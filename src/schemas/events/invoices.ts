/**
 * Invoice aggregate events.
 */
import type { EventEnvelope } from "./common.ts";
import type { Invoice } from "../invoice.ts";

export type InvoiceCreated = EventEnvelope<Invoice> & { event: "invoice.created" };
export type InvoiceUpdated = EventEnvelope<Invoice> & { event: "invoice.updated" };
export type InvoiceIssued = EventEnvelope<Invoice> & { event: "invoice.issued" };
export type InvoiceVoided = EventEnvelope<Invoice> & { event: "invoice.voided" };

// `InvoicePaymentReceived` (`invoice.payment_received`) was deleted here on
// 2026-08-03, with `Invoice.payments`. It said the right thing about the wrong
// aggregate: its payload was the *invoice* a settlement happened to touch, so a
// consumer had to diff two invoice snapshots to learn what was actually paid.
// Settlement is its own event log — use `settlement.recorded` from
// `./settlements.ts`, whose payload is the settlement itself.
