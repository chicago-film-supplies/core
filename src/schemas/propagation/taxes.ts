/**
 * Tax propagation rules — the class catalog (`taxes-codes`, `taxes-rates`,
 * `taxes-classes`). Post-commit fan-outs and coalesced live-order recomputes.
 */
import type {
  CollectionRule,
  PropagationModule,
  TransactionDefinition,
} from "./types.ts";

// The legacy `taxes` cascades — `update-tax:to-products`,
// `update-tax:to-webshop-products` and the `supersede-tax:recompute-live-*` pair —
// were retired with their writers at the tax-class cutover (api-cloudrun#993).
// Nothing writes `taxes` any more, so nothing could fire them.

// ── The class catalog (api-cloudrun#993) ─────────────────────────
//
// ⚠️ **None of these runs inside its route's transaction.** A class rename
// reaches every product holding the class and its webshop mirror — ~440 writes
// for "Rental" alone, against Firestore's 500-write transaction cap — so the
// fan-outs are post-commit converges and the recomputes are coalesced Cloud
// Tasks, as the retired legacy `update-tax:*` and `supersede-tax:*` rules were.
// That is why each transaction below declares `steps: []`, and why no rule
// carries a `transaction` field.
//
// ⚠️ **No rule fires on a CODE edit.** A code's `jurisdiction` and `type` are
// immutable, and its `name` is snapshotted onto a line only when the line is
// priced — so a renamed code reaches live documents on their next reprice, like
// any other catalog read, and frozen documents keep the name they were billed
// under.

const RECOMPUTE_FIELDS = [
  {
    source: [],
    target: ["items", "price", "taxes"],
    transform:
      "re-resolve every line through its class at the order's asOf (resolveClassTaxes), then recompute item and document totals",
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
];

const INVOICE_RESYNC_FIELDS = [
  {
    source: ["items", "price", "taxes"],
    target: ["items", "price", "taxes"],
    transform: "inherited via projectOrderItemToInvoiceItem; non-terminal invoices only",
  },
];

const classCatalogRules: CollectionRule[] = [
  {
    id: "create-tax-rate:recompute-live-orders",
    source: "taxes-rates",
    target: "orders",
    mode: "fan-out",
    invariant:
      "A new rate of a code must reach every order that still re-resolves its tax NOW rather than on whatever write happens to come next; frozen orders keep the rate they were quoted and billed at. The successor of the retired `supersede-tax:recompute-live-orders`.",
    trigger:
      "POST /taxes-codes/{uid}/rates — coalesced Cloud Task over REPRICEABLE_ORDER_STATUSES (draft, quoted, reserved), unconditionally: a no-op recompute writes nothing. ⚠️ It lands whatever drift was ALREADY pending on every live order, not only those resolving this code — measure that before adding a rate.",
    fields: RECOMPUTE_FIELDS,
  },
  {
    id: "create-tax-rate:recompute-live-invoices",
    source: "orders",
    target: "invoices",
    mode: "fan-out",
    invariant:
      "A recomputed order must re-sync its non-terminal invoices' tax amounts; terminal invoices stay frozen",
    trigger: "order recompute — transitive via `stageOrderInvoiceSync`; the terminal-invoice freeze is that function's own",
    fields: INVOICE_RESYNC_FIELDS,
  },
  {
    id: "update-tax-class:name-to-products",
    source: "taxes-classes",
    target: "products",
    mode: "fan-out",
    invariant:
      "`product.tax_class_name` is a DENORM of its class's name, kept beside the `uid_tax_class` REF so a rename can find its population",
    trigger:
      "PUT /taxes-classes/{uid} with a name change — post-commit converge over `where(uid_tax_class == uid)`. Until it runs, a stale name also heals on the product's next write.",
    fields: [{ source: ["name"], target: ["tax_class_name"] }],
  },
  {
    id: "update-tax-class:name-to-webshop-products",
    source: "taxes-classes",
    target: "webshop-products",
    mode: "fan-out",
    invariant: "The webshop mirror carries the same `tax_class_name` denorm as its product",
    trigger: "PUT /taxes-classes/{uid} with a name change — the same converge, over the mirror collection",
    fields: [{ source: ["name"], target: ["tax_class_name"] }],
  },
  {
    id: "update-tax-class:codes-recompute-live-orders",
    source: "taxes-classes",
    target: "orders",
    mode: "fan-out",
    invariant:
      "A class's code membership decides what every line of that class is taxed, so a membership change must reprice live orders; settled documents never move",
    trigger:
      "PUT /taxes-classes/{uid} with a `uid_tax_codes` change — the same coalesced recompute as a new rate, over REPRICEABLE_ORDER_STATUSES",
    fields: RECOMPUTE_FIELDS,
  },
  {
    id: "update-tax-class:codes-recompute-live-invoices",
    source: "orders",
    target: "invoices",
    mode: "fan-out",
    invariant: "A recomputed order must re-sync its non-terminal invoices' tax amounts; terminal invoices stay frozen",
    trigger: "order recompute — transitive via `stageOrderInvoiceSync`",
    fields: INVOICE_RESYNC_FIELDS,
  },
  {
    id: "update-product:tax-class-to-live-orders",
    source: "products",
    target: "orders",
    mode: "fan-out",
    invariant:
      "A line snapshots its product's class, so re-classing a product must reach the lines of live orders that have NOT overridden it, and reprice them; an override is the operator's statement and is never clobbered, and frozen orders keep their snapshot",
    trigger:
      "a product write that moves `uid_tax_class` — post-commit, over REPRICEABLE_ORDER_STATUSES orders carrying the product",
    fields: [
      {
        source: ["uid_tax_class"],
        target: ["items", "uid_tax_class"],
        transform: "only on lines whose uid_tax_class_override is null",
      },
      ...RECOMPUTE_FIELDS.slice(0, 1),
    ],
  },
];

const classCatalogTransactions: TransactionDefinition[] = [
  {
    id: "create-tax-code",
    description:
      "Creates a tax code (the identity of one tax) together with its first rate. Propagates nothing: no class lists a new code yet.",
    steps: [],
  },
  {
    id: "update-tax-code",
    description:
      "Renames, re-binds the Xero posting of, or deactivates a tax code. `jurisdiction` and `type` are refused. Propagates nothing in-transaction; a new name reaches live lines on their next reprice.",
    steps: [],
  },
  {
    id: "create-tax-rate",
    description:
      "Adds a dated rate to a code and closes the incumbent's window in the same transaction, refused on any `validateTaxSetup` violation. The live-order recompute runs post-commit (`create-tax-rate:recompute-live-orders`).",
    steps: [],
  },
  {
    id: "update-tax-rate",
    description:
      "Renews a rate's review window (`applied_to`) or records its `effective_from`. The rate itself is refused — a new value is a new rate.",
    steps: [],
  },
  {
    id: "create-tax-class",
    description:
      "Creates a tax class, refused on any `validateTaxSetup` violation. Propagates nothing: no product holds it yet.",
    steps: [],
  },
  {
    id: "update-tax-class",
    description:
      "Renames, re-memberships, re-defaults or deactivates a tax class, refused on any `validateTaxSetup` violation. The name denorm and the live-order recompute both run post-commit (`update-tax-class:*`).",
    steps: [],
  },
];

// ── Module ──────────────────────────────────────────────────────────
/** Everything `propagation/taxes.ts` contributes to the propagation catalog. */
export const taxes: PropagationModule = {
  rules: [
    ...classCatalogRules,
  ],
  transactions: classCatalogTransactions,
};
