const b64encode = (bytes: Uint8Array): string => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};
const b64decode = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function importKey(keyB64: string): Promise<CryptoKey> {
  const raw = b64decode(keyB64);
  if (raw.length !== 32) throw new Error("STORAGE_ENC_KEY must be base64 of 32 bytes");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** AES-256-GCM; returns base64(iv[12] | ciphertext+tag). */
export async function encryptSecret(plaintext: string, keyB64: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await importKey(keyB64), new TextEncoder().encode(plaintext));
  const out = new Uint8Array(12 + ct.byteLength);
  out.set(iv);
  out.set(new Uint8Array(ct), 12);
  return b64encode(out);
}

export async function decryptSecret(encB64: string, keyB64: string): Promise<string> {
  const data = b64decode(encB64);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: data.subarray(0, 12) }, await importKey(keyB64), data.subarray(12));
  return new TextDecoder().decode(pt);
}
