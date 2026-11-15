"use client";

import { Button } from "@/components/ui";
import { useSubmit } from "@/components/admin/shell/use-submit";
import { approveEntriesAction } from "../actions";

/** Approves the given finished entries (one, or everything waiting for a person that week). */
export function ApproveButton({
  entryIds,
  label,
  size = "sm",
}: {
  entryIds: string[];
  label: string;
  size?: "sm" | "md";
}) {
  const { pending, error, submit } = useSubmit();
  return (
    <span className="inline-flex flex-col gap-1">
      <Button
        type="button"
        size={size}
        variant="secondary"
        loading={pending}
        onClick={() =>
          submit(() => approveEntriesAction({ entryIds }), { success: "Approved" })
        }
      >
        {label}
      </Button>
      {error ? (
        <span role="alert" className="text-xs text-danger">
          {error}
        </span>
      ) : null}
    </span>
  );
}
