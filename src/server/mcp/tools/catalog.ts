import { z } from "zod";
import { integrationAccount } from "@/db/schema";
import { defineRead } from "../deps";
import { moneySpentToday, startOfBusinessDay } from "../guards";
import { loadServices } from "../queries";
import { whenOut } from "../shared";
import { untrusted } from "../text";

export const listServices = defineRead({
  kind: "read",
  name: "list_services",
  title: "List services",
  description:
    "The service catalogue: name, duration, price, buffer, deposit override and whether it is bookable. Prices in cents (AUD).",
  schema: z.object({
    includeInactive: z
      .boolean()
      .default(false)
      .describe("Also list services that are switched off."),
  }),
  async run({ includeInactive }, { deps }) {
    const rows = await loadServices(deps.db, includeInactive);
    return {
      count: rows.length,
      services: rows.map((s) => ({
        serviceId: s.id,
        name: s.name,
        category: s.category,
        description: s.description,
        durationMin: s.durationMin,
        priceCents: s.priceCents,
        bufferMin: s.bufferMin,
        depositPct: s.depositPct,
        vipOnly: s.vipOnly,
        active: s.active,
      })),
    };
  },
});

const PROVIDERS = ["stripe", "google", "xero"] as const;

export const getIntegrationStatus = defineRead({
  kind: "read",
  name: "get_integration_status",
  title: "Get integration status",
  description:
    "Whether Stripe, Google Calendar and Xero are connected and healthy, when each last synced, and the current " +
    "state of the MCP money tools (switch and daily allowance). Never returns credentials.",
  schema: z.object({}),
  async run(_args, { deps, timezone }) {
    const accounts = await deps.db
      .select({
        provider: integrationAccount.provider,
        status: integrationAccount.status,
        lastSyncAt: integrationAccount.lastSyncAt,
        lastError: integrationAccount.lastError,
      })
      .from(integrationAccount);
    const spent = await moneySpentToday(deps.db, startOfBusinessDay(deps.now(), timezone));
    const { config } = deps;
    return {
      integrations: PROVIDERS.map((provider) => {
        const found = accounts.find((a) => a.provider === provider);
        return found
          ? {
              provider,
              status: found.status,
              lastSyncAt: found.lastSyncAt ? whenOut(found.lastSyncAt, timezone) : null,
              lastError: untrusted(found.lastError, 300),
            }
          : { provider, status: "not_connected", lastSyncAt: null, lastError: null };
      }),
      mcp: {
        moneyToolsEnabled: config.moneyToolsEnabled,
        maxMoneyCentsPerCall: config.maxMoneyCentsPerCall,
        maxMoneyCentsPerDay: config.maxMoneyCentsPerDay,
        moneyUsedTodayCents: spent,
        moneyRemainingTodayCents: Math.max(0, config.maxMoneyCentsPerDay - spent),
      },
    };
  },
});
