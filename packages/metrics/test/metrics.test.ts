import { describe, expect, it } from "vitest";
import { parquetMetadata } from "hyparquet";
import {
  ROW_GROUP_SIZE,
  compact,
  dataKey,
  downsample,
  encodeSegment,
  metricsBase,
  parseSegmentKey,
  readRows,
  segmentKey,
  toSeries,
} from "../src/index";

const big = 2 ** 40 + 7; // > 2^31, < MAX_SAFE_INTEGER

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
});

describe("compact", () => {
  it("merges files, sorts (key, step, writer_id), keeps latest ts per (key, step)", async () => {
    const data = encodeSegment(
      [
        { key: "loss", step: 1, value: 10, ts: 100 },
        { key: "loss", step: 2, value: 20, ts: 100 },
      ],
      0,
    );
    const w0 = encodeSegment([{ key: "loss", step: 2, value: 21, ts: 200 }], 0);
    const w1 = encodeSegment(
      [
        { key: "loss", step: 2, value: 22, ts: 150 }, // older than w0's → dropped
        { key: "loss", step: 1, value: 11, ts: 300 }, // newer than data → wins
        { key: "acc", step: big, value: -0.5, ts: 1 },
      ],
      1,
    );
    const rows = await readRows(await compact([data, w0, w1]));
    expect(rows).toEqual([
      { key: "acc", step: big, value: -0.5, ts: 1, writer_id: 1 },
      { key: "loss", step: 1, value: 11, ts: 300, writer_id: 1 },
      { key: "loss", step: 2, value: 21, ts: 200, writer_id: 0 },
    ]);
  });

  it("is idempotent", async () => {
    const seg = encodeSegment([{ key: "a", step: 1, value: 1, ts: 1 }], 0);
    const once = await compact([seg]);
    expect(await readRows(await compact([once, seg]))).toEqual(await readRows(once));
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

describe("toSeries", () => {
  it("groups by key, dedupes by latest ts, sorts by step, includes empty requested keys", () => {
    const rows = [
      { key: "a", step: 2, value: 2, ts: 1, writer_id: 0 },
      { key: "a", step: 1, value: 1, ts: 1, writer_id: 0 },
      { key: "a", step: 2, value: 9, ts: 5, writer_id: 1 },
      { key: "other", step: 1, value: 1, ts: 1, writer_id: 0 },
    ];
    expect(toSeries(rows, ["a", "missing"], 2000)).toEqual({
      a: { step: [1, 2], value: [1, 9] },
      missing: { step: [], value: [] },
    });
  });
});

describe("object naming", () => {
  it("formats and parses segment keys", () => {
    const base = metricsBase("pre", "p1", "r1");
    expect(base).toBe("pre/p/p1/r/r1/metrics/");
    expect(metricsBase("", "p1", "r1")).toBe("p/p1/r/r1/metrics/");
    expect(metricsBase("/pre/", "p1", "r1")).toBe("pre/p/p1/r/r1/metrics/");
    expect(dataKey(base)).toBe("pre/p/p1/r/r1/metrics/data.parquet");
    const k = segmentKey(base, 3, 42);
    expect(k).toBe("pre/p/p1/r/r1/metrics/seg-3-000042.parquet");
    expect(parseSegmentKey(k)).toEqual({ writerId: 3, seq: 42 });
    expect(parseSegmentKey("seg-0-1234567.parquet")).toEqual({ writerId: 0, seq: 1234567 });
    expect(parseSegmentKey("data.parquet")).toBeNull();
    expect(parseSegmentKey("seg-0-42.parquet")).toBeNull();
    expect(parseSegmentKey("seg-x-000001.parquet")).toBeNull();
  });
});
