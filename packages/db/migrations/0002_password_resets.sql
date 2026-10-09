-- Accounts are admin-created; a user sets (or resets) their password through a one-time link.
-- Invites and the open-signup setting are gone.

CREATE TABLE password_resets (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL, -- NULL: break-glass script
  expires_at INTEGER NOT NULL,
  used_at    INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX password_resets_user ON password_resets(user_id);

DROP TABLE invites;
DROP TABLE settings; -- held only open_signup
