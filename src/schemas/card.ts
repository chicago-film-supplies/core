/**
 * Card document schema — Firestore collection: cards
 *
 * The generalized work-item surface that replaces `order-events`. Cards drive
 * the Dashboard's list/agenda/kanban/calendar/map views — one schema for
 * field-service events, to-dos, shopping items, and calendar entries.
 *
 * Cards belong to one `lists/{uid_list}` (routable bucket) and carry a
 * fractional `position` for drag-reorder. They reference any number of source
 * docs (`sources: DocSource[]`) to surface the card wherever the sources are
 * displayed (e.g. an event card on its parent order detail page). Every card
 * cowrites a default thread on creation so comments have a target.
 *
 * The `locked[]` enum pins specific fields against PATCH and, when it
 * contains `"card"`, blocks DELETE — used by order-event-migrated cards to
 * prevent users from editing the subject or deleting the card while the
 * underlying order still exists.
 *
 * Recurrence fields:
 * - `recurrence_parent_uid` + `recurrence_index` — when non-null, the card
 *   was materialized from a `recurrences/{uid}` prototype.
 * - `recurrence_overrides` — iCal-style override markers. Field names
 *   listed here were user-edited on this specific instance (via
 *   `PATCH /cards/{uid}?recurrence_scope=this`) and must not be clobbered
 *   when the parent recurrence's prototype updates fan out to siblings.
 */
import { z } from "zod";
import { CardId, FirestoreId, ListId, ThreadId } from "./_uid.ts";
import { chicagoInstant } from "./_datetime.ts";
import { uploadcareRef } from "./uploadcare/ref.ts";
import {
  ActorRef,
  type ActorRefType,
  DocSource,
  type DocSourceType,
  FirestoreTimestamp,
  type FirestoreTimestampType,
  OrderDerivedOrgPath,
  type OrgPathNodeType,
  TimestampFields,
} from "./common.ts";
import { CommentBody, type CommentBodyJson } from "./comment.ts";
import {
  DocDestinationEndpoint,
  type DocDestinationEndpointType,
} from "./order.ts";

// ── Status enum ─────────────────────────────────────────────────────

const CARD_STATUSES = [
  "draft",
  "planned",
  "active",
  "blocked",
  "complete",
  "canceled",
] as const;
/** Allowed card statuses. Shared across field-service, to-do, shopping, calendar. */
export type CardStatus = typeof CARD_STATUSES[number];
/** Zod schema for CardStatus. */
export const CardStatusEnum: z.ZodType<CardStatus> = z.enum(CARD_STATUSES);

// ── Action (denormalized next-step button) ──────────────────────────

const CARD_FULFILLMENT_ACTIONS = ["prep", "checkout", "return"] as const;
/** The next fulfillment step a fulfillment-sourced card surfaces on its button. */
export type CardFulfillmentAction = typeof CARD_FULFILLMENT_ACTIONS[number];
/** Zod schema for CardFulfillmentAction. */
export const CardFulfillmentActionEnum: z.ZodType<CardFulfillmentAction> = z.enum(
  CARD_FULFILLMENT_ACTIONS,
);

/**
 * Denormalized "next action" for a card's primary button, computed server-side
 * on every booking write (alongside `status`). Surfaces on Dashboard/Calendar
 * surfaces where no bookings are loaded, so the button can show the *next* step
 * without a join.
 *
 * A discriminated object (not a flat enum) so non-fulfillment sources can be
 * added as purely additive arms (e.g. `{ source: "out_of_service", value: … }`)
 * without a cross-repo field rename. `null` when nothing is actionable
 * (terminal status, or no pending step on this side).
 */
export type CardAction = { source: "fulfillment"; value: CardFulfillmentAction };
/** Zod schema for CardAction (discriminated on `source`; JSR no-slow-types-safe). */
export const CardActionSchema: z.ZodType<CardAction> = z.discriminatedUnion("source", [
  z.strictObject({ source: z.literal("fulfillment"), value: CardFulfillmentActionEnum }),
]);

// ── Lock keys ───────────────────────────────────────────────────────

const CARD_LOCK_KEYS = [
  "card",
  "uid_list",
  "status",
  "status_auto",
  "subject",
  "body",
  "body_text",
  "dates",
  "destination",
  "organization",
  "sources",
  "attachments",
  "uid_assignees",
] as const;
/**
 * Enum of lockable card surfaces.
 *
 * - `"card"` — presence blocks DELETE (all other keys are field locks)
 * - `"status_auto"` — narrow override slot: server auto-computes `status`,
 *   but PATCH still accepts `status: "blocked"` (manual block) or a no-op of
 *   the current auto value. Distinct from `"status"`, which fully locks the
 *   field.
 * - Any other value — presence rejects PATCH of that specific field
 *
 * Narrower than `(keyof Card)[]` because (a) most Card fields are
 * system-managed (uid, timestamps, actor refs) and nonsensical to lock, and
 * (b) we need a sentinel for "prevent delete" that doesn't collide with a
 * real field name.
 */
export type CardLockKey = typeof CARD_LOCK_KEYS[number];
/** Zod schema for CardLockKey. */
export const CardLockKeyEnum: z.ZodType<CardLockKey> = z.enum(CARD_LOCK_KEYS);

// ── Attachments ─────────────────────────────────────────────────────

const CARD_ATTACHMENT_TYPES = [
  "image",
  "file",
  "packing",
  "quote",
  "invoice",
] as const;
/**
 * Semantic discriminator for a card attachment. Server-derived attachments
 * (packing/quote/invoice) carry their domain meaning so the UI can render
 * them as labelled chips without sniffing MIME or filename. User uploads
 * default to `image` (when MIME starts with `image/`) or `file` otherwise.
 */
export type CardAttachmentTypeEnum = typeof CARD_ATTACHMENT_TYPES[number];
/** Zod schema for CardAttachmentTypeEnum. */
export const CardAttachmentTypeEnumSchema: z.ZodType<CardAttachmentTypeEnum> =
  z.enum(CARD_ATTACHMENT_TYPES);

/** A single attachment on a card (Uploadcare UUID + display metadata). */
export interface CardAttachmentType {
  uid: string;
  type: CardAttachmentTypeEnum;
  filename: string;
  mime_type: string;
  size_bytes: number;
  locked: boolean;
}

/**
 * Zod schema for a card attachment.
 *
 * One node, seven consumers — `CardSchema`, `RecurrenceSchema`'s prototype, and
 * the create/update inputs of both all reference this same instance, and
 * `z.globalRegistry` is a WeakMap keyed on the instance. So the single
 * `uploadcareRef()` below annotates `uid` for every one of them.
 *
 * ⚠️ **This used to justify itself with "no `.extend()` / `.omit()` / `.pick()`
 * anywhere in `src/schemas/`", and that was FALSE for five weeks** —
 * `product.ts` gained one in `91ea625` (2026-07-29) and nothing noticed
 * (core#82). The conclusion held the whole time, but by accident of *which*
 * object was extended rather than by the global absence it claimed. A comment
 * asserting an unchecked premise is worse than no comment: it reads as verified.
 *
 * ⭐ **What holds it up now is a test, not a sentence.** Composition goes through
 * `extendChecked` (`_extend.ts`), which captures the (base, derived) pair at
 * construction, and `tests/meta-preservation.test.ts` both forbids a bare
 * `.extend()`/`.merge()` in `src/` and diffs every re-declared field's
 * annotations against its base. So the reachability argument above is only ever
 * one part of the guarantee — the other part reddens.
 */
export const CardAttachment: z.ZodType<CardAttachmentType> = z.strictObject({
  uid: uploadcareRef(z.uuid()),
  type: CardAttachmentTypeEnumSchema.meta({ column: true, label: "Type" }),
  filename: z.string().min(1).max(260).meta({ pii: "mask", column: true, label: "Filename" }),
  mime_type: z.string().min(1).max(120),
  size_bytes: z.int().min(0),
  locked: z.boolean(),
});

// ── Organization (denormalized) ─────────────────────────────────────

/**
 * Denormalized organization snapshot on order-derived event cards. Surfaces
 * "who is this card for?" on every card-rendering surface (list, kanban,
 * calendar, dashboard) without joining back to the order.
 *
 * ⚠️ **`uid` is nullable for the HAND-AUTHORED card, and the reason it used to
 * give was dead.** The old justification — *"some organizations exist without a
 * CFS-side uid (legacy CRMS-only customers)"* — outlived CRMS, which was retired
 * 2026-09-04. Measured 2026-09-19: **0 of 1,175 prod event cards carry a null
 * here**, and `checkEventCard` now requires it non-null on that kind. What keeps
 * the nullability is the to-do: a card with no order has no organization, and 7
 * such cards exist in dev.
 */
export interface CardOrganizationType {
  uid: string | null;
  path: OrgPathNodeType[];
}

/** Zod schema for CardOrganizationType. */
export const CardOrganization: z.ZodType<CardOrganizationType> = z.strictObject({
  uid: FirestoreId.nullable(),
  path: OrderDerivedOrgPath,
});

// ── Source payloads ─────────────────────────────────────────────────

/**
 * The `fulfillments` SOURCE PAYLOAD — the fields of the fulfillment's destination
 * pair that a card surface reads, copied under the pair's OWN names.
 *
 * **Event cards are sourced from the FULFILLMENT (owner, 2026-09-21).** A card
 * describes what happens on the ground; the order is the quote. So an event
 * card's source is `{ collection: "fulfillments", uid }` — the same uid as its
 * order, since a fulfillment shares its order's id. The label was `orders` until
 * the api-cloudrun cards-from-fulfillments campaign relabelled both corpora
 * (2026-09-21) and this contract removed it.
 *
 * **This is the pattern for every future source kind (owner, 2026-09-20):**
 *
 * - **The key is a `sources[].collection` value, spelled exactly.** Event cards
 *   are sourced `{ collection: "fulfillments" }`, so the key is `fulfillments` —
 *   not `fulfillment`, and not a new word.
 * - **PRESENT iff that source is in `sources`, otherwise ABSENT — never `null`.**
 *   A stated exception to core#95's "key required, value nullable": with N
 *   source kinds every card would otherwise carry N nulls, and `cards` must
 *   stay light.
 * - **The value holds only fields a card surface READS** (list, facet, button),
 *   copied from the source doc under their own names. `leg` is the one
 *   exception: it says WHICH part of the source this card projects, and
 *   `checkEventCard` pins it to the id's `:start` / `:end`.
 * - **One writer: the projection that owns the card** (`buildEventCards`). It
 *   is rebuilt on every build, never carried forward the way `action` is.
 * - **No `source` discriminator inside it.** The card's kind is already
 *   `sources`; a second copy could disagree with it.
 *
 * `destination` and `organization` are this same pattern from before it had a
 * name. They are not migrated.
 *
 * Why this exists: a card never stored the collect flag, and api-cloudrun#662
 * repoints every customer-collect leg at the store's own destination — 24 of 43
 * open prod cards (2026-09-20) sat on that one `destination.uid`. The flag is
 * what lets the index tell an in-store leg from a delivery there; see
 * `cardPickBucket` (`@cfs/core/utils/cards`).
 *
 * **REQUIRED on an event card** (`checkEventCard`). It was optional while the
 * corpus was rebuilt; the relabel wrote it onto every event card — 1,191 of
 * 1,191 in each environment, 0 unresolved — and `buildEventCards` writes it on
 * every build.
 */
export type CardFulfillmentsSourceType =
  | { leg: "start"; customer_collecting: boolean }
  | { leg: "end"; customer_returning: boolean };

/** Zod schema for CardFulfillmentsSourceType (discriminated on `leg`; JSR no-slow-types-safe). */
export const CardFulfillmentsSource: z.ZodType<CardFulfillmentsSourceType> = z.discriminatedUnion("leg", [
  z.strictObject({ leg: z.literal("start"), customer_collecting: z.boolean() }),
  z.strictObject({ leg: z.literal("end"), customer_returning: z.boolean() }),
]);

// ── Firestore document ──────────────────────────────────────────────

/**
 * Card datetime range. `start` is the canonical occurrence instant — Chicago
 * offset form, idempotent through `chicagoInstant()`. `end` carries the
 * occurrence's wall-clock close (deliveries with start + end times); `null`
 * means single-instant or all-day. `start` is nullable so cards without a
 * date (generic to-dos, shopping items) stay valid.
 */
export interface CardDatesType {
  start: string | null;
  end: string | null;
}

/** Card Firestore document shape. */
export interface Card {
  uid: string;
  uid_list: string;
  uid_thread: string;
  status: CardStatus;
  action: CardAction | null;
  position: number;
  subject: string;
  body: CommentBodyJson | null;
  body_text: string;
  dates: CardDatesType;
  all_day: boolean;
  date_fs: FirestoreTimestampType | null;
  destination: DocDestinationEndpointType | null;
  organization: CardOrganizationType | null;
  sources: DocSourceType[];
  /** The `fulfillments` source payload — present iff `sources` names a fulfillment. See {@link CardFulfillmentsSource}. */
  fulfillments?: CardFulfillmentsSourceType;
  attachments: CardAttachmentType[];
  uid_assignees: string[];
  locked: CardLockKey[];
  recurrence_parent_uid: string | null;
  recurrence_index: number | null;
  recurrence_overrides: string[];
  version: number;
  created_by: ActorRefType;
  updated_by: ActorRefType;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}

/** Zod schema for the card dates sub-object. */
export const CardDates: z.ZodType<CardDatesType> = z.strictObject({
  // `serverSortVia` names the stored Timestamp this ISO field is ordered by —
  // and, because they are the same value under two encodings, it is also what
  // tells the Typesense surface that its `date_fs` column IS this one. The two
  // names do not correspond, so nothing but a declaration could pair them.
  // `readMetaThroughWrappers` (`zod-walk.ts`) reads THROUGH wrappers rather than
  // unwrapping first, so the tag resolves whether it sits on the pipe (here,
  // matching `booking.ts`) or on the outer `.default()` (`invoice.due_date`
  // uses that form today) — factory placement is convention, not necessity.
  start: chicagoInstant().meta({ column: true, label: "Date", serverSortVia: "date_fs" }).nullable(),
  end: chicagoInstant().meta({ column: true, label: "End Date" }).nullable(),
});

/** Zod schema for a card Firestore document. */
/**
 * An event card is one the fulfillment projection OWNS — `buildEventCards` built
 * it, `reconcileEventCards` recomputes it, and a uid that does not parse as an
 * {@link EventCardId} gets it hard-deleted. The discriminator is DERIVED rather
 * than stored, and `sources` is the only place it can be read from: a card
 * carrying a `fulfillments` source is this projection's. (The label was `orders`
 * until both corpora were relabelled on 2026-09-21; an `orders` source now marks
 * nothing.)
 *
 * ⚠️ **Do not switch this to an id-shape test.** The id is what the projection
 * MINTS; the source is what makes the card the projection's to mint. Keying the
 * refinement on the id would make a malformed id unrepresentable *and* exempt
 * from every other rule here, which is backwards.
 * `assertClientAuthoredCardShape` (`api-cloudrun/src/lib/serverOwnedCards.ts`)
 * refuses an event source from `POST /cards` and from a recurrence prototype,
 * which is what makes this predicate an authorization fact rather than a
 * heuristic. `manager/src/utils/cardKind.ts` spells it the same way.
 */
const isEventCard = (doc: Card): boolean =>
  doc.sources.some((s) => s.collection === "fulfillments");

/**
 * Per-KIND requiredness: the five fields an event card always has, and a
 * hand-authored to-do legitimately does not.
 *
 * 🔴 **The corpus is not the argument — the feature is.** All five read 0 nulls
 * across 1,175 prod and 1,175 dev event cards (2026-09-19), but dev also holds
 * **7 hand-authored to-do cards** carrying `destination: null` AND
 * `organization: null` with `sources: []` — the path that has never run in
 * prod. A blanket `.nonnullable()` would make that path unwritable, so the
 * nullability stays and the requirement is scoped to the kind that earns it.
 *
 * ⚠️ **`destination.instructions` is deliberately ABSENT from this list**, and
 * it was in the plan that produced this refinement. **19 event cards in each
 * corpus carry `instructions: null`** — and null MEANS *no special
 * instructions* there (`ensureDestinationShape` writes `?? null`), so requiring
 * it would 400 nineteen documents for a correct value.
 *
 * ⚠️ **`destination.address` is absent for a different reason — it is a
 * BACKLOG, not a semantic null.** 11 event cards in each corpus carry it null
 * because the order they project from has an endpoint with no address; the fix
 * is upstream and the tightening lands with it.
 */
function checkEventCard(doc: Card, ctx: z.RefinementCtx): void {
  if (!isEventCard(doc)) {
    // The payload is present IFF its source is — a to-do carrying a
    // `fulfillments` payload is claiming a projection nothing built.
    if (doc.fulfillments !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["fulfillments"],
        message: "fulfillments is present only on a card whose sources name a fulfillment",
      });
    }
    return;
  }

  // `leg` says which half of the pair this card projects, and the id already
  // says it. Two copies that could disagree are pinned together here.
  if (doc.fulfillments === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["fulfillments"],
      message: "fulfillments is required on an event card",
    });
  } else {
    const idLeg = doc.uid.endsWith(":start") ? "start" : doc.uid.endsWith(":end") ? "end" : null;
    if (idLeg !== doc.fulfillments.leg) {
      ctx.addIssue({
        code: "custom",
        path: ["fulfillments", "leg"],
        message: `fulfillments.leg "${doc.fulfillments.leg}" does not match the card id's leg (${idLeg ?? "none"})`,
      });
    }
  }

  const require = (ok: boolean, path: (string | number)[], field: string) => {
    if (ok) return;
    ctx.addIssue({
      code: "custom",
      path,
      message: `${field} is required on an order-derived event card`,
    });
  };

  require(doc.destination !== null, ["destination"], "destination");
  require(
    doc.destination === null || doc.destination.uid !== null,
    ["destination", "uid"],
    "destination.uid",
  );
  require(doc.organization !== null, ["organization"], "organization");
  require(
    doc.organization === null || doc.organization.uid !== null,
    ["organization", "uid"],
    "organization.uid",
  );
  require(doc.date_fs !== null, ["date_fs"], "date_fs");
}

export const CardSchema: z.ZodType<Card> = z.strictObject({
  uid: CardId,
  uid_list: ListId,
  uid_thread: ThreadId,
  status: CardStatusEnum.meta({ column: true, label: "Status" }),
  // **REQUIRED — inert `.default(null)` removed 2026-09-11 (core#95 batch 9).**
  // Both writers already state it — `createCard` writes an explicit `null` (a
  // user-authored card has no fulfillment action) and `buildEventCards` carries
  // the existing value forward. `null` stays a legal stored value; this requires
  // the KEY. See the note on `organization` below for why it was batch 9 rather
  // than batch 8.
  action: CardActionSchema.nullable(),
  position: z.number().meta({ column: true, label: "Position" }),
  // Required (no `.default("")`): the Typesense config declares it so, and a
  // `.default()` never materializes on a write — see the note in `product.ts`.
  subject: z.string().max(200).meta({ pii: "mask", column: true, label: "Subject" }),
  // `body`/`body_text`: required, and all 1,129 prod cards carry BOTH keys —
  // `body: null`, `body_text: ""` (2026-08-23). The prod corpus is entirely
  // machine-generated from orders, so the emptiness measures the hand-authored
  // card path never having run, not a dead field. CLAUDE.md § "Is a field dead?".
  body: CommentBody.nullable(),
  // **REQUIRED — the inert `.default("")` came off 2026-09-11 (core#95 batch 8).**
  // The line above already measures the corpus; the `.default()` never put the
  // key there. `""` stays a legal stored value — this requires the KEY and makes
  // no claim about the VALUE.
  body_text: z.string().max(20000).meta({ pii: "mask", column: true, label: "Body" }),
  dates: CardDates,
  // **REQUIRED — inert `.default(false)` removed 2026-09-11 (core#95 batch 8).**
  // ⚠️ Removing it is invisible to `getInitialValues`: `resolveField`'s type
  // switch returns `false` for a bare `z.boolean()`, which is the value the
  // default carried. That equality is what made this batch free of a manager
  // change — and it is exactly what `.meta({ initial })` exists for when it does
  // NOT hold (see the note in `initial.ts`). Do not assume it for a
  // `.default(true)`.
  all_day: z.boolean(),
  date_fs: FirestoreTimestamp.nullable(),
  destination: DocDestinationEndpoint.nullable().meta({ label: "Destination" }),
  // **REQUIRED — inert `.default(null)` removed 2026-09-11 (core#95 batch 9).**
  // 🔴 **Batch 8 deferred this and `action` because 7 dev cards omitted them**,
  // and those 7 were the only HAND-AUTHORED cards in either corpus — so a
  // prod-only reading (1,159 of 1,159) would have called both free while
  // measuring nothing but `buildEventCards`. They were repaired on the owner's
  // call, dev-only, with the values `createCard` writes for that population;
  // both positions now read 1,161/1,161 prod and 1,168/1,168 present.
  // ⚠️ The witness is gone by design — that repair is why this line can exist.
  organization: CardOrganization.nullable().meta({ label: "Organization" }),
  sources: z.array(DocSource).meta({ label: "Source" }),
  // ABSENT rather than null off an event card, by rule — see
  // `CardFulfillmentsSource`. Required ON an event card by `checkEventCard`.
  fulfillments: CardFulfillmentsSource.optional(),
  // **REQUIRED ×3 — inert `.default([])` removed 2026-09-11 (core#95 batch 8).**
  // 1,159 prod / 1,166 dev cards state all three, and dev is a genuine second
  // sample here: its 7 extra documents are the only hand-authored cards in
  // either corpus (prod's are all machine-generated by `buildEventCards`), and
  // they state these three too. ⚠️ The same 7 omitted `action` and
  // `organization`, which is why those two waited for batch 9. See core#95.
  attachments: z.array(CardAttachment).meta({ label: "Attachment" }),
  uid_assignees: z.array(FirestoreId),
  locked: z.array(CardLockKeyEnum),
  // Both recurrence fields: key present on all 1,129 prod cards, always `null`
  // (2026-08-23). Same reason as `body` above — no recurrence has been expanded.
  recurrence_parent_uid: FirestoreId.nullable(),
  recurrence_index: z.int().nullable(),
  recurrence_overrides: z.array(z.string()).default([]),
  version: z.int().min(0).default(0),
  created_by: ActorRef.meta({ column: true, label: "Created By" }),
  updated_by: ActorRef.meta({ column: true, label: "Updated By" }),
  ...TimestampFields,
}).superRefine(checkEventCard).meta({
  title: "Card",
  collection: "cards",
  displayDefaults: {
    columns: ["subject", "status", "dates.start", "created_by"],
    filters: { status: [] },
    sort: { column: "position", direction: "asc" },
    groupBy: [
      { field: null, label: "None" },
      { field: "uid_list", label: "List", kind: "collectionFeed", collection: "lists" },
      { field: "status", label: "Status", kind: "enum" },
      { field: "dates.start", label: "Date", kind: "dateBucket" },
    ],
  },
});

// ── Input schemas ───────────────────────────────────────────────────

/** Input for POST /cards. */
export interface CreateCardInputType {
  uid_list: string;
  subject: string;
  status?: CardStatus;
  position?: number;
  body?: CommentBodyJson | null;
  body_text?: string;
  dates?: CardDatesType;
  all_day?: boolean;
  destination?: DocDestinationEndpointType | null;
  organization?: CardOrganizationType | null;
  sources?: DocSourceType[];
  attachments?: CardAttachmentType[];
  uid_assignees?: string[];
  locked?: CardLockKey[];
}

/** Zod schema for creating a card. */
export const CreateCardInput: z.ZodType<CreateCardInputType> = z.object({
  uid_list: ListId,
  subject: z.string().min(1).max(200).meta({ pii: "mask" }),
  status: CardStatusEnum.optional(),
  position: z.number().optional(),
  body: CommentBody.nullable().optional(),
  body_text: z.string().max(20000).meta({ pii: "mask" }).optional(),
  dates: CardDates.optional(),
  all_day: z.boolean().optional(),
  destination: DocDestinationEndpoint.nullable().optional(),
  organization: CardOrganization.nullable().optional(),
  sources: z.array(DocSource).optional(),
  attachments: z.array(CardAttachment).optional(),
  uid_assignees: z.array(FirestoreId).optional(),
  locked: z.array(CardLockKeyEnum).optional(),
});

/**
 * Input for PATCH /cards/:uid — all fields optional except version.
 *
 * 🔴 **`locked` is deliberately ABSENT here while `CreateCardInputType` has it.
 * A card's lock set is settable at birth and never afterwards, and the
 * asymmetry is the point.** `locked[]` is a server-authored ACL, not user
 * content: `buildEventCards` stamps `ORDER_CARD_LOCKED` on every order-derived
 * card so an operator cannot edit the subject, re-point the destination or
 * delete a card while its order still exists. Accepting `locked` on PATCH would
 * let anyone holding `cards.update` unlock their own card and then edit the very
 * field the lock protects — a one-request escalation past every one of those
 * guards, including `"card"`, the sentinel that blocks DELETE and which
 * `eventCardReconcile` treats as a load-bearing invariant.
 *
 * Keeping it on CREATE is not the same hole. A client can only create a
 * hand-authored card, and choosing its own new card's locks harms nobody —
 * the worst case is an undeletable to-do of its own making. Order-derived cards
 * are minted server-side at a derived id and never come through this input at
 * all.
 *
 * So: **to change a lock set, change the writer that stamps it.** There is no
 * API path, by design. Decided 2026-09-04 (core#79), which was filed because
 * the asymmetry was silent rather than wrong.
 */
export interface UpdateCardInputType {
  uid_list?: string;
  status?: CardStatus;
  position?: number;
  subject?: string;
  body?: CommentBodyJson | null;
  body_text?: string;
  dates?: CardDatesType;
  all_day?: boolean;
  destination?: DocDestinationEndpointType | null;
  organization?: CardOrganizationType | null;
  sources?: DocSourceType[];
  attachments?: CardAttachmentType[];
  uid_assignees?: string[];
  version: number;
}

/**
 * Zod schema for updating a card. Lock enforcement happens at the service
 * layer (api-cloudrun) — the schema accepts any field, then service rejects
 * with FIELD_LOCKED if the card's `locked[]` contains the field name.
 */
export const UpdateCardInput: z.ZodType<UpdateCardInputType> = z.object({
  uid_list: ListId.optional(),
  status: CardStatusEnum.optional(),
  position: z.number().optional(),
  subject: z.string().min(1).max(200).meta({ pii: "mask" }).optional(),
  body: CommentBody.nullable().optional(),
  body_text: z.string().max(20000).meta({ pii: "mask" }).optional(),
  dates: CardDates.optional(),
  all_day: z.boolean().optional(),
  destination: DocDestinationEndpoint.nullable().optional(),
  organization: CardOrganization.nullable().optional(),
  sources: z.array(DocSource).optional(),
  attachments: z.array(CardAttachment).optional(),
  uid_assignees: z.array(FirestoreId).optional(),
  version: z.int().min(0),
});
