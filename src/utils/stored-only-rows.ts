/**
 * Where a projection's STORED-ONLY rows go when an order edit re-projects it.
 *
 * Both projections of an order — the fulfillment and the invoice — keep rows
 * the order does not carry: a picker addition, a substitution, a row kept
 * because its units are still out, a line or a whole section an operator added
 * on the invoice. Each sync decides WHICH stored rows survive by its own rule
 * (custody and kits on the fulfillment, "absent from both orders" on the
 * invoice), and that rule stays with its sync. What is the same on both sides
 * is the PLACEMENT, and this module is it.
 *
 * 🔴 **The placement is not cosmetic.** `computeItemPaths` reads the divider
 * stack off the ARRAY, so a surviving row emitted at the wrong index is
 * re-parented under whatever divider precedes it — into a group the operator
 * never put it in, silently, with a path that is now a fixed point of the
 * recompute and therefore passes the write guard. Three rules prevent it:
 *
 * 1. **A survivor follows the stored row it followed.** Each block is keyed on
 *    the last stored row that is ALSO in the projection — its anchor — rather
 *    than on an index, which a concurrent insert would shift.
 * 2. **A stored-only divider is emitted only when a survivor hangs beneath
 *    it**, element-wise (`isStrictlyBelow`), never by a joined-string prefix.
 *    A divider the order removed with nothing of the projection's own left
 *    under it goes with the order.
 * 3. **And it is emitted IMMEDIATELY BEFORE its first survivor**, not at its
 *    stored index. A kept divider separated from its subtree by a projected
 *    line would capture that line.
 *
 * A survivor may itself be a divider (an invoice divider an operator renamed
 * before the order deleted it, or one the invoice authored). It is placed like
 * any survivor and drags its own kept ancestors in front of itself.
 *
 * Extracted from `syncRows` in `api-cloudrun/src/lib/orderFulfillmentSync.ts`,
 * which solved it first (api-cloudrun#897, #1147); the invoice sync adopted it
 * with core#124.
 *
 * @module
 */
import { isStrictlyBelow } from "./substitutions.ts";

/** Anything carrying a self-inclusive item path. */
export interface PathedRow {
  path: readonly string[];
}

/** What {@link placeStoredOnlyRows} needs. */
export interface StoredOnlyRowsInput<T extends PathedRow> {
  /** The stored projection's rows, in stored order. */
  stored: readonly T[];
  /** The paths the new projection emits. A stored row at one of them is an anchor. */
  projectedPaths: Iterable<readonly string[]>;
  /** The stored rows that survive. Membership is by identity — pass elements of `stored`. */
  survivors: ReadonlySet<T>;
  /** The row a survivor is emitted AS, when it is not emitted unchanged. */
  survivorAs?: ReadonlyMap<T, T>;
  /** Is this row a LINE? Only a non-line row can be kept as an ancestor. */
  isLine: (row: T) => boolean;
}

/** Where every surviving stored row goes, relative to the projection. */
export interface StoredOnlyPlacement<T extends PathedRow> {
  /** Survivors whose stored position precedes every anchor. */
  leading: readonly T[];
  /** Survivors to emit right after the projected row at `path` — empty when none. */
  following(path: readonly string[]): readonly T[];
}

const keyOf = (path: readonly string[]): string => path.join("/");

/**
 * Place a projection's surviving stored-only rows — see the module doc.
 *
 * The caller walks its projection and, after emitting the row at each projected
 * path, emits `following(path)`; `leading` goes first. Use
 * {@link interleaveStoredOnlyRows} when the projection is already a plain array.
 */
export function placeStoredOnlyRows<T extends PathedRow>(input: StoredOnlyRowsInput<T>): StoredOnlyPlacement<T> {
  const { stored, survivors, survivorAs, isLine } = input;
  const projected = new Set<string>();
  for (const path of input.projectedPaths) projected.add(keyOf(path));

  const keptDividers: T[] = [];
  for (const e of stored) {
    if (isLine(e) || survivors.has(e) || projected.has(keyOf(e.path))) continue;
    if (![...survivors].some((r) => isStrictlyBelow(r.path, e.path))) continue;
    keptDividers.push(e);
  }

  const leading: T[] = [];
  const after = new Map<string, T[]>();
  const emittedDividers = new Set<T>();
  /** A survivor and any kept ancestors it drags in front of itself. */
  const withKeptAncestors = (row: T, as: T): T[] => {
    const out: T[] = [];
    for (const d of keptDividers) {
      if (emittedDividers.has(d) || !isStrictlyBelow(row.path, d.path)) continue;
      emittedDividers.add(d);
      out.push(d);
    }
    out.push(as);
    return out;
  };
  let lastAnchor: string | null = null;
  for (const e of stored) {
    const k = keyOf(e.path);
    if (!survivors.has(e)) {
      if (projected.has(k)) lastAnchor = k;
      continue;
    }
    const block = withKeptAncestors(e, survivorAs?.get(e) ?? e);
    if (lastAnchor === null) leading.push(...block);
    else {
      const bucket = after.get(lastAnchor);
      if (bucket) bucket.push(...block);
      else after.set(lastAnchor, block);
    }
  }
  return { leading, following: (path) => after.get(keyOf(path)) ?? [] };
}

/**
 * {@link placeStoredOnlyRows} over a projection that is already a plain array:
 * the projection's own rows, in order, with each survivor block after its anchor.
 */
export function interleaveStoredOnlyRows<T extends PathedRow>(
  projection: readonly T[],
  input: Omit<StoredOnlyRowsInput<T>, "projectedPaths">,
): T[] {
  const placement = placeStoredOnlyRows({ ...input, projectedPaths: projection.map((r) => r.path) });
  const out: T[] = [...placement.leading];
  for (const row of projection) {
    out.push(row);
    out.push(...placement.following(row.path));
  }
  return out;
}
