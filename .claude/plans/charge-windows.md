# Multiple charge windows per destination pair

**Date:** 2026-09-16 • **Repo:** core (+ api-cloudrun, manager, templates) • **Status:** in-progress (steps 1–4 in prod; step 5 next)
**Origin:** hotspot rentals billed only for their activation windows; owner design sessions 2026-09-16
**Related:** api-cloudrun#1028, core#112 (§3 comparator), core#113 (pair invariant guard), templates#376 (partials read windows)

## START HERE
**Step 4 (beta B) is in prod as of 2026-09-17**: manager 26.26.0, then API 0.277.0, and templates#375 is merged. Next is **step 5** (stop writing the legacy fields, purge, remove); its prerequisites are listed in the status block below, and templates#376 goes first. First command: `gh issue view 376 -R chicago-film-supplies/templates`.

> ## ⚠️ STATUS UPDATE 2026-09-17 (compacted): beta B in prod
> **Shipped to prod earlier the same day (steps 1–3).** Core beta.481, manager 26.25.0, API 0.276.0. Backfill applied dev then prod: every pair has windows whose Σ days = `days_charged`; one total moved (#990, owner decision). Details in api-cloudrun `9fb93eca`.
>
> **Beta B (step 4).**
> - **Core `6c7c984` → `@cfs/core@10.0.0-beta.482`.** `OrderDocDates.charge_windows` required. Legacy fallbacks gone: `chargeWindowsOf`, `storedWindows`, `legacy_days_charged`; `chargeWindowContext` refuses a windowless pair. §2c: `BilledWindow` = last end + window days; groups track billable days; `extensionChargeDays` removed. `buildRemainingInvoice` writes the extension pair's ONE window (day after billed end at the order's start time → order's last end, `days` = ADDED days; **owner decision 2026-09-17: one window, not clipped windows**). `accountLine` prices a remainder on a 2+ window pair at `billableDays ÷ 5` (it used the line's own floor, a bug). `deriveOrderDateEnvelope` derives its charge fields from windows. `getDuration` lost its charge half. New `chicagoDayAtTimeOf`.
> - **Manager `4a6c78ba`, prod as 26.26.0.** Pin beta.482; `ensurePairWindows` removed; date editor, collapsed summary, invoice drawer and item search read windows; BookingDetail drops charge rows; `documentTax` passes every pair's windows.
> - **API `5ce32faf`, prod as 0.277.0** (the `requires-manager` gate went green once 26.26.0 released; no prod errors logged after the deploy). Pin beta.482; `canonicalizeDestinationDates` always writes windows; reprice key reads window days; `canonicalNewInvoicePair` takes the extension window as built; **bookings write `charge_*` null** (not optional: core's stored-optionality ratchet refuses a new `.nullable().optional()`, so the removal goes optional → purge → delete in step 5); census script deleted. Dev's two void test invoices #1000001/#1000002 were given windows by the backfill rule (the pre-push suite reads dev).
> - **Templates #375** (merged): pin beta.482 + windows on 31 fixture pairs; renders unchanged.
> - **Released in order:** manager 26.26.0, its prod deploy, then API 0.277.0. The manager stopped reading booking charge fields before the API nulled them.
>
> **Deferred, filed:** core#112 (§3: `computeInvoiceSyncStatus` badges an invoice whose own windows bill different days; not a regression), core#113 (nothing asserts the 2+ window pair invariant on write), templates#376 (partials still read `charge_start`/`charge_end`/`days_charged`; **must land before step 5**). core#111 closed (moot: required windows mean a seed with none is correctly refused).
>
> **Not verified:** the manager's date editor and summary were not opened in a browser; the change is covered by unit tests only. `orderPerf` self-skips on dev.
>
> **Step 5 prerequisites found while building beta B:** templates#376; typesense `dates.charge_*_fs`/`days_charged` fields and `display-columns.ts` still project the mirrors (remove with a forced prod resync before the manager release that stops reading them); `deriveOrderDateEnvelope`'s charge fields; `xeroQuoteStatus`'s `charge_end` fallback (now window-derived); booking charge fields optional → stop → purge → delete; api-cloudrun `scripts/_stockReconciliationPlan.ts` and `reconcile-physical-stock-count.ts` read booking `charge_start` as a fallback.
>
> **Decided (owner, 2026-09-17): reopening re-derives, in the reopening write.** api-cloudrun `cf4b9673` adds a `reopened` arm to `updateOrder`'s reprice gate, so `canceled` → `draft`/`quoted`/`reserved` reprices from the windows in the same write, and that write's activity row carries the totals delta. Stored days are not carried past a reopen; issued invoices are protected by the invoice freeze. `complete` has no reopen path today (`finalizeOrderBookings` treats it as terminal); the predicate covers it for any future one. On `main`; not yet released.

## Census (prod, 2026-09-16; dev agrees to within 2 invoices)
Script: the charge-windows census script, uncommitted on api-cloudrun branch `chore/charge-windows-census` (worktree `charge-windows`); it lands with the backfill. Prod: 1,033 orders, 1,051 invoices.
- **Bucket 1:** native (post-cutover) documents have 0 divergent lines. Divergence is CRMS-migrated only, and a floored count differs in every case:
  - **live orders, only two:** #1003 (active, 18 lines at 5 on a 7-day pair) and #979 (reserved, 16 lines at 15 on a 20-day pair; its invoice #2396 bills the same 15)
  - complete orders 575 lines, canceled 77
  - **issued, unpaid:** #2396 (bills 15 of 20, 16 lines), #2408 (15 on a 14-day pair, 6 lines), #2399 (one rental line with null days on a 15-day pair)
  - paid 1,067 lines, void 95
- **Bucket 2:** every non-rental `five_day_week` line is on an invoice; 53 `service` lines carry days, all paid.
- **Bucket 3:** 3 pairless rentals, all on paid invoices.
- **Bucket 4:** charge ≠ possession on 112 order pairs and 132 invoice pairs; 0 null charge bounds.
- **Bucket 5:** 0 extension sections in prod, so nothing to reproduce.
- **Decision (owner, 2026-09-16): orders follow the invoice pattern.** Complete and canceled orders keep their stored line days, as paid and void invoices do. ⚠️ Nothing freezes an order today (`assertRepriceable` refuses only invoices), so `priceDocument` must carry stored line days for `complete`/`canceled` orders, and the design must say what reopening one does. Live orders and issued, unpaid invoices are re-derived. Backfill for #2396: its window carries the 15 days billed.
- **Backfill decisions (owner, 2026-09-16):** #979's window = 15 days; #1003's window = 5 days; #2408's invoice window = 15 days (keeps its money); #2396's window = 15 days.
- **#2399 is a different class:** Combo Hangers are `fixed` products that bill 1 week whatever the rental length, but the migrated line is stored as `five_day_week`. Prod has this product↔line formula mismatch (product `fixed`, line `five_day_week`) on live documents: #2399 (issued, days null, bills 1 week, correct), and on orders #990 (4 × $15 at 24 days = $288.00; `fixed` would be $60.00), #961 (2 × $25 at 15 days = $150.00; `fixed` would be $50.00), plus #865/#867/#869/#871 (1–2 days, so the floor already bills one week). Frozen documents: 71 complete-order lines, 73 paid-invoice lines. **Decision (owner):** the backfill sets the line formula to `fixed` on #990, #865, #867, #869, #871 and #2399 (#990 drops $288.00 → $60.00). **#961 is preserved** as `five_day_week`; its pair is 15 days, so a derived line keeps $150.00.
## Context

**Use case:** a hotspot goes out for 3 months. It is billed only for the three separate windows when it was activated remotely.
- **Fulfillment:** shows what really happened. Possession runs from delivery to collection, and that drives bookings and availability.
- **Quote and invoice:** say the same, and add that the charge covers only those windows.

Today every destination pair has exactly one `charge_start`/`charge_end`.

### Decisions (with the user, 2026-09-16)

1. **One pair holds an array of charge windows.** Splitting into several pairs would invent deliveries and free up stock between windows.
2. **The one-week minimum applies to every window, including a 0-day one:** `billableDays = Σ max(window.days, 5)`.
   - [3,4,2] → 15 → 3.0 × base. [3,0,4] → 15.
   - For a single window this is exactly today's pricing, so there is no special case.
3. **Dates, chargeable days and price always move together.**
   - A rental line's `chargeable_days` is derived from its pair's windows. There is no per-line override.
   - Duration inputs edit the windows.
   - A line needing a different duration belongs in its own pair ("dates and destinations ride together", `invoice.ts:505-523`).
   - A partial bill (e.g. 35 + 10 of a 45-day rental) sets **that invoice's own pair windows** to the part being billed.
4. **The floor lives in `priceDocument`**, which reads each pair's window day counts. Nothing stores a floored count.
5. **Drop `days_charged`.** Each window stores its `days` (≥ 0), counted once when written.
   - `charge_windows` is never null. Every total is Σ `window.days`, with no holiday list needed.
   - Sale-only pairs already store full windows, so they are unaffected.
6. **Drop `charge_start`/`charge_end` (+`_fs`) in the same campaign.** There is no derived envelope and nothing deferred.
7. **Keep `days_active` stored**, as the frozen count for the possession window.
8. **Extension sections carry the part of each window after the billed end.** Added days = billable(order windows) − billable(billed windows), computed from stored counts.
9. **Input `charge_windows` is required and legacy input is removed.** Breaking during rollout is accepted.
10. **Old data doesn't constrain the design.** Anything already sent out (paid, void or settled invoices and their PDFs, credit notes) keeps its stored line days and money.
11. **Date-edit rules move from the manager to core** (`applyDateEdit`). Duration edits keep the end's own time of day.
12. **Starts from core `beta` after the quantity-accounting campaign** (retired in api-cloudrun `6fa6a2f8`, core `beta.477`).

### Why stored counts, not computed on read (audited)

- The holiday list changes and has no versions: one singleton `holiday-snapshot/current`, written for the current year including past dates (`api-cloudrun/src/services/holidays.ts:444, 168-171`).
- Renders use live holidays (`api-cloudrun/src/lib/templates/render.ts:480`).
- Computing counts on read would break three things:
  - the holiday recompute would move nothing
  - extension billing would be wrong
  - issued PDFs would reprint different counts next to frozen money

### What the code does today (audited)

- **Where dates live:** each pair's `dates: OrderDocDates` (`core/src/schemas/order.ts:130-205`), on orders, fulfillments and invoice pairs.
- **Day counts:** `getDuration` (`core/src/utils/dates.ts:586`) → `days_charged` → copied onto lines.
  - Lines follow a date change only while they equal the old default (before beta A: `syncChargeDaysToItems` and friends in `core/src/utils/orders.ts`, and `settleScopedChargeDays` in `core/src/utils/invoices.ts`; all deleted in beta A).
  - Tests pinned "hand-set values are preserved" (the charge-days test file, deleted in beta A).
- **Per-line duration inputs** (`manager/src/components/orders/item-cells/ItemDuration.tsx` and its `invoices` twin) write one line's days alone. This contradicts decision 3.
- **Price:** `perUnitSubtotal` (`core/src/utils/orders.ts:817-846`) applies days only for `five_day_week` with days > 5.
  - Invoice `sale`/`service`/`surcharge` lines are stored as `five_day_week` with null days (`core/src/schemas/common.ts:955-965`), and price at factor 1.
- **`priceDocument` reprices issued unpaid invoices.** `assertRepriceable` (`price-document.ts:150-161`) refuses only void, paid or settled.
- **Date rules that exist only on the client** (`OrderDestinationDates.tsx`):
  - The charge window follows possession (:123-143).
  - `*_end = *_start` (:33-44).
  - Duration → end at the start's time of day (:269-291).
  - The server passes dates straight through (`api-cloudrun/src/services/orders.ts:704-728`, `lib/pairEdit.ts:96-151`).
  - `*_end` has server readers: booking holds (`orderHelpers.ts:74-76`), event cards, activity, quote expiry (`xeroQuoteStatus.ts:123`).
- **Invoice pairs are editable in the manager** (`InvoiceItemRow.tsx:543` mounts the same editor). Comments saying otherwise are stale.
  - Fulfillment pairs are API-only.
  - MCP is GET-only.
- **Prod sample (2026-09-16):**
  - Pairs: 0/56 with end ≠ start; 12/56 with charge ≠ possession; weekend and 0-day windows exist.
  - Lines diverging from their pair: none in 23 recent orders or 16 native invoices. They do exist on CRMS invoices: #2408 (issued, unpaid, lines at 15 and 14 in one 14-day pair) and #2406 (void).

## Design

### 1. Schema

```ts
// core/src/schemas/order.ts
ChargeWindowInput = z.object({ start: chicagoInstant(), end: chicagoInstant() })
ChargeWindow      = z.strictObject({ start: chicagoInstant(), end: chicagoInstant(),
                                     days: z.int().min(0).meta({ derived: true }) })
OrderDates    = { delivery_*, collection_*, charge_windows: z.array(ChargeWindowInput).min(1) }
OrderDocDates = { delivery_*(+_fs), collection_*(+_fs), days_active,
                  charge_windows: z.array(ChargeWindow).min(1).meta({ shared: "value" }) }
// removed: charge_start, charge_end (+_fs), days_charged

// order + invoice line price
chargeable_days: z.int().nullable().meta({ derived: true })   // key stays present
// credit-note.ts:172  chargeable_days: z.number() → z.int()
```

- **Windows carry no `_fs` twins and no `uid`.** They merge as one value (§5). `days` is tagged derived, so the three-way merge skips it (write-path-invariants skill :381-397).
- **Schema refine:** windows are sorted and don't overlap, comparing calendar days. ⚠️ A refine means the manager ships first.
- **API checks (they need holidays):**
  - Adjacent windows (no business day between) are refused.
  - `isNonTerminatingWindow` runs on each window.
  - Where: `assertWalkableWindow` (`services/orders.ts:684`) and `pairEdit.ts:128-140`.
  - A 0-day window is valid.
- **Pair invariant, checked on write:** in a pair with 2+ windows, every rental `five_day_week` line has `chargeable_days === Σ days`. Because of it, readers never have to guess whether a line follows its pair.
- **Bookings** (`booking.ts:427-430`) drop the charge fields. The only reader is display in `BookingDetail.tsx:64-67`, which reads the order instead. `buildBookingDates` stops copying them.

### 2. One author per derived value

- **`canonicalChargeWindows(dates, holidays)`** recounts every window's `days` and `days_active`, **except extension windows**, whose count comes from §2c.
  - It is the only writer of counts.
  - Callers: `canonicalizeDestinationDates`, `pairEdit`, `resolveMergedPairDates` (update the injected-fn type at `shared-fields.ts:484-487`), `buildRemainingInvoice`, and **`createInvoice`'s stated-destinations branch** (`services/invoices.ts:938-939`). That branch currently stores client-sent derived counts verbatim because its input is the document schema (`invoice.ts:1420`); it now canonicalizes.
- **`chargedDays(dates)`** = Σ `days`. **`chargeEnvelope(dates)`** = first start / last end. **`billableDays(days[])`** = Σ max(d, 5). All pure.
- New exports become template helpers: run `deno task check:generated`.

### 2b. `applyDateEdit(dates, edit, ctx) → { dates } | { error }` (core; manager and API)

`ctx = { holidays, prev?: dates, extension?: boolean }`. The function:
- parses in Chicago (`{ in: tz("America/Chicago") }`)
- emits via `toChicagoInstant`
- recounts through `canonicalChargeWindows`

**Edits:**
- **`set_possession { delivery_start?, collection_start? }`**
  - An `*_end` follows its start while it equals the previous start. This is not forced; `*_end` feeds booking holds, cards, activity and quote expiry, and windows on it are coming.
  - A window follows possession when the pair has one window whose bounds equal the previous possession bounds, **compared as instants, not strings**.
- **`set_possession_days { days }`**: `collection_start` moves to the date `getEndDateByChargePeriod` gives and **keeps its own time of day**.
- **`set_window { index, start?, end? }`**, **`set_window_days { index, days }`** (end keeps its own time). Both are refused on extension windows.
- **`add_window`**, **`remove_window`** (at least 1 window stays), **`reset_windows`** (one window = possession).
- **`copy_from { dates }`**: a new pair copies a previous pair's dates, then recounts (replaces `cloneDeep` at `stores/orders.ts:127-128`).
- **`default_dates { now }`**: next business day 09:00, or tomorrow when the hour is > 8 (`dates.ts:412-430`), + 5 chargeable days. The end keeps the 09:00-derived date and the 15:00 default time.

**Errors:** `non_terminating`, `overlap`, `adjacent`, `holidays_unloaded`. The last one is new: today `getDuration` counts holidays as business days while `holidays()` is `[]` (`stores/dateHelpers.ts:14-27`).

**UI-only (stays in the manager):**
- The 09:00/15:00 default time when a field is null
- `MIN_PICKABLE_DATE`, `maxEnd`
- The days/weeks display unit

**Consumers:**
- **manager:**
  - `OrderDestinationDates.tsx` handlers dispatch edits.
  - The follow effect and `saveDatesAndSync`'s end mirroring are deleted.
  - the order and invoice `ItemDuration` cells dispatches `set_window_days` for one window, or is read-only showing Σ for several.
  - `buildDefaultDocDates`, the draft seed at `OrderItems.tsx:177-197`, and `addDestinationPair` dispatch `default_dates`/`copy_from`.
  - Fix the stale "invoice doesn't mount this" comments (`OrderDestinationDates.tsx:114-120, 315-316`; `InvoiceDestinationSummary.tsx:60-80`).
- **api-cloudrun:**
  - Order PUT (`services/orders.ts:1526-1566`, after `assignPairUids`) and `pairEdit` diff the input against the **stored** pair into `set_possession`, then canonicalize. A server edit then follows exactly like the manager, without the client's first-mount blind spot.
  - After `resolveMergedPairDates`, re-apply the follow rule against the **merged** previous possession (order→invoice/fulfillment sync).
  - Test: a manager edit and an API PUT of the same dates store identical pairs.

### 2c. Extensions (carry Track R's owner rules over)

- `clipWindowsAfter(windows, billedEnd, holidays)` gives the extension pair its windows after the billed end.
  - It keeps the pair's time of day; today `addChicagoDays` puts it at midnight (`quantityAccounting.ts:719-729`).
  - `stampMovedChargeStart` (`services/invoices.ts:633`) is deleted.
- **`extensionAddedDays`** = `billableDays(order windows) − billableDays(billed windows)`.
  - It replaces `extensionChargeDays` (`price-document.ts:146`) and `added = window.days_charged` (`quantityAccounting.ts:476`).
  - Track R's rules stay:
    - extend only when the order's envelope end is later than the billed end
    - the sign must agree (a negative value means shortened)
    - the census guard against phantom extensions
    - CRMS-authored refusal
- Extension lines state the added days (all lines in the section share it, `quantityAccounting.ts:651-668, 709`). `pairEdit` no longer recounts an extension pair, which fixes a confirmed bug.

### 3. Line `chargeable_days` becomes derived

**The derivation rule, stamped by `priceDocument` in `write` mode:**

| Line | `chargeable_days` |
|---|---|
| `rental` + `five_day_week`, in a normal section | `chargedDays(pair)` |
| any line in an extension section | `extensionAddedDays` (today's rule) |
| every other type or formula (`sale`/`service`/`surcharge` stored as `five_day_week` included) | `null` (priced at factor 1, as today) |
| rental `five_day_week` line with **no pair** (e.g. under the order divider; manager `addCustomItem` can put it there, `stores/invoices.ts:1166`) | **refused** with a named 400, rather than billing a week |
| fee lines | `null` (`assembleLinePrice`, `core/src/utils/orders.ts:1505`) |

**Documents already sent out are never re-derived.** Void, paid and settled invoices, and the `probe-settled` path (`lineMoneyAgrees` ignores days), carry their **stored** line days through. Otherwise a divergence that doesn't change money (e.g. 3 → 4) would silently rewrite a paid invoice's days, and one that does change money would 400 non-money edits such as #473 repairs. **Issued, unpaid invoices do get re-derived**; the census decides their backfill (#2408).

**Delete:**
- `syncChargeDaysToItems`, `reconcileChargeDaysByDestination`, `resolveDownstreamChargeDays`, `settleScopedChargeDays`, with their tests (done in beta A)
- Their callers: `services/orders.ts:1631, 2968`, `services/invoices.ts:1304`, `core/src/utils/invoices.ts` (`settleScopedChargeDays`'s caller), `manager/src/stores/orders.ts:304-371`
- The holiday recompute becomes "recanonicalize, then reprice". Replace its positional "Nth divider owns Nth destination" mapping (`services/orders.ts:3015-3030`) with path/uid.

**Writers that stop taking days:**
- Builders: `order-lines.ts:167, 230, 268, 413`. They still emit the key as `null`.
- API: `buildLineItem` (`services/orders.ts:255-290, 395-455`) and `services/invoices.ts:454` ignore input days. This also fixes API/MCP-created rentals billing a flat week.
- `afterProductWrite.ts:686` reprices after re-typing.
- Manager: `substituteItem` (:579), custom add (:886), `setItemType` (:943-952), and the invoice equivalents (`stores/invoices.ts:943, 1180, 1219`), plus `OrderItemSearchSelect.tsx:72-77`, `InvoiceItemSearchSelect.tsx:46`, `ItemSearchSelect.tsx:145`.
- Line input schemas: drop `chargeable_days` (breaking change accepted).

**Comparators:**
- `invoicePriceDifferences` (`core/src/utils/invoices.ts`) → `computeInvoiceSyncStatus` treats days as derived, so an invoice that overrides its windows doesn't badge `out_of_sync` against the order.
- Shared-fields: `items[].price.chargeable_days` changes from propagated to derived (`core/tests/shared-fields.test.ts:92`).
- `linePriceKeySets.test.ts`: the key stays.

**Display:** manager cells already guard `> 0` (manager#330). Fixed rentals now show `null` → "Fixed" (`items-grid.eta:247`).

### 4. Pricer

- **`PriceDocumentContext.charge_windows: { divider_path; days: number[] }[]`** is required: every caller fails to compile until it passes one.
  - Build it with `chargeWindowContext(destinations)` from **stored** window days; no holidays.
- **`perUnitSubtotal` for rental `five_day_week`:**
  - Pair with 2+ windows → factor `billableDays(days)/5`.
  - Single window → today's `max(line days, 5)/5`.
  - Extension → `extensionAddedDays/5`, with no floor.
  - Integer arithmetic, rounded once (cfs-money).
- **Line seeds: delete the money call** and let `priceDocument` fill it in:
  - `services/orders.ts:255`, `services/invoices.ts:534`, `afterProductWrite.ts:686`, `manager/src/stores/invoices.ts:877`
  - Check each for readers of the interim value first.
- **The audit oracle stays independent and reads stored inputs only** (api-cloudrun#997 D2):
  - Stored line days, plus the stored pair window days via the same context. It never recounts.
  - Legacy divergent lines all sit in single-window pairs after the backfill, so they re-derive exactly as today.
  - Pass `extensions` too; it omits them today, and extension invoices probably show as drift. Check prod.
  - Callers: `settlementProjection.ts:235`, `api-cloudrun/scripts/audit-transaction-fee-lines.ts:230`.
- **`priceCreditNote` credits as billed:** stored line days, plus the stored pair window count (multi-window factor only when the credited line's pair had 2+ windows).
  - Credit notes have never stored non-null days (146/146), so test crediting an extension line, a multi-window line and a legacy divergent line explicitly.

### 5. Shared-field merge

- `classifySharedFields` (`shared-fields.ts:247-261`) currently throws on a uid-less object array. Teach it `.meta({ shared: "value" })`; the existing deep compare/copy handles the rest.
- Update:
  - the `DATES` and items snapshots
  - `PAIR_DATE_BOUNDARIES` (`shared-fields.ts:431-438`)
  - `BOUNDARIES` plus the header comment in `pairEdit.ts:23-73`
  - `routes/fulfillmentEdits.ts:268`

### 6. Readers moved to `chargedDays` / `chargeEnvelope` / windows

- **core:**
  - `deriveOrderDateEnvelope` (`core/src/utils/orders.ts:537`)
  - `pairWindow`/`orderLineWindow`/`extensionGroups`/`buildRemainingInvoice` (`quantityAccounting.ts`)
  - `computeDocumentDiffs` (`documentDiff.ts:792`)
  - `getDuration`/`DurationDates` (the charge half is removed)
  - Typesense `schemas/typesense/{orders,fulfillments,documents}.ts`, `display-columns.ts:158-159`
  - Propagation text: `propagation/orders.ts:362, 417-420`, `core/src/schemas/propagation/fulfillments.ts:224`
  - Regenerated files; `CLAUDE.md:678, 691`
- **api-cloudrun:**
  - `lib/orderFulfillmentSync.ts:668`, `lib/typesenseTranslate.ts:549`, `lib/orderHelpers.ts:66-112`
  - `lib/xeroQuoteStatus.ts:122-123`, `services/xeroQuotes.ts:291, 308`, `lib/trello.ts:90`
  - Scripts: `audit-invoice-override-classes.ts:99`, `audit-order-invoice-coverage.ts`, `audit-line-price-provenance.ts:188`, `audit-document-grain-parity.ts:356`, `repair-missing-bookings.ts:33`; retire `backfill-invoice-destination-windows.ts`
  - Skill `write-path-invariants/SKILL.md:390` (the `derived` example becomes `charge_windows[].days`)
- **manager:**
  - `DestinationDatesSummary.tsx:84-145`, `InvoiceDestinationSummary.tsx:104-117`, `BookingDetail.tsx:64-67`, `createOrderInvoiceCoverage.ts:111`
  - `ProductPriceCells.tsx`, `InvoiceProductPriceCells.tsx`, `utils/itemColumns.ts:147`, `DiffRow.tsx:56`
  - `order-items` skill :248 ("quantity, days, discount")
- **templates** (feature branch + PR):
  - `partials/shared/destinations.eta` and `items-grid.eta` list each window with its days, plus Σ.
  - Update about 30 `fixtures/**`.
  - Single-window output stays identical.
- **Before the purge:** grep every skill (including the cfs-skills plugin: cfs-items, cfs-money, cfs-template-authoring) and every plan doc for `days_charged`, `charge_start`, `charge_end` and "hand-set days".

## Census before building (read-only, prod, full paging; record the counts here)

1. **Lines whose `chargeable_days` ≠ their pair's `days_charged`**, bucketed by:
   - document type/status: draft/live order; issued unpaid invoice; paid/void/settled invoice
   - extension section vs not
   - `crms_id` or not
   - **split billing** (invoice pair covers the full order window but its lines bill fewer days)

   Owner decides per live bucket: a real difference in duration → split into its own pair or edit the invoice windows; a mistake → reprice. Anything sent out is untouched.
2. **Non-rental lines stored as `five_day_week`** (confirm they derive `null` and their money doesn't move).
3. **Rental lines with no pair.**
4. **Pairs where charge ≠ possession, and pairs with a null charge bound.**
5. **Existing extension pairs**: `extensionAddedDays` must reproduce their stored count.

## Release order (follow the cfs-release-order skill; write it into each PR)

1. **core beta A:**
   - `charge_windows` added to the stored schema (optional for now), `applyDateEdit`, the classifier rule, the helpers, the required pricer context, derived line days
   - old fields still in the schema
2. **Manager, then the API right after** (breaking input accepted). Writers write `charge_windows` **and** keep writing the old fields (derived from the windows).
3. **Backfill** (dev, then prod; orders, invoices, fulfillments, template fixtures), taking a baseline first:
   - One window from `charge_start ?? delivery_start` → `charge_end ?? collection_start`, with `days` = stored `days_charged`, **copied, not recounted**.
   - Extension pairs: the clipped window; assert `extensionAddedDays` equals the stored count.
   - Census buckets per owner decision.
   - **Assert every paid/void/settled invoice and credit note is unchanged. List every live or issued-unpaid total that moves** for owner sign-off. Those re-push to Xero.
4. **core beta B:**
   - `charge_windows` required
   - all readers switched
   - bookings stop carrying charge fields
   - then the manager, the API, and a templates merge
5. **Stop writing, purge, remove from the schema:**
   - Stop writing the old fields and line input days.
   - **Purge** `charge_start`/`charge_end`(+`_fs`)/`days_charged` from orders, invoices, fulfillments, bookings and fixtures (dev, then prod).
   - **Remove them from the core schema** (beta C).
   - Force a prod Typesense resync before the manager release that reads the new index shape.
6. Enable the multi-window UI.

The api pre-push gate runs against dev data, so dev has to be converted before each push. Pin every consumer to each beta right after publishing it.

## Verification

- **core:**
  - Property sweep: for any single-window pair, the new pricer and helpers give the same days and cents as the old code.
  - Worked cases: [3,4,2] → 3.0×; [3,0,4] → 3.0×; [8,7,6] → 4.2×; a flat discount scales the same way.
  - Non-rental `five_day_week` lines stay at factor 1.
  - A rental line with no pair is refused.
  - A settled invoice keeps its stored divergent days through `probe-settled`.
  - `applyDateEdit`, every edit:
    - DST crossing
    - holidays inside a window
    - a following vs an edited window when possession moves
    - an end following its start while equal
    - the end keeps its time
    - `holidays_unloaded`
    - extension windows refuse `set_window*`
  - Extensions:
    - adding a 2-day window after billing [3,4,2] adds 5 days
    - a window cut at the billed end
    - removing a window → negative
    - single windows match today's `extensionChargeDays`
  - Shared-fields snapshot: `unhandled == []`.
  - The audit oracle matches on multi-window, extension and legacy divergent invoices.
  - Credit notes on an extension line, a multi-window line and a legacy line.
- **api-cloudrun (dev):**
  - Create an order with 3 windows. Check stored `days`, bookings spanning possession, and no charge fields on bookings.
  - Invoice it: 3.0 × base.
  - A PUT that moves possession gives the same windows as the manager edit.
  - Edit a window and confirm it syncs to an unpaid invoice's pair and lines without an `out_of_sync` badge on an overridden invoice.
  - Partial bill by editing invoice windows.
  - Extension invoice.
  - Holidays: add one inside a draft's window and it reprices; inside a paid invoice's window, nothing changes.
  - Suite, plus backfill dry-run parity.
- **manager:** open the rendered page and check:
  - adding/removing windows reprices
  - a single-window duration box moves the window end and keeps its time
  - multi-window duration is read-only
  - one window follows possession
  - an invoice pair edit
- **templates:** single-window goldens don't change. Add a multi-window fixture and render a preview.

## Follow-ups

- api-cloudrun#1028 (credit-note offer for over-billing) gains a population once windows can be removed after billing. Comment on it when this lands.
- If census bucket 1 shows live CRMS divergence beyond #2408, decide with the owner before the backfill. It must not be silently repriced.

No open issue overlaps (api-cloudrun#680 belongs to the quantity-accounting campaign, which finishes first). Promote this to `core/.claude/plans/charge-windows.md` when implementation starts, because it spans sessions and four repos.

## Context recommendation
**Context:** CLEAR CONTEXT — the doc carries the decisions, census counts and file map; implementation is large.
**Execute with:** opus — derived days and the pricer are money paths where a wrong diff compiles and passes.
