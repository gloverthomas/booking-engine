import { DateTime } from "luxon";
import { describe, expect, test } from "vitest";
import {
  computeSlots,
  windowsForDate,
  type Candidate,
  type DayException,
  type EngineInput,
  type WeeklyRule,
} from "@/server/availability/engine";

const ZONE = "Australia/Melbourne";
const local = (iso: string): Date => DateTime.fromISO(iso, { zone: ZONE }).toJSDate();
const localTime = (d: Date): string => DateTime.fromJSDate(d, { zone: ZONE }).toFormat("HH:mm");

const NINE_TO_FIVE: WeeklyRule = {
  weekday: 1,
  startMinute: 540,
  endMinute: 1020,
  validFrom: null,
  validTo: null,
};
const MONDAY = "2026-11-02";

const off = (date: string): DayException => ({
  date,
  kind: "off",
  startMinute: null,
  endMinute: null,
});
const custom = (date: string, startMinute: number, endMinute: number): DayException => ({
  date,
  kind: "custom",
  startMinute,
  endMinute,
});

function input(
  exceptions: DayException[],
  overrides: Partial<EngineInput> = {},
  candidate: Partial<Candidate> = {},
): EngineInput {
  return {
    timezone: ZONE,
    fromDate: MONDAY,
    toDate: MONDAY,
    now: local("2026-11-01T08:00"),
    slotStepMin: 15,
    minNoticeMin: 0,
    maxAdvanceDays: 400,
    candidates: [
      {
        staffId: "s1",
        durationMin: 45,
        bufferMin: 0,
        rules: [NINE_TO_FIVE],
        exceptions,
        busy: [],
        ...candidate,
      },
    ],
    ...overrides,
  };
}

const starts = (slots: ReturnType<typeof computeSlots>) => slots.map((s) => localTime(s.start));

describe("windowsForDate", () => {
  test("returns the weekly rules when there is no exception for the date", () => {
    expect(windowsForDate([NINE_TO_FIVE], [off("2026-11-09")], 1, MONDAY)).toEqual([
      { startMinute: 540, endMinute: 1020 },
    ]);
  });

  test("an off exception removes the day", () => {
    expect(windowsForDate([NINE_TO_FIVE], [off(MONDAY)], 1, MONDAY)).toEqual([]);
  });

  test("a custom exception replaces the weekly rules for that date", () => {
    expect(windowsForDate([NINE_TO_FIVE], [custom(MONDAY, 600, 720)], 1, MONDAY)).toEqual([
      { startMinute: 600, endMinute: 720 },
    ]);
  });

  test("a custom exception opens a day that has no weekly rule", () => {
    expect(
      windowsForDate([NINE_TO_FIVE], [custom("2026-11-03", 600, 720)], 2, "2026-11-03"),
    ).toEqual([{ startMinute: 600, endMinute: 720 }]);
  });

  test("an off exception wins over a custom one on the same date", () => {
    expect(
      windowsForDate([NINE_TO_FIVE], [custom(MONDAY, 600, 720), off(MONDAY)], 1, MONDAY),
    ).toEqual([]);
  });

  test("several custom exceptions on one date are all kept", () => {
    const windows = windowsForDate(
      [NINE_TO_FIVE],
      [custom(MONDAY, 480, 600), custom(MONDAY, 840, 960)],
      1,
      MONDAY,
    );
    expect(windows).toEqual([
      { startMinute: 480, endMinute: 600 },
      { startMinute: 840, endMinute: 960 },
    ]);
  });

  test("a malformed custom exception closes the day rather than opening it", () => {
    const broken: DayException = {
      date: MONDAY,
      kind: "custom",
      startMinute: null,
      endMinute: null,
    };
    expect(windowsForDate([NINE_TO_FIVE], [broken], 1, MONDAY)).toEqual([]);
  });

  test("weekly rules keep honouring validFrom and validTo", () => {
    const bounded: WeeklyRule = { ...NINE_TO_FIVE, validFrom: "2026-11-09", validTo: null };
    expect(windowsForDate([bounded], [], 1, MONDAY)).toEqual([]);
    expect(windowsForDate([bounded], [], 1, "2026-11-09")).toHaveLength(1);
  });

  test("a custom exception applies even outside a rule's validity window", () => {
    const bounded: WeeklyRule = { ...NINE_TO_FIVE, validFrom: "2026-12-01", validTo: null };
    expect(windowsForDate([bounded], [custom(MONDAY, 600, 660)], 1, MONDAY)).toEqual([
      { startMinute: 600, endMinute: 660 },
    ]);
  });
});

describe("computeSlots with roster exceptions", () => {
  test("a day off yields no slots that day but leaves other weeks alone", () => {
    const week = input([off(MONDAY)], { toDate: "2026-11-09" });
    const result = computeSlots(week);
    expect(result).not.toHaveLength(0);
    expect(result.every((s) => s.start >= local("2026-11-09T00:00"))).toBe(true);
  });

  test("custom hours replace the weekly hours", () => {
    const slots = computeSlots(input([custom(MONDAY, 600, 720)]));
    expect(starts(slots)[0]).toBe("10:00");
    expect(starts(slots).at(-1)).toBe("11:15");
    expect(starts(slots)).not.toContain("09:00");
  });

  test("custom hours can extend past the weekly hours", () => {
    const slots = computeSlots(input([custom(MONDAY, 480, 1140)]));
    expect(starts(slots)[0]).toBe("08:00");
    expect(starts(slots).at(-1)).toBe("18:15");
  });

  test("busy time still removes slots inside custom hours", () => {
    const busy = [{ start: local("2026-11-02T10:00"), end: local("2026-11-02T10:45") }];
    const slots = computeSlots(input([custom(MONDAY, 600, 720)], {}, { busy }));
    expect(starts(slots)).not.toContain("10:00");
    expect(starts(slots)).toContain("10:45");
  });

  test("candidates without exceptions behave as before", () => {
    const slots = computeSlots(input([], {}, { exceptions: undefined }));
    expect(starts(slots)[0]).toBe("09:00");
  });

  test("exceptions only affect their own stylist", () => {
    const base = input([off(MONDAY)]);
    const other: Candidate = {
      staffId: "s2",
      durationMin: 45,
      bufferMin: 0,
      rules: [NINE_TO_FIVE],
      exceptions: [],
      busy: [],
    };
    const slots = computeSlots({ ...base, candidates: [...base.candidates, other] });
    expect(new Set(slots.map((s) => s.staffId))).toEqual(new Set(["s2"]));
  });
});

describe("computeSlots: roster exceptions on daylight-saving days", () => {
  // Melbourne: clocks go forward 02:00 -> 03:00 on Sunday 2026-10-04 and back 03:00 -> 02:00 on 2027-04-04.
  const sundayRule: WeeklyRule = { ...NINE_TO_FIVE, weekday: 0 };

  test("custom hours spanning the spring-forward gap lose the missing hour", () => {
    const slots = computeSlots(
      input(
        [custom("2026-10-04", 0, 360)],
        {
          fromDate: "2026-10-04",
          toDate: "2026-10-04",
          slotStepMin: 60,
          now: local("2026-10-01T08:00"),
        },
        { durationMin: 60, rules: [sundayRule] },
      ),
    );
    // 00:00-06:00 local is only five real hours that day
    expect(starts(slots)).toEqual(["00:00", "01:00", "03:00", "04:00", "05:00"]);
  });

  test("custom hours spanning the fall-back repeat hour gain an hour", () => {
    const slots = computeSlots(
      input(
        [custom("2027-04-04", 0, 360)],
        {
          fromDate: "2027-04-04",
          toDate: "2027-04-04",
          slotStepMin: 60,
          now: local("2027-04-01T08:00"),
        },
        { durationMin: 60, rules: [sundayRule] },
      ),
    );
    expect(slots).toHaveLength(7);
  });

  test("a day off on a DST-change day removes it entirely", () => {
    const slots = computeSlots(
      input(
        [off("2026-10-04")],
        { fromDate: "2026-10-04", toDate: "2026-10-04", now: local("2026-10-01T08:00") },
        { rules: [sundayRule] },
      ),
    );
    expect(slots).toEqual([]);
  });

  test("ordinary custom hours on a DST-change day sit on the local clock", () => {
    const slots = computeSlots(
      input(
        [custom("2026-10-04", 600, 720)],
        { fromDate: "2026-10-04", toDate: "2026-10-04", now: local("2026-10-01T08:00") },
        { rules: [sundayRule] },
      ),
    );
    expect(starts(slots)[0]).toBe("10:00");
    // 10:00 AEDT is 23:00Z the previous day
    expect(slots[0].start.toISOString()).toBe("2026-10-03T23:00:00.000Z");
  });
});
