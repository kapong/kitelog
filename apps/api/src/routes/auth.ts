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
import { LoginInput, SignupInput, type AuthStatus, type InviteLookup } from "@kitelog/shared";
import type { AppEnv, UserRow } from "../env";
import { ApiError, body, userOut } from "../http";
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

// Public: the signup page shows "create admin" (no users yet) or whether signup is open.
auth.get("/status", async (c) => {
  const [users, open] = await c.env.DB.batch<{ n: number } | { value: string }>([
    c.env.DB.prepare("SELECT EXISTS (SELECT 1 FROM users) AS n"),
    c.env.DB.prepare("SELECT value FROM settings WHERE key = 'open_signup'"),
  ]);
  return c.json({
    needs_setup: (users!.results[0] as { n: number }).n === 0,
    open_signup: (open!.results[0] as { value: string } | undefined)?.value === "true",
  } satisfies AuthStatus);
});

// Public: the web invite page shows which email an invite is for. 404 unless usable.
auth.get("/invite/:token", async (c) => {
  const row = await c.env.DB.prepare(
    "SELECT email, expires_at FROM invites WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?",
  )
    .bind(await sha256Hex(c.req.param("token")), Date.now())
    .first<InviteLookup>();
  if (!row) throw new ApiError(404, "invalid_invite", "invite is invalid, used, or expired");
  return c.json(row);
});

// First user → admin, no invite. Afterwards: valid invite for this email, or settings.open_signup.
auth.post("/signup", async (c) => {
  const input = await body(c, SignupInput);
  const db = c.env.DB;
  const id = crypto.randomUUID();
  const now = Date.now();
  const pwHash = await hashPassword(input.password);
  const insert = (isAdmin: number) =>
    db
      .prepare("INSERT INTO users (id, email, password_hash, name, is_admin, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(id, input.email, pwHash, input.name ?? null, isAdmin, now);

  if (await db.prepare("SELECT 1 FROM users WHERE email = ?").bind(input.email).first()) {
    throw new ApiError(409, "email_taken", "email already registered");
  }

  // Single statement, so two racing "first" signups cannot both become admin.
  const first = await db
    .prepare(
      `INSERT INTO users (id, email, password_hash, name, is_admin, created_at)
       SELECT ?, ?, ?, ?, 1, ? WHERE NOT EXISTS (SELECT 1 FROM users)`,
    )
    .bind(id, input.email, pwHash, input.name ?? null, now)
    .run();

  if (first.meta.changes === 0) {
    if (input.invite_token) {
      const tokenHash = await sha256Hex(input.invite_token);
      // One transaction: claim the invite (only if unused/unexpired/same email), insert the user only if claimed.
      const [claim] = await db.batch([
        db
          .prepare(
            `UPDATE invites SET used_at = ? WHERE token_hash = ? AND email = ? AND used_at IS NULL AND expires_at > ?`,
          )
          .bind(now, tokenHash, input.email, now),
        db
          .prepare(
            `INSERT INTO users (id, email, password_hash, name, is_admin, created_at)
             SELECT ?, ?, ?, ?, 0, ? WHERE EXISTS (SELECT 1 FROM invites WHERE token_hash = ? AND email = ? AND used_at = ?)`,
          )
          .bind(id, input.email, pwHash, input.name ?? null, now, tokenHash, input.email, now),
      ]);
      if (claim!.meta.changes !== 1) throw new ApiError(403, "invalid_invite", "invite is invalid, used, or expired");
    } else {
      const open = await db.prepare("SELECT value FROM settings WHERE key = 'open_signup'").first<{ value: string }>();
      if (open?.value !== "true") throw new ApiError(403, "invite_required", "signup requires an invite");
      await insert(0).run();
    }
  }

  await startSession(c, id);
  const user = await db.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<UserRow>();
  return c.json(userOut(user!), 201);
});

auth.post("/login", async (c) => {
  const input = await body(c, LoginInput);
  const user = await c.env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(input.email).first<UserRow>();
  // ponytail: no login rate limit yet; add a Cloudflare rate-limiting rule or binding when needed.
  const ok = user
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
