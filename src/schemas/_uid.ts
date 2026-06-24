/**
 * Identifier validators for Firestore document ids and the few id-shaped
 * fields that are *not* plain auto-ids. Applied by **field-role**, not by
 * name — uids in CFS are not monomorphic (see the shape table below).
 *
 * Composed from native Zod 4 pieces (`z.uuid()`, `z.iso.date()`,
 * `z.templateLiteral()`, `z.union()`); only the atomic Firestore-id shape,
 * which has no native validator, uses `.regex()`.
 *
 * | Validator        | Shape                                   | Used for |
 * |------------------|-----------------------------------------|----------|
 * | `FirestoreId`    | `[A-Za-z0-9]{20}`                       | own `uid` on normal collections + every `uid_*` doc reference |
 * | `BookingId`      | `{id}:{itemUid}:{id}`                   | `bookings.uid` = `{uid_order}:{item uid}:{uid_destination}` |
 * | `StockSummaryId` | `{id}:rental:{date}:{date}` / `:sale:`  | `stock-summaries.uid`, `public-stock-summaries.uid` |
 * | `ItemUid`        | `FirestoreId | uuid | custom-{uuid}`    | order/invoice/fulfillment `items[].uid` + `path[]` segments |
 * | `QuoteId`        | `{id}:v{N}` / `{id}:draft`              | `quotes.uid` (saved versions + working draft) |
 *
 * Carve-outs that intentionally stay looser: `ActorRef.uid` (free-form
 * historical actors — see `common.ts`), `DocSource.uid` / `UidNameRef.uid`
 * (polymorphic), divider-item `uid` (native `z.uuid()`), and third-party
 * UUIDs (`uploadcare_uuid`, `xero_id`).
 *
 * @module
 */

import { z } from "zod";

/**
 * Source fragment for a Firestore auto-id — 20 alphanumeric chars. Kept
 * un-anchored so it can be embedded as a `z.templateLiteral` part; the
 * standalone validators anchor it.
 */
const FIRESTORE_ID = "[A-Za-z0-9]{20}";

/** Internal, un-annotated so `z.templateLiteral` can read its pattern. */
const firestoreId = z.string().regex(new RegExp(`^${FIRESTORE_ID}$`), "Must be a Firestore document id");

/** Atomic Firestore auto-generated document id (`[A-Za-z0-9]{20}`). */
export const FirestoreId: z.ZodType<string> = firestoreId;

/**
 * A custom-product line-item id: `"custom-"` + a native UUID (newer items) or a
 * Firestore-style 20-char id (older items). Both forms exist in stored data.
 */
const customItemUid = z.union([
  z.templateLiteral(["custom-", z.uuid()]),
  z.templateLiteral(["custom-", firestoreId]),
]);

/**
 * Polymorphic `items[].uid` + `path[]` segment in order/invoice/fulfillment
 * documents: a product's Firestore id, a divider UUID, or a custom-product id.
 */
export const ItemUid: z.ZodType<string> = z.union([firestoreId, z.uuid(), customItemUid]);

/**
 * `bookings.uid` — deterministic composite
 * `{uid_order}:{item uid}:{uid_destination}` (the middle segment is the order
 * item's uid, which for a custom product is `custom-{uuid}`).
 */
export const BookingId: z.ZodType<string> = z.templateLiteral([
  firestoreId,
  ":",
  z.union([firestoreId, customItemUid]),
  ":",
  firestoreId,
]);

/**
 * `stock-summaries.uid` / `public-stock-summaries.uid` — deterministic
 * composite `{uid_product}:rental:{start}:{end}` or `{uid_product}:sale:{date}`
 * (dates are `YYYY-MM-DD`).
 */
export const StockSummaryId: z.ZodType<string> = z.union([
  z.templateLiteral([firestoreId, ":rental:", z.iso.date(), ":", z.iso.date()]),
  z.templateLiteral([firestoreId, ":sale:", z.iso.date()]),
]);

/**
 * `quotes.uid` — deterministic composite `{uid_order}:v{N}` (saved versions) or
 * `{uid_order}:draft` (the working draft). Built in api-cloudrun
 * `src/services/quotes.ts` (`${uidOrder}:v${version}` / `${uidOrder}:draft`).
 */
export const QuoteId: z.ZodType<string> = z.union([
  z.templateLiteral([firestoreId, ":v", z.number()]),
  z.templateLiteral([firestoreId, ":draft"]),
]);

/**
 * `cards` event-card composite id — `{uid_order}:{uid_destination}:start|end`
 * (one per order delivery/collection endpoint). See `api-cloudrun
 * src/lib/eventCards.ts` (`EventPosition = "start" | "end"`).
 */
export const EventCardId: z.ZodType<string> = z.templateLiteral([
  firestoreId,
  ":",
  firestoreId,
  ":",
  z.enum(["start", "end"]),
]);

/**
 * `cards.uid` — either a Firestore auto-id (kanban/to-do cards) or an
 * `EventCardId` composite (auto-generated order event cards).
 */
export const CardId: z.ZodType<string> = z.union([firestoreId, EventCardId]);

/**
 * `threads.uid` (and the `uid_thread` references on `cards` + `comments`) —
 * either a Firestore auto-id (the default-thread cowrite for most entities) or
 * an `EventCardId` composite. Event-card threads are minted at a **deterministic
 * id equal to their card uid** (`${uid_order}:${uid_destination}:start|end`) so
 * the delete→recreate churn of a CRMS opportunity-webhook burst reuses the one
 * stable `threads/{cardUid}` doc instead of piling up random-id orphans (and
 * comments survive across the cycle). Structurally identical to `CardId`; see
 * `services/eventCardReconcile.ts` `eventCardThreadId`.
 */
export const ThreadId: z.ZodType<string> = z.union([firestoreId, EventCardId]);

/**
 * `lists.uid` (and `uid_list` references) — a Firestore auto-id (user-created
 * lists) or a lowercase-kebab slug (seeded/system lists, e.g. `in-store`,
 * `field-service`).
 */
export const ListId: z.ZodType<string> = z.union([
  firestoreId,
  z.string().regex(/^[a-z][a-z0-9-]*$/, "Must be a list slug"),
]);

/**
 * Any known CFS document-id shape — atomic Firestore id, divider/custom item
 * id, a composite (booking / stock-summary / event-card), or a lowercase-kebab
 * slug (slug-keyed collections such as `roles` and seeded `lists`). Use for
 * polymorphic references (`DocSource`, `UidNameRef`) that may point at any
 * collection. `ItemUid` already covers `FirestoreId | uuid | custom-`.
 */
export const AnyUid: z.ZodType<string> = z.union([
  ItemUid,
  BookingId,
  StockSummaryId,
  EventCardId,
  z.string().regex(/^[a-z][a-z0-9-]*$/, "Must be a slug"),
]);
