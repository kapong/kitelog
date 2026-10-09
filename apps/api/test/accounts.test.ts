import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { hashPassword, newSessionToken, sha256Hex } from "@kitelog/auth";
import { AdminUser, PasswordResetCreated, PasswordResetLookup } from "@kitelog/shared";

// Self-contained: users and sessions inserted directly. Each test uses its own emails / IPs.
const BASE = "http://kitelog.test/api/v1";
const pw = "correct horse battery";
let ipN = 0;

async function call(cookie: string | null, method: string, path: string, json?: unknown, ip = `10.0.0.${++ipN}`) {
  const headers: Record<string, string> = { "CF-Connecting-IP": ip };
  if (cookie) headers.Cookie = cookie;
  if (json !== undefined) headers["Content-Type"] = "application/json";
  const res = await exports.default.fetch(
    new Request(BASE + path, { method, headers, body: json === undefined ? undefined : JSON.stringify(json) }),
  );
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}

async function user(email: string, isAdmin = 0) {
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO users (id, email, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(id, email, await hashPassword(pw), isAdmin, Date.now())
    .run();
  return { id, cookie: await session(id) };
}

async function session(userId: string) {
  const { token, tokenHash } = await newSessionToken();
  await env.DB.prepare("INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)")
    .bind(crypto.randomUUID(), userId, tokenHash, Date.now() + 3600_000)
    .run();
  return `kl_session=${token}`;
}

const sessionsOf = async (userId: string) =>
  (await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?").bind(userId).first<{ n: number }>())!.n;
const me = async (cookie: string) => (await call(cookie, "GET", "/auth/me")).status;

describe("rate limiting (AUTH_LIMITER binding)", () => {
  it("login: 10 per minute per (IP, email), then 429 rate_limited with Retry-After", async () => {
    await user("rl@example.com");
    const login = (ip: string, email = "rl@example.com") => call(null, "POST", "/auth/login", { email, password: "wrong password" }, ip);
    for (let i = 0; i < 10; i++) expect((await login("10.9.9.9")).status).toBe(401);
    const r = await login("10.9.9.9");
    expect(r.status).toBe(429);
    expect(r.body.error.code).toBe("rate_limited");
    expect(r.headers.get("Retry-After")).toBe("60");
    // email is lowercased for the key; other IPs / emails are unaffected
    expect((await login("10.9.9.9", "RL@example.com")).status).toBe(429);
    expect((await login("10.9.9.8")).status).toBe(401);
    expect((await login("10.9.9.9", "other@example.com")).status).toBe(401);
  });

  it("reset lookup and reset share the per-IP `reset` budget", async () => {
    const ip = "10.9.8.7";
    for (let i = 0; i < 5; i++) expect((await call(null, "POST", "/auth/reset/lookup", { token: "bogus" }, ip)).status).toBe(404);
    for (let i = 0; i < 5; i++)
      expect((await call(null, "POST", "/auth/reset", { token: "bogus", new_password: "brand new pass" }, ip)).status).toBe(404);
    const r = await call(null, "POST", "/auth/reset/lookup", { token: "bogus" }, ip);
    expect(r.status).toBe(429);
    expect(r.body.error.code).toBe("rate_limited");
    expect((await call(null, "POST", "/auth/reset/lookup", { token: "bogus" }, "10.9.8.6")).status).toBe(404);
  });
});

describe("password change", () => {
  it("wrong current → 400; success revokes other sessions, keeps this one; new password logs in", async () => {
    const u = await user("pc@example.com");
    const other = await session(u.id);
    const wrong = await call(u.cookie, "POST", "/auth/password", { current_password: "nope", new_password: "new password 1" });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.code).toBe("wrong_password");
    expect((await call(u.cookie, "POST", "/auth/password", { current_password: pw, new_password: "short" })).status).toBe(400);
    expect((await call(null, "POST", "/auth/password", { current_password: pw, new_password: "new password 1" })).status).toBe(401);

    expect((await call(u.cookie, "POST", "/auth/password", { current_password: pw, new_password: "new password 1" })).status).toBe(204);
    expect(await me(u.cookie)).toBe(200);
    expect(await me(other)).toBe(401);
    expect(await sessionsOf(u.id)).toBe(1);
    expect((await call(null, "POST", "/auth/login", { email: "pc@example.com", password: pw })).status).toBe(401);
    expect((await call(null, "POST", "/auth/login", { email: "pc@example.com", password: "new password 1" })).status).toBe(200);
  });
});

describe("admin users and password resets", () => {
  it("list users: admin only", async () => {
    const a = await user("adm-list@example.com", 1);
    const n = await user("plain-list@example.com");
    expect((await call(n.cookie, "GET", "/admin/users")).status).toBe(403);
    const r = await call(a.cookie, "GET", "/admin/users");
    expect(r.status).toBe(200);
    const list = AdminUser.strict().array().parse(r.body);
    expect(list.find((x) => x.id === a.id)?.is_admin).toBe(true);
    expect(JSON.stringify(r.body)).not.toContain("password");
    expect((await call(n.cookie, "POST", `/admin/users/${a.id}/reset`)).status).toBe(403);
  });

  it("reset: create → lookup → use → reuse 404 → sessions gone → new password works", async () => {
    const a = await user("adm-reset@example.com", 1);
    const u = await user("target@example.com");
    const other = await session(u.id);
    expect((await call(a.cookie, "POST", `/admin/users/nope/reset`)).status).toBe(404);
    const r = await call(a.cookie, "POST", `/admin/users/${u.id}/reset`);
    expect(r.status).toBe(201);
    const { token, expires_at } = PasswordResetCreated.strict().parse(r.body);
    expect(expires_at - Date.now()).toBeGreaterThan(23 * 3600_000);
    expect(expires_at - Date.now()).toBeLessThanOrEqual(24 * 3600_000);

    const look = await call(null, "POST", "/auth/reset/lookup", { token });
    expect(PasswordResetLookup.strict().parse(look.body)).toEqual({ email: "target@example.com", expires_at });
    expect((await call(null, "POST", "/auth/reset/lookup", { token: "bogus" })).body.error.code).toBe("invalid_reset");

    expect((await call(null, "POST", "/auth/reset", { token, new_password: "short" })).status).toBe(400);
    expect((await call(null, "POST", "/auth/reset", { token, new_password: "brand new pass" })).status).toBe(204);
    const again = await call(null, "POST", "/auth/reset", { token, new_password: "another new pass" });
    expect(again.status).toBe(404);
    expect(again.body.error.code).toBe("invalid_reset");
    expect((await call(null, "POST", "/auth/reset/lookup", { token })).status).toBe(404);

    expect(await me(u.cookie)).toBe(401);
    expect(await me(other)).toBe(401);
    expect(await sessionsOf(u.id)).toBe(0);
    expect((await call(null, "POST", "/auth/login", { email: "target@example.com", password: pw })).status).toBe(401);
    expect((await call(null, "POST", "/auth/login", { email: "target@example.com", password: "brand new pass" })).status).toBe(200);
  });

  it("expired token rejected; a newer reset invalidates the older one", async () => {
    const a = await user("adm-exp@example.com", 1);
    const u = await user("exp@example.com");
    const t1 = PasswordResetCreated.parse((await call(a.cookie, "POST", `/admin/users/${u.id}/reset`)).body).token;
    const t2 = PasswordResetCreated.parse((await call(a.cookie, "POST", `/admin/users/${u.id}/reset`)).body).token;
    expect((await call(null, "POST", "/auth/reset/lookup", { token: t1 })).status).toBe(404);
    expect((await call(null, "POST", "/auth/reset", { token: t1, new_password: "brand new pass" })).status).toBe(404);
    expect((await call(null, "POST", "/auth/reset/lookup", { token: t2 })).status).toBe(200);

    await env.DB.prepare("UPDATE password_resets SET expires_at = 1 WHERE token_hash = ?").bind(await sha256Hex(t2)).run();
    expect((await call(null, "POST", "/auth/reset/lookup", { token: t2 })).status).toBe(404);
    expect((await call(null, "POST", "/auth/reset", { token: t2, new_password: "brand new pass" })).status).toBe(404);
    expect(await me(u.cookie)).toBe(200); // failed resets change nothing
  });

  it("create user: no usable password, 7-day set-password link; admin flag; non-admin 403", async () => {
    const a = await user("adm-create@example.com", 1);
    const n = await user("plain-create@example.com");
    expect((await call(n.cookie, "POST", "/admin/users", { email: "new@example.com" })).status).toBe(403);
    const r = await call(a.cookie, "POST", "/admin/users", { email: "New2@Example.com", name: "N", is_admin: true });
    expect(r.status).toBe(201);
    expect(r.body.user).toMatchObject({ email: "new2@example.com", name: "N", is_admin: true });
    expect(r.body.reset.expires_at - Date.now()).toBeGreaterThan(6.9 * 24 * 3600_000);
    const row = await env.DB.prepare("SELECT password_hash FROM users WHERE email = 'new2@example.com'").first<{ password_hash: string }>();
    expect(row!.password_hash).toBe("!");
    expect((await call(a.cookie, "POST", "/admin/users", { email: "new2@example.com" })).status).toBe(409);
  });

  it("patch / delete: no self-demotion or self-deletion, last owner protected, cascade", async () => {
    const a = await user("adm-pd@example.com", 1);
    const u = await user("pd@example.com");
    expect((await call(a.cookie, "PATCH", `/admin/users/${a.id}`, { is_admin: false })).body.error.code).toBe("last_admin");
    expect((await call(a.cookie, "DELETE", `/admin/users/${a.id}`)).body.error.code).toBe("last_admin");

    const promoted = await call(a.cookie, "PATCH", `/admin/users/${u.id}`, { is_admin: true });
    expect(AdminUser.parse(promoted.body).is_admin).toBe(true);
    expect((await call(a.cookie, "PATCH", `/admin/users/${u.id}`, { is_admin: false })).body.is_admin).toBe(false);
    expect((await call(a.cookie, "PATCH", "/admin/users/nope", { is_admin: true })).status).toBe(404);

    const pid = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO projects (id, slug, name, created_at) VALUES (?, 'pd-proj', 'p', ?)").bind(pid, Date.now()).run();
    await env.DB.prepare("INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, 'owner')").bind(pid, u.id).run();
    const owned = await call(a.cookie, "DELETE", `/admin/users/${u.id}`);
    expect(owned.status).toBe(409);
    expect(owned.body.error.code).toBe("last_owner");

    await env.DB.prepare("INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, 'owner')").bind(pid, a.id).run();
    expect((await call(a.cookie, "DELETE", `/admin/users/${u.id}`)).status).toBe(204);
    expect(await sessionsOf(u.id)).toBe(0);
    const m = await env.DB.prepare("SELECT COUNT(*) AS n FROM project_members WHERE user_id = ?").bind(u.id).first<{ n: number }>();
    expect(m!.n).toBe(0);
    expect((await call(a.cookie, "DELETE", `/admin/users/${u.id}`)).status).toBe(404);
  });

  it("the only admin cannot demote itself; a demoted admin loses admin routes", async () => {
    await env.DB.prepare("UPDATE users SET is_admin = 0").run();
    const a = await user("adm-last@example.com", 1);
    const b = await user("adm-last2@example.com", 1);
    expect((await call(a.cookie, "PATCH", `/admin/users/${b.id}`, { is_admin: false })).status).toBe(200);
    // a is now the only admin; b (non-admin) cannot act; a cannot demote itself
    expect((await call(b.cookie, "PATCH", `/admin/users/${a.id}`, { is_admin: false })).status).toBe(403);
    expect((await call(a.cookie, "PATCH", `/admin/users/${a.id}`, { is_admin: false })).status).toBe(409);
  });
});
