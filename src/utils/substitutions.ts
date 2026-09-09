/**
 * "Is this row explained by a substitution?" — the ONE predicate, asked from
 * several directions by two repos.
 *
 * ## Why this is one module and not a helper per caller
 *
 * A substitution makes a document diverge from its order deliberately, and
 * every guard over that document has to be relaxed by *exactly* the amount the
 * substitution licenses — no more, no less. There are six askers today:
 *
 * | asked by | of what | direction |
 * |---|---|---|
 * | `api-cloudrun/src/services/fulfillmentEdits.ts` — the omission guard | a STORED row the submission drops | is it at or below some `path_substituted_for`? |
 * | `api-cloudrun/src/services/fulfillmentEdits.ts` — the counterpart guard | a SUBMITTED row with no order line | is it strictly below some substitution's own path? |
 * | `api-cloudrun/scripts/audit-fulfillment-divergence.ts` | an ORDER line with no fulfillment row | is it at or below some `path_substituted_for`? |
 * | {@link syncOrderToInvoiceSelective} | an ORDER line the invoice does not carry | is it at or below some `path_substituted_for`? |
 * | {@link computeInvoiceSyncStatus} | both sides of a substituted pair | is the divergence tracked rather than drift? |
 * | {@link computeOrderInvoiceCoverage} | an order line with no invoice line | is it at or below some `path_substituted_for`? |
 *
 * Four of the six are the same question, and the wire boundary, the audit and
 * the projection **must** answer it identically — an audit stricter than the
 * guard reports correct data as a finding, and one that is looser certifies
 * what the guard would have refused. Sharing the predicate is what makes "the
 * audit checks what the server enforces" a fact rather than an intention.
 *
 * ⚠️ **It lives in `core` because the callers are in two repos.** It was
 * `api-cloudrun/src/lib/substitutedSubtree.ts` while all three askers were
 * server-side; the invoice sync (`utils/invoices.ts`) is the caller that made
 * that home wrong. The booking-projection half stayed behind — it reads
 * `price.total_cents` and belongs to the order→booking projection, not to the
 * predicate.
 *
 * ## 🔴 The asymmetry is the whole design, so do not "simplify" it to one call
 *
 * A substitution row Y carries two paths and they live in **different
 * documents**:
 *
 * - **`path_substituted_for`** is X's path in the ORDER — the row Y replaces,
 *   **as the order carries it NOW**. It is what licenses the *absence* of X (and
 *   of X's whole component subtree) from the downstream document.
 *   🔴 This read *"locked at substitution time, never re-derived"* until
 *   api-cloudrun#897, and that was wrong rather than a policy since changed. A
 *   path is only as stable as the dividers above it, so an admin reparenting X on
 *   the order left the anchor naming a path nothing resolved — X stopped being
 *   at-or-below it, {@link isRemovedBySubstitution} went false, and both syncs
 *   re-projected the product the operator had swapped away. **The two syncs
 *   re-point it and write the new value back**, because they are the only callers
 *   holding both revisions of the order; every reader below sees one order and
 *   could not resolve a locked value at all.
 * - **`path`** is Y's own path in that downstream document. It is what licenses
 *   the *presence* of Y's components, which exist on no order line at all.
 *
 * So a removal is explained from the X side and an addition from the Y side,
 * and swapping them silently admits the class of write these guards exist to
 * refuse. {@link SubstitutionAnchor} keeps both, named, rather than letting a
 * call site pick the wrong array.
 *
 * ## Paths compare ELEMENT-WISE, never as joined strings
 *
 * ⚠️ A joined key is right for equality and **wrong for prefix**. With any
 * separator, `["a","b"]` joins to a string prefix of `["a","bc"]`'s join, so a
 * `startsWith` test reports a kit component as a descendant of an unrelated
 * sibling. The segments are uids and the arrays are ≤ a handful deep, so the
 * loop below is both cheaper and correct.
 *
 * ⚠️ **Both surfaces must feed this the SAME path space.** A fulfillment row
 * and its order counterpart share one path space, so the fulfillment callers
 * pass stored paths straight in. An invoice line's stored path is prefixed with
 * its ORDER DIVIDER's uid and an order line's is not, so the invoice callers
 * strip that prefix first — `path_substituted_for` is an ORDER path on both
 * surfaces, and comparing it against a divider-scoped path matches nothing and
 * reports every substitution as unexplained.
 *
 * @module
 */

/** A substitution row, reduced to the two paths the predicates need. */
export interface SubstitutionAnchor {
  /** Y's own path, in the document that carries the row. */
  readonly path: readonly string[];
  /** X's ORDER path — the row Y replaces. Locked at substitution time. */
  readonly substitutedFor: readonly string[];
}

/** The shape every caller already has; deliberately narrower than a line item. */
export interface MaybeSubstitution {
  readonly path: readonly string[];
  readonly path_substituted_for?: readonly string[] | undefined;
}

/**
 * True when `ancestor` is `path` itself or a proper prefix of it.
 *
 * Element-wise on purpose — see the module docstring.
 *
 * @param path - The row's path
 * @param ancestor - The candidate ancestor path
 * @returns Whether `ancestor` is `path` or a proper prefix of it
 */
export function isAtOrBelow(
  path: readonly string[],
  ancestor: readonly string[],
): boolean {
  if (ancestor.length > path.length) return false;
  for (let i = 0; i < ancestor.length; i++) {
    if (path[i] !== ancestor[i]) return false;
  }
  return true;
}

/**
 * True when `ancestor` is a PROPER prefix of `path` — the row itself excluded.
 *
 * @param path - The row's path
 * @param ancestor - The candidate strict ancestor path
 * @returns Whether `path` sits strictly below `ancestor`
 */
export function isStrictlyBelow(
  path: readonly string[],
  ancestor: readonly string[],
): boolean {
  return path.length > ancestor.length && isAtOrBelow(path, ancestor);
}

/**
 * Reduce a row set to its substitution anchors.
 *
 * ⚠️ A row with no `path_substituted_for` is not an anchor even if it sits
 * inside a substituted subtree — the components of Y explain nothing, they are
 * themselves explained. Only the row that names X licenses anything.
 *
 * 🔴 **An EMPTY path on either side is refused, and it is the sharp case.**
 * `[]` is a prefix of every path, so an anchor holding one turns
 * {@link isRemovedBySubstitution} and {@link isInSubstitutedSubtree} into
 * `true` for the entire document — every guard relaxed at once, every audit
 * certifying its whole corpus as explained. The failure is silent and it is in
 * the permissive direction, which is why this refuses rather than warns.
 *
 * ⚠️ **It is reachable, not theoretical.** The field is `.optional()` on both
 * surfaces with no `.min(1)`, and `getInitialValues` materializes an optional
 * array as `[]` — so any line seeded from the schema carries an empty one.
 * Measured: a `getInitialValues(InvoiceDocLineItem)` fixture made a
 * substitution "explain" the removal of a row sharing no path segment with it.
 * The wire guard in `api-cloudrun/src/services/fulfillmentEdits.ts` happens to
 * reject an empty `path_substituted_for` on submission (it resolves to no order
 * item), but the audits and projections read STORED rows and had no such
 * backstop.
 *
 * ⭐ Refusing here rather than in the schema is deliberate: `.min(1)` would make
 * a form seed fail to parse, and the defect is not that `[]` can be written —
 * it is that `[]` must not LICENSE anything.
 *
 * @param rows - The rows to scan
 * @returns One anchor per row carrying a non-empty `path_substituted_for`
 */
export function collectSubstitutionAnchors(
  rows: readonly MaybeSubstitution[],
): SubstitutionAnchor[] {
  const anchors: SubstitutionAnchor[] = [];
  for (const row of rows) {
    if (row.path_substituted_for === undefined) continue;
    if (row.path_substituted_for.length === 0) continue;
    if (row.path.length === 0) continue;
    anchors.push({ path: row.path, substitutedFor: row.path_substituted_for });
  }
  return anchors;
}

/**
 * Is the ABSENCE of the row at `orderPath` explained by one of these anchors?
 *
 * Answers for X itself (`substitutedFor` equals the path) and for every one of
 * X's components (`substitutedFor` is a proper prefix). That second case is the
 * one that matters: substituting a kit removes a whole subtree, and only the
 * parent is named by any stored field.
 *
 * @param orderPath - The order line's path
 * @param anchors - The downstream document's substitution anchors
 * @returns Whether some anchor explains the row's absence
 */
export function isRemovedBySubstitution(
  orderPath: readonly string[],
  anchors: readonly SubstitutionAnchor[],
): boolean {
  return anchors.some((a) => isAtOrBelow(orderPath, a.substitutedFor));
}

/**
 * Is the PRESENCE of the row at `path` explained as part of a substituted
 * subtree — i.e. is it a component of some Y?
 *
 * ⚠️ **Strictly below, so Y itself is NOT in its own subtree.** Y is validated
 * by the substitution branch (in-place path, live `Product.alternates[]`
 * membership); admitting it here as well would let a row license itself.
 *
 * @param path - The row's path in the downstream document
 * @param anchors - The downstream document's substitution anchors
 * @returns Whether the row is a component of some substitution
 */
export function isInSubstitutedSubtree(
  path: readonly string[],
  anchors: readonly SubstitutionAnchor[],
): boolean {
  return anchors.some((a) => isStrictlyBelow(path, a.path));
}

/**
 * Is the row at `path` part of a substitution's own subtree — Y ITSELF, or one
 * of Y's components?
 *
 * 🔴 **The INCLUSIVE twin of {@link isInSubstitutedSubtree}, and the difference
 * is not a detail.** The strict form exists so a submitted row cannot license
 * itself: `api-cloudrun`'s counterpart guard validates Y on its own merits
 * (in-place path, live `Product.alternates[]` membership) and must not let Y
 * wave itself through as "part of a substituted subtree". A downstream
 * PROJECTION is asking the opposite question — *which rows do I keep?* — and
 * the answer there is Y and its components together, because dropping Y is
 * precisely the bug.
 *
 * ⚠️ Reach for this only where the anchor set has already been VALIDATED. On a
 * wire boundary, use {@link isInSubstitutedSubtree} and check Y separately.
 *
 * @param path - The row's path in the downstream document
 * @param anchors - The downstream document's substitution anchors
 * @returns Whether the row is a substitution's own row or one of its components
 */
export function isSubstitutionRow(
  path: readonly string[],
  anchors: readonly SubstitutionAnchor[],
): boolean {
  return anchors.some((a) => isAtOrBelow(path, a.path));
}

/**
 * The anchor whose subtree `path` falls in, or `undefined`.
 *
 * The caller needs the anchor itself and not merely a boolean, because deriving
 * a component's unauthorable fields means reading the REPLACEMENT product —
 * which is addressed by the anchor's own `path.at(-1)`.
 *
 * @param path - The row's path in the downstream document
 * @param anchors - The downstream document's substitution anchors
 * @returns The nearest enclosing anchor, or `undefined`
 */
export function findSubtreeAnchor(
  path: readonly string[],
  anchors: readonly SubstitutionAnchor[],
): SubstitutionAnchor | undefined {
  // Deepest-first: nested kits mean a row can sit under two anchors, and the
  // one that owns it is the nearer. Sorting by length is enough — an ancestor
  // of a path is strictly shorter than it.
  let best: SubstitutionAnchor | undefined;
  for (const a of anchors) {
    if (!isStrictlyBelow(path, a.path)) continue;
    if (best === undefined || a.path.length > best.path.length) best = a;
  }
  return best;
}
