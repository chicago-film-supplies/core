# Stamp `quantity_per_parent` on kit component lines

> ## ⚠️ STATUS UPDATE 2026-10-12
> **Phase 1 and both prerequisites are DONE and in prod. Next: Phase 2.**
> - **Phase 1** — core `0ee5d79` (beta.653): every reader accepts `quantity_per_parent`;
>   `componentQuantityAt`, `kitCutQuantities`, `isDirectComponent`, `rescaleKitSubtree` /
>   `kitRootPos` in `core/src/utils/order-lines.ts`. manager-v27.49.2, api v0.346.0.
> - **api-cloudrun#1286 + api-cloudrun#1287, CLOSED in full** — core `1d713b3` (beta.654),
>   manager `c2e078bf` (27.49.3), api `45c10742` (0.346.1). One author for a line's catalog
>   facts (`deriveLineCatalogFacts`, `zeroPricedForSlot`, `catalogSlotOf`,
>   `catalogComponentAt`), the fulfillment projector in core
>   (`projectFulfillmentLine`, `fulfillmentSourceOfComponent` in
>   `core/src/utils/fulfillment-items.ts`), and the api order writer resolving each row's
>   flag before the build in `api-cloudrun/src/lib/orderLineZeroPriced.ts`.
> - ⭐ **Owner ruling 2026-10-12: `zero_priced` is a SNAPSHOT carried by row** (stored flag for
>   an existing row, the catalog slot only for a new row, never the client's). The stamp
>   already had snapshot semantics in this plan, so Phase 2 below takes the same shape —
>   confirmed for the stamp by the owner the same day.

## Problem

A kit component's per-kit quantity exists only in the product catalog
(`products/{uid}.components[].quantity`, `z.number()` — fractional by design,
`core/src/schemas/product.ts`). A document line holds only the expanded
`quantity` (`z.number().int().min(0)`), which is already `ceil(ratio × parent)`
and may be hand-edited. So every path that needs "how many of this component go
with N kits" either loads the catalog or guesses from line proportions:

- **Fulfillment "2 of 5 kits" cut** — not possible today; a kit row offers no
  action quantity (`manager/src/utils/mergedPartial.ts` module note). Line
  proportions are WRONG, not just drifty, for packing ratios: 1 mirror / 1 case
  reads as 1:1 when the rule is 0.5.
- **Kit quantity edit + merge-on-add** (`rescaleKitSubtree`,
  now `core/src/utils/order-lines.ts`; manager deleted its copy) — loads the catalog across an await
  (`manager/src/stores/kitQuantityEdit.ts`, with its stale-index / baseline machinery), and
  a catalog edit after the order was written makes every untouched component look
  hand-edited, so it silently stops following its kit.

### What the catalog numbers mean (owner, 2026-10-10)

- **Fraction < 1 = packing ratio.** 2 makeup mirrors per case → case is 0.5 on
  the mirror; ceil gives cases needed (1→1, 2→1, 3→2). Pipes cases, drape
  backpacks and other kit parents use this. Prod: ~33 of ~175 catalog component
  entries are fractional (0.5, 0.25, 0.125, 0.04, …).
- **0 = optional.** Present so `OrderItemSearchSelect` offers it; the operator
  raises it by hand. ~33 entries.

## Decision

Add `quantity_per_parent: number | null` to every component line on orders,
invoices and fulfillments.

- **Value:** the catalog `components[].quantity ?? 1`, rounded to 4 dp, at expansion.
  Relative to the DIRECT parent (as `componentQuantities` expands it). Fractional.
- **Top-level lines:** `null`. **Pre-stamp component lines:** `null` means no ratio, so the
  line reads as a mismatch. There is no catalog fallback.
- **Hand edit changes `quantity`, never the stamp.** Override becomes readable off
  the document: `quantity !== componentQuantityAt(qpp, parent.quantity)`. No stored override
  flag (consistent with the projection rule — the difference IS the signal).
- **Line items only, never bookings.** A booking merges every line with the same
  (order, product, leg, ancestry) — two groups' copies of one kit may carry
  different hand edits — so one ratio per booking is undefined. A partial custody
  move only needs a unit count per component booking, which the client derives
  from the stamped lines.
- **Rejected: one spec on the kit line** — its keys go stale when a component is
  removed, substituted, dragged or carried across a rebuild; a field on the row
  travels with the row (`splitItem`, `pairItemsAcrossRebuild`).

### The cut rule (owner, 2026-10-10)

For a kit cut to `k` of `n`, each component line (stamp `r`, quantity `q`) moves:

```
moved = min(q, ceil(r × k))      // the shared container goes with the FIRST move
```

The remainder may be short a container. That is expected: the operator adds a
second case to the fulfillment. The splitter does NOT try to keep both sides
whole. Cascades per level (a sub-kit's `k` is its own moved count). Capped again
at what the component's booking can actually move.

- **One rule for every line (owner, 2026-10-11).** If `quantity === componentQuantityAt(r, parent)`,
  the line moves `min(q, ceil(r × k))`. Otherwise it moves `ceil(q × k ÷ n)`, proportionally.
  "Otherwise" covers several cases with one rule:
  - hand edits
  - re-parented lines
  - lines built under an older catalog
  - raised optionals (r = 0)
  - pre-stamp lines (r = null)
- **Full move:** when the parent moves in full, every child moves in full. Without this, a
  hand-edited `q > ceil(r × n)` would leave units behind.
- **No writer rules.** There is no non-component refinement and nothing nulls the stamp on
  re-parent. A ratio is only ever read through its parent, so a stamp with no parent is
  inert, and a stamp under the wrong parent reads as a mismatch.
- **Substitution:** Y's root takes X's stamp (the slot rule, as `substitutionRootZeroPriced`).
  Y's subtree is stamped from Y's catalog.
- **`zero_priced` stays as is.** It is a money claim that readers use without its parent,
  so it earns its rules. The $0 re-root hole found while reviewing this plan is
  api-cloudrun#1286, which is separate work.

## Order of work

`z.strictObject` everywhere, so a reader must accept the field before any writer
emits it. Two core releases rather than one, so manager and api never have to
land together.

**Sequence (owner, 2026-10-11):**
1. Phase 1, with manager#639 items 1, 3 and 4 and manager#640 folded in. **Done.**
2. api-cloudrun#1286, then api-cloudrun#1287 — **prerequisites of Phase 2, closed in full. Done.**
3. Phase 2.
4. Phase 3.

Tracking issue: core#131. This plan closes **five** issues: core#131, manager#639, manager#640,
api-cloudrun#1286 and api-cloudrun#1287. It leaves api-cloudrun#1288, core#130 and
api-cloudrun#1290 open; those are separate campaigns.

### Phase 1 — core: accept, don't write  (`Launch from: core/`)
- Field on the three item schemas: `.nullable().optional()`, `propagate: true`
  (shared leaf; an invoice/fulfillment may override, three-way merge).
- Declare it ONCE in `LineItemCore` (`core/src/schemas/_items.ts`), next to `zero_priced`:
  `z.number().min(0).nullable().optional().meta({ propagate: true })`. This follows
  `uid_tax_class_override` . All three grains spread `LineItemCore`.
- **Input schemas too**, or every PUT strips the field: `OrderItemLineInner` (`core/src/schemas/order.ts`) and
  `InvoiceItemInputLineInner` (`core/src/schemas/invoice.ts`). Not `FulfillmentItemInputLine`.
- Catalogs: `core/tests/stored-optionality.test.ts`, the shared-fields snapshot, `ZeroPricedItemLike`
  (`core/src/schemas/common.ts`; not needed after all), `LineItem` (`core/src/utils/orders.ts`), and the template-helpers emit/denylist.
- **No `itemArrayIssues` rule** (see the cut rule).
- `componentQuantityAt(ratio, parentQty)` in `utils/order-lines.ts`: BigInt ceil at a 1e4
  scale (`QTY_SCALE` precedent, `core/src/utils/orders.ts`). `componentQuantities` is routed through it.
  ⚠️ This fixes `ceil(0.07 × 100) = 8`, and lines built under the float rule will then read as
  mismatches, which is acceptable under the cut rule.
- `kitCutQuantities(items, kitIndex, k): Map<number, number>` in the same module. It cascades
  via `getItemSubtreeRange` and never returns null. The booking cap stays with the caller.
- Tests use a seeded mulberry32 sweep (`core/tests/purchases.test.ts`):
  - exact BigInt reference, plus a companion test showing the float form fails
  - moved ≤ q
  - a full cut moves q
  - two cuts that add up to n move all of q
- ~~Go/no-go custody check~~: **done 2026-10-11, GO** (see *Settled*).
- **Folded in from manager#639** (the same rule, so it is not written twice):
  - item 1: `getComponentMinQty` (`manager/src/components/ItemSearchSelect.tsx`) calls
    `componentQuantityAt`, which closes the 1.5-unit fractional minimum;
  - item 3: one "direct child" rule, core's `resolveParentUid` (`path.length <= 1`). Replace
    `path.length === 1` in `manager/src/stores/products.ts`, `manager/src/components/products/ProductRelationshipTable.tsx`,
    `manager/src/components/products/ProductRelationshipRow.tsx`, `manager/src/routes/ProductDetail.tsx`, and
    `api-cloudrun/src/services/products.ts` (5 sites), `api-cloudrun/src/lib/productComponents.ts`;
  - item 4: `rescaleKitSubtree` moves to core HERE, not in Phase 2. Its `catalogChain` is
    deleted for `resolveParentUid`.
  - **manager#640** (split from #639 item 2): `availabilityComponents`
    (`manager/src/utils/itemAvailability.ts`) bounds its search to the kit's subtree via
    core `getItemSubtreeRange`. Add a unit test with the same kit on two legs.
  - Close manager#639 and manager#640 when Phase 1 lands.
- Publish `feat`. Then api + manager pin bumps → **both released to prod**.
- Skills: `cfs-release-order`, `cfs-items`, `cfs-order-projections`; read `core/CLAUDE.md`.

### Phase 2 — core: write  (`Launch from: core/`, then `api-cloudrun/`, then `manager/`)
Unblocked: api-cloudrun#1286 and api-cloudrun#1287 are closed in full. The writer list is now
the single authors they created, so the stamp lands in each ONCE:
- **core** (`core/src/utils/order-lines.ts`): a slot rule beside `zeroPricedForSlot` —
  `quantityPerParentForSlot(slot)` = `slot === null ? null : round4(slot.quantity ?? 1)`
  (`?? 1` because expansion uses it). `buildOrderComponentLines` stamps it, which covers the
  manager's order / invoice / fulfillment stores, item search and exchanges.
  `fulfillmentSourceOfComponent` (`core/src/utils/fulfillment-items.ts`) and
  `projectFulfillmentLine` carry it, which covers the api's substituted-subtree and
  exchange-component rows and manager's `toFulfillmentLine`.
- **api order writer**: `resolveOrderZeroPriced` (`api-cloudrun/src/lib/orderLineZeroPriced.ts`)
  already resolves each row's slot and carries the stored value by row. Generalize it to
  resolve the stamp the same way, so a new row is stamped from its slot and an existing
  row keeps its stored stamp: the snapshot rule, and the client is never the source.
  **Owner ruling 2026-10-12: yes** — the stamp follows `zero_priced`'s snapshot rule
  exactly (catalog slot for a new row, stored value carried by row, never the client's).
- **Named-field projectors drop it unless told:**
  - `projectOrderItemToInvoiceItem` (`core/src/utils/invoices.ts`). Spread it only when
    present, because `invoiceItemDifferences` compares key sets.
  - `projectItem` (`api-cloudrun/src/services/fulfillment.ts`) — the order-line → fulfillment
    projection (it passes an order line's fields to `projectFulfillmentLine`).
  - substitution ROOT: takes X's stamp (the slot rule, as `substitutionRootZeroPriced`), in
    `api-cloudrun/src/lib/orderFulfillmentSync.ts`, `api-cloudrun/src/services/fulfillmentEdits.ts`,
    the invoice substitution path, and manager's `applySubstitution` / `substituteRows`.

  `zero_priced` has the same footprint; grep it as the map.
- Publish; api + manager pin bumps. No ordering constraint (every reader already accepts
  the field since Phase 1).

### Phase 3 — manager readers  (`Launch from: manager/`)
- `rescaleKitSubtree` (moved to core in Phase 1) reads the stamp. A null stamp means no ratio, so the line
  is treated as hand-edited and isn't rescaled. The catalog load and the baseline
  machinery in `manager/src/stores/kitQuantityEdit.ts` can be deleted (confirm nothing else uses them).
- Fulfillment kit row: action quantity box on kits, using `kitCutQuantities`;
  confirm text names the component counts.
- Skills: `order-items`, `testing-conventions`, `design-system`.

### Phase 4: dropped (owner, 2026-10-11)
Pre-stamp lines cut proportionally under the one cut rule, so there is no backfill.

## Costs

- ~30 bytes per component line — negligible against 1 MiB even at 500 lines.
- Two core releases + two rounds of pin bumps across api and manager.
- Rescale tests move from catalog fixtures to stamped ones.
- Staleness: low by design — it is a snapshot; it diverges from the catalog only
  when the catalog is deliberately changed, which is the point.

## Settled 2026-10-11

- **Partial custody: GO on the server.** `applyBookingUpdates` takes a per-booking `quantity`
  with nothing tying a component booking to its kit. The block is manager-only:
  `manager/src/components/fulfillment/FulfillmentItemRow.tsx` (`isKit` disables partials). A serialized component must
  still name exactly `quantity` units.
- **Catalog ratio bound shipped:** `@cfs/core` beta.652 bounds `AuthoredComponentSchema.quantity`
  to ≥ 0 and 4 decimals, and api `toAuthoredComponents` rounds (api-cloudrun commit `a347eed7`).
- **1.01 is not a typo.** It is "Roll Up Fence (6.5' Section)" → "42\" Traffic Delineator",
  the fence-post rule: ceil(1.01 × n) = n + 1 posts for n ≤ 100. It works under the cut rule.
- **Related issues the core work should absorb:**
  - manager#639: `getComponentMinQty` skips the ceil; two "direct child" definitions; `rescaleKitSubtree`
  - api-cloudrun#1287: fulfillment `zero_priced` / first-uid catalog lookup
  - api-cloudrun#1286: one author for a line's catalog facts. `buildOrderComponentLines`
    gains the stamp there.
- **Owner rule:** collapse rules over preserving minor divergence; core's answer wins.

## Context recommendation

Clear between phases — each starts from its own `Launch from:` with fresh skills; this plan
carries everything needed.
