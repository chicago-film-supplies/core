/**
 * Movement session — the fold of one operator ACTION, and the first template
 * source that is **not** a Firestore collection.
 *
 * One press of Check In writes one movement per booking it touched, all sharing
 * a client-minted `uuid_session` (`schemas/transaction.ts`). A movement is the
 * unit the ledger records ("2 of this product came back"); a *session* is the
 * unit a human recognises ("I checked in the crate"), and it is the unit a
 * receipt is printed at. So a receipt renders from a fold of
 * `transactions where uuid_session == …`, not from any stored document.
 *
 * ## Why this schema exists rather than a `movement-sessions` collection
 *
 * A template's `collection_source` resolves through four mechanisms, and only
 * ONE of them needs a collection — `captureFixture`'s point-get. The other
 * three need a **schema**: the field reference panel
 * (`schemas/template-schema-fields.generated.ts`), fixture validation
 * (`schemaForCollection`) and fixture PII sanitisation (`applyPii`). The render
 * path needs neither: it takes a plain object.
 *
 * So `movement-sessions` is a source with a schema and no collection, resolved
 * through {@link TEMPLATE_COLLECTION_SCHEMAS} rather than through the Firestore
 * collection registry. api-cloudrun#700 records the three options that were
 * refused and why: a source with NO schema is refused by an existing ratchet
 * (`tests/schema-fields.test.ts` — *"every source collection has a non-empty
 * field array"*), registering it in `schemas` would make
 * `isCollectionName("movement-sessions")` true for a path that does not exist,
 * and storing the fold would cache an ANSWER and buy only a reprint identity
 * that {@link MovementSession.numbers} already provides.
 *
 * ⚠️ **This is NOT the manager's `MovementSession`**
 * (`manager/src/utils/movementSessions.ts`), which is a client-side grouping
 * over movement rows a page already holds — generic over the four fields it
 * reads, with no joins. This one is the printable document: it carries the
 * product names, order numbers and organization that a movement does **not**,
 * because a movement carries `uid_product` and no product name at all.
 *
 * @module
 */
import { z } from "zod";
import { AnyUid, FirestoreId } from "./_uid.ts";
import { chicagoInstant } from "./_datetime.ts";
import { ActorRef, type ActorRefType, NameField } from "./common.ts";
import {
  MovementCustody,
  type MovementCustodyType,
  MovementLine,
  type MovementLineType,
  MovementTypeEnum,
  type MovementTypeType,
} from "./transaction.ts";

/**
 * One movement, joined to what a receipt has to name.
 *
 * Called `items` on the session for the same reason orders, invoices and
 * fulfillments call theirs that way: `partials/shared/*.eta` is written against
 * a document with an `items[]`, and a fourth spelling would make the shared
 * markup un-shareable.
 */
export interface MovementSessionItem {
  /** The movement's own uid — `{uuid_session}|{type}|{subject}`. */
  uid: string;
  /**
   * The movement's sequence number, unique across `transactions`.
   *
   * ⚠️ **This is the receipt's numbering, and it is why no counter is minted
   * for one.** A receipt names the movements it covers; those numbers are
   * already sequential and unique, so a second sequence would be a second
   * hot document allocating a number that adds no information.
   */
  number: number;
  type: MovementTypeType;
  quantity: number;
  uid_product: string;
  /**
   * The product's name, JOINED at fold time.
   *
   * ⚠️ **A movement cannot name what moved** — it carries `uid_product` and
   * nothing else, which is exactly what defeated the manager's first session
   * timeline (all twelve rows rendered identically). The fold is the only place
   * this join can happen, because a template cannot read Firestore.
   */
  name: string;
  uid_booking: string | null;
  /** From the movement's own `sources[]` — a session can span orders. */
  uid_order: string | null;
  order_number: number | null;
  custody: MovementCustodyType | null;
  /**
   * The physical movement, carried verbatim off the movement.
   *
   * Not flattened to a from/to pair of strings: `location.from` / `location.to`
   * are `DocSource`s whose `label` is already the human name, and a fold that
   * threw the pointer away would leave a receipt unable to link back.
   */
  lines: MovementLineType[];
  serialized_details: { asset_tags: string[]; serial_numbers: string[] } | null;
  reference: string;
}

/** Zod schema for one folded movement. */
export const MovementSessionItemSchema: z.ZodType<MovementSessionItem> = z.strictObject({
  uid: z.string().min(1),
  number: z.int(),
  type: MovementTypeEnum,
  quantity: z.number().int().positive(),
  uid_product: FirestoreId,
  name: z.string(),
  uid_booking: AnyUid.nullable(),
  uid_order: FirestoreId.nullable(),
  order_number: z.int().nullable(),
  custody: MovementCustody.nullable(),
  lines: z.array(MovementLine).default([]),
  serialized_details: z.strictObject({
    asset_tags: z.array(z.string()).default([]),
    serial_numbers: z.array(z.string()).default([]),
  }).nullable(),
  reference: z.string(),
});

/** One order a session touched, named the way a receipt prints it. */
export interface MovementSessionOrderRef {
  uid: string;
  number: number;
}

/** Zod schema for a session's order reference. */
export const MovementSessionOrderRefSchema: z.ZodType<MovementSessionOrderRef> = z.strictObject({
  uid: FirestoreId,
  number: z.int(),
});

/**
 * The fold of every movement sharing one `uuid_session` — what a receipt
 * renders.
 *
 * Not stored anywhere. Rebuilt on demand from the journal, which is append-only
 * and idempotent under `movementContentHash`, so the fold is stable: printing
 * the same receipt twice produces the same document.
 */
export interface MovementSession {
  /** The client-minted uuid every movement in the session carries. */
  uuid_session: string;
  /**
   * The session's instant, Chicago-offset — the EARLIEST movement's `date`.
   *
   * Earliest rather than latest because a receipt states when the action
   * happened, and the action began when its first movement was recorded. Every
   * movement in a session is stamped from one `ctx.nowIso`, so they normally
   * agree; the tie-break is stated so a legacy or repaired session cannot make
   * the field ambiguous.
   */
  date: string;
  /** Distinct movement types, in journal order (`prep`, `check_out`, …). */
  types: MovementTypeType[];
  /** Every movement number the receipt covers. See {@link MovementSessionItem.number}. */
  numbers: number[];
  /** Total units moved across every line of every movement. */
  quantity: number;
  /** Who performed the action. */
  created_by: ActorRefType;
  /** The orders the session touched — plural, because cross-order is the point. */
  orders: MovementSessionOrderRef[];
  /**
   * The customer, when every order in the session agrees on one; `null` when
   * they do not.
   *
   * ⚠️ **`null` is an ANSWER — "this session spans customers" — and a receipt
   * must not print a customer name in that case.** `POST /returns` deliberately
   * accepts bookings from different orders, so a session spanning two
   * organizations is legitimate rather than a data fault; collapsing to the
   * first would put one customer's name on another's goods.
   */
  organization: { uid: string | null; name: string } | null;
  items: MovementSessionItem[];
}

/** Zod schema for a folded movement session. */
export const MovementSessionSchema: z.ZodType<MovementSession> = z.strictObject({
  uuid_session: z.uuid(),
  date: chicagoInstant(),
  types: z.array(MovementTypeEnum).default([]),
  numbers: z.array(z.int()).default([]),
  quantity: z.int(),
  created_by: ActorRef,
  orders: z.array(MovementSessionOrderRefSchema).default([]),
  organization: z.strictObject({
    uid: FirestoreId.nullable(),
    name: NameField,
  }).nullable(),
  items: z.array(MovementSessionItemSchema).default([]),
}).meta({ title: "MovementSession" });
