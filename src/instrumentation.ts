import * as Sentry from "@sentry/nextjs";
import { sentryOptions } from "@/lib/sentry";

/** Server-side error reporting. Does nothing until SENTRY_DSN is set. */
export function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  Sentry.init(
    sentryOptions({
      dsn: process.env.SENTRY_DSN,
      environment: process.env.SENTRY_ENVIRONMENT,
      release: process.env.RAILWAY_GIT_COMMIT_SHA,
      tracesSampleRate: process.env.SENTRY_TRACES_SAMPLE_RATE,
    }),
  );
}

export const onRequestError = Sentry.captureRequestError;
