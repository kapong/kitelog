import { AwsClient } from "aws4fetch";
import { type Body, type CompletedPart, type PutOptions, type Storage, type StoredObject, StorageError, sized } from "./types";

export interface S3Config {
  endpoint: string; // https only, e.g. https://<account>.r2.cloudflarestorage.com
  region: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  secretAccessKey: string;
  pathStyle: boolean;
}

type Fetch = (req: Request) => Promise<Response>;

/** encodeURIComponent per segment + RFC 3986 extras, keeping `/` (matches aws4fetch's canonical path). */
export const encodeKey = (key: string): string =>
  key
    .split("/")
    .map((s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase()))
    .join("/");

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
export const decodeXml = (s: string): string =>
  s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) =>
    e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENTITIES[e.toLowerCase()]!,
  );
const escapeXml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);

const tag = (xml: string, name: string): string | null => {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? decodeXml(m[1]!) : null;
};
const tags = (xml: string, name: string): string[] =>
  [...xml.matchAll(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "g"))].map((m) => decodeXml(m[1]!));

export class S3Storage implements Storage {
  readonly canPresign = true;
  private readonly aws: AwsClient;
  private readonly base: string; // URL up to and including the bucket, no trailing slash
  private readonly prefix: string; // "" or "a/b/"
  private readonly fetch: Fetch;

  constructor(cfg: S3Config, fetchImpl?: Fetch) {
    const ep = new URL(cfg.endpoint);
    if (ep.protocol !== "https:") throw new StorageError("S3 endpoint must be https://", 400, "invalid_endpoint");
    const path = ep.pathname.replace(/\/+$/, "");
    this.base = cfg.pathStyle
      ? `${ep.origin}${path}/${encodeKey(cfg.bucket)}`
      : `https://${cfg.bucket}.${ep.host}${path}`;
    const p = cfg.prefix.replace(/^\/+|\/+$/g, "");
    this.prefix = p ? p + "/" : "";
    this.aws = new AwsClient({
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
      service: "s3",
      region: cfg.region || "auto",
    });
    this.fetch = fetchImpl ?? ((req) => fetch(req));
  }

  private url(key: string, query: Record<string, string> = {}): string {
    const k = key ? "/" + encodeKey(this.prefix + key.replace(/^\/+/, "")) : "/";
    const qs = new URLSearchParams(query).toString();
    return this.base + k + (qs ? "?" + qs : "");
  }

  private async send(method: string, url: string, init: { headers?: Record<string, string>; body?: Body } = {}, allow404 = false): Promise<Response | null> {
    const req = await this.aws.sign(url, { method, headers: init.headers, body: init.body as BodyInit | undefined });
    const res = await this.fetch(req);
    if (res.ok) return res;
    if (allow404 && res.status === 404) {
      await res.body?.cancel();
      return null;
    }
    const text = await res.text().catch(() => "");
    const code = tag(text, "Code") ?? `http_${res.status}`;
    throw new StorageError(`S3 ${method} failed: ${res.status} ${code}${tag(text, "Message") ? ` (${tag(text, "Message")})` : ""}`, res.status, code);
  }

  /** CompleteMultipartUpload (and some others) can return 200 with an <Error> body. */
  private async xml(res: Response): Promise<string> {
    const text = await res.text();
    if (/<Error>/.test(text)) {
      const code = tag(text, "Code") ?? "unknown";
      throw new StorageError(`S3 error: ${code} ${tag(text, "Message") ?? ""}`.trim(), 500, code);
    }
    return text;
  }

  private presign(method: string, url: string, expiresSec: number): Promise<string> {
    const u = new URL(url);
    u.searchParams.set("X-Amz-Expires", String(Math.floor(expiresSec)));
    return this.aws.sign(u.toString(), { method, aws: { signQuery: true } }).then((r) => r.url);
  }

  async put(key: string, body: Body, opts: PutOptions = {}): Promise<void> {
    const headers: Record<string, string> = {};
    if (opts.contentType) headers["Content-Type"] = opts.contentType;
    const res = await this.send("PUT", this.url(key), { headers, body: sized(body, opts.size) });
    await res!.body?.cancel();
  }

  async get(key: string): Promise<StoredObject | null> {
    const res = await this.send("GET", this.url(key), {}, true);
    if (!res) return null;
    return {
      body: res.body ?? new Response("").body!,
      size: Number(res.headers.get("Content-Length") ?? 0),
      contentType: res.headers.get("Content-Type"),
    };
  }

  async delete(key: string): Promise<void> {
    const res = await this.send("DELETE", this.url(key), {}, true);
    await res?.body?.cancel();
  }

  // ponytail: DeleteObjects needs Content-MD5 (no MD5 in WebCrypto outside Workers) or
  // x-amz-checksum-*, which R2/RustFS/MinIO support unevenly. Individual DELETEs with small
  // concurrency are universally compatible; switch to batch if compaction delete volume hurts.
  async deleteMany(keys: string[]): Promise<void> {
    const queue = [...keys];
    const worker = async () => {
      for (let k = queue.shift(); k !== undefined; k = queue.shift()) await this.delete(k);
    };
    await Promise.all(Array.from({ length: Math.min(8, queue.length) }, worker));
  }

  async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let token: string | null = null;
    do {
      const q: Record<string, string> = { "list-type": "2", prefix: this.prefix + prefix.replace(/^\/+/, "") };
      if (token) q["continuation-token"] = token;
      const xml = await this.xml((await this.send("GET", this.url("", q)))!);
      for (const k of tags(xml, "Key")) keys.push(k.slice(this.prefix.length));
      token = tag(xml, "IsTruncated") === "true" ? tag(xml, "NextContinuationToken") : null;
    } while (token);
    return keys;
  }

  presignPut(key: string, expiresSec: number): Promise<string> {
    return this.presign("PUT", this.url(key), expiresSec);
  }

  presignGet(key: string, expiresSec: number): Promise<string> {
    return this.presign("GET", this.url(key), expiresSec);
  }

  async createMultipart(key: string, contentType?: string): Promise<string> {
    const headers: Record<string, string> = contentType ? { "Content-Type": contentType } : {};
    const xml = await this.xml((await this.send("POST", this.url(key, { uploads: "" }), { headers }))!);
    const id = tag(xml, "UploadId");
    if (!id) throw new StorageError("S3 CreateMultipartUpload: no UploadId in response", 502, "bad_response");
    return id;
  }

  presignPart(key: string, uploadId: string, partNumber: number, expiresSec: number): Promise<string> {
    return this.presign("PUT", this.url(key, { partNumber: String(partNumber), uploadId }), expiresSec);
  }

  async completeMultipart(key: string, uploadId: string, parts: CompletedPart[]): Promise<void> {
    const body =
      "<CompleteMultipartUpload>" +
      [...parts]
        .sort((a, b) => a.n - b.n)
        .map((p) => `<Part><PartNumber>${p.n}</PartNumber><ETag>${escapeXml(p.etag)}</ETag></Part>`)
        .join("") +
      "</CompleteMultipartUpload>";
    await this.xml((await this.send("POST", this.url(key, { uploadId }), { headers: { "Content-Type": "application/xml" }, body }))!);
  }

  async abortMultipart(key: string, uploadId: string): Promise<void> {
    const res = await this.send("DELETE", this.url(key, { uploadId }), {}, true);
    await res?.body?.cancel();
  }
}
