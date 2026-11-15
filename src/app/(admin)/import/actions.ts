"use server";

import { importRequestSchema, runImport } from "@/server/import";
import { accessAction } from "@/server/auth/run-action";

/** Dry run (the default) reports what would happen; `dryRun: false` applies it. Owner only. */
export async function runImportAction(input: unknown) {
  return accessAction("data.import", importRequestSchema, input, (parsed, { db, actor }) =>
    runImport(db, parsed, { actor }),
  );
}
