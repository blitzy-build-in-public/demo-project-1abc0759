/**
 * `Cache-Control: no-store` for every response to a signed-in request.
 *
 * Private pages, redirects, error pages and the CSV export must not be kept in the browser's or
 * any intermediary's HTTP cache, so that after logout a shared browser's history cannot bring
 * them back from it. Chrome still keeps `no-store` pages in its back/forward cache; the
 * `POST /logout` response is what makes it discard them, so Back after logout asks the server.
 * Anonymous responses (the sign-up and login pages, `/static` assets) hold nothing private and
 * keep their default caching.
 */

import type { RequestHandler } from 'express';

// Side-effect import: brings the global `Express.Request` augmentation (`req.user`) into the
// program when this file is compiled on its own under `isolatedModules`.
import '../request-user';

/**
 * Marks the response `Cache-Control: no-store` when the request is authenticated, then always
 * continues with `next()`. Requests without `req.user` pass through untouched.
 *
 * It must run after `loadSession`, which is the only code that sets `req.user`, and before the
 * routers, so the header is already set on whatever response a route, the 404 handler or the
 * error handler later sends. Mounting order is owned by `createApp` in `src/app.ts`.
 */
export const noStore: RequestHandler = (req, res, next) => {
  if (req.user) {
    res.set('Cache-Control', 'no-store');
  }
  next();
};
