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
 * reason `@cfs/core/utils/stock` does: it is shared verbatim so two
 * consumers **cannot disagree**. There are three — the manager's staging
 * popover, the manager's order/invoice stores, and the public webapp's order
 * drafts — across two repos. A second copy of the component expansion is a
 * second answer to "what does this kit bring", and the drafts a customer creates
 * would then disagree with the operator's view of the same order.
 *
 * ## What these builders do NOT do: price
 *
 * The returned lines carry `subtotal`/`subtotal_discounted`/`total` of `0`, and
 * an empty `price.taxes`: tax is resolved from the line's `uid_tax_class`
 * (stamped from the hit) when the document is priced — `priceDocument` — never
 * copied from the catalog (api-cloudrun#993). Pricing is not folded in here
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
  InvoiceDocLineItemType,
  OrderDocLineItemType,
  PriceFormulaType,
  ProductTypeType,
  RateType,
  StockMethodType,
} from "../schemas/mod.ts";
import type { ProductDocument, ProductDocumentComponent } from "../schemas/typesense/mod.ts";
import { isDividerItemType } from "../schemas/mod.ts";
import { getItemSubtreeRange } from "./orders.ts";

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
// a cast that quietly lies. Same pattern as `_itemTypeParity` / `_lineParity` in
// `schemas/common.ts`. The load-bearing condition is that the two sides are
// declared independently: a `T extends keyof typeof TABLE` guard over a table
// already annotated `Record<T, …>` reads `T extends T` and cannot fail, which is
// why three of those were deleted rather than kept as reassurance.
// (`price.formula` has no list to compare — it is written from
// `PriceFormulaEnum` by the product writer.)
type _ProductTypesAreLineTypes = ProductTypeType extends DocLineItemTypeType ? true : never;
const _productTypeParity: _ProductTypesAreLineTypes = true;
void _productTypeParity;

type _ComponentTypesAreLineTypes = ComponentTypeType extends DocLineItemTypeType ? true : never;
const _componentTypeParity: _ComponentTypesAreLineTypes = true;
void _componentTypeParity;

// ── A line's catalog facts: ONE author (api-cloudrun#1286) ───────

/**
 * The catalog fields a line's facts are read from — satisfied by a Firestore
 * `Product`, a Typesense `ProductDocument`, and a `components[]` row of either
 * (which mirrors its component product's price).
 */
export interface CatalogLineSource {
  readonly type?: string;
  readonly stock_method?: string;
  readonly price?: {
    readonly base_cents?: number;
    readonly base_percent?: number | null;
    readonly replacement_cents?: number | null;
    readonly formula?: string;
  } | null;
}

/** What a parent's `components[]` row says about the SLOT a component line fills. */
export interface CatalogSlot {
  readonly zero_priced?: boolean;
  /** The per-parent ratio the slot expands at — see {@link quantityPerParentForSlot}. */
  readonly quantity?: number;
}

/**
 * Every catalog-derived fact of a product line, decided together.
 *
 * VALUES only, never a key set: each builder decides which keys it writes,
 * because a writer's price key set is a claim about the documents it already
 * stored (api-cloudrun's `linePriceKeySets`).
 */
export interface LineCatalogFacts {
  type: DocLineItemTypeType;
  stock_method: StockMethodType;
  zero_priced: boolean | null;
  price: {
    base_cents: number;
    base_percent: number | null;
    replacement_cents: number | null;
    formula: PriceFormulaType;
  };
}

/**
 * A line's `zero_priced`, from the slot it fills: `null` for a line that fills
 * no slot (top-level), else whether the parent includes it at no charge.
 *
 * ⚠️ **`=== true`, never `?? null`.** A component must state a boolean — core's
 * own `zero_priced_unstated` refuses `null` on one — and a catalog row that says
 * nothing means *billed separately*, which is how the price was always read
 * (`zero_priced ? 0 : price`). This builder used to write `?? null`, so a line
 * expanded from such a row was refused by the rule beside it
 * (api-cloudrun#1287).
 */
export function zeroPricedForSlot(slot: CatalogSlot | null): boolean | null {
  return slot === null ? null : slot.zero_priced === true;
}

/**
 * A line's `quantity_per_parent`, from the slot it fills (core#131): `null` for a
 * line that fills no slot (top-level), else the ratio the slot expands at,
 * rounded to 4 dp.
 *
 * `?? 1` because that is what {@link componentQuantities} expands a row that
 * states no quantity at, and the stamp must be the ratio the line was actually
 * built from — otherwise a freshly expanded line would read as hand-edited.
 *
 * ⭐ **A SNAPSHOT, like `zero_priced` (owner, 2026-10-12).** It is read off the
 * catalog only when a row is first built; after that the stored stamp is carried
 * by row, and a hand edit changes `quantity`, never this.
 */
export function quantityPerParentForSlot(slot: CatalogSlot | null): number | null {
  return slot === null ? null : roundRatio(slot.quantity ?? 1);
}

/** A kit ratio quantized to the 4 dp it is stored at (`AuthoredComponentSchema.quantity`). */
function roundRatio(ratio: number): number {
  return Math.round(ratio * 10_000) / 10_000;
}

/**
 * The formula a line takes when its catalog states none: the type's default.
 * Measured 2026-10-12, every prod product states one, so this is a floor and not
 * a policy.
 */
function defaultFormulaFor(type: string | undefined): PriceFormulaType {
  return type === "rental" ? "five_day_week" : "fixed";
}

/**
 * The ONE author of a product line's catalog facts — type, stock method,
 * `zero_priced` and the catalog half of the price — decided together, so no
 * writer can produce a pair this function would not (api-cloudrun#1286). The
 * failure it closes: five writers each re-derived a SUBSET (the flag without
 * the price, the price without the flag, the formula from the type), and every
 * subset could write a flag/price pair nothing else would.
 *
 * - **`zeroPriced` is an input, not derived here.** Its source differs by
 *   writer: a builder takes {@link zeroPricedForSlot} of the catalog row, while
 *   api-cloudrun's order writer carries the STORED flag by row and derives only
 *   for a new row — a SNAPSHOT (owner, 2026-10-12). Whatever it is, the price
 *   follows it here: flagged → `base_cents: 0`.
 * - **`formula` is the catalog's**, falling back to the type default only when
 *   the catalog states none. Two prod rentals are deliberately `fixed` (Combo
 *   Hangers); a type-derived formula would bill them per day.
 * - **`percent_of_total`** carries its unit in `base_percent` and must state
 *   `base_cents: 0` (`checkPriceBaseUnit`); every other formula states
 *   `base_percent: null`.
 */
export function deriveLineCatalogFacts(
  product: CatalogLineSource,
  zeroPriced: boolean | null,
): LineCatalogFacts {
  const formula = (product.price?.formula as PriceFormulaType | undefined) ?? defaultFormulaFor(product.type);
  const isPercent = formula === "percent_of_total";
  return {
    type: product.type as DocLineItemTypeType,
    stock_method: product.stock_method as StockMethodType,
    zero_priced: zeroPriced,
    price: {
      base_cents: zeroPriced === true || isPercent ? 0 : (product.price?.base_cents ?? 0),
      base_percent: isPercent ? (product.price?.base_percent ?? null) : null,
      replacement_cents: product.price?.replacement_cents ?? null,
      formula,
    },
  };
}

/**
 * The `components[]` row of `parent` that describes its DIRECT child `uid` — the
 * slot a component line of `uid` under a `parent` line fills.
 *
 * ⚠️ **Direct rows only.** `components[]` is the materialized WHOLE descendant
 * tree, so the same uid can also appear as a grandchild under another child;
 * "the first row with this uid" (the lookup this replaces) can read that row's
 * flag for the wrong slot.
 */
export function catalogSlotOf<C extends { readonly uid?: string; readonly path?: readonly string[] | null }>(
  parent: { readonly components?: readonly C[] | null } | undefined,
  uid: string,
): C | undefined {
  return parent?.components?.find((c) => c.uid === uid && isDirectComponent(c));
}

/**
 * The catalog row of `product` for component `uid` sitting under `ancestors`
 * (the component uids strictly between `product` and it, outermost first) —
 * resolved BY PATH.
 *
 * ⚠️ **Not "the first row with this uid"** (the lookup this replaces,
 * api-cloudrun#1287). A kit may list one product under two parents, charged
 * under one and included free under the other, and a uid-only match hands the
 * second slot the first slot's flag. A catalog path EXCLUDES self and starts at
 * the root, so the row at `[product, ...ancestors]` is the one; a direct child
 * is matched through {@link isDirectComponent}, which also covers the one
 * malformed direct-child shape {@link resolveParentUid} hardens against.
 */
export function catalogComponentAt<C extends { readonly uid?: string; readonly path?: readonly string[] | null }>(
  product: { readonly uid: string; readonly components?: readonly C[] | null },
  ancestors: readonly string[],
  uid: string,
): C | undefined {
  if (ancestors.length === 0) return catalogSlotOf(product, uid);
  const want = [product.uid, ...ancestors];
  return product.components?.find((c) => {
    const path = c.path ?? [];
    return c.uid === uid && path.length === want.length && path.every((seg, i) => seg === want[i]);
  });
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
  /**
   * The class a line whose product carries no `uid_tax_class` is stamped with —
   * the active class defaulting its `type`, the same fallback the API's
   * `stampLineTaxClasses` takes. A search hit or component row indexed before
   * the field existed has no class of its own, and a stored line must carry one
   * (api-cloudrun#993). `validateTaxSetup`'s `missing_type_default` keeps every
   * type resolvable; a caller whose catalog cannot resolve one should throw
   * rather than invent a class.
   */
  taxClassForType: (type: DocLineItemTypeType) => string;
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
  // A top-level line fills no slot, so its flag is `null` and its price is the
  // catalog's — see `deriveLineCatalogFacts`.
  const facts = deriveLineCatalogFacts(doc, zeroPricedForSlot(null));
  const type = facts.type;
  const isRental = type === "rental";
  return {
    uid: doc.uid,
    type,
    name: doc.name,
    description: doc.description || "",
    quantity: opts.quantity,
    stock_method: facts.stock_method,
    crms_id: doc.crms_id ?? null,
    ...(opts.uidOrder ? { uid_order: opts.uidOrder } : {}),
    path: [...(opts.inheritedAncestry ?? [])],
    // A top-level line is not a component of anything, and the server writes
    // both as an explicit `null` — so the optimistic row matches the echo.
    inclusion_type: null,
    zero_priced: facts.zero_priced,
    quantity_per_parent: quantityPerParentForSlot(null),
    // The class the product is taxed as, so the optimistic reprice resolves
    // what the server will stamp; a hit indexed before the field takes its
    // type's default, which is the server's fallback too.
    uid_tax_class: doc.uid_tax_class || opts.taxClassForType(type),
    price: {
      base_cents: facts.price.base_cents,
      base_percent: facts.price.base_percent,
      replacement_cents: facts.price.replacement_cents,
      chargeable_days: isRental ? opts.chargeDays : null,
      formula: facts.price.formula,
      discount: null,
      subtotal_cents: 0,
      subtotal_discounted_cents: 0,
      // Empty: the line's tax is its class's, resolved at pricing (api-cloudrun#993).
      taxes: [],
      total_cents: 0,
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
  base_cents?: number;
  formula?: PriceFormulaType;
  chargeDays: number | null;
  taxes: ReadonlyArray<{ uid: string; name: string; rate: number; type: RateType }>;
  /**
   * The line's tax class. A custom line has no product to snapshot one from, so
   * the caller passes the class it will be taxed as — the type's default unless
   * the operator picked another (api-cloudrun#993).
   */
  uid_tax_class: string;
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
    quantity_per_parent: null,
    uid_tax_class: opts.uid_tax_class,
    price: {
      base_cents: opts.base_cents ?? 0,
      replacement_cents: isRental ? 0 : null,
      chargeable_days: isRental ? opts.chargeDays : null,
      formula: opts.formula ?? (isRental ? "five_day_week" : "fixed"),
      discount: null,
      subtotal_cents: 0,
      subtotal_discounted_cents: 0,
      // Already complete `PriceModifier`s — the caller resolved them — so unlike
      // the catalog path these need no narrowing.
      taxes: opts.taxes.map((t) => ({ ...t, amount_cents: 0 })),
      total_cents: 0,
    },
  };
}

/**
 * Build a custom (no-product) invoice line item.
 *
 * An invoice line is a strictly smaller shape than an order line: no
 * `stock_method`, no `crms_id`, no `uid_order`, no `inclusion_type`, and no
 * `price.replacement_cents` — an invoice does not track replacement value. It DOES
 * carry `zero_priced` (stated `null`: a custom line is never a kit component), since
 * the key is required on every stored line. This used to claim it "strips order-only fields" while the
 * `initial` spread put `stock_method: "bulk"`, `order_number: 0` and
 * `uid_order: ""` straight back in; constructing the object outright is what
 * makes the docblock true.
 */
export function buildCustomInvoiceLine(
  opts: Omit<CustomLineBuildOptions, "uidOrder">,
): InvoiceDocLineItemType {
  const isRental = opts.type === "rental";
  return {
    uid: "custom-" + crypto.randomUUID(),
    name: opts.name ?? "Custom Item",
    description: "",
    type: opts.type,
    quantity: opts.quantity ?? 1,
    path: [],
    zero_priced: null,
    uid_tax_class: opts.uid_tax_class,
    price: {
      base_cents: opts.base_cents ?? 0,
      chargeable_days: isRental ? opts.chargeDays : null,
      formula: opts.formula ?? (isRental ? "five_day_week" : "fixed"),
      discount: null,
      subtotal_cents: 0,
      subtotal_discounted_cents: 0,
      taxes: opts.taxes.map((t) => ({ ...t, amount_cents: 0 })),
      total_cents: 0,
    },
  };
}

/**
 * A custom line's price after its TYPE changes — the one rule both manager
 * stores' `setItemType` apply (api-cloudrun#1286). They used to disagree:
 * retyping rental → sale, the order store nulled `replacement_cents` and the
 * invoice store kept it.
 *
 * The formula and `chargeable_days` follow the new type, exactly as
 * {@link buildCustomOrderLine} defaults them. `replacement_cents` is restated
 * ONLY where the key is present (an invoice line has none; a writer's key set
 * is a claim about its stored lines): `0` for a rental, `null` otherwise.
 * `taxes` is cleared — the reprice re-derives them from the line's class.
 *
 * `chargeDays` is the caller's: an order passes its destination's charged days,
 * an invoice `null` (its operator fills the Duration cell).
 */
export function retypedLinePrice<
  P extends { formula: PriceFormulaType; chargeable_days?: number | null; replacement_cents?: number | null; taxes: unknown[] },
>(price: P, type: DocLineItemTypeType, chargeDays: number | null): P {
  const isRental = type === "rental";
  return {
    ...price,
    formula: isRental ? "five_day_week" : "fixed",
    chargeable_days: isRental ? chargeDays : null,
    ...("replacement_cents" in price ? { replacement_cents: isRental ? 0 : null } : {}),
    taxes: [],
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
  return isDirectComponent(comp) ? rootUid : path[path.length - 1]!;
}

/**
 * Is this catalog `components[]` row a DIRECT child of the product that carries
 * the array? The one definition of "direct child" (manager#639 item 3), shared
 * by {@link resolveParentUid}, the manager's relationship table and api-cloudrun's
 * component services.
 *
 * `path.length <= 1`, not `=== 1`: the `<=` is what the
 * {@link resolveParentUid} hardening above depends on, and a row with no path at
 * all has no other parent to name.
 */
export function isDirectComponent(comp: { readonly path?: readonly string[] | null }): boolean {
  return (comp.path ?? []).length <= 1;
}

/**
 * The fields of a catalog component row the quantity walk reads — satisfied by
 * both the Firestore `ProductComponent` and the Typesense
 * `ProductDocumentComponent`.
 */
export interface ComponentRowForWalk {
  uid?: string;
  type?: string;
  path?: string[];
  quantity?: number;
  inclusion_type?: string;
  zero_priced?: boolean;
}

/** One component the walk reached: the row, its resolved quantity, and its self-inclusive doc path. */
export interface ComponentQuantity<C extends ComponentRowForWalk> {
  component: C;
  quantity: number;
  /** `[...rootDocPath, ...ancestors, uid]` — derived from the resolved parent, never copied from the catalog chain. */
  path: string[];
}

/**
 * Which `mandatory`/`default` components a product at `quantity` carries, and
 * how many of each — the ONE quantity rule, shared by the order-line expander
 * ({@link buildOrderComponentLines}) and the manager's component fan-out on a
 * movement (api-cloudrun#388, manager#271), so an order line and a movement
 * proposal never disagree about how many sides come with three tents.
 *
 * Depth-first, each parent's direct children `zero_priced` first; quantities
 * recurse per level as {@link componentQuantityAt}`(comp.quantity, parentEffective)` (owner,
 * 2026-10-09: a movement proposal rounds up like an order line, and the
 * operator edits it). An `optional` row is not walked, and neither is its
 * subtree — see {@link buildOrderComponentLines} for why that drop is right.
 *
 * @throws Error when a reached component row carries no `uid` or no `type`.
 */
export function componentQuantities<C extends ComponentRowForWalk>(
  rootUid: string,
  components: readonly C[],
  quantity: number,
  rootDocPath: readonly string[] = [rootUid],
): ComponentQuantity<C>[] {
  const included = components.filter((c) => c.inclusion_type === "mandatory" || c.inclusion_type === "default");
  if (!included.length) return [];

  const childrenByParent = new Map<string, C[]>();
  for (const comp of included) {
    if (!comp.uid) throw new Error(`Product ${rootUid} has a component with no uid`);
    if (!comp.type) throw new Error(`Product ${rootUid} component ${comp.uid} has no type`);
    const parentUid = resolveParentUid(comp, rootUid);
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

  const out: ComponentQuantity<C>[] = [];
  const emit = (parentUid: string, parentEffective: number, parentDocPath: string[]): void => {
    for (const comp of childrenByParent.get(parentUid) ?? []) {
      const qty = componentQuantityAt(comp.quantity ?? 1, parentEffective);
      const path = [...parentDocPath, comp.uid!];
      out.push({ component: comp, quantity: qty, path });
      emit(comp.uid!, qty, path);
    }
  };
  emit(rootUid, quantity, [...rootDocPath]);
  return out;
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
  return componentQuantities(
    doc.uid,
    doc.components ?? [],
    opts.quantity,
    [...(opts.inheritedAncestry ?? []), doc.uid],
  ).map(({ component: comp, quantity, path }) => {
    // The row is both the slot (its `zero_priced`) and the product (it mirrors
    // the component product's type, stock method and price).
    const facts = deriveLineCatalogFacts(comp, zeroPricedForSlot(comp));
    const type = facts.type;
    return {
      uid: comp.uid!,
      type,
      name: comp.name ?? "",
      description: comp.description ?? "",
      quantity,
      // Read off the component row. The `initial` spread this replaced said
      // `"bulk"` for every component regardless — so a no-stock component
      // rendered availability it does not have until the server echo landed.
      stock_method: facts.stock_method,
      ...(opts.uidOrder ? { uid_order: opts.uidOrder } : {}),
      path,
      inclusion_type: comp.inclusion_type as OrderDocLineItemType["inclusion_type"],
      zero_priced: facts.zero_priced,
      // The ratio this line was just expanded at, relative to its DIRECT parent
      // — `componentQuantityAt(quantity_per_parent, parent.quantity)` reproduces
      // `quantity` until someone edits it (core#131).
      quantity_per_parent: quantityPerParentForSlot(comp),
      uid_tax_class: comp.uid_tax_class || opts.taxClassForType(type),
      price: {
        // No `base_percent` key: a component line never wrote one, and a
        // writer's key set is a claim about its stored lines.
        base_cents: facts.price.base_cents,
        replacement_cents: facts.price.replacement_cents,
        chargeable_days: type === "rental" ? opts.chargeDays : null,
        formula: facts.price.formula,
        discount: null,
        subtotal_cents: 0,
        subtotal_discounted_cents: 0,
        taxes: [],
        total_cents: 0,
      },
    };
  });
}

// ── Kit ratios: expand, rescale, cut (core#131) ──────────────────

/** Fixed-point scale of a kit ratio — 4 dp, the bound `AuthoredComponentSchema.quantity` enforces. */
const RATIO_SCALE = 10_000n;

/**
 * How many of a component go with `parentQty` of its DIRECT parent:
 * `ceil(ratio × parentQty)`, exactly.
 *
 * The ONE quantity rule — {@link componentQuantities} expands through it, a kit
 * rescale reads it, and a stamped line's override is read off the document as
 * `quantity !== componentQuantityAt(quantity_per_parent, parent.quantity)`.
 *
 * ⚠️ **Integer arithmetic at a 1e4 scale, not `Math.ceil(ratio × parentQty)`.**
 * The float product of a 4 dp ratio and an integer lands a hair ABOVE the
 * integer it should equal often enough to matter — `0.07 × 100` is
 * `7.000000000000001`, so the float form ceils it to 8. The ratio is quantized
 * once to 4 dp (where it is stored), and nothing after that rounds until the
 * single ceil — the closure rule `cfs-money` states for money, applied to a
 * count.
 *
 * @throws RangeError when `ratio` is negative or not finite, or `parentQty` is
 *   not a non-negative integer — neither has a meaning a count can take.
 */
export function componentQuantityAt(ratio: number, parentQty: number): number {
  if (!Number.isFinite(ratio) || ratio < 0) throw new RangeError(`kit ratio must be a finite number ≥ 0, got ${ratio}`);
  if (!Number.isInteger(parentQty) || parentQty < 0) {
    throw new RangeError(`parent quantity must be an integer ≥ 0, got ${parentQty}`);
  }
  const num = BigInt(Math.round(ratio * Number(RATIO_SCALE))) * BigInt(parentQty);
  return Number((num + RATIO_SCALE - 1n) / RATIO_SCALE);
}

/** `ceil(num / den)` over non-negative bigints. */
function ceilDiv(num: bigint, den: bigint): bigint {
  return (num + den - 1n) / den;
}

/** The fields of a document line a kit cut or rescale reads — every grain's item satisfies it. */
export interface KitLineLike {
  readonly uid: string;
  readonly type: string;
  readonly path: string[];
  readonly quantity?: number | null;
  readonly quantity_per_parent?: number | null;
}

/**
 * How many units of each line move when the kit at `items[kitIndex]` is cut to
 * `k` of its `n` (= `quantity`) — the fulfillment "move 2 of 5 kits" split.
 * Returns a map from item INDEX to moved count, for the kit and every line of its
 * subtree (`getItemSubtreeRange`), and never null. The kit itself moves `k`.
 *
 * Per level, each line's parent moved `k'` of its `n'`:
 *
 * - **Parent moved in full (`k' === n'`)** → the line moves its whole `quantity`.
 *   Without this a hand-edited line above its ratio would leave units behind.
 * - **The line still matches its stamp** (`quantity ===
 *   componentQuantityAt(r, n')`) → `min(quantity, componentQuantityAt(r, k'))`.
 *   A shared container goes with the FIRST move, so the remainder may be short a
 *   case; that is expected — the operator adds one (owner, 2026-10-10). The
 *   splitter does not try to keep both sides whole.
 * - **Anything else moves proportionally**, `ceil(quantity × k' ÷ n')` — one rule
 *   for a hand edit, a re-parented line, a line built under an older catalog, a
 *   raised optional (`r = 0`) and a pre-stamp line (`r` null or absent) (owner,
 *   2026-10-11).
 *
 * A sub-kit's own moved count is its children's `k'`, so the rule cascades. The
 * cap at what a component's BOOKING can actually move stays with the caller —
 * this answers for the document, not for custody.
 *
 * @throws RangeError when `items[kitIndex]` is a divider, or `k` is not an
 *   integer in `[0, n]`.
 * @throws Error when a subtree line's parent row is missing — a path
 *   `computeItemPaths` could not have written.
 */
export function kitCutQuantities<T extends KitLineLike>(items: T[], kitIndex: number, k: number): Map<number, number> {
  const kit = items[kitIndex];
  if (!kit || isDividerItemType(kit.type)) throw new RangeError(`items[${kitIndex}] is not a line item`);
  const n = kit.quantity ?? 0;
  if (!Number.isInteger(k) || k < 0 || k > n) throw new RangeError(`cut must be an integer in [0, ${n}], got ${k}`);

  const out = new Map<number, number>();
  // Keyed by the row's own path: a parent ROW is the one whose path is the
  // child's minus self (cfs-items), never "a row with the parent's uid".
  const byPath = new Map<string, { n: number; moved: number }>();
  const { startIndex, endIndex } = getItemSubtreeRange(items, kitIndex);
  for (let i = startIndex; i <= endIndex; i++) {
    const item = items[i];
    const q = item.quantity ?? 0;
    let moved: number;
    if (i === kitIndex) {
      moved = k;
    } else {
      const parent = byPath.get(item.path.slice(0, -1).join("\u0000"));
      if (!parent) throw new Error(`items[${i}] (${item.uid}) has no parent row inside the kit's subtree`);
      const r = item.quantity_per_parent;
      if (parent.moved === parent.n) {
        moved = q;
      } else if (r != null && q === componentQuantityAt(r, parent.n)) {
        moved = Math.min(q, componentQuantityAt(r, parent.moved));
      } else {
        moved = Number(ceilDiv(BigInt(q) * BigInt(parent.moved), BigInt(parent.n)));
      }
    }
    byPath.set(item.path.join("\u0000"), { n: q, moved });
    out.set(i, moved);
  }
  return out;
}

/** The fields read off a catalog `components[]` row by {@link rescaleKitSubtree} — shared by `Product` and the Typesense `ProductDocument`. */
export interface CatalogComponentLike {
  readonly uid?: string;
  readonly path?: readonly string[] | null;
  readonly quantity?: number | null;
}

/**
 * The index in `items[index].path` of the outermost line-item ancestor — the
 * top-level kit product whose catalog describes the whole subtree. Every segment
 * before it is a divider (order / destination / group). Returns -1 when the path
 * holds no line segment, which a well-formed line cannot.
 */
export function kitRootPos<T extends KitLineLike>(items: readonly T[], index: number): number {
  const dividers = new Set(items.filter((i) => isDividerItemType(i.type)).map((i) => i.uid));
  return (items[index]?.path ?? []).findIndex((seg) => !dividers.has(seg));
}

/** A catalog row's chain from the root product to itself (the catalog `path` excludes self). */
function catalogChain(comp: CatalogComponentLike, rootUid: string): string[] {
  return isDirectComponent(comp) ? [rootUid, comp.uid ?? ""] : [...(comp.path ?? []), comp.uid ?? ""];
}

/**
 * Set `items[index]` to `newQty` and rescale its component subtree per level —
 * the one answer shared by merge-on-add and a direct quantity edit on the order,
 * invoice and fulfillment items tables (moved from the manager, manager#639 item 4).
 * Returns a new array; nothing is mutated. Sets quantity only — pricing is the
 * caller's document reprice.
 *
 * **Catalog ratio with override, applied per level**: a component still at
 * {@link componentQuantityAt}`(ratio, parentOld)` follows its parent to
 * `componentQuantityAt(ratio, parentNew)`; anything else is a hand edit and
 * keeps its number. The ratio is relative to the DIRECT parent.
 *
 * ⚠️ Reads the CATALOG for now. Once every component line carries
 * `quantity_per_parent` (core#131 Phase 2), Phase 3 switches it to the stamp
 * and the catalog argument goes away.
 *
 * @param catalog the ROOT product's `components[]` — the materialized whole tree
 * @param rootPos {@link kitRootPos} of the edited line, so editing a nested
 *   sub-kit still reads the root's catalog
 */
export function rescaleKitSubtree<T extends KitLineLike>(
  items: T[],
  index: number,
  newQty: number,
  catalog: readonly CatalogComponentLike[],
  rootPos: number,
): T[] {
  const out = [...items];
  const { startIndex, endIndex } = getItemSubtreeRange(items, index);
  const rootUid = items[index].path[rootPos];
  const oldQty = new Map<string, number>();
  const nextQty = new Map<string, number>();

  for (let i = startIndex; i <= endIndex; i++) {
    const item = items[i];
    const key = item.path.join("\u0000");
    const before = item.quantity ?? 0;
    oldQty.set(key, before);

    let after = before;
    if (i === index) {
      after = newQty;
    } else {
      const parentKey = item.path.slice(0, -1).join("\u0000");
      const parentOld = oldQty.get(parentKey);
      const parentNew = nextQty.get(parentKey);
      if (parentOld !== undefined && parentNew !== undefined && parentOld !== parentNew) {
        const chain = item.path.slice(rootPos);
        const comp = catalog.find((c) => {
          const cc = catalogChain(c, rootUid);
          return cc.length === chain.length && cc.every((seg, j) => seg === chain[j]);
        });
        if (comp) {
          const ratio = comp.quantity ?? 1;
          if (before === componentQuantityAt(ratio, parentOld)) after = componentQuantityAt(ratio, parentNew);
        }
      }
    }

    nextQty.set(key, after);
    if (after !== before) out[i] = { ...item, quantity: after };
  }
  return out;
}
