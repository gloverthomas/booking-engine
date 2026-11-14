import type {
  CatalogData,
  CatalogLocation,
  CatalogService,
  HoldData,
  SlotDto,
} from "@/lib/public-api-types";
import { estimateDepositCents, sumTotals } from "@/lib/public-api-money";
import { EMPTY_DETAILS, type DetailsForm } from "./details";

export type StepId = "location" | "services" | "time" | "details" | "pay";

export interface FlowState {
  step: StepId;
  locationId: string | null;
  serviceIds: string[];
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

export function flowTotals(state: FlowState, catalog: CatalogData): FlowTotals {
  const services = selectedServices(state, catalog);
  const { totalCents, durationMin } = sumTotals(services);
  return { totalCents, durationMin, depositCents: estimateDepositCents(services) };
}

/** The ordered steps for this catalog. Location is skipped for one site; pay for free bookings. */
export function stepsFor(catalog: CatalogData, state: FlowState): StepId[] {
  const steps: StepId[] = [];
  if (catalog.locations.length > 1) steps.push("location");
  steps.push("services", "time", "details");
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
