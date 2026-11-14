import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { groupByCategory } from "@/components/public/steps/ServicesStep";
import { policyBody } from "@/components/public/flow/policy-copy";
import { Ticket } from "@/components/public/ui/Ticket";
import { StepRail } from "@/components/public/ui/StepRail";
import { Notice } from "@/components/public/ui/Notice";
import { catalog } from "./fakes";

const services = catalog.locations[0].services;

describe("groupByCategory", () => {
  it("keeps first-seen order and merges repeated categories", () => {
    const groups = groupByCategory([
      { ...services[0], category: "Hair" },
      { ...services[1], category: "Beard" },
      { ...services[0], id: "x", category: "Hair" },
    ]);
    expect(groups.map((g) => [g.title, g.services.length])).toEqual([
      ["Hair", 2],
      ["Beard", 1],
    ]);
  });

  it("uses a null title for uncategorised services", () => {
    const groups = groupByCategory([{ ...services[0], category: null }]);
    expect(groups).toEqual([{ title: null, services: [expect.anything()] }]);
  });
});

describe("policyBody", () => {
  it("prefers the owner's text", () => {
    expect(policyBody({ ...catalog.policy, text: " Be kind " })).toBe("Be kind");
  });

  it("falls back to a summary built from the numbers", () => {
    const text = policyBody({ ...catalog.policy, text: "" });
    expect(text).toContain("50% deposit");
    expect(text).toContain("24 hours' notice");
  });
});

describe("presentational components (server render)", () => {
  it("renders the ticket with total, deposit and items", () => {
    const html = renderToStaticMarkup(
      createElement(Ticket, {
        items: [{ id: "a", name: "Maintenance Haircut", priceCents: 9500 }],
        locationName: "Northside",
        whenIso: "2026-11-20T03:30:00Z",
        timezone: "Australia/Melbourne",
        totalCents: 9500,
        durationMin: 45,
        depositCents: 4750,
        action: createElement("button", null, "Go"),
      }),
    );
    expect(html).toContain('aria-label="Your booking"');
    expect(html).toContain("$95");
    expect(html).toContain("$47.50 deposit");
    expect(html).toContain("Friday 20 November, 2:30 pm");
    expect(html).toContain("45 min");
  });

  it("renders an empty ticket without a deposit line", () => {
    const html = renderToStaticMarkup(
      createElement(Ticket, {
        items: [],
        locationName: null,
        whenIso: null,
        timezone: "Australia/Melbourne",
        totalCents: 0,
        durationMin: 0,
        depositCents: 0,
        action: null,
      }),
    );
    expect(html).toContain("Nothing selected yet.");
    expect(html).not.toContain("deposit");
  });

  it("marks the current step and disables unreachable ones", () => {
    const html = renderToStaticMarkup(
      createElement(StepRail, {
        steps: ["services", "time", "details"],
        current: "time",
        canVisit: () => true,
        onVisit: () => undefined,
      }),
    );
    expect(html).toContain('aria-current="step"');
    expect(html.match(/disabled=""/g)).toHaveLength(2); // current and upcoming are not clickable
    expect(html).toContain("(completed)");
  });

  it("announces errors as alerts and info as status", () => {
    // Notice is a plain function component, so call it directly instead of via createElement.
    expect(renderToStaticMarkup(Notice({ tone: "error", children: "Bad" }))).toContain(
      'role="alert"',
    );
    expect(renderToStaticMarkup(Notice({ children: "Fine" }))).toContain('role="status"');
  });
});
