// Parquet metric segments: encode, read, compact, downsample. Pure JS, Worker-safe,
// storage-agnostic (bytes in, bytes out).
//
// Codec: SNAPPY — hyparquet-writer's default, implemented in pure JS (no WASM, no zlib),
// and hyparquet decodes it natively. Keys repeat heavily in long format, so the
// dictionary + snappy combination keeps segments small.
//
// Row groups: ROW_GROUP_SIZE rows each, statistics on (default true). Rows are sorted by
// key, so each row group covers a narrow [min,max] key range and readRows() can skip
// groups that cannot contain requested keys. 10k rows ≈ a single flush (MAX_POINTS_PER_FLUSH),
// small enough for skipping in a big data.parquet, large enough to keep per-group
// overhead negligible.
import { parquetMetadata, parquetRead } from "hyparquet";
import { parquetWriteBuffer } from "hyparquet-writer";
import type { MetricPoint, MetricsRead } from "@kitelog/shared";

export const ROW_GROUP_SIZE = 10_000;
export const DEFAULT_MAX_POINTS = 2000;

export interface MetricRow {
  key: string;
  step: number;
  value: number;
  ts: number;
  writer_id: number;
}

const byKeyStep = (a: { key: string; step: number }, b: { key: string; step: number }) =>
  a.key < b.key ? -1 : a.key > b.key ? 1 : a.step - b.step;

function writeRows(rows: MetricRow[]): Uint8Array {
  const buf = parquetWriteBuffer({
    columnData: [
      { name: "key", data: rows.map((r) => r.key), type: "STRING" },
      { name: "step", data: BigInt64Array.from(rows, (r) => BigInt(r.step)), type: "INT64" },
      { name: "value", data: Float64Array.from(rows, (r) => r.value), type: "DOUBLE" },
      { name: "ts", data: BigInt64Array.from(rows, (r) => BigInt(r.ts)), type: "INT64" },
      { name: "writer_id", data: Int32Array.from(rows, (r) => r.writer_id), type: "INT32" },
    ],
    codec: "SNAPPY",
    statistics: true,
    rowGroupSize: ROW_GROUP_SIZE,
  });
  return new Uint8Array(buf);
}

/** One flush → one Parquet segment, rows sorted by (key, step). */
export function encodeSegment(points: MetricPoint[], writerId: number): Uint8Array {
  const rows = points.map((p) => ({ key: p.key, step: p.step, value: p.value, ts: p.ts, writer_id: writerId }));
  return writeRows(rows.sort(byKeyStep));
}

const toArrayBuffer = (b: Uint8Array): ArrayBuffer =>
  (b.byteOffset === 0 && b.byteLength === b.buffer.byteLength
    ? b.buffer
    : b.slice().buffer) as ArrayBuffer;

/**
 * Read all rows, or only rows whose key is in `keys`. With `keys`, row groups whose
 * key min/max statistics exclude every requested key are never decoded.
 */
export async function readRows(bytes: Uint8Array, opts: { keys?: string[] } = {}): Promise<MetricRow[]> {
  const file = toArrayBuffer(bytes); // ArrayBuffer satisfies hyparquet's AsyncBuffer
  const metadata = parquetMetadata(file);
  const want = opts.keys ? new Set(opts.keys) : null;
  const sorted = want ? [...want].sort() : [];

  // Row ranges to decode: [start, end) per kept row group, adjacent ranges merged.
  const ranges: [number, number][] = [];
  let start = 0;
  for (const rg of metadata.row_groups) {
    const end = start + Number(rg.num_rows);
    let keep = true;
    if (want) {
      const stats = rg.columns.find((c) => c.meta_data?.path_in_schema[0] === "key")?.meta_data?.statistics;
      const min = stats?.min_value ?? stats?.min;
      const max = stats?.max_value ?? stats?.max;
      if (typeof min === "string" && typeof max === "string") {
        keep = sorted.some((k) => k >= min && k <= max);
      }
    }
    if (keep) {
      const last = ranges[ranges.length - 1];
      if (last && last[1] === start) last[1] = end;
      else ranges.push([start, end]);
    }
    start = end;
  }

  const out: MetricRow[] = [];
  for (const [rowStart, rowEnd] of ranges) {
    await parquetRead({
      file,
      metadata,
      rowStart,
      rowEnd,
      rowFormat: "object",
      onComplete: (rows) => {
        for (const r of rows) {
          // Kept groups can still hold other keys at their edges.
          if (want && !want.has(r.key)) continue;
          out.push({
            key: r.key,
            step: Number(r.step),
            value: r.value,
            ts: Number(r.ts),
            writer_id: r.writer_id,
          });
        }
      },
    });
  }
  return out;
}

/**
 * Merge data.parquet + segments into one file sorted by (key, step, writer_id).
 * Duplicate (key, step): keep the row with the latest ts (ties: later input file wins).
 */
export async function compact(files: Uint8Array[]): Promise<Uint8Array> {
  const latest = new Map<string, MetricRow>();
  for (const f of files) {
    for (const r of await readRows(f)) {
      const id = `${r.step}\u0000${r.key}`;
      const prev = latest.get(id);
      if (!prev || r.ts >= prev.ts) latest.set(id, r);
    }
  }
  const rows = [...latest.values()].sort((a, b) => byKeyStep(a, b) || a.writer_id - b.writer_id);
  return writeRows(rows);
}

/**
 * Min/max bucket downsample. Always keeps the first and last point; every bucket
 * between contributes its min and max (in step order), so spikes stay visible.
 * Output length ≤ maxPoints. Input must be sorted by step.
 */
export function downsample(
  steps: number[],
  values: number[],
  maxPoints: number = DEFAULT_MAX_POINTS,
): { step: number[]; value: number[] } {
  const n = steps.length;
  if (n <= maxPoints) return { step: steps.slice(), value: values.slice() };
  if (maxPoints < 2) return { step: steps.slice(0, maxPoints), value: values.slice(0, maxPoints) };
  const step = [steps[0]!];
  const value = [values[0]!];
  const buckets = Math.floor((maxPoints - 2) / 2);
  const inner = n - 2; // points 1..n-2
  for (let b = 0; b < buckets; b++) {
    const lo = 1 + Math.floor((b * inner) / buckets);
    const hi = 1 + Math.floor(((b + 1) * inner) / buckets);
    if (lo >= hi) continue;
    let iMin = lo;
    let iMax = lo;
    for (let i = lo + 1; i < hi; i++) {
      if (values[i]! < values[iMin]!) iMin = i;
      if (values[i]! > values[iMax]!) iMax = i;
    }
    for (const i of iMin === iMax ? [iMin] : [Math.min(iMin, iMax), Math.max(iMin, iMax)]) {
      step.push(steps[i]!);
      value.push(values[i]!);
    }
  }
  step.push(steps[n - 1]!);
  value.push(values[n - 1]!);
  return { step, value };
}

/**
 * Rows (any order, may contain duplicates across data.parquet + segments) → series.
 * Duplicate (key, step) resolves to latest ts, same as compaction.
 */
export function toSeries(
  rows: MetricRow[],
  keys: string[],
  maxPoints: number = DEFAULT_MAX_POINTS,
): MetricsRead["series"] {
  const byKey = new Map<string, Map<number, MetricRow>>(keys.map((k) => [k, new Map()]));
  for (const r of rows) {
    const m = byKey.get(r.key);
    if (!m) continue;
    const prev = m.get(r.step);
    if (!prev || r.ts >= prev.ts) m.set(r.step, r);
  }
  const series: MetricsRead["series"] = {};
  for (const [key, m] of byKey) {
    const sorted = [...m.values()].sort((a, b) => a.step - b.step);
    series[key] = downsample(
      sorted.map((r) => r.step),
      sorted.map((r) => r.value),
      maxPoints,
    );
  }
  return series;
}

// ---- object naming ----

/** `{prefix}/p/{pid}/r/{rid}/metrics/` — no leading slash when prefix is empty. */
export function metricsBase(prefix: string, projectId: string, runId: string): string {
  const p = prefix.replace(/^\/+|\/+$/g, "");
  return `${p ? `${p}/` : ""}p/${projectId}/r/${runId}/metrics/`;
}

export function segmentKey(base: string, writerId: number, seq: number): string {
  return `${base}seg-${writerId}-${String(seq).padStart(6, "0")}.parquet`;
}

export function dataKey(base: string): string {
  return `${base}data.parquet`;
}

/** Accepts a bare name or a full object key. */
export function parseSegmentKey(name: string): { writerId: number; seq: number } | null {
  const m = /(?:^|\/)seg-(\d+)-(\d{6,})\.parquet$/.exec(name);
  if (!m) return null;
  const writerId = Number(m[1]);
  const seq = Number(m[2]);
  if (!Number.isSafeInteger(seq) || writerId > 0x7fffffff) return null;
  return { writerId, seq };
}
