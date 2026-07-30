/**
 * The order/invoice line builders — the one answer to *"given catalog product P
 * at quantity N, which line items does it produce, at what quantities?"*
 *
 * ```ts
 * import { buildOrderLineFromProduct, buildOrderComponentLines } from "@cfs/core/utils/order-lines";
 *
 * const line = buildOrderLineFromProduct(productDoc, { quantity: 2, chargeDays: 5, uidOrder });
 * const kids = buildOrderComponentLines(productDoc, { quantity: 2, chargeDays: 5, uidOrder });
 * ```
 *
 * Pure and db-free — the input is a Typesense `ProductDocument` the caller
 * already holds, and the output is a plain array. It lives here for the same
 * reason `@cfs/core/utils/availability` does: it is shared verbatim so two
 * consumers **cannot disagree**. There are three — the manager's staging
 * popover, the manager's order/invoice stores, and the public webapp's order
 * drafts — across two repos. A second copy of the component expansion is a
 * second answer to "what does this kit bring", and the drafts a customer creates
 * would then disagree with the operator's view of the same order.
 *
 * ## What these builders do NOT do: price
 *
 * The returned lines carry `subtotal`/`subtotal_discounted`/`total` of `0`, and
 * their `price.taxes` are bare `{ uid }` references copied from the catalog.
 * Run {@link https://jsr.io/@cfs/core/doc/utils/orders | calculateItemPrice}
 * against the live tax docs before persisting — that resolves each uid to
 * name/rate/type and computes the amounts. Pricing is not folded in here
 * because the custom-line builders receive the *line's* tax set rather than the
 * tax catalog `calculateItemPrice` needs, so a single signature cannot express
 * both.
 *
 * ## The catalog `path` convention is the INVERSE of the doc-item one
 *
 * A `product.components[]` row's `path` **excludes** itself and starts at the
 * root product: a direct child of product `A` has `path: ["A"]`, a grandchild
 * has `path: ["A", "child"]`. A doc-item `path` **includes** itself, so its
 * parent is `path.at(-2)`. {@link buildOrderComponentLines} is the seam where one
 * becomes the other, and it derives every doc path from the **resolved parent**
 * rather than concatenating the catalog chain — the same "one author, parent-
 * derived" rule `computeItemPaths` follows, and for the same reason: a catalog
 * row whose chain contradicts its position must not be able to write a path.
 *
 * @module
 */
import type {
  ComponentTypeType,
  DocLineItemTypeType,
  InvoiceDocLineItem,
  OrderDocLineItemType,
  PriceFormulaType,
  PriceModifierType,
  ProductTypeType,
  RateType,
  StockMethodType,
} from "../schemas/mod.ts";
import type { ProductDocument, ProductDocumentComponent } from "../schemas/typesense/mod.ts";

// ── Typesense enum narrowing ─────────────────────────────────────
//
// A Typesense document projects every enum as a bare `string`, so the three
// enum-typed fields read off a `ProductDocument` below (`type`, `stock_method`,
// `price.formula`) need narrowing. The narrowings are FIELD-LEVEL on purpose:
// each builder used to end in one `as OrderDocLineItemType`, which also absorbed
// every other field and would have swallowed any future schema drift silently.
//
// Soundness of the two `type` narrowings is asserted at compile time rather than
// asserted in prose — `PRODUCT_TYPES` and `DOC_LINE_ITEM_TYPES` are two
// hand-written lists of the same six names, and `COMPONENT_TYPES` is a subset, so
// a new product type the line vocabulary lacks becomes a compile error instead of
// a cast that quietly lies. Same pattern as `_contractParity` in
// `schemas/common.ts`; `MANUAL_MOVEMENT_TYPES` in `schemas/transaction.ts` is the
// one such list in this package WITHOUT an assertion, and core#41 is exactly the
// resulting drift. (`price.formula` has no list to compare — it is written from
// `PriceFormulaEnum` by the product writer.)
type _ProductTypesAreLineTypes = ProductTypeType extends DocLineItemTypeType ? true : never;
const _productTypeParity: _ProductTypesAreLineTypes = true;
void _productTypeParity;

type _ComponentTypesAreLineTypes = ComponentTypeType extends DocLineItemTypeType ? true : never;
const _componentTypeParity: _ComponentTypesAreLineTypes = true;
void _componentTypeParity;

/**
 * The catalog's tax references, in the shape an item price carries them BEFORE
 * pricing: bare `{ uid }`.
 *
 * `OrderDocItemPrice.taxes` declares `PriceModifierType[]` (uid + name + rate +
 * type + amount), and only `calculateItemPrice` can fill the other four in — it
 * needs the live tax docs, which a catalog row does not carry. So this one field
 * is genuinely looser than the declared type, and narrowing exactly it is the
 * honest statement of that gap.
 */
function unpricedTaxRefs(
  taxes: ReadonlyArray<{ uid?: string }> | undefined,
): PriceModifierType[] {
  return (taxes ?? [])
    .map((t) => t.uid)
    .filter((uid): uid is string => Boolean(uid))
    .map((uid) => ({ uid })) as PriceModifierType[];
}

/**
 * Shared options for building order line items from a Typesense
 * `ProductDocument` — used by the staging popover, the substitute flow, and any
 * "add product to an order" surface.
 *
 * There is deliberately no `initial` option. All three consumers used to pass
 * `getInitialValues(OrderItem)`, and the three seeds could drift; worse, the
 * spread quietly supplied fields the builder did not own — every expanded
 * component claimed `stock_method: "bulk"` regardless of the component's real
 * value, and every line carried `order_number: 0` for a number only the server
 * can allocate. Each builder now writes every field it emits.
 */
export interface OrderLineBuildOptions {
  quantity: number;
  chargeDays: number | null;
  /**
   * Component ancestors of the item being built (parent product uids only,
   * structural destination/group uids stripped). Used by the substitute flow to
   * keep a sub-component nested inside its parent kit. Defaults to `[]` for a
   * top-level addition.
   */
  inheritedAncestry?: string[];
  /**
   * Stamped as `uid_order` when present, and omitted entirely when not — the
   * invoice surfaces have no such field.
   *
   * This replaced a `provenance: { field, value }` pair whose only caller ever
   * passed `field: "uid_order"`. The generalization cost more than it bought: a
   * computed key widens the object literal, which is what forced the
   * whole-object cast this module used to end every builder with.
   */
  uidOrder?: string;
}

/**
 * Build a top-level order line item from a `ProductDocument`.
 *
 * `path` carries the component ancestry only — the item's own uid and the
 * structural destination/group prefix are appended by `computeItemPaths`, which
 * is the sole author of a stored `path`.
 */
export function buildOrderLineFromProduct(
  doc: ProductDocument,
  opts: OrderLineBuildOptions,
): OrderDocLineItemType {
  const type = doc.type as DocLineItemTypeType;
  const isRental = type === "rental";
  return {
    uid: doc.uid,
    type,
    name: doc.name,
    description: doc.description || "",
    quantity: opts.quantity,
    stock_method: doc.stock_method as StockMethodType,
    crms_id: doc.crms_id ?? null,
    ...(opts.uidOrder ? { uid_order: opts.uidOrder } : {}),
    path: [...(opts.inheritedAncestry ?? [])],
    // A top-level line is not a component of anything, and the server writes
    // both as an explicit `null` — so the optimistic row matches the echo.
    inclusion_type: null,
    zero_priced: null,
    price: {
      base: doc.price?.base ?? 0,
      replacement: doc.price?.replacement ?? null,
      chargeable_days: isRental ? opts.chargeDays : null,
      formula: (doc.price?.formula as PriceFormulaType | undefined) ?? "five_day_week",
      discount: null,
      subtotal: 0,
      subtotal_discounted: 0,
      taxes: unpricedTaxRefs(doc.price?.taxes),
      total: 0,
    },
  };
}

/**
 * Options for a one-off "custom" line with no product catalog entry behind it —
 * the orders/invoices "Add Custom Item" flow.
 *
 * `taxes` is the line's own resolved tax set (already carrying name/rate/type),
 * not the tax catalog: a custom line has no product to read tax references off,
 * so the caller resolves them.
 */
export interface CustomLineBuildOptions {
  type: DocLineItemTypeType;
  name?: string;
  quantity?: number;
  base?: number;
  formula?: PriceFormulaType;
  chargeDays: number | null;
  taxes: ReadonlyArray<{ uid: string; name: string; rate: number; type: RateType }>;
  /** @see {@link OrderLineBuildOptions.uidOrder} */
  uidOrder?: string;
}

/**
 * Build a custom (no-product) order line item.
 *
 * Stamps the `"custom-"` uid prefix, which is part of the data contract rather
 * than a UI hint: api-cloudrun's `buildOrderLineItem` branches on it to skip the
 * product lookup and accept the line's own payload.
 */
export function buildCustomOrderLine(opts: CustomLineBuildOptions): OrderDocLineItemType {
  const isRental = opts.type === "rental";
  return {
    uid: "custom-" + crypto.randomUUID(),
    name: opts.name ?? "Custom Item",
    description: "",
    type: opts.type,
    quantity: opts.quantity ?? 1,
    stock_method: "none",
    crms_id: null,
    ...(opts.uidOrder ? { uid_order: opts.uidOrder } : {}),
    path: [],
    inclusion_type: null,
    zero_priced: null,
    price: {
      base: opts.base ?? 0,
      replacement: isRental ? 0 : null,
      chargeable_days: isRental ? opts.chargeDays : null,
      formula: opts.formula ?? (isRental ? "five_day_week" : "fixed"),
      discount: null,
      subtotal: 0,
      subtotal_discounted: 0,
      // Already complete `PriceModifier`s — the caller resolved them — so unlike
      // the catalog path these need no narrowing.
      taxes: opts.taxes.map((t) => ({ ...t, amount: 0 })),
      total: 0,
    },
  };
}

/**
 * Build a custom (no-product) invoice line item.
 *
 * An invoice line is a strictly smaller shape than an order line: no
 * `stock_method`, no `crms_id`, no `uid_order`, no `inclusion_type`/
 * `zero_priced`, and no `price.replacement` — an invoice does not track
 * replacement value. This used to claim it "strips order-only fields" while the
 * `initial` spread put `stock_method: "bulk"`, `order_number: 0` and
 * `uid_order: ""` straight back in; constructing the object outright is what
 * makes the docblock true.
 */
export function buildCustomInvoiceLine(
  opts: Omit<CustomLineBuildOptions, "uidOrder">,
): InvoiceDocLineItem {
  const isRental = opts.type === "rental";
  return {
    uid: "custom-" + crypto.randomUUID(),
    name: opts.name ?? "Custom Item",
    description: "",
    type: opts.type,
    quantity: opts.quantity ?? 1,
    path: [],
    price: {
      base: opts.base ?? 0,
      chargeable_days: isRental ? opts.chargeDays : null,
      formula: opts.formula ?? (isRental ? "five_day_week" : "fixed"),
      discount: null,
      subtotal: 0,
      subtotal_discounted: 0,
      taxes: opts.taxes.map((t) => ({ ...t, amount: 0 })),
      total: 0,
    },
  };
}

/**
 * A component row's direct parent, as a uid.
 *
 * `path.length <= 1` means a direct child of the root product, so the parent IS
 * the root — matching api-cloudrun's own definition
 * (`directComponents = components.filter((c) => c.path.length === 1)`). Reading
 * `path.at(-1)` for that case instead assumes `path[0]` is the root, and one
 * live prod row breaks that assumption: product `F4uPA273BUHa0Qf5ZLVr` carries a
 * **mandatory** component whose `path` is its own uid, so it bucketed under
 * itself, `emit` never reached it, and 206 order lines for that product shipped
 * without the power supply the catalog says is mandatory. The data is repaired,
 * but the two notions of "direct child" disagreeing is what let one bad row go
 * silent — so there is now one notion.
 */
function resolveParentUid(comp: ProductDocumentComponent, rootUid: string): string {
  const path = comp.path ?? [];
  return path.length <= 1 ? rootUid : path[path.length - 1]!;
}

/**
 * Build the mandatory/default sub-component lines for a parent
 * `ProductDocument`, scaling each component's quantity off the parent quantity.
 *
 * Walks the catalog tree depth-first (parent → its descendants → next sibling)
 * and stable-sorts each parent's direct-children block `zero_priced === true`
 * first. `computeItemPaths` re-linearizes downstream anyway, but emitting
 * depth-first up front keeps the array readable when inspected raw.
 *
 * Quantities recurse with a per-level effective quantity —
 * `ceil(comp.quantity × parentEffective)` — because a fractional catalog ratio
 * compounds with depth. 34 of prod's 165 component rows carry a fractional
 * quantity and 6 of those sit below a direct child, so scaling a whole subtree
 * by one root-level ratio gives a different (wrong) answer. All 34 are
 * `inclusion_type: "default"` and no fractional component is `mandatory`, so the
 * result is always a valid integer.
 *
 * **One drop IS intentional, and the distinction matters.** A `mandatory` or
 * `default` row whose parent is `optional` is NOT emitted: the walk starts at the
 * root and only descends through rows that survived the filter, so an unselected
 * parent takes its subtree with it. Prod has 3 such rows — a generator's
 * fuel-tank cap and hose under an optional extension tank, and a hand truck under
 * an optional folding chair — and staging them unasked would put a fuel-tank cap
 * on every generator order.
 *
 * **Nothing is lost, and that is a property of the data rather than a hope.**
 * `product.components[]` is a *materialized* denorm of the whole descendant tree
 * (`buildComponentEntries` prepends the new parent to every row of the child
 * product's own array), so a subtree sitting behind an optional parent is still
 * reachable — through that parent's OWN `components`. Adding "Extension Fuel
 * Tank" as its own line expands its own array, which carries the cap and hose at
 * `path: [tankUid]`. Verified end to end: all **5** prod orders containing the
 * optional tank carry **both** of its mandatory children, 0 missing. Optional
 * parents do reach orders — 72 nested prod lines across 13 distinct optional
 * pairs — so this path is exercised, not theoretical.
 *
 * So do **not** "fix" this by hoisting an unreachable row to the root. The
 * hardening in {@link resolveParentUid} is about a row whose `path` is
 * *malformed*; this is a row whose parent is *deselected*, and its subtree has
 * another way in. Pinned by a test, because the two look identical from inside
 * the walk.
 *
 * @throws Error when a component row carries no `uid` or no `type` — neither is
 *   buildable, and dropping it silently is the failure mode this module exists
 *   to prevent. Prod: 0 such rows across all 165.
 */
export function buildOrderComponentLines(
  doc: ProductDocument,
  opts: OrderLineBuildOptions,
): OrderDocLineItemType[] {
  const components = (doc.components ?? []).filter(
    (c) => c.inclusion_type === "mandatory" || c.inclusion_type === "default",
  );
  if (!components.length) return [];

  const childrenByParent = new Map<string, ProductDocumentComponent[]>();
  for (const comp of components) {
    if (!comp.uid) {
      throw new Error(`Product ${doc.uid} has a component with no uid`);
    }
    if (!comp.type) {
      throw new Error(`Product ${doc.uid} component ${comp.uid} has no type`);
    }
    const parentUid = resolveParentUid(comp, doc.uid);
    let bucket = childrenByParent.get(parentUid);
    if (!bucket) {
      bucket = [];
      childrenByParent.set(parentUid, bucket);
    }
    bucket.push(comp);
  }
  // Zero-priced first, within each parent's direct-children block. Stable, so
  // position across blocks is preserved — the same rule
  // `sortComponentsZeroPricedFirst` applies to the catalog array itself.
  for (const bucket of childrenByParent.values()) {
    bucket.sort((a, b) => (a.zero_priced === true ? 0 : 1) - (b.zero_priced === true ? 0 : 1));
  }

  const items: OrderDocLineItemType[] = [];

  /**
   * @param parentUid the catalog uid whose children to emit
   * @param parentEffective the parent's resolved quantity, for the ratio
   * @param parentDocPath the parent's doc-item `path` — self-inclusive, so each
   *   child's path is this plus its own uid. Threading it down is what makes the
   *   doc path parent-DERIVED rather than copied from the catalog chain.
   */
  function emit(parentUid: string, parentEffective: number, parentDocPath: string[]): void {
    const bucket = childrenByParent.get(parentUid);
    if (!bucket) return;
    for (const comp of bucket) {
      const uid = comp.uid!;
      const type = comp.type as DocLineItemTypeType;
      const isRental = type === "rental";
      const quantity = Math.ceil((comp.quantity ?? 1) * parentEffective);
      const docPath = [...parentDocPath, uid];

      items.push({
        uid,
        type,
        name: comp.name ?? "",
        description: comp.description ?? "",
        quantity,
        // Read off the component row. The `initial` spread this replaced said
        // `"bulk"` for every component regardless — so a no-stock component
        // rendered availability it does not have until the server echo landed.
        stock_method: comp.stock_method as StockMethodType,
        ...(opts.uidOrder ? { uid_order: opts.uidOrder } : {}),
        path: docPath,
        inclusion_type: comp.inclusion_type as OrderDocLineItemType["inclusion_type"],
        zero_priced: comp.zero_priced ?? null,
        price: {
          base: comp.zero_priced ? 0 : (comp.price?.base ?? 0),
          replacement: comp.price?.replacement ?? null,
          chargeable_days: isRental ? opts.chargeDays : null,
          formula: (comp.price?.formula as PriceFormulaType | undefined) ?? "five_day_week",
          discount: null,
          subtotal: 0,
          subtotal_discounted: 0,
          taxes: unpricedTaxRefs(comp.price?.taxes),
          total: 0,
        },
      });

      emit(uid, quantity, docPath);
    }
  }

  emit(doc.uid, opts.quantity, [...(opts.inheritedAncestry ?? []), doc.uid]);

  return items;
}
