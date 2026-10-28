import { createHash, randomBytes } from 'node:crypto';

/**
 * Number of random bytes in a session token: 256 bits of entropy, well above
 * OWASP's 128-bit floor for session identifiers.
 */
export const SESSION_TOKEN_BYTES = 32;

/**
 * Generates a new random session token as base64url text (43 URL-safe
 * characters, no padding).
 *
 * A fresh token is issued at every successful login, which prevents session
 * fixation. The raw token lives only in the signed `sid` cookie; the database
 * keeps its hash (see {@link hashSessionToken}), so a database read yields no
 * usable token. The token must never be logged, rendered or put in a redirect.
 */
export function generateSessionToken(): string {
  return randomBytes(SESSION_TOKEN_BYTES).toString('base64url');
}

/**
 * Returns the SHA-256 digest (32 bytes) of a session token. Pure and
 * deterministic: the same token always yields the same digest.
 *
 * This digest is the `sessions.id` primary key (`bytea`, constrained to
 * exactly 32 bytes). Its lowercase hex form (`toString('hex')`) is
 * `AuthenticatedUser.sessionId`, used only as the CSRF HMAC binding and never
 * rendered.
 */
export function hashSessionToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}
