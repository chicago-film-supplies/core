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
 * 🔴 **An extension is a change of WINDOW SET, and its days are the PAIRS' days.**
 * A billed row is extended, or shortened, only when the order pair's windows
 * cover DIFFERENT Chicago calendar dates than the windows that billed it; the
 * amount is then `billableDays(order windows) − billed days`, sign and all, from
 * the two pairs' stored window days — never a line's `chargeable_days`. A
 * {@link BilledWindow} carries that pair's last window end, its window days, and
 * each window's bounds.
 *
 * ⚠️ **This widened on 2026-09-17 (api-cloudrun#1028 phase 1a), and the widening
 * is the point.** The rule it replaced compared only where the LAST window ended,
 * so dropping or shrinking a MIDDLE window moved no end and reported nothing at
 * all. The two questions — *did the window move?* and *by how much, which way?* —
 * are now asked separately in {@link extensionGroups}; the first is answered by
 * dates ({@link sameWindowDates}) and the second by day counts.
 *
 * Both cuts reverse the first one, which read line `chargeable_days` on both sides.
 * The 2026-09-16 census (prod and dev agree) found ONE genuine extension in the
 * corpus (#898) against 34 orders reading a positive extension on an UNMOVED
 * window — $59.6k — and 60 remainder sections charging from the day after their
 * own end: CRMS lines stored with no days, hand-held days, a long rental billed
 * in two parts (35 + 10 of 45 days, each invoice carrying the full window), and
 * a pair recounted from 10 to 11 days. Every one had identical windows. ⚠️ The
 * date-set gate is what keeps all 34 dead: a stored `days` is frozen at write
 * while the order's is recounted, so a day delta under identical dates is always
 * an artefact of the recount.
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
import type { CreditNoteStatusType, DocDestinationType, InvoiceDocDestinationType, InvoiceDocItemType, InvoiceStatusType } from "../schemas/mod.ts";
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
import { billableDays, chargeEnvelope, chicagoDayAtTimeOf, toChicagoYmd } from "./dates.ts";
import { isPreTaxItem, type LineItem } from "./orders.ts";
import { priceLine } from "./price-document.ts";

/** The invoice shape these functions read — every linked invoice, live or void. */
export interface AccountedInvoice {
  uid: string;
  status: InvoiceStatusType;
  items: InvoiceItem[];
  /** Its document number. {@link buildOverbillingCredits} orders on it, last. */
  number?: number;
  /**
   * What is still owed on it, in integer cents.
   *
   * ⚠️ Read by {@link buildOverbillingCredits} to prefer an invoice a credit can
   * actually be ALLOCATED to. A note against a fully paid invoice is issuable and
   * not allocatable to it, so it leaves the money sitting as unconsumed credit.
   */
  amount_due_cents?: number;
  /** The pairs that date its sections. Without one, a row it bills has no {@link BilledWindow} and extends by nothing. */
  destinations?: readonly InvoiceDocDestinationType[];
  /** Set on a CRMS-authored invoice. A remainder refuses an order any live one bills. */
  crms_id?: number | string | null;
}

/** One charge window's bounds, as the shortening gate compares them. */
export interface WindowBounds {
  start: string;
  end: string;
}

/** A pair's charge windows, as an extension compares them: where the last one ends, each one's days, and each one's bounds. */
export interface BilledWindow {
  /** The last window's end. */
  end: string;
  /** Each window's stored `days`, in order. */
  days: readonly number[];
  /**
   * Each window's bounds, in order — parallel to {@link days}.
   *
   * 🔴 **This, not {@link days}, is what says whether a window MOVED.** A stored
   * `days` is frozen at write while the order's is recounted against the holiday
   * calendar, so a day delta under an identical set of dates is always an
   * artefact of that recount and never a shortening. See {@link extensionGroups}.
   */
  windows: readonly WindowBounds[];
}

/** A pair's {@link BilledWindow}, or `null` when it has no windows. */
export function pairWindow(pair: { dates?: unknown } | undefined): BilledWindow | null {
  const dates = pair?.dates as { charge_windows?: readonly { start: string; end: string; days: number }[] } | undefined;
  const envelope = chargeEnvelope({ charge_windows: dates?.charge_windows });
  if (envelope === null || Number.isNaN(Date.parse(envelope.end))) return null;
  return {
    end: envelope.end,
    days: dates!.charge_windows!.map((w) => w.days),
    windows: dates!.charge_windows!.map((w) => ({ start: w.start, end: w.end })),
  };
}

/**
 * Whether two window lists cover the same Chicago calendar dates, window for
 * window, in order.
 *
 * Compared as DATES rather than instants: a pair re-authored at a different time
 * of day covers the same days and charges the same, and the stored `days` counts
 * are deliberately not consulted.
 */
export function sameWindowDates(a: readonly WindowBounds[], b: readonly WindowBounds[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((w, i) =>
    toChicagoYmd(w.start) === toChicagoYmd(b[i].start) && toChicagoYmd(w.end) === toChicagoYmd(b[i].end)
  );
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

/** One credit-note line, as {@link billingReversals} reads it. */
export interface AccountedCreditNoteItem {
  quantity: number;
  /** The `path` of the invoice line credited — its row identity on that invoice. */
  path_invoice_item?: readonly string[];
  /**
   * Stated by every line, and true only on one the over-billing offer wrote.
   *
   * ⚠️ Read with `=== true` rather than for truthiness: the reader is handed
   * documents by consumers that may predate the migration, and a `false` and an
   * absent must both mean "not netted".
   */
  reverses_billing: boolean;
}

/** A credit note as quantity accounting reads it. */
export interface AccountedCreditNote {
  uid: string;
  status: CreditNoteStatusType;
  items: readonly AccountedCreditNoteItem[];
  /** Where the credit lands. Exactly one `invoices` entry makes a line attributable. */
  sources?: readonly { collection: string; uid: string }[];
}

/** @see {@link billingReversals} */
export interface BillingReversals {
  /** `invoiceUid + "|" + invoice path key` → units whose billing is reversed. */
  byRow: Map<string, number>;
  /**
   * Notes carrying a `reverses_billing` line this cannot key — no
   * `path_invoice_item`, or not exactly one `invoices` source.
   *
   * 🔴 **Surface this. "No credits found" must never read as "no credits."**
   */
  unkeyed: string[];
}

/**
 * The units each invoice row's billing has been REVERSED by, from credit notes.
 *
 * A line counts only when all four hold, and each one is load-bearing:
 *
 * - the note is `issued` or `applied` — a draft has not credited anything, and a
 *   void one has been taken back;
 * - the line sets `reverses_billing`. 🔴 **Never gate on `reason` instead**:
 *   `bad_debt` is a write-off and `order_adjustment` covers loss-and-damage, so
 *   netting by reason would make {@link remainingForOrder} offer to RE-BILL units
 *   that were written off rather than returned;
 * - the line names `path_invoice_item`, the invoice row it credits. `uid` alone
 *   is not a row identity — it repeats within one document;
 * - the note names exactly ONE invoice in `sources`. A path key is only unique
 *   within one document, so without that the same path on two invoices is
 *   indistinguishable and the credit could be subtracted from the wrong row.
 *
 * Anything else is reported in `unkeyed` rather than guessed at.
 */
export function billingReversals(creditNotes: readonly AccountedCreditNote[]): BillingReversals {
  const byRow = new Map<string, number>();
  const unkeyed: string[] = [];
  for (const note of creditNotes) {
    if (note.status !== "issued" && note.status !== "applied") continue;
    const invoices = (note.sources ?? []).filter((s) => s.collection === "invoices");
    for (const item of note.items) {
      if (item.reverses_billing !== true) continue;
      const path = item.path_invoice_item ?? [];
      if (path.length === 0 || invoices.length !== 1) {
        unkeyed.push(note.uid);
        continue;
      }
      const k = `${invoices[0].uid}|${key(path)}`;
      byRow.set(k, (byRow.get(k) ?? 0) + (item.quantity ?? 0));
    }
  }
  return { byRow, unkeyed: [...new Set(unkeyed)] };
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
  /**
   * Credit notes carrying a `reverses_billing` line this could not attribute to
   * an invoice row, so nothing was netted for them.
   *
   * 🔴 **A caller that reports credits MUST report this too.** Empty because
   * nothing credited and empty because nothing could be READ are the same number
   * otherwise, and the second one silently re-offers units that are already
   * credited. See {@link billingReversals}.
   */
  credits_unkeyed: string[];
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
 * ## Credit notes net the units they reverse (api-cloudrun#1028 phase 1b)
 *
 * A credit note this feature authored subtracts the units it reverses from the
 * row that billed them, so taking the over-billing offer CLEARS the offer rather
 * than leaving it standing for ever. {@link billingReversals} decides which lines
 * qualify; `credits_unkeyed` names the notes it could not key.
 *
 * ⚠️ **The subtraction happens on the ROW, before the substitution ratio walk** —
 * not on the path total afterwards. That ordering is what makes a credit against
 * a substitute Y reduce the units standing in for each X, and then flow down the
 * order's own ratio to X's components. Netting the total afterwards would leave
 * every descendant crediting units their parent no longer bills.
 *
 * ⚠️ **Units only. Days are NOT netted here** — a credited shortening is reported
 * as a suppressed offer instead. `billed_days` is derived inside
 * {@link extensionGroups}, where extension rows split and merge groups, so a
 * `(path, quantity, days)` triple cannot say which group loses the days.
 *
 * @param orderUid - The order's uid, which is its divider's uid on every invoice
 * @param orderItems - The order's CURRENT `items`, dividers included
 * @param invoices - Every invoice linked to the order, live or void
 * @param creditNotes - Every credit note on those invoices. Omitted ⇒ nothing nets.
 */
export function billedByPath(
  orderUid: string,
  orderItems: readonly LineItem[],
  invoices: readonly AccountedInvoice[],
  creditNotes: readonly AccountedCreditNote[] = [],
): BilledByPath {
  const byPath = new Map<string, BilledAtPath>();
  const compared: string[] = [];
  const unaligned: string[] = [];
  const reversals = billingReversals(creditNotes);
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
      // Units of THIS row whose billing a credit note has reversed, spent below
      // against the anchors first and then against the row's own bill.
      let reversed = reversals.byRow.get(`${invoice.uid}|${key(item.path ?? [])}`) ?? 0;
      /** Take up to `units` from the reversal budget. */
      const netted = (units: number): number => {
        const taken = Math.min(reversed, Math.max(units, 0));
        reversed -= taken;
        return units - taken;
      };
      const bill = (units: number) => {
        const left = netted(units);
        if (left <= 0) return;
        const entry = at(key(rel));
        entry.rows.push({ invoiceUid: invoice.uid, item, via: "direct", quantity: left, window });
        entry.quantity += left;
      };
      if (enclosing.length === 0) {
        bill(item.quantity ?? 0);
        continue;
      }
      // Y itself: each anchor at this row credits its X by the units standing in.
      // A reversal is spent HERE first, so `substituteCredit` — and therefore the
      // ratio walk below — sees the reduced stand-in rather than the billed one.
      for (const anchor of enclosing) {
        if (key(anchor.path) !== key(rel) || anchor.quantity <= 0) continue;
        const standIn = netted(anchor.quantity);
        if (standIn <= 0) continue;
        const x = key(anchor.substitutedFor);
        at(x).rows.push({ invoiceUid: invoice.uid, item, via: "substitute", quantity: standIn, window });
        substituteCredit.set(x, (substituteCredit.get(x) ?? 0) + standIn);
      }
      // D2: what does not stand in for a live X is the
      // order's own quantity at this path — a merge into a Y the order carries.
      const liveX = new Set(enclosing.map((a) => key(a.substitutedFor)));
      bill((item.quantity ?? 0) - standInUnits(item, liveX));
    }
  }

  for (const [k, units] of substitutionCredit(orderItems, substituteCredit)) at(k).quantity += units;

  return { byPath, compared, unaligned, credits_unkeyed: reversals.unkeyed };
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
  /**
   * The FULFILLMENT's quantity for this line, when a fulfillment row exists
   * for it. `undefined` means no fulfillment row — not "nothing was fulfilled".
   *
   * ⚠️ **Not a custody fact, and deliberately not named for one.** This was
   * `sent` first, which claimed a rung of the ladder (`quoted → prep →
   * checkout → return → complete`) that the number does not carry: it is the
   * same figure before anything is picked and after everything has come back.
   * How many units are physically OUT lives on the booking's breakdown. The
   * parallel that governs the name is `billed`, which asserts what the
   * invoices SAY rather than that money moved — payment is settlements' fact.
   *
   * 🔴 **A THIRD authority, not a better version of `ordered`.** The three
   * documents answer three different questions and are all mutable: the ORDER
   * is the quote given to the customer, the FULFILLMENT records what actually
   * happened, and the INVOICE is the operator's decision about what to bill.
   * They are not expected to agree, so a reader must be able to ask "billed
   * against what was quoted" and "billed against what the warehouse recorded"
   * separately and get different answers.
   */
  fulfilled?: number;
  /** `fulfilled − billed`. Negative means more was billed than the fulfillment records. */
  fulfilled_quantity?: number;
  /** Pre-tax cents for `fulfilled_quantity` units at the order line's current terms. Signed with it. */
  fulfilled_quantity_cents?: number;
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
 * @param fulfilled - the FULFILLMENT row's quantity at this line's path, if one exists
 */
export function accountLine(
  orderLine: LineItem,
  billed: BilledAtPath | undefined,
  orderWindow: BilledWindow | null,
  fulfilled?: number,
): LineAccount {
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

  // The same pricing basis as `quantity_cents` — the ORDER line's current
  // terms — because that is what an operator would bill the unbilled units at.
  // Priced here rather than by the caller so every number on this object comes
  // from one author.
  const fulfilledQuantity = fulfilled === undefined ? undefined : fulfilled - billedUnits;
  const fulfilledQuantityCents = fulfilledQuantity === undefined || fulfilledQuantity === 0
    ? fulfilledQuantity === undefined ? undefined : 0
    : Math.sign(fulfilledQuantity) * subtotalCents({ ...orderLine, quantity: Math.abs(fulfilledQuantity) });

  return {
    ordered,
    billed: billedUnits,
    quantity,
    quantity_cents: quantityCents,
    extension_cents: extensionCents,
    ...(fulfilled === undefined
      ? {}
      : {
        fulfilled,
        fulfilled_quantity: fulfilledQuantity,
        fulfilled_quantity_cents: fulfilledQuantityCents,
      }),
  };
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
  /**
   * Every window billed on these units, in order: the row's pair's windows, then
   * each extension's. Compared against the order pair's set to decide whether the
   * window MOVED at all — see {@link BilledWindow.windows}.
   */
  billed_set: readonly WindowBounds[];
  /** `billableDays(order pair windows) − billed_days`. Never 0; negative is a shortening. */
  extension_days: number;
  /** The invoice section that last billed these units: `[invoiceUid, section divider uid]`. */
  section: [string, string];
  /**
   * The invoice ROW that last billed these units — the originating row, or the
   * extension row that last moved them.
   *
   * 🔴 **{@link section} does not name a line.** `section[1]` is a divider uid, and
   * once an extension row has moved units the group's `item` and `section` name
   * different invoices. A credit has to be raised against the row that actually
   * billed the units, so that row states itself here.
   */
  last_billed: { invoiceUid: string; uid: string; path: readonly string[] };
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
 * ## Two questions, not one (api-cloudrun#1028)
 *
 * The gate used to be a single test — *does the day delta's sign agree with the
 * direction the LAST window's end moved?* — which is two questions wearing one
 * hat, and it answered the second one only for the last window. Dropping or
 * shrinking a MIDDLE window leaves the last end where it was, so a genuine
 * shortening reported nothing at all. They are now asked separately:
 *
 * 1. **Did the window move?** {@link sameWindowDates} compares the order pair's
 *    windows against the group's {@link ExtensionGroup.billed_set}, window for
 *    window, as Chicago calendar dates. Identical ⇒ `extension_days = 0`,
 *    whatever the day counts say. 🔴 This is the holiday-recount guard, and it is
 *    why the comparison is of DATES and not of `days`: a stored `days` is frozen
 *    at write while the order's is recounted, so a delta under an identical date
 *    set is always an artefact of the recount.
 * 2. **How much, and which way?** `billableDays(order pair windows) − billed_days`,
 *    sign and all. Negative is a shortening — over-billing, for the credit-note
 *    flow — and positive is an extension still owed.
 *
 * ⚠️ **There is deliberately no sub-cover test.** A window set that shrinks by
 * date while `billableDays` RISES (one window split into several, each floored to
 * a week) is a genuine extension, and by owner ruling an invoice stating its own
 * windows is never over-billing — so a bill inside a narrower or split cover
 * credits nothing.
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
      billed_set: row.window.windows,
      section: [row.invoiceUid, (row.item.path ?? [])[1] ?? ""],
      last_billed: { invoiceUid: row.invoiceUid, uid: row.item.uid, path: row.item.path ?? [] },
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
      // The extension bills its own window ON TOP of what the group already carried.
      const billedSet = [...earliest.billed_set, ...row.window.windows];
      earliest.quantity -= moved;
      left -= moved;
      // `billed_set` joins the merge key: two groups can agree on their day count
      // and their end and still have been billed across different windows, and
      // merging those would hand the shortening gate a set neither of them has.
      const same = groups.find((g) =>
        g.item === earliest.item && g.billed_days === billedDays && g.billed_end === billedEnd &&
        g.section[0] === section[0] && g.section[1] === section[1] && sameWindowDates(g.billed_set, billedSet)
      );
      if (same) same.quantity += moved;
      else {
        groups.push({
          ...earliest,
          quantity: moved,
          billed_days: billedDays,
          billed_end: billedEnd,
          billed_set: billedSet,
          section,
          last_billed: { invoiceUid: row.invoiceUid, uid: row.item.uid, path: row.item.path ?? [] },
        });
      }
    }
  }
  const orderDays = billableDays(orderWindow.days);
  return groups
    .filter((g) => g.quantity > 0)
    .map((g) => ({
      ...g,
      // (1) did the window move? (2) if so, by how much and which way?
      extension_days: sameWindowDates(g.billed_set, orderWindow.windows) ? 0 : orderDays - g.billed_days,
    }))
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
  /** @see {@link BilledByPath.credits_unkeyed} — report it beside any credit figure. */
  credits_unkeyed: string[];
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
  creditNotes: readonly AccountedCreditNote[] = [],
): RemainingForOrder {
  const billed = billedByPath(orderUid, orderItems, invoices, creditNotes);
  const crmsAuthored = crmsAuthoredInvoices(invoices);
  if (billed.unaligned.length > 0 || crmsAuthored.length > 0) {
    return {
      lines: [],
      compared: billed.compared,
      unaligned: billed.unaligned,
      crms_authored: crmsAuthored,
      credits_unkeyed: billed.credits_unkeyed,
    };
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
  return { lines, compared: billed.compared, unaligned: [], crms_authored: [], credits_unkeyed: billed.credits_unkeyed };
}

// ── The over-billing OFFER (api-cloudrun#1028 phase 1d) ─────────

/** One credit-note line the offer would raise. */
export interface OverbillingCreditLine {
  /** The invoice row this credits — its row identity on that invoice. */
  path_invoice_item: string[];
  /** That row's own uid, for the `uid_invoice_item` a credit note also stores. */
  uid_invoice_item: string;
  /** The order-relative path the over-billing was found at. */
  order_path: string[];
  /** Whole units to credit. `0` on a days-only credit. */
  quantity: number;
  /**
   * Billable days to credit, for a window the order SHORTENED — `−extension_days`.
   * Absent on an ordinary unit credit.
   */
  credited_days?: number;
  /** Pre-tax preview cents, priced from the row the note will be priced from. */
  preview_cents: number;
}

/** One credit note the offer would raise — a note belongs to exactly ONE invoice. */
export interface OverbillingCreditNote {
  uid_invoice: string;
  lines: OverbillingCreditLine[];
  /** Σ `preview_cents`, pre-tax. */
  preview_cents: number;
}

/** @see {@link buildOverbillingCredits} */
export interface OverbillingCredits {
  /** One per invoice to credit, in the order they should be offered. Empty ⇒ no offer. */
  notes: OverbillingCreditNote[];
  /**
   * Over-billing found but NOT offered, with the reason. 🔴 Surface it: an offer
   * that silently drops part of what the diff surface renders leaves an operator
   * looking at "over-billed" copy that the button does not clear.
   */
  refused: Array<{ order_path: string[]; reason: string }>;
  /** As {@link remainingForOrder} — non-empty ⇒ `notes` is empty. */
  unaligned: string[];
  crms_authored: string[];
  /** @see {@link BilledByPath.credits_unkeyed} */
  credits_unkeyed: string[];
}

/**
 * **Build the credit notes that give back what an order's invoices over-billed
 * it** (api-cloudrun#1028). The ONE author of the offer: the server rebuilds it
 * inside the create transaction and the manager renders it as a preview, so the
 * two cannot answer differently.
 *
 * ## The ROW is the unit of work, not the path
 *
 * 🔴 An over-billed path with no rows of its own is a kit component credited
 * through its PARENT's substitute. It has nothing to raise a credit against, it
 * emits no line, and it clears when the anchor is credited — so it is neither
 * offered nor refused. Driving this off paths instead would mint a credit line
 * with no invoice row behind it.
 *
 * ## Which invoice, and the ordering is a choice of MONEY
 *
 * A credit note belongs to one invoice, so over-billing spanning several is
 * several notes. They are ordered by **outstanding balance first**, then by
 * number — not by recency. A note against a fully paid invoice is issuable but
 * not ALLOCATABLE to it, so it would leave the money sitting as unconsumed credit
 * rather than settling anything.
 *
 * ⚠️ For a shortening the target row is {@link ExtensionGroup.last_billed}, never
 * `group.section`. In the ordinary case `group.item` and `group.section` name one
 * invoice; once an extension row has moved units they do not, and `section[1]` is
 * a divider uid rather than a line.
 *
 * ## Refusals
 *
 * Fails closed exactly as {@link remainingForOrder} does — an unaligned scope or a
 * live CRMS-authored invoice — **plus**, per path:
 *
 * - a **draft** invoice among the billers: a draft has billed nothing to give
 *   back, and crediting one is not a correction but a reason to edit it;
 * - a path with **no attributable row** that is not the kit-component case above;
 * - a path attributable only through a **substitute**: one Y row can stand in for
 *   several X paths, and the cap is Y's full quantity, so a credit raised there
 *   could exceed what any single X was billed.
 *
 * ⚠️ **Preview cents come from the ROW the note will be priced from**, not from
 * {@link accountLine}. `accountLine.quantity_cents` prices at the ORDER line's
 * terms, while `priceCreditNote` prices the stored INVOICE line — and where the
 * two disagree, the second is what the operator will be asked to approve.
 */
export function buildOverbillingCredits(
  order: RemainingOrderSource,
  invoices: readonly AccountedInvoice[],
  creditNotes: readonly AccountedCreditNote[] = [],
): OverbillingCredits {
  const O = order.uid;
  const billed = billedByPath(O, order.items, invoices, creditNotes);
  const crmsAuthored = crmsAuthoredInvoices(invoices);
  const empty: OverbillingCredits = {
    notes: [],
    refused: [],
    unaligned: billed.unaligned,
    crms_authored: crmsAuthored,
    credits_unkeyed: billed.credits_unkeyed,
  };
  if (billed.unaligned.length > 0 || crmsAuthored.length > 0) return empty;

  const byUid = new Map(invoices.map((inv) => [inv.uid, inv]));
  const refused: OverbillingCredits["refused"] = [];
  /** invoice uid → the lines to credit on it. */
  const perInvoice = new Map<string, OverbillingCreditLine[]>();
  const add = (invoiceUid: string, line: OverbillingCreditLine) => {
    if (!perInvoice.has(invoiceUid)) perInvoice.set(invoiceUid, []);
    perInvoice.get(invoiceUid)!.push(line);
  };

  for (const item of order.items) {
    if (!isLineItemType(item.type)) continue;
    const path = item.path ?? [];
    const at = billed.byPath.get(key(path));
    const account = accountLine(item, at, orderLineWindow(order.destinations, path));

    // ── Units billed beyond the order ──
    if (account.quantity < 0) {
      let owed = -account.quantity;
      // Direct rows only, largest first, so the fewest lines carry the credit.
      const rows = (at?.rows ?? []).filter((r) => r.via === "direct" && r.quantity > 0);
      if (rows.length === 0) {
        // A substitute-only path is refusable; a path with NO rows at all is the
        // kit component credited through its parent, which clears on its own.
        const substituteOnly = (at?.rows ?? []).some((r) => r.via === "substitute");
        if (substituteOnly) {
          refused.push({
            order_path: [...path],
            reason: "billed only through a substitute — one substitute row can stand in for several order lines, so its cap is not this line's",
          });
        }
      } else if (rows.some((r) => byUid.get(r.invoiceUid)?.status === "draft")) {
        refused.push({ order_path: [...path], reason: "billed by a DRAFT invoice — edit the draft rather than crediting it" });
      } else {
        for (const row of [...rows].sort((a, b) => b.quantity - a.quantity)) {
          if (owed <= 0) break;
          const take = Math.min(owed, row.quantity);
          owed -= take;
          add(row.invoiceUid, {
            path_invoice_item: [...(row.item.path ?? [])],
            uid_invoice_item: row.item.uid,
            order_path: [...path],
            quantity: take,
            preview_cents: subtotalCents({ ...row.item, quantity: take } as LineItem),
          });
        }
        if (owed > 0) {
          refused.push({ order_path: [...path], reason: `${owed} unit(s) over-billed beyond any attributable invoice row` });
        }
      }
    }

    // ── Days billed beyond the order: a SHORTENED charge window ──
    for (const group of extensionGroups(item, at, orderLineWindow(order.destinations, path))) {
      if (group.extension_days >= 0) continue;
      const days = -group.extension_days;
      const invoice = byUid.get(group.last_billed.invoiceUid);
      if (invoice?.status === "draft") {
        refused.push({ order_path: [...path], reason: "window shortened on a DRAFT invoice — edit the draft rather than crediting it" });
        continue;
      }
      if (group.via === "substitute") {
        refused.push({ order_path: [...path], reason: "window shortened on a substituted row — the credit's cap is not this line's" });
        continue;
      }
      add(group.last_billed.invoiceUid, {
        path_invoice_item: [...group.last_billed.path],
        uid_invoice_item: group.last_billed.uid,
        order_path: [...path],
        quantity: group.quantity,
        credited_days: days,
        preview_cents: Math.abs(subtotalCents({ ...group.item, quantity: group.quantity } as LineItem, group.extension_days)),
      });
    }
  }

  // Outstanding balance first — a note against a fully paid invoice is issuable
  // and not allocatable to it — then by number, so the order is stable.
  const notes = [...perInvoice.entries()]
    .map(([uid_invoice, lines]) => ({ uid_invoice, lines, preview_cents: lines.reduce((t, l) => t + l.preview_cents, 0) }))
    .sort((a, b) => {
      const owed = (uid: string) => byUid.get(uid)?.amount_due_cents ?? 0;
      if ((owed(a.uid_invoice) > 0) !== (owed(b.uid_invoice) > 0)) return owed(a.uid_invoice) > 0 ? -1 : 1;
      return (byUid.get(a.uid_invoice)?.number ?? 0) - (byUid.get(b.uid_invoice)?.number ?? 0);
    });

  return { ...empty, notes, refused };
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
