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
import { chicagoInstant } from "./_datetime.ts";
import {
  ActorRef,
  type ActorRefType,
  DocSource,
  type DocSourceType,
  FirestoreTimestamp,
  type FirestoreTimestampType,
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

// ── Lock keys ───────────────────────────────────────────────────────

const CARD_LOCK_KEYS = [
  "card",
  "uid_list",
  "status",
  "subject",
  "body",
  "body_text",
  "dates",
  "destination",
  "sources",
  "attachments",
  "uid_assignees",
] as const;
/**
 * Enum of lockable card surfaces.
 *
 * - `"card"` — presence blocks DELETE (all other keys are field locks)
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

/** A single attachment on a card (Uploadcare UUID + display metadata). */
export interface CardAttachmentType {
  uid: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  locked: boolean;
}

/** Zod schema for a card attachment. */
export const CardAttachment: z.ZodType<CardAttachmentType> = z.strictObject({
  uid: z.string().min(1),
  filename: z.string().min(1).max(260).meta({ pii: "mask" }),
  mime_type: z.string().min(1).max(120),
  size_bytes: z.int().min(0),
  locked: z.boolean().default(false),
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
  position: number;
  subject: string;
  body: CommentBodyJson | null;
  body_text: string;
  dates: CardDatesType;
  all_day: boolean;
  date_fs: FirestoreTimestampType | null;
  destination: DocDestinationEndpointType | null;
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
  created_at?: FirestoreTimestampType;
  updated_at?: FirestoreTimestampType;
}

/** Zod schema for the card dates sub-object. */
export const CardDates: z.ZodType<CardDatesType> = z.strictObject({
  start: chicagoInstant().nullable().default(null),
  end: chicagoInstant().nullable().default(null),
});

/** Zod schema for a card Firestore document. */
export const CardSchema: z.ZodType<Card> = z.strictObject({
  uid: z.string(),
  uid_list: z.string().min(1),
  uid_thread: z.string().min(1),
  status: CardStatusEnum,
  position: z.number(),
  subject: z.string().max(200).meta({ pii: "mask" }).default(""),
  body: CommentBody.nullable(),
  body_text: z.string().max(20000).meta({ pii: "mask" }).default(""),
  dates: CardDates,
  all_day: z.boolean().default(false),
  date_fs: FirestoreTimestamp.nullable(),
  destination: DocDestinationEndpoint.nullable(),
  sources: z.array(DocSource).default([]),
  attachments: z.array(CardAttachment).default([]),
  uid_assignees: z.array(z.string()).default([]),
  locked: z.array(CardLockKeyEnum).default([]),
  recurrence_parent_uid: z.string().nullable(),
  recurrence_index: z.int().nullable(),
  recurrence_overrides: z.array(z.string()).default([]),
  version: z.int().min(0).default(0),
  created_by: ActorRef,
  updated_by: ActorRef,
  ...TimestampFields,
}).meta({
  title: "Card",
  collection: "cards",
  displayDefaults: {
    columns: ["subject", "status", "dates.start", "created_by.name"],
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
  sources?: DocSourceType[];
  attachments?: CardAttachmentType[];
  uid_assignees?: string[];
  locked?: CardLockKey[];
}

/** Zod schema for creating a card. */
export const CreateCardInput: z.ZodType<CreateCardInputType> = z.object({
  uid_list: z.string().min(1),
  subject: z.string().min(1).max(200).meta({ pii: "mask" }),
  status: CardStatusEnum.optional(),
  position: z.number().optional(),
  body: CommentBody.nullable().optional(),
  body_text: z.string().max(20000).meta({ pii: "mask" }).optional(),
  dates: CardDates.optional(),
  all_day: z.boolean().optional(),
  destination: DocDestinationEndpoint.nullable().optional(),
  sources: z.array(DocSource).optional(),
  attachments: z.array(CardAttachment).optional(),
  uid_assignees: z.array(z.string()).optional(),
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
  uid_list: z.string().min(1).optional(),
  status: CardStatusEnum.optional(),
  position: z.number().optional(),
  subject: z.string().min(1).max(200).meta({ pii: "mask" }).optional(),
  body: CommentBody.nullable().optional(),
  body_text: z.string().max(20000).meta({ pii: "mask" }).optional(),
  dates: CardDates.optional(),
  all_day: z.boolean().optional(),
  destination: DocDestinationEndpoint.nullable().optional(),
  sources: z.array(DocSource).optional(),
  attachments: z.array(CardAttachment).optional(),
  uid_assignees: z.array(z.string()).optional(),
  version: z.int().min(0),
});
