import type { LineItem } from "../../src/utils/orders.ts";
import type { PairChargeWindows, PriceDocumentExtension } from "../../src/utils/price-document.ts";
import { businessDayWindow, FIVE_DAY_WEEK } from "./formulas.ts";

/**
 * One single-window pair per Five-day week line that states counts, at the
 * line's own path, whose window holds the business days those counts bill
 * (`num × 5 ÷ den`). A single window meters exactly what the line's counts
 * say, so a pricing test that is not about windows keeps the money it states.
 * Lines in an extension section get no pair: they bill their own stated
 * counts.
 */
export function linePairs(
  items: readonly LineItem[],
  extensions: readonly PriceDocumentExtension[] = [],
): PairChargeWindows[] {
  const inExtension = (path: readonly string[]) =>
    extensions.some((ext) => ext.divider_path.every((segment, i) => path[i] === segment));
  return items
    .filter((it) =>
      it.price?.price_formula?.uid === FIVE_DAY_WEEK.uid && (it.price.counts?.length ?? 0) > 0 &&
      !inExtension(it.path ?? [])
    )
    .map((it) => {
      const t = it.price!.counts[0];
      return { divider_path: [...(it.path ?? [])], windows: [businessDayWindow((t.num * 5) / t.den)] };
    });
}
