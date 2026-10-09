import { z, type ZodType } from "zod";
import {
  AdminUser,
  AdminUserCreated,
  ApiKey,
  ApiKeyCreated,
  AuthStatus,
  ErrorBody,
  FileInfo,
  Member,
  MetricsRead,
  PasswordResetCreated,
  PasswordResetLookup,
  Project,
  RunWithMetrics,
  StorageConfig,
  User,
  type AdminUserCreate,
  type AdminUserPatch,
  type ApiKeyCreate,
  type LoginInput,
  type MemberAdd,
  type PasswordChange,
  type PasswordResetInput,
  type ProjectCreate,
  type ProjectPatch,
  type Role,
  type SignupInput,
  type StorageConfigInput,
} from "@kitelog/shared";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** Extra fields of the error body, e.g. `step` on `storage_probe_failed`. */
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const BASE = "/api/v1";

async function req<T>(method: string, path: string, schema: ZodType<T> | null, body?: unknown): Promise<T> {
  const res = await fetch(BASE + path, {
    method,
    credentials: "include",
    headers: { Accept: "application/json", ...(body !== undefined && { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data: unknown = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    // Session expired mid-use: back to login, then return here.
    if (res.status === 401 && !path.startsWith("/auth/") && typeof location !== "undefined") {
      location.assign("/login?next=" + encodeURIComponent(location.pathname + location.search));
    }
    if (res.status === 429) throw new ApiError(429, "rate_limited", "Too many attempts, try again in a minute.");
    const e = ErrorBody.safeParse(data);
    if (e.success) {
      const raw = (data as { error: Record<string, unknown> }).error;
      throw new ApiError(res.status, e.data.error.code, e.data.error.message, raw);
    }
    throw new ApiError(res.status, "http_error", `request failed (${res.status})`);
  }
  return schema ? schema.parse(data) : (undefined as T);
}

const enc = encodeURIComponent;
const p = (slug: string) => `/projects/${enc(slug)}`;

export const api = {
  // auth
  me: () => req("GET", "/auth/me", User),
  authStatus: () => req("GET", "/auth/status", AuthStatus),
  login: (input: LoginInput) => req("POST", "/auth/login", User, input),
  signup: (input: SignupInput) => req("POST", "/auth/signup", User, input),
  logout: () => req("POST", "/auth/logout", null),
  /** Other sessions of the user are signed out. */
  changePassword: (input: PasswordChange) => req("POST", "/auth/password", null, input),
  resetLookup: (token: string) => req("POST", "/auth/reset/lookup", PasswordResetLookup, { token }),
  resetPassword: (input: PasswordResetInput) => req("POST", "/auth/reset", null, input),

  // admin
  users: () => req("GET", "/admin/users", z.array(AdminUser)),
  createUser: (input: AdminUserCreate) => req("POST", "/admin/users", AdminUserCreated, input),
  patchUser: (id: string, patch: AdminUserPatch) => req("PATCH", `/admin/users/${enc(id)}`, AdminUser, patch),
  deleteUser: (id: string) => req("DELETE", `/admin/users/${enc(id)}`, null),
  resetUser: (id: string) => req("POST", `/admin/users/${enc(id)}/reset`, PasswordResetCreated),

  // projects
  projects: () => req("GET", "/projects", z.array(Project)),
  project: (slug: string) => req("GET", p(slug), Project),
  createProject: (input: ProjectCreate) => req("POST", "/projects", Project, input),
  patchProject: (slug: string, patch: ProjectPatch) => req("PATCH", p(slug), Project, patch),
  deleteProject: (slug: string) => req("DELETE", p(slug), null),

  // members
  members: (slug: string) => req("GET", `${p(slug)}/members`, z.array(Member)),
  addMember: (slug: string, input: MemberAdd) => req("POST", `${p(slug)}/members`, Member, input),
  setRole: (slug: string, userId: string, role: Role) =>
    req("PATCH", `${p(slug)}/members/${enc(userId)}`, Member, { role }),
  removeMember: (slug: string, userId: string) => req("DELETE", `${p(slug)}/members/${enc(userId)}`, null),

  // api keys
  keys: (slug: string) => req("GET", `${p(slug)}/keys`, z.array(ApiKey)),
  createKey: (slug: string, input: ApiKeyCreate) => req("POST", `${p(slug)}/keys`, ApiKeyCreated, input),
  revokeKey: (slug: string, id: string) => req("DELETE", `${p(slug)}/keys/${enc(id)}`, null),

  // storage (owner)
  storage: (slug: string) => req("GET", `${p(slug)}/storage`, StorageConfig.nullable()),
  saveStorage: (slug: string, cfg: StorageConfigInput) => req("PUT", `${p(slug)}/storage`, StorageConfig, cfg),
  testStorage: (slug: string, cfg: StorageConfigInput) =>
    req("POST", `${p(slug)}/storage/test`, z.object({ ok: z.literal(true) }), cfg),
  removeStorage: (slug: string) => req("DELETE", `${p(slug)}/storage`, null),

  // runs
  /** Newest first. Next page: `before` = `runCursor(lastRunOfPreviousPage)`. */
  runs: (slug: string, q: { before?: string; limit?: number } = {}) => {
    const qs = new URLSearchParams();
    if (q.before) qs.set("before", q.before);
    if (q.limit) qs.set("limit", String(q.limit));
    return req("GET", `${p(slug)}/runs${qs.size ? `?${qs}` : ""}`, z.array(RunWithMetrics));
  },
  run: (slug: string, id: string) => req("GET", `${p(slug)}/runs/${enc(id)}`, RunWithMetrics),
  deleteRun: (slug: string, id: string) => req("DELETE", `${p(slug)}/runs/${enc(id)}`, null),
  runMetrics: (slug: string, id: string, keys: string[], points = 2000) =>
    req("GET", `${p(slug)}/runs/${enc(id)}/metrics?keys=${keys.map(enc).join(",")}&points=${points}`, MetricsRead),
  runFiles: (slug: string, id: string) => req("GET", `${p(slug)}/runs/${enc(id)}/files`, z.array(FileInfo)),
  fileDownloadUrl: (slug: string, fileId: string) => `${BASE}${p(slug)}/files/${enc(fileId)}/download`,
};

/** Pagination cursor for `api.runs`: `<created_at>:<id>` of the last run already loaded. */
export const runCursor = (r: { created_at: number; id: string }) => `${r.created_at}:${r.id}`;

/** Human-readable message for any thrown value. */
export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
