import { AwsClient } from "aws4fetch";
import {
  type Body,
  type CompletedPart,
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

export interface S3Config {
  endpoint: string; // https only, e.g. https://<account>.r2.cloudflarestorage.com
  region: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  secretAccessKey: string;
  pathStyle: boolean;
  /** Dev / private self-hosting only (Worker var ALLOW_PRIVATE_S3_ENDPOINTS): allow http:// and private hosts. */
  allowPrivate?: boolean;
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
/** Inner XML of each <name> element, not entity-decoded (for nested parsing with `tag`). */
const rawTags = (xml: string, name: string): string[] =>
  [...xml.matchAll(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "g"))].map((m) => m[1]!);

const BUCKET_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const MAX_PRESIGN_SEC = 604800; // SigV4 query-signing limit (7 days)

// Integrity check on user-supplied endpoints, NOT the security boundary: Workers' network
// isolation (no route to private/internal networks) is what actually prevents SSRF. This only
// rejects obviously-wrong targets early with a clear error.
function assertEndpoint(ep: URL, allowPrivate: boolean): void {
  const bad = (why: string): never => {
    throw new StorageError(`S3 endpoint ${why}`, 400, "invalid_endpoint");
  };
  if (ep.username || ep.password) bad("must not contain credentials");
  if (ep.protocol !== "https:" && !(allowPrivate && ep.protocol === "http:")) bad("must be https://");
  if (allowPrivate) return;
  const host = ep.hostname.toLowerCase().replace(/\.$/, "");
  if (host.startsWith("[") || /^\d+(\.\d+){3}$/.test(host)) bad("must be a hostname, not an IP address");
  if (host === "localhost" || /\.(localhost|local|internal)$/.test(host)) bad("must be a public hostname");
}

export class S3Storage implements Storage {
  readonly canPresign = true;
  private readonly aws: AwsClient;
  private readonly base: string; // URL up to and including the bucket, no trailing slash
  private readonly prefix: string; // "" or "a/b/"
  private readonly fetch: Fetch;

  constructor(cfg: S3Config, fetchImpl?: Fetch) {
    const ep = new URL(cfg.endpoint);
    assertEndpoint(ep, cfg.allowPrivate === true);
    if (!BUCKET_RE.test(cfg.bucket)) throw new StorageError("invalid S3 bucket name", 400, "invalid_bucket");
    const path = ep.pathname.replace(/\/+$/, "");
    this.base = cfg.pathStyle
      ? `${ep.origin}${path}/${encodeKey(cfg.bucket)}`
      : `${ep.protocol}//${cfg.bucket}.${ep.host}${path}`;
    const p = cfg.prefix.replace(/^\/+|\/+$/g, "");
    if (p) {
      try {
        assertKey(p);
      } catch {
        throw new StorageError("invalid S3 prefix", 400, "invalid_prefix");
      }
    }
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
    assertKey(key); // every object method goes through here
    return this.withQuery(this.base + "/" + encodeKey(this.prefix + key), query);
  }

  private withQuery(url: string, query: Record<string, string>): string {
    const qs = new URLSearchParams(query).toString();
    return url + (qs ? "?" + qs : "");
  }

  private async send(method: string, url: string, init: { headers?: Record<string, string>; body?: Body } = {}, allow404 = false): Promise<Response | null> {
    const req = await this.aws.sign(url, { method, headers: init.headers, body: init.body as BodyInit | undefined });
    let res: Response;
    try {
      res = await this.fetch(req);
    } catch (e) {
      // Network failure (DNS, TLS, refused). workerd's message is often an opaque
      // "internal error; reference = …": name the host instead. No headers/URL query (signatures).
      const why = e instanceof Error && !/internal error/i.test(e.message) ? e.message : "host unreachable, DNS or TLS failure";
      throw new StorageError(`could not connect to endpoint ${new URL(url).host}: ${why}`, 502, "network_error");
    }
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
    if (!(Number.isFinite(expiresSec) && expiresSec >= 1 && expiresSec <= MAX_PRESIGN_SEC)) {
      throw new StorageError(`expiresSec must be 1..${MAX_PRESIGN_SEC}`, 400, "invalid_expires");
    }
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

  async head(key: string): Promise<{ size: number } | null> {
    const res = await this.send("HEAD", this.url(key), {}, true);
    if (!res) return null;
    await res.body?.cancel();
    return { size: Number(res.headers.get("Content-Length") ?? 0) };
  }

  async getRange(key: string, offset: number, length: number): Promise<ArrayBuffer> {
    const url = this.url(key);
    assertRange(offset, length);
    if (length === 0) return new ArrayBuffer(0);
    const res = (await this.send("GET", url, { headers: { Range: `bytes=${offset}-${offset + length - 1}` } }))!;
    if (res.status === 206) {
      const buf = await res.arrayBuffer();
      return buf.byteLength > length ? buf.slice(0, length) : buf;
    }
    // Store ignored Range and sent the whole object: fine only if that's what we asked for.
    const size = Number(res.headers.get("Content-Length") ?? NaN);
    if (offset === 0 && Number.isFinite(size) && length >= size) return res.arrayBuffer();
    await res.body?.cancel();
    throw new StorageError(`S3 GET ignored Range (status ${res.status})`, 502, "range_unsupported");
  }

  async delete(key: string): Promise<void> {
    const res = await this.send("DELETE", this.url(key), {}, true);
    await res?.body?.cancel();
  }

  // ponytail: DeleteObjects needs Content-MD5 (no MD5 in WebCrypto outside Workers) or
  // x-amz-checksum-*, which R2/RustFS/MinIO support unevenly. Individual DELETEs with small
  // concurrency are universally compatible; switch to batch if compaction delete volume hurts.
  async deleteMany(keys: string[]): Promise<void> {
    keys.forEach(assertKey);
    const queue = [...keys];
    const worker = async () => {
      for (let k = queue.shift(); k !== undefined; k = queue.shift()) await this.delete(k);
    };
    await Promise.all(Array.from({ length: Math.min(8, queue.length) }, worker));
  }

  async list(prefix: string): Promise<ListedObject[]> {
    assertPrefix(prefix);
    const out: ListedObject[] = [];
    let token: string | null = null;
    do {
      const q: Record<string, string> = { "list-type": "2", prefix: this.prefix + prefix };
      if (token) q["continuation-token"] = token;
      const xml = await this.xml((await this.send("GET", this.withQuery(this.base + "/", q)))!);
      for (const c of rawTags(xml, "Contents")) {
        out.push({ key: (tag(c, "Key") ?? "").slice(this.prefix.length), size: Number(tag(c, "Size") ?? 0) });
      }
      token = tag(xml, "IsTruncated") === "true" ? tag(xml, "NextContinuationToken") : null;
    } while (token);
    return out;
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
