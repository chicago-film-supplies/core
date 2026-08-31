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
  let costAppliedCents = 0;
  let unitCost = 0;
  if (carriesCost) {
    const basisCents = BigInt(next.total_cost_basis_cents);
    if (delta > 0) {
      const addCents = BigInt(movement.cost?.amount_cents ?? 0);
      costAppliedCents = Number(addCents);
      unitCost = perUnitCostAt4dp(addCents, BigInt(delta));
      next.total_cost_basis_cents = Number(basisCents + addCents);
    } else if (delta < 0) {
      const units = -delta;
      const outCents = costOfUnits(basisCents, next.quantity_held, units);
      costAppliedCents = -Number(outCents);
      unitCost = perUnitCostAt4dp(outCents, BigInt(units));
      next.total_cost_basis_cents = Number(basisCents - outCents);
    }
  }

  next.quantity_held += delta;

  if (next.quantity_held > 0) {
    next.average_unit_cost = perUnitCostAt4dp(
      BigInt(next.total_cost_basis_cents),
      BigInt(next.quantity_held),
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

  return { ledger: next, costAppliedCents, unitCost };
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
  | "capitalised_disposal";

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
  // Custody-only steps and `transfer` carry no cost object at all.
  if (!hasCosts(type)) return { kind: "skip", reason: "no_cost_contract" };
  if (type === "opening_balance") return { kind: "skip", reason: "opening_balance" };
  if (type === "sale") return { kind: "skip", reason: "sale_posts_on_accrec" };

  // A refunded return is settled against the customer, not a supplier. The zero
  // IS the decision — `MOVEMENT_CONTRACTS` makes `cost` required on
  // `sale_return` precisely so the amount can be zero and mean something.
  //
  // ⚠️ Read as a MAGNITUDE, because the question is what the FORWARD event was:
  // a reversal carries the negated cost, so a `> 0` test on the stored value
  // answers `false` for the reversal of a refunded return and would let it post
  // an ACCPAY bill where the event it undoes posted nothing at all.
  if (type === "sale_return" && Math.abs(costAmountCents ?? 0) > 0) {
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
  const natural = getTransactionMultiplier(type);
  if (natural === 0) return { kind: "terminal", reason: "no_ownership_direction" };

  // The DOCUMENT's direction. Equal to `natural` for an ordinary movement and
  // its negation for a reversal, which is the whole of the distinction.
  const direction = heldDelta === null
    ? natural
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
    ? (type === "purchase"
      // Only a real purchase moves a payable; every other increase nets to zero.
      ? XERO_OFFSET_ACCOUNTS.accounts_payable
      : XERO_OFFSET_ACCOUNTS.adjustment_clearing)
    : XERO_OFFSET_ACCOUNTS.inventory_shrink;
  const zero_total = !(natural === 1 && type === "purchase");

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
