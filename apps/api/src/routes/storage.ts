import { Hono } from "hono";
import { S3Storage, StorageError, allowPrivateS3, encryptSecret, probe, type ProjectStorageRow } from "@kitelog/storage";
import { StorageConfigInput, type StorageConfig } from "@kitelog/shared";
import type { AppEnv } from "../env";
import { ApiError, body } from "../http";
import { requireMember } from "../middleware/member";
import { sessionAuth } from "../middleware/session";

// Mounted at /projects/:slug/storage. Owner only. The secret is never returned.
export const storage = new Hono<AppEnv>();
storage.use(sessionAuth, requireMember("owner"));

const out = (r: ProjectStorageRow): StorageConfig => ({
  endpoint: r.endpoint,
  region: r.region,
  bucket: r.bucket,
  prefix: r.prefix,
  access_key_prefix: r.access_key_id.slice(0, 4),
  path_style: r.path_style === 1,
  updated_at: r.updated_at,
});

/** put/get/delete probe against the submitted config; throws 400 `storage_probe_failed` with `step`. */
async function probeOrThrow(cfg: StorageConfigInput, env: AppEnv["Bindings"]) {
  let s3: S3Storage;
  try {
    s3 = new S3Storage({
      endpoint: cfg.endpoint,
      region: cfg.region,
      bucket: cfg.bucket,
      prefix: cfg.prefix,
      accessKeyId: cfg.access_key_id,
      secretAccessKey: cfg.secret_access_key,
      pathStyle: cfg.path_style,
      allowPrivate: allowPrivateS3(env), // https + public host unless ALLOW_PRIVATE_S3_ENDPOINTS
    });
  } catch (e) {
    if (e instanceof StorageError) throw new ApiError(400, e.code, e.message);
    throw e;
  }
  let result;
  try {
    result = await probe(s3);
  } catch (e) {
    result = { ok: false as const, step: "put" as const, error: e instanceof Error ? e.message : String(e) };
  }
  if (!result.ok) {
    throw new ApiError(400, "storage_probe_failed", `storage ${result.step} failed: ${result.error}`, { step: result.step });
  }
}

storage.get("/", async (c) => {
  const row = await c.env.DB.prepare("SELECT * FROM project_storage WHERE project_id = ?")
    .bind(c.get("project").id)
    .first<ProjectStorageRow>();
  return c.json(row ? out(row) : null);
});

storage.put("/", async (c) => {
  const cfg = await body(c, StorageConfigInput);
  await probeOrThrow(cfg, c.env);
  const row: ProjectStorageRow = {
    project_id: c.get("project").id,
    endpoint: cfg.endpoint,
    region: cfg.region,
    bucket: cfg.bucket,
    prefix: cfg.prefix,
    access_key_id: cfg.access_key_id,
    secret_enc: await encryptSecret(cfg.secret_access_key, c.env.STORAGE_ENC_KEY),
    path_style: cfg.path_style ? 1 : 0,
    updated_at: Date.now(),
  };
  // Existing data is not migrated (CLAUDE.md: storage decisions).
  await c.env.DB.prepare(
    `INSERT INTO project_storage (project_id, endpoint, region, bucket, prefix, access_key_id, secret_enc, path_style, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id) DO UPDATE SET endpoint = excluded.endpoint, region = excluded.region,
       bucket = excluded.bucket, prefix = excluded.prefix, access_key_id = excluded.access_key_id,
       secret_enc = excluded.secret_enc, path_style = excluded.path_style, updated_at = excluded.updated_at`,
  )
    .bind(row.project_id, row.endpoint, row.region, row.bucket, row.prefix, row.access_key_id, row.secret_enc, row.path_style, row.updated_at)
    .run();
  return c.json(out(row));
});

storage.delete("/", async (c) => {
  await c.env.DB.prepare("DELETE FROM project_storage WHERE project_id = ?").bind(c.get("project").id).run();
  return c.body(null, 204);
});

storage.post("/test", async (c) => {
  await probeOrThrow(await body(c, StorageConfigInput), c.env);
  return c.json({ ok: true });
});
