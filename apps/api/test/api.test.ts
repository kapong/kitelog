import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Capabilities, ErrorBody, InviteCreated, Project, ProjectInfo, StorageConfig, User } from "@kitelog/shared";

// One flow, sequential: later steps depend on earlier ones (storage persists within this file).
type Client = { cookie?: string };
const BASE = "http://kitelog.test/api/v1";

async function call(who: Client | string | null, method: string, path: string, json?: unknown) {
  const headers: Record<string, string> = {};
  if (typeof who === "string") headers.Authorization = `Bearer ${who}`;
  else if (who?.cookie) headers.Cookie = who.cookie;
  if (json !== undefined) headers["Content-Type"] = "application/json";
  const res = await exports.default.fetch(
    new Request(BASE + path, { method, headers, body: json === undefined ? undefined : JSON.stringify(json) }),
  );
  const set = res.headers.get("Set-Cookie");
  if (set && who && typeof who === "object") who.cookie = set.split(";")[0];
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, text, setCookie: set };
}

const admin: Client = {};
const bob: Client = {};
const carol: Client = {};
const pw = "correct horse battery";

describe("accounts and projects", () => {
  afterEach(() => vi.restoreAllMocks());

  it("first signup becomes admin; session cookie set (not Secure on http)", async () => {
    expect((await call(null, "GET", "/auth/status")).body).toEqual({ needs_setup: true, open_signup: false });
    const r = await call(admin, "POST", "/auth/signup", { email: "Admin@Example.com", password: pw });
    expect((await call(null, "GET", "/auth/status")).body).toEqual({ needs_setup: false, open_signup: false });
    expect(r.status).toBe(201);
    const u = User.parse(r.body);
    expect(u.is_admin).toBe(true);
    expect(u.email).toBe("admin@example.com");
    expect(r.setCookie).toMatch(/^kl_session=.+HttpOnly/);
    expect(r.setCookie).not.toMatch(/Secure/);
  });

  it("second signup without invite is blocked", async () => {
    const r = await call(bob, "POST", "/auth/signup", { email: "bob@example.com", password: pw });
    expect(r.status).toBe(403);
    expect(ErrorBody.parse(r.body).error.code).toBe("invite_required");
  });

  it("bad input → 400 invalid_input", async () => {
    const r = await call(bob, "POST", "/auth/signup", { email: "nope", password: "x" });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("invalid_input");
  });

  it("invite flow: admin creates, wrong email rejected, invitee signs up, token single-use", async () => {
    expect((await call(bob, "POST", "/invites", { email: "x@example.com" })).status).toBe(401);
    const r = await call(admin, "POST", "/invites", { email: "bob@example.com" });
    expect(r.status).toBe(201);
    const inv = InviteCreated.parse(r.body);
    const wrong = await call({}, "POST", "/auth/signup", { email: "eve@example.com", password: pw, invite_token: inv.token });
    expect(wrong.status).toBe(403);
    const ok = await call(bob, "POST", "/auth/signup", { email: "bob@example.com", password: pw, invite_token: inv.token });
    expect(ok.status).toBe(201);
    expect(User.parse(ok.body).is_admin).toBe(false);
    const again = await call({}, "POST", "/auth/signup", { email: "bob2@example.com", password: pw, invite_token: inv.token });
    expect(again.status).toBe(403);
    const list = await call(admin, "GET", "/invites");
    expect(list.body[0].used_at).not.toBeNull();
    expect(list.text).not.toContain(inv.token);
    expect((await call(bob, "GET", "/invites")).status).toBe(403);
  });

  it("open signup setting lets anyone sign up", async () => {
    expect((await call(bob, "PATCH", "/settings", { open_signup: true })).status).toBe(403);
    expect((await call(admin, "PATCH", "/settings", { open_signup: true })).body).toEqual({ open_signup: true });
    expect((await call(carol, "POST", "/auth/signup", { email: "carol@example.com", password: pw })).status).toBe(201);
    await call(admin, "PATCH", "/settings", { open_signup: false });
    expect((await call(admin, "GET", "/settings")).body).toEqual({ open_signup: false });
  });

  it("login / me / logout", async () => {
    const bad = await call({}, "POST", "/auth/login", { email: "bob@example.com", password: "wrong password" });
    const missing = await call({}, "POST", "/auth/login", { email: "ghost@example.com", password: pw });
    expect(bad.status).toBe(401);
    expect(missing.body).toEqual(bad.body); // generic error
    const s: Client = {};
    expect((await call(s, "POST", "/auth/login", { email: "bob@example.com", password: pw })).status).toBe(200);
    expect(User.parse((await call(s, "GET", "/auth/me")).body).email).toBe("bob@example.com");
    expect((await call(s, "POST", "/auth/logout")).status).toBe(204);
    const old = { cookie: s.cookie }; // cleared cookie; also check the old token is dead
    expect((await call(old, "GET", "/auth/me")).status).toBe(401);
  });

  it("expired session rejected", async () => {
    const s: Client = {};
    await call(s, "POST", "/auth/login", { email: "carol@example.com", password: pw });
    await env.DB.prepare("UPDATE sessions SET expires_at = 1 WHERE user_id = (SELECT id FROM users WHERE email = 'carol@example.com')").run();
    expect((await call(s, "GET", "/auth/me")).status).toBe(401);
    await call(carol, "POST", "/auth/login", { email: "carol@example.com", password: pw });
  });

  it("projects + member roles", async () => {
    const r = await call(bob, "POST", "/projects", { slug: "proj", name: "Proj" });
    expect(r.status).toBe(201);
    Project.parse(r.body);
    expect((await call(admin, "POST", "/projects", { slug: "proj", name: "dup" })).status).toBe(409);
    // non-member (even admin) → 404
    expect((await call(admin, "GET", "/projects/proj")).status).toBe(404);
    expect((await call(carol, "GET", "/projects/proj/members")).status).toBe(404);
    // add carol as viewer
    const add = await call(bob, "POST", "/projects/proj/members", { email: "carol@example.com", role: "viewer" });
    expect(add.status).toBe(201);
    const carolId = add.body.user_id;
    expect((await call(carol, "GET", "/projects")).body.map((p: { slug: string }) => p.slug)).toEqual(["proj"]);
    expect((await call(carol, "GET", "/projects/proj/members")).body).toHaveLength(2);
    // viewer cannot create keys / patch / manage members
    expect((await call(carol, "POST", "/projects/proj/keys", { name: "k", scope: "write" })).status).toBe(403);
    expect((await call(carol, "PATCH", "/projects/proj", { name: "x" })).status).toBe(403);
    expect((await call(carol, "POST", "/projects/proj/members", { email: "admin@example.com", role: "owner" })).status).toBe(403);
    // last owner cannot be demoted or removed
    const bobId = (await call(bob, "GET", "/auth/me")).body.id;
    expect((await call(bob, "PATCH", `/projects/proj/members/${bobId}`, { role: "editor" })).status).toBe(409);
    expect((await call(bob, "DELETE", `/projects/proj/members/${bobId}`)).status).toBe(409);
    // promote carol to editor, owner patches project
    expect((await call(bob, "PATCH", `/projects/proj/members/${carolId}`, { role: "editor" })).body.role).toBe("editor");
    expect((await call(bob, "PATCH", "/projects/proj", { description: "d" })).body.description).toBe("d");
  });

  it("api keys: editor creates, Bearer GET /project returns fallback caps, revoked → 401", async () => {
    const r = await call(carol, "POST", "/projects/proj/keys", { name: "train", scope: "write" });
    expect(r.status).toBe(201);
    const key: string = r.body.key;
    expect(key).toMatch(/^kl_/);
    const list = await call(carol, "GET", "/projects/proj/keys");
    expect(list.text).not.toContain(key);
    const info = await call(key, "GET", "/project");
    expect(info.status).toBe(200);
    const parsed = ProjectInfo.parse(info.body);
    expect(parsed.project.slug).toBe("proj");
    expect(Capabilities.parse(parsed.capabilities)).toEqual({
      can_save: { checkpoint: true, artifact: false },
      max_checkpoint_bytes: 100 * 1024 * 1024,
      keep_checkpoints: 1,
      metric_types: ["number"],
    });
    expect((await call("kl_bogus", "GET", "/project")).status).toBe(401);
    expect((await call(null, "GET", "/project")).status).toBe(401);
    expect((await call(carol, "DELETE", `/projects/proj/keys/${r.body.id}`)).status).toBe(204);
    expect((await call(key, "GET", "/project")).status).toBe(401);
  });

  const cfg = {
    endpoint: "https://s3.example.com",
    bucket: "my-bucket",
    access_key_id: "AKIAEXAMPLE123",
    secret_access_key: "SUPER-SECRET-VALUE",
    path_style: true,
  };

  it("storage PUT rejected when probe fails; nothing saved", async () => {
    const f = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("denied", { status: 403 }));
    const r = await call(bob, "PUT", "/projects/proj/storage", cfg);
    expect(f).toHaveBeenCalled();
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("storage_probe_failed");
    expect(r.body.error.step).toBe("put");
    expect((await call(bob, "GET", "/projects/proj/storage")).body).toBeNull();
    expect((await call(carol, "PUT", "/projects/proj/storage", cfg)).status).toBe(403); // editor
    for (const endpoint of ["http://s3.example.com", "https://localhost:9000", "https://10.0.0.5"]) {
      const bad = await call(bob, "PUT", "/projects/proj/storage", { ...cfg, endpoint });
      expect(bad.status).toBe(400);
      expect(bad.body.error.code).toBe("invalid_endpoint");
    }
  });

  it("ALLOW_PRIVATE_S3_ENDPOINTS lets http / private hosts through to the probe", async () => {
    const e = env as unknown as Record<string, string | undefined>;
    const urls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      urls.push(input instanceof Request ? input.url : String(input));
      return new Response("denied", { status: 403 });
    });
    e.ALLOW_PRIVATE_S3_ENDPOINTS = "true";
    try {
      const r = await call(bob, "POST", "/projects/proj/storage/test", { ...cfg, endpoint: "http://localhost:9000" });
      expect(r.body.error.code).toBe("storage_probe_failed"); // passed the guard, reached S3
      expect(urls[0]).toMatch(/^http:\/\/localhost:9000\/my-bucket\//);
    } finally {
      delete e.ALLOW_PRIVATE_S3_ENDPOINTS;
    }
  });

  it("storage PUT saves after probe; secret never returned; capabilities switch", async () => {
    const objects = new Map<string, string>();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const req = new Request(input as RequestInfo, init);
      const k = new URL(req.url).pathname;
      if (req.method === "PUT") objects.set(k, await req.text());
      if (req.method === "GET") return objects.has(k) ? new Response(objects.get(k)) : new Response("", { status: 404 });
      if (req.method === "DELETE") objects.delete(k);
      return new Response(null, { status: 200 });
    });
    expect((await call(bob, "POST", "/projects/proj/storage/test", cfg)).body).toEqual({ ok: true });
    const put = await call(bob, "PUT", "/projects/proj/storage", cfg);
    expect(put.status).toBe(200);
    const get = await call(bob, "GET", "/projects/proj/storage");
    expect(StorageConfig.parse(get.body).access_key_prefix).toBe("AKIA");
    for (const t of [put.text, get.text]) {
      expect(t).not.toContain("SUPER-SECRET");
      expect(t).not.toContain("AKIAEXAMPLE123");
    }
    const row = await env.DB.prepare("SELECT secret_enc FROM project_storage").first<{ secret_enc: string }>();
    expect(row!.secret_enc).not.toContain("SUPER-SECRET");
    const key = (await call(bob, "POST", "/projects/proj/keys", { name: "r", scope: "read" })).body.key;
    const caps = (await call(key, "GET", "/project")).body.capabilities;
    expect(caps.can_save.artifact).toBe(true);
    expect((await call(bob, "DELETE", "/projects/proj/storage")).status).toBe(204);
    expect((await call(key, "GET", "/project")).body.capabilities.can_save.artifact).toBe(false);
  });

  it("project delete (owner only) cascades", async () => {
    expect((await call(carol, "DELETE", "/projects/proj")).status).toBe(403);
    expect((await call(bob, "DELETE", "/projects/proj")).status).toBe(204);
    expect((await call(bob, "GET", "/projects/proj")).status).toBe(404);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM api_keys").first<{ n: number }>();
    expect(n!.n).toBe(0);
  });

  it("unknown route → JSON 404", async () => {
    const r = await call(null, "GET", "/nope");
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe("not_found");
  });
});
