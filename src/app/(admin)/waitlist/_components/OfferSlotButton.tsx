"use client";

import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import { useSubmit } from "@/components/admin/shell/use-submit";
import { offerSlotAction } from "../actions";

interface OfferSlotButtonProps {
  entryId: string;
  staffId: string;
  /** ISO instants. */
  start: string;
  end: string;
  /** For the accessible name, e.g. "Mon 2 Nov 10:00 am with Ryan". */
  label: string;
}

export function OfferSlotButton({ entryId, staffId, start, end, label }: OfferSlotButtonProps) {
  const router = useRouter();
  const { pending, submit } = useSubmit();
  return (
    <Button
      size="sm"
      loading={pending}
      aria-label={`Offer ${label}`}
      onClick={() =>
        submit(() => offerSlotAction({ entryId, staffId, start, end }), {
          success: "Offer sent",
          onSuccess: () => router.push("/waitlist"),
        })
      }
    >
      Send offer
    </Button>
  );
}
