import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";
import { OPERATIONS, buildOpenApi, routeFileFor } from "@/server/api/openapi";

const ROOT = process.cwd();
const API_DIR = join(ROOT, "src/app/api/v1");

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return routeFiles(full);
    return name === "route.ts" ? [relative(ROOT, full)] : [];
  });
}

/** `METHOD file` for every HTTP handler a route file exports. */
function handlersOnDisk(): string[] {
  return routeFiles(API_DIR).flatMap((file) => {
    const source = readFileSync(join(ROOT, file), "utf8");
    return [...source.matchAll(/export\s+async\s+function\s+(GET|POST|PUT|PATCH|DELETE)\b/g)].map(
      (m) => `${m[1]} ${file}`,
    );
  });
}

describe("the OpenAPI registry matches the routes", () => {
  test("every route handler is documented", () => {
    const documented = new Set(
      OPERATIONS.map((o) => `${o.method.toUpperCase()} ${routeFileFor(o)}`),
    );
    const missing = handlersOnDisk().filter((h) => !documented.has(h));
    expect(
      missing,
      `Add these to OPERATIONS in src/server/api/openapi.ts:\n${missing.join("\n")}`,
    ).toEqual([]);
  });

  test("everything documented exists", () => {
    const onDisk = new Set(handlersOnDisk());
    const phantom = OPERATIONS.map((o) => `${o.method.toUpperCase()} ${routeFileFor(o)}`).filter(
      (h) => !onDisk.has(h),
    );
    expect(phantom, `Documented but not implemented:\n${phantom.join("\n")}`).toEqual([]);
  });

  test("operation ids are unique", () => {
    const ids = OPERATIONS.map((o) => o.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("docs/openapi.json", () => {
  test("is up to date: run `pnpm openapi` after changing an endpoint", () => {
    const committed = JSON.parse(readFileSync(join(ROOT, "docs/openapi.json"), "utf8"));
    expect(committed).toEqual(JSON.parse(JSON.stringify(buildOpenApi())));
  });

  const doc = JSON.parse(JSON.stringify(buildOpenApi())) as ReturnType<typeof buildOpenApi>;
  type Op = {
    operationId: string;
    parameters?: Array<{ name: string; in: string }>;
    responses: Record<string, unknown>;
    requestBody?: unknown;
    security?: unknown[];
  };
  const operations = Object.entries(doc.paths).flatMap(([path, methods]) =>
    Object.entries(methods).map(([method, op]) => ({ path, method, op: op as Op })),
  );

  test("is OpenAPI 3.1 with bearer auth by default", () => {
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.security).toEqual([{ bearerAuth: [] }]);
    expect(doc.components.securitySchemes.bearerAuth).toMatchObject({
      type: "http",
      scheme: "bearer",
    });
  });

  test("describes all the operations", () => {
    expect(operations).toHaveLength(OPERATIONS.length);
  });

  test("a path with {id} declares it, and only the sign-in call is open", () => {
    for (const { path, op } of operations) {
      if (path.includes("{id}")) {
        expect(op.parameters?.some((p) => p.name === "id" && p.in === "path")).toBe(true);
      }
      if (op.operationId === "signInWithGoogle") expect(op.security).toEqual([]);
      else expect(op.security).toBeUndefined();
    }
  });

  test("every operation documents success and the error shape, with its $ref resolvable", () => {
    for (const { op } of operations) {
      const success = Object.keys(op.responses).filter((k) => k.startsWith("2"));
      expect(success).toHaveLength(1);
      expect(op.responses["401"]).toBeTruthy();
      expect(JSON.stringify(op.responses["401"])).toContain("#/components/schemas/Error");
    }
    expect(doc.components.schemas.Error).toMatchObject({ type: "object" });
  });

  test("a body-taking operation has a request body, and a GET never does", () => {
    for (const { method, op } of operations) {
      if (method === "get") expect(op.requestBody).toBeUndefined();
    }
    expect(
      operations.find((o) => o.op.operationId === "createBooking")?.op.requestBody,
    ).toBeTruthy();
  });

  test("creating things answers 201", () => {
    const status = (id: string) =>
      Object.keys(operations.find((o) => o.op.operationId === id)?.op.responses ?? {}).find((k) =>
        k.startsWith("2"),
      );
    for (const id of [
      "createBooking",
      "startCardPayment",
      "setRosterException",
      "offerWaitlistSlot",
    ]) {
      expect(status(id)).toBe("201");
    }
    expect(status("me")).toBe("200");
  });
});
