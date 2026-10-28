-- Migration 0002_create_sessions
--
-- Creates the sessions table: server-side session records, one per login
-- (plan sections 0.5.2 and 0.3.4). A session is identified by the SHA-256 of
-- the random token held in the signed sid cookie, never by the token itself.
--
-- The migration runner (src/db/migrate.ts) applies this file exactly once,
-- inside a transaction it opens and closes itself, and records the version
-- in schema_migrations. The file therefore holds no transaction control.
--
-- Never edit this file once it has been applied anywhere. Later schema
-- changes go in new, higher-numbered migration files.

-- Invariants kept by the application, which these checks back up:
--   * expires_at = LEAST(created_at + 8 hours, last_active_at + 30 minutes),
--     as computed by computeExpiresAt in src/auth/session-policy.ts, so it
--     never exceeds created_at + 8 hours.
--   * last_active_at starts at created_at, and touchIfActive in
--     src/db/sessions-repo.ts advances it with GREATEST, so it never moves
--     backwards and never falls below created_at.
-- The '8 hours' interval has no day or month part, so the check means the
-- same instant in every time zone.
CREATE TABLE sessions (
  -- SHA-256 of the 256-bit random cookie token (hashSessionToken in
  -- src/auth/tokens.ts). A database read therefore yields no usable token.
  id bytea PRIMARY KEY CHECK (octet_length(id) = 32),
  -- Deleting a user deletes that user's sessions.
  user_id bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- Millisecond precision matches JavaScript Date. No defaults: the
  -- application binds every timestamp from its injected Clock.
  created_at timestamptz(3) NOT NULL,
  last_active_at timestamptz(3) NOT NULL,
  expires_at timestamptz(3) NOT NULL,
  CONSTRAINT sessions_last_active_at_check CHECK (last_active_at >= created_at),
  CONSTRAINT sessions_expires_at_check CHECK (expires_at <= created_at + interval '8 hours')
);

-- Serves the ON DELETE CASCADE from users, which looks sessions up by user_id.
CREATE INDEX sessions_user_id_idx ON sessions (user_id);

-- Serves the scheduled purge of expired sessions (deleteExpired in
-- src/db/sessions-repo.ts deletes every row whose expires_at has passed).
CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);
