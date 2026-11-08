/**
 * **The purchase ↔ bill diff** (purchases-as-documents D6) — what a supplier
 * billed against what CFS ordered, surfaced and never resolved.
 *
 * A separate function rather than new arms on `computeDocumentDiffs`, which is
 * order-shaped throughout (destinations, dividers, fulfillments; it would label
 * a bill "Fulfillment"). The VOCABULARY is shared: a `differs` /
 * `not_on_source` / `doc_field` entry carries `DocumentDiffField`s exactly as on
 * the customer side, so the manager reuses the presentational pieces with a
 * purchase-side row host.
 *
 * - **The join is the bill line's `path_purchase_item`**, a flat key (purchase
 *   items are flat, `path = [uid]`). No ancestry walk, no divider levels.
 * - **What is compared is what the sync MERGES** — the shared line fields read
 *   off the two schemas (`purchaseBillSharedLineFields`), projected to the bill's
 *   shape (`projectPurchaseLineForBill`), each compared canonically (absent ≡
 *   null). So a new shared field is compared by construction, and "overridden"
 *   means the same thing to the diff and the sync.
 * - **Billed is SUMMED over the purchase's live bills, net of live credits** —
 *   a line is routinely billed across several. On a FLAT line the entry states
 *   ordered, received and billed units, and billed cents against what the
 *   line's cumulative share says those units cost. On a TIME line it states,
 *   per unit, the time recorded and not billed and the time billed and not
 *   recorded — COVERAGE, not counts, because two bills may meter one window
 *   differently and still cover it once.
 * - **Money is compared where the line can state it alone**: a LINKED time
 *   line's Xero amount against its own `rates × counts` (a pushed one is refined
 *   to agree, so it cannot differ).
 * - **Over-billing is a difference, never a refusal** (D5).
 *
 * Baseline (D6): 193 account differences on 160 linked settled dev bills — the
 * 1999 → 6500 re-stamp. Expected signal, not noise.
 *
 * @module
 */
import type {
  ChargeWindowType,
  Purchase,
  PurchaseBill,
  PurchaseCredit,
  PurchaseDocumentItem,
  PurchaseItem,
  UnitType,
} from "../schemas/mod.ts";
import { purchaseItemBasis } from "../schemas/mod.ts";
import { canonicalizePayload } from "./invoices.ts";
import type { DocumentDiffField } from "./documentDiff.ts";
import {
  billedUnitCoverage,
  projectPurchaseLineForBill,
  purchaseBillIsLive,
  purchaseBillSharedLineFields,
  purchaseCreditIsLive,
  purchaseLineBilledNet,
  subtractChargeWindows,
  unitWindowsForLine,
} from "./purchase-documents.ts";
import { priceFromFormula } from "./price-formulas.ts";
import { roundDivHalfUp } from "./money.ts";

/** The three supplier-side document kinds a purchase diff can be viewed from or sourced from. */
export type PurchaseDocumentKind = "purchase" | "bill" | "purchase_credit";

/** Which document an entry is against — enough to link to it and to CAS a later sync. */
export interface PurchaseDocumentRef {
  kind: PurchaseDocumentKind;
  uid: string;
  number: number;
  version: number;
}

/**
 * What one source says about one line of the viewed document — the customer
 * side's `DocumentSourceDiffEntry`, with a supplier-side source.
 *
 * - `differs` — a compared field disagrees
 * - `not_on_source` — on the viewed bill, absent from the purchase (a
 *   document-only charge line, or a line naming a purchase line that is gone)
 */
export interface PurchaseSourceDiffEntry {
  kind: "differs" | "not_on_source";
  source: PurchaseDocumentRef;
  /** Empty for `not_on_source`. */
  fields: DocumentDiffField[];
}

/**
 * A FLAT purchase line's units and money across every live bill, net of live
 * credits, emitted when they disagree with what was ordered or received, or
 * when the billed money is not what the line's cumulative share says those
 * units cost. Emitted only once a live bill or a live credit names the line,
 * and then when billed ≠ ordered or the money disagrees. A live credit with no
 * live bill left under it reads as a negative `billed`, which is how a voided
 * bill's stranded credit reaches the operator. `received` is stated for the
 * reader and is not a trigger: billing before delivery is normal.
 */
export interface PurchaseBilledEntry {
  kind: "billed";
  bills: PurchaseDocumentRef[];
  credits: PurchaseDocumentRef[];
  /** `quantity − quantity_canceled`. */
  ordered: number;
  /** `quantity_received` on a sale or rental; `null` on a service or replacement, which receives nothing. */
  received: number | null;
  /** Σ live bill line quantity − Σ live credit line quantity, unfloored. */
  billed: number;
  /** Σ live bill line money − Σ live credit line money, unfloored. */
  billed_cents: number;
  /** What `billed` units cost at the line's cumulative share (past `quantity`, at the same rate). */
  expected_cents: number;
}

/**
 * One unit's charge-window COVERAGE on a TIME purchase line: what its windows
 * recorded (up to the diff's `through`) and no live bill covers, and what live
 * bills cover that no window recorded. Emitted when either is non-empty, and
 * only when a live bill bills the line or `through` is given.
 */
export interface PurchaseCoverageEntry {
  kind: "coverage";
  bills: PurchaseDocumentRef[];
  uid_unit: string;
  recorded_not_billed: ChargeWindowType[];
  billed_not_recorded: ChargeWindowType[];
}

/** One entry at one line of the viewed document. Discriminated on `kind`. */
export type PurchaseDiffEntry = PurchaseSourceDiffEntry | PurchaseBilledEntry | PurchaseCoverageEntry;

/**
 * The answer for one viewed document. Keys are the VIEWED document's own line
 * `path.join("/")`, so a row looks itself up by its stored path: a bill line's
 * key is its own path, never its `path_purchase_item`.
 */
export interface PurchaseDiffMap {
  lines: Map<string, PurchaseDiffEntry[]>;
}

/** {@link computePurchaseBillDiffs}' sources. */
export interface PurchaseDiffSources {
  purchase: Purchase;
  /** Every bill of the purchase — sibling bills are what "billed" sums over. */
  bills: readonly PurchaseBill[];
  credits: readonly PurchaseCredit[];
  /** The units whose windows may name the purchase's time lines; absent skips coverage. */
  units?: readonly Pick<UnitType, "uid" | "charge_windows">[];
  /** Coverage cut-off — open windows read up to here. Required for coverage. A Chicago instant. */
  through?: string;
}

/** Which document is being viewed. */
export type PurchaseDiffView = { kind: "purchase" } | { kind: "bill"; uid: string };

const refOfPurchase = (p: Purchase): PurchaseDocumentRef => ({ kind: "purchase", uid: p.uid, number: p.number, version: p.version });
const refOfBill = (b: PurchaseBill): PurchaseDocumentRef => ({ kind: "bill", uid: b.uid, number: b.number, version: b.version });
const refOfCredit = (c: PurchaseCredit): PurchaseDocumentRef => ({
  kind: "purchase_credit",
  uid: c.uid,
  number: c.number,
  version: c.version,
});

const key = (path: readonly string[]) => path.join("/");

function readPath(root: unknown, path: string): unknown {
  let v: unknown = root;
  for (const s of path.split(".")) {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return undefined;
    v = (v as Record<string, unknown>)[s];
  }
  return v;
}

/**
 * The shared fields a bill line and its purchase line disagree on — `here` the
 * bill line's, `there` the purchase line's. A null parent (no discount on one
 * side) compares the parent whole, as the merge does.
 */
function lineFieldDiffs(line: PurchaseDocumentItem, item: PurchaseItem): DocumentDiffField[] {
  const there = projectPurchaseLineForBill(item, line.quantity);
  const out: DocumentDiffField[] = [];
  const seen = new Set<string>();
  for (const f of purchaseBillSharedLineFields()) {
    if (f.kind === "derived" || f.kind === "homonym") continue;
    const segs = f.path.split(".");
    let unit = f.path;
    for (let i = 1; i < segs.length; i++) {
      const parent = segs.slice(0, i).join(".");
      const isObj = (v: unknown) => v !== null && typeof v === "object" && !Array.isArray(v);
      if (!isObj(readPath(line, parent)) || !isObj(readPath(there, parent))) {
        unit = parent;
        break;
      }
    }
    if (seen.has(unit)) continue;
    seen.add(unit);
    const h = readPath(line, unit);
    const t = readPath(there, unit);
    if (JSON.stringify(canonicalizePayload(h)) !== JSON.stringify(canonicalizePayload(t))) {
      out.push({ field: unit, here: h, there: t });
    }
  }
  return out;
}

/** A linked time line's Xero amount against its own `rates × counts`, or nothing. */
function linkedMoneyDiff(line: PurchaseDocumentItem, origin: PurchaseBill["origin"]): DocumentDiffField[] {
  if (origin !== "linked" || line.price?.price_formula.basis !== "time") return [];
  let expected: number;
  try {
    expected = priceFromFormula(line.price.rates, line.price.counts, 1, line.price.discount).subtotal_discounted_cents;
  } catch {
    return [{ field: "price.counts", here: line.price.counts, there: line.price.rates }];
  }
  return expected === line.amount_cents ? [] : [{ field: "amount_cents", here: line.amount_cents, there: expected }];
}

/** Cents for `units` of a flat line at its cumulative share, past `quantity` at the same rate. */
function shareCents(amountCents: number, quantity: number, units: number): number {
  return Number(roundDivHalfUp(BigInt(amountCents) * BigInt(Math.max(0, units)), BigInt(quantity)));
}

function billedEntry(
  item: PurchaseItem,
  liveBills: readonly PurchaseBill[],
  liveCredits: readonly PurchaseCredit[],
): PurchaseBilledEntry | null {
  const lines = (items: readonly PurchaseDocumentItem[]) =>
    items.filter((l) => l.path_purchase_item !== undefined && key(l.path_purchase_item) === key(item.path));
  const bills = liveBills.filter((b) => lines(b.items).length > 0);
  const credits = liveCredits.filter((c) => lines(c.items).length > 0);
  if (bills.length === 0 && credits.length === 0) return null;
  const { quantity: billed, amount_cents: billed_cents } = purchaseLineBilledNet(item.path, { bills, credits });
  const ordered = item.quantity - item.quantity_canceled;
  const received = item.type === "service" || item.type === "replacement" ? null : item.quantity_received;
  const expected_cents = shareCents(item.amount_cents ?? 0, item.quantity, billed);
  // Received is stated, never a trigger: the owner bills before delivery as
  // often as after. A short close lowers `ordered` to what came, so billing
  // past what was received then reads as billed ≠ ordered.
  if (billed === ordered && billed_cents === expected_cents) return null;
  return { kind: "billed", bills: bills.map(refOfBill), credits: credits.map(refOfCredit), ordered, received, billed, billed_cents, expected_cents };
}

function coverageEntries(
  item: PurchaseItem,
  sources: PurchaseDiffSources,
  liveBills: readonly PurchaseBill[],
): PurchaseCoverageEntry[] {
  if (!sources.units || !sources.through) return [];
  const bills = liveBills.filter((b) =>
    b.items.some((l) => l.path_purchase_item !== undefined && key(l.path_purchase_item) === key(item.path))
  );
  const recorded = item.type === "sale"
    ? new Map<string, ChargeWindowType[]>()
    : unitWindowsForLine(sources.units, item, sources.through);
  const billed = billedUnitCoverage({ bills: sources.bills, credits: sources.credits }, item.path);
  const units = [...new Set([...recorded.keys(), ...billed.keys()])].sort();
  const out: PurchaseCoverageEntry[] = [];
  for (const uid_unit of units) {
    const r = recorded.get(uid_unit) ?? [];
    const b = billed.get(uid_unit) ?? [];
    const recorded_not_billed = subtractChargeWindows(r, b);
    const billed_not_recorded = subtractChargeWindows(b, r);
    if (recorded_not_billed.length > 0 || billed_not_recorded.length > 0) {
      out.push({ kind: "coverage", bills: bills.map(refOfBill), uid_unit, recorded_not_billed, billed_not_recorded });
    }
  }
  return out;
}

function push(map: Map<string, PurchaseDiffEntry[]>, k: string, entry: PurchaseDiffEntry): void {
  const list = map.get(k) ?? [];
  list.push(entry);
  map.set(k, list);
}

/**
 * **The purchase ↔ bill diff for one viewed document** (D6). Pure.
 *
 * - **Purchase view** — at each purchase line: a `differs` entry per live bill
 *   whose line overrides a shared field, then the line's `billed` entry (flat)
 *   or `coverage` entries (time).
 * - **Bill view** — at each of the bill's lines: `differs` against the purchase
 *   (shared fields, plus a linked time line's money against its own snapshot),
 *   `not_on_source` for a document-only line or one whose purchase line is
 *   gone, then the same summed `billed` / `coverage` entries for the purchase
 *   line it projects. A voided bill is still viewable; it is just not summed.
 *
 * @throws when the bill view names a bill not in `sources.bills`.
 */
export function computePurchaseBillDiffs(view: PurchaseDiffView, sources: PurchaseDiffSources): PurchaseDiffMap {
  const lines = new Map<string, PurchaseDiffEntry[]>();
  const purchaseRef = refOfPurchase(sources.purchase);
  const byPath = new Map(sources.purchase.items.map((i) => [key(i.path), i]));
  const liveBills = sources.bills.filter(purchaseBillIsLive);
  const liveCredits = sources.credits.filter(purchaseCreditIsLive);

  const summed = (item: PurchaseItem): PurchaseDiffEntry[] => {
    if (purchaseItemBasis(item) === "flat") {
      const e = billedEntry(item, liveBills, liveCredits);
      return e ? [e] : [];
    }
    return coverageEntries(item, sources, liveBills);
  };

  if (view.kind === "purchase") {
    for (const item of sources.purchase.items) {
      const k = key(item.path);
      for (const bill of liveBills) {
        for (const line of bill.items) {
          if (line.path_purchase_item === undefined || key(line.path_purchase_item) !== k) continue;
          // `here` is the purchase line on this view, `there` the bill's.
          const fields = [...lineFieldDiffs(line, item), ...linkedMoneyDiff(line, bill.origin)]
            .map((f) => ({ field: f.field, here: f.there, there: f.here }));
          if (fields.length > 0) push(lines, k, { kind: "differs", source: refOfBill(bill), fields });
        }
      }
      for (const e of summed(item)) push(lines, k, e);
    }
    return { lines };
  }

  const bill = sources.bills.find((b) => b.uid === view.uid);
  if (!bill) throw new Error(`Bill ${view.uid} is not among the purchase's bills`);
  for (const line of bill.items) {
    const k = key(line.path);
    const item = line.path_purchase_item === undefined ? undefined : byPath.get(key(line.path_purchase_item));
    if (!item) {
      push(lines, k, { kind: "not_on_source", source: purchaseRef, fields: [] });
      continue;
    }
    const fields = [...lineFieldDiffs(line, item), ...linkedMoneyDiff(line, bill.origin)];
    if (fields.length > 0) push(lines, k, { kind: "differs", source: purchaseRef, fields });
    for (const e of summed(item)) push(lines, k, e);
  }
  return { lines };
}
