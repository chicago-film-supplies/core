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

import { isLineItemType } from "../schemas/common.ts";

/**
 * A substitution row, reduced to what the predicates need.
 *
 * One anchor per (substitute row, replaced X). A row merged from two different
 * X's is two anchors sharing one `path`.
 */
export interface SubstitutionAnchor {
  /** Y's own path, in the document that carries the row. */
  readonly path: readonly string[];
  /** X's ORDER path — the row Y replaces. Re-pointed by the syncs when X moves. */
  readonly substitutedFor: readonly string[];
  /**
   * Units of Y that stand in for X. For a `legacy` anchor it is the row's whole
   * quantity: `path_substituted_for` swapped in place, so all of Y replaced X.
   */
  readonly quantity: number;
  /**
   * `legacy` — read from `path_substituted_for`. `entry` — read from a
   * `substituted_for` entry (manager#414), which may be a MERGE into a row the
   * order also carries.
   *
   * ⚠️ The two graduate differently (owner, 2026-09-16): a legacy anchor is
   * spent once the order carries Y itself; an entry is spent once the order no
   * longer carries X. Y being on the order says nothing about a merge, which
   * was always into a Y the order had.
   */
  readonly form: "legacy" | "entry";
}

/** One `substituted_for` entry, as a row carries it. */
export interface MaybeSubstitutedForEntry {
  readonly path: readonly string[];
  readonly quantity: number;
}

/** The shape every caller already has; deliberately narrower than a line item. */
export interface MaybeSubstitution {
  readonly path: readonly string[];
  readonly path_substituted_for?: readonly string[] | undefined;
  readonly substituted_for?: readonly MaybeSubstitutedForEntry[] | undefined;
  /** Read only for a `legacy` anchor's {@link SubstitutionAnchor.quantity}. */
  readonly quantity?: number | undefined;
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
 * ⭐ **`substituted_for` is stamped on EVERY row of Y's subtree (D1), so the
 * anchor is the subtree's ROOT for that X** — the row no strict ancestor in the
 * set also names that X for. A component's entry records how many of ITS units
 * stand in (the D2 invariant, {@link standInUnits}); it anchors nothing.
 *
 * A row carrying both fields yields anchors from `substituted_for` only: the
 * new field is the more specific statement of the same swap.
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
  /** Every (row path, X path) an entry names — to tell a subtree root from a component. */
  const named = new Set<string>();
  for (const row of rows) {
    for (const entry of row.substituted_for ?? []) named.add(joinKey(row.path) + "\x1e" + joinKey(entry.path));
  }
  for (const row of rows) {
    if (row.path.length === 0) continue;
    const entries = (row.substituted_for ?? []).filter((e) => e.path.length > 0);
    if (entries.length > 0) {
      for (const entry of entries) {
        let underRoot = false;
        for (let depth = row.path.length - 1; depth > 0 && !underRoot; depth--) {
          underRoot = named.has(joinKey(row.path.slice(0, depth)) + "\x1e" + joinKey(entry.path));
        }
        if (underRoot) continue;
        anchors.push({ path: row.path, substitutedFor: entry.path, quantity: entry.quantity, form: "entry" });
      }
      continue;
    }
    if (row.path_substituted_for === undefined) continue;
    if (row.path_substituted_for.length === 0) continue;
    anchors.push({ path: row.path, substitutedFor: row.path_substituted_for, quantity: row.quantity ?? 0, form: "legacy" });
  }
  return anchors;
}

/** Element-wise join for set keys; `\x1f` never occurs in a uid. */
function joinKey(path: readonly string[]): string {
  return path.join("\x1f");
}

/**
 * How many of a row's own units stand in for a substitution rather than for
 * the order line at its own path — Σ of its `substituted_for` quantities whose
 * X is one of `liveX` (the D2 invariant: the rest is the order's quantity at
 * the row's path).
 *
 * A spent entry (its X not in `liveX`) stands in for nothing, so its units
 * count at the row's own path again. A row with no `substituted_for` returns 0,
 * including a `legacy` anchor row, whose whole quantity the caller reads from
 * {@link SubstitutionAnchor.quantity}.
 *
 * @param row - The downstream row
 * @param liveX - Keys (`path.join("/")`) of the X paths whose anchors are live
 * @returns Units of the row that stand in for a live substitution
 */
export function standInUnits(row: MaybeSubstitution, liveX: ReadonlySet<string>): number {
  let units = 0;
  for (const entry of row.substituted_for ?? []) {
    if (entry.path.length > 0 && liveX.has(entry.path.join("/"))) units += entry.quantity;
  }
  return units;
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

/** An order row, reduced to what {@link substitutionCredit} reads. */
export interface CreditableRow {
  readonly type: string;
  readonly path?: readonly string[] | undefined;
  readonly quantity?: number | undefined;
}

/**
 * Units of each order line that substitutes stand in for: what substitutes name
 * it directly, plus its kit parent's credit scaled by the ORDER's own component
 * ratio (`credit × component quantity ÷ kit quantity`, rounded half-up once per
 * level — never the catalog, D1/D2).
 *
 * The one walk `billedByPath`, `computeDocumentDiffs`'s D2 quantity check and
 * the invoice sync (`syncOrderToInvoiceSelective`, `computeInvoiceSyncStatus`) read. A path under a credited kit is present even at 0.
 *
 * A path named directly that the order does not carry (a dangling anchor) keeps
 * its direct credit; the walk only reaches paths the order has.
 *
 * @param orderItems - The order's items, dividers included (skipped)
 * @param direct - Order path key → units substitutes name it for directly
 */
export function substitutionCredit(
  orderItems: readonly CreditableRow[],
  direct: ReadonlyMap<string, number>,
): Map<string, number> {
  // Paths are depth-first contiguous, so a parent's credit is final before its children.
  const credit = new Map<string, number>();
  const quantityAt = new Map<string, number>();
  for (const item of orderItems) {
    if (!isLineItemType(item.type)) continue;
    const path = item.path ?? [];
    const k = path.join("/");
    const quantity = item.quantity ?? 0;
    quantityAt.set(k, quantity);
    const parent = path.slice(0, -1).join("/");
    const parentCredit = credit.get(parent) ?? 0;
    const parentQuantity = quantityAt.get(parent) ?? 0;
    const inherited = parentCredit > 0 && parentQuantity > 0
      ? Math.floor((2 * parentCredit * quantity + parentQuantity) / (2 * parentQuantity))
      : 0;
    const own = (direct.get(k) ?? 0) + inherited;
    if (own === 0 && !(parentCredit > 0)) continue;
    credit.set(k, own);
  }
  for (const [k, units] of direct) {
    if (!quantityAt.has(k)) credit.set(k, units);
  }
  return credit;
}


/** @see {@link substitutionResync} */
export interface SubstitutionResync {
  /** The `entry` anchors live against the PREVIOUS order (it carries their X). */
  readonly anchorsPrev: readonly SubstitutionAnchor[];
  /** {@link anchorsPrev}, each X re-pointed to the NEXT order, kept only where it still carries X. */
  readonly anchorsNext: readonly SubstitutionAnchor[];
  /**
   * A stored row's ORDER-EQUIVALENT quantity — its quantity with the previous
   * order's D2 offset removed: `quantity − standing-in units + credit`.
   *
   * @param path - The row's path, in the ORDER's path space
   * @param row - The stored row
   */
  orderEquivalent(path: readonly string[], row: MaybeSubstitution): number;
  /**
   * Re-apply the D2 offset under the NEXT order to a row's order-equivalent
   * quantity: `− credit + Σ live entries`. Entries are re-pointed at X's next
   * path; one whose X the next order lacks is dropped WITH its units (owner,
   * 2026-09-16); one already spent against the previous order is dropped and its
   * units stay (they were never removed).
   *
   * @param path - The row's path on the next order, in the ORDER's path space
   * @param entries - The row's stored `substituted_for`
   * @param orderEquivalent - The row's order-equivalent quantity after any merge
   * @returns `substituted` is true when an entry or a credit touched the row —
   *   the rows a caller drops once `quantity` reaches 0
   */
  reoffset(
    path: readonly string[],
    entries: readonly MaybeSubstitutedForEntry[] | undefined,
    orderEquivalent: number,
  ): { quantity: number; substituted_for: MaybeSubstitutedForEntry[] | undefined; substituted: boolean };
}

/**
 * The D2 offset of a downstream document's `substituted_for` entries across one
 * order edit — the half an order → downstream sync needs (manager#414).
 *
 * A sync compares and merges ORDER-EQUIVALENT quantities, then re-offsets what it
 * emits, so a merged Y and a partially swapped X follow order quantity edits
 * instead of reading as an override. One implementation for the invoice sync
 * (`syncOrderToInvoiceSelective`) and api-cloudrun's fulfillment sync, which
 * must answer identically.
 *
 * @param rows - The downstream rows, paths in the ORDER's path space
 * @param prevOrderItems - The order before the edit
 * @param nextOrderItems - The order after it (the same array for a one-order read)
 * @param toPath - Where a previous-order line path sits on the next order, if it moved
 */
export function substitutionResync(
  rows: readonly MaybeSubstitution[],
  prevOrderItems: readonly CreditableRow[],
  nextOrderItems: readonly CreditableRow[],
  toPath: (path: readonly string[]) => readonly string[] | undefined = () => undefined,
): SubstitutionResync {
  const keys = (items: readonly CreditableRow[]) => new Set(items.map((it) => (it.path ?? []).join("/")));
  const prevKeys = keys(prevOrderItems);
  const nextKeys = keys(nextOrderItems);
  const xNext = (x: readonly string[]): readonly string[] => toPath(x) ?? x;

  const anchorsPrev = collectSubstitutionAnchors(rows.map((r) => ({ path: r.path, substituted_for: r.substituted_for })))
    .filter((a) => prevKeys.has(a.substitutedFor.join("/")));
  const anchorsNext = anchorsPrev
    .map((a) => ({ ...a, substitutedFor: [...xNext(a.substitutedFor)] }))
    .filter((a) => nextKeys.has(a.substitutedFor.join("/")));

  const offsets = (anchors: readonly SubstitutionAnchor[], orderItems: readonly CreditableRow[]) => {
    const direct = new Map<string, number>();
    const liveX = new Set<string>();
    for (const a of anchors) {
      const x = a.substitutedFor.join("/");
      liveX.add(x);
      direct.set(x, (direct.get(x) ?? 0) + a.quantity);
    }
    return { credit: substitutionCredit(orderItems, direct), liveX };
  };
  const prev = offsets(anchorsPrev, prevOrderItems);
  const next = offsets(anchorsNext, nextOrderItems);

  return {
    anchorsPrev,
    anchorsNext,
    orderEquivalent: (path, row) =>
      (row.quantity ?? 0) - standInUnits(row, prev.liveX) + (prev.credit.get(path.join("/")) ?? 0),
    reoffset: (path, entries, orderEquivalent) => {
      const credit = next.credit.get(path.join("/")) ?? 0;
      let quantity = orderEquivalent - credit;
      const kept: MaybeSubstitutedForEntry[] = [];
      for (const entry of entries ?? []) {
        if (!prev.liveX.has(entry.path.join("/"))) continue;
        const now = xNext(entry.path);
        if (!nextKeys.has(now.join("/"))) continue;
        kept.push({ ...entry, path: [...now] });
        quantity += entry.quantity;
      }
      return {
        quantity,
        substituted_for: kept.length > 0 ? kept : undefined,
        substituted: credit > 0 || (entries?.length ?? 0) > 0,
      };
    },
  };
}
