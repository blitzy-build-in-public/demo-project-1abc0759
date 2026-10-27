/**
 * Request typing: adds `req.user` to every Express request through the global `Express.Request`
 * merge point that `@types/express` declares.
 *
 * `req.user` is set only by `loadSession` (`src/web/middleware/load-session.ts`), and only after
 * `AuthService.authenticate` returns a user for a validly signed, active session token. It stays
 * absent for anonymous requests and for tampered, unknown or expired session cookies, so its
 * presence is the single signal of a signed-in request for `requireAuth`, `noStore`, CSRF binding
 * and the routers.
 *
 * {@link AuthenticatedUser} carries no password, hash or raw token. Its `sessionId` is the hex
 * session-token hash, used only inside the CSRF HMAC and never rendered into a page, redirect or
 * log.
 *
 * Files that read or write `req.user` import this module for its side effect (for example
 * `import '../request-user';` from `middleware/` or `routes/`), so the dependency stays explicit
 * when a file is compiled alone.
 */

import type { AuthenticatedUser } from '../auth/auth-service';

declare global {
  // Merging into the global `Express` namespace is the extension point the Express 4 type
  // declarations document; a module-scoped interface would not reach `express.Request`.
  namespace Express {
    interface Request {
      /** The signed-in user, set by `loadSession` when the session cookie is valid and active. */
      user?: AuthenticatedUser;
    }
  }
}

// `declare global` is legal only in a module. The type-only import is erased at emit, so this
// empty export keeps the file a module on its own terms under `isolatedModules`.
export {};
