/** A problem the person can fix (not clocked in, overlapping entry...). The message is shown as-is. */
export class TimesheetError extends Error {
  readonly code: string;
  readonly fieldErrors: Readonly<Record<string, string>>;

  constructor(code: string, message: string, fieldErrors: Record<string, string> = {}) {
    super(message);
    this.name = "TimesheetError";
    this.code = code;
    this.fieldErrors = fieldErrors;
  }
}

export function isTimesheetError(error: unknown): error is TimesheetError {
  return error instanceof TimesheetError;
}
