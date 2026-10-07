import type { Context } from "hono";
import { resolveStorage, StorageError, type ProjectStorageRow, type ResolvedStorage } from "@kitelog/storage";
import type { Run } from "@kitelog/shared";
import type { AppEnv, Env } from "./env";
import { ApiError } from "./http";

/** Project's storage tier. Keys passed to it are relative: S3Storage applies its own prefix. */
export async function storageFor(env: Env, projectId: string): Promise<ResolvedStorage> {
  const row = await env.DB.prepare("SELECT * FROM project_storage WHERE project_id = ?")
    .bind(projectId)
    .first<ProjectStorageRow>();
  try {
    return resolveStorage(row, env);
  } catch (e) {
    if (e instanceof StorageError && ["invalid_endpoint", "invalid_bucket", "invalid_prefix"].includes(e.code)) {
      throw new ApiError(500, "storage_misconfigured", e.message);
    }
    throw e;
  }
}

/** `p/{pid}/r/{rid}/` — everything a run owns (metrics/, files/). */
export const runBase = (projectId: string, runId: string) => `p/${projectId}/r/${runId}/`;

export interface RunRow {
  id: string;
  project_id: string;
  name: string;
  status: Run["status"];
  config: string;
  summary: string;
  tags: string;
  created_at: number;
  updated_at: number;
  finished_at: number | null;
  heartbeat_at: number | null;
}

/** `:id` run in the context's project (API key or membership); 404 otherwise. */
export async function loadRun(c: Context<AppEnv>): Promise<RunRow> {
  const run = await c.env.DB.prepare("SELECT * FROM runs WHERE id = ? AND project_id = ?")
    .bind(c.req.param("id") ?? "", c.get("project").id)
    .first<RunRow>();
  if (!run) throw new ApiError(404, "not_found", "run not found");
  return run;
}

export const runOut = (r: RunRow): Run => ({
  id: r.id,
  name: r.name,
  status: r.status,
  config: JSON.parse(r.config),
  summary: JSON.parse(r.summary),
  tags: JSON.parse(r.tags),
  created_at: r.created_at,
  updated_at: r.updated_at,
  finished_at: r.finished_at,
  heartbeat_at: r.heartbeat_at,
});
