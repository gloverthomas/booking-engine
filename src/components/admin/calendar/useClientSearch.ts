"use client";

import { useEffect, useState } from "react";
import type { ClientSummary } from "@/server/admin/types";
import { getJson } from "./api";

const SEARCH_DELAY_MS = 250;

/** Debounced client search against /clients/search. Pass `enabled=false` to pause (and skip fetching). */
export function useClientSearch(query: string, enabled = true) {
  const [results, setResults] = useState<ClientSummary[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setSearching(true);
      setError(null);
      getJson<{ clients: ClientSummary[] }>(
        `/clients/search?q=${encodeURIComponent(query)}`,
        controller.signal,
      )
        .then((body) => setResults(body.clients))
        .catch((cause: unknown) => {
          if (controller.signal.aborted) return;
          setError(cause instanceof Error ? cause.message : "Search failed");
        })
        .finally(() => {
          if (!controller.signal.aborted) setSearching(false);
        });
    }, SEARCH_DELAY_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query, enabled]);

  return { results, searching, error };
}
