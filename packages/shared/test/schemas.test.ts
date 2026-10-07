import { describe, expect, it } from "vitest";
import {
  ErrorBody,
  MetricKey,
  MetricsFlush,
  RunCreate,
  RunCreated,
  RunPatch,
  StorageConfigInput,
  UploadCreate,
  UploadInstructions,
} from "../src/index";

describe("MetricsFlush", () => {
  const ok = { writer_id: 0, seq: 1, points: [{ key: "loss", step: 0, value: 0.5, ts: 1 }] };
  it("accepts a valid flush", () => expect(MetricsFlush.safeParse(ok).success).toBe(true));
  it("rejects non-finite values, long keys, and oversized batches", () => {
    const p = ok.points[0]!;
    expect(MetricsFlush.safeParse({ ...ok, points: [{ ...p, value: Infinity }] }).success).toBe(false);
    expect(MetricsFlush.safeParse({ ...ok, points: [{ ...p, value: "x" }] }).success).toBe(false);
    expect(MetricsFlush.safeParse({ ...ok, points: [{ ...p, key: "k".repeat(257) }] }).success).toBe(false);
    expect(MetricsFlush.safeParse({ ...ok, points: Array(10_001).fill(p) }).success).toBe(false);
  });
});

describe("StorageConfigInput", () => {
  const ok = { endpoint: "https://s3.example.com", bucket: "my-bucket", access_key_id: "AK", secret_access_key: "s" };
  it("accepts https and applies defaults", () => {
    expect(StorageConfigInput.parse(ok)).toMatchObject({ region: "auto", prefix: "", path_style: false });
  });
  it("rejects http endpoints", () => {
    expect(StorageConfigInput.safeParse({ ...ok, endpoint: "http://s3.example.com" }).success).toBe(false);
  });
  it("rejects endpoints with userinfo, query, or fragment", () => {
    for (const endpoint of [
      "https://user:pw@s3.example.com",
      "https://user@s3.example.com",
      "https://s3.example.com/?x=1",
      "https://s3.example.com/?",
      "https://s3.example.com/#frag",
    ])
      expect(StorageConfigInput.safeParse({ ...ok, endpoint }).success, endpoint).toBe(false);
    expect(StorageConfigInput.safeParse({ ...ok, endpoint: "https://s3.example.com:9000/" }).success).toBe(true);
  });
  it("validates bucket names", () => {
    for (const bucket of ["abc", "my.bucket-1", "a".repeat(63)])
      expect(StorageConfigInput.safeParse({ ...ok, bucket }).success, bucket).toBe(true);
    for (const bucket of ["ab", "a".repeat(64), "My-Bucket", "-abc", "abc-", "a_b_c", "a/b/c", ""])
      expect(StorageConfigInput.safeParse({ ...ok, bucket }).success, bucket).toBe(false);
  });
});

describe("MetricKey", () => {
  it("accepts ordinary keys", () => {
    for (const k of ["loss", "train/acc", "lr@0", "k".repeat(256)]) expect(MetricKey.safeParse(k).success, k).toBe(true);
  });
  it("rejects commas, whitespace, control chars, empty, and >256 chars", () => {
    for (const k of ["", "a,b", "a b", "a\tb", "a\nb", "a\x00b", "a\x1fb", "k".repeat(257)])
      expect(MetricKey.safeParse(k).success, JSON.stringify(k)).toBe(false);
  });
});

describe("UploadCreate", () => {
  const ok = { path: "ckpt/model.pt", kind: "checkpoint", size: 10 };
  it("accepts relative paths", () => {
    for (const path of ["model.pt", "a/b/c.bin", "a.b/..c/d..", ".hidden"])
      expect(UploadCreate.safeParse({ ...ok, path }).success, path).toBe(true);
  });
  it("rejects unsafe paths", () => {
    for (const path of ["", "/abs", "a/", "a//b", ".", "..", "a/./b", "a/../b", "../a", "a\\b", "a\x00b", "a\nb", "a\x7fb"])
      expect(UploadCreate.safeParse({ ...ok, path }).success, JSON.stringify(path)).toBe(false);
  });
  it("rejects unsafe sizes", () => {
    expect(UploadCreate.safeParse({ ...ok, size: Number.MAX_SAFE_INTEGER + 1 }).success).toBe(false);
    expect(UploadCreate.safeParse({ ...ok, size: -1 }).success).toBe(false);
  });
});

describe("seq contract", () => {
  it("RunCreate defaults writer_id to 0 and validates it", () => {
    expect(RunCreate.parse({}).writer_id).toBe(0);
    expect(RunCreate.parse({ writer_id: 3 }).writer_id).toBe(3);
    expect(RunCreate.safeParse({ writer_id: -1 }).success).toBe(false);
    expect(RunCreate.safeParse({ writer_id: 2 ** 31 }).success).toBe(false);
  });
  it("RunCreated carries last_seq (-1 = no commits)", () => {
    expect(RunCreated.parse({ id: "r", last_seq: -1 }).last_seq).toBe(-1);
    expect(RunCreated.safeParse({ id: "r" }).success).toBe(false);
    expect(RunCreated.safeParse({ id: "r", last_seq: -2 }).success).toBe(false);
  });
  it("ErrorBody allows optional last_seq", () => {
    expect(ErrorBody.parse({ error: { code: "seq_conflict", message: "m", last_seq: 4 } }).error.last_seq).toBe(4);
    expect(ErrorBody.safeParse({ error: { code: "x", message: "m" } }).success).toBe(true);
  });
  it("MetricsFlush rejects unsafe seq", () => {
    expect(MetricsFlush.safeParse({ writer_id: 0, seq: Number.MAX_SAFE_INTEGER + 1, points: [] }).success).toBe(false);
  });
});

describe("Json size cap", () => {
  it("rejects config over 256k chars", () => {
    expect(RunPatch.safeParse({ config: { a: "x".repeat(255_000) } }).success).toBe(true);
    expect(RunPatch.safeParse({ config: { a: "x".repeat(256_000) } }).success).toBe(false);
  });
  it("RunPatch no longer has heartbeat", () => {
    expect("heartbeat" in RunPatch.shape).toBe(false);
  });
});

describe("UploadInstructions", () => {
  it("discriminates single vs multipart", () => {
    expect(UploadInstructions.parse({ type: "multipart", part_size: 5, parts: [{ n: 1, url: "u" }] }).type).toBe("multipart");
    expect(UploadInstructions.safeParse({ type: "single", url: "u" }).success).toBe(false);
  });
});
