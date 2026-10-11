/** Errors callers can act on without interpreting a chat reply. */
export class ControlError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ControlError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
