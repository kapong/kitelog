import type { Env } from "./env";
import { storageFor } from "./lib";
import { compactRun } from "./routes/metrics";
import { UPLOAD_TTL_MS, type UploadRow } from "./routes/uploads";

export const CRASH_AFTER_MS = 10 * 60_000;
const UPLOADS_PER_RUN = 100;
/** Stopped runs compacted per cron tick (each call ≤ 3 chunks; leftovers next tick). */
const COMPACT_RUNS_PER_TICK = 4;

/**
 * Cron (every 5 min):
 * - runs still `running` whose writer-0 heartbeat (or, with no writer 0 yet, creation) is
 *   older than CRASH_AFTER_MS → `crashed`;
 * - runs no longer `running` with uncompacted seqs → one compactRun call each (crashed runs,
 *   or a finish() whose compaction never completed);
 * - pending uploads past their TTL → `aborted` (S3 multipart aborted; R2 partial body deleted
 *   unless a registered file uses the same key).
 */
export async function cron(_controller: ScheduledController, env: Env, now = Date.now()): Promise<void> {
  // finished_at = last sign of life (writer-0 heartbeat, else creation); resume clears it.
  const lastSeen = `COALESCE((SELECT heartbeat_at FROM run_writers w WHERE w.run_id = runs.id AND w.writer_id = 0), created_at)`;
  await env.DB.prepare(
    `UPDATE runs SET status = 'crashed', updated_at = ?1, finished_at = ${lastSeen}
     WHERE status = 'running' AND ${lastSeen} < ?2`,
  )
    .bind(now, now - CRASH_AFTER_MS)
    .run();

  const { results: stopped } = await env.DB.prepare(
    `SELECT DISTINCT r.id, r.project_id FROM runs r JOIN run_writers w ON w.run_id = r.id
     WHERE r.status != 'running' AND w.last_seq > w.compacted_seq LIMIT ?`,
  )
    .bind(COMPACT_RUNS_PER_TICK)
    .all<{ id: string; project_id: string }>();
  for (const r of stopped) {
    try {
      await compactRun(env, r);
    } catch (e) {
      console.error("cron: compaction failed", r.id, e);
    }
  }

  // Per-backend TTL in SQL, so unexpired rows (e.g. young S3 uploads) never fill the LIMIT
  // and starve expired ones behind them.
  const { results } = await env.DB.prepare(
    `SELECT * FROM uploads WHERE status = 'pending'
       AND ((backend = 'r2' AND created_at < ?1) OR (backend = 's3' AND created_at < ?2))
     ORDER BY created_at LIMIT ?3`,
  )
    .bind(now - UPLOAD_TTL_MS.r2, now - UPLOAD_TTL_MS.s3, UPLOADS_PER_RUN)
    .all<UploadRow>();
  for (const u of results) {
    try {
      const { storage, backend } = await storageFor(env, u.project_id);
      if (backend === u.backend) {
        if (u.s3_upload_id) await storage.abortMultipart(u.storage_key, u.s3_upload_id);
        // Upload keys are unique per upload id; this check only guards legacy path-only keys.
        else if (!(await env.DB.prepare("SELECT 1 FROM files WHERE storage_key = ?").bind(u.storage_key).first())) {
          await storage.delete(u.storage_key);
        }
      }
    } catch (e) {
      console.error("cron: upload cleanup failed", u.id, e); // still marked aborted; bytes orphaned
    }
    await env.DB.prepare("UPDATE uploads SET status = 'aborted' WHERE id = ? AND status = 'pending'").bind(u.id).run();
  }
}
