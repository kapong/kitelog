import { createMiddleware } from "hono/factory";
import { hashApiKey, parseBearer, scopeAllows } from "@kitelog/auth";
import type { Scope } from "@kitelog/shared";
import type { AppEnv, ProjectRow } from "../env";
import { ApiError } from "../http";

const TOUCH_EVERY_MS = 60_000;

/** `Authorization: Bearer kl_...` → unrevoked api_keys row → its project. */
export const apiKeyAuth = createMiddleware<AppEnv>(async (c, next) => {
  const key = parseBearer(c.req.header("Authorization"));
  if (!key) throw new ApiError(401, "unauthorized", "missing or malformed API key");
  const row = await c.env.DB.prepare(
    `SELECT k.id AS key_id, k.scope, k.last_used_at, p.*
     FROM api_keys k JOIN projects p ON p.id = k.project_id
     WHERE k.key_hash = ? AND k.revoked_at IS NULL`,
  )
    .bind(await hashApiKey(key))
    .first<ProjectRow & { key_id: string; scope: Scope; last_used_at: number | null }>();
  if (!row) throw new ApiError(401, "unauthorized", "invalid API key");
  const now = Date.now();
  if (row.last_used_at == null || now - row.last_used_at >= TOUCH_EVERY_MS) {
    // At most one write per key per minute; off the response path.
    c.executionCtx.waitUntil(
      c.env.DB.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").bind(now, row.key_id).run().catch(() => {}),
    );
  }
  const { key_id: _k, scope, last_used_at: _l, ...project } = row;
  c.set("project", project);
  c.set("keyScope", scope);
  await next();
});

export const requireScope = (need: Scope) =>
  createMiddleware<AppEnv>(async (c, next) => {
    if (!scopeAllows(c.get("keyScope"), need)) throw new ApiError(403, "insufficient_scope", `API key needs '${need}' scope`);
    await next();
  });
