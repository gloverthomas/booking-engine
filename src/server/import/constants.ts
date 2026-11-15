/** Bookings created by an import carry `booking.source = "import:<system>"`. */
export const IMPORT_SOURCE_PREFIX = "import:";
export const TIMELY_SOURCE = `${IMPORT_SOURCE_PREFIX}timely`;

export function isImportedSource(source: string | null | undefined): boolean {
  return Boolean(source?.startsWith(IMPORT_SOURCE_PREFIX));
}
