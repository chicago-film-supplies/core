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

/** Utils namespaces injected for every template regardless of collection. */
export const ALWAYS_ON_UTIL_NAMESPACES: readonly string[] = ["dates"];

/**
 * Third-party libraries injected as `it.*` globals for every template
 * (`it.currency`, `it.dateFns`, `it.tz`). Not `@cfs/core` utils — documented
 * here so the render context has one authoritative inventory.
 */
export const TEMPLATE_LIB_GLOBALS: readonly string[] = ["currency", "dateFns", "tz"];

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
