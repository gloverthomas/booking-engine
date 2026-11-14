import { DateTime } from "luxon";
import { describe, expect, test } from "vitest";
import {
  computeSlots,
  localDate,
  wallClockInstant,
  type Candidate,
  type EngineInput,
} from "@/server/availability/engine";

const ZONE = "Australia/Melbourne";

/** A Date for a local wall-clock time in Melbourne, e.g. local("2026-11-02T09:00"). */
const local = (iso: string): Date => DateTime.fromISO(iso, { zone: ZONE }).toJSDate();
const localTime = (d: Date): string => DateTime.fromJSDate(d, { zone: ZONE }).toFormat("HH:mm");

const NOW = local("2026-11-01T08:00"); // Sunday
const MONDAY = "2026-11-02";

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    staffId: "s1",
    durationMin: 45,
    bufferMin: 0,
    rules: [{ weekday: 1, startMinute: 540, endMinute: 1020, validFrom: null, validTo: null }],
    busy: [],
    ...overrides,
  };
}

function input(overrides: Partial<EngineInput> = {}): EngineInput {
  return {
    timezone: ZONE,
    fromDate: MONDAY,
    toDate: MONDAY,
    now: NOW,
    slotStepMin: 15,
    minNoticeMin: 0,
    maxAdvanceDays: 90,
    candidates: [candidate()],
    ...overrides,
  };
}

const starts = (slots: ReturnType<typeof computeSlots>) => slots.map((s) => localTime(s.start));

describe("computeSlots: grid", () => {
  test("slices the weekly window on the slot grid so the appointment ends by closing time", () => {
    const slots = computeSlots(input());
    expect(slots).toHaveLength(30);
    expect(starts(slots)[0]).toBe("09:00");
    expect(starts(slots).at(-1)).toBe("16:15");
    expect(localTime(slots.at(-1)!.end)).toBe("17:00");
  });

  test("honours a coarser slot step", () => {
    const slots = computeSlots(input({ slotStepMin: 30 }));
    expect(starts(slots).slice(0, 3)).toEqual(["09:00", "09:30", "10:00"]);
  });

  test("the slot end is the appointment end and excludes the buffer", () => {
    const [slot] = computeSlots(input({ candidates: [candidate({ bufferMin: 15 })] }));
    expect(localTime(slot.end)).toBe("09:45");
  });

  test("the buffer may run past closing time but the appointment itself may not", () => {
    const slots = computeSlots(input({ candidates: [candidate({ bufferMin: 15 })] }));
    expect(starts(slots).at(-1)).toBe("16:15");
  });

  test("a service longer than the window yields no slots", () => {
    expect(computeSlots(input({ candidates: [candidate({ durationMin: 600 })] }))).toEqual([]);
  });

  test("ignores days without a matching weekday rule", () => {
    expect(computeSlots(input({ fromDate: "2026-11-03", toDate: "2026-11-03" }))).toEqual([]);
  });

  test("maps Sunday to weekday 0", () => {
    const sunday = candidate({
      rules: [{ weekday: 0, startMinute: 600, endMinute: 720, validFrom: null, validTo: null }],
    });
    const slots = computeSlots(
      input({ fromDate: "2026-11-08", toDate: "2026-11-08", candidates: [sunday] }),
    );
    expect(starts(slots)[0]).toBe("10:00");
  });

  test("supports multiple windows in one day (lunch gap)", () => {
    const split = candidate({
      rules: [
        { weekday: 1, startMinute: 540, endMinute: 600, validFrom: null, validTo: null },
        { weekday: 1, startMinute: 780, endMinute: 840, validFrom: null, validTo: null },
      ],
      durationMin: 30,
    });
    const slots = computeSlots(input({ candidates: [split] }));
    expect(starts(slots)).toEqual(["09:00", "09:15", "09:30", "13:00", "13:15", "13:30"]);
  });

  test("overlapping rules do not produce duplicate slots", () => {
    const dup = candidate({
      rules: [
        { weekday: 1, startMinute: 540, endMinute: 600, validFrom: null, validTo: null },
        { weekday: 1, startMinute: 540, endMinute: 600, validFrom: null, validTo: null },
      ],
      durationMin: 30,
    });
    expect(starts(computeSlots(input({ candidates: [dup] })))).toEqual(["09:00", "09:15", "09:30"]);
  });

  test("a window ending at midnight (1440) is supported", () => {
    const late = candidate({
      rules: [{ weekday: 1, startMinute: 1380, endMinute: 1440, validFrom: null, validTo: null }],
      durationMin: 30,
    });
    expect(starts(computeSlots(input({ candidates: [late] })))).toEqual([
      "23:00",
      "23:15",
      "23:30",
    ]);
  });

  test("covers every date in an inclusive range", () => {
    const slots = computeSlots(input({ fromDate: "2026-11-02", toDate: "2026-11-09" }));
    const days = new Set(slots.map((s) => localDate(s.start, ZONE)));
    expect([...days]).toEqual(["2026-11-02", "2026-11-09"]);
  });
});

describe("computeSlots: rule validity", () => {
  test("respects validFrom and validTo (inclusive, local dates)", () => {
    const limited = candidate({
      rules: [
        {
          weekday: 1,
          startMinute: 540,
          endMinute: 600,
          validFrom: "2026-11-09",
          validTo: "2026-11-16",
        },
      ],
      durationMin: 60,
    });
    const slots = computeSlots(
      input({ fromDate: "2026-11-02", toDate: "2026-11-30", candidates: [limited] }),
    );
    const days = [...new Set(slots.map((s) => localDate(s.start, ZONE)))];
    expect(days).toEqual(["2026-11-09", "2026-11-16"]);
  });
});

describe("computeSlots: busy time", () => {
  test("a booking removes overlapping slots but allows back-to-back starts", () => {
    const busy = [{ start: local("2026-11-02T10:00"), end: local("2026-11-02T10:45") }];
    const slots = starts(computeSlots(input({ candidates: [candidate({ busy })] })));
    expect(slots).toContain("09:15"); // ends exactly at 10:00
    expect(slots).not.toContain("09:30");
    expect(slots).not.toContain("10:00");
    expect(slots).not.toContain("10:30");
    expect(slots).toContain("10:45"); // starts exactly when the booking ends
  });

  test("the service buffer keeps the next booking away", () => {
    const busy = [{ start: local("2026-11-02T10:00"), end: local("2026-11-02T11:00") }];
    const slots = starts(computeSlots(input({ candidates: [candidate({ bufferMin: 15, busy })] })));
    expect(slots).toContain("09:00"); // 09:00 + 45 + 15 buffer = 10:00
    expect(slots).not.toContain("09:15");
    expect(slots).toContain("11:00");
  });

  test("a block that only partially overlaps a slot still removes it", () => {
    const busy = [{ start: local("2026-11-02T12:10"), end: local("2026-11-02T12:20") }];
    const slots = starts(computeSlots(input({ candidates: [candidate({ busy })] })));
    expect(slots).toContain("11:15"); // ends 12:00
    expect(slots).not.toContain("11:30"); // ends 12:15, overlaps the block
    expect(slots).not.toContain("12:15");
    expect(slots).toContain("12:30"); // starts after the block
  });

  test("busy time that covers the whole day removes every slot", () => {
    const busy = [{ start: local("2026-11-02T00:00"), end: local("2026-11-03T00:00") }];
    expect(computeSlots(input({ candidates: [candidate({ busy })] }))).toEqual([]);
  });
});

describe("computeSlots: notice and advance limits", () => {
  test("min notice hides slots that start too soon", () => {
    const now = local("2026-11-02T08:00");
    const slots = starts(
      computeSlots(input({ now, minNoticeMin: 120, candidates: [candidate()] })),
    );
    expect(slots[0]).toBe("10:00");
  });

  test("slots in the past are never offered", () => {
    const now = local("2026-11-02T12:00");
    const slots = starts(computeSlots(input({ now, minNoticeMin: 0 })));
    expect(slots[0]).toBe("12:00");
  });

  test("max advance days cuts off later dates (relative to the local date of now)", () => {
    const wide = input({ fromDate: "2026-11-02", toDate: "2026-12-31", maxAdvanceDays: 8 });
    const days = [...new Set(computeSlots(wide).map((s) => localDate(s.start, ZONE)))];
    // today is Sunday 2026-11-01, so +8 days = 2026-11-09 (a Monday) is the last day offered
    expect(days).toEqual(["2026-11-02", "2026-11-09"]);
  });

  test("the local date of now (not UTC) anchors the advance window", () => {
    // 2026-11-01T14:30Z is already Monday 2026-11-02 01:30 in Melbourne
    const now = new Date("2026-11-01T14:30:00Z");
    const result = computeSlots(
      input({ now, fromDate: "2026-11-02", toDate: "2026-11-10", maxAdvanceDays: 7 }),
    );
    const days = [...new Set(result.map((s) => localDate(s.start, ZONE)))];
    expect(days).toEqual(["2026-11-02", "2026-11-09"]);
  });

  test("an empty range after clamping returns nothing", () => {
    const past = input({ fromDate: "2026-10-01", toDate: "2026-10-05" });
    expect(computeSlots(past)).toEqual([]);
  });
});

describe("computeSlots: multiple staff", () => {
  test("returns slots per staff member, ordered by start then candidate order", () => {
    const a = candidate({ staffId: "a", durationMin: 60 });
    const b = candidate({
      staffId: "b",
      durationMin: 60,
      busy: [{ start: local("2026-11-02T09:00"), end: local("2026-11-02T10:00") }],
    });
    const slots = computeSlots(input({ candidates: [a, b], slotStepMin: 60 }));
    const first = slots.slice(0, 3).map((s) => `${s.staffId}@${localTime(s.start)}`);
    expect(first).toEqual(["a@09:00", "a@10:00", "b@10:00"]);
  });
});

describe("computeSlots: Melbourne daylight saving", () => {
  const sundayRule = (startMinute: number, endMinute: number) =>
    candidate({
      durationMin: 60,
      rules: [{ weekday: 0, startMinute, endMinute, validFrom: null, validTo: null }],
    });

  test("spring forward (Sun 2026-10-04): a normal 9-5 day keeps wall-clock start times", () => {
    const slots = computeSlots(
      input({
        now: local("2026-10-01T08:00"),
        fromDate: "2026-10-04",
        toDate: "2026-10-04",
        slotStepMin: 60,
        candidates: [sundayRule(540, 1020)],
      }),
    );
    expect(starts(slots)[0]).toBe("09:00");
    // 09:00 AEDT (+11) on the 4th is 22:00Z on the 3rd
    expect(slots[0].start.toISOString()).toBe("2026-10-03T22:00:00.000Z");
    expect(slots).toHaveLength(8);
  });

  test("spring forward: the missing 02:00-03:00 hour is not offered", () => {
    const slots = computeSlots(
      input({
        now: local("2026-10-01T08:00"),
        fromDate: "2026-10-04",
        toDate: "2026-10-04",
        slotStepMin: 60,
        candidates: [sundayRule(60, 240)], // 01:00 to 04:00 local
      }),
    );
    // Only two real hours exist between 01:00 AEST and 04:00 AEDT.
    expect(slots.map((s) => s.start.toISOString())).toEqual([
      "2026-10-03T15:00:00.000Z", // 01:00 AEST
      "2026-10-03T16:00:00.000Z", // 03:00 AEDT
    ]);
    expect(starts(slots)).toEqual(["01:00", "03:00"]);
  });

  test("fall back (Sun 2027-04-04): the repeated 02:00-03:00 hour is offered twice", () => {
    const slots = computeSlots(
      input({
        now: local("2027-04-01T08:00"),
        fromDate: "2027-04-04",
        toDate: "2027-04-04",
        slotStepMin: 60,
        candidates: [sundayRule(60, 240)], // 01:00 to 04:00 local = four real hours
      }),
    );
    expect(slots.map((s) => s.start.toISOString())).toEqual([
      "2027-04-03T14:00:00.000Z", // 01:00 AEDT
      "2027-04-03T15:00:00.000Z", // 02:00 AEDT
      "2027-04-03T16:00:00.000Z", // 02:00 AEST (repeated hour)
      "2027-04-03T17:00:00.000Z", // 03:00 AEST
    ]);
  });

  test("fall back: a 9-5 day is still 9am AEST local", () => {
    const [first] = computeSlots(
      input({
        now: local("2027-04-01T08:00"),
        fromDate: "2027-04-04",
        toDate: "2027-04-04",
        candidates: [sundayRule(540, 1020)],
      }),
    );
    expect(first.start.toISOString()).toBe("2027-04-03T23:00:00.000Z"); // 09:00 AEST (+10)
  });

  test("a booking made across the transition blocks the right real-time slots", () => {
    const busy = [
      { start: new Date("2026-10-03T15:30:00Z"), end: new Date("2026-10-03T16:30:00Z") },
    ];
    const slots = computeSlots(
      input({
        now: local("2026-10-01T08:00"),
        fromDate: "2026-10-04",
        toDate: "2026-10-04",
        slotStepMin: 60,
        candidates: [{ ...sundayRule(60, 240), busy }],
      }),
    );
    expect(slots).toEqual([]);
  });
});

describe("wall clock helpers", () => {
  test("wallClockInstant resolves local minutes in the business zone", () => {
    const day = DateTime.fromISO("2026-11-02", { zone: ZONE });
    expect(wallClockInstant(day, 570).toISO()).toBe("2026-11-02T09:30:00.000+11:00");
    expect(wallClockInstant(day, 1440).toISO()).toBe("2026-11-03T00:00:00.000+11:00");
  });

  test("localDate formats the local calendar date of an instant", () => {
    expect(localDate(new Date("2026-11-01T14:30:00Z"), ZONE)).toBe("2026-11-02");
  });

  test("an invalid timezone is rejected", () => {
    expect(() => computeSlots(input({ timezone: "Not/AZone" }))).toThrow(/timezone/i);
  });
});
