import { z } from "zod";
import { createLogger } from "@/lib/logger";
import { recordAudit } from "../audit";
import { CONFIRM_TTL_MS } from "./config";
import { createConfirmToken, verifyConfirmToken } from "./confirm";
import type { ToolContext, ToolDef, WriteToolDef } from "./deps";
import { McpToolError } from "./errors";
import {
  consumeConfirmToken,
  releaseDailyMoney,
  reserveDailyMoney,
  startOfBusinessDay,
} from "./guards";
import { containsUntrusted, UNTRUSTED_NOTICE } from "./text";

const log = createLogger("mcp");

const argsObject = z.record(z.string(), z.unknown());
const tokenField = z.string().min(10).max(200).optional();

/** Added to every write tool's input schema (as advertised to clients). */
export const CONFIRM_TOKEN_DESCRIPTION =
  "Leave out on the first call to get a preview. To go ahead, call again with identical arguments plus the " +
  "confirmToken from the preview, after the owner has seen the preview and agreed.";

function withNotice<T extends Record<string, unknown>>(body: T): T & { dataNotice?: string } {
  return containsUntrusted(body) ? { ...body, dataNotice: UNTRUSTED_NOTICE } : body;
}

async function recordFailure(ctx: ToolContext, tool: WriteToolDef, error: unknown): Promise<void> {
  try {
    await recordAudit(ctx.deps.db, {
      actor: ctx.principal.actor,
      action: `mcp.${tool.name}.failed`,
      entityType: tool.entityType,
      data: { code: error instanceof McpToolError ? error.code : "error" },
    });
  } catch (auditError) {
    log({
      level: "error",
      event: "mcp.audit.failed",
      tool: tool.name,
      message: String(auditError),
    });
  }
}

async function runWrite(
  tool: WriteToolDef,
  rawInput: Record<string, unknown>,
  ctx: ToolContext,
): Promise<Record<string, unknown>> {
  const { confirmToken: rawToken, ...rest } = rawInput;
  const confirmToken = tokenField.parse(rawToken);
  const args = tool.schema.parse(rest);
  const { deps, principal } = ctx;

  const limited = deps.writeLimiter.check(principal.tokenId ?? principal.ownerId);
  if (!limited.allowed) {
    throw new McpToolError(
      "rate_limited",
      "Too many changes in a short time. Wait a moment and try again.",
      {
        retryAfterSeconds: limited.retryAfterSec,
      },
    );
  }

  // Preconditions are checked on both steps: the world may have changed in the five minutes between them.
  const preview = await tool.prepare(args, ctx);
  const secret = deps.getConfirmSecret();
  const now = deps.now();

  if (!confirmToken) {
    const { token, expiresAt } = createConfirmToken({
      secret,
      tool: tool.name,
      ownerId: principal.ownerId,
      args,
      now,
      ttlMs: CONFIRM_TTL_MS,
    });
    return {
      status: "confirmation_required",
      tool: tool.name,
      nothingChangedYet: true,
      preview: { summary: preview.summary, details: preview.details },
      confirmToken: token,
      expiresAt: expiresAt.toISOString(),
      howToConfirm:
        `Show this preview to the owner. Only if they agree, call ${tool.name} again with exactly the same ` +
        `arguments plus confirmToken. The token works once, for these arguments only, for 5 minutes.`,
    };
  }

  const verdict = verifyConfirmToken({
    secret,
    tool: tool.name,
    ownerId: principal.ownerId,
    args,
    token: confirmToken,
    now,
  });
  if (!verdict.ok) {
    if (verdict.reason === "expired") {
      throw new McpToolError(
        "confirm_token_expired",
        "That confirmation expired. Ask for a new preview.",
      );
    }
    throw new McpToolError(
      "confirm_token_invalid",
      "That confirmToken does not match this tool and these exact arguments. Nothing was done. Ask for a new preview.",
    );
  }

  await consumeConfirmToken(deps.db, verdict.tokenId, tool.name);

  let reservationId: string | undefined;
  if (tool.kind === "money") {
    if (preview.moneyCents === undefined) {
      throw new McpToolError("internal_error", "Money tool produced no amount.");
    }
    reservationId = await reserveDailyMoney(deps.db, {
      amountCents: preview.moneyCents,
      capCents: deps.config.maxMoneyCentsPerDay,
      dayStart: startOfBusinessDay(now, ctx.timezone),
      now,
      tool: tool.name,
    });
  }

  try {
    const execution = await tool.execute(args, ctx, preview);
    try {
      await recordAudit(deps.db, {
        actor: principal.actor,
        action: `mcp.${tool.name}`,
        entityType: tool.entityType,
        entityId: execution.entityId,
        data: {
          ...(tool.auditArgs?.(args) ?? {}),
          ...(execution.audit ?? {}),
          ownerId: principal.ownerId,
          confirmRef: verdict.tokenId.slice(0, 12),
        },
      });
    } catch (auditError) {
      // The change already happened; report it rather than pretend it failed.
      log({
        level: "error",
        event: "mcp.audit.failed",
        tool: tool.name,
        message: String(auditError),
      });
    }
    return {
      status: "executed",
      tool: tool.name,
      summary: execution.summary,
      result: execution.result,
    };
  } catch (error) {
    if (reservationId && preview.moneyCents !== undefined) {
      await releaseDailyMoney(deps.db, {
        reservationId,
        amountCents: preview.moneyCents,
        tool: tool.name,
        now,
      });
    }
    await recordFailure(ctx, tool, error);
    throw error;
  }
}

/** Validate input, enforce the confirm flow for writes, run the tool. Throws McpToolError / ZodError on failure. */
export async function runTool(
  tools: ReadonlyMap<string, ToolDef>,
  name: string,
  rawArgs: unknown,
  ctx: ToolContext,
): Promise<Record<string, unknown>> {
  const tool = tools.get(name);
  if (!tool)
    throw new McpToolError("unknown_tool", `There is no tool called "${name.slice(0, 60)}".`);
  const input = argsObject.parse(rawArgs ?? {});
  if (tool.kind === "read") {
    const args = tool.schema.parse(input);
    return withNotice(await tool.run(args, ctx));
  }
  return withNotice(await runWrite(tool, input, ctx));
}
