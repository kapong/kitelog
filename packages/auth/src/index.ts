// Framework-free auth primitives (WebCrypto only). See CLAUDE.md "Accounts and auth".

const enc = new TextEncoder();

// ---------- encoding ----------

function toB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toB64Url(bytes: Uint8Array): string {
  return toB64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Constant-time comparison (length leak only). */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

// ---------- passwords ----------

/** Cloudflare Workers caps PBKDF2 at 100000 iterations. */
export const PBKDF2_ITERATIONS = 100_000;

async function pbkdf2(pw: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(pw), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    256,
  );
  return new Uint8Array(bits);
}

/** Returns `pbkdf2$<iterations>$<salt b64>$<hash b64>`. */
export async function hashPassword(pw: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(pw, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toB64(salt)}$${toB64(hash)}`;
}

export async function verifyPassword(pw: string, encoded: string): Promise<boolean> {
  const parts = encoded.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > PBKDF2_ITERATIONS) return false;
  let salt: Uint8Array, expected: Uint8Array;
  try {
    salt = fromB64(parts[2]!);
    expected = fromB64(parts[3]!);
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length !== 32) return false;
  return timingSafeEqual(await pbkdf2(pw, salt, iterations), expected);
}

// ---------- tokens ----------

export function randomToken(bytes = 32): string {
  return toB64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256Hex(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function tokenPair(): Promise<{ token: string; tokenHash: string }> {
  const token = randomToken();
  return { token, tokenHash: await sha256Hex(token) };
}

// ---------- sessions ----------

export const SESSION_COOKIE = "kl_session";

export const newSessionToken = tokenPair;

/**
 * `secure = false` omits `Secure` (Safari rejects Secure cookies on http://localhost under
 * wrangler dev). The Worker passes `url.protocol === "https:"`.
 */
export function sessionCookie(token: string, maxAgeSec: number, secure = true): string {
  const sec = secure ? " Secure;" : "";
  return `${SESSION_COOKIE}=${token}; Max-Age=${Math.floor(maxAgeSec)}; Path=/; HttpOnly;${sec} SameSite=Lax`;
}

export function clearSessionCookie(secure = true): string {
  return sessionCookie("", 0, secure);
}

export function readCookie(header: string | null | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

// ---------- API keys ----------

export const API_KEY_PREFIX = "kl_";

export async function newApiKey(): Promise<{ key: string; prefix: string; keyHash: string }> {
  const key = API_KEY_PREFIX + randomToken(32);
  return { key, prefix: key.slice(0, 10), keyHash: await hashApiKey(key) };
}

export const hashApiKey = sha256Hex;

/** Extracts a `kl_` key from `Authorization: Bearer kl_...`; anything else → null. */
export function parseBearer(authHeader: string | null | undefined): string | null {
  const m = /^Bearer\s+(kl_[A-Za-z0-9_-]+)\s*$/i.exec(authHeader ?? "");
  return m ? m[1]! : null;
}

// ---------- invites ----------

export const newInviteToken = tokenPair;

// ---------- roles / scopes ----------

export type Role = "owner" | "editor" | "viewer";
export type Scope = "write" | "read";

const ROLE_RANK: Record<Role, number> = { viewer: 0, editor: 1, owner: 2 };
const SCOPE_RANK: Record<Scope, number> = { read: 0, write: 1 };

export function roleAtLeast(role: Role, min: Role): boolean {
  return (ROLE_RANK[role] ?? -1) >= ROLE_RANK[min];
}

export function scopeAllows(scope: Scope, need: Scope): boolean {
  return (SCOPE_RANK[scope] ?? -1) >= SCOPE_RANK[need];
}
