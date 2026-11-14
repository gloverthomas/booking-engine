"use client";

import { useEffect, useRef } from "react";
import type { StepId } from "./state";

const STEPS: readonly StepId[] = ["location", "services", "time", "details", "pay"];

function isStep(value: unknown): value is StepId {
  return typeof value === "string" && (STEPS as readonly string[]).includes(value);
}

/**
 * Make the browser Back/Forward buttons move between booking steps instead of leaving the page
 * and losing the visitor's choices. `onNavigate` decides whether the target step is allowed.
 */
export function useFlowHistory(step: StepId, onNavigate: (step: StepId) => void): void {
  const current = useRef(step);
  const handler = useRef(onNavigate);

  useEffect(() => {
    handler.current = onNavigate;
  }, [onNavigate]);

  useEffect(() => {
    window.history.replaceState({ ...window.history.state, rkStep: current.current }, "");
    const onPop = (event: PopStateEvent) => {
      const target: unknown = event.state?.rkStep;
      if (isStep(target)) handler.current(target);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    if (current.current === step) return;
    current.current = step;
    // Only add an entry when it is not already the one we are on (Back/Forward set it already).
    if (window.history.state?.rkStep !== step) {
      window.history.pushState({ ...window.history.state, rkStep: step }, "");
    }
  }, [step]);
}
