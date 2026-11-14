"use client";

import { useRouter } from "next/navigation";
import { useCallback, useState, useTransition } from "react";
import { useToast } from "@/components/ui/toast";
import type { ActionResult } from "@/server/admin-foundation/action";

interface SubmitOptions<T> {
  /** Toast shown on success. */
  success: string;
  /** Runs after a successful save (navigate, close a dialog...). */
  onSuccess?: (data: T | undefined) => void;
  /** Refresh server data after success (default true). */
  refresh?: boolean;
}

export interface SubmitState {
  pending: boolean;
  /** Form-level error message from the server. */
  error: string | null;
  /** Field-level messages keyed by input path, e.g. "name" or "intakeQuestions.0.label". */
  fieldErrors: Record<string, string>;
  submit: <T>(run: () => Promise<ActionResult<T>>, options: SubmitOptions<T>) => void;
  clearErrors: () => void;
}

/**
 * Runs a server action in a transition and turns its result into toast + field errors.
 * Keeps every admin form behaving the same: inputs stay editable, errors are announced, success toasts.
 */
export function useSubmit(): SubmitState {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const router = useRouter();
  const { toast } = useToast();

  const clearErrors = useCallback(() => {
    setError(null);
    setFieldErrors({});
  }, []);

  const submit = useCallback(
    <T>(run: () => Promise<ActionResult<T>>, options: SubmitOptions<T>) => {
      clearErrors();
      startTransition(async () => {
        let result: ActionResult<T>;
        try {
          result = await run();
        } catch {
          setError("We couldn't reach the server. Check your connection and try again.");
          toast({ title: "Not saved", description: "Check your connection.", tone: "danger" });
          return;
        }
        if (!result.ok) {
          setError(result.error);
          setFieldErrors(result.fieldErrors ?? {});
          toast({ title: "Not saved", description: result.error, tone: "danger" });
          return;
        }
        toast({ title: options.success, tone: "success" });
        if (options.refresh !== false) router.refresh();
        options.onSuccess?.(result.data);
      });
    },
    [clearErrors, router, toast],
  );

  return { pending, error, fieldErrors, submit, clearErrors };
}
