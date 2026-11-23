/**
 * **The one remainder builder, both sides** (one-document-model 6e-0d2, rulings
 * 168 and 172–181): what a billing document of "what is left" bills — an invoice
 * of every order in `query_by_orders`, a bill of every purchase in
 * `query_by_purchases` — built from each initiator and its account.
 *
 * It replaced the receivable `assembleRemainder` and the payable bill writer's
 * own split (`splitBillTime`, `billExtensionSections`, the picks). The DECISION
 * was already one function, {@link remainingBilling}; the ROWS are now one
 * assembly, the side read only through {@link REMAINDER_SIDES} (ruling 84: per-side
 * data, never an `if side`):
 *
 * - **Every initiator divider is carried**, empty or not (ruling 181, AR's rule).
 * - **A line bills its remaining units at its own path**, as a PART of the
 *   initiator line: `units_from` is where its billing stands (ruling 174), so its
 *   money is the source's units `(from, from + quantity]`.
 * - **An ancestor of a billed line is carried at quantity 0** when it has nothing
 *   of its own left (ruling 176, AR's rule; a bill line may hold 0 since ruling
 *   180), so a component's path still resolves from its parent.
 * - **Owed time is one date-extension section per destination and billed
 *   window**, each line priced on the BILLED ROW's terms (ruling 175, AR's rule)
 *   at the group's extension counts; the section's pair runs from the day after
 *   the group's billed end to the end of the destination's windows.
 * - **A destination owed time with no charge window refuses by name** (the loud
 *   one of the two old behaviours: AR skipped it, AP threw).
 * - **A refused account** (an unaligned scope, a live CRMS-authored invoice)
 *   builds nothing and is NAMED, so the caller refuses the whole create naming
 *   that source (ruling 177).
 *
 * Its pair input is {@link billableInitiator}'s: the payable side clips an OPEN
 * hire at the bill date, or an open hire meters nothing and nothing is owed. The
 * account the builder reads must be built over the same clipped initiator, and
 * so must the catalog's `create_remaining_billing` offer, so the offer and the
 * builder cannot disagree.
 *
 * Pure and db-free: the API's create and the manager's preview run it verbatim.
 */
import type {
  DocDestinationType,
  InvoiceDocDestinationType,
  InvoiceDocItemType,
  Purchase,
  PurchaseDocDestination,
  PurchaseDocumentRow,
  PurchaseItem,
  Side,
} from "../schemas/mod.ts";
import { isLineItemType, purchaseItemBasis, purchaseLines } from "../schemas/mod.ts";
import type { LineItem } from "./orders.ts";
import type { TierCount } from "./price-formulas.ts";
import { chicagoDayAtTimeOf } from "./dates.ts";
import { projectOrderItemToInvoiceItem, toInvoiceDestinationPair } from "./invoices.ts";
import { projectPurchaseLineToBillLine, purchaseScopeDivider } from "./purchase-documents.ts";
import {
  type AccountedInvoice,
  type ExtensionGroup,
  type InitiatorAccount,
  remainingBilling,
  sameWindowDates,
  type WindowBounds,
} from "./quantityAccounting.ts";

// ── Per-side data ────────────────────────────────────────────────

/** An initiator as the builder reads it, per side. */
export interface RemainderInitiators {
  receivable: { uid: string; number: number; items: readonly LineItem[]; destinations: readonly DocDestinationType[] };
  payable: Pick<Purchase, "uid" | "number" | "items" | "destinations">;
}

/** A billing document's row and pair, per side. */
export interface RemainderRows {
  receivable: { row: InvoiceDocItemType; pair: InvoiceDocDestinationType };
  payable: { row: PurchaseDocumentRow; pair: PurchaseDocDestination };
}

/** One source of a remainder: an initiator and its account over EVERY billing and credit document on it. */
export interface RemainderSource<S extends Side> {
  initiator: RemainderInitiators[S];
  /** `accountBilling(side, billableInitiator(side, initiator, asOf), …)`, never a page of documents. */
  account: InitiatorAccount;
}

/** What one side contributes to the one assembly. Never read by an `if side`. */
interface RemainderSide<S extends Side> {
  /** The scope divider the source's block opens with (`order` / `purchase`). */
  scopeDivider(initiator: RemainderInitiators[S]): RemainderRows[S]["row"];
  /** An initiator DIVIDER row under the source's scope. */
  projectDivider(item: LineItem, scope: string): RemainderRows[S]["row"];
  /** An initiator LINE at `quantity` units, a part starting after `from`. */
  projectLine(item: LineItem, scope: string, quantity: number, from: number): RemainderRows[S]["row"];
  /**
   * An extension-section line: initiator line `item`, priced on the BILLED ROW
   * `billed`'s terms (ruling 175), at `counts`, placed at `path`.
   */
  extensionLine(billed: LineItem, item: LineItem, scope: string, path: string[], quantity: number, counts: readonly TierCount[]): RemainderRows[S]["row"];
  /** An initiator pair projected onto the billing document. */
  projectPair(scope: string, pair: DocDestinationType): RemainderRows[S]["pair"];
  /** The pairs a remainder is metered over: the payable side clips an open hire at `asOf`. */
  billablePairs(initiator: RemainderInitiators[S], asOf: string): RemainderInitiators[S]["destinations"];
}

const RECEIVABLE_REMAINDER: RemainderSide<"receivable"> = {
  scopeDivider: (order) =>
    ({ uid: order.uid, type: "order", name: `Order #${order.number}`, description: "", path: [order.uid] }) as InvoiceDocItemType,
  projectDivider: (item, scope) => projectOrderItemToInvoiceItem(item, scope),
  projectLine: (item, scope, quantity, from) => ({
    ...projectOrderItemToInvoiceItem({ ...item, quantity } as LineItem, scope),
    ...(from > 0 ? { units_from: from } : {}),
  }) as InvoiceDocItemType,
  extensionLine: (billed, item, scope, path, quantity, counts) => {
    const projected = projectOrderItemToInvoiceItem({
      ...billed,
      uid: item.uid,
      path: item.path,
      quantity,
      price: { ...billed.price, counts: [...counts] },
    } as LineItem, scope);
    // An extension section bills more days of a leg; it is not an exchange, so a
    // copied exchange line keeps no take-back list (its pair's `exchange` is
    // nulled, and `checkInvoiceExchangedFor` refuses the field off one). Nor is it
    // a part: it bills time, not units.
    const { exchanged_for: _exchange, units_from: _part, ...line } = projected as InvoiceDocItemType & {
      exchanged_for?: unknown;
      units_from?: unknown;
    };
    return { ...line, path } as InvoiceDocItemType;
  },
  projectPair: (scope, pair) => toInvoiceDestinationPair(scope, pair),
  billablePairs: (order) => order.destinations,
};

const PAYABLE_REMAINDER: RemainderSide<"payable"> = {
  scopeDivider: (purchase) => purchaseScopeDivider(purchase),
  projectDivider: (item, scope) => ({ ...item, path: [scope, ...(item.path ?? [])] }) as unknown as PurchaseDocumentRow,
  projectLine: (item, scope, quantity, from) => ({
    ...projectPurchaseLineToBillLine(item as unknown as PurchaseItem, { uid_purchase: scope, quantity, from }),
    // A flat line already states it (its slice's marker); a TIME line prices from it (ruling 174).
    ...(from > 0 ? { units_from: from } : {}),
  }) as PurchaseDocumentRow,
  extensionLine: (billed, item, scope, path, quantity, counts) => {
    // The purchase line's head, the BILLED ROW's terms (ruling 175).
    const source = item as unknown as PurchaseItem;
    const terms = billed.price as unknown as Pick<PurchaseItem["price"], "price_formula" | "rates" | "discount">;
    const line = projectPurchaseLineToBillLine(
      { ...source, price: { ...source.price, price_formula: terms.price_formula, rates: terms.rates, discount: terms.discount } } as PurchaseItem,
      { uid_purchase: scope, quantity, from: 0, counts: [...counts] },
    );
    const { units_from: _part, exchanged_for: _exchange, ...rest } = line as typeof line & { units_from?: unknown; exchanged_for?: unknown };
    return { ...rest, path } as unknown as PurchaseDocumentRow;
  },
  projectPair: (scope, pair) => ({ uid_source: scope, ...pair }) as unknown as PurchaseDocDestination,
  billablePairs: (purchase, asOf) => clipOpenHires(purchase, asOf),
};

/** The two sides' remainder data. */
export const REMAINDER_SIDES: { [S in Side]: RemainderSide<S> } = {
  receivable: RECEIVABLE_REMAINDER,
  payable: PAYABLE_REMAINDER,
};

// ── The clip ─────────────────────────────────────────────────────

/**
 * **A purchase's pairs as a billing document meters them at `asOf`**: a pair
 * holding a TIME line with no charge window yet (an open hire) is windowed from
 * its delivery start to `asOf`, so what it has run so far meters. Every other
 * pair is unchanged. Moved from the api's `billingPairs` (6e-0d2) so the offer,
 * the builder and the credit writer read ONE clip.
 */
export function clipOpenHires(
  purchase: Pick<Purchase, "items" | "destinations">,
  asOf: string,
): Purchase["destinations"] {
  const metered = new Set(purchaseLines(purchase.items).filter((l) => purchaseItemBasis(l) === "time").map((l) => l.path[0]));
  return purchase.destinations.map((pair) => {
    const start = pair.dates.delivery_start;
    if (!metered.has(pair.uid) || pair.dates.charge_windows !== null || start === null) return pair;
    if (Date.parse(asOf) <= Date.parse(start)) return pair;
    return { ...pair, dates: { ...pair.dates, charge_windows: [{ start, end: asOf }] } };
  });
}

/**
 * **The initiator a billing reader meters**, per side: the receivable order as
 * it is (an order with a rental states windows on every pair), the payable
 * purchase with its open hires clipped at `asOf` ({@link clipOpenHires}). The
 * builder's account, the credit writer's account and the catalog's offer all
 * read this, so none answers over different windows.
 */
export function billableInitiator<S extends Side, I extends RemainderInitiators[S]>(side: S, initiator: I, asOf: string): I {
  const data = REMAINDER_SIDES[side] as RemainderSide<S>;
  return { ...initiator, destinations: data.billablePairs(initiator, asOf) };
}

// ── The builder ──────────────────────────────────────────────────

/** {@link buildRemainder}'s answer. */
export interface BillingRemainder<S extends Side> {
  /** Every source's block, in source order: its scope divider, its dividers and lines, then its extension sections. Empty when anything refused. */
  items: RemainderRows[S]["row"][];
  /** Every source's pairs, then one pair per extension section. */
  destinations: RemainderRows[S]["pair"][];
  /** Whether any source has anything left to bill. */
  bills: boolean;
  /** Per source: lines and extension groups billed BEYOND the initiator — a credit's to settle, never a remainder's. */
  overbilled: { uid_source: string; path: string[]; quantity: number; extension_counts: readonly TierCount[] }[];
  /** Per refused source (ruling 177): the unaligned billing documents and the live CRMS-authored ones. Non-empty ⇒ nothing is built. */
  refused: { uid_source: string; unaligned: string[]; crms_authored: string[] }[];
  /** Every billing document compared, across sources. */
  compared: string[];
}

const pathKey = (path: readonly string[]) => path.join("/");

/** Whether `candidate` is a strict ancestor of any key in `keys`. */
function isAncestorOf(candidate: readonly string[], keys: Iterable<string>): boolean {
  const prefix = pathKey(candidate) + "/";
  for (const k of keys) if (k.startsWith(prefix)) return true;
  return false;
}

/** The live CRMS-authored billing documents, from the account's headers. */
function liveCrmsAuthored(account: InitiatorAccount): string[] {
  return [...account.documents.values()].filter((d) => d.role === "billing" && d.live && d.crms_id !== null).map((d) => d.uid);
}

/**
 * **Build the remainder of every source** — see the module header.
 *
 * @param sources - Each initiator, already {@link billableInitiator}'d, with its account over the same
 * @param mintUid - Mints each extension section divider's uid
 * @throws Error when an extension is owed on units a SUBSTITUTE billed (manager#414:
 *   the extension line would price the substitute at the replaced line's path), and
 *   when a destination owed time states no charge window to extend
 */
export function buildRemainder<S extends Side>(
  side: S,
  sources: readonly RemainderSource<S>[],
  mintUid: () => string = () => crypto.randomUUID(),
): BillingRemainder<S> {
  const data = REMAINDER_SIDES[side] as RemainderSide<S>;
  const out: BillingRemainder<S> = { items: [], destinations: [], bills: false, overbilled: [], refused: [], compared: [] };
  const decided = sources.map((source) => ({ source, decision: remainingBilling(source.account) }));
  for (const { source, decision } of decided) {
    out.compared.push(...source.account.compared);
    if (decision.refused) {
      out.refused.push({ uid_source: source.initiator.uid, unaligned: [...source.account.unaligned], crms_authored: liveCrmsAuthored(source.account) });
    }
  }
  if (out.refused.length > 0) return out;

  for (const { source, decision } of decided) {
    const S = source.initiator.uid;
    out.overbilled.push(...decision.overbilled.map((o) => ({ uid_source: S, ...o })));
    if (decision.bills) out.bills = true;
    for (const entries of decision.owed.values()) {
      const bySubstitute = entries.find((e) => e.group.via === "substitute");
      if (bySubstitute !== undefined) {
        throw new Error(
          `Line ${bySubstitute.line.name} was billed by a substitute; an extension on a substituted line cannot be built yet (manager#414)`,
        );
      }
    }
    // Where each line's billing stands: the ACTED billed units (floored at 0, R2).
    const from = new Map(source.account.lines.map((l) => [pathKey(l.path), Math.max(0, l.billed.quantity)]));
    const block = assembleSource(data, source.initiator, decision.units, decision.owed, from, mintUid);
    out.items.push(...block.items);
    out.destinations.push(...block.destinations);
  }
  return out;
}

/** One source's block: its scope, then its extension sections. */
function assembleSource<S extends Side>(
  data: RemainderSide<S>,
  initiator: RemainderInitiators[S],
  units: ReadonlyMap<string, number>,
  owed: ReadonlyMap<string, Array<{ line: LineItem; group: ExtensionGroup }>>,
  from: ReadonlyMap<string, number>,
  mintUid: () => string,
): { items: RemainderRows[S]["row"][]; destinations: RemainderRows[S]["pair"][] } {
  const S = initiator.uid;
  const initiatorItems = initiator.items as unknown as readonly LineItem[];
  const items: RemainderRows[S]["row"][] = [data.scopeDivider(initiator)];
  for (const item of initiatorItems) {
    if (!isLineItemType(item.type)) {
      items.push(data.projectDivider(item, S));
      continue;
    }
    const k = pathKey(item.path ?? []);
    const quantity = units.get(k) ?? (isAncestorOf(item.path ?? [], units.keys()) ? 0 : undefined);
    if (quantity === undefined) continue;
    items.push(data.projectLine(item, S, quantity, quantity > 0 ? from.get(k) ?? 0 : 0));
  }

  const pairs = (initiator.destinations as readonly DocDestinationType[]).map((pair) => data.projectPair(S, pair));
  const sectionPairs: RemainderRows[S]["pair"][] = [];

  for (const [destination, entries] of owed) {
    const divider = initiatorItems.find((it) => it.type === "destination" && it.uid === destination);
    const pair = (initiator.destinations as readonly DocDestinationType[]).find((p) => p.uid === destination);
    const windows = pair?.dates.charge_windows ?? null;
    if (divider === undefined || pair === undefined || windows === null || windows.length === 0) {
      throw new Error(`buildRemainder: destination ${destination} of ${S} states no charge window to extend`);
    }

    // One section per billed WINDOW SET; each line in it states its own counts,
    // because its lines may be on different formulas (ruling 8).
    const sections: Array<{ billedSet: readonly WindowBounds[]; billedEnd: string; byPath: Map<string, { line: LineItem; group: ExtensionGroup }> }> = [];
    for (const entry of entries) {
      const k = pathKey(entry.line.path ?? []);
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
      items.push({ ...data.projectDivider(divider, S), uid: E, path: [S, E], path_extension_for: [destination] } as RemainderRows[S]["row"]);
      for (const item of initiatorItems) {
        const path = item.path ?? [];
        if (path[0] !== destination || item.type === "destination") continue;
        const k = pathKey(path);
        const entry = section.byPath.get(k);
        if (!entry && !isAncestorOf(path, section.byPath.keys())) continue;
        const scoped = [S, E, ...path.slice(1)];
        if (!isLineItemType(item.type)) {
          items.push({ ...data.projectDivider(item, S), path: scoped } as RemainderRows[S]["row"]);
          continue;
        }
        // A billed group prices on the row that billed it, at the counts the
        // initiator's windows add. An ancestor bills nothing (quantity 0), and
        // states zero counts only because every line in a section must state some.
        const billed = entry ? entry.group.item : item;
        const counts: TierCount[] = entry
          ? [...entry.group.extension_counts]
          : (billed.price?.rates ?? []).slice(0, 1).map((r) => ({ rate_key: r.rate_key, num: 0, den: 1 }));
        items.push(data.extensionLine(billed, item, S, scoped, entry ? entry.group.quantity : 0, counts));
      }

      const projected = data.projectPair(S, pair) as RemainderRows[S]["pair"] & { dates: DocDestinationType["dates"] };
      const start = chicagoDayAtTimeOf(section.billedEnd, 1, windows[0].start);
      const end = windows[windows.length - 1].end;
      sectionPairs.push({
        ...projected,
        uid: E,
        // Spread from the projected pair, so an extension of an exchange leg would
        // otherwise claim to BE an exchange (ruling 82): it bills days, it swaps nothing.
        exchange: null,
        dates: { ...projected.dates, charge_windows: [{ start, end }] },
      } as RemainderRows[S]["pair"]);
    }
  }

  return { items, destinations: [...pairs, ...sectionPairs] };
}

// ── The receivable single-order form ─────────────────────────────

/** The order fields {@link buildRemainingInvoice} reads. */
export type RemainingOrderSource = RemainderInitiators["receivable"];

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
  /** Live CRMS-authored invoices; non-empty ⇒ nothing is built. */
  crms_authored: string[];
}

/**
 * **One order's remainder**, the receivable single-source form of
 * {@link buildRemainder} the manager's preview reads: empty `items` when the
 * account refuses (naming `unaligned` / `crms_authored`) or when nothing remains,
 * so "nothing left" stays one test for that caller.
 *
 * @param account - {@link accountBilling} over EVERY invoice and credit note on the order, never a page
 */
export function buildRemainingInvoice(
  order: RemainingOrderSource,
  account: InitiatorAccount,
  mintUid: () => string = () => crypto.randomUUID(),
): RemainingInvoice {
  const built = buildRemainder("receivable", [{ initiator: order, account }], mintUid);
  const refused = built.refused[0];
  if (refused !== undefined) {
    return { items: [], destinations: [], overbilled: [], compared: account.compared, unaligned: refused.unaligned, crms_authored: refused.crms_authored };
  }
  const overbilled = built.overbilled.map(({ uid_source: _s, ...o }) => o);
  if (!built.bills) return { items: [], destinations: [], overbilled, compared: account.compared, unaligned: [], crms_authored: [] };
  return { items: built.items, destinations: built.destinations, overbilled, compared: account.compared, unaligned: [], crms_authored: [] };
}
