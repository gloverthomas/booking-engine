"use client";

import { useEffect, useMemo, useState } from "react";
import type { CatalogData } from "@/lib/public-api-types";
import { createApiClient } from "./flow/api-client";
import { FlowBody } from "./FlowBody";
import { ErrorPanel, ListSkeleton } from "./ui/Notice";
import { PublicFrame } from "./ui/PublicFrame";

type CatalogState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; catalog: CatalogData };

/** Loads the catalog, then hands over to the step-by-step flow. */
export function BookingFlow() {
  const api = useMemo(() => createApiClient(), []);
  const [state, setState] = useState<CatalogState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void api.catalog().then((result) => {
      if (cancelled) return;
      setState(
        result.ok
          ? { status: "ready", catalog: result.data }
          : { status: "error", message: result.error.message },
      );
    });
    return () => {
      cancelled = true;
    };
  }, [api, attempt]);

  const retry = () => {
    setState({ status: "loading" });
    setAttempt((n) => n + 1);
  };

  return (
    <PublicFrame>
      {({ embedded, rootRef }) => {
        if (state.status === "ready") {
          if (state.catalog.locations.length === 0) {
            return (
              <>
                <h1 className="rk-masthead rk-display">
                  Book an appointment<span className="rk-masthead__dot">.</span>
                </h1>
                <div className="rk-step-body">
                  <ErrorPanel message="Online booking isn't open at the moment. Please check back soon or contact the salon." />
                </div>
              </>
            );
          }
          return (
            <FlowBody
              api={api}
              catalog={state.catalog}
              onReloadCatalog={() => setAttempt((n) => n + 1)}
              embedded={embedded}
              rootRef={rootRef}
            />
          );
        }
        return (
          <>
            <h1 className="rk-masthead rk-display">
              Book an appointment<span className="rk-masthead__dot">.</span>
            </h1>
            <div className="rk-step-body">
              {state.status === "error" ? (
                <ErrorPanel message={state.message} onRetry={retry} />
              ) : (
                <div role="status" aria-label="Loading">
                  <ListSkeleton />
                </div>
              )}
            </div>
          </>
        );
      }}
    </PublicFrame>
  );
}
