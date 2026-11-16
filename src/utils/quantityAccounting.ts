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
 * remaining-invoice create mode (via {@link buildRemainingInvoice}), the
 * over-billing offer and the coverage banner — all reading {@link accountInitiator}.
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
 *   variable components make catalog derivation wrong (D1). A full substitution credits
 *   every component exactly its order quantity, so the rounding only ever bites
 *   a partial substitution.
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
 * as a D7 EXTENSION (api-cloudrun#997): at the counts
 * `meter(order windows) − meter(billed windows)`, both metered through the
 * billed row's formula (each side carries its own minimum, so the difference
 * skips it), through `priceDocument`'s line pricer — so it is exactly what an
 * extension section on an invoice bills (#997 D11, Phase 2 ruling 8).
 *
 * 🔴 **An extension is a change of WINDOW SET, and its days are the PAIRS' days.**
 * A billed row is extended, or shortened, only when the order pair's windows
 * cover DIFFERENT Chicago calendar dates than the windows that billed it; the
 * amount is then `meter(order windows) − billed counts`, sign and all, from the
 * two pairs' windows metered through the row's formula — never a line's own
 * stored counts. A {@link BilledWindow} carries that pair's last window end and
 * each window's bounds.
 *
 * ⚠️ **This widened on 2026-09-17 (api-cloudrun#1028 phase 1a), and the widening
 * is the point.** The rule it replaced compared only where the LAST window ended,
 * so dropping or shrinking a MIDDLE window moved no end and reported nothing at
 * all. The two questions — *did the window move?* and *by how much, which way?* —
 * are now asked separately in {@link groupExtensions}; the first is answered by
 * dates ({@link sameWindowDates}) and the second by day counts.
 *
 * Both cuts reverse the first one, which read the line's stored days on both sides.
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
 * 🔴 **Never price "the extra days" as an ordinary line.** Five-day week floors
 * at one week, so `price(3 days)` charges a week the billed row already paid.
 * The D7 day count floors each SIDE at the week instead, and skips the floor on
 * the difference. A `fixed` row never read its days and extends by nothing.
 *
 * **A bill of the extension nets it out.** A line in an invoice's
 * date-extension section (`path_extension_for`) reaches {@link billedByPath} as
 * an `extension` row at the path it extends: it adds no units, and
 * {@link groupExtensions} moves the units it extends onto its window, so the
 * account ({@link accountInitiator}) owes no extension once it is billed.
 *
 * ⚠️ **A billed line is read for its RATE terms and formula only**, never for
 * the extension's counts — see above.
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
 * The account ({@link InitiatorAccount.refused}), and so {@link buildRemainingInvoice}
 * and {@link buildOverbillingCredits}, fail closed when any LIVE invoice on the
 * order carries a `crms_id`, naming those uids in `crms_authored`, exactly as on
 * an unaligned scope. The fold itself ({@link billedByPath}) is unaffected, so a
 * diff still reads them.
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
import type {
  CreditNoteStatusType,
  DocDestinationType,
  Fulfillment,
  FulfillmentItemType,
  Invoice,
  InvoiceDocDestinationType,
  InvoiceDocItemType,
  InvoiceStatusType,
  Order,
  OutOfService,
  Purchase,
  PurchaseBill,
  PurchaseCredit,
  PurchaseDocumentItem,
  PurchaseReceipt,
  PurchaseReceiptItemType,
  Side,
} from "../schemas/mod.ts";
import { billsOutOfService, isDividerItemType, isLineItemType } from "../schemas/mod.ts";
import { type LineMoneyLike, lineUnitsCents, payableStoredMoney, sliceStoredMoney } from "../schemas/_line-money.ts";
import {
  extensionSectionTargets,
  getOrderScopedItems,
  type InvoiceItem,
  invoiceAuthoredSubtrees,
  type MovePointerCarrier,
  orderLineClaims,
  invoiceScopeDividersMatch,
  isInInvoiceAuthoredSubtree,
  isInExtensionSection,
  liveInvoiceAnchors,
  projectOrderItemToInvoiceItem,
  purchaseBillIsLive,
  purchaseCreditIsLive,
  toInvoiceDestinationPair,
  toOrderRelativePath,
} from "./invoices.ts";
import {
  collectSubstitutionAnchors,
  isAtOrBelow,
  type MaybeSubstitution,
  standInUnits,
  substitutionCredit,
} from "./substitutions.ts";
import { BILLABLE_OOS_REASONS, billedOutOfService, type ReplacementBillingInvoice } from "./replacements.ts";
import { bookingIdsByPath } from "./order-edit-delta.ts";
import { parseBookingId } from "./booking-id.ts";
import { inboundBookingIdFor, isReceivedDamagedRecord, PAYABLE_OOS_REASONS } from "./bookings-inbound.ts";

export { substitutionCredit };
import { chargeEnvelope, chicagoDayAtTimeOf, toChicagoYmd } from "./dates.ts";
import { combineTierCounts, meterUnits, priceFromFormula, type PricingFormulas, type TierCount } from "./price-formulas.ts";
import { isPreTaxItem, type LineItem } from "./orders.ts";
import { priceLine } from "./price-document.ts";

/** The invoice shape these functions read — every linked invoice, live or void. */
export interface AccountedInvoice {
  uid: string;
  status: InvoiceStatusType;
  items: InvoiceItem[];
  /** Its document number. {@link buildOverbillingCredits} orders on it, last. */
  number?: number;
  /** Its version, for a reference a later write can be conditioned on. */
  version?: number;
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

/** A pair's charge windows, as an extension compares them: where the last one ends, and each one's bounds. */
export interface BilledWindow {
  /** The last window's end. */
  end: string;
  /**
   * Each window's bounds, in order.
   *
   * 🔴 **These DATES are what say whether a window MOVED.** A day delta under an
   * identical set of dates is an artefact (a holiday recount, a hand-held count)
   * and never a shortening. See {@link groupExtensions}.
   */
  windows: readonly WindowBounds[];
}

/** A pair's {@link BilledWindow}, or `null` when it has no windows. */
export function pairWindow(pair: { dates?: unknown } | undefined): BilledWindow | null {
  const dates = pair?.dates as { charge_windows?: readonly { start: string; end: string }[] } | undefined;
  const envelope = chargeEnvelope({ charge_windows: dates?.charge_windows });
  if (envelope === null || Number.isNaN(Date.parse(envelope.end))) return null;
  return {
    end: envelope.end,
    windows: dates!.charge_windows!.map((w) => ({ start: w.start, end: w.end })),
  };
}

/**
 * What metering a window set needs (ruling 8): every formula the order's and
 * invoices' lines name, and the holiday list.
 */
export interface AccountingContext {
  formulas: PricingFormulas;
  holidays: readonly string[];
}

/**
 * **What `item`'s formula meters from `windows`** — `null` when the line is not
 * on a time formula, or its formula is not loaded. Both sides of an extension
 * are metered here, through the BILLED row's formula, against today's holidays,
 * so their difference is a difference of like with like.
 */
function meterWindows(item: LineItem, windows: readonly WindowBounds[], ctx: AccountingContext): TierCount[] | null {
  if (item.price?.price_formula?.basis !== "time" || windows.length === 0) return null;
  const formula = ctx.formulas.get(item.price.price_formula.uid);
  if (!formula) return null;
  const span = { start: windows[0].start, end: windows[windows.length - 1].end };
  return meterUnits(formula, { windows, span, holidays: ctx.holidays, rates: item.price.rates }).tiers;
}

/** Every tier is zero. */
function countsAreZero(counts: readonly TierCount[]): boolean {
  return counts.every((t) => t.num === 0);
}

/** Two count lists name the same value per key. */
function sameCountValues(a: readonly TierCount[], b: readonly TierCount[]): boolean {
  return countsAreZero(combineTierCounts(a, b, -1));
}

/**
 * The DIRECTION of a count delta: the sign of the money it prices to at the
 * line's own rates, or — on a $0 line — the sign of its summed periods. `+1`
 * is an extension still owed, `−1` a shortening, `0` nothing.
 */
export function countsDirection(item: LineItem, counts: readonly TierCount[]): -1 | 0 | 1 {
  if (countsAreZero(counts)) return 0;
  try {
    const money = priceFromFormula(item.price?.rates ?? [], counts, 1, null).subtotal_cents;
    if (money !== 0) return money > 0 ? 1 : -1;
  } catch {
    // a key the rates lack: fall through to the periods
  }
  const periods = counts.reduce((sum, t) => sum + t.num / t.den, 0);
  return periods > 0 ? 1 : periods < 0 ? -1 : 0;
}

/** The magnitude of a count delta — every tier's sign flipped when the direction is negative. */
export function countsMagnitude(item: LineItem, counts: readonly TierCount[]): TierCount[] {
  return countsDirection(item, counts) < 0 ? counts.map((t) => ({ ...t, num: -t.num })) : [...counts];
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

// ── The one credit keyer (ruling 84) ──────────────────────────────

/** An exact, non-negative-denominator rational — a quantity of a formula's periods. */
export interface TimeAmount {
  num: number;
  den: number;
}

function gcd(a: number, b: number): number {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b) [a, b] = [b, a % b];
  return a || 1;
}

function reduceTime(t: TimeAmount): TimeAmount {
  const g = gcd(t.num, t.den);
  return { num: t.num / g, den: t.den / g };
}

/** `a + b`, exact. */
export function addTime(a: TimeAmount, b: TimeAmount): TimeAmount {
  return reduceTime({ num: a.num * b.den + b.num * a.den, den: a.den * b.den });
}

/** `t × k`, exact. */
export function scaleTime(t: TimeAmount, k: number): TimeAmount {
  return reduceTime({ num: t.num * k, den: t.den });
}

/** The sign of `a − b`, compared exactly by cross-multiplying. */
export function compareTime(a: TimeAmount, b: TimeAmount): number {
  return a.num * b.den - b.num * a.den;
}

/**
 * **One unit's billed time**: Σ a line's `counts`, exact. A line with no counts
 * (none stored) counts as one period, so the budget is exactly its unit count.
 */
export function countsTime(counts: readonly { num: number; den: number }[] | null | undefined): TimeAmount {
  if (!counts || counts.length === 0) return { num: 1, den: 1 };
  return counts.reduce<TimeAmount>((acc, c) => addTime(acc, { num: c.num, den: c.den }), { num: 0, den: 1 });
}

/** What {@link keyInvoiceCredits} reads of a credit-note line: the cap's lines and the fold's alike. */
export interface KeyableCreditLine {
  quantity: number;
  path_invoice_item?: readonly string[];
  uid_invoice_item?: string | null;
  price?: { counts?: readonly { num: number; den: number }[] };
}

/** One credit-note line, as quantity accounting reads it. */
export interface AccountedCreditNoteItem extends KeyableCreditLine {
  quantity: number;
  /** The `path` of the invoice line credited — its row identity on that invoice. */
  path_invoice_item?: readonly string[];
  /**
   * The credited row's uid, for a note stored before paths. Only the CREDITED
   * view (the cap) falls back to it, and only to the first line carrying it;
   * netting never guesses a row.
   */
  uid_invoice_item?: string | null;
  /**
   * True only on a line that un-bills what it credits. Read with `=== true`: a
   * `false` and an absent both mean "not netted".
   */
  reverses_billing?: boolean;
  /**
   * The line's stored counts and pre-tax money. A line whose counts give one
   * unit LESS time than its invoice row's is a time credit (R3); absent counts
   * read as a unit credit.
   */
  price?: { counts?: readonly TierCount[]; subtotal_discounted_cents?: number };
  /**
   * The invoice row's `substituted_for`, sliced to the units this line credits
   * (ruling 84, `api-cloudrun/src/lib/creditNotePointers.ts`). ORDER-relative.
   */
  substituted_for?: readonly { path: readonly string[]; quantity: number }[];
}

/** A credit note as quantity accounting reads it. */
export interface AccountedCreditNote {
  uid: string;
  status: CreditNoteStatusType;
  items: readonly AccountedCreditNoteItem[];
  number?: number;
  version?: number;
  /** Where the credit lands. Exactly one `invoices` entry makes a line attributable. */
  sources?: readonly { collection: string; uid: string }[];
}

/** The invoice row a keyed credit line credits: the fields the keyer reads. */
export interface KeyedInvoiceRow {
  uid: string;
  path: readonly string[];
  quantity?: number;
  price?: { counts?: readonly { num: number; den: number }[] };
}

/** One credit-note line matched to the invoice row it credits. @see {@link keyInvoiceCredits} */
export interface KeyedInvoiceCredit<L extends KeyableCreditLine = KeyableCreditLine, R extends KeyedInvoiceRow = KeyedInvoiceRow> {
  line: L;
  /** The invoice row it credits. */
  row: R;
  /**
   * `units` credits whole units of the row; `time` credits time on `quantity`
   * units and NO units (R3). Read off the stored counts against the row's: a
   * line whose counts give one unit the row's own time (or that stores none)
   * credited units. A time credit of exactly the billed length reads as a unit
   * credit, which is the same money and the same units.
   */
  kind: "units" | "time";
  /** One unit's credited time: the line's own counts, else (none stored) the row's. */
  time: TimeAmount;
}

/**
 * **The one AR credit keyer** (ruling 84): each line of `notes` matched to the
 * row of `rows` it credits, with its kind. Both views read it:
 *
 * - **credited** — the cap ({@link creditableLines}' budget,
 *   {@link unitsCreditedBefore}): every non-void note, marker-free, with the
 *   legacy `uid_invoice_item` fallback (`fallback: true`);
 * - **reversed** — netting ({@link billedByPath}): issued or applied notes,
 *   `reverses_billing === true` lines, by `path_invoice_item` only.
 *
 * The caller has already chosen the notes of ONE invoice. A line it cannot
 * match is returned in `unmatched`.
 */
export function keyInvoiceCredits<L extends KeyableCreditLine, R extends KeyedInvoiceRow>(
  rows: readonly R[],
  lines: readonly L[],
  opts: { fallback: boolean },
): { keyed: KeyedInvoiceCredit<L, R>[]; unmatched: L[] } {
  const byPath = new Map(rows.map((r) => [key(r.path), r] as const));
  const keyed: KeyedInvoiceCredit<L, R>[] = [];
  const unmatched: L[] = [];
  for (const line of lines) {
    let row: R | undefined;
    if (line.path_invoice_item && line.path_invoice_item.length > 0) row = byPath.get(key(line.path_invoice_item));
    else if (opts.fallback && line.uid_invoice_item) row = rows.find((r) => r.uid === line.uid_invoice_item);
    if (row === undefined) {
      unmatched.push(line);
      continue;
    }
    const own = line.price?.counts ?? [];
    const rowTime = countsTime(row.price?.counts);
    const time = own.length > 0 ? countsTime(own) : rowTime;
    keyed.push({ line, row, kind: compareTime(time, rowTime) === 0 ? "units" : "time", time });
  }
  return { keyed, unmatched };
}

/**
 * **`c` — whole units of `row` the non-void `notes` already credited**, the
 * credited view (marker-free, the cap's liveness and matching). A credit line's
 * `substituted_for` slice starts here (ruling 84): units `(c, c + n]`. Time
 * credits take no units (R3), so they do not advance it.
 */
export function unitsCreditedBefore(
  rows: readonly KeyedInvoiceRow[],
  row: Pick<KeyedInvoiceRow, "path">,
  notes: readonly { status: string; items: readonly KeyableCreditLine[] }[],
): number {
  const k = key(row.path);
  let c = 0;
  for (const note of notes) {
    if (note.status === "void") continue;
    for (const credit of keyInvoiceCredits(rows, note.items, { fallback: true }).keyed) {
      if (credit.kind === "units" && key(credit.row.path) === k) c += credit.line.quantity;
    }
  }
  return c;
}

const key = (path: readonly string[]): string => path.join("/");
/** The line types an invoice-only row may project onto a fulfillment. `replacement` bills an out-of-service record and `transaction_fee` is document-level. */
const INVOICE_ONLY_TYPES: ReadonlySet<string> = new Set(["rental", "sale", "service", "surcharge"]);

// ── The one billing fold (one-document-model 6e-0b2 F1–F2; rulings 84, 86–89) ──

/**
 * One row that bills an initiator path — an invoice or bill row, read by
 * {@link billedByPath}, on both sides.
 */
export interface BilledRow {
  /** The billing document the row is on. */
  documentUid: string;
  item: InvoiceItem;
  /**
   * `direct` — the row sits at the initiator path itself (or is a moved row
   * claiming it). `substitute` — the row is a substitute Y whose live anchor
   * names this path. `extension` — the row sits in a date-extension section
   * extending this path: it bills DAYS on units other rows billed, so it adds no
   * quantity.
   */
  via: "direct" | "substitute" | "extension";
  /** Units this row bills AT THIS PATH, net of what reversing credits took back of it. */
  quantity: number;
  /**
   * The money of those units: the row's STORED net, less the substitute shares it
   * moved to the X it stands in for, less what reversing credits took back. On an
   * extension row, its whole stored net (it bills days, not units).
   */
  amount_cents: number;
  /** The window of the billing pair dating the row's section — for an extension row, the extension's own. */
  window: BilledWindow | null;
}

/** One reversing TIME credit (R3), netted against the extension group of the billing row it credits. */
export interface BilledTimeCredit {
  /** The billing document of the row it credits. */
  documentUid: string;
  /** The credited billing row's path on that document. */
  path: readonly string[];
  /** Units whose time it credits. */
  quantity: number;
  /** One unit's credited counts. */
  counts: readonly TierCount[];
}

/** What the billing documents bill at one initiator-relative path. */
export interface BilledAtPath {
  /**
   * Units billed: direct rows, substitute rows and ratio credit from a
   * substituted kit above, net of reversing credits. Signed and UNFLOORED (R2):
   * a negative is an over-credit, which a caller that acts floors where it acts.
   */
  quantity: number;
  /**
   * The money of {@link quantity}, in integer cents, net of reversing credits.
   * Signed and unfloored. ⚠️ Extension rows' money is NOT in it — they bill days
   * on units other rows billed, and each states its own on its row.
   */
  amount_cents: number;
  /** The rows billing this path with a positive count, and every extension row. */
  rows: BilledRow[];
  /** Reversing time credits on rows billing this path. Absent when there are none. */
  time_credits?: BilledTimeCredit[];
  /** The live credit documents whose reversing rows took something back at this path. Absent when none did. */
  credit_documents?: string[];
}

/**
 * **A billing or credit document's header** — what a caller that ACTS on the
 * fold reads besides its rows: the refusal (`status`, `crms_id`), the over-billing
 * offer's order (`amount_due_cents`, `number`), and a diff's reference (`number`,
 * `version`). One per document passed, live or not.
 */
export interface BilledDocument {
  uid: string;
  role: "billing" | "credit";
  /** The side's liveness predicate for its role. */
  live: boolean;
  status: string;
  number: number | null;
  version: number | null;
  /** Set on a CRMS-authored invoice; always `null` on the payable side. */
  crms_id: number | string | null;
  /** What is still owed on a billing document, in integer cents; `null` on a credit, or when not passed. */
  amount_due_cents: number | null;
}

/** Why {@link billedByPath} could not place a document-only row on the initiator's legs. */
export interface DocumentOnlySkip {
  documentUid: string;
  /** The row's path on the document, scope divider first. */
  path: string[];
  /**
   * `no_leg` — the row hangs directly under the scope divider and the initiator
   * has not exactly one destination, so no leg is nameable. `authored_destination`
   * — the row sits under a destination the document authored, which has no
   * initiator pair to date or place a booking.
   */
  reason: "no_leg" | "authored_destination";
  /** The skipped row itself, at its document path, for a reader that counts it (the coverage banner). */
  item: InvoiceItem;
}

/**
 * **The lines the billing documents bill that the initiator does not carry** —
 * the input to the fulfillment's invoice-only projection (api-cloudrun#1188), on
 * both sides, with each line's money. Not document-only: a row at a path the
 * initiator carries, a moved row, an extension row, a substitute (or its
 * components), an out-of-service charge, a `replacement` and a `transaction_fee`.
 */
export interface DocumentOnlyLines {
  /** One line per initiator-relative path, quantity summed across documents and floored above 0, in first-seen order. */
  lines: LineItem[];
  /** Initiator-relative path key → the summed net money of {@link lines}' line there. */
  amount_cents: Map<string, number>;
  /** The dividers the documents authored that {@link lines} hang under, ancestors first. */
  dividers: LineItem[];
  /** Initiator-relative path key → the documents that bill it. */
  documentUids: Map<string, string[]>;
  /** Rows no leg could be named for. Never dropped silently. */
  skipped: DocumentOnlySkip[];
}

/** @see {@link billedByPath} */
export interface BilledByPath {
  /** Keyed by the initiator-relative `path.join("/")`. A path nothing bills has no entry. */
  byPath: Map<string, BilledAtPath>;
  /** What the documents bill that the initiator does not carry. */
  document_only: DocumentOnlyLines;
  /** Live billing documents whose scope was summed. */
  compared: string[];
  /** Live billing documents hung on a different divider skeleton, NOT summed. A caller that acts on the sum refuses when non-empty. */
  unaligned: string[];
  /**
   * Credits carrying a reversing line the fold could not attribute to a billing
   * row, so nothing was netted for them: no path to the row, a path the document
   * no longer carries, or (AR) not exactly one `invoices` source.
   *
   * 🔴 **A caller that reports credits MUST report this too.** Empty because
   * nothing credited and empty because nothing could be READ are the same number
   * otherwise, and the second one silently re-offers units already credited.
   */
  credits_unkeyed: string[];
  /** Every document passed, billing and credit, live or not, by uid. */
  documents: Map<string, BilledDocument>;
}

/** An initiator, as the fold reads it: its uid (its scope divider's uid on every billing document) and CURRENT rows. */
export interface BillingFoldInitiator {
  uid: string;
  items: readonly LineItem[];
}

/** A bill, as the fold reads it. */
export type PayableFoldBill =
  & Pick<PurchaseBill, "uid" | "status" | "items" | "destinations">
  & Partial<Pick<PurchaseBill, "number" | "version">>
  & { totals?: Pick<PurchaseBill["totals"], "amount_due_cents"> };
/** A supplier credit, as the fold reads it. */
export type PayableFoldCredit =
  & Pick<PurchaseCredit, "uid" | "status" | "items" | "destinations">
  & Partial<Pick<PurchaseCredit, "number" | "version">>;

/** The documents {@link billedByPath} takes on each side. */
export interface BillingFoldDocuments {
  receivable: { billing: AccountedInvoice; credit: AccountedCreditNote };
  payable: { billing: PayableFoldBill; credit: PayableFoldCredit };
}

/** What reversing credits take back from one row of one context. */
interface FoldReversal {
  /** Whole units (unit credits only). */
  units: number;
  /** Their net money, time credits included. */
  cents: number;
  /** Stand-in units taken back, by X path key (unit credits only). */
  standIn: Map<string, number>;
  /** Stand-in money taken back, by X path key. */
  standInCents: Map<string, number>;
  time: BilledTimeCredit[];
  /** The credit documents that contributed. */
  credits: Set<string>;
}

/**
 * One document the fold reads a scope of. A BILLING document is a context with
 * `base: 1` and its reversals attached; on the payable side a supplier CREDIT is
 * a context of its own with `base: 0`, its reversing rows being its reversals,
 * placed at their own paths with their own anchors (F1: AP reads a credit's
 * anchors and time test off the credit's own rows).
 */
interface FoldContext {
  documentUid: string;
  items: readonly InvoiceItem[];
  destinations: readonly { uid: string; dates?: unknown; uid_order?: string; uid_purchase?: string }[];
  base: 0 | 1;
  /** Alignment-checked, listed in `compared`/`unaligned`, and reported in `document_only` sources. */
  billing: boolean;
  /** By the row's FULL document path key. */
  reversals: Map<string, FoldReversal>;
}

/**
 * **Everything that differs between the sides in the billing fold** — data,
 * never an `if side` (ruling 84), on the pattern of {@link ScopedSyncSide}.
 * The last two entries (how a credit reaches the row it reverses, and whose
 * anchors and time test it reads) are ruling 34's to collapse into one keyer
 * `(uid_billing, path_billing_item)`; until then they are named here.
 */
export interface BillingFoldSide<B, C> {
  /** The scope divider's type on a billing document. */
  scopeType: "order" | "purchase";
  /** The billing row's move pointer. */
  pointerKey: keyof MovePointerCarrier;
  /** The pair key naming the initiator a billing document's pair belongs to. */
  pairScopeKey: "uid_order" | "uid_purchase";
  billingIsLive(doc: B): boolean;
  creditIsLive(doc: C): boolean;
  /** A billing document's header. */
  billingHeader(doc: B): Omit<BilledDocument, "role" | "live">;
  /** A credit document's header. */
  creditHeader(doc: C): Omit<BilledDocument, "role" | "live">;
  /** A billing document's rows and pairs. */
  billingRows(doc: B): { items: readonly InvoiceItem[]; destinations: FoldContext["destinations"] };
  /** A row's STORED net money (rule 7) — never re-derived. */
  rowNetCents(row: InvoiceItem): number;
  /**
   * The money of units `(before, after]` of a row: the ONE part the fold prices,
   * a substitute entry's share (rule 7, ruling 88 — keyed by what the line's
   * money IS: a rate line through {@link lineUnitsCents}, stored money sliced).
   */
  partCents(row: InvoiceItem, before: number, after: number): number;
  /**
   * The contexts a side's credits contribute, and the reversals they attach to
   * the billing contexts. Receives the live, aligned billing contexts by uid, and
   * the initiator's path keys: a credit's stand-in entries take its first units
   * only where X is still carried (a spent entry stands in for nothing).
   */
  placeCredits(
    billing: ReadonlyMap<string, FoldContext>,
    credits: readonly C[],
    unkeyed: Set<string>,
    scopeUid: string,
    initiatorPaths: ReadonlySet<string>,
  ): FoldContext[];
}

const emptyReversal = (): FoldReversal => ({ units: 0, cents: 0, standIn: new Map(), standInCents: new Map(), time: [], credits: new Set() });

function reversalAt(map: Map<string, FoldReversal>, k: string): FoldReversal {
  let r = map.get(k);
  if (!r) map.set(k, r = emptyReversal());
  return r;
}

/**
 * The stand-in money of each live entry of a row, its FIRST units in stored
 * order (as {@link sliceSubstitutedFor} reads them), by X path key. A spent
 * entry takes no units. Every share lands on X, a root's and a component's
 * alike (api-cloudrun#1475): the money a substitute stands in for is X's.
 */
function standInShares(
  row: { quantity?: number; substituted_for?: readonly { path: readonly string[]; quantity: number }[] },
  liveX: ReadonlySet<string>,
  part: (before: number, after: number) => number,
): Map<string, number> {
  const out = new Map<string, number>();
  let units = 0;
  for (const e of row.substituted_for ?? []) {
    const x = key(e.path);
    if (e.path.length === 0 || e.quantity <= 0 || !liveX.has(x)) continue;
    out.set(x, (out.get(x) ?? 0) + part(units, units + e.quantity));
    units += e.quantity;
  }
  return out;
}

/** A receivable row's stored net: `subtotal_discounted_cents`. */
function receivableNetCents(row: { price?: unknown }): number {
  const price = row.price as { subtotal_discounted_cents?: number } | undefined;
  return price?.subtotal_discounted_cents ?? 0;
}

/**
 * A receivable part (ruling 88): a RATE row through the one line-money function;
 * a stated row, or a credit-note line (which carries no rates), sliced from its
 * stored money.
 */
function receivablePartCents(row: InvoiceItem, before: number, after: number): number {
  const price = row.price as
    | { rates?: unknown[]; stated_cents?: number | null; subtotal_cents?: number; subtotal_discounted_cents?: number; discount?: { amount_cents?: number } | null }
    | undefined;
  if ((price?.rates?.length ?? 0) > 0 && (price?.stated_cents ?? null) === null) {
    return lineUnitsCents(row as unknown as LineMoneyLike, before, after);
  }
  const net = price?.subtotal_discounted_cents ?? 0;
  const gross = price?.subtotal_cents ?? net;
  return sliceStoredMoney({ quantity: row.quantity ?? 0, gross_cents: gross, discount_cents: gross - net }, before, after).net_cents;
}

/** A payable row as the fold's typed accessors read it. */
function payableRow(row: InvoiceItem): PurchaseDocumentItem {
  return row as unknown as PurchaseDocumentItem;
}

/** The receivable side: orders, invoices, credit notes. */
export const RECEIVABLE_BILLING_FOLD: BillingFoldSide<AccountedInvoice, AccountedCreditNote> = {
  scopeType: "order",
  pointerKey: "path_order_item",
  pairScopeKey: "uid_order",
  billingIsLive: (doc) => doc.status !== "void",
  creditIsLive: (doc) => doc.status === "issued" || doc.status === "applied",
  billingHeader: (doc) => ({
    uid: doc.uid,
    status: doc.status,
    number: doc.number ?? null,
    version: doc.version ?? null,
    crms_id: doc.crms_id === undefined || doc.crms_id === "" ? null : doc.crms_id,
    amount_due_cents: doc.amount_due_cents ?? null,
  }),
  creditHeader: (doc) => ({
    uid: doc.uid,
    status: doc.status,
    number: doc.number ?? null,
    version: doc.version ?? null,
    crms_id: null,
    amount_due_cents: null,
  }),
  billingRows: (doc) => ({ items: doc.items ?? [], destinations: doc.destinations ?? [] }),
  rowNetCents: receivableNetCents,
  partCents: receivablePartCents,
  // A note's reversing lines attach to the INVOICE row they credit
  // (`keyInvoiceCredits`' reversed view): its anchors and its time test are the
  // invoice row's. A note naming not exactly one invoice is unkeyed.
  placeCredits(billing, credits, unkeyed, _scopeUid, initiatorPaths) {
    for (const note of credits) {
      if (!RECEIVABLE_BILLING_FOLD.creditIsLive(note)) continue;
      const reversing = note.items.filter((l) => l.reverses_billing === true);
      if (reversing.length === 0) continue;
      const invoices = (note.sources ?? []).filter((s) => s.collection === "invoices");
      if (invoices.length !== 1) {
        unkeyed.add(note.uid);
        continue;
      }
      const ctx = billing.get(invoices[0].uid);
      if (ctx === undefined) continue;
      const rows = ctx.items.filter((it) => isLineItemType(it.type)) as KeyedInvoiceRow[];
      const { keyed, unmatched } = keyInvoiceCredits(rows, reversing, { fallback: false });
      if (unmatched.length > 0) unkeyed.add(note.uid);
      for (const credit of keyed) {
        const r = reversalAt(ctx.reversals, key(credit.row.path));
        r.credits.add(note.uid);
        const line = credit.line;
        r.cents += line.price?.subtotal_discounted_cents ?? 0;
        if (credit.kind === "time") {
          r.time.push({ documentUid: ctx.documentUid, path: credit.row.path, quantity: line.quantity, counts: line.price?.counts ?? [] });
          continue;
        }
        r.units += line.quantity;
        const asRow = line as unknown as InvoiceItem;
        let units = 0;
        for (const e of line.substituted_for ?? []) {
          const x = key(e.path);
          if (e.path.length === 0 || e.quantity <= 0 || !initiatorPaths.has(x)) continue;
          r.standIn.set(x, (r.standIn.get(x) ?? 0) + e.quantity);
          r.standInCents.set(x, (r.standInCents.get(x) ?? 0) + receivablePartCents(asRow, units, units + e.quantity));
          units += e.quantity;
        }
      }
    }
    return [];
  },
};

/** The payable side: purchases, bills, supplier credits. */
export const PAYABLE_BILLING_FOLD: BillingFoldSide<PayableFoldBill, PayableFoldCredit> = {
  scopeType: "purchase",
  pointerKey: "path_purchase_item",
  pairScopeKey: "uid_purchase",
  billingIsLive: purchaseBillIsLive,
  creditIsLive: purchaseCreditIsLive,
  billingHeader: (doc) => ({
    uid: doc.uid,
    status: doc.status,
    number: doc.number ?? null,
    version: doc.version ?? null,
    crms_id: null,
    amount_due_cents: doc.totals?.amount_due_cents ?? null,
  }),
  creditHeader: (doc) => ({
    uid: doc.uid,
    status: doc.status,
    number: doc.number ?? null,
    version: doc.version ?? null,
    crms_id: null,
    amount_due_cents: null,
  }),
  billingRows: (doc) => ({ items: doc.items as unknown as InvoiceItem[], destinations: doc.destinations }),
  rowNetCents: (row) => payableRow(row).amount_cents ?? 0,
  partCents: (row, before, after) => sliceStoredMoney(payableStoredMoney(payableRow(row)), before, after).net_cents,
  // A supplier credit is its OWN context: its reversing rows are placed at their
  // own paths (the writer copies the bill row's), with the credit's own anchors.
  // A row carrying counts is a time credit (R3): counts and money, never units.
  placeCredits(_billing, credits, _unkeyed, scopeUid, initiatorPaths) {
    const contexts: FoldContext[] = [];
    for (const credit of credits) {
      if (!PAYABLE_BILLING_FOLD.creditIsLive(credit)) continue;
      const items = credit.items as unknown as InvoiceItem[];
      const reversals = new Map<string, FoldReversal>();
      for (const row of items) {
        if (!isLineItemType(row.type) || row.path[0] !== scopeUid) continue;
        const line = payableRow(row);
        if (line.reverses_billing !== true) continue;
        const r = reversalAt(reversals, key(row.path));
        r.credits.add(credit.uid);
        r.cents += line.amount_cents ?? 0;
        const time = (line.price?.counts?.length ?? 0) > 0;
        if (time) {
          r.time.push({
            documentUid: line.uid_purchase_bill ?? credit.uid,
            path: line.path_bill_item ?? line.path,
            quantity: line.quantity,
            counts: line.price.counts,
          });
        } else {
          r.units += line.quantity;
        }
        let units = 0;
        for (const e of ("substituted_for" in line ? line.substituted_for : undefined) ?? []) {
          const x = key(e.path);
          if (e.path.length === 0 || e.quantity <= 0 || !initiatorPaths.has(x)) continue;
          if (!time) r.standIn.set(x, (r.standIn.get(x) ?? 0) + e.quantity);
          r.standInCents.set(x, (r.standInCents.get(x) ?? 0) + PAYABLE_BILLING_FOLD.partCents(row, units, units + e.quantity));
          units += e.quantity;
        }
      }
      if (reversals.size > 0) {
        contexts.push({ documentUid: credit.uid, items, destinations: credit.destinations ?? [], base: 0, billing: false, reversals });
      }
    }
    return contexts;
  },
};

/** The two sides' fold data. Typed per side, so a caller's documents are its side's. */
export const BILLING_FOLD: { [S in Side]: BillingFoldSide<BillingFoldDocuments[S]["billing"], BillingFoldDocuments[S]["credit"]> } = {
  receivable: RECEIVABLE_BILLING_FOLD,
  payable: PAYABLE_BILLING_FOLD,
};

/**
 * **The one billing fold** (one-document-model 6e-0b2, rulings 84 and 86–89):
 * what an initiator's billing documents bill at each initiator path — units,
 * rows, money and time credits — net of reversing credits, on BOTH sides, and
 * what they bill that the initiator does not carry.
 *
 * It replaced the AR fold, its invoice-only pass and the per-document payable
 * fold (deleted in beta F) with one set of rules, each written once (F2):
 *
 * 1. **Alignment on both sides.** A billing document whose scope hangs on
 *    another divider skeleton is left out and named in `unaligned`.
 * 2. **A moved row** (its move pointer names initiator line X) bills X, at X's
 *    terms, before the authored test.
 * 3. **A row under a divider the document authored** bills no initiator line; it
 *    goes to `document_only`. A document-added row under an INITIATOR divider is
 *    keyed at its own path AND reported in `document_only`.
 * 4. **An extension row** (under a destination carrying `path_extension_for`) is
 *    `via: "extension"` at the extended path, adds no units, and carries its window.
 * 5. **A substitute's** live entries take its first units, in stored order; each
 *    entry's units bill X (a root's directly, a component's through the ratio
 *    walk), and every entry's share of the money lands on X. The rest is the
 *    row's own, at its own path.
 * 6. **The ratio walk is SUMMED** (ruling 87): stand-in units across every live
 *    document, credits at sign −1, then `substitutionCredit` once.
 * 7. **Money** is each row's STORED net, never re-derived; the only part priced
 *    is a substitute's share ({@link BillingFoldSide.partCents}).
 * 8. **A credit row nets only when `reverses_billing === true`**, at sign −1,
 *    placed per side ({@link BillingFoldSide.placeCredits}); a time credit nets
 *    counts and money, never units (R3).
 *
 * The per-side data is {@link BILLING_FOLD}; nothing here branches on the side.
 *
 * @param side - Which side's documents these are
 * @param initiator - The order or purchase, with its CURRENT rows
 * @param billing - Every billing document linked to it, live or not, WHOLE
 * @param credits - Every credit document on it. The fold drops dead ones itself.
 */
export function billedByPath<S extends Side>(
  side: S,
  initiator: BillingFoldInitiator,
  billing: readonly BillingFoldDocuments[S]["billing"][],
  credits: readonly BillingFoldDocuments[S]["credit"][] = [],
): BilledByPath {
  const fold: BillingFoldSide<BillingFoldDocuments[S]["billing"], BillingFoldDocuments[S]["credit"]> = BILLING_FOLD[side];
  const scopeUid = initiator.uid;
  const initiatorItems = initiator.items as LineItem[];
  const compared: string[] = [];
  const unaligned: string[] = [];
  const unkeyed = new Set<string>();

  /**
   * One document's rows in this initiator's scope, the scope divider itself left
   * out: it has no initiator counterpart, and the shared helpers excuse only an
   * `order` divider by type, so a bill's `purchase` divider would read as a
   * divider the purchase lacks.
   */
  const scopeOf = (items: readonly InvoiceItem[]) =>
    getOrderScopedItems([...items], scopeUid).filter((it) => it.type !== fold.scopeType);

  const documents = new Map<string, BilledDocument>();
  for (const doc of billing) {
    documents.set(fold.billingHeader(doc).uid, { ...fold.billingHeader(doc), role: "billing", live: fold.billingIsLive(doc) });
  }
  for (const doc of credits) {
    documents.set(fold.creditHeader(doc).uid, { ...fold.creditHeader(doc), role: "credit", live: fold.creditIsLive(doc) });
  }
  const billingContexts = new Map<string, FoldContext>();
  for (const doc of billing) {
    if (!fold.billingIsLive(doc)) continue;
    const { items, destinations } = fold.billingRows(doc);
    const uid = (doc as { uid: string }).uid;
    const scoped = scopeOf(items);
    if (scoped.length > 0 && !invoiceScopeDividersMatch(scoped, initiatorItems, scopeUid, fold.pointerKey)) {
      unaligned.push(uid);
      continue;
    }
    compared.push(uid);
    billingContexts.set(uid, { documentUid: uid, items, destinations, base: 1, billing: true, reversals: new Map() });
  }
  const initiatorPaths = new Set<string>();
  const initiatorDestinations: string[] = [];
  for (const it of initiatorItems) {
    initiatorPaths.add(key(it.path ?? []));
    if (it.type === "destination") initiatorDestinations.push(it.uid);
  }
  const contexts = [
    ...billingContexts.values(),
    ...fold.placeCredits(billingContexts, credits, unkeyed, scopeUid, initiatorPaths),
  ];

  const byPath = new Map<string, BilledAtPath>();
  const at = (k: string): BilledAtPath => {
    let entry = byPath.get(k);
    if (!entry) byPath.set(k, entry = { quantity: 0, amount_cents: 0, rows: [] });
    return entry;
  };
  const add = (k: string, units: number, cents: number, row: Omit<BilledRow, "quantity" | "amount_cents">) => {
    if (units === 0 && cents === 0) return;
    const entry = at(k);
    entry.quantity += units;
    entry.amount_cents += cents;
    if (units > 0) entry.rows.push({ ...row, quantity: units, amount_cents: cents });
  };
  /** Record which credit documents took something back at `k`. */
  const noteCredits = (k: string, rev: FoldReversal) => {
    if (rev.credits.size === 0) return;
    const entry = at(k);
    const docs = new Set(entry.credit_documents ?? []);
    for (const uid of rev.credits) docs.add(uid);
    entry.credit_documents = [...docs];
  };
  const addTimeCredits = (k: string, credits: readonly BilledTimeCredit[]) => {
    if (credits.length === 0) return;
    const entry = at(k);
    entry.time_credits = [...(entry.time_credits ?? []), ...credits];
  };
  /** Stand-in units credited to an initiator path through a substitute, before the ratio walk. */
  const substituteCredit = new Map<string, number>();

  // document_only (F1)
  const summed = new Map<string, { line: LineItem; quantity: number; cents: number; documents: string[] }>();
  const dividers = new Map<string, LineItem>();
  const skipped: DocumentOnlySkip[] = [];

  for (const ctx of contexts) {
    const scoped = scopeOf(ctx.items);
    const anchors = liveInvoiceAnchors(scoped, initiatorItems, scopeUid);
    const extensionTargets = extensionSectionTargets(scoped, scopeUid);
    const authored = invoiceAuthoredSubtrees(scoped, initiatorItems, scopeUid);
    const claims = orderLineClaims(scoped, scopeUid, fold.pointerKey);
    const scopedByKey = new Map(scoped.map((it) => [key(it.path ?? []), it] as const));
    // A document on no pair bills on no window (AR's `destinations?.find`), so it extends nothing.
    const windowOf = (item: InvoiceItem) =>
      pairWindow((ctx.destinations ?? []).find((pair) => pair.uid === (item.path ?? [])[1] && pair[fold.pairScopeKey] === scopeUid));
    const rowInfo = (item: InvoiceItem, via: BilledRow["via"]) => ({ documentUid: ctx.documentUid, item, via, window: windowOf(item) });

    for (const item of scoped) {
      if (!isLineItemType(item.type)) continue;
      const path = item.path ?? [];
      const rev = ctx.reversals.get(key(path)) ?? emptyReversal();
      const baseUnits = ctx.base * (item.quantity ?? 0);
      const baseCents = ctx.base * fold.rowNetCents(item);
      const rel = path.slice(1);

      // document_only: what the initiator does not carry.
      if (
        INVOICE_ONLY_TYPES.has(item.type) && !billsOutOfService(item) &&
        !isInExtensionSection(path, scopeUid, extensionTargets) &&
        !claims.has(key(rel)) && !initiatorPaths.has(key(rel)) &&
        !anchors.some((a) => isAtOrBelow(rel, a.path))
      ) {
        let placed: string[] | null = rel;
        if (rel.length === 1) {
          if (initiatorDestinations.length !== 1) {
            if (ctx.billing) skipped.push({ documentUid: ctx.documentUid, path: [...path], reason: "no_leg", item });
            placed = null;
          } else placed = [initiatorDestinations[0], ...rel];
        } else if (!initiatorDestinations.includes(rel[0])) {
          if (ctx.billing) skipped.push({ documentUid: ctx.documentUid, path: [...path], reason: "authored_destination", item });
          placed = null;
        }
        if (placed !== null && !initiatorPaths.has(key(placed))) {
          const k = key(placed);
          const units = baseUnits - rev.units;
          const cents = baseCents - rev.cents;
          const entry = summed.get(k);
          if (entry) {
            entry.quantity += units;
            entry.cents += cents;
            if (ctx.billing && !entry.documents.includes(ctx.documentUid)) entry.documents.push(ctx.documentUid);
          } else {
            // The move pointer is the billing row's, never the line's.
            const { path_order_item: _o, path_purchase_item: _p, ...row } = item as InvoiceItem & MovePointerCarrier;
            summed.set(k, { line: { ...row, path: placed }, quantity: units, cents, documents: ctx.billing ? [ctx.documentUid] : [] });
          }
          for (let depth = 2; depth < rel.length; depth++) {
            const ancestor = rel.slice(0, depth);
            const ak = key(ancestor);
            if (initiatorPaths.has(ak) || dividers.has(ak)) continue;
            const divider = scopedByKey.get(key([scopeUid, ...ancestor]));
            if (divider) dividers.set(ak, { ...divider, path: ancestor } as LineItem);
          }
        }
      }

      // Rule 2: a moved row bills X directly, before the authored test.
      const claim = claims.get(key(rel));
      if (claim !== undefined) {
        add(key(claim), baseUnits - rev.units, baseCents - rev.cents, rowInfo(item, "direct"));
        addTimeCredits(key(claim), rev.time);
        noteCredits(key(claim), rev);
        continue;
      }
      // Rule 3: a row under a divider the document authored bills no initiator line.
      if (isInInvoiceAuthoredSubtree(path, scopeUid, authored)) continue;
      // Rule 4: an extension row bills days on units other rows billed; a credit of one nets nothing.
      if (isInExtensionSection(path, scopeUid, extensionTargets)) {
        if (ctx.base === 1) {
          at(key(toOrderRelativePath(path, scopeUid, extensionTargets))).rows.push({
            ...rowInfo(item, "extension"),
            quantity: item.quantity ?? 0,
            amount_cents: baseCents,
          });
        }
        continue;
      }
      addTimeCredits(key(rel), rev.time);
      noteCredits(key(rel), rev);
      const enclosing = anchors.filter((a) => isAtOrBelow(rel, a.path));
      if (enclosing.length === 0) {
        add(key(rel), baseUnits - rev.units, baseCents - rev.cents, rowInfo(item, "direct"));
        continue;
      }
      // Rule 5. Root vs component is the context's anchors: the billing row's (AR,
      // and an AP bill), the credit's own (an AP credit).
      const liveX = new Set(enclosing.map((a) => key(a.substitutedFor)));
      const shares = ctx.base === 1
        ? standInShares(item, liveX, (b, a) => fold.partCents(item, b, a))
        : new Map<string, number>();
      let creditedStandIn = 0;
      let creditedStandInCents = 0;
      for (const x of liveX) {
        creditedStandIn += rev.standIn.get(x) ?? 0;
        creditedStandInCents += rev.standInCents.get(x) ?? 0;
      }
      let sharedCents = 0;
      for (const x of liveX) {
        const cents = (shares.get(x) ?? 0) - (rev.standInCents.get(x) ?? 0);
        sharedCents += shares.get(x) ?? 0;
        if (cents !== 0) at(x).amount_cents += cents;
        if ((rev.standIn.get(x) ?? 0) !== 0 || (rev.standInCents.get(x) ?? 0) !== 0) noteCredits(x, rev);
      }
      for (const anchor of enclosing) {
        if (key(anchor.path) !== key(rel)) continue;
        const x = key(anchor.substitutedFor);
        const standIn = ctx.base * anchor.quantity - (rev.standIn.get(x) ?? 0);
        if (standIn > 0) {
          at(x).rows.push({ ...rowInfo(item, "substitute"), quantity: standIn, amount_cents: shares.get(x) ?? 0 });
        }
        if (standIn !== 0) substituteCredit.set(x, (substituteCredit.get(x) ?? 0) + standIn);
      }
      const own = baseUnits - ctx.base * standInUnits(item, liveX);
      add(
        key(rel),
        own - (rev.units - creditedStandIn),
        baseCents - sharedCents - (rev.cents - creditedStandInCents),
        rowInfo(item, "direct"),
      );
    }
  }

  // Rule 6: the ratio walk, once per initiator line, summed across every document.
  for (const [k, units] of substitutionCredit(initiatorItems, substituteCredit)) at(k).quantity += units;

  const kept = [...summed].filter(([, e]) => e.quantity > 0);
  const keptKeys = kept.map(([k]) => k);
  return {
    byPath,
    document_only: {
      lines: kept.map(([, e]) => ({ ...e.line, quantity: e.quantity })),
      amount_cents: new Map(kept.map(([k, e]) => [k, e.cents] as const)),
      dividers: [...dividers].filter(([dk]) => keptKeys.some((k) => k.startsWith(`${dk}/`))).map(([, d]) => d),
      documentUids: new Map(kept.map(([k, e]) => [k, e.documents] as const)),
      skipped,
    },
    compared,
    unaligned,
    credits_unkeyed: [...unkeyed],
    documents,
  };
}

// ── What a caller that ACTS reads off the fold (ruling 42) ──

/**
 * **Units billed at a path, as a caller that ACTS reads them** (ruling 42, R2):
 * the fold's signed count floored at 0, so an over-credit bills nothing extra
 * and frees nothing below zero. The diff reads the fold unfloored instead.
 * {@link accountInitiator} and every payable reader share this one floor.
 *
 * @param fold - {@link billedByPath} over the initiator's documents
 * @param path - The initiator-relative line path
 */
export function actedBilledUnits(fold: Pick<BilledByPath, "byPath">, path: readonly string[]): number {
  return Math.max(0, fold.byPath.get(key(path))?.quantity ?? 0);
}

/**
 * **Units of a line still to bill** (ruling 42's one remaining-to-bill engine):
 * ordered less what is billed, floored at 0, so an over-billed line (legal,
 * flagged by the diff) has nothing left. Pass the ACTED billed units
 * ({@link actedBilledUnits}).
 *
 * ⚠️ A TIME line's remaining is its never-billed units; what it still owes in
 * TIME is its owed extension groups (`LineAccount.remaining.owed`), not this.
 *
 * @param item - The initiator line (its ordered `quantity`)
 * @param billedUnits - Acted billed units, ≥ 0
 */
export function remainingToBill(item: { quantity: number }, billedUnits: number): number {
  return Math.max(0, item.quantity - billedUnits);
}

/**
 * **Does the billing fold NAME this line?** A live direct or substitute row
 * bills it (units through a substituted kit included), or a live reversing
 * credit took something back from it. An extension row alone does not: it bills
 * days on units billed elsewhere; nor does a money-only residual with no units
 * and no row. `LineAccount.named` is this, and a payable line it names is
 * "touched" (ruling 102).
 *
 * @param at - The fold's entry at the line's path, if any
 */
export function billingNamesLine(at: BilledAtPath | undefined): boolean {
  return at !== undefined &&
    (at.quantity !== 0 || at.rows.some((r) => r.via !== "extension") || (at.credit_documents?.length ?? 0) > 0);
}

// ── The one per-line account (one-document-model 6e-0b2 F9, rulings 90–92) ──

/** Why a line's documents disagree. Empty set ⇔ no quantity entry. */
export type Disagreement = "quantity" | "extension" | "money";

/**
 * A custody document's row at one initiator-relative path: a fulfillment row
 * (AR) or a receipt row's received units (AP). `item` is the custody row, read
 * for an exchange unit and for a row the initiator does not carry.
 */
export interface CustodyRow {
  quantity: number;
  item: LineItem | null;
}

/**
 * **One initiator line's account** — every quantity and money figure the diff,
 * the remaining invoice, the over-billing offer, the coverage banner and the
 * payable writers read about it, decided once (ruling 92).
 */
export interface LineAccount {
  /** Initiator-relative path — the line's identity on its initiator. */
  path: string[];
  item: LineItem;
  /**
   * `exchange` — a unit sent in place of a lost, damaged or dirty one: shown,
   * never owed (decision 8). `stated` — its money is a stated total
   * (`price.stated_cents`), so billed money can disagree with what the billed
   * units cost. `rate` — everything else.
   */
  kind: "rate" | "stated" | "exchange";
  /**
   * A live direct or substitute row bills it (units through a substituted kit
   * included), or a reversing credit took something back from it. An extension
   * row alone does not name it: it bills days on units billed elsewhere.
   */
  named: boolean;
  /** The live billing documents whose rows bill it, in fold order. */
  naming: string[];
  /** The live credit documents that took something back from it. */
  credit_sources: string[];
  /** The initiator line's quantity. */
  ordered: number;
  /** What the fold bills at the path. Signed and unfloored (R2). */
  billed: { quantity: number; amount_cents: number; rows: BilledRow[] };
  /** `ordered − billed.quantity`. Negative is over-billing. */
  quantity: number;
  /** The money of {@link quantity} units at the line's terms (ruling 39's one function), signed with it. */
  quantity_cents: number;
  /**
   * Extra or shortened time on billed units (rulings 36, 89), each group signed
   * by its direction; and `billed`, EVERY group of billed units with the time
   * billed on them (credits netted), in step or not — what a supplier credit's
   * time default reads (owner 2026-11-15, "newest time first").
   */
  extension: { groups: ExtensionGroup[]; amount_cents: number; billed: BilledTimeGroup[] };
  /** What the billed units should cost, on a STATED line only (39); `null` otherwise. */
  expected_cents: number | null;
  /**
   * What the custody document records at the path, and the money of
   * `custody − billed` at the line's terms. SHOWN, never a reason (ruling 35).
   * `null` when no custody row exists for the line.
   */
  custody: { quantity: number; quantity_cents: number } | null;
  /** What a remaining invoice / bill would bill (ruling 42's engine reads this). */
  remaining: {
    /** Units still to bill: `ordered − max(0, billed)`, floored at 0 (R2: an over-credit bills nothing extra). */
    units: number;
    /** Extension groups still owed (direction +1). */
    owed: ExtensionGroup[];
    /** A remainder would bill something for this line. */
    bills: boolean;
    /** Why an owed extension cannot be built yet. */
    blocked: "substitute_extension" | null;
  };
  /** What was billed beyond the line: units, and shortened windows (direction −1). */
  overbilled: { units: number; shortened: ExtensionGroup[] };
  /** The credit lines the over-billing offer would raise for it, and what it refuses. */
  credit: { lines: OverbillingCreditLine[]; refused: string[] };
  /** Why the documents disagree about it. Empty ⇔ no quantity entry. */
  disagrees: ReadonlySet<Disagreement>;
}

/** A row only the custody document carries (ruling 35's exception), against what is billed at its path. */
export interface CustodyOnlyAccount {
  path: string[];
  item: LineItem | null;
  custody: number;
  billed: number;
}

/** A lost or damaged record, pre-placed by the caller at the row that books it (or `null`). */
export interface OutOfServiceInput {
  uid: string;
  /** Its billable units (`quantity − returned_to_service`, or 0 once canceled). */
  fulfilled: number;
  /** What non-void billing lines naming it bill. */
  invoiced: number;
  /** The initiator-relative row key it is filed at; `null` when no row books it. */
  rel: string | null;
}

/** @see {@link accountInitiator} */
export interface InitiatorAccount {
  side: Side;
  initiatorUid: string;
  lines: LineAccount[];
  /** Custody rows the initiator lacks whose billed figure differs; empty until a billing document is compared. */
  custody_only: CustodyOnlyAccount[];
  /** Records whose billed figure differs from their billable units; empty until a billing document is compared. */
  out_of_service: OutOfServiceInput[];
  document_only: DocumentOnlyLines;
  compared: string[];
  unaligned: string[];
  credits_unkeyed: string[];
  documents: Map<string, BilledDocument>;
  /** Any live billing document is CRMS-authored (AR data; always `false` on AP). */
  crms_blocked: boolean;
  /** The shared fail-closed rule for a caller that ACTS: `unaligned` non-empty or `crms_blocked`. */
  refused: boolean;
}

/** What the account reads of an `out-of-service` record. */
export type DocumentDiffOutOfService = Pick<OutOfService, "uid" | "reason" | "status" | "quantity" | "query_by_sources"> & {
  breakdown: Pick<OutOfService["breakdown"], "returned_to_service">;
};

/**
 * **A custody document's rows as the account's custody input** (F9, F11): each
 * line of the fulfillment (AR) or the purchase receipt (AP) by its
 * initiator-relative key — both sides' custody documents share their
 * initiator's path space, so one function reads either. The figure is the
 * document's own stated count (the picker's or the receiver's), never the
 * movement journal's: custody is SHOWN, never a reason (ruling 35).
 *
 * A row a substitution explains is left out — its `substituted` entry is that
 * row's answer, and a custody figure there would report it twice. A receipt
 * carries no substitution, so the skip is vacuous there.
 */
export function custodyRows(doc: Fulfillment | PurchaseReceipt): Map<string, CustodyRow> {
  const items = doc.items as readonly (FulfillmentItemType | PurchaseReceiptItemType)[];
  const anchors = collectSubstitutionAnchors(items as readonly MaybeSubstitution[]);
  const out = new Map<string, CustodyRow>();
  for (const it of items) {
    if (isDividerItemType(it.type)) continue;
    const rel = it.path.join("/");
    if (anchors.some((a) => a.path.join("/") === rel || a.substitutedFor.join("/") === rel)) continue;
    const item = it as unknown as LineItem;
    out.set(rel, { quantity: item.quantity ?? 0, item });
  }
  return out;
}

/**
 * **An order's lost/damaged records as the account's input** (decision 9): each
 * billable record's units and what non-void invoices bill it, placed at the row
 * that owns its booking (the order first, then the fulfillment), or `null`.
 */
export function orderOutOfServiceInputs(
  order: Order,
  fulfillment: Fulfillment | undefined,
  records: readonly DocumentDiffOutOfService[],
  invoices: readonly Invoice[],
): OutOfServiceInput[] {
  const orderKey = `orders:${order.uid}`;
  const billable = records.filter((r) =>
    (BILLABLE_OOS_REASONS as readonly string[]).includes(r.reason) && r.query_by_sources.includes(orderKey)
  );
  if (billable.length === 0) return [];
  const rowByBooking = new Map<string, string>();
  for (const doc of [order, fulfillment]) {
    if (doc === undefined) continue;
    for (const { path, bookingId } of bookingIdsByPath(doc as unknown as Order)) {
      if (!rowByBooking.has(bookingId)) rowByBooking.set(bookingId, path.join("/"));
    }
  }
  const invoicedByRecord = billedOutOfService(
    invoices.filter((i) => i.status !== "void") as unknown as ReplacementBillingInvoice[],
  );
  return billable.map((record) => {
    // ⚠️ Deliberately NOT every terminal bucket (api-cloudrun#1360, D6).
    const fulfilled = record.status === "canceled" ? 0 : record.quantity - record.breakdown.returned_to_service;
    const bookingId = record.query_by_sources
      .filter((s) => s.startsWith("bookings:"))
      .map((s) => s.slice("bookings:".length))
      .find((id) => parseBookingId(id)?.orderUid === order.uid);
    return {
      uid: record.uid,
      fulfilled,
      invoiced: invoicedByRecord.get(record.uid) ?? 0,
      rel: bookingId === undefined ? null : rowByBooking.get(bookingId) ?? null,
    };
  });
}

/**
 * **A purchase's lost/damaged records as the account's input** (one-document-model
 * F12, rulings 96–99): the payable twin of {@link orderOutOfServiceInputs}.
 *
 * - **Which records:** every record naming `purchases:<uid>` whose reason a
 *   supplier settles ({@link PAYABLE_OOS_REASONS}) — the cause does not filter
 *   (ruling 97), so a supplier charging for its own damage is seen.
 * - **`fulfilled`, what the supplier is expected to bill, depends on the CAUSE**
 *   (ruling 97): a unit lost or damaged on CFS's watch is its billable units, as
 *   on the receivable side; a unit RECEIVED damaged is the supplier's fault and
 *   expects 0. The cause is read off the record's id ({@link isReceivedDamagedRecord},
 *   ruling 99).
 * - **`invoiced`**: what the non-void bills' lines naming it bill (`out_of_service`, W4R).
 * - **`rel`**: the purchase (then receipt) row owning its inbound booking
 *   (`bookings-inbound:<uid>`, ruling 98), kept only when that id parses to THIS
 *   purchase; else `null` (unplaced).
 *
 * A record may also name an order (a customer's loss of a subrented unit); it
 * then surfaces on both initiators, each against its own billing documents.
 */
export function purchaseOutOfServiceInputs(
  purchase: Pick<Purchase, "uid" | "items">,
  receipt: Pick<PurchaseReceipt, "items"> | undefined,
  records: readonly DocumentDiffOutOfService[],
  bills: readonly PurchaseBill[],
): OutOfServiceInput[] {
  const purchaseKey = `purchases:${purchase.uid}`;
  const settled = records.filter((r) =>
    (PAYABLE_OOS_REASONS as readonly string[]).includes(r.reason) && r.query_by_sources.includes(purchaseKey)
  );
  if (settled.length === 0) return [];
  const rowByBooking = new Map<string, string>();
  for (const items of [purchase.items, receipt?.items ?? []]) {
    for (const row of items as readonly { uid: string; type: string; path: readonly string[] }[]) {
      if (isDividerItemType(row.type)) continue;
      const bookingId = inboundBookingIdFor(purchase.uid, row);
      if (!rowByBooking.has(bookingId)) rowByBooking.set(bookingId, row.path.join("/"));
    }
  }
  const billedByRecord = billedOutOfService(bills as unknown as ReplacementBillingInvoice[]);
  return settled.map((record) => {
    const fulfilled = record.status === "canceled" || isReceivedDamagedRecord(record)
      ? 0
      : record.quantity - record.breakdown.returned_to_service;
    const bookingId = record.query_by_sources
      .filter((s) => s.startsWith("bookings-inbound:"))
      .map((s) => s.slice("bookings-inbound:".length))
      .find((id) => parseBookingId(id)?.orderUid === purchase.uid);
    return {
      uid: record.uid,
      fulfilled,
      invoiced: billedByRecord.get(record.uid) ?? 0,
      rel: bookingId === undefined ? null : rowByBooking.get(bookingId) ?? null,
    };
  });
}

/** The initiator as {@link accountInitiator} reads it. */
export interface AccountedInitiator {
  uid: string;
  items: readonly LineItem[];
  /** Its CURRENT pairs, which date every extension. */
  destinations: readonly { uid: string; dates?: unknown }[];
}

/** A line's units `(0, |n|]` at its own terms, signed with `n`: the one function (ruling 39), per what its money IS (ruling 88). */
function unitsMoney(side: Side, item: LineItem, n: number): number {
  if (n === 0 || !isPreTaxItem(item)) return 0;
  return Math.sign(n) * BILLING_FOLD[side].partCents(item as unknown as InvoiceItem, 0, Math.abs(n));
}

/** An exchange unit: sent in place of a lost, damaged or dirty one (decision 8). */
function isExchangeLine(item: LineItem | null | undefined): boolean {
  const entries = (item as { exchanged_for?: readonly unknown[] } | null | undefined)?.exchanged_for;
  return Array.isArray(entries) && entries.length > 0;
}

/**
 * **The one per-line account** (one-document-model 6e-0b2 F9, ruling 92): every
 * initiator line's quantity and money facts, read off {@link billedByPath}, on
 * both sides. Every caller that decides "is it billed", "what is left", "what
 * was over-billed" or "show a quantity entry" reads this, never the fold:
 *
 * - **`disagrees`** is built here and nowhere else: `quantity` once any live
 *   billing document is compared (ruling 90) or a live credit document took
 *   something back at the line, any extension group (36, 89), or a STATED line
 *   whose billed money differs from what its billed units cost (39).
 *   Custody never adds a reason (35), and an exchange unit never disagrees.
 * - **`remaining` / `overbilled` / `credit`** are what the remainder and the
 *   over-billing offer assemble; their refusals (`refused`) are the initiator's.
 *
 * @param side - Which side's documents the fold read
 * @param initiator - The order or purchase, with its CURRENT rows and pairs
 * @param fold - {@link billedByPath} over the same initiator
 * @param custody - The custody document's rows by initiator-relative key; `null` when not passed
 * @param outOfService - Lost/damaged records, pre-placed; empty when not compared
 * @param ctx - formulas and holidays the extension meters with
 */
export function accountInitiator(
  side: Side,
  initiator: AccountedInitiator,
  fold: BilledByPath,
  custody: ReadonlyMap<string, CustodyRow> | null,
  outOfService: readonly OutOfServiceInput[],
  ctx: AccountingContext,
): InitiatorAccount {
  const live = (uid: string) => fold.documents.get(uid)?.live === true;
  const crmsBlocked = [...fold.documents.values()].some((d) => d.role === "billing" && d.live && d.crms_id !== null);
  const anyCompared = fold.compared.length > 0;
  const lines: LineAccount[] = [];
  const initiatorKeys = new Set<string>();

  for (const item of initiator.items) {
    initiatorKeys.add(key(item.path ?? []));
    if (!isLineItemType(item.type)) continue;
    const path = [...(item.path ?? [])];
    const k = key(path);
    const at = fold.byPath.get(k);
    const ordered = item.quantity ?? 0;
    const billedUnits = at?.quantity ?? 0;
    const quantity = ordered - billedUnits;
    const custodyRow = custody?.get(k);
    const kind: LineAccount["kind"] = isExchangeLine(item) || isExchangeLine(custodyRow?.item)
      ? "exchange"
      : ((item.price as { stated_cents?: number | null } | undefined)?.stated_cents ?? null) !== null
      ? "stated"
      : "rate";

    const window = orderLineWindow(initiator.destinations, path);
    const { owed: groups, billed: billedGroups } = groupExtensions(
      item,
      at?.rows ?? [],
      (at?.time_credits ?? []),
      window,
      ctx,
      // A time credit keyed on its own document names no billing row.
      (credit) => fold.documents.get(credit.documentUid)?.role === "credit",
    );
    let extensionCents = 0;
    for (const g of groups) extensionCents += subtotalCents({ ...g.item, quantity: g.quantity } as LineItem, g.extension_counts);

    const expected = kind === "stated"
      ? BILLING_FOLD[side].partCents(item as unknown as InvoiceItem, 0, Math.max(0, billedUnits))
      : null;

    const naming: string[] = [];
    for (const row of at?.rows ?? []) {
      if (live(row.documentUid) && !naming.includes(row.documentUid)) naming.push(row.documentUid);
    }

    // What acts reads billing floored at 0 (R2): an over-credit bills nothing extra.
    const remainingUnits = remainingToBill({ quantity: ordered }, actedBilledUnits(fold, path));
    const owed = groups.filter((g) => g.extension_direction > 0);
    const shortened = groups.filter((g) => g.extension_direction < 0);

    // The over-billing offer's per-line rule (api-cloudrun#1028): the ROW is the unit of work.
    const creditLines: OverbillingCreditLine[] = [];
    const refused: string[] = [];
    if (quantity < 0) {
      let left = -quantity;
      const rows = (at?.rows ?? []).filter((r) => r.via === "direct" && r.quantity > 0);
      if (rows.length === 0) {
        if ((at?.rows ?? []).some((r) => r.via === "substitute")) {
          refused.push("billed only through a substitute — one substitute row can stand in for several order lines, so its cap is not this line's");
        }
      } else if (rows.some((r) => fold.documents.get(r.documentUid)?.status === "draft")) {
        refused.push("billed by a DRAFT invoice — edit the draft rather than crediting it");
      } else {
        for (const row of [...rows].sort((a, b) => b.quantity - a.quantity)) {
          if (left <= 0) break;
          const take = Math.min(left, row.quantity);
          left -= take;
          creditLines.push({
            uid_billing: row.documentUid,
            path_invoice_item: [...(row.item.path ?? [])],
            uid_invoice_item: row.item.uid,
            order_path: [...path],
            quantity: take,
            preview_cents: subtotalCents({ ...row.item, quantity: take } as LineItem),
          });
        }
        if (left > 0) refused.push(`${left} unit(s) over-billed beyond any attributable invoice row`);
      }
    }
    for (const group of shortened) {
      if (fold.documents.get(group.last_billed.documentUid)?.status === "draft") {
        refused.push("window shortened on a DRAFT invoice — edit the draft rather than crediting it");
        continue;
      }
      if (group.via === "substitute") {
        refused.push("window shortened on a substituted row — the credit's cap is not this line's");
        continue;
      }
      creditLines.push({
        uid_billing: group.last_billed.documentUid,
        path_invoice_item: [...group.last_billed.path],
        uid_invoice_item: group.last_billed.uid,
        order_path: [...path],
        quantity: group.quantity,
        credited_counts: countsMagnitude(group.item, group.extension_counts),
        preview_cents: Math.abs(subtotalCents({ ...group.item, quantity: group.quantity } as LineItem, group.extension_counts)),
      });
    }

    const creditSources = (at?.credit_documents ?? []).filter(live);
    const disagrees = new Set<Disagreement>();
    // Reported once a live billing document is compared (ruling 90), or a live
    // credit document took something back here: a credit whose billing document
    // was voided leaves a negative `billed` that nothing else would surface.
    if (kind !== "exchange" && (anyCompared || creditSources.length > 0)) {
      if (quantity !== 0) disagrees.add("quantity");
      if (groups.length > 0) disagrees.add("extension");
      if (expected !== null && (at?.amount_cents ?? 0) !== expected) disagrees.add("money");
    }

    lines.push({
      path,
      item,
      kind,
      // An extension row bills DAYS on units billed elsewhere, so it names nothing on
      // its own; nor does a money-only residual (F2 rule 7) with no units and no row.
      named: billingNamesLine(at),
      naming,
      credit_sources: creditSources,
      ordered,
      billed: { quantity: billedUnits, amount_cents: at?.amount_cents ?? 0, rows: at?.rows ?? [] },
      quantity,
      quantity_cents: unitsMoney(side, item, quantity),
      extension: { groups, amount_cents: extensionCents, billed: billedGroups },
      expected_cents: expected,
      custody: custodyRow === undefined
        ? null
        : { quantity: custodyRow.quantity, quantity_cents: unitsMoney(side, item, custodyRow.quantity - billedUnits) },
      remaining: {
        units: remainingUnits,
        owed,
        bills: remainingUnits > 0 || owed.length > 0,
        blocked: owed.some((g) => g.via === "substitute") ? "substitute_extension" : null,
      },
      overbilled: { units: Math.max(0, -quantity), shortened },
      credit: { lines: creditLines, refused },
      disagrees,
    });
  }

  // Custody-only rows and lost/damaged records are compared only once a live
  // billing document is: before any, nothing is billed to disagree with.
  const custodyOnly: CustodyOnlyAccount[] = [];
  for (const [k, row] of anyCompared ? custody ?? [] : []) {
    if (initiatorKeys.has(k)) continue;
    if (row.item !== null && !isLineItemType(row.item.type)) continue;
    // An exchange unit is shown, never owed (decision 8), here as on a line:
    // a row under a custody-authored exchange leg (ruling 82) bills nothing.
    if (isExchangeLine(row.item)) continue;
    const billed = fold.byPath.get(k)?.quantity ?? 0;
    if (row.quantity === billed) continue;
    custodyOnly.push({ path: k === "" ? [] : k.split("/"), item: row.item, custody: row.quantity, billed });
  }

  return {
    side,
    initiatorUid: initiator.uid,
    lines,
    custody_only: custodyOnly,
    out_of_service: anyCompared ? outOfService.filter((r) => r.fulfilled !== r.invoiced) : [],
    document_only: fold.document_only,
    compared: fold.compared,
    unaligned: fold.unaligned,
    credits_unkeyed: fold.credits_unkeyed,
    documents: fold.documents,
    crms_blocked: crmsBlocked,
    refused: fold.unaligned.length > 0 || crmsBlocked,
  };
}

/**
 * **The account over the billing and credit documents alone** — no custody
 * document, no out-of-service record: what the remainder
 * ({@link buildRemainingInvoice}), the over-billing offer
 * ({@link buildOverbillingCredits}) and the coverage banner read. The one door,
 * so no caller folds and accounts with different documents.
 *
 * @param billing - EVERY billing document linked to the initiator, live or not, never a page
 * @param credits - EVERY credit document against them
 */
export function accountBilling<S extends Side>(
  side: S,
  initiator: AccountedInitiator,
  billing: readonly BillingFoldDocuments[S]["billing"][],
  credits: readonly BillingFoldDocuments[S]["credit"][],
  ctx: AccountingContext,
): InitiatorAccount {
  return accountInitiator(side, initiator, billedByPath(side, initiator, billing, credits), null, [], ctx);
}

/**
 * `subtotal_discounted_cents` of a line, or 0 for a line that is not priced
 * pre-tax — through `priceDocument`'s line pricer (#997 D11), so a remainder is
 * priced by the same author as the document that will bill it.
 *
 * The line's tax refs are dropped first: only the pre-tax subtotal is read, and
 * the pricer resolves every ref it is handed against the catalog it is given.
 */
function subtotalCents(item: LineItem, extensionCounts?: readonly TierCount[]): number {
  if (!isPreTaxItem(item)) return 0;
  const untaxed = {
    ...item,
    price: { ...item.price, taxes: [], ...(extensionCounts ? { counts: [...extensionCounts] } : {}) },
  } as LineItem;
  return priceLine(untaxed, [], extensionCounts !== undefined).subtotal_discounted_cents;
}

/** Units billed at one cumulative day count, still owed (or over-billed) an extension. */
/** A group of billed units and the time billed on them, before any comparison with the initiator's window. */
export type BilledTimeGroup = Omit<ExtensionGroup, "extension_counts" | "extension_direction">;

export interface ExtensionGroup {
  /** The billed row whose terms (rate, discount) the extension is priced on. */
  item: LineItem;
  /** `direct` or `substitute`, from the row that billed the units. */
  via: "direct" | "substitute";
  /** Units in the group. */
  quantity: number;
  /**
   * The counts billed so far: what the row's formula meters from its pair's
   * windows, plus every extension applied to these units (their stated counts).
   */
  billed_counts: readonly TierCount[];
  /** Where the billed window ends: the row's pair's end, or the last extension's. */
  billed_end: string;
  /**
   * Every window billed on these units, in order: the row's pair's windows, then
   * each extension's. Compared against the order pair's set to decide whether the
   * window MOVED at all — see {@link BilledWindow.windows}.
   */
  billed_set: readonly WindowBounds[];
  /**
   * What the row's formula meters from the order pair's windows, less
   * {@link billed_counts}. Never all-zero; {@link countsDirection} says which
   * way — negative is a shortening.
   */
  extension_counts: readonly TierCount[];
  /** {@link countsDirection} of {@link extension_counts}: `1` owed, `−1` a shortening. */
  extension_direction: -1 | 1;
  /** The billing section that last billed these units: `[documentUid, section divider uid]`. */
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
  last_billed: { documentUid: string; uid: string; path: readonly string[] };
}

/** A billing row as {@link groupExtensions} reads it, on either side. */
interface GroupedRow {
  documentUid: string;
  item: InvoiceItem;
  via: "direct" | "substitute" | "extension";
  quantity: number;
  window: BilledWindow | null;
}

/** A reversing time credit as {@link groupExtensions} reads it, on either side. */
interface GroupedTimeCredit {
  documentUid: string;
  path: readonly string[];
  quantity: number;
  counts: readonly TierCount[];
}

/**
 * The extension still owed on an order line, as groups of billed units that
 * share their terms and their cumulative billed days (api-cloudrun#680 R1).
 *
 * The walk: every time-formula unit row on a known {@link BilledWindow}
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
 *    window, as Chicago calendar dates. Identical ⇒ no extension,
 *    whatever the day counts say. 🔴 This is the holiday-recount guard, and it is
 *    why the comparison is of DATES and not of `days`: a stored `days` is frozen
 *    at write while the order's is recounted, so a delta under an identical date
 *    set is always an artefact of the recount.
 * 2. **How much, and which way?** `meter(order pair windows) − billed_counts`,
 *    sign and all. Negative is a shortening — over-billing, for the credit-note
 *    flow — and positive is an extension still owed.
 *
 * ⚠️ **There is deliberately no sub-cover test.** A window set that shrinks by
 * date while the metered count RISES (one window split into several, each floored to
 * a week) is a genuine extension, and by owner ruling an invoice stating its own
 * windows is never over-billing — so a bill inside a narrower or split cover
 * credits nothing.
 *
 * A `fixed` row never read its days, so it forms no group; nor does a row on no
 * known window. A group whose extension is zero is dropped.
 */
function groupExtensions(
  orderLine: LineItem,
  rows: readonly GroupedRow[],
  timeCredits: readonly GroupedTimeCredit[],
  orderWindow: BilledWindow | null,
  ctx: AccountingContext,
  namesNoBillingRow: (credit: GroupedTimeCredit) => boolean = () => false,
): { owed: ExtensionGroup[]; billed: BilledTimeGroup[] } {
  // A time-formula line only: a flat-formula row never read its time, so it has
  // nothing to extend or credit.
  if (!isPreTaxItem(orderLine) || orderWindow === null) return { owed: [], billed: [] };
  const groups: Array<Omit<ExtensionGroup, "extension_counts" | "extension_direction">> = [];
  const extensions: GroupedRow[] = [];
  for (const row of rows) {
    if (!isPreTaxItem(row.item) || row.item.price.price_formula?.basis !== "time") continue;
    if (row.via === "extension") {
      extensions.push(row);
      continue;
    }
    const quantity = row.quantity;
    if (quantity <= 0 || row.window === null) continue;
    const billedCounts = meterWindows(row.item, row.window.windows, ctx);
    if (billedCounts === null) continue;
    groups.push({
      item: row.item,
      via: row.via,
      quantity,
      billed_counts: billedCounts,
      billed_end: row.window.end,
      billed_set: row.window.windows,
      section: [row.documentUid, (row.item.path ?? [])[1] ?? ""],
      last_billed: { documentUid: row.documentUid, uid: row.item.uid, path: row.item.path ?? [] },
    });
  }
  for (const row of extensions) {
    if (row.window === null) continue;
    let left = row.item.quantity ?? 0;
    // An extension line STATES the counts it added, minimum skipped.
    const added = row.item.price?.counts ?? [];
    const billedEnd = row.window.end;
    const section: [string, string] = [row.documentUid, (row.item.path ?? [])[1] ?? ""];
    while (left > 0) {
      const open = groups.filter((g) => g.quantity > 0);
      if (open.length === 0) break;
      const earliest = open.reduce((a, b) => {
        const byEnd = Date.parse(b.billed_end) - Date.parse(a.billed_end);
        return byEnd < 0 || (byEnd === 0 && countsDirection(a.item, combineTierCounts(b.billed_counts, a.billed_counts, -1)) < 0)
          ? b
          : a;
      });
      const moved = Math.min(left, earliest.quantity);
      const billedCounts = combineTierCounts(earliest.billed_counts, added, 1);
      // The extension bills its own window ON TOP of what the group already carried.
      const billedSet = [...earliest.billed_set, ...row.window.windows];
      earliest.quantity -= moved;
      left -= moved;
      // `billed_set` joins the merge key: two groups can agree on their day count
      // and their end and still have been billed across different windows, and
      // merging those would hand the shortening gate a set neither of them has.
      const same = groups.find((g) =>
        g.item === earliest.item && sameCountValues(g.billed_counts, billedCounts) && g.billed_end === billedEnd &&
        g.section[0] === section[0] && g.section[1] === section[1] && sameWindowDates(g.billed_set, billedSet)
      );
      if (same) same.quantity += moved;
      else {
        groups.push({
          ...earliest,
          quantity: moved,
          billed_counts: billedCounts,
          billed_end: billedEnd,
          billed_set: billedSet,
          section,
          last_billed: { documentUid: row.documentUid, uid: row.item.uid, path: row.item.path ?? [] },
        });
      }
    }
  }
  // A reversing TIME credit (R3) takes counts back from the group of the row it
  // credits — the row that last billed those units — on up to its quantity, and
  // moves no window: what was credited is time, not a different window.
  //
  // A credit that names NO billing row (a supplier credit raised from the
  // purchase line, every manager credit) takes from the line's groups most
  // recently billed first: the order its default counts were drawn in
  // (`creditTimeCounts`, owner 2026-11-15, "newest time first"), so a second
  // default credit cannot take the same time back twice.
  for (const credit of timeCredits) {
    let left = credit.quantity;
    const unanchored = namesNoBillingRow(credit);
    const candidates = unanchored
      ? [...groups].sort((a, b) => Date.parse(b.billed_end) - Date.parse(a.billed_end))
      : [...groups];
    for (const g of candidates) {
      if (left <= 0) break;
      if (g.quantity <= 0) continue;
      if (!unanchored && (g.last_billed.documentUid !== credit.documentUid || key(g.last_billed.path) !== key(credit.path))) continue;
      const moved = Math.min(left, g.quantity);
      g.quantity -= moved;
      left -= moved;
      groups.push({ ...g, quantity: moved, billed_counts: combineTierCounts(g.billed_counts, credit.counts, -1) });
    }
  }
  const out: ExtensionGroup[] = [];
  for (const g of groups) {
    if (g.quantity <= 0) continue;
    // (1) did the window move? (2) if so, by how much and which way?
    if (sameWindowDates(g.billed_set, orderWindow.windows)) continue;
    const ordered = meterWindows(g.item, orderWindow.windows, ctx);
    if (ordered === null) continue;
    const extension = combineTierCounts(ordered, g.billed_counts, -1);
    const direction = countsDirection(g.item, extension);
    if (direction === 0) continue;
    out.push({ ...g, extension_counts: extension, extension_direction: direction });
  }
  return { owed: out, billed: groups.filter((g) => g.quantity > 0) };
}

/** The uids of the LIVE invoices CRMS authored — a remainder refuses when any exist. */
export function crmsAuthoredInvoices(invoices: readonly AccountedInvoice[]): string[] {
  return invoices
    .filter((invoice) => invoice.status !== "void" && invoice.crms_id !== undefined && invoice.crms_id !== null && invoice.crms_id !== "")
    .map((invoice) => invoice.uid);
}

// ── The over-billing OFFER (api-cloudrun#1028 phase 1d) ─────────

/** One credit-note line the offer would raise. */
export interface OverbillingCreditLine {
  /** The billing document the credited row is on. */
  uid_billing?: string;
  /** The invoice row this credits — its row identity on that invoice. */
  path_invoice_item: string[];
  /** That row's own uid, for the `uid_invoice_item` a credit note also stores. */
  uid_invoice_item: string;
  /** The order-relative path the over-billing was found at. */
  order_path: string[];
  /** Whole units to credit. `0` on a days-only credit. */
  quantity: number;
  /**
   * The counts to credit, for a window the order SHORTENED — the magnitude of
   * the group's `extension_counts` (ruling 8). Absent on an ordinary unit credit.
   */
  credited_counts?: TierCount[];
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
  /** The account's ({@link InitiatorAccount.unaligned}) — non-empty ⇒ `notes` is empty. */
  unaligned: string[];
  crms_authored: string[];
  /** @see {@link BilledByPath.credits_unkeyed} */
  credits_unkeyed: string[];
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
  overbilled: { path: string[]; quantity: number; extension_counts: readonly TierCount[] }[];
  compared: string[];
  unaligned: string[];
  /** Live CRMS-authored invoices; non-empty ⇒ nothing is built. See the module header. */
  crms_authored: string[];
}

/**
 * The remainder's items and pairs, from what each line bills: `units` by order
 * path key, and the extension groups owed under each order destination. The one
 * assembly behind {@link buildRemainingInvoice}.
 */
function assembleRemainder(
  order: RemainingOrderSource,
  units: ReadonlyMap<string, number>,
  owed: ReadonlyMap<string, Array<{ line: LineItem; group: ExtensionGroup }>>,
  mintUid: () => string,
): { items: InvoiceDocItemType[]; destinations: InvoiceDocDestinationType[] } {
  const O = order.uid;
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
    // A pair with no windows bills no days, so it holds no rental and nothing
    // here can have extended it.
    if (!divider || !orderPair || orderPair.dates.charge_windows === null) continue;

    /** One section: its billed window, and the entries keyed by order path. */
    // A section is one billed WINDOW SET; each line in it states its own
    // counts, because its lines may be on different formulas (ruling 8).
    const sections: Array<{ billedSet: readonly WindowBounds[]; billedEnd: string; byPath: Map<string, { line: LineItem; group: ExtensionGroup }> }> = [];
    for (const entry of entries) {
      const k = key(entry.line.path ?? []);
      let section = sections.find((s) =>
        sameWindowDates(s.billedSet, entry.group.billed_set) && s.billedEnd === entry.group.billed_end && !s.byPath.has(k)
      );
      if (!section) {
        section = { billedSet: entry.group.billed_set, billedEnd: entry.group.billed_end, byPath: new Map() };
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
        // A billed group prices on the row that billed it, at the counts the
        // order's windows add. An ancestor bills nothing (quantity 0), and states
        // zero counts only because every line in an extension section must state
        // some.
        const source = entry ? entry.group.item : item;
        const counts = entry
          ? [...entry.group.extension_counts]
          : (source.price?.rates ?? []).slice(0, 1).map((r) => ({ rate_key: r.rate_key, num: 0, den: 1 }));
        const projected = projectOrderItemToInvoiceItem({
          ...source,
          uid: item.uid,
          path,
          quantity: entry ? entry.group.quantity : 0,
          price: { ...source.price, counts },
        } as LineItem, O);
        // An extension section bills more days of a leg; it is not an exchange, so a
        // copied exchange line keeps no take-back list (its pair's `exchange` is
        // nulled below, and `checkInvoiceExchangedFor` refuses the field off one).
        const { exchanged_for: _notAnExchange, ...line } = projected as InvoiceDocItemType & { exchanged_for?: unknown };
        items.push({ ...line, path: scoped } as InvoiceDocItemType);
      }

      const projectedPair = toInvoiceDestinationPair(O, orderPair);
      const orderWindows = orderPair.dates.charge_windows!;
      const start = chicagoDayAtTimeOf(section.billedEnd, 1, orderWindows[0].start);
      const end = orderWindows[orderWindows.length - 1].end;
      extensionPairs.push({
        ...projectedPair,
        uid: E,
        // Spread from the projected pair, so an extension of an exchange leg would
        // otherwise claim to BE an exchange (ruling 82): it bills days, it swaps nothing.
        exchange: null,
        dates: { ...projectedPair.dates, charge_windows: [{ start, end }] },
      });
    }
  }

  return { items, destinations: [...pairs, ...extensionPairs] };
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
 *   line's owed {@link LineAccount.extension} groups that share their billed days. Its divider
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
 * - **Credit notes net through the account** (core#121, owner 2026-10-01). A
 *   `reverses_billing` line means "billed beyond the order" — its only writer is
 *   the over-billing offer — so units it gave back are unbilled, and an order
 *   that grows to need them again bills them again. 🔴 Build the account from
 *   EVERY credit note: one built without them answers a different `billed` than
 *   the offer counted, the defect this closes.
 *
 * Every per-line decision is read from {@link LineAccount.remaining} and
 * {@link LineAccount.overbilled} (6e-0b2 F9), never re-derived here.
 *
 * 🔴 Fails closed on the account's shared refusal ({@link InitiatorAccount.refused}:
 * an unaligned scope or a live CRMS-authored invoice), building nothing.
 *
 * @param account - {@link accountBilling} over EVERY invoice and credit note on the order, never a page
 * @throws Error when an extension is owed on a unit a SUBSTITUTE billed: the
 *   extension line would price the substitute at the replaced line's path, and
 *   substitution merges (manager#414) have not settled what that row is.
 */
export function buildRemainingInvoice(
  order: RemainingOrderSource,
  account: InitiatorAccount,
  mintUid: () => string = () => crypto.randomUUID(),
): RemainingInvoice {
  const crmsAuthored = liveCrmsAuthored(account);
  const empty = { items: [], destinations: [], overbilled: [], compared: account.compared, unaligned: account.unaligned, crms_authored: crmsAuthored };
  if (account.refused) return empty;
  const overbilled: RemainingInvoice["overbilled"] = [];
  const units = new Map<string, number>();
  const owed = new Map<string, Array<{ line: LineItem; group: ExtensionGroup }>>();
  for (const line of account.lines) {
    const k = key(line.path);
    if (line.remaining.units > 0) units.set(k, line.remaining.units);
    if (line.overbilled.units > 0) overbilled.push({ path: [...line.path], quantity: -line.overbilled.units, extension_counts: [] });
    for (const group of line.extension.groups) {
      if (group.extension_direction < 0) {
        overbilled.push({ path: [...line.path], quantity: group.quantity, extension_counts: group.extension_counts });
        continue;
      }
      if (group.via === "substitute") {
        throw new Error(
          `Order line ${line.item.name} was billed by a substitute; an extension on a substituted line cannot be built yet (manager#414)`,
        );
      }
      const destination = line.path[0];
      if (!owed.has(destination)) owed.set(destination, []);
      owed.get(destination)!.push({ line: line.item, group });
    }
  }
  if (units.size === 0 && owed.size === 0) return { ...empty, overbilled };
  const { items, destinations } = assembleRemainder(order, units, owed, mintUid);
  return { items, destinations, overbilled, compared: account.compared, unaligned: [], crms_authored: [] };
}

/** The live CRMS-authored billing documents, from the account's headers. */
function liveCrmsAuthored(account: InitiatorAccount): string[] {
  return [...account.documents.values()].filter((d) => d.role === "billing" && d.live && d.crms_id !== null).map((d) => d.uid);
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
 * Fails closed on the account's shared refusal ({@link InitiatorAccount.refused}:
 * an unaligned scope or a live CRMS-authored invoice) — **plus**, per path, the
 * refusals each {@link LineAccount.credit} carries:
 *
 * - a **draft** invoice among the billers: a draft has billed nothing to give
 *   back, and crediting one is not a correction but a reason to edit it;
 * - a path with **no attributable row** that is not the kit-component case above;
 * - a path attributable only through a **substitute**: one Y row can stand in for
 *   several X paths, and the cap is Y's full quantity, so a credit raised there
 *   could exceed what any single X was billed.
 *
 * Every per-line decision is the account's ({@link LineAccount.credit}); this
 * only groups the lines one note per billing document and orders the notes.
 *
 * ⚠️ **Preview cents come from the ROW the note will be priced from**, not from
 * {@link LineAccount.quantity_cents}, which prices at the ORDER line's terms, while `priceCreditNote` prices the stored INVOICE line — and where the
 * two disagree, the second is what the operator will be asked to approve.
 */
export function buildOverbillingCredits(account: InitiatorAccount): OverbillingCredits {
  const empty: OverbillingCredits = {
    notes: [],
    refused: [],
    unaligned: account.unaligned,
    crms_authored: liveCrmsAuthored(account),
    credits_unkeyed: account.credits_unkeyed,
  };
  if (account.refused) return empty;
  const perBilling = new Map<string, OverbillingCreditLine[]>();
  const refused: OverbillingCredits["refused"] = [];
  for (const line of account.lines) {
    for (const credit of line.credit.lines) {
      const uid = credit.uid_billing!;
      if (!perBilling.has(uid)) perBilling.set(uid, []);
      perBilling.get(uid)!.push(credit);
    }
    for (const reason of line.credit.refused) refused.push({ order_path: [...line.path], reason });
  }
  const header = (uid: string) => account.documents.get(uid);
  const notes = [...perBilling.entries()]
    .map(([uid_invoice, lines]) => ({ uid_invoice, lines, preview_cents: lines.reduce((t, l) => t + l.preview_cents, 0) }))
    .sort((a, b) => {
      const owedOn = (uid: string) => header(uid)?.amount_due_cents ?? 0;
      if ((owedOn(a.uid_invoice) > 0) !== (owedOn(b.uid_invoice) > 0)) return owedOn(a.uid_invoice) > 0 ? -1 : 1;
      return (header(a.uid_invoice)?.number ?? 0) - (header(b.uid_invoice)?.number ?? 0);
    });
  return { ...empty, notes, refused };
}
