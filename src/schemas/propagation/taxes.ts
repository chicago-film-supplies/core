/**
 * Tax propagation rules — update-tax cascades.
 *
 * Post-transaction fan-out: when a tax's name, rate, or type changes,
 * the denormalized TaxRef / PriceModifier snapshots on products,
 * webshop-products, and incomplete orders are updated.
 */
import type { CollectionRule } from "./types.ts";

export const updateTaxRules: CollectionRule[] = [
  {
    id: "update-tax:to-products",
    source: "taxes",
    target: "products",
    mode: "fan-out",
    invariant: "Products embed tax name/rate/type in price.taxes — must stay current",
    trigger: "name, rate, or type change — post-transaction batch matched by tax uid",
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
    invariant: "Webshop products embed tax name/rate/type in price.taxes — must stay current",
    trigger: "name, rate, or type change — post-transaction batch matched by tax uid",
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
    invariant: "Incomplete orders embed tax data as PriceModifiers — rate changes must recompute amounts and totals",
    trigger: "name, rate, or type change — post-transaction batch filtered to incomplete orders, matched by tax uid",
    fields: [
      { source: ["name"], target: ["items", "price", "taxes", "name"] },
      { source: ["rate"], target: ["items", "price", "taxes", "rate"] },
      { source: ["type"], target: ["items", "price", "taxes", "type"] },
      { source: ["rate"], target: ["items", "price", "taxes", "amount"], transform: "recomputed from new rate × item base price" },
      { source: ["name"], target: ["totals", "taxes", "name"] },
      { source: ["rate"], target: ["totals", "taxes", "rate"] },
      { source: ["type"], target: ["totals", "taxes", "type"] },
      { source: ["rate"], target: ["totals", "taxes", "amount"], transform: "recomputed from new rate × subtotal_discounted" },
      { source: [], target: ["totals", "total"], transform: "recalculated: subtotal_discounted + sum(taxes.amount) + sum(transaction_fees.amount)" },
    ],
  },
];
