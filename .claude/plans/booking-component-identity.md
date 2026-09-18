# Component-signature-aware Booking identity, and the merged fulfillment/pick-sheet surface

Cross-repo: this plan's identity fix lives in `core` (schema/id shape) and `api-cloudrun`
(writers, migration script); the merged surface it enables is `manager`-side work, built once the
identity fix has deployed. See `Critical files` below for the full per-repo file list.

## Context

This started as "add a combined table to `/pick-sheet`." It isn't that anymore. The user wants
`/fulfillment/:id` (order-scoped, full editing including substitution) and `/pick-sheet`
(org-/destination-scoped, spanning many orders) collapsed into **one surface**. Building that on
today's data model runs straight into a real bug, not a UI gap: `Booking` aggregates one row per
`(order, product, destination)`, and its Firestore id is a **deterministic composite**,
`{uid_order}:{item uid}:{uid_destination}` (`core/src/schemas/_uid.ts`). `item.uid` is the bare
product id and — per root `CLAUDE.md`'s own standing invariant — **repeats within one document,
in 18% of prod orders**, because an order's `items[]` can hold the same product standalone, as a
component of kit A, as a component of kit B, or split via `splitItem`. None of that is captured
by the id formula, so every one of those differently-configured occurrences collapses onto the
*same* booking document today. The existing mitigation, `chooseBookingOwner`
(`core/src/utils/pick-sheet-fold.ts`), is a heuristic tiebreak that picks one occurrence to show
controls on — its own docblock documents a real prod incident (order 961: four
differently-parented occurrences of one product, the old tiebreak handed all their units to one
display row, which then showed a fully-checked-out booking as still "Reserved").

This is also, plainly, how the codebase arrived at its current shape: every time this ambiguity
got hit, another read-side coping mechanism got built next to it instead of the identity model
getting fixed — `chooseBookingOwner`, `joinBookings`, the original (now-retired) manager-side
pick-sheet fold, api-cloudrun's own fold, all independently managing one unfixed ambiguity. The
user was explicit: **"i dont want to go in steps, thats how we got all this divergent
functionality in the first place."** This plan is therefore one coherent design — the identity
fix and the merged surface built on it — not a "ship a stopgap now, fix the root cause later"
sequence. Where a live Firestore migration genuinely forces an execution order (code must deploy
before it can write a new shape — `z.strictObject` allows no other direction), that's stated
plainly as *execution sequencing within one committed design*, which is a different thing from
scope deferral, and is called out as such below.

## 1. The disambiguating signature

**Ancestry is not a separate fact — it's a pure filter of `path`, nothing else.** For an item
occurrence at `items[i]` with `path` (self-inclusive):

```
componentAncestry(path) = path
  .filter(seg => isProductShaped(seg))   // keep only product-uid segments
  .slice(0, -1)                          // drop the item's own trailing uid
```

`isProductShaped` needs no external context — `ItemUid`'s own grammar (`core/src/schemas/_uid.ts`)
already discriminates the segments: a bare `z.uuid()` is always a divider (its own carve-out note:
"divider-item uid (native `z.uuid()`)"), a bare `FirestoreId` or `custom-`-prefixed uid is always a
product. So `componentAncestry` is derivable from `path` alone, everywhere `path` is available —
no `structuralUids` set has to travel alongside it. This is the same relationship `path` already
has with `getParentProductUid`/`getItemDepth`: one stored fact, several pure-function views of it,
never a second stored field per view.

The full root-to-leaf ancestor chain, not just the immediate parent — this is what distinguishes
"component of kit A" from "component of kit B nested two deep." `path` construction forces one
walk from root, so there's no ordering ambiguity to resolve. Two occurrences are:

- **the same booking (fungible)** iff `componentAncestry` matches exactly.
- **genuinely different bookings** iff the ancestor chains differ at any position.

**Group-divider identity is deliberately excluded** from the signature — this is what makes
`splitItem` output (confirmed to clone the whole subtree, proportionally rescaled, into a new
sibling group) resolve to the same signature as the original, correctly staying merged. Order
961's four differently-*parented* occurrences already disambiguate correctly under this rule
(four distinct single-element chains) — this is not a new heuristic tuned to that incident, it's
the general case the incident was a symptom of.

**Resolved.** The real mover is `splitOrderItem` (`manager/src/stores/orders.ts:559`), reached via
`handle.splitItem`. It clones the source item's whole subtree (`getItemSubtreeRange`) into a new
sibling group, and every clone is built as `{ ...origLine, quantity: newQty }` — a shallow spread
that **reuses the original `uid`**, only overwriting `quantity`. The function's own comment
confirms this is deliberate: *"Clones deliberately reuse the source subtree's uids
(same-uid-at-two-paths)."* Only the new enclosing **group** divider gets a freshly minted uid
(`newGroupUid = crypto.randomUUID()`); every product/component uid inside the cloned subtree is
preserved. Since `componentAncestry` strips structural (group/destination) segments and keeps only
product uids, a split clone's ancestry is identical to the original's — group-divider identity was
already excluded from the signature for exactly this reason (§1 above), and this confirms it holds
for the whole nested kit tree, not just the split root: a cloned kit's own components keep their
original uids too, so their ancestry (`[...,sourceProduct.uid]`) is unchanged.

⚠️ **One real asymmetry, worth noting rather than treating as settled-and-forgotten:**
`splitOrderItem` always inserts the new group (and its clones) as a **top-level** sibling within
the destination — `working = [...before, ...updatedSubtree, ...afterSubtreeUntilDestEnd, newGroup,
...clones, ...after]`, unconditional on where the split *source* sat. So splitting a **top-level**
product's quantity produces a fungible clone (ancestry unchanged, correctly merges) — the common
case, and the one `SplitQuantityPopover` is normally reached from. Splitting a **nested
kit-component** row (if ever exposed there) would produce a clone whose ancestry changes from
`[...,kitProduct.uid]` to `[]`, because the clone lands as a new top-level group rather than
staying nested under its original kit — a genuinely different booking, correctly, not a bug: a
component pulled out and re-grouped on its own really is a different physical/logical draw than
one still nested inside its kit. **Confirmed reachable, not hypothetical:** `OrderItemRow.tsx`/
`InvoiceItemRow.tsx` gate `SplitQuantityPopover` only on `!disabled() && !isCustom() &&
!isTransactionFee() && item.type !== "surcharge" && !isZeroPriced() && quantity > 1` — nothing
excludes a nested (non-zero-priced) kit-component row. So this asymmetry will actually occur, not
just in principle; downstream language should say "fungible for a top-level split" rather than
"fungible," full stop.

## 2. Where it lives

`BookingId` widens, but **only for the minority of bookings that are actually ambiguous** — a
top-level (non-component) occurrence's ancestry is always `[]` (§1), so paying an id-shape cost
for every booking would be pure overhead. Sparse form:

```
BookingId =
    {uid_order}:{item uid}:{uid_destination}                     // top-level occurrence — UNCHANGED, byte-for-byte
  | {uid_order}:{item uid}:{uid_destination}:{signature_hash}    // component occurrence — NEW, 4th segment
```

`signature_hash` = first 12 hex chars of `sha256(ancestry.join(SEP)`, where `SEP` is the ASCII Unit Separator (U+001F))` — which can't appear
in any `ItemUid`-shaped segment, so the join is unambiguous. A hash, not the raw joined chain,
keeps the id bounded regardless of nesting depth — same shape of choice as `registerDocId`'s
20-hex-char SHA-256 truncation (`api-cloudrun/src/services/templates/publishFromMerge.ts`, cited
in `_uid.ts`), just shorter since this doesn't need to satisfy `FirestoreId`'s exact 20-char form.

**Why this is better than either "always 4 segments" or storing raw `path`, both rejected:**
- Always emitting the 4th segment (even empty) would mean every one of the ~7,266 bookings changes
  shape; the sparse form means **every non-kit-component booking keeps its exact current id and
  needs zero migration** — the blast radius is exactly the set that's actually ambiguous, nothing
  wider.
- Raw `path` was considered and rejected: it bakes in the destination/group **divider** uid, which
  (a) must never enter booking identity — group membership is a toggleable *display* fold (§4),
  not a physical-identity fact, and baking it in would make two same-configuration occurrences
  under differently-named groups wrongly non-fungible; and (b) divider uids are randomly minted
  per document and never repeat across orders, so a raw-`path`-based identity could never be
  cross-order-comparable at all — which defeats the entire reason for doing this (the merged
  row's grouping key in §4 depends on ancestry being comparable across documents). Ancestry is
  `path` stripped down to only the part that *is* comparable: product uids alone.

**Store only `component_signature_hash` — not `path`.** An earlier draft of this plan also stored
`Booking.path`, "refreshed opportunistically on any write that touches the booking," for
informational/debugging value. Checked against the actual write path and dropped: `consolidateItems`
already strips `path` before `getChangedItems` (`api-cloudrun/src/lib/orderHelpers.ts`) ever runs
its diff — a pure group reassignment (same product, same destination, same ancestry, different
group) is invisible to that comparison by construction, and the booking-reconciliation propagation
rule's own `invariant` text confirms this is intentional scope, not an oversight: *"Bookings are
diffed — created, updated, or deleted based on item/status/date/destination changes"* — group was
never one of the tracked axes. So a stored `path` field would need its own new propagation trigger
to stay honest, or it would go stale exactly the way group-name staleness already does today for
every OTHER consumer of group membership.

**The fix isn't a new trigger — it's not storing the fact on `Booking` at all.** `fulfillments` is
already rebuilt wholesale on every order write (`update-order:order-to-fulfillment`, `mode:
"co-write"`, unconditional field-for-field copy inside the same transaction) — so
`fulfillments.items[].path`, and therefore group membership, is **never stale**, by a guarantee
that already exists and costs nothing new. The merged surface needs `fulfillments` regardless (item-
tree edits — substitution — need something with an item tree; `Booking` has none), so its
groups-toggle fold (§4) reads group name from `fulfillments.items[]`, never from a Booking-side
mirror. Storing `path` on `Booking` too would have been a second, independently-staleness-prone
copy of a fact `fulfillments` already keeps honest — exactly the coping-mechanism-proliferation
this plan exists to stop.

Add to `Booking` only:

```ts
component_signature_hash?: string | null;  // null for a top-level occurrence; else the 12-hex
                                            // digest of componentAncestry(item's current path) —
                                            // the one field that's actually load-bearing. It needs
                                            // to be its own indexed field (Firestore can't filter
                                            // on a value computed at read time), even though it's
                                            // mechanically a pure function of the item's `path`.
```

⚠️ **`?:`, not required — a correction found while implementing, not in the original draft.**
`BookingSchema` is `z.strictObject`, and ~7,266 bookings stored before this field existed carry no
such key at all. A fork verified (2026-09-18) that nothing in api-cloudrun or manager read-parses a
stored `Booking` through this schema — every read is a bare TS cast — so a required key would not
throw on read; but the TS type would still assert a shape ~7,266 documents don't have, which is
exactly the defect class `core/CLAUDE.md`'s "Making a field REQUIRED" section exists to prevent:
measure the corpus and let the writer populate it BEFORE tightening, not in the same commit that
introduces the field. Catalogued in `tests/stored-optionality.test.ts` as `mid-expand`. Tighten to
required once §3.3's backfill has run.

**Why this can't go stale — proven by the actual write-gate mechanism, not an opportunistic-refresh
promise.** The booking-write gate (`writableEntries` in `api-cloudrun/src/services/orders.ts`) has
three arms — `changed` (the `getChangedItems` diff, which can't see a pure path/group move, per
above), `!bookingByUid.has(e.bookingId)`, and `movedPrepped`. Under the widened `consolidateItems`
(keyed on `(item.uid, signatureHash)` instead of bare `item.uid`, §3.2), an ancestry-changing edit
produces a genuinely different booking id — so the **second** arm fires regardless of whether
`changed` did, because that id simply isn't in the existing-bookings map yet. The old id falls out
of the id-set diff and gets orphaned/canceled through the same existing mechanism. So
`component_signature_hash` staying correct doesn't depend on any write-gate widening at all — an
edit that would make it wrong is, by construction, an edit that produces a different document.

The destination segment's position and meaning are untouched — this doesn't repeat the earlier
destination-uid-move incident that produced 552 duplicate bookings (a segment's *meaning* moving
under a stable-looking id); here the destination segment keeps its exact meaning and position, and
the new segment is additive and conditional.

**`MovementId` consequence — permanent, not transitional.** `MovementId` embeds `BookingId`
verbatim as one union arm, and `transactions` is an append-only journal — a historical movement's
stored id is a fact about what the subject's id *was at the time*, never rewritten. So
`MovementId`'s subject arm becomes, and stays forever, a union of the 3- and 4-segment forms: old
journal rows legitimately keep the 3-segment shape indefinitely for bookings that existed before
this ships. There's no later step that retires the old shape — both stay valid permanently,
depending on when the movement was recorded. Audit for any `split(":")` on a `BookingId` string as
part of the vocabulary survey below — a naive 3-way split silently breaks on a 4-segment id.

`stores`/`query_by_uid_store`/`query_by_uid_location` need no shape change — they're per-document,
computed by `allocateBookingToStores` against that booking's own quantity; disaggregating a merged
booking into signature-distinct ones just means that allocator runs once per new document instead
of once for the old merged total, and the sum is unchanged (`stock/{P}` is keyed by product, not
booking, so net availability is unaffected — worth a targeted regression check, not a redesign).

## 3. Migration

### 3.1 Measure first — DONE, and the answer changes §5's sizing

Firestore can't answer "how many bookings aggregate 2+ genuinely different configurations" with a
query — built and ran `api-cloudrun/scripts/audit-booking-identity-collisions.ts` (read-only, both
envs, self-test proves the detector fires before touching real data). Walks `fulfillments.items[]`
grouped by `(item.uid, deliveryUid)` per the writer's own forward destination-walk (restated from
`api-cloudrun/src/lib/orderProjection.ts`'s `bookableLines` without its dedupe, so per-occurrence `path`
survives), flags groups whose occurrences carry more than one distinct `componentAncestry`.

**Measured against prod (2026-09-18):** 1,033 fulfillments scanned, **332 colliding `(order,
product, destination)` groups** — **37 non-terminal**, 295 on `complete` orders (read-only
history, correctly left alone). Dev tracks within 4 (328/33) — expected, since `mirror-top-level`
replicates prod writes into dev near-real-time, not a discrepancy to chase.

**Spot-checked genuine, not an audit-script artifact:** `orders/0nqm8igLxfyz6HFQrU6z`, product
"25' Extension Cord" — one occurrence nested under "Pipe & Drape (2 Rooms)" (qty 2), a second under
"Hair & Makeup Mirror" (qty 1), both today collapsed onto one booking (`quantity: 3`).

**The §3.3 "unverified, flag before relying on it" custody-apportionment question is now
resolved, not open — and it resolves unfavorably.** Added a custody-commitment pass to the audit
script (batch-`getAll` the 37 non-terminal collisions' existing booking documents, check
`breakdown` for any `prepped`/`out`/`returned`/`lost`/`damaged` unit). **26 of 37 (70%) are
custody-COMMITTED**, not quoted/reserved-only. Checked the worked example's actual history
(`transactions` query on that booking): one `prep` + one `check_out` movement, quantity 3,
`breakdown.out: 3` — and the movement's `lines[]` records only `{quantity, location: {from, to}}`,
**never which item occurrence a unit belonged to**. There is no historical record anywhere that
says which 2 of the 3 checked-out units were for the Pipe&Drape context and which 1 was for
Hair&Makeup — the journal was never designed to carry that, because the booking it's about was
never disambiguated in the first place. **This is not a script that needs to be smarter; the
information to auto-split does not exist.** 26 collisions need a human decision (which occurrence
the committed units belong to, or an explicit "split unknown, assign arbitrarily and flag"
convention the owner signs off on) — §3.3's `recomputeOrderBookings` cannot correctly guess this,
and should not try to. Only the remaining 11 (quoted/reserved-only) are safe to auto-apportion by
ordered quantity.

For every flagged collision the script also classifies genuinely-fungible (false positive, one
signature, not counted above) vs. genuinely-colliding, and terminal vs. **non-terminal** (draft/
canceled/complete orders are read-only history and are deliberately left alone — no operational
value in touching them). **This measurement decides the real size of the project** — say which band, once
measured, rather than assuming either (§5 expands the two bands).

Also, as part of this same step: **grep every place a `BookingId` is hand-constructed rather than
built through one shared function** — this is the "survey every closed vocabulary before cutting
the beta" step `cfs-release-order` requires, and it matters more than usual here because three
independent constructors already exist (`bookingId()` in `api-cloudrun/src/services/orders.ts`,
`bookingUidFor()` in `core/src/utils/pick-sheet-fold.ts`, `bookingUidForItem()` in
`manager/src/utils/orderBookingJoin.ts` — `core`'s own `bookingUidForItem` and `manager`'s
`joinBookings` both correctly delegate to a shared function already, confirmed by reading them;
only these three actually construct an id from parts) — three re-implementations of one derivation
is the exact pattern that let this defect class exist in the first place, and the fix must not add
a fourth. Consolidate all three onto one shared builder (`core/src/utils/booking-id.ts`, new) as
part of step 3.2, not after.

**Survey done — a real, concrete finding, not a hypothetical the "naive 3-way split" warning in §2
was hedging against.** `api-cloudrun/src/lib/bookingDestination.ts` has two functions that parse a
`BookingId` string by hand and both **require exactly 3 segments**:

- `bookingDestUid(bookingId)` — `parts.length === 3 && parts[2] !== ""`, else `null`. Feeds
  `isStrandedBookingId`/`classifyStrandedBookings`, which back
  `api-cloudrun/scripts/repair-missing-bookings.ts`,
  `api-cloudrun/scripts/cleanup-orphan-bookings.ts`, and
  `api-cloudrun/scripts/audit-order-projection.ts`'s booking-side arm.
  Under the new scheme, **every 4-segment (kit-component) booking id returns `null` from this
  function unchanged**, which makes `isStrandedBookingId` return `false` unconditionally for it —
  the orphan-detection/repair machinery would go silently blind to exactly the class of booking
  this migration exists to disambiguate.
- `pairRepointedBookings(orphanIds, newIds)` — both loops `continue` on `parts.length !== 3`. This
  is the function `updateOrder`'s reconciliation uses to carry a booking's custody `breakdown`
  forward across a destination change (keyed by `(order, product)`) instead of seeding it from
  nothing — its own docblock documents the exact bug this prevents (api-cloudrun#724: a destination
  change on a booking with no match seeds custody from `undefined`, and a `complete` order ends up
  reporting `returned: quantity` with no event log). Under the new scheme, **every kit-component
  booking's destination change would silently skip repointing and hit that exact bug again.**

**Required fix, same commit as the id-shape change:** both functions parse by fixed position, and
under this design the destination segment's position never moves (§2 — the new segment is
appended *after* destination, not inserted before it), so the fix is a one-line arity widening in
each — `(parts.length === 3 || parts.length === 4)` instead of `parts.length === 3` in
`bookingDestUid`; `(parts.length === 3 || parts.length === 4)` instead of `!== 3` (i.e., don't skip
on 4 either) in `pairRepointedBookings`, still reading `parts[0]`/`parts[1]` for the pairing key.
**Also worth doing in the same edit, not required for correctness:** widen `pairRepointedBookings`'
pairing key from `(order, product)` to `(order, product, signature)` — the coarser key is still
*safe* post-migration (the function declines ambiguous pairs rather than guessing, per its own
stated philosophy), just less precise than it could be once a product can genuinely have several
independent booking identities on one order.

`api-cloudrun/scripts/audit-order-projection.ts` has a third hand-parse (`d.id.split(":")`, line ~433) that only
reads `parts[0]`/`parts[1]` with no length check at all — already arity-tolerant by construction,
confirmed safe, no fix needed.

### 3.2 Writer changes

All compute `componentAncestry`/`signature_hash` from data already in scope at each call site —
threaded parameters through one new shared builder, not new algorithm, and not three parallel
re-implementations:

- **New `core/src/utils/booking-id.ts`** — `componentAncestry(path)` (the pure filter from §1),
  `componentSignatureHash(path)` (hashes `componentAncestry(path)`, `null` when it's empty), and
  `buildBookingId(orderUid, item, path, destUid)` (calls the above, picks the 3- or 4-segment
  form). The one place this logic lives — no caller needs a separate `structuralUids` argument,
  since `componentAncestry` reads it off `path`'s own uid shapes.
- `core/src/utils/orders.ts` — `consolidateItems` groups by `(item.uid, signatureHash)` instead of
  bare `item.uid`; `ConsolidatedItem` gains the signature so callers downstream (`buildPackingList`,
  `buildPackingListForLeg`) emit the right rows with no further edit, since they already delegate
  to `consolidateItems`.
- `core/src/schemas/_uid.ts` / `core/src/schemas/booking.ts` — `BookingId` widened per §2,
  `Booking.component_signature_hash` added.
- `core/src/utils/pick-sheet-fold.ts` — `bookingUidFor` calls the shared builder instead of its own
  inline template.
- `manager/src/utils/orderBookingJoin.ts` — `bookingUidForItem` calls the shared builder;
  `countProductOccurrencesInDestination` (currently over-counts by product alone) must key on
  product+signature or it re-introduces the same conflation this migration removes.
- `api-cloudrun/src/services/orders.ts` — `bookingId()` becomes a thin call to the shared builder;
  `buildBookingIdMap` and the substitution X/Y netting block (which independently derives
  booking-id pairs) both flow through it too, so a substitution between two differently-configured
  occurrences of the same product doesn't collapse either.
- Write both writer and reader halves against a **local, unpublished** core (`file://` import in a
  throwaway probe) before cutting the beta, per `cfs-release-order`'s "a survey sees a name, never
  a type" lesson — exercise the new shape with real code before publishing it.

### 3.3 Existing documents: reconciliation, not a bespoke re-key script

**No bespoke booking-rewrite script is needed — this leans on machinery that already exists.**
`api-cloudrun/src/services/orders.ts` already implements, on every order write, a diff between the
bookings the current order state implies (`newBookingIdMap`) and the bookings that actually exist,
creating what's missing and canceling what's orphaned (the api-cloudrun#873/#882 reconciliation
machinery). Once the id formula changes, **the next write to any order naturally retires its old
aggregated booking and creates the correctly-disambiguated replacements, with zero new
booking-rewrite code** — the current state no longer implies the old id, and now does imply the
new ones.

The actual gap is orders that never get touched again — they keep a stale-but-still-valid
aggregated booking indefinitely (not wrong, since `chooseBookingOwner` still handles it exactly as
before; just not improved). Closing that gap needs two small, real changes, not a migration script
with its own transaction logic:

1. **Extract the reconciliation into a standalone callable.** It currently lives inline inside the
   `updateOrder` transaction. Factor `recomputeOrderBookings(orderUid): Promise<{created, canceled}>`
   out, callable independently of a full order edit — genuine production code (worth landing as its
   own reviewed change before anything depends on it), not migration-script glue.
2. **It must not touch `order.version` or any Xero/CRMS-relevant field** — only read the
   order/fulfillment and write to `bookings` — so it doesn't trigger the Xero/CRMS fan-out a normal
   `updateOrder` bulk pass would (`api-cloudrun/CLAUDE.md`: "a bulk write to orders that bumps
   version fans out to Xero for EVERY one of them").

Then a thin backfill script — not yet written; plan to add it at
`api-cloudrun/scripts/` as `backfill-booking-signature-reconciliation.ts` once §3.2 lands —
dry-run default, `--write`, calls `recomputeOrderBookings` once per **non-terminal order** in
§3.1's flagged set, batched, verified by re-running the audit script and asserting zero remaining
ambiguous multi-signature bookings among non-terminal orders. **Per §3.3's custody-commitment
finding, it needs a `--review-queue` mode**: before calling `recomputeOrderBookings` on a flagged
order, check whether any of its colliding bookings carry committed custody (the same check the
audit script's custody pass already does) — clean ones proceed automatically, committed ones are
written to a review file instead and skipped until a human resolves them (re-run with an explicit
per-occurrence assignment, or an accepted "unknown, assign to X" override).

**`transactions` history needs no correction-entry append.** Because most bookings never move at
all (only kit-component ones with an actual collision do, and only on their next touch), and
because `MovementId`'s dual-shape union is permanent by design (§2), old movement rows simply keep
referencing whatever booking id was current when they were recorded — there's no "carried forward"
pointer to invent, and nothing to reconcile on the journal side.

**Resolved by §3.1's measurement — and it resolves unfavorably.** 26 of the 37 measured
non-terminal collisions carry committed custody, and the worked example's own `transactions`
history proves the split is genuinely unrecoverable: the movement journal records
`{quantity, location}` per event, never which item OCCURRENCE a unit belonged to, because the
booking it's about was never disambiguated. So `recomputeOrderBookings`'s plain create/cancel
diff — correct for every collision-free booking, and for the 11 quoted/reserved-only collisions
(safe to auto-apportion by ordered quantity) — **must not run unattended on the 26
custody-committed ones.** It needs a `--review-queue` mode: detect a collision whose existing
booking carries committed custody, DO NOT auto-split it, and instead emit a row for a human to
resolve (which occurrence the committed units belong to, or an explicit "unknown, assign
arbitrarily" call the owner signs off on) before `recomputeOrderBookings` proceeds on that one.
This is now a concrete backfill-script requirement, not an open question.

### 3.4 The one place execution order is forced, and why that's not "steps"

`BookingSchema` is `z.strictObject` — under that, the deployed reader must exist before anything
writes the new shape (no safe direction otherwise). So, strictly in dependency order:

1. Publish one `@cfs/core` beta with the widened `BookingId`, `Booking.component_signature_hash`,
   the shared `booking-id.ts` builder, and the updated `consolidateItems` — reader and writer
   halves together, so this isn't a "ship the type, forget the writer" beta.
2. Bump and deploy `api-cloudrun` (dev automatic, prod via its release PR) — the build that can
   both read the wider shape and write it. New-shape documents must not exist before this deploys,
   or an older still-running revision fails to parse them.
3. Land `recomputeOrderBookings` (§3.3) and run the backfill against prod's flagged non-terminal
   orders — **only once step 2 is live**, since the backfill's writes are exactly the new-shape
   documents step 2's deploy has to precede.
4. Bump and deploy `manager` — needed before the merged surface can be built (it reads
   `component_signature_hash`, and reads group name off `fulfillments.items[]`), not before the
   identity fix itself.
5. `chooseBookingOwner`/`joinBookings` simplification (§3.5) ships in the same betas as steps 1/4
   — it's a pure function change with no data dependency, no reason to split it out.

This is the unavoidable mechanics of landing one atomic decision on a live collection with
independent release trains on either side of it — the design itself (signature, id shape, writer
changes, reconciliation mechanism, permanent `MovementId` dual-shape) is fully decided before step
1, not discovered later.

### 3.5 `chooseBookingOwner` / `joinBookings` after the fix

Kept — **NOT simplified in the core-only commit that lands §3.2**, which corrects this section's
original plan. `splitItem` output still legitimately puts multiple *rows* under one booking, so a
read surface still needs to pick which row carries the controls. The "structural parentage as
override" arm does become genuinely unreachable through `foldPickSheet`/`bookingOccurrencesByBooking`
the moment `bookingUidFor` is ancestry-aware — a same-`uidBooking` bucket can now only ever hold
occurrences that already share `componentAncestry`, hence share `isStructural` — **but
`chooseBookingOwner` is `export`ed specifically because `manager/src/utils/orderBookingJoin.ts` calls
it too, and manager still builds its `uidBooking` the OLD (non-ancestry-aware) way until its own
§3.2 bullet lands.** Simplifying the exported function in core alone, ahead of manager's matching
update, would ship a core version whose `chooseBookingOwner` silently regresses manager's display
(prod order 961's bug) the moment manager bumps its pin — before manager's own writer changes are
even in flight. **Do the simplification in the SAME beta wave as manager's update (this step's own
original point, restated correctly)**, not preemptively. `joinBookings` needs only the id-formula
update — it already delegates correctly.

## 4. The merged surface, built on the fixed identity

With disambiguated identity, a merged row's "how many bookings does this represent" question has
a factual answer, and a substitution has real per-occurrence targets instead of one blurred
aggregate.

**Row model.** A merged row = one `(uid_product, uid_destination, component_signature_hash)` group,
scoped to one order (today's `FulfillmentDetail`) or across orders (today's `/pick-sheet`) — the
same fold, generalized, using the disambiguated booking id as the join key throughout. No new path
is minted; the merge only groups existing paths (per the standing `cfs-items` rule).

**Groups become a toggleable, name-keyed axis of that same merge key** — read from
`fulfillments.items[]` (never mirrored onto `Booking` — see §2's reasoning for why that field
would be independently stale), since group membership is inherently per-document:
- **Groups ON**: fold key includes the group's **name** (not uid — uids don't cross documents;
  reuse the exact pattern `groupPickSheetSections`/`pickSheetCart` already use for
  `destinationName`/`organizationName`). `[group a, chair]` and `[group b, chair]` stay separate
  rows.
- **Groups OFF**: fold key drops group entirely — only product + component ancestry. The two
  chairs above merge into one row.

⚠️ **Named follow-up, out of scope here:** `group` (`core/src/schemas/_dividers.ts`'s
`GroupDividerArm`) is a bare free-text `name` with nothing distinguishing a catalog-category use
("Hair & Makeup", "Tables & Chairs") from an ad hoc physical-sub-location use ("2nd Floor",
"Rehearsal Room") — confirmed no schema anywhere models a customer-destination sub-location
(`Booking.stores`/`BookingStoreLocation` is CFS's own warehouse shelf location, unrelated).
The groups toggle works identically either way, so this doesn't block the feature — but it's a
real modeling gap worth its own follow-up, not something to silently treat as "groups are just
catalog labels" going forward.

**Cross-order substitution allocation — a real, buildable mechanism, not an open question.**
`core/src/utils/allocation.ts`'s `allocateBookingToStores`/`drawFromLocationsForBooking` already
solve the structurally identical problem (distribute a quantity across an ordered set of targets,
each with its own capacity, greedily, returning `shortage` rather than throwing) for physical
locations. Mirror that shape for bookings:

```ts
export interface SubstitutionTarget {
  uid_booking: BookingId;
  quantity_available_to_receive: number;
  due_at: string | null;
}
export function allocateSubstitutionAcrossBookings(
  targets: readonly SubstitutionTarget[],
  quantity: number,
): { allocations: Array<{ uid_booking: string; quantity: number }>; shortage: number }
```

- **Ordering: soonest-due-first** — reuse the existing `sortSections`/`compareDue` convention
  already governing pick-sheet row order, not a new rule.
- **FIFO fill**, walking sorted targets, `min(remaining, capacity)` per target, reporting
  `shortage` rather than silently refusing.
- **This is a default, not the mechanism.** The merged row's substitute action computes this
  allocation to pre-fill an expandable per-line editor — one row per contributing booking
  (order + occurrence) — and the operator adjusts any line before confirming. The actual write
  stays N independent per-booking substitution calls (the existing within-order X/Y netting
  machinery, one booking at a time); the allocator only proposes the starting split. This only
  works because each contributing line is now an unambiguous, individually-addressable booking —
  before the §1-§3 fix, there was nothing correct to pre-fill from.

**What doesn't change:** `chooseBookingOwner` still picks which row of a still-legitimately-
multi-row (post-`splitItem`) booking carries controls; the `bookings`-for-membership /
`fulfillments`-for-rows split stays exactly as documented in `pick-sheet-fold.ts` today — that
split is orthogonal and already correct. `BulkBookingUpdateInputType` (`core/src/schemas/booking.ts`)
already accepts an array of per-booking updates sharing one `uuid_session` — the merged row's
custody-action fan-out composes this existing shape client-side (group dispatches by
`uid_fulfillment`, one array per order) rather than inventing a new bulk-mutation primitive; the
only new server surface is a thin orchestrator around the existing per-fulfillment bulk endpoint.

**This replaces `/pick-sheet` and `/check-in` as separate routes, not just adds to them.** Once
the merged surface exists at order/org/destination scope with the full bucket-column/action-button
machinery, those two routes (and the checkout cart embedded in `/pick-sheet`) are a narrower slice
of what it does — keeping them as parallel screens would be the same coping-mechanism-proliferation
pattern this whole plan exists to stop, moved into routing. Two things do NOT disappear with the
routes, though:
- **`submitCheckouts`/`submitReturns`** (the dedicated cross-order endpoints, one shared
  `uuid_session` across the whole selected batch) get called BY the merged surface's checkout/return
  actions specifically, instead of the generic per-order fan-out — the fan-out mints a session per
  order and loses that one-shared-session property, which checkout/return are worth keeping. Route
  gone, write path underneath reused, not replaced.
- **The printable pick-sheet document** (`GET /pick-sheets`, server-side `foldPickSheet`) stays —
  it's a PDF/print consumer via `DocumentsMenu`, unrelated to whether a live screen exists.
- Entry points that link into the old routes today (`FulfillmentPage.tsx` roll-up rows,
  `FulfillmentContextRails.tsx`, `OrganizationDetail.tsx`'s embedded doc source) need repointing to
  the merged surface as part of this work, not left dangling.

## 5. Cost and risk

Real production-data migration on money-adjacent custody state, 7,266 live booking documents, no
dev-twin exemption (ordinary Firestore — dev exists to rehearse against and tracks prod closely
via mirroring, but prod is the real risk surface). **Measured, not assumed (§3.1, 2026-09-18):
332 colliding groups, 37 non-terminal, 26 of those custody-committed with no recoverable split.**
This is the manual-review band, not the contained one — say so plainly:

- **Not a weekend migration.** 26 non-terminal collisions need a human decision before
  `recomputeOrderBookings` may touch them (§3.3) — realistically the owner reviewing each one
  against what's physically checked out today, or accepting an explicit documented convention
  ("assign committed units to the largest-ordered-quantity occurrence, flag the order for a
  physical recount") rather than pretending the split is knowable. The other 11 non-terminal
  collisions and the schema/writer work (§2-§3.2) are the "days" part; the 26-row review queue is
  the part that sets the real timeline, and it's owner-availability-bound, not engineering-bound.
- **295 terminal/complete collisions are correctly out of scope** — read-only history,
  `chooseBookingOwner` already handles their display, no operational reason to touch them. Their
  count (comparable to the non-terminal one) is still worth knowing: it says this pattern has been
  happening at a steady rate for as long as orders have been completing, not just recently.
- The design in §1-§4 doesn't change because of this number — it changes the *backfill script's
  required shape* (§3.3's `--review-queue` mode is now load-bearing, not a nice-to-have) and the
  *honest timeline* to tell the owner before starting.

## Critical files

`core/src/schemas/_uid.ts`, `core/src/schemas/booking.ts`, new `core/src/utils/booking-id.ts`
(the one shared id/signature builder), `core/src/utils/orders.ts` (`consolidateItems`,
`getStructuralUids`, `getParentProductUid`), `core/src/utils/pick-sheet-fold.ts` (`bookingUidFor`,
`chooseBookingOwner`, `foldPickSheet`), `core/src/utils/allocation.ts` (precedent + new
`allocateSubstitutionAcrossBookings`), `api-cloudrun/src/services/orders.ts` (`bookingId()`,
`buildBookingIdMap`, substitution netting, and the reconciliation block to extract into
`recomputeOrderBookings`), `api-cloudrun/src/lib/bookingDestination.ts` (`bookingDestUid`,
`pairRepointedBookings` — both currently reject a 4-segment id outright; see §3.1's survey finding,
required fixes not optional), `manager/src/utils/orderBookingJoin.ts`, new
`api-cloudrun/scripts/audit-booking-identity-collisions.ts` (built, §3.1) and a not-yet-written
`backfill-booking-signature-reconciliation.ts` in the same directory (§3.3).

## Verification

- `api-cloudrun/scripts/audit-booking-identity-collisions.ts` run against both envs **before**
  writing any migration code — its output decides §5's sizing band, and whether the manual-review
  path is needed depends on it plus the §3.3 breakdown-apportionment flag.
- `api-cloudrun`: unit tests for `bookingDestUid`/`pairRepointedBookings` (`bookingDestination.ts`)
  against a planted 4-segment id, asserting both now resolve/pair instead of silently treating it
  as unparseable — this is the regression §3.1's survey found, not a hypothetical.
- `core`: `deno task test` with planted collision/fungible-duplicate fixtures for
  `componentAncestry`/`componentSignatureHash`/`consolidateItems`/`buildBookingId`;
  `deno task check:declarations`
  (the widened `BookingId` template literal is exactly the JSR slow-types risk class this task
  exists for).
- `api-cloudrun`: integration test creating an order with a standalone-plus-two-differently-
  parented-kit-component occurrence of one product, asserting three distinct booking documents
  land, not one. A second test exercising `recomputeOrderBookings` directly on a
  custody-committed collision, asserting `breakdown` lands correctly apportioned (this is the
  test that resolves the §3.3 open flag).
- Backfill script rehearsed against dev first, with a before/after count assertion (flagged
  collisions → correctly-signatured replacement documents, quantity sums preserved) before
  touching prod.
- `manager`: merged-row fold tests for the groups-on/off toggle producing the right row split;
  `allocateSubstitutionAcrossBookings` unit tests (exact fit, shortage, single-target, empty
  targets); an e2e/Playwright pass on the merged surface substituting a quantity that spans two
  orders, confirming the pre-filled per-line split and that adjusting one line before confirming
  actually changes what's written; confirm `FulfillmentPage`/`FulfillmentContextRails`/
  `OrganizationDetail` entry points repoint to the merged surface once `/pick-sheet`/`/check-in`
  are removed.

## Status

> ## ⚠️ STATUS UPDATE 2026-09-18
>
> **§3.2's `core`-side writer changes are DONE, tested, and committed on `beta`** (not yet
> pushed/published as of this update): the shared `core/src/utils/booking-id.ts` builder
> (`componentAncestry`/`componentSignatureHash`/`buildBookingId`, with a self-contained sync SHA-256
> since the module must run in the manager's browser too — verified against `shasum` vectors);
> `BookingId` widened to the 3-/4-segment union and `MovementId`'s subject arm updated to match;
> `Booking.component_signature_hash` added; `consolidateItems` regrouped on `(uid, signatureHash)`;
> `pick-sheet-fold.ts`'s `bookingUidFor` now delegates to the shared builder. Full test coverage
> (new `tests/booking-id.test.ts`, updates to `_uid`/`orders`/`pick-sheet-fold`/`template-helpers`
> tests), `deno task check`/`lint`/`test`/`check:declarations`/`check:generated`/`audit:citations`
> all clean, `deno publish --dry-run` succeeds.
>
> **Two corrections to this doc's earlier text, found while implementing, both already folded in
> above rather than left as a diff to reconcile later:**
> 1. §2's `component_signature_hash` ships `?:` (optional), not required — `BookingSchema` is
>    `z.strictObject` and ~7,266 pre-existing bookings carry no such key; core's own
>    "Making a field REQUIRED" procedure says measure + backfill before tightening, not in the
>    same commit that introduces the field. Catalogued in `tests/stored-optionality.test.ts` as
>    `mid-expand`. A fork confirmed nothing read-parses a stored `Booking` through this schema in
>    either api-cloudrun or manager (every read is a bare TS cast), so this was a type-honesty fix,
>    not a crash-prevention one — but a real fix regardless.
> 2. §3.5's `chooseBookingOwner` simplification is **NOT done in this commit** — it is genuinely
>    unreachable through core's own two callers now, but `manager/src/utils/orderBookingJoin.ts`
>    still calls the same exported function with occurrences built from its OWN (still
>    non-ancestry-aware) id computation. Simplifying `chooseBookingOwner` here, ahead of manager's
>    matching update, would ship a core version that silently regresses manager's display (prod
>    order 961's bug) the moment manager bumps its pin. Do it in the same beta wave as manager's
>    own §3.2 bullet, not preemptively.
>
> Next concrete step: publish the `core` beta (§3.4 step 1), then api-cloudrun's bump+deploy.

Compacted 2026-09-18 (was two stacked status blocks; folded into one current statement).

**§1 and §3.1 are done, not just planned.** `splitItem`'s open question is resolved (uid-reuse
confirmed, nested-component asymmetry noted and confirmed reachable). The `BookingId`
hand-constructor vocabulary survey is done and found a real regression
(`api-cloudrun/src/lib/bookingDestination.ts`'s `bookingDestUid`/`pairRepointedBookings`, both
folded into §3.1/§3.2/Critical files/Verification as required one-line fixes). The measurement
itself is done: `api-cloudrun/scripts/audit-booking-identity-collisions.ts` is written, self-tested,
and run against both envs — **332 colliding groups in prod, 37 non-terminal, 26 of those
custody-committed with a confirmed-unrecoverable split** (§3.1, §3.3, §5). This is the
manual-review band, not the contained one, and the plan above reflects that throughout, not just
in one caveat.
