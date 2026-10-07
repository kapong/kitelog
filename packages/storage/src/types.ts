export type Body = ReadableStream | ArrayBuffer | Uint8Array | string;

export interface PutOptions {
  contentType?: string;
  /** Required when `body` is a ReadableStream (R2 and S3 both need a known length). */
  size?: number;
}

export interface StoredObject {
  body: ReadableStream;
  size: number;
  contentType: string | null;
}

export interface ListedObject {
  key: string;
  size: number;
}

export interface CompletedPart {
  n: number;
  etag: string;
}

export interface Storage {
  /** false for the R2 binding: callers must route uploads through a Worker URL instead. */
  readonly canPresign: boolean;
  put(key: string, body: Body, opts?: PutOptions): Promise<void>;
  get(key: string): Promise<StoredObject | null>;
  delete(key: string): Promise<void>;
  deleteMany(keys: string[]): Promise<void>;
  /** Size of an object, or null if missing. */
  head(key: string): Promise<{ size: number } | null>;
  /** Bytes [offset, offset+length) of an object (shorter if it runs past the end). 404 if missing. */
  getRange(key: string, offset: number, length: number): Promise<ArrayBuffer>;
  /** All objects under `prefix` (relative to the storage's own prefix), across pages. */
  list(prefix: string): Promise<ListedObject[]>;
  presignPut(key: string, expiresSec: number): Promise<string>;
  presignGet(key: string, expiresSec: number): Promise<string>;
  createMultipart(key: string, contentType?: string): Promise<string>;
  presignPart(key: string, uploadId: string, partNumber: number, expiresSec: number): Promise<string>;
  completeMultipart(key: string, uploadId: string, parts: CompletedPart[]): Promise<void>;
  abortMultipart(key: string, uploadId: string): Promise<void>;
}

export class StorageError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "StorageError";
  }
}

/** Wrap a stream so Workers send/store it with a fixed Content-Length (no-op outside Workers). */
export function sized(body: Body, size: number | undefined): Body {
  if (!(body instanceof ReadableStream) || size == null) return body;
  if (typeof FixedLengthStream === "undefined") return body;
  const fixed = new FixedLengthStream(size);
  void body.pipeTo(fixed.writable).catch(() => {});
  return fixed.readable;
}

// Segments `.`/`..` (literal or percent-encoded) would be resolved away by WHATWG URL parsing,
// letting a key escape the storage prefix (and, path-style, the bucket) with a valid signature.
const DOT_SEGMENT = /^(?:\.|%2e){1,2}$/i;
const BAD_CHARS = /[\x00-\x1f\x7f\\]/;

/** Reject keys that are empty, absolute, contain dot segments, control chars, or backslashes. */
export function assertKey(key: string): void {
  if (
    typeof key !== "string" ||
    key === "" ||
    key.startsWith("/") ||
    BAD_CHARS.test(key) ||
    key.split("/").some((seg) => DOT_SEGMENT.test(seg))
  ) {
    throw new StorageError(`invalid object key: ${JSON.stringify(key)}`, 400, "invalid_key");
  }
}

/** Like assertKey, but "" (everything) and a trailing "/" are allowed. */
export function assertPrefix(prefix: string): void {
  if (prefix === "") return;
  assertKey(prefix.endsWith("/") ? prefix.slice(0, -1) : prefix);
}

export function assertRange(offset: number, length: number): void {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) {
    throw new StorageError(`invalid range: offset=${offset} length=${length}`, 400, "invalid_range");
  }
}

/** hyparquet's AsyncBuffer over a stored object; each slice is one ranged read. */
export interface AsyncBuffer {
  byteLength: number;
  slice(start: number, end?: number): Promise<ArrayBuffer>;
}

export function asyncBuffer(storage: Storage, key: string, size: number): AsyncBuffer {
  return {
    byteLength: size,
    slice: (start, end = size) => storage.getRange(key, start, Math.max(0, end - start)),
  };
}
