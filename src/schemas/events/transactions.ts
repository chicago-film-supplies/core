/**
 * Movement aggregate events.
 *
 * Covers: transactions (inventory), out-of-service.
 *
 * A store transfer is an ordinary {@link Movement} of type `transfer`, whose
 * lines name the shelf on each end. It carries no discriminator of its own: the
 * `source` object this comment used to point at is gone, and the
 * `transfer_increase`/`transfer_decrease` pair it distinguished collapsed into
 * one document once `location: {from, to}` could say "out of A, into B".
 */
import type { EventEnvelope } from "./common.ts";
import type { Movement } from "../transaction.ts";
import type { OutOfService } from "../out-of-service.ts";

// ── Movement events ─────────────────────────────────────────────

export type TransactionCreated = EventEnvelope<Movement> & { event: "transaction.created" };
export type TransactionUpdated = EventEnvelope<Movement> & { event: "transaction.updated" };

// ── Out-of-service events ──────────────────────────────────────────

export type OutOfServiceCreated = EventEnvelope<OutOfService> & { event: "out_of_service.created" };
export type OutOfServiceUpdated = EventEnvelope<OutOfService> & { event: "out_of_service.updated" };
