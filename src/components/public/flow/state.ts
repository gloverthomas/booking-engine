import type {
  CatalogData,
  CatalogLocation,
  CatalogService,
  HoldData,
  SlotDto,
} from "@/lib/public-api-types";
import {
  baseQuote,
  eligibleStaff,
  quoteFor,
  quoteRange,
  staffOptions,
  type StaffOption,
} from "@/lib/public-api-staff";
import { EMPTY_DETAILS, type DetailsForm } from "./details";

export type StepId = "location" | "services" | "staff" | "time" | "details" | "pay";

export interface FlowState {
  step: StepId;
  locationId: string | null;
  serviceIds: string[];
  /** The stylist the client chose; null is "Anyone available". Only used when choosing is on. */
  staffId: string | null;
  /** Local date (YYYY-MM-DD) the client is looking at. */
  date: string | null;
  slot: SlotDto | null;
  details: DetailsForm;
  hold: HoldData | null;
  /** A message shown above the current step (e.g. "that time was just taken"). */
  notice: string | null;
}

export type FlowAction =
  | { type: "selectLocation"; locationId: string }
  | { type: "toggleService"; serviceId: string }
  | { type: "pickStaff"; staffId: string | null }
  | { type: "pickDate"; date: string }
  | { type: "pickSlot"; slot: SlotDto }
  | { type: "editDetails"; patch: Partial<DetailsForm> }
  | { type: "goTo"; step: StepId }
  | { type: "holdCreated"; hold: HoldData }
  | { type: "holdReleased"; to?: StepId; notice?: string }
  | { type: "slotLost"; notice: string }
  | { type: "notice"; notice: string | null };

export function initialState(): FlowState {
  return {
    step: "services",
    locationId: null,
    serviceIds: [],
    staffId: null,
    date: null,
    slot: null,
    details: EMPTY_DETAILS,
    hold: null,
    notice: null,
  };
}

/** Starting state for a catalog: with a single location the location step is skipped. */
export function initialStateFor(
  catalog: CatalogData,
  details: DetailsForm = EMPTY_DETAILS,
): FlowState {
  const base = { ...initialState(), details };
  if (catalog.locations.length === 1) {
    return { ...base, locationId: catalog.locations[0].id, step: "services" };
  }
  return { ...base, step: "location" };
}

export function flowReducer(state: FlowState, action: FlowAction): FlowState {
  switch (action.type) {
    case "selectLocation":
      // Choosing is not navigating: the visitor moves on with the Services button.
      if (state.locationId === action.locationId) return { ...state, notice: null };
      return {
        ...state,
        locationId: action.locationId,
        serviceIds: [],
        staffId: null,
        date: null,
        slot: null,
        hold: null,
        notice: null,
      };

    case "toggleService": {
      const serviceIds = state.serviceIds.includes(action.serviceId)
        ? state.serviceIds.filter((id) => id !== action.serviceId)
        : [...state.serviceIds, action.serviceId];
      // Different services mean a different duration, so earlier availability no longer applies.
      return { ...state, serviceIds, date: null, slot: null, notice: null };
    }

    case "pickStaff":
      // Availability is per stylist, so a different choice means the picked day and time no longer apply.
      if (action.staffId === state.staffId) return { ...state, notice: null };
      return { ...state, staffId: action.staffId, date: null, slot: null, notice: null };

    case "pickDate":
      return { ...state, date: action.date, slot: null };

    case "pickSlot":
      return { ...state, slot: action.slot, notice: null };

    case "editDetails":
      return { ...state, details: { ...state.details, ...action.patch } };

    case "goTo":
      return { ...state, step: action.step, notice: null };

    case "holdCreated":
      return { ...state, hold: action.hold, step: "pay", notice: null };

    case "holdReleased": {
      const to = action.to ?? "time";
      return {
        ...state,
        hold: null,
        step: to,
        slot: to === "time" ? null : state.slot,
        notice: action.notice ?? null,
      };
    }

    case "slotLost":
      return { ...state, hold: null, slot: null, step: "time", notice: action.notice };

    case "notice":
      return { ...state, notice: action.notice };
  }
}

/* ------------------------------------------------------------------ */
/* Selectors                                                           */
/* ------------------------------------------------------------------ */

export function selectedLocation(state: FlowState, catalog: CatalogData): CatalogLocation | null {
  return catalog.locations.find((l) => l.id === state.locationId) ?? null;
}

export function selectedServices(state: FlowState, catalog: CatalogData): CatalogService[] {
  const location = selectedLocation(state, catalog);
  if (!location) return [];
  return state.serviceIds.flatMap((id) => location.services.find((s) => s.id === id) ?? []);
}

export interface FlowTotals {
  totalCents: number;
  durationMin: number;
  depositCents: number;
}

/** The stylist choice, only when it still makes sense for the services and location. */
export function chosenStaffId(state: FlowState, catalog: CatalogData): string | null {
  const location = selectedLocation(state, catalog);
  if (!catalog.chooseStaff || !location || state.staffId === null) return null;
  const ok = eligibleStaff(location.staff, state.serviceIds).some((p) => p.id === state.staffId);
  return ok ? state.staffId : null;
}

/** Rows for the stylist step ("Anyone" first). Empty when clients cannot choose. */
export function staffStepOptions(state: FlowState, catalog: CatalogData): StaffOption[] {
  const location = selectedLocation(state, catalog);
  if (!catalog.chooseStaff || !location) return [];
  return staffOptions(location.staff, selectedServices(state, catalog));
}

/** Who the booking is with: the stylist asked for, else the one the picked time is with. */
function resolvedStaff(state: FlowState, catalog: CatalogData) {
  const location = selectedLocation(state, catalog);
  if (!catalog.chooseStaff || !location) return null;
  const id = chosenStaffId(state, catalog) ?? state.slot?.staffId ?? null;
  return location.staff.find((p) => p.id === id) ?? null;
}

export function selectedStaffName(state: FlowState, catalog: CatalogData): string | null {
  return resolvedStaff(state, catalog)?.name ?? null;
}

/** The stylist's totals when known; otherwise Anyone's lowest; otherwise the plain service prices. */
function currentQuote(state: FlowState, catalog: CatalogData) {
  const services = selectedServices(state, catalog);
  const person = resolvedStaff(state, catalog);
  const personal = person ? quoteFor(person, services) : null;
  if (personal) return { quote: personal, estimate: false };

  const location = selectedLocation(state, catalog);
  if (catalog.chooseStaff && location) {
    const range = quoteRange(eligibleStaff(location.staff, state.serviceIds), services);
    if (range) return { quote: range.low, estimate: range.differs };
  }
  return { quote: baseQuote(services), estimate: false };
}

export function flowTotals(state: FlowState, catalog: CatalogData): FlowTotals {
  const { quote } = currentQuote(state, catalog);
  return {
    totalCents: quote.totalCents,
    durationMin: quote.durationMin,
    depositCents: quote.depositCents,
  };
}

/** True when the total is the lowest of several stylists' prices, so the page says "from". */
export function isEstimate(state: FlowState, catalog: CatalogData): boolean {
  return currentQuote(state, catalog).estimate;
}

/** Selected services at the price of whoever will do them, for the running ticket. */
export function ticketLines(state: FlowState, catalog: CatalogData) {
  return currentQuote(state, catalog).quote.lines;
}

/**
 * Whether the stylist step exists. It depends on the location, not the services, so the rail does not
 * change shape as services are ticked; with several locations it shows if any of them has a choice.
 */
function hasStaffChoice(catalog: CatalogData, state: FlowState): boolean {
  if (!catalog.chooseStaff) return false;
  const location = selectedLocation(state, catalog);
  if (location) return location.staff.length >= 2;
  return catalog.locations.some((l) => l.staff.length >= 2);
}

/** The ordered steps for this catalog. Location is skipped for one site; pay for free bookings. */
export function stepsFor(catalog: CatalogData, state: FlowState): StepId[] {
  const steps: StepId[] = [];
  if (catalog.locations.length > 1) steps.push("location");
  steps.push("services");
  if (hasStaffChoice(catalog, state)) steps.push("staff");
  steps.push("time", "details");
  const needsDeposit = flowTotals(state, catalog).depositCents > 0 || state.serviceIds.length === 0;
  if (needsDeposit) steps.push("pay");
  return steps;
}

export function canLeaveStep(state: FlowState, step: StepId): boolean {
  switch (step) {
    case "location":
      return state.locationId !== null;
    case "services":
      return state.serviceIds.length > 0;
    case "time":
      return state.slot !== null;
    default:
      return true;
  }
}

/**
 * Whether the user may jump back to `target` from the rail. Forward jumps are only allowed to
 * steps whose prerequisites are done; the pay step is only reachable through a created hold.
 */
export function canVisit(state: FlowState, steps: readonly StepId[], target: StepId): boolean {
  const targetIndex = steps.indexOf(target);
  const currentIndex = steps.indexOf(state.step);
  if (targetIndex < 0) return false;
  if (target === "pay") return state.hold !== null;
  if (targetIndex <= currentIndex) return true;
  return steps.slice(0, targetIndex).every((s) => s === "details" || canLeaveStep(state, s));
}
