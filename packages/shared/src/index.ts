import { z } from "zod";

// ---- enums ----
export const Role = z.enum(["owner", "editor", "viewer"]);
export const Scope = z.enum(["write", "read"]);
export const RunStatus = z.enum(["running", "finished", "failed", "crashed"]);
export const FileKind = z.enum(["checkpoint", "artifact"]);
export type Role = z.infer<typeof Role>;
export type Scope = z.infer<typeof Scope>;
export type RunStatus = z.infer<typeof RunStatus>;
export type FileKind = z.infer<typeof FileKind>;

// ---- primitives ----
const Id = z.string().min(1).max(64);
const Ms = z.number().int().nonnegative();
const Email = z.string().trim().toLowerCase().max(254).pipe(z.email());
const Password = z.string().min(8).max(256);
const Slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
export const MAX_JSON_CHARS = 256_000;
const Json = z.record(z.string(), z.unknown()).refine((v) => {
  try {
    return JSON.stringify(v).length <= MAX_JSON_CHARS;
  } catch {
    return false; // cycles / BigInt are not JSON
  }
}, `JSON larger than ${MAX_JSON_CHARS} chars`);
const Int32 = z.number().int().min(0).max(2 ** 31 - 1);

// ---- errors ----
export const ErrorBody = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    last_seq: z.number().int().optional(), // set on 409 `seq_conflict`
  }),
});
export type ErrorBody = z.infer<typeof ErrorBody>;

// ---- auth ----
export const SignupInput = z.object({
  email: Email,
  password: Password,
  name: z.string().max(128).optional(),
  invite_token: z.string().max(256).optional(), // required unless first user or open signup
});
export const LoginInput = z.object({ email: Email, password: Password });
export const User = z.object({
  id: Id,
  email: z.string(),
  name: z.string().nullable(),
  is_admin: z.boolean(),
  created_at: Ms,
});
export type SignupInput = z.infer<typeof SignupInput>;
export type LoginInput = z.infer<typeof LoginInput>;
export type User = z.infer<typeof User>;

// ---- invites (admin) ----
export const InviteCreate = z.object({ email: Email });
export const Invite = z.object({
  id: Id,
  email: z.string(),
  expires_at: Ms,
  used_at: Ms.nullable(),
});
// Raw token returned once, on creation only.
export const InviteCreated = Invite.extend({ token: z.string() });
// Public lookup for the invite page (GET /auth/invite/:token).
export const InviteLookup = Invite.pick({ email: true, expires_at: true });
export type InviteLookup = z.infer<typeof InviteLookup>;
export type InviteCreate = z.infer<typeof InviteCreate>;
export type Invite = z.infer<typeof Invite>;
export type InviteCreated = z.infer<typeof InviteCreated>;

// ---- settings (admin) ----
export const Settings = z.object({ open_signup: z.boolean() });
export const SettingsPatch = Settings.partial();
export type Settings = z.infer<typeof Settings>;
export type SettingsPatch = z.infer<typeof SettingsPatch>;

// ---- projects ----
export const ProjectCreate = z.object({
  slug: Slug,
  name: z.string().min(1).max(128),
  description: z.string().max(2000).optional(),
});
export const ProjectPatch = ProjectCreate.omit({ slug: true }).partial();
export const Project = z.object({
  id: Id,
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  created_at: Ms,
  role: Role.optional(), // caller's role; only on GET /projects/:slug
});
export type ProjectCreate = z.infer<typeof ProjectCreate>;
export type ProjectPatch = z.infer<typeof ProjectPatch>;
export type Project = z.infer<typeof Project>;

// ---- members ----
export const MemberAdd = z.object({ email: Email, role: Role });
export const MemberPatch = z.object({ role: Role });
export const Member = z.object({ user_id: Id, email: z.string(), name: z.string().nullable(), role: Role });
export type MemberAdd = z.infer<typeof MemberAdd>;
export type MemberPatch = z.infer<typeof MemberPatch>;
export type Member = z.infer<typeof Member>;

// ---- api keys ----
export const ApiKeyCreate = z.object({ name: z.string().min(1).max(128), scope: Scope });
export const ApiKey = z.object({
  id: Id,
  name: z.string(),
  prefix: z.string(),
  scope: Scope,
  created_at: Ms,
  last_used_at: Ms.nullable(),
  revoked_at: Ms.nullable(),
});
// Raw `kl_...` key returned once, on creation only.
export const ApiKeyCreated = ApiKey.extend({ key: z.string().startsWith("kl_") });
export type ApiKeyCreate = z.infer<typeof ApiKeyCreate>;
export type ApiKey = z.infer<typeof ApiKey>;
export type ApiKeyCreated = z.infer<typeof ApiKeyCreated>;

// ---- storage config (owner only) ----
export const StorageConfigInput = z.object({
  // http(s); no userinfo, query, or fragment (credentials go in their own fields). The API
  // requires https + a public host unless ALLOW_PRIVATE_S3_ENDPOINTS is set (S3Storage).
  // (String check: shared is env-agnostic, no DOM/Workers `URL` type.)
  endpoint: z
    .url({ protocol: /^https?$/ })
    .regex(/^https?:\/\/[^/@?#\\]+(\/[^?#]*)?$/i, "endpoint must not contain credentials, query, or fragment"),
  region: z.string().min(1).max(64).default("auto"),
  bucket: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/),
  prefix: z.string().max(512).default(""),
  access_key_id: z.string().min(1).max(256),
  secret_access_key: z.string().min(1).max(512),
  path_style: z.boolean().default(false),
});
// Output never includes the secret; access key shown only as a prefix.
export const StorageConfig = z.object({
  endpoint: z.string(),
  region: z.string(),
  bucket: z.string(),
  prefix: z.string(),
  access_key_prefix: z.string(),
  path_style: z.boolean(),
  updated_at: Ms,
});
export type StorageConfigInput = z.infer<typeof StorageConfigInput>;
export type StorageConfig = z.infer<typeof StorageConfig>;

// ---- client: capabilities (GET /api/v1/project) ----
export const Capabilities = z.object({
  can_save: z.object({ checkpoint: z.boolean(), artifact: z.boolean() }),
  max_checkpoint_bytes: z.number().int().positive().nullable(), // null = no limit
  keep_checkpoints: z.number().int().positive().nullable(), // null = keep all
  metric_types: z.array(z.literal("number")),
});
export const ProjectInfo = z.object({ project: Project, capabilities: Capabilities });
export type Capabilities = z.infer<typeof Capabilities>;
export type ProjectInfo = z.infer<typeof ProjectInfo>;

// ---- runs ----
export const RUN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const RunId = z.string().regex(RUN_ID_RE, "run id: 1-64 chars of A-Z a-z 0-9 _ -");
const Tags = z.array(z.string().min(1).max(64)).max(100);
export const RunCreate = z.object({
  name: z.string().min(1).max(128).optional(),
  config: Json.optional(),
  tags: Tags.optional(),
  // Run id to join: resumes that run, or creates it with this id if it does not exist yet, so
  // distributed ranks can all join one run by a user-chosen id. Server ids (UUIDs) match too.
  resume: RunId.optional(),
  writer_id: Int32.default(0),
});
// last_seq: this writer's last committed seq (-1 if none). Client continues from last_seq + 1.
export const RunCreated = z.object({ id: Id, last_seq: z.number().int().min(-1) });
export const RunPatch = z.object({
  config: Json.optional(),
  summary: Json.optional(),
  tags: Tags.optional(),
  status: RunStatus.exclude(["crashed"]).optional(), // crashed is set only by cron
});
export const Run = z.object({
  id: Id,
  name: z.string(),
  status: RunStatus,
  config: Json,
  summary: Json,
  tags: z.array(z.string()),
  created_at: Ms,
  updated_at: Ms,
  finished_at: Ms.nullable(),
  heartbeat_at: Ms.nullable(),
});
// Dashboard run list / detail: the run plus each metric key's last (max-step) point.
export const RunWithMetrics = Run.extend({
  metrics: z.record(z.string(), z.object({ step: z.number().int(), value: z.number().nullable() })),
});
export type RunWithMetrics = z.infer<typeof RunWithMetrics>;
export type RunCreate = z.infer<typeof RunCreate>;
export type RunCreated = z.infer<typeof RunCreated>;
export type RunPatch = z.infer<typeof RunPatch>;
export type Run = z.infer<typeof Run>;

// ---- metrics ----
export const MAX_POINTS_PER_FLUSH = 10_000;
// 1–256 chars, no `,` (separates keys in reads), whitespace, or control chars.
export const MetricKey = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[^,\s\x00-\x1f\x7f]+$/);
export const MetricPoint = z.object({
  key: MetricKey,
  step: z.number().int().nonnegative(), // zod 4 .int() = safe integer
  value: z.number(), // zod rejects NaN / ±Infinity
  ts: Ms,
});
// One flush = one Parquet segment named by (writer_id, seq). Server semantics vs the
// writer's committed last_seq: seq > last_seq → write and commit; seq == last_seq →
// accepted (idempotent retry, overwrites the same object); seq < last_seq → 409
// `seq_conflict` with `error.last_seq`.
export const MetricsFlush = z.object({
  writer_id: Int32,
  seq: z.number().int().nonnegative(),
  points: z.array(MetricPoint).max(MAX_POINTS_PER_FLUSH),
});
export const Heartbeat = z.object({ writer_id: Int32 });
export const MetricsQuery = z.object({
  keys: z
    .string()
    .transform((s) => s.split(",").filter(Boolean))
    .pipe(z.array(MetricKey).min(1).max(100)),
  points: z.coerce.number().int().min(10).max(10_000).default(2000),
});
// Compaction does at most a few batches per call; `more: true` → call again.
export const CompactResult = z.object({ chunks: z.number().int(), segments: z.number().int(), more: z.boolean() });
// Public: drives the signup page.
export const AuthStatus = z.object({ needs_setup: z.boolean(), open_signup: z.boolean() });
// Columnar series per key, downsampled server-side.
export const MetricsRead = z.object({
  series: z.record(MetricKey, z.object({ step: z.array(z.number()), value: z.array(z.number()) })),
});
export type MetricPoint = z.infer<typeof MetricPoint>;
export type MetricsFlush = z.infer<typeof MetricsFlush>;
export type Heartbeat = z.infer<typeof Heartbeat>;
export type MetricsQuery = z.infer<typeof MetricsQuery>;
export type MetricsRead = z.infer<typeof MetricsRead>;
export type CompactResult = z.infer<typeof CompactResult>;
export type AuthStatus = z.infer<typeof AuthStatus>;

// ---- uploads / files ----
export const UploadCreate = z.object({
  path: z
    .string()
    .min(1)
    .max(1024)
    // Relative, "/"-separated; every segment non-empty and not "." / "..";
    // no backslashes or control chars.
    .refine(
      (p) =>
        !/[\\\x00-\x1f\x7f]/.test(p) &&
        p.split("/").every((seg) => seg !== "" && seg !== "." && seg !== ".."),
      "invalid path",
    ),
  kind: FileKind,
  size: z.number().int().nonnegative(),
  content_type: z.string().max(256).default("application/octet-stream"),
});
// Own S3: presigned URLs. Fallback R2: a Worker URL (`/uploads/:id/body`) authorized by the
// unguessable single-use upload id (expires 1 h after creation); the client never sends its
// API key there.
export const UploadInstructions = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("single"),
    url: z.string(),
    method: z.literal("PUT"),
    headers: z.record(z.string(), z.string()),
  }),
  z.object({
    type: z.literal("multipart"),
    part_size: z.number().int().positive(),
    parts: z.array(z.object({ n: z.number().int().positive(), url: z.string() })),
  }),
]);
export const UploadCreated = z.object({ id: Id, upload: UploadInstructions });
export const UploadComplete = z.object({
  parts: z.array(z.object({ n: z.number().int().positive(), etag: z.string().min(1) })).optional(),
});
export const FileInfo = z.object({
  id: Id,
  run_id: Id.nullable(),
  kind: FileKind,
  path: z.string(),
  size: z.number().int(),
  content_type: z.string().nullable(),
  created_at: Ms,
});
export type UploadCreate = z.infer<typeof UploadCreate>;
export type UploadInstructions = z.infer<typeof UploadInstructions>;
export type UploadCreated = z.infer<typeof UploadCreated>;
export type UploadComplete = z.infer<typeof UploadComplete>;
export type FileInfo = z.infer<typeof FileInfo>;
