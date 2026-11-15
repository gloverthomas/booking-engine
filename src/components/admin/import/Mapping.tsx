import { Select } from "@/components/ui/select";
import type { ImportReport } from "@/server/import";
import { label, type Choice, type WizardOptions } from "./labels";

interface MappingProps {
  report: ImportReport;
  onChange: (field: string, header: string | null) => void;
}

/** Which column of the file feeds which field. Detected automatically; change anything that is wrong. */
export function ColumnMapping({ report, onChange }: MappingProps) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {report.fields.map((field) => (
        <Select
          key={field}
          label={label(field)}
          value={report.mapping[field] ?? ""}
          onChange={(e) => onChange(field, e.target.value || null)}
        >
          <option value="">Not in my file</option>
          {report.headers.map((header) => (
            <option key={header} value={header}>
              {header}
            </option>
          ))}
        </Select>
      ))}
    </div>
  );
}

interface NamesProps {
  report: ImportReport;
  staff: readonly Choice[];
  locations: readonly Choice[];
  options: WizardOptions;
  onChange: (next: WizardOptions) => void;
}

/** Names in the file that matched nobody in the system, each with a picker. */
export function UnmappedNames({ report, staff, locations, options, onChange }: NamesProps) {
  const { unmapped } = report;
  if (unmapped.staff.length + unmapped.locations.length === 0) return null;
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {unmapped.staff.map((n) => (
        <Select
          key={`s-${n.key}`}
          label={`Stylist "${n.name}" (${n.rows} rows)`}
          value={options.staffMap[n.key] ?? ""}
          onChange={(e) =>
            onChange({ ...options, staffMap: { ...options.staffMap, [n.key]: e.target.value } })
          }
        >
          <option value="">Choose who this is</option>
          {staff.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
      ))}
      {unmapped.locations.map((n) => (
        <Select
          key={`l-${n.key}`}
          label={`Location "${n.name}" (${n.rows} rows)`}
          value={options.locationMap[n.key] ?? ""}
          onChange={(e) =>
            onChange({
              ...options,
              locationMap: { ...options.locationMap, [n.key]: e.target.value },
            })
          }
        >
          <option value="">Choose the location</option>
          {locations.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </Select>
      ))}
    </div>
  );
}
