/**
 * Invoice aggregate events.
 */
import type { EventEnvelope } from "./common.ts";
import type { Invoice } from "../invoice.ts";

export type InvoiceCreated = EventEnvelope<Invoice> & { event: "invoice.created" };
export type InvoiceUpdated = EventEnvelope<Invoice> & { event: "invoice.updated" };
export type InvoiceIssued = EventEnvelope<Invoice> & { event: "invoice.issued" };
/**
 * @deprecated Says the right thing about the wrong aggregate. Settlement is its
 * own event log now — use `settlement.recorded` from `./settlements.ts`, whose
 * payload is the settlement itself rather than the invoice it happened to touch.
 * Removed whenever core next publishes, alongside `Invoice.payments`.
 */
export type InvoicePaymentReceived = EventEnvelope<Invoice> & { event: "invoice.payment_received" };
export type InvoiceVoided = EventEnvelope<Invoice> & { event: "invoice.voided" };
