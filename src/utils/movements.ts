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
  MovementServiceType,
  MovementTypeType,
  ProductTypeType,
  StoreBreakdownEntry,
  StoreBreakdownLocation,
} from "../schemas/mod.ts";
import { getTransactionMultiplier, hasCosts, MOVEMENT_CONTRACTS } from "../schemas/mod.ts";
import { perUnitCostAt4dp, roundDivHalfUp } from "./money.ts";

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

/**
 * The EXACT basis a reversal must relieve, or `null` when this is not a
 * cost-bearing reversal of an increase and the weighted-average share applies.
 *
 * ## 🔴 A reversal reverses EXACTLY — owner, 2026-09-19 (api-cloudrun#1069)
 *
 * *"a reversal should reverse exactly, yes i misentered the transaction info
 * twice."* Every other decrease relieves `costOfUnits(basis, held, units)`,
 * deliberately, because on a `sale` the caller's number is REVENUE. A reversal
 * is the one decrease whose entire job is to undo a specific prior movement, so
 * a weighted-average share makes the relief depend on every unrelated purchase
 * in between: reversing a $149.96 purchase relieved $74.98, and the product's
 * basis never returned to what it was before the mis-key.
 *
 * ## ⭐ The exact number is already on the reversal, and it needs no lookup
 *
 * `cost.amount_cents` on a STORED movement is what the applier actually took,
 * not what the operator typed — `appliedMovementCost`
 * (`api-cloudrun/src/lib/movementApplier.ts`) restamps it from the fold's own
 * `costAppliedCents` before the movement is written. And `reverseTransaction`
 * negates that stored amount onto the reversal. So the reversal already carries
 * −(what its original applied), and a pure fold can be exact without reading
 * the original at all.
 *
 * ⚠️ **That is a claim about the WRITER, and it is what makes this safe.** If a
 * future writer ever stores an operator-typed cost on a reversal instead, this
 * becomes exact about the wrong number, silently. `reverses` is the structured
 * field — not the `Reversal of #N` prose in `reference`, which 2 of the 6
 * cost-bearing prod reversals do not use (#1155 and #1157 say *"Reverses the
 * … verification find"*), and which an enumeration keyed on that prose missed.
 *
 * ## ⚠️ The MIRROR case was already correct, and must not be "fixed"
 *
 * Reversing a DECREASE is an increase, and the `delta > 0` branch has always
 * added `cost.amount_cents` directly. So prod movement #1159 (reversal of the
 * #1158 `adjustment_decrease`) restores exactly the $1.23 that #1158 relieved,
 * and its POSITIVE amount on a decrease-typed movement is `reverseTransaction`
 * negating a negative — **not** an operator compensating for this defect, which
 * is what api-cloudrun#1069 question 4 suspected.
 *
 * Returns a MAGNITUDE, matching `costOfUnits`: the caller carries the sign.
 */
function reversalReliefCents(
  movement: Pick<Movement, "type" | "cost" | "reverses">,
): bigint | null {
  if (!isReversing(movement) || movement.cost === null) return null;
  const stated = BigInt(movement.cost.amount_cents);
  // 🔴 A reversal of an INCREASE carries a negative amount, so the relief is
  // its negation. A POSITIVE amount here means the reversal disagrees with its
  // own direction — a stored-record defect, not a smaller relief — so fall back
  // to the weighted-average share rather than ADDING basis on a decrease.
  //
  // ⭐ **ZERO is exact, not a defect** (widened from `< 0` in stock campaign P1):
  // undoing a no-refund `sale_return`, or reversing a $0 increase, relieves
  // exactly the $0 its forward restored. The weighted-average share it fell
  // back to before would relieve basis the forward never added.
  return stated <= 0n ? -stated : null;
}

/**
 * Whether a movement walks back another: a `reverses` reversal (it keeps its
 * original's type and negates its lines), or a TYPED reversal — an undo type
 * whose contract is its forward's mirrored (`MOVEMENT_CONTRACTS[type].undoes`).
 *
 * The cost-bearing readers treat both alike (stock campaign decision 5): the
 * relief is exact ({@link reversalReliefCents}), and a Xero posting takes the
 * FORWARD's accounts ({@link xeroPostingFor}). On a custody-only undo — every
 * rental rewind — there is no cost, so nothing reads differently.
 */
export function isReversing(m: Pick<Movement, "type" | "reverses">): boolean {
  return m.reverses !== null || MOVEMENT_CONTRACTS[m.type].undoes !== null;
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
    // The units a line placed are the units its reversal takes back. Carried
    // only when the original states the key, so a reversal of a unit-less line
    // stays byte-identical to what this function has always produced.
    ...(l.units !== undefined ? { units: [...l.units] } : {}),
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
 *
 * ⚠️ **`"both"` for `transfer` means two independently chosen sides; for
 * `flag` it does not.** A flag is always in place (owner, 2026-09-27), so its
 * two ends are one location named twice — the contract says
 * `locations → locations` only because a line needs two ends. A surface that
 * names one side — the out-of-service create/update `allocations`, which are
 * the locations the units stand on by that input's own docstring — should take
 * its side from that input and not call this function at all.
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
  costAppliedCents: number;
  /**
   * The per-unit basis this movement consumed or added, **at 4dp DOLLARS**.
   *
   * Not cents, and not 2dp — this docstring said "at 2dp" for months while
   * `perUnitCostAt4dp` produced four, which is the kind of comment a reader
   * trusts and then quantizes a rate on. It is the same rate family as
   * `cost.unit_cost` and `average_unit_cost`, and forcing it to the cent is the
   * beta.117 regression: a 100-unit $6.39 purchase reporting $0.06/unit.
   */
  unitCost: number;
  /**
   * How far an EXACT reversal relief overshot the basis that was there to
   * relieve, in cents. `0` on every other movement, and on every reversal that
   * fits.
   *
   * 🔴 **It is REPORTED, never thrown and never clamped, and the split is the
   * point.** A clamp would fabricate a basis and make the reversal inexact,
   * which is the whole defect this branch removes. A throw would abort the
   * caller — and two of the three callers are corpus-wide REPLAY SCANS
   * (`api-cloudrun/scripts/audit-ledger-replay.ts`,
   * `api-cloudrun/scripts/audit-unjournaled-consumption.ts`), where a throw
   * mid-scan reports nothing and looks exactly like a clean corpus.
   *
   * So the WRITER gates on it and a SCAN counts it. Measured on prod
   * 2026-09-19: **0 of the 6 cost-bearing reversals underflow**, which is what
   * licenses refusing rather than guessing (api-cloudrun#1069 question 3).
   */
  basisUnderflowCents: number;
  /**
   * Units that moved out of service with no reason to file them under — see
   * {@link deriveServiceQuantities}. `0` on every movement that names one and
   * on every movement that moves no service units at all.
   *
   * ⚠️ Non-zero means `quantity_out_of_service` did NOT move, because the
   * breakdown it is derived from could not represent the change. The WRITER
   * must refuse; a replay SCAN counts it.
   */
  oosUnattributedDelta: number;
  /**
   * The stated acquisition cost, in cents, of a cost-bearing INCREASE folded
   * onto an **uncounted** ledger (`quantity_held: null`) — which has no count to
   * spread a basis over, so the fold adds none. `0` on every counted ledger and
   * on every decrease.
   *
   * Reported on the same WRITER-refuses / SCAN-counts split as
   * {@link basisUnderflowCents}: a purchase, find or make against an uncounted
   * product is money the valuation would silently lose, and only the writer
   * has an operator to tell. The way to bring an uncounted product into the
   * valuation is to COUNT it (the `none` → `bulk` flip seeds `quantity_held`),
   * not to buy into it.
   */
  uncountedCostCents: number;
  /**
   * The quantity of a movement written with `lines: []` (its contract's
   * `uncounted: "lineless"`) folded onto a **COUNTED** ledger. `0` on every
   * uncounted ledger, on every movement that carries lines, and on a type with
   * no places at all (`prep`, `unprep`).
   *
   * A lineless movement is an uncounted product's custody step: its units
   * moved and no shelf exists to say from where. On a counted ledger the same
   * document moves custody while the shelf keeps units that left it, which
   * breaks `quantity_held === Σ store_breakdown + units out`. The schema
   * cannot see the ledger, so the fold is the first place this is knowable.
   * WRITER refuses, SCAN counts — the split {@link basisUnderflowCents} uses.
   */
  linelessCountedQuantity: number;
  /**
   * The `quantity_held` a `count_close` discarded: what the ledger held the
   * instant it stopped counting. `0` on every other movement.
   *
   * Non-zero is normal when units are out on rentals or away at a record — a
   * close forgets the count, not the units, and a later `count_open` re-seeds
   * them from the bookings and records. Units still on a SHELF are the case the
   * writer refuses before it writes (the location documents would keep units
   * the ledger dropped), so a SCAN reading a shelved close here is reading a
   * write that bypassed that refusal. Reported, never thrown: the
   * WRITER-refuses / SCAN-counts split {@link basisUnderflowCents} uses.
   */
  countClosedHeld: number;
}

/**
 * The counted ledger a `count_open` folds onto when the ledger is UNCOUNTED:
 * zero held, no shelves, no basis, no out-of-service breakdown. An uncounted
 * ledger already carries all of those as zero or empty except the count, so
 * this changes only `quantity_held`/`quantity_in_service` in practice; zeroing
 * the rest is what keeps the open exact if an uncounted ledger ever carried
 * stale values.
 */
function openedCountBase(ledger: InventoryLedger): InventoryLedger {
  return {
    ...ledger,
    quantity_held: 0,
    quantity_in_service: 0,
    store_breakdown: [],
    query_by_uid_store: [],
    query_by_uid_location: [],
    average_unit_cost: 0,
    total_cost_basis_cents: 0,
    out_of_service_breakdown: { cleaning: 0, damaged: 0, maintenance: 0, lost: 0 },
    quantity_out_of_service: 0,
  };
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
 *
 * ## An uncounted ledger (`quantity_held: null`)
 *
 * Holds no count and no basis, so the fold moves **neither**: `quantity_held`
 * stays `null`, the basis and average stay 0, and a cost-bearing increase's
 * stated cost is reported as `uncountedCostCents` rather than applied.
 * `quantity_in_service` stays `null`. Service quantities move only with a
 * line, and an uncounted product's movements carry none (below), so its
 * out-of-service breakdown stays at zero: a lost or damaged uncounted unit is
 * stated by its out-of-service RECORD, not by the ledger.
 *
 * ⚠️ **Placement is folded exactly as on a counted ledger, on purpose.** An
 * uncounted ledger has no shelves (`InventoryLedgerSchema` refuses a non-empty
 * `store_breakdown` on one), so a writer that names a shelf endpoint for an
 * uncounted product fails validation LOUDLY here, rather than having its shelf
 * leg dropped silently while the location document it also writes takes it.
 * The writer's job is to emit no shelf leg for an uncounted product at all.
 *
 * So an uncounted product's movements carry **no lines** (its contract's
 * `uncounted: "lineless"`): the custody step is journalled and nothing is
 * folded but `updated_at`. The same lineless document on a COUNTED ledger is
 * reported as `linelessCountedQuantity`.
 */
export function applyMovementToLedger(
  ledger: InventoryLedger,
  // `custody` joined this Pick when `damaged` became a STATE: a damaged unit
  // stays on its shelf, so the fold can no longer read out-of-service off the
  // line endpoints alone. See `deriveServiceQuantities`.
  // `reverses` joined this Pick for api-cloudrun#1069: a reversal relieves the
  // EXACT amount its original applied, and nothing else on the movement can say
  // that this IS a reversal. See the cost branch below.
  movement: Pick<Movement, "type" | "quantity" | "lines" | "cost" | "custody" | "reverses" | "service">,
  placements: ReadonlyMap<string, LocationPlacement>,
  now: InventoryLedger["updated_at"],
  /**
   * The out-of-service bucket this movement's units belong to, when it moves
   * any. `null` for every movement that does not touch service state.
   *
   * 🔴 The caller supplies the REASON and nothing else — see
   * {@link deriveServiceQuantities}. It used to supply a quantity as well and
   * maintain `out_of_service_breakdown` itself, which made the breakdown and
   * `quantity_out_of_service` two independent accounts of one fact.
   */
  oosReason: keyof InventoryLedger["out_of_service_breakdown"] | null = null,
): LedgerFoldResult {
  // ── The count boundaries ──
  // A close is ABSOLUTE: line arithmetic cannot take a count to null, so it
  // returns the uncounted shape directly. An open onto an uncounted ledger
  // starts from zero and then folds its lines like any increase.
  if (movement.type === "count_close") {
    return {
      ledger: {
        ...ledger,
        quantity_held: null,
        quantity_in_service: null,
        store_breakdown: [],
        query_by_uid_store: [],
        query_by_uid_location: [],
        average_unit_cost: 0,
        total_cost_basis_cents: 0,
        out_of_service_breakdown: { cleaning: 0, damaged: 0, maintenance: 0, lost: 0 },
        quantity_out_of_service: 0,
        updated_at: now,
      },
      costAppliedCents: 0,
      unitCost: 0,
      basisUnderflowCents: 0,
      oosUnattributedDelta: 0,
      uncountedCostCents: 0,
      linelessCountedQuantity: 0,
      countClosedHeld: ledger.quantity_held ?? 0,
    };
  }
  const source = movement.type === "count_open" && ledger.quantity_held === null
    ? openedCountBase(ledger)
    : ledger;
  const next: InventoryLedger = {
    ...source,
    out_of_service_breakdown: { ...source.out_of_service_breakdown },
    store_breakdown: cloneStoreBreakdown(source.store_breakdown),
  };

  const delta = movementHeldDelta(movement.lines);
  const carriesCost = MOVEMENT_CONTRACTS[movement.type].cost === "required";

  // ── Cost basis, before the quantity moves ──
  //
  // The basis is MONEY and stays at the cent. `unitCost` is a RATE and does not:
  // see `perUnitCostAt4dp`. Both are derived from the same integer cents, so the
  // pair cannot disagree about how much moved — only about how finely the
  // per-unit figure is reported.
  let costAppliedCents = 0;
  let unitCost = 0;
  let basisUnderflowCents = 0;
  let uncountedCostCents = 0;
  const heldBefore = next.quantity_held;
  if (carriesCost && heldBefore === null) {
    if (delta > 0) uncountedCostCents = movement.cost?.amount_cents ?? 0;
  } else if (carriesCost && heldBefore !== null) {
    const basisCents = BigInt(next.total_cost_basis_cents);
    if (delta > 0) {
      const addCents = BigInt(movement.cost?.amount_cents ?? 0);
      costAppliedCents = Number(addCents);
      unitCost = perUnitCostAt4dp(addCents, BigInt(delta));
      next.total_cost_basis_cents = Number(basisCents + addCents);
    } else if (delta < 0) {
      const units = -delta;
      const outCents = reversalReliefCents(movement) ??
        costOfUnits(basisCents, heldBefore, units);
      // 🔴 A reversal may relieve more basis than is there, and the shortfall
      // is REPORTED rather than clamped — see `basisUnderflowCents`. The
      // weighted-average branch cannot underflow: `costOfUnits` caps at the
      // basis by construction, so this is only ever a reversal's number.
      if (outCents > basisCents) basisUnderflowCents = Number(outCents - basisCents);
      costAppliedCents = -Number(outCents);
      unitCost = perUnitCostAt4dp(outCents, BigInt(units));
      next.total_cost_basis_cents = Number(basisCents - outCents);
    }
  }

  // Uncounted (`heldBefore === null`): no count to move and no basis to
  // average, so `quantity_held` stays null — see the docblock.
  if (heldBefore !== null) {
    const heldAfter = heldBefore + delta;
    next.quantity_held = heldAfter;
    if (heldAfter > 0) {
      next.average_unit_cost = perUnitCostAt4dp(
        BigInt(next.total_cost_basis_cents),
        BigInt(heldAfter),
      );
    } else if (carriesCost) {
      // No units held after a cost-bearing move (a sale of the last unit) means no
      // carrying cost. Zero both, so a residual basis cannot corrupt the average of
      // the next purchase — held→0 then buy 1 must not inherit.
      next.average_unit_cost = 0;
      next.total_cost_basis_cents = 0;
    }
    // else: a placement-only movement drove held transiently to 0 (#286 defect 2).
    // Leave basis and average untouched; zeroing here PERMANENTLY destroyed the
    // basis, which is the prod corruption that fix addressed.
  }

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
      // The shelf's own out-of-service count moves with a flag on this
      // endpoint — see `endpointServiceReason`. Written only when touched, so
      // `undefined` keeps meaning "never written" (`StoreBreakdownLocationSchema`).
      if (endpointServiceReason(movement, side, "locations", null) !== null) {
        location.quantity_out_of_service = (location.quantity_out_of_service ?? 0) +
          line.quantity * sign;
      }
    }
  }

  // ── The three fields that used to be vestigial ──
  const service = deriveServiceQuantities(next, movement, oosReason);
  next.out_of_service_breakdown = service.out_of_service_breakdown;
  next.quantity_out_of_service = service.quantity_out_of_service;
  next.quantity_in_service = service.quantity_in_service;

  next.query_by_uid_store = next.store_breakdown.map((s) => s.uid_store);
  next.query_by_uid_location = next.store_breakdown.flatMap((s) =>
    s.locations.map((l) => l.uid_location)
  );
  next.updated_at = now;

  return {
    ledger: next,
    costAppliedCents,
    unitCost,
    basisUnderflowCents,
    oosUnattributedDelta: service.oosUnattributedDelta,
    uncountedCostCents,
    linelessCountedQuantity: movement.lines.length === 0 && heldBefore !== null &&
        MOVEMENT_CONTRACTS[movement.type].places !== null
      ? movement.quantity
      : 0,
    countClosedHeld: 0,
  };
}

/**
 * Whether a REPLAY of one product's journal starts from an UNCOUNTED ledger
 * (`true`) or a counted one at zero (`false`), read off the journal itself.
 *
 * The first count boundary decides it: a `count_open` first means the ledger
 * was uncounted until then, a `count_close` first means it was counted. With no
 * boundary at all the ledger never changed its counted-ness, so it starts as it
 * stands — `storedUncounted`, the stored ledger's `quantity_held === null`.
 * That last arm reads the stored ledger, which is sound only because nothing in
 * the journal ever flipped it.
 *
 * ⭐ This is what replaced the ledger's `counted_from` marker: the boundary is a
 * movement, so a replay needs no seed stamped beside the journal, and a product
 * born counted needs nothing written at all.
 *
 * ⚠️ **Pass the journal in the order the replay folds it** (`replayOrder`,
 * `utils/journal.ts`): "first" here is first in the array as given.
 */
export function replayStartsUncounted(
  journal: ReadonlyArray<Pick<Movement, "type">>,
  storedUncounted: boolean,
): boolean {
  const first = journal.find((m) => m.type === "count_open" || m.type === "count_close");
  if (!first) return storedUncounted;
  return first.type === "count_open";
}

/**
 * The out-of-service reason a line endpoint's units carry on one side of a
 * movement, or `null` for "in service there".
 *
 * ⭐ **With a `service` axis the axis answers, whatever the place.** At an
 * out-of-service record it is the bucket the units are counted under while
 * they stand there; at a shelf it is the flag they carry on it; at a booking or
 * outside ownership `checkMovementContract` rule 4 has already refused
 * anything but `null`.
 *
 * **Without one — every movement written before the axis — the two legacy
 * carriers answer, one per place kind:**
 * - at a record: `fallback`, the RECORD's reason, which only the caller can
 *   read (a `mark_lost`'s `lost`, a record-driven write-off's `oos.reason`);
 * - at a shelf: a custody key of `damaged`, `cleaning` or `maintenance` — a
 *   `mark_damaged` (or, since P2b, `mark_cleaning` / `mark_maintenance`) lands
 *   its unit on a shelf, flagged, and its undo takes the flag back off. Those
 *   types forbid `service`, so the custody key is their ONLY carrier.
 *
 * 🔴 **The legacy carriers are disjoint by place kind, and that is what keeps
 * the 8 pre-model `mark_damaged` rows counted ONCE.** Those rows are
 * `bookings → out-of-service` with `custody.to === "damaged"` (measured
 * 2026-09-19, 4 prod + 4 dev). They name no shelf, so the custody carrier never
 * fires for them and the record carrier counts them, exactly as it did when
 * they were written. The old two-term fold needed an explicit guard for this;
 * keying on the endpoint's place kind makes it structural.
 */
export function endpointServiceReason(
  movement: Pick<Movement, "custody" | "service">,
  side: "from" | "to",
  kind: "locations" | "out-of-service",
  fallback: keyof InventoryLedger["out_of_service_breakdown"] | null,
): keyof InventoryLedger["out_of_service_breakdown"] | null {
  const service: MovementServiceType | null = movement.service ?? null;
  if (service !== null) return service[side];
  if (kind === "out-of-service") return fallback;
  const key = movement.custody?.[side];
  return key === "damaged" || key === "cleaning" || key === "maintenance" ? key : null;
}

/**
 * `quantity_in_service`, `quantity_out_of_service` and the per-reason
 * breakdown, after one movement.
 *
 * These moved in exact lockstep with `quantity_held` before the journal — so
 * `in_service` always equalled `held` — while `out_of_service` was written once
 * as zero at ledger creation and never moved again. Under the line model they
 * are derived, one line ENDPOINT at a time:
 *
 * - an endpoint at an `out-of-service` record moves the bucket of the reason
 *   its units are counted under there — `lost`, or a unit at a vendor (a
 *   PLACE);
 * - an endpoint at a shelf moves the bucket of the flag its units carry there
 *   — `damaged`, `cleaning`, `maintenance` in the building (a STATE);
 * - `+q` on a `to` side, `−q` on a `from` side.
 *
 * So one rule covers every shape: a flag `{null→r}` is `+q r`; a reclassify
 * `{r→r′}` is `−q r, +q r′`; a clear `{r→null}` is `−q r`; a `send_away` of a
 * flagged unit `{r→r}` is `−q r` at the shelf and `+q r` at the record, net 0;
 * a `mark_lost` is `+q lost` at the record. Which reason each endpoint carries
 * is {@link endpointServiceReason}'s answer.
 *
 * 🔴 **Out-of-service was a PLACE for `lost` and a STATE for `damaged` before
 * this axis existed, and this is still true.** A damaged unit stays on its
 * shelf (`CUSTODY_PLACE_KINDS`), so reading placement alone would report a
 * shelf full of broken units as fully in service. The endpoint rule counts it
 * at the shelf; an off-shelf unit is counted at the record; no endpoint is
 * both.
 *
 * @param movement Its `lines`, `custody` and `service`. `custody` and
 *   `service` are required keys of the argument (though `service` may be
 *   absent on a stored document): a forgotten custody drops the legacy
 *   in-place carrier silently, which reads as "no damage recorded" rather than
 *   as an error.
 */
export function deriveServiceQuantities(
  ledger: InventoryLedger,
  movement: Pick<Movement, "lines" | "custody" | "service">,
  /**
   * The RECORD's reason, for an endpoint at an out-of-service record on a
   * movement with no `service` axis. The reason lives on the out-of-service
   * DOCUMENT, so only the caller can read it. Ignored when the axis is present.
   *
   * 🔴 **It is the ONLY thing the caller supplies, and that is the fix.** The
   * caller used to pass a QUANTITY too and apply it to the breakdown itself,
   * AFTER this function had separately moved the scalar. Two independent
   * maintainers of one fact, and only the breakdown self-corrected
   * (`applyOutOfServiceReason` clamps at 0). The scalar ratcheted.
   */
  reason: keyof InventoryLedger["out_of_service_breakdown"] | null,
): Pick<
  InventoryLedger,
  "quantity_in_service" | "quantity_out_of_service" | "out_of_service_breakdown"
> & {
  /**
   * 🔴 Units that moved at an out-of-service record with NO reason to file
   * them under — a legacy movement whose caller passed no `reason`.
   *
   * Non-zero means the breakdown cannot represent the move, so the scalar
   * derived from it would silently under-count. **Reported, never thrown** —
   * callers include corpus-wide replay scans, where a throw mid-run reports
   * nothing and looks exactly like a clean corpus. The WRITER refuses; a SCAN
   * counts. Same split as `basisUnderflowCents`.
   */
  oosUnattributedDelta: number;
} {
  let breakdown = ledger.out_of_service_breakdown;
  let unattributed = 0;

  for (const line of movement.lines) {
    for (const side of ["from", "to"] as const) {
      const source = line.location[side];
      if (source === null) continue;
      const kind = source.collection;
      if (kind !== "locations" && kind !== "out-of-service") continue;
      const delta = (side === "to" ? 1 : -1) * line.quantity;
      const endpointReason = endpointServiceReason(movement, side, kind, reason);
      if (endpointReason !== null) {
        breakdown = applyOutOfServiceReason(breakdown, endpointReason, delta);
      } else if (kind === "out-of-service") {
        unattributed += delta;
      }
    }
  }

  // 🔴 **ONE SOURCE OF TRUTH: the breakdown.** The scalar is its SUM, derived
  // here and nowhere else, so the two cannot disagree by construction.
  // Measured 2026-09-19: 285 of 285 prod ledgers already satisfied
  // `scalar == sum(breakdown)` when this became the rule.
  const outOfService = Object.values(breakdown).reduce((sum, n) => sum + n, 0);
  return {
    out_of_service_breakdown: breakdown,
    quantity_out_of_service: outOfService,
    // `null` held (an uncounted ledger) has no in-service count either.
    quantity_in_service: ledger.quantity_held === null ? null : ledger.quantity_held - outOfService,
    oosUnattributedDelta: unattributed,
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

// ── Xero posting ────────────────────────────────────────────────────

/**
 * The inventory asset accounts a movement's value can land on.
 *
 * Two, not four. The owner has decided to **capitalise everything** from next
 * year, so the account choice collapses to the product type and the writer
 * needs no capitalisation threshold at all. The `$1,000` line-total rule
 * measured against the live corpus (97.7% agreement, against 78.7% for the
 * per-unit phrasing) survives only as a *historical classifier* — it answers
 * "how was this existing stock booked", which the history import must know
 * because it decides whether a disposal posts to Xero at all. It is
 * deliberately not encoded here.
 */
export const XERO_ASSET_ACCOUNTS = {
  /** Retail Inventory — consumables, `product.type === "sale"`. */
  retail: 1400,
  /** Fixed Asset Clearing — the fleet, `product.type === "rental"`. */
  fixed_asset_clearing: 1999,
} as const;

/** The counter-account a movement's value is offset against. */
export const XERO_OFFSET_ACCOUNTS = {
  /** Accounts Payable — a real supplier bill, and the only non-zero total. */
  accounts_payable: 2000,
  /** Inventory Adjustment Clearing — the $0 adjustment bills. */
  adjustment_clearing: 2510,
  /** COGS: Inventory Shrink — an expensed decrease. */
  inventory_shrink: 5700,
} as const;

/** A movement that posts: exactly two lines, and what they are. */
export interface XeroBillPosting {
  kind: "bill";
  /** Where the inventory value sits. */
  asset_account: typeof XERO_ASSET_ACCOUNTS[keyof typeof XERO_ASSET_ACCOUNTS];
  /** The counter-account the offset line carries. */
  offset_account: typeof XERO_OFFSET_ACCOUNTS[keyof typeof XERO_OFFSET_ACCOUNTS];
  /**
   * `1` the asset account is debited (stock in), `-1` it is credited (stock
   * out). Carried explicitly so the consumer never re-derives it, and so the
   * recast source is complete.
   *
   * 🔴 **This is the DOCUMENT's direction, not the type's, and the two differ on
   * a reversal.** It used to be documented as *"always equals
   * `getTransactionMultiplier(type)`"*, and that was the defect: a reversal
   * keeps its original's type, so a reversed `find` claimed `+1` and posted a
   * second increase. Measured live 2026-08-30 — prod Xero went
   * `QuantityOnHand` 43 → 44 → 45 while the CFS ledger went 38 → 39 → 38
   * (api-cloudrun#743).
   *
   * ⚠️ **The ACCOUNTS still come from the type** — see `xeroPostingFor`. Only
   * this field follows the document.
   */
  direction: 1 | -1;
  /**
   * Whether the two lines must cancel to exactly `0.00`.
   *
   * True for every posting except a real `purchase`. A bill that should total
   * zero and does not is the defect that put $106 of phantom AP on the live
   * ledger — assert it at the byte level, because there is no dev Xero tenant.
   *
   * ⭐ **It is also the "is the offset an explicit LINE?" discriminator**, which
   * is what the bill builder actually needs. Accounts Payable is *implicit* in
   * an ACCPAY bill — Xero credits it with the document total, and emitting a
   * `2000` line would double it. `2510` and `5700` are real lines. Since AP is
   * the only non-zero-total offset, `zero_total` answers both questions at once:
   * emit the offset line when it is `true`, and only then.
   */
  zero_total: boolean;
}

/** Why a movement deliberately posts nothing. */
export type XeroPostingSkipReason =
  /** Custody-only or a `transfer` — no cost object, so nothing to post. */
  | "no_cost_contract"
  /** `opening_balance` — $0-cost CRMS seeding the history import replaces outright. */
  | "opening_balance"
  /** A `sale`'s cost side is COGS on the ACCREC invoice; a bill would double-count it. */
  | "sale_posts_on_accrec"
  /** A refunded return is customer money — an ACCREC credit note, not a supplier bill. */
  | "refunded_return_posts_on_accrec";

/** Why a movement needs a person in the Xero UI. */
export type XeroPostingManualReason =
  /**
   * A capitalised unit left the fleet.
   *
   * The expensed entry (DR 5700 / CR asset) is *incomplete* for a capitalised
   * unit: it never clears that unit's accumulated depreciation, and CFS has no
   * depreciation model to compute it. The misstatement is silent — net PP&E
   * understated, loss overstated, equity understated permanently, and the
   * balance sheet still balances. Xero additionally cannot do a partial
   * disposal by quantity at all. So CFS refuses rather than posting a journal
   * it cannot complete.
   */
  | "capitalised_disposal"
  /**
   * A twin reclass — units moved between a retail product and its rental twin.
   *
   * 🔴 **It is not a spend and must never post a bill.** Nothing entered or left
   * CFS; one inventory account has to be credited and another debited, which is
   * a Xero MANUAL JOURNAL and not an ACCPAY document. Routing it down the bill
   * path would post a shrink expense on one side and an adjustment clearing
   * entry on the other, recording a loss and a gain for an event that is
   * neither.
   *
   * ⚠️ Both sides of the pair report, and that is deliberate: each is a
   * different account movement, and an operator reading one intervention with
   * no counterpart would not know which direction was left unposted.
   */
  | "reclass_between_products";

/** Why a movement *should* post but cannot — permanent, and detected before any Xero call. */
export type XeroPostingTerminalReason =
  /** A cost-bearing movement on a product type that bears no stock. */
  | "product_type_not_stock_bearing"
  /** A cost-bearing movement that neither enters nor leaves ownership. */
  | "no_ownership_direction";

/** What the Xero seam should do with one movement. */
export type XeroPostingDecision =
  | XeroBillPosting
  | { kind: "skip"; reason: XeroPostingSkipReason }
  | { kind: "manual"; reason: XeroPostingManualReason }
  | { kind: "terminal"; reason: XeroPostingTerminalReason };

/**
 * The posting table: what one movement does to the Xero ledger.
 *
 * Pure and total — every `(MovementTypeType, ProductTypeType)` pair resolves,
 * and it makes no Xero call, so the whole table is assertable at the byte level
 * without a tenant. **This is the recast source v2 reads** (`erp-spec`
 * ADR-0020), which is why it returns a spec rather than emitting lines.
 *
 * **Derived from the contract, never hand-listed.** The direction comes from
 * `getTransactionMultiplier` and the cost-bearingness from `hasCosts`, both of
 * which read `MOVEMENT_CONTRACTS` — so a new movement type is classified by the
 * contract it declares rather than by remembering to extend a list here. The two
 * carve-outs (`opening_balance`, `sale`) are explicit *because* they are
 * exceptions to that derivation, not because the table is enumerated.
 *
 * ⚠️ **`trade_in` is a DECREASE**, on its contract (`from: locations`,
 * `to: outside`), and therefore takes the disposal row — including the
 * capitalised-disposal refusal. A planning-era census grouped it with the
 * increase types; the contract is the authority and disagrees.
 *
 * @param type The movement type.
 * @param productType `product.type` of the movement's subject.
 * ## 🔴 The ACCOUNTS come from the type; the DIRECTION comes from the document
 *
 * These were one thing until api-cloudrun#743, and conflating them is what put
 * two phantom units on the live tenant. A **reversal keeps its original's
 * type** — `reverseTransaction` negates the lines and the cost, and `reverses`
 * is what names the relationship — so `getTransactionMultiplier(type)` answers
 * `+1` for a reversed `find` exactly as it does for the `find` it undoes.
 *
 * The fix is not a `isReversal` flag. `applyMovementToLedger` has always had
 * this right and never consulted the multiplier at all: it folds
 * `movementHeldDelta(movement.lines)`, and `negateLines`'s own docblock says
 * why — *"because a line carries both sides, negating it needs no knowledge of
 * the movement type."* So the direction is read from the same place the ledger
 * reads it, and the bill cannot disagree with the ledger it mirrors.
 *
 * The accounts stay keyed on the type, because a reversal must post the
 * ORIGINAL's accounts negated. Reversing a `find` is `DR 2510 / CR 1400` — a
 * correction books no expense, and must not strand the original's 2510 credit;
 * routing it to the decrease row's `5700 COGS: Inventory Shrink` would do both.
 *
 * @param type The movement type.
 * @param productType `product.type` of the movement's subject.
 * @param costAmountCents `movement.cost.amount_cents`, or `null` when absent.
 *   Read **only** to tell a no-refund return from a refunded one — the zero is
 *   the decision. It is deliberately not consulted for the account choice.
 * @param heldDelta `movementHeldDelta(movement.lines)` — what this DOCUMENT
 *   does to `quantity_held`. Only its sign is read.
 *
 *   ⚠️ **`null` means "no document"** — enumerate the table by the type's own
 *   direction. It is for asking *"does this (type, productType) pair ever
 *   bill?"*, never for classifying a stored movement. It is deliberately NOT
 *   optional-with-a-default: a forgotten argument defaulting to the forward
 *   direction is precisely the silent wrong answer this parameter exists to
 *   remove, so every call site is made to state which question it is asking.
 */
export function xeroPostingFor(
  type: MovementTypeType,
  productType: ProductTypeType,
  costAmountCents: number | null,
  heldDelta: number | null,
): XeroPostingDecision {
  // A TYPED reversal (`sale_undo`, `sale_return_undo`) posts as its forward
  // would, negated by the document's own direction — exactly as a `reverses`
  // reversal, which keeps its original's type. So every account and refusal
  // below reads `forward`; only the document direction reads `type`. For every
  // forward type `forward === type`, which `tests/movement-contract-pins.test.ts`
  // pins byte for byte. No new posting row exists for a sale's rewinds.
  const forward = MOVEMENT_CONTRACTS[type].undoes ?? type;
  // Custody-only steps and `transfer` carry no cost object at all.
  if (!hasCosts(forward)) return { kind: "skip", reason: "no_cost_contract" };
  if (forward === "opening_balance") return { kind: "skip", reason: "opening_balance" };
  if (forward === "sale") return { kind: "skip", reason: "sale_posts_on_accrec" };
  // 🔴 Before any account derivation: a reclass has no ACCPAY document of any
  // kind, whichever direction it runs and whatever the product type. Placing
  // this after the `asset_account` switch would make a reclass on a
  // non-stock-bearing product terminal instead of manual, i.e. a 500 on a
  // movement that is simply not Xero's business.
  if (forward === "reclass_out" || forward === "reclass_in") {
    return { kind: "manual", reason: "reclass_between_products" };
  }

  // A refunded return is settled against the customer, not a supplier. The zero
  // IS the decision — `MOVEMENT_CONTRACTS` makes `cost` required on
  // `sale_return` precisely so the amount can be zero and mean something.
  //
  // ⚠️ Read as a MAGNITUDE, because the question is what the FORWARD event was:
  // a reversal carries the negated cost, so a `> 0` test on the stored value
  // answers `false` for the reversal of a refunded return and would let it post
  // an ACCPAY bill where the event it undoes posted nothing at all.
  if (forward === "sale_return" && Math.abs(costAmountCents ?? 0) > 0) {
    return { kind: "skip", reason: "refunded_return_posts_on_accrec" };
  }

  const asset_account = productType === "sale"
    ? XERO_ASSET_ACCOUNTS.retail
    : productType === "rental"
    ? XERO_ASSET_ACCOUNTS.fixed_asset_clearing
    : null;
  if (asset_account === null) {
    return { kind: "terminal", reason: "product_type_not_stock_bearing" };
  }

  // The TYPE's own direction. It picks the ACCOUNTS — what kind of event this
  // is — and nothing else.
  const natural = getTransactionMultiplier(forward);
  if (natural === 0) return { kind: "terminal", reason: "no_ownership_direction" };

  // The DOCUMENT's direction. Equal to `natural` for an ordinary movement and
  // its negation for a reversal, which is the whole of the distinction.
  const direction = heldDelta === null
    ? getTransactionMultiplier(type)
    : heldDelta > 0
    ? 1
    : heldDelta < 0
    ? -1
    : 0;
  // A cost-bearing movement whose lines net to zero moves no owned quantity, so
  // there is nothing for the asset line to carry. Reached only from a stored
  // document — `natural !== 0` already ruled the type out above — so it is a
  // malformed document rather than a table row, and it must not post.
  if (direction === 0) return { kind: "terminal", reason: "no_ownership_direction" };

  // ── Accounts, from `natural` ──────────────────────────────────────────
  const offset_account = natural === 1
    ? (forward === "purchase"
      // Only a real purchase moves a payable; every other increase nets to zero.
      ? XERO_OFFSET_ACCOUNTS.accounts_payable
      : XERO_OFFSET_ACCOUNTS.adjustment_clearing)
    : XERO_OFFSET_ACCOUNTS.inventory_shrink;
  const zero_total = !(natural === 1 && forward === "purchase");

  // ── The refusals ──────────────────────────────────────────────────────
  //
  // 🔴 **A reversal posts if and only if its FORWARD event posted.** That is the
  // rule these two guards implement, and getting it wrong is not symmetrical:
  // posting the reversal of something CFS never posted puts a ONE-SIDED entry in
  // the tenant with no counterpart to net against.
  //
  // So each guard asks about BOTH directions, and for different reasons:
  //
  //  - `natural === -1` — the TYPE is a disposal, so the forward event was
  //    already refused. Its reversal must be refused too, and it runs `+1`, so a
  //    guard keyed only on the document's direction misses it. This is the arm a
  //    reversed rental `write_off` takes; without it the function returns a bill
  //    `DR 1999 / CR 5700` undoing a disposal that was never posted.
  //  - `direction === -1` — THIS document removes a capitalised unit, whether it
  //    is a rental `write_off` or the reversal of a rental `find`. The two read
  //    identically to Xero and neither can clear accumulated depreciation.
  if (
    asset_account === XERO_ASSET_ACCOUNTS.fixed_asset_clearing &&
    (natural === -1 || direction === -1)
  ) {
    return { kind: "manual", reason: "capitalised_disposal" };
  }
  // ⭐ **A reversed purchase POSTS, and it needs no arm of its own.** Undoing a
  // purchase moves real Accounts Payable, and the Xero instrument for that is an
  // ACCPAYCREDIT supplier credit note — which api-cloudrun#746 built. So the two
  // facts this row needs are already the two fields below: `direction === -1`
  // selects `ACCPAYCREDIT` at the builder's one branch, and `zero_total === false`
  // suppresses the offset line, leaving ONE line whose total IS the payable being
  // credited back. The contact is the ORIGINAL's supplier, carried onto the
  // reversal at the writer (`api-cloudrun/src/services/transactions.ts`), so the
  // credit lands on the vendor that was billed.
  //
  // ⚠️ **This used to return `{ kind: "manual", reason:
  // "reversed_purchase_needs_credit_note" }`**, and that member is now RETIRED
  // from `XeroPostingManualReason` — a narrowing, so every consumer `switch`
  // became a compile error rather than a silently dead arm. The refusal's stated
  // reason (*"an instrument this codebase does not build"*) had been false since
  // #746; api-cloudrun#755 is where it was measured and retired.
  //
  // 🔴 **What this does NOT do is ALLOCATE the credit against the original
  // bill.** The note is raised against the supplier and sits as an unallocated
  // credit until someone applies it — which is correct and conservative: Xero
  // cannot allocate to a document CFS may not have posted (the guard above
  // refuses a reversal whose original is VOIDED), and auto-allocation is an
  // accounting call about a PAID bill rather than a coding one. That call is the
  // remaining half of api-cloudrun#755.
  return { kind: "bill", asset_account, offset_account, direction, zero_total };
}

// ── Consuming forwards newest first ─────────────────────────────────

/** One forward event an undo can consume part of: a movement, or a loss record. */
export interface ConsumableForward<O = string> {
  /** The forward's id (a movement id, or a record uid). */
  id: string;
  /** Units it moved. A positive whole number. */
  quantity: number;
  /** The basis it moved, in cents, as a MAGNITUDE (`0` for a custody-only event or a no-refund return). */
  amount_cents: number;
  /** The caller's tag carried through to each share — the origin a mark took units from, say. */
  origin: O;
}

/** An undo already recorded against a forward: how many of its units are spoken for. */
export interface PriorUndo {
  /** The forward it consumed ({@link ConsumableForward.id}). */
  original: string;
  quantity: number;
}

/** One forward's share of an undo. */
export interface ForwardConsumption<O = string> {
  original: string;
  quantity: number;
  /** This share's basis, in cents: the forward's amount pro rata, rounded so every share of one forward sums to exactly its amount. */
  amount_cents: number;
  origin: O;
}

/**
 * Which forwards an undo of `quantity` units takes back, NEWEST FIRST — the one
 * allocator behind the loss-undo records (api-cloudrun#1218), the `sale_undo`
 * basis and the refunded-return basis (stock campaign decision 6).
 *
 * `forwards` are in journal order, oldest first (`journalOrder`); `priorUndos`
 * are what earlier undos already took from each. The newest forward with units
 * left goes first, and partial consumption is allowed: a share of `k` of a
 * forward's `q` units, `c` of which were already taken, carries
 *
 *     round(A·(c + k) / q) − round(A·c / q)   (half up, integer cents)
 *
 * so however a forward is consumed — in one undo or across many — its shares sum
 * to EXACTLY its amount, and the last unit carries the remainder. That is the
 * "an undo relieves exactly what its forward restored" rule at unit grain.
 *
 * @throws RangeError when `quantity` exceeds what the forwards have left, or an
 *   input is not a whole non-negative number — refuse, never clamp: the caller
 *   maps it to a 400 naming the shortfall.
 */
export function consumeNewestFirst<O>(
  forwards: readonly ConsumableForward<O>[],
  priorUndos: readonly PriorUndo[],
  quantity: number,
): ForwardConsumption<O>[] {
  if (!Number.isSafeInteger(quantity) || quantity < 0) {
    throw new RangeError(`consumeNewestFirst needs a whole non-negative quantity, got ${quantity}`);
  }
  const taken = new Map<string, number>();
  for (const u of priorUndos) taken.set(u.original, (taken.get(u.original) ?? 0) + u.quantity);
  const shares: ForwardConsumption<O>[] = [];
  let left = quantity;
  for (let i = forwards.length - 1; i >= 0 && left > 0; i--) {
    const f = forwards[i];
    if (!Number.isSafeInteger(f.quantity) || f.quantity <= 0 || !Number.isSafeInteger(f.amount_cents) || f.amount_cents < 0) {
      throw new RangeError(`forward ${f.id}: quantity and amount_cents must be whole, quantity positive, amount non-negative`);
    }
    const before = Math.min(taken.get(f.id) ?? 0, f.quantity);
    const k = Math.min(f.quantity - before, left);
    if (k <= 0) continue;
    const A = BigInt(f.amount_cents);
    const q = BigInt(f.quantity);
    const upTo = (n: number) => roundDivHalfUp(A * BigInt(n), q);
    shares.push({ original: f.id, quantity: k, amount_cents: Number(upTo(before + k) - upTo(before)), origin: f.origin });
    left -= k;
  }
  if (left > 0) {
    throw new RangeError(
      `consumeNewestFirst: an undo of ${quantity} unit(s) finds only ${quantity - left} left on its forwards`,
    );
  }
  return shares;
}
