import { describe, expect, it } from "vitest";
import { parquetMetadata } from "hyparquet";
import {
  MAX_COMPACT_ROWS,
  MAX_SEGMENTS_PER_CHUNK,
  ROW_GROUP_SIZE,
  WHOLE_FILE_BYTES,
  chunkKey,
  compact,
  downsample,
  encodeSegment,
  metricsBase,
  parseChunkKey,
  parseSegmentKey,
  planCompaction,
  readMetadata,
  readRows,
  readSeries,
  segmentKey,
  sortChunkKeys,
  type AsyncBuffer,
} from "../src/index";

// No @types/node in this package: the few Node globals the tests use, typed locally.
const node = globalThis as unknown as {
  process: { memoryUsage(): { heapUsed: number } };
  console: { log(...a: unknown[]): void };
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(t: unknown): void;
  gc?: () => void;
};
const log = (...a: unknown[]) => node.console.log(...a);

const big = 2 ** 40 + 7; // > 2^31, < MAX_SAFE_INTEGER

/** AsyncBuffer over bytes that counts slice() calls and bytes returned (like ranged GETs). */
function counted(bytes: Uint8Array) {
  const stats = { calls: 0, bytes: 0 };
  const file: AsyncBuffer = {
    byteLength: bytes.byteLength,
    slice: async (start, end = bytes.byteLength) => {
      stats.calls++;
      stats.bytes += end - start;
      return bytes.slice(start, end).buffer as ArrayBuffer;
    },
  };
  return { file, stats };
}

describe("encodeSegment / readRows", () => {
  it("roundtrips int64 steps > 2^31 and negative floats, sorted by (key, step)", async () => {
    const pts = [
      { key: "loss", step: big, value: -1.25, ts: 1_700_000_000_123 },
      { key: "acc", step: 3, value: 0.5, ts: 2 },
      { key: "loss", step: 1, value: -1e-300, ts: 1 },
      { key: "acc", step: 1, value: Number.MAX_VALUE, ts: 1 },
    ];
    const rows = await readRows(encodeSegment(pts, 7));
    expect(rows).toEqual([
      { key: "acc", step: 1, value: Number.MAX_VALUE, ts: 1, writer_id: 7 },
      { key: "acc", step: 3, value: 0.5, ts: 2, writer_id: 7 },
      { key: "loss", step: 1, value: -1e-300, ts: 1, writer_id: 7 },
      { key: "loss", step: big, value: -1.25, ts: 1_700_000_000_123, writer_id: 7 },
    ]);
  });

  it("writes the spec column types", () => {
    const bytes = encodeSegment([{ key: "a", step: 1, value: 1, ts: 1 }], 0);
    const md = parquetMetadata(bytes.slice().buffer);
    const cols = Object.fromEntries(md.schema.slice(1).map((s) => [s.name, s.type]));
    expect(cols).toEqual({ key: "BYTE_ARRAY", step: "INT64", value: "DOUBLE", ts: "INT64", writer_id: "INT32" });
  });

  it("empty segment roundtrips", async () => {
    expect(await readRows(encodeSegment([], 0))).toEqual([]);
  });

  it("filters keys and skips row groups by key stats", async () => {
    const keys = ["a", "b", "c", "d"];
    const pts = keys.flatMap((key) =>
      Array.from({ length: ROW_GROUP_SIZE }, (_, step) => ({ key, step, value: step, ts: 1 })),
    );
    const bytes = encodeSegment(pts, 0);
    const md = parquetMetadata(bytes.slice().buffer);
    expect(md.row_groups.length).toBe(4);
    const st = md.row_groups[2]!.columns[0]!.meta_data!.statistics!;
    expect([st.min_value, st.max_value]).toEqual(["c", "c"]);

    const rows = await readRows(bytes, { keys: ["c", "zz"] });
    expect(rows.length).toBe(ROW_GROUP_SIZE);
    expect(rows.every((r) => r.key === "c")).toBe(true);
    expect(await readRows(bytes, { keys: ["nope"] })).toEqual([]);
  });

  it("filters within a shared row group", async () => {
    const bytes = encodeSegment(
      [
        { key: "x", step: 1, value: 1, ts: 1 },
        { key: "y", step: 1, value: 2, ts: 1 },
        { key: "z", step: 1, value: 3, ts: 1 },
      ],
      0,
    );
    expect((await readRows(bytes, { keys: ["y"] })).map((r) => r.value)).toEqual([2]);
  });

  it("range-reads: a single-key read on a 100k-row multi-key file fetches far fewer bytes", async () => {
    const keys = Array.from({ length: 10 }, (_, i) => `key/${i}`);
    const pts = keys.flatMap((key) =>
      Array.from({ length: 10_000 }, (_, step) => ({ key, step, value: Math.sin(step) * step, ts: 1_700_000_000_000 + step })),
    );
    const bytes = encodeSegment(pts, 0);
    const { file, stats } = counted(bytes);
    const rows = await readRows(file, { keys: ["key/4"] });
    expect(rows.length).toBe(10_000);
    expect(rows.every((r) => r.key === "key/4")).toBe(true);
    log(`range read: file ${bytes.byteLength} B, fetched ${stats.bytes} B in ${stats.calls} slices`);
    expect(stats.calls).toBeLessThanOrEqual(3); // footer (+ maybe larger footer) + one row-group range
    expect(stats.bytes).toBeLessThan(bytes.byteLength / 3);

    // readSeries uses the same path
    const s2 = counted(bytes);
    const series = await readSeries([s2.file], ["key/4"], 100);
    expect(series["key/4"]!.step.length).toBeLessThanOrEqual(100);
    expect(s2.stats.bytes).toBe(stats.bytes);
  });

  it("coalesces adjacent kept row groups into one ranged slice", async () => {
    const pts = Array.from({ length: 3 * ROW_GROUP_SIZE }, (_, step) => ({ key: "a", step, value: step, ts: 1 }));
    pts.push({ key: "b", step: 0, value: 0, ts: 1 });
    const bytes = encodeSegment(pts, 0);
    const { file, stats } = counted(bytes);
    expect((await readRows(file, { keys: ["a"] })).length).toBe(3 * ROW_GROUP_SIZE);
    expect(stats.calls).toBe(2); // footer + one range for 3 groups
  });
});

describe("compact", () => {
  it("merges segments, sorts (key, step, writer_id), keeps latest ts per (key, step)", async () => {
    const w0a = encodeSegment(
      [
        { key: "loss", step: 1, value: 10, ts: 100 },
        { key: "loss", step: 2, value: 20, ts: 100 },
      ],
      0,
    );
    const w0b = encodeSegment([{ key: "loss", step: 2, value: 21, ts: 200 }], 0);
    const w1 = encodeSegment(
      [
        { key: "loss", step: 2, value: 22, ts: 150 }, // older than w0b's → dropped
        { key: "loss", step: 1, value: 11, ts: 300 }, // newer than w0a → wins
        { key: "acc", step: big, value: -0.5, ts: 1 },
      ],
      1,
    );
    const rows = await readRows(await compact([w0a, w0b, w1]));
    expect(rows).toEqual([
      { key: "acc", step: big, value: -0.5, ts: 1, writer_id: 1 },
      { key: "loss", step: 1, value: 11, ts: 300, writer_id: 1 },
      { key: "loss", step: 2, value: 21, ts: 200, writer_id: 0 },
    ]);
  });

  it("ts tie: later input wins (also within one segment)", async () => {
    const a = encodeSegment(
      [
        { key: "k", step: 1, value: 1, ts: 5 },
        { key: "k", step: 1, value: 2, ts: 5 },
      ],
      0,
    );
    const b = encodeSegment([{ key: "k", step: 2, value: 3, ts: 5 }], 0);
    const c = encodeSegment([{ key: "k", step: 2, value: 4, ts: 5 }], 1);
    expect((await readRows(await compact([a, b, c]))).map((r) => r.value)).toEqual([2, 4]);
  });

  it("accepts AsyncBuffers and is idempotent", async () => {
    const seg = encodeSegment([{ key: "a", step: 1, value: 1, ts: 1 }], 0);
    const once = await compact([counted(seg).file]);
    expect(await readRows(await compact([once, seg]))).toEqual(await readRows(once));
  });

  it("rejects more than MAX_COMPACT_ROWS rows", async () => {
    const seg = encodeSegment(
      Array.from({ length: MAX_COMPACT_ROWS / 2 + 1 }, (_, step) => ({ key: "a", step, value: 1, ts: 1 })),
      0,
    );
    await expect(compact([seg, seg])).rejects.toThrow(RangeError);
  });

  it(
    "20 segments × 10k rows stays under a heap budget",
    async () => {
      const keys = Array.from({ length: 50 }, (_, i) => `train/metric_${i}`);
      const segs: Uint8Array[] = [];
      for (let s = 0; s < MAX_SEGMENTS_PER_CHUNK; s++) {
        const pts = Array.from({ length: 10_000 }, (_, i) => ({
          key: keys[i % keys.length]!,
          step: s * 200 + Math.floor(i / keys.length),
          value: Math.random(),
          ts: 1_700_000_000_000 + s * 15_000 + i,
        }));
        segs.push(encodeSegment(pts, s % 2));
      }
      node.gc?.();
      const before = node.process.memoryUsage().heapUsed;
      const out = await compact(segs);
      const md = await readMetadata(out);
      expect(Number(md.num_rows)).toBe(200_000);
      const mb = (node.process.memoryUsage().heapUsed - before) / 2 ** 20;
      log(`compact 200k rows: heapUsed delta ≈ ${mb.toFixed(1)} MB (no gc in between), out ${out.byteLength} B`);
      expect(mb).toBeLessThan(100);
    },
    60_000,
  );
});

describe("heap ceiling (child process with a capped V8 old space)", () => {
  // The in-process heapUsed delta above cannot see the peak (compaction is mostly
  // synchronous). This runs the real code under --max-old-space-size, the way the audit
  // measured the old implementation (which OOMed at 128 MB on 500k rows).
  const script = (mode: "compact" | "series", segs: number) => `
    const { compact, encodeSegment, readSeries } = await import(process.env.SRC);
    const keys = Array.from({ length: 50 }, (_, i) => "train/metric_" + i);
    const segs = [];
    for (let s = 0; s < ${segs}; s++) segs.push(encodeSegment(Array.from({ length: 10000 }, (_, i) =>
      ({ key: keys[i % 50], step: s * 200 + Math.floor(i / 50), value: Math.random(), ts: 1e12 + s * 15000 + i })), s % 2));
    ${mode === "compact" ? "await compact(segs);" : "await readSeries(segs, keys, 2000);"}
    console.log("ok");`;
  const run = async (mode: "compact" | "series", segs: number, oldSpaceMb: number) => {
    const cp = (await import("node:child_process" as string)) as {
      spawnSync(cmd: string, args: string[], o: object): { stdout: { toString(): string }; status: number | null };
    };
    const meta = import.meta as unknown as { dirname: string };
    const src = `${meta.dirname}/../src/index.ts`;
    const r = cp.spawnSync(
      (node.process as unknown as { execPath: string }).execPath,
      [`--max-old-space-size=${oldSpaceMb}`, "--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", script(mode, segs)],
      { env: { ...(node.process as unknown as { env: object }).env, SRC: src }, encoding: "utf8" },
    );
    return r.status === 0 && r.stdout.toString().includes("ok");
  };

  it("compact of 20 × 10k-row segments (200k rows) fits in 48 MB", async () => {
    expect(await run("compact", MAX_SEGMENTS_PER_CHUNK, 48)).toBe(true);
  }, 60_000);

  it("readSeries over 100 files / 1M rows / 50 keys fits in 48 MB", async () => {
    expect(await run("series", 100, 48)).toBe(true);
  }, 60_000);
});

describe("planCompaction", () => {
  it("orders by (writer_id, seq), ignores non-segments, batches by count and rows", () => {
    const base = metricsBase("", "p", "r");
    const names = [
      segmentKey(base, 1, 0),
      segmentKey(base, 0, 2),
      chunkKey(base, 0),
      segmentKey(base, 0, 10),
      segmentKey(base, 0, 1),
    ];
    expect(planCompaction(names)).toEqual([
      [segmentKey(base, 0, 1), segmentKey(base, 0, 2), segmentKey(base, 0, 10), segmentKey(base, 1, 0)],
    ]);
    const many = Array.from({ length: 45 }, (_, i) => segmentKey(base, 0, i));
    expect(planCompaction(many).map((b) => b.length)).toEqual([20, 20, 5]);
    const rows = [150_000, 60_000, 10, 199_999];
    expect(planCompaction(many.slice(0, 4), rows).map((b) => b.length)).toEqual([1, 2, 1]);
  });
});

describe("downsample", () => {
  const n = 100_000;
  const steps = Array.from({ length: n }, (_, i) => i);
  const values = steps.map((i) => Math.sin(i / 1000));
  values[31_337] = 1e6; // spike
  values[77_777] = -1e6; // dip

  it("respects maxPoints, keeps first/last and extremes, stays step-ordered", () => {
    for (const max of [10, 11, 2000]) {
      const d = downsample(steps, values, max);
      expect(d.step.length).toBeLessThanOrEqual(max);
      expect(d.step.length).toBe(d.value.length);
      expect(d.step[0]).toBe(0);
      expect(d.step.at(-1)).toBe(n - 1);
      expect(d.value).toContain(1e6);
      expect(d.value).toContain(-1e6);
      expect(d.step).toEqual([...d.step].sort((a, b) => a - b));
    }
  });

  it("returns input unchanged when small", () => {
    expect(downsample([1, 2, 3], [4, 5, 6], 10)).toEqual({ step: [1, 2, 3], value: [4, 5, 6] });
  });
});

describe("readSeries", () => {
  it("groups by key, dedupes by latest ts, sorts by step, includes empty requested keys", async () => {
    const seg = encodeSegment(
      [
        { key: "a", step: 2, value: 2, ts: 1 },
        { key: "a", step: 1, value: 1, ts: 1 },
        { key: "a", step: 2, value: 9, ts: 5 },
        { key: "other", step: 1, value: 1, ts: 1 },
      ],
      0,
    );
    expect(await readSeries([seg], ["a", "missing"], 2000)).toEqual({
      a: { step: [1, 2], value: [1, 9] },
      missing: { step: [], value: [] },
    });
  });

  it("small remote files are fetched whole: one slice per file, large ones still ranged", async () => {
    const seg = encodeSegment(
      Array.from({ length: 3 * ROW_GROUP_SIZE }, (_, i) => ({ key: `k${i % 3}`, step: i, value: i, ts: 1 })),
      0,
    );
    expect(seg.byteLength).toBeLessThanOrEqual(WHOLE_FILE_BYTES);
    const files = [counted(seg), counted(seg), counted(seg)];
    const out = await readSeries(files.map((f) => f.file), ["k0", "k2"], 100);
    expect(out.k0!.step.length).toBeGreaterThan(0);
    for (const f of files) expect(f.stats).toEqual({ calls: 1, bytes: seg.byteLength });
    // compact: also one GET per (small) segment
    const segs = [counted(seg), counted(seg)];
    await compact(segs.map((f) => f.file));
    for (const f of segs) expect(f.stats.calls).toBe(1);
  });

  it("3 chunks with overlapping steps resolve to the latest ts (tie → later file)", async () => {
    const c0 = await compact([
      encodeSegment(
        [
          { key: "loss", step: 1, value: 1, ts: 10 },
          { key: "loss", step: 2, value: 2, ts: 10 },
          { key: "loss", step: 3, value: 3, ts: 10 },
        ],
        0,
      ),
    ]);
    const c1 = await compact([
      encodeSegment(
        [
          { key: "loss", step: 3, value: 33, ts: 20 }, // retry/late: newer → wins over c0
          { key: "loss", step: 4, value: 4, ts: 20 },
          { key: "loss", step: 5, value: 5, ts: 30 },
        ],
        1,
      ),
    ]);
    const c2 = await compact([
      encodeSegment(
        [
          { key: "loss", step: 4, value: 44, ts: 20 }, // tie with c1 → later file wins
          { key: "loss", step: 5, value: 55, ts: 25 }, // older than c1 → loses
          { key: "loss", step: 6, value: 6, ts: 40 },
        ],
        0,
      ),
    ]);
    expect(await readSeries([c0, c1, c2], ["loss"])).toEqual({
      loss: { step: [1, 2, 3, 4, 5, 6], value: [1, 2, 33, 44, 5, 6] },
    });
  });

  it(
    "1M points across files: ≤ maxPoints, keeps global min/max and endpoints",
    async () => {
      const files: Uint8Array[] = [];
      const per = 200_000;
      for (let f = 0; f < 5; f++) {
        const pts = Array.from({ length: per }, (_, i) => {
          const step = f * per + i;
          return { key: "loss", step, value: Math.sin(step / 5000), ts: step };
        });
        if (f === 1) pts[12_345]!.value = 1e9;
        if (f === 3) pts[54_321]!.value = -1e9;
        // an "other" key interleaved in the same files
        pts.push(...Array.from({ length: 1000 }, (_, i) => ({ key: "zz", step: i, value: i, ts: 1 })));
        files.push(encodeSegment(pts, 0));
      }
      const max = 2000;
      const s = (await readSeries(files.map((b) => counted(b).file), ["loss"], max))["loss"]!;
      expect(s.step.length).toBeLessThanOrEqual(max);
      expect(s.step.length).toBeGreaterThan(max / 2);
      expect(s.step[0]).toBe(0);
      expect(s.step.at(-1)).toBe(5 * per - 1);
      expect(Math.max(...s.value)).toBe(1e9);
      expect(Math.min(...s.value)).toBe(-1e9);
      expect(s.step).toEqual([...s.step].sort((a, b) => a - b));
      expect(new Set(s.step).size).toBe(s.step.length);
    },
    120_000,
  );
});

describe("object naming", () => {
  it("formats and parses segment and chunk keys", () => {
    const base = metricsBase("pre", "p1", "r1");
    expect(base).toBe("pre/p/p1/r/r1/metrics/");
    expect(metricsBase("", "p1", "r1")).toBe("p/p1/r/r1/metrics/");
    expect(metricsBase("/pre/", "p1", "r1")).toBe("pre/p/p1/r/r1/metrics/");
    const k = segmentKey(base, 3, 42);
    expect(k).toBe("pre/p/p1/r/r1/metrics/seg-3-000042.parquet");
    expect(parseSegmentKey(k)).toEqual({ writerId: 3, seq: 42 });
    expect(parseSegmentKey("seg-0-1234567.parquet")).toEqual({ writerId: 0, seq: 1234567 });
    expect(parseSegmentKey("chunk-000001.parquet")).toBeNull();
    expect(parseSegmentKey("seg-0-42.parquet")).toBeNull();
    expect(parseSegmentKey("seg-x-000001.parquet")).toBeNull();

    const c = chunkKey(base, 7);
    expect(c).toBe("pre/p/p1/r/r1/metrics/chunk-000007.parquet");
    expect(parseChunkKey(c)).toBe(7);
    expect(parseChunkKey("chunk-1234567.parquet")).toBe(1234567);
    expect(parseChunkKey("chunk-7.parquet")).toBeNull();
    expect(parseChunkKey(k)).toBeNull();

    const u = chunkKey(base, 7, "0a1b2c3d");
    expect(u).toBe("pre/p/p1/r/r1/metrics/chunk-000007-0a1b2c3d.parquet");
    expect(parseChunkKey(u)).toBe(7);
    expect(parseChunkKey("chunk-000007-XYZ.parquet")).toBeNull();
    // order: by n, then full key; legacy (no suffix) and suffixed coexist
    const keys = [chunkKey(base, 1, "ff"), chunkKey(base, 0, "b0"), chunkKey(base, 1), k, chunkKey(base, 0, "a0")];
    expect(sortChunkKeys(keys, (x) => x)).toEqual([
      chunkKey(base, 0, "a0"),
      chunkKey(base, 0, "b0"),
      chunkKey(base, 1, "ff"),
      chunkKey(base, 1),
    ]);
  });
});
