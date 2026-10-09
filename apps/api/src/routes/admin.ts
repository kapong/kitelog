import { Hono } from "hono";
import { newResetToken } from "@kitelog/auth";
import { AdminUserCreate, AdminUserPatch, type AdminUserCreated, type PasswordResetCreated } from "@kitelog/shared";
import type { AppEnv, Env, UserRow } from "../env";
import { ApiError, body, userOut } from "../http";
import { requireAdmin, sessionAuth } from "../middleware/session";

const RESET_TTL_MS = 24 * 3600 * 1000;
const NEW_USER_TTL_MS = 7 * 24 * 3600 * 1000;
/** Not a `pbkdf2$...` string, so verifyPassword always rejects it: no login until a reset is used. */
const NO_PASSWORD = "!";

/** New single-use reset link for `userId`; older unused links of that user stop working. */
async function createReset(env: Env, userId: string, createdBy: string, ttlMs: number): Promise<PasswordResetCreated> {
  const { token, tokenHash } = await newResetToken();
  const now = Date.now();
  const expires_at = now + ttlMs;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM password_resets WHERE user_id = ? AND used_at IS NULL").bind(userId),
    env.DB.prepare(
      "INSERT INTO password_resets (id, user_id, token_hash, created_by, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(crypto.randomUUID(), userId, tokenHash, createdBy, expires_at, now),
  ]);
  return { token, expires_at };
}

async function getUser(env: Env, id: string): Promise<UserRow> {
  const u = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<UserRow>();
  if (!u) throw new ApiError(404, "not_found", "user not found");
  return u;
}

const OTHER_ADMINS = "(SELECT COUNT(*) FROM users WHERE is_admin = 1 AND id != ?)";

export const admin = new Hono<AppEnv>();
admin.use(sessionAuth, requireAdmin);

admin.get("/users", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT * FROM users ORDER BY created_at").all<UserRow>();
  return c.json(results.map(userOut));
});

// The account has no usable password; the returned link (valid 7 days) lets the user set one.
admin.post("/users", async (c) => {
  const input = await body(c, AdminUserCreate);
  if (await c.env.DB.prepare("SELECT 1 FROM users WHERE email = ?").bind(input.email).first()) {
    throw new ApiError(409, "email_taken", "email already registered");
  }
  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    "INSERT INTO users (id, email, password_hash, name, is_admin, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(id, input.email, NO_PASSWORD, input.name ?? null, input.is_admin ? 1 : 0, Date.now())
    .run();
  const reset = await createReset(c.env, id, c.get("user").id, NEW_USER_TTL_MS);
  return c.json({ user: userOut(await getUser(c.env, id)), reset } satisfies AdminUserCreated, 201);
});

admin.patch("/users/:id", async (c) => {
  const patch = await body(c, AdminUserPatch);
  const id = c.req.param("id");
  const target = await getUser(c.env, id);
  if (patch.is_admin !== undefined && (patch.is_admin ? 1 : 0) !== target.is_admin) {
    if (!patch.is_admin && id === c.get("user").id) throw new ApiError(409, "last_admin", "cannot demote yourself");
    // Conditional, so concurrent demotions cannot remove the last admin.
    const r = await c.env.DB.prepare(
      `UPDATE users SET is_admin = ? WHERE id = ? AND (? = 1 OR ${OTHER_ADMINS} > 0)`,
    )
      .bind(patch.is_admin ? 1 : 0, id, patch.is_admin ? 1 : 0, id)
      .run();
    if (r.meta.changes === 0) throw new ApiError(409, "last_admin", "cannot demote the last admin");
  }
  return c.json(userOut(await getUser(c.env, id)));
});

// Sessions, memberships and reset links go with the user (FK cascade).
admin.delete("/users/:id", async (c) => {
  const id = c.req.param("id");
  await getUser(c.env, id);
  if (id === c.get("user").id) throw new ApiError(409, "last_admin", "cannot delete yourself");
  const soleOwner = `EXISTS (SELECT 1 FROM project_members m WHERE m.user_id = ? AND m.role = 'owner'
    AND NOT EXISTS (SELECT 1 FROM project_members o WHERE o.project_id = m.project_id AND o.role = 'owner' AND o.user_id != ?))`;
  const r = await c.env.DB.prepare(
    `DELETE FROM users WHERE id = ? AND NOT ${soleOwner} AND (is_admin = 0 OR ${OTHER_ADMINS} > 0)`,
  )
    .bind(id, id, id, id)
    .run();
  if (r.meta.changes === 0) {
    const owns = await c.env.DB.prepare(`SELECT ${soleOwner} AS n`).bind(id, id).first<{ n: number }>();
    if (owns?.n) throw new ApiError(409, "last_owner", "user is the only owner of a project");
    throw new ApiError(409, "last_admin", "cannot delete the last admin");
  }
  return c.body(null, 204);
});

// A fresh 24 h link; works for any user, including another admin.
admin.post("/users/:id/reset", async (c) => {
  const id = c.req.param("id");
  await getUser(c.env, id);
  return c.json(await createReset(c.env, id, c.get("user").id, RESET_TTL_MS), 201);
});
