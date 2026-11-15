/**
 * Which stylists the calendar shows. The selection is a list of stylist ids where an empty list means
 * "everyone I may see". Kept free of React so the rules are unit tested.
 *
 * Two behaviours, because phones and desks need different things:
 * - "multi" (wide screens): chips toggle stylists on and off, so you can compare two or three columns.
 * - "single" (phones): chips behave as a switcher: one stylist at a time, or everyone.
 */
export type FilterMode = "single" | "multi";

/** Drop ids that are not selectable, and collapse "everyone ticked" back to the empty (= all) list. */
export function normaliseSelection(
  selected: readonly string[],
  allIds: readonly string[],
): string[] {
  const known = new Set(allIds);
  const kept = [...new Set(selected)].filter((id) => known.has(id));
  return kept.length === allIds.length ? [] : kept;
}

/** The stylists actually on screen: the selection, or everyone when nothing is selected. */
export function visibleStaffIds(selected: readonly string[], allIds: readonly string[]): string[] {
  const kept = normaliseSelection(selected, allIds);
  return kept.length === 0 ? [...allIds] : kept;
}

/** The new selection after a tap on a stylist chip. */
export function selectStaff(
  selected: readonly string[],
  id: string,
  allIds: readonly string[],
  mode: FilterMode,
): string[] {
  if (!allIds.includes(id)) return normaliseSelection(selected, allIds);
  if (mode === "single") return normaliseSelection([id], allIds);
  const current = normaliseSelection(selected, allIds);
  const next = current.includes(id) ? current.filter((s) => s !== id) : [...current, id];
  return normaliseSelection(next, allIds);
}

/** `staffIds` query value for the events endpoint, or undefined to ask for everyone. */
export function staffQuery(selected: readonly string[]): string | undefined {
  return selected.length === 0 ? undefined : selected.join(",");
}

/**
 * First paint, before anyone has touched the chips. A phone starts on one column (yours if you have
 * one) because several side-by-side lanes are too narrow to read; a wide screen starts on everyone.
 */
export function defaultSelection(options: {
  narrow: boolean;
  ownStaffId: string | null;
  allIds: readonly string[];
}): string[] {
  const { narrow, ownStaffId, allIds } = options;
  if (allIds.length <= 1) return [];
  if (!narrow) return [];
  if (ownStaffId && allIds.includes(ownStaffId)) return [ownStaffId];
  return [allIds[0]];
}

/**
 * Which stylist a new booking should start on. A stylist always books into their own column. For anyone
 * else it is the one person on screen, otherwise "" (first available).
 */
export function defaultCreateStaff(options: {
  seesAll: boolean;
  ownStaffId: string | null;
  selected: readonly string[];
  allIds: readonly string[];
}): string {
  const { seesAll, ownStaffId, selected, allIds } = options;
  if (!seesAll) return ownStaffId ?? "";
  const visible = visibleStaffIds(selected, allIds);
  return visible.length === 1 && allIds.length > 1 ? visible[0] : "";
}
