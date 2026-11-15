"use client";

import { useState } from "react";
import { useSubmit } from "@/components/admin/shell/use-submit";
import {
  Button,
  Dialog,
  EmptyState,
  Input,
  Select,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from "@/components/ui";
import { TARGET_METRIC_LABEL, TARGET_METRICS, type TargetMetric } from "@/server/targets/units";
import { createTargetAction, deleteTargetAction, updateTargetAction } from "../actions";

export interface TargetView {
  id: string;
  staffId: string | null;
  staffName: string | null;
  metric: TargetMetric;
  period: "week" | "month";
  /** Display text, e.g. "$4,000.00" or "75%". */
  valueText: string;
  /** Text for the input box, e.g. "4000.00" or "75". */
  inputValue: string;
  validFrom: string;
  validTo: string | null;
}

const UNIT_HINT: Record<TargetMetric, string> = {
  revenue: "Dollars, like 4000",
  bookings: "A whole number of appointments",
  rebook_rate: "A percentage, like 60",
  utilisation: "A percentage, like 75",
};

/** Targets for each person or the whole business. Owner and managers only (the server checks too). */
export function TargetsManager({
  targets,
  staff,
  today,
}: {
  targets: TargetView[];
  staff: Array<{ id: string; name: string }>;
  today: string;
}) {
  const [editing, setEditing] = useState<TargetView | "new" | null>(null);
  const [deleting, setDeleting] = useState<TargetView | null>(null);
  const [metric, setMetric] = useState<TargetMetric>("revenue");
  const form = useSubmit();
  const del = useSubmit();

  function openForm(target: TargetView | "new") {
    form.clearErrors();
    setMetric(target === "new" ? "revenue" : target.metric);
    setEditing(target);
  }

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const text = (key: string) => String(data.get(key) ?? "");
    const payload = {
      staffId: text("staffId") || null,
      metric: text("metric"),
      period: text("period"),
      targetValue: text("targetValue"),
      validFrom: text("validFrom"),
      validTo: text("validTo") || null,
    };
    const current = editing;
    form.submit(
      () =>
        current && current !== "new"
          ? updateTargetAction({ ...payload, id: current.id })
          : createTargetAction(payload),
      { success: "Target saved", onSuccess: () => setEditing(null) },
    );
  }

  const editingTarget = editing && editing !== "new" ? editing : null;
  const fe = form.fieldErrors;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <Button type="button" onClick={() => openForm("new")}>
          Add a target
        </Button>
      </div>
      {targets.length === 0 ? (
        <EmptyState
          title="No targets yet"
          description="Add a weekly or monthly goal for a stylist, or for the whole business."
        />
      ) : (
        <Table caption="Targets">
          <THead>
            <TR>
              <TH>Who</TH>
              <TH>Measure</TH>
              <TH>Period</TH>
              <TH className="text-right">Target</TH>
              <TH>From</TH>
              <TH>Until</TH>
              <TH>
                <span className="sr-only">Actions</span>
              </TH>
            </TR>
          </THead>
          <TBody>
            {targets.map((t) => (
              <TR key={t.id}>
                <TD className="font-semibold">{t.staffName ?? "Whole business"}</TD>
                <TD>{TARGET_METRIC_LABEL[t.metric]}</TD>
                <TD>{t.period === "week" ? "Weekly" : "Monthly"}</TD>
                <TD className="text-right tabular-nums">{t.valueText}</TD>
                <TD className="tabular-nums">{t.validFrom}</TD>
                <TD className="tabular-nums">{t.validTo ?? "Open ended"}</TD>
                <TD>
                  <div className="flex gap-1">
                    <Button type="button" size="sm" variant="ghost" onClick={() => openForm(t)}>
                      Edit
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        del.clearErrors();
                        setDeleting(t);
                      }}
                    >
                      Delete
                    </Button>
                  </div>
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}

      <Dialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editingTarget ? "Edit target" : "Add a target"}
        description="One target per person, measure and period at a time. Revenue is cash received."
      >
        {editing !== null ? (
          <form onSubmit={onSubmit} className="flex flex-col gap-3" noValidate>
            <Select
              name="staffId"
              label="Who"
              defaultValue={editingTarget?.staffId ?? ""}
              error={fe.staffId}
            >
              <option value="">Whole business</option>
              {staff.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
            <Select
              name="metric"
              label="Measure"
              value={metric}
              onChange={(e) => setMetric(e.target.value as TargetMetric)}
              error={fe.metric}
            >
              {TARGET_METRICS.map((m) => (
                <option key={m} value={m}>
                  {TARGET_METRIC_LABEL[m]}
                </option>
              ))}
            </Select>
            <Select
              name="period"
              label="Period"
              defaultValue={editingTarget?.period ?? "month"}
              error={fe.period}
            >
              <option value="week">Weekly</option>
              <option value="month">Monthly</option>
            </Select>
            <Input
              name="targetValue"
              label="Target"
              required
              defaultValue={editingTarget?.inputValue ?? ""}
              hint={UNIT_HINT[metric]}
              prefix={metric === "revenue" ? "$" : undefined}
              suffix={metric === "rebook_rate" || metric === "utilisation" ? "%" : undefined}
              error={fe.targetValue}
            />
            <Input
              name="validFrom"
              label="Starts"
              type="date"
              required
              defaultValue={editingTarget?.validFrom ?? today}
              error={fe.validFrom}
            />
            <Input
              name="validTo"
              label="Ends (optional)"
              type="date"
              defaultValue={editingTarget?.validTo ?? ""}
              error={fe.validTo}
            />
            {form.error ? (
              <p role="alert" className="text-sm text-danger">
                {form.error}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setEditing(null)}>
                Cancel
              </Button>
              <Button type="submit" loading={form.pending}>
                Save target
              </Button>
            </div>
          </form>
        ) : null}
      </Dialog>

      <Dialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title="Delete this target?"
        description={
          deleting
            ? `${deleting.staffName ?? "Whole business"}, ${TARGET_METRIC_LABEL[deleting.metric]}, ${deleting.valueText}. Past performance is not affected.`
            : undefined
        }
        footer={
          <>
            <Button type="button" variant="secondary" onClick={() => setDeleting(null)}>
              Keep it
            </Button>
            <Button
              type="button"
              variant="danger"
              loading={del.pending}
              onClick={() => {
                const target = deleting;
                if (!target) return;
                del.submit(() => deleteTargetAction({ id: target.id }), {
                  success: "Target deleted",
                  onSuccess: () => setDeleting(null),
                });
              }}
            >
              Delete target
            </Button>
          </>
        }
      >
        {del.error ? (
          <p role="alert" className="text-sm text-danger">
            {del.error}
          </p>
        ) : null}
      </Dialog>
    </div>
  );
}
