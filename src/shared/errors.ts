// Class fields compile with define semantics (target ES2023), so `name` and `cause` are never
// declared as fields: a declared field would be reset to `undefined` after `super()` returns.
// `name` is assigned in each constructor and `cause` is left to the native Error constructor.

/**
 * A failure whose HTTP status and fixed user-facing message the error handler renders directly.
 *
 * It is a client error and is never logged. `publicMessage` is always a constant defined in this
 * module, never user input or driver text, so rendering it cannot leak data.
 */
export class HttpError extends Error {
  /** HTTP status code of the response. */
  readonly status: number;
  /** Fixed message shown on the error page. */
  readonly publicMessage: string;

  /**
   * @param status - HTTP status code of the response.
   * @param publicMessage - Fixed message shown on the error page.
   */
  constructor(status: number, publicMessage: string) {
    super(publicMessage);
    this.name = 'HttpError';
    this.status = status;
    this.publicMessage = publicMessage;
  }
}

/**
 * Malformed request input: a non-numeric or over-long task id, an unknown filter or status value,
 * a repeated parameter, or a form body whose bytes or percent-escapes are not valid UTF-8. It is
 * thrown before any write, so no data changes. Renders 400 "Bad request."
 */
export class BadRequestError extends HttpError {
  constructor() {
    super(400, 'Bad request.');
    this.name = 'BadRequestError';
  }
}

/** The only messages a 404 response may show. */
export type NotFoundMessage = 'Task not found.' | 'Page not found.';

/**
 * A missing resource, rendered as 404.
 *
 * "Task not found." covers both a task that does not exist and a task owned by another user, with
 * an identical status and body so the two cases cannot be told apart. "Page not found." covers
 * unknown routes.
 */
export class NotFoundError extends HttpError {
  /** @param publicMessage - Which not-found message to show. */
  constructor(publicMessage: NotFoundMessage) {
    super(404, publicMessage);
    this.name = 'NotFoundError';
  }
}

/**
 * A state-changing request whose CSRF check failed: the nonce cookie is missing, the `_csrf` field
 * is missing, or the token does not match. Nothing is changed. Renders 403 with the message
 * "The form has expired. Reload the page and try again."
 */
export class CsrfError extends HttpError {
  constructor() {
    super(403, 'The form has expired. Reload the page and try again.');
    this.name = 'CsrfError';
  }
}

/**
 * The database could not be reached or could not serve a statement in time: a network failure
 * (`ECONNREFUSED`, `ECONNRESET`, `ENOTFOUND`, `ETIMEDOUT`, `EAI_AGAIN`), SQLSTATE class `08`,
 * `57P01`–`57P03` or `53300`, a statement the server cancelled and rolled back on the pool's
 * statement timeout (`57014`) or a lock timeout (`55P03`), a pool connection timeout, a
 * terminated connection, a statement the server left unanswered past the pool's query timeout
 * ("Query read timeout"), or a statement pg refuses because its client's connection is already
 * gone ("not queryable").
 *
 * Raised by the data-access layer with the driver error kept as `cause`, so the logger can record
 * the driver's code. For a refused statement on a checked-out client, the `cause` is the error
 * that broke its connection when the client recorded one. The error handler logs it and renders
 * 503 "Service temporarily unavailable".
 * It deliberately does not extend {@link HttpError}, because HTTP errors are never logged.
 */
export class DatabaseUnavailableError extends Error {
  /**
   * @param message - Generic description. Never pass the driver's message, SQL text or the
   *   connection string, which may carry credentials.
   * @param options - `cause` holds the original driver error.
   */
  constructor(message: string = 'Database unavailable', options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DatabaseUnavailableError';
  }
}
