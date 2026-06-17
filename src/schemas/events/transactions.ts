/**
 * Transaction aggregate events.
 *
 * Covers: transactions (inventory), out-of-service.
 * Store transfers use the same Transaction type with source.type = "store-transfer".
 */
import type { EventEnvelope } from "./common.ts";
import type { Transaction } from "../transaction.ts";
import type { OutOfService } from "../out-of-service.ts";

// ── Transaction events ─────────────────────────────────────────────

export type TransactionCreated = EventEnvelope<Transaction> & { event: "transaction.created" };
export type TransactionUpdated = EventEnvelope<Transaction> & { event: "transaction.updated" };

// ── Out-of-service events ──────────────────────────────────────────

export type OutOfServiceCreated = EventEnvelope<OutOfService> & { event: "out_of_service.created" };
export type OutOfServiceUpdated = EventEnvelope<OutOfService> & { event: "out_of_service.updated" };
