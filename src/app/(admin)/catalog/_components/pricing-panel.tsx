"use client";

import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  formatDelta,
  type EffectiveRow,
  type LevelUsage,
  type PriceSource,
} from "@/server/admin-foundation/catalog-pricing";
import { formatCents } from "@/server/admin-foundation/money";

export interface LevelDraft {
  price: string;
  durationMin: string;
}

interface SeniorityCardProps {
  levels: readonly LevelUsage[];
  drafts: Record<number, LevelDraft>;
  onChange: (level: number, patch: Partial<LevelDraft>) => void;
  fieldErrors: Record<string, string>;
  /** The service's own price and duration, shown as the placeholder: blank means "use these". */
  servicePrice: string;
  serviceDuration: string;
}

const EMPTY: LevelDraft = { price: "", durationMin: "" };

/** One row per seniority level in use. Blank price or duration inherits the service's own. */
export function SeniorityCard({
  levels,
  drafts,
  onChange,
  fieldErrors,
  servicePrice,
  serviceDuration,
}: SeniorityCardProps) {
  return (
    <Card aria-labelledby="svc-seniority">
      <CardHeader title={<span id="svc-seniority">Seniority pricing</span>} eyebrow="By level" />
      <CardBody className="flex flex-col gap-4">
        {levels.length === 0 ? (
          <p className="text-sm text-ink-muted">
            No stylists yet. Add stylists and give them a level to price by seniority.
          </p>
        ) : (
          <>
            <p className="text-sm text-ink-muted">
              Set a price or time for everyone at a level. Leave a box blank to use the
              service&apos;s own ({servicePrice || "no price"}, {serviceDuration || "?"} min). A
              price set on one stylist below still wins over their level.
            </p>
            {levels.map((row, index) => {
              const draft = drafts[row.level] ?? EMPTY;
              // The form sends one entry per level in this order, so server errors are keyed by index.
              const errorBase = `levelPrices.${index}`;
              return (
                <fieldset key={row.level} className="grid gap-3 sm:grid-cols-[1fr_1fr_1fr]">
                  <legend className="sr-only">Level {row.level}</legend>
                  <div className="flex flex-col justify-center">
                    <span className="font-semibold">Level {row.level}</span>
                    <span className="text-sm text-ink-muted">
                      {row.unused ? (
                        <Badge tone="warning">No stylist at this level</Badge>
                      ) : (
                        row.staffNames.join(", ")
                      )}
                    </span>
                  </div>
                  <Input
                    label={`Price, level ${row.level}`}
                    prefix="$"
                    inputMode="decimal"
                    value={draft.price}
                    onChange={(e) => onChange(row.level, { price: e.target.value })}
                    error={fieldErrors[`${errorBase}.price`]}
                    placeholder={servicePrice}
                  />
                  <Input
                    label={`Duration, level ${row.level}`}
                    suffix="min"
                    type="number"
                    inputMode="numeric"
                    min={5}
                    step={5}
                    value={draft.durationMin}
                    onChange={(e) => onChange(row.level, { durationMin: e.target.value })}
                    error={fieldErrors[`${errorBase}.durationMin`]}
                    placeholder={serviceDuration}
                  />
                </fieldset>
              );
            })}
          </>
        )}
      </CardBody>
    </Card>
  );
}

const SOURCE_LABEL: Record<PriceSource, string> = {
  stylist: "their own",
  level: "level",
  service: "service",
};

interface EffectiveCardProps {
  rows: readonly EffectiveRow[];
}

/** What clients will actually pay and how long each stylist takes, so a mistake is obvious. */
export function EffectivePricesCard({ rows }: EffectiveCardProps) {
  return (
    <Card aria-labelledby="svc-effective">
      <CardHeader
        title={<span id="svc-effective">What each stylist charges</span>}
        eyebrow="Result"
      />
      <CardBody>
        {rows.length === 0 ? (
          <p className="text-sm text-ink-muted">
            Tick who offers this service and their price shows here.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[28rem] text-left text-sm">
              <caption className="sr-only">
                Effective price and duration per stylist, and where each value comes from
              </caption>
              <thead>
                <tr className="border-b border-line text-ink-muted">
                  <th scope="col" className="py-2 pr-3 font-semibold">
                    Stylist
                  </th>
                  <th scope="col" className="py-2 pr-3 font-semibold">
                    Price
                  </th>
                  <th scope="col" className="py-2 pr-3 font-semibold">
                    Time
                  </th>
                  <th scope="col" className="py-2 font-semibold">
                    Check
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.staffId} className="border-b border-line last:border-b-0">
                    <th scope="row" className="py-2 pr-3 font-semibold">
                      {row.name}
                      <span className="block text-xs font-normal text-ink-muted">
                        Level {row.level}
                      </span>
                    </th>
                    <td className="tabular py-2 pr-3">
                      <span className="font-semibold">{formatCents(row.priceCents)}</span>
                      <span className="block text-xs text-ink-muted">
                        {SOURCE_LABEL[row.priceSource]}
                        {formatDelta(row.priceDeltaCents, "money")
                          ? ` · ${formatDelta(row.priceDeltaCents, "money")}`
                          : ""}
                      </span>
                    </td>
                    <td className="tabular py-2 pr-3">
                      <span className="font-semibold">{row.durationMin} min</span>
                      <span className="block text-xs text-ink-muted">
                        {SOURCE_LABEL[row.durationSource]}
                        {formatDelta(row.durationDeltaMin, "minutes")
                          ? ` · ${formatDelta(row.durationDeltaMin, "minutes")}`
                          : ""}
                      </span>
                    </td>
                    <td className="py-2">
                      {row.warnings.length === 0 ? (
                        <span className="text-ink-muted">OK</span>
                      ) : (
                        row.warnings.map((w) => (
                          <Badge key={w} tone="warning">
                            {w}
                          </Badge>
                        ))
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardBody>
    </Card>
  );
}
