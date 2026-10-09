# kitelog

Lightweight, self-hostable experiment tracker in the style of wandb.
The server runs on Cloudflare (Workers + D1 + R2, or the project's own
S3-compatible store such as RustFS). A Python client (`pip install kitelog`) logs metrics,
config, and files from training scripts.

Repository: `github.com/kapong/kitelog`.

## Layout

pnpm workspaces monorepo. Apps deploy; packages are libraries; clients ship to users.

```
apps/
  api/                 Cloudflare Worker (Hono). REST API at /api/v1/*. Owns D1 + R2 bindings.
    src/
      index.ts         Hono app + `scheduled` handler (cron), mounts routes
      routes/          one file per resource: auth, admin, projects, members, keys, storage,
                       runs, metrics, uploads, files
      middleware/      session auth, api-key auth, role / scope checks
      cron.ts          mark stale runs `crashed`, compact stopped runs, abort expired uploads
    scripts/admin-reset-link.mjs  break-glass: SQL + link for a reset when no admin can log in
    wrangler.jsonc
  web/                 Cloudflare Worker: vinext (Next.js App Router on Vite) + Tailwind. UI only.
    app/               routes: (auth)/login, (auth)/reset, projects/[slug],
                       projects/[slug]/runs/[id], projects/[slug]/settings, admin
    components/        ui/ (primitives), charts/ (uPlot wrappers), runs/, projects/
    lib/api.ts         typed fetch wrapper for /api/v1
    wrangler.jsonc     service binding API -> apps/api; /api/* proxied (same origin, no CORS)
packages/
  shared/              API contract: zod schemas + inferred TS types. Used by api and web.
  db/                  D1 migrations (migrations/*.sql) + typed query functions.
  storage/             Storage interface + r2.ts + s3.ts (aws4fetch), presign, multipart.
  metrics/             Parquet write/read (hyparquet + hyparquet-writer, pure JS), downsampling.
  auth/                password hashing (PBKDF2), session tokens, api-key generate/hash.
clients/
  python/              pip package `kitelog`, src layout
    src/kitelog/  __init__.py (init/log/save/finish), run.py, sender.py, api.py, cli.py
    tests/
    pyproject.toml
```

Rules for code groups:
- `apps/*` never import from each other. Shared code goes into `packages/*`.
- `packages/*` stay framework-free (no Hono, no React) so both apps can use them.
- `web` never touches D1 or storage directly. It goes through the API.
- The Python client mirrors the API contract in `packages/shared`. Change both together.

## Decisions (settled — do not re-litigate)

### Accounts and auth
- Multi-user, multi-project. Public signup works only while there are no users (it creates
  the first admin); afterwards 403 `signup_closed`. No invites, no open signup.
- Users are created by an admin only (`POST /admin/users`): the account gets an unusable
  password (`"!"`, never a `pbkdf2$` hash) and the response carries a set-password link
  (`/reset#<token>`, 7 days; fragment, never a path). Admin can promote/demote/delete users; never yourself, never the
  last admin (409 `last_admin`), never a project's only owner (409 `last_owner`).
- Password reset (no email infra): admin creates a single-use link (`password_resets`, 24 h,
  SHA-256 hash stored; a new one deletes older unused ones). Using it sets the password and
  deletes ALL sessions of the user. Break-glass: `apps/api/scripts/admin-reset-link.mjs`.
- Password change (session): verify current, set new, delete all OTHER sessions.
- Rate limit: Workers Rate Limiting binding `AUTH_LIMITER` (10 / 60 s) on login, signup,
  password change, reset; key `${CF-Connecting-IP}:${lowercased email}` (reset: `ip:reset`).
  Over → 429 `rate_limited` + `Retry-After: 60`. Binding absent → no limit.
- Email + password (PBKDF2 via WebCrypto). Session = random token in an HttpOnly cookie,
  hash stored in D1.
- Project members have roles `owner | editor | viewer`.
- API keys are scoped to ONE project. Format `kl_<random>`. Store only the SHA-256 hash and a
  short prefix for display. Scope: `write` (log runs) or `read`.
- The Python client authenticates with `Authorization: Bearer kl_...` only.

### Storage (per project, server-side concern only)
Two tiers. The client never learns which tier, backend, or S3 details a project uses.
- **Own S3** (project has S3 config): any S3-compatible endpoint (AWS, RustFS, MinIO, R2 S3 API),
  signed with `aws4fetch`. Everything allowed: metrics, checkpoints, artifacts. No quota.
- **Fallback R2** (no S3 config): our R2 binding, limited tier.
  - Numeric metrics only. Non-numeric values rejected.
  - Checkpoints only, max 100 MB per project, keep only the latest (one per project, newest
    wins). Delete the old object + row only after the new upload completes.
  - Other file kinds rejected with 403 `storage_tier_limit`.
- Limits live in Worker vars (`FALLBACK_MAX_CHECKPOINT_MB=100`), not code.
- S3 secret keys encrypted at rest in D1 (AES-GCM, key from Worker secret `STORAGE_ENC_KEY`).
  Never returned to the UI; show only endpoint, bucket, and access-key prefix.
- S3 endpoint must be `https://` with a public hostname (Workers cannot reach private networks;
  expose home/LAN RustFS/MinIO via e.g. Cloudflare Tunnel). Worker var `ALLOW_PRIVATE_S3_ENDPOINTS=1`
  (local dev only, never in prod) allows `http://` and private hosts. `POST .../storage/test`
  does a put/get/delete probe before saving.
- Changing or removing S3 config does not migrate existing data.

### Uploads (files)
- Two-step: `POST /uploads` returns upload instructions; client PUTs bytes; `POST .../complete`.
- Own S3: instructions are presigned URLs (multipart for large files). Bytes go straight to S3.
- Fallback R2: instructions point at a Worker URL (R2 binding cannot presign). Size checked
  from the declared size and `Content-Length` before reading the body (413 if over).
- Client just follows instructions; it does not know which case it is.
- Worker upload URL auth: the upload `id` (random UUID) is the capability. Single-use
  (`status = pending`), expires 1 h after creation. No API key is sent to `/uploads/:id/body`.
  Own-S3 presigned / multipart uploads expire after 24 h (large files). Cron aborts expired ones.

### Metrics (object storage, not D1)
- Metrics live in the project's storage as **Parquet**, written in the Worker with
  `hyparquet-writer` and read with `hyparquet` (pure JS, no WASM; check bundle size).
- **No Durable Objects** (cost: DO duration + SQLite rows written grow per running run).
  The client process is the buffer; the Worker is stateless.
- **Writers**: a run can have many writers (distributed ranks). Each writer has a `writer_id`
  (default: rank from `RANK` env, else 0) and its own increasing `seq`.
- **Flush** (client, about every 15 s): `POST .../metrics {writer_id, seq, points}` becomes ONE
  Parquet segment object (all keys, long format). The object name comes from `(writer_id, seq)`,
  so a retried flush overwrites the same object (idempotent). Server accepts `seq == last_seq`
  (retry) and rejects `seq < last_seq` with 409 whose error body carries `last_seq`.
- `POST /runs` (create or `resume`) takes `writer_id` and returns that writer's `last_seq`
  (-1 if new). The client continues from `last_seq + 1`, so a resumed writer never overwrites.
- Metric keys: 1–256 chars, no `,`, whitespace, or control chars (`,` separates keys in reads).
- **Compaction** (immutable chunks; memory bounded forever): writer 0 calls
  `POST .../metrics/compact` every 20 of its segments and on `finish()`. Compaction runs in
  writer 0's sender thread, so it never overlaps its own writes. It merges ONLY pending
  segments (all writers, up to a snapshot of committed seqs, capped at `MAX_COMPACT_ROWS`
  = 200k rows per chunk; at most 3 chunks per call, response `more: true` → call again) into a
  new immutable `chunk-{n:06}-{8 hex}.parquet` (random suffix: concurrent compactions never
  overwrite each other; overlaps dedupe at read), sorted
  `(key, step, writer_id)` and deduped within, then deletes those segments. Old chunks are
  never rewritten.
- Same `(key, step)` twice (two writers, or across chunks): keep the latest `ts`, resolved at
  read time.
- Object layout: `{prefix}/p/{project_id}/r/{run_id}/metrics/`
  `seg-{writer_id}-{seq:06}.parquet` and `chunk-{n:06}-{8 hex}.parquet` (legacy: no suffix). Columns: `key` string,
  `step` int64, `value` float64, `ts` int64 (ms), `writer_id` int32. Sorted by key, row groups
  of 10k rows with stats, so reads skip other keys.
- Reads: range GETs (Parquet footer + only row groups whose key stats match), fold each file
  straight into per-key column arrays, downsample per file then once more after concatenation
  (about 2000 points per series). Memory is O(row group + files × points), not O(series).
  Dashboard polls every 15 s for running runs.
- Known ceiling: about 400 files per read (≈ 80M rows per run). Tiered re-compaction of chunks is future work.
  Over 200 pending segments → 413 `too_many_files` (compact first); over 400 files → 413 `run_too_large`.
- Measured: about 17 bytes per row in Parquet; Worker heap ceiling about 300k rows per request.
  **Workers Paid plan recommended**: Free plan's 10 ms CPU and 50 subrequests per request are
  too small for compaction and reads of long runs.
- **Crash detection**: Cron Trigger every 5 min marks runs `crashed` when writer 0's heartbeat
  is stale. Heartbeat rides on metric flushes (no extra requests); an idle client sends a bare
  heartbeat every 60 s. Runs no longer `running` with uncompacted
  segments (crashed, or finish() compaction cut short) are compacted by the same cron (4 runs per tick).
- D1 keeps only metadata: metric keys per run with last step and last value (for run tables
  and summary).

## Data model (D1)

```
users(id, email UNIQUE, password_hash, name, is_admin, created_at)
sessions(id, user_id, token_hash, expires_at)
password_resets(id, user_id, token_hash UNIQUE, created_by, expires_at, used_at, created_at)
                                                              -- created_by NULL: break-glass
projects(id, slug UNIQUE, name, description, created_at)
project_storage(project_id PK, endpoint, region, bucket, prefix, access_key_id,
                secret_enc, path_style, updated_at)          -- row exists = own S3 tier
project_members(project_id, user_id, role, PRIMARY KEY(project_id, user_id))
api_keys(id, project_id, name, prefix, key_hash UNIQUE, scope, created_by, created_at,
         last_used_at, revoked_at)
runs(id, project_id, name, status, config JSON, summary JSON, tags JSON,
     created_at, updated_at, finished_at, heartbeat_at)
run_writers(run_id, writer_id, last_seq, compacted_seq, heartbeat_at,
            PRIMARY KEY(run_id, writer_id))
run_metric_keys(run_id, key, last_step, last_value, PRIMARY KEY(run_id, key))
files(id, project_id, run_id, kind, path, size, content_type, storage_key, backend, created_at)
                                                              -- kind: checkpoint | artifact
uploads(id, project_id, run_id, kind, path, size, storage_key, backend, s3_upload_id,
        status, created_at)                                   -- pending multipart / worker uploads
```

`status`: `running | finished | failed | crashed`.

## API (v1)

Client (API key):
- `GET /api/v1/project` — key's project + capabilities only, e.g.
  `{"can_save": {"checkpoint": true, "artifact": false}, "max_checkpoint_bytes": 104857600,
  "keep_checkpoints": 1, "metric_types": ["number"]}`.
- `POST /api/v1/runs` — create run `{name?, config?, tags?}` → `{id}`; `resume` by id supported.
- `PATCH /api/v1/runs/:id` — update config / summary / status / heartbeat
- `POST /api/v1/runs/:id/metrics` — `{writer_id, seq, points: [{key, step, value, ts}]}`
  → one Parquet segment; also updates heartbeat and `run_metric_keys`
- `POST /api/v1/runs/:id/metrics/compact` — called by writer 0 (not enforced)
- `POST /api/v1/runs/:id/heartbeat` — `{writer_id}` (idle clients only)
- `POST /api/v1/runs/:id/uploads` — `{path, kind, size, content_type}` → upload instructions
- `PUT  /api/v1/uploads/:id/body` — Worker upload target (fallback tier only)
- `POST /api/v1/uploads/:id/complete` — `{parts?: [{n, etag}]}` → registers file

Auth (public unless noted):
- `GET /api/v1/auth/status` → `{needs_setup}`; `POST /auth/signup` (first admin only),
  `POST /auth/login`, `POST /auth/logout`, `GET /auth/me` (session)
- `POST /api/v1/auth/password` (session) — `{current_password, new_password}` → 204
- `POST /api/v1/auth/reset/lookup` — `{token}` → `{email, expires_at}` or 404 `invalid_reset` (rate-limited)
- `POST /api/v1/auth/reset` — `{token, new_password}` → 204 (single-use)

Admin (session, admin): `GET /api/v1/admin/users`; `POST /admin/users {email, name?, is_admin?}`
→ `{user, reset: {token, expires_at}}`; `PATCH /admin/users/:id {is_admin?}`;
`DELETE /admin/users/:id`; `POST /admin/users/:id/reset` → `{token, expires_at}`.

Dashboard (session cookie): projects CRUD, members,
API keys, storage config (`PUT/DELETE /api/v1/projects/:slug/storage`, `POST .../storage/test`;
owner only), list runs, read metrics (`GET /api/v1/runs/:id/metrics?keys=a,b&points=2000`),
download files (presigned GET or Worker stream).

## Python client

```python
import kitelog as kl

run = kl.init(project="my-proj", name="exp-1", config={"lr": 1e-3})   # resume="<run_id>" optional
for step in range(100):
    kl.log({"loss": loss, "acc": acc}, step=step)
kl.save_checkpoint("model.pt")
kl.save("preds.parquet")         # artifact
kl.finish()
```

- Config from env: `KITELOG_API_KEY`, `KITELOG_BASE_URL`; or `kitelog login` writes `~/.kitelog/config`.
- `init()` fetches capabilities. The client knows only what it can save, never where.
  Disallowed values or files are skipped with ONE warning each. Server enforces the same rules.
- `log()` is non-blocking: queue + one background sender thread flushes every ~15 s or
  5000 points, and asks for compaction (writer 0) every 20 segments. Buffer capped at 1M
  points (oldest batch dropped with a warning).
- `finish()` has a 30 s total deadline; unsent points are reported, never block exit longer.
- 401/403 disables the run after one warning (except 403 `storage_tier_limit`: skip that file).
- Distributed: every rank calls `init(run_id=...)` (default env `KITELOG_RUN_ID`) with the same
  user-chosen id (`^[A-Za-z0-9_-]{1,64}$`); `POST /runs {resume}` creates it if missing (201) or joins (200),
  race-safe, 404 if another project owns it. `writer_id` defaults to `RANK`.
  Only writer 0's `finish()` compacts and closes the run; other writers just flush.
- `atexit` flushes and sets status; uncaught exception sets `failed`.
- Network errors retry with backoff; never crash the training script.
- Stdlib only (`urllib`, `threading`, `json`). Packaging via `pyproject.toml` (hatchling).
- Before publishing: check the `kitelog` name is free on PyPI.

## Commands

```bash
pnpm install
pnpm --filter api db:migrate:local      # apply D1 migrations locally
pnpm dev                                # api + web together
pnpm test                               # all TS packages
pnpm --filter api deploy && pnpm --filter web deploy
cd clients/python && pip install -e '.[dev]' && pytest
```

## Conventions

- Minimal code. No abstraction with one implementation (storage has two backends, so it gets one).
- Validate all input at API boundaries. Check project membership / key scope on every route.
- Never log or return raw API keys or S3 secrets after creation.
- Code, comments, commits in English.
- Each non-trivial module leaves one runnable check (small test or selftest).

## Out of scope (add when needed)

Sweeps, reports, artifact versioning, media panels (images/audio), system metrics (GPU/CPU),
offline mode, live WebSocket chart updates (polling is enough), fallback-tier metric quota,
client-side Parquet writing (needs pyarrow; breaks stdlib-only client).
