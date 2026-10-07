# kitelog

kitelog is a small, self-hosted experiment tracker in the style of Weights & Biases. The server runs on Cloudflare (Workers, D1, and R2 or your own S3-compatible storage). A stdlib-only Python client logs metrics, config, checkpoints, and files from your training scripts.

## Features

- Projects, each with its own members, API keys, and storage settings.
- Multi-user with roles (owner, editor, viewer). The first user to sign up becomes admin; after that, signup is invite-only (an admin can enable open signup).
- Project-scoped API keys (`kl_...`) with `write` or `read` scope.
- Metrics charts per run, and compare runs side by side. Run tables show the last value of each metric.
- Checkpoints and artifacts (files) attached to runs.
- Two storage tiers per project: a limited built-in R2 tier, or your own S3-compatible bucket with no limits (see [Storage tiers](#storage-tiers)).
- Crash detection: runs whose client stops sending heartbeats are marked `crashed`.

## Architecture

- `apps/api`: Cloudflare Worker (Hono) serving the REST API at `/api/v1/*`. Owns the D1 and R2 bindings. Stateless, no Durable Objects.
- `apps/web`: Cloudflare Worker (vinext, Next.js App Router on Vite, Tailwind, uPlot charts). UI only. It reaches the API Worker through a service binding and proxies `/api/*`, so the browser sees one origin and there is no CORS.
- D1 holds metadata only: users, projects, runs, API keys, file records, and the last value per metric key.
- Metrics are stored as Parquet segments in the project's object storage (R2 or your S3), not in D1.
- The Python client buffers points in memory and flushes about every 15 seconds (or 5000 points). Each flush becomes one Parquet segment; writer 0 periodically asks the server to compact segments into larger chunks.
- A cron trigger (every 5 minutes) marks runs with stale heartbeats as `crashed`, compacts leftover segments of finished or crashed runs, and aborts expired uploads.

Monorepo layout (pnpm workspaces):

```
apps/api         API Worker
apps/web         Web UI Worker
packages/shared  API contract (zod schemas, types)
packages/db      D1 migrations and queries
packages/storage R2 and S3 backends, presigning, multipart
packages/metrics Parquet read/write, downsampling
packages/auth    password hashing, sessions, API key helpers
clients/python   the `kitelog` pip package
```

## Requirements

- A Cloudflare account. The **Workers Paid plan is recommended**: the Free plan's 10 ms CPU time and 50 subrequests per request are too small for compaction and for reading long runs.
- Node.js and pnpm 12.9.1 (pinned in `package.json`). Run `corepack enable`, or prefix commands with `npx pnpm@12.9.1`.
- Python 3.9 or newer for the client (no third-party dependencies).

## Local development

```bash
pnpm install

# Encryption key for S3 secrets stored in D1
cp apps/api/.dev.vars.example apps/api/.dev.vars
# edit apps/api/.dev.vars and set STORAGE_ENC_KEY to the output of:
openssl rand -base64 32

pnpm --filter api db:migrate:local   # create the local D1 schema
pnpm dev                             # runs api and web together
```

Open the web URL printed by `pnpm dev` (the Vite dev server, usually http://localhost:5173). Sign up: the first user becomes admin. Then create a project and an API key.

Tests: `pnpm test` (all TypeScript packages, including the web tests, plus the API Worker tests) and `cd clients/python && pip install -e ".[dev]" && pytest`.

Cron does not fire on its own under `wrangler dev`. Trigger one tick (crash detection, compaction, upload cleanup) with:

```bash
curl "http://localhost:8787/cdn-cgi/local/scheduled?cron=*/5+*+*+*+*"
```

`pnpm dev` keeps the other server running if one of them exits.

## Deploy

Run these from the repo root. Use `wrangler` via `pnpm --filter api exec wrangler ...`.

1. Create the D1 database and put the printed `database_id` in `apps/api/wrangler.jsonc`:
   ```bash
   pnpm --filter api exec wrangler d1 create kitelog
   ```
2. Create the R2 bucket used by the built-in tier (name must match `r2_buckets` in `apps/api/wrangler.jsonc`):
   ```bash
   pnpm --filter api exec wrangler r2 bucket create kitelog
   ```
3. Set the encryption secret (use a key from `openssl rand -base64 32` and keep it safe; losing it makes stored S3 secrets unreadable):
   ```bash
   pnpm --filter api exec wrangler secret put STORAGE_ENC_KEY
   ```
   If the secret is set before the first deploy and wrangler asks to create the Worker, accept.
4. Apply migrations to the remote database:
   ```bash
   pnpm --filter api exec wrangler d1 migrations apply kitelog --remote
   ```
5. Deploy the API first, then the web Worker (the web Worker binds to `kitelog-api`):
   ```bash
   pnpm --filter api deploy
   pnpm --filter web deploy
   ```
6. Optional: add a custom domain to the `kitelog-web` Worker in the Cloudflare dashboard (Workers & Pages, kitelog-web, Settings, Domains & Routes). Use that URL as the client's base URL. The API Worker does not need a public route.

Open the web URL, sign up (first user is admin), create a project and an API key.

## Using the Python client

Install (PyPI once published; from git until then):

```bash
pip install kitelog
pip install "git+https://github.com/kapong/kitelog.git#subdirectory=clients/python"
```

Credentials come from the environment, or from `kitelog login`, which saves them to `~/.kitelog/config` (mode 0600). Environment variables win.

```bash
export KITELOG_BASE_URL=https://kitelog.example.com
export KITELOG_API_KEY=kl_...
# or:
kitelog login
```

```python
import kitelog as kl

kl.init(project="my-proj", name="exp-1", config={"lr": 1e-3}, tags=["baseline"])
for step in range(100):
    kl.log({"loss": loss, "acc": acc}, step=step)
kl.save_checkpoint("model.pt")     # checkpoint
kl.save("preds.parquet")           # artifact (needs your own S3)
kl.summary({"best_acc": 0.93})     # sent when the run finishes
kl.finish()
```

An API key belongs to exactly one project; `project=` is only checked against it. `log()` never blocks on the network. `finish()` is also called automatically at exit; an uncaught exception marks the run `failed`.

**Distributed training.** Pick a run id (1 to 64 characters of `A-Z a-z 0-9 _ -`) and give the same one to every rank, either as `kl.init(project="my-proj", run_id="exp-42")` or by setting `KITELOG_RUN_ID` in the launcher (the client reads it when `run_id` is not passed). The first rank to arrive creates the run under that id; the others join it. No coordination between ranks is needed. Each rank is a separate writer, identified by the `RANK` environment variable (default 0). Only rank 0's `finish()` compacts metrics and closes the run.

```bash
KITELOG_RUN_ID=exp-42 torchrun --nproc_per_node=4 train.py   # train.py calls kl.init(project="my-proj")
```

Use a new id for each new run: reusing an id joins (resumes) that run.

**Resume.** `kl.init(resume="<run_id>")` continues an existing run; the client picks up the writer's last sequence number so earlier data is not overwritten.

## Storage tiers

| | Built-in R2 (default) | Your own S3 |
|---|---|---|
| Metrics | numeric only | numeric only |
| Checkpoints | max 100 MB each, only the latest one per project is kept | any size, all kept |
| Artifacts (`kl.save`) | rejected (403 `storage_tier_limit`) | allowed |
| Quota | none beyond the above | none |

The checkpoint limit is the `FALLBACK_MAX_CHECKPOINT_MB` var in `apps/api/wrangler.jsonc`.

To use your own storage, open the project's settings page in the web UI (project owners only) and enter the endpoint, region, bucket, prefix, access key ID, secret, and path-style option. Any S3-compatible service works: AWS S3, RustFS, MinIO, or R2's S3 API. The UI runs a put/get/delete probe before saving. The secret is encrypted at rest with `STORAGE_ENC_KEY` and never shown again. Changing or removing the S3 config does not migrate existing data. The client never learns which tier is in use; it only skips what the project cannot save, with a one-time warning.

**Endpoint reachability.** The Worker talks to your S3 endpoint directly, and both the Worker and your training machines use the presigned URLs it hands out. In production the endpoint must be `https://` with a public hostname: deployed Workers cannot reach private networks, and the API rejects IP addresses, `localhost`, `*.local`, and `*.internal`. To use RustFS or MinIO running at home or on a LAN, expose it under a public https hostname, for example with a Cloudflare Tunnel (`cloudflared`).

**Local development only:** set `ALLOW_PRIVATE_S3_ENDPOINTS=1` in `apps/api/.dev.vars` to allow `http://` and private hosts, e.g. a local RustFS container:

```bash
docker run -d --name rustfs -p 9000:9000 -e RUSTFS_ACCESS_KEY=devkey -e RUSTFS_SECRET_KEY=devsecret123 rustfs/rustfs
# create a bucket, then in project settings: endpoint http://localhost:9000, path-style on
```

Do not set this flag in production: it disables the endpoint checks, and it does not make private networks reachable from Cloudflare anyway.

## Limits and known ceilings

- Metric values must be numbers (booleans log as 0/1). Non-numeric and non-finite values are dropped.
- Metric keys: 1 to 256 characters, no commas, whitespace, or control characters.
- A run can be read up to about 400 storage files, roughly 80 million rows. Beyond that, reads fail with 413 `run_too_large`.
- Parquet costs about 17 bytes per row; a single request handles about 300k rows in Worker memory. Charts are downsampled to about 2000 points per series.
- Built-in tier checkpoints: 100 MB, latest only.
- The client buffers up to 1 million points while the server is unreachable.
- Run `summary` and `config` are limited to 256,000 characters of JSON.
- Not supported: sweeps, reports, artifact versioning, images/audio, system metrics, offline mode, live (WebSocket) chart updates (the dashboard polls every 15 seconds for running runs).

## License

TBD.
