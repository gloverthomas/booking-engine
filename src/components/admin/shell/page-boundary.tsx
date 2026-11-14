import { Suspense, type ReactNode } from "react";

/** Placeholder shown in the content area while an admin page streams in. */
export function PageSkeleton() {
  return (
    <div aria-busy="true" className="flex flex-col gap-6">
      <p className="sr-only" role="status">
        Loading
      </p>
      <div aria-hidden className="flex flex-col gap-3 border-b border-ink pb-5">
        <div className="h-3 w-24 animate-pulse rounded bg-line motion-reduce:animate-none" />
        <div className="h-12 w-3/4 max-w-md animate-pulse rounded bg-line motion-reduce:animate-none" />
      </div>
      <div aria-hidden className="flex flex-col gap-3">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="h-16 animate-pulse rounded-card bg-sunken motion-reduce:animate-none"
          />
        ))}
      </div>
    </div>
  );
}

/**
 * Wrap the body of every admin page in this. Pages read the session and database at request time;
 * Next.js (Cache Components) needs a Suspense boundary inside the page's own segment so client
 * navigations show the shell and skeleton instantly while the content streams in.
 *
 *   export default function Page() {
 *     return <PageBoundary><PageBody /></PageBoundary>;   // PageBody is the async component
 *   }
 */
export function PageBoundary({ children }: { children: ReactNode }) {
  return <Suspense fallback={<PageSkeleton />}>{children}</Suspense>;
}
