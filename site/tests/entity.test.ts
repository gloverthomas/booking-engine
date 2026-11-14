import { describe, expect, test } from "vitest";
import { TBC, entityConfigured, readEntity } from "@/lib/entity";

describe("entity", () => {
  test("missing values read as 'to be confirmed' and the site is not configured", () => {
    const e = readEntity({});
    expect(Object.values(e).every((v) => v === TBC)).toBe(true);
    expect(entityConfigured(e)).toBe(false);
  });

  test("a partly filled entity is still not configured; fully filled is", () => {
    expect(entityConfigured(readEntity({ ENTITY_LEGAL_NAME: "Ryan Kennedy" }))).toBe(false);
    const full = readEntity({
      ENTITY_LEGAL_NAME: " Ryan Kennedy ",
      ENTITY_ABN: "11 111 111 111",
      ENTITY_TRADING_NAME: "Ryan Kennedy Hairdressing",
      ENTITY_ADDRESS: "1 Example St, Carlton North VIC 3054",
    });
    expect(full.legalName).toBe("Ryan Kennedy");
    expect(entityConfigured(full)).toBe(true);
  });

  test("blank strings count as missing", () => {
    expect(readEntity({ ENTITY_ABN: "   " }).abn).toBe(TBC);
  });
});
