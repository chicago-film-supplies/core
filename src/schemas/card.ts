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
 * the create/update inputs of both all reference this same instance (no
 * `.extend()` / `.omit()` / `.pick()` anywhere in `src/schemas/`), and
 * `z.globalRegistry` is a WeakMap keyed on the instance. So the single
 * `uploadcareRef()` below annotates `uid` for every one of them.
 */
export const CardAttachment: z.ZodType<CardAttachmentType> = z.strictObject({
  uid: uploadcareRef(z.uuid()),
  type: CardAttachmentTypeEnumSchema.meta({ column: true, label: "Type" }),
  filename: z.string().min(1).max(260).meta({ pii: "mask", column: true, label: "Filename" }),
  mime_type: z.string().min(1).max(120),
  size_bytes: z.int().min(0),
  locked: z.boolean().default(false),
});

// ── Organization (denormalized) ─────────────────────────────────────

/**
 * Denormalized organization snapshot on order-derived event cards. Surfaces
 * "who is this card for?" on every card-rendering surface (list, kanban,
 * calendar, dashboard) without joining back to the order. `uid` is nullable
 * because some organizations exist without a CFS-side uid (legacy CRMS-only
 * customers).
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
  // The annotation sits on the PIPE, before `.nullable()`, matching `booking.ts`
  // and `schemas/out-of-service.ts`: `getServerSortableColumns` unwraps to the pipe and
  // reads meta THERE, so a tag on the outer `.default()` is invisible to it —
  // and with it invisible, the Typesense `date_fs` column loses its pairing.
  start: chicagoInstant().meta({ column: true, label: "Date", serverSortVia: "date_fs" }).nullable().default(null),
  end: chicagoInstant().meta({ column: true, label: "End Date" }).nullable().default(null),
});

/** Zod schema for a card Firestore document. */
export const CardSchema: z.ZodType<Card> = z.strictObject({
  uid: CardId,
  uid_list: ListId,
  uid_thread: ThreadId,
  status: CardStatusEnum.meta({ column: true, label: "Status" }),
  action: CardActionSchema.nullable().default(null),
  position: z.number().meta({ column: true, label: "Position" }),
  // Required (no `.default("")`): the Typesense config declares it so, and a
  // `.default()` never materializes on a write — see the note in `product.ts`.
  subject: z.string().max(200).meta({ pii: "mask", column: true, label: "Subject" }),
  // `body`/`body_text`: required, and all 1,129 prod cards carry BOTH keys —
  // `body: null`, `body_text: ""` (2026-08-23). The prod corpus is entirely
  // machine-generated from orders, so the emptiness measures the hand-authored
  // card path never having run, not a dead field. CLAUDE.md § "Is a field dead?".
  body: CommentBody.nullable(),
  body_text: z.string().max(20000).meta({ pii: "mask", column: true, label: "Body" }).default(""),
  dates: CardDates,
  all_day: z.boolean().default(false),
  date_fs: FirestoreTimestamp.nullable(),
  destination: DocDestinationEndpoint.nullable().meta({ label: "Destination" }),
  organization: CardOrganization.nullable().default(null).meta({ label: "Organization" }),
  sources: z.array(DocSource).meta({ label: "Source" }),
  attachments: z.array(CardAttachment).default([]).meta({ label: "Attachment" }),
  uid_assignees: z.array(FirestoreId).default([]),
  locked: z.array(CardLockKeyEnum).default([]),
  // Both recurrence fields: key present on all 1,129 prod cards, always `null`
  // (2026-08-23). Same reason as `body` above — no recurrence has been expanded.
  recurrence_parent_uid: FirestoreId.nullable(),
  recurrence_index: z.int().nullable(),
  recurrence_overrides: z.array(z.string()).default([]),
  version: z.int().min(0).default(0),
  created_by: ActorRef.meta({ column: true, label: "Created By" }),
  updated_by: ActorRef.meta({ column: true, label: "Updated By" }),
  ...TimestampFields,
}).meta({
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

/** Input for PATCH /cards/:uid — all fields optional except version. */
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
