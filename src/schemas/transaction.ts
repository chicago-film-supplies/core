/**
 * Movement document schema — Firestore collection: `transactions`
 *
 * An append-only journal of inventory movement. Every event is **one subject**
 * (a booking for custody events, a product for ownership events) plus a set of
 * signed lines, grouped with its siblings by a client-minted `uuid_session`.
 *
 * The collection keeps its name — the journal was migrated in place — but the
 * document is a `Movement`, not the old current-state `Transaction`.
 *
 * ## Three axes
 *
 * Each answers an independent question about the same physical unit:
 *
 * | Axis       | Question                              | Lands on                                  |
 * |------------|---------------------------------------|-------------------------------------------|
 * | `custody`  | How far through this order is it?     | `booking.breakdown` — the seven keys      |
 * | `lines[]`  | Where is it in the warehouse?         | `locations.products[]`; `quantity_held`   |
 * | `cost`     | What is it carried at on the books?   | `inventory-ledgers.total_cost_basis`      |
 *
 * `cost` is **cost only, never revenue** — customer-facing money lives in Xero;
 * the only money here is inventory's carrying value.
 *
 * `custody` and `lines` are correlated but not derivable from each other:
 * custody implies the *kind* of place a unit is in ({@link CUSTODY_PLACE_KINDS})
 * but not *which* location, because where a returning unit goes back to is an
 * operator's choice.
 *
 * ## Conservation is structural, not checked
 *
 * A line's contribution to `quantity_held` is
 * `(location.to ? +q : 0) + (location.from ? −q : 0)` — no cross-line
 * summation. `{from: null, to: L3}` reads "entered ownership at L3";
 * `{from: L3, to: null}` reads "left ownership from L3"; both non-null is a
 * move that leaves ownership untouched. A half-move is inexpressible.
 *
 * `lines: []` means **nothing physically moved** — a `prep`, where reserved and
 * prepped units sit on the same shelf, or a cost-only adjustment.
 *
 * @module
 */
import { z } from "zod";
import { BookingId, FirestoreId, MovementId } from "./_uid.ts";
import { chicagoInstant } from "./_datetime.ts";
import {
  ActorRef,
  type ActorRefType,
  type CfsSourceCollectionType,
  DocSource,
  type DocSourceType,
  FirestoreTimestamp,
  type FirestoreTimestampType,
  TimestampFields,
} from "./common.ts";
import { BookingBreakdownKeyEnum, type BookingBreakdownKeyType } from "./booking.ts";

// ── Movement types ──────────────────────────────────────────────────

/**
 * Every kind of movement, as ONE classifier. There is deliberately no second
 * `kind` field: `type` is required in a strict object and drives
 * {@link getTransactionMultiplier}, so a document can never be half-classified.
 *
 * Grouped by which axes the type carries — see {@link MOVEMENT_CONTRACTS}, which
 * is the machine-readable form of the same grouping.
 *
 * **Removed in the journal migration**, all with zero stored instances in prod
 * AND dev, unreachable from `MANUAL_TRANSACTION_TYPES` and
 * {@link getDisplayTransactionTypes}: `acquisition`, `disposal`,
 * `partial_disposal`, `depreciation_tax`, `depreciation_gaap`. They were the
 * only unclassified branch, which is why `getTransactionMultiplier` used to
 * throw — a live 500 waiting on a type nothing could produce.
 *
 * Asset depreciation IS on the roadmap. When it lands:
 *   - **`depreciation` wants to be ONE type with a `book` field** on the cost
 *     object, not `depreciation_tax` + `depreciation_gaap`. As types they double
 *     every future cost-only event; as a field the book is one dimension.
 *     The movement shape already exists: `lines: []` + a negative `cost`, the
 *     same shape a late landed-cost adjustment uses.
 *   - **`disposal` wants to come back as its own type**, even though `write_off`
 *     already covers the mechanics (`out-of-service → null` + `cost`). Finance
 *     reporting a "disposals" line has to tell a disposal from a damage
 *     write-off, and inferring that from "is there an OOS record in `sources[]`"
 *     is inferring cause from effect — the same reason a refund is a credit-note
 *     link and not a `total_cost > 0` test.
 *   - `acquisition` and `partial_disposal` do NOT come back: the first is
 *     `purchase`, and the second is a `disposal` whose quantity is less than
 *     what's held. Quantity already says it.
 *
 * `transfer_increase` / `transfer_decrease` collapsed into a single
 * {@link MOVEMENT_CONTRACTS} `transfer`: they existed only because one row could
 * not say "out of A, into B", which `location: {from, to}` now says. The
 * migration rewrites the stored pairs.
 */
export const MOVEMENT_TYPES = [
  // Custody only — booking-scoped fulfillment, no ownership or cost change.
  "prep",
  "check_out",
  "check_in",
  "mark_damaged",
  "mark_lost",
  // Custody + ownership + cost.
  "sale",
  "sale_return",
  // Ownership + cost, no order involved.
  "opening_balance",
  "purchase",
  "find",
  "make",
  "adjustment_increase",
  "adjustment_decrease",
  "trade_in",
  "write_off",
  // Placement only — nets to zero on ownership and touches no cost.
  "transfer",
] as const;

/** Union of all movement type string literals. */
export type MovementTypeType = typeof MOVEMENT_TYPES[number];
/** Zod schema for MovementTypeType. */
export const MovementTypeEnum: z.ZodType<MovementTypeType> = z.enum(MOVEMENT_TYPES);

// ── Placement kinds ─────────────────────────────────────────────────

/**
 * The kinds of place a unit can be in. `"outside"` is the absence of a place —
 * a `null` side of `location`, meaning outside CFS ownership entirely.
 */
export const PLACE_KINDS = ["locations", "bookings", "out-of-service", "outside"] as const;
/** One kind of place a unit can occupy. */
export type PlaceKindType = typeof PLACE_KINDS[number];

/**
 * **Location is a total function**: every owned unit is in exactly one kind of
 * place, determined by its custody key. Consumed by the balance checker (rule 2)
 * and by every writer, so the mapping exists once.
 *
 * `out` is the one key whose place depends on the booking: a rental's units sit
 * at the booking until they come back, a sale's units left ownership at the
 * point of sale and are nowhere.
 */
export const CUSTODY_PLACE_KINDS: Readonly<
  Record<BookingBreakdownKeyType, readonly PlaceKindType[]>
> = {
  quoted: ["locations"],
  reserved: ["locations"],
  prepped: ["locations"],
  out: ["bookings", "outside"],
  returned: ["locations"],
  lost: ["out-of-service"],
  damaged: ["out-of-service"],
};

// ── The per-kind contract ───────────────────────────────────────────

/**
 * How the three axes may be filled for one movement type.
 *
 * Fixing this per type is what makes a missing axis a validation error rather
 * than a silent zero, a stray axis a validation error, and reversal a pure
 * negate-every-line transform. It is `hasCosts(type)` generalized to all three
 * axes.
 *
 * `custody: "with_booking"` — required exactly when `uid_booking` is set. Sales
 * are the only types that legitimately happen both ways: 247 stored rows are
 * order-sourced (a booking's units being sold), and the manual transaction form
 * lets an operator key an off-the-shelf sale with no order at all.
 */
export interface MovementContract {
  /** Whether the custody axis must, must not, or conditionally appears. */
  custody: "required" | "forbidden" | "with_booking";
  /** Whether the cost axis must or must not appear. */
  cost: "required" | "forbidden";
  /** `null` ⇒ `lines` must be empty (nothing physically moved). */
  places: { from: readonly PlaceKindType[]; to: readonly PlaceKindType[] } | null;
  /** Whether a `uid_booking` subject must, must not, or may appear. */
  booking: "required" | "forbidden" | "optional";
}

/** The per-kind line contract, one entry per {@link MOVEMENT_TYPES} member. */
export const MOVEMENT_CONTRACTS: Readonly<Record<MovementTypeType, MovementContract>> = {
  // Reserved and prepped units are both on the shelf, so nothing moves.
  prep: { custody: "required", cost: "forbidden", places: null, booking: "required" },
  check_out: {
    custody: "required",
    cost: "forbidden",
    places: { from: ["locations"], to: ["bookings"] },
    booking: "required",
  },
  check_in: {
    custody: "required",
    cost: "forbidden",
    places: { from: ["bookings"], to: ["locations"] },
    booking: "required",
  },
  mark_damaged: {
    custody: "required",
    cost: "forbidden",
    places: { from: ["bookings"], to: ["out-of-service"] },
    booking: "required",
  },
  mark_lost: {
    custody: "required",
    cost: "forbidden",
    places: { from: ["bookings"], to: ["out-of-service"] },
    booking: "required",
  },
  // A one-sided line: the units leave both the shelf and ownership, and that is
  // what drops `quantity_held`.
  //
  // Both `locations` and `bookings` are legitimate origins, and this is not a
  // compatibility carve-out: an off-the-shelf sale takes units straight off a
  // shelf, while an order-scoped sale whose units were already checked out takes
  // them from the booking they are sitting at. Constraining to one would make the
  // other unwritable.
  sale: {
    custody: "with_booking",
    cost: "required",
    places: { from: ["locations", "bookings"], to: ["outside"] },
    booking: "optional",
  },
  // A no-refund return is the same event with `cost.amount === 0` — the zero IS
  // the decision, which is why cost is required rather than nullable here.
  sale_return: {
    custody: "with_booking",
    cost: "required",
    places: { from: ["outside"], to: ["locations"] },
    booking: "optional",
  },
  opening_balance: {
    custody: "forbidden",
    cost: "required",
    places: { from: ["outside"], to: ["locations"] },
    booking: "forbidden",
  },
  purchase: {
    custody: "forbidden",
    cost: "required",
    places: { from: ["outside"], to: ["locations"] },
    booking: "forbidden",
  },
  find: {
    custody: "forbidden",
    cost: "required",
    places: { from: ["outside"], to: ["locations"] },
    booking: "forbidden",
  },
  make: {
    custody: "forbidden",
    cost: "required",
    places: { from: ["outside"], to: ["locations"] },
    booking: "forbidden",
  },
  adjustment_increase: {
    custody: "forbidden",
    cost: "required",
    places: { from: ["outside"], to: ["locations"] },
    booking: "forbidden",
  },
  adjustment_decrease: {
    custody: "forbidden",
    cost: "required",
    places: { from: ["locations"], to: ["outside"] },
    booking: "forbidden",
  },
  trade_in: {
    custody: "forbidden",
    cost: "required",
    places: { from: ["locations"], to: ["outside"] },
    booking: "forbidden",
  },
  // No custody: the booking keeps `damaged: N` forever — a terminal key and part
  // of its history — so removing it would break `sum(breakdown) === quantity`.
  // A write-off removes ownership, not history.
  //
  // `locations` is allowed alongside `out-of-service` because requiring a unit to
  // pass through an OOS record before it can be written off is a workflow rule,
  // not a physical one — an operator finding a broken unit on a shelf can write
  // it off from there.
  write_off: {
    custody: "forbidden",
    cost: "required",
    places: { from: ["out-of-service", "locations"], to: ["outside"] },
    booking: "forbidden",
  },
  // Nets to zero on ownership, so it has no cost object to mis-gate — which is
  // what made #286 (a costed transfer corrupting the basis) possible.
  transfer: {
    custody: "forbidden",
    cost: "forbidden",
    places: { from: ["locations"], to: ["locations"] },
    booking: "forbidden",
  },
};

/**
 * Returns +1 for movements that increase owned quantity, -1 for those that
 * decrease it, and 0 for those that leave it untouched (a `transfer`, a
 * custody-only fulfillment step, a cost-only adjustment).
 *
 * **Total** — it cannot throw. The financial-only types that used to make it
 * partial are gone; see {@link MOVEMENT_TYPES}. Derived from the contract so it
 * cannot drift from it.
 */
export function getTransactionMultiplier(type: MovementTypeType): 1 | -1 | 0 {
  const places = MOVEMENT_CONTRACTS[type].places;
  if (!places) return 0;
  const entering = places.from.includes("outside");
  const leaving = places.to.includes("outside");
  if (entering && !leaving) return 1;
  if (leaving && !entering) return -1;
  return 0;
}

/** Whether a movement type carries a cost object. Derived from the contract. */
export function hasCosts(type: MovementTypeType): boolean {
  return MOVEMENT_CONTRACTS[type].cost === "required";
}

/**
 * Movement types suitable for the manual transaction form.
 *
 * **Derived from {@link MANUAL_MOVEMENT_TYPES}, which is what
 * `CreateTransactionInput` validates against — so the picker cannot offer a type
 * the API rejects.** It used to re-derive the set independently from
 * `MOVEMENT_CONTRACTS`, and the two disagreed: `sale_return` has no *required*
 * booking, so it passed that filter and reached the manager's type picker, while
 * the input schema refused it. An operator picking it got a 400. (core#41)
 *
 * The one remaining asymmetry is deliberate and runs the safe way:
 * `opening_balance` is *accepted* by the input but hidden here, because it is
 * minted at product creation rather than keyed. Hiding an accepted type costs
 * nothing; offering a rejected one is a dead end in the UI.
 *
 * When `increaseOnly` is true, returns only types that add stock — for the first
 * transaction on a product.
 */
export function getDisplayTransactionTypes(increaseOnly?: boolean): MovementTypeType[] {
  if (increaseOnly) return ["purchase", "make", "find"];
  return MANUAL_MOVEMENT_TYPES.filter((t) => t !== "opening_balance");
}

// ── Line, custody and cost ──────────────────────────────────────────

/**
 * One physical movement of `quantity` units between two places.
 *
 * A `null` side means "outside CFS ownership". Both sides non-null is a move
 * that leaves `quantity_held` untouched.
 *
 * Note `lines[]` is NOT directly queryable — Firestore `array-contains` works on
 * scalar arrays, not nested object fields. Query paths come from the flat
 * `query_by_*` denorms.
 */
export interface MovementLineType {
  quantity: number;
  location: { from: DocSourceType | null; to: DocSourceType | null };
}

/** Zod schema for one movement line. */
export const MovementLine: z.ZodType<MovementLineType> = z.strictObject({
  quantity: z.number().int().positive().meta({ column: true, label: "Quantity" }),
  location: z.strictObject({
    from: DocSource.nullable().meta({ label: "From" }),
    to: DocSource.nullable().meta({ label: "To" }),
  }).refine(
    (l) => l.from !== null || l.to !== null,
    { message: "A line must move units from somewhere, to somewhere, or both" },
  ),
});

/**
 * The custody transition this event records, as a pair of breakdown keys.
 *
 * Named `custody` and deliberately NOT `status` or `state`: `Booking` already
 * has a `status` field (`draft/quoted/reserved/part-prepped/prepped/active/
 * complete`) that is a different thing from a breakdown key, and the two enums
 * share several words — `status: {from: "prepped"}` would misread as
 * `booking.status`.
 *
 * A side may be `null` for a one-sided transition: an order edit that changes
 * the booking's own quantity moves units into or out of the breakdown without a
 * matching opposite key.
 */
export interface MovementCustodyType {
  from: BookingBreakdownKeyType | null;
  to: BookingBreakdownKeyType | null;
}

/** Zod schema for a custody transition. */
export const MovementCustody: z.ZodType<MovementCustodyType> = z.strictObject({
  from: BookingBreakdownKeyEnum.nullable(),
  to: BookingBreakdownKeyEnum.nullable(),
}).refine(
  (c) => c.from !== null || c.to !== null,
  { message: "A custody transition must name at least one side" },
);

/**
 * The carrying-value change this event records. `amount_cents` is signed:
 * negative removes basis, positive adds it. `unit_costs_cents[]` carries the
 * per-unit basis actually consumed or added, which the weighted-average cost
 * fold reads.
 *
 * ⚠️ **`unit_cost` sits between two `_cents` fields and is NOT one of them.**
 * It is a per-unit **rate** at 4dp, and quantizing it to the cent is a measured
 * regression, not a hypothetical: `@cfs/core@10.0.0-beta.117` emitted it
 * through `fromCentsBig` and a 100-unit $6.39 purchase reported $0.06/unit — a
 * 6% error that went a week undetected because every movement written in that
 * window happened to divide evenly at the cent. A mechanical "convert every
 * money field in this object" pass restores it exactly.
 */
export interface MovementCostType {
  amount_cents: number;
  /** A per-unit RATE at 4dp — dollars, not cents. See the type docblock. */
  unit_cost: number;
  unit_costs_cents: number[];
}

/** Zod schema for a cost change. */
export const MovementCost: z.ZodType<MovementCostType> = z.strictObject({
  amount_cents: z.int().meta({ column: true, label: "Cost" }),
  // `unit: "usd"` NAMES the unit rather than asserting mere rate-ness — 4dp
  // dollars, so the cell reaches for a rate formatter and not the 2dp money one
  // that rendered $0.0639/unit as `$0.00`. A bare `rate: true` marker would
  // repeat `money: boolean`'s mistake of carrying no unit at all.
  unit_cost: z.number().meta({ column: true, label: "Unit Cost", unit: "usd" }),
  unit_costs_cents: z.array(z.int()).default([]),
});

// ── The document ────────────────────────────────────────────────────

/** A movement-journal event. */
export interface Movement {
  /**
   * `{uuid_session}|{type}|{subject}`. Equals the document id.
   *
   * One shape, no auto-id alternative: `uuid_session` is required on every
   * movement, so the migration has to mint one for each historical row
   * regardless — and once it has, deriving the id costs nothing and spares every
   * reader a "which shape is this" branch. The corpus is re-keyed rather than
   * carried, which is safe because the only things referencing a transaction by
   * id were 900 auto-cowritten threads, none of which holds a comment.
   */
  uid: string;
  /**
   * This movement's own sequence number, unique across the collection.
   *
   * Genuinely new: the old `source.number` was the *source's* number, not the
   * transaction's — measured on prod, 138 distinct values across 917 docs with
   * 63 reused, because order-sourced rows denormalised the *order's* number.
   * The order's number survives as a `label` on its `sources[]` entry.
   */
  number: number;

  // ── subject: exactly one per event ────────────────────────────────
  uid_product: string;
  /** The custody subject. `null` for ownership-only events. */
  uid_booking: string | null;

  // ── what happened ─────────────────────────────────────────────────
  type: MovementTypeType;
  quantity: number;
  custody: MovementCustodyType | null;
  cost: MovementCostType | null;
  /** Physical movement. Empty when nothing moved. */
  lines: MovementLineType[];
  /** The physical instant the movement happened, not when it was recorded. */
  date: string;
  date_fs: FirestoreTimestampType;
  /** Free text — the one balance-irrelevant field still editable in place. */
  reference: string;

  // ── grouping, idempotency, correction ─────────────────────────────
  /** One per operator action. Client-minted, so a retry storm collapses. */
  uuid_session: string;
  /** The uid of the movement this one negates. */
  reverses: string | null;

  // ── provenance ────────────────────────────────────────────────────
  sources: DocSourceType[];
  query_by_sources: string[];

  // ── denormalised query keys ───────────────────────────────────────
  query_by_uid_store: string[];
  query_by_uid_location: string[];

  // ── carried over unchanged ────────────────────────────────────────
  serialized_details: { asset_tags: string[]; serial_numbers: string[] } | null;

  // ── standard ──────────────────────────────────────────────────────
  version: number;
  created_by: ActorRefType;
  updated_by: ActorRefType;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}

/** The kind of place a `DocSource` points at, for contract checking. */
function placeKind(source: DocSourceType | null): PlaceKindType {
  if (source === null) return "outside";
  const collection: CfsSourceCollectionType = source.collection;
  if (collection === "locations" || collection === "bookings" || collection === "out-of-service") {
    return collection;
  }
  // Anything else is not a place; reported as a contract violation by the caller.
  return "outside";
}

/** True when `source` names a real place (not the absence of one). */
function isPlace(source: DocSourceType | null): boolean {
  return source !== null &&
    (source.collection === "locations" || source.collection === "bookings" ||
      source.collection === "out-of-service");
}

/**
 * Enforces the per-kind contract and the two surviving balance rules.
 *
 * The old "custody lines sum to Δquantity" and "Σ placement == Σ held" rules are
 * gone: with `from`/`to` on one line, an unbalanced move cannot be written.
 *
 * **A reversal's placement contract is its type's, MIRRORED.** A reversal keeps
 * the original's type and negates its lines, so a reversed `sale` runs
 * `outside → locations` against a table that says `locations → outside`. Without
 * the mirror the contract rejects it, and every reversal of a one-directional
 * type — sale, purchase, write_off, check_out, … — is unwritable. Mirroring here
 * rather than exempting reversals keeps the check real: a reversal must still
 * name places of the RIGHT KIND, just in the opposite order. (`custody` needs no
 * mirror: the writer swaps its two ends, so rule 3 lines up side-for-side.)
 */
function checkMovementContract(m: Movement, ctx: z.RefinementCtx): void {
  const base = MOVEMENT_CONTRACTS[m.type];
  if (!base) return;
  const contract: MovementContract = m.reverses === null || base.places === null ? base : {
    ...base,
    places: { from: base.places.to, to: base.places.from },
  };

  // ── booking subject ──
  if (contract.booking === "required" && m.uid_booking === null) {
    ctx.addIssue({
      code: "custom",
      path: ["uid_booking"],
      message: `"${m.type}" is a booking-scoped event and requires uid_booking`,
    });
  }
  if (contract.booking === "forbidden" && m.uid_booking !== null) {
    ctx.addIssue({
      code: "custom",
      path: ["uid_booking"],
      message: `"${m.type}" is not booking-scoped; uid_booking must be null`,
    });
  }

  // ── custody axis ──
  const custodyRequired = contract.custody === "required" ||
    (contract.custody === "with_booking" && m.uid_booking !== null);
  const custodyForbidden = contract.custody === "forbidden" ||
    (contract.custody === "with_booking" && m.uid_booking === null);
  if (custodyRequired && m.custody === null) {
    ctx.addIssue({
      code: "custom",
      path: ["custody"],
      message: `"${m.type}" requires a custody transition`,
    });
  }
  if (custodyForbidden && m.custody !== null) {
    ctx.addIssue({
      code: "custom",
      path: ["custody"],
      message: `"${m.type}" must not carry a custody transition`,
    });
  }

  // ── cost axis ──
  if (contract.cost === "required" && m.cost === null) {
    ctx.addIssue({ code: "custom", path: ["cost"], message: `"${m.type}" requires a cost` });
  }
  if (contract.cost === "forbidden" && m.cost !== null) {
    ctx.addIssue({ code: "custom", path: ["cost"], message: `"${m.type}" must not carry a cost` });
  }

  // ── lines ──
  if (contract.places === null) {
    if (m.lines.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["lines"],
        message: `"${m.type}" moves nothing physically; lines must be empty`,
      });
    }
    return;
  }
  if (m.lines.length === 0) {
    ctx.addIssue({
      code: "custom",
      path: ["lines"],
      message: `"${m.type}" moves units and requires at least one line`,
    });
    return;
  }

  // Rule 1: the lines allocate exactly the event's quantity.
  const total = m.lines.reduce((sum, l) => sum + l.quantity, 0);
  if (total !== m.quantity) {
    ctx.addIssue({
      code: "custom",
      path: ["lines"],
      message: `lines sum to ${total} but quantity is ${m.quantity}`,
    });
  }

  // Rule 2: each side is the kind of place the contract (and hence custody) implies.
  m.lines.forEach((line, i) => {
    for (const side of ["from", "to"] as const) {
      const source = line.location[side];
      const allowed = contract.places![side];
      if (source !== null && !isPlace(source)) {
        ctx.addIssue({
          code: "custom",
          path: ["lines", i, "location", side],
          message: `"${source.collection}" is not a place units can be in`,
        });
        continue;
      }
      const kind = placeKind(source);
      if (!allowed.includes(kind)) {
        ctx.addIssue({
          code: "custom",
          path: ["lines", i, "location", side],
          message: `"${m.type}" moves ${side} ${allowed.join(" or ")}, got "${kind}"`,
        });
      }
    }
  });

  // Rule 3: custody and placement must agree on the kind of place.
  if (m.custody !== null) {
    for (const side of ["from", "to"] as const) {
      const key = m.custody[side];
      if (key === null) continue;
      const implied = CUSTODY_PLACE_KINDS[key];
      m.lines.forEach((line, i) => {
        const kind = placeKind(line.location[side]);
        if (!implied.includes(kind)) {
          ctx.addIssue({
            code: "custom",
            path: ["lines", i, "location", side],
            message:
              `custody.${side} "${key}" implies ${implied.join(" or ")}, but the line says "${kind}"`,
          });
        }
      });
    }
  }
}

/** Zod schema for a Movement. */
export const MovementSchema: z.ZodType<Movement> = z.strictObject({
  uid: MovementId,
  number: z.int().min(0).meta({ serverSortVia: "number", column: true, label: "#" }),
  uid_product: FirestoreId,
  // Safe to constrain: the historical corpus has no uid_booking at all (it is
  // null for every migrated doc), so only new writers reach this.
  uid_booking: BookingId.nullable(),
  type: MovementTypeEnum.meta({ column: true, label: "Type" }),
  quantity: z.number().meta({ serverSortVia: "quantity", column: true, label: "Quantity" }),
  custody: MovementCustody.nullable(),
  cost: MovementCost.nullable(),
  lines: z.array(MovementLine).default([]).meta({ label: "Line" }),
  date: chicagoInstant().meta({ serverSortVia: "date_fs", column: true, label: "Date" }),
  date_fs: FirestoreTimestamp,
  reference: z.string().meta({ column: true, label: "Reference" }),
  uuid_session: z.uuid(),
  // Required-but-nullable; all 932 prod movements carry the KEY as `null`
  // (2026-08-23) because no movement has been reversed yet. Not dead — the
  // reversal path reads it at `:535`. CLAUDE.md § "Is a field dead?".
  reverses: MovementId.nullable(),
  sources: z.array(DocSource).default([]).meta({ label: "Source" }),
  query_by_sources: z.array(z.string()).default([]),
  query_by_uid_store: z.array(FirestoreId).default([]),
  query_by_uid_location: z.array(FirestoreId).default([]),
  serialized_details: z.strictObject({
    asset_tags: z.array(z.string()).default([]),
    serial_numbers: z.array(z.string()).default([]),
  }).nullable(),
  version: z.int().min(0).default(0),
  created_by: ActorRef.meta({ column: true, label: "Created By" }),
  updated_by: ActorRef.meta({ column: true, label: "Updated By" }),
  ...TimestampFields,
}).superRefine(checkMovementContract).meta({
  title: "Movement",
  collection: "transactions",
  displayDefaults: {
    // `total_cost` and `source.type` are gone — the cost object and `sources[]`
    // replaced them. `tests/display-defaults.test.ts` resolves every path here.
    columns: ["date", "number", "quantity", "type", "reference"],
    filters: {},
    sort: { column: "date", direction: "desc" },
    groupBy: [
      { field: null, label: "None" },
      { field: "type", label: "Type", kind: "enum" },
    ],
  },
});

// ── Input schemas ───────────────────────────────────────────────────

/**
 * Types an operator may key directly. The booking-scoped fulfillment events are
 * excluded — the picker writes those — as are `transfer` (its own UI) and
 * `sale_return` (raised from the sale it reverses, so it can find the basis).
 */
const MANUAL_MOVEMENT_TYPES = [
  "purchase",
  "find",
  "make",
  "opening_balance",
  "adjustment_increase",
  "sale",
  "write_off",
  "trade_in",
  "adjustment_decrease",
] as const;

/**
 * One requested placement of `quantity` units. Direction-agnostic on purpose:
 * {@link MOVEMENT_CONTRACTS} decides whether it lands on `location.from` or
 * `location.to`, so the client never has to know which way a type moves.
 */
export interface MovementAllocationInputType {
  uid_location: string;
  quantity: number;
}

/** Zod schema for one requested placement. */
export const MovementAllocationInput: z.ZodType<MovementAllocationInputType> = z.object({
  uid_location: FirestoreId,
  quantity: z.number().int().positive(),
});

/** Input for creating a manual movement. */
export interface CreateTransactionInputType {
  uid_product: string;
  type: typeof MANUAL_MOVEMENT_TYPES[number];
  quantity: number;
  total_cost_cents: number;
  date: string;
  reference: string;
  uuid_session: string;
  allocations?: MovementAllocationInputType[];
  serialized_details?: { asset_tags: string[]; serial_numbers: string[] } | null;
}

/**
 * Input schema for creating a manual movement.
 *
 * `uid` is gone: the document id is derived (`{uuid_session}|{type}|{subject}`),
 * which is what makes a retried create idempotent instead of appending a second
 * event. `allocations` is optional — absent means the server allocates.
 */
export const CreateTransactionInput: z.ZodType<CreateTransactionInputType> = z.object({
  uid_product: FirestoreId,
  type: z.enum(MANUAL_MOVEMENT_TYPES),
  quantity: z.number().int().positive(),
  total_cost_cents: z.int().min(0),
  date: chicagoInstant(),
  reference: z.string(),
  uuid_session: z.uuid(),
  allocations: z.array(MovementAllocationInput).min(1).optional(),
  serialized_details: z.object({
    asset_tags: z.array(z.string()).default([]),
    serial_numbers: z.array(z.string()).default([]),
  }).nullable().optional(),
}).refine(
  // The scalar quantity must equal Σ per-location allocation, or the movement is
  // born desynced. `CreateProductInput` has carried the identical rule since
  // #168 (`schemas/product.ts`, on `transaction.quantity`); this boundary did
  // not, so the two disagreed about the same invariant.
  //
  // Without it the payload passes the door — every field validates
  // independently — and is caught only at write time by
  // `MovementSchema.superRefine` → `checkMovementContract` balance rule 1, where
  // `assertValidForWrite` throws a bare `Error`. The client gets an opaque
  // **500** instead of a 400 naming the field. Until this landed the CLIENT was
  // the only real guard: the manager gates its Create button on
  // `Σ allocations === quantity`, which is a UI courtesy, not a contract. core#45.
  //
  // Absent `allocations` is explicitly NOT a violation — it means "the server
  // allocates", which is the documented default and why the field is optional.
  (t) =>
    !t.allocations ||
    t.quantity === t.allocations.reduce((sum, a) => sum + a.quantity, 0),
  {
    message: "quantity must equal the sum of per-location allocation quantities",
    path: ["quantity"],
  },
) as z.ZodType<CreateTransactionInputType>;

/**
 * Input for editing a movement's descriptive fields.
 *
 * **Balance-affecting fields are absent by design.** Quantity, type, cost,
 * placement and date change through a reversal plus a corrected event, not an
 * in-place edit — that is what makes the collection a journal rather than a
 * mutable table. Only `reference` still edits in place.
 */
export interface UpdateTransactionInputType {
  reference: string;
  version: number;
}

/** Input schema for editing a movement's descriptive fields. */
export const UpdateTransactionInput: z.ZodType<UpdateTransactionInputType> = z.object({
  reference: z.string(),
  version: z.int().min(0),
});

/** Input for reversing a movement. */
export interface ReverseTransactionInputType {
  uuid_session: string;
  reference: string;
  date?: string;
}

/**
 * Input schema for reversing a movement. The reversal negates every line of the
 * event it names; nothing else is client-supplied, so a reversal cannot silently
 * disagree with what it reverses.
 */
export const ReverseTransactionInput: z.ZodType<ReverseTransactionInputType> = z.object({
  uuid_session: z.uuid(),
  reference: z.string(),
  date: chicagoInstant().optional(),
});

/** Input for creating a store-to-store transfer. */
export interface CreateStoreTransferInputType {
  uid_product: string;
  quantity: number;
  date: string;
  reference: string;
  uuid_session: string;
  from: MovementAllocationInputType[];
  to: MovementAllocationInputType[];
  serialized_details?: { asset_tags: string[]; serial_numbers: string[] } | null;
}

/**
 * Input schema for a store-to-store transfer.
 *
 * One event, not the old `transfer_increase` + `transfer_decrease` pair:
 * `location: {from, to}` says what two documents used to. `total_cost` is gone —
 * a transfer nets to zero on ownership, so it has no cost object to mis-gate,
 * which is what made #286 possible.
 */
export const CreateStoreTransferInput: z.ZodType<CreateStoreTransferInputType> = z.object({
  uid_product: FirestoreId,
  quantity: z.number().int().positive(),
  date: chicagoInstant(),
  reference: z.string(),
  uuid_session: z.uuid(),
  from: z.array(MovementAllocationInput).min(1),
  to: z.array(MovementAllocationInput).min(1),
  serialized_details: z.object({
    asset_tags: z.array(z.string()).default([]),
    serial_numbers: z.array(z.string()).default([]),
  }).nullable().optional(),
});

// Totality of `MOVEMENT_CONTRACTS` over `MOVEMENT_TYPES`, and of
// `CUSTODY_PLACE_KINDS` over the breakdown keys, is enforced by the
// `Readonly<Record<…>>` annotations on the declarations themselves — an
// incomplete literal is a type error there, and an extra key is an excess
// property. Two `X extends keyof typeof X_TABLE` guards used to sit here
// claiming to do that job; because the annotation already fixes `keyof` to the
// union, both read `T extends T` and could not fail. Deleting them was verified
// to lose nothing: an unbacked `MOVEMENT_TYPES` member still fails `deno check`
// at the annotation, which is where the error belongs.
