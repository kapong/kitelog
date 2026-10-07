import { Hono } from "hono";
import { newApiKey } from "@kitelog/auth";
import { ApiKeyCreate, type ApiKey } from "@kitelog/shared";
import type { AppEnv } from "../env";
import { ApiError, body } from "../http";
import { requireMember } from "../middleware/member";
import { sessionAuth } from "../middleware/session";

// Mounted at /projects/:slug/keys. Editors and owners manage keys; viewers cannot see them.
export const keys = new Hono<AppEnv>();
keys.use(sessionAuth, requireMember("editor"));

keys.get("/", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, name, prefix, scope, created_at, last_used_at, revoked_at FROM api_keys
     WHERE project_id = ? ORDER BY created_at DESC`,
  )
    .bind(c.get("project").id)
    .all<ApiKey>();
  return c.json(results);
});

keys.post("/", async (c) => {
  const { name, scope } = await body(c, ApiKeyCreate);
  const { key, prefix, keyHash } = await newApiKey();
  const k: ApiKey = { id: crypto.randomUUID(), name, prefix, scope, created_at: Date.now(), last_used_at: null, revoked_at: null };
  await c.env.DB.prepare(
    `INSERT INTO api_keys (id, project_id, name, prefix, key_hash, scope, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(k.id, c.get("project").id, name, prefix, keyHash, scope, c.get("user").id, k.created_at)
    .run();
  return c.json({ ...k, key }, 201); // raw key returned once
});

keys.delete("/:id", async (c) => {
  const r = await c.env.DB.prepare(
    "UPDATE api_keys SET revoked_at = ? WHERE id = ? AND project_id = ? AND revoked_at IS NULL",
  )
    .bind(Date.now(), c.req.param("id"), c.get("project").id)
    .run();
  if (r.meta.changes === 0) throw new ApiError(404, "not_found", "key not found or already revoked");
  return c.body(null, 204);
});
