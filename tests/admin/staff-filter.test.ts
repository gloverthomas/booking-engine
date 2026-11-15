import { describe, expect, test } from "vitest";
import {
  defaultCreateStaff,
  defaultSelection,
  normaliseSelection,
  selectStaff,
  staffQuery,
  visibleStaffIds,
} from "@/components/admin/calendar/staff-filter";

const ALL = ["a", "b", "c"];

describe("normaliseSelection / visibleStaffIds", () => {
  test("drops unknown and duplicate ids", () => {
    expect(normaliseSelection(["a", "a", "zzz"], ALL)).toEqual(["a"]);
  });

  test("everyone ticked collapses to the empty (= all) selection", () => {
    expect(normaliseSelection(["c", "a", "b"], ALL)).toEqual([]);
  });

  test("an empty selection shows everyone", () => {
    expect(visibleStaffIds([], ALL)).toEqual(ALL);
    expect(visibleStaffIds(["b"], ALL)).toEqual(["b"]);
    expect(visibleStaffIds(["gone"], ALL)).toEqual(ALL);
  });
});

describe("selectStaff", () => {
  test("multi: tapping from All focuses that person, more taps add and remove", () => {
    let sel = selectStaff([], "a", ALL, "multi");
    expect(sel).toEqual(["a"]);
    sel = selectStaff(sel, "b", ALL, "multi");
    expect(sel).toEqual(["a", "b"]);
    sel = selectStaff(sel, "a", ALL, "multi");
    expect(sel).toEqual(["b"]);
  });

  test("multi: removing the last person goes back to All, and ticking everyone is All", () => {
    expect(selectStaff(["a"], "a", ALL, "multi")).toEqual([]);
    expect(selectStaff(["a", "b"], "c", ALL, "multi")).toEqual([]);
  });

  test("single (phone switcher): each tap shows exactly that person", () => {
    expect(selectStaff([], "b", ALL, "single")).toEqual(["b"]);
    expect(selectStaff(["a"], "b", ALL, "single")).toEqual(["b"]);
    expect(selectStaff(["b"], "b", ALL, "single")).toEqual(["b"]);
  });

  test("a single-person team always normalises to All", () => {
    expect(selectStaff([], "a", ["a"], "single")).toEqual([]);
  });

  test("an unknown id leaves the selection alone", () => {
    expect(selectStaff(["a"], "zzz", ALL, "multi")).toEqual(["a"]);
  });
});

describe("staffQuery", () => {
  test("nothing selected means no filter, otherwise a comma list", () => {
    expect(staffQuery([])).toBeUndefined();
    expect(staffQuery(["a", "b"])).toBe("a,b");
  });
});

describe("defaultSelection", () => {
  test("wide screens and one-person teams start on everyone", () => {
    expect(defaultSelection({ narrow: false, ownStaffId: "a", allIds: ALL })).toEqual([]);
    expect(defaultSelection({ narrow: true, ownStaffId: "a", allIds: ["a"] })).toEqual([]);
  });

  test("a phone starts on your own column when you have one, else the first stylist", () => {
    expect(defaultSelection({ narrow: true, ownStaffId: "b", allIds: ALL })).toEqual(["b"]);
    expect(defaultSelection({ narrow: true, ownStaffId: null, allIds: ALL })).toEqual(["a"]);
    expect(defaultSelection({ narrow: true, ownStaffId: "zzz", allIds: ALL })).toEqual(["a"]);
  });
});

describe("defaultCreateStaff", () => {
  test("a stylist books into their own column", () => {
    expect(
      defaultCreateStaff({ seesAll: false, ownStaffId: "b", selected: [], allIds: ["b"] }),
    ).toBe("b");
  });

  test("others get the one person on screen, or first available", () => {
    expect(
      defaultCreateStaff({ seesAll: true, ownStaffId: null, selected: ["c"], allIds: ALL }),
    ).toBe("c");
    expect(defaultCreateStaff({ seesAll: true, ownStaffId: null, selected: [], allIds: ALL })).toBe(
      "",
    );
    expect(
      defaultCreateStaff({ seesAll: true, ownStaffId: null, selected: ["a", "b"], allIds: ALL }),
    ).toBe("");
  });

  test("a one-person team never forces a request", () => {
    expect(
      defaultCreateStaff({ seesAll: true, ownStaffId: null, selected: [], allIds: ["a"] }),
    ).toBe("");
  });
});
