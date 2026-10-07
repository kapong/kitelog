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
  /** All keys under `prefix` (relative to the storage's own prefix), across pages. */
  list(prefix: string): Promise<string[]>;
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
