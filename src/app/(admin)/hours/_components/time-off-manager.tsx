"use client";

import { useState, type FormEvent } from "react";
import { Trash2 } from "lucide-react";
import { useSubmit } from "@/components/admin/shell/use-submit";
import { useToast } from "@/components/ui/toast";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { createTimeBlockAction, deleteTimeBlockAction } from "../actions";

export interface TimeBlockView {
  id: string;
  staffName: string;
  /** Already formatted in the business timezone. */
  label: string;
  reason: string | null;
}

interface TimeOffManagerProps {
  staff: Array<{ id: string; name: string }>;
  blocks: TimeBlockView[];
  defaultStaffId: string;
  /** "YYYY-MM-DDTHH:mm" in the business timezone, to prefill the form. */
  defaultStart: string;
  defaultEnd: string;
}

/** Time off and blocked time: leave, appointments elsewhere. Imported Google busy time is not listed here. */
export function TimeOffManager({
  staff,
  blocks,
  defaultStaffId,
  defaultStart,
  defaultEnd,
}: TimeOffManagerProps) {
  const { pending, error, fieldErrors, submit } = useSubmit();
  const { toast } = useToast();
  const [staffId, setStaffId] = useState(defaultStaffId);
  const [start, setStart] = useState(defaultStart);
  const [end, setEnd] = useState(defaultEnd);
  const [reason, setReason] = useState("");

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    submit(() => createTimeBlockAction({ staffId, start, end, reason }), {
      success: "Time blocked",
      onSuccess: (data) => {
        setReason("");
        if (data && data.conflictingBookings > 0) {
          toast({
            title: `${data.conflictingBookings} existing booking${data.conflictingBookings === 1 ? "" : "s"} overlap this time`,
            description: "They have not been moved or cancelled. Review them in Bookings.",
            tone: "info",
          });
        }
      },
    });
  }

  return (
    <Card aria-labelledby="time-off-title">
      <CardHeader
        eyebrow="Leave and blocked time"
        title={<span id="time-off-title">Time off</span>}
      />
      <CardBody className="flex flex-col gap-6">
        <form onSubmit={onSubmit} noValidate className="grid gap-4 sm:grid-cols-2">
          {error ? (
            <Alert tone="danger" className="sm:col-span-2">
              {error}
            </Alert>
          ) : null}
          {staff.length > 1 ? (
            <Select
              label="Stylist"
              value={staffId}
              onChange={(e) => setStaffId(e.target.value)}
              error={fieldErrors.staffId}
              wrapperClassName="sm:col-span-2"
            >
              {staff.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          ) : null}
          <Input
            label="From"
            type="datetime-local"
            required
            value={start}
            onChange={(e) => setStart(e.target.value)}
            error={fieldErrors.start}
          />
          <Input
            label="To"
            type="datetime-local"
            required
            value={end}
            onChange={(e) => setEnd(e.target.value)}
            error={fieldErrors.end}
          />
          <Input
            label="Reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            error={fieldErrors.reason}
            placeholder="Holiday, dentist, training…"
            hint="Only you see this."
            wrapperClassName="sm:col-span-2"
          />
          <div className="sm:col-span-2">
            <Button type="submit" loading={pending}>
              Block this time
            </Button>
          </div>
        </form>

        <div>
          <h3 className="eyebrow mb-2">Upcoming</h3>
          {blocks.length === 0 ? (
            <EmptyState
              title="Nothing blocked"
              description="Blocked time stops clients booking over it."
            />
          ) : (
            <ul className="divide-y divide-line rounded-card border border-line">
              {blocks.map((block) => (
                <TimeBlockRow key={block.id} block={block} showStaff={staff.length > 1} />
              ))}
            </ul>
          )}
        </div>
      </CardBody>
    </Card>
  );
}

function TimeBlockRow({ block, showStaff }: { block: TimeBlockView; showStaff: boolean }) {
  const { pending, submit } = useSubmit();
  return (
    <li className="flex items-center justify-between gap-3 px-4 py-2">
      <div className="min-w-0">
        <p className="font-semibold">{block.label}</p>
        <p className="truncate text-sm text-ink-muted">
          {[showStaff ? block.staffName : null, block.reason].filter(Boolean).join(" · ") ||
            "No reason given"}
        </p>
      </div>
      <Button
        variant="ghost"
        loading={pending}
        aria-label={`Remove blocked time ${block.label}`}
        onClick={() => submit(() => deleteTimeBlockAction(block.id), { success: "Block removed" })}
      >
        <Trash2 aria-hidden className="size-4" />
      </Button>
    </li>
  );
}
