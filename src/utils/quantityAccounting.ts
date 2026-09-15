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
import type { DocDestinationType, InvoiceDocDestinationType, InvoiceDocItemType, InvoiceStatusType } from "../schemas/mod.ts";
import { isLineItemType } from "../schemas/mod.ts";
import {
  extensionSectionTargets,
  getOrderScopedItems,
  type InvoiceItem,
  invoiceScopeDividersMatch,
  isInExtensionSection,
  liveInvoiceAnchors,
  projectOrderItemToInvoiceItem,
  toInvoiceDestinationPair,
  toOrderRelativePath,
} from "./invoices.ts";
import { addChicagoDays } from "./dates.ts";
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

  // What the order's days add to the units already billed, each group priced as
  // the ONE extension line that would bill it — so a remainder invoice built
  // from {@link extensionGroups} nets this to exactly zero, cent for cent.
  let extensionCents = 0;
  for (const group of extensionGroups(orderLine, billed)) {
    extensionCents += subtotalCents({ ...group.item, quantity: group.quantity } as LineItem, group.extension_days);
  }

  return { ordered, billed: billedUnits, quantity, quantity_cents: quantityCents, extension_cents: extensionCents };
}

/** Units billed at one cumulative day count, still owed (or over-billed) an extension. */
export interface ExtensionGroup {
  /** The billed row whose terms (rate, discount) the extension is priced on. */
  item: LineItem;
  /** `direct` or `substitute`, from the row that billed the units. */
  via: "direct" | "substitute";
  /** Units in the group. */
  quantity: number;
  /** Charge days billed so far: the row's own, plus every extension applied to these units. */
  billed_days: number;
  /** `extensionChargeDays(order days, billed_days)`. Never 0; negative is a shortening. */
  extension_days: number;
  /** The invoice section that last billed these units: `[invoiceUid, section divider uid]`. */
  section: [string, string];
}

/**
 * The extension still owed on an order line, as groups of billed units that
 * share their terms and their cumulative billed days (api-cloudrun#680 R1).
 *
 * The walk: every `five_day_week` unit row starts a group at its own
 * `chargeable_days`. Each extension row then moves its quantity from the groups
 * with the FEWEST billed days, in invoice order, to
 * `max(days, 5) + added days`. A remainder invoice brings every group to the
 * order's days at once, so a later remainder always extends from a single
 * cumulative count per window; the fewest-first rule only has to choose for an
 * extension built by hand. Extension quantity beyond the units billed is
 * ignored.
 *
 * A `fixed` row never read its days, so it forms no group. A group whose
 * extension is zero is dropped.
 */
export function extensionGroups(orderLine: LineItem, billed: BilledAtPath | undefined): ExtensionGroup[] {
  if (!isPreTaxItem(orderLine)) return [];
  const orderDays = orderLine.price?.chargeable_days ?? 0;
  const groups: Array<Omit<ExtensionGroup, "extension_days">> = [];
  const extensions: BilledRow[] = [];
  for (const row of billed?.rows ?? []) {
    if (!isPreTaxItem(row.item) || row.item.price.formula !== "five_day_week") continue;
    if (row.via === "extension") {
      extensions.push(row);
      continue;
    }
    const quantity = row.item.quantity ?? 0;
    if (quantity <= 0) continue;
    groups.push({
      item: row.item,
      via: row.via,
      quantity,
      billed_days: row.item.price.chargeable_days ?? 0,
      section: [row.invoiceUid, (row.item.path ?? [])[1] ?? ""],
    });
  }
  for (const row of extensions) {
    let left = row.item.quantity ?? 0;
    const added = row.item.price?.chargeable_days ?? 0;
    const section: [string, string] = [row.invoiceUid, (row.item.path ?? [])[1] ?? ""];
    while (left > 0) {
      const open = groups.filter((g) => g.quantity > 0);
      if (open.length === 0) break;
      const fewest = open.reduce((a, b) => (b.billed_days < a.billed_days ? b : a));
      const moved = Math.min(left, fewest.quantity);
      const billedDays = Math.max(fewest.billed_days, 5) + added;
      fewest.quantity -= moved;
      left -= moved;
      const same = groups.find((g) =>
        g.item === fewest.item && g.billed_days === billedDays && g.section[0] === section[0] && g.section[1] === section[1]
      );
      if (same) same.quantity += moved;
      else groups.push({ ...fewest, quantity: moved, billed_days: billedDays, section });
    }
  }
  return groups
    .filter((g) => g.quantity > 0)
    .map((g) => ({ ...g, extension_days: extensionChargeDays(orderDays, g.billed_days) }))
    .filter((g) => g.extension_days !== 0);
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

// ── The remainder invoice (api-cloudrun#680 R1) ─────────────────

/** The order fields {@link buildRemainingInvoice} reads. */
export interface RemainingOrderSource {
  uid: string;
  number: number;
  items: readonly LineItem[];
  destinations: readonly DocDestinationType[];
}

/** An invoice as {@link buildRemainingInvoice} reads it: its lines, and the pairs that date its sections. */
export interface RemainingInvoiceSource extends AccountedInvoice {
  destinations?: readonly InvoiceDocDestinationType[];
}

/** @see {@link buildRemainingInvoice} */
export interface RemainingInvoice {
  /** The order divider, then the order's scope. Empty when `unaligned` is non-empty or nothing remains. */
  items: InvoiceDocItemType[];
  /** Every order pair, then one pair per extension section. */
  destinations: InvoiceDocDestinationType[];
  /** The order lines and extension groups billed BEYOND the order: a credit note's to settle, never this invoice's. */
  overbilled: { path: string[]; quantity: number; extension_days: number }[];
  compared: string[];
  unaligned: string[];
}

/**
 * Build the invoice that bills what is left on an order: new lines whole,
 * quantity increases at their own path, and each extension of dates as a
 * date-extension section (owner decisions, 2026-09-13 and 2026-09-15).
 *
 * The one builder, shared by `POST /invoices { remaining_of_order }` (which
 * rebuilds it from EVERY sibling invoice and ignores the client's items) and the
 * manager's preview.
 *
 * - **Every order divider is carried**, empty or not: alignment compares the
 *   whole divider skeleton, so a remainder without it would be unaligned and
 *   bill everything again on the next remainder.
 * - **An ancestor of a billed line is carried at quantity 0** when it has
 *   nothing of its own left (owner, 2026-09-15). `path` is resolved from the
 *   parent, so a component without its kit would bill a different path.
 * - **One extension section per billed window**: per order destination, the
 *   groups of {@link extensionGroups} that share their billed days. Its divider
 *   is a new uid carrying `path_extension_for`; each line in it is the billed
 *   row's terms at the group's added days. A path already in the section (the
 *   same product billed on different terms) opens another section.
 * - **Its pair** is the order's pair re-keyed to the section, charging from the
 *   day after the billed window's `charge_end` to the order's. The `_fs`
 *   companion of a moved `charge_start` is `null` here: the writer stamps it,
 *   because a utility cannot mint a Firestore Timestamp.
 * - **Over-billing is never netted in.** A negative quantity or extension is
 *   returned in `overbilled`, for the credit-note flow.
 *
 * 🔴 Fails closed on an unaligned scope, exactly as {@link remainingForOrder}.
 *
 * @throws Error when an extension is owed on a unit a SUBSTITUTE billed: the
 *   extension line would price the substitute at the replaced line's path, and
 *   substitution merges (manager#414) have not settled what that row is.
 */
export function buildRemainingInvoice(
  order: RemainingOrderSource,
  invoices: readonly RemainingInvoiceSource[],
  mintUid: () => string = () => crypto.randomUUID(),
): RemainingInvoice {
  const O = order.uid;
  const billed = billedByPath(O, order.items, invoices);
  const empty = { items: [], destinations: [], overbilled: [], compared: billed.compared, unaligned: billed.unaligned };
  if (billed.unaligned.length > 0) return empty;

  const orderLines = order.items.filter((it) => isLineItemType(it.type));
  const overbilled: RemainingInvoice["overbilled"] = [];
  /** Order path key → units this invoice bills at order terms. */
  const units = new Map<string, number>();
  /** Order destination uid → extension groups owed under it. */
  const owed = new Map<string, Array<{ line: LineItem; group: ExtensionGroup }>>();

  for (const line of orderLines) {
    const path = line.path ?? [];
    const at = billed.byPath.get(key(path));
    const quantity = (line.quantity ?? 0) - (at?.quantity ?? 0);
    if (quantity > 0) units.set(key(path), quantity);
    if (quantity < 0) overbilled.push({ path: [...path], quantity, extension_days: 0 });
    for (const group of extensionGroups(line, at)) {
      if (group.extension_days < 0) {
        overbilled.push({ path: [...path], quantity: group.quantity, extension_days: group.extension_days });
        continue;
      }
      if (group.via === "substitute") {
        throw new Error(
          `Order line ${line.name} was billed by a substitute; an extension on a substituted line cannot be built yet (manager#414)`,
        );
      }
      const destination = path[0];
      if (!owed.has(destination)) owed.set(destination, []);
      owed.get(destination)!.push({ line, group });
    }
  }

  if (units.size === 0 && owed.size === 0) return { ...empty, overbilled };

  const isAncestorOf = (candidate: readonly string[], keys: Iterable<string>): boolean => {
    const prefix = key(candidate) + "/";
    for (const k of keys) if (k.startsWith(prefix)) return true;
    return false;
  };

  const orderDivider = { uid: O, type: "order", name: `Order #${order.number}`, description: "", path: [O] } as InvoiceDocItemType;
  const items: InvoiceDocItemType[] = [orderDivider];
  for (const item of order.items) {
    if (!isLineItemType(item.type)) {
      items.push(projectOrderItemToInvoiceItem(item as LineItem, O));
      continue;
    }
    const k = key(item.path ?? []);
    const quantity = units.get(k) ?? (isAncestorOf(item.path ?? [], units.keys()) ? 0 : undefined);
    if (quantity === undefined) continue;
    items.push(projectOrderItemToInvoiceItem({ ...item, quantity } as LineItem, O));
  }

  const pairs = order.destinations.map((pair) => toInvoiceDestinationPair(O, pair));
  const extensionPairs: InvoiceDocDestinationType[] = [];
  const pairOf = (invoiceUid: string, sectionUid: string) =>
    invoices.find((inv) => inv.uid === invoiceUid)?.destinations?.find((p) => p.uid === sectionUid && p.uid_order === O);

  for (const [destination, entries] of owed) {
    const divider = order.items.find((it) => it.type === "destination" && it.uid === destination);
    const orderPair = order.destinations.find((pair) => pair.uid === destination);
    if (!divider || !orderPair) continue;

    /** One section: its billed days, and the entries keyed by order path. */
    const sections: Array<{ billedDays: number; extensionDays: number; byPath: Map<string, { line: LineItem; group: ExtensionGroup }> }> = [];
    for (const entry of entries) {
      const k = key(entry.line.path ?? []);
      let section = sections.find((s) => s.billedDays === entry.group.billed_days && !s.byPath.has(k));
      if (!section) {
        section = { billedDays: entry.group.billed_days, extensionDays: entry.group.extension_days, byPath: new Map() };
        sections.push(section);
      }
      section.byPath.set(k, entry);
    }

    for (const section of sections) {
      const E = mintUid();
      items.push({
        ...projectOrderItemToInvoiceItem(divider as LineItem, O),
        uid: E,
        path: [O, E],
        path_extension_for: [destination],
      } as InvoiceDocItemType);
      for (const item of order.items) {
        const path = item.path ?? [];
        if (path[0] !== destination || item.type === "destination") continue;
        const k = key(path);
        const entry = section.byPath.get(k);
        if (!entry && !isAncestorOf(path, section.byPath.keys())) continue;
        const scoped = [O, E, ...path.slice(1)];
        if (!isLineItemType(item.type)) {
          items.push({ ...projectOrderItemToInvoiceItem(item as LineItem, O), path: scoped } as InvoiceDocItemType);
          continue;
        }
        // A billed group prices on the row that billed it; an ancestor bills
        // nothing, and states the section's days only because every line in an
        // extension section must.
        const source = entry ? entry.group.item : item;
        const projected = projectOrderItemToInvoiceItem({
          ...source,
          uid: item.uid,
          path,
          quantity: entry ? entry.group.quantity : 0,
          price: { ...source.price, formula: "five_day_week", chargeable_days: section.extensionDays },
        } as LineItem, O);
        items.push({ ...projected, path: scoped } as InvoiceDocItemType);
      }

      const billedEnds = [...section.byPath.values()]
        .map(({ group }) => pairOf(group.section[0], group.section[1])?.dates?.charge_end ?? null)
        .filter((end): end is string => end !== null)
        .sort((a, b) => Date.parse(a) - Date.parse(b));
      const billedEnd = billedEnds.at(-1);
      const projectedPair = toInvoiceDestinationPair(O, orderPair);
      extensionPairs.push({
        ...projectedPair,
        uid: E,
        dates: {
          ...projectedPair.dates,
          ...(billedEnd ? { charge_start: addChicagoDays(billedEnd, 1), charge_start_fs: null } : {}),
          days_charged: section.extensionDays,
        },
      });
    }
  }

  return { items, destinations: [...pairs, ...extensionPairs], overbilled, compared: billed.compared, unaligned: [] };
}
