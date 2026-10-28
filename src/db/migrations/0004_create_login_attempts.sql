-- Migration 0004_create_login_attempts
--
-- Creates the login_attempts table that records failed logins for the lockout
-- rule (5 failures for one email within 15 minutes refuse further attempts for
-- 15 minutes), its two indexes, and the trigger that removes a user's login
-- attempts when the user is deleted (plan sections 0.5.2 and 0.3.4).
--
-- Rows carry the normalised email rather than a user id, because failures are
-- also recorded for emails that have no account. The lockout therefore behaves
-- the same for registered and unknown emails and reveals nothing about which
-- emails are registered. Without a user id no foreign key can cascade the
-- deletion of a user, so the users_delete_login_attempts trigger does it.
--
-- The migration runner (src/db/migrate.ts) applies this file exactly once,
-- inside a transaction it opens and closes itself, and records the version
-- in schema_migrations. The file therefore holds no transaction control; the
-- BEGIN and END inside the trigger function delimit a PL/pgSQL block.
--
-- Never edit this file once it has been applied anywhere. Later schema
-- changes go in new, higher-numbered migration files.

CREATE TABLE login_attempts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- The normalised key lower(btrim(email)): normalizeEmail in
  -- src/auth/password-policy.ts normalises it before login-attempts-repo.ts
  -- inserts it.
  email text NOT NULL,
  -- No default: the application binds the failure time from its injected
  -- Clock, so the lockout window and refusal can be tested with a fake clock.
  failed_at timestamptz(3) NOT NULL
);

-- Serves the lockout check (an email's newest failures, newest first) and the
-- deletion of an email's failures after a successful login.
CREATE INDEX login_attempts_email_failed_idx ON login_attempts (email, failed_at DESC);

-- Serves the purge of failures older than 24 hours.
CREATE INDEX login_attempts_failed_at_idx ON login_attempts (failed_at);

-- Deletes the failures recorded under a deleted user's email. users.email is
-- stored trimmed with its case as entered, so lower(btrim(OLD.email))
-- reproduces the key stored in login_attempts. PostgreSQL ignores the return
-- value of an AFTER row trigger, hence RETURN NULL.
CREATE FUNCTION delete_login_attempts_for_user() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM login_attempts WHERE email = lower(btrim(OLD.email));
  RETURN NULL;
END;
$$;

-- No page deletes users; the cascade is verified directly in
-- tests/integration/schema.test.ts. TRUNCATE fires no row triggers, which is
-- harmless because tests/helpers/test-db.ts truncates login_attempts itself.
CREATE TRIGGER users_delete_login_attempts
  AFTER DELETE ON users
  FOR EACH ROW
  EXECUTE FUNCTION delete_login_attempts_for_user();
