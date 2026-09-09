# Aligning the order / invoice / fulfillment schemas

*Promoted from a machine-local draft on 2026-09-09. Owning repo is `core` — the schemas are
the work; `api-cloudrun` owns only the census/backfill script this doc names.*

> ## ⚠️ STATUS 2026-09-09 — core#97 is STRUCTURALLY COMPLETE. Every grain-sharing piece has shipped.
>
> **The three grains now share one declaration per shared field, and each sharing has a guard.**
> Nothing in this plan is outstanding. What remains are the SPIN-OFFS below, each with its own
> issue.
>
> | shared thing | how | guard | beta |
> |---|---|---|---|
> | line-item core fields | **SPREAD** (`schemas/_items.ts`) | `tests/item-shape-parity.test.ts` | `.387`–`.391`, spread at **`.398`** |
> | destination pair | SPREAD (`DestinationPairCore`) | `tests/destination-pair-parity.test.ts` | `.391` |
> | `subject`, `reference` | one declaration per grain | `tests/subject-parity.test.ts` | `.394` |
> | dividers | already shared (`_dividers.ts`) | — | pre-existing |
> | **input schemas** | fulfillment got its first | `tests/fulfillment.test.ts` | **`.396`** |
> | **totals** | per key (`TotalsCore`) | `tests/totals-parity.test.ts` | **`.397`** |
> | **member naming** | invoice adopts the MEMBER convention | the compiler | **`.397`** |
>
> Consumers, all landed: api-cloudrun `eaf4eed4`, manager `19a092d`, both at `.398`. templates is
> on `.397` and peer-owned — `.398` is pin-only there, but it reorders
> `src/schemas/template-schema-fields.generated.ts` (same members), which is that repo's render-context
> surface, so it is the one file to eyeball rather than rubber-stamp.
>
> ### 🔴 The one rule this campaign produced, stated three times before it was right
>
> **Whether a shared shape can be SPREAD is decided by agreement on KEY ORDER, not by contiguity.**
> A schema's key order is its Firestore-surface column order, so a spread is an operator-visible
> column move wearing a refactor's clothes. Three questions, three answers:
>
> - **line item — SPREAD at `.398`, reversing this campaign's own earlier ruling.** ⚠️ The ruling
>   was *"no key order leaves all three grains unchanged, therefore reference per key"*. It is TRUE
>   and it answers the wrong question: it is a claim about preserving the status quo, not about
>   whether the status quo is worth preserving. Asked the second way — *"are the distinct
>   arrangements NECESSARY?"* — the answer is **no**:
>   - only FOUR of the six are columns at all (`uid` and `path` carry no `column` meta);
>   - three of those four — `name`, `description`, `quantity` — already sat at IDENTICAL positions
>     in all three grains, behind `type`;
>   - the one that differed, `zero_priced`, differed **only because of how many grain-specific
>     fields happened to precede it** (index 21 / 17 / 5). Accretion, not design;
>   - and NO `items.*` column is default-visible — all three `displayDefaults.columns` are
>     `number`, `organization.path`, `subject`, `status` (+ `reference` on invoices) — so item key
>     order reaches the column PICKER and nothing an operator sees without opting in.
>
>   ⭐ **Keeping each grain's own `type` AHEAD of the spread was what kept the cost to one column.**
>   All three already led with it. The whole measured change is `zero_priced` → index 4 on all
>   three; both consumers needed zero source edits, which is the real check on a reorder.
>
>   🔴 **And the dump behind the original ruling was VACUOUS on exactly this point.**
>   `getFirestoreColumns` takes a COLLECTION NAME; it was passed a schema object, returned `[]`,
>   and three of the nine "byte-identical surfaces" compared empty to empty. It is the ONLY one of
>   the three that can see an `items[]` key-order change — `getTypesenseColumns` iterates
>   `config.schema.fields`, and `getInitialValues` returns `[]` for an array without descending.
> - **destination pair — CAN spread.** The shared fields are the whole object in its existing order
>   and the invoice's only extra key already sat first.
> - **totals — cannot spread.** Contiguous in both, and *still* not spreadable:
>   `discount_amount_cents` is FIRST on the order and THIRD on the invoice.
>
> ⭐ The totals case is the one that sharpened the rule — contiguity looked sufficient and is not.
> Every non-spread case puts the anti-drift guarantee in a parity test asserting **instance
> identity**, never structural equality: `z.globalRegistry` is keyed on the instance, so a
> separately-declared twin carries none of the base's `.meta()` and every heading silently vanishes
> while a structural check stays green. **Confirmed by planting the defect** on the totals arm.
>
> ⚠️ **The "nine surfaces byte-identical" verification was PARTLY VACUOUS — corrected, and the
> corrected instrument is what licensed the `.398` spread.** `getFirestoreColumns(collection: string)` takes a COLLECTION
> NAME; the dump passed it a schema object, so it returned `[]` and three of the nine members
> compared empty-to-empty. The other six were real (`getInitialValues` 24/28/12 keys,
> `getTypesenseColumns` 62/24/32).
>
> 🔴 **And the surface that was vacuous is the only one that could have seen an `items[]` key-order
> change.** `getInitialValues` returns `[]` for an array without descending, and
> `getTypesenseColumns` iterates `config.schema.fields` rather than the shape — so **no surface in
> that dump ever covered the LINE ITEM's key order**, which is the one the no-spread ruling was
> made about. The totals and destination-pair claims are unaffected: both are document-level
> objects, so `getInitialValues` walks into them and its JSON key order reflects the shape.
>
> **The real instrument is `getFirestoreColumns("orders" | "invoices" | "fulfillments")`**, and run
> properly it reports 62 / 63 / 25 columns, of which 23 / 19 / 7 sit under `items[]`. Use that
> before making any further key-order claim.
>
> ### What is left — all of it now lives on issues, not here
>
> - **core#100 (increment 1a)** — ~9,214 component rows stating no `zero_priced`. Its own campaign,
>   and a `kind:decision` first: the census counts rows that do not STATE the flag and cannot say
>   which were meant to be charged. ⚠️ Its numbers moved inside a day; re-derive before sizing.
> - **core#103, api-cloudrun#943, api-cloudrun#944** — the § *2* bookings findings. Both renames
>   § *2* proposed are REFUSED on the evidence; see below.
> - **§ *4*'s remaining half** — canonicalising `OrderItemLine` vs `InvoiceItemInputLine` across
>   grains. Deliberately NOT done: unlike the invoice's inverted members, neither spelling is
>   wrong, and `FulfillmentLineItem` lacking a `Doc` segment is now *accurate* rather than sloppy.
> - ⚠️ **One live inconsistency this pass exposed and did not fix:** the three input schemas
>   disagree on `path`. `OrderItemLineInner` requires it, `InvoiceItemInputLineInner` has
>   `.optional()`, and `FulfillmentItemInputLineInner` requires it. The invoice is the outlier;
>   tightening it is a client-supplied-input refinement, so it needs the writer check first.
>
> ### Increment 3 — the two § *3* rulings, SHIPPED as `@cfs/core@10.0.0-beta.394`

>
> All four repos landed: core `f816cbc`, api-cloudrun `4e4f67c6` + `05ae7b4a` + `0941c8db`,
> manager `e2c5900`. `templates` handed off at `.393` with its corpus verified (below).
>
> **`subject` is now one bare `z.string()` at all three grains** — required, present,
> non-nullable, `""` for absence. It was `z.string().nullable()` on the invoice and
> `z.string().default("")` on the other two, so "no subject" had two spellings AND the key had two
> presence rules. `tests/subject-parity.test.ts` guards it BEHAVIOURALLY rather than by instance
> identity, which is forced: each grain's `.meta()` carries its own `linkTo` and `.meta()` clones,
> so three annotations mean three instances however the shape is written.
>
> 🔴 **The census did not license the invoice half, and that is the durable lesson.** 0 null and 0
> absent across all three grains in both projects — and `CreateInvoiceInputType.subject` is
> `z.string().optional()`, so the very next invoice created without one would have been written
> `null` and refused. `orders.crms_status` verbatim. **The writer moved first** (`4e4f67c6`,
> `createInvoice` writes `?? ""`, in prod as of v0.245.0) and core tightened after.
>
> ⚠️ **`Invoice.destinations` — I was wrong to frame this as "no lower bound", and the correction
> is the useful part.** The bound EXISTS and is CONDITIONAL: `InvoiceSchema`'s document `.refine()`
> already says `query_by_orders.length === 0 || destinations.length >= 1`. What this pass added is
> the measurement behind the exemption — **31 stored invoices carry `[]` and every one is a flat
> CRMS-ingested invoice with no source order** (`crms_id` present, `number_orders` empty,
> `query_by_orders` empty; 26 from the 2025-12-02 import, 5 from the CRMS webhook 2026-07-28 →
> 08-17), and **0 of 1,040 are empty AND order-linked** in either project. So an unconditional
> `.min(1)` is strictly stronger than the refine and would refuse all 31 on their next write.
> **Do not add one.**
>
> 🔴 **What WAS a defect is the `.default([])`, now dropped** — inert on a write, so its one effect
> was to let a writer omit the key, which **2 invoices did** (#1698, #1421) against a non-optional
> declaration. Repaired in prod and dev with owner approval before the schema moved. ⭐ **The
> invariant that says the repair worked is that the absent-or-empty TOTAL stayed 31**: the 2 moved
> between classes and nothing entered or left the population. ⚠️ Dev needed no separate run —
> `devReplica` mirrored the prod write, so "clean in both" was ONE confirmation, not two.
>
> ### Increment 2 (bookings) — AUDITED, and both renames are REFUSED on the evidence
>
> The plan said *"if it is not a clean alias, file the finding rather than force it."* Neither is.
>
> 🔴 **`Booking.dates` is a per-item-type DERIVATION, not a renamed subset, and the premise in
> § *2* was wrong.** `buildBookingDates` (`api-cloudrun/src/lib/orderHelpers.ts`): `start` is
> `delivery_start` in all three branches — a clean alias — but **`end` is `collection_START`, not
> `collection_end`**, and is `null` for `sale`; `charge_start`/`charge_end` pass through for
> rental/service and become `delivery_start`/`null` for `sale`. Three of the four fields are not
> aliases of anything. ⭐ **And the current names are BETTER than the pair's**: a booking has a
> start and an end, and which order field the end was derived from is an implementation detail the
> rename would have promoted into the schema. **The rename is refused; no issue is filed for it,
> because there is nothing left to do.** What the audit turned up on the way is filed:
>
> - **core#103** — `Booking`'s flat `uid_destination_*` pair is **asymmetric**, which is exactly
>   what made it read as one decision. `uid_destination_delivery` has a composite index
>   (`bookings: [uid_destination_delivery, status]`) AND a live `.where()` in
>   `api-cloudrun/src/services/pickSheets.ts`, so
>   it is real query surface; `uid_destination_collection` has neither and is read only in-process
>   by `api-cloudrun/src/lib/eventCards.ts`. Neither is checked against its nested twin —
>   `api-cloudrun/src/lib/bookingDestination.ts` has an
>   `idFieldDisagreement` check on the delivery side and nothing on the collection side.
> - **api-cloudrun#943** — `OrderDocDates` models a collection WINDOW and three consumers each
>   collapse it differently. **1,020 of 1,020 pairs have `collection_start === collection_end`** in
>   both projects, and that is a fact about the WRITER: the manager mirrors `collection_end` ←
>   `collection_start` and has no independent editor. `booking.dates.end` feeds `stockSummary`, so
>   the first non-zero window would release a unit while it is still out.
> - **api-cloudrun#944** — `Movement.path`, filed as the `kind:decision` § *2(b)* said to file
>   rather than guess. Append-only journal, so the field is stampable going forward and absent on
>   history.
>
> ### Five things this pass learned that outlive it
>
> 1. 🔴 **A tightening's real blast radius is in the SEEDS, and only the fullest gate finds it.**
>    `.394` broke **12 hand-spelled `subject: null` integration seeds across 8 files**. `deno check`
>    is blind (untyped literals), `test:units` cannot reach them (they need live dev), and grepping
>    `subject` finds the seeds that already MENTION it — the opposite of the dangerous set.
>    ⭐ **10 of the 12 were a DELETION, not a correction**: they spread `getTestDoc(InvoiceSchema)`
>    and were overriding a default that had been right all along.
> 2. ⭐ **A seed patched five times is asking to be converted.** `webhooks/xeroPayment.test.ts`'s
>    `seedInvoice` had been hand-patched for `subject`/`uid_thread`, `reference`, `notes`,
>    `pdf_params` and `pdf_params_context`, with a comment each time predicting the next. It is
>    `getTestDoc` now. The one seed deliberately NOT converted is `users/userNameCascade.test.ts`,
>    because that cascade validates the PATCH rather than the merged document, so its seed is
>    partial on purpose.
> 3. 🔴 **`in` narrows the OBJECT, never an already-`.optional()` property.** `updateOrder` had
>    `if ("subject" in update) updatedOrder.subject = update.subject;` — it type-checked while
>    proving nothing, and became an error only when the field stopped being optional. Guard on the
>    VALUE. ⚠️ `reference` beside it correctly keeps its key test: it is `.nullable()`, where
>    `null` is a real answer.
> 4. ⭐ **A question in a census is a claim about a POPULATION, and the label is the only place the
>    population is stated** (api-cloudrun#941, raised by the script's own author against their own
>    work). `destination pair flag missing or non-boolean: 0` fired in the invoices block alone and
>    read as document-wide. Every label is grain-qualified now, the pair question is asked at all
>    **three** grains (fulfillments carry the same `DocDestination` and had never been read — 0),
>    and a question whose non-zero answer is a RULING carries an `expected()` marker so the gate
>    does not teach its reader to ignore it.
> 5. ⚠️ **A gating census against live dev can read non-zero because a PEER'S SUITE is mid-run.**
>    One dev run read `subject key ABSENT: 1` and the next read 0; `pgrep -fl "deno.*test"` answered
>    it in one call. Check for a running suite before believing a dev number, in either direction.
>
> ### Standing verification notes
>
> - 🔴 **Verify a core publish against the PUBLISHED TARBALL and print the installed version inside
>   the probe.** Done for `.394` from `manager/node_modules` — 9/9 subject arms across three grains,
>   `destinations` accepting `[]` and refusing `undefined`, and both whole-document refusals
>   asserting the ISSUE PATH rather than just `success === false`.
> - ⭐ **`getInitialValues` + `getFirestoreColumns` + `getTypesenseColumns` for all three
>   collections, dumped before and after: eight of nine surfaces byte-identical including column
>   order.** The ninth changed by exactly one value — `invoices` initial `subject` `null` → `""` —
>   which is the intended effect.
> - ⭐ **`templates` was cleared by running the REAL validator over the REAL corpus**, not by
>   reasoning about which declarations could reach a fixture: `validateFixtureDoc` over
>   `fixtures/**/*.json` at `.394` reads **38 valid, 0 invalid**. ⚠️ Its first run said 2 invalid
>   and both were a collection MAPPING error of mine — a probe failure reads exactly like a
>   negative result.
> - ⚠️ **The § *0* census table is a SNAPSHOT presented as a state.** Three of its rows moved inside
>   a day. Re-run `api-cloudrun/scripts/audit-document-grain-parity.ts` rather than citing it.
>
> **NEXT: `TotalsCore`, then § *4* if it is ever worth it. Nothing is blocked.**

## Status — this runs AFTER the core#91/#92/#93 campaign

**Nothing here is started.** The campaign that precedes it has LANDED — core#91, core#92 and
core#93 are closed and the fixture corpus merged as templates#292 — so its plan doc
(`core/.claude/plans/fixture-pii-identity.md`) is deleted, per the convention that the commit
landing a campaign's last piece removes it. This doc is the follow-on work.

The two are deliberately separate: the campaign's corpus is the committed `templates`
fixtures, this one's is stored Firestore documents across `orders`, `invoices` and
`fulfillments`. Different corpus, different failure mode, and this one is gated on a census
that has not run. Consolidating them would produce one unshippable campaign.

### Findings handed to that campaign on 2026-09-09 — recorded, not owned

Delivered by message to the session planning it; `fixture-pii-identity.md` was their home and
is now deleted with that campaign, so what follows is the surviving copy rather than a
duplicate. Kept because they were expensive to measure and cheap to keep, and because a reader
of THIS doc may wonder whether they were checked.

- **The staleness in that plan is LOCALIZED.** Its `core#91` half is citation-exact —
  `fixture-pii.ts` `:533`/`:611`/`:658` and `walker.ts` `:130`/`:335`/`:415`/`:454` all
  verified, plus `schemas/reporting.ts:492-512`. Only the pick-sheet surface moved
  (`pick-sheet.ts:466`/`:560` → `:522`/`:616`), and core#93's own issue body carries the same
  stale pair.
- **The org-ref census is complete: exactly three `{uid, name}` survivors, zero siblings.**
  `movement-session.ts:188-191`, `pick-sheet.ts:555-558`, `pick-sheet.ts:657-660`. Every
  stored collection already carries `{uid, path}` — `Booking`, `OutOfService`, `Card`,
  `Fulfillment`, `DocumentOrganizationSnapshot`, all four `schemas/reporting.ts` surfaces. All three
  survivors are non-stored fold documents, which is *why* they were skipped.
- **The campaign is entirely outside propagation.** None of `pick-sheets`,
  `movement-sessions`, `statements` or `aging-reports` is a `CollectionName`, so zero rules
  and zero `fields[]` paths name any of it, `tests/propagation.test.ts`'s path walk cannot
  reach them, and no new transaction id is needed. The only `statement-documents` reference is
  `propagation/uploadcare.ts:123`, about uuids.

⚠️ **One correction worth carrying, because it is a reasoning error rather than a fact.** I
first read `core/src/utils/pick-sheet-fold.ts:401-405` — *"a derived value is fine to
deliver"* — as a settled ruling that refuted core#93, and recommended re-scoping the issue.
That was wrong: the fold is the SUBJECT of that campaign, not the authority on whether it
needs one, and a comment landed the previous day is not a ruling. **Using the thing under
review to adjudicate whether it needs reviewing is circular** — and it is an easy mistake to
repeat here, because this doc reviews schemas whose docblocks argue for themselves too.

## Context

`orders`, `invoices` and `fulfillments` are three grains of one document. The invoice is the
order's line-item model **plus** an `order` divider (so one invoice can bill several orders);
the fulfillment is the same model **minus** price, totals and the fee line type. An order is
the source; on order update a diff propagates into the other two and deliberately preserves
whatever they have overridden.

That relationship is real and well-modelled at the *vocabulary* level — `ITEM_CONTRACTS`,
`DOC_LINE_ITEM_TYPES`, `_dividers.ts`, `PriceModifier`/`TaxRef`/`Discount` are all declared
once and shared. It is **not** modelled at the *shape* level: every line-item schema, every
price schema, every totals schema and the invoice's destination pair are independent
hand-listed `z.strictObject`s. They have already drifted, and the drift is not theoretical:

> `9435a15` (2026-09-08, the commit immediately before this session) made
> `DocDestination.customer_collecting` / `.customer_returning` **required**, with a 🔴 comment
> explaining that the `.default(false)` they carried "did the opposite of what it looked
> like" — `validateBeforeWrite` discards `result.data`, so the default never materialised and
> its one effect was to let a writer omit a flag that "reads as *we deliver*, which is the
> answer that sends a crew to an address."
>
> `InvoiceDocDestination` — a hand-copy of the same six keys — **still carries both
> defaults.** Its census (`orders: 1019, fulfillments: 1019`) never looked at `invoices`.

`invoice.ts:582` already says why, in its own words: *"🔴 THIS LIST INHERITS NOTHING."* The
type `extends DocDestinationType`, the schema inherits nothing, and the compiler cannot see
the gap — only a write can.

**The goal: make the shapes share one declaration so they cannot drift again, fix the
divergences that are already wrong, and settle the ones that need a ruling.** Scope also
covers bookings' date/destination vocabulary, per the session's scoping decisions.

---

## What is actually wrong

Grouped by the three halves you named. Every row was read, not inferred.

### A. Line items — no shared base, and it has already drifted

`OrderDocLineItemInner` (`src/schemas/order.ts:1007`), `InvoiceDocLineItemInner`
(`src/schemas/invoice.ts:378`) and `FulfillmentLineItemInner`
(`src/schemas/fulfillment.ts:135`) each restate `uid`/`name`/`description`/`quantity`/`path`/
`zero_priced`. Three of those six already disagree:

| field | order | invoice | fulfillment |
|---|---|---|---|
| `name` | `.min(1).max(100)` | **bare `z.string()`** | `.min(1).max(100)` |
| `quantity` | `z.number().int().min(0)` | **`z.int()` — no `.min(0)`** | `z.number().int().min(0)` |
| `price.chargeable_days` | `z.number().int()` | **`z.number()` — no `.int()`** | — (no price) |

An invoice line can therefore store an empty name, a negative quantity, and 2.5 chargeable
days. The last one contradicts `CLAUDE.md` § *Stored money is integer cents* directly: *"an
INTEGRAL quantity is `z.int()` … a count of things — units, documents, attempts, **days**."*

🔴 **`checkZeroPricedAmount` does not run when an invoice document parses.** The order
attaches it to the **Inner** const (`order.ts:1064`), so it is inside `OrderDocItem`. Invoice
(`invoice.ts:404`) and fulfillment (`fulfillment.ts:158`) attach it to the *exported alias*
only, while `InvoiceDocItem` (`invoice.ts:444`) and `FulfillmentItem` (`fulfillment.ts:192`)
are built from the un-refined `Inner`. So `validateBeforeWrite` on an invoice never asks
whether a `zero_priced` line carries a charge. On fulfillment the check is vacuous (no
`price` — it returns early at `schemas/common.ts:1156`), so **invoices are the only real exposure.**

### B. Dates & destination

- `OrderDocDates` (`src/schemas/order.ts:153`) is already shared by all three — order and
  fulfillment through `DocDestination`, invoice through `InvoiceDocDestination`. ✅
- `InvoiceDocDestination` (`src/schemas/invoice.ts:570`) hand-restates `DocDestination`'s six
  keys and has diverged on the two flags (above).
- `Invoice.destinations` is `.default([])`; order and fulfillment are `.min(1)`.
- `Booking.dates` (`src/schemas/booking.ts:165`) is a **renamed subset** —
  `{start, end, charge_start, charge_end}` + `_fs` twins, where the pair says
  `delivery_start` / `collection_end`. No `days_active` / `days_charged`.
- `Booking` carries a **third spelling of the destination join**: `destinations.{delivery,
  collection}: {uid, address}` *and* flat `uid_destination_delivery` /
  `uid_destination_collection`.
- `PickSheetDestination.due_at` (`src/schemas/pick-sheet.ts:506`) is a bare
  `z.string().nullable()` — **no `chicagoInstant()` / `chicagoStartOfDay()` factory at all**,
  on a field a rendered surface prints.

### C. Totals

`OrderDocTotals` (`src/schemas/order.ts:1164`) and `InvoiceDocTotalsSchema`
(`src/schemas/invoice.ts:522`) share six byte-identical declarations and each append a tail
(`replacement_total_cents` / the four settlement fields). The intersection is **already
hand-declared once more** at the utils layer — `DocumentTotalsCore`
(`src/utils/orders.ts:1588`), whose own docblock admits it is *"one of the places a rename
does NOT arrive as a compile error automatically."* Fulfillment correctly has no totals.

⚠️ **`replacement_total_cents` being order-only is correct, not a divergence.** An invoice
price has no `replacement_cents`, so an invoice structurally cannot compute one. Written down
so it is not re-proposed.

### D. Naming — three schemes for one role

| role | order | invoice | fulfillment |
|---|---|---|---|
| stored line | `OrderDocLineItem` | `InvoiceDocLineItemSchema` | `FulfillmentLineItem` |
| stored line type | `OrderDocLineItemType` | `InvoiceDocLineItem` *(no suffix)* | `FulfillmentLineItemType` |
| input line | `OrderItemLine` | `InvoiceItemInputLine` | — (none) |

### E. Two casts that say the supertype claim is not true

`LineItem` (`src/utils/orders.ts:131`) claims *"Every member of `OrderDocItemType`,
`InvoiceDocItemType` and `FulfillmentItemType` is assignable to it."* Two call sites say
otherwise:

- ✅ **`src/utils/fulfillment-items.ts` — the `computeItemPaths(out as never) as FulfillmentItemType[]` cast is GONE (2026-09-09, increment 1).** It turned out not to be a variance wall at all: with `isStructural` replaced by core's new `isFulfillmentLineItem`, `computeItemPaths(out)` type-checks directly. The `as never` had been *defeating* the generic (`T = never`) and casting the result back, so removing it made the call properly generic rather than merely tidier.
- `api-cloudrun/src/lib/firestoreWrite.ts:405` — `assertArrayUniqueness` keeps orders and
  fulfillments in **separate branches** for one rule, because `T[]` is invariant and a
  fulfillment line has no `price`. Merging them previously forced `T = any` and made the
  constraint vacuous.

Plus **core#90**: core exports no fulfillment-grain item guard, so the predicate is written
four times in three repos and two copies return `boolean` and narrow nothing. This pass is
its natural home.

### F. What the propagation machinery constrains (do not break these)

Confirmed by tracing `api-cloudrun/src/lib/orderInvoiceSync.ts` and
`api-cloudrun/src/lib/orderFulfillmentSync.ts`. Two corrections to the mental model, both of
which shape the design:

1. **The invoice freeze is per ROW, not per field.** If any comparable field on a line
   differs from the previous order's projection, the whole line is left alone
   (`src/utils/invoices.ts:1305`). The only per-field merges are the seven
   `INVOICE_ONLY_ITEM_FIELDS` (`src/utils/invoices.ts:447`) and `jurisdiction` on pairs.
2. **Fulfillments do not work that way at all.** The projection wins unconditionally on the
   whole non-items surface; on items it is a `(prevOrder, nextOrder, stored)` table with a
   **custody-based freeze driven by `bookings`**, not by field equality. Only `quantity` is
   field-level.

🔴 **`invoiceItemDifferences` (`src/utils/invoices.ts:796`) diffs KEY SETS.** A comparable
field present on one grain and absent on the other reports **every paired line permanently
out of sync** — this has happened three times (`base_percent`, `crms_id`,
`price.discount_percent`: 8,015 of 8,978 paired lines). **Any field this pass moves onto or
off a line arm must be checked against that comparator before it lands.**

⚠️ **`INVOICE_ONLY_ITEM_FIELDS` must NOT be derived from the schema shape.** It looks
derivable and is not: `coa_revenue` is on the order line too and `path_substituted_for` is on
fulfillment, so the list is an **override policy**, not a structural difference. It can be
*type-checked* against the schema (every member is a key of the shape) — that is the guard to
add, not a derivation.

---

## Design — spread shared SHAPES, do not `.extend()` schemas

The house pattern already exists and is the right one: `...TimestampFields`
(`src/schemas/common.ts:106`), and `DocDestinationEndpoint` used as **one instance** for two
keys with `.meta()` cloning per key (`src/schemas/order.ts:400`).

New internal module — call it `_items`, in `src/schemas/`, alongside `_dividers.ts` and for the same
reason its header gives: the consts must stay **un-annotated** so `_zod.propValues` survives
for `z.discriminatedUnion`, and JSR's `no-slow-types` forbids an un-annotated symbol in the
public API — so it must not be an entrypoint and must not be re-exported from `schemas/mod.ts`.

```ts
/** Every items[] line at every grain. One instance per field, shared by reference. */
export const LineItemCore = {
  uid: ItemUid,
  name: z.string().min(1).max(100).meta({ pii: "none", column: true }),
  description: z.string().meta({ pii: "none", column: true, label: "Description" }).default(""),
  quantity: z.number().int().min(0).default(0).meta({ column: true, label: "Quantity" }),
  path: z.array(ItemUid).default([]),
  zero_priced: z.boolean().nullable().optional().meta({ column: true, label: "Zero Priced" }),
};
// PriceCore, TotalsCore, DestinationPairCore follow the same shape.
```

Each grain then reads `z.strictObject({ ...LineItemCore, type: <its own enum>, …its own
fields })`. `type` is **not** in the core shape — the three vocabularies genuinely differ
(`DOC_LINE_ITEM_TYPES` vs `FULFILLMENT_LINE_ITEM_TYPES`).

**Why a shape spread and not `extendChecked`.** `.extend()` re-declares a field as a *new
instance*, and `z.globalRegistry` is a WeakMap keyed on the instance — so the extension
carries **none** of the base's `.meta()`. That drives `applyPii` masking and every table
heading, and a dropped `pii` tag is invisible to `tests/pii.test.ts` by construction
(`src/schemas/_extend.ts:8-29`). A spread shares the instance, so there is nothing to drop.
A grain that genuinely needs a different label writes `LineItemCore.name.meta({ … })`, which
clones **visibly at the call site**.

⚠️ `tests/meta-preservation.test.ts` **forbids a bare `.extend()`/`.merge()` in `src/`**.
Do not reach for one.

On the TypeScript side, one `interface LineItemCoreFields` that all three line interfaces
`extend`. `tests/interface-optionality.test.ts` already checks interface `?` against schema
optionality, so the shared fields become consistent by construction.

---

## Increments

### 0 — Census first (read-only, both environments)

**Gate on this. Every tightening below is only safe where the count is 0.** Reads in
api-cloudrun cast (`docData<T>` is `snapshot.data() as T`), so a legacy document stays
invisible until its next *write*, when `validateBeforeWrite` refuses it — an existing invoice
failing to save, surfacing on an operator rather than on a deploy.

⚠️ **`orderBy` cannot answer MOST of these.** They sit inside arrays of maps, which is
`stored-optionality.test.ts`'s own `array-member-uncensusable`. This needs a **paging**
script, not `api-cloudrun/scripts/audit-field-presence.ts`. ⚠️ The exception is any question
that IS a plain dotted path into a map — `organization.crms_id`, say — where
`audit-field-presence.ts` is the right tool and the paging script deliberately does not
duplicate it.

✅ **DONE 2026-09-09 — `api-cloudrun/scripts/audit-document-grain-parity.ts` (`ef75a64c`).**
Measured against `cfs-3100` / `cfs-dev-3100`; 1,019 orders, 1,040 invoices, 1,019
fulfillments in both.

| question | prod | dev | what it clears |
|---|---:|---:|---|
| `items[].price.chargeable_days` fractional | **0** | **0** | invoice → `z.int()` |
| `items[].quantity < 0` | **0** | **0** | invoice → `.min(0)` |
| `items[].name` empty or > 100 | **0** | **0** | invoice → `.min(1).max(100)` |
| `reference` > 255 | **0** | **0** | invoice → `.max(255)` |
| `zero_priced` with non-zero `base_cents` | **0** | **0** | move `checkZeroPricedAmount` onto the Inner const |
| `subject` null | **0** | **0** | **settles an increment-3 ruling — no backfill** |
| destination pair flag absent | ~~16~~ **0** | ~~16~~ **0** | ✅ REPAIRED 2026-09-09 (core#101) — projected from each source order, 8/8 |
| `destinations` empty | 31 | 31 | answers increment 3; the guess was 28 |
| component without `zero_priced` (orders) | 2 | 2 | → increment 1a |
| component without `zero_priced` (invoices) | 4,397 | 4,396 | → increment 1a |
| component without `zero_priced` (fulfillments) | 4,815 | 4,815 | → increment 1a |
| fee/surcharge line with null `crms_id` | 3 | 3 | see below |

⚠️ **The destination-pair row above is the only one that has moved since.** It was repaired on
2026-09-09 (core#101) rather than tightened around: the values were **projected from each invoice's
source order**, which resolved 8 of 8, because a blanket `false` would have been **wrong on 5 of the
8** — four pairs are `true/true` and two more carry a `true`.

⭐ **The whole table was RE-RUN on 2026-09-09 immediately before `1477dd5`, and every row is
unchanged.** Both projects, same document counts (1,019 / 1,040 / 1,019). So the five non-zero rows
are the standing state rather than a stale reading: 31 empty `destinations` (§ *3*), the three
`zero_priced` component counts (core#100), and the 3 fee lines. ⚠️ It still has a shelf life — re-run
it rather than citing this table before any further tightening.

🔴 **Dev and prod differ by ONE row in ONE question, so this is one corpus measured twice —
not two independent samples.** `devReplica` is currently mirroring prod closely, so the
dual-census premise `audit-field-presence.ts` documents (dev carries documents the legacy
ingest did not write, which is what makes the pair informative) **does not hold for these
three collections today.** Do not cite "clean in both environments" as two confirmations.

⭐ **The three null-`crms_id` fee lines are not a class.** All 13 `transaction_fee` /
`surcharge` products in prod carry a `crms_id` (measured 2026-09-09) — the catalog entries
are wired, dormant pending manager launch, per the owner. Two of the three offenders carry
line uid `77LKBYcC09u1PZFhxmDJ`, which is the **Card Fee product itself** (`crms_id: 372`,
active): the line names the product and the denormalized copy is null, because
`productLineDenorms` takes `Product | undefined`. Three lines, not a population.

A new `api-cloudrun/scripts/` census script — `audit-document-grain-parity` — dev + prod, one table:

| # | question | collection |
|---|---|---|
| 1 | `items[].price.chargeable_days` with a fractional value | invoices |
| 2 | `items[].quantity < 0` | invoices |
| 3 | `items[].name` empty, or longer than 100 | invoices |
| 4 | `reference` longer than 255 | invoices |
| 5 | destination pairs missing / non-boolean `customer_collecting` or `customer_returning` | invoices |
| 6 | `destinations` empty | invoices |
| 7 | `items[]` with `zero_priced === true && price.base_cents !== 0` | invoices |
| 8 | `subject === null` | invoices |

Put the numbers and the date in the commit message, per `CLAUDE.md` § *Making a field
REQUIRED*.

### 1 — the shared `_items` module, and adopt it ✅ COMPLETE 2026-09-09

⚠️ **Read the status update, not this section, for what landed.** Two things below are wrong as
written: the spread is not what the line item got (key order — see the status block), and
`TotalsCore` was deferred rather than shipped.

Shared shapes; every grain rebuilt as a spread. Where the census cleared it, adoption **is**
the tightening — invoice `name`, `quantity` and `chargeable_days` become the order's
declarations because they come from the same instance. Also in this commit:

- `InvoiceDocDestination` = `z.strictObject({ uid_order: FirestoreId, ...DestinationPairCore })`
  — which drops the two inert `.default(false)`s and closes the `9435a15` gap.
  ✅ **DONE 2026-09-09** (`1477dd5`, `beta.391`). ⚠️ **`DestinationPairCore` lives in
  `schemas/order.ts`, not in `_items.ts`** — it needs `OrderDocDates`, `DocDestinationEndpoint` and
  `JurisdictionEnum`, all of which `order.ts` owns, so putting it in `_items.ts` is an import cycle
  (the same wall `TotalsCore` hit). It is exported with an explicit annotation, in the
  `TimestampFields` house style, and deliberately kept **off `schemas/mod.ts`** — no consumer
  assembles a pair from parts. `tests/destination-pair-parity.test.ts` is the guard.
- `OrderDocTotals` / `InvoiceDocTotalsSchema` rebuilt from `TotalsCore`; `DocumentTotalsCore`
  (`src/utils/orders.ts:1588`) derived from it rather than hand-declared.
- `checkZeroPricedAmount` moved onto the invoice and fulfillment **Inner** consts so the
  document unions enforce it, matching the order.
- **core#90** — export `isFulfillmentLineItem` from `src/schemas/fulfillment.ts`, delete
  core's `isStructural` (`src/utils/fulfillment-items.ts`) and its two casts, including
  `computeItemPaths(out as never)`. ✅ **DONE 2026-09-09.**
- Add the `INVOICE_ONLY_ITEM_FIELDS` key-check described above.

### 1a — `zero_priced` becomes REQUIRED on components (owner's proposal, 2026-09-09)

**Yes, this can be done — but not as a per-item refine, and that is the whole finding.**

Today `zero_priced` is `.nullable().optional()` on all three grains, and only one direction is
enforced: **a flagged line must be a COMPONENT** (`validateZeroPricedComponents`, called from
`api-cloudrun/src/lib/validate.ts:211`). The proposal is its **converse** — *a component must
state the flag* — so an absent value stops meaning "nobody decided" and starts being
unrepresentable.

**It buys the thing manager#421 just cost.** `checkZeroPricedAmount` fires only on `=== true`,
and the zero-priced-first sort groups only on `=== true`, so an absent value silently resolves
to *charged*. On a kit component, "included at no charge with its parent" versus "billed
separately" is a real billing distinction being decided by a default.

🔴 **The obvious implementation is impossible, and the codebase already says so.**
`checkZeroPricedAmount`'s own docblock (`src/schemas/common.ts`):

> *"Invariant (2) (a flagged line is a COMPONENT) cannot be expressed here at all, because
> deciding it requires the sibling array."*

Componenthood is a property of an item's position among its siblings — `path.at(-2)` naming a
line item rather than a divider — so no `superRefine` on the line arm can see it. **It has to
be an ARRAY-level refine** on `items`, and none of the three schemas has one today: all three
are a bare `z.array(X).default([]).meta({ label: "Item" })`
(`order.ts:1362`, `invoice.ts:769`, `fulfillment.ts:240`).

⭐ **Put BOTH directions in that refine, rather than adding the converse alone.** Splitting one
rule across a schema refine and a write-boundary check gives one fact two homes. And there is
a concrete gain: **`validateCollection` re-parses every stored document through its Zod
schema**, so a schema-level rule audits the whole corpus for free, while a boundary-only rule
is invisible to it.

**`.meta({ initial: false })` is correct, and load-bearing for a specific reason.**
`getInitialValues` returns **`null` for a nullable** (`src/schemas/initial.ts`, `case
"nullable"`), not `false` — so without the annotation the manager's form seeds `null` where
the intent is *not zero-priced*. That is exactly the case the file's own docblock describes for
the five `z.boolean().default(true)` fields: the type-derived zero is the wrong seed.
⚠️ **It becomes redundant if the field is also de-nullabled** to a plain required `z.boolean()`
on components — `case "boolean"` already yields `false`, which is why `9435a15` deliberately
added no `initial` to the destination pair's two flags. Decide the nullability first; the
annotation follows from it.

**Cost — this is a tightening, so it runs the full procedure.** Census both environments for
component lines lacking the key, across `orders`, `invoices` **and** `fulfillments`, then
backfill an explicit `false`. ⚠️ `orderBy` cannot reach it (array of maps), so it joins
increment 0's paging script.

🔴 **MEASURED 2026-09-09, and it is 200× what this section assumed: 9,214 rows** — 2 orders,
4,397 invoices, 4,815 fulfillments in prod. This section was sized against the *other*
direction's repair on 2026-09-07 (**44 top-level flagged lines across 35 documents**, all from
the deleted CRMS ingest), and that precedent gives the script shape and **not** the scale.

⭐ **So 1a is NOT a rider on increment 1 — it is its own campaign, and it is tracked as one.**
A ~9,200-row backfill across three collections, plus an array-level refine on all three, plus
the deploy-before-backfill ordering under `z.strictObject`, is not something that rides along
inside a schema-alignment PR. Increment 1 should ship without it.

⚠️ **And the census cannot tell you what to backfill.** It counts components that do not STATE
the flag; it cannot know whether each was meant to be charged. Writing `false` across 9,214
rows asserts "every one of these is charged", which is probably right and is **not** measured.
That is the part to put in front of the owner before writing anything.

⚠️ **Writing `false` is a real value, not a cushion.** It says *this component is charged*,
which a writer genuinely produces — the `orders.crms_id` case, not the case
`CLAUDE.md` § *Making a field REQUIRED* warns against.

### 2 — Bookings

⚠️ `PickSheetDestination.due_at` and `MovementSessionItem.owner_path` **moved to the
core#91/#92/#93 campaign** and SHIPPED there in `@cfs/core@10.0.0-beta.386` — its plan doc
(`core/.claude/plans/fixture-pii-identity.md`) has since been deleted, so read the closed
issues rather than looking for it. What remains here is bookings only.

- `Booking`'s flat `uid_destination_delivery` / `uid_destination_collection`: check
  `api-cloudrun/infra/firestore-indexes.json` for a caller before proposing removal — they
  may exist because a composite index needs a top-level field. If nothing needs them, they
  are a third spelling of a join that already has one.
- `Booking.dates`: **audit `buildBookingDates` before renaming.** A booking's window is
  derived per item type, so `start`/`end` may not be a clean alias of
  `delivery_start`/`collection_end`. If it is, rename to the pair's vocabulary; if it is not,
  file the finding rather than force it.

**Movements and `path` — your note, and it has a precedent.** A movement's subject is a
**booking**, and a booking is an aggregate per `(order, product, destination)` spanning N
item rows — so a movement cannot today say *which row* it moved. The pick sheet hit exactly
this and solved it: `PickSheetItem.owner_path` plus `chooseBookingOwner`, published in
`ac5b9fc`. `core/CLAUDE.md` records the ruling that licenses it, and it was **reversed in
your favour on 2026-09-08**:

> ⭐ *"Ask what the document's CONSUMERS have to compute, not what the document is 'about' —
> a fact every reader must derive identically is a fact the writer should have stated, and
> 'this consumer happens not to need it yet' expires."*

Two levels, and they are different decisions — **(a) has moved to the core#91/#93 campaign**
because it lands in the file and the fixture family that campaign already opens:

- **(a) `MovementSessionItem.owner_path` — in the core#91/#92/#93 campaign, not here.** The
  session is a fold rebuilt on demand (`src/schemas/movement-session.ts:134`), so there is no
  corpus, no backfill and no ordering. Use `chooseBookingOwner` so the pick sheet and the
  receipt designate the same row. Touches the `templates` render context, so it needs that
  repo's pin bump — which that campaign is already paying.
- **(b) `Movement.path` on the `transactions` journal — file as `kind:decision`, do not
  guess.** The journal is append-only and its id is `{uuid_session}|{type}|{subject}`.
  Historical movements cannot be repaired — the row is not recoverable after the fact — so
  the field would be stamped going forward and **absent on history**, which is the
  `pdf_versions` precedent. Worth doing, and worth deciding deliberately rather than inside
  a schema-alignment PR.

### 3 — What needed a ruling; two are now answered

⚠️ **Rewritten 2026-09-09.** Increment 0 answered two of these with data and the owner ruled on
the third, so this is no longer three open `kind:decision` items.

- 🔴 **`Invoice.subject` — NOT free, and the "answered" verdict above was wrong. Corrected
  2026-09-09 while landing increment 1.** The census IS 0 nulls in both environments, and that
  is exactly the trap `CLAUDE.md` § *Making a field REQUIRED* step 2 names: **a clean census is
  evidence about the INPUTS SO FAR, not about the writer.** `createInvoice` writes
  `subject: input.subject ?? null` (`api-cloudrun/src/services/invoices.ts`) and
  `CreateInvoiceInput.subject` is `z.string().optional()` — so the writer *produces* `null`, and
  the very next invoice created without a subject would be refused by a non-nullable schema.
  0 nulls means nobody has yet created one without a subject; it does not mean nobody can.

  ⭐ This is the `orders.crms_status` case verbatim — 995/995 present, and requiring it would
  400 the native create path the first time it ran — sitting directly beside `orders.crms_id`,
  which reads identically and IS required because `createOrder` writes an explicit value. Same
  census, opposite verdicts, and only the writer distinguishes them.

  **So it is a cross-repo ordering, not a declaration change.** Align the writer first
  (`?? null` → `?? ""`, matching order and fulfillment's `.default("")` / `subject: string`),
  DEPLOY it, and only then tighten the schema. ⚠️ And note the `.default("")` on the other two
  grains is inert on a write — `validateBeforeWrite` discards `result.data` — so the writer has
  to supply `""` itself; the default is not doing this for order or fulfillment either.

- ✅ **`reference` — done in increment 1.** Already nullable on all three; the invoice was the
  only grain without `.max(255)`, and 0 of 1,040 exceed it. Unlike `subject`, no writer can
  produce a violating value on its own, which is why this one genuinely was free.
- ⚠️ **`Invoice.destinations` `.default([])` vs `.min(1)` — ANSWERED, and it is NOT free.**
  **31 invoices carry an empty `destinations`** in both environments. The guess in the earlier
  draft was "the 28 flat CRMS invoices"; the real number is 31 and it has not been attributed.
  `.min(1)` would refuse all 31 on their next write. Either keep `.default([])` and record why,
  or attribute the 31 first — do not tighten on the strength of the count alone.
- 🔴 **`crms_id` — the owner has RULED, and this bullet was wrong.** It read *"probably a
  removal, not an alignment."* **It is a rename, not a removal** (owner, 2026-09-09; the same
  ruling core#94 records from 2026-09-08): it is the operator-facing **human-readable account
  number**, and deleting it breaks every organization deep link and row label.

  ⚠️ **And `crms_id` is FOUR fields wearing one name — that is the trap, and it is why this
  bullet went wrong.** Verified 2026-09-09:

  | # | where | declaration | note |
  |---|---|---|---|
  | 1 | `DocumentOrganizationSnapshot.crms_id` (`schemas/common.ts`) | `.nullable().optional()` | **core#94's field.** The account number |
  | 2 | order **line item** (`schemas/order.ts`) | `z.int().nullable().optional()` | **not** `@deprecated` |
  | 3 | invoice **line item** (`schemas/invoice.ts`) | `z.union([z.int(), z.string()]).nullable().optional()` | `@deprecated Legacy CRMS field` |
  | 4 | top-level `Order.crms_id` (`schemas/order.ts`) | `z.int().nullable()` — **required** | 995/995, CRMS-authored corpus |

  The earlier bullet claimed (2) and (3) are *"both marked `@deprecated`"*. Only (3) is.

  ⭐ **So core#97's scope here is ONLY the type divergence between (2) and (3)** — `z.int()`
  against `z.union([z.int(), z.string()])`. The rename of (1) is core#94's, and (4) stays.
  🔴 **A removal of (2) or (3) is blocked regardless**, and this doc already says why:
  `invoiceItemDifferences` diffs KEY SETS, and `crms_id` is one of the three fields that has
  already caused every paired line to report permanently out of sync (8,015 of 8,978). Dropping
  it from one line arm and not the other re-triggers exactly that.

  ⚠️ **Before narrowing (3) to `z.int()`, census the `string` member** — the union's string arm
  is not covered by increment 0's questions.

### 4 — Naming (last, and separable)

Canonicalise on `<Grain>Doc*` for stored and `<Grain>Input*` for input, and put `…Type` on
every interface or none. ~50 first-party files name an item type directly; the six heavy ones
are `manager/src/stores/invoices.ts` (60 refs), `manager/src/stores/orders.ts` (42),
`api-cloudrun/src/lib/orderFulfillmentSync.ts` (26), `api-cloudrun/src/services/orders.ts`
(18), `api-cloudrun/src/services/fulfillment.ts` (17) and `src/utils/invoices.ts`.

⚠️ **This is the one piece with no correctness payoff and the largest blast radius.** Keep it
as its own commit inside the PR so it can be dropped if the diff gets too large to review
against the parts that fix defects.

---

## Cross-repo release order

Write it into the PR — nothing enforces it, and dev is structurally blind to the whole class
because `api-cloudrun` and `manager` both deploy continuously from `main`.

1. **Census** (increment 0) — read-only, no release.
2. **Repair** any non-zero count from the census, in prod and dev, *before* the schema lands.
   A tightening has no safe direction otherwise.
3. **Core `feat!` beta** — increments 1–2 (+4 if kept).
4. **Pin bumps**: `manager/package.json` (1), `api-cloudrun/deno.json`
   (`grep -c 'jsr:@cfs/core@'`), `templates/deno.json`. Renovate automates the first two.
5. **Deploy** api-cloudrun and manager. Increment 2(a) additionally needs the `templates` pin
   and its render context regenerated.

⚠️ **`checkZeroPricedAmount` reaching the invoice union is a tightening of what parses**, not
a new field — so it belongs in step 2's repair scope even though nothing about it looks like
a migration.

---

## Verification

**Core, before anything ships:**

- `deno task check`, `deno task check:declarations`, `deno task check:generated`,
  `deno task test`
- 🔴 **`getInitialValues` output must be byte-identical** for `OrderSchema`, `InvoiceSchema`
  and `FulfillmentSchema` before and after increment 1. This is the assertion that catches a
  dropped `.meta()` — which `tests/pii.test.ts` structurally cannot, because a field that
  never had a tag is indistinguishable from one that lost it.
- `tests/display-columns.test.ts` (T8–T11, T14), `tests/meta-preservation.test.ts`,
  `tests/pii.test.ts`, `tests/interface-optionality.test.ts`, `tests/inert-defaults.test.ts`
- `tests/stored-optionality.test.ts` — its map **only ever shrinks**. Do not add an entry to
  make something land.
- `tests/typesenseFieldCoverage.test.ts` — the Typesense configs are a fourth consumer of
  these field names.
- New arms: an invoice line with `zero_priced: true` and a non-zero `base_cents` must now be
  refused by `InvoiceSchema` (paired with a positive control that still parses), and an
  invoice destination pair omitting either flag must be refused **and name both paths**.

**Against live data, both environments, before commit:**

- Re-parse both corpora — the manager's Settings → dev tools → Collection Validation, backed
  by `api-cloudrun/src/services/validateCollection.ts`, for `orders`, `invoices`,
  `fulfillments` and `bookings`.
- `api-cloudrun/scripts/audit-item-paths.ts` (read-only, both collections) and
  `api-cloudrun/scripts/audit-datetime-forms.ts`.

**After deploy:**

- Edit an order that has both an invoice and a fulfillment, and confirm the propagation still
  preserves overrides: an overridden invoice line survives, a non-overridden one updates, a
  picker-set quantity survives, and `computeInvoiceSyncStatus` does **not** flip every paired
  line to `out_of_sync` (the key-set trap in § F).

---

## Issues

**Folded in:** core#90 (fulfillment-grain guard — increment 1).

**Filed by this work:** the three rulings in increment 3; `Movement.path` from increment
2(b); and anything the census turns up non-zero that is too large to repair in this campaign.

**Ran BEFORE this plan and is now DONE, having taken two items from it:** core#91 + core#92 +
core#93 — all three closed, plan doc `core/.claude/plans/fixture-pii-identity.md` deleted with
them — plus `PickSheetDestination.due_at`, `MovementSessionItem.owner_path` and
`TEMPLATE_COMMIT_TYPES`. See § *Status* above.

**Adjacent, do not absorb:** core#83 (`.nullable().optional()` ratchet — respect it, do not
add entries), core#95 (inert `.default()` guard — this pass removes two of its instances but
does not build the guard), core#94 (excluded from both campaigns, already decided),
api-cloudrun#890 / api-cloudrun#664 (invoice destination override behaviour — this pass
changes the *schema*, not the override policy).

---


## Context recommendation

**CLEAR.** core#97 is structurally complete and every piece is landed, published and pinned in all
consumers. Nothing outstanding needs the session that produced it: seven betas, four repos, a prod
backfill, a peer running a parallel release train, and several corrections that are already written
down below. **A fresh window loses nothing that is not in this doc or on an issue.**

**Where things stand, so a cold reader can confirm rather than trust:**

| repo | at | commit |
|---|---|---|
| core | `10.0.0-beta.398` published | `fe031a5` |
| api-cloudrun | `.398` | `eaf4eed4` |
| manager | `.398` | `19a092d` |
| templates | `.397` — peer-owned | `6c65fa4` |

⚠️ **The one loose end is templates' `.397` → `.398` bump**, which is pin-only but reorders
`src/schemas/template-schema-fields.generated.ts` (same members, new order). That file is the render-context
surface, so it is worth an eyeball rather than a rubber stamp. Handed to the peer holding that repo;
re-confirm before assuming it landed.

### What to pick up next — all of it is on an issue, none of it is in this doc

- **core#100 — the biggest, and it is a DECISION before it is work.** ~9,214 component rows state no
  `zero_priced`. The census counts rows that do not STATE the flag; it **cannot** say which were
  meant to be charged, so writing `false` across them asserts something nobody has measured. That
  question goes to the owner first. ⚠️ Its numbers moved inside a day — re-derive before sizing.
- **core#103** — `Booking`'s flat `uid_destination_*` pair is asymmetric: `delivery` is indexed query
  surface (`bookings: [uid_destination_delivery, status]` + a live `.where()` in
  `api-cloudrun/src/services/pickSheets.ts`), `collection` is an unbacked denorm. Neither is checked
  against its nested twin.
- **api-cloudrun#943** — `OrderDocDates` models a collection WINDOW that three consumers each collapse
  differently. 1,020/1,020 pairs are currently equal, and that is a fact about the WRITER (the manager
  mirrors them). `booking.dates.end` feeds `stockSummary`, so the first non-zero window releases a unit
  while it is still out. Cheap to settle now, expensive later.
- **api-cloudrun#944** — `Movement.path` on the append-only journal.

### Deliberately NOT done, with reasons — do not re-propose without new evidence

- **§ *4*'s remaining half.** Canonicalising `OrderItemLine` vs `InvoiceItemInputLine` across grains:
  neither spelling is wrong, and `FulfillmentLineItem` lacking a `Doc` segment is now **accurate**
  rather than sloppy, since it stopped doing double duty at `.396`.
- **An unconditional `.min(1)` on `Invoice.destinations`.** The bound exists and is CONDITIONAL; see
  the field's own docblock. Adding one refuses 31 live flat CRMS invoices.
- **Renaming `Booking.dates`.** `buildBookingDates` is a per-item-type DERIVATION, not a renamed
  subset — `end` is `collection_START`, and `null` for a sale.

### One live inconsistency this campaign exposed and did not fix

The three input schemas disagree on whether `path` is required: `OrderItemLineInner` requires it,
`InvoiceItemInputLineInner` has `.optional()`, `FulfillmentItemInputLineInner` requires it. **The
invoice is the outlier.** Tightening it is a refinement of a client-supplied input, so it needs the
writer check first — not a free change.

### Standing hazards, re-confirmed today

🔴 **Verify a `core` publish against the PUBLISHED TARBALL and print the installed version inside the
probe.** `beta.388` shipped a symbol missing from `schemas/mod.ts` with all three local gates green.
⚠️ The npm alias installs at `node_modules/@cfs/core`, and `npm install` alone can leave it a beta
behind its own lockfile — `rm -rf node_modules/@cfs/core && npm install`.

🔴 **`refactor:` is a NO-RELEASE type in core's convention table.** A `refactor(schemas):` commit ran
green and published nothing on 2026-09-09, leaving the change unreachable on `beta`. If a version does
not move, check the commit TYPE before checking JSR.

🔴 **`getFirestoreColumns` takes a COLLECTION NAME, not a schema.** Passing a schema returns `[]` and
the comparison is empty-to-empty. It is the ONLY surface that can see an `items[]` key-order change.

⚠️ **`core`'s gate judges the WHOLE working tree at commit and push; `api-cloudrun`'s and `manager`'s
gate the SUBJECT** (a throwaway worktree at the push sha — api-cloudrun#817 is closed). So a peer's
dirty tree cannot fail your push there. What DOES bite is committing during a peer's gate: git resolves
the ref at pack time, so a commit landing mid-gate ships having been gated by nothing (api-cloudrun#846).

⚠️ **This doc's line numbers rot.** Re-derive before acting on any; the measurements and the reasoning
are the durable half.

**Delete this doc once core#100 is decided.** The structural work it planned is done; what keeps it
alive is that core#100 and the three bookings issues still cite its § *0* census table as the record
of what was counted.