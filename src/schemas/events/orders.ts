/**
 * Order aggregate events.
 *
 * Covers: orders, bookings, stock, quotes.
 */
import type { EventEnvelope } from "./common.ts";
import type { Order } from "../order.ts";
import type { Booking } from "../booking.ts";
import type { Stock } from "../stock.ts";
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

// ── Stock events ────────────────────────────────────────────────────

/**
 * ONE event, because there is one document. This replaced a
 * `stock_summary.recalculated` / `public_stock_summary.recalculated` pair when
 * `stock-summaries` and its public twin collapsed into `stock/{P}`: pre-reducing
 * the intervals to anonymous `{start, end, quantity, kind}` removed the reason
 * for a sanitized twin, so one document now serves the operator UI and the
 * public storefront under one security rule.
 */
export type StockRecalculated = EventEnvelope<Stock> & { event: "stock.recalculated" };

// ── Quote events ────────────────────────────────────────────────────

export type QuoteCreated = EventEnvelope<Quote> & { event: "quote.created" };
export type QuoteRestored = EventEnvelope<Quote> & { event: "quote.restored" };
export type QuoteDeleted = EventEnvelope<Quote> & { event: "quote.deleted" };
