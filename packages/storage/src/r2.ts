import { type Body, type PutOptions, type Storage, type StoredObject, StorageError, sized } from "./types";

const noPresign = (): never => {
  throw new StorageError("R2 binding cannot presign; use the Worker upload URL", 501, "presign_unsupported");
};

export class R2Storage implements Storage {
  readonly canPresign = false;
  constructor(private readonly bucket: R2Bucket) {}

  async put(key: string, body: Body, opts: PutOptions = {}): Promise<void> {
    await this.bucket.put(key, sized(body, opts.size) as ReadableStream | ArrayBuffer | string, {
      httpMetadata: opts.contentType ? { contentType: opts.contentType } : undefined,
    });
  }

  async get(key: string): Promise<StoredObject | null> {
    const obj = await this.bucket.get(key);
    if (!obj) return null;
    return { body: obj.body, size: obj.size, contentType: obj.httpMetadata?.contentType ?? null };
  }

  async delete(key: string): Promise<void> {
    await this.bucket.delete(key);
  }

  async deleteMany(keys: string[]): Promise<void> {
    for (let i = 0; i < keys.length; i += 1000) await this.bucket.delete(keys.slice(i, i + 1000));
  }

  async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await this.bucket.list({ prefix, cursor });
      for (const o of page.objects) keys.push(o.key);
      if (!page.truncated) return keys;
      cursor = page.cursor;
    }
  }

  presignPut = noPresign;
  presignGet = noPresign;
  createMultipart = noPresign;
  presignPart = noPresign;
  completeMultipart = noPresign;
  abortMultipart = noPresign;
}
