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
 * path (one-document-model Phase 3). `path_source_item` survives only as a
 * MOVE pointer. Every "which purchase line does this bill" question goes
 * through `purchaseLineKeyOf` (`schemas/purchase-bill.ts`).
 *
 * ## One pricer
 *
 * A payable line's money is written by `priceDocument`'s stated-total arm
 * (`priceStatedTotalLine`): the line states its net in `amount_cents`, and its
 * k-th bill is defaulted by the one line-money function (`lineUnitsCents`),
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
  creditLineBillingPointer,
  type PurchaseRow,
  PurchaseSchema,
  type SubstitutedForEntryType,
  isPurchaseLine,
  purchaseDocumentLines,
  isKitHeaderLine,
  payableLineUid,
  withRowSourcePath,
} from "../schemas/mod.ts";
import {
  lineUnitsCents,
  type PayableMoneyLineLike,
  applyDiscountTerms,
  payableStoredMoney,
  statedLine,
} from "../schemas/_line-money.ts";
import { fitOutOfServiceEntries } from "./replacements.ts";
import type { ExchangedForEntryType, OutOfServiceEntryType } from "../schemas/mod.ts";
import {
  collectSubstitutionAnchors,
  type CreditableRow,
  type PathForwardMap,
  sliceSubstitutedFor,
} from "./substitutions.ts";
import { classifySharedFields, fieldsUnder, sameSharedValue, type SharedField } from "./shared-fields.ts";
import {
  computePurchaseDocumentItemPaths,
  invoiceIsFrozen,
  type LineClaimSide,
  purchaseBillIsLive,
  purchaseCreditIsLive,
  type ScopedPairSide,
  type ScopedSyncSide,
  syncScopedDestinations,
} from "./invoices.ts";
import type { DocumentTotalsCore, LineItem } from "./orders.ts";
import {
  billingRowPart,
  billingRowCreditMoney,
  chargeWindowContext,
  type CreditMoney,
  flatPayablePrice,
  type PartMoney,
  type PayablePriceDocumentContext,
  priceDocument,
  type PricingFormulas,
} from "./price-document.ts";
import { meanTierCounts, type TierCount } from "./price-formulas.ts";
import {
  type AccountedInitiator,
  billedByPath,
  type BilledAtPath,
  type BilledByPath,
  type ExtensionGroup,
  type LineAccount,
  type PayableFoldBill,
  type PayableFoldCredit,
} from "./quantityAccounting.ts";
import { chicagoDayAtTimeOf } from "./dates.ts";

export { purchaseBillIsLive, purchaseCreditIsLive };

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
   * components by ({@link purchaseBillingFold}). Required, so a reader
   * cannot silently stop counting a substitute.
   */
  purchase_items: readonly CreditableRow[];
  bills: readonly (PayableFoldBill & Pick<PurchaseBill, "number" | "totals">)[];
  credits: readonly PayableFoldCredit[];
}

// ── Reading existing coverage ──────────────────────────────────

/** A purchase line's join key — `uid_purchase/...path` — the twin of `purchaseLineKeyOf`. */
export function purchaseLineKey(uidPurchase: string, path: readonly string[]): string {
  return [uidPurchase, ...path].join("/");
}

/** A row's `substituted_for`: only the product arm (a sale or rental line) carries one. */
function substitutedForOf(row: PurchaseDocumentItem): PurchaseDocumentProductItem["substituted_for"] {
  return "substituted_for" in row ? row.substituted_for : undefined;
}

/**
 * Does this purchase line COUNT for coverage — a subrent, charge or replacement
 * line whose purchase was not canceled? A line closed to nothing is removed
 * (ruling 47), so every line still present covered what it covered.
 */
export function purchaseLineCovers(purchase: Pick<Purchase, "status">, item: PurchaseItem): boolean {
  return purchase.status !== "canceled" && item.type !== "sale";
}

/**
 * **A purchase as the billing account reads it** (`accountBilling("payable", …)`,
 * `accountInitiator`): its uid, its rows and its pairs. A purchase row is not an
 * order line by type, though the fold reads only what both carry, so the one
 * cast lives here rather than at every payable caller. Pass the purchase with
 * its open hires CLIPPED at the document date when the account must meter them.
 */
export function purchaseInitiator(purchase: Pick<Purchase, "uid" | "items" | "destinations">): AccountedInitiator {
  return { uid: purchase.uid, items: purchase.items as unknown as readonly LineItem[], destinations: purchase.destinations };
}

/**
 * **The billing fold over one purchase's documents** (6e-0b2 F3): what every
 * bill and supplier credit bills at each purchase-relative path, net of credits,
 * UNFLOORED — `billedByPath("payable", …)`, the AR fold's rules on this side.
 * Read `byPath.get(path.join("/"))` for a line's `{ quantity, amount_cents }`:
 * lines join on the full path under the purchase, because one product may sit on
 * two lines. A negative is a credit with no live bill left under it, which the
 * diff has to be able to show. Liveness is the fold's.
 */
export function purchaseBillingFold(documents: PurchaseBilledDocuments): BilledByPath {
  return billedByPath(
    "payable",
    { uid: documents.uid_purchase, items: documents.purchase_items as readonly LineItem[] },
    documents.bills,
    documents.credits,
  );
}

// ── Billing a time line: unbilled units first, then owed time (6e-0b2 F5) ──

/** {@link splitBillTime}'s answer: where a bill's units of one TIME purchase line go. */
export interface BillTimeSplit {
  /** Units billed at the line's own path: its never-billed units, then any past every owed group (over-billing, D5). */
  own: number;
  /** Owed extension groups the bill takes, oldest `billed_end` first, each with the units taken. */
  extensions: { group: ExtensionGroup; quantity: number }[];
}

/**
 * **Split a bill's `quantity` of one TIME purchase line** by the line's account
 * (one-document-model 6e-0b2 F5; owner 2026-11-15, "unbilled first"): the
 * line's never-billed units first ({@link LineAccount.remaining}`.units`), then
 * its owed extension groups, oldest `billed_end` first, each taking at most its
 * own units. Units past both bill at the line's own path: over-billing is legal
 * (D5) and the diff reports it.
 *
 * The account must be built over the purchase with its open hires CLIPPED at
 * the bill date (the bill's pairs), or an open hire's pair meters nothing and
 * nothing is ever owed.
 *
 * @returns `null` when neither covers a single unit: there is nothing unbilled,
 *   which the bill writer refuses by name
 * @throws Error when a taken group was billed by a substitute: an extension on a
 *   substituted line cannot be built yet, as on the receivable side (manager#414)
 */
export function splitBillTime(line: LineAccount, quantity: number): BillTimeSplit | null {
  let left = quantity;
  const unbilled = Math.min(left, Math.max(0, line.remaining.units));
  left -= unbilled;
  const extensions: BillTimeSplit["extensions"] = [];
  const owed = [...line.remaining.owed].sort((a, b) => Date.parse(a.billed_end) - Date.parse(b.billed_end));
  for (const group of owed) {
    if (left <= 0) break;
    const take = Math.min(left, group.quantity);
    if (take <= 0) continue;
    if (group.via === "substitute") {
      throw new Error(
        `Purchase line ${line.item.name} was billed by a substitute; an extension on a substituted line cannot be built yet (manager#414)`,
      );
    }
    extensions.push({ group, quantity: take });
    left -= take;
  }
  if (unbilled === 0 && extensions.length === 0) return null;
  return { own: unbilled + left, extensions };
}

/** One purchase line's owed time a bill takes: the line and {@link splitBillTime}'s extensions for it. */
export interface BillExtensionTake {
  item: PurchaseItem;
  extensions: BillTimeSplit["extensions"];
}

/**
 * **A bill's date-extension sections** (ruling 89; F5): the extra time a bill
 * takes on lines earlier bills already billed, as the receivable remainder
 * builds it. One section per destination and billed window: a destination
 * divider at `[purchase, E]` carrying `path_extension_for: [destination]`, the
 * group dividers above each line, and each line at `[purchase, E, ...its path
 * below the destination]` with `quantity` the units taken and `counts` the
 * group's `extension_counts` (priced with no minimum: `priceDocument` reads the
 * section off the divider). Its pair is the destination's, windowed from the day
 * after the group's `billed_end` to the end of the destination's CLIPPED
 * windows.
 *
 * @param purchase - The purchase with its open hires clipped at the bill date (the bill's pairs)
 * @param takes - Per line, the owed groups {@link splitBillTime} took
 * @param mintUid - Mints each section divider's uid
 * @returns Rows to append to the purchase's block (dividers first, in path
 *   order), and the pairs their sections name; empty when nothing is taken
 */
export function billExtensionSections(
  purchase: Pick<Purchase, "uid" | "items" | "destinations">,
  takes: readonly BillExtensionTake[],
  mintUid: () => string = () => crypto.randomUUID(),
): { items: PurchaseDocumentRow[]; destinations: PurchaseDocDestination[] } {
  const P = purchase.uid;
  const items: PurchaseDocumentRow[] = [];
  const destinations: PurchaseDocDestination[] = [];
  const byKey = new Map(purchase.items.map((r) => [r.path.join("/"), r]));
  /** Per destination, its sections: one billed window set and end each, one entry per line. */
  const sections = new Map<string, Array<{ group: ExtensionGroup; entries: Array<{ item: PurchaseItem; quantity: number; group: ExtensionGroup }> }>>();
  for (const take of takes) {
    const destination = take.item.path[0];
    for (const { group, quantity } of take.extensions) {
      const list = sections.get(destination) ?? sections.set(destination, []).get(destination)!;
      let section = list.find((s) =>
        s.group.billed_end === group.billed_end && sameWindowDates(s.group.billed_set, group.billed_set) &&
        !s.entries.some((e) => e.item.path.join("/") === take.item.path.join("/"))
      );
      if (section === undefined) list.push(section = { group, entries: [] });
      section.entries.push({ item: take.item, quantity, group });
    }
  }
  for (const [destination, list] of sections) {
    const divider = byKey.get(destination);
    const pair = purchase.destinations.find((d) => d.uid === destination);
    const windows = pair?.dates.charge_windows ?? null;
    if (divider === undefined || divider.type !== "destination" || pair === undefined || windows === null || windows.length === 0) {
      throw new Error(`billExtensionSections: destination ${destination} of purchase ${P} states no charge window to extend`);
    }
    for (const section of list) {
      const E = mintUid();
      items.push({ ...divider, uid: E, path: [P, E], path_extension_for: [destination] } as PurchaseDocumentRow);
      const placedGroups = new Set<string>();
      for (const entry of section.entries) {
        // The group dividers between the destination and the line, carried once per section.
        for (let k = 2; k < entry.item.path.length; k++) {
          const ancestor = byKey.get(entry.item.path.slice(0, k).join("/"));
          if (ancestor === undefined || ancestor.type !== "group" || placedGroups.has(ancestor.uid)) continue;
          placedGroups.add(ancestor.uid);
          items.push({ ...ancestor, path: [P, E, ...ancestor.path.slice(1)] } as PurchaseDocumentRow);
        }
        const line = projectPurchaseLineToBillLine(entry.item, {
          uid_purchase: P,
          quantity: entry.quantity,
          from: 0,
          counts: [...entry.group.extension_counts],
        });
        // An extension bills more days of a leg; it is not an exchange, so it keeps no
        // take-back list (and its pair's `exchange` is cleared below), as on AR.
        const { exchanged_for: _notAnExchange, ...extended } = line as PurchaseDocumentItem & { exchanged_for?: unknown };
        items.push({ ...extended, path: [P, E, ...entry.item.path.slice(1)] } as PurchaseDocumentItem);
      }
      const start = chicagoDayAtTimeOf(section.group.billed_end, 1, windows[0].start);
      const end = windows[windows.length - 1].end;
      destinations.push({
        ...purchasePairForBill(pair, P),
        uid: E,
        ...("exchange" in pair ? { exchange: null } : {}),
        dates: { ...pair.dates, charge_windows: [{ start, end }] },
      });
    }
  }
  return { items, destinations };
}

/**
 * **The counts a supplier credit of `quantity` units of one TIME purchase line
 * takes back by default** (owner 2026-11-15, "newest time first"): the line's
 * billed groups ({@link LineAccount.extension}`.billed`), most recently billed
 * first, take the credited units, and the credit row states their
 * QUANTITY-WEIGHTED MEAN counts (`meanTierCounts`). One row prices
 * `rates × mean × quantity`, which is exactly the sum over the groups taken,
 * because counts are rationals; a row per group would collide at the line's one
 * path. Units past everything billed take the mean too (an over-credit, which
 * the diff shows).
 *
 * Build the account over the purchase CLIPPED at the credit date, as the bill
 * writer does, or an open hire's pair meters nothing and no group is billed.
 *
 * @returns `null` when no time is billed on the line: there is nothing to take back
 */
export function creditTimeCounts(line: LineAccount, quantity: number): TierCount[] | null {
  const newestFirst = [...line.extension.billed].sort((a, b) => Date.parse(b.billed_end) - Date.parse(a.billed_end));
  const taken: { quantity: number; counts: readonly TierCount[] }[] = [];
  let left = quantity;
  for (const group of newestFirst) {
    if (left <= 0) break;
    const take = Math.min(left, group.quantity);
    if (take > 0) taken.push({ quantity: take, counts: group.billed_counts });
    left -= take;
  }
  return taken.length === 0 ? null : meanTierCounts(taken);
}

/** Two window sets name the same dates, in order. */
function sameWindowDates(a: readonly { start: string; end: string }[], b: readonly { start: string; end: string }[]): boolean {
  return a.length === b.length && a.every((w, i) => Date.parse(w.start) === Date.parse(b[i].start) && Date.parse(w.end) === Date.parse(b[i].end));
}

// ── Money ───────────────────────────────────────────────────────

export type { CreditMoney, PartMoney } from "./price-document.ts";

/**
 * **Units `(from, to]` of a source line, as a part stores them** (D7): its
 * slices of the source's stored gross and discount cents, and the net as their
 * difference — the one part door ({@link billingRowPart}). A part never
 * re-applies a rate, so the parts of a line sum to it exactly on every figure
 * and each part's own `net = gross − discount` holds.
 */
export function partMoney(
  line: PayableMoneyLineLike & { price: { discount: DiscountType | null } },
  from: number,
  to: number,
): PartMoney {
  const slice = billingRowPart(line, from, to);
  const terms = line.price.discount;
  return {
    amount_cents: slice.net_cents,
    stated_cents: slice.gross_cents,
    discount: terms === null ? null : { ...terms, amount_cents: slice.discount_cents },
  };
}

/** Is a stored row's money exactly `part`? Gross (stated, or net + cents), cents and net. */
function moneyIs(row: PayableMoneyLineLike & { price: { discount: DiscountType | null } }, part: PartMoney): boolean {
  const own = payableStoredMoney(row);
  return row.amount_cents === part.amount_cents && own.gross_cents === part.stated_cents &&
    own.discount_cents === (part.discount?.amount_cents ?? 0);
}

/**
 * **What a supplier credit of `n` flat units is worth, when it names no bill
 * line** (api-cloudrun#1439) — a share of the line's billed POOL
 * (the fold's `{ quantity, amount_cents }` at the line, {@link purchaseBillingFold}:
 * live bills less live credits), never of the PO line,
 * so an edited bill strands nothing.
 *
 * - The pool's LAST `n` units of a PSEUDO-line, the pool's net over its units
 *   (`statedLine`): crediting the whole pool returns exactly its money, and
 *   successive credits sum to it. The pool is net, so no discount is inherited.
 * - `memo_cents`: the supplier's memo governs, refused above the pool, because
 *   an operator typed it.
 *
 * A credit that names a bill line is priced by {@link billLineCreditParts}
 * instead (one-document-model 6d): from that line, not the pool.
 *
 * @throws {RangeError} when `n` is outside `1..pool quantity`, the pool holds no
 *   money, or a memo exceeds the pool
 */
export function billedPoolCreditMoney(args: {
  pool: Pick<BilledAtPath, "quantity" | "amount_cents">;
  n: number;
  memo_cents?: number;
}): CreditMoney {
  const { pool, n, memo_cents } = args;
  if (!Number.isInteger(n) || n < 1 || n > pool.quantity) {
    throw new RangeError(`crediting ${n} exceeds the ${pool.quantity} billed`);
  }
  if (pool.amount_cents <= 0) throw new RangeError("this line's billed pool holds no money to credit");
  if (memo_cents !== undefined) {
    if (memo_cents > pool.amount_cents) {
      throw new RangeError(`a credit of ${memo_cents} cents exceeds the ${pool.amount_cents} cents billed`);
    }
    return { amount_cents: memo_cents, discount: null, stated_cents: memo_cents, units_from: null };
  }
  const net = lineUnitsCents(statedLine(pool.amount_cents, pool.quantity), pool.quantity - n, pool.quantity);
  return { amount_cents: net, discount: null, stated_cents: net, units_from: null };
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
 * `uidBill`** — every live credit line naming that `(uid_billing,
 * path_billing_item)`. The per-line half of the credit cap (one-document-model 6d),
 * the twin of AR's `creditableLines` prior-note sum.
 *
 * **The CREDITED view of the one credit fold** (ruling 84): marker-free, every
 * non-void credit — the same liveness the AR cap reads (`creditableLines`). The
 * REVERSED view is the billing fold's ({@link purchaseBillingFold}), gated on `reverses_billing`.
 * A supplier credit has no draft state, so non-void is "issued or applied",
 * exactly AR's netting liveness.
 *
 * ⚠️ Keyed on the pointer as written, which goes stale when the bill row moves
 * (owner ruling 22, as `path_billing_item` does on AR): a credit raised before a
 * move then no longer counts against the row. The pool cap
 * ({@link purchaseBillingFold}) still sees it.
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
      if (!isPurchaseLine(line)) continue;
      const pointer = creditLineBillingPointer(line);
      if (pointer === null || pointer.uid !== uidBill || pointer.path.join("/") !== key) continue;
      out.quantity += line.quantity;
      out.amount_cents += line.amount_cents;
    }
  }
  return out;
}

/**
 * **What a supplier credit of `n` units of one bill line is worth**
 * (one-document-model 6d, owner 2026-11-11; D4 2026-11-13): units `(c, c + n]`
 * of the line, `c` the units live credits already took (`billLineCredited`),
 * priced FIRST-COME by the one line-money function (`lineUnitsCents`), so
 * crediting a line in parts sums to exactly its amount — $100.00 over 3 units
 * credited one at a time is 3333 + 3334 + 3333, never 9999. The credit line
 * INHERITS the row's discount terms, its record over the same units (D4).
 *
 * The payable door onto {@link billingRowCreditMoney}, the one first-come
 * function both sides price a credit of a billing row through (F14 item 6).
 *
 * - `memo_cents`: the supplier's memo governs, refused above what is left of
 *   the line's money, and is stored as the credit line's `price.stated_cents`.
 * - The first-come share is capped at what is left of the line's money, so a
 *   line part-credited by a memo cannot be over-credited.
 *
 * @throws {RangeError} when `n` is outside `1..units left`, or a memo exceeds
 *   the money left
 */
export function billLineCreditMoney(args: {
  line: PayableMoneyLineLike & { amount_cents: number; price: { discount: DiscountType | null } };
  credited: BillLineCredited;
  n: number;
  memo_cents?: number;
}): CreditMoney {
  const { line, ...rest } = args;
  return billingRowCreditMoney({ side: "payable", row: line, ...rest });
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
  /** Their money, first-come, and the discount record they inherit (D4). */
  amount_cents: number;
  /** The row's discount terms, its slice of the row's cents over these units; `null` on a memo. */
  discount: DiscountType | null;
  /** The credit line's gross: its slice of the row's, or the memo (D4, D7). */
  stated_cents: number;
  /** The first unit of the row this part covers; `null` on a memo. */
  units_from: number | null;
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
 *   left, a memo exceeds the money left, or a kit's credit states a memo (a kit
 *   is priced from its rows)
 */
export function billLineCreditParts(args: {
  bill: Pick<PurchaseBill, "uid" | "items">;
  path: readonly string[];
  n: number;
  credits: readonly Pick<PurchaseCredit, "status" | "items">[];
  /** Keys (`path.join("/")`, purchase-relative) of the purchase's rows. */
  purchaseKeys: ReadonlySet<string>;
  /** The supplier's memo for the root row: its credit line's `price.stated_cents` (D4). */
  memo_cents?: number;
}): BillLineCreditPart[] {
  const { bill, path, n, credits, purchaseKeys, memo_cents } = args;
  const key = path.join("/");
  const root = bill.items.find((r): r is PurchaseDocumentItem => isPurchaseLine(r) && r.path.join("/") === key);
  if (root === undefined) throw new RangeError(`bill has no line at ${key}`);
  const subtree = substituteKitSubtree(bill.items, path);
  if (subtree.length > 0 && memo_cents !== undefined) {
    throw new RangeError("a substitute kit's credit is priced from its rows, so it states no amount");
  }
  const c = billLineCredited(bill.uid, path, credits).quantity;
  const part = (line: PurchaseDocumentItem, from: number, to: number): BillLineCreditPart => {
    const credited = billLineCredited(bill.uid, line.path, credits);
    const m = to - from;
    const live = (substitutedForOf(line) ?? []).filter((e) => purchaseKeys.has(e.path.join("/")));
    const money = billLineCreditMoney({
      line,
      credited,
      n: m,
      ...(line === root && memo_cents !== undefined ? { memo_cents } : {}),
    });
    return { line, credited, n: m, ...money, substituted_for: sliceSubstitutedFor(live, from, to) };
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
    ...exchangedForProjection(item),
  };
}

/**
 * An exchange line's take-back list on its bill line (C16, ruling 82):
 * purchase-relative, as on the purchase, and presence-faithful — a purchase `[]`
 * stays `[]`, an absent key stays absent — so no stored bill key set moves.
 */
function exchangedForProjection(item: PurchaseItem): { exchanged_for?: ExchangedForEntryType[] } {
  return item.type === "rental" && item.exchanged_for !== undefined
    ? { exchanged_for: item.exchanged_for.map((e) => ({ ...e, path: [...e.path] })) }
    : {};
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
   * The unit the share starts after. A new bill continues where the line's
   * billing stands: the ACTED billed units (`actedBilledUnits` over
   * {@link purchaseBillingFold}, ruling 42). The sync's projector passes `0`:
   * it projects the WHOLE line, as an order line projects whole. A TIME line
   * reads nothing from it; its callers pass `0`. Required, so no caller falls
   * back on a stored count.
   */
  from: number;
  /**
   * A TIME line's counts to bill: an extension row's added counts
   * ({@link billExtensionSections}), or a credit's ({@link creditTimeCounts}).
   * Absent: `[]`, and `priceDocument` meters the bill's pair instead.
   */
  counts?: TierCount[];
}

/**
 * **Default a bill line from its purchase line** (D5). Name, formula, discount
 * terms, posting and attribution are the purchase line's (each then
 * overridable on the bill until it settles). The amount is `quantity` units of
 * the line from `from` (where its billing stands), by the one line-money
 * function (`lineUnitsCents`, defined past the ordered count because
 * over-billing is legal), so the bills of a line sum to its `amount_cents`.
 *
 * The money is the slice `(before, before + quantity]` of the line's stored
 * gross and discount cents ({@link partMoney}, D7), and the line records
 * `units_from: before`, so the sync can tell it still is that slice.
 *
 * The line's price is built by `flatPayablePrice` (the stated-total arm), so
 * the projection parses on its own; the writer prices the whole document with
 * `priceDocument`, which states the same money and the line's `taxes_base`.
 *
 * A TIME line projects unpriced, with the caller's `counts` seed, if any
 * ({@link ProjectBillLineOptions.counts}); the writer's `priceDocument` prices it.
 */
export function projectPurchaseLineToBillLine(
  item: PurchaseItem,
  opts: ProjectBillLineOptions,
): PurchaseDocumentItem {
  if (item.price.price_formula.basis === "time") return projectTimeLine(item, opts);
  const before = opts.from;
  const part = partMoney(item, before, before + opts.quantity);
  const amount_cents = part.amount_cents;
  const price: PurchaseDocumentLinePrice = flatPayablePrice({
    uid: item.uid,
    quantity: opts.quantity,
    stated_cents: part.stated_cents,
    price_formula: item.price.price_formula,
    discount: part.discount,
    taxes: item.price.taxes,
    taxes_base: item.price.taxes_base,
  });
  return {
    type: item.type,
    ...projectedLineHead(item, opts.uid_purchase),
    ...attributionOf(item, opts.quantity),
    quantity: opts.quantity,
    amount_cents,
    units_from: before,
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
 * **A credit line copied from a BILL ROW sits under that bill's `billing`
 * divider** (ruling 107): its path is `[bill uid, ...the bill row's path]`,
 * one block per bill in order of first appearance, after the unpointed lines'
 * block (nothing but another billing divider closes a billing level). So a
 * credit naming two bills of one purchase line holds both rows; placed by
 * purchase-local path alone, one overwrote the other. Each line is written on
 * the pointer's new spelling, `uid_billing` + `path_billing_item`.
 *
 * Inside a bill's block a line keeps the bill row's path (one-document-model
 * 6d, ruling 23; owner 2026-11-11), even where the purchase has no row there: a
 * W5 substitute, a bill-authored charge, a row the bill moved. Its dividers come
 * from the bill, which `opts.bills` must carry: one the purchase holds is taken
 * as above, and one the BILL authored (a group, or a destination with its pair)
 * is copied from the bill. The line goes at the end of its parent's direct lines
 * (ahead of a destination's first group, as a divider closes every level below
 * it), so the credit shows the bill's tree. A block's pairs are the bill's own
 * where it authored them, else the purchase's.
 *
 * @throws when a line names a bill `opts.bills` does not carry, or a row that
 *   bill does not hold
 */
export function purchaseDocumentScope(
  purchase: Pick<Purchase, "uid" | "number" | "items" | "destinations">,
  lines: readonly PurchaseDocumentItem[],
  opts: { bills?: readonly Pick<PurchaseBill, "uid" | "number" | "items" | "destinations">[] } = {},
): { items: PurchaseDocumentRow[]; destinations: PurchaseDocDestination[] } {
  for (const line of lines) {
    if (line.path[0] !== purchase.uid) {
      throw new Error(`purchaseDocumentScope: line ${line.uid} is not under purchase ${purchase.uid}`);
    }
  }
  const unpointed = lines.filter((line) => creditLineBillingPointer(line) === null);
  const byBill = Map.groupBy(lines.filter((line) => creditLineBillingPointer(line) !== null), (line) =>
    creditLineBillingPointer(line)!.uid);
  const rows: PurchaseDocumentRow[] = [];
  const pairs: PurchaseDocDestination[] = [];
  const addPairs = (more: readonly PurchaseDocDestination[]) => {
    for (const pair of more) if (!pairs.some((p) => p.uid === pair.uid)) pairs.push(pair);
  };
  if (unpointed.length > 0 || byBill.size === 0) {
    const block = purchaseScopeBlock(purchase, unpointed, null);
    rows.push(...block.rows);
    addPairs(block.pairs);
  }
  for (const [uidBill, billLines] of byBill) {
    const bill = opts.bills?.find((b) => b.uid === uidBill);
    if (bill === undefined) {
      throw new Error(`purchaseDocumentScope: line ${billLines[0].uid} names bill ${uidBill}, which was not passed`);
    }
    const block = purchaseScopeBlock(purchase, billLines, bill);
    rows.push(billingDivider(bill));
    for (const row of block.rows) {
      const path = [bill.uid, ...row.path];
      if (!isPurchaseLine(row)) {
        rows.push({ ...row, path });
        continue;
      }
      rows.push({ ...row, path });
    }
    addPairs(block.pairs);
  }
  return { items: computePurchaseDocumentItemPaths(rows), destinations: pairs };
}

/**
 * A bill's `billing` divider on a supplier credit (ruling 107): the shared arm,
 * its uid the bill's, its name machine-written.
 */
function billingDivider(bill: Pick<PurchaseBill, "uid" | "number">): PurchaseDocumentRow {
  return { uid: bill.uid, type: "billing", name: `Bill #${bill.number}`, path: [bill.uid], description: "" };
}

/**
 * One block of {@link purchaseDocumentScope}: the purchase divider, the dividers
 * above `lines`, the lines, and their pairs, at purchase-relative paths. `bill`
 * is the bill the lines all name, or null for lines naming none.
 */
function purchaseScopeBlock(
  purchase: Pick<Purchase, "uid" | "number" | "items" | "destinations">,
  lines: readonly PurchaseDocumentItem[],
  bill: Pick<PurchaseBill, "uid" | "items" | "destinations"> | null,
): { rows: PurchaseDocumentRow[]; pairs: PurchaseDocDestination[] } {
  const byLocal = new Map<string, PurchaseDocumentItem>();
  const own: PurchaseDocumentItem[] = [];
  const fromBill: PurchaseDocumentItem[] = [];
  for (const line of lines) {
    const local = line.path.slice(1).join("/");
    const onPurchase = purchase.items.some((r) => r.path.join("/") === local);
    if (onPurchase) byLocal.set(local, line);
    else if (bill !== null) fromBill.push(line);
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
    if (bill === null) continue;
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
      rows.push(strandedUnderLine ? withRowSourcePath(line, row.path) : line);
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
    rows,
    pairs: [
      ...purchase.destinations.filter((d) => dividers.has(d.uid)).map((d) => ({ uid_source: purchase.uid, ...d })),
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
 * **A purchase line in a BILL line's shape, over the shared keys only, fitted
 * to a bill row's quantity** — the purchase ↔ bill DIFF's projection
 * (`DIFF_SIDES.payable.line.projectLine`, `utils/documentDiff.ts`).
 *
 * ⚠️ Not the sync's: the sync projects the whole line from unit 0
 * ({@link projectPurchaseRowForBill}) and merges `quantity`, the money and
 * `out_of_service` as one `flat_money` group, so a partial bill keeps all of
 * them. The diff ignores groups, so it fits the projection to the row's
 * quantity instead: the discount record becomes that quantity's share and
 * `out_of_service` that quantity's records, and only a row naming different
 * records from its purchase line reports.
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
      discount: partMoney(item, 0, quantity).discount,
    },
    ...attributionOf(item, quantity),
    ...exchangedForProjection(item),
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
 * `path_source_item` move pointer, {@link projectPurchaseRowForBill} and the
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
        // Still exactly its slice of the line at its own units (D7)? Then the slice at the new count.
        const from = row.units_from ?? 0;
        if (moneyIs(row, partMoney(line, from, from + row.quantity))) {
          return withPart(row, quantity, partMoney(line, from, from + quantity), from);
        }
      }
      if (scaleFrom !== undefined && scaleFrom > 0 && scaleFrom !== quantity) {
        // A pseudo-source: the row's own stored money over the count it had, rescaled.
        const own = { ...row, quantity: scaleFrom };
        return withPart(row, quantity, partMoney(own, 0, quantity), row.units_from ?? null);
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
 * the pair scoped by `uid_source` (ruling 109), the invoice pair's twin.
 */
function purchasePairForBill(pair: PurchaseDestination, uidPurchase: string): PurchaseDocDestination {
  return { uid_source: uidPurchase, ...pair };
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
  fields: purchaseBillSharedPairFields,
  project: purchasePairForBill,
};

/**
 * The payable side of `orderLineClaimIssues`: a bill or credit's move
 * pointer (`path_source_item`, ruling 109). A line closed to 0 is removed (ruling 47), so there is
 * no closed line to refuse: a claim on it names a row that is not there, as on
 * the receivable side.
 */
export const PAYABLE_LINE_CLAIMS: LineClaimSide<PurchaseRow> = {
  scopeType: "purchase",
};

/** A row at `quantity` units carrying `part` (D7). */
function withPart<R extends PurchaseDocumentItem>(row: R, quantity: number, part: PartMoney, from: number | null): R {
  return {
    ...row,
    quantity,
    amount_cents: part.amount_cents,
    ...(from !== null ? { units_from: from } : {}),
    price: { ...row.price, stated_cents: part.stated_cents, discount: part.discount },
  };
}

/**
 * **The merge rule, applied to a PART** (one-document-model D7): a bill line
 * that was exactly its slice of the PREVIOUS purchase line — money and discount
 * terms — becomes its slice of the NEXT one at the same units; anything else is
 * the operator's and stays — except that terms the merge moved onto a line whose
 * money is its own are applied to that line's own gross, the one rate event
 * (`applyDiscountTerms`). The engine cannot do this itself: a part never
 * equals the whole-line projection, and its discount cents are derived, so the
 * engine keeps a part's money whatever the purchase did. A discount that newly
 * reaches a part thus lands as the part's slice, and a price or terms edit on the
 * purchase reaches every untouched bill of it.
 *
 * `units_from` absent reads as 0: a bill written before D7 behaves as it did.
 */
function followPurchaseSlices(
  synced: readonly PurchaseDocumentRow[],
  scoped: readonly PurchaseDocumentRow[],
  prev: Purchase,
  next: Purchase,
): PurchaseDocumentRow[] {
  const lineAt = (p: Purchase) => new Map(purchaseLines(p.items).map((i) => [purchaseLineKey(p.uid, i.path), i]));
  const before = lineAt(prev);
  const after = lineAt(next);
  const held = new Map(scoped.filter(isPurchaseLine).map((r) => [r.path.join("/"), r as PurchaseDocumentItem]));
  return synced.map((row) => {
    if (!isPurchaseLine(row) || row.price.price_formula.basis === "time") return row;
    const key = purchaseLineKeyOf(row);
    const was = held.get(row.path.join("/"));
    const p = key === null ? undefined : before.get(key);
    const n = key === null ? undefined : after.get(key);
    if (!was || !p || !n || purchaseItemBasis(p) !== "flat" || purchaseItemBasis(n) !== "flat") return row;
    const from = was.units_from ?? 0;
    const termsOf = (d: DiscountType | null) => (d === null ? null : `${d.type}:${d.rate}`);
    const sameTerms = termsOf(was.price.discount) === termsOf(p.price.discount);
    if (!sameTerms || !moneyIs(was, partMoney(p, from, from + was.quantity))) {
      // The line's money is its own. If the merge moved its terms (they were
      // untouched), that is a rate event on the line's OWN gross (D7).
      const terms = row.price.discount;
      if (termsOf(terms) === termsOf(was.price.discount)) return row;
      const gross = payableStoredMoney(was).gross_cents;
      const applied = applyDiscountTerms(gross, row.quantity, terms === null ? null : { rate: terms.rate, type: terms.type });
      return withPart(row as PurchaseDocumentItem, row.quantity, { ...applied, stated_cents: gross }, null);
    }
    const part = partMoney(n, from, from + row.quantity);
    if (moneyIs(row, part) && (row.price.discount?.rate ?? null) === (n.price.discount?.rate ?? null)) return row;
    return withPart(row as PurchaseDocumentItem, row.quantity, part, from);
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
      ...followPurchaseSlices(synced, scoped, args.prev, args.next),
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
      bill: { ...bill, items: priced.items, destinations, totals: withTotal(bill.totals, priced.totals) },
      changed: true,
    };
  });
}

/**
 * The totals at a new pricing, the identity kept: an unfrozen bill carries no
 * money settlement, so what moves is what is due. The breakdown keys come with
 * the total (ruling 105, {@link billTotalsBreakdown}).
 */
function withTotal(totals: PurchaseBill["totals"], priced: DocumentTotalsCore): PurchaseBill["totals"] {
  const settled = totals.amount_paid_cents + totals.amount_credited_cents + totals.amount_void_cents;
  return {
    ...totals,
    ...billTotalsBreakdown(priced),
    total_cents: priced.total_cents,
    amount_due_cents: priced.total_cents - settled,
  };
}

/**
 * **The one author of a bill's breakdown keys** (ruling 105, one totals shape per
 * role): the invoice's five, read off `priceDocument`'s stage-5 sum. Every bill
 * writer spreads it beside the settlement keys; a writer that only refolds the
 * journal carries the stored ones.
 */
export function billTotalsBreakdown(
  priced: DocumentTotalsCore,
): Required<Pick<PurchaseBill["totals"], "subtotal_cents" | "subtotal_discounted_cents" | "discount_amount_cents" | "taxes" | "transaction_fees">> {
  return {
    subtotal_cents: priced.subtotal_cents,
    subtotal_discounted_cents: priced.subtotal_discounted_cents,
    discount_amount_cents: priced.discount_amount_cents,
    taxes: priced.taxes,
    transaction_fees: priced.transaction_fees,
  };
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
 * Rewrite a stored pointer (a bill line's `path_source_item`, a `substituted_for`
 * entry's `path`, a movement's `path_source_item`, a credit's `path_billing_item`)
 * through a re-key's `map`.
 *
 * A pointer at a row the document still holds maps exactly. One that names a
 * row it no longer holds is legal stored state (a spent `substituted_for`, a
 * move pointer at a removed line), so it is never refused: its longest mapped
 * prefix is rewritten and the rest kept verbatim, and `exact: false` reports
 * it, as `repointExchangedFor` keeps a dangling `exchanged_for`.
 *
 * ⚠️ Pass the map of the document the pointer's path space belongs to: a bill
 * line's `path_source_item` and `substituted_for`, and a movement's
 * `path_source_item` (one-document-model ruling 65a), take the PURCHASE's; a credit's `path_billing_item` takes
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
