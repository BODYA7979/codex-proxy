export class CallerRequestError extends Error {
  constructor(message: string, readonly status = 400, readonly code = "invalid_request") { super(message); }
}
