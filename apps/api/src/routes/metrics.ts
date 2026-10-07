import { Hono } from "hono";
import { asyncBuffer, StorageError, type Storage } from "@kitelog/storage";
import {
  chunkKey,
  compact,
  encodeSegment,
  metricsBase,
  parseChunkKey,
  parseSegmentKey,
  planCompaction,
  readSeries,
  segmentKey,
  sortChunkKeys,
} from "@kitelog/metrics";
import { MetricsFlush, MetricsQuery, type CompactResult, type MetricPoint } from "@kitelog/shared";
import type { AppEnv, Env } from "../env";
import { ApiError, body, parse } from "../http";
import { loadRun, storageFor, type RunRow } from "../lib";

const PARQUET = "application/vnd.apache.parquet";
/** run_metric_keys rows per upsert statement (passed as ONE JSON param, so no 100-param limit). */
const KEYS_PER_STMT = 1000;
/** Compaction batches (chunks) per request: bounds subrequests + CPU; `more: true` → call again. */
const COMPACT_BATCHES_PER_CALL = 3;
/** Pending segments per metrics read: compacting reduces these, so over → "compact first". */
const MAX_READ_SEGMENTS = 200;
/** Files (chunks + segments) per metrics read: each costs ≥ 1 subrequest. Hard ceiling. */
const MAX_READ_FILES = 400;

/** 8 random hex chars: unique chunk names (see chunkKey). */
const chunkSuffix = () => crypto.randomUUID().replace(/-/g, "").slice(0, 8);

// Base passed to storage is relative ("" prefix): S3Storage adds the project's own prefix.
const base = (projectId: string, runId: string) => metricsBase("", projectId, runId);

/**
 * Flushes/heartbeats are accepted while `running`, and also when cron marked the run `crashed`
 * (a slow-but-alive client): reviveStmt then sets it back to `running`. Finished/failed → 409.
 */
export function assertWritable(run: RunRow): void {
  if (run.status !== "running" && run.status !== "crashed") {
    throw new ApiError(409, "run_not_running", `run is ${run.status}`);
  }
}

/** Heartbeat + revive a crashed run, in the caller's batch. Never touches finished/failed. */
export const reviveStmt = (db: D1Database, runId: string, now: number) =>
  db
    .prepare(
      `UPDATE runs SET heartbeat_at = ?1, updated_at = ?1,
         status = CASE WHEN status = 'crashed' THEN 'running' ELSE status END,
         finished_at = CASE WHEN status = 'crashed' THEN NULL ELSE finished_at END
       WHERE id = ?2`,
    )
    .bind(now, runId);

// ---------- client, mounted under /runs/:id/metrics (auth from the parent) ----------
export const metrics = new Hono<AppEnv>();

/**
 * One flush → one segment object named by (writer_id, seq). The object is written BEFORE
 * last_seq is committed, so a committed seq always has its data; a crash in between leaves
 * an uncommitted segment the client's retry (same seq) overwrites.
 */
metrics.post("/", async (c) => {
  const run = await loadRun(c);
  assertWritable(run);
  // Numeric-only: MetricPoint.value is z.number() (finite), the only type either tier accepts today.
  const f = await body(c, MetricsFlush);
  const db = c.env.DB;
  const w = await db
    .prepare("SELECT last_seq, compacted_seq FROM run_writers WHERE run_id = ? AND writer_id = ?")
    .bind(run.id, f.writer_id)
    .first<{ last_seq: number; compacted_seq: number }>();
  const last = w?.last_seq ?? -1;
  if (f.seq < last) {
    throw new ApiError(409, "seq_conflict", `seq ${f.seq} < last_seq ${last}`, { last_seq: last });
  }
  // A retry of a seq already compacted into a chunk: its data is safe; rewriting the segment
  // would only duplicate rows.
  const already = w != null && f.seq <= w.compacted_seq;
  if (!already && f.points.length > 0) {
    const { storage } = await storageFor(c.env, run.project_id);
    await storage.put(segmentKey(base(run.project_id, run.id), f.writer_id, f.seq), encodeSegment(f.points, f.writer_id), {
      contentType: PARQUET,
    });
  }

  const now = Date.now();
  const stmts = [
    db
      .prepare(
        `INSERT INTO run_writers (run_id, writer_id, last_seq, heartbeat_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(run_id, writer_id) DO UPDATE SET last_seq = MAX(last_seq, excluded.last_seq),
           heartbeat_at = excluded.heartbeat_at`,
      )
      .bind(run.id, f.writer_id, f.seq, now),
    reviveStmt(db, run.id, now),
  ];
  // Last point per key = max step (tie → latest ts).
  const lastByKey = new Map<string, MetricPoint>();
  for (const p of f.points) {
    const cur = lastByKey.get(p.key);
    if (!cur || p.step > cur.step || (p.step === cur.step && p.ts >= cur.ts)) lastByKey.set(p.key, p);
  }
  const rows = [...lastByKey.values()].map((p) => [p.key, p.step, p.value]);
  for (let i = 0; i < rows.length; i += KEYS_PER_STMT) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO run_metric_keys (run_id, key, last_step, last_value)
           SELECT ?1, j.value ->> 0, j.value ->> 1, j.value ->> 2 FROM json_each(?2) j WHERE true
           ON CONFLICT(run_id, key) DO UPDATE SET last_step = excluded.last_step, last_value = excluded.last_value
           WHERE excluded.last_step >= run_metric_keys.last_step`,
        )
        .bind(run.id, JSON.stringify(rows.slice(i, i + KEYS_PER_STMT))),
    );
  }
  await db.batch(stmts);
  return c.json({ last_seq: Math.max(last, f.seq) });
});

/**
 * Merge committed pending segments (all writers, seq ≤ snapshot of each writer's last_seq)
 * into new immutable chunks, then delete them. Caller is writer 0 by convention (its sender
 * thread calls this serially, so runs never overlap); no body needed.
 *
 * Crash safety: chunk is written before its segments are deleted. A crash in between leaves
 * the segments in place; the next run puts them into ANOTHER chunk, duplicating rows across
 * chunks — harmless, since reads dedupe (key, step) by latest ts.
 * Concurrent compactions (e.g. a client retrying after a timeout) may pick the same chunk
 * number; chunk names carry a random suffix, so both chunks survive and overlap (deduped at
 * read) instead of overwriting each other. A segment deleted by the other compaction → 404
 * → that batch is skipped here (the other one has it).
 * At most COMPACT_BATCHES_PER_CALL chunks per call; `more: true` → the client calls again.
 */
metrics.post("/compact", async (c) => c.json(await compactRun(c.env, await loadRun(c))));

/**
 * The compaction itself (route above; cron for runs that are no longer running).
 * When no pending segments are left, every writer's compacted_seq is raised to the snapshot
 * last_seq: a committed seq with no segment in storage was either compacted already or an
 * empty flush (no object written), so cron stops re-selecting the run.
 */
export async function compactRun(env: Env, run: { id: string; project_id: string }): Promise<CompactResult> {
  const db = env.DB;
  const { results: writers } = await db
    .prepare("SELECT writer_id, last_seq FROM run_writers WHERE run_id = ?")
    .bind(run.id)
    .all<{ writer_id: number; last_seq: number }>();
  const committed = new Map(writers.map((w) => [w.writer_id, w.last_seq]));
  const { storage } = await storageFor(env, run.project_id);
  const b = base(run.project_id, run.id);
  const objs = await storage.list(b);
  const size = new Map(objs.map((o) => [o.key, o.size]));
  let next = objs.reduce((m, o) => Math.max(m, parseChunkKey(o.key) ?? -1), -1) + 1;
  const pending = objs
    .map((o) => o.key)
    .filter((k) => {
      const s = parseSegmentKey(k);
      return s !== null && s.seq <= (committed.get(s.writerId) ?? -1);
    });

  const compactedTo = new Map<number, number>();
  const all = planCompaction(pending); // ≤ MAX_SEGMENTS_PER_CHUNK × 10k rows each, so no row counts needed
  const batches = all.slice(0, COMPACT_BATCHES_PER_CALL);
  let chunks = 0;
  let segments = 0;
  let skipped = false;
  for (const batch of batches) {
    let chunk: Uint8Array;
    try {
      chunk = await compact(batch.map((k) => asyncBuffer(storage, k, size.get(k)!)));
    } catch (e) {
      if (e instanceof StorageError && e.status === 404) {
        skipped = true; // a concurrent compaction took it
        continue;
      }
      throw e;
    }
    await storage.put(chunkKey(b, next++, chunkSuffix()), chunk, { contentType: PARQUET });
    await storage.deleteMany(batch);
    chunks++;
    segments += batch.length;
    for (const k of batch) {
      const s = parseSegmentKey(k)!;
      compactedTo.set(s.writerId, Math.max(compactedTo.get(s.writerId) ?? -1, s.seq));
    }
  }
  const more = skipped || all.length > batches.length;
  // Nothing pending left up to the snapshot → every writer is compacted up to it.
  if (!more) for (const [w, seq] of committed) compactedTo.set(w, seq);
  if (compactedTo.size) {
    await db.batch(
      [...compactedTo].map(([w, seq]) =>
        db
          .prepare("UPDATE run_writers SET compacted_seq = ? WHERE run_id = ? AND writer_id = ? AND compacted_seq < ?")
          .bind(seq, run.id, w, seq),
      ),
    );
  }
  return { chunks, segments, more };
}

// ---------- dashboard, mounted under /projects/:slug/runs/:id/metrics (auth from the parent) ----------
export const metricsRead = new Hono<AppEnv>();

/** Files in write order: chunks by (n, key), then pending segments by (writer_id, seq). */
async function seriesFiles(storage: Storage, b: string) {
  const objs = await storage.list(b);
  const chunks = sortChunkKeys(objs, (o) => o.key);
  const segs = objs
    .map((o) => ({ o, s: parseSegmentKey(o.key) }))
    .filter((x) => x.s !== null)
    .sort((x, y) => x.s!.writerId - y.s!.writerId || x.s!.seq - y.s!.seq)
    .map((x) => x.o);
  if (segs.length > MAX_READ_SEGMENTS) {
    throw new ApiError(413, "too_many_files", `run has ${segs.length} pending metric segments (max ${MAX_READ_SEGMENTS}); compact it first`);
  }
  const files = [...chunks, ...segs];
  if (files.length > MAX_READ_FILES) {
    throw new ApiError(413, "run_too_large", `run has ${files.length} metric files (max ${MAX_READ_FILES} per read)`);
  }
  return files.map((o) => asyncBuffer(storage, o.key, o.size));
}

// Reads merge pending segments; runs that stopped without compacting are compacted by cron.
metricsRead.get("/", async (c) => {
  const run = await loadRun(c);
  const q = parse(MetricsQuery, c.req.query());
  const { storage } = await storageFor(c.env, run.project_id);
  const b = base(run.project_id, run.id);
  // A compaction between list and read deletes listed segments (404): re-list once.
  for (let attempt = 0; ; attempt++) {
    try {
      return c.json({ series: await readSeries(await seriesFiles(storage, b), q.keys, q.points) });
    } catch (e) {
      if (attempt > 0 || !(e instanceof StorageError && e.status === 404)) throw e;
    }
  }
});
