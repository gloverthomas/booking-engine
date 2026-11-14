import type { ToolDef } from "../deps";
import { cancelBookingTool, createBookingTool, moveBookingTool } from "./booking-writes";
import { getBooking, listBookings } from "./bookings";
import { getIntegrationStatus, listServices } from "./catalog";
import { findClient, getClientHistory } from "./clients";
import { checkAvailability, getCancellationReport, getRevenueSummary } from "./insights";
import {
  addClientNoteTool,
  blockTimeTool,
  sendMessageTool,
  updateServiceTool,
} from "./misc-writes";
import { chargeFeeTool, refundPaymentTool } from "./money";

/** Every tool the server offers, in the order they are listed. Read tools first, then writes, then money. */
export const ALL_TOOLS: readonly ToolDef[] = [
  listBookings,
  getBooking,
  findClient,
  getClientHistory,
  checkAvailability,
  getRevenueSummary,
  getCancellationReport,
  listServices,
  getIntegrationStatus,
  createBookingTool,
  moveBookingTool,
  cancelBookingTool,
  blockTimeTool,
  updateServiceTool,
  addClientNoteTool,
  sendMessageTool,
  refundPaymentTool,
  chargeFeeTool,
];
