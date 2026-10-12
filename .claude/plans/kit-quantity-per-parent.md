# Stamp `quantity_per_parent` on kit component lines

> ## ⚠️ STATUS UPDATE 2026-10-12
> **Phase 1 is DONE and in prod.** Every reader accepts `quantity_per_parent`; nothing writes it yet.
> - **core** `0ee5d79` → `10.0.0-beta.653`: `quantity_per_parent` on `LineItemCore`, the
>   order/invoice input schemas, the three stored interfaces and `LineItem`. New in
>   `core/src/utils/order-lines.ts`: `componentQuantityAt`, `kitCutQuantities`, `isDirectComponent`,
>   and `rescaleKitSubtree` / `kitRootPos` (moved from manager, still CATALOG-reading until Phase 3).
>   Tests: `core/tests/kit-ratio.test.ts`.
> - **manager** `95dd9fb5` (pin beta.653): manager#639 items 1/3/4 and manager#640, both CLOSED.
>   Released to prod as **manager-v27.49.2** (2026-10-12; `deploy-prod` green).
> - **api-cloudrun** `20d96173` (pin beta.653 + the `@cfs/core/utils/order-lines` map entry): the six
>   `api-cloudrun/src/services/products.ts` direct-child tests and the zero-priced sort's parent bucket
>   read `isDirectComponent`. Released as **v0.346.0** (2026-10-12), after manager, with
>   `requires-manager` green.
> **Next:** api-cloudrun#1286, then api-cloudrun#1287 (both closed IN FULL; launch from
> `api-cloudrun/`), then Phase 2.
> ⚠️ Item 3 landed as a predicate, `isDirectComponent(comp)`, not as an exported
> `resolveParentUid`: every call site asks "is this a direct child?", none has a root uid in hand.

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
1. Phase 1, with manager#639 items 1, 3 and 4 and manager#640 folded in.
2. api-cloudrun#1286, then api-cloudrun#1287 — **prerequisites of Phase 2, closed in full.**
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

### Phase 2 — core: write  (`Launch from: core/`)
**Blocked on api-cloudrun#1286 and api-cloudrun#1287 — both CLOSED IN FULL (owner, 2026-10-11).**
Not just the slice this phase needs. For #1286 that means every writer in its table (incl.
`syncDraftOrders`, the order-writer derivation, the invoice fills, manager `setItemType`). For
#1287 it includes item 5 (`createFulfillmentExchange` eligibility).
- **#1286** gives a line's catalog facts one core author (`deriveLineCatalogFacts`). The
  stamp is one more catalog fact, so it is added THERE, in one line.
- **#1287** collapses the fulfillment projectors (`projectFulfillmentLine`,
  `toFulfillmentLine`, `exchangeComponentRows`, substituted-subtree rows) into one core
  projector, which resolves catalog entries **by path**.
- ⚠️ Correctness, not only effort: today's first-uid lookup (`subtreeComponentOf`) would
  stamp a component listed under two kits with the WRONG kit's ratio. That is a wrong
  value, and nothing refuses it.
- After both land, the projector list below shrinks to their single authors plus
  `projectOrderItemToInvoiceItem` and `projectItem`.
- `buildOrderComponentLines` (`core/src/utils/order-lines.ts`) stamps
  `quantity_per_parent: round4(comp.quantity ?? 1)`. Use `?? 1` because expansion uses it. That one builder covers api
  (`api-cloudrun/src/lib/productComponents.ts`, `api-cloudrun/src/lib/fulfillmentLine.ts`) and manager's order /
  invoice / fulfillment stores, item search, exchanges.
- **Named-field projectors drop it unless told.** Each of these needs the field:
  - `projectOrderItemToInvoiceItem` (`core/src/utils/invoices.ts`). Spread it only when
    present, because `invoiceItemDifferences` compares key sets.
  - `projectFulfillmentLine` (`api-cloudrun/src/lib/fulfillmentLine.ts`)
  - `projectItem` (`api-cloudrun/src/services/fulfillment.ts`)
  - `buildOrderLineItem` (`api-cloudrun/src/services/orders.ts`)
  - `exchangeComponentRows` (`api-cloudrun/src/services/fulfillmentEdits.ts`)
  - substitution root and subtree (`api-cloudrun/src/lib/substitutedSubtree.ts`, manager `buildOrderLineFromProduct`)
  - manager `toFulfillmentLine` (`manager/src/stores/fulfillment.ts`)

  `zero_priced` has the same footprint, so use it as the map.
- Publish; api + manager pin bumps.

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
