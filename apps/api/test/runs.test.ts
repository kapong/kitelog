import { env, exports } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { newApiKey, newSessionToken } from "@kitelog/auth";
import { encryptSecret } from "@kitelog/storage";
import { AuthStatus, FileInfo, MetricsRead, Project, RunCreated, RunWithMetrics, UploadCreated } from "@kitelog/shared";

// Self-contained: users / projects / keys inserted directly so this file does not depend on
// api.test.ts. Sequential flow; later steps depend on earlier ones.
const BASE = "http://kitelog.test/api/v1";
const uid = () => crypto.randomUUID();

async function call(who: string | null, method: string, path: string, json?: unknown, extra: Record<string, string> = {}) {
  const headers: Record<string, string> = { ...extra };
  if (who?.startsWith("kl_session=")) headers.Cookie = who;
  else if (who) headers.Authorization = `Bearer ${who}`;
  if (json !== undefined) headers["Content-Type"] = "application/json";
  const res = await exports.default.fetch(
    new Request(BASE + path, { method, headers, body: json === undefined ? undefined : JSON.stringify(json), redirect: "manual" }),
  );
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {}
  return { status: res.status, body, text, headers: res.headers };
}

async function user(email: string): Promise<{ id: string; cookie: string }> {
  const id = uid();
  await env.DB.prepare("INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, 'x', ?)").bind(id, email, Date.now()).run();
  const { token, tokenHash } = await newSessionToken();
  await env.DB.prepare("INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)")
    .bind(uid(), id, tokenHash, Date.now() + 3600_000)
    .run();
  return { id, cookie: `kl_session=${token}` };
}

async function project(slug: string, members: [string, string][]): Promise<string> {
  const id = uid();
  await env.DB.prepare("INSERT INTO projects (id, slug, name, created_at) VALUES (?, ?, ?, ?)").bind(id, slug, slug, Date.now()).run();
  for (const [u, role] of members) {
    await env.DB.prepare("INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, ?)").bind(id, u, role).run();
  }
  return id;
}

async function apiKey(projectId: string, scope = "write"): Promise<string> {
  const { key, prefix, keyHash } = await newApiKey();
  await env.DB.prepare("INSERT INTO api_keys (id, project_id, name, prefix, key_hash, scope, created_at) VALUES (?, ?, 'k', ?, ?, ?, ?)")
    .bind(uid(), projectId, prefix, keyHash, scope, Date.now())
    .run();
  return key;
}

const r2Keys = async (prefix: string) => (await env.BUCKET.list({ prefix })).objects.map((o) => o.key).sort();
/** Chunk names carry a random suffix: compare as `chunk-{n}-*`. */
const unsuffix = (keys: string[]) => keys.map((k) => k.replace(/(chunk-\d{6})-[0-9a-f]{8}\.parquet$/, "$1-*.parquet"));
const pts = (key: string, steps: number[], ts: number, v = (s: number) => s) => steps.map((step) => ({ key, step, value: v(step), ts }));

let owner: { id: string; cookie: string };
let viewer: { id: string; cookie: string };
let pid: string;
let key: string;
let otherKey: string;
let readKey: string;
let rid: string;

beforeAll(async () => {
  owner = await user("owner-3b@example.com");
  viewer = await user("viewer-3b@example.com");
  pid = await project("p3b", [
    [owner.id, "owner"],
    [viewer.id, "viewer"],
  ]);
  key = await apiKey(pid);
  readKey = await apiKey(pid, "read");
  otherKey = await apiKey(await project("other-3b", [[owner.id, "owner"]]));
});

afterEach(() => vi.restoreAllMocks());

describe("runs + metrics (fallback R2)", () => {
  it("create run → 201 with last_seq -1, default name", async () => {
    const r = await call(key, "POST", "/runs", { config: { lr: 0.1 }, tags: ["a"] });
    expect(r.status).toBe(201);
    const created = RunCreated.parse(r.body);
    expect(created.last_seq).toBe(-1);
    rid = created.id;
    const run = RunWithMetrics.parse((await call(viewer.cookie, "GET", `/projects/p3b/runs/${rid}`)).body);
    expect(run.name).toMatch(/^run-[0-9a-f]{8}$/);
    expect(run.status).toBe("running");
    expect(run.config).toEqual({ lr: 0.1 });
    expect((await call(readKey, "POST", "/runs", {})).status).toBe(403);
  });

  it("flush seq 0,1,2; retry seq 2 idempotent; seq 1 → 409 with last_seq", async () => {
    for (const seq of [0, 1, 2]) {
      const steps = [seq * 10, seq * 10 + 5];
      const r = await call(key, "POST", `/runs/${rid}/metrics`, {
        writer_id: 0,
        seq,
        points: [...pts("loss", steps, 1000 + seq, (s) => 100 - s), ...pts("acc", steps, 1000 + seq, (s) => s / 100)],
      });
      expect(r.status).toBe(200);
      expect(r.body.last_seq).toBe(seq);
    }
    const retry = await call(key, "POST", `/runs/${rid}/metrics`, { writer_id: 0, seq: 2, points: pts("loss", [20, 25], 1002, (s) => 100 - s) });
    expect(retry.status).toBe(200);
    const stale = await call(key, "POST", `/runs/${rid}/metrics`, { writer_id: 0, seq: 1, points: [] });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatchObject({ code: "seq_conflict", last_seq: 2 });
    const base = `p/${pid}/r/${rid}/metrics/`;
    expect(await r2Keys(base)).toEqual([0, 1, 2].map((s) => `${base}seg-0-00000${s}.parquet`));
    const run = RunWithMetrics.parse((await call(viewer.cookie, "GET", `/projects/p3b/runs/${rid}`)).body);
    expect(run.metrics).toEqual({ loss: { step: 25, value: 75 }, acc: { step: 25, value: 0.25 } });
  });

  it("invalid values rejected (numeric only, key rules)", async () => {
    const bad = [{ key: "loss", step: 1, value: "x", ts: 1 }];
    expect((await call(key, "POST", `/runs/${rid}/metrics`, { writer_id: 0, seq: 3, points: bad })).status).toBe(400);
    const badKey = [{ key: "a,b", step: 1, value: 1, ts: 1 }];
    expect((await call(key, "POST", `/runs/${rid}/metrics`, { writer_id: 0, seq: 3, points: badKey })).status).toBe(400);
  });

  it("resume returns each writer's last_seq; writer 1 flushes", async () => {
    const w0 = await call(key, "POST", "/runs", { resume: rid, writer_id: 0 });
    expect(w0.status).toBe(200);
    expect(w0.body).toEqual({ id: rid, last_seq: 2 });
    const w1 = await call(key, "POST", "/runs", { resume: rid, writer_id: 1 });
    expect(w1.body).toEqual({ id: rid, last_seq: -1 });
    // writer 1 writes step 5 of loss with a later ts → wins over writer 0's step 5
    for (const seq of [0, 1]) {
      const r = await call(key, "POST", `/runs/${rid}/metrics`, { writer_id: 1, seq, points: pts("loss", [5 + seq * 100], 5000, () => -1) });
      expect(r.status).toBe(200);
    }
  });

  it("join by a new user-chosen id: concurrent ranks create one run; separate writer rows", async () => {
    const [a, b] = await Promise.all([
      call(key, "POST", "/runs", { resume: "exp-42", writer_id: 0 }),
      call(key, "POST", "/runs", { resume: "exp-42", writer_id: 1 }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(a.body).toEqual({ id: "exp-42", last_seq: -1 });
    expect(b.body).toEqual({ id: "exp-42", last_seq: -1 });
    const runRows = await env.DB.prepare("SELECT project_id, name FROM runs WHERE id = 'exp-42'").all();
    expect(runRows.results).toEqual([{ project_id: pid, name: "exp-42" }]);
    const writers = await env.DB.prepare("SELECT writer_id FROM run_writers WHERE run_id = 'exp-42' ORDER BY writer_id").all();
    expect(writers.results).toEqual([{ writer_id: 0 }, { writer_id: 1 }]);
    // joining again → 200; an id owned by another project → 404 (never created or leaked)
    expect((await call(key, "POST", "/runs", { resume: "exp-42", writer_id: 2 })).status).toBe(200);
    expect((await call(otherKey, "POST", "/runs", { resume: "exp-42" })).status).toBe(404);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM runs WHERE id = 'exp-42'").first())!.n).toBe(1);
    for (const bad of ["", "a b", "x/y", "é", "a".repeat(65)]) {
      expect((await call(key, "POST", "/runs", { resume: bad })).status).toBe(400);
    }
    await env.DB.prepare("DELETE FROM runs WHERE id = 'exp-42'").run(); // keep later list tests exact
  });

  it("key from another project → 404", async () => {
    expect((await call(otherKey, "POST", `/runs/${rid}/metrics`, { writer_id: 0, seq: 9, points: [] })).status).toBe(404);
    expect((await call(otherKey, "PATCH", `/runs/${rid}`, { summary: {} })).status).toBe(404);
    expect((await call(otherKey, "POST", "/runs", { resume: rid })).status).toBe(404);
    expect((await call(otherKey, "POST", `/runs/${rid}/metrics/compact`)).status).toBe(404);
  });

  it("compact → chunk written, segments deleted, compacted_seq set; read merges", async () => {
    const base = `p/${pid}/r/${rid}/metrics/`;
    const r = await call(key, "POST", `/runs/${rid}/metrics/compact`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ chunks: 1, segments: 5, more: false });
    expect(unsuffix(await r2Keys(base))).toEqual([`${base}chunk-000000-*.parquet`]);
    const w = await env.DB.prepare("SELECT writer_id, compacted_seq FROM run_writers WHERE run_id = ? ORDER BY writer_id").bind(rid).all();
    expect(w.results).toEqual([
      { writer_id: 0, compacted_seq: 2 },
      { writer_id: 1, compacted_seq: 1 },
    ]);
    // retry of a compacted seq (same payload): accepted, nothing rewritten
    expect((await call(key, "POST", `/runs/${rid}/metrics`, { writer_id: 1, seq: 1, points: pts("loss", [105], 5000, () => -1) })).status).toBe(200);
    expect(unsuffix(await r2Keys(base))).toEqual([`${base}chunk-000000-*.parquet`]);
    // new pending segment after the chunk
    await call(key, "POST", `/runs/${rid}/metrics`, { writer_id: 0, seq: 3, points: pts("loss", [30], 1003, () => 70) });

    const m = await call(viewer.cookie, "GET", `/projects/p3b/runs/${rid}/metrics?keys=loss,acc&points=100`);
    expect(m.status).toBe(200);
    const { series } = MetricsRead.parse(m.body);
    expect(series.loss).toEqual({ step: [0, 5, 10, 15, 20, 25, 30, 105], value: [100, -1, 90, 85, 80, 75, 70, -1] });
    // the seq-2 retry carried only `loss`, so its overwrite dropped acc@20,25 (retry = same object)
    expect(series.acc!.step).toEqual([0, 5, 10, 15]);
    expect((await call(viewer.cookie, "GET", `/projects/p3b/runs/${rid}/metrics?keys=`)).status).toBe(400);

    // second compaction → next chunk number
    expect((await call(key, "POST", `/runs/${rid}/metrics/compact`)).body).toEqual({ chunks: 1, segments: 1, more: false });
    expect(unsuffix(await r2Keys(base))).toEqual([`${base}chunk-000000-*.parquet`, `${base}chunk-000001-*.parquet`]);
    const again = MetricsRead.parse((await call(viewer.cookie, "GET", `/projects/p3b/runs/${rid}/metrics?keys=loss`)).body);
    expect(again.series.loss).toEqual(series.loss);
  });

  it("uncommitted segments (seq > last_seq) are not compacted", async () => {
    const base = `p/${pid}/r/${rid}/metrics/`;
    await env.BUCKET.put(`${base}seg-0-000099.parquet`, "junk");
    expect((await call(key, "POST", `/runs/${rid}/metrics/compact`)).body).toEqual({ chunks: 0, segments: 0, more: false });
    await env.BUCKET.delete(`${base}seg-0-000099.parquet`);
  });

  it("heartbeat; PATCH finished; non-running run → 409", async () => {
    expect((await call(key, "POST", `/runs/${rid}/heartbeat`, { writer_id: 0 })).status).toBe(204);
    const p = await call(key, "PATCH", `/runs/${rid}`, { status: "finished", summary: { best: 1 } });
    expect(p.status).toBe(200);
    expect(p.body.finished_at).toBeTypeOf("number");
    expect(p.body.summary).toEqual({ best: 1 });
    const f = await call(key, "POST", `/runs/${rid}/metrics`, { writer_id: 0, seq: 4, points: [] });
    expect(f.status).toBe(409);
    expect(f.body.error.code).toBe("run_not_running");
    expect((await call(key, "POST", `/runs/${rid}/heartbeat`, { writer_id: 0 })).status).toBe(409);
    expect((await call(key, "PATCH", `/runs/${rid}`, { status: "crashed" })).status).toBe(400);
    // resume reopens
    expect((await call(key, "POST", "/runs", { resume: rid })).body.last_seq).toBe(3);
    expect((await call(viewer.cookie, "GET", `/projects/p3b/runs/${rid}`)).body.status).toBe("running");
  });

  it("read tolerates a compaction between list and read (re-lists once)", async () => {
    expect((await call(key, "POST", `/runs/${rid}/metrics`, { writer_id: 0, seq: 4, points: pts("lr", [1, 2], 2000) })).status).toBe(200);
    const realGet = env.BUCKET.get.bind(env.BUCKET);
    let compacted = false;
    const spy = vi.spyOn(env.BUCKET, "get").mockImplementation((async (k: string, o?: R2GetOptions) => {
      if (!compacted) {
        compacted = true; // segment listed, then deleted by a concurrent compaction
        spy.mockRestore();
        expect((await call(key, "POST", `/runs/${rid}/metrics/compact`)).body).toEqual({ chunks: 1, segments: 1, more: false });
      }
      return realGet(k, o);
    }) as typeof env.BUCKET.get);
    const r = await call(viewer.cookie, "GET", `/projects/p3b/runs/${rid}/metrics?keys=lr`);
    expect(compacted).toBe(true);
    expect(r.status).toBe(200);
    expect(r.body.series.lr).toEqual({ step: [1, 2], value: [1, 2] });
  });

  it("dashboard list: newest first, metrics, pagination; viewer only for own projects", async () => {
    const second = (await call(key, "POST", "/runs", { name: "second" })).body.id;
    await env.DB.prepare("UPDATE runs SET created_at = created_at + 1000 WHERE id = ?").bind(second).run();
    const list = await call(viewer.cookie, "GET", "/projects/p3b/runs?limit=1");
    expect(list.status).toBe(200);
    const [first] = list.body.map((r: unknown) => RunWithMetrics.parse(r));
    expect(first.id).toBe(second);
    const page2 = await call(viewer.cookie, "GET", `/projects/p3b/runs?limit=1&before=${first.created_at}`);
    expect(page2.body.map((r: { id: string }) => r.id)).toEqual([rid]);
    expect(page2.body[0].metrics.loss).toEqual({ step: 105, value: -1 });
    expect((await call(viewer.cookie, "GET", "/projects/other-3b/runs")).status).toBe(404);
    expect((await call(null, "GET", "/projects/p3b/runs")).status).toBe(401);
  });
});

describe("uploads (fallback R2)", () => {
  let first: string;

  const put = (id: string, bytes: Uint8Array, len = bytes.byteLength) =>
    exports.default.fetch(
      new Request(`${BASE}/uploads/${id}/body`, { method: "PUT", body: bytes, headers: { "Content-Length": String(len) } }),
    );

  async function upload(path: string, bytes: Uint8Array) {
    const c = await call(key, "POST", `/runs/${rid}/uploads`, { path, kind: "checkpoint", size: bytes.byteLength });
    expect(c.status).toBe(201);
    const { id, upload: ins } = UploadCreated.parse(c.body);
    expect(ins).toEqual({ type: "single", method: "PUT", url: `/api/v1/uploads/${id}/body`, headers: { "Content-Type": "application/octet-stream" } });
    return id;
  }

  it("tier limits: artifact 403, oversized checkpoint 413, bad path 400", async () => {
    const a = await call(key, "POST", `/runs/${rid}/uploads`, { path: "x.bin", kind: "artifact", size: 1 });
    expect(a.status).toBe(403);
    expect(a.body.error.code).toBe("storage_tier_limit");
    expect((await call(key, "POST", `/runs/${rid}/uploads`, { path: "x.pt", kind: "checkpoint", size: 100 * 1024 * 1024 + 1 })).status).toBe(413);
    expect((await call(key, "POST", `/runs/${rid}/uploads`, { path: "../x", kind: "checkpoint", size: 1 })).status).toBe(400);
  });

  it("body: size mismatch 400, over 413, then OK; complete registers file", async () => {
    const id = await upload("ckpt/a.pt", new Uint8Array(10));
    expect((await put(id, new Uint8Array(5))).status).toBe(400);
    expect((await put(id, new Uint8Array(20))).status).toBe(413);
    expect((await put(id, new Uint8Array(10).fill(7))).status).toBe(204);
    expect((await call(otherKey, "POST", `/uploads/${id}/complete`, {})).status).toBe(404);
    const done = await call(key, "POST", `/uploads/${id}/complete`, {});
    expect(done.status).toBe(201);
    first = FileInfo.parse(done.body).id;
    expect((await call(key, "POST", `/uploads/${id}/complete`, {})).status).toBe(409);
    expect((await put(id, new Uint8Array(10))).status).toBe(404); // single-use
    const dl = await exports.default.fetch(new Request(`${BASE}/projects/p3b/files/${first}/download`, { headers: { Cookie: viewer.cookie } }));
    expect(dl.status).toBe(200);
    expect(dl.headers.get("Content-Disposition")).toBe("attachment; filename*=UTF-8''a.pt");
    expect([...new Uint8Array(await dl.arrayBuffer())]).toEqual(Array(10).fill(7));
  });

  it("complete without body uploaded → 400", async () => {
    const id = await upload("ckpt/missing.pt", new Uint8Array(3));
    expect((await call(key, "POST", `/uploads/${id}/complete`, {})).status).toBe(400);
  });

  it("second checkpoint replaces first (old object + row gone)", async () => {
    const id = await upload("ckpt/b.pt", new Uint8Array(4));
    expect((await put(id, new Uint8Array(4))).status).toBe(204);
    const done = await call(key, "POST", `/uploads/${id}/complete`, {});
    expect(done.status).toBe(201);
    const files = await call(viewer.cookie, "GET", `/projects/p3b/runs/${rid}/files`);
    expect(files.body.map((f: unknown) => FileInfo.parse(f).path)).toEqual(["ckpt/b.pt"]);
    expect(await r2Keys(`p/${pid}/r/${rid}/files/`)).toEqual([`p/${pid}/r/${rid}/files/checkpoint/${id}/ckpt/b.pt`]);
    expect((await call(viewer.cookie, "GET", `/projects/p3b/files/${first}/download`)).status).toBe(404);
  });

  it("expired upload id → 410; unknown → 404", async () => {
    const id = await upload("ckpt/c.pt", new Uint8Array(2));
    await env.DB.prepare("UPDATE uploads SET created_at = created_at - 3600001 WHERE id = ?").bind(id).run();
    expect((await put(id, new Uint8Array(2))).status).toBe(410);
    expect((await call(key, "POST", `/uploads/${id}/complete`, {})).status).toBe(410);
    expect((await put(uid(), new Uint8Array(2))).status).toBe(404);
  });
});

describe("cron + delete", () => {
  it("cron marks stale running runs crashed and aborts expired uploads", async () => {
    const { cron } = await import("../src/cron");
    const fresh = (await call(key, "POST", "/runs", {})).body.id;
    const hb = Date.now() - 11 * 60_000;
    await env.DB.prepare("UPDATE run_writers SET heartbeat_at = ? WHERE run_id = ?").bind(hb, rid).run();
    await cron({} as ScheduledController, env);
    const row = (id: string) => env.DB.prepare("SELECT status, finished_at FROM runs WHERE id = ?").bind(id).first<{ status: string; finished_at: number | null }>();
    const status = async (id: string) => (await row(id))!.status;
    expect(await row(rid)).toEqual({ status: "crashed", finished_at: hb }); // finished_at = last heartbeat
    expect(await row(fresh)).toEqual({ status: "running", finished_at: null });
    const pending = await env.DB.prepare("SELECT COUNT(*) AS n FROM uploads WHERE status = 'pending'").first<{ n: number }>();
    expect(pending!.n).toBe(1); // only "missing.pt" (not expired)
    const aborted = await env.DB.prepare("SELECT path FROM uploads WHERE status = 'aborted'").all();
    expect(aborted.results).toEqual([{ path: "ckpt/c.pt" }]);
  });

  it("delete run: viewer 403, owner 204, rows + objects gone", async () => {
    expect((await call(viewer.cookie, "DELETE", `/projects/p3b/runs/${rid}`)).status).toBe(403);
    expect((await call(owner.cookie, "DELETE", `/projects/p3b/runs/${rid}`)).status).toBe(204);
    expect((await call(owner.cookie, "GET", `/projects/p3b/runs/${rid}`)).status).toBe(404);
    expect(await r2Keys(`p/${pid}/r/${rid}/`)).toEqual([]);
    const n = await env.DB.prepare("SELECT (SELECT COUNT(*) FROM files WHERE run_id = ?1) + (SELECT COUNT(*) FROM run_metric_keys WHERE run_id = ?1) AS n")
      .bind(rid)
      .first<{ n: number }>();
    expect(n!.n).toBe(0);
  });
});

describe("own S3 tier: presigned instructions", () => {
  it("single presigned PUT ≤ 100 MB, multipart above; artifacts allowed", async () => {
    const s3pid = await project("s3-3b", [[owner.id, "owner"]]);
    await env.DB.prepare(
      `INSERT INTO project_storage (project_id, endpoint, region, bucket, prefix, access_key_id, secret_enc, path_style, updated_at)
       VALUES (?, 'https://s3.example.com', 'auto', 'bkt', 'pre', 'AKIA1', ?, 1, 0)`,
    )
      .bind(s3pid, await encryptSecret("secret", env.STORAGE_ENC_KEY))
      .run();
    const k = await apiKey(s3pid);
    const reqs: Request[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const req = new Request(input as RequestInfo, init);
      reqs.push(req);
      if (req.method === "POST" && new URL(req.url).searchParams.has("uploads")) {
        return new Response("<InitiateMultipartUploadResult><UploadId>UP-1</UploadId></InitiateMultipartUploadResult>");
      }
      return new Response(null, { status: 200 });
    });
    const run = (await call(k, "POST", "/runs", {})).body.id;

    const small = UploadCreated.parse((await call(k, "POST", `/runs/${run}/uploads`, { path: "m.bin", kind: "artifact", size: 1000 })).body);
    expect(small.upload.type).toBe("single");
    const u = new URL((small.upload as { url: string }).url);
    expect(u.pathname).toBe(`/bkt/pre/p/${s3pid}/r/${run}/files/artifact/${small.id}/m.bin`);
    expect(u.searchParams.get("X-Amz-Signature")).toBeTruthy();
    expect(reqs).toHaveLength(0); // presigning needs no network

    const big = UploadCreated.parse(
      (await call(k, "POST", `/runs/${run}/uploads`, { path: "big.pt", kind: "checkpoint", size: 200 * 1024 * 1024 })).body,
    );
    expect(big.upload.type).toBe("multipart");
    if (big.upload.type !== "multipart") return;
    expect(big.upload.part_size).toBe(64 * 1024 * 1024);
    expect(big.upload.parts.map((p) => p.n)).toEqual([1, 2, 3, 4]);
    const p2 = new URL(big.upload.parts[1]!.url);
    expect(p2.searchParams.get("partNumber")).toBe("2");
    expect(p2.searchParams.get("uploadId")).toBe("UP-1");
    expect(reqs.map((r) => r.method)).toEqual(["POST"]);
    expect((await call(k, "POST", `/runs/${run}/uploads`, { path: "huge", kind: "checkpoint", size: 10_001 * 64 * 1024 * 1024 })).status).toBe(413);
    // complete without parts on a multipart upload → 400
    expect((await call(k, "POST", `/uploads/${big.id}/complete`, {})).status).toBe(400);
  });
});

describe("audit fixes", () => {
  it("non-JSON Content-Type rejected (CSRF via text/plain forms)", async () => {
    const r = await exports.default.fetch(
      new Request(`${BASE}/auth/login`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: '{"email":"a@b.co","password":"12345678"}' }),
    );
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: { message: string } }).error.message).toMatch(/Content-Type/);
  });
});

describe("audit fixes 2", () => {
  let p2: string;
  let k2: string;
  const flush = (run: string, writer_id: number, seq: number, points = pts("x", [seq], 1000 + seq)) =>
    call(k2, "POST", `/runs/${run}/metrics`, { writer_id, seq, points });
  const runStatus = async (id: string) =>
    (await env.DB.prepare("SELECT status, finished_at FROM runs WHERE id = ?").bind(id).first<{ status: string; finished_at: number | null }>())!;
  const putBody = (id: string, bytes: Uint8Array) =>
    exports.default.fetch(
      new Request(`${BASE}/uploads/${id}/body`, { method: "PUT", body: bytes, headers: { "Content-Length": String(bytes.byteLength) } }),
    );
  async function uploadDone(run: string, path: string, bytes: Uint8Array) {
    const c = await call(k2, "POST", `/runs/${run}/uploads`, { path, kind: "checkpoint", size: bytes.byteLength });
    expect(c.status).toBe(201);
    expect((await putBody(c.body.id, bytes)).status).toBe(204);
    return c.body.id as string;
  }

  beforeAll(async () => {
    p2 = await project("p3c", [
      [owner.id, "owner"],
      [viewer.id, "viewer"],
    ]);
    k2 = await apiKey(p2);
  });

  it("crashed run: flush and heartbeat revive it; finished/failed still 409", async () => {
    const run = (await call(k2, "POST", "/runs", {})).body.id;
    await env.DB.prepare("UPDATE runs SET status = 'crashed', finished_at = 1 WHERE id = ?").bind(run).run();
    expect((await flush(run, 0, 0)).status).toBe(200);
    expect(await runStatus(run)).toEqual({ status: "running", finished_at: null });
    await env.DB.prepare("UPDATE runs SET status = 'crashed' WHERE id = ?").bind(run).run();
    expect((await call(k2, "POST", `/runs/${run}/heartbeat`, { writer_id: 1 })).status).toBe(204);
    expect((await runStatus(run)).status).toBe("running");
    for (const status of ["finished", "failed"]) {
      expect((await call(k2, "PATCH", `/runs/${run}`, { status })).status).toBe(200);
      expect((await flush(run, 0, 1)).status).toBe(409);
      expect((await call(k2, "POST", `/runs/${run}/heartbeat`, { writer_id: 0 })).status).toBe(409);
      expect((await runStatus(run)).status).toBe(status);
    }
  });

  it("compaction does at most 3 chunks per call and reports `more`", async () => {
    const run = (await call(k2, "POST", "/runs", {})).body.id;
    for (let seq = 0; seq <= 60; seq++) expect((await flush(run, 0, seq)).status).toBe(200);
    expect((await call(k2, "POST", `/runs/${run}/metrics/compact`)).body).toEqual({ chunks: 3, segments: 60, more: true });
    expect((await call(k2, "POST", `/runs/${run}/metrics/compact`)).body).toEqual({ chunks: 1, segments: 1, more: false });
    const m = await call(viewer.cookie, "GET", `/projects/p3c/runs/${run}/metrics?keys=x`);
    expect(m.body.series.x.step).toEqual(Array.from({ length: 61 }, (_, i) => i));
  });

  it("two overlapping compactions pick the same n but both chunks survive; no data lost", async () => {
    const run = (await call(k2, "POST", "/runs", {})).body.id;
    const base = `p/${p2}/r/${run}/metrics/`;
    for (let seq = 0; seq < 3; seq++) await flush(run, 0, seq);
    const realPut = env.BUCKET.put.bind(env.BUCKET);
    let nested = false;
    vi.spyOn(env.BUCKET, "put").mockImplementation((async (k: string, v: any, o?: R2PutOptions) => {
      if (k.includes("/chunk-") && !nested) {
        nested = true; // A is about to write its chunk: B lists the same segments, same n
        expect((await call(k2, "POST", `/runs/${run}/metrics/compact`)).body).toEqual({ chunks: 1, segments: 3, more: false });
      }
      return realPut(k, v, o);
    }) as typeof env.BUCKET.put);
    expect((await call(k2, "POST", `/runs/${run}/metrics/compact`)).status).toBe(200);
    vi.restoreAllMocks();
    expect(unsuffix(await r2Keys(base))).toEqual([`${base}chunk-000000-*.parquet`, `${base}chunk-000000-*.parquet`]);
    const m = await call(viewer.cookie, "GET", `/projects/p3c/runs/${run}/metrics?keys=x`);
    expect(m.body.series.x).toEqual({ step: [0, 1, 2], value: [0, 1, 2] });
  });

  it("read over too many files → 413 too_many_files", async () => {
    const run = (await call(k2, "POST", "/runs", {})).body.id;
    const base = `p/${p2}/r/${run}/metrics/`;
    for (let i = 0; i <= 200; i++) await env.BUCKET.put(`${base}seg-0-${String(i).padStart(6, "0")}.parquet`, "junk");
    const r = await call(viewer.cookie, "GET", `/projects/p3c/runs/${run}/metrics?keys=x`);
    expect(r.status).toBe(413);
    expect(r.body.error.code).toBe("too_many_files");
  });

  it("re-upload of the same path leaves the registered object alone until complete", async () => {
    const run = (await call(k2, "POST", "/runs", {})).body.id;
    const files = `p/${p2}/r/${run}/files/`;
    const a = await uploadDone(run, "ckpt/same.pt", new Uint8Array([1]));
    const fa = (await call(k2, "POST", `/uploads/${a}/complete`, {})).body.id;
    const b = await uploadDone(run, "ckpt/same.pt", new Uint8Array([2]));
    expect(await r2Keys(files)).toEqual([`${files}checkpoint/${a}/ckpt/same.pt`, `${files}checkpoint/${b}/ckpt/same.pt`].sort());
    const dl = await exports.default.fetch(new Request(`${BASE}/projects/p3c/files/${fa}/download`, { headers: { Cookie: viewer.cookie } }));
    expect([...new Uint8Array(await dl.arrayBuffer())]).toEqual([1]);
    expect((await call(k2, "POST", `/uploads/${b}/complete`, {})).status).toBe(201);
    expect(await r2Keys(files)).toEqual([`${files}checkpoint/${b}/ckpt/same.pt`]); // old one dropped only now
  });

  it("download filename uses RFC 5987 encoding", async () => {
    const run = (await call(k2, "POST", "/runs", {})).body.id;
    const id = await uploadDone(run, "it's (1)*.pt", new Uint8Array([3]));
    const f = (await call(k2, "POST", `/uploads/${id}/complete`, {})).body.id;
    const dl = await exports.default.fetch(new Request(`${BASE}/projects/p3c/files/${f}/download`, { headers: { Cookie: viewer.cookie } }));
    expect(dl.headers.get("Content-Disposition")).toBe("attachment; filename*=UTF-8''it%27s%20%281%29%2A.pt");
    await dl.body?.cancel();
  });

  it("upload body shorter than Content-Length → 400", async () => {
    const run = (await call(k2, "POST", "/runs", {})).body.id;
    const c = await call(k2, "POST", `/runs/${run}/uploads`, { path: "short.pt", kind: "checkpoint", size: 10 });
    const body = new ReadableStream({
      start(ctl) {
        ctl.enqueue(new Uint8Array(5));
        ctl.close();
      },
    });
    const r = await exports.default.fetch(
      new Request(`${BASE}/uploads/${c.body.id}/body`, { method: "PUT", body, headers: { "Content-Length": "10" }, duplex: "half" } as RequestInit),
    );
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe("body_incomplete");
  });

  it("run delete keeps pending uploads (run_id NULL) for cron; they cannot be completed", async () => {
    const run = (await call(k2, "POST", "/runs", {})).body.id;
    const c = await call(k2, "POST", `/runs/${run}/uploads`, { path: "late.pt", kind: "checkpoint", size: 1 });
    expect((await call(owner.cookie, "DELETE", `/projects/p3c/runs/${run}`)).status).toBe(204);
    const row = await env.DB.prepare("SELECT run_id, status FROM uploads WHERE id = ?").bind(c.body.id).first();
    expect(row).toEqual({ run_id: null, status: "pending" });
    expect((await putBody(c.body.id, new Uint8Array(1))).status).toBe(404);
    expect((await call(k2, "POST", `/uploads/${c.body.id}/complete`, {})).status).toBe(404);
  });

  it("cron: young S3 uploads do not starve expired R2 uploads", async () => {
    const { cron } = await import("../src/cron");
    const now = Date.now();
    const ins = (id: string, backend: string, at: number) =>
      env.DB.prepare(
        `INSERT INTO uploads (id, project_id, run_id, kind, path, size, storage_key, backend, status, created_at)
         VALUES (?, ?, NULL, 'checkpoint', 'x', 1, ?, ?, 'pending', ?)`,
      ).bind(id, p2, `p/${p2}/stale/${id}`, backend, at);
    const s3Ids = Array.from({ length: 100 }, () => uid());
    await env.DB.batch(s3Ids.map((id, i) => ins(id, "s3", now - 2 * 3600_000 - 1000 - i)));
    const r2Id = uid();
    await ins(r2Id, "r2", now - 2 * 3600_000).run();
    await cron({} as ScheduledController, env, now);
    const st = async (id: string) => (await env.DB.prepare("SELECT status FROM uploads WHERE id = ?").bind(id).first<{ status: string }>())!.status;
    expect(await st(r2Id)).toBe("aborted");
    expect(await st(s3Ids[0]!)).toBe("pending");
  });

  it("GET /projects/:slug includes the caller's role; /auth/status is public", async () => {
    const v = await call(viewer.cookie, "GET", "/projects/p3c");
    expect(Project.parse(v.body).role).toBe("viewer");
    expect((await call(owner.cookie, "GET", "/projects/p3c")).body.role).toBe("owner");
    const s = await call(null, "GET", "/auth/status");
    expect(AuthStatus.strict().parse(s.body)).toEqual({ needs_setup: false });
  });

  it("storage probe: unreachable endpoint → readable message, no internals", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("internal error; reference = abc123");
    });
    const cfg = { endpoint: "https://s3.example.com", region: "auto", bucket: "bkt", prefix: "", access_key_id: "AKIAX", secret_access_key: "SECRET-1", path_style: true };
    const r = await call(owner.cookie, "POST", "/projects/p3c/storage/test", cfg);
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/^storage put failed: could not connect to endpoint s3\.example\.com: /);
    expect(r.text).not.toContain("reference");
    expect(r.text).not.toContain("SECRET-1");
  });
});

describe("re-audit fixes", () => {
  let k: string;
  const flush = (run: string, writer_id: number, seq: number, points = pts("x", [seq], 1000 + seq)) =>
    call(k, "POST", `/runs/${run}/metrics`, { writer_id, seq, points });
  const segKeys = async (run: string) => (await r2Keys(`p/${pd}/r/${run}/metrics/`)).filter((x) => x.includes("/seg-"));
  let pd: string;

  beforeAll(async () => {
    pd = await project("p3d", [
      [owner.id, "owner"],
      [viewer.id, "viewer"],
    ]);
    k = await apiKey(pd);
  });

  it("read: many chunks but few segments is fine; > 400 files → 413 run_too_large", async () => {
    const run = (await call(k, "POST", "/runs", {})).body.id;
    const base = `p/${pd}/r/${run}/metrics/`;
    for (let i = 0; i <= 400; i++) await env.BUCKET.put(`${base}chunk-${String(i).padStart(6, "0")}-0000abcd.parquet`, "junk");
    const r = await call(viewer.cookie, "GET", `/projects/p3d/runs/${run}/metrics?keys=x`);
    expect(r.status).toBe(413);
    expect(r.body.error.code).toBe("run_too_large");
    expect(r.body.error.message).not.toMatch(/compact/);
  });

  it("upload body: a non-short-body put error → 500, not 400", async () => {
    const run = (await call(k, "POST", "/runs", {})).body.id;
    const c = await call(k, "POST", `/runs/${run}/uploads`, { path: "x.pt", kind: "checkpoint", size: 1 });
    vi.spyOn(env.BUCKET, "put").mockRejectedValue(new Error("boom"));
    const r = await exports.default.fetch(
      new Request(`${BASE}/uploads/${c.body.id}/body`, { method: "PUT", body: new Uint8Array([1]), headers: { "Content-Length": "1" } }),
    );
    expect(r.status).toBe(500);
  });

  it("PATCH sets only patched columns (status/finished_at untouched by a summary patch)", async () => {
    const run = (await call(k, "POST", "/runs", {})).body.id;
    // Simulate a concurrent status change after PATCH's loadRun: the row read is stale.
    const realPrepare = env.DB.prepare.bind(env.DB);
    vi.spyOn(env.DB, "prepare").mockImplementation((q: string) => {
      if (q.startsWith("UPDATE runs SET")) {
        vi.restoreAllMocks();
        return { bind: (...a: unknown[]) => ({ first: async () => {
          await realPrepare("UPDATE runs SET status = 'finished', finished_at = 7 WHERE id = ?").bind(run).run();
          return realPrepare(q).bind(...a).first();
        } }) } as unknown as D1PreparedStatement;
      }
      return realPrepare(q);
    });
    const r = await call(k, "PATCH", `/runs/${run}`, { summary: { best: 1 } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: "finished", finished_at: 7, summary: { best: 1 } });
  });

  it("cron compacts stopped runs with pending segments, converges, leaves running runs alone", async () => {
    const { cron } = await import("../src/cron");
    const crashed = (await call(k, "POST", "/runs", {})).body.id;
    for (let seq = 0; seq < 3; seq++) expect((await flush(crashed, 0, seq)).status).toBe(200);
    expect((await flush(crashed, 1, 0)).status).toBe(200);
    expect((await flush(crashed, 1, 1, [])).status).toBe(200); // empty flush: no segment, seq committed
    const live = (await call(k, "POST", "/runs", {})).body.id;
    expect((await flush(live, 0, 0)).status).toBe(200);
    // crashed via cron (stale heartbeat); live stays fresh
    await env.DB.prepare("UPDATE run_writers SET heartbeat_at = ? WHERE run_id = ?").bind(Date.now() - 11 * 60_000, crashed).run();
    await env.DB.prepare("UPDATE runs SET created_at = 0 WHERE id = ?").bind(crashed).run();
    const selected = () =>
      env.DB.prepare(
        `SELECT COUNT(DISTINCT r.id) AS n FROM runs r JOIN run_writers w ON w.run_id = r.id
         WHERE r.status != 'running' AND w.last_seq > w.compacted_seq`,
      ).first<{ n: number }>();
    // Other tests' stopped runs share the queue (4 per tick): tick until nothing is selected.
    for (let i = 0; i < 20 && (await selected())!.n > 0; i++) await cron({} as ScheduledController, env);
    await cron({} as ScheduledController, env);
    expect((await selected())!.n).toBe(0);
    expect((await env.DB.prepare("SELECT status FROM runs WHERE id = ?").bind(crashed).first<{ status: string }>())!.status).toBe("crashed");
    expect(await segKeys(crashed)).toEqual([]);
    const w = await env.DB.prepare("SELECT writer_id, last_seq, compacted_seq FROM run_writers WHERE run_id = ? ORDER BY writer_id").bind(crashed).all();
    expect(w.results).toEqual([
      { writer_id: 0, last_seq: 2, compacted_seq: 2 },
      { writer_id: 1, last_seq: 1, compacted_seq: 1 },
    ]);
    const m = await call(viewer.cookie, "GET", `/projects/p3d/runs/${crashed}/metrics?keys=x`);
    expect(m.body.series.x.step).toEqual([0, 1, 2]);
    // running run untouched
    expect(await segKeys(live)).toEqual([`p/${pd}/r/${live}/metrics/seg-0-000000.parquet`]);
    expect(await env.DB.prepare("SELECT compacted_seq FROM run_writers WHERE run_id = ?").bind(live).first()).toEqual({ compacted_seq: -1 });
  });

  it("runs list: (created_at, id) cursor pages through runs sharing a ms; legacy numeric cursor still works", async () => {
    const pe = await project("p3e", [[viewer.id, "viewer"]]);
    const ke = await apiKey(pe);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await call(ke, "POST", "/runs", {})).body.id);
    await env.DB.prepare("UPDATE runs SET created_at = 5000 WHERE project_id = ?").bind(pe).run();
    const older = (await call(ke, "POST", "/runs", {})).body.id;
    await env.DB.prepare("UPDATE runs SET created_at = 4000 WHERE id = ?").bind(older).run();
    const seen: string[] = [];
    let before = "";
    for (;;) {
      const page = await call(viewer.cookie, "GET", `/projects/p3e/runs?limit=2${before}`);
      expect(page.status).toBe(200);
      if (page.body.length === 0) break;
      for (const r of page.body) seen.push(r.id);
      const last = page.body.at(-1);
      before = `&before=${last.created_at}:${last.id}`;
    }
    expect(seen).toEqual([...[...ids].sort().reverse(), older]);
    const legacy = await call(viewer.cookie, "GET", "/projects/p3e/runs?before=5000");
    expect(legacy.body.map((r: { id: string }) => r.id)).toEqual([older]);
    expect((await call(viewer.cookie, "GET", "/projects/p3e/runs?before=abc")).status).toBe(400);
  });
});
