/**
 * "Which row of the NEW array is the same row as this one in the OLD array?" —
 * the ONE pairing, asked across two rebuilds by two repos.
 *
 * ## Why the key is `(uid, k-th occurrence)` and not the obvious two
 *
 * - **Not `uid` alone.** `item.uid` repeats within one items array on 18% of
 *   prod orders — a priced principal beside zero-priced accessory copies, a
 *   `splitItem`, or a product appearing standalone and as a kit component. A
 *   uid-keyed pairing silently applies one row's answer to every row sharing its
 *   uid.
 * - **Not `path`.** A path is only as stable as the dividers above it, and
 *   divider uids are reused BY NAME (`reuseMemberUids`), so a group rename — or
 *   an operator dragging a line into another group — churns every descendant
 *   path while changing nothing about the lines themselves. That is precisely
 *   the api-cloudrun#897 defect this module exists to remove: two syncs asked
 *   *"was this row on the previous order?"* with a raw path-string lookup, so a
 *   reparented line read as brand new and was projected fresh **beside the
 *   substitute that had replaced it**.
 * - **`(uid, k-th occurrence in document order)`** is what
 *   `api-cloudrun`'s `carryForwardRowField` (`api-cloudrun/src/lib/itemNesting.ts`) and
 *   `reuseMemberUids` already use, with `uid` in place of `name`. Position is
 *   never the identity — only ever a tie-break among members already identical
 *   under one.
 *
 * ⚠️ **It lives here because the callers are in two repos**, exactly as
 * `utils/substitutions.ts` does. `adoptOrderDividerStructure`
 * (`utils/invoices.ts`) grew the first copy of this loop; `syncItems`
 * (`api-cloudrun/src/lib/orderFulfillmentSync.ts`) needed the second. Two copies
 * of one pairing rule in one domain is precisely what api-cloudrun#593 was —
 * two carry-forwards in one file that had drifted onto different keys with
 * nothing making them agree — so there is one implementation and both callers
 * take it.
 *
 * ## 🔴 A pairing is a GUESS wherever a uid repeats, and it says so
 *
 * {@link AmbiguousPairing} is reported, never silently resolved. The pairing
 * still happens — refusing would be worse, because the alternative to a k-th
 * guess is no answer at all — but a caller that can surface it to an operator
 * must, and `api-cloudrun/scripts/repair-invoice-structure.ts` is the worked example.
 *
 * ## Paths never leave this module as strings
 *
 * {@link RebuildPathMap} hands back **path arrays**, not keys. Its two consumers
 * key paths differently (`utils/invoices.ts` joins on `/`,
 * `api-cloudrun/src/lib/orderFulfillmentSync.ts` on `\x1f`), and a map handed
 * out under one of those spellings is a map half its callers would look up
 * wrongly. The joiner below is private for that reason.
 *
 * @module
 */

/** `path` as a map key. `\x1f` cannot occur in a uid, so this cannot collide. */
function pathKey(path: readonly string[] | undefined): string {
  return (path ?? []).join("\x1f");
}

/** The shape a pairing needs; deliberately narrower than a line item. */
export interface PairableItem {
  readonly uid: string;
}

/** {@link PairableItem} that also carries a path. */
export interface PathedItem extends PairableItem {
  readonly path?: readonly string[] | undefined;
}

/**
 * A uid that identifies more than one row on at least one side, so the k-th
 * occurrence pairing is a guess rather than a fact. Reported, never silently
 * resolved.
 */
export interface AmbiguousPairing {
  uid: string;
  /** Occurrences of this uid among the `from` side's rows. */
  fromOccurrences: number;
  /** Occurrences of this uid among the `to` side's rows. */
  toOccurrences: number;
}

/** @see {@link pairItemsByUidOccurrence} */
export interface UidOccurrencePairing<A, B> {
  /** The `to` row each `from` row pairs with, keyed by object identity. */
  forward: Map<A, B>;
  /** The `to` rows some `from` row claimed. */
  matched: Set<B>;
  /** Uids whose pairing is a guess. */
  ambiguous: AmbiguousPairing[];
}

/**
 * Pair two item arrays by **`(uid, k-th occurrence in document order)`**.
 *
 * Both arrays must already be filtered to the population being paired — this
 * function applies no type predicate of its own, because its two callers pair
 * different populations (`isLineItemType` for the invoice structure adoption,
 * `isFulfillableItem` for the fulfillment sync) and a hidden default would be
 * wrong for one of them.
 *
 * `forward` is keyed on the `from` row's **object identity**, so a caller that
 * needs to address the result by uid or path derives that itself — see
 * {@link mapPathsAcrossRebuild}.
 *
 * ⚠️ **A `from` row whose uid appears on the `to` side but whose occurrence is
 * exhausted still CONSUMES a cursor position.** Three order lines of one uid
 * against one invoice line pair the first and leave the second and third
 * unpaired, rather than re-pairing the same invoice row three times. That is
 * `adoptOrderDividerStructure`'s long-standing behaviour and it is preserved
 * deliberately.
 *
 * @param from - The driving array, walked in document order
 * @param to - The pool paired against, bucketed in document order
 * @returns The pairing, the rows it consumed, and the uids it guessed at
 */
export function pairItemsByUidOccurrence<A extends PairableItem, B extends PairableItem>(
  from: readonly A[],
  to: readonly B[],
): UidOccurrencePairing<A, B> {
  const toByUid = new Map<string, B[]>();
  for (const it of to) {
    const bucket = toByUid.get(it.uid);
    if (bucket) bucket.push(it);
    else toByUid.set(it.uid, [it]);
  }

  const fromCounts = new Map<string, number>();
  for (const it of from) fromCounts.set(it.uid, (fromCounts.get(it.uid) ?? 0) + 1);

  const cursor = new Map<string, number>();
  const forward = new Map<A, B>();
  const matched = new Set<B>();
  for (const row of from) {
    const bucket = toByUid.get(row.uid);
    if (!bucket) continue;
    const k = cursor.get(row.uid) ?? 0;
    cursor.set(row.uid, k + 1);
    const match = bucket[k];
    if (!match) continue;
    forward.set(row, match);
    matched.add(match);
  }

  const ambiguous: AmbiguousPairing[] = [];
  for (const [uid, bucket] of toByUid) {
    const fromOccurrences = fromCounts.get(uid) ?? 0;
    if (fromOccurrences === 0) continue;
    if (bucket.length > 1 || fromOccurrences > 1) {
      ambiguous.push({ uid, fromOccurrences, toOccurrences: bucket.length });
    }
  }

  return { forward, matched, ambiguous };
}

/** @see {@link mapPathsAcrossRebuild} */
export interface RebuildPathMap {
  /** Where a row that sat at `fromPath` sits in the `to` array, if it survived. */
  toPath(fromPath: readonly string[] | undefined): readonly string[] | undefined;
  /** Where a row that sits at `toPath` sat in the `from` array, if it existed. */
  fromPath(toPath: readonly string[] | undefined): readonly string[] | undefined;
  /** Uids whose pairing is a guess. */
  ambiguous: AmbiguousPairing[];
}

/**
 * The prev → next path correspondence across a rebuild, both directions.
 *
 * This is the instrument for the question *"is this projected row NEW, or is it
 * a row that MOVED?"* — which a path-string lookup answers wrongly the moment a
 * divider is added, renamed or removed. A lookup that misses reports a moved row
 * as new, and every downstream decision keyed on that answer inverts:
 * a picker's substitution is undone, an operator's quantity override is
 * discarded, a carry-forward reverts a line to its product default.
 *
 * ⭐ **`undefined` means "this path pairs with nothing", and the caller must
 * decide what that means.** It is genuinely ambiguous here — a row that is new,
 * a row that was deleted, and a row whose uid ran out of occurrences all reach
 * it — and only the caller knows which of those its own surrounding state can
 * distinguish. Callers fall back to the identity mapping (`?? path`), which
 * degrades to the pre-#897 behaviour rather than to something new.
 *
 * @param from - The previous array, already filtered to the paired population
 * @param to - The next array, already filtered the same way
 * @returns Both lookups plus the ambiguity report
 */
export function mapPathsAcrossRebuild<A extends PathedItem, B extends PathedItem>(
  from: readonly A[],
  to: readonly B[],
): RebuildPathMap {
  const { forward, ambiguous } = pairItemsByUidOccurrence(from, to);

  const toByFrom = new Map<string, readonly string[]>();
  const fromByTo = new Map<string, readonly string[]>();
  for (const [fromRow, toRow] of forward) {
    // A row with no path on either side pairs, but states no correspondence —
    // `[]` is not a location, and admitting it would map every unpathed row onto
    // whichever other unpathed row happened to pair last.
    if (!fromRow.path?.length || !toRow.path?.length) continue;
    toByFrom.set(pathKey(fromRow.path), toRow.path);
    fromByTo.set(pathKey(toRow.path), fromRow.path);
  }

  return {
    toPath: (p) => (p?.length ? toByFrom.get(pathKey(p)) : undefined),
    fromPath: (p) => (p?.length ? fromByTo.get(pathKey(p)) : undefined),
    ambiguous,
  };
}
