/**
 * Price formula propagation — the `price-formulas` catalog
 * (purchases-as-documents D1, `api-cloudrun/.claude/plans/purchases-as-documents.md`).
 *
 * ⚠️ **Neither transaction propagates anything, by design.** A line snapshots
 * the formula it priced with (`price.price_formula: { uid, name }`) and the
 * rates it priced with (`price.rates`), so no live document reads a formula
 * after it is priced — a formula's rule is immutable once referenced, and a
 * rename reaches a line on its next reprice, the way a renamed tax code does.
 */
import type { PropagationModule, TransactionDefinition } from "./types.ts";

const formulaTransactions: TransactionDefinition[] = [
  {
    id: "create-price-formula",
    description:
      "Creates a price formula, refused on any `priceFormulaRuleIssues` violation. Propagates nothing: no line has priced with it yet.",
    steps: [],
  },
  {
    id: "update-price-formula",
    description:
      "Renames, re-describes, deactivates or supersedes a price formula. The rule itself is not on the input: a changed rule is a new formula. Propagates nothing: every line holds its own snapshot.",
    steps: [],
  },
];

/** Everything `propagation/price-formulas.ts` contributes to the propagation catalog. */
export const priceFormulas: PropagationModule = {
  rules: [],
  transactions: formulaTransactions,
};
