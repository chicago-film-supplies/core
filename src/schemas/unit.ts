/**
 * Serialized units — Firestore collection: `units`.
 *
 * One document per unit NUMBER, the asset tag the operator reads off the unit.
 * The number is the identity; the serial is a changeable attribute (owner
 * ruling 2026-09-21): a replaced radio keeps its number and takes a new serial,
 * and a tent has a number and no serial at all.
 *
 * Where a unit IS right now is not on this document. That is the roster
 * (`unit-roster.ts`, one document per product), which only the ledger writer
 * writes. This document holds what the roster cannot: the serial, its history,
 * and whether the number is in use (`status`). The four places and their one
 * job each are in `api-cloudrun/.claude/plans/serial-tracking.md` §
 * *Architecture*.
 *
 * The dependency runs one way: `src/schemas/transaction.ts` imports from here,
 * never the reverse, so this module may not import it. A movement id is named
 * through `MovementId` in `_uid.ts`, which both modules share.
 *
 * The id, `UnitId` (`unit-{number}`), lives with every other id shape in
 * `_uid.ts`. That `uid === unit-${number}` holds is checked on the API's write
 * path rather than refined here: a refine would leave `getTestDoc` unable to
 * build the document without an `OVERRIDES` entry (`tests/testing.test.ts`).
 *
 * ⚠️ **Not an activity-feed collection, deliberately.** It carries actors, but
 * a bulk serial paste is hundreds of rows of noise in the feed, and the feed's
 * distinct permissions sit 5 under Firestore's `in` cap of 30
 * (`ACTIVITY_READ_PERMISSION_BY_COLLECTION`, `schemas/activity.ts`). A unit's
 * history is already two queries: `serial_history` here, and the movements
 * whose `query_by_unit_number` contains it.
 *
 * @module
 */

import { z } from "zod";
import { FirestoreId, MovementId, UnitId } from "./_uid.ts";
import { chicagoInstant } from "./_datetime.ts";
import {
  ActorRef,
  type ActorRefType,
  FirestoreTimestamp,
  type FirestoreTimestampType,
  UidNameRef,
  type UidNameRefType,
} from "./common.ts";

// ── Scalars ──────────────────────────────────────────────────────────

/**
 * A unit's number: the asset tag the operator reads off the unit, and the
 * unit's identity (owner ruling 2026-09-21). Globally unique across products.
 */
export const UnitNumber: z.ZodType<number> = z.int().min(1);

/**
 * A manufacturer serial. A changeable ATTRIBUTE of a unit number, never its
 * identity: a replaced radio keeps its number and takes a new serial.
 */
export const SerialNumber: z.ZodType<string> = z.string().min(1).max(100);

/**
 * The most units one product's roster may hold before it has to be split by
 * number block. It also caps every {@link UnitSet}, so no single set can name
 * more units than one roster document is sized for (about 120 B per `out`
 * entry, so 5,000 is roughly 600 KB against Firestore's 1 MiB).
 */
export const MAX_UNITS_PER_ROSTER = 5000;

function checkAscendingUnique(numbers: number[], ctx: z.RefinementCtx): void {
  for (let i = 1; i < numbers.length; i++) {
    if (numbers[i] <= numbers[i - 1]) {
      ctx.addIssue({
        code: "custom",
        path: [i],
        message: numbers[i] === numbers[i - 1]
          ? `unit ${numbers[i]} is named twice`
          : `units must be in ascending order (${numbers[i - 1]} before ${numbers[i]})`,
      });
      return;
    }
  }
}

function unitSetOf(max: number): z.ZodType<number[]> {
  return z.array(UnitNumber).max(max).superRefine(checkAscendingUnique);
}

/**
 * A canonical set of unit numbers: strictly ascending, no duplicates.
 *
 * Unsorted input and duplicates are REFUSED, never normalized. A client that
 * holds a set in some other order canonicalizes it with `normalizeUnitSet`
 * (`@cfs/core/utils/units`) before sending; a server that silently sorted would
 * hide a client building the set wrong.
 */
export const UnitSet: z.ZodType<number[]> = unitSetOf(MAX_UNITS_PER_ROSTER);

/** The most units one create may mint, in either mode. */
export const MAX_UNITS_PER_CREATE = 400;

// ── Vocabularies ─────────────────────────────────────────────────────

/**
 * Whether a number is in use.
 *
 * - `active` — in CFS's CUSTODY, and on the product's roster. Not "owned": a
 *   unit subrented from a supplier is active too. WHOSE it is is its open
 *   history entry's `supplier` (`unitOwnership`, `@cfs/core/utils/units`).
 * - `vacant` — not in CFS's custody right now (sold, written off, returned to
 *   its supplier, never activated). The number can take a replacement unit with
 *   a new serial. EVERY departure leaves a number vacant (owner, 2026-10-03);
 *   nothing retires one implicitly.
 * - `retired` — never to be reused. Only an operator retires a number, and only
 *   from `vacant`.
 */
export const UNIT_STATUSES = ["active", "vacant", "retired"] as const;
/** One unit status. See {@link UNIT_STATUSES}. */
export type UnitStatusType = typeof UNIT_STATUSES[number];
/** Zod schema for {@link UnitStatusType}. */
export const UnitStatusEnum: z.ZodType<UnitStatusType> = z.enum(UNIT_STATUSES);

/**
 * Why a history entry (a spell) opened on a number.
 *
 * - `initial` — the first spell of a CFS-owned unit on the number (a create, a
 *   conversion, an ownership movement, or a later bulk paste).
 * - `replaced` — a different physical unit took over the number.
 * - `corrected` — the previous entry was mis-typed; the unit did not change.
 * - `subrented` — a `subrent_in` brought a supplier's unit in on the number:
 *   every entry a subrent opens takes it, whether the number was fresh, vacant,
 *   or is the same device coming back. Like `replaced` it starts a new PHYSICAL
 *   unit (`serialAt`). It says why the spell opened, never whose the unit is —
 *   that is the entry's `supplier`, which a `corrected` entry on a vendor unit
 *   carries forward.
 *
 * Adding a member widens a stored enum, so readers ship before any writer.
 */
export const SERIAL_CHANGE_REASONS = ["initial", "replaced", "corrected", "subrented"] as const;
/** One serial-change reason. See {@link SERIAL_CHANGE_REASONS}. */
export type SerialChangeReasonType = typeof SERIAL_CHANGE_REASONS[number];
/** Zod schema for {@link SerialChangeReasonType}. */
export const SerialChangeReasonEnum: z.ZodType<SerialChangeReasonType> = z.enum(SERIAL_CHANGE_REASONS);

/**
 * The reasons `PUT /units/{uid}` may send. Every reason but `subrented`, which
 * only a `subrent_in` opens. Kept as its own list, the `OOS_USER_STATUSES`
 * pattern, so narrowing what an operator may send does not narrow what storage
 * may hold.
 */
export const UNIT_USER_SERIAL_REASONS = ["initial", "replaced", "corrected"] as const;
/** One reason an operator may send. */
export type UnitUserSerialReasonType = typeof UNIT_USER_SERIAL_REASONS[number];
/** Zod schema for {@link UnitUserSerialReasonType}. */
export const UnitUserSerialReasonEnum: z.ZodType<UnitUserSerialReasonType> = z.enum(UNIT_USER_SERIAL_REASONS);

/**
 * The statuses `PUT /units/{uid}` may ask for: only `retired`, and the server
 * honours it only from `vacant`. `active` and `vacant` are reached by ownership
 * movements, never set by hand.
 */
export const UNIT_USER_STATUSES = ["retired"] as const;
/** One status an operator may ask for. */
export type UnitUserStatusType = typeof UNIT_USER_STATUSES[number];
/** Zod schema for {@link UnitUserStatusType}. */
export const UnitUserStatusEnum: z.ZodType<UnitUserStatusType> = z.enum(UNIT_USER_STATUSES);

// Compile-time guards: what an operator may send is a subset of what storage holds.
type _UserReasonsAreReasons = UnitUserSerialReasonType extends SerialChangeReasonType ? true : never;
type _UserStatusesAreStatuses = UnitUserStatusType extends UnitStatusType ? true : never;
const _unitVocabSubsets: [_UserReasonsAreReasons, _UserStatusesAreStatuses] = [true, true];
void _unitVocabSubsets;

// ── The document ─────────────────────────────────────────────────────

/**
 * One SPELL of one physical unit under a number: from when it took the number
 * until it left or was re-recorded. Its serial is optional — a tent has a
 * number and no serial, and a radio's serial may be typed in later — so an
 * entry is a spell, not "a serial". The field keeps the name `serial_history`
 * because renaming a stored array on a strict object is a four-step purge for a
 * cosmetic gain.
 *
 * The acquisition reference lives HERE, per entry, rather than once per unit: a
 * replacement re-points the number at a new physical unit, and a single
 * unit-level field would lose the original acquisition. The unit's CURRENT
 * acquisition is the open entry's `uid_movement`. Ownership lives here for the
 * same reason: a number can be CFS-owned, then vacant, then a supplier's.
 */
export interface UnitSerialHistoryEntryType {
  /** The manufacturer serial this spell carried, or `null` when none was recorded. */
  serial_number: string | null;
  /** When this serial took the number. A Chicago instant; array members carry no `_fs` twin. */
  start: string;
  /** When it stopped carrying it; `null` is the current mapping. At most one entry is open. */
  end: string | null;
  reason: SerialChangeReasonType;
  /**
   * The ownership movement that set this serial (a purchase, a find, the
   * conversion's opening), or `null` for an operator's `initial` or
   * `corrected` entry that no movement made.
   */
  uid_movement: string | null;
  /**
   * WHOSE the unit is during this spell: the supplier it was subrented from, or
   * `null` for a CFS-owned unit. Non-null exactly when a `subrent_in` opened the
   * spell; a `corrected` copy carries it forward. Spelled as `Purchase.supplier`.
   * A unit is vendor-owned iff its OPEN entry's `supplier !== null`.
   *
   * ⚠️ Optional only until the backfill stamps `null` onto every stored entry
   * (api-cloudrun `.claude/plans/serialized-subrent.md` § 1, step 3); the
   * contract beta then makes it required. Absent reads as `null`.
   */
  supplier?: UidNameRefType | null;
  notes: string;
  changed_by: ActorRefType;
}

/** The confirmed on/off instants of an activation, as the provider's portal or bill states them. */
export interface UnitActivationConfirmedType {
  /** A Chicago instant. */
  start: string;
  /** A Chicago instant; `null` until the off-instant is confirmed. */
  end: string | null;
}

/**
 * One span during which a unit's service line was switched ON — a hotspot's or
 * router's data line, billed by its provider through the product's `cogs`
 * activation entry that `uid_cogs` names.
 *
 * RECORDED, never derived from custody: a device can sit on the shelf switched
 * on (an idle, still-billed span) or go out switched off. Present on every
 * unit, owned or rented, because CFS's own devices carry provider lines too.
 * The biller is the named cost entry's `provider`, not a field here, since one
 * product can hold units billed by different providers.
 */
export interface UnitActivationType {
  /** An array-member uid (`crypto.randomUUID()`). */
  uid: string;
  /** When CFS asked the provider to switch the line on. A Chicago instant. */
  start: string;
  /** When it was switched off; `null` while still on. A Chicago instant. */
  end: string | null;
  /** The order it was switched on for, or `null` for an idle or test activation. */
  uid_order: string | null;
  /** The product's `cogs` activation entry this span accrues (`CogsEntryType.uid`). */
  uid_cogs: string;
  /** What the provider confirms, or `null` until the on-instant is confirmed. */
  provider_confirmed: UnitActivationConfirmedType | null;
  notes: string;
  changed_by: ActorRefType;
}

/** A unit number, its current serial and its history. */
export interface UnitType {
  /** `unit-{number}` — derived, see `UnitId`. */
  uid: string;
  uid_product: string;
  number: number;
  /**
   * The serial the number carries now: the open history entry's. `null` for a
   * tent (no serial), a `vacant` or `retired` number, or an active unit whose
   * serial has not been recorded yet.
   */
  serial_number: string | null;
  serial_history: UnitSerialHistoryEntryType[];
  status: UnitStatusType;
  /**
   * The unit's service-line activations, ascending by `start`, never
   * overlapping, at most one open, and none open unless `active`.
   *
   * ⚠️ Optional only until the backfill stamps `[]` onto every stored unit
   * (`.claude/plans/serialized-subrent.md` § 1, step 3); the contract beta
   * makes it required. Absent reads as `[]`.
   */
  activations?: UnitActivationType[];
  /**
   * The `POST /products/{uid}/units` request that minted this number — its
   * `uuid_session`, the create's idempotency key. A retried count-mode create
   * finds the numbers its first attempt minted by this field and replays them
   * rather than drawing a second run from the block.
   *
   * `null` when the number was minted any other way: by an ownership movement
   * naming a fresh number (the history entry's `uid_movement` names it), or by
   * a stock-method conversion.
   */
  uuid_session: string | null;
  version: number;
  created_by: ActorRefType;
  updated_by: ActorRefType;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}

/** Zod schema for {@link UnitSerialHistoryEntryType}. */
export const UnitSerialHistoryEntry: z.ZodType<UnitSerialHistoryEntryType> = z.strictObject({
  serial_number: SerialNumber.nullable().meta({ column: true, label: "Serial" }),
  start: chicagoInstant().meta({ column: true, label: "From" }),
  end: chicagoInstant().nullable().meta({ column: true, label: "Until" }),
  reason: SerialChangeReasonEnum.meta({ column: true, label: "Reason" }),
  uid_movement: MovementId.nullable(),
  supplier: UidNameRef.nullable().optional().meta({ label: "Supplier" }),
  // `mask` — free text an operator writes about a unit, which can name a person.
  notes: z.string().max(500).meta({ pii: "mask" }),
  changed_by: ActorRef.meta({ label: "Changed By" }),
});

/** Zod schema for {@link UnitActivationConfirmedType}. */
export const UnitActivationConfirmed: z.ZodType<UnitActivationConfirmedType> = z.strictObject({
  start: chicagoInstant().meta({ column: true, label: "Provider On" }),
  end: chicagoInstant().nullable().meta({ column: true, label: "Provider Off" }),
}).superRefine((c, ctx) => {
  if (c.end !== null && Date.parse(c.end) < Date.parse(c.start)) {
    ctx.addIssue({ code: "custom", path: ["end"], message: "a confirmed activation ends at or after it starts" });
  }
});

/** Zod schema for {@link UnitActivationType}. */
export const UnitActivation: z.ZodType<UnitActivationType> = z.strictObject({
  uid: z.uuid(),
  start: chicagoInstant().meta({ column: true, label: "Active From" }),
  end: chicagoInstant().nullable().meta({ column: true, label: "Active Until" }),
  uid_order: FirestoreId.nullable(),
  uid_cogs: z.uuid(),
  provider_confirmed: UnitActivationConfirmed.nullable().meta({ label: "Confirmed" }),
  // `mask` — free text an operator writes about a unit, which can name a person.
  notes: z.string().max(500).meta({ pii: "mask" }),
  changed_by: ActorRef.meta({ label: "Changed By" }),
}).superRefine((a, ctx) => {
  if (a.end !== null && Date.parse(a.end) < Date.parse(a.start)) {
    ctx.addIssue({ code: "custom", path: ["end"], message: "an activation ends at or after it starts" });
  }
});

/**
 * The document's own consistency, all derivable from the one document:
 *
 * 1. at most one history entry is open;
 * 2. `serial_number` is the open entry's serial, or `null` when none is open;
 * 3. a number that is not `active` carries no serial and no open entry — a
 *    vacant number's last serial is CLOSED, which is what lets a replacement
 *    open a new one;
 * 4. its activations ascend by `start` and never overlap, at most one is
 *    open, and a number that is not `active` has none open — switching a line
 *    off is a call to the provider, so a departure refuses an activated unit
 *    rather than closing its span for it.
 *
 * ⚠️ Rule 3 still allows an ACTIVE unit with no open entry. The universal
 * spell rule — active ⟺ exactly one open entry — turns on in the contract beta,
 * once the backfill has opened one for every active unit that has none
 * (`.claude/plans/serialized-subrent.md` § 1, step 4).
 */
function checkUnit(doc: UnitType, ctx: z.RefinementCtx): void {
  const open = doc.serial_history.filter((e) => e.end === null);
  if (open.length > 1) {
    ctx.addIssue({
      code: "custom",
      path: ["serial_history"],
      message: `a unit carries at most one current serial; ${open.length} history entries are open`,
    });
    return;
  }
  const current = open[0]?.serial_number ?? null;
  if (doc.serial_number !== current) {
    ctx.addIssue({
      code: "custom",
      path: ["serial_number"],
      message: current === null
        ? "serial_number must be null when no history entry is open"
        : `serial_number must equal the open history entry's serial (${current})`,
    });
  }
  if (doc.status !== "active" && (open.length > 0 || doc.serial_number !== null)) {
    ctx.addIssue({
      code: "custom",
      path: ["status"],
      message: `a ${doc.status} number carries no serial; close its open history entry first`,
    });
  }
  checkActivations(doc, ctx);
}

function checkActivations(doc: UnitType, ctx: z.RefinementCtx): void {
  const spans = doc.activations ?? [];
  for (let i = 1; i < spans.length; i++) {
    const prev = spans[i - 1];
    if (Date.parse(spans[i].start) < Date.parse(prev.start)) {
      ctx.addIssue({ code: "custom", path: ["activations", i], message: "activations must ascend by start" });
      return;
    }
    if (prev.end === null || Date.parse(prev.end) > Date.parse(spans[i].start)) {
      ctx.addIssue({
        code: "custom",
        path: ["activations", i],
        message: "activations must not overlap: a span starts only after the previous one has ended",
      });
      return;
    }
  }
  const open = spans.filter((a) => a.end === null).length;
  if (open > 0 && doc.status !== "active") {
    ctx.addIssue({
      code: "custom",
      path: ["activations"],
      message: `a ${doc.status} number has no line switched on; end its open activation first`,
    });
  }
}

/** Zod schema for {@link UnitType}. */
export const UnitSchema: z.ZodType<UnitType> = z.strictObject({
  uid: UnitId,
  uid_product: FirestoreId,
  number: UnitNumber.meta({ column: true, label: "Number", serverSortVia: "number" }),
  serial_number: SerialNumber.nullable().meta({ column: true, label: "Serial" }),
  serial_history: z.array(UnitSerialHistoryEntry).meta({ label: "Serial History" }),
  status: UnitStatusEnum.meta({ column: true, label: "Status" }),
  activations: z.array(UnitActivation).optional().meta({ label: "Activations" }),
  uuid_session: z.uuid().nullable(),
  // Plain, not `.default(0)`: every writer states it, and a stored default is
  // inert (`tests/stored-defaults.test.ts`).
  version: z.int().min(0),
  created_by: ActorRef.meta({ column: true, label: "Created By" }),
  updated_by: ActorRef.meta({ column: true, label: "Updated By" }),
  created_at: FirestoreTimestamp.meta({ column: true, label: "Created" }),
  updated_at: FirestoreTimestamp.meta({ column: true, label: "Updated" }),
}).superRefine(checkUnit).meta({
  title: "Unit",
  collection: "units",
  displayDefaults: {
    columns: ["number", "serial_number", "status"],
    filters: {},
    sort: { column: "number", direction: "asc" },
    groupBy: [
      { field: null, label: "None" },
      { field: "status", label: "Status", kind: "enum" },
    ],
  },
});

// ── Inputs ───────────────────────────────────────────────────────────

/**
 * Body of `POST /products/{uid}/units`: mint `vacant` numbers for a product.
 *
 * - `count` — the next `count` numbers in the product's block, assigned by the
 *   server (`max + 1 …`).
 * - `explicit` — exactly these numbers.
 *
 * ⚠️ **No serial, in either arm.** A created number is `vacant`, and a vacant
 * number carries no serial (`UnitSchema`'s refine), so a serial here would
 * have 500'd inside the create. A serial arrives with ACTIVATION — on the
 * ownership movement that brings the unit in (`CreateTransactionInput.units`),
 * or afterwards through `PUT /units/{uid}` with reason `initial`.
 *
 * `uuid_session` is the create's idempotency key, as on
 * `CreateOutOfServiceInput`: a retried count-mode create replays the batch
 * rather than minting a second run of numbers.
 */
export type CreateUnitsInputType =
  | { mode: "count"; count: number; uuid_session: string }
  | { mode: "explicit"; numbers: number[]; uuid_session: string };

/** Zod schema for {@link CreateUnitsInputType}. */
export const CreateUnitsInput: z.ZodType<CreateUnitsInputType> = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("count"),
    count: z.int().min(1).max(MAX_UNITS_PER_CREATE),
    uuid_session: z.uuid(),
  }),
  z.object({
    mode: z.literal("explicit"),
    numbers: unitSetOf(MAX_UNITS_PER_CREATE).refine((n) => n.length > 0, { message: "name at least one unit" }),
    uuid_session: z.uuid(),
  }),
]);

/** A serial change sent to `PUT /units/{uid}`. */
export interface UnitSerialChangeInputType {
  /** The new serial, or `null` to clear a mis-recorded one (`corrected`). */
  serial_number: string | null;
  reason: UnitUserSerialReasonType;
  notes: string;
}

/**
 * Body of `PUT /units/{uid}`: change the serial, retire the number, or both.
 *
 * A serial remap does NOT cascade into past movements — `MovementUnit` keeps
 * the serial as a snapshot of the moment it moved.
 */
export interface UpdateUnitInputType {
  version: number;
  serial?: UnitSerialChangeInputType;
  status?: UnitUserStatusType;
}

/** Zod schema for {@link UpdateUnitInputType}. */
export const UpdateUnitInput: z.ZodType<UpdateUnitInputType> = z.object({
  version: z.int().min(0),
  serial: z.object({
    serial_number: SerialNumber.nullable(),
    reason: UnitUserSerialReasonEnum,
    notes: z.string().max(500).meta({ pii: "mask" }),
  }).optional(),
  status: UnitUserStatusEnum.optional(),
}).refine((u) => u.serial !== undefined || u.status !== undefined, {
  message: "send a serial change, a status change, or both",
});
