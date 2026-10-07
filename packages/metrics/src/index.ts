// Parquet metrics: encode segments, compact segments into immutable chunks, range-read
// series. Pure JS, Worker-safe, storage-agnostic: inputs are hyparquet AsyncBuffers
// (`{ byteLength, slice(start, end) }`, e.g. backed by ranged GETs) or Uint8Arrays.
//
// Codec: SNAPPY — hyparquet-writer's default, implemented in pure JS (no WASM, no zlib),
// and hyparquet decodes it natively. Keys repeat heavily in long format, so the
// dictionary + snappy combination keeps files small (~17 B/row).
//
// Row groups: ROW_GROUP_SIZE rows each, statistics on. Rows are sorted by key, so each
// row group covers a narrow [min,max] key range and reads skip groups (and their bytes)
// that cannot contain requested keys. Memory: reads decode one row group at a time
// straight into column arrays; nothing materialises a per-row object.
//
// String ordering: keys are compared with JS `<` (UTF-16 code units) everywhere — the
// writer's min/max stats (hyparquet-writer compares strings with `<`), our sort, and the
// reader's stats check — so the three always agree even where UTF-8 byte order differs.
import { parquetMetadataAsync, parquetRead } from "hyparquet";
import type { AsyncBuffer, FileMetaData, RowGroup } from "hyparquet";
import { parquetWriteBuffer } from "hyparquet-writer";
import type { MetricPoint, MetricsRead } from "@kitelog/shared";

export type { AsyncBuffer } from "hyparquet";
export type Source = AsyncBuffer | Uint8Array;

export const ROW_GROUP_SIZE = 10_000;
export const DEFAULT_MAX_POINTS = 2000;
/** Hard cap on rows merged into one chunk (Worker heap ceiling is ~300k rows/request). */
export const MAX_COMPACT_ROWS = 200_000;
/** Each segment ≤ MAX_POINTS_PER_FLUSH (10k) rows, so 20 segments ≤ MAX_COMPACT_ROWS. */
export const MAX_SEGMENTS_PER_CHUNK = 20;
/** Tail bytes fetched for the footer; hyparquet fetches more if the footer is larger. */
export const FOOTER_FETCH_BYTES = 64 * 1024;
/** Max bytes fetched in one ranged read when coalescing adjacent kept row groups. */
export const MAX_RANGE_BYTES = 8 * 1024 * 1024;
/** Files at most this big are fetched with ONE GET and sliced in memory (1 subrequest per file). */
export const WHOLE_FILE_BYTES = 256 * 1024;
/** Files read concurrently by readSeries (memory ≈ this × one file's rows for the keys). */
const READ_CONCURRENCY = 4;

export interface MetricRow {
  key: string;
  step: number;
  value: number;
  ts: number;
  writer_id: number;
}

// ---- write ----

interface Columns {
  key: string[];
  step: ArrayLike<number>;
  value: ArrayLike<number>;
  ts: ArrayLike<number>;
  writer_id: ArrayLike<number>;
}

function writeColumns(c: Columns): Uint8Array {
  const buf = parquetWriteBuffer({
    columnData: [
      { name: "key", data: c.key, type: "STRING" },
      { name: "step", data: BigInt64Array.from(c.step, (v) => BigInt(v)), type: "INT64" },
      { name: "value", data: Float64Array.from(c.value), type: "DOUBLE" },
      { name: "ts", data: BigInt64Array.from(c.ts, (v) => BigInt(v)), type: "INT64" },
      { name: "writer_id", data: Int32Array.from(c.writer_id), type: "INT32" },
    ],
    codec: "SNAPPY",
    statistics: true,
    rowGroupSize: ROW_GROUP_SIZE,
  });
  return new Uint8Array(buf);
}

/** One flush → one Parquet segment, rows stably sorted by (key, step). Not deduped. */
export function encodeSegment(points: MetricPoint[], writerId: number): Uint8Array {
  const sorted = points
    .slice()
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.step - b.step));
  return writeColumns({
    key: sorted.map((p) => p.key),
    step: sorted.map((p) => p.step),
    value: sorted.map((p) => p.value),
    ts: sorted.map((p) => p.ts),
    writer_id: new Int32Array(sorted.length).fill(writerId),
  });
}

// ---- range reads ----

const toArrayBuffer = (b: Uint8Array): ArrayBuffer =>
  (b.byteOffset === 0 && b.byteLength === b.buffer.byteLength
    ? b.buffer
    : b.slice().buffer) as ArrayBuffer;

/** ArrayBuffer satisfies AsyncBuffer, so a Uint8Array only needs unwrapping. */
export const asAsyncBuffer = (f: Source): AsyncBuffer => (f instanceof Uint8Array ? toArrayBuffer(f) : f);

/** Small remote file → fetched whole once, so footer + row-group slices cost one GET total. */
async function wholeIfSmall(f: Source): Promise<AsyncBuffer> {
  const file = asAsyncBuffer(f);
  if (file instanceof ArrayBuffer || file.byteLength > WHOLE_FILE_BYTES) return file;
  return file.slice(0, file.byteLength);
}

/** Footer only: one tail read of FOOTER_FETCH_BYTES (two if the footer is larger). */
export function readMetadata(file: Source): Promise<FileMetaData> {
  return parquetMetadataAsync(asAsyncBuffer(file), { initialFetchSize: FOOTER_FETCH_BYTES });
}

/** One decoded row group, columnar. Arrays are only valid during the callback. */
interface Group {
  n: number;
  key: string[];
  step: Float64Array;
  value: Float64Array;
  ts: Float64Array;
  writer_id: Int32Array;
}

function groupByteRange(rg: RowGroup): [number, number] {
  let start = Infinity;
  let end = 0;
  for (const c of rg.columns) {
    const m = c.meta_data!;
    const s = Number(m.dictionary_page_offset || m.data_page_offset);
    start = Math.min(start, s);
    end = Math.max(end, s + Number(m.total_compressed_size));
  }
  return [start, end];
}

function keepGroup(rg: RowGroup, sortedKeys: string[] | null): boolean {
  if (!sortedKeys) return true;
  const stats = rg.columns.find((c) => c.meta_data?.path_in_schema[0] === "key")?.meta_data?.statistics;
  const min = stats?.min_value ?? stats?.min;
  const max = stats?.max_value ?? stats?.max;
  if (typeof min !== "string" || typeof max !== "string") return true; // no stats: must read
  return sortedKeys.some((k) => k >= min && k <= max);
}

/**
 * Decode the row groups that may hold `keys` (all groups when null), one at a time.
 * Adjacent kept groups are fetched with ONE ranged slice (capped at MAX_RANGE_BYTES);
 * skipped groups' bytes are never requested.
 */
async function scanGroups(
  source: Source,
  keys: string[] | null,
  onGroup: (g: Group) => void,
  metadata?: FileMetaData,
): Promise<void> {
  const file = asAsyncBuffer(source);
  const md = metadata ?? (await readMetadata(file));
  const sortedKeys = keys ? [...new Set(keys)].sort() : null;

  // Runs of adjacent kept groups: [firstGroup, lastGroup] with their byte span.
  type Run = { groups: { rg: RowGroup; start: number; rows: number }[]; from: number; to: number };
  const runs: Run[] = [];
  let rowStart = 0;
  let prevKept = false;
  for (const rg of md.row_groups) {
    const rows = Number(rg.num_rows);
    const kept = rows > 0 && keepGroup(rg, sortedKeys);
    if (kept) {
      const [from, to] = groupByteRange(rg);
      const last = runs[runs.length - 1];
      if (prevKept && last && from === last.to && to - last.from <= MAX_RANGE_BYTES) {
        last.groups.push({ rg, start: rowStart, rows });
        last.to = to;
      } else {
        runs.push({ groups: [{ rg, start: rowStart, rows }], from, to });
      }
    }
    prevKept = kept;
    rowStart += rows;
  }

  for (const run of runs) {
    const bytes = await file.slice(run.from, run.to);
    const ranged: AsyncBuffer = {
      byteLength: file.byteLength,
      slice: (s, e = file.byteLength) =>
        s >= run.from && e <= run.to ? bytes.slice(s - run.from, e - run.from) : file.slice(s, e),
    };
    for (const { start, rows } of run.groups) {
      const g: Group = {
        n: rows,
        key: new Array<string>(rows),
        step: new Float64Array(rows),
        value: new Float64Array(rows),
        ts: new Float64Array(rows),
        writer_id: new Int32Array(rows),
      };
      await parquetRead({
        file: ranged,
        metadata: md,
        rowStart: start,
        rowEnd: start + rows,
        onChunk: ({ columnName, columnData, rowStart: cs }) => {
          const off = cs - start;
          const len = Math.min(columnData.length, rows - off);
          const src = columnData as ArrayLike<unknown>;
          if (columnName === "key") {
            for (let i = Math.max(0, -off); i < len; i++) g.key[off + i] = src[i] as string;
          } else {
            const dst = (g as unknown as Record<string, Float64Array | Int32Array>)[columnName];
            if (!dst) return;
            for (let i = Math.max(0, -off); i < len; i++) dst[off + i] = Number(src[i]);
          }
        },
      });
      onGroup(g);
    }
  }
}

/**
 * All rows, or only rows whose key is in `keys` (row groups whose key stats exclude every
 * requested key are neither fetched nor decoded). Materialises row objects: use for
 * small reads/tests; series reads use readSeries.
 */
export async function readRows(file: Source, opts: { keys?: string[] } = {}): Promise<MetricRow[]> {
  const want = opts.keys ? new Set(opts.keys) : null;
  const out: MetricRow[] = [];
  await scanGroups(file, opts.keys ?? null, (g) => {
    for (let i = 0; i < g.n; i++) {
      const key = g.key[i]!;
      if (want && !want.has(key)) continue; // kept groups can hold other keys at their edges
      out.push({ key, step: g.step[i]!, value: g.value[i]!, ts: g.ts[i]!, writer_id: g.writer_id[i]! });
    }
  });
  return out;
}

// ---- compaction ----

/**
 * Merge pending segments into ONE new immutable chunk, sorted by (key, step, writer_id)
 * and deduped within: same (key, step) keeps the latest ts; on a ts tie the later input
 * wins. Callers pass segments sorted by (writer_id, seq) (see planCompaction), so a
 * writer's later flush beats its earlier one. Duplicates ACROSS chunks are resolved at
 * read time (readSeries). Throws RangeError above MAX_COMPACT_ROWS (checked from footers
 * before any row is decoded).
 *
 * Memory: columnar (≈40 B/row + key pointers), no per-row objects or string-keyed maps.
 */
export async function compact(segments: Source[]): Promise<Uint8Array> {
  const files = await Promise.all(segments.map(wholeIfSmall));
  const metas = await Promise.all(files.map((f) => readMetadata(f)));
  const total = metas.reduce((s, m) => s + Number(m.num_rows), 0);
  if (total > MAX_COMPACT_ROWS) {
    throw new RangeError(`compact: ${total} rows > MAX_COMPACT_ROWS (${MAX_COMPACT_ROWS})`);
  }

  const key = new Array<string>(total);
  const step = new Float64Array(total);
  const value = new Float64Array(total);
  const ts = new Float64Array(total);
  const writer = new Int32Array(total);
  let n = 0;
  for (let f = 0; f < files.length; f++) {
    await scanGroups(
      files[f]!,
      null,
      (g) => {
        for (let i = 0; i < g.n; i++, n++) {
          key[n] = g.key[i]!;
          step[n] = g.step[i]!;
          value[n] = g.value[i]!;
          ts[n] = g.ts[i]!;
          writer[n] = g.writer_id[i]!;
        }
      },
      metas[f],
    );
  }

  // Rank keys once so the sort compares ints, not strings.
  const uniq = [...new Set(key.slice(0, n))].sort();
  const rankOf = new Map(uniq.map((k, i) => [k, i]));
  const rank = new Int32Array(n);
  for (let i = 0; i < n; i++) rank[i] = rankOf.get(key[i]!)!;

  // Index order = input order, so the final `a - b` makes later input win ts ties.
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  order.sort((a, b) => rank[a]! - rank[b]! || step[a]! - step[b]! || ts[a]! - ts[b]! || a - b);

  // Keep the last row of each (key, step) run.
  const kept: number[] = [];
  for (let j = 0; j < n; j++) {
    const i = order[j]!;
    const next = j + 1 < n ? order[j + 1]! : -1;
    if (next < 0 || rank[next] !== rank[i] || step[next] !== step[i]) kept.push(i);
  }
  return writeColumns({
    key: kept.map((i) => key[i]!),
    step: kept.map((i) => step[i]!),
    value: kept.map((i) => value[i]!),
    ts: kept.map((i) => ts[i]!),
    writer_id: kept.map((i) => writer[i]!),
  });
}

/**
 * Split pending segment names into compaction batches, each → one chunk. Segments are
 * ordered by (writer_id, seq) (the order compact() expects); a batch holds at most
 * MAX_SEGMENTS_PER_CHUNK segments and, when `rowCounts` (aligned with `segmentNames`) is
 * given, at most MAX_COMPACT_ROWS rows. Names that are not segments are ignored.
 */
export function planCompaction(segmentNames: string[], rowCounts?: number[]): string[][] {
  const segs = segmentNames
    .map((name, i) => ({ name, rows: rowCounts?.[i] ?? 0, id: parseSegmentKey(name) }))
    .filter((s): s is { name: string; rows: number; id: { writerId: number; seq: number } } => s.id !== null)
    .sort((a, b) => a.id.writerId - b.id.writerId || a.id.seq - b.id.seq);
  const batches: string[][] = [];
  let cur: string[] = [];
  let rows = 0;
  for (const s of segs) {
    if (cur.length && (cur.length >= MAX_SEGMENTS_PER_CHUNK || rows + s.rows > MAX_COMPACT_ROWS)) {
      batches.push(cur);
      cur = [];
      rows = 0;
    }
    cur.push(s.name);
    rows += s.rows;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

// ---- series ----

/** Indices kept by min/max bucket downsampling (see downsample). */
function downsampleIndices(values: ArrayLike<number>, n: number, maxPoints: number): number[] {
  if (n <= maxPoints) return Array.from({ length: n }, (_, i) => i);
  if (maxPoints < 2) return Array.from({ length: maxPoints }, (_, i) => i);
  const out = [0];
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
    if (iMin === iMax) out.push(iMin);
    else out.push(Math.min(iMin, iMax), Math.max(iMin, iMax));
  }
  out.push(n - 1);
  return out;
}

/**
 * Min/max bucket downsample. Always keeps the first and last point; every bucket
 * between contributes its min and max (in step order), so spikes — and the global
 * min/max — survive, also when applied repeatedly. Output length ≤ maxPoints.
 * Input must be sorted by step.
 */
export function downsample(
  steps: number[],
  values: number[],
  maxPoints: number = DEFAULT_MAX_POINTS,
): { step: number[]; value: number[] } {
  const idx = downsampleIndices(values, steps.length, maxPoints);
  return { step: idx.map((i) => steps[i]!), value: idx.map((i) => values[i]!) };
}

interface Part {
  step: number[];
  value: number[];
  ts: number[];
}

/**
 * Sort by step (stable) and keep one point per step: latest ts, tie → later position.
 * Already-sorted input (every file we write) skips the sort.
 */
function dedupeByStep(p: Part): Part {
  const n = p.step.length;
  let sorted = true;
  for (let i = 1; i < n && sorted; i++) if (p.step[i]! < p.step[i - 1]!) sorted = false;
  const order = Array.from({ length: n }, (_, i) => i);
  if (!sorted) order.sort((a, b) => p.step[a]! - p.step[b]! || a - b);
  const out: Part = { step: [], value: [], ts: [] };
  for (let j = 0; j < n; j++) {
    const i = order[j]!;
    const last = out.step.length - 1;
    if (last >= 0 && out.step[last] === p.step[i]) {
      if (p.ts[i]! >= out.ts[last]!) {
        out.value[last] = p.value[i]!;
        out.ts[last] = p.ts[i]!;
      }
    } else {
      out.step.push(p.step[i]!);
      out.value.push(p.value[i]!);
      out.ts.push(p.ts[i]!);
    }
  }
  return out;
}

function downsamplePart(p: Part, maxPoints: number): Part {
  const idx = downsampleIndices(p.value, p.step.length, maxPoints);
  if (idx.length === p.step.length) return p;
  return { step: idx.map((i) => p.step[i]!), value: idx.map((i) => p.value[i]!), ts: idx.map((i) => p.ts[i]!) };
}

/**
 * Series for `keys` across files (chunks then segments, in write order: on equal ts the
 * later file wins). Per file: range-read only the row groups that may hold the keys,
 * fold rows straight into per-key column arrays, dedupe, downsample to maxPoints. Then
 * per key: concatenate files, stable sort by step, dedupe equal steps across files by
 * latest ts, downsample once more. Memory: O(keys × maxPoints) plus, per concurrently
 * read file (READ_CONCURRENCY), one row group and that file's rows for the requested keys.
 *
 * Approximation: a step can appear in two files only via retries/late writers. If the
 * newer copy was bucket-dropped by its file's downsample while the older copy survived
 * its own, the older (superseded) value is shown at that step. Accepted: rare, and
 * the plotted point is still a real value of that series at that step.
 */
export async function readSeries(
  files: Source[],
  keys: string[],
  maxPoints: number = DEFAULT_MAX_POINTS,
): Promise<MetricsRead["series"]> {
  const want = new Set(keys);
  const readFile = async (file: Source): Promise<Map<string, Part>> => {
    const acc = new Map<string, Part>();
    await scanGroups(await wholeIfSmall(file), keys, (g) => {
      let cur: Part | undefined;
      let curKey: string | undefined;
      for (let i = 0; i < g.n; i++) {
        const k = g.key[i]!;
        if (k !== curKey) {
          curKey = k;
          cur = acc.get(k);
          if (!cur && want.has(k)) acc.set(k, (cur = { step: [], value: [], ts: [] }));
        }
        if (!cur) continue;
        cur.step.push(g.step[i]!);
        cur.value.push(g.value[i]!);
        cur.ts.push(g.ts[i]!);
      }
    });
    for (const [k, p] of acc) acc.set(k, downsamplePart(dedupeByStep(p), maxPoints));
    return acc;
  };

  // Fold files in order into a running per-key series, re-downsampled whenever it grows
  // past 4 × maxPoints, so memory does not grow with the number of files. Folding in
  // file order keeps "later file wins ts ties". A step the running series already
  // dropped can only be re-added by a later file, whose copy is the newer one anyway.
  const running = new Map<string, Part>(keys.map((k) => [k, { step: [], value: [], ts: [] }]));
  for (let at = 0; at < files.length; at += READ_CONCURRENCY) {
    const batch = await Promise.all(files.slice(at, at + READ_CONCURRENCY).map(readFile));
    for (const acc of batch) {
      for (const [k, p] of acc) {
        const r = running.get(k)!;
        for (let i = 0; i < p.step.length; i++) {
          r.step.push(p.step[i]!);
          r.value.push(p.value[i]!);
          r.ts.push(p.ts[i]!);
        }
        if (r.step.length > 4 * maxPoints) running.set(k, downsamplePart(dedupeByStep(r), 2 * maxPoints));
      }
    }
  }

  const series: MetricsRead["series"] = {};
  for (const [key, r] of running) {
    const merged = downsamplePart(dedupeByStep(r), maxPoints);
    series[key] = { step: merged.step, value: merged.value };
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

/**
 * `chunk-{n:06}-{suffix}.parquet`. The random hex suffix makes two concurrent compactions
 * that pick the same n write DIFFERENT objects (overlapping rows, deduped at read) instead
 * of one overwriting the other. Legacy chunks have no suffix.
 */
export function chunkKey(base: string, n: number, suffix?: string): string {
  return `${base}chunk-${String(n).padStart(6, "0")}${suffix ? `-${suffix}` : ""}.parquet`;
}

/** Chunk keys in write order: by n, then by full key (ties come only from concurrent compactions). */
export function sortChunkKeys<T>(items: T[], key: (t: T) => string): T[] {
  return items
    .map((t) => ({ t, k: key(t), n: parseChunkKey(key(t)) }))
    .filter((x) => x.n !== null)
    .sort((a, b) => a.n! - b.n! || (a.k < b.k ? -1 : a.k > b.k ? 1 : 0))
    .map((x) => x.t);
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

/** Chunk number from a bare name or full object key; null if not a chunk. */
export function parseChunkKey(name: string): number | null {
  const m = /(?:^|\/)chunk-(\d{6,})(?:-([0-9a-f]+))?\.parquet$/.exec(name);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) ? n : null;
}
