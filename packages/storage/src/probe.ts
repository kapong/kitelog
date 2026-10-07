import type { Storage } from "./types";

export type ProbeResult = { ok: true } | { ok: false; step: "put" | "get" | "delete"; error: string };

/** put/get/delete a tiny object; used by `POST .../storage/test` before saving S3 config. */
export async function probe(storage: Storage): Promise<ProbeResult> {
  const key = `.kitelog-probe/${crypto.randomUUID()}`;
  const payload = `kitelog-probe ${Date.now()}`;
  let step: "put" | "get" | "delete" = "put";
  try {
    await storage.put(key, payload, { contentType: "text/plain" });
    step = "get";
    const obj = await storage.get(key);
    if (!obj) return { ok: false, step, error: "object not found after put" };
    const text = await new Response(obj.body).text();
    if (text !== payload) return { ok: false, step, error: "content mismatch" };
    step = "delete";
    await storage.delete(key);
    return { ok: true };
  } catch (e) {
    return { ok: false, step, error: e instanceof Error ? e.message : String(e) };
  }
}
