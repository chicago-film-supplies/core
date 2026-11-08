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
  type PurchaseDocDestination,
  type PurchaseDocumentItem,
  type PurchaseDocumentLinePrice,
  type PurchaseDocumentRow,
  type PurchaseItem,
  purchaseItemBasis,
  purchaseLines,
  purchaseItemCanceled,
  purchaseLineKeyOf,
  type PurchaseRow,
  PurchaseSchema,
} from "../schemas/mod.ts";
import { cumulativeShareCents } from "./purchases.ts";
import { roundDivHalfUp } from "./money.ts";
import { classifySharedFields, fieldsUnder, sameSharedValue, type SharedField } from "./shared-fields.ts";
import {
  computePurchaseDocumentItemPaths,
  invoiceIsFrozen,
  purchaseBillIsLive,
  type ScopedSyncSide,
  syncScopedBillingItems,
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
import { combineTierCounts, type TierCount } from "./price-formulas.ts";

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
  bills: readonly Pick<PurchaseBill, "uid" | "number" | "totals" | "items" | "status">[];
  credits: readonly Pick<PurchaseCredit, "status" | "items">[];
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

/** The lines of a document that bill the purchase line at `key` ({@link purchaseLineKey}). */
function linesFor(rows: readonly PurchaseDocumentRow[], key: string): PurchaseDocumentItem[] {
  const out: PurchaseDocumentItem[] = [];
  for (const row of rows) {
    if (row.type === "purchase" || row.type === "destination" || row.type === "group") continue;
    if (purchaseLineKeyOf(row) === key) out.push(row);
  }
  return out;
}

/**
 * Does this purchase line COUNT for coverage — a subrent, charge or replacement
 * line whose purchase was not canceled and which was not canceled in full with
 * nothing billed (`purchaseItemCanceled`: it never happened)? A closed or
 * completed line still covered what it covered.
 */
export function purchaseLineCovers(purchase: Pick<Purchase, "status">, item: PurchaseItem): boolean {
  return purchase.status !== "canceled" && item.type !== "sale" && !purchaseItemCanceled(item);
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
  const key = purchaseLineKey(documents.uid_purchase, path);
  const net: PurchaseLineBilledNet = { quantity: 0, amount_cents: 0 };
  const add = (rows: readonly PurchaseDocumentRow[], sign: 1 | -1) => {
    for (const line of linesFor(rows, key)) {
      net.quantity += sign * line.quantity;
      net.amount_cents += sign * line.amount_cents;
    }
  };
  for (const bill of documents.bills) if (purchaseBillIsLive(bill)) add(bill.items, 1);
  for (const credit of documents.credits) if (purchaseCreditIsLive(credit)) add(credit.items, -1);
  return net;
}

/**
 * **The counts the live documents bill of one TIME purchase line, net of
 * credits** — Σ live bill line `counts` − Σ live credit line `counts`, tier by
 * tier (`combineTierCounts`), joined on the purchase line key as
 * {@link purchaseLineBilledNet} is. Unfloored, like it.
 */
export function purchaseLineBilledCounts(path: readonly string[], documents: PurchaseBilledDocuments): TierCount[] {
  const key = purchaseLineKey(documents.uid_purchase, path);
  let net: TierCount[] = [];
  const add = (rows: readonly PurchaseDocumentRow[], sign: 1 | -1) => {
    for (const line of linesFor(rows, key)) net = combineTierCounts(net, line.price.counts, sign);
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
  const metered = meteredLineCounts(asEngineSource(args.item), {
    charge_windows: statedChargeWindows(args.purchase.destinations),
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
 * ⚠️ `quantity_billed` is unlike its sibling buckets. `quantity_received` and
 * `quantity_returned` are kept by delta, because a receipt's quantity never
 * changes; a bill line's does, so a delta here releases the wrong number on a
 * void. Pass EVERY bill and credit of the purchase, including the one the
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
 * **What a supplier credit of `n` flat units is worth** (api-cloudrun#1439) — a
 * share of the line's billed POOL (`purchaseLineBilledNet`: live bills less live
 * credits), never of the PO line, so an edited bill strands nothing.
 *
 * - No bill line named: the pool's share of its last `n` units. Crediting the
 *   whole pool returns exactly its money, and successive credits sum to it.
 * - A bill line named: that line's rate for `n` units, so a credit raised from a
 *   bill is not blended across bills at different prices.
 * - `stated_cents`: the supplier's memo governs.
 *
 * **The pool caps all three.** A named rate above the pool is capped, a stated
 * amount above it refused, because an operator typed that one.
 *
 * @throws {RangeError} when `n` is outside `1..pool quantity`, the pool holds no
 *   money, or a stated amount exceeds the pool
 */
export function purchaseLineCreditCents(args: {
  pool: PurchaseLineBilledNet;
  n: number;
  bill_line?: { quantity: number; amount_cents: number };
  stated_cents?: number;
}): number {
  const { pool, n, bill_line, stated_cents } = args;
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
  if (bill_line !== undefined) {
    const named = Number(roundDivHalfUp(BigInt(bill_line.amount_cents) * BigInt(n), BigInt(bill_line.quantity)));
    return Math.min(named, pool.amount_cents);
  }
  return flatShareCents(pool.amount_cents, pool.quantity, pool.quantity - n, pool.quantity);
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
 * What a purchase line's bill line attributes: the product a sale or rental
 * orders, or a service's optional product, and a replacement's record.
 */
function attributionOf(item: PurchaseItem): { uid_product?: string; uid_out_of_service?: string } {
  switch (item.type) {
    case "sale":
    case "rental":
      return { uid_product: item.uid_product };
    case "service":
      return item.uid_product !== undefined ? { uid_product: item.uid_product } : {};
    case "replacement":
      return {
        ...(item.uid_product !== undefined ? { uid_product: item.uid_product } : {}),
        uid_out_of_service: item.uid_out_of_service,
      };
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
    ...attributionOf(item),
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
  const head = { ...projectedLineHead(item, opts.uid_purchase), ...attributionOf(item), quantity: opts.quantity, amount_cents: 0, price };
  switch (item.type) {
    case "sale":
    case "rental":
      return { type: item.type, ...head, uid_product: item.uid_product };
    case "service":
      return { type: "service", ...head };
    case "replacement":
      return { type: "replacement", ...head, uid_out_of_service: item.uid_out_of_service };
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
 */
export function purchaseDocumentScope(
  purchase: Pick<Purchase, "uid" | "number" | "items" | "destinations">,
  lines: readonly PurchaseDocumentItem[],
): { items: PurchaseDocumentRow[]; destinations: PurchaseDocDestination[] } {
  const byLocal = new Map<string, PurchaseDocumentItem>();
  const own: PurchaseDocumentItem[] = [];
  for (const line of lines) {
    if (line.path[0] !== purchase.uid) {
      throw new Error(`purchaseDocumentScope: line ${line.uid} is not under purchase ${purchase.uid}`);
    }
    const local = line.path.slice(1).join("/");
    const onPurchase = purchase.items.some((r) => r.path.join("/") === local);
    if (onPurchase) byLocal.set(local, line);
    else own.push(line);
  }
  // Every ancestor path of a billed line, so the dividers above it come along.
  const wanted = new Set<string>();
  for (const local of byLocal.keys()) {
    const parts = local.split("/");
    for (let k = 1; k < parts.length; k++) wanted.add(parts.slice(0, k).join("/"));
  }
  const rows: PurchaseDocumentRow[] = [purchaseScopeDivider(purchase), ...own];
  for (const row of purchase.items) {
    const local = row.path.join("/");
    if (row.type === "destination" || row.type === "group") {
      if (wanted.has(local)) rows.push({ ...row, path: [purchase.uid, ...row.path] });
      continue;
    }
    const line = byLocal.get(local);
    if (line) rows.push(line);
  }
  const dividers = new Set(rows.filter((r) => r.type === "destination").map((r) => r.uid));
  return {
    items: computePurchaseDocumentItemPaths(rows),
    destinations: purchase.destinations.filter((d) => dividers.has(d.uid)).map((d) => ({ uid_purchase: purchase.uid, ...d })),
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
 * The fields a TIME line merges: the shared set without `amount_cents`, and
 * with `quantity` out of the `flat_money` group. A time line's amount is
 * DERIVED from its counts (`priceDocument`'s pushed time arm), as an order
 * line's money is, so it is re-priced rather than compared, and its quantity
 * follows on its own as an order line's does.
 */
function timeLineFields(): readonly SharedField[] {
  if (timeFields !== null) return timeFields;
  timeFields = purchaseBillSharedLineFields()
    .filter((f) => f.path !== "amount_cents")
    .map((f) => (f.group === undefined ? f : { path: f.path, kind: f.kind }));
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
    ...attributionOf(item),
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
 * (`syncScopedBillingItems`, `@cfs/core/utils/invoices`): the purchase → bill
 * sync IS the order → invoice sync, with a `purchase` scope divider, the
 * `path_purchase_item` move pointer, {@link projectPurchaseRowForBill} and the
 * purchase ↔ bill field set (one-document-model Phase 3).
 *
 * Built per sync over the two purchase revisions it converts
 * ({@link asEngineSource}): the engine hands its projector the converted rows,
 * and the side maps each back to the purchase row it came from.
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
   * What a touched bill's TIME lines meter with — the formulas and holidays;
   * each bill's own pairs supply the windows. Required only when the purchase
   * carries a time line.
   */
  time?: { formulas: PricingFormulas; holidays: readonly string[] };
}

/**
 * The bill's pairs for one purchase block after a purchase edit: a pair
 * follows its destination divider (kept exactly when the divider is), and a
 * kept pair follows the purchase's pair WHOLE when the bill still holds the
 * previous purchase's pair, else keeps its own. Whole, not per leaf: a payable
 * pair's `dates` carries derived `_fs` mirrors and day counts, and a per-leaf
 * merge would need the receivable side's holiday-aware window resolution for
 * pairs that are, today, almost all the store with no window. A deliberate
 * simplification, stated here so it is not mistaken for the invoice's rule.
 */
function syncScopePairs(
  prev: Purchase,
  next: Purchase,
  bill: PurchaseBill,
  items: readonly PurchaseDocumentRow[],
): PurchaseDocDestination[] {
  const uidPurchase = next.uid;
  const dividers = new Set(
    items.filter((r) => r.type === "destination" && r.path[0] === uidPurchase).map((r) => r.uid),
  );
  const others = bill.destinations.filter((d) => d.uid_purchase !== uidPurchase);
  const stored = new Map(bill.destinations.filter((d) => d.uid_purchase === uidPurchase).map((d) => [d.uid, d]));
  const prevPairs = new Map(prev.destinations.map((d) => [d.uid, d]));
  const nextPairs = new Map(next.destinations.map((d) => [d.uid, d]));
  const mine: PurchaseDocDestination[] = [];
  for (const uid of dividers) {
    const own = stored.get(uid);
    const p = prevPairs.get(uid);
    const n = nextPairs.get(uid);
    if (own === undefined) {
      if (n !== undefined) mine.push({ uid_purchase: uidPurchase, ...n });
      continue;
    }
    const { uid_purchase: _scope, ...ownPair } = own;
    if (n !== undefined && p !== undefined && sameSharedValue(ownPair, p)) mine.push({ uid_purchase: uidPurchase, ...n });
    else mine.push(own);
  }
  return [...others, ...mine];
}

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
 * engine (`syncScopedBillingItems`) run on each bill's block for this purchase,
 * with {@link payableScopedSync}. Every rule is the invoice's — synced,
 * overridden, new, left out, removed, moved — so a purchase edit reaches an
 * untouched bill line, leaves an overridden one alone, and adds a new purchase
 * line to every bill it can (the New arm; billing it twice reads as billed >
 * ordered, as on AR). Pure; the writer stores the `changed` bills in the
 * purchase writer's transaction.
 *
 * Skipped whole: a linked bill (Xero is authoritative), a frozen one
 * (`invoiceIsFrozen`), a voided one, and a bill with no block for this
 * purchase. A changed bill is re-pathed and re-priced whole by `priceDocument`
 * at its own date, and its total is the Σ.
 *
 * `total_cents` and `amount_due_cents` move together (an unfrozen bill has no
 * money settlement, so the identity holds with what is due).
 */
export function syncPurchaseToBills(args: SyncPurchaseToBillsArgs): PurchaseBillSync[] {
  const uidPurchase = args.next.uid;
  return args.bills.map((bill) => {
    const untouched = { uid: bill.uid, bill, changed: false };
    if (bill.origin !== "pushed" || !purchaseBillIsLive(bill) || invoiceIsFrozen(bill)) return untouched;
    const start = bill.items.findIndex((r) => r.type === "purchase" && r.uid === uidPurchase);
    if (start < 0) return untouched;
    let end = start + 1;
    while (end < bill.items.length && bill.items[end].path[0] === uidPurchase) end++;
    const scoped = bill.items.slice(start + 1, end);
    const { side, prevItems, nextItems } = payableScopedSync(args.prev, args.next);
    const synced = syncScopedBillingItems(prevItems, nextItems, scoped, uidPurchase, side);
    const rows = computePurchaseDocumentItemPaths([
      ...bill.items.slice(0, start + 1),
      ...reshareDiscounts(synced, args.next),
      ...bill.items.slice(end),
    ]);
    const destinations = syncScopePairs(args.prev, args.next, bill, rows);
    if (sameSharedValue(rows, bill.items) && sameSharedValue(destinations, bill.destinations)) return untouched;
    const priced = priceDocument(rows, {
      document: { kind: "purchase_bill", origin: "pushed" },
      tax: { ...args.tax, asOf: bill.date },
      ...(args.time ? { time: { ...args.time, charge_windows: chargeWindowContext(destinations) } } : {}),
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
