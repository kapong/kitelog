import type { Capabilities } from "@kitelog/shared";
import { decryptSecret } from "./crypto";
import { R2Storage } from "./r2";
import { S3Storage } from "./s3";
import type { Storage } from "./types";

/** Row of `project_storage` (migrations/0001_init.sql). */
export interface ProjectStorageRow {
  project_id: string;
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  access_key_id: string;
  secret_enc: string;
  path_style: number; // 0 | 1
  updated_at: number;
}

export interface StorageEnv {
  BUCKET: R2Bucket;
  STORAGE_ENC_KEY: string;
  FALLBACK_MAX_CHECKPOINT_MB?: string;
}

export interface ResolvedStorage {
  storage: Storage;
  backend: "r2" | "s3";
  capabilities: Capabilities;
}

const DEFAULT_FALLBACK_MB = 100;

export function fallbackCapabilities(maxMb?: string): Capabilities {
  const n = Number(maxMb);
  const mb = Number.isFinite(n) && n > 0 ? n : DEFAULT_FALLBACK_MB;
  return {
    can_save: { checkpoint: true, artifact: false },
    max_checkpoint_bytes: Math.floor(mb * 1024 * 1024),
    keep_checkpoints: 1,
    metric_types: ["number"],
  };
}

export const OWN_S3_CAPABILITIES: Capabilities = {
  can_save: { checkpoint: true, artifact: true },
  max_checkpoint_bytes: null,
  keep_checkpoints: null,
  metric_types: ["number"], // shared schema only knows "number" today
};

export async function resolveStorage(
  row: ProjectStorageRow | null,
  env: StorageEnv,
  fetchImpl?: (req: Request) => Promise<Response>,
): Promise<ResolvedStorage> {
  if (!row) {
    return { storage: new R2Storage(env.BUCKET), backend: "r2", capabilities: fallbackCapabilities(env.FALLBACK_MAX_CHECKPOINT_MB) };
  }
  const storage = new S3Storage(
    {
      endpoint: row.endpoint,
      region: row.region,
      bucket: row.bucket,
      prefix: row.prefix,
      accessKeyId: row.access_key_id,
      secretAccessKey: await decryptSecret(row.secret_enc, env.STORAGE_ENC_KEY),
      pathStyle: row.path_style === 1,
    },
    fetchImpl,
  );
  return { storage, backend: "s3", capabilities: OWN_S3_CAPABILITIES };
}
