import { Hono } from "hono";
import { assertKey, StorageError } from "@kitelog/storage";
import { UploadComplete, UploadCreate, type UploadInstructions } from "@kitelog/shared";
import type { AppEnv } from "../env";
import { ApiError, body } from "../http";
import { loadRun, runBase, storageFor } from "../lib";
import { apiKeyAuth, requireScope } from "../middleware/apiKey";

const MB = 1024 * 1024;
const SINGLE_MAX = 100 * MB; // above: multipart (own S3 only)
const PART_SIZE = 64 * MB;
const MAX_PARTS = 10_000;
/**
 * Pending-upload lifetime. Worker body URL (R2): 1 h (spec). Own S3: presigned URLs and the
 * multipart upload live 24 h, so a multi-GB checkpoint on a slow link is not aborted mid-way.
 */
export const UPLOAD_TTL_MS = { r2: 3600_000, s3: 24 * 3600_000 } as const;

export interface UploadRow {
  id: string;
  project_id: string;
  run_id: string | null;
  kind: "checkpoint" | "artifact";
  path: string;
  size: number;
  content_type: string | null;
  storage_key: string;
  backend: "r2" | "s3";
  s3_upload_id: string | null;
  status: "pending" | "completed" | "aborted";
  created_at: number;
}

const expired = (u: UploadRow, now = Date.now()) => now - u.created_at > UPLOAD_TTL_MS[u.backend];

// ---------- client, mounted under /runs/:id/uploads (auth from the parent) ----------
export const runUploads = new Hono<AppEnv>();

runUploads.post("/", async (c) => {
  const run = await loadRun(c);
  const input = await body(c, UploadCreate);
  const { storage, backend, capabilities: caps } = await storageFor(c.env, run.project_id);
  if (!caps.can_save[input.kind]) {
    throw new ApiError(403, "storage_tier_limit", `this project cannot store ${input.kind} files`);
  }
  if (input.kind === "checkpoint" && caps.max_checkpoint_bytes != null && input.size > caps.max_checkpoint_bytes) {
    throw new ApiError(413, "too_large", `checkpoint exceeds ${caps.max_checkpoint_bytes} bytes`);
  }
  // Per-upload key: re-uploading a path never touches the registered object before complete.
  const id = crypto.randomUUID();
  const key = `${runBase(run.project_id, run.id)}files/${input.kind}/${id}/${input.path}`;
  try {
    assertKey(key);
  } catch {
    throw new ApiError(400, "invalid_input", "path: invalid path");
  }

  const ttlSec = UPLOAD_TTL_MS[backend] / 1000;
  const ct = input.content_type;
  let upload: UploadInstructions;
  let s3UploadId: string | null = null;
  if (!storage.canPresign) {
    upload = { type: "single", method: "PUT", url: `/api/v1/uploads/${id}/body`, headers: { "Content-Type": ct } };
  } else if (input.size <= SINGLE_MAX) {
    upload = { type: "single", method: "PUT", url: await storage.presignPut(key, ttlSec), headers: { "Content-Type": ct } };
  } else {
    const n = Math.ceil(input.size / PART_SIZE);
    if (n > MAX_PARTS) throw new ApiError(413, "too_large", `file exceeds ${MAX_PARTS} parts of ${PART_SIZE} bytes`);
    s3UploadId = await storage.createMultipart(key, ct);
    const parts = await Promise.all(
      Array.from({ length: n }, async (_, i) => ({ n: i + 1, url: await storage.presignPart(key, s3UploadId!, i + 1, ttlSec) })),
    );
    upload = { type: "multipart", part_size: PART_SIZE, parts };
  }

  await c.env.DB.prepare(
    `INSERT INTO uploads (id, project_id, run_id, kind, path, size, content_type, storage_key, backend, s3_upload_id, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
  )
    .bind(id, run.project_id, run.id, input.kind, input.path, input.size, ct, key, backend, s3UploadId, Date.now())
    .run();
  return c.json({ id, upload }, 201);
});

// ---------- mounted at /uploads ----------
export const uploads = new Hono<AppEnv>();

/**
 * Worker upload target (fallback R2 only). No API key: the unguessable pending upload id is
 * the capability. Size is checked from Content-Length BEFORE the body is read; the stored
 * stream is fixed-length, so a lying Content-Length fails the put.
 */
uploads.put("/:id/body", async (c) => {
  const u = await c.env.DB.prepare(
    "SELECT * FROM uploads WHERE id = ? AND backend = 'r2' AND status = 'pending' AND run_id IS NOT NULL",
  )
    .bind(c.req.param("id"))
    .first<UploadRow>();
  if (!u) throw new ApiError(404, "not_found", "upload not found");
  if (expired(u)) throw new ApiError(410, "upload_expired", "upload expired");
  const len = Number(c.req.header("Content-Length") ?? NaN);
  if (!Number.isSafeInteger(len) || len < 0) throw new ApiError(400, "length_required", "Content-Length required");
  if (len > u.size) throw new ApiError(413, "too_large", `body exceeds declared size ${u.size}`);
  if (len !== u.size) throw new ApiError(400, "size_mismatch", `body is ${len} bytes, declared ${u.size}`);
  const { storage, backend } = await storageFor(c.env, u.project_id);
  if (backend !== "r2") throw new ApiError(409, "storage_changed", "project storage changed; create a new upload");
  try {
    await storage.put(u.storage_key, c.req.raw.body ?? new Uint8Array(0), {
      size: u.size,
      contentType: u.content_type ?? undefined,
    });
  } catch (e) {
    // Body ended before Content-Length bytes (FixedLengthStream) — a client error, not ours.
    // Anything else (storage, internal) → rethrow → 500 via onError.
    if (e instanceof Error && /connection lost|FixedLengthStream|expected length|fewer bytes/i.test(e.message)) {
      throw new ApiError(400, "body_incomplete", "request body shorter than Content-Length");
    }
    throw e;
  }
  return c.body(null, 204);
});

/** Registers the file. Fallback tier: then drops older checkpoints beyond keep_checkpoints. */
uploads.post("/:id/complete", apiKeyAuth, requireScope("write"), async (c) => {
  const { parts } = await body(c, UploadComplete);
  const db = c.env.DB;
  const u = await db.prepare("SELECT * FROM uploads WHERE id = ? AND project_id = ?")
    .bind(c.req.param("id"), c.get("project").id)
    .first<UploadRow>();
  if (!u) throw new ApiError(404, "not_found", "upload not found");
  if (u.status !== "pending") throw new ApiError(409, "upload_not_pending", `upload is ${u.status}`);
  if (u.run_id === null) throw new ApiError(404, "not_found", "run was deleted"); // cron aborts it
  if (expired(u)) throw new ApiError(410, "upload_expired", "upload expired");
  const { storage, backend, capabilities: caps } = await storageFor(c.env, u.project_id);
  if (backend !== u.backend) throw new ApiError(409, "storage_changed", "project storage changed; create a new upload");

  if (u.s3_upload_id) {
    if (!parts?.length) throw new ApiError(400, "invalid_input", "parts: required for multipart uploads");
    try {
      await storage.completeMultipart(u.storage_key, u.s3_upload_id, parts);
    } catch (e) {
      if (e instanceof StorageError && e.status < 500) throw new ApiError(400, "upload_incomplete", e.message);
      throw e;
    }
  }
  const head = await storage.head(u.storage_key);
  if (!head) throw new ApiError(400, "upload_incomplete", "no object uploaded");
  if (head.size !== u.size) throw new ApiError(400, "size_mismatch", `object is ${head.size} bytes, declared ${u.size}`);

  const fileId = crypto.randomUUID();
  const now = Date.now();
  // Claim + register atomically: a concurrent second complete inserts nothing.
  const [claim] = await db.batch([
    db.prepare("UPDATE uploads SET status = 'completed' WHERE id = ? AND status = 'pending'").bind(u.id),
    db
      .prepare(
        `INSERT INTO files (id, project_id, run_id, kind, path, size, content_type, storage_key, backend, created_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE changes() = 1`,
      )
      .bind(fileId, u.project_id, u.run_id, u.kind, u.path, u.size, u.content_type, u.storage_key, u.backend, now),
  ]);
  if (claim!.meta.changes !== 1) throw new ApiError(409, "upload_not_pending", "upload already completed");

  if (u.kind === "checkpoint" && caps.keep_checkpoints != null) {
    // Only after the new one is registered. Same tier only (quota is per backend).
    const { results: old } = await db
      .prepare(
        `SELECT id, storage_key FROM files WHERE project_id = ? AND kind = 'checkpoint' AND backend = ? AND id != ?
         ORDER BY created_at DESC LIMIT -1 OFFSET ?`,
      )
      .bind(u.project_id, backend, fileId, caps.keep_checkpoints - 1)
      .all<{ id: string; storage_key: string }>();
    if (old.length) {
      // Keys are per upload id now; this filter only matters for rows from legacy
      // (path-only) keys, where a re-upload of the same path shares the object.
      await storage.deleteMany([...new Set(old.map((f) => f.storage_key))].filter((k) => k !== u.storage_key));
      await db.batch(old.map((f) => db.prepare("DELETE FROM files WHERE id = ?").bind(f.id)));
    }
  }

  return c.json(
    {
      id: fileId,
      run_id: u.run_id,
      kind: u.kind,
      path: u.path,
      size: u.size,
      content_type: u.content_type,
      created_at: now,
    },
    201,
  );
});
