import { TimesheetError } from "../timesheets/errors";

/** A problem with a target the person can fix. Same shape as TimesheetError so one action wrapper handles both. */
export class TargetError extends TimesheetError {
  constructor(code: string, message: string, fieldErrors: Record<string, string> = {}) {
    super(code, message, fieldErrors);
    this.name = "TargetError";
  }
}
