/**
 * Movement aggregate events.
 *
 * Covers: transactions (inventory), out-of-service.
 * Store transfers use the same Movement type with source.type = "store-transfer".
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
