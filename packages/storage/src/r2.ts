import {
  type Body,
  type ListedObject,
  type PutOptions,
  type Storage,
  type StoredObject,
  StorageError,
  assertKey,
  assertPrefix,
  assertRange,
  sized,
} from "./types";

const noPresign = (): never => {
  throw new StorageError("R2 binding cannot presign; use the Worker upload URL", 501, "presign_unsupported");
};

export class R2Storage implements Storage {
  readonly canPresign = false;
  constructor(private readonly bucket: R2Bucket) {}

  async put(key: string, body: Body, opts: PutOptions = {}): Promise<void> {
    assertKey(key);
    await this.bucket.put(key, sized(body, opts.size) as ReadableStream | ArrayBuffer | string, {
      httpMetadata: opts.contentType ? { contentType: opts.contentType } : undefined,
    });
  }

  async get(key: string): Promise<StoredObject | null> {
    assertKey(key);
    const obj = await this.bucket.get(key);
    if (!obj) return null;
    return { body: obj.body, size: obj.size, contentType: obj.httpMetadata?.contentType ?? null };
  }

  async head(key: string): Promise<{ size: number } | null> {
    assertKey(key);
    const obj = await this.bucket.head(key);
    return obj ? { size: obj.size } : null;
  }

  async getRange(key: string, offset: number, length: number): Promise<ArrayBuffer> {
    assertKey(key);
    assertRange(offset, length);
    if (length === 0) return new ArrayBuffer(0);
    const obj = await this.bucket.get(key, { range: { offset, length } });
    if (!obj) throw new StorageError(`object not found: ${key}`, 404, "not_found");
    return obj.arrayBuffer();
  }

  async delete(key: string): Promise<void> {
    assertKey(key);
    await this.bucket.delete(key);
  }

  async deleteMany(keys: string[]): Promise<void> {
    keys.forEach(assertKey);
    for (let i = 0; i < keys.length; i += 1000) await this.bucket.delete(keys.slice(i, i + 1000));
  }

  async list(prefix: string): Promise<ListedObject[]> {
    assertPrefix(prefix);
    const out: ListedObject[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await this.bucket.list({ prefix, cursor });
      for (const o of page.objects) out.push({ key: o.key, size: o.size });
      if (!page.truncated) return out;
      cursor = page.cursor;
    }
  }

  // Validate keys first so both backends reject bad keys the same way (400 before 501).
  presignPut = (key: string, _expiresSec: number): Promise<string> => (assertKey(key), noPresign());
  presignGet = (key: string, _expiresSec: number): Promise<string> => (assertKey(key), noPresign());
  createMultipart = (key: string, _contentType?: string): Promise<string> => (assertKey(key), noPresign());
  presignPart = (key: string, _uploadId: string, _n: number, _e: number): Promise<string> => (assertKey(key), noPresign());
  completeMultipart = (key: string, _uploadId: string, _parts: unknown): Promise<void> => (assertKey(key), noPresign());
  abortMultipart = (key: string, _uploadId: string): Promise<void> => (assertKey(key), noPresign());
}
