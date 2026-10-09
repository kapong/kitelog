import type { Role, Scope } from "@kitelog/shared";

export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  STORAGE_ENC_KEY: string;
  FALLBACK_MAX_CHECKPOINT_MB: string;
  /** "1" | "true": allow http:// and private-host S3 endpoints. Local dev only; never in prod. */
  ALLOW_PRIVATE_S3_ENDPOINTS?: string;
  /** Rate Limiting binding for login / signup / password endpoints. Absent → no limit. */
  AUTH_LIMITER?: RateLimit;
}

export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  name: string | null;
  is_admin: number;
  created_at: number;
}

export interface ProjectRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  created_at: number;
}

export type AppEnv = {
  Bindings: Env;
  Variables: {
    user: UserRow; // session auth
    sessionHash: string;
    project: ProjectRow; // requireMember or api-key auth
    role: Role; // requireMember
    keyScope: Scope; // api-key auth
  };
};
