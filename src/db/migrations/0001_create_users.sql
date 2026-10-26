-- Migration 0001_create_users
--
-- Creates the users table and the case-insensitive unique email index
-- (plan section 0.5.2).
--
-- The migration runner (src/db/migrate.ts) applies this file exactly once,
-- inside a transaction it opens and closes itself, and records the version
-- in schema_migrations. The file therefore holds no transaction control.
--
-- Never edit this file once it has been applied anywhere. Later schema
-- changes go in new, higher-numbered migration files.

CREATE TABLE users (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- Stored trimmed, with its case as entered. The length check is a backstop
  -- for validateEmail in src/auth/password-policy.ts.
  email text NOT NULL CHECK (char_length(email) BETWEEN 3 AND 254),
  password_hash text NOT NULL, -- bcrypt hash, cost 12; plain-text passwords are never stored
  -- Millisecond precision matches JavaScript Date, so values round-trip exactly.
  -- The application binds every timestamp from its injected Clock.
  created_at timestamptz(3) NOT NULL
);

-- Enforces case-insensitive email uniqueness in the database, so two racing
-- sign-ups for the same address cannot both succeed; also serves login lookups
-- on lower(email). users-repo.ts maps a violation of this name to 'duplicate'.
CREATE UNIQUE INDEX users_email_lower_key ON users (lower(email));
