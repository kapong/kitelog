import { describe, expect, it } from "vitest";
import {
  clearSessionCookie, hashApiKey, hashPassword, newApiKey, newInviteToken, newSessionToken,
  parseBearer, randomToken, readCookie, roleAtLeast, scopeAllows, sessionCookie, sha256Hex,
  verifyPassword,
} from "../src/index";

describe("passwords", () => {
  it("roundtrips and rejects wrong password", async () => {
    const enc = await hashPassword("hunter2");
    expect(enc).toMatch(/^pbkdf2\$100000\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(await verifyPassword("hunter2", enc)).toBe(true);
    expect(await verifyPassword("hunter3", enc)).toBe(false);
    expect(await hashPassword("hunter2")).not.toBe(enc); // random salt
  });
  it("rejects tampered encodings", async () => {
    const enc = await hashPassword("pw");
    const [alg, it, salt, hash] = enc.split("$");
    const flip = (s: string) => (s[0] === "A" ? "B" : "A") + s.slice(1);
    for (const bad of [
      `${alg}$${it}$${salt}$${flip(hash!)}`,
      `${alg}$${it}$${flip(salt!)}$${hash}`,
      `${alg}$99999$${salt}$${hash}`,
      `${alg}$1000000$${salt}$${hash}`,
      `scrypt$${it}$${salt}$${hash}`,
      `${alg}$${it}$${salt}`,
      `${alg}$${it}$${salt}$!!!`,
      "",
    ]) expect(await verifyPassword("pw", bad)).toBe(false);
  });
  it("roundtrips the empty password", async () => {
    const enc = await hashPassword("");
    expect(await verifyPassword("", enc)).toBe(true);
    expect(await verifyPassword(" ", enc)).toBe(false);
  });
  it("rejects a valid-base64 hash of the wrong length", async () => {
    const [alg, it, salt] = (await hashPassword("pw")).split("$");
    const short = btoa(String.fromCharCode(...new Uint8Array(31)));
    const long = btoa(String.fromCharCode(...new Uint8Array(33)));
    for (const h of [short, long, ""]) expect(await verifyPassword("pw", `${alg}$${it}$${salt}$${h}`)).toBe(false);
  });
});

describe("tokens", () => {
  it("randomToken is base64url of requested length", () => {
    expect(randomToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken(16)).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });
  it("sha256Hex", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
  it("session/invite token hash matches", async () => {
    for (const { token, tokenHash } of [await newSessionToken(), await newInviteToken()])
      expect(tokenHash).toBe(await sha256Hex(token));
  });
});

describe("api keys", () => {
  it("format, prefix, hash", async () => {
    const { key, prefix, keyHash } = await newApiKey();
    expect(key).toMatch(/^kl_[A-Za-z0-9_-]{43}$/);
    expect(prefix).toBe(key.slice(0, 10));
    expect(prefix).toHaveLength(10);
    expect(keyHash).toBe(await hashApiKey(key));
    expect(keyHash).toMatch(/^[0-9a-f]{64}$/);
  });
  it("parseBearer accepts only kl_ keys", () => {
    expect(parseBearer("Bearer kl_abc-_123")).toBe("kl_abc-_123");
    expect(parseBearer("bearer kl_x")).toBe("kl_x");
    expect(parseBearer("Bearer abc")).toBeNull();
    expect(parseBearer("Basic kl_abc")).toBeNull();
    expect(parseBearer("Bearer kl_a b")).toBeNull();
    expect(parseBearer("kl_abc")).toBeNull();
    expect(parseBearer(null)).toBeNull();
  });
});

describe("cookies", () => {
  it("builds session cookies", () => {
    const c = sessionCookie("tok", 3600);
    expect(c).toContain("kl_session=tok");
    for (const a of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/", "Max-Age=3600"]) expect(c).toContain(a);
    expect(clearSessionCookie()).toContain("Max-Age=0");
    expect(clearSessionCookie()).toContain("Secure");
  });
  it("omits Secure when secure=false", () => {
    const c = sessionCookie("tok", 60, false);
    expect(c).not.toContain("Secure");
    for (const a of ["HttpOnly", "SameSite=Lax", "Path=/"]) expect(c).toContain(a);
    expect(clearSessionCookie(false)).not.toContain("Secure");
  });
  it("readCookie", () => {
    const h = "a=1; kl_session=xyz=; other_kl_session=no";
    expect(readCookie(h, "kl_session")).toBe("xyz=");
    expect(readCookie(h, "a")).toBe("1");
    expect(readCookie(h, "missing")).toBeNull();
    expect(readCookie(null, "a")).toBeNull();
  });
});

describe("roles and scopes", () => {
  it("roleAtLeast", () => {
    expect(roleAtLeast("owner", "editor")).toBe(true);
    expect(roleAtLeast("editor", "editor")).toBe(true);
    expect(roleAtLeast("viewer", "editor")).toBe(false);
    expect(roleAtLeast("editor", "owner")).toBe(false);
    expect(roleAtLeast("viewer", "viewer")).toBe(true);
  });
  it("scopeAllows", () => {
    expect(scopeAllows("write", "read")).toBe(true);
    expect(scopeAllows("write", "write")).toBe(true);
    expect(scopeAllows("read", "read")).toBe(true);
    expect(scopeAllows("read", "write")).toBe(false);
  });
});
