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
 * ## Substitutions (D2, manager#414)
 *
 * A substitute Y's `substituted_for` entries record how MUCH of Y stands in for
 * each X. So:
 *
 * - **The subtree root's entry credits X by its quantity.** Y's components carry
 *   entries too (stamped at the document's ratio), but they anchor nothing.
 * - **X's components are credited through the ORDER's own stored ratio** —
 *   `credit × component quantity ÷ kit quantity`, walked down the order's path
 *   tree, rounded half-up once per level. Never the catalog: optional and
 *   variable components make catalog derivation wrong (D1). A full swap credits
 *   every component exactly its order quantity, so the rounding only ever bites
 *   a partial swap.
 * - **Every row of the subtree bills its own path by
 *   `row quantity − Σ live entry quantities`** — which is how a merge into a Y
 *   the order already carries bills both lines.
 * - **A spent entry is not a substitution** — {@link liveInvoiceAnchors} drops an
 *   anchor once the order no longer carries its X, and its units then count at
 *   the row's own path like any other.
 *
 * ## Dates are money, not quantity (D4)
 *
 * An order whose dates were extended after it was billed has no quantity left to
 * bill and still has money left to bill. That remainder is each billed row priced
 * as a D7 EXTENSION (api-cloudrun#997): for
 * `billableDays(order windows) − billableDays(billed windows)` days with the
 * one-week minimum skipped, through `priceDocument`'s line pricer — so it is
 * exactly what an extension section on an invoice bills (#997 D11).
 *
 * 🔴 **An extension is a change of WINDOW, and its days are the PAIRS' days.**
 * A billed row is extended only when the order pair's charge end is LATER than
 * the end of the window that billed it (earlier is a shortening, the same is
 * nothing), and the day counts are the two pairs' stored window days — never a
 * line's `chargeable_days`. A {@link BilledWindow} is that pair's last window end
 * and its window days.
 * A sign that disagrees with the window's direction is no extension either.
 *
 * This reverses the first cut, which read line `chargeable_days` on both sides.
 * The 2026-09-16 census (prod and dev agree) found ONE genuine extension in the
 * corpus (#898) against 34 orders reading a positive extension on an UNMOVED
 * window — $59.6k — and 60 remainder sections charging from the day after their
 * own end: CRMS lines stored with no days, hand-held days, a long rental billed
 * in two parts (35 + 10 of 45 days, each invoice carrying the full window), and
 * a pair recounted from 10 to 11 days. Every one had identical windows.
 *
 * The one cost, taken knowingly (owner, 2026-09-16): a row whose days an
 * operator held by hand is extended by the pairs' difference on top of whatever
 * it billed. A row billed on no pair — no `destinations` entry, or no end —
 * extends by nothing: an unknown window is not a later one.
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
 * ⚠️ **A line's `chargeable_days` is read for its RATE terms only**, never for
 * the extension's days — see above.
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
 * ## A remainder refuses CRMS-authored invoices (owner, 2026-09-16)
 *
 * Both {@link remainingForOrder} and {@link buildRemainingInvoice} fail closed
 * when any LIVE invoice on the order carries a `crms_id`, naming those uids in
 * `crms_authored`, exactly as they do on an unaligned scope. The sum itself
 * ({@link billedByPath}) is unaffected, so a diff still reads them.
 *
 * The 2026-09-16 census (`api-cloudrun/scripts/audit-order-invoice-coverage.ts`,
 * prod and dev identical): every one of the 103 orders the button was offered
 * on was billed by CRMS, and none by a native invoice. CRMS billed units under
 * a different destination than the order carries them now — #478 bills 10
 * Trash Removal under one destination where the order spreads them over five —
 * so the same units read as NEW at four paths and OVER-billed at the fifth, and
 * a remainder bills paid units again. 32 of the 103 carried that signature;
 * the rest cannot be told apart from it with what is stored.
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
import { isAtOrBelow, standInUnits, substitutionCredit } from "./substitutions.ts";

export { substitutionCredit };
import { billableDays, chargeEnvelope, chicagoDayAtTimeOf } from "./dates.ts";
import { isPreTaxItem, type LineItem } from "./orders.ts";
import { priceLine } from "./price-document.ts";

/** The invoice shape these functions read — every linked invoice, live or void. */
export interface AccountedInvoice {
  uid: string;
  status: InvoiceStatusType;
  items: InvoiceItem[];
  /** The pairs that date its sections. Without one, a row it bills has no {@link BilledWindow} and extends by nothing. */
  destinations?: readonly InvoiceDocDestinationType[];
  /** Set on a CRMS-authored invoice. A remainder refuses an order any live one bills. */
  crms_id?: number | string | null;
}

/** A pair's charge windows, as an extension compares them: where the last one ends, and each one's days. */
export interface BilledWindow {
  /** The last window's end. */
  end: string;
  /** Each window's stored `days`, in order. */
  days: readonly number[];
}

/** A pair's {@link BilledWindow}, or `null` when it has no windows. */
export function pairWindow(pair: { dates?: unknown } | undefined): BilledWindow | null {
  const dates = pair?.dates as { charge_windows?: readonly { start: string; end: string; days: number }[] } | undefined;
  const envelope = chargeEnvelope({ charge_windows: dates?.charge_windows });
  if (envelope === null || Number.isNaN(Date.parse(envelope.end))) return null;
  return { end: envelope.end, days: dates!.charge_windows!.map((w) => w.days) };
}

/** The window of the order pair an order line hangs under (`path[0]`), or `null`. */
export function orderLineWindow(
  destinations: readonly { uid: string; dates?: unknown }[],
  path: readonly string[],
): BilledWindow | null {
  return pairWindow(destinations.find((pair) => pair.uid === path[0]));
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
  /**
   * Units this row bills AT THIS PATH. The row's own quantity, except for a
   * merged substitute (manager#414): its row counts toward each X it stands in
   * for by that entry's quantity, and toward its own path by the rest.
   */
  quantity: number;
  /** The window of the invoice pair dating the row's section — for an extension row, the extension's own. */
  window: BilledWindow | null;
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
    const windowOf = (item: InvoiceItem) =>
      pairWindow(invoice.destinations?.find((pair) => pair.uid === (item.path ?? [])[1] && pair.uid_order === orderUid));
    for (const item of scoped) {
      if (!isLineItemType(item.type)) continue;
      const window = windowOf(item);
      if (isInExtensionSection(item.path ?? [], orderUid, extensionTargets)) {
        at(key(toOrderRelativePath(item.path ?? [], orderUid, extensionTargets))).rows.push({
          invoiceUid: invoice.uid,
          item,
          via: "extension",
          quantity: item.quantity ?? 0,
          window,
        });
        continue;
      }
      const rel = (item.path ?? []).slice(1);
      const enclosing = anchors.filter((a) => isAtOrBelow(rel, a.path));
      const bill = (units: number) => {
        if (units <= 0) return;
        const entry = at(key(rel));
        entry.rows.push({ invoiceUid: invoice.uid, item, via: "direct", quantity: units, window });
        entry.quantity += units;
      };
      if (enclosing.length === 0) {
        bill(item.quantity ?? 0);
        continue;
      }
      // Y itself: each anchor at this row credits its X by the units standing in.
      for (const anchor of enclosing) {
        if (key(anchor.path) !== key(rel) || anchor.quantity <= 0) continue;
        const x = key(anchor.substitutedFor);
        at(x).rows.push({ invoiceUid: invoice.uid, item, via: "substitute", quantity: anchor.quantity, window });
        substituteCredit.set(x, (substituteCredit.get(x) ?? 0) + anchor.quantity);
      }
      // D2: what does not stand in for a live X is the
      // order's own quantity at this path — a merge into a Y the order carries.
      const liveX = new Set(enclosing.map((a) => key(a.substitutedFor)));
      bill((item.quantity ?? 0) - standInUnits(item, liveX));
    }
  }

  for (const [k, units] of substitutionCredit(orderItems, substituteCredit)) at(k).quantity += units;

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
   * Pre-tax cents the order pair's current window adds to the rows already
   * billed. Negative when the window shortened.
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
 * @param orderLine - The order line, at its current quantity
 * @param billed - {@link billedByPath}'s entry for the line's path, if any
 * @param orderWindow - {@link orderLineWindow} for the line; `null` extends nothing
 */
export function accountLine(orderLine: LineItem, billed: BilledAtPath | undefined, orderWindow: BilledWindow | null): LineAccount {
  const ordered = orderLine.quantity ?? 0;
  const billedUnits = billed?.quantity ?? 0;
  const quantity = ordered - billedUnits;

  // The pricer rounds a non-negative quantity; an over-billed remainder is
  // priced at its magnitude and given back its sign.
  // The line's own days: `priceDocument` stamps a 2+ window pair's line with its
  // billable days (core#114), so they already carry every window's minimum.
  const quantityCents = quantity === 0
    ? 0
    : Math.sign(quantity) * subtotalCents({ ...orderLine, quantity: Math.abs(quantity) });

  // What the order's days add to the units already billed, each group priced as
  // the ONE extension line that would bill it — so a remainder invoice built
  // from {@link extensionGroups} nets this to exactly zero, cent for cent.
  let extensionCents = 0;
  for (const group of extensionGroups(orderLine, billed, orderWindow)) {
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
  /**
   * Billable days billed so far: `billableDays` of the row's pair's windows, plus
   * every extension applied to these units.
   */
  billed_days: number;
  /** Where the billed window ends: the row's pair's end, or the last extension's. */
  billed_end: string;
  /** `billableDays(order pair windows) − billed_days`. Never 0; negative is a shortening. */
  extension_days: number;
  /** The invoice section that last billed these units: `[invoiceUid, section divider uid]`. */
  section: [string, string];
}

/**
 * The extension still owed on an order line, as groups of billed units that
 * share their terms and their cumulative billed days (api-cloudrun#680 R1).
 *
 * The walk: every `five_day_week` unit row on a known {@link BilledWindow}
 * starts a group at its pair's billable days and end. Each extension row then moves its
 * quantity from the groups whose window ENDS earliest (then fewest days), in
 * invoice order, to `billed days + the extension pair's days`, ending where the
 * extension's pair ends. A remainder invoice brings every group to the order's
 * window at once, so a later remainder always extends from a single cumulative
 * window; the earliest-first rule only has to choose for an extension built by
 * hand. Extension quantity beyond the units billed is ignored.
 *
 * A group is owed `billableDays(order pair windows) − billed days` only when
 * its sign agrees with the window's direction: a later order end and more days,
 * or an earlier end and fewer. The same end is nothing, whatever the counts say.
 *
 * A `fixed` row never read its days, so it forms no group; nor does a row on no
 * known window. A group whose extension is zero is dropped.
 */
export function extensionGroups(
  orderLine: LineItem,
  billed: BilledAtPath | undefined,
  orderWindow: BilledWindow | null,
): ExtensionGroup[] {
  if (!isPreTaxItem(orderLine) || orderWindow === null) return [];
  const orderEnd = Date.parse(orderWindow.end);
  const groups: Array<Omit<ExtensionGroup, "extension_days">> = [];
  const extensions: BilledRow[] = [];
  for (const row of billed?.rows ?? []) {
    if (!isPreTaxItem(row.item) || row.item.price.formula !== "five_day_week") continue;
    if (row.via === "extension") {
      extensions.push(row);
      continue;
    }
    const quantity = row.quantity;
    if (quantity <= 0 || row.window === null) continue;
    groups.push({
      item: row.item,
      via: row.via,
      quantity,
      billed_days: billableDays(row.window.days),
      billed_end: row.window.end,
      section: [row.invoiceUid, (row.item.path ?? [])[1] ?? ""],
    });
  }
  for (const row of extensions) {
    if (row.window === null) continue;
    let left = row.item.quantity ?? 0;
    // An extension pair's one window stores the days it ADDED: no floor.
    const added = row.window.days.reduce((total, d) => total + d, 0);
    const billedEnd = row.window.end;
    const section: [string, string] = [row.invoiceUid, (row.item.path ?? [])[1] ?? ""];
    while (left > 0) {
      const open = groups.filter((g) => g.quantity > 0);
      if (open.length === 0) break;
      const earliest = open.reduce((a, b) => {
        const byEnd = Date.parse(b.billed_end) - Date.parse(a.billed_end);
        return byEnd < 0 || (byEnd === 0 && b.billed_days < a.billed_days) ? b : a;
      });
      const moved = Math.min(left, earliest.quantity);
      const billedDays = earliest.billed_days + added;
      earliest.quantity -= moved;
      left -= moved;
      const same = groups.find((g) =>
        g.item === earliest.item && g.billed_days === billedDays && g.billed_end === billedEnd &&
        g.section[0] === section[0] && g.section[1] === section[1]
      );
      if (same) same.quantity += moved;
      else groups.push({ ...earliest, quantity: moved, billed_days: billedDays, billed_end: billedEnd, section });
    }
  }
  return groups
    .filter((g) => g.quantity > 0)
    .map((g) => {
      const direction = Math.sign(orderEnd - Date.parse(g.billed_end));
      const days = billableDays(orderWindow.days) - g.billed_days;
      return { ...g, extension_days: Math.sign(days) === direction ? days : 0 };
    })
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
  /** Live CRMS-authored invoices. Non-empty ⇒ `lines` is empty: their paths cannot be trusted to bill the order's. */
  crms_authored: string[];
}

/** The uids of the LIVE invoices CRMS authored — a remainder refuses when any exist. */
export function crmsAuthoredInvoices(invoices: readonly AccountedInvoice[]): string[] {
  return invoices
    .filter((invoice) => invoice.status !== "void" && invoice.crms_id !== undefined && invoice.crms_id !== null && invoice.crms_id !== "")
    .map((invoice) => invoice.uid);
}

/**
 * What is left to bill on an order: new lines in full, quantity deltas at
 * existing paths, and date-extension money on rows already billed (D4).
 *
 * 🔴 **Fails closed on any unaligned scope** — `lines` comes back empty and the
 * uids are in `unaligned`. A remainder built over a partial sum bills again
 * whatever the unaligned invoice already billed.
 *
 * 🔴 **Fails closed on any live CRMS-authored invoice**, the same way, naming it
 * in `crms_authored` — see the module header.
 *
 * Every order LINE is considered, dividers never. A line whose quantity and
 * extension are both zero is omitted; a negative one (over-billing) is returned,
 * for the caller to route to a credit note rather than a remainder.
 *
 * @param orderUid - The order's uid
 * @param orderItems - The order's CURRENT `items`, dividers included
 * @param invoices - Every invoice linked to the order, live or void — ALL of them, never a page
 * @param orderDestinations - The order's CURRENT pairs, which date every extension
 */
export function remainingForOrder(
  orderUid: string,
  orderItems: readonly LineItem[],
  invoices: readonly AccountedInvoice[],
  orderDestinations: readonly DocDestinationType[],
): RemainingForOrder {
  const billed = billedByPath(orderUid, orderItems, invoices);
  const crmsAuthored = crmsAuthoredInvoices(invoices);
  if (billed.unaligned.length > 0 || crmsAuthored.length > 0) {
    return { lines: [], compared: billed.compared, unaligned: billed.unaligned, crms_authored: crmsAuthored };
  }
  const lines: RemainingLine[] = [];
  for (const item of orderItems) {
    if (!isLineItemType(item.type)) continue;
    const path = item.path ?? [];
    const at = billed.byPath.get(key(path));
    const account = accountLine(item, at, orderLineWindow(orderDestinations, path));
    if (account.quantity === 0 && account.extension_cents === 0) continue;
    lines.push({ ...account, path, item, new: at === undefined });
  }
  return { lines, compared: billed.compared, unaligned: [], crms_authored: [] };
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
export type RemainingInvoiceSource = AccountedInvoice;

/** @see {@link buildRemainingInvoice} */
export interface RemainingInvoice {
  /** The order divider, then the order's scope. Empty when `unaligned` or `crms_authored` is non-empty, or nothing remains. */
  items: InvoiceDocItemType[];
  /** Every order pair, then one pair per extension section. */
  destinations: InvoiceDocDestinationType[];
  /** The order lines and extension groups billed BEYOND the order: a credit note's to settle, never this invoice's. */
  overbilled: { path: string[]; quantity: number; extension_days: number }[];
  compared: string[];
  unaligned: string[];
  /** Live CRMS-authored invoices; non-empty ⇒ nothing is built. See the module header. */
  crms_authored: string[];
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
 * - **Its pair** is the order's pair re-keyed to the section, with ONE charge
 *   window from the day after the billed window's end (at the order's first
 *   window start's time of day) to the order's last window end. Its `days` is
 *   the section's ADDED days, never a count of the window (owner, 2026-09-17),
 *   so its lines derive exactly that. An extension is only owed on a window
 *   that ends before the order's, so the section never starts after it ends.
 * - **Over-billing is never netted in.** A negative quantity or extension is
 *   returned in `overbilled`, for the credit-note flow.
 *
 * 🔴 Fails closed on an unaligned scope or a live CRMS-authored invoice, exactly
 * as {@link remainingForOrder}.
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
  const crmsAuthored = crmsAuthoredInvoices(invoices);
  const empty = { items: [], destinations: [], overbilled: [], compared: billed.compared, unaligned: billed.unaligned, crms_authored: crmsAuthored };
  if (billed.unaligned.length > 0 || crmsAuthored.length > 0) return empty;

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
    for (const group of extensionGroups(line, at, orderLineWindow(order.destinations, path))) {
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

  for (const [destination, entries] of owed) {
    const divider = order.items.find((it) => it.type === "destination" && it.uid === destination);
    const orderPair = order.destinations.find((pair) => pair.uid === destination);
    if (!divider || !orderPair) continue;

    /** One section: its billed window, and the entries keyed by order path. */
    const sections: Array<{ billedDays: number; billedEnd: string; extensionDays: number; byPath: Map<string, { line: LineItem; group: ExtensionGroup }> }> = [];
    for (const entry of entries) {
      const k = key(entry.line.path ?? []);
      let section = sections.find((s) =>
        s.billedDays === entry.group.billed_days && s.billedEnd === entry.group.billed_end && !s.byPath.has(k)
      );
      if (!section) {
        section = {
          billedDays: entry.group.billed_days,
          billedEnd: entry.group.billed_end,
          extensionDays: entry.group.extension_days,
          byPath: new Map(),
        };
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

      const projectedPair = toInvoiceDestinationPair(O, orderPair);
      const orderWindows = orderPair.dates.charge_windows;
      const start = chicagoDayAtTimeOf(section.billedEnd, 1, orderWindows[0].start);
      const end = orderWindows[orderWindows.length - 1].end;
      extensionPairs.push({
        ...projectedPair,
        uid: E,
        dates: { ...projectedPair.dates, charge_windows: [{ start, end, days: section.extensionDays }] },
      });
    }
  }

  return { items, destinations: [...pairs, ...extensionPairs], overbilled, compared: billed.compared, unaligned: [], crms_authored: [] };
}
