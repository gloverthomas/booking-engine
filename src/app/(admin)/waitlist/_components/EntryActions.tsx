"use client";

import { useState } from "react";
import { Button } from "@/components/ui";
import { useSubmit } from "@/components/admin/shell/use-submit";
import { removeEntryAction } from "../actions";

/** Remove an entry: the first press asks, the second confirms (nothing is deleted from history). */
export function RemoveEntryButton({ entryId, name }: { entryId: string; name: string }) {
  const [confirming, setConfirming] = useState(false);
  const { pending, submit } = useSubmit();

  if (!confirming) {
    return (
      <Button variant="ghost" size="sm" onClick={() => setConfirming(true)}>
        Remove
      </Button>
    );
  }
  return (
    <span
      className="inline-flex gap-2"
      role="group"
      aria-label={`Remove ${name} from the waitlist`}
    >
      <Button
        variant="danger"
        size="sm"
        loading={pending}
        onClick={() =>
          submit(() => removeEntryAction({ entryId }), {
            success: `${name} removed from the waitlist`,
            onSuccess: () => setConfirming(false),
          })
        }
      >
        Confirm remove
      </Button>
      <Button variant="secondary" size="sm" disabled={pending} onClick={() => setConfirming(false)}>
        Keep
      </Button>
    </span>
  );
}
