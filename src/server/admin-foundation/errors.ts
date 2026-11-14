/** A problem the owner can fix (bad input, record in use). Shown to the user as-is; never carries secrets. */
export class AdminError extends Error {
  readonly code: string;
  readonly fieldErrors: Readonly<Record<string, string>>;

  constructor(code: string, message: string, fieldErrors: Record<string, string> = {}) {
    super(message);
    this.name = "AdminError";
    this.code = code;
    this.fieldErrors = fieldErrors;
  }
}

export function isAdminError(error: unknown): error is AdminError {
  return error instanceof AdminError;
}
