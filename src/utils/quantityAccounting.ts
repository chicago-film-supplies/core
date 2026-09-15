/**
 * **Quantity accounting** — how much of an order line its invoices have billed,
 * and what is left to bill (api-cloudrun#680, manager#414).
 *
 * ## One sum, computed on read, never stored (owner decision D3, 2026-09-13)
 *
 * > billed quantity at an order path = Σ over non-void, aligned invoices of
 * > (line quantity at that path + substitution quantities naming it)
 *
 * Nothing stores this number, so there is no second writer and no denorm to
 * drift — the `Order.invoices[]` status-drift class. A `quantity_invoiced` field
 * on order lines was rejected for exactly that reason.
 *
 * Its readers: `computeDocumentDiffs`'s "billed N of M" entry, the
 * remaining-invoice create mode (via {@link remainingForOrder}), and the
 * coverage census.
 *
 * ## Substitutions, as the documents carry them today
 *
 * Today a substitute Y carries one `path_substituted_for` naming X's order path,
 * and Y replaces X in place. So:
 *
 * - **Y's row quantity counts in full toward X.** Y's own path is not an order
 *   path and receives nothing, and Y's components (which exist on no order
 *   line) count toward nothing.
 * - **X's components are credited through the ORDER's own stored ratio** —
 *   `credit × component quantity ÷ kit quantity`, walked down the order's path
 *   tree, rounded half-up once per level. Never the catalog: optional and
 *   variable components make catalog derivation wrong (D1). A full swap credits
 *   every component exactly its order quantity, so the rounding only ever bites
 *   a partial swap.
 * - **A spent anchor is not a substitution** — {@link liveInvoiceAnchors}
 *   drops an anchor whose Y the order now carries itself, and that row then
 *   counts at its own path like any other.
 *
 * Track S (manager#414) replaces `path_substituted_for` with
 * `substituted_for[].quantity`; only {@link billedByPath}'s substitution input
 * changes then, not this module's contract.
 *
 * ## Dates are money, not quantity (D4)
 *
 * An order whose dates were extended after it was billed has no quantity left to
 * bill and still has money left to bill. That remainder is each billed row priced
 * as a D7 EXTENSION (api-cloudrun#997): for
 * `max(order charge days, 5) − max(billed charge days, 5)` days with the
 * one-week minimum skipped, through `priceDocument`'s line pricer — so it is
 * exactly what an extension section on an invoice bills (#997 D11).
 *
 * 🔴 **Never price "the extra days" as an ordinary line.** `five_day_week` floors
 * at one week, so `price(3 days)` charges a week the billed row already paid.
 * The D7 day count floors each SIDE at the week instead, and skips the floor on
 * the difference. A `fixed` row never read its days and extends by nothing.
 *
 * **A bill of the extension nets it out.** A line in an invoice's
 * date-extension section (`path_extension_for`) reaches {@link billedByPath} as
 * an `extension` row at the path it extends: it adds no units, and
 * {@link accountLine} subtracts its money, priced at its own added days, from
 * what the order's days add to the unit rows.
 *
 * ⚠️ **The date input is `price.chargeable_days`, not the destination pair's
 * dates.** The pair's dates are its upstream: `syncChargeDaysToItems` writes the
 * pair's charge days onto every line still on the default, and an operator can
 * override a line's days by hand. The pricer reads the line, so the line is what
 * was billed and the line is what the order now asks for — a hand-held line
 * whose days did not move correctly reports no extension.
 *
 * ## Money is PRE-TAX, in integer cents
 *
 * Every cent figure here is `subtotal_discounted_cents`: the invoice writer that
 * bills a remainder materializes tax on the line it builds, per destination, and
 * pricing tax here would restate `priceDocument`'s tax stage. Each amount is one
 * pricer result, rounded once (`cfs-money`).
 *
 * Signed on purpose: a negative quantity or extension is OVER-billing (the order
 * went down, or its dates shortened, after billing). That is a credit-note
 * question rather than a remainder, and it is the caller's to decide — this
 * reports it rather than clamping it away.
 *
 * Pure: no reads.
 *
 * @module
 */
import type { InvoiceStatusType } from "../schemas/mod.ts";
import { isLineItemType } from "../schemas/mod.ts";
import {
  extensionSectionTargets,
  getOrderScopedItems,
  type InvoiceItem,
  invoiceScopeDividersMatch,
  isInExtensionSection,
  liveInvoiceAnchors,
  toOrderRelativePath,
} from "./invoices.ts";
import { isPreTaxItem, type LineItem } from "./orders.ts";
import { extensionChargeDays, priceLine } from "./price-document.ts";

/** The invoice shape these functions read — every linked invoice, live or void. */
export interface AccountedInvoice {
  uid: string;
  status: InvoiceStatusType;
  items: InvoiceItem[];
}

/** One invoice row that bills an order path. */
export interface BilledRow {
  invoiceUid: string;
  item: InvoiceItem;
  /**
   * `direct` — the row sits at the order path itself. `substitute` — the row is
   * a substitute Y whose live anchor names this order path. `extension` — the
   * row sits in a date-extension section extending this path: it bills DAYS on
   * units other rows billed, so it adds no quantity (api-cloudrun#680 R1).
   */
  via: "direct" | "substitute" | "extension";
}

/** What the invoices bill at one order-relative path. */
export interface BilledAtPath {
  /** Units billed: direct rows, substitute rows, and ratio credit from a substituted kit above. */
  quantity: number;
  /** The rows that bill this path. Empty for a component credited only through its kit's substitute. */
  rows: BilledRow[];
}

/** @see {@link billedByPath} */
export interface BilledByPath {
  /** Keyed by the order-relative `path.join("/")`. A path with nothing billing it has no entry. */
  byPath: Map<string, BilledAtPath>;
  /** Non-void invoices whose scope was summed. */
  compared: string[];
  /** Non-void invoices whose scope is hung on a different divider skeleton, and was NOT summed. */
  unaligned: string[];
}

const key = (path: readonly string[]): string => path.join("/");

/**
 * How much each order path is billed, summed across every non-void, aligned
 * invoice (D3).
 *
 * ⚠️ **An unaligned scope is left out of the sum and named in `unaligned`**;
 * this does not fail closed on its own, because `computeDocumentDiffs`
 * reports an unaligned scope as its own entry and still compares the aligned
 * ones. A caller about to ACT on the sum — {@link remainingForOrder} — must
 * refuse when `unaligned` is non-empty: an unaligned scope's lines are
 * uncounted, so everything it bills reads unbilled.
 *
 * An invoice line at a path the order does not carry is still keyed here; it is
 * the order's absence, not the sum's, that makes it unmatched.
 *
 * @param orderUid - The order's uid, which is its divider's uid on every invoice
 * @param orderItems - The order's CURRENT `items`, dividers included
 * @param invoices - Every invoice linked to the order, live or void
 */
export function billedByPath(
  orderUid: string,
  orderItems: readonly LineItem[],
  invoices: readonly AccountedInvoice[],
): BilledByPath {
  const byPath = new Map<string, BilledAtPath>();
  const compared: string[] = [];
  const unaligned: string[] = [];
  const at = (k: string): BilledAtPath => {
    let entry = byPath.get(k);
    if (!entry) byPath.set(k, entry = { quantity: 0, rows: [] });
    return entry;
  };

  /** Units credited to an order path through a substitute, before the ratio walk. */
  const substituteCredit = new Map<string, number>();

  for (const invoice of invoices) {
    if (invoice.status === "void") continue;
    const scoped = getOrderScopedItems(invoice.items ?? [], orderUid);
    if (scoped.length > 0 && !invoiceScopeDividersMatch(scoped, orderItems as LineItem[], orderUid)) {
      unaligned.push(invoice.uid);
      continue;
    }
    compared.push(invoice.uid);
    const anchors = liveInvoiceAnchors(scoped, orderItems, orderUid);
    const extensionTargets = extensionSectionTargets(scoped, orderUid);
    for (const item of scoped) {
      if (!isLineItemType(item.type)) continue;
      if (isInExtensionSection(item.path ?? [], orderUid, extensionTargets)) {
        at(key(toOrderRelativePath(item.path ?? [], orderUid, extensionTargets))).rows.push({
          invoiceUid: invoice.uid,
          item,
          via: "extension",
        });
        continue;
      }
      const rel = (item.path ?? []).slice(1);
      const anchor = anchors.find((a) => key(a.path) === key(rel));
      if (anchor) {
        const x = key(anchor.substitutedFor);
        at(x).rows.push({ invoiceUid: invoice.uid, item, via: "substitute" });
        substituteCredit.set(x, (substituteCredit.get(x) ?? 0) + (item.quantity ?? 0));
        continue;
      }
      // A substitute's own components stand in for nothing on the order.
      if (anchors.some((a) => rel.length > a.path.length && key(rel.slice(0, a.path.length)) === key(a.path))) continue;
      const entry = at(key(rel));
      entry.rows.push({ invoiceUid: invoice.uid, item, via: "direct" });
      entry.quantity += item.quantity ?? 0;
    }
  }

  // Walk the order top-down: a line's credit is what substitutes name it plus
  // its kit parent's credit scaled by the order's own component ratio. Paths are
  // depth-first contiguous, so a parent's credit is final before its children.
  const credit = new Map<string, number>();
  const quantityAt = new Map<string, number>();
  for (const item of orderItems) {
    if (!isLineItemType(item.type)) continue;
    const path = item.path ?? [];
    const k = key(path);
    const quantity = item.quantity ?? 0;
    quantityAt.set(k, quantity);
    const parent = key(path.slice(0, -1));
    const parentCredit = credit.get(parent) ?? 0;
    const parentQuantity = quantityAt.get(parent) ?? 0;
    const inherited = parentCredit > 0 && parentQuantity > 0
      ? Math.floor((2 * parentCredit * quantity + parentQuantity) / (2 * parentQuantity))
      : 0;
    const own = (substituteCredit.get(k) ?? 0) + inherited;
    if (own === 0 && !(parentCredit > 0)) continue;
    credit.set(k, own);
    at(k).quantity += own;
  }
  // A substitute naming an X the order no longer carries (a dangling anchor)
  // still bills that path; the walk above only reached paths the order has.
  for (const [k, units] of substituteCredit) {
    if (!quantityAt.has(k)) at(k).quantity += units;
  }

  return { byPath, compared, unaligned };
}

/** @see {@link accountLine} */
export interface LineAccount {
  /** The order line's quantity. */
  ordered: number;
  /** Units billed across the invoices (0 when nothing bills the path). */
  billed: number;
  /** `ordered − billed`. Negative is over-billing. */
  quantity: number;
  /** Pre-tax cents for `quantity` units at the order line's current terms. Signed with `quantity`. */
  quantity_cents: number;
  /**
   * Pre-tax cents the order's current `chargeable_days` add to the rows already
   * billed. Negative when the days shortened.
   */
  extension_cents: number;
}

/**
 * `subtotal_discounted_cents` of a line, or 0 for a line that is not priced
 * pre-tax — through `priceDocument`'s line pricer (#997 D11), so a remainder is
 * priced by the same author as the document that will bill it.
 *
 * The line's tax refs are dropped first: only the pre-tax subtotal is read, and
 * the pricer resolves every ref it is handed against the catalog it is given.
 */
function subtotalCents(item: LineItem, extensionDays?: number): number {
  if (!isPreTaxItem(item)) return 0;
  const untaxed = { ...item, price: { ...item.price, taxes: [] } } as LineItem;
  return priceLine(untaxed, [], extensionDays).subtotal_discounted_cents;
}

/**
 * Account for one order line against what the invoices bill at its path.
 *
 * @param orderLine - The order line, at its current quantity and `chargeable_days`
 * @param billed - {@link billedByPath}'s entry for the line's path, if any
 */
export function accountLine(orderLine: LineItem, billed: BilledAtPath | undefined): LineAccount {
  const ordered = orderLine.quantity ?? 0;
  const billedUnits = billed?.quantity ?? 0;
  const quantity = ordered - billedUnits;

  // The pricer rounds a non-negative quantity; an over-billed remainder is
  // priced at its magnitude and given back its sign.
  const quantityCents = quantity === 0 ? 0 : Math.sign(quantity) * subtotalCents({ ...orderLine, quantity: Math.abs(quantity) });

  // What the order's days add to the rows that billed units, less what
  // extension sections already billed for those days. A section extending a
  // 3-day bill to 7 stores 2 added days, which prices exactly what the unit row
  // is owed, so the two cancel.
  let extensionCents = 0;
  const orderDays = orderLine.price?.chargeable_days ?? 0;
  if (isPreTaxItem(orderLine)) {
    for (const row of billed?.rows ?? []) {
      if (!isPreTaxItem(row.item)) continue;
      // A `fixed` row has no day count to extend: its price never read the days.
      if (row.item.price.formula !== "five_day_week") continue;
      if (row.via === "extension") {
        extensionCents -= subtotalCents(row.item, row.item.price.chargeable_days ?? 0);
        continue;
      }
      const days = extensionChargeDays(orderDays, row.item.price.chargeable_days ?? 0);
      if (days === 0) continue;
      extensionCents += subtotalCents(row.item, days);
    }
  }

  return { ordered, billed: billedUnits, quantity, quantity_cents: quantityCents, extension_cents: extensionCents };
}

/** One order line with something left to bill, or billed beyond the order. */
export interface RemainingLine extends LineAccount {
  /** The order-relative path — the line's identity on the order. */
  path: string[];
  item: LineItem;
  /** Nothing on any compared invoice bills this path: the line comes in whole. */
  new: boolean;
}

/** @see {@link remainingForOrder} */
export interface RemainingForOrder {
  lines: RemainingLine[];
  compared: string[];
  /** Non-empty ⇒ `lines` is empty: the sum would under-count, so nothing is computed. */
  unaligned: string[];
}

/**
 * What is left to bill on an order: new lines in full, quantity deltas at
 * existing paths, and date-extension money on rows already billed (D4).
 *
 * 🔴 **Fails closed on any unaligned scope** — `lines` comes back empty and the
 * uids are in `unaligned`. A remainder built over a partial sum bills again
 * whatever the unaligned invoice already billed.
 *
 * Every order LINE is considered, dividers never. A line whose quantity and
 * extension are both zero is omitted; a negative one (over-billing) is returned,
 * for the caller to route to a credit note rather than a remainder.
 *
 * @param orderUid - The order's uid
 * @param orderItems - The order's CURRENT `items`, dividers included
 * @param invoices - Every invoice linked to the order, live or void — ALL of them, never a page
 */
export function remainingForOrder(
  orderUid: string,
  orderItems: readonly LineItem[],
  invoices: readonly AccountedInvoice[],
): RemainingForOrder {
  const billed = billedByPath(orderUid, orderItems, invoices);
  if (billed.unaligned.length > 0) return { lines: [], compared: billed.compared, unaligned: billed.unaligned };
  const lines: RemainingLine[] = [];
  for (const item of orderItems) {
    if (!isLineItemType(item.type)) continue;
    const path = item.path ?? [];
    const at = billed.byPath.get(key(path));
    const account = accountLine(item, at);
    if (account.quantity === 0 && account.extension_cents === 0) continue;
    lines.push({ ...account, path, item, new: at === undefined });
  }
  return { lines, compared: billed.compared, unaligned: [] };
}
