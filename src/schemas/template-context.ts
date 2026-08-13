/**
 * Template render-context descriptor — the single source of truth for **which
 * `it.*` namespaces a template can call**, shared by the API's render context
 * and the manager's editor reference panels.
 *
 * A template's available helpers are determined by its **collections**, not by a
 * fixed list. `api-cloudrun`'s `eta.ts` used to inject `it.orders` + `it.dates`
 * unconditionally, so an invoices-source template got order helpers and no
 * invoice helpers. Both the runtime injection and the editor panels now resolve
 * the same set through {@link availableUtilNamespaces}, so the panel can never
 * advertise a helper the server won't provide.
 *
 * The resolver takes **lists** even though `collection_source`/`collection_target`
 * are single-valued today (`z.enum` on the family doc). When a template grows to
 * multiple sources/targets, only the call sites change — not this contract.
 *
 * @module
 */
import type { TemplateSourceCollectionType, TemplateTargetCollectionType } from "./template.ts";

/** Any collection a template can read from or produce. */
export type TemplateCollectionType = TemplateSourceCollectionType | TemplateTargetCollectionType;

/**
 * Collection → the `@cfs/core/utils` namespace injected for it, exposed as
 * `it.<namespace>` inside a template.
 *
 * `Partial` on purpose: a collection need not have a utils namespace.
 * `quotes` and `packing_lists` have none — templates *produce* those, they
 * don't compute over them.
 *
 * Values must be valid `it.<ns>` identifiers. `contact-name` is deliberately
 * unmapped for that reason; a future collection needing it would map to
 * `"contactName"`.
 */
export const TEMPLATE_COLLECTION_UTILS: Partial<Record<TemplateCollectionType, string>> = {
  orders: "orders",
  invoices: "invoices",
};

/**
 * Utils namespaces injected for every template regardless of collection.
 *
 * `money` is here rather than in {@link TEMPLATE_COLLECTION_UTILS} because every
 * document a template renders carries money — an order, an invoice and a quote
 * all need `it.money.formatCents`, so keying it to one collection would just
 * mean listing it under all of them.
 *
 * It also closes a gap the generated helper catalogue had already opened:
 * `template-helpers.generated.ts` derives its namespaces from `src/utils/`, so
 * it has been advertising eleven `it.money.*` helpers to template authors while
 * the render path injected none of them. Documentation promising a global that
 * throws at render time is worse than no documentation.
 *
 * ✅ `it.currency` (raw currency.js) **is gone as of Phase 11 Phase E**, and
 * `it.money` is what replaced it. It survived this long because the natural
 * replacement takes **cents** while template documents held **dollars**, so
 * every one of the 19 call sites in `templates/quote.eta` would have read
 * `it.money.formatCents(it.money.toCents(x))` — worse than what it replaced.
 * Documents are cents-denominated now, `it.money.formatCents(doc.total_cents)`
 * is the natural form, and the trade flipped exactly as predicted.
 *
 * `icons` is always on for the same reason `money` is — a glyph beside a phone
 * number or a delivery block is not a property of the source collection. It also
 * has to be always-on to be *usable*: header and footer partials render in an
 * isolated Chromium frame that loads no external resources, so inline SVG from a
 * util is the only icon a partial can have, and partials are shared across
 * collections.
 */
export const ALWAYS_ON_UTIL_NAMESPACES: readonly string[] = ["dates", "money", "icons"];

/**
 * Third-party libraries injected as `it.*` globals for every template
 * (`it.dateFns`, `it.tz`). Not `@cfs/core` utils — documented here so the
 * render context has one authoritative inventory.
 *
 * **This list IS the contract, not a description of one.** `api-cloudrun`'s
 * money Ratchet E asserts the render context's raw injections against it
 * directly, so adding a name here is what permits a new raw library into every
 * template — there is no second copy to keep in sync.
 *
 * ⚠️ **A money library must never come back.** `currency` lived here until
 * Phase 11 Phase E and was the one unguarded money surface templates had:
 * `it.currency(x).divide(y)` is a real, working call that makes a silent
 * rounding decision, and no ratchet in `api-cloudrun` or `core` can see what an
 * `.eta` file does with it — template content is canonical in the `templates`
 * repo, not here. Money reaches templates through `it.money` (see
 * {@link ALWAYS_ON_UTIL_NAMESPACES}), which is swept.
 */
export const TEMPLATE_LIB_GLOBALS: readonly string[] = ["dateFns", "tz"];

/**
 * Per-render scalars injected as `it.*` globals for every template. `it.doc` is
 * always the **source** document — a template never reads its target, it
 * produces it.
 */
export const TEMPLATE_SCALAR_GLOBALS: readonly string[] = [
  "doc",
  "version",
  "params",
  "now",
  "holidays",
  "logo",
];

/**
 * Resolve the `@cfs/core/utils` namespaces available to a template, as the union
 * of the always-on set plus each source/target collection's namespace.
 *
 * ```ts
 * availableUtilNamespaces(["orders"], ["quotes"]);     // ["dates", "orders"]
 * availableUtilNamespaces(["orders"], ["invoices"]);   // ["dates", "orders", "invoices"]
 * availableUtilNamespaces(["invoices"], ["invoices"]); // ["dates", "invoices"]
 * ```
 *
 * Note that a **target**-derived namespace is forward-looking: `it.doc` is the
 * source document, so e.g. an orders→invoices template gets `it.invoices`
 * helpers with no invoice document to apply them to until the author builds
 * invoice-shaped data themselves.
 *
 * @param sources - The template's source collections (single-element today).
 * @param targets - The template's target collections (single-element today).
 * @returns Deduped namespace list, always-on first, in collection order.
 */
export function availableUtilNamespaces(
  sources: readonly TemplateCollectionType[],
  targets: readonly TemplateCollectionType[],
): string[] {
  const namespaces = new Set<string>(ALWAYS_ON_UTIL_NAMESPACES);
  for (const collection of [...sources, ...targets]) {
    const namespace = TEMPLATE_COLLECTION_UTILS[collection];
    if (namespace) namespaces.add(namespace);
  }
  return [...namespaces];
}
