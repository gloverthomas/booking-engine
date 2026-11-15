import { ButtonLink } from "@/components/ui/button";
import { ADMIN_HOME } from "./nav-config";

/**
 * Shown inside the admin shell when a signed-in person opens something their role cannot use.
 * Friendly and final: no redirect, so it can never loop.
 */
export function NotAllowed() {
  return (
    <section
      aria-labelledby="not-allowed-heading"
      className="flex max-w-xl flex-col gap-4 border-t-[3px] border-ink pt-6"
    >
      <p className="eyebrow">Not available</p>
      <h1 id="not-allowed-heading" className="display text-4xl">
        This isn&apos;t part of your access
      </h1>
      <p className="text-ink-muted">
        Your role doesn&apos;t include this page. If you think it should, ask the owner to check
        your role under Staff.
      </p>
      <div>
        <ButtonLink href={ADMIN_HOME}>Back to the calendar</ButtonLink>
      </div>
    </section>
  );
}
