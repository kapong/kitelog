import { createMiddleware } from "hono/factory";
import { SESSION_COOKIE, readCookie, sha256Hex } from "@kitelog/auth";
import type { AppEnv, UserRow } from "../env";
import { ApiError } from "../http";

/** Cookie `kl_session` → sessions.token_hash (unexpired) → user. */
export const sessionAuth = createMiddleware<AppEnv>(async (c, next) => {
  const token = readCookie(c.req.header("Cookie"), SESSION_COOKIE);
  if (!token) throw new ApiError(401, "unauthorized", "not logged in");
  const hash = await sha256Hex(token);
  const user = await c.env.DB.prepare(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ?`,
  )
    .bind(hash, Date.now())
    .first<UserRow>();
  if (!user) throw new ApiError(401, "unauthorized", "not logged in");
  c.set("user", user);
  c.set("sessionHash", hash);
  await next();
});

export const requireAdmin = createMiddleware<AppEnv>(async (c, next) => {
  if (c.get("user").is_admin !== 1) throw new ApiError(403, "forbidden", "admin only");
  await next();
});
