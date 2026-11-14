import { loadIntegrationEnv } from "@/server/integrations/common/env";
import { registerConsumer, registerScheduledJob } from "@/server/integrations/common/worker-utils";
import {
  GOOGLE_JOBS,
  GOOGLE_SCHEDULES,
  runChannelRenewalJob,
  runGoogleReconcile,
  runGoogleSyncJob,
} from "@/server/integrations/google/jobs";
import {
  handleGoogleDomainEvent,
  type IncomingDomainEvent,
} from "@/server/integrations/google/outbound";
import type { GoogleDeps } from "@/server/integrations/google/runtime";
import type { RegisterHandlers } from "../context";

/**
 * Google Calendar worker: the domain-event consumer (outbound), the 15-minute fallback poll,
 * push-channel renewal and an hourly reconcile.
 */
export const register: RegisterHandlers = async ({ boss, db, log, now }) => {
  const deps = (): GoogleDeps => ({ db, log, now, env: loadIntegrationEnv() });

  await registerConsumer<IncomingDomainEvent>(boss, GOOGLE_JOBS.consumer, (event) =>
    handleGoogleDomainEvent(deps(), event),
  );
  await registerScheduledJob(boss, GOOGLE_JOBS.sync, GOOGLE_SCHEDULES.sync, () =>
    runGoogleSyncJob(deps()),
  );
  await registerScheduledJob(boss, GOOGLE_JOBS.renewChannel, GOOGLE_SCHEDULES.renewChannel, () =>
    runChannelRenewalJob(deps()),
  );
  await registerScheduledJob(boss, GOOGLE_JOBS.reconcile, GOOGLE_SCHEDULES.reconcile, async () => {
    await runGoogleReconcile(deps());
  });
};
