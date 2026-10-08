/**
 * The rules for a legal items array, composed ONCE.
 *
 * Before this module they lived in three places that disagreed: manager's
 * reorder guard, api-cloudrun's write guard (`api-cloudrun/src/lib/validate.ts` +
 * `api-cloudrun/src/lib/firestoreWrite.ts`),
 * and the core schema refinements. A rule added to one was missing from the
 * others until someone noticed — the manager offered reorders the API then
 * 400'd on mixed booking grains, a zero-priced line at the root, or a misplaced
 * `exchanged_for`. {@link itemArrayIssues} is the one composition; the next rule
 * lands here and every caller has it.
 *
 * **It ADDS no rule.** Every arm is an existing building block, named in the
 * table on {@link itemArrayIssues}, and the schema refinements stay — they are
 * what `validateCollection` audits the stored corpus through.
 *
 * **It holds issues, not policy.** The API refuses on any issue; the manager
 * accepts a reorder that does not make the count worse. Both read the same list.
 *
 * @module
 */
import {
  type DestinationExchangeType,
  type DestinationJoinViolation,
  destinationJoinViolations,
  type ExchangedForViolation,
  exchangedForViolations,
  type LeadingDividerViolation,
  leadingDividerViolations,
  type MixedBookingGrain,
  mixedBookingGrains,
  type ZeroPricedComponentFinding,
  zeroPricedFlaggedNonComponents,
  zeroPricedUnstatedComponents,
  zeroQuantityComponents,
} from "../schemas/mod.ts";
import {
  computeItemPaths,
  type ItemParentageIssue,
  type ItemPathIssue,
  type ItemUniquenessIssue,
  type LineItem,
  validateItemParentage,
  validateItemPaths,
  validateItemUniqueness,
} from "./orders.ts";
import {
  computeInvoiceItemPaths,
  type InvoiceItem,
  validateInvoiceItemPaths,
  validateInvoiceItemUniqueness,
} from "./invoices.ts";

/** Which document an items array belongs to. Each grain has its own rule set. */
export type ItemArrayGrain = "order" | "invoice" | "fulfillment";

/** The document fields {@link itemArrayIssues} reads. */
export interface ItemArrayDoc {
  items: readonly LineItem[];
  /** The destination pairs. Absent ⇒ the `destination_join` and `exchanged_for` arms are skipped. */
  destinations?: ReadonlyArray<{ uid: string; exchange?: DestinationExchangeType | null }>;
  /** An invoice's source orders; non-empty ⇒ it must lead with an `order` divider. */
  query_by_orders?: readonly string[];
}

/** Options for {@link itemArrayIssues}. */
export interface ItemArrayIssueOptions {
  /**
   * Re-path the items first, with the grain's own normalizer
   * (`computeItemPaths`, or `computeInvoiceItemPaths` for an invoice — by name,
   * never by passing levels). For a CLIENT judging an array it is about to send
   * through that normalizer anyway; `path_fixed_point` is then empty by
   * construction. A writer leaves it off, because the fixed point is the check.
   */
  recompute?: boolean;
}

/**
 * One reason an items array is not legal, discriminated by `rule`. Each arm
 * carries its building block's own finding, so a caller mapping it onto an
 * existing error shape loses nothing.
 */
export type ItemArrayIssue =
  | ({ rule: "leading_divider" } & LeadingDividerViolation)
  | ({ rule: "destination_join" } & DestinationJoinViolation)
  | ({ rule: "parentage" } & ItemParentageIssue)
  | ({ rule: "uniqueness" } & ItemUniquenessIssue)
  | { rule: "path_empty"; index: number; uid: string | undefined }
  | { rule: "path_not_self"; index: number; uid: string | undefined; path: string[] }
  | ({ rule: "path_fixed_point" } & ItemPathIssue)
  | ({ rule: "zero_priced_non_component" } & ZeroPricedComponentFinding)
  | ({ rule: "zero_priced_unstated" } & ZeroPricedComponentFinding)
  | ({ rule: "zero_quantity_component" } & ZeroPricedComponentFinding)
  | ({ rule: "mixed_booking_grain" } & MixedBookingGrain)
  | ({ rule: "exchanged_for" } & ExchangedForViolation);

/** Every `rule` an {@link ItemArrayIssue} can carry. */
export type ItemArrayRule = ItemArrayIssue["rule"];

/**
 * Every way an items array breaks the rules of its grain.
 *
 * | rule | built from | grains |
 * |---|---|---|
 * | `leading_divider` | `leadingDividerViolations` (`linked` = `query_by_orders` non-empty) | all |
 * | `destination_join` | `destinationJoinViolations` | all (needs `destinations`) |
 * | `parentage` | `validateItemParentage` | all |
 * | `uniqueness` | `validateItemUniqueness` / `validateInvoiceItemUniqueness` | all |
 * | `path_empty`, `path_not_self` | asserted directly — invariants (4) and (5) | all |
 * | `path_fixed_point` | `validateItemPaths` / `validateInvoiceItemPaths` | all |
 * | `zero_priced_non_component`, `zero_priced_unstated` | `zeroPricedFlaggedNonComponents`, `zeroPricedUnstatedComponents` | all |
 * | `zero_quantity_component`, `mixed_booking_grain` | `zeroQuantityComponents`, `mixedBookingGrains` | order |
 * | `exchanged_for` | `exchangedForViolations` | order, fulfillment (needs `destinations`) |
 *
 * ⚠️ **(4) and (5) are asserted directly, beside the fixed point, on purpose.**
 * A fixed-point check can only agree with its normalizer; these hold whatever
 * the normalizer does (the `cfs-items` skill records the 79 items a fixed point
 * certified clean).
 *
 * **Deliberately OUT** — each needs context an items array does not carry:
 * - `orderLineClaimIssues` — needs the OTHER orders' current items;
 * - `chargeWindowPairViolations` — needs the pricing context;
 * - the fulfillment's `uid_order` / `order_number` agreement — needs the
 *   document's own identity;
 * - a product's `components` — a different path convention; that is
 *   `validateComponentUniqueness`;
 * - credit notes — they carry no structural paths.
 *
 * Returns `[]` for a legal array.
 */
export function itemArrayIssues(
  doc: ItemArrayDoc,
  grain: ItemArrayGrain,
  opts: ItemArrayIssueOptions = {},
): ItemArrayIssue[] {
  const raw = [...doc.items];
  const items: LineItem[] = !opts.recompute
    ? raw
    : grain === "invoice"
    ? computeInvoiceItemPaths(raw as InvoiceItem[])
    : computeItemPaths(raw);
  const issues: ItemArrayIssue[] = [];

  const linked = (doc.query_by_orders?.length ?? 0) > 0;
  for (const v of leadingDividerViolations(items, grain, linked)) issues.push({ rule: "leading_divider", ...v });
  if (doc.destinations) {
    for (const v of destinationJoinViolations(items, doc.destinations)) {
      issues.push({ rule: "destination_join", ...v });
    }
  }
  for (const v of validateItemParentage(items)) issues.push({ rule: "parentage", ...v });
  const uniqueness = grain === "invoice"
    ? validateInvoiceItemUniqueness(items as InvoiceItem[])
    : validateItemUniqueness(items);
  for (const v of uniqueness) issues.push({ rule: "uniqueness", ...v });

  items.forEach((it, index) => {
    const path = it?.path;
    if (!Array.isArray(path) || path.length === 0) issues.push({ rule: "path_empty", index, uid: it?.uid });
    else if (path.at(-1) !== it.uid) issues.push({ rule: "path_not_self", index, uid: it.uid, path });
  });
  const fixedPoint = grain === "invoice" ? validateInvoiceItemPaths(items as InvoiceItem[]) : validateItemPaths(items);
  for (const v of fixedPoint) issues.push({ rule: "path_fixed_point", ...v });

  for (const v of zeroPricedFlaggedNonComponents(items)) issues.push({ rule: "zero_priced_non_component", ...v });
  for (const v of zeroPricedUnstatedComponents(items)) issues.push({ rule: "zero_priced_unstated", ...v });

  if (grain === "order") {
    for (const v of zeroQuantityComponents(items)) issues.push({ rule: "zero_quantity_component", ...v });
    for (const v of mixedBookingGrains(items)) issues.push({ rule: "mixed_booking_grain", ...v });
  }
  if (grain !== "invoice" && doc.destinations) {
    for (const v of exchangedForViolations({ destinations: doc.destinations, items })) {
      issues.push({ rule: "exchanged_for", ...v });
    }
  }
  return issues;
}
