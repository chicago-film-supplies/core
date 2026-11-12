/**
 * Purchase → bill: the projector, the "already billed" readers and the
 * purchase → bill three-way sync (purchases-as-documents D5, D7; api-cloudrun
 * `one-document-model` Phases 2–3).
 *
 * The supplier side's twin of the order → invoice machinery, built from the
 * same parts:
 *
 * | customer side | here |
 * |---|---|
 * | `projectOrderItemToInvoiceItem` | {@link projectPurchaseLineToBillLine} |
 * | `syncOrderToInvoiceSelective` | {@link syncPurchaseToBills} |
 * | `priceDocument` | `priceDocument` itself — its payable arm (`./price-document.ts`) |
 *
 * ## Rows join by path, as an invoice's do
 *
 * A bill or credit line sits at `[purchase uid, ...its purchase line's path]`
 * under its purchase's `purchase` divider and takes the purchase line's uid,
 * exactly as an invoice line sits under its order divider at its order line's
 * path (one-document-model Phase 3). `path_purchase_item` survives only as a
 * MOVE pointer. Every "which purchase line does this bill" question goes
 * through `purchaseLineKeyOf` (`schemas/purchase-bill.ts`).
 *
 * ## One pricer
 *
 * A payable line's money is written by `priceDocument`'s stated-total arm
 * (`priceStatedTotalLine`): the line states its net in `amount_cents`, and its
 * k-th bill is defaulted by `cumulativeShareCents` (via {@link flatShareCents}),
 * exactly as its receipts are, so the bills of a fully billed line sum to the
 * line's `amount_cents`.
 *
 * ⚠️ **There are no unit charge windows.** A time line meters its PAIR's
 * `charge_windows`, as an order line does; the per-unit window machinery that
 * lived here (`unitWindowsForLine`, `coversForUnit`, `billedUnitCoverage`,
 * `seedPurchaseLinesForWindows`) retired in one-document-model Phase 3, unused
 * in either environment (Phase 0b census).
 *
 * @module
 */
import {
  type DiscountType,
  type Purchase,
  type PurchaseBill,
  PurchaseBillSchema,
  type PurchaseCredit,
  type PurchaseDestination,
  type PurchaseDocDestination,
  type PurchaseDocumentItem,
  type PurchaseDocumentLinePrice,
  type PurchaseDocumentProductItem,
  type PurchaseDocumentRow,
  type PurchaseItem,
  purchaseItemBasis,
  purchaseLines,
  purchaseLineKeyOf,
  type PurchaseRow,
  PurchaseSchema,
  type SubstitutedForEntryType,
  isPurchaseLine,
  purchaseDocumentLines,
  isKitHeaderLine,
  payableLineUid,
} from "../schemas/mod.ts";
import { cumulativeShareCents } from "./purchases.ts";
import { fitOutOfServiceEntries } from "./replacements.ts";
import type { OutOfServiceEntryType } from "../schemas/mod.ts";
import { roundDivHalfUp } from "./money.ts";
import {
  collectSubstitutionAnchors,
  type CreditableRow,
  liveSubstitutionAnchors,
  type PathForwardMap,
  sliceSubstitutedFor,
  standInUnits,
  substitutionCredit,
} from "./substitutions.ts";
import { classifySharedFields, fieldsUnder, sameSharedValue, type SharedField } from "./shared-fields.ts";
import {
  computePurchaseDocumentItemPaths,
  invoiceIsFrozen,
  type LineClaimSide,
  purchaseBillIsLive,
  type ScopedPairSide,
  type ScopedSyncSide,
  syncScopedDestinations,
} from "./invoices.ts";
import type { LineItem } from "./orders.ts";
import {
  chargeWindowContext,
  flatPayablePrice,
  meteredLineCounts,
  type PayablePriceDocumentContext,
  priceDocument,
  type PricingFormulas,
  statedChargeWindows,
} from "./price-document.ts";
import { combineTierCounts, meanTierCounts, type TierCount } from "./price-formulas.ts";

export { purchaseBillIsLive };

// ── Context ─────────────────────────────────────────────────────

/**
 * One purchase's existing bills and credits, as the "already billed" readers
 * see them. Pass EVERY bill and credit of the purchase; liveness is decided
 * here ({@link purchaseBillIsLive}, {@link purchaseCreditIsLive}). A bill may
 * bill several purchases, so `uid_purchase` says whose lines to read.
 */
export interface PurchaseBilledDocuments {
  uid_purchase: string;
  /**
   * The purchase's rows, dividers included: which substitutions are LIVE (the
   * purchase still carries X) and the kit ratio a substitute credits X's
   * components by ({@link purchaseDocumentBilling}). Required, so a reader
   * cannot silently stop counting a substitute.
   */
  purchase_items: readonly CreditableRow[];
  bills: readonly Pick<PurchaseBill, "uid" | "number" | "totals" | "items" | "status">[];
  credits: readonly Pick<PurchaseCredit, "status" | "items">[];
}

/**
 * **The documents of one purchase dated before `bill`** — by date, then number —
 * with `bill` itself left out. A time line re-seeded on `bill` is billed for its
 * pair's time less what THESE documents bill (one-document-model item 5): a later
 * document's billing does not limit what an earlier one may bill. The bill writer
 * and the manager's optimistic reprice both read it, so the two cannot disagree.
 */
export function purchaseDocumentsBefore<
  B extends Pick<PurchaseBill, "uid" | "date" | "number">,
  C extends Pick<PurchaseCredit, "date" | "number">,
>(
  bill: Pick<PurchaseBill, "uid" | "date" | "number">,
  purchase: { uid: string; items: readonly CreditableRow[] },
  bills: readonly B[],
  credits: readonly C[],
): { uid_purchase: string; purchase_items: readonly CreditableRow[]; bills: B[]; credits: C[] } {
  const at = Date.parse(bill.date);
  const before = (d: { date: string; number: number }): boolean => {
    const t = Date.parse(d.date);
    return t < at || (t === at && d.number < bill.number);
  };
  return {
    uid_purchase: purchase.uid,
    purchase_items: purchase.items,
    bills: bills.filter((b) => b.uid !== bill.uid && before(b)),
    credits: credits.filter(before),
  };
}

// ── Reading existing coverage ──────────────────────────────────

/** Is this credit live — not voided? Every "already billed" reader asks it. */
export function purchaseCreditIsLive(credit: Pick<PurchaseCredit, "status">): boolean {
  return credit.status !== "void";
}

/** A purchase line's join key — `uid_purchase/...path` — the twin of `purchaseLineKeyOf`. */
export function purchaseLineKey(uidPurchase: string, path: readonly string[]): string {
  return [uidPurchase, ...path].join("/");
}

/** A row's `substituted_for`: only the product arm (a sale or rental line) carries one. */
function substitutedForOf(row: PurchaseDocumentItem): PurchaseDocumentProductItem["substituted_for"] {
  return "substituted_for" in row ? row.substituted_for : undefined;
}

/** What one document bills of one purchase line: {@link purchaseDocumentBilling}'s value. */
export interface PurchaseLineBilling {
  /** Units billed, a substitute's stand-in units included. */
  quantity: number;
  /** The money of those units. */
  amount_cents: number;
  /**
   * The rows' counts, each with the units it bills, for the quantity-weighted
   * mean ({@link purchaseLineBilledCounts}). A unit credited through a kit's
   * ratio adds quantity and no part.
   */
  parts: { quantity: number; counts: readonly TierCount[] }[];
}

/**
 * **What one document bills of each line of purchase `uidPurchase`**, keyed by
 * the line's path relative to the purchase, joined with `/`. Every "already
 * billed" reader goes through it.
 *
 * - A row bills the line its join names (`purchaseLineKeyOf`: its own path, or
 *   its move pointer).
 * - 🔴 **A substitute Y bills the X it stands in for** (W5, `substituted_for`),
 *   as an invoice's does on AR (`invoicedByPath`): each live entry credits X
 *   with its units and their share of Y's money and counts, and the rest of Y
 *   stays at Y's own join. The stand-in units take Y's FIRST units' share
 *   (`cumulativeShareCents`), so the parts sum to exactly Y's amount.
 * - An entry is live while the purchase still carries X (`purchase_items`);
 *   a spent one bills nothing for X, and its units count at Y's own join.
 * - X's kit components are credited through the PURCHASE's own ratio
 *   (`substitutionCredit`), in units only: the money a substitute stands in for
 *   is X's whole subtree's, and it lands on X. That holds whichever of Y's rows
 *   carries it: a component's stamped entries move its stand-in share of its
 *   money to X too, units staying with the ratio walk (api-cloudrun#1475).
 */
export function purchaseDocumentBilling(
  rows: readonly PurchaseDocumentRow[],
  uidPurchase: string,
  purchaseItems: readonly CreditableRow[],
): Map<string, PurchaseLineBilling> {
  return foldPurchaseDocument(rows, uidPurchase, purchaseItems, "bill");
}

/**
 * **What one supplier credit UN-bills of each line of purchase `uidPurchase`** —
 * {@link purchaseDocumentBilling}'s fold over the credit's rows, read as rows of
 * sign −1 (ruling 84). The caller subtracts it. Two differences, both the one
 * credit fold's rules on both sides:
 *
 * - **Only a `reverses_billing: true` line nets** (ruling 38). An unmarked line —
 *   a goodwill or freight credit — is money given back, not billing reversed.
 * - **A time credit nets COUNTS and money, never units** (R3): a line carrying
 *   `counts` adds its parts and amount and no quantity.
 *
 * Root vs component is the credit's own anchors, and that is the bill's by
 * construction: a credit of a substitute kit copies its root WITH its subtree
 * and refuses a bare component (`billLineCreditParts`, `creditableBillLines`),
 * so the copied anchors are the bill's. No stored credit carries
 * `substituted_for` (prod 2, dev 6 lines on 2026-11-13).
 */
export function purchaseCreditBilling(
  rows: readonly PurchaseDocumentRow[],
  uidPurchase: string,
  purchaseItems: readonly CreditableRow[],
): Map<string, PurchaseLineBilling> {
  return foldPurchaseDocument(rows, uidPurchase, purchaseItems, "credit");
}

function foldPurchaseDocument(
  rows: readonly PurchaseDocumentRow[],
  uidPurchase: string,
  purchaseItems: readonly CreditableRow[],
  role: "bill" | "credit",
): Map<string, PurchaseLineBilling> {
  const out = new Map<string, PurchaseLineBilling>();
  const at = (k: string): PurchaseLineBilling => {
    let entry = out.get(k);
    if (!entry) out.set(k, entry = { quantity: 0, amount_cents: 0, parts: [] });
    return entry;
  };
  const prefix = `${uidPurchase}/`;
  const lines: PurchaseDocumentItem[] = [];
  for (const row of rows) {
    if (row.type === "purchase" || row.type === "destination" || row.type === "group") continue;
    if (role === "credit" && row.reverses_billing !== true) continue;
    if (row.path[0] === uidPurchase) lines.push(row);
  }
  /** A time credit (R3) moves counts and money, never units. */
  const unitsOf = (line: PurchaseDocumentItem, units: number): number =>
    role === "credit" && (line.price?.counts?.length ?? 0) > 0 ? 0 : units;
  const anchors = liveSubstitutionAnchors(
    purchaseItems,
    collectSubstitutionAnchors(lines.map((l) => ({ path: l.path.slice(1), substituted_for: substitutedForOf(l) }))),
  );
  const liveX = new Set(anchors.map((a) => a.substitutedFor.join("/")));
  const anchorAt = new Set(anchors.map((a) => `${a.path.join("/")}\x1e${a.substitutedFor.join("/")}`));
  const direct = new Map<string, number>();
  for (const line of lines) {
    const join = purchaseLineKeyOf(line);
    if (join === null || !join.startsWith(prefix)) continue;
    const rel = line.path.slice(1).join("/");
    let units = 0;
    let cents = 0;
    // The row's live entries in stored order take its first units, each its share of the money.
    for (const e of substitutedForOf(line) ?? []) {
      const x = e.path.join("/");
      if (e.path.length === 0 || e.quantity <= 0 || !liveX.has(x)) continue;
      const share = flatShareCents(line.amount_cents, line.quantity, units, units + e.quantity);
      const entry = at(x);
      entry.amount_cents += share;
      if (anchorAt.has(`${rel}\x1e${x}`)) {
        // A root: its entry bills X's units, and its counts.
        entry.quantity += unitsOf(line, e.quantity);
        entry.parts.push({ quantity: e.quantity, counts: line.price.counts });
        if (unitsOf(line, e.quantity) > 0) direct.set(x, (direct.get(x) ?? 0) + e.quantity);
      }
      // A component's stamped entry is its share of its root's. Its UNITS reach X's
      // components through the ratio walk below. Its MONEY lands on X, as the root's
      // does: left at the component's own join, it billed a key no purchase line
      // carries (api-cloudrun#1475, a $0 header Y over priced components).
      units += e.quantity;
      cents += share;
    }
    const own = line.quantity - standInUnits({ path: line.path, substituted_for: substitutedForOf(line) }, liveX);
    const entry = at(join.slice(prefix.length));
    entry.quantity += unitsOf(line, own);
    entry.amount_cents += line.amount_cents - cents;
    if (own > 0) entry.parts.push({ quantity: own, counts: line.price.counts });
  }
  for (const [k, units] of substitutionCredit(purchaseItems, direct)) {
    if (!direct.has(k)) at(k).quantity += units;
  }
  return out;
}

/**
 * Does this purchase line COUNT for coverage — a subrent, charge or replacement
 * line whose purchase was not canceled? A line closed to nothing is removed
 * (ruling 47), so every line still present covered what it covered.
 */
export function purchaseLineCovers(purchase: Pick<Purchase, "status">, item: PurchaseItem): boolean {
  return purchase.status !== "canceled" && item.type !== "sale";
}

/** What the live documents bill of one purchase line, net of credits. */
export interface PurchaseLineBilledNet {
  /** Σ live bill line quantity − Σ live credit line quantity. May be negative. */
  quantity: number;
  /** Σ live bill line `amount_cents` − Σ live credit line `amount_cents`. May be negative. */
  amount_cents: number;
}

/**
 * **What the purchase line at `path` is billed, net of credits, UNFLOORED.** The
 * one sum behind {@link recomputePurchaseQuantityBilled} and the diff's `billed`
 * entry: lines join on the full path under the purchase, because one product
 * may sit on two lines. A negative is a credit with no live bill left under
 * it, which the diff has to be able to show.
 */
export function purchaseLineBilledNet(path: readonly string[], documents: PurchaseBilledDocuments): PurchaseLineBilledNet {
  const key = path.join("/");
  const net: PurchaseLineBilledNet = { quantity: 0, amount_cents: 0 };
  const add = (rows: readonly PurchaseDocumentRow[], sign: 1 | -1) => {
    const fold = sign === 1 ? purchaseDocumentBilling : purchaseCreditBilling;
    const billed = fold(rows, documents.uid_purchase, documents.purchase_items).get(key);
    if (billed === undefined) return;
    net.quantity += sign * billed.quantity;
    net.amount_cents += sign * billed.amount_cents;
  };
  for (const bill of documents.bills) if (purchaseBillIsLive(bill)) add(bill.items, 1);
  for (const credit of documents.credits) if (purchaseCreditIsLive(credit)) add(credit.items, -1);
  return net;
}

/**
 * **The counts the live documents bill of one TIME purchase line, net of
 * credits** — Σ live bill `counts` − Σ live credit `counts`, tier by tier
 * (`combineTierCounts`), joined on the purchase line key as
 * {@link purchaseLineBilledNet} is. Unfloored, like it.
 *
 * The rows of ONE document that bill the line fold first, into their
 * quantity-weighted mean (`meanTierCounts`), so a split reads as one billing:
 * 4 units split 2 + 2 over 30 days have billed 30 days, not 60. Summing across
 * documents is unchanged (core#149 tracks what that means for a partial bill).
 */
export function purchaseLineBilledCounts(path: readonly string[], documents: PurchaseBilledDocuments): TierCount[] {
  const key = path.join("/");
  let net: TierCount[] = [];
  const add = (rows: readonly PurchaseDocumentRow[], sign: 1 | -1) => {
    const fold = sign === 1 ? purchaseDocumentBilling : purchaseCreditBilling;
    const parts = fold(rows, documents.uid_purchase, documents.purchase_items).get(key)?.parts ?? [];
    net = combineTierCounts(net, meanTierCounts(parts), sign);
  };
  for (const bill of documents.bills) if (purchaseBillIsLive(bill)) add(bill.items, 1);
  for (const credit of documents.credits) if (purchaseCreditIsLive(credit)) add(credit.items, -1);
  return net;
}

/** {@link remainingTimeCounts}' inputs. */
export interface RemainingTimeCountsArgs {
  purchase: Pick<Purchase, "uid" | "destinations">;
  item: PurchaseItem;
  documents: PurchaseBilledDocuments;
  formulas: PricingFormulas;
  holidays: readonly string[];
  /**
   * Meter over a BILL's own pair rather than the purchase's: `path` is the row's
   * path on the bill and `destinations` the bill's pairs. A row that moved to
   * another pair, or a pair the bill's edit re-dated, is metered there, because
   * the purchase line's own path names the pair it sat under. `documents` is
   * then whichever bills and credits the caller counts as already billed.
   */
  metered_over?: { path: readonly string[]; destinations: readonly PurchaseDocDestination[] };
}

/**
 * **What is left to bill of a TIME purchase line, in counts** (0b ruling 3,
 * the AR rule `extensionGroups` applies to an order): the line metered over its
 * PAIR's `charge_windows` through its formula, less what live bills already
 * bill there net of credits ({@link purchaseLineBilledCounts}), each tier
 * floored at 0. Billing in parts therefore never totals more than metering the
 * whole, and an over-billed line seeds nothing (the diff reports it).
 *
 * `null` when the line's pair states no charge windows — there is no time to
 * bill, which the bill writer refuses by name.
 */
export function remainingTimeCounts(args: RemainingTimeCountsArgs): TierCount[] | null {
  const over = args.metered_over;
  const source = asEngineSource(args.item);
  const metered = meteredLineCounts(over ? { ...source, path: [...over.path] } : source, {
    charge_windows: statedChargeWindows(over ? over.destinations : args.purchase.destinations),
    formulas: args.formulas,
    holidays: args.holidays,
  });
  if (metered === null) return null;
  const billed = purchaseLineBilledCounts(args.item.path, { ...args.documents, uid_purchase: args.purchase.uid });
  return combineTierCounts(metered, billed, -1).map((t) => (t.num < 0 ? { ...t, num: 0, den: 1 } : t));
}

/**
 * **A purchase's rows with each line's `quantity_billed` recounted** from its
 * documents (api-cloudrun#1441). A flat line's count is
 * {@link purchaseLineBilledNet} floored at 0, because the schema's bucket is
 * `.min(0)`; the diff keeps the unfloored number. A time line and a divider
 * come back as they went in.
 *
 * ⚠️ `quantity_billed` is recounted, never kept by delta: a bill line's
 * quantity changes, so a delta here would release the wrong number on a void.
 * (Its retired siblings `quantity_received` / `quantity_returned` are custody
 * now, read off the inbound bookings and the journal, C8.) Pass EVERY bill and credit of the purchase, including the one the
 * caller is writing.
 */
export function recomputePurchaseQuantityBilled(
  purchase: Pick<Purchase, "items">,
  documents: PurchaseBilledDocuments,
): PurchaseRow[] {
  return purchase.items.map((row) => {
    if (row.type === "destination" || row.type === "group") return row;
    return purchaseItemBasis(row) === "flat"
      ? { ...row, quantity_billed: Math.max(0, purchaseLineBilledNet(row.path, documents).quantity) }
      : row;
  });
}

// ── Money ───────────────────────────────────────────────────────

/**
 * A FLAT bill line's share of its purchase line's discount, for the record.
 * `amount_cents` is already net (ruling 7), so this moves no money: it is
 * `round(discount × billed ÷ ordered)`, informational, and never summed.
 */
function flatDiscountShare(discount: DiscountType, billed: number, ordered: number): number {
  if (ordered === 0) return 0; // A canceled line: no discount left to share.
  return Number(roundDivHalfUp(BigInt(discount.amount_cents) * BigInt(billed), BigInt(ordered)));
}

/**
 * The cents a flat line's units `(before, after]` cost — `cumulativeShareCents`,
 * extended past `quantity` at the same per-unit rate, because over-billing is
 * legal (D5) and still needs a default. A writer pricing anything against a
 * line's `quantity_billed`, which may stand past `quantity`, prices through this
 * and never through `cumulativeShareCents`, which throws there.
 */
export function flatShareCents(amountCents: number, quantity: number, before: number, after: number): number {
  if (after <= quantity) return cumulativeShareCents(amountCents, quantity, before, after);
  const at = (k: number) => Number(roundDivHalfUp(BigInt(amountCents) * BigInt(k), BigInt(quantity)));
  return at(after) - at(before);
}

/**
 * **What a supplier credit of `n` flat units is worth, when it names no bill
 * line** (api-cloudrun#1439) — a share of the line's billed POOL
 * (`purchaseLineBilledNet`: live bills less live credits), never of the PO line,
 * so an edited bill strands nothing.
 *
 * - The pool's share of its last `n` units. Crediting the whole pool returns
 *   exactly its money, and successive credits sum to it.
 * - `stated_cents`: the supplier's memo governs, refused above the pool, because
 *   an operator typed it.
 *
 * A credit that names a bill line is priced by {@link billLineCreditCents}
 * instead (one-document-model 6d): from that line, not the pool.
 *
 * @throws {RangeError} when `n` is outside `1..pool quantity`, the pool holds no
 *   money, or a stated amount exceeds the pool
 */
export function purchaseLineCreditCents(args: {
  pool: PurchaseLineBilledNet;
  n: number;
  stated_cents?: number;
}): number {
  const { pool, n, stated_cents } = args;
  if (!Number.isInteger(n) || n < 1 || n > pool.quantity) {
    throw new RangeError(`crediting ${n} exceeds the ${pool.quantity} billed`);
  }
  if (pool.amount_cents <= 0) throw new RangeError("this line's billed pool holds no money to credit");
  if (stated_cents !== undefined) {
    if (stated_cents > pool.amount_cents) {
      throw new RangeError(`a credit of ${stated_cents} cents exceeds the ${pool.amount_cents} cents billed`);
    }
    return stated_cents;
  }
  return flatShareCents(pool.amount_cents, pool.quantity, pool.quantity - n, pool.quantity);
}

/** What live supplier credits have already taken from one bill line. */
export interface BillLineCredited {
  /** Σ quantity of live credit lines naming the bill line. */
  quantity: number;
  /** Σ their `amount_cents`. */
  amount_cents: number;
}

/**
 * **What live credits have taken from the bill line at `path` on bill
 * `uidBill`** — every live credit line naming that `(uid_purchase_bill,
 * path_bill_item)`. The per-line half of the credit cap (one-document-model 6d),
 * the twin of AR's `creditableLines` prior-note sum.
 *
 * **The CREDITED view of the one credit fold** (ruling 84): marker-free, every
 * non-void credit — the same liveness the AR cap reads (`creditableLines`). The
 * REVERSED view is {@link purchaseCreditBilling}, gated on `reverses_billing`.
 * A supplier credit has no draft state, so non-void is "issued or applied",
 * exactly AR's netting liveness.
 *
 * ⚠️ Keyed on the pointer as written, which goes stale when the bill row moves
 * (owner ruling 22, as `path_invoice_item` does on AR): a credit raised before a
 * move then no longer counts against the row. The pool cap
 * (`purchaseLineBilledNet`) still sees it.
 */
export function billLineCredited(
  uidBill: string,
  path: readonly string[],
  credits: readonly Pick<PurchaseCredit, "status" | "items">[],
): BillLineCredited {
  const key = path.join("/");
  const out: BillLineCredited = { quantity: 0, amount_cents: 0 };
  for (const credit of credits) {
    if (!purchaseCreditIsLive(credit)) continue;
    // Every line row, kit headers included: a substitute kit's root is usually a
    // $0 header, and a credit of it copies it (`billLineCreditParts`).
    for (const line of credit.items) {
      if (!isPurchaseLine(line) || line.uid_purchase_bill !== uidBill || line.path_bill_item?.join("/") !== key) continue;
      out.quantity += line.quantity;
      out.amount_cents += line.amount_cents;
    }
  }
  return out;
}

/**
 * **What a supplier credit of `n` units of one bill line is worth**
 * (one-document-model 6d, owner 2026-11-11): units `(c, c + n]` of the line,
 * `c` the units live credits already took (`billLineCredited`), priced
 * FIRST-COME (`flatShareCents`), so crediting a line in parts sums to exactly
 * its amount — $100.00 over 3 units credited one at a time is 3333 + 3334 +
 * 3333, never 9999.
 *
 * ⚠️ **Deliberately unlike AR**, where each credit-note line rounds on its own
 * (`priceCreditNote`). This module's rule is that a line's documents sum to the
 * line's money exactly, and a credit of a bill line is one more of them.
 *
 * - `stated_cents`: the supplier's memo governs, refused above what is left of
 *   the line's money.
 * - The first-come share is capped at what is left of the line's money, so a
 *   line part-credited at a stated amount cannot be over-credited.
 *
 * @throws {RangeError} when `n` is outside `1..units left`, or a stated amount
 *   exceeds the money left
 */
export function billLineCreditCents(args: {
  line: { quantity: number; amount_cents: number };
  credited: BillLineCredited;
  n: number;
  stated_cents?: number;
}): number {
  const { line, credited, n, stated_cents } = args;
  const left = line.quantity - credited.quantity;
  if (!Number.isInteger(n) || n < 1 || n > left) {
    throw new RangeError(`crediting ${n} exceeds the ${Math.max(0, left)} left on the bill line`);
  }
  const room = Math.max(0, line.amount_cents - credited.amount_cents);
  if (stated_cents !== undefined) {
    if (stated_cents > room) throw new RangeError(`a credit of ${stated_cents} cents exceeds the ${room} cents left on the bill line`);
    return stated_cents;
  }
  return Math.min(room, flatShareCents(line.amount_cents, line.quantity, credited.quantity, credited.quantity + n));
}

/**
 * The rows a substitute KIT's root binds on a bill: its line rows strictly below
 * it, when it is a substitution's root (W5) and has any. Empty for every other
 * row, which a credit copies alone (ruling 23).
 *
 * A substituted kit's component carries a stamped share of its root's
 * `substituted_for`, which a credit row cannot carry without its root above it:
 * copied alone, its entries read as anchors and un-bill X itself by the
 * component's units. So a credit of such a kit copies the root WITH its subtree
 * (api-cloudrun#1475), and the root is offered even when it is a $0 header.
 *
 * @param rows - The bill's rows, dividers included
 * @param path - The candidate root's path on the bill
 */
export function substituteKitSubtree(
  rows: readonly PurchaseDocumentRow[],
  path: readonly string[],
): PurchaseDocumentItem[] {
  const entriesOf = (r: PurchaseDocumentItem) => substitutedForOf(r) ?? [];
  const lines = rows.filter((r): r is PurchaseDocumentItem => isPurchaseLine(r));
  const key = path.join("/");
  const self = lines.find((r) => r.path.join("/") === key);
  if (self === undefined || entriesOf(self).length === 0) return [];
  const withEntries = lines.filter((r) => entriesOf(r).length > 0).map((r) => ({ path: r.path, substituted_for: entriesOf(r) }));
  if (!collectSubstitutionAnchors(withEntries).some((a) => a.path.join("/") === key)) return [];
  return lines.filter((r) => r.path.length > path.length && path.every((p, i) => r.path[i] === p));
}

/** One bill row a supplier credit copies: {@link billLineCreditParts}' element. */
export interface BillLineCreditPart {
  /** The bill row. */
  line: PurchaseDocumentItem;
  /** What live credits naming the row already took ({@link billLineCredited}). */
  credited: BillLineCredited;
  /** Units this credit takes of the row: `(credited.quantity, credited.quantity + n]`. */
  n: number;
  /** Their money, first-come ({@link billLineCreditCents}). */
  amount_cents: number;
  /** The row's LIVE `substituted_for` entries, sliced to those units ({@link sliceSubstitutedFor}). */
  substituted_for: SubstitutedForEntryType[];
}

/**
 * **Every bill row a credit of `n` units of the bill line at `path` copies**,
 * each with its units, money and sliced substitution (one-document-model 6d,
 * ruling 23). The API's writer stores them and the manager's form previews
 * their sum, so the screen shows what is stored.
 *
 * - An ordinary row is one part: units `(c, c + n]`, `c` what live credits took.
 * - A substitute KIT's root ({@link substituteKitSubtree}) brings every row
 *   below it, by the BILL's own ratio: a row of `q` units under a root of `Q`
 *   takes units `(⌊cQ⌉, ⌊(c + n)Q⌉]` of its own, `⌊kq/Q⌉` rounded half-up, so
 *   credits that sum to the root's quantity sum to each row's. A row the ratio
 *   gives no unit is left out. Each part is priced on its own, first-come.
 * - ⚠️ X's components are un-billed by the fold's ratio walk, which rounds once
 *   per DOCUMENT (`substitutionCredit`). A kit's ratio is whole (its
 *   `quantity_per_parent`), so the walk is exact; a fractional ratio would leave
 *   X's component a unit off after several credits, as several partial bills
 *   of one substitute kit already would.
 *
 * Entries are LIVE while the purchase still carries their X (`purchaseKeys`),
 * as the fold reads them; a spent one stands in for nothing and is not copied.
 *
 * @throws {RangeError} when no line row sits at `path`, `n` exceeds a row's units
 *   left, a stated amount exceeds the money left, or a kit's credit states an
 *   amount (a kit is priced from its rows)
 */
export function billLineCreditParts(args: {
  bill: Pick<PurchaseBill, "uid" | "items">;
  path: readonly string[];
  n: number;
  credits: readonly Pick<PurchaseCredit, "status" | "items">[];
  /** Keys (`path.join("/")`, purchase-relative) of the purchase's rows. */
  purchaseKeys: ReadonlySet<string>;
  stated_cents?: number;
}): BillLineCreditPart[] {
  const { bill, path, n, credits, purchaseKeys, stated_cents } = args;
  const key = path.join("/");
  const root = bill.items.find((r): r is PurchaseDocumentItem => isPurchaseLine(r) && r.path.join("/") === key);
  if (root === undefined) throw new RangeError(`bill has no line at ${key}`);
  const subtree = substituteKitSubtree(bill.items, path);
  if (subtree.length > 0 && stated_cents !== undefined) {
    throw new RangeError("a substitute kit's credit is priced from its rows, so it states no amount");
  }
  const c = billLineCredited(bill.uid, path, credits).quantity;
  const part = (line: PurchaseDocumentItem, from: number, to: number): BillLineCreditPart => {
    const credited = billLineCredited(bill.uid, line.path, credits);
    const m = to - from;
    const live = (substitutedForOf(line) ?? []).filter((e) => purchaseKeys.has(e.path.join("/")));
    return {
      line,
      credited,
      n: m,
      amount_cents: billLineCreditCents({
        line,
        credited,
        n: m,
        ...(line === root && stated_cents !== undefined ? { stated_cents } : {}),
      }),
      substituted_for: sliceSubstitutedFor(live, from, to),
    };
  };
  const out = [part(root, c, c + n)];
  const at = (k: number, q: number) => Math.floor((2 * k * q + root.quantity) / (2 * root.quantity));
  for (const line of subtree) {
    const from = at(c, line.quantity);
    const to = at(c + n, line.quantity);
    if (to > from) out.push(part(line, from, to));
  }
  return out;
}

// ── The projector ───────────────────────────────────────────────

/**
 * The shared keys a bill or credit line copies from the purchase line it
 * projects: the line head, posting and tax cores (one instance per key,
 * `schemas/_items.ts`), at the purchase line's own path under its purchase
 * divider and with its uid — the invoice line's convention. `quantity` is NOT
 * here: it is the units the line bills.
 */
function projectedLineHead(item: PurchaseItem, uidPurchase: string) {
  return {
    uid: item.uid,
    name: item.name,
    description: item.description,
    path: [uidPurchase, ...item.path],
    zero_priced: item.zero_priced,
    ...(item.quantity_per_parent !== undefined ? { quantity_per_parent: item.quantity_per_parent } : {}),
    ledger_account: item.ledger_account,
    uid_tracking_category: item.uid_tracking_category,
    uid_tax_class: item.uid_tax_class,
    ...(item.uid_tax_class_override !== undefined ? { uid_tax_class_override: item.uid_tax_class_override } : {}),
  };
}

/**
 * What a purchase line's bill line carries beyond its head: a replacement's
 * record(s). (The product is the line's uid on every arm since 7a.)
 *
 * A replacement's `out_of_service` list is re-shared over the bill line's
 * `quantity` (`fitOutOfServiceEntries`), so a partial bill's shares sum to its
 * own quantity and an untouched partial bill compares equal to its projection.
 * The re-share is first-come from the line's first unit for every bill, so a
 * second partial bill of a two-record line names the records in the same order
 * as the first. Nothing reads per-record billing on this side (W4R), so that is
 * attribution, not money.
 */
function attributionOf(
  item: PurchaseItem,
  quantity: number,
): { out_of_service?: OutOfServiceEntryType[] } {
  switch (item.type) {
    case "sale":
    case "rental":
    case "service":
      return {};
    case "replacement":
      return { out_of_service: fitOutOfServiceEntries(item.out_of_service, quantity) };
    default: {
      const unreachable: never = item;
      throw new Error(`attributionOf: unknown purchase item ${JSON.stringify(unreachable)}`);
    }
  }
}

/** {@link projectPurchaseLineToBillLine}'s inputs beside the purchase line. */
export interface ProjectBillLineOptions {
  /** The purchase the line is on. */
  uid_purchase: string;
  /** The units billed (the operator's input). */
  quantity: number;
  /**
   * The unit the share starts after — the line's `quantity_billed` by default
   * (the next bill continues where the last stopped). The sync's projector
   * passes `0`: it projects the WHOLE line, as an order line projects whole.
   * A flat line only.
   */
  from?: number;
  /**
   * A TIME line's counts to bill — the writer's {@link remainingTimeCounts}
   * seed. Absent: `[]`, and `priceDocument` meters the bill's pair instead.
   */
  counts?: TierCount[];
}

/**
 * **Default a bill line from its purchase line** (D5). Name, formula, discount
 * terms, posting and attribution are the purchase line's (each then
 * overridable on the bill until it settles). The amount is `quantity` units at
 * the line's cumulative share from where its `quantity_billed` stands
 * ({@link flatShareCents}, extended past the ordered count because
 * over-billing is legal), so the bills of a line sum to its `amount_cents`; the
 * discount record is the same share of the purchase line's.
 *
 * The line's price is built by `flatPayablePrice` (the stated-total arm), so
 * the projection parses on its own; the writer prices the whole document with
 * `priceDocument`, which states the same money and the line's `taxes_base`.
 *
 * A TIME line projects unpriced, with the caller's `counts` seed
 * ({@link remainingTimeCounts}); the writer's `priceDocument` prices it.
 */
export function projectPurchaseLineToBillLine(
  item: PurchaseItem,
  opts: ProjectBillLineOptions,
): PurchaseDocumentItem {
  if (item.price.price_formula.basis === "time") return projectTimeLine(item, opts);
  const amount = item.amount_cents ?? 0;
  const before = opts.from ?? item.quantity_billed ?? 0;
  const amount_cents = flatShareCents(amount, item.quantity, before, before + opts.quantity);
  const price: PurchaseDocumentLinePrice = flatPayablePrice({
    uid: item.uid,
    quantity: opts.quantity,
    amount_cents,
    price_formula: item.price.price_formula,
    discount: item.price.discount
      ? { ...item.price.discount, amount_cents: flatDiscountShare(item.price.discount, opts.quantity, item.quantity) }
      : null,
    taxes: item.price.taxes,
    taxes_base: item.price.taxes_base,
    counts: true,
  });
  return {
    type: item.type,
    ...projectedLineHead(item, opts.uid_purchase),
    ...attributionOf(item, opts.quantity),
    quantity: opts.quantity,
    amount_cents,
    price,
  } as PurchaseDocumentItem;
}

/**
 * A TIME purchase line's bill line, UNPRICED: the purchase line's formula,
 * rates and discount terms, the seeded `counts` (or `[]`), and zero money. The
 * writer prices the bill with `priceDocument` (`origin: "pushed"` and its
 * `time` context), whose time arm meters an empty `counts` from the bill's pair
 * and writes the line's money and `amount_cents` (one-document-model Phase 3).
 */
function projectTimeLine(item: PurchaseItem, opts: ProjectBillLineOptions): PurchaseDocumentItem {
  const price: PurchaseDocumentLinePrice = {
    price_formula: { ...item.price.price_formula },
    rates: item.price.rates.map((r) => ({ ...r })),
    discount: item.price.discount ? { ...item.price.discount } : null,
    taxes: [],
    ...(item.price.taxes_base !== undefined ? { taxes_base: item.price.taxes_base.map((t) => ({ ...t })) } : {}),
    counts: (opts.counts ?? []).map((t) => ({ ...t })),
    subtotal_cents: 0,
    subtotal_discounted_cents: 0,
    total_cents: 0,
  };
  const head = { ...projectedLineHead(item, opts.uid_purchase), ...attributionOf(item, opts.quantity), quantity: opts.quantity, amount_cents: 0, price };
  switch (item.type) {
    case "sale":
    case "rental":
      return { type: item.type, ...head };
    case "service":
      return { type: "service", ...head, ledger_account: item.ledger_account };
    case "replacement":
      // Restated: `attributionOf`'s return type cannot say the replacement arm always carries the list.
      return { type: "replacement", ...head, out_of_service: fitOutOfServiceEntries(item.out_of_service, opts.quantity), ledger_account: item.ledger_account };
    default: {
      const unreachable: never = item;
      throw new Error(`projectTimeLine: unknown purchase item ${JSON.stringify(unreachable)}`);
    }
  }
}

/** A purchase's `purchase` divider on a bill or credit — named `PO-n`, its uid the purchase's. */
export function purchaseScopeDivider(purchase: Pick<Purchase, "uid" | "number">): PurchaseDocumentRow {
  return { uid: purchase.uid, type: "purchase", name: `PO-${purchase.number}`, path: [purchase.uid], description: "" };
}

/**
 * **One purchase's block on a bill or credit**: its `purchase` divider, then
 * every purchase divider (destination, group) that is an ancestor of a given
 * line, then the lines — in the PURCHASE's row order, re-pathed by
 * `computePurchaseDocumentItemPaths` — plus the pairs those destination
 * dividers name, scoped by `uid_purchase`. The `adoptOrderDividerStructure`
 * twin: the dividers keep the purchase's uids, so a bill line's path IS
 * `[purchase uid, ...its purchase line's path]`.
 *
 * `lines` are bill or credit lines already at those paths ({@link
 * projectPurchaseLineToBillLine}); a line at a path the purchase does not carry
 * (a document-only charge, `[purchase uid, uid]`) sits directly under the
 * purchase divider, ahead of the first destination, so contiguity holds.
 *
 * **A credit line copied from a BILL ROW keeps that row's path**
 * (one-document-model 6d, ruling 23; owner 2026-11-11), even where the purchase
 * has no row there: a W5 substitute, a bill-authored charge, a row the bill
 * moved. Its dividers come from the bill named by `uid_purchase_bill`, which
 * `opts.bills` must carry: one the purchase holds is taken as above, and one the
 * BILL authored (a group, or a destination with its pair) is copied from the
 * bill. The line goes at the end of its parent's direct lines (ahead of a
 * destination's first group, as a divider closes every level below it), so the
 * credit shows the bill's tree.
 *
 * @throws when a line names a bill `opts.bills` does not carry, or a row that
 *   bill does not hold
 */
export function purchaseDocumentScope(
  purchase: Pick<Purchase, "uid" | "number" | "items" | "destinations">,
  lines: readonly PurchaseDocumentItem[],
  opts: { bills?: readonly Pick<PurchaseBill, "uid" | "items" | "destinations">[] } = {},
): { items: PurchaseDocumentRow[]; destinations: PurchaseDocDestination[] } {
  const byLocal = new Map<string, PurchaseDocumentItem>();
  const own: PurchaseDocumentItem[] = [];
  const fromBill: PurchaseDocumentItem[] = [];
  for (const line of lines) {
    if (line.path[0] !== purchase.uid) {
      throw new Error(`purchaseDocumentScope: line ${line.uid} is not under purchase ${purchase.uid}`);
    }
    const local = line.path.slice(1).join("/");
    const onPurchase = purchase.items.some((r) => r.path.join("/") === local);
    if (onPurchase) byLocal.set(local, line);
    else if (line.uid_purchase_bill !== undefined) fromBill.push(line);
    else own.push(line);
  }
  // Every ancestor path of a billed line, so the dividers above it come along.
  const wanted = new Set<string>();
  // `local` and every ancestor of it (`inclusive`), or its ancestors alone.
  const want = (local: string, inclusive: boolean) => {
    const parts = local.split("/");
    for (let k = 1; k < parts.length + (inclusive ? 1 : 0); k++) wanted.add(parts.slice(0, k).join("/"));
  };
  for (const local of byLocal.keys()) want(local, false);
  const held = new Map(purchase.items.map((r) => [r.path.join("/"), r]));
  // A bill-row line's ancestors: those the purchase holds come along as above;
  // a divider only the bill holds is copied from the bill (in path order).
  const authored = new Map<string, PurchaseDocumentRow>();
  const authoredPairs: PurchaseDocDestination[] = [];
  for (const line of fromBill) {
    const bill = opts.bills?.find((b) => b.uid === line.uid_purchase_bill);
    if (bill === undefined) {
      throw new Error(`purchaseDocumentScope: line ${line.uid} names bill ${line.uid_purchase_bill}, which was not passed`);
    }
    const billRows = new Map(bill.items.map((r) => [r.path.join("/"), r]));
    if (!billRows.has(line.path.join("/"))) {
      throw new Error(`purchaseDocumentScope: bill ${bill.uid} holds no row at ${line.path.join("/")}`);
    }
    for (let k = 2; k < line.path.length; k++) {
      const full = line.path.slice(0, k).join("/");
      const local = line.path.slice(1, k).join("/");
      if (held.has(local)) {
        want(local, true);
        continue;
      }
      const row = billRows.get(full);
      if (row === undefined || (row.type !== "destination" && row.type !== "group")) continue;
      if (!authored.has(full)) {
        authored.set(full, row);
        if (row.type === "destination") {
          const pair = bill.destinations.find((d) => d.uid === row.uid);
          if (pair !== undefined) authoredPairs.push(pair);
        }
      }
    }
  }
  const rows: PurchaseDocumentRow[] = [purchaseScopeDivider(purchase), ...own];
  for (const row of purchase.items) {
    const local = row.path.join("/");
    if (row.type === "destination" || row.type === "group") {
      if (wanted.has(local)) rows.push({ ...row, path: [purchase.uid, ...row.path] });
      continue;
    }
    const line = byLocal.get(local);
    if (line) {
      // A counted ancestor this document leaves out cannot hold the line's path,
      // so the line names where it came from by the move pointer.
      const strandedUnderLine = row.path.slice(0, -1).some((_, k) => {
        const ancestor = row.path.slice(0, k + 1).join("/");
        const above = held.get(ancestor);
        return above !== undefined && isPurchaseLine(above) && !isKitHeaderLine(above) && !byLocal.has(ancestor);
      });
      rows.push(strandedUnderLine ? { ...line, path_purchase_item: row.path } : line);
    } else if (isKitHeaderLine(row) && wanted.has(local) && row.quantity > 0) {
      rows.push(projectPurchaseLineToBillLine(row, { uid_purchase: purchase.uid, quantity: row.quantity, from: 0 }));
    }
  }
  // Insert each bill-row line, and each divider only the bill holds, under its
  // parent: after the parent's direct lines (a divider row ends them), or for a
  // divider, after the parent's whole subtree.
  const startsWith = (path: readonly string[], prefix: readonly string[]) => prefix.every((p, i) => path[i] === p);
  const isDivider = (r: PurchaseDocumentRow) => r.type === "purchase" || r.type === "destination" || r.type === "group";
  const place = (row: PurchaseDocumentRow) => {
    // The nearest ancestor this block holds; the purchase divider always is one.
    let parentPath = row.path.slice(0, -1);
    let at = -1;
    for (; parentPath.length > 0; parentPath = parentPath.slice(0, -1)) {
      at = rows.findIndex((r) => r.path.join("/") === parentPath.join("/"));
      if (at !== -1) break;
    }
    at += 1;
    const divider = isDivider(row);
    while (at < rows.length && startsWith(rows[at].path, parentPath) && (divider || !isDivider(rows[at]))) at += 1;
    rows.splice(at, 0, row);
  };
  for (const line of fromBill) {
    for (let k = 2; k < line.path.length; k++) {
      const full = line.path.slice(0, k).join("/");
      const divider = authored.get(full);
      if (divider !== undefined && !rows.some((r) => r.path.join("/") === full)) place(divider);
    }
    place(line);
  }
  const dividers = new Set(rows.filter((r) => r.type === "destination").map((r) => r.uid));
  return {
    items: computePurchaseDocumentItemPaths(rows),
    destinations: [
      ...purchase.destinations.filter((d) => dividers.has(d.uid)).map((d) => ({ uid_purchase: purchase.uid, ...d })),
      ...authoredPairs.filter((d) => dividers.has(d.uid)),
    ],
  };
}

// ── The purchase → bill sync ───────────────────────────────────

let billFields: readonly SharedField[] | null = null;

/**
 * The line fields the purchase → bill merge follows, read off the two schemas
 * (fail-closed: an undeclared shared key throws, as on the order side).
 */
export function purchaseBillSharedLineFields(): readonly SharedField[] {
  if (billFields !== null) return billFields;
  const c = classifySharedFields(PurchaseSchema, PurchaseBillSchema);
  if (c.unhandled.length > 0 || c.undeclared.length > 0) {
    throw new Error(
      `purchase → bill shared fields are not all declared: unhandled ${JSON.stringify(c.unhandled)}, ` +
        `undeclared ${JSON.stringify(c.undeclared)}`,
    );
  }
  billFields = fieldsUnder(c, "items[]");
  return billFields;
}

/**
 * The document-level fields a purchase and its bill share, read off the two
 * schemas as the line fields are. Every entry comes off the classification, so a
 * new shared key is compared by construction.
 */
export function purchaseBillSharedDocFields(): readonly SharedField[] {
  purchaseBillSharedLineFields();
  return classifySharedFields(PurchaseSchema, PurchaseBillSchema).fields.filter((f) =>
    !f.path.startsWith("items[]") && !f.path.startsWith("destinations[]")
  );
}

let timeFields: readonly SharedField[] | null = null;

/**
 * The fields a TIME line merges: the shared set without `amount_cents`. A time
 * line's amount is DERIVED from its counts (`priceDocument`'s pushed time arm),
 * as an order line's money is, so it is re-priced rather than compared.
 *
 * The rest of the `flat_money` group stays a group: `quantity` and a
 * replacement line's `out_of_service` (W4R), whose shares sum to the quantity,
 * so they follow or stay together. On every other line `out_of_service` is
 * absent from all three sides and the group decides exactly as `quantity`
 * alone did before W4R.
 */
function timeLineFields(): readonly SharedField[] {
  if (timeFields !== null) return timeFields;
  timeFields = purchaseBillSharedLineFields().filter((f) => f.path !== "amount_cents");
  return timeFields;
}

/**
 * **A purchase line in a BILL line's shape, over the shared keys only** — the
 * merge's three arguments must all be in the downstream shape (core#52), and
 * the purchase↔bill diff compares exactly what the merge follows.
 *
 * `quantity` is the units the bill line bills: the discount record is that
 * share of the purchase line's ({@link projectPurchaseLineToBillLine}'s rule),
 * so an untouched bill line compares equal to its projection and follows it,
 * and a followed discount lands as the bill's share rather than the whole.
 */
export function projectPurchaseLineForBill(item: PurchaseItem, quantity: number): Record<string, unknown> {
  return {
    type: item.type,
    name: item.name,
    description: item.description,
    zero_priced: item.zero_priced,
    ...(item.quantity_per_parent !== undefined ? { quantity_per_parent: item.quantity_per_parent } : {}),
    ledger_account: item.ledger_account,
    uid_tracking_category: item.uid_tracking_category,
    uid_tax_class: item.uid_tax_class,
    ...(item.uid_tax_class_override !== undefined ? { uid_tax_class_override: item.uid_tax_class_override } : {}),
    price: {
      price_formula: item.price.price_formula,
      rates: item.price.rates,
      discount: item.price.discount
        ? { ...item.price.discount, amount_cents: flatDiscountShare(item.price.discount, quantity, item.quantity) }
        : null,
    },
    ...attributionOf(item, quantity),
  };
}

/**
 * **A purchase row in a BILL's shape, under its purchase divider** — the
 * payable `ScopedSyncSide.project`. A divider is the purchase's own, re-pathed;
 * a line is the WHOLE line as a bill would bill it from nothing
 * ({@link projectPurchaseLineToBillLine} at its full quantity, from unit 0), so
 * an untouched bill line compares equal to it and follows it, exactly as an
 * untouched invoice line follows its order line. A partial bill differs on
 * `{quantity, amount_cents}` and keeps both (`shared_group: "flat_money"`).
 */
export function projectPurchaseRowForBill(row: PurchaseRow, uidPurchase: string): PurchaseDocumentRow {
  if (row.type === "destination" || row.type === "group") return { ...row, path: [uidPurchase, ...row.path] };
  return projectPurchaseLineToBillLine(row, { uid_purchase: uidPurchase, quantity: row.quantity, from: 0 });
}

/**
 * A purchase row in the sync engine's SOURCE shape (`LineItem`, the order-row
 * shadow): a divider as it is, a line with `counts: []` — a purchase line
 * meters no counts, and the order-shaped price declares the key. A conversion,
 * not a cast; {@link payableScopedSync} maps each converted row back to its
 * original, so the projector reads the purchase row itself.
 */
function asEngineSource(row: PurchaseRow): LineItem {
  if (row.type === "destination" || row.type === "group") return row;
  return { ...row, price: { ...row.price, counts: [] } };
}

/**
 * **The payable side of the scoped initiator → billing sync**
 * (`syncScopedDestinations`, `@cfs/core/utils/invoices`): the purchase → bill
 * sync IS the order → invoice sync, with a `purchase` scope divider, the
 * `path_purchase_item` move pointer, {@link projectPurchaseRowForBill} and the
 * purchase ↔ bill field set (one-document-model Phase 3).
 *
 * Built per sync over the two purchase revisions it converts
 * ({@link asEngineSource}): the engine hands its projector the converted rows,
 * and the side maps each back to the purchase row it came from. A line closed to
 * 0 is removed (ruling 47), so an overridden bill row that billed it keeps no
 * pointer, as an invoice row whose order line was removed keeps none.
 */
export function payableScopedSync(prev: Purchase, next: Purchase): {
  side: ScopedSyncSide<PurchaseDocumentRow>;
  prevItems: LineItem[];
  nextItems: LineItem[];
} {
  const original = new WeakMap<LineItem, PurchaseRow>();
  const convert = (rows: readonly PurchaseRow[]) =>
    rows.map((row) => {
      const source = asEngineSource(row);
      original.set(source, row);
      return source;
    });
  const prevItems = convert(prev.items);
  const nextItems = convert(next.items);
  const side: ScopedSyncSide<PurchaseDocumentRow> = {
    scopeType: "purchase",
    pointerKey: "path_purchase_item",
    isStructural: (item) => isKitHeaderLine(item),
    // A bill's own sale or rental line is the purchase line added after it for the
    // same product. A charge or a replacement line names no product it orders.
    adopts: (item, row) => {
      const source = original.get(item);
      return source !== undefined && (source.type === "sale" || source.type === "rental") &&
        row.type === source.type && row.uid === source.uid;
    },
    // A flat line states its money, so a substitution moving its units moves money
    // too (W5). A row still at its share of its purchase line follows that line's
    // share; any other row keeps its amount, unless units left it (a spent entry),
    // which take their share of it. A time line's money is its counts priced.
    requantify: (row, quantity, { source, scaleFrom }) => {
      if (!isPurchaseLine(row) || row.price.price_formula.basis === "time") return { ...row, quantity };
      const line = source === undefined ? undefined : original.get(source);
      if (line !== undefined && isPurchaseLine(line) && line.quantity > 0 && purchaseItemBasis(line) === "flat") {
        const amount = line.amount_cents ?? 0;
        if (row.amount_cents === flatShareCents(amount, line.quantity, 0, row.quantity)) {
          return { ...row, quantity, amount_cents: flatShareCents(amount, line.quantity, 0, quantity) };
        }
      }
      if (scaleFrom !== undefined && scaleFrom > 0 && scaleFrom !== quantity) {
        return { ...row, quantity, amount_cents: flatShareCents(row.amount_cents, scaleFrom, 0, quantity) };
      }
      return { ...row, quantity };
    },
    project: (item, scopeUid) => {
      const row = original.get(item);
      if (row === undefined) throw new Error(`payableScopedSync: row ${item.uid} is not one of the purchase's`);
      return projectPurchaseRowForBill(row, scopeUid);
    },
    lineFields: (item) => {
      const row = original.get(item);
      return row !== undefined && row.type !== "destination" && row.type !== "group" &&
          row.price.price_formula.basis === "time"
        ? timeLineFields()
        : purchaseBillSharedLineFields();
    },
  };
  return { side, prevItems, nextItems };
}

/** One bill's outcome from {@link syncPurchaseToBills}. */
export interface PurchaseBillSync {
  uid: string;
  /** The bill to store — the input object unchanged when `changed` is false. */
  bill: PurchaseBill;
  changed: boolean;
  /**
   * The sync would have removed the bill's every line (each followed a canceled
   * purchase line), so the bill was left as it stood: Xero ignores an empty
   * `LineItems`, which is how invoice #2396 froze. The caller reports it.
   */
  kept_no_lines?: true;
}

/** {@link syncPurchaseToBills}' inputs. */
export interface SyncPurchaseToBillsArgs {
  prev: Purchase;
  next: Purchase;
  /** Every bill of the purchase (the writer point-gets `query_by_bills`). */
  bills: readonly PurchaseBill[];
  /** The tax inputs each touched bill is priced under, at its own date. */
  tax: Omit<PayablePriceDocumentContext["tax"], "asOf">;
  /**
   * What a touched bill's TIME lines meter with, and what settles a merged pair's
   * day counts — the formulas and holidays; each bill's own pairs supply the windows.
   */
  time: { formulas: PricingFormulas; holidays: readonly string[] };
  /**
   * The unpaid LINKED bills the writer has just compared with Xero and found
   * equal. Only these follow a purchase edit: a linked bill's push replaces
   * Xero's lines, so an unchecked one would overwrite an edit made in Xero. The
   * compare needs Xero, so it runs before the transaction this sync runs in.
   */
  linked_cleared?: ReadonlySet<string>;
}

/**
 * **A purchase's pair in a bill's shape**, the payable `ScopedPairSide.project`:
 * the pair scoped by `uid_purchase`, the invoice pair's twin.
 */
function purchasePairForBill(pair: PurchaseDestination, uidPurchase: string): PurchaseDocDestination {
  return { uid_purchase: uidPurchase, ...pair };
}

let billPairFields: readonly SharedField[] | null = null;

/** The pair fields the purchase → bill merge follows, read off the two schemas. */
export function purchaseBillSharedPairFields(): readonly SharedField[] {
  if (billPairFields !== null) return billPairFields;
  purchaseBillSharedLineFields();
  billPairFields = fieldsUnder(classifySharedFields(PurchaseSchema, PurchaseBillSchema), "destinations[]");
  return billPairFields;
}

const PAYABLE_PAIR_SIDE: ScopedPairSide<PurchaseDestination, PurchaseDocDestination> = {
  scopeKey: "uid_purchase",
  fields: purchaseBillSharedPairFields,
  project: purchasePairForBill,
};

/**
 * The payable side of `orderLineClaimIssues`: a bill or credit's
 * `path_purchase_item`. A line closed to 0 is removed (ruling 47), so there is
 * no closed line to refuse: a claim on it names a row that is not there, as on
 * the receivable side.
 */
export const PAYABLE_LINE_CLAIMS: LineClaimSide<PurchaseRow> = {
  scopeType: "purchase",
  pointerKey: "path_purchase_item",
};

/**
 * A bill line's discount record is ITS SHARE of its purchase line's discount
 * (`flatDiscountShare`, as {@link projectPurchaseLineToBillLine} writes it at
 * create). The sync's projector projects the WHOLE line, so a discount that
 * newly reaches a partial bill line arrives at the whole line's amount; this
 * restates it as the line's share whenever its terms are the purchase line's.
 * A line whose terms the operator changed keeps its own record. Money does not
 * move: `amount_cents` is the stated NET, and the record is informational.
 */
function reshareDiscounts(rows: readonly PurchaseDocumentRow[], next: Purchase): PurchaseDocumentRow[] {
  const byKey = new Map(purchaseLines(next.items).map((i) => [purchaseLineKey(next.uid, i.path), i]));
  return rows.map((row) => {
    if (row.type === "purchase" || row.type === "destination" || row.type === "group") return row;
    const discount = row.price.discount;
    const key = purchaseLineKeyOf(row);
    const item = key === null ? undefined : byKey.get(key);
    const source = item?.price.discount;
    if (!discount || !item || !source || source.rate !== discount.rate || source.type !== discount.type) return row;
    const amount_cents = flatDiscountShare(source, row.quantity, item.quantity);
    if (amount_cents === discount.amount_cents) return row;
    return { ...row, price: { ...row.price, discount: { ...discount, amount_cents } } };
  });
}

/**
 * **The purchase → bill three-way sync** (D5): the order → invoice sync's
 * engine (`syncScopedDestinations`) run on each bill's block for this purchase,
 * with {@link payableScopedSync}. Every rule is the invoice's — synced,
 * overridden, new, left out, removed, moved — so a purchase edit reaches an
 * untouched bill line, leaves an overridden one alone, and adds a new purchase
 * line to every bill it can (the New arm; billing it twice reads as billed >
 * ordered, as on AR). Pure; the writer stores the `changed` bills in the
 * purchase writer's transaction.
 *
 * Skipped whole: a frozen bill (`invoiceIsFrozen`), a voided one, a linked one
 * the writer did not clear ({@link SyncPurchaseToBillsArgs.linked_cleared}), and
 * a bill with no block for this purchase. A changed bill is re-pathed and
 * re-priced whole by `priceDocument` at its own date, and its total is the Σ.
 * Pairs follow the invoice's rule, per field (`syncScopedDestinations`).
 *
 * `total_cents` and `amount_due_cents` move together (an unfrozen bill has no
 * money settlement, so the identity holds with what is due).
 */
export function syncPurchaseToBills(args: SyncPurchaseToBillsArgs): PurchaseBillSync[] {
  const uidPurchase = args.next.uid;
  return args.bills.map((bill) => {
    const untouched = { uid: bill.uid, bill, changed: false };
    if (bill.origin === "linked" && !args.linked_cleared?.has(bill.uid)) return untouched;
    if (!purchaseBillIsLive(bill) || invoiceIsFrozen(bill)) return untouched;
    const start = bill.items.findIndex((r) => r.type === "purchase" && r.uid === uidPurchase);
    if (start < 0) return untouched;
    let end = start + 1;
    while (end < bill.items.length && bill.items[end].path[0] === uidPurchase) end++;
    const scoped = bill.items.slice(start + 1, end);
    const { side, prevItems, nextItems } = payableScopedSync(args.prev, args.next);
    // A dropped pair is the purchase's own removal, so nothing here reports it.
    const { items: synced, destinations } = syncScopedDestinations(
      { items: prevItems, destinations: args.prev.destinations },
      { items: nextItems, destinations: args.next.destinations },
      scoped,
      bill.destinations,
      uidPurchase,
      side,
      PAYABLE_PAIR_SIDE,
      args.time.holidays,
    );
    const rows = computePurchaseDocumentItemPaths([
      ...bill.items.slice(0, start + 1),
      ...reshareDiscounts(synced, args.next),
      ...bill.items.slice(end),
    ]);
    if (purchaseDocumentLines(rows).length === 0 && purchaseDocumentLines(bill.items).length > 0) {
      return { ...untouched, kept_no_lines: true };
    }
    if (sameSharedValue(rows, bill.items) && sameSharedValue(destinations, bill.destinations)) return untouched;
    const priced = priceDocument(rows, {
      document: { kind: "purchase_bill", origin: bill.origin },
      tax: { ...args.tax, asOf: bill.date },
      time: { ...args.time, charge_windows: chargeWindowContext(destinations) },
    });
    return {
      uid: bill.uid,
      bill: { ...bill, items: priced.items, destinations, totals: withTotal(bill.totals, priced.totals.total_cents) },
      changed: true,
    };
  });
}

/**
 * The totals at a new `total_cents`, the identity kept: an unfrozen bill carries
 * no money settlement, so what moves is what is due.
 */
function withTotal(totals: PurchaseBill["totals"], total: number): PurchaseBill["totals"] {
  const settled = totals.amount_paid_cents + totals.amount_credited_cents + totals.amount_void_cents;
  return { ...totals, total_cents: total, amount_due_cents: total - settled };
}

// ── Re-keying payable lines by product (W4K) ─────────────────────

/** A row {@link rekeyPayableLines} re-keys: a payable line or divider, stored or as sent. */
export interface RekeyablePayableRow {
  type: string;
  uid: string;
  path: readonly string[];
  /** A LEGACY pre-W4K row's product key; the re-key reads it from stored history only. */
  uid_product?: string;
}

/** Two rows the re-key puts at one path: a product twice under one parent. */
export interface PayableRekeyCollision {
  /** The later row's index. */
  index: number;
  /** The earlier row already at {@link path}. */
  earlier: number;
  path: string[];
}

/** What {@link rekeyPayableLines} returns. */
export interface PayableLineRekey<T> {
  /** The rows, each line keyed by `payableLineUid` and every path re-derived. */
  items: T[];
  /**
   * The old path → new path correspondence, the shape every pointer rewrite
   * reads (`PathForwardMap`, `./substitutions.ts`). `undefined` for a path no
   * row held; see {@link rekeyPayablePointer} for a pointer at such a path.
   */
  map: PathForwardMap;
  /**
   * Rows whose new path an earlier row already holds. Reported, never merged:
   * whether two lines of one product may become one is the caller's to decide
   * (the migration merges a canceled pair, PO-313, and refuses the rest).
   */
  collisions: PayableRekeyCollision[];
}

// Private, as `./item-pairing.ts`'s joiner is: no path leaves this module as a string.
const rekeyPathKey = (path: readonly string[]): string => path.join("\x1f");

/**
 * Re-key a payable document's lines by product (one-document-model W4K, owner
 * ruling 12, 2026-11-10): the one author the migration and the API writers
 * both call.
 *
 * Each line takes `payableLineUid`: a `sale` or `rental` (and a `replacement`
 * naming a product) its product's uid, anything else a `custom-` uid. Dividers
 * keep theirs. Every path is re-derived as `[...its parent's NEW path, its new
 * uid]`, where the parent is the row at the ORIGINAL path minus self
 * (cfs-items: a uid repeats across parents, so never by uid). So a kit's
 * components follow their re-keyed parent, and a bill's lines keep their
 * leading `purchase` divider. A row whose parent path names no row keeps that
 * prefix verbatim.
 *
 * Pure, and a fixed point: re-keying keyed rows returns them unchanged, with an
 * identity map. Every other key of a row is carried as it is.
 */
export function rekeyPayableLines<T extends RekeyablePayableRow>(items: readonly T[]): PayableLineRekey<T> {
  const forward = new Map<string, string[]>();
  const holder = new Map<string, number>();
  const collisions: PayableRekeyCollision[] = [];
  const rekeyed = items.map((row, index) => {
    const parent = row.path.slice(0, -1);
    const newParent = parent.length === 0 ? [] : forward.get(rekeyPathKey(parent)) ?? [...parent];
    const uid = isPurchaseLine(row) ? payableLineUid(row) : row.uid;
    const path = [...newParent, uid];
    forward.set(rekeyPathKey(row.path), path);
    const at = rekeyPathKey(path);
    const earlier = holder.get(at);
    if (earlier !== undefined) collisions.push({ index, earlier, path: [...path] });
    else holder.set(at, index);
    return { ...row, uid, path };
  });
  return {
    items: rekeyed,
    map: { toPath: (from) => (from === undefined ? undefined : forward.get(rekeyPathKey(from))) },
    collisions,
  };
}

/**
 * Rewrite a stored pointer (`path_purchase_item`, a `substituted_for` entry's
 * `path`, a movement's `path_source_item`, a credit's `path_bill_item`)
 * through a re-key's `map`.
 *
 * A pointer at a row the document still holds maps exactly. One that names a
 * row it no longer holds is legal stored state (a spent `substituted_for`, a
 * move pointer at a removed line), so it is never refused: its longest mapped
 * prefix is rewritten and the rest kept verbatim, and `exact: false` reports
 * it, as `repointExchangedFor` keeps a dangling `exchanged_for`.
 *
 * ⚠️ Pass the map of the document the pointer's path space belongs to: a bill
 * line's `path_purchase_item` and `substituted_for`, and a movement's
 * `path_source_item` (one-document-model ruling 65a), take the PURCHASE's; a credit's `path_bill_item` takes
 * the BILL's.
 */
export function rekeyPayablePointer(map: PathForwardMap, path: readonly string[]): { path: string[]; exact: boolean } {
  const exact = map.toPath(path);
  if (exact !== undefined) return { path: [...exact], exact: true };
  for (let k = path.length - 1; k > 0; k--) {
    const prefix = map.toPath(path.slice(0, k));
    if (prefix !== undefined) return { path: [...prefix, ...path.slice(k)], exact: false };
  }
  return { path: [...path], exact: false };
}
