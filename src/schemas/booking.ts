/**
 * Booking document schema — Firestore collection: bookings
 */
import { z } from "zod";
import { BookingId, FirestoreId } from "./_uid.ts";
import { chicagoInstant } from "./_datetime.ts";
import {
  BOOKING_UNIT_BUCKETS,
  type BookingBreakdown,
  BookingBreakdownSchema,
  type BookingUnitSetsType,
  BookingUnitSetsSchema,
} from "./_breakdown.ts";
import { BookingActions, type BookingActionType } from "./custody.ts";
import { checkBookingCollection, checkBookingDelivery, checkBookingUnitsWithin } from "./_booking-refines.ts";
import {
  Address,
  type AddressType,
  ComponentTypeEnum,
  type ComponentTypeType,
  FirestoreTimestamp,
  type FirestoreTimestampType,
  OrgSnapshotCore,
  type OrgPathNodeType,
} from "./common.ts";

export const BOOKING_STATUSES = [
  "draft", "quoted", "reserved", "part-prepped", "prepped", "active", "complete",
] as const;
export type BookingStatusType = typeof BOOKING_STATUSES[number];
const BookingStatus: z.ZodType<BookingStatusType> = z.enum(BOOKING_STATUSES);

/**
 * Every booking status but `complete` — the statuses whose booking may still
 * consume stock (`unavailableFromBooking` drops a complete booking and nothing
 * else). An ARRAY, because its main readers are Firestore
 * `where("status", "in", …)` queries (core#110: the api's pick sheets and the
 * manager's stock store each derived it by hand). Derived as the complement, so
 * a new status is open until someone says otherwise.
 */
export const OPEN_BOOKING_STATUSES: readonly BookingStatusType[] = BOOKING_STATUSES.filter((s) => s !== "complete");

/** A reference to a destination with its address, used in booking delivery/collection. */
export interface BookingDestinationRef {
  uid: string;
  address: AddressType | null;
}

export {
  BOOKING_BREAKDOWN_KEYS,
  BOOKING_BREAKDOWN_LABELS,
  BOOKING_BREAKDOWN_TERMINAL_KEYS,
  type BookingBreakdown,
  BookingBreakdownKeyEnum,
  type BookingBreakdownKeyType,
  BookingBreakdownSchema,
  BOOKING_UNIT_BUCKETS,
  type BookingUnitBucketType,
  type BookingUnitSetsType,
  BookingUnitSetsSchema,
  emptyBookingUnitSets,
  BOOKING_PLAN_KEYS,
  CUSTODY_HISTORY_KEYS,
  OUT_OF_SERVICE_KEYS,
  type OutOfServiceKeyType,
} from "./_breakdown.ts";

export {
  emptyInboundBreakdown,
  INBOUND_BOOKING_TYPES,
  INBOUND_BREAKDOWN_KEYS,
  INBOUND_BREAKDOWN_LABELS,
  INBOUND_HISTORY_KEYS,
  INBOUND_PLAN_KEYS,
  INBOUND_RECEIVED_KEYS,
  INBOUND_RETURNED_KEYS,
  INBOUND_STAGE_TWINS,
  INBOUND_UNIT_BUCKETS,
  emptyInboundUnitSets,
  type InboundUnitSetsType,
  InboundUnitSetsSchema,
  type InboundBookingTypeType,
  InboundBookingTypeEnum,
  type InboundBreakdown,
  InboundBreakdownKeyEnum,
  type InboundBreakdownKeyType,
  InboundBreakdownSchema,
  type InboundUnitBucketType,
  inboundOwnsKey,
  isInboundLive,
  isInboundTerminal,
} from "./_inbound-breakdown.ts";

/** A specific location within a store allocated for a booking. */
export interface BookingStoreLocation {
  uid_location: string;
  name: string;
  quantity: number;
}

/** A store and its locations assigned to a booking. */
export interface BookingStore {
  uid_store: string;
  name: string;
  default: boolean;
  quantity: number;
  locations: BookingStoreLocation[];
}

/**
 * Full Firestore document for a booking — an AGGREGATE per
 * `(order, product, LEG, component_signature_hash)`, **not a line**.
 *
 * 🔴 **The leg is the destination PAIR (`destinations[i].uid`), not the
 * address it ships to.** An order may carry two legs to one address; keyed on
 * the address they collapse to one row and every per-leg total then states its
 * whole quantity once per leg (api-cloudrun#933). `uid_destination_delivery` /
 * `uid_destination_collection` remain the ADDRESSES and are what every
 * address-filtered query reads; the LEG is recovered from `uid` via
 * `parseBookingId`.
 *
 * The same product may repeat within one leg in ways that ARE
 * fungible (a priced principal plus its own zero-priced accessories, a
 * `splitItem` clone of the same subtree) and every such occurrence resolves
 * to this ONE row.
 *
 * ⚠️ **It is NOT one row per `(order, product, leg)` alone** — a
 * standalone unit of a product and an occurrence of the same product nested
 * inside a kit are genuinely different bookings, disambiguated by
 * `component_signature_hash` / `uid`'s 4th segment
 * (`@cfs/core/utils/booking-id`). Reading a shared `(order, product,
 * leg)` as one booking is the prod-961 defect class this field
 * exists to close; reading a shared `(…, component_signature_hash)` row as a
 * line is the OTHER standing defect — it renders one booking's quantities N
 * times, every unit total N× wrong. Stated the same way in
 * `api-cloudrun/src/lib/orderProjection.ts`, the manager's since-deleted `orderBookingJoin`,
 * `core/src/schemas/pick-sheet.ts` and `manager/src/utils/pickSheet.ts`.
 */
export interface Booking {
  uid: string;
  uid_order: string;
  uid_product: string;
  /**
   * `null` for a top-level (non-component) occurrence; else the 12-hex digest
   * of `componentAncestry(item's current path)` (`@cfs/core/utils/booking-id`)
   * — the fact that distinguishes this booking's `uid` from another
   * occurrence of the same product elsewhere in the order. Mirrors `uid`'s
   * own 4th segment 1:1; needs its own indexed field because Firestore
   * cannot filter on a value computed at read time. Never goes stale: a path
   * change that would change this value produces a genuinely different
   * `uid`, which the booking-reconciliation diff (`api-cloudrun`'s
   * `writableEntries`) already creates/orphans through its existing
   * missing-id arm.
   *
   * ⭐ **Required (a key, nullable), since the 2026-09-19 backfill.** The field was
   * declared before anything wrote it, and read `null`/absent on all 7,306 prod
   * bookings until api-cloudrun v0.281.0 gave both writers (`createOrder`,
   * `reconcileOrderBookings`) the value. A one-shot api-cloudrun backfill
   * (deleted once run) then stamped the rest off the id — the 4th segment, else `null` — and the
   * key-presence census reads 7,306 of 7,306 in prod. `null` therefore means "the
   * id is the 3-segment form", NOT "unknown": a legacy aggregate booking that
   * spans several ancestries carries `null` like any top-level one, so read
   * ancestry off the fulfillment's paths, never off this field, for those.
   */
  component_signature_hash: string | null;
  name: string;
  number: number;
  type: ComponentTypeType;
  status: BookingStatusType;
  /**
   * The PHYSICAL number — how many units of this product this booking's
   * custody actually accounts for, defined as `sumBookingBreakdown(breakdown)`.
   *
   * ⚠️ **It is no longer a synonym for what the order asked for.** It was, for
   * every booking written before this field's twin existed, and the runtime
   * check in `api-cloudrun/src/services/bookings.ts` (`sum(breakdown) ===
   * quantity`) read as a CONSTRAINT on the warehouse. It is now the
   * DEFINITION of this field: the warehouse may hold more units than were
   * ordered (an over-send) or fewer, and availability has to reflect the shelf
   * rather than the paperwork. What the order asked for is
   * {@link Booking.quantity_ordered}.
   */
  quantity: number;
  /**
   * What the ORDER asked for at this booking's grain — Σ `item.quantity` over
   * the consolidated order lines, which is exactly what `quantity` alone used
   * to carry.
   *
   * ⚠️ **Optional, not required, and for the same reason as
   * `component_signature_hash` directly above** — every booking stored before
   * this field existed carries no such key, and this repo's required-field
   * procedure (`core/CLAUDE.md`) is measure + backfill BEFORE tightening, not
   * in the commit that introduces the field. An absent key means "never
   * diverged from `quantity`", which is what it was for the whole corpus.
   *
   * 🔴 **Growing `quantity` in place without this field ERASES the order's
   * number from the booking** and turns "we over-sent" into "this is what was
   * ordered" — which is why the two-operand split exists here rather than a
   * single mutable number. The same split already exists one document over:
   * `FulfillmentLineItem` carries `quantity` (picker-owned, physical) beside
   * `quantity_ordered` (the order's quantity, stamped on every line).
   */
  quantity_ordered?: number;
  shortage: number;
  subject: string;
  crms_id?: number | null;
  crms_product_id?: number | null;
  breakdown: BookingBreakdown;
  /**
   * Which units sit in each unit-holding bucket — `null` when this booking is
   * not unit-tracked (a bulk product, or a serialized one whose roster is not
   * seeded yet). See {@link BookingUnitSetsType}.
   *
   * Written by the booking chunk beside `breakdown`, from the units each
   * custody action names (`BookingAction.units`). `units[k].length ≤
   * breakdown[k]`; the difference is the bucket's untracked count, left by a
   * bulk → serialized conversion and derived rather than stored
   * (`untrackedUnitCount`, `@cfs/core/utils/bookings`).
   *
   * 🔴 **REQUIRED-nullable, never optional** (`api-cloudrun/.claude/plans/serial-tracking.md`
   * D2). A `?` is exactly what lets a writer that builds a literal `Booking`
   * drop the field silently (the api-cloudrun#782 class); required turns that
   * into a compile error. It got here in four steps: added optional (beta.593),
   * every writer stamping `null` with `reconcileOrderBookings` carrying it
   * forward, a backfill, then this. Census 2026-10-04 after the backfill:
   * 7,449/7,449 prod and 7,468/7,468 dev bookings carry the key.
   */
  units: BookingUnitSetsType | null;
  dates: {
    start: string | null;
    start_fs: FirestoreTimestampType | null;
    end: string | null;
    end_fs: FirestoreTimestampType | null;
  };
  destinations: {
    delivery: BookingDestinationRef | null;
    collection: BookingDestinationRef | null;
  };
  organization: {
    uid: string | null;
    path: OrgPathNodeType[];
    crms_id: number | null;
  };
  stores: BookingStore[];
  query_by_uid_store: string[];
  query_by_uid_location: string[];
  /**
   * The delivery ADDRESS, flat — the indexed query surface. Refined on
   * {@link BookingSchema} (`checkBookingDelivery`) to equal
   * `destinations.delivery.uid` (core#103).
   */
  uid_destination_delivery: string;
  /**
   * The collection ADDRESS — or `null` on a booking that does not come back.
   *
   * 🔴 **A booking's collection is decided by its OWN `type`**
   * (api-cloudrun#1154): a `rental` returns and carries its pair's collection
   * leg; a `sale` never returns, so it carries `null` here and on
   * `destinations.collection`, even on an order whose other lines do come back.
   * One author: `bookingCollectionFor` (`@cfs/core/utils/bookings`). Every writer
   * used to fall back to the DELIVERY address, so all 492 stored sale bookings
   * (prod and dev, 2026-09-28) claim a collection that never happens; the
   * api-cloudrun#1154 Phase 4 backfill nulls them.
   *
   * Refined on {@link BookingSchema} (`checkBookingCollection`): a `rental`
   * states a collection and a non-rental states none, and this id is always
   * `destinations.collection?.uid ?? null`. That shipped the beta after the
   * backfill, because a whole-document booking write (custody replace, a kept
   * booking) would otherwise have 500'd on the sale bookings still carrying the
   * old value.
   */
  uid_destination_collection: string | null;
  version: number;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}

/** Zod schema for BookingDestinationRef — also the out-of-service record's `destination`. */
export const BookingDestinationRefSchema: z.ZodType<BookingDestinationRef> = z.strictObject({
  uid: FirestoreId,
  address: Address,
});

const BookingStoreLocationSchema: z.ZodType<BookingStoreLocation> = z.strictObject({
  uid_location: FirestoreId,
  name: z.string().meta({ column: true }),
  quantity: z.int().meta({ column: true, label: "Quantity" }),
});

/**
 * Zod schema for a booking's store allocation.
 *
 * Exported because the pick sheet carries it verbatim — *"where do I walk"* is
 * the question that surface exists for, and a narrowed twin of this shape would
 * be a copy to keep in step for no gain.
 */
export const BookingStoreSchema: z.ZodType<BookingStore> = z.strictObject({
  uid_store: FirestoreId,
  name: z.string().meta({ column: true }),
  default: z.boolean(),
  quantity: z.int().meta({ column: true, label: "Quantity" }),
  locations: z.array(BookingStoreLocationSchema).meta({ label: "Location" }),
});

// ── Update input ──────────────────────────────────────────────

/**
 * A key the delta wire carried and the actions wire retired, declared only so a
 * payload still carrying it is REFUSED rather than stripped (custody-actions P4).
 *
 * Stripping is the dangerous half: `breakdown` was an ABSOLUTE next state, so a
 * stale client sending it beside `actions` — or a script replaying an old body —
 * would have its intent dropped with a 200. Every other unknown key still strips,
 * as an input schema's does; only these three were ever meaningful.
 */
function retiredKey(key: "status" | "breakdown" | "return_flags") {
  const why = key === "status"
    ? "a booking's status is derived from its breakdown, never sent"
    : "send custody `actions` instead";
  // ⚠️ The meta is what lets a consumer's OpenAPI generator render the key.
  // zod-to-openapi has no mapping for `never` and throws `UnknownZodTypeError`
  // for the WHOLE document unless the schema states a `type` — the same reason
  // `FirestoreTimestamp` carries its representation (`src/schemas/common.ts`). `{ type:
  // "null", not: {} }` is JSON Schema's "nothing validates", which is what
  // `never` means; the description says why a reader should not send it.
  return z.never({ error: `"${key}" is retired: ${why}` })
    .meta({ type: "null", not: {}, description: `Retired: ${why}. Present is a 400.` })
    .optional();
}

/**
 * Input for updating a single booking via `PUT /bookings/{uid}`.
 *
 * A save is the ordered list of custody steps the operator took
 * ({@link BookingActionType}, `schemas/custody.ts`), applied to the booking's
 * CURRENT state rather than a state the client computed — so a short source
 * bucket after a concurrent write is a refusal, not an overwrite. `status` is
 * derived by the server. Version is required for optimistic concurrency.
 *
 * ⚠️ The absolute-`breakdown` delta wire is retired from every operator route
 * (custody-actions P4). The api keeps a server-actor-only delta path for repair
 * scripts, typed on its own side; it is not this input.
 *
 * {@link UpdateBookingInputType.uuid_session} is what makes this endpoint safe to
 * retry — see the field's own note.
 */
export interface UpdateBookingInputType {
  actions: BookingActionType[];
  /** Retired — see `retiredKey`. Present is a 400. */
  status?: never;
  /** Retired — see `retiredKey`. Present is a 400. */
  breakdown?: never;
  /** Retired — see `retiredKey`. Present is a 400. */
  return_flags?: never;
  version: number;
  /**
   * The client-minted uuid identifying ONE operator action, required.
   *
   * A custody change appends movement events, and appending is not idempotent
   * the way an absolute-set write was: a lost response plus the manager's retry
   * would say the operator returned the units twice. Every movement's document
   * id is `{uuid_session}|{type}|{subject}`, so a retry carrying the same session
   * resolves to the same documents and collapses to one event by construction.
   *
   * **Required, with no server-side fallback.** A server-minted session would be
   * fresh on every attempt, which is precisely the retry the id exists to
   * absorb — an optional field would therefore be silently wrong exactly when it
   * mattered. Mint it per operator action (not per request, and not per
   * keystroke) and reuse it across retries of that action.
   */
  uuid_session: string;
  /**
   * The physical instant the step happened, for a step recorded after the fact
   * (a check-in typed the next morning). Absent is now. Every movement the
   * request writes takes it as its `date`. The same field on both levers
   * (ruling 76; the inbound twin is `BulkInboundBookingUpdateInputType.date`).
   *
   * 🔴 **The api bounds it** (rulings 76, 77). It refuses a date LATER than now:
   * a custody movement records what happened, and the write moves custody and
   * stock at once whatever it says; an expected arrival is a pair's dates. It
   * refuses a date that would make the booking's journal, replayed in `date`
   * order (`journalOrder`), take a bucket NEGATIVE at any instant — a step
   * dated before the step that filled its source bucket, which the replay audit
   * reads as missing history. Any other backdating is legal. A step whose
   * movement posts to Xero is refused when its date falls inside Xero's LIVE
   * lock date, read at the request; CFS keeps no copy of it. Only the api's
   * clock decides "now"; a client check is a courtesy.
   *
   * ⚠️ **Release order:** a stripping `z.object`, so an api older than this
   * field drops it silently and records the step at now. The api release that
   * reads it must be live in prod before the manager sends it.
   */
  date?: string;
}

/** Zod schema for UpdateBookingInput. */
export const UpdateBookingInput: z.ZodType<UpdateBookingInputType> = z.object({
  actions: BookingActions,
  status: retiredKey("status"),
  breakdown: retiredKey("breakdown"),
  return_flags: retiredKey("return_flags"),
  version: z.int().min(0),
  uuid_session: z.uuid(),
  date: chicagoInstant().optional(),
});

// ── Bulk update input (PUT /fulfillments/{uid}/bookings) ───────

/**
 * Per-row entry for the bulk fulfillment-bookings endpoint. Matches
 * `UpdateBookingInputType` field-for-field, plus the booking `uid` to address
 * the row (since the URL carries the fulfillment uid, not the booking uid).
 */
export interface BookingUpdateType {
  uid: string;
  actions: BookingActionType[];
  /** Retired — see `retiredKey`. Present is a 400. */
  status?: never;
  /** Retired — see `retiredKey`. Present is a 400. */
  breakdown?: never;
  /** Retired — see `retiredKey`. Present is a 400. */
  return_flags?: never;
  version: number;
}

export const BookingUpdate: z.ZodType<BookingUpdateType> = z.object({
  uid: BookingId,
  actions: BookingActions,
  status: retiredKey("status"),
  breakdown: retiredKey("breakdown"),
  return_flags: retiredKey("return_flags"),
  version: z.int().min(0),
});

/**
 * Body of `PUT /fulfillments/{uid}/bookings` — applies N booking transitions
 * for one order in a single Firestore transaction.
 *
 * Top-level `version` is the fulfillment doc version at read time. Currently
 * advisory: a stale value 409s. Per-row `version` carries each booking's
 * current version for optimistic concurrency.
 *
 * No fixed cap on `updates.length`. Bound only by the real Firestore limits
 * (270s tx duration, 10 MiB request size). The bulk service rejects empty
 * arrays with 400.
 */
export interface BulkBookingUpdateInputType {
  version: number;
  updates: BookingUpdateType[];
  /**
   * ONE session for the whole request, not one per row.
   *
   * A bulk apply IS one operator action — "check out these five rows", or a
   * picker action cascading onto a kit's component bookings — so the rows share
   * a session. They cannot collide on it: a movement's id carries the subject,
   * and every row addresses a different booking. See
   * {@link UpdateBookingInputType.uuid_session}.
   */
  uuid_session: string;
  /** The physical instant of every step in the request; see {@link UpdateBookingInputType.date}. */
  date?: string;
}

export const BulkBookingUpdateInput: z.ZodType<BulkBookingUpdateInputType> = z.object({
  version: z.int().min(0),
  updates: z.array(BookingUpdate).min(1),
  uuid_session: z.uuid(),
  date: chicagoInstant().optional(),
});

/**
 * Response from `PUT /fulfillments/{uid}/bookings`. Per-row `results` carry the
 * post-write booking versions in input order.
 *
 * ⚠️ **`success` is a boolean, not `true`** — and that is a fact about the
 * server, not a loosening. Rows commit in transaction-sized chunks
 * (api-cloudrun#391), so a failure after an earlier chunk has committed is a
 * PARTIAL success: the earlier writes exist and cannot be rolled back. A
 * `z.literal(true)` cannot describe that state, so the route restated the whole
 * shape inline rather than use this one — which is the drift api-cloudrun#624
 * item 3 names. `failures` + `chunks` are what make the partial case legible to
 * a client (manager#272).
 *
 * There is deliberately **no `order_completed`**. It was edge-triggered — true
 * only when THIS run flipped the order into `complete` — while its name read
 * level-triggered, so a replayed request reported `false` for an order that IS
 * complete. Completion is level-triggered at the call site, where the client's
 * order listener already holds `status === "complete"`.
 */
export interface BulkBookingUpdateResponseType {
  /** False when at least one chunk failed after another had already committed. */
  success: boolean;
  oos_records_written: number;
  results: Array<{ uid: string; version: number }>;
  /** Rows no chunk committed. Empty whenever `success` is true. */
  failures: Array<{ uid: string; error: string }>;
  /**
   * Transactions the rows were split across. 1 for the p50 order; 0 when every
   * row was cut to nothing by a short shelf (see {@link ShelfShortfallType}).
   */
  chunks: number;
  /** See {@link PrepShortfallType}. Absent when every prep was covered. */
  prep_shortfalls?: PrepShortfallType[];
  /** See {@link ShelfShortfallType}. Absent when every check-out was covered. */
  shelf_shortfalls?: ShelfShortfallType[];
}

/**
 * A check-out the shelves could not fully cover. The server moved what the
 * shelves hold (`moved`, possibly 0) and left the rest of the row's units in the
 * bucket they were in before the request — reserved or prepped. Never a 400:
 * the operator is told, and recounts, receives stock, or checks out the rest.
 *
 * A row clamped to 0 wrote nothing, so it is absent from `results` and is not a
 * `failures` entry either: nothing failed.
 */
export interface ShelfShortfallType {
  uid: string;
  /** The units the row would have taken off the shelves. */
  requested: number;
  /** The units it did take. `0 <= moved < requested`. */
  moved: number;
}

/** Zod schema for {@link ShelfShortfallType}. */
export const ShelfShortfall: z.ZodType<ShelfShortfallType> = z.object({
  uid: BookingId,
  requested: z.int().min(1),
  moved: z.int().min(0),
});

/**
 * A prep the shelves could not fully cover (api-cloudrun#1302 ruling 8). The
 * covered units moved to staging; the `shortfall` was prepped IN PLACE with no
 * shelf, because the units are not on any shelf to move. Never a 400: the
 * operator is told, and resolves it with a recount or by cleaning up bookings.
 */
export interface PrepShortfallType {
  uid: string;
  shortfall: number;
}

/** Zod schema for {@link PrepShortfallType}. */
export const PrepShortfall: z.ZodType<PrepShortfallType> = z.object({
  uid: BookingId,
  shortfall: z.int().min(1),
});

export const BulkBookingUpdateResponse: z.ZodType<BulkBookingUpdateResponseType> =
  z.object({
    success: z.boolean(),
    oos_records_written: z.int().min(0),
    results: z.array(z.object({
      uid: BookingId,
      version: z.int().min(0),
    })),
    failures: z.array(z.object({
      uid: BookingId,
      error: z.string(),
    })),
    chunks: z.int().min(0),
    prep_shortfalls: z.array(PrepShortfall).optional(),
    shelf_shortfalls: z.array(ShelfShortfall).optional(),
  });

/**
 * Response from `PUT /bookings/{uid}` — the single-row form.
 *
 * One row plans to exactly one chunk, so it cannot partially succeed and
 * carries no `failures`/`chunks`. Kept a distinct shape from
 * {@link BulkBookingUpdateResponseType} for that reason rather than sharing
 * one loosened type: N rows and one row genuinely differ in what can go wrong.
 */
export interface UpdateBookingResponseType {
  success: boolean;
  version: number;
  oos_records_written: number;
  /** See {@link PrepShortfallType}. Absent when the prep was covered. */
  prep_shortfalls?: PrepShortfallType[];
  /** See {@link ShelfShortfallType}. Absent when the check-out was covered. */
  shelf_shortfalls?: ShelfShortfallType[];
}

export const UpdateBookingResponse: z.ZodType<UpdateBookingResponseType> = z.object({
  success: z.boolean(),
  version: z.int().min(0),
  oos_records_written: z.int().min(0),
  prep_shortfalls: z.array(PrepShortfall).optional(),
  shelf_shortfalls: z.array(ShelfShortfall).optional(),
});

/**
 * The fields an OUTBOUND booking (`bookings`, an order's) and an INBOUND one
 * (`bookings-inbound`, a purchase's — the 7a contract beta) declare identically:
 * one instance per field, referenced key by key from each schema
 * (`api-cloudrun/.claude/plans/one-document-model.md` C5).
 *
 * ⭐ **Referenced PER KEY, not spread — the `TotalsCore` answer
 * (`schemas/order.ts`), for the same reason.** A schema's key order is its
 * column order, and these fields are interleaved with outbound-only ones
 * (`uid_order`, `organization`, `subject`, …); a spread would move every
 * outbound column. Each schema keeps its own order.
 *
 * 🔴 **So the anti-drift guarantee is `tests/booking-core-parity.test.ts`**,
 * which asserts INSTANCE identity: `z.globalRegistry` is keyed on the instance,
 * so a re-declared twin would carry none of these `.meta()` headings.
 *
 * What is NOT here, because the two collections genuinely differ: `uid`,
 * `number` (its `linkTo` names a different detail page), `type` (inbound is
 * `sale | rental`), `status`, `breakdown`, `units` and `quantity_ordered`
 * (inbound is required from day one). Outbound only: `uid_order`,
 * `organization`, `subject`, `crms_id`, `crms_product_id`, `shortage`.
 *
 * ⚠️ **Not on the `@cfs/core/schemas` barrel**, as `TotalsCore` is not: no
 * consumer assembles a booking from parts.
 */
export const BOOKING_CORE: {
  uid_product: z.ZodType<string>;
  component_signature_hash: z.ZodType<string | null>;
  name: z.ZodType<string>;
  quantity: z.ZodType<number>;
  dates: z.ZodType<Booking["dates"]>;
  destinations: z.ZodType<Booking["destinations"]>;
  stores: z.ZodType<BookingStore[]>;
  query_by_uid_store: z.ZodType<string[]>;
  query_by_uid_location: z.ZodType<string[]>;
  uid_destination_delivery: z.ZodType<string>;
  uid_destination_collection: z.ZodType<string | null>;
  version: z.ZodType<number>;
  created_at: z.ZodType<FirestoreTimestampType>;
  updated_at: z.ZodType<FirestoreTimestampType>;
} = {
  uid_product: FirestoreId,
  // Required and NULLABLE — see the interface field's own note: `null` is the
  // 3-segment (top-level) id, and every stored booking states one or the other.
  component_signature_hash: z.string().regex(/^[0-9a-f]{12}$/, "Must be a 12-hex component signature hash")
    .nullable(),
  name: z.string().meta({ column: true, label: "Product", linkTo: "productDetail" }),
  quantity: z.int().meta({ serverSortVia: "quantity", column: true, label: "Quantity" }),
  dates: z.strictObject({
    start: chicagoInstant().meta({ serverSortVia: "dates.start_fs", column: true, label: "Start" }).nullable(),
    start_fs: FirestoreTimestamp.nullable(),
    end: chicagoInstant().meta({ serverSortVia: "dates.end_fs", column: true, label: "End" }).nullable(),
    end_fs: FirestoreTimestamp.nullable(),
  }),
  destinations: z.strictObject({
    delivery: BookingDestinationRefSchema.nullable().meta({ label: "Delivery" }),
    collection: BookingDestinationRefSchema.nullable().meta({ label: "Collection" }),
  }),
  stores: z.array(BookingStoreSchema).meta({ label: "Store" }),
  query_by_uid_store: z.array(FirestoreId),
  query_by_uid_location: z.array(FirestoreId),
  uid_destination_delivery: FirestoreId,
  uid_destination_collection: FirestoreId.nullable(),
  version: z.int().min(0).default(0),
  created_at: FirestoreTimestamp.meta({ column: true, label: "Created" }),
  updated_at: FirestoreTimestamp.meta({ column: true, label: "Updated" }),
};

/** Zod schema for Booking. */
export const BookingSchema: z.ZodType<Booking> = z.strictObject({
  // Key order is this schema's own and is preserved exactly — see `BOOKING_CORE`.
  uid: BookingId,
  uid_order: FirestoreId,
  uid_product: BOOKING_CORE.uid_product,
  component_signature_hash: BOOKING_CORE.component_signature_hash,
  name: BOOKING_CORE.name,
  number: z.int().meta({ column: true, label: "#", linkTo: "fulfillmentDetail", serverSortVia: "number" }),
  type: ComponentTypeEnum.meta({ column: true, label: "Type" }),
  status: BookingStatus.meta({ column: true, label: "Status" }),
  quantity: BOOKING_CORE.quantity,
  // Optional, not required — see the interface field's own note. No `column`
  // meta on purpose: every stored booking reads it as absent today, and a
  // column that is blank on 7,306 rows is not a column.
  quantity_ordered: z.int().min(0).optional(),
  shortage: z.int().meta({ column: true, label: "Shortage" }),
  // `mask` — see the note on `subject` in `order.ts`; same field, same ruling.
  subject: z.string().meta({ pii: "mask", column: true, label: "Subject" }),
  // crms_id and crms_product_id are written back post-transaction by CRMS sync
  crms_id: z.int().nullable().optional(),
  crms_product_id: z.int().nullable().optional(),
  breakdown: BookingBreakdownSchema,
  // Required-nullable — see the interface field's own note. `null` is "not unit-tracked".
  units: BookingUnitSetsSchema.nullable(),
  dates: BOOKING_CORE.dates,
  destinations: BOOKING_CORE.destinations,
  organization: z.strictObject({
    ...OrgSnapshotCore,
    crms_id: z.int().nullable(),
  }).meta({ label: "Organization" }),
  stores: BOOKING_CORE.stores,
  query_by_uid_store: BOOKING_CORE.query_by_uid_store,
  query_by_uid_location: BOOKING_CORE.query_by_uid_location,
  uid_destination_delivery: BOOKING_CORE.uid_destination_delivery,
  uid_destination_collection: BOOKING_CORE.uid_destination_collection,
  version: BOOKING_CORE.version,
  created_at: BOOKING_CORE.created_at,
  updated_at: BOOKING_CORE.updated_at,
}).superRefine(checkBookingCollection).superRefine(checkBookingDelivery).superRefine(checkBookingUnitsWithin(BOOKING_UNIT_BUCKETS)).meta({
  title: "Booking",
  collection: "bookings",
  displayDefaults: {
    columns: ["number", "status", "organization.path", "quantity", "dates.start", "dates.end"],
    filters: {},
    sort: { column: "number", direction: "desc" },
    groupBy: [
      { field: null, label: "None" },
      { field: "status", label: "Status", kind: "enum" },
    ],
  },
});
