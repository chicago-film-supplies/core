/**
 * Tax propagation rules — update-tax cascades.
 *
 * Post-transaction fan-out: when a tax's name, rate, or type changes,
 * the denormalized TaxRef / PriceModifier snapshots on products,
 * webshop-products, and incomplete orders are updated.
 */
import type {
  CollectionRule,
  EnforcementRef,
  PropagationModule,
} from "./types.ts";

// ── What checks these rules ─────────────────────────────────────────
//
// ⚠️ `update-tax:to-webshop-products` is deliberately left UNLINKED. The one
// tax-cascade test sets `webshop.available: false` on its fixture product, so
// the webshop mirror is the one target it does NOT exercise — and nothing else
// covers it. Pointing at that test would be a pointer at the case it excludes.

const TAX_TO_PRODUCTS: EnforcementRef = {
  kind: "test",
  ref:
    "api-cloudrun/tests/integration/taxes/taxes.test.ts::PUT - cascades name change to products",
  clause:
    "the rename reaching a product's embedded `price.taxes[]` entry. Writer-path only; no corpus detector walks the tax denorms. Runs in `deno task test` (pre-push), not the hermetic CI gate.",
  gates: true,
};

const TAX_TO_ORDERS: EnforcementRef = {
  kind: "test",
  ref:
    "api-cloudrun/tests/integration/taxes/taxes.test.ts::PUT - cascades a NAME change to incomplete orders without moving their money",
  clause:
    "the NAME change and the fail-closed arm — the rename reaches an incomplete order's PriceModifiers and the recompute leaves the money exactly where it was, and the sibling step `PUT - cascade rejects an order that violates the item invariants` asserts the cascade REFUSES an order it would leave violating the item invariants rather than writing it. ⚠️ **No test covers a RATE change reaching an order, and none can: `PUT /taxes/{uid}` REFUSES an in-place rate or type change with a 400 naming supersede** (`PUT - REFUSES an in-place rate or type change, pointing at supersede`). This rule's own invariant and trigger still describe that refused edit — see core#55.",
  gates: true,
};

const updateTaxRules: CollectionRule[] = [
  {
    id: "update-tax:to-products",
    source: "taxes",
    target: "products",
    mode: "fan-out",
    invariant:
      "Products embed tax name/rate/type in price.taxes — must stay current",
    enforced_by: [TAX_TO_PRODUCTS],
    trigger:
      "name, rate, or type change — post-transaction batch matched by tax uid",
    fields: [
      { source: ["name"], target: ["price", "taxes", "name"] },
      { source: ["rate"], target: ["price", "taxes", "rate"] },
      { source: ["type"], target: ["price", "taxes", "type"] },
      { source: ["name"], target: ["components", "price", "taxes", "name"] },
      { source: ["rate"], target: ["components", "price", "taxes", "rate"] },
      { source: ["type"], target: ["components", "price", "taxes", "type"] },
    ],
  },
  {
    id: "update-tax:to-webshop-products",
    source: "taxes",
    target: "webshop-products",
    mode: "fan-out",
    invariant:
      "Webshop products embed tax name/rate/type in price.taxes — must stay current",
    trigger:
      "name, rate, or type change — post-transaction batch matched by tax uid",
    fields: [
      { source: ["name"], target: ["price", "taxes", "name"] },
      { source: ["rate"], target: ["price", "taxes", "rate"] },
      { source: ["type"], target: ["price", "taxes", "type"] },
      { source: ["name"], target: ["components", "price", "taxes", "name"] },
      { source: ["rate"], target: ["components", "price", "taxes", "rate"] },
      { source: ["type"], target: ["components", "price", "taxes", "type"] },
    ],
  },
  {
    id: "update-tax:to-orders",
    source: "taxes",
    target: "orders",
    mode: "fan-out",
    invariant:
      "Incomplete orders embed tax data as PriceModifiers — rate changes must recompute amounts and totals",
    enforced_by: [TAX_TO_ORDERS],
    trigger:
      "name, rate, or type change — post-transaction batch filtered to incomplete orders, matched by tax uid",
    fields: [
      { source: ["name"], target: ["items", "price", "taxes", "name"] },
      { source: ["rate"], target: ["items", "price", "taxes", "rate"] },
      { source: ["type"], target: ["items", "price", "taxes", "type"] },
      {
        source: ["rate"],
        target: ["items", "price", "taxes", "amount_cents"],
        transform: "recomputed from new rate × item base_cents price",
      },
      { source: ["name"], target: ["totals", "taxes", "name"] },
      { source: ["rate"], target: ["totals", "taxes", "rate"] },
      { source: ["type"], target: ["totals", "taxes", "type"] },
      {
        source: ["rate"],
        target: ["totals", "taxes", "amount_cents"],
        transform: "recomputed from new rate × subtotal_discounted_cents",
      },
      {
        source: [],
        target: ["totals", "total_cents"],
        transform:
          "recalculated: subtotal_discounted_cents + sum(taxes.amount_cents) + sum(transaction_fees.amount_cents)",
      },
    ],
  },
];

// ── Module ──────────────────────────────────────────────────────────
/** Everything `taxes.ts` contributes to the propagation catalog. */
export const taxes: PropagationModule = {
  rules: [
    ...updateTaxRules,
  ],
  transactions: [],
};
