/**
 * Rebuilding a fulfillment's `items[]` from a picker submission.
 *
 * ONE function, called by both writers — `api-cloudrun`'s
 * `PUT /fulfillments/{uid}/items` and the manager's optimistic
 * `applySubstitution`. It lives here because a copy drifted: the manager
 * normalized with a bare `computeItemPaths` while the API bucketed by carried
 * path, and the manager's comment asserted they used the same function while
 * they did not. That divergence shipped a real defect — a substitution appended
 * at the array tail was re-parented to the LAST divider in the document and
 * lost its line-item parent, so substituting into any order with more than one
 * group failed at the API's in-place check.
 *
 * ## Sequence is NOT the picker's to author
 *
 * 🔴 **The order of `items[]` comes from the STORED document, never from the
 * submission.** A picker authors which lines exist, their quantities, and
 * substitutions — nothing else. The fulfillment surface has no drag-reorder
 * (dnd-kit is wired on orders, invoices and products; not here), so a
 * submission's sequence carries no operator intent to preserve.
 *
 * ⚠️ **The zero-priced-first invariant is no longer part of the reason.** This
 * used to say a fulfillment line carried no `zero_priced` and so could only
 * inherit its order's sequence. It has carried the flag since 2026-09-10
 * (emitted by `projectItem`, corpus backfilled, and checked by
 * `checkZeroPricedComponents` on `FulfillmentSchema`), so a fulfillment can
 * evaluate the invariant itself. What stands is the sentence above: sequence
 * is not the picker's to author, so the stored order is kept.
 *
 * ## Why keyed on `path`, never `uid`
 *
 * ⚠️ `item.uid` is not a row identity — it repeats within one document, in 18%
 * of prod orders (a priced principal beside zero-priced accessory copies, a
 * `splitItem`, or a product appearing standalone and as a kit component). Only
 * `path` identifies a row within a document, which is why the submission is
 * matched on it.
 *
 * @module
 */
import { computeItemPaths } from "./orders.ts";
import { collectSubstitutionAnchors, isStrictlyBelow, isSubstitutionRow } from "./substitutions.ts";
import { isFulfillmentLineItem } from "../schemas/fulfillment.ts";
import { isFulfillableItemType } from "../schemas/common.ts";
import type {
  FulfillmentItemType,
  FulfillmentLineItemType,
} from "../schemas/fulfillment.ts";

/** `path` as a map key. `\x1f` cannot occur in a uid, so this cannot collide. */
function pathKey(path: readonly string[] | undefined): string {
  return (path ?? []).join("\x1f");
}

/**
 * Rebuild the items array from the stored document and a picker submission.
 *
 * Structure and sequence come from `storedItems`; membership, quantities and
 * substitutions come from `submitted`. The result is a function of
 * *(stored order, submitted set)* — **the order lines arrive in does not affect
 * it**, which is the property the two previous implementations both lacked.
 *
 * - A stored line whose path the submission still carries is kept, in place,
 *   carrying the submitted line's values.
 * - A stored line the submission drops is removed.
 * - A submitted line with no stored counterpart is a substitution: it is placed
 *   immediately after the deepest ancestor the output still carries, which is
 *   where its parentage comes from. Several substitutions against one ancestor
 *   keep their submitted order relative to each other.
 * - Structural items are never taken from the submission — the picker does not
 *   own them, and the API strips them from the request body.
 *
 * `computeItemPaths` runs last and remains the ONE author of `path`; this
 * function only decides the sequence it reads.
 */
export function rebuildFulfillmentItems(
  storedItems: readonly FulfillmentItemType[],
  submitted: readonly FulfillmentLineItemType[],
): FulfillmentItemType[] {
  // Structural items are dropped from the submission ENTIRELY rather than
  // merely ignored in pass 1: the picker does not own them, the API strips
  // them from the request body, and without this a smuggled divider would fall
  // through to pass 2 as an unmatched "new line" and be inserted into the tree.
  const submittedLines = submitted.filter((li) => isFulfillmentLineItem(li));

  const submittedByPath = new Map<string, FulfillmentLineItemType>();
  for (const li of submittedLines) submittedByPath.set(pathKey(li.path), li);

  // Pass 1 — stored order decides everything that already existed.
  const out: FulfillmentItemType[] = [];
  const consumed = new Set<string>();
  for (const item of storedItems) {
    if (!isFulfillmentLineItem(item)) {
      out.push(item);
      continue;
    }
    const key = pathKey(item.path);
    const match = submittedByPath.get(key);
    if (match) {
      out.push(match);
      consumed.add(key);
    }
    // else: the picker removed this line — drop it.
  }

  // Pass 2 — anything left is new, and a new line is a substitution. Place it
  // after its nearest surviving ancestor, the only statement of its parentage.
  const placedPerAnchor = new Map<string, number>();
  // Lines whose parentage resolved to nothing at all. They go to the ROOT, not
  // to the tail: appending would hand them whichever divider happens to come
  // last, which is precisely the re-parenting defect this function exists to
  // remove. A root-level path states "we do not know where this belongs"
  // instead of asserting somewhere wrong.
  const rootless: FulfillmentLineItemType[] = [];
  for (const li of submittedLines) {
    const key = pathKey(li.path);
    if (consumed.has(key)) continue;
    consumed.add(key);

    // The deepest ancestor the output still carries, so the line keeps as much
    // of its parentage as survives. Matched on the ancestor's PATH, never its
    // uid: one kit on two legs (or standalone and nested in one group) is two
    // rows sharing a uid, and a uid match took the first — another leg's copy —
    // so the substitution landed on the wrong leg (core#129).
    let at = -1;
    const path = li.path ?? [];
    for (let d = path.length - 2; d >= 0 && at === -1; d--) {
      const ancestorKey = pathKey(path.slice(0, d + 1));
      at = out.findIndex((i) => pathKey(i.path) === ancestorKey);
    }

    if (at === -1) {
      rootless.push(li);
    } else {
      // Offset past substitutions already placed against this same row, so a
      // second one does not jump ahead of the first. Counted rather than
      // scanned: the row itself never moves, so its index is stable and the
      // n-th insertion belongs at `row + 1 + n`.
      const seat = pathKey(out[at].path);
      const nth = placedPerAnchor.get(seat) ?? 0;
      out.splice(at + 1 + nth, 0, li);
      placedPerAnchor.set(seat, nth + 1);
    }
  }

  out.unshift(...rootless);

  return computeItemPaths(out);
}

/**
 * **A KEPT fulfillment row keeps its PRODUCT ancestors** — the rows, among
 * `candidates`, that sit strictly above some `kept` row, each in the form it
 * survives as: `quantity: 0`, `quantity_ordered: 0` (structure, not units —
 * ruling Q2 of api-cloudrun#1147).
 *
 * A kit component's grain includes its kit, and `computeItemPaths` derives a
 * row's path from the rows above it, so a kept component whose kit parent went
 * is re-rooted: its booking signature goes null, it detaches from its 4-segment
 * booking, and its stored `zero_priced: true` lands on a top-level line, which
 * `FulfillmentSchema` refuses. A kit's OWN booking keeps it only when that
 * booking holds custody, and an operator who checked out only the components
 * left the kit's booking a plan — so custody alone does not keep the kit, and
 * this rule has to.
 *
 * ONE rule for every writer that keeps rows by custody. It was `syncRows`'
 * private loop (`api-cloudrun/src/lib/orderFulfillmentSync.ts`, kit review A)
 * while the invoice-only projection
 * (`api-cloudrun/src/lib/invoiceOnlyProjection.ts`) kept a component and
 * dropped its kit.
 *
 * @param candidates - Line rows the writer would otherwise DROP. Which rows
 *   those are is the writer's own rule; dividers are placed separately
 *   (`placeStoredOnlyRows`) and do not belong here.
 * @param kept - The rows being kept, by their (stored) path
 * @returns Each candidate to keep, mapped to the row it survives as
 */
export function keepKitAncestors<T extends FulfillmentLineItemType>(
  candidates: readonly T[],
  kept: readonly { readonly path: readonly string[] }[],
): Map<T, T> {
  const out = new Map<T, T>();
  for (const row of candidates) {
    if (kept.some((k) => isStrictlyBelow(k.path, row.path))) {
      out.set(row, { ...row, quantity: 0, quantity_ordered: 0 });
    }
  }
  return out;
}

/**
 * Why a stored fulfillment LINE row exists — {@link fulfillmentRowSources}.
 *
 * | source | the row is | how it is told |
 * |---|---|---|
 * | `order` | the order's own line | an order line is at its path |
 * | `substitution` | a substitute Y, or one of Y's components | a `substituted_for` entry, or at/below an anchor |
 * | `exchange` | a unit of a warehouse-staged exchange | under an exchange pair the ORDER does not carry |
 * | `kept` | a line an order edit removed while its units were out (api-cloudrun#1147) | `quantity_ordered: 0` |
 * | `invoice_projected` | an invoice-only line projected to reach the shelf (api-cloudrun#1188) | a positive `quantity_ordered` |
 * | `unexplained` | none of these — a finding | — |
 */
export type FulfillmentRowSource =
  | "order"
  | "substitution"
  | "exchange"
  | "kept"
  | "invoice_projected"
  | "unexplained";

/** The order fields {@link fulfillmentRowSources} reads. */
export interface RowSourceOrder {
  items: ReadonlyArray<{ readonly type: string; readonly path: readonly string[] }>;
  destinations: ReadonlyArray<{ readonly uid: string }>;
}

/** The fulfillment fields {@link fulfillmentRowSources} reads. */
export interface RowSourceFulfillment<T extends FulfillmentLineItemType> {
  items: ReadonlyArray<FulfillmentItemType | T>;
  destinations: ReadonlyArray<{ readonly uid: string; readonly exchange?: unknown }>;
}

/**
 * Classify every LINE row of a stored fulfillment by why it exists (core#129).
 *
 * 🔴 **ONE classifier, because each consumer kept its own and they drifted.** A
 * fulfillment row the order does not carry has a small, closed set of
 * legitimate reasons, and every new one (kept rows, then invoice-projected rows)
 * was taught to some of the places that ask and not others. The picker save
 * refused a kept row as "no counterpart" while refusing its omission as a stale
 * view, so a fulfillment holding one could not be saved at all; the drift audit
 * reported every invoice-projected row as unexplained.
 *
 * **Precedence is the table's order**, top first: a row at an order path is
 * `order` whatever else it carries (a merged Y is the order's own row), and the
 * substitution and exchange licences are structural, so they outrank the
 * `quantity_ordered` reading. `null` there is what a substitute, an exchange
 * unit and a picker addition all state, which is why a NUMBER is the
 * server's signature.
 *
 * ⚠️ **Dividers are not classified** — their survival is a placement question
 * (`placeStoredOnlyRows`), not a provenance one.
 *
 * @param fulfillment - The stored fulfillment
 * @param order - The order it projects (only fulfillable lines are counted)
 * @returns Each line row, by object identity, mapped to its source
 */
export function fulfillmentRowSources<T extends FulfillmentLineItemType>(
  fulfillment: RowSourceFulfillment<T>,
  order: RowSourceOrder,
): Map<T, FulfillmentRowSource> {
  const orderPaths = new Set(
    order.items.filter((i) => isFulfillableItemType(i.type)).map((i) => pathKey(i.path)),
  );
  const orderPairs = new Set(order.destinations.map((p) => p.uid));
  const exchangeLegs = new Set(
    fulfillment.destinations.filter((p) => p.exchange != null && !orderPairs.has(p.uid)).map((p) => p.uid),
  );
  const lines = fulfillment.items.filter((i): i is T => isFulfillmentLineItem(i as FulfillmentItemType));
  const anchors = collectSubstitutionAnchors(lines);

  const out = new Map<T, FulfillmentRowSource>();
  for (const row of lines) {
    const q = row.quantity_ordered;
    const source: FulfillmentRowSource = orderPaths.has(pathKey(row.path))
      ? "order"
      : (row.substituted_for?.length ?? 0) > 0 || isSubstitutionRow(row.path, anchors)
      ? "substitution"
      : row.path[0] !== undefined && exchangeLegs.has(row.path[0])
      ? "exchange"
      : q === 0
      ? "kept"
      : typeof q === "number" && q > 0
      ? "invoice_projected"
      : "unexplained";
    out.set(row, source);
  }
  return out;
}
