import { loadIntegrationEnv } from "@/server/integrations/common/env";
import { registerConsumer, registerScheduledJob } from "@/server/integrations/common/worker-utils";
import {
  handleXeroDomainEvent,
  type IncomingXeroEvent,
  type XeroConsumerDeps,
} from "@/server/integrations/xero/consumer";
import {
  runXeroKeepalive,
  runXeroReconcile,
  XERO_JOBS,
  XERO_SCHEDULES,
} from "@/server/integrations/xero/jobs";
import type { RegisterHandlers } from "../context";

/**
 * Xero worker: the domain-event consumer plus a daily token keepalive and an hourly reconcile.
 * Nothing here polls Xero, so the free tier's 1,000 calls/day is spent only on real bookings.
 */
export const register: RegisterHandlers = async ({ boss, db, log, now }) => {
  const deps = (): XeroConsumerDeps => ({ db, log, now, env: loadIntegrationEnv() });

  await registerConsumer<IncomingXeroEvent>(boss, XERO_JOBS.consumer, (event) =>
    handleXeroDomainEvent(deps(), event),
  );
  await registerScheduledJob(boss, XERO_JOBS.keepalive, XERO_SCHEDULES.keepalive, async () => {
    await runXeroKeepalive(deps());
  });
  await registerScheduledJob(boss, XERO_JOBS.reconcile, XERO_SCHEDULES.reconcile, async () => {
    await runXeroReconcile(deps());
  });
};
