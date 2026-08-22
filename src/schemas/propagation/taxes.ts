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
      "NAME change — post-transaction batch matched by tax uid. ⚠️ Said \"name, rate, or type\" until 2026-08-18, which no writer could produce: `PUT /taxes/{uid}` has refused an in-place rate or type edit since api-cloudrun#495, pointing at supersede. core#55's class — one half of a rule corrected and the other left describing the refused edit. A `jurisdiction` / `item_types` edit deliberately does NOT fire it either: those axes do not price anything until #409 Phase 2 makes `findTaxFor` the pricing path.",
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
      "NAME change — post-transaction batch matched by tax uid. ⚠️ Said \"name, rate, or type\" until 2026-08-18, which no writer could produce: `PUT /taxes/{uid}` has refused an in-place rate or type edit since api-cloudrun#495, pointing at supersede. core#55's class — one half of a rule corrected and the other left describing the refused edit. A `jurisdiction` / `item_types` edit deliberately does NOT fire it either: those axes do not price anything until #409 Phase 2 makes `findTaxFor` the pricing path.",
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
      "NAME change — post-transaction batch filtered to incomplete orders, matched by tax uid. ⚠️ See the sibling rules' trigger: rate and type are unreachable here since api-cloudrun#495, which is why the `rate`-sourced field mappings below can only ever be exercised by the recompute path, never by this one. They are kept because they describe what the cascade WOULD write, and the enforcement ref says outright that no test covers a rate change and none can.",
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

// ── The supersede draft-recompute ────────────────────────────────
//
// ⚠️ **"live", not "draft".** The holiday pair next door recomputes `status ==
// "draft"` only, because a holiday moves a DATE and a quoted order's dates are
// what the customer was shown. A tax version is different: `orderTaxVersionFor`
// already declares `draft`/`quoted`/`reserved` repriceable, so all three
// re-resolve on their next write regardless. Recomputing them here changes
// WHEN, not WHETHER.
//
// ⚠️ **This REVERSES the conclusion `supersedeTax`'s own docblock reached**, and
// the reversal is narrower than it looks. That docblock argued there is nothing
// to propagate because "the order writers re-resolve by name at `asOf`, so a
// document written after `applied_from` picks up the successor on its own". Every
// word of that is true — *at the document's next write*. The gap is a draft that
// nobody touches: it keeps showing the old total until someone opens it, and if
// a customer ACCEPTS that quote, the very next write silently reprices it.
//
// Recomputing `status == "draft"` orders is not the retroactive re-pricing the
// supersede endpoint exists to avoid. Those documents are not committed to
// anyone; finalized ones stay frozen, which is the same line
// `holiday-change:recompute-draft-orders` draws for the same reason. The two
// cascades solve one problem — a change to a shared pricing input that must
// reach live drafts and must never touch history — so this copies that one in
// shape rather than inventing a second.
//
// ⚠️ **Neither rule carries a `transaction` field**, matching the holiday pair:
// they run post-commit off a coalesced Cloud Task, so they are single-rule
// cascades logged with `logPropagation`, not steps of `supersede-tax`.

const supersedeTaxDraftRecomputeRules: CollectionRule[] = [
  {
    id: "supersede-tax:recompute-live-orders",
    source: "taxes",
    target: "orders",
    mode: "fan-out",
    invariant:
      "An order that still re-resolves its tax version on write must have a new version reach its stored PriceModifiers and totals NOW rather than on whatever write happens to come next; frozen orders stay frozen, keeping what was quoted and billed",
    trigger:
      "POST /taxes/{uid}/supersede — coalesced Cloud Task over REPRICEABLE_ORDER_STATUSES (draft, quoted, reserved). ⚠️ NOT 'draft' alone, and the wider set is the point: `orderTaxVersionFor` already declares those three repriceable, so this recompute applies the rule the next ordinary write would apply anyway — it makes the repricing happen VISIBLY now instead of invisibly when a customer accepts a quote. Narrowing it to draft would be a second, disagreeing copy of the freeze rule. Recomputes UNCONDITIONALLY rather than filtering to orders that name the superseded tax: a no-op recompute writes nothing and bumps nothing, so a filter only adds a predicate that can be wrong.",
    fields: [
      {
        source: [],
        target: ["items", "price", "taxes"],
        transform:
          "re-resolve each line's tax refs at the order's asOf (resolveTaxRefsAt picks the version whose applied window contains it), then recompute item and document totals",
      },
      {
        source: [],
        target: ["totals", "taxes"],
        transform: "recomputed from the re-resolved item taxes",
      },
      {
        source: [],
        target: ["totals", "total_cents"],
        transform:
          "recalculated: subtotal_discounted_cents + sum(taxes.amount_cents) + sum(transaction_fees.amount_cents)",
      },
    ],
  },
  {
    id: "supersede-tax:recompute-live-invoices",
    source: "orders",
    target: "invoices",
    mode: "fan-out",
    invariant:
      "A recomputed order must re-sync its non-terminal invoices' tax amounts; terminal invoices (any unreversed settlement, or status in {paid, void}) stay frozen",
    trigger:
      "order recompute — transitive via `stageOrderInvoiceSync`, exactly as the holiday cascade reaches invoices. The terminal-invoice freeze is that function's own, not a second predicate here.",
    fields: [
      {
        source: ["items", "price", "taxes"],
        target: ["items", "price", "taxes"],
        transform:
          "inherited via projectOrderItemToInvoiceItem; non-terminal invoices only",
      },
    ],
  },
];

// ── Module ──────────────────────────────────────────────────────────
/** Everything `taxes.ts` contributes to the propagation catalog. */
export const taxes: PropagationModule = {
  rules: [
    ...updateTaxRules,
    ...supersedeTaxDraftRecomputeRules,
  ],
  transactions: [],
};
