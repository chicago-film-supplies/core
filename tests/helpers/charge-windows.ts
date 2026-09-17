import type { LineItem } from "../../src/utils/orders.ts";
import type { PairChargeWindows, PriceDocumentExtension } from "../../src/utils/price-document.ts";

/**
 * One single-window pair per day-carrying rental line, at the line's own path,
 * whose window carries the line's `chargeable_days`. A single window prices
 * exactly as the line's own days did before windows, so a pricing test that is
 * not about windows keeps the days it states. Lines in an extension section get
 * no pair: they bill their own stated days.
 */
export function linePairs(
  items: readonly LineItem[],
  extensions: readonly PriceDocumentExtension[] = [],
): PairChargeWindows[] {
  const inExtension = (path: readonly string[]) =>
    extensions.some((ext) => ext.divider_path.every((segment, i) => path[i] === segment));
  return items
    .filter((it) =>
      it.type === "rental" && it.price?.formula === "five_day_week" &&
      typeof it.price.chargeable_days === "number" && !inExtension(it.path ?? [])
    )
    .map((it) => ({ divider_path: [...(it.path ?? [])], days: [it.price!.chargeable_days as number] }));
}
