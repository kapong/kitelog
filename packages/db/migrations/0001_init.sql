-- kitelog initial schema. IDs are TEXT (generated in app), timestamps are INTEGER ms,
-- booleans are INTEGER 0/1, JSON columns are TEXT.

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name          TEXT,
  is_admin      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);

CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE invites (
  id         TEXT PRIMARY KEY,
  email      TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER
);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE projects (
  id          TEXT PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  description TEXT,
  created_at  INTEGER NOT NULL
);

-- Row exists = project uses its own S3 tier.
CREATE TABLE project_storage (
  project_id    TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  endpoint      TEXT NOT NULL,
  region        TEXT NOT NULL,
  bucket        TEXT NOT NULL,
  prefix        TEXT NOT NULL DEFAULT '',
  access_key_id TEXT NOT NULL,
  secret_enc    TEXT NOT NULL,
  path_style    INTEGER NOT NULL DEFAULT 0,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE project_members (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  PRIMARY KEY (project_id, user_id)
);
CREATE INDEX project_members_user ON project_members(user_id);

CREATE TABLE api_keys (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  prefix       TEXT NOT NULL,
  key_hash     TEXT NOT NULL UNIQUE,
  scope        TEXT NOT NULL CHECK (scope IN ('write', 'read')),
  created_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at   INTEGER
);
CREATE INDEX api_keys_project ON api_keys(project_id);

CREATE TABLE runs (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('running', 'finished', 'failed', 'crashed')),
  config       TEXT NOT NULL DEFAULT '{}',
  summary      TEXT NOT NULL DEFAULT '{}',
  tags         TEXT NOT NULL DEFAULT '[]',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  finished_at  INTEGER,
  heartbeat_at INTEGER
);
CREATE INDEX runs_project_created ON runs(project_id, created_at);
CREATE INDEX runs_status_heartbeat ON runs(status, heartbeat_at);

CREATE TABLE run_writers (
  run_id        TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  writer_id     INTEGER NOT NULL,
  last_seq      INTEGER NOT NULL DEFAULT -1,
  compacted_seq INTEGER NOT NULL DEFAULT -1,
  heartbeat_at  INTEGER,
  PRIMARY KEY (run_id, writer_id)
);

CREATE TABLE run_metric_keys (
  run_id     TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  last_step  INTEGER NOT NULL,
  last_value REAL,
  PRIMARY KEY (run_id, key)
);

CREATE TABLE files (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id       TEXT REFERENCES runs(id) ON DELETE SET NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('checkpoint', 'artifact')),
  path         TEXT NOT NULL,
  size         INTEGER NOT NULL,
  content_type TEXT,
  storage_key  TEXT NOT NULL,
  backend      TEXT NOT NULL CHECK (backend IN ('r2', 's3')),
  created_at   INTEGER NOT NULL
);
CREATE INDEX files_project_kind_created ON files(project_id, kind, created_at);
CREATE INDEX files_run ON files(run_id);

-- Pending multipart / worker uploads.
CREATE TABLE uploads (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id       TEXT REFERENCES runs(id) ON DELETE SET NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('checkpoint', 'artifact')),
  path         TEXT NOT NULL,
  size         INTEGER NOT NULL,
  content_type TEXT,          -- not in spec's data model; needed to fill files.content_type on complete
  storage_key  TEXT NOT NULL,
  backend      TEXT NOT NULL CHECK (backend IN ('r2', 's3')),
  s3_upload_id TEXT,
  status       TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'aborted')),
  created_at   INTEGER NOT NULL
);
CREATE INDEX uploads_status ON uploads(status, created_at);
CREATE INDEX uploads_run ON uploads(run_id);
