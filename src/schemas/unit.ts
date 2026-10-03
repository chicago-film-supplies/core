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
 * - `active` — owned, and on the product's roster.
 * - `vacant` — not owned right now (sold, written off, never activated). The
 *   number can take a replacement unit with a new serial. EVERY departure
 *   leaves a number vacant (owner, 2026-10-03); nothing retires one implicitly.
 * - `retired` — never to be reused. Only an operator retires a number, and only
 *   from `vacant`.
 */
export const UNIT_STATUSES = ["active", "vacant", "retired"] as const;
/** One unit status. See {@link UNIT_STATUSES}. */
export type UnitStatusType = typeof UNIT_STATUSES[number];
/** Zod schema for {@link UnitStatusType}. */
export const UnitStatusEnum: z.ZodType<UnitStatusType> = z.enum(UNIT_STATUSES);

/**
 * Why a serial was set on a number.
 *
 * - `initial` — the first serial recorded for the number (a create, a
 *   conversion, or a later bulk paste).
 * - `replaced` — a different physical unit took over the number.
 * - `corrected` — the previous entry was mis-typed; the unit did not change.
 */
export const SERIAL_CHANGE_REASONS = ["initial", "replaced", "corrected"] as const;
/** One serial-change reason. See {@link SERIAL_CHANGE_REASONS}. */
export type SerialChangeReasonType = typeof SERIAL_CHANGE_REASONS[number];
/** Zod schema for {@link SerialChangeReasonType}. */
export const SerialChangeReasonEnum: z.ZodType<SerialChangeReasonType> = z.enum(SERIAL_CHANGE_REASONS);

/**
 * The reasons `PUT /units/{uid}` may send. Today every reason; kept as its own
 * list, the `OOS_USER_STATUSES` pattern, so narrowing what an operator may send
 * does not narrow what storage may hold.
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
 * One serial a number has carried, and over which span.
 *
 * The acquisition reference lives HERE, per entry, rather than once per unit: a
 * replacement re-points the number at a new physical unit, and a single
 * unit-level field would lose the original acquisition. The unit's CURRENT
 * acquisition is the open entry's `uid_movement`.
 */
export interface UnitSerialHistoryEntryType {
  serial_number: string;
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
  version: number;
  created_by: ActorRefType;
  updated_by: ActorRefType;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}

/** Zod schema for {@link UnitSerialHistoryEntryType}. */
export const UnitSerialHistoryEntry: z.ZodType<UnitSerialHistoryEntryType> = z.strictObject({
  serial_number: SerialNumber.meta({ column: true, label: "Serial" }),
  start: chicagoInstant().meta({ column: true, label: "From" }),
  end: chicagoInstant().nullable().meta({ column: true, label: "Until" }),
  reason: SerialChangeReasonEnum.meta({ column: true, label: "Reason" }),
  uid_movement: MovementId.nullable(),
  // `mask` — free text an operator writes about a unit, which can name a person.
  notes: z.string().max(500).meta({ pii: "mask" }),
  changed_by: ActorRef.meta({ label: "Changed By" }),
});

/**
 * The document's own consistency, all derivable from the one document:
 *
 * 1. at most one history entry is open;
 * 2. `serial_number` is the open entry's serial, or `null` when none is open;
 * 3. a number that is not `active` carries no serial and no open entry — a
 *    vacant number's last serial is CLOSED, which is what lets a replacement
 *    open a new one.
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
}

/** Zod schema for {@link UnitType}. */
export const UnitSchema: z.ZodType<UnitType> = z.strictObject({
  uid: UnitId,
  uid_product: FirestoreId,
  number: UnitNumber.meta({ column: true, label: "Number", serverSortVia: "number" }),
  serial_number: SerialNumber.nullable().meta({ column: true, label: "Serial" }),
  serial_history: z.array(UnitSerialHistoryEntry).meta({ label: "Serial History" }),
  status: UnitStatusEnum.meta({ column: true, label: "Status" }),
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
