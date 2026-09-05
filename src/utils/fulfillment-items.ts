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
 * Taking sequence from the stored document is also the only way the
 * zero-priced-first invariant survives: `zero_priced` is one of the six fields
 * stripped from a fulfillment line, so a fulfillment **cannot evaluate that
 * invariant about itself**. It can only inherit the sequence its order
 * projection already satisfies. A rebuild that honoured submission order would
 * be free to break it, silently and unverifiably.
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
import type {
  FulfillmentItemType,
  FulfillmentLineItemType,
} from "../schemas/fulfillment.ts";

/** `path` as a map key. `\x1f` cannot occur in a uid, so this cannot collide. */
function pathKey(path: readonly string[] | undefined): string {
  return (path ?? []).join("\x1f");
}

function isStructural(item: FulfillmentItemType): boolean {
  return item.type === "destination" || item.type === "group";
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
 *   immediately after the line named by its `path_substituted_for`, which is
 *   where its parentage comes from. Several substitutions against one anchor
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
  const submittedLines = submitted.filter((li) => !isStructural(li as FulfillmentItemType));

  const submittedByPath = new Map<string, FulfillmentLineItemType>();
  for (const li of submittedLines) submittedByPath.set(pathKey(li.path), li);

  // Pass 1 — stored order decides everything that already existed.
  const out: FulfillmentItemType[] = [];
  const consumed = new Set<string>();
  for (const item of storedItems) {
    if (isStructural(item)) {
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
  // after its anchor, because that is the only statement of its parentage.
  const placedPerAnchor = new Map<string, number>();
  for (const li of submittedLines) {
    const key = pathKey(li.path);
    if (consumed.has(key)) continue;
    consumed.add(key);

    const anchorKey = pathKey(li.path_substituted_for);
    let at = anchorKey === ""
      ? -1
      : out.findIndex((i) => pathKey(i.path) === anchorKey);

    if (at === -1) {
      // No anchor resolved — fall back to the deepest ancestor the output
      // still carries, so the line keeps as much of its parentage as survives.
      // Reached when a substitution's anchor was removed in the same write.
      const ancestry = (li.path ?? []).slice(0, -1);
      for (let d = ancestry.length - 1; d >= 0 && at === -1; d--) {
        at = out.findIndex((i) => (i.uid ?? "") === ancestry[d]);
      }
    }

    if (at === -1) {
      out.push(li);
    } else {
      // Offset past substitutions already placed against this same anchor, so
      // a second one does not jump ahead of the first. Counted rather than
      // scanned: the anchor itself never moves, so its index is stable and the
      // n-th insertion belongs at `anchor + 1 + n`.
      // Keyed on the RESOLVED row, not on `path_substituted_for`: two lines
      // that both fell back to the same ancestor share a placement point while
      // carrying different anchors, and keying on the anchor would stack them
      // on a counter neither of them owns.
      const seat = pathKey(out[at].path);
      const nth = placedPerAnchor.get(seat) ?? 0;
      out.splice(at + 1 + nth, 0, li);
      placedPerAnchor.set(seat, nth + 1);
    }
  }

  return computeItemPaths(out as never) as FulfillmentItemType[];
}
