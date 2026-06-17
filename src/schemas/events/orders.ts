/**
 * Order aggregate events.
 *
 * Covers: orders, bookings, stock-summaries, public-stock-summaries, quotes.
 */
import type { EventEnvelope } from "./common.ts";
import type { Order } from "../order.ts";
import type { Booking } from "../booking.ts";
import type { StockSummary } from "../stock-summary.ts";
import type { PublicStockSummary } from "../public-stock-summary.ts";
import type { Quote } from "../quote.ts";

// ── Order events ────────────────────────────────────────────────────

export type OrderCreated = EventEnvelope<Order> & { event: "order.created" };
export type OrderUpdated = EventEnvelope<Order> & { event: "order.updated" };
export type OrderStatusChanged = EventEnvelope<Order> & { event: "order.status_changed" };
export type OrderCanceled = EventEnvelope<Order> & { event: "order.canceled" };

// ── Booking events ──────────────────────────────────────────────────

export type BookingCreated = EventEnvelope<Booking> & { event: "booking.created" };
export type BookingUpdated = EventEnvelope<Booking> & { event: "booking.updated" };
export type BookingStatusChanged = EventEnvelope<Booking> & { event: "booking.status_changed" };

// ── Stock summary events ────────────────────────────────────────────

export type StockSummaryRecalculated = EventEnvelope<StockSummary> & { event: "stock_summary.recalculated" };
export type PublicStockSummaryRecalculated = EventEnvelope<PublicStockSummary> & { event: "public_stock_summary.recalculated" };

// ── Quote events ────────────────────────────────────────────────────

export type QuoteCreated = EventEnvelope<Quote> & { event: "quote.created" };
export type QuoteRestored = EventEnvelope<Quote> & { event: "quote.restored" };
export type QuoteDeleted = EventEnvelope<Quote> & { event: "quote.deleted" };
