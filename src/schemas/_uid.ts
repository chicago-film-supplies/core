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
 * | `BookingId`      | `{id}:{itemUid}:{id}` or `{id}:{itemUid}:{id}:{hash}` | `bookings.uid` = `{uid_order}:{item uid}:{uid_destination}`, +4th segment for a kit-component occurrence — see below |
 * | `ItemUid`        | `FirestoreId | uuid | custom-{uuid}`    | order/invoice/fulfillment `items[].uid` + `path[]` segments |
 * | `QuoteId`        | `{id}:v{N}` / `{id}:draft`              | `quotes.uid` (saved versions + working draft) |
 * | `StatementDocumentId` | `{id}:v{N}`                        | `statement-documents.uid` (saved org statements) |
 * | `MovementId`     | `{uuid}|{type}|{FirestoreId\|BookingId}` | `transactions.uid` for journal events (see below) |
 * | *(none)*         | third-party uuid                        | `uploadcare-worklist.uuid` — an Uploadcare id, so `uuid` not `uid`; see the carve-outs below |
 *
 * Carve-outs that intentionally stay looser: `ActorRef.uid` (free-form
 * historical actors — see `schemas/common.ts`), `DocSource.uid` / `UidNameRef.uid`
 * (polymorphic), divider-item `uid` (native `z.uuid()`), and third-party
 * UUIDs (`uploadcare_uuid`, `xero_id`).
 *
 * ## 🔴 One id is DERIVED and still shaped like an auto-id — nothing records it
 *
 * `BookingId`, `QuoteId` and `MovementId` are deterministic, and they announce
 * themselves *here*, because a composite has its own shape. **`templates` and
 * `template-components` do not**: since 2026-09-08 a family REGISTERED by a
 * template-PR merge takes 20 hex chars of SHA-256 over its `git_path`
 * (`registerDocId`, in `api-cloudrun/src/services/templates/publishFromMerge.ts`),
 * which satisfies `FirestoreId` exactly — so it is byte-indistinguishable from an
 * auto-id, the validator cannot tell, and neither can a reader looking at the
 * data. **That is precisely why it is written down, and this is the only place
 * that could carry it.**
 *
 * It exists to make a duplicate unrepresentable: two concurrent merges
 * registering one `git_path` both resolve "no family" from a pre-write query, so
 * under auto-minted ids they had nothing to collide on and both creates
 * succeeded (api-cloudrun#639).
 *
 * ⚠️ **Two things not to infer from it.** It is **not a lookup key** — every
 * family registered before that date has a real auto-id, so addressing one by
 * derivation 404s on a family that plainly exists, and the `git_path` query stays
 * the only way to FIND one. And it is **not uniform**: `createTemplateFamily`
 * (the manager-driven path) still auto-mints, so *"one `git_path`, one document"*
 * is not an invariant of the corpus.
 *
 * ⭐ The transferable rule: **when a deterministic id has to meet an id-shape
 * schema, bend the DERIVATION, not the schema.** The readable `gp-<git_path>`
 * form was written first and failed `validateBeforeWrite` at every register;
 * widening `FirestoreId` would have weakened a guard covering 41 document types
 * for the sake of two.
 *
 * ## `BookingId`'s 4th segment, and why `isProductShapedUid` lives here
 *
 * `bookings` aggregates one row per `(order, product, destination)` — but a
 * product's `item.uid` repeats within one order's `items[]` in 18% of prod
 * orders, standalone and as a component of one or more kits, and the bare
 * 3-segment id could not tell those occurrences apart. `BookingId` is now the
 * union of that unchanged 3-segment form and a 4-segment one that appends a
 * signature hash of the item's *component ancestry* — its chain of product
 * (never divider) ancestors — for exactly the occurrences that need it. The
 * derivation lives in `core/src/utils/booking-id.ts`
 * (`componentAncestry`/`componentSignatureHash`/`buildBookingId`), the one
 * place a `BookingId` is assembled from parts.
 *
 * **`isProductShapedUid` is exported from HERE, not from `booking-id.ts`**,
 * because it is a fact about `ItemUid`'s own grammar, not about bookings: a
 * bare `z.uuid()` path segment is always a structural divider
 * (`getStructuralUids`' domain — `ORDER_ITEM_LEVELS` fixes dividers to the top
 * of a subtree, never nested inside a product's own components), while a bare
 * `FirestoreId` or a `custom-`-prefixed segment is always a product. So the
 * predicate is derivable from `ItemUid`'s union alone — no `structuralUids` set
 * has to travel alongside a `path` for `componentAncestry` to read it correctly.
 *
 * ⚠️ **`MovementId`'s subject arm is a permanent union of the 3- and
 * 4-segment forms**, not a transitional one. `transactions` is an
 * append-only journal, so a historical movement's stored id records what its
 * subject's id *was at the time* and is never rewritten — old rows keep the
 * 3-segment shape indefinitely for bookings that existed before the 4-segment
 * form shipped.
 *
 * ## Naming: `uid` is a document id, `uuid` is someone else's id
 *
 * This module is about the **form** an id takes; the companion rule is about
 * what it may be **called**, and until 2026-08-23 it was written down nowhere.
 *
 * > `uid` / `uid_{domain}` is a Firestore **document id** — a native auto-id or
 * > a CFS deterministic composite.
 * > `uuid` is an **actual UUID from elsewhere** (Uploadcare, some line-item
 * > types) — which is why the table's last row is `uuid` and not `uid`.
 *
 * It governs document identity and cross-document references. Array-element ids
 * are the separate concern `ItemUid` above already types.
 *
 * Measured 2026-08-23: of the registry's 56 distinct document types, **41
 * declare `uid` and 15 do not** — a credential class (the doc id is the bearer
 * token, so copying it into the body only widens a leak), a natural-key class
 * (hot-path plumbing with no reader of a body id), one genuine gap
 * (`orders/{uid}/documents`), and a class whose id sits in the body under
 * another name. Of that last class exactly three are sanctioned:
 * **`roles.name`** (security rules can only `get()` by path, never query),
 * **`mcp-oauth-clients.client_id`** (an RFC 7591 wire name), and
 * **`uploadcare-worklist.uuid`** (already correct — it IS an Uploadcare UUID).
 * `core/CLAUDE.md` § *UID property naming* carries the full table and the
 * reasoning.
 *
 * 🔴 **The naming is load-bearing, not cosmetic.** api-cloudrun's write-time
 * drift guard reads `doc.uid` and compares it to `ref.id`; a document that
 * names its id field anything else passes **silently**. So the guard covers
 * exactly the 41 — and nothing declares which 15 it does not.
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

const BARE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether an `ItemUid`-shaped `path` segment names a PRODUCT (including a
 * custom product) rather than a structural (destination/group) divider — see
 * the "`BookingId`'s 4th segment" section above. A bare `z.uuid()` is always a
 * divider; a `FirestoreId` or a `custom-`-prefixed uid is always a product,
 * and the two are distinguishable by this one check because a `FirestoreId`
 * never contains a `-`. This is `core/src/utils/booking-id.ts`'s
 * `componentAncestry` filter, exported from the grammar it reads rather than
 * from the booking-specific module that consumes it.
 */
export function isProductShapedUid(uid: string): boolean {
  return !BARE_UUID.test(uid);
}

/** Internal, un-annotated so `MovementId` can embed its pattern. */
const bookingIdTopLevel = z.templateLiteral([
  firestoreId,
  ":",
  z.union([firestoreId, customItemUid]),
  ":",
  firestoreId,
]);

/**
 * Internal, un-annotated so `MovementId` can embed its pattern. The 4th
 * segment is the first 12 hex chars of a SHA-256 digest — see
 * `booking-id.ts`'s `componentSignatureHash`.
 */
const bookingIdComponent = z.templateLiteral([
  firestoreId,
  ":",
  z.union([firestoreId, customItemUid]),
  ":",
  firestoreId,
  ":",
  z.string().regex(/^[0-9a-f]{12}$/, "Must be a 12-hex component signature hash"),
]);

/**
 * `bookings.uid` — deterministic composite, sparse by construction:
 * `{uid_order}:{item uid}:{uid_destination}` for a top-level occurrence
 * (unchanged, byte-for-byte, from before the 4-segment form existed; the
 * middle segment is the order item's uid, which for a custom product is
 * `custom-{uuid}`), or `{uid_order}:{item uid}:{uid_destination}:{hash}` for
 * an occurrence that is a component of a kit — see the "`BookingId`'s 4th
 * segment" section above. Built only through `booking-id.ts`'s
 * `buildBookingId`; never assembled by hand at a second call site.
 */
export const BookingId: z.ZodType<string> = z.union([bookingIdTopLevel, bookingIdComponent]);

/**
 * `transactions.uid` for a movement-journal event — the deterministic composite
 * `{uuid_session}|{type}|{subject}`, where the subject is a product id (ownership
 * events) or a `BookingId` (custody events).
 *
 * **The separator is `|`, not `:`, and that is load-bearing.** A `BookingId` is
 * itself `a:b:c`, so a colon-joined id would carry 2 colons for a product
 * subject and 4 for a booking one — variable arity that no `split(":")` can
 * disambiguate.
 *
 * **The `type` segment is load-bearing too:** one operator action legitimately
 * produces several event types against one subject ("return 2, mark 1 damaged"
 * is two picker actions on one booking), so session+subject alone would collide.
 * It is matched loosely here (`[a-z][a-z_]*`) rather than against
 * `MOVEMENT_TYPES` — `schemas/transaction.ts` imports this module, so the reverse
 * dependency would be a cycle, and the `type` **field** is the authority
 * anyway. The id only has to be well-formed and stable.
 *
 * This is the sanctioned use of a derived id: it is what makes an append-only
 * event idempotent under the manager's retry-on-409, exactly as the derived
 * `bookings` id makes a booking upsert idempotent.
 *
 * ⚠️ The subject arm is `firestoreId | bookingIdTopLevel | bookingIdComponent`
 * — a permanent union, not a transitional one. See the "`BookingId`'s 4th
 * segment" section above.
 */
export const MovementId: z.ZodType<string> = z.templateLiteral([
  z.uuid(),
  "|",
  z.string().regex(/^[a-z][a-z_]*$/, "Must be a movement type segment"),
  "|",
  z.union([firestoreId, bookingIdTopLevel, bookingIdComponent]),
]);

/**
 * `quotes.uid` — deterministic composite `{uid_order}:v{N}` (saved versions) or
 * `{uid_order}:draft` (the working draft). Built in
 * `api-cloudrun/src/services/quotes.ts` (`${uidOrder}:v${version}` / `${uidOrder}:draft`).
 */
export const QuoteId: z.ZodType<string> = z.union([
  z.templateLiteral([firestoreId, ":v", z.number()]),
  z.templateLiteral([firestoreId, ":draft"]),
]);

/**
 * `statement-documents.uid` — `{uid_organization}:v{N}`.
 *
 * ⭐ **{@link QuoteId} minus the `:draft` arm, and the absence is the design.** A
 * quote has a canonical draft because the ORDER decides its content; a statement
 * does not, because the REQUEST decides it — there is no "the statement for this
 * organization" for a draft to be of. Built in
 * `api-cloudrun/src/services/reporting/statement.ts`.
 */
export const StatementDocumentId: z.ZodType<string> = z.templateLiteral([
  firestoreId,
  ":v",
  z.number(),
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
 * `threads.uid` and every `uid_thread` reference — `cards`, `comments`, and the
 * eight default-thread carriers (`orders`, `invoices`, `products`, `roles`,
 * `contacts`, `organizations`, `out-of-service`, `credit-notes`, where it is
 * `.optional()`) — either a Firestore auto-id (the default-thread cowrite) or
 * an `EventCardId` composite. Event-card threads are minted at a **deterministic
 * id equal to their card uid** (`${uid_order}:${uid_destination}:start|end`) so
 * the delete→recreate churn of a CRMS opportunity-webhook burst reuses the one
 * stable `threads/{cardUid}` doc instead of piling up random-id orphans (and
 * comments survive across the cycle). Structurally identical to `CardId`; see
 * `services/eventCardReconcile.ts` `eventCardThreadId`.
 */
export const ThreadId: z.ZodType<string> = z.union([firestoreId, EventCardId]);

/**
 * A lowercase-kebab slug: `^[a-z][a-z0-9-]*$`.
 *
 * ⚠️ **One fragment, because three validators used to spell it separately and
 * one of them disagreed.** `RoleId`, `ListId` and `AnyUid`'s slug arm all mean
 * the same shape, and `roles.name` / `sessions.preview_role` additionally
 * allowed an underscore (`[a-z0-9_-]`) while `AnyUid` did not — so a role named
 * `on_call` passed its own schema and then **failed its own creation
 * transaction**, because the thread `sources[]` entry minted alongside it is
 * gated on `AnyUid`. Underscores are gone; see {@link RoleId}.
 */
const SLUG = "[a-z][a-z0-9-]*";
const slug = (message: string) => z.string().regex(new RegExp(`^${SLUG}$`), message);

/**
 * A role id — which for `roles` IS the document id, and also the claim string
 * written into `users.roles[]`, `invites.roles[]`, `sessions.preview_role` and
 * Firebase custom claims.
 *
 * ⚠️ **`roles.name` is a deliberate carve-out from the `uid` convention** — the
 * doc id must BE the claim string because `manager/firestore.rules` can only
 * `get()` by path and never query. The reasoning is in
 * `core/.claude/plans/roles-campaign.md`; do not "fix" it to `uid`.
 *
 * ⚠️ **Kept an open string, NOT a closed enum.** `POST /admin/roles` exists, so
 * an operator-created role must stay representable. The six git-declared roles
 * are {@link SEEDED_ROLE_NAMES}, which is the narrower literal type — use that
 * where a specific role is meant, and this where any role is.
 *
 * The 64-char cap is a **token-size constraint, not cosmetic**: `customClaims.roles[]`
 * must stay inside Firebase's 1000-byte limit.
 *
 * Verified against both environments before shipping (2026-08-23): 6 live roles
 * in each — `admin`, `authenticated`, `customer`, `template-editor`,
 * `template-maintainer`, `warehouse` — plus every `users.roles[]`,
 * `invites.roles[]` and `threads.sources[]` entry with `collection: "roles"`.
 * **0 would have failed the no-underscore form.**
 */
export const RoleId: z.ZodType<string> = slug(
  "Must be lowercase alphanumerics or hyphens, starting with a letter",
).min(1).max(64);

/**
 * The six roles declared in git (`api-cloudrun/scripts/rbacRoles.ts`) and seeded
 * by `seed-rbac.ts`.
 *
 * ⚠️ This is NOT the storage type — see {@link RoleId}. It exists so the role
 * literals scattered through production source and fixtures become compile-
 * checked rather than free strings.
 */
export const SEEDED_ROLE_NAMES = [
  "admin",
  "authenticated",
  "customer",
  "template-editor",
  "template-maintainer",
  "warehouse",
] as const;

/** One of the six git-declared roles. @see {@link SEEDED_ROLE_NAMES} */
export type SeededRoleName = typeof SEEDED_ROLE_NAMES[number];

/**
 * `lists.uid` (and `uid_list` references) — a Firestore auto-id (user-created
 * lists) or a lowercase-kebab slug (seeded/system lists, e.g. `in-store`,
 * `field-service`).
 */
export const ListId: z.ZodType<string> = z.union([
  firestoreId,
  slug("Must be a list slug"),
]);

/**
 * Any known CFS document-id shape — atomic Firestore id, divider/custom item
 * id, a composite (booking / event-card), or a lowercase-kebab slug (slug-keyed
 * collections such as `roles` and seeded `lists`). Use for polymorphic
 * references (`DocSource`, `UidNameRef`) that may point at any collection.
 * `ItemUid` already covers `FirestoreId | uuid | custom-`.
 */
export const AnyUid: z.ZodType<string> = z.union([
  ItemUid,
  BookingId,
  EventCardId,
  // A movement's id is a composite too, and movements reference each other: a
  // reversal names the event it negates in `sources[]`. Without this arm that
  // reference falls through to the slug pattern and the reversal — the journal's
  // only correction path — fails validation on write.
  MovementId,
  // Same fragment as `RoleId` / `ListId`. They were three separate regexes, and
  // the role one disagreed — which is what made `on_call` fail its own creation
  // transaction. See SLUG above.
  slug("Must be a slug"),
]);
