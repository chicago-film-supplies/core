/**
 * Pure helpers over a movement SESSION — the document a receipt renders.
 *
 * ```ts
 * import { groupSessionItemsByOrder } from "@cfs/core/utils/sessions";
 * ```
 *
 * A session is the fold of every movement sharing one `uuid_session`
 * (`schemas/movement-session.ts`): one press of Check In, one printable record.
 * This namespace is what `it.sessions` resolves to for a
 * `movement-sessions`-sourced template.
 *
 * ## What belongs here, and what deliberately does not
 *
 * The test is `utils/fulfillments.ts`'s: **the document's own subject.** A
 * receipt states what physically changed hands, so it needs the grouping a
 * cross-order session forces and the direction each row moved. It does **not**
 * need the ledger fold — `applyMovementToLedger`, `costOfUnits`,
 * `applyOutOfServiceReason` and `LedgerFoldResult` stay in `utils/movements.ts`,
 * where the writers use them. Those are how a movement changes stock; a receipt
 * is a statement about what a person handed over, and putting an accounting
 * fold on it would advertise arithmetic no template should be doing.
 *
 * ⚠️ **`movementHeldDelta` is deliberately NOT re-exported**, even though it is
 * the one helper in `utils/movements.ts` whose argument a receipt actually holds
 * (`items[].lines` is a `MovementLineType[]`). It answers "did units come back
 * into CFS custody" — a real question, with no template asking it yet. Re-export
 * it when a family calls it, and lift its `TEMPLATE_HELPER_DENYLIST` entry in the
 * same change; shipping it now would be the dead helper-panel surface that
 * denylist exists to prevent.
 *
 * ⚠️ **There is no movement-type LABEL helper here, deliberately.** The manager
 * renders a type with a generic `startCase(camelCase(t))`
 * (`manager/src/components/inventory/MovementTimeline.tsx`), and a hand-written
 * map in core would be a second authority that disagrees with it the first time
 * either side is edited — for wording, which is a template's own business.
 *
 * @module
 */
import type { MovementLineType, MovementSessionItem } from "../schemas/mod.ts";

/** One order's rows within a session, in the order the journal returned them. */
export interface SessionOrderGroup {
  /** `null` for a row the journal recorded against no order. */
  uid_order: string | null;
  order_number: number | null;
  items: MovementSessionItem[];
  /** Units moved across this group's rows. */
  quantity: number;
}

/**
 * Split a session's rows into one group per order.
 *
 * ⚠️ **A session can span orders, and that is the point of the surface it comes
 * from.** `POST /returns` accepts whatever a worker was handed back — an item
 * from order A returned alongside order B is the driving case — so a receipt
 * that printed one flat list would give the customer no way to see which of
 * their jobs each line settled.
 *
 * Insertion order is preserved rather than sorted by order number: the fold
 * hands rows over in journal order, and re-sorting here would silently disagree
 * with the session timeline the operator saw when they pressed the button.
 *
 * A row with no `uid_order` gets its own `null` group rather than being dropped
 * — a manual movement swept into a session is still something the customer was
 * handed.
 */
export function groupSessionItemsByOrder(
  items: readonly MovementSessionItem[],
): SessionOrderGroup[] {
  const groups = new Map<string, SessionOrderGroup>();
  for (const item of items) {
    const key = item.uid_order ?? "";
    const existing = groups.get(key);
    if (existing) {
      existing.items.push(item);
      existing.quantity += item.quantity;
      continue;
    }
    groups.set(key, {
      uid_order: item.uid_order,
      order_number: item.order_number,
      items: [item],
      quantity: item.quantity,
    });
  }
  return [...groups.values()];
}

/**
 * Total units across a set of rows.
 *
 * Sums `quantity`, the movement's own count, and **not** the absolute value of
 * its lines: a row that moves units between two places carries one quantity and
 * two line sides, so summing lines would double it.
 */
export function sessionQuantity(items: readonly MovementSessionItem[]): number {
  return items.reduce((total, item) => total + item.quantity, 0);
}

/**
 * The distinct places a row's units moved between, as `{from, to}` labels.
 *
 * A template cannot read Firestore, so it can only print what a `DocSource`
 * already carries — `label` when the writer set one, otherwise nothing. Returned
 * as a list because one movement can draw from several shelves.
 */
export function sessionItemPlaces(
  lines: readonly MovementLineType[],
): Array<{ from: string | null; to: string | null; quantity: number }> {
  return lines.map((line) => ({
    from: line.location.from?.label ?? null,
    to: line.location.to?.label ?? null,
    quantity: line.quantity,
  }));
}
