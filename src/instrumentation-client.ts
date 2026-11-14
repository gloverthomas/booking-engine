import * as Sentry from "@sentry/nextjs";
import { sentryOptions } from "@/lib/sentry";

/** Browser error reporting for the booking page and admin. Does nothing until the public DSN is set. */
Sentry.init(
  sentryOptions({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT,
    tracesSampleRate: process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE,
  }),
);

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
