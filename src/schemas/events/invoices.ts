/**
 * Invoice aggregate events.
 */
import type { EventEnvelope } from "./common.ts";
import type { Invoice } from "../invoice.ts";

export type InvoiceCreated = EventEnvelope<Invoice> & { event: "invoice.created" };
export type InvoiceUpdated = EventEnvelope<Invoice> & { event: "invoice.updated" };
export type InvoiceIssued = EventEnvelope<Invoice> & { event: "invoice.issued" };
export type InvoicePaymentReceived = EventEnvelope<Invoice> & { event: "invoice.payment_received" };
export type InvoiceVoided = EventEnvelope<Invoice> & { event: "invoice.voided" };
