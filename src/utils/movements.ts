/**
 * Pure helpers over the movement journal — the fold from an event's lines onto
 * an inventory ledger, the reversal transform, and the placement helpers that
 * turn a contract plus an allocation into lines.
 *
 * ```ts
 * import { applyMovementToLedger, negateLines } from "@cfs/core/utils/movements";
 * ```
 *
 * Db-free and side-effect-free, so the same fold runs server-side inside a
 * Firestore transaction and in a test over a plain object. Document refs,
 * throws and logging stay in api-cloudrun; this module only computes.
 *
 * The contract tables themselves (`MOVEMENT_CONTRACTS`, `CUSTODY_PLACE_KINDS`)
 * live in `schemas/transaction.ts`, not here — the document schema validates
 * against them, and schema modules cannot import utils.
 *
 * @module
 */
import type {
  InventoryLedger,
  Movement,
  MovementLineType,
  MovementTypeType,
  StoreBreakdownEntry,
  StoreBreakdownLocation,
} from "../schemas/mod.ts";
import { MOVEMENT_CONTRACTS } from "../schemas/mod.ts";
import { fromCentsBig, perUnitCostAt4dp, roundDivHalfUp, toCentsBig } from "./money.ts";

// ── Money ───────────────────────────────────────────────────────────

/**
 * The carrying value of `quantity` units drawn from a basis of `basisCents`
 * spread over `heldUnits`, rounded once at the end.
 *
 * **`× quantity ÷ held`, never `× (basis / held)`.** Deriving a per-unit average
 * first and multiplying by it quantizes the average before it is scaled, so the
 * error rides into the money — the operation-order trap, not a precision one.
 * The previous ledger fold did exactly that: it read the stored
 * `average_unit_cost` (already quantized) and multiplied. Here the division
 * happens last, on exact integer cents.
 */
export function costOfUnits(basisCents: bigint, heldUnits: number, quantity: number): bigint {
  if (heldUnits <= 0 || quantity <= 0) return 0n;
  if (basisCents <= 0n) return 0n;
  const drawn = roundDivHalfUp(basisCents * BigInt(quantity), BigInt(heldUnits));
  // Never remove more basis than exists — a rounding-up on the last units out
  // would otherwise leave a negative residue.
  return drawn > basisCents ? basisCents : drawn;
}

// ── Placement ───────────────────────────────────────────────────────

/**
 * A line's contribution to `quantity_held`: `+q` if it lands somewhere, `−q` if
 * it leaves from somewhere, and `0` when it does both.
 *
 * Conservation is structural — no cross-line summation, and a half-move is
 * inexpressible because a line with two nulls does not validate.
 */
export function heldDelta(line: MovementLineType): number {
  const enters = line.location.to !== null ? line.quantity : 0;
  const leaves = line.location.from !== null ? line.quantity : 0;
  return enters - leaves;
}

/** A movement's total effect on `quantity_held`. */
export function movementHeldDelta(lines: readonly MovementLineType[]): number {
  return lines.reduce((sum, l) => sum + heldDelta(l), 0);
}

/**
 * Swap every line's `from` and `to`. This is the whole of a reversal: because a
 * line carries both sides, negating it needs no knowledge of the movement type,
 * and the per-kind contract makes the result either valid or rejected rather
 * than silently lopsided.
 */
export function negateLines(lines: readonly MovementLineType[]): MovementLineType[] {
  return lines.map((l) => ({
    quantity: l.quantity,
    location: { from: l.location.to, to: l.location.from },
  }));
}

/**
 * Which side of a line an operator-supplied allocation lands on, per the type's
 * contract. `check_out` is location→booking so an allocation names the source;
 * `check_in` is booking→location so it names the destination.
 *
 * Returning the side rather than letting callers decide is the point: the client
 * sends a direction-agnostic `[{uid_location, quantity}]` and never has to know
 * which way a type moves.
 */
export function allocationSide(type: MovementTypeType): "from" | "to" | "both" | null {
  const places = MOVEMENT_CONTRACTS[type].places;
  if (!places) return null;
  const fromIsLocation = places.from.includes("locations");
  const toIsLocation = places.to.includes("locations");
  if (fromIsLocation && toIsLocation) return "both";
  if (fromIsLocation) return "from";
  if (toIsLocation) return "to";
  return null;
}

// ── The ledger fold ─────────────────────────────────────────────────

/** What a movement did to a ledger, and the cost it actually consumed. */
export interface LedgerFoldResult {
  ledger: InventoryLedger;
  /**
   * The basis this movement moved, signed. For a cost-bearing decrease this is
   * the weighted-average share computed from the basis **before** the quantity
   * changed, so it is what a reversal must restore.
   *
   * Returned rather than written back onto the input movement. The old fold
   * mutated `transaction.total_cost` in place, which made the applier's output
   * depend on the caller remembering to persist its input.
   */
  costApplied: number;
  /** The per-unit basis this movement consumed or added, at 2dp. */
  unitCost: number;
}

/** A shallow-cloned store entry, so the fold never mutates its input. */
function cloneStoreBreakdown(entries: readonly StoreBreakdownEntry[]): StoreBreakdownEntry[] {
  return entries.map((s) => ({ ...s, locations: s.locations.map((l) => ({ ...l })) }));
}

/**
 * Find or create the store entry owning `uidStore`.
 *
 * Create-if-missing is deliberate (#294): a movement may legitimately place
 * units in a store the ledger has never held — a first purchase into a new
 * store. The predecessor used `.find(...)!` and threw a raw TypeError mid
 * transaction. For a decrease into a never-held store the entry starts at zero
 * and is driven negative, which the caller's non-negative assertion then rejects
 * as a typed 400, which is the right failure.
 */
function upsertStore(
  ledger: InventoryLedger,
  uidStore: string,
): StoreBreakdownEntry {
  const found = ledger.store_breakdown.find((s) => s.uid_store === uidStore);
  if (found) return found;
  const created: StoreBreakdownEntry = {
    uid_store: uidStore,
    // `name` and `default` are stamped by the caller from the resolved
    // placement, on create AND on every later touch — see the fold below.
    name: "",
    default: false,
    crms_stock_level_id: null,
    quantity: 0,
    locations: [],
  };
  ledger.store_breakdown.push(created);
  return created;
}

/** Find or create the location entry within a store. Same rationale as above. */
function upsertLocation(store: StoreBreakdownEntry, uidLocation: string): StoreBreakdownLocation {
  const found = store.locations.find((l) => l.uid_location === uidLocation);
  if (found) return found;
  const created: StoreBreakdownLocation = {
    uid_location: uidLocation,
    name: "",
    default: false,
    max: null,
    quantity: 0,
  };
  store.locations.push(created);
  return created;
}

/**
 * Where a `locations`-kind DocSource sits, resolved by the caller.
 *
 * Every field is read from the `locations` / `stores` documents, never from
 * client input — that is what makes a cross-store placement inexpressible
 * (#307). It carries the store's identity as well as the location's because the
 * ledger's `store_breakdown` denormalizes both, and `allocateBookingToStores`
 * sorts on `store.default`, `store.name` and `location.default`: a placement
 * that left them at `""`/`false` would silently cost the allocator its
 * default-store-first and default-location-first ordering.
 */
export interface LocationPlacement {
  uid_store: string;
  store_name: string;
  /** The owning store's own `default` flag — NOT the location's. */
  store_default: boolean;
  name: string;
  default: boolean;
  max: number | null;
}

/**
 * Fold one movement onto a ledger, returning a NEW ledger.
 *
 * Purely a function of `(ledger, movement, placements)`: no Firestore, no clock,
 * no mutation of either input. `now` is injected rather than read so the same
 * write instant can be shared across a multi-document transaction.
 *
 * `placements` resolves each `locations`-kind line endpoint to the store that
 * owns it. The caller must have already asserted that ownership (#307) — this
 * fold trusts the map, because the read that proves it is what stops a future
 * writer from skipping the check.
 *
 * ## Cost
 *
 * Increases add the caller-supplied acquisition cost. Cost-bearing decreases
 * remove the weighted-average share of the basis captured BEFORE the quantity
 * changes — never the caller's number, which is revenue or an estimate and let
 * the basis drift from quantity and even go negative.
 *
 * The returned `unitCost` and the ledger's `average_unit_cost` are per-unit
 * **rates at 4dp** (`perUnitCostAt4dp`), not money. Both were quantized to the
 * cent until 2026-08-03, which reported a 100-unit purchase at $6.39 as
 * $0.06/unit — a 6% error on a figure that is only ever displayed. The basis
 * itself is money and is unchanged.
 *
 * A type whose contract forbids cost never touches the basis at all. That is
 * what makes #286 (a costed transfer corrupting the basis) structurally
 * impossible rather than gated: a transfer has no cost object to mis-gate.
 */
export function applyMovementToLedger(
  ledger: InventoryLedger,
  movement: Pick<Movement, "type" | "quantity" | "lines" | "cost">,
  placements: ReadonlyMap<string, LocationPlacement>,
  now: InventoryLedger["updated_at"],
): LedgerFoldResult {
  const next: InventoryLedger = {
    ...ledger,
    out_of_service_breakdown: { ...ledger.out_of_service_breakdown },
    store_breakdown: cloneStoreBreakdown(ledger.store_breakdown),
  };

  const delta = movementHeldDelta(movement.lines);
  const carriesCost = MOVEMENT_CONTRACTS[movement.type].cost === "required";

  // ── Cost basis, before the quantity moves ──
  //
  // The basis is MONEY and stays at the cent. `unitCost` is a RATE and does not:
  // see `perUnitCostAt4dp`. Both are derived from the same integer cents, so the
  // pair cannot disagree about how much moved — only about how finely the
  // per-unit figure is reported.
  let costApplied = 0;
  let unitCost = 0;
  if (carriesCost) {
    const basisCents = toCentsBig(next.total_cost_basis);
    if (delta > 0) {
      const addCents = toCentsBig(movement.cost?.amount ?? 0);
      costApplied = fromCentsBig(addCents);
      unitCost = perUnitCostAt4dp(addCents, BigInt(delta));
      next.total_cost_basis = fromCentsBig(basisCents + addCents);
    } else if (delta < 0) {
      const units = -delta;
      const outCents = costOfUnits(basisCents, next.quantity_held, units);
      costApplied = -fromCentsBig(outCents);
      unitCost = perUnitCostAt4dp(outCents, BigInt(units));
      next.total_cost_basis = fromCentsBig(basisCents - outCents);
    }
  }

  next.quantity_held += delta;

  if (next.quantity_held > 0) {
    next.average_unit_cost = perUnitCostAt4dp(
      toCentsBig(next.total_cost_basis),
      BigInt(next.quantity_held),
    );
  } else if (carriesCost) {
    // No units held after a cost-bearing move (a sale of the last unit) means no
    // carrying cost. Zero both, so a residual basis cannot corrupt the average of
    // the next purchase — held→0 then buy 1 must not inherit.
    next.average_unit_cost = 0;
    next.total_cost_basis = 0;
  }
  // else: a placement-only movement drove held transiently to 0 (#286 defect 2).
  // Leave basis and average untouched; zeroing here PERMANENTLY destroyed the
  // basis, which is the prod corruption that fix addressed.

  // ── Placement ──
  for (const line of movement.lines) {
    for (const side of ["from", "to"] as const) {
      const source = line.location[side];
      if (source === null || source.collection !== "locations") continue;
      const placement = placements.get(source.uid);
      if (!placement) continue;
      const sign = side === "to" ? 1 : -1;
      const store = upsertStore(next, placement.uid_store);
      const location = upsertLocation(store, source.uid);
      // Refreshed on every touch, not only on create, so a renamed store or a
      // re-flagged default self-heals on the next movement instead of needing a
      // cascade of its own.
      store.name = placement.store_name;
      store.default = placement.store_default;
      location.name = placement.name;
      location.default = placement.default;
      location.max = placement.max;
      location.quantity += line.quantity * sign;
      store.quantity += line.quantity * sign;
    }
  }

  // ── The three fields that used to be vestigial ──
  Object.assign(next, deriveServiceQuantities(next, movement.lines));

  next.query_by_uid_store = next.store_breakdown.map((s) => s.uid_store);
  next.query_by_uid_location = next.store_breakdown.flatMap((s) =>
    s.locations.map((l) => l.uid_location)
  );
  next.updated_at = now;

  return { ledger: next, costApplied, unitCost };
}

/**
 * `quantity_in_service` and `quantity_out_of_service` from placement kind.
 *
 * These moved in exact lockstep with `quantity_held` before the journal — so
 * `in_service` always equalled `held` — while `out_of_service` was written once
 * as zero at ledger creation and never moved again, meaning the ledger reported
 * every product as 100% in service. Under the line model they are derived:
 * units at a `locations` doc or a `booking` are in service, units at an
 * `out-of-service` record are not.
 *
 * `out_of_service_breakdown` needs the OOS record's `reason`, which this module
 * cannot read, so the caller supplies it — see `applyOutOfServiceReason`.
 */
export function deriveServiceQuantities(
  ledger: InventoryLedger,
  lines: readonly MovementLineType[],
): Pick<InventoryLedger, "quantity_in_service" | "quantity_out_of_service"> {
  let oosDelta = 0;
  for (const line of lines) {
    for (const side of ["from", "to"] as const) {
      const source = line.location[side];
      if (source === null || source.collection !== "out-of-service") continue;
      oosDelta += (side === "to" ? 1 : -1) * line.quantity;
    }
  }
  const outOfService = Math.max(0, ledger.quantity_out_of_service + oosDelta);
  return {
    quantity_out_of_service: outOfService,
    quantity_in_service: ledger.quantity_held - outOfService,
  };
}

/**
 * Apply an OOS record's reason to the per-reason breakdown. Split from
 * `deriveServiceQuantities` because the reason lives on the OOS document, which
 * only the caller can read.
 */
export function applyOutOfServiceReason(
  breakdown: InventoryLedger["out_of_service_breakdown"],
  reason: keyof InventoryLedger["out_of_service_breakdown"],
  delta: number,
): InventoryLedger["out_of_service_breakdown"] {
  return { ...breakdown, [reason]: Math.max(0, breakdown[reason] + delta) };
}
