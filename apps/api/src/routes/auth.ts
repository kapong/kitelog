import { Hono, type Context } from "hono";
import {
  SESSION_COOKIE,
  clearSessionCookie,
  hashPassword,
  newSessionToken,
  readCookie,
  sessionCookie,
  sha256Hex,
  verifyPassword,
} from "@kitelog/auth";
import {
  LoginInput,
  PasswordChange,
  PasswordResetInput,
  PasswordResetLookupInput,
  SignupInput,
  type AuthStatus,
  type PasswordResetLookup,
} from "@kitelog/shared";
import type { AppEnv, UserRow } from "../env";
import { ApiError, body, rateLimit, userOut } from "../http";
import { sessionAuth } from "../middleware/session";

const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const isHttps = (c: Context) => new URL(c.req.url).protocol === "https:";

// Verified against when the email is unknown, so a miss costs the same PBKDF2 work as a hit.
let dummyHash: Promise<string> | undefined;

async function startSession(c: Context<AppEnv>, userId: string) {
  const { token, tokenHash } = await newSessionToken();
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND expires_at <= ?").bind(userId, now),
    c.env.DB.prepare("INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)").bind(
      crypto.randomUUID(),
      userId,
      tokenHash,
      now + SESSION_TTL_MS,
    ),
  ]);
  c.header("Set-Cookie", sessionCookie(token, SESSION_TTL_MS / 1000, isHttps(c)));
}

export const auth = new Hono<AppEnv>();

// Public: the login page offers "create admin" only while there are no users.
auth.get("/status", async (c) => {
  const row = await c.env.DB.prepare("SELECT EXISTS (SELECT 1 FROM users) AS n").first<{ n: number }>();
  return c.json({ needs_setup: row!.n === 0 } satisfies AuthStatus);
});

// First-admin setup only. Every other account is created by an admin (POST /admin/users).
auth.post("/signup", async (c) => {
  const input = await body(c, SignupInput);
  await rateLimit(c, input.email);
  const db = c.env.DB;
  const any = await db.prepare("SELECT EXISTS (SELECT 1 FROM users) AS n").first<{ n: number }>();
  if (any!.n) throw new ApiError(403, "signup_closed", "accounts are created by an admin");
  const id = crypto.randomUUID();
  // Single statement, so two racing "first" signups cannot both become admin.
  const first = await db
    .prepare(
      `INSERT INTO users (id, email, password_hash, name, is_admin, created_at)
       SELECT ?, ?, ?, ?, 1, ? WHERE NOT EXISTS (SELECT 1 FROM users)`,
    )
    .bind(id, input.email, await hashPassword(input.password), input.name ?? null, Date.now())
    .run();
  if (first.meta.changes === 0) throw new ApiError(403, "signup_closed", "accounts are created by an admin");
  await startSession(c, id);
  const user = await db.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<UserRow>();
  return c.json(userOut(user!), 201);
});

auth.post("/login", async (c) => {
  const input = await body(c, LoginInput);
  await rateLimit(c, input.email);
  const user = await c.env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(input.email).first<UserRow>();
  // Unknown users and users without a password yet ("!") cost the same dummy PBKDF2.
  const ok = user?.password_hash.startsWith("pbkdf2$")
    ? await verifyPassword(input.password, user.password_hash)
    : (await verifyPassword(input.password, await (dummyHash ??= hashPassword("dummy-password"))), false);
  if (!user || !ok) throw new ApiError(401, "invalid_credentials", "invalid email or password");
  await startSession(c, user.id);
  return c.json(userOut(user));
});

auth.post("/logout", async (c) => {
  const token = readCookie(c.req.header("Cookie"), SESSION_COOKIE);
  if (token) await c.env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256Hex(token)).run();
  c.header("Set-Cookie", clearSessionCookie(isHttps(c)));
  return c.body(null, 204);
});

auth.get("/me", sessionAuth, (c) => c.json(userOut(c.get("user"))));

// Session: verify the current password, set the new one, revoke every OTHER session.
auth.post("/password", sessionAuth, async (c) => {
  const input = await body(c, PasswordChange);
  const user = c.get("user");
  await rateLimit(c, user.email);
  if (!(await verifyPassword(input.current_password, user.password_hash))) {
    throw new ApiError(400, "wrong_password", "current password is incorrect");
  }
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE users SET password_hash = ? WHERE id = ?").bind(await hashPassword(input.new_password), user.id),
    c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?").bind(user.id, c.get("sessionHash")),
  ]);
  return c.body(null, 204);
});

// Public: the set-password page shows which account a reset link is for. 404 unless usable.
auth.post("/reset/lookup", async (c) => {
  const input = await body(c, PasswordResetLookupInput);
  await rateLimit(c, "reset");
  const row = await c.env.DB.prepare(
    `SELECT u.email, r.expires_at FROM password_resets r JOIN users u ON u.id = r.user_id
     WHERE r.token_hash = ? AND r.used_at IS NULL AND r.expires_at > ?`,
  )
    .bind(await sha256Hex(input.token), Date.now())
    .first<PasswordResetLookup>();
  if (!row) throw new ApiError(404, "invalid_reset", "reset link is invalid, used, or expired");
  return c.json(row);
});

// Public: single-use claim, set the password, revoke ALL sessions of that user.
auth.post("/reset", async (c) => {
  const input = await body(c, PasswordResetInput);
  await rateLimit(c, "reset");
  const db = c.env.DB;
  const tokenHash = await sha256Hex(input.token);
  const pwHash = await hashPassword(input.new_password);
  const now = Date.now();
  const owner = "(SELECT user_id FROM password_resets WHERE token_hash = ? AND used_at = ?)";
  // One transaction: the password/session statements only match if the claim succeeded.
  const [claim] = await db.batch([
    db
      .prepare("UPDATE password_resets SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?")
      .bind(now, tokenHash, now),
    db.prepare(`UPDATE users SET password_hash = ? WHERE id = ${owner}`).bind(pwHash, tokenHash, now),
    db.prepare(`DELETE FROM sessions WHERE user_id = ${owner}`).bind(tokenHash, now),
  ]);
  if (claim!.meta.changes !== 1) throw new ApiError(404, "invalid_reset", "reset link is invalid, used, or expired");
  return c.body(null, 204);
});
