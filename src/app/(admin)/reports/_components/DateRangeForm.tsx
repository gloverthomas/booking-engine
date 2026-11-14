import type { RangePreset } from "@/server/reports";
import { queryString, type ResolvedParams } from "../_lib/page-data";
import { Button, Field, Input, Select } from "../ui-shim";
import Link from "next/link";

interface DateRangeFormProps {
  /** Path of the current report, e.g. "/reports/revenue". The form submits back to it with GET. */
  path: string;
  params: ResolvedParams;
  presets: RangePreset[];
  /** Offer the by day / week / month picker. */
  granularity?: boolean;
  /** Offer the group by location / service picker. */
  groupBy?: boolean;
}

/** Date range picker: two date fields, quick presets, and optional grouping. A plain GET form, so it needs no JavaScript. */
export function DateRangeForm({ path, params, presets, granularity, groupBy }: DateRangeFormProps) {
  return (
    <section className="rpt-range" aria-label="Date range">
      <form method="get" action={path}>
        <Field label="From">
          <Input type="date" name="from" defaultValue={params.from} required max="9999-12-31" />
        </Field>
        <Field label="To">
          <Input type="date" name="to" defaultValue={params.to} required max="9999-12-31" />
        </Field>
        {granularity ? (
          <Field label="Group by period">
            <Select name="granularity" defaultValue={params.granularity}>
              <option value="day">Day</option>
              <option value="week">Week</option>
              <option value="month">Month</option>
            </Select>
          </Field>
        ) : (
          <input type="hidden" name="granularity" value={params.granularity} />
        )}
        {groupBy ? (
          <Field label="Split by">
            <Select name="groupBy" defaultValue={params.groupBy}>
              <option value="none">Nothing</option>
              <option value="location">Location</option>
              <option value="service">Service</option>
            </Select>
          </Field>
        ) : (
          <input type="hidden" name="groupBy" value={params.groupBy} />
        )}
        <Button type="submit">Apply</Button>
      </form>
      <div className="rpt-presets" role="group" aria-label="Quick ranges">
        {presets.map((preset) => (
          <Link
            key={preset.id}
            className="rpt-chip"
            href={`${path}?${queryString(params, { from: preset.from, to: preset.to })}`}
            aria-current={
              preset.from === params.from && preset.to === params.to ? "true" : undefined
            }
          >
            {preset.label}
          </Link>
        ))}
      </div>
    </section>
  );
}
