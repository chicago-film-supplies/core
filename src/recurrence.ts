/**
 * Recurrence document schema — Firestore collection: recurrences
 *
 * A Recurrence is a **prototype card + RRULE + horizon window** that the
 * nightly materializer expands into concrete `cards` documents. Each
 * materialized instance carries `recurrence_parent_uid` + `recurrence_index`
 * back to the recurrence so scope-aware edits (`this`/`following`/`all`) can
 * fan out correctly.
 *
 * Design notes:
 *
 * - The prototype card fields live under a nested `prototype: { ... }` so
 *   the Recurrence doc's own `status: active | paused | archived` doesn't
 *   collide with `prototype.status: CardStatus`.
 * - `exception_dates` tracks user-initiated "skip this one" deletions
 *   (`DELETE /cards/{uid}?recurrence_scope=this`) so re-materialization
 *   doesn't resurrect deleted instances.
 * - `recurrence_overrides` on the Card side (see `src/card.ts`) tracks
 *   per-instance field-level edits (iCal-style): fields listed there are
 *   pinned against prototype-fanout updates.
 * - The RRULE shape is RFC 5545 / `rrule-temporal`-aligned so the
 *   api-cloudrun materializer can pass it straight through to the library
 *   without a translation layer.
 * - No default thread cowrite — recurrences are a settings-style surface.
 *   Discussion happens on the individual instance cards. Revisit if the
 *   settings UI grows a comments affordance.
 *
 * Runtime wiring (api-cloudrun, out of scope for this schema):
 *
 * - `POST /recurrences` materializes the initial horizon synchronously
 *   (bounded by `horizon_days`, default 60).
 * - Nightly Cloud Scheduler job @ 02:00 America/Chicago calls
 *   `POST /tasks/materialize-horizon`, which rolls the horizon forward for
 *   every `status == "active"` recurrence.
 * - `PATCH /cards/{uid}?recurrence_scope=...` dispatches to
 *   `src/services/cardsRecurrence.ts` when `card.recurrence_parent_uid`
 *   is set.
 */
import { z } from "zod";
import {
  ActorRef,
  type ActorRefType,
  DocSource,
  type DocSourceType,
  type FirestoreTimestampType,
  TimestampFields,
} from "./common.ts";
import { CommentBody, type CommentBodyJson } from "./comment.ts";
import {
  CardAttachment,
  type CardAttachmentType,
  CardLockKeyEnum,
  type CardLockKey,
  CardStatusEnum,
  type CardStatus,
} from "./card.ts";
import {
  DocDestinationEndpoint,
  type DocDestinationEndpointType,
} from "./order.ts";

// ── Recurrence status ───────────────────────────────────────────────

const RECURRENCE_STATUSES = ["active", "paused", "archived"] as const;
/**
 * Recurrence lifecycle.
 * - `active` — nightly materializer rolls the horizon forward; prototype
 *   edits fan out to existing instances (respecting per-card overrides).
 * - `paused` — materializer skips; existing instances remain untouched.
 *   Use for temporary holds ("no deliveries this month").
 * - `archived` — materializer skips; instances remain but the recurrence
 *   is hidden from the settings UI.
 */
export type RecurrenceStatus = typeof RECURRENCE_STATUSES[number];
/** Zod schema for RecurrenceStatus. */
export const RecurrenceStatusEnum: z.ZodType<RecurrenceStatus> = z.enum(
  RECURRENCE_STATUSES,
);

// ── RRULE ───────────────────────────────────────────────────────────

const RECURRENCE_FREQS = ["DAILY", "WEEKLY", "MONTHLY", "YEARLY"] as const;
/** RFC 5545 FREQ value. */
export type RecurrenceFreq = typeof RECURRENCE_FREQS[number];
/** Zod schema for RecurrenceFreq. */
export const RecurrenceFreqEnum: z.ZodType<RecurrenceFreq> = z.enum(
  RECURRENCE_FREQS,
);

const RECURRENCE_WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;
/** RFC 5545 BYDAY value (two-letter weekday code). */
export type RecurrenceWeekday = typeof RECURRENCE_WEEKDAYS[number];
/** Zod schema for RecurrenceWeekday. */
export const RecurrenceWeekdayEnum: z.ZodType<RecurrenceWeekday> = z.enum(
  RECURRENCE_WEEKDAYS,
);

/**
 * RFC 5545 / rrule-temporal-aligned recurrence rule. Each field maps
 * directly to a rrule-temporal constructor option — see
 * https://jsr.io/@gsphw/rrule-temporal.
 */
export interface RecurrenceRuleType {
  freq: RecurrenceFreq;
  /** Every N units of `freq`. Must be >= 1. */
  interval: number;
  /** BYDAY — for WEEKLY/MONTHLY/YEARLY. `null` if not set. */
  byweekday: RecurrenceWeekday[] | null;
  /** BYMONTHDAY — days of month (1..31, or -1..-31 for last N). `null` if not set. */
  bymonthday: number[] | null;
  /** BYMONTH — months of year (1..12). `null` if not set. */
  bymonth: number[] | null;
  /** BYSETPOS — positional filter (e.g. "first Monday" = byweekday:["MO"], bysetpos:[1]). `null` if not set. */
  bysetpos: number[] | null;
  /** COUNT — total occurrences. Mutually exclusive with `until`. */
  count: number | null;
  /** UNTIL — stop date (YYYY-MM-DD). Mutually exclusive with `count`. */
  until: string | null;
}

/** Zod schema for a recurrence rule. */
export const RecurrenceRule: z.ZodType<RecurrenceRuleType> = z.strictObject({
  freq: RecurrenceFreqEnum,
  interval: z.int().min(1),
  byweekday: z.array(RecurrenceWeekdayEnum).nullable(),
  bymonthday: z.array(z.int().min(-31).max(31).refine((n) => n !== 0)).nullable(),
  bymonth: z.array(z.int().min(1).max(12)).nullable(),
  bysetpos: z.array(z.int().min(-366).max(366).refine((n) => n !== 0)).nullable(),
  count: z.int().min(1).nullable(),
  until: z.iso.date().nullable(),
}).refine(
  (r) => !(r.count != null && r.until != null),
  { message: "RecurrenceRule: count and until are mutually exclusive" },
);

// ── Prototype ───────────────────────────────────────────────────────

/**
 * The card prototype — fields that materialize verbatim into each instance
 * card unless per-instance `recurrence_overrides` pin them. Mirrors
 * `CreateCardInputType` minus `uid_list`, `position`, and `date`
 * (those live on the Recurrence root since they're series-level concerns).
 */
export interface RecurrencePrototypeType {
  subject: string;
  body: CommentBodyJson | null;
  body_text: string;
  /** Default status for newly materialized instance cards. */
  status: CardStatus;
  destination: DocDestinationEndpointType | null;
  sources: DocSourceType[];
  attachments: CardAttachmentType[];
  uid_assignees: string[];
  /**
   * Lock set applied to every materialized instance card. Order-event
   * recurrences would set this to `["card", "subject", "sources"]` to mirror
   * the order-event-migrated defaults; user-created to-do recurrences might
   * set `[]`.
   */
  locked: CardLockKey[];
}

/** Zod schema for the recurrence prototype. */
export const RecurrencePrototype: z.ZodType<RecurrencePrototypeType> = z
  .strictObject({
    subject: z.string().min(1).max(200).meta({ pii: "mask" }),
    body: CommentBody.nullable(),
    body_text: z.string().max(20000).meta({ pii: "mask" }).default(""),
    status: CardStatusEnum,
    destination: DocDestinationEndpoint.nullable(),
    sources: z.array(DocSource).default([]),
    attachments: z.array(CardAttachment).default([]),
    uid_assignees: z.array(z.string()).default([]),
    locked: z.array(CardLockKeyEnum).default([]),
  });

// ── Firestore document ──────────────────────────────────────────────

/** Recurrence Firestore document shape. */
export interface Recurrence {
  uid: string;
  /** List instance cards materialize into. */
  uid_list: string;
  status: RecurrenceStatus;
  rule: RecurrenceRuleType;
  /** First eligible instance date (YYYY-MM-DD). */
  active_from: string;
  /** Last eligible instance date (YYYY-MM-DD). `null` = open-ended. */
  active_until: string | null;
  /**
   * Last date up to which instance cards have been written (YYYY-MM-DD).
   * `null` before the first materialization. The nightly job reads this
   * to know where to resume.
   */
  horizon_through: string | null;
  /**
   * Per-recurrence horizon window override. Materializer keeps
   * `horizon_through` at `today + horizon_days` for active recurrences.
   * `null` = use system default (60).
   */
  horizon_days: number | null;
  /**
   * Dates (YYYY-MM-DD) the materializer should skip. Appended on
   * `DELETE /cards/{uid}?recurrence_scope=this`.
   */
  exception_dates: string[];
  /** Card template fields that fan out on materialization. */
  prototype: RecurrencePrototypeType;
  version: number;
  created_by: ActorRefType;
  updated_by: ActorRefType;
  created_at?: FirestoreTimestampType;
  updated_at?: FirestoreTimestampType;
}

/** Zod schema for a Recurrence Firestore document. */
export const RecurrenceSchema: z.ZodType<Recurrence> = z.strictObject({
  uid: z.string(),
  uid_list: z.string().min(1),
  status: RecurrenceStatusEnum,
  rule: RecurrenceRule,
  active_from: z.iso.date(),
  active_until: z.iso.date().nullable(),
  horizon_through: z.iso.date().nullable(),
  horizon_days: z.int().min(1).max(3650).nullable(),
  exception_dates: z.array(z.iso.date()).default([]),
  prototype: RecurrencePrototype,
  version: z.int().min(0).default(0),
  created_by: ActorRef,
  updated_by: ActorRef,
  ...TimestampFields,
}).meta({
  title: "Recurrence",
  collection: "recurrences",
  displayDefaults: {
    columns: ["prototype.subject", "status", "rule.freq", "active_from", "horizon_through"],
    filters: { status: ["active"] },
    sort: { column: "created_at", direction: "desc" },
  },
});

// ── Input schemas ───────────────────────────────────────────────────

/** Input for POST /recurrences. */
export interface CreateRecurrenceInputType {
  uid_list: string;
  status?: RecurrenceStatus;
  rule: RecurrenceRuleType;
  active_from: string;
  active_until?: string | null;
  horizon_days?: number | null;
  prototype: {
    subject: string;
    body?: CommentBodyJson | null;
    body_text?: string;
    status?: CardStatus;
    destination?: DocDestinationEndpointType | null;
    sources?: DocSourceType[];
    attachments?: CardAttachmentType[];
    uid_assignees?: string[];
    locked?: CardLockKey[];
  };
}

/** Zod schema for creating a recurrence. */
export const CreateRecurrenceInput: z.ZodType<CreateRecurrenceInputType> = z
  .object({
    uid_list: z.string().min(1),
    status: RecurrenceStatusEnum.optional(),
    rule: RecurrenceRule,
    active_from: z.iso.date(),
    active_until: z.iso.date().nullable().optional(),
    horizon_days: z.int().min(1).max(3650).nullable().optional(),
    prototype: z.object({
      subject: z.string().min(1).max(200).meta({ pii: "mask" }),
      body: CommentBody.nullable().optional(),
      body_text: z.string().max(20000).meta({ pii: "mask" }).optional(),
      status: CardStatusEnum.optional(),
      destination: DocDestinationEndpoint.nullable().optional(),
      sources: z.array(DocSource).optional(),
      attachments: z.array(CardAttachment).optional(),
      uid_assignees: z.array(z.string()).optional(),
      locked: z.array(CardLockKeyEnum).optional(),
    }),
  });

/**
 * Input for PATCH /recurrences/:uid — all fields optional. Prototype
 * field patches fan out to existing instance cards at the service layer
 * (skipping cards whose `recurrence_overrides` pin the field).
 */
export interface UpdateRecurrenceInputType {
  uid_list?: string;
  status?: RecurrenceStatus;
  rule?: RecurrenceRuleType;
  active_from?: string;
  active_until?: string | null;
  horizon_days?: number | null;
  prototype?: {
    subject?: string;
    body?: CommentBodyJson | null;
    body_text?: string;
    status?: CardStatus;
    destination?: DocDestinationEndpointType | null;
    sources?: DocSourceType[];
    attachments?: CardAttachmentType[];
    uid_assignees?: string[];
    locked?: CardLockKey[];
  };
  version: number;
}

/** Zod schema for updating a recurrence. */
export const UpdateRecurrenceInput: z.ZodType<UpdateRecurrenceInputType> = z
  .object({
    uid_list: z.string().min(1).optional(),
    status: RecurrenceStatusEnum.optional(),
    rule: RecurrenceRule.optional(),
    active_from: z.iso.date().optional(),
    active_until: z.iso.date().nullable().optional(),
    horizon_days: z.int().min(1).max(3650).nullable().optional(),
    prototype: z.object({
      subject: z.string().min(1).max(200).meta({ pii: "mask" }).optional(),
      body: CommentBody.nullable().optional(),
      body_text: z.string().max(20000).meta({ pii: "mask" }).optional(),
      status: CardStatusEnum.optional(),
      destination: DocDestinationEndpoint.nullable().optional(),
      sources: z.array(DocSource).optional(),
      attachments: z.array(CardAttachment).optional(),
      uid_assignees: z.array(z.string()).optional(),
      locked: z.array(CardLockKeyEnum).optional(),
    }).optional(),
    version: z.int().min(0),
  });
