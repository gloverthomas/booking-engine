"use client";

import { NotAllowed } from "@/components/admin/shell/not-allowed";
import { Button } from "@/components/ui/button";
import { ACCESS_DENIED_DIGEST } from "@/server/auth/access-core";

/**
 * Error boundary for every admin page (inside the shell, so navigation stays usable).
 * A role without the permission throws AccessDeniedError, which carries a fixed digest that survives
 * production error masking: that case gets the friendly page, anything else a retry prompt.
 */
export default function AdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  if (error.digest === ACCESS_DENIED_DIGEST) return <NotAllowed />;
  return (
    <section
      aria-labelledby="admin-error-heading"
      className="flex max-w-xl flex-col gap-4 border-t-[3px] border-ink pt-6"
    >
      <p className="eyebrow">Something went wrong</p>
      <h1 id="admin-error-heading" className="display text-4xl">
        This page didn&apos;t load
      </h1>
      <p className="text-ink-muted">
        Nothing was lost. Try again, and if it keeps happening let the owner know.
      </p>
      <div>
        <Button onClick={reset}>Try again</Button>
      </div>
    </section>
  );
}
