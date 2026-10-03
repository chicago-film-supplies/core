# core#124 — An invoice owns rows and pairs no order carries

> ## ⚠️ STATUS UPDATE 2026-10-03 (Phases 1, 2 and 1b-core)
>
> **Phase 1 (core) DONE** — `839dfae`, `@cfs/core@10.0.0-beta.588`: rows and pairs on neither order stay;
> placement is `core/src/utils/stored-only-rows.ts`; alignment reads invoice-authored subtrees. Tests:
> `core/tests/invoice-owned-rows.test.ts`. ⚠️ Accepted edge: an order that MOVES a group holding an
> invoice-authored line leaves the stale group behind and reads UNALIGNED (revisit with core#125).
>
> **Phase 2 (api-cloudrun) DONE and PUSHED** — `61acf2a1` pin + `destinationSyncReport.ts` retired,
> `bbda9878` `syncRows` through `placeStoredOnlyRows`, `b4eba964` `reconcileInvoicePairMembership`
> (`api-cloudrun/src/lib/pairEdit.ts`), `27617239` + `c44c24d9` skills.
>
> **Phase 1b core half DONE** — `1feb510` (`feat(invoice)!`, the beta after `588`). In `syncScopedItems` a
> divider on both orders the invoice lacks is DECLINED and is dropped unless a non-declined row lands
> beneath it (re-open). `syncOrderDestinationScope` derives pairs from the surviving destination dividers;
> the #664 loop, `kept` and `KeptInvoiceDestination` are gone; `DroppedInvoiceDestination.reason` gains
> `divider_absent`. `syncOrderDestinationsSelective` stays as the PAIR-ONLY path for an invoice with no
> order divider (api-cloudrun's `else` branch). `invoiceScopeDividersMatch` narrowed: order dividers the
> invoice holds must sit at the order's path (inside authored subtrees too); a MISSING one is declined
> unless the invoice still paths a line under it or bills one of its order lines' uids at a path the
> order lacks (authored subtrees NOT excused — double-billing guard). Tests: § *Phase 1b* in
> `core/tests/invoice-owned-rows.test.ts`, mutation-controlled.
> **api-cloudrun#1189 cause established:** #2300/#2413 each bill one group of order #897 and lack the
> other; #2396 bills only lost/damaged `replacement` lines and lacks all five groups of #979. All three
> are declined, not broken — they read aligned under 1b. Close #1189 once the API runs this core.
>
> **Next: Phase 1b api-cloudrun half** (see § Phase 1b → *Fulfillment half*), then Phase 3 (manager).

## Context

core#124 asks that an invoice be able to add a destination (pair + divider) its order lacks, so manager's
invoice items header can offer **Add Destination**. Verified 2026-10-03 (prod reads):

- `syncOrderDestinationsSelective` dropped every pair on neither order (`key_names_no_order_pair`).
- An override kept after the order deleted it was dropped on the NEXT edit — lines and dividers too.
- A plain invoice-only LINE was dropped on the next order edit of an unfrozen invoice.
- `invoiceScopeDividersMatch` needed identical dividers, so an invoice Add Group made `invoicedByPath`
  skip the invoice, `remainingForOrder` refuse, and the diff say unaligned.
- `applyInvoicePairEdits` (`api-cloudrun/src/lib/pairEdit.ts`) ignores unknown pairs; a lone divider 400s
  at `findDestinationJoinIssues` (`api-cloudrun/src/lib/firestoreWrite.ts`, wrapping core's
  `destinationJoinViolations`).

Prod census (2026-10-03, read-only): 1,073 invoices; **0** invoice-only pairs, **0** invoice-only dividers;
**97** order scopes carry invoice-only lines (**1** unfrozen — the rest survive only because they're frozen);
**3** unaligned invoices (#2396, #2300, #2413 — orders #979, #897), none from invoice-only dividers (the
invoice LACKS an order divider — separate cause, out of scope, filed separately). Survivorship caveat: rows
already dropped by the sync are not in the corpus.

**Owner decisions (2026-10-03):**
- Alignment model = **invoice-only subtree**: an invoice-authored divider and everything under it is the
  invoice's own; its lines bill no order line. Rejected: transparent groups (implicit second path-mapping
  rule); explicit `path_section_for` mapping (conflicts with api-cloudrun#538's "invoice path = order path"
  ruling, cannot extend to fulfillments where custody is per physical leg, roughly doubles manager#472's
  sync-button design).
- Fix **rows + pairs together**: one rule for every invoice-authored row.
- Also plan the **per-line "bills order path" pointer** (Phase 4).

The rule is the fulfillment's (`mergePairs` + `syncRows`, `api-cloudrun/src/lib/orderFulfillmentSync.ts`):
**absent from BOTH orders ⇒ downstream-authored ⇒ stays**; absent only from next ⇒ admin removal ⇒ the
override test.

## Phase 1b — one row rule for lines, groups and destinations (core, core#126)

**Launch from:** `~/cfs/core` (then api-cloudrun for the fulfillment half and the pin)
**Skills:** cfs-order-projections, cfs-items, cfs-release-order, fulfillment-ladder (api-cloudrun)
**Read:** `core/CLAUDE.md`; this doc.

**Owner rulings (2026-10-03):** a destination or group divider is decided exactly like a line.
Agreed costs 1–4 and both questions below.

| | projection has it | projection lacks it |
|---|---|---|
| on prev and next order | merge per field | **declined: stays out** |
| new on next order | — | project it |
| on prev only | override test | gone |
| on neither | the projection's own, stays | — |

- **A divider exists while something under it does.** A kept row keeps its ancestors
  (`placeStoredOnlyRows`); a projected NEW row drags any missing ancestor back in — so a new order
  line under a declined destination re-opens it, divider AND pair (ruled: yes).
- **A pair follows its destination divider** and decides no membership of its own:
  `syncOrderDestinationsSelective` (invoice) and `mergePairs` (`api-cloudrun/src/lib/orderFulfillmentSync.ts`)
  merge fields only for pairs whose divider is present. The "absent ⇒ new pair" arm goes.
- **The fulfillment follows the same rule** (ruled: yes). Its `syncRows` has the same divider
  exception (`prevByPath` excludes dividers, so a missing divider re-projects).
- Collapses: the divider re-projection in `syncScopedItems`, most of `syncOrderDestinationScope`'s
  #664 re-decision loop and probably `KeptInvoiceDestination` / `holds_invoice_rows`.

**Agreed costs:**
1. `invoiceScopeDividersMatch` can no longer tell a DECLINED destination/group from a broken
   skeleton. Alignment narrows to what the single path author cannot guarantee. ⚠️ **Before landing,
   establish why api-cloudrun#1189's three invoices lack an order divider** — under this rule they
   would probably read as declined and stop being flagged.
2. A group or destination an operator deletes on a partial invoice stays deleted (today the order
   puts it back).
3. A new order line re-opens a declined section (above).
4. Bringing a declined row back is manager#472's sync buttons, extended to dividers.

**Unchanged:** lines under a declined destination read uninvoiced in coverage and are billed by a
remaining invoice; Phase 2's write side (pair follows divider) is already this rule's shape.

**Tests:** prev/next/projection matrix per row kind (line, group, destination) on both projections;
re-open on a new line; #126's resurrection case now stays out; the fulfillment oracle suites.

### Fulfillment half + pin (api-cloudrun `main`) — NOT STARTED

**Launch from:** `~/cfs/api-cloudrun`. **Skills:** fulfillment-ladder, cfs-order-projections, cfs-items,
cfs-release-order, cfs-worktrees. Design settled 2026-10-03 (read `api-cloudrun/src/lib/orderFulfillmentSync.ts`):

1. **Pin** to the beta `1feb510` published. Type fallout should be nil (nothing reads `kept` /
   `KeptInvoiceDestination`); `orderInvoiceSync.ts`'s comment on `syncOrderDestinationScope` (~L355) and
   `api-cloudrun/tests/integration/invoices/destinationRowSync.test.ts` / `invoiceOwnedDestinations.test.ts`
   may assert the old re-projection — re-read, update to the declined rule.
2. **`syncRows`:** a projected DIVIDER with no stored row whose path the PREVIOUS order had (`prevByPath`
   holds fulfillable lines only — add a divider-path set) is declined: emit it, then drop each declined
   divider no non-declined emitted row sits strictly below (same post-pass as core's `syncScopedItems`).
3. **Pairs follow dividers:** keep `mergePairs` / `resolveEffectiveFulfillmentDestinations` as they are —
   bookings read them via `effectivePairFor` (`api-cloudrun/src/services/orderBookingRecompute.ts`), which falls back to the order pair,
   so a superset is harmless there. In `stageOrderFulfillmentSync`, filter what is STORED: after the items
   arm, keep only pairs whose destination divider is in `finalItems` (the write guard
   `destinationJoinViolations` checks fulfillments too). Census first: prod/dev fulfillments carrying a
   pair with no divider must be 0, or the filter drops them.
4. Tests: declined group/leg stays out on the fulfillment; new order line re-opens divider + pair; the
   custody-keep + fulfillment-sync suites stay green UNEDITED.
5. Skills: `cfs-order-projections` (claude-plugins) still says "Dividers are still projected when
   missing" and describes the #664 loop / `kept`; `cfs-invoices` + `write-path-invariants` where they
   describe pair membership.

## Phase 2 — api-cloudrun (`main`) — DONE (see status)

**Launch from:** `~/cfs/api-cloudrun`
**Skills:** write-path-invariants, cfs-invoices, cfs-tax (directory-scoped, invocable from there), fulfillment-ladder, cfs-order-projections, cfs-release-order, cfs-worktrees
**Read:** this doc; `core/CLAUDE.md` only if a core follow-up is needed.

- **Pin bump** to `10.0.0-beta.588`. It is type-breaking: delete the `key_names_no_order_pair` arm and the
  `invoice_destination_override_dropped` emit in `api-cloudrun/src/lib/destinationSyncReport.ts` (the
  module may go entirely — `dropped` now only ever carries intended drops; keep the
  `destinationSyncCoverage` guard's intent or retire it deliberately). Check
  `api-cloudrun/scripts/repair-invoice-structure.ts` and `api-cloudrun/scripts/audit-invoice-override-classes.ts`
  for the removed reason too.
- **Adopt `interleaveStoredOnlyRows` / `placeStoredOnlyRows` in `syncRows`** — behaviour-preserving; the
  fulfillment sync / custody-keep suites are the oracle and must stay green with no test edits. Separate
  commit from the invoice work so a regression bisects to it. `syncRows` keeps its custody/kit survivor
  selection and `survivorAs`; only the kept-divider + anchor placement moves (use `placeStoredOnlyRows`,
  since its output loop merges per projected row and may emit a relocated substitution).
- **Add-pair in `updateInvoice`** (`api-cloudrun/src/services/invoices.ts`): after items are built, a
  requested pair whose `(uid_order, uid)` matches no stored pair but whose `uid` equals a destination
  divider NEW in this write's items is appended via `canonicalNewInvoicePair`, `uid_order` from the
  divider's order block. A requested unknown pair joined to no divider → **400** (replace the silent
  ignore; update `pairEdit.ts`'s docstring and `api-cloudrun/tests/unit/pairEdit.test.ts`).
- **Remove-pair:** a stored pair whose destination divider this write removed is dropped in the same
  write (today it would trip the join guard).
- **Tax:** a new pair's `jurisdiction: null` resolves via `documentTaxContext`. An earlier
  `delivery_start` moves `invoiceTaxAsOf` for the whole invoice; settled invoices already refuse via
  `lineMoneyAgrees`. Test both, don't change.
- **Integration tests** (`api-cloudrun/tests/integration/invoices/`): PUT new pair+divider → 200; PUT pair
  without divider → 400; a subsequent order edit keeps pair, divider and lines; Add Group on the invoice
  survives an order edit and the scope stays aligned; `remaining_of_order` create no longer 409s for that
  order; delete the invoice-authored destination → pair goes.
- Update `api-cloudrun/.claude/skills/write-path-invariants/SKILL.md` and the `cfs-invoices` skill where
  they describe pair membership; the `cfs-order-projections` skill (claude-plugins) where it says the
  rows follow "for free" only on the fulfillment.

## Phase 3 — manager (`main`)

**Launch from:** `~/cfs/manager`
**Skills:** order-items (directory-scoped), cfs-order-projections, cfs-items, cfs-release-order
**Read:** `api-cloudrun/.claude/skills/write-path-invariants/SKILL.md` (pair ⟺ divider join the save must satisfy)

- Pin bump to `10.0.0-beta.588` or later (alignment/diff/coverage read invoice-authored subtrees).
- `addPair` in `manager/src/stores/invoices.ts`, modelled on orders' `addDestinationPair`
  (`manager/src/stores/orders.ts`): `buildDestinationPairWithDivider`, stamp `uid_order` of the target
  order block, seed dates from that block's last pair, insert at the END of the block (reuse `addGroup`'s
  block scan), paths via `computeInvoiceItemPathsDecoupled`. Multi-order invoice: target = the last order
  block unless one is focused (match `addGroup`).
- Pass `onAddDestination` from `InvoiceItems.tsx`; fix `ItemsHeader.tsx` ("Orders only until…") and the
  `stores/invoices.ts` comment ("Row MEMBERSHIP follows the order").
- Verify the diff notes / coverage advisory render an invoice-authored subtree as extras, not "unaligned".

**Release order:** core → api-cloudrun → manager (`requires-manager.yaml` enforces manager's released pin
≥ API's). Between API and manager deploy, old-core manager shows an invoice Add Group as "unaligned" —
display only, and already true today. Write this order into each PR/commit body.

## Phase 4 — per-line "bills order path" pointer (design session, then its own campaign)

Tracked in core#125. Launch from `~/cfs/core`; skills cfs-order-projections,
cfs-items, cfs-plan-docs. The gap: a line dragged on the invoice into another group/destination gets a path
the order lacks, so it bills no order line and its order line reads uninvoiced; manager#472's realign would
delete + re-add it. First evaluate reusing `substituted_for` before minting a field.

## Issues

- Delete this doc in the commit landing Phase 3; close core#124 there.
- Filed with Phase 1: core#125 (per-line pointer, Phase 4); api-cloudrun#1189 (the 3 unaligned prod
  invoices that lack an order divider). manager#472 has the realign semantics for invoice-authored subtrees.

## Verification

- api-cloudrun: integration suite; then on dev, through manager: add a destination + group on a draft
  invoice, edit the order, confirm both survive and the invoice diff shows extras, not "unaligned".
- Re-run `GCLOUD_PROJECT=cfs-3100 deno run -A scripts/audit-order-invoice-coverage.ts` (api-cloudrun) after
  deploy: `unaligned` must not rise above 2 orders; `extra invoice lines` may rise (rows no longer dropped)
  — that is the fix, not drift.

## Context recommendation

**Context:** CLEAR CONTEXT between phases — this doc carries the decisions and what landed.
**Execute with:** opus — projection-merge semantics where a wrong diff compiles and passes.
