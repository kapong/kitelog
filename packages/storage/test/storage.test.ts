import { describe, expect, it } from "vitest";
import {
  R2Storage,
  S3Storage,
  StorageError,
  decryptSecret,
  encryptSecret,
  fallbackCapabilities,
  probe,
  resolveStorage,
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
          ? `<ListBucketResult><IsTruncated>true</IsTruncated><Contents><Key>team/r/seg-0-000001.parquet</Key></Contents><Contents><Key>team/r/a&amp;b&#x27;.txt</Key></Contents><NextContinuationToken>t&amp;2</NextContinuationToken></ListBucketResult>`
          : `<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>team/r/data.parquet</Key></Contents></ListBucketResult>`,
      );
    });
    const keys = await new S3Storage(cfg(), f).list("r/");
    expect(keys).toEqual(["r/seg-0-000001.parquet", "r/a&b'.txt", "r/data.parquet"]);
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
      project_id: "p", endpoint: "https://s3.example.com", region: "auto", bucket: "b", prefix: "",
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
    expect(calls[0]!.url).toBe("https://s3.example.com/b/x");
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
