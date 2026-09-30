/// Errors that map to a deliberate HTTP status. Anything else that reaches the
/// error handler is a bug and becomes a 500 with no detail leaked to the client.
export class HttpError extends Error {
  readonly status: number;

  /// Short machine-readable reason, used for security logging. Never sent to
  /// the client verbatim unless it is already in `message`.
  readonly reason: string;

  constructor(status: number, message: string, reason = message) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.reason = reason;
  }
}

export const unauthorized = (reason: string): HttpError =>
  new HttpError(401, "Unauthorized", reason);

export const forbidden = (reason: string): HttpError =>
  new HttpError(403, "Forbidden", reason);

export const notFound = (reason: string): HttpError =>
  new HttpError(404, "Not found", reason);

export const badRequest = (message: string): HttpError =>
  new HttpError(400, message);

export const tooManyRequests = (retryAfterSeconds: number): HttpError =>
  new HttpError(
    429,
    `Too many requests. Retry in ${retryAfterSeconds}s`,
    "rate_limited",
  );
