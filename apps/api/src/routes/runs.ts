import { Hono } from "hono";
import { z } from "zod";
import { roleAtLeast } from "@kitelog/auth";
import { Heartbeat, RunCreate, RunPatch, type FileInfo, type RunWithMetrics } from "@kitelog/shared";
import type { AppEnv } from "../env";
import { ApiError, body, parse } from "../http";
import { loadRun, runBase, runOut, storageFor, type RunRow } from "../lib";
import { apiKeyAuth, requireScope } from "../middleware/apiKey";
import { requireMember } from "../middleware/member";
import { sessionAuth } from "../middleware/session";
import { assertWritable, metrics, metricsRead, reviveStmt } from "./metrics";
import { runUploads } from "./uploads";

// ---------- client (API key, write scope), mounted at /runs ----------
export const runs = new Hono<AppEnv>();
runs.use(apiKeyAuth, requireScope("write"));

/**
 * Create a run, or join one by id (`resume`). Joining an id that does not exist yet creates it
 * with that id (race-safe: concurrent ranks all end up in the same row), so distributed ranks
 * need no coordination. Joining an existing run sets it back to `running`. An id owned by
 * another project is 404 (never leaked). 201 when created, 200 when joined. Returns this
 * writer's last_seq.
 */
runs.post("/", async (c) => {
  const input = await body(c, RunCreate);
  const db = c.env.DB;
  const p = c.get("project");
  const now = Date.now();
  const id = input.resume ?? crypto.randomUUID();
  const json = (v: unknown) => (v === undefined ? null : JSON.stringify(v));
  const ins = await db
    .prepare(
      `INSERT INTO runs (id, project_id, name, status, config, tags, created_at, updated_at, heartbeat_at)
       VALUES (?1, ?2, ?3, 'running', ?4, ?5, ?6, ?6, ?6) ON CONFLICT(id) DO NOTHING`,
    )
    .bind(id, p.id, input.name ?? (input.resume ? id : `run-${id.slice(0, 8)}`), json(input.config ?? {}), json(input.tags ?? []), now)
    .run();
  const created = ins.meta.changes > 0;
  if (!created) {
    const r = await db
      .prepare(
        `UPDATE runs SET status = 'running', finished_at = NULL, heartbeat_at = ?1, updated_at = ?1,
           name = COALESCE(?2, name), config = COALESCE(?3, config), tags = COALESCE(?4, tags)
         WHERE id = ?5 AND project_id = ?6`,
      )
      .bind(now, input.name ?? null, json(input.config), json(input.tags), id, p.id)
      .run();
    if (r.meta.changes === 0) throw new ApiError(404, "not_found", "run not found");
  }
  const w = await db
    .prepare(
      `INSERT INTO run_writers (run_id, writer_id, heartbeat_at) VALUES (?, ?, ?)
       ON CONFLICT(run_id, writer_id) DO UPDATE SET heartbeat_at = excluded.heartbeat_at
       RETURNING last_seq`,
    )
    .bind(id, input.writer_id, now)
    .first<{ last_seq: number }>();
  return c.json({ id, last_seq: w!.last_seq }, created ? 201 : 200);
});

runs.patch("/:id", async (c) => {
  const run = await loadRun(c);
  const patch = await body(c, RunPatch);
  const now = Date.now();
  // SET only the patched columns: never write back loadRun's possibly stale status/finished_at.
  const set: Partial<RunRow> = { updated_at: now };
  if (patch.config !== undefined) set.config = JSON.stringify(patch.config);
  if (patch.summary !== undefined) set.summary = JSON.stringify(patch.summary);
  if (patch.tags !== undefined) set.tags = JSON.stringify(patch.tags);
  if (patch.status !== undefined) {
    set.status = patch.status;
    set.finished_at = patch.status === "running" ? null : now;
  }
  const cols = Object.keys(set) as (keyof RunRow)[]; // fixed names from the code above, not input
  const row = await c.env.DB.prepare(`UPDATE runs SET ${cols.map((k) => `${k} = ?`).join(", ")} WHERE id = ? RETURNING *`)
    .bind(...cols.map((k) => set[k] ?? null), run.id)
    .first<RunRow>();
  if (!row) throw new ApiError(404, "not_found", "run not found"); // deleted meanwhile
  return c.json(runOut(row));
});

runs.post("/:id/heartbeat", async (c) => {
  const run = await loadRun(c);
  assertWritable(run);
  const { writer_id } = await body(c, Heartbeat);
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO run_writers (run_id, writer_id, heartbeat_at) VALUES (?, ?, ?)
       ON CONFLICT(run_id, writer_id) DO UPDATE SET heartbeat_at = excluded.heartbeat_at`,
    ).bind(run.id, writer_id, now),
    reviveStmt(c.env.DB, run.id, now),
  ]);
  return c.body(null, 204);
});

runs.route("/:id/metrics", metrics);
runs.route("/:id/uploads", runUploads);

// ---------- dashboard (session, member), mounted at /projects/:slug/runs ----------
export const projectRuns = new Hono<AppEnv>();
projectRuns.use(sessionAuth, requireMember("viewer"));

type LastRow = { run_id: string; key: string; last_step: number; last_value: number | null };
const withMetrics = (rows: RunRow[], last: LastRow[]): RunWithMetrics[] => {
  const by = new Map<string, RunWithMetrics["metrics"]>(rows.map((r) => [r.id, {}]));
  for (const m of last) by.get(m.run_id)![m.key] = { step: m.last_step, value: m.last_value };
  return rows.map((r) => ({ ...runOut(r), metrics: by.get(r.id)! }));
};

const CURSOR = /^(\d{1,15})(?::(.+))?$/;
const ListQuery = z.object({
  // Cursor of the last run on the previous page: `<created_at>:<id>` (legacy: `<created_at>`).
  before: z.string().regex(CURSOR).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/**
 * Newest first, ordered (created_at, id) DESC. Next page: `?before=<created_at>:<id>` of the
 * last item (runs sharing a created_at ms are not skipped). Legacy `?before=<created_at>`
 * means `created_at < before` (id '' sorts below every id).
 */
projectRuns.get("/", async (c) => {
  const q = parse(ListQuery, c.req.query());
  const m = q.before?.match(CURSOR);
  const [at, id] = m ? [Number(m[1]), m[2] ?? ""] : [Number.MAX_SAFE_INTEGER, ""];
  const page = `SELECT * FROM runs WHERE project_id = ?1 AND (created_at, id) < (?2, ?3)
                ORDER BY created_at DESC, id DESC LIMIT ?4`;
  const args = [c.get("project").id, at, id, q.limit];
  const [runsRes, lastRes] = await c.env.DB.batch<RunRow | LastRow>([
    c.env.DB.prepare(page).bind(...args),
    c.env.DB.prepare(`SELECT * FROM run_metric_keys WHERE run_id IN (SELECT id FROM (${page}))`).bind(...args),
  ]);
  return c.json(withMetrics(runsRes!.results as RunRow[], lastRes!.results as LastRow[]));
});

projectRuns.get("/:id", async (c) => {
  const run = await loadRun(c);
  const { results } = await c.env.DB.prepare("SELECT * FROM run_metric_keys WHERE run_id = ?").bind(run.id).all<LastRow>();
  return c.json(withMetrics([run], results)[0]);
});

projectRuns.get("/:id/files", async (c) => {
  const run = await loadRun(c);
  const { results } = await c.env.DB.prepare(
    `SELECT id, run_id, kind, path, size, content_type, created_at FROM files
     WHERE run_id = ? ORDER BY created_at DESC`,
  )
    .bind(run.id)
    .all<FileInfo>();
  return c.json(results);
});

/**
 * Editor+. Rows first (the UI never shows a half-deleted run), then objects best-effort.
 * Pending uploads are kept (run_id → NULL via FK) so cron still aborts S3 multipart uploads.
 */
projectRuns.delete("/:id", async (c) => {
  if (!roleAtLeast(c.get("role"), "editor")) throw new ApiError(403, "forbidden", "requires editor role");
  const run = await loadRun(c);
  const db = c.env.DB;
  await db.batch([
    db.prepare("DELETE FROM files WHERE run_id = ?").bind(run.id),
    db.prepare("DELETE FROM runs WHERE id = ?").bind(run.id), // cascades writers + metric keys
  ]);
  try {
    const { storage } = await storageFor(c.env, run.project_id);
    const objs = await storage.list(runBase(run.project_id, run.id));
    await storage.deleteMany(objs.map((o) => o.key));
  } catch (e) {
    // ponytail: leftovers are orphaned bytes only (no rows point at them); add a sweeper if it matters.
    console.error("run delete: object cleanup failed", e);
  }
  return c.body(null, 204);
});

projectRuns.route("/:id/metrics", metricsRead);
