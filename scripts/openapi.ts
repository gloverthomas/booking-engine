import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildOpenApi } from "../src/server/api/openapi";

/** Writes docs/openapi.json. Run after changing an endpoint; a test fails when the file is stale. */
const target = resolve(__dirname, "../docs/openapi.json");
writeFileSync(target, `${JSON.stringify(buildOpenApi(), null, 2)}\n`);
console.log(`Wrote ${target}`);
