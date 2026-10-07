import { describe, expect, it } from "vitest";
import {
  R2Storage,
  S3Storage,
  asyncBuffer,
  StorageError,
  decryptSecret,
  encryptSecret,
  fallbackCapabilities,
  probe,
  resolveStorage,
  allowPrivateS3,
  type S3Config,
} from "../src/index";
import { Capabilities } from "@kitelog/shared";

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i)));

describe("crypto", () => {
  it("roundtrips and uses a fresh iv", async () => {
    const a = await encryptSecret("s3cr3t/ключ", KEY);
    const b = await encryptSecret("s3cr3t/ключ", KEY);
    expect(a).not.toBe(b);
    expect(await decryptSecret(a, KEY)).toBe("s3cr3t/ключ");
  });
  it("rejects wrong key and bad key length", async () => {
    const enc = await encryptSecret("x", KEY);
    const other = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
    await expect(decryptSecret(enc, other)).rejects.toThrow();
    await expect(encryptSecret("x", btoa("short"))).rejects.toThrow(/32 bytes/);
  });
});

type Call = { method: string; url: string; headers: Headers; body: string };
function fakeFetch(respond: (c: Call) => Response) {
  const calls: Call[] = [];
  const f = async (req: Request) => {
    const c = { method: req.method, url: req.url, headers: req.headers, body: req.body ? await req.text() : "" };
    calls.push(c);
    return respond(c);
  };
  return { f, calls };
}

const cfg = (o: Partial<S3Config> = {}): S3Config => ({
  endpoint: "https://s3.example.com",
  region: "us-east-1",
  bucket: "bkt",
  prefix: "/team/",
  accessKeyId: "AKID",
  secretAccessKey: "SECRET",
  pathStyle: true,
  ...o,
});

describe("S3Storage URLs and signing", () => {
  it("path-style: bucket in path, prefix joined, key encoded keeping /", async () => {
    const { f, calls } = fakeFetch(() => new Response(null, { status: 200 }));
    const s = new S3Storage(cfg(), f);
    await s.put("p/1/a b+c(1).bin", "hello", { contentType: "application/octet-stream" });
    expect(calls[0]!.method).toBe("PUT");
    expect(calls[0]!.url).toBe("https://s3.example.com/bkt/team/p/1/a%20b%2Bc%281%29.bin");
    expect(calls[0]!.headers.get("authorization")).toMatch(/^AWS4-HMAC-SHA256 Credential=AKID\/\d{8}\/us-east-1\/s3\/aws4_request/);
    expect(calls[0]!.headers.get("x-amz-content-sha256")).toBe("UNSIGNED-PAYLOAD");
    expect(calls[0]!.body).toBe("hello");
  });

  it("virtual-hosted: bucket in host", async () => {
    const { f, calls } = fakeFetch(() => new Response(null, { status: 200 }));
    await new S3Storage(cfg({ pathStyle: false, prefix: "" }), f).delete("k/x.txt");
    expect(calls[0]!.url).toBe("https://bkt.s3.example.com/k/x.txt");
  });

  it("rejects non-https endpoints", () => {
    expect(() => new S3Storage(cfg({ endpoint: "http://s3.example.com" }))).toThrow(/https/);
  });

  it("presigns query-signed URLs with expiry", async () => {
    const s = new S3Storage(cfg({ pathStyle: false }));
    const u = new URL(await s.presignPut("a/b.ckpt", 900));
    expect(u.origin + u.pathname).toBe("https://bkt.s3.example.com/team/a/b.ckpt");
    expect(u.searchParams.get("X-Amz-Expires")).toBe("900");
    expect(u.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    const part = new URL(await s.presignPart("a/b.ckpt", "up+id", 3, 60));
    expect(part.searchParams.get("partNumber")).toBe("3");
    expect(part.searchParams.get("uploadId")).toBe("up+id");
  });

  it("get returns null on 404 and maps other errors with S3 code", async () => {
    const { f } = fakeFetch((c) =>
      c.url.includes("missing")
        ? new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 })
        : new Response("<Error><Code>AccessDenied</Code><Message>nope</Message></Error>", { status: 403 }),
    );
    const s = new S3Storage(cfg(), f);
    expect(await s.get("missing")).toBeNull();
    const err = await s.get("denied").catch((e) => e);
    expect(err).toBeInstanceOf(StorageError);
    expect(err).toMatchObject({ status: 403, code: "AccessDenied" });
  });

  it("get returns body, size, content type", async () => {
    const { f } = fakeFetch(() => new Response("abc", { headers: { "Content-Type": "text/plain", "Content-Length": "3" } }));
    const o = (await new S3Storage(cfg(), f).get("k"))!;
    expect(o.size).toBe(3);
    expect(o.contentType).toBe("text/plain");
    expect(await new Response(o.body).text()).toBe("abc");
  });
});

describe("S3Storage list", () => {
  it("follows continuation tokens, decodes entities, strips prefix", async () => {
    const { f, calls } = fakeFetch((c) => {
      const tok = new URL(c.url).searchParams.get("continuation-token");
      return new Response(
        tok === null
          ? `<ListBucketResult><IsTruncated>true</IsTruncated><Contents><Key>team/r/seg-0-000001.parquet</Key><Size>17</Size></Contents><Contents><Key>team/r/a&amp;b&#x27;.txt</Key><Size>0</Size></Contents><NextContinuationToken>t&amp;2</NextContinuationToken></ListBucketResult>`
          : `<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>team/r/data.parquet</Key><Size>123456</Size></Contents></ListBucketResult>`,
      );
    });
    const keys = await new S3Storage(cfg(), f).list("r/");
    expect(keys).toEqual([
      { key: "r/seg-0-000001.parquet", size: 17 },
      { key: "r/a&b'.txt", size: 0 },
      { key: "r/data.parquet", size: 123456 },
    ]);
    const u1 = new URL(calls[0]!.url);
    expect(u1.pathname).toBe("/bkt/");
    expect(u1.searchParams.get("list-type")).toBe("2");
    expect(u1.searchParams.get("prefix")).toBe("team/r/");
    expect(new URL(calls[1]!.url).searchParams.get("continuation-token")).toBe("t&2");
  });
});

describe("S3Storage multipart", () => {
  it("create, complete (sorted, escaped XML), abort", async () => {
    const { f, calls } = fakeFetch((c) =>
      c.method === "POST" && c.url.includes("uploads")
        ? new Response("<InitiateMultipartUploadResult><UploadId>UP1</UploadId></InitiateMultipartUploadResult>")
        : new Response("<CompleteMultipartUploadResult/>"),
    );
    const s = new S3Storage(cfg(), f);
    expect(await s.createMultipart("big.ckpt", "application/octet-stream")).toBe("UP1");
    expect(calls[0]!.url).toBe("https://s3.example.com/bkt/team/big.ckpt?uploads=");
    await s.completeMultipart("big.ckpt", "UP1", [{ n: 2, etag: '"e2"' }, { n: 1, etag: '"e1"' }]);
    expect(calls[1]!.url).toBe("https://s3.example.com/bkt/team/big.ckpt?uploadId=UP1");
    expect(calls[1]!.body).toBe(
      "<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>&quot;e1&quot;</ETag></Part><Part><PartNumber>2</PartNumber><ETag>&quot;e2&quot;</ETag></Part></CompleteMultipartUpload>",
    );
    await s.abortMultipart("big.ckpt", "UP1");
    expect(calls[2]!.method).toBe("DELETE");
  });

  it("complete surfaces a 200-with-<Error> body", async () => {
    const { f } = fakeFetch(() => new Response("<Error><Code>InvalidPart</Code></Error>"));
    await expect(new S3Storage(cfg(), f).completeMultipart("k", "U", [{ n: 1, etag: "x" }])).rejects.toMatchObject({ code: "InvalidPart" });
  });

  it("deleteMany issues one DELETE per key", async () => {
    const { f, calls } = fakeFetch(() => new Response(null, { status: 204 }));
    await new S3Storage(cfg(), f).deleteMany(Array.from({ length: 20 }, (_, i) => `k${i}`));
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(20);
  });
});

describe("resolveStorage", () => {
  const env = { BUCKET: {} as R2Bucket, STORAGE_ENC_KEY: KEY };

  it("fallback R2: checkpoint only, default 100 MB, keep 1", async () => {
    const r = await resolveStorage(null, env);
    expect(r.backend).toBe("r2");
    expect(r.storage).toBeInstanceOf(R2Storage);
    expect(r.storage.canPresign).toBe(false);
    expect(() => r.storage.presignPut("k", 60)).toThrow(/cannot presign/);
    expect(r.capabilities).toEqual({
      can_save: { checkpoint: true, artifact: false },
      max_checkpoint_bytes: 100 * 1024 * 1024,
      keep_checkpoints: 1,
      metric_types: ["number"],
    });
    expect(Capabilities.safeParse(r.capabilities).success).toBe(true);
  });

  it("fallback honours FALLBACK_MAX_CHECKPOINT_MB, ignores junk", () => {
    expect(fallbackCapabilities("5").max_checkpoint_bytes).toBe(5 * 1024 * 1024);
    expect(fallbackCapabilities("abc").max_checkpoint_bytes).toBe(100 * 1024 * 1024);
  });

  it("own S3: decrypts secret, no limits", async () => {
    const row = {
      project_id: "p", endpoint: "https://s3.example.com", region: "auto", bucket: "bkt", prefix: "",
      access_key_id: "AK", secret_enc: await encryptSecret("SK", KEY), path_style: 1, updated_at: 0,
    };
    const { f, calls } = fakeFetch(() => new Response(null, { status: 200 }));
    const r = await resolveStorage(row, env, f);
    expect(r.backend).toBe("s3");
    expect(r.storage.canPresign).toBe(true);
    expect(r.capabilities).toEqual({
      can_save: { checkpoint: true, artifact: true }, max_checkpoint_bytes: null, keep_checkpoints: null, metric_types: ["number"],
    });
    expect(Capabilities.safeParse(r.capabilities).success).toBe(true);
    await r.storage.delete("x");
    expect(calls[0]!.url).toBe("https://s3.example.com/bkt/x");
  });

  it("ALLOW_PRIVATE_S3_ENDPOINTS gates http / private endpoints (off by default)", async () => {
    const row = {
      project_id: "p", endpoint: "http://localhost:9000", region: "auto", bucket: "bkt", prefix: "",
      access_key_id: "AK", secret_enc: await encryptSecret("SK", KEY), path_style: 1, updated_at: 0,
    };
    await expect(resolveStorage(row, env)).rejects.toMatchObject({ code: "invalid_endpoint" });
    await expect(resolveStorage(row, { ...env, ALLOW_PRIVATE_S3_ENDPOINTS: "0" })).rejects.toMatchObject({ code: "invalid_endpoint" });
    for (const v of ["1", "true", "TRUE"]) {
      expect(allowPrivateS3({ ALLOW_PRIVATE_S3_ENDPOINTS: v })).toBe(true);
      expect((await resolveStorage(row, { ...env, ALLOW_PRIVATE_S3_ENDPOINTS: v })).backend).toBe("s3");
    }
    expect(allowPrivateS3({})).toBe(false);
  });
});

describe("probe", () => {
  it("put/get/delete against an in-memory S3", async () => {
    const store = new Map<string, string>();
    const { f } = fakeFetch((c) => {
      const k = new URL(c.url).pathname;
      if (c.method === "PUT") return store.set(k, c.body), new Response(null);
      if (c.method === "GET") return store.has(k) ? new Response(store.get(k)) : new Response(null, { status: 404 });
      store.delete(k);
      return new Response(null, { status: 204 });
    });
    expect(await probe(new S3Storage(cfg(), f))).toEqual({ ok: true });
    expect(store.size).toBe(0);
  });
  it("reports the failing step", async () => {
    const { f } = fakeFetch(() => new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 }));
    expect(await probe(new S3Storage(cfg(), f))).toMatchObject({ ok: false, step: "put" });
  });
});

/** Error from fn, whether it throws synchronously or rejects. */
async function failure(fn: () => unknown): Promise<unknown> {
  try {
    await fn();
  } catch (e) {
    return e;
  }
  throw new Error("expected failure");
}

/** Minimal in-memory R2Bucket covering what R2Storage uses. */
function fakeR2(init: Record<string, string> = {}) {
  const data = new Map(Object.entries(init).map(([k, v]) => [k, new TextEncoder().encode(v)]));
  const calls: string[] = [];
  const obj = (key: string, bytes: Uint8Array) => ({
    key,
    size: data.get(key)!.byteLength,
    body: new Response(bytes).body!,
    httpMetadata: {},
    arrayBuffer: async () => bytes.slice().buffer,
  });
  const bucket = {
    async head(key: string) {
      calls.push(`head ${key}`);
      return data.has(key) ? { key, size: data.get(key)!.byteLength } : null;
    },
    async get(key: string, opts?: { range?: { offset: number; length: number } }) {
      calls.push(`get ${key}${opts?.range ? ` ${opts.range.offset}+${opts.range.length}` : ""}`);
      const b = data.get(key);
      if (!b) return null;
      const r = opts?.range;
      return obj(key, r ? b.subarray(r.offset, r.offset + r.length) : b);
    },
    async put(key: string, v: string) {
      calls.push(`put ${key}`);
      data.set(key, new TextEncoder().encode(v));
    },
    async delete(k: string | string[]) {
      for (const key of [k].flat()) (calls.push(`delete ${key}`), data.delete(key));
    },
    async list({ prefix, cursor }: { prefix: string; cursor?: string }) {
      calls.push(`list ${prefix} ${cursor ?? ""}`);
      const all = [...data.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const page = all.slice(start, start + 2);
      const truncated = start + 2 < all.length;
      return { objects: page.map((k) => ({ key: k, size: data.get(k)!.byteLength })), truncated, cursor: truncated ? String(start + 2) : undefined };
    },
  };
  return { bucket: bucket as unknown as R2Bucket, calls, data };
}

describe("key validation (both backends)", () => {
  const BAD = ["a/../b", "../x", "./a", "", "/abs", "a/./b", "a/..", "a/%2e%2e/b", "a/%2E/b", "a\\b", "a\nb", "a\u0000b", "x\u007f"];
  const backends = () => {
    const { f, calls } = fakeFetch(() => new Response(null, { status: 200 }));
    return [
      { name: "s3", s: new S3Storage(cfg(), f), calls: () => calls.length },
      { name: "r2", s: new R2Storage(fakeR2().bucket), calls: () => 0 },
    ];
  };

  it.each(["s3", "r2"])("%s: delete/presignPut/get/head/getRange/put reject bad keys", async (name) => {
    const b = backends().find((x) => x.name === name)!;
    for (const key of BAD) {
      for (const op of [
        () => b.s.delete(key),
        () => b.s.presignPut(key, 60),
        () => b.s.get(key),
        () => b.s.head(key),
        () => b.s.getRange(key, 0, 1),
        () => b.s.put(key, "x"),
        () => b.s.deleteMany(["ok", key]),
        () => b.s.createMultipart(key),
      ]) {
        expect(await failure(op), `${name} ${JSON.stringify(key)}`).toMatchObject({ status: 400, code: "invalid_key" });
      }
    }
    expect(b.calls()).toBe(0); // nothing reached the network
  });

  it("the spec'd escapes throw on both backends", async () => {
    for (const { s } of backends()) {
      expect(await failure(() => s.delete("a/../b"))).toBeInstanceOf(StorageError);
      expect(await failure(() => s.presignPut("../x", 60))).toMatchObject({ code: "invalid_key" });
      expect(await failure(() => s.get("./a"))).toMatchObject({ code: "invalid_key" });
      expect(await failure(() => s.list("../"))).toMatchObject({ code: "invalid_key" });
    }
  });

  it("accepts ordinary keys incl. dotfiles and the probe key", async () => {
    const { f, calls } = fakeFetch(() => new Response(null, { status: 200 }));
    const s = new S3Storage(cfg(), f);
    await s.delete(".kitelog-probe/abc");
    await s.delete("a/...x/..b/c.d");
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(["/bkt/team/.kitelog-probe/abc", "/bkt/team/a/...x/..b/c.d"]);
  });
});

describe("S3Storage constructor guards", () => {
  it.each([
    "https://127.0.0.1",
    "https://10.0.0.1:9000",
    "https://0x7f.1",
    "https://[::1]",
    "https://localhost",
    "https://LOCALHOST.",
    "https://minio.localhost",
    "https://nas.local",
    "https://meta.google.internal",
    "https://user:pw@s3.example.com",
  ])("rejects endpoint %s", (endpoint) => {
    expect(() => new S3Storage(cfg({ endpoint }))).toThrow(expect.objectContaining({ code: "invalid_endpoint" }));
  });

  it.each(["http://localhost:9000", "https://127.0.0.1:9000", "http://nas.local", "https://[::1]"])(
    "accepts %s with allowPrivate",
    async (endpoint) => {
      const { f, calls } = fakeFetch(() => new Response(null, { status: 200 }));
      await new S3Storage(cfg({ endpoint, allowPrivate: true }), f).delete("x");
      expect(calls[0]!.url).toBe(`${new URL(endpoint).origin}/bkt/team/x`);
    },
  );

  it("allowPrivate still rejects credentials and non-http(s) schemes; keeps http on virtual-hosted", async () => {
    expect(() => new S3Storage(cfg({ endpoint: "http://u:p@localhost", allowPrivate: true }))).toThrow(
      expect.objectContaining({ code: "invalid_endpoint" }),
    );
    expect(() => new S3Storage(cfg({ endpoint: "ftp://localhost", allowPrivate: true }))).toThrow(/https/);
    const s = new S3Storage(cfg({ endpoint: "http://minio.lan:9000", pathStyle: false, allowPrivate: true }));
    expect(new URL(await s.presignGet("a", 60)).origin).toBe("http://bkt.minio.lan:9000");
  });

  it.each(["b", "ab", "Bkt", "-bkt", "bkt-", "bk_t", "a/b", "x".repeat(64)])("rejects bucket %s", (bucket) => {
    expect(() => new S3Storage(cfg({ bucket }))).toThrow(expect.objectContaining({ code: "invalid_bucket" }));
  });

  it("rejects a prefix with dot segments", () => {
    expect(() => new S3Storage(cfg({ prefix: "a/../b" }))).toThrow(expect.objectContaining({ code: "invalid_prefix" }));
  });

  it("accepts normal endpoints and buckets", () => {
    expect(() => new S3Storage(cfg({ endpoint: "https://acc.r2.cloudflarestorage.com", bucket: "my.bucket-1" }))).not.toThrow();
    expect(() => new S3Storage(cfg({ endpoint: "https://s3.us-east-1.amazonaws.com:443/base", bucket: "x".repeat(63) }))).not.toThrow();
  });
});

describe("presign expiry bounds", () => {
  it.each([0, 0.5, -1, 604801, NaN, Infinity])("rejects %s", async (exp) => {
    const s = new S3Storage(cfg());
    expect(await failure(() => s.presignGet("k", exp))).toMatchObject({ status: 400, code: "invalid_expires" });
    expect(await failure(() => s.presignPart("k", "U", 1, exp))).toMatchObject({ code: "invalid_expires" });
  });
  it("accepts 1 and 604800", async () => {
    const s = new S3Storage(cfg());
    expect(new URL(await s.presignGet("k", 1)).searchParams.get("X-Amz-Expires")).toBe("1");
    expect(new URL(await s.presignGet("k", 604800)).searchParams.get("X-Amz-Expires")).toBe("604800");
  });
});

describe("S3Storage head/getRange", () => {
  const OBJ = "0123456789";
  const rangeStore = (honourRange = true) =>
    fakeFetch((c) => {
      if (!c.url.includes("/obj")) return new Response(null, { status: 404 });
      if (c.method === "HEAD") return new Response(null, { headers: { "Content-Length": String(OBJ.length) } });
      const m = /^bytes=(\d+)-(\d+)$/.exec(c.headers.get("range") ?? "");
      if (!m || !honourRange) return new Response(OBJ, { headers: { "Content-Length": String(OBJ.length) } });
      const [a, b] = [Number(m[1]), Math.min(Number(m[2]), OBJ.length - 1)];
      if (a >= OBJ.length) return new Response("<Error><Code>InvalidRange</Code></Error>", { status: 416 });
      return new Response(OBJ.slice(a, b + 1), { status: 206 });
    });
  const text = (b: ArrayBuffer) => new TextDecoder().decode(b);

  it("head returns size or null", async () => {
    const { f, calls } = rangeStore();
    const s = new S3Storage(cfg(), f);
    expect(await s.head("obj")).toEqual({ size: 10 });
    expect(calls[0]!.method).toBe("HEAD");
    expect(await s.head("missing")).toBeNull();
  });

  it("getRange sends an inclusive Range header and returns the bytes", async () => {
    const { f, calls } = rangeStore();
    const s = new S3Storage(cfg(), f);
    expect(text(await s.getRange("obj", 2, 3))).toBe("234");
    expect(calls[0]!.headers.get("range")).toBe("bytes=2-4");
    expect(text(await s.getRange("obj", 8, 100))).toBe("89"); // past end: short read
    expect(text(await s.getRange("obj", 0, 0))).toBe("");
    expect(calls).toHaveLength(2);
  });

  it("errors: 404, 416, bad args", async () => {
    const s = new S3Storage(cfg(), rangeStore().f);
    expect(await failure(() => s.getRange("missing", 0, 1))).toMatchObject({ status: 404 });
    expect(await failure(() => s.getRange("obj", 50, 1))).toMatchObject({ status: 416, code: "InvalidRange" });
    for (const [o, l] of [[-1, 1], [0, -1], [1.5, 1], [0, NaN]] as const) {
      expect(await failure(() => s.getRange("obj", o, l))).toMatchObject({ status: 400, code: "invalid_range" });
    }
  });

  it("store ignoring Range: 200 ok only for offset 0 covering the whole object", async () => {
    const s = new S3Storage(cfg(), rangeStore(false).f);
    expect(text(await s.getRange("obj", 0, 10))).toBe(OBJ);
    expect(text(await s.getRange("obj", 0, 1000))).toBe(OBJ);
    expect(await failure(() => s.getRange("obj", 0, 4))).toMatchObject({ code: "range_unsupported" });
    expect(await failure(() => s.getRange("obj", 3, 100))).toMatchObject({ code: "range_unsupported" });
  });

  it("asyncBuffer slices via ranged reads (hyparquet AsyncBuffer shape)", async () => {
    const { f, calls } = rangeStore();
    const s = new S3Storage(cfg(), f);
    const buf = asyncBuffer(s, "obj", 10);
    expect(buf.byteLength).toBe(10);
    expect(text(await buf.slice(6))).toBe("6789");
    expect(text(await buf.slice(1, 3))).toBe("12");
    expect(calls.map((c) => c.headers.get("range"))).toEqual(["bytes=6-9", "bytes=1-2"]);
  });
});

describe("R2Storage", () => {
  it("head, getRange, list with sizes across pages", async () => {
    const { bucket, calls } = fakeR2({ "r/a": "0123456789", "r/b": "xy", "r/c": "", "q/z": "zz" });
    const s = new R2Storage(bucket);
    expect(await s.head("r/a")).toEqual({ size: 10 });
    expect(await s.head("nope")).toBeNull();
    expect(new TextDecoder().decode(await s.getRange("r/a", 3, 4))).toBe("3456");
    expect(calls).toContain("get r/a 3+4");
    expect(await failure(() => s.getRange("nope", 0, 1))).toMatchObject({ status: 404, code: "not_found" });
    expect(await s.list("r/")).toEqual([{ key: "r/a", size: 10 }, { key: "r/b", size: 2 }, { key: "r/c", size: 0 }]);
    expect(calls.filter((c) => c.startsWith("list"))).toHaveLength(2);
    const ab = asyncBuffer(s, "r/a", 10);
    expect(new TextDecoder().decode(await ab.slice(7))).toBe("789");
  });

  it("probe works against R2", async () => {
    const { bucket, data } = fakeR2();
    expect(await probe(new R2Storage(bucket))).toEqual({ ok: true });
    expect(data.size).toBe(0);
  });
});
