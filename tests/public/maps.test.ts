import { describe, expect, test } from "vitest";
import {
  mapQuery,
  mapsDirectionsUrl,
  mapsEmbedUrl,
  mapsSearchUrl,
} from "@/components/public/flow/maps";

const northside = {
  name: "Northside (Lola Fortune)",
  addressLine: "302 Rathdowne Street",
  suburb: "Carlton North",
  state: "VIC",
  postcode: "3054",
};

describe("map helpers", () => {
  test("builds a full address query ending in Australia", () => {
    expect(mapQuery(northside)).toBe("302 Rathdowne Street, Carlton North VIC 3054, Australia");
  });

  test("tolerates a missing locality and returns null with no street address", () => {
    expect(mapQuery({ ...northside, suburb: null, state: null, postcode: null })).toBe(
      "302 Rathdowne Street, Australia",
    );
    expect(mapQuery({ ...northside, addressLine: null })).toBeNull();
  });

  test("search and directions links encode the address", () => {
    const q = "302 Rathdowne Street, Carlton North VIC 3054, Australia";
    expect(mapsSearchUrl(q)).toBe(
      "https://www.google.com/maps/search/?api=1&query=302%20Rathdowne%20Street%2C%20Carlton%20North%20VIC%203054%2C%20Australia",
    );
    expect(mapsDirectionsUrl(q)).toContain("/maps/dir/?api=1&destination=302%20Rathdowne");
  });

  test("the embedded map needs a key; without one it is null", () => {
    expect(mapsEmbedUrl("x", undefined)).toBeNull();
    expect(mapsEmbedUrl("x", "  ")).toBeNull();
    expect(mapsEmbedUrl("a b", "KEY123")).toBe(
      "https://www.google.com/maps/embed/v1/place?key=KEY123&q=a%20b",
    );
  });
});
