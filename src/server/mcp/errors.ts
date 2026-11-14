import { z } from "zod";
import { createLogger } from "@/lib/logger";
import { ReportInputError } from "../reports/range";
import { cleanText } from "./text";

export type McpErrorCode =
  | "invalid_input"
  | "unknown_tool"
  | "not_found"
  | "precondition_failed"
  | "confirm_token_invalid"
  | "confirm_token_expired"
  | "confirm_token_used"
  | "money_tools_disabled"
  | "amount_exceeds_per_call_cap"
  | "daily_cap_exceeded"
  | "rate_limited"
  | "backend_unavailable"
  | "backend_error"
  | "internal_error";

/** An expected failure with a stable code the model (and tests) can act on. */
export class McpToolError extends Error {
  constructor(
    readonly code: McpErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "McpToolError";
  }
}

export interface ToolErrorBody {
  error: { code: McpErrorCode; message: string; details?: Record<string, unknown> };
}

const log = createLogger("mcp");

/** Domain stubs throw "<fn> not implemented" until the owning workstream lands. */
const NOT_IMPLEMENTED = /not implemented/i;

/** Turn anything thrown into a structured, safe error body. Unknown errors are logged, never echoed. */
export function toErrorBody(error: unknown, tool?: string): ToolErrorBody {
  if (error instanceof McpToolError) {
    return { error: { code: error.code, message: error.message, details: error.details } };
  }
  if (error instanceof z.ZodError) {
    return {
      error: {
        code: "invalid_input",
        message: "The arguments did not match the tool's input schema.",
        details: {
          issues: error.issues.slice(0, 10).map((i) => ({
            path: i.path.join("."),
            message: cleanText(i.message, 200).text,
          })),
        },
      },
    };
  }
  if (error instanceof ReportInputError) {
    return { error: { code: "invalid_input", message: error.message } };
  }
  if (error instanceof Error && NOT_IMPLEMENTED.test(error.message)) {
    return {
      error: {
        code: "backend_unavailable",
        message: "That part of the booking system is not available yet.",
      },
    };
  }
  log({
    level: "error",
    event: "mcp.tool.failed",
    tool,
    message: error instanceof Error ? error.message : String(error),
  });
  return {
    error: {
      code: "internal_error",
      message:
        "Something went wrong. Nothing was changed unless the result says so. Try again or check the logs.",
    },
  };
}

/**
 * Wrap a call into a domain function. "Not implemented" stubs and our own McpToolErrors pass through untouched;
 * anything else the domain throws (slot taken, booking already cancelled...) becomes a capped backend_error.
 */
export async function callBackend<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof McpToolError) throw error;
    if (error instanceof Error && NOT_IMPLEMENTED.test(error.message)) throw error;
    if (error instanceof Error) {
      throw new McpToolError("backend_error", cleanText(error.message.split("\n")[0], 200).text);
    }
    throw error;
  }
}
