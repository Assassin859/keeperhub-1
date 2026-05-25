-- Two columns on sessions track whether a freshly-created session
-- needs the user to verify the originating IP via the /verify-ip
-- flow before it can reach any non-auth route. `pending_ip` is set
-- at the moment session.create.before fires so /verify-ip knows
-- which address to add to user_trusted_ips on success.
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS requires_ip_verification BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS pending_ip TEXT;

-- Per-user allowlist of trusted IPs. Inserted when the user
-- successfully verifies a new IP via /verify-ip; matched against
-- the request IP at every fresh session creation.
CREATE TABLE IF NOT EXISTS user_trusted_ips (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ip TEXT NOT NULL,
  country TEXT,
  first_seen_at TIMESTAMP NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_user_trusted_ips_user_id
  ON user_trusted_ips (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_trusted_ips_user_ip
  ON user_trusted_ips (user_id, ip);
