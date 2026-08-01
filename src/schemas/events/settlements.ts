/**
 * Settlement aggregate events.
 *
 * Uses the package's established `<aggregate>.<past_tense>` vocabulary rather
 * than forking a new one. The envelope's `correlation_id` carries the
 * settlement's `uid_session`, so a batch payment or a multi-invoice allocation
 * is one correlated group in both the journal and the notification stream.
 *
 * Note the envelope wraps *the whole document* — it is a change-notification
 * shape, not an event-sourcing payload. The `settlements` collection is the
 * event log; this is how a change to it is announced.
 */
import type { EventEnvelope } from "./common.ts";
import type { Settlement } from "../settlement.ts";
import type { CreditNote } from "../credit-note.ts";

export type SettlementRecorded = EventEnvelope<Settlement> & { event: "settlement.recorded" };
export type SettlementReversed = EventEnvelope<Settlement> & { event: "settlement.reversed" };

export type CreditNoteCreated = EventEnvelope<CreditNote> & { event: "credit_note.created" };
export type CreditNoteUpdated = EventEnvelope<CreditNote> & { event: "credit_note.updated" };
export type CreditNoteVoided = EventEnvelope<CreditNote> & { event: "credit_note.voided" };
