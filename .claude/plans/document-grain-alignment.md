# Aligning the order / invoice / fulfillment schemas

*Promoted from a machine-local draft on 2026-09-09. Owning repo is `core` — the schemas are
the work; `api-cloudrun` owns only the census/backfill script this doc names.*

> ## ⚠️ STATUS UPDATE 2026-09-09 — increments 0 and 1 are DONE and SHIPPED (`beta.390`)
>
> Compacted from three blocks. Read this instead of the increment prose where they disagree.
>
> **Shipped:** `f7e9b66` (the shared line-item shape), `85184ea` (`reference`/`chargeable_days`/the
> `INVOICE_ONLY_ITEM_FIELDS` key-check), `0122a0c` (a barrel fix — see below), `83b3cfe` (core#102,
> the input schema). Published `beta.388` → `.390`. **`manager` is pinned to `.390` and landed**
> (`095ce6a`): 0 typecheck errors, 1977 tests. **`api-cloudrun` is NOT yet bumped** — that is the
> remaining consumer work.
>
> **Increment 0** — `api-cloudrun/scripts/audit-document-grain-parity.ts` (`ef75a64c`, on
> `origin/main`). Numbers in § *0*.
>
> **Increment 1** — `src/schemas/_items.ts` holds `LineItemCore`; all three grains reference it. The
> invoice gained `.min(1).max(100)` on `name`, `.min(0)` on `quantity`, `.int()` on
> `price.chargeable_days` and `.max(255)` on `reference`; `checkZeroPricedAmount` moved onto the
> invoice and fulfillment **Inner** consts so it actually runs on a document parse; core#90's
> `isFulfillmentLineItem` is exported and `isStructural` plus both its casts are gone.
>
> 🔴 **The `{ ...LineItemCore, … }` spread this doc proposed is NOT what landed.** Shape key order
> becomes schema key order and `getFirestoreColumns` walks the shape, so a spread silently reorders
> the operator's column picker on all three surfaces — and the six fields are not contiguous in any
> grain, so **no key order for that object leaves all three unchanged.** Fields are referenced per
> key; the anti-drift guarantee moved to `tests/item-shape-parity.test.ts`, which is **stronger**
> (a spread cannot see a grain SHADOWING a shared key, which is exactly how `name` and `quantity`
> drifted). All nine derived surfaces are byte-identical, order included. The general rule is now in
> `core/CLAUDE.md` beside the display-columns section, not only here.
>
> 🔴 **`beta.388` shipped `isFulfillmentLineItem` UNREACHABLE**, and the lesson outlives this pass.
> It was exported from `schemas/fulfillment.ts` and never added to `schemas/mod.ts`'s explicit list,
> so `@cfs/core/schemas` — what every consumer imports — resolved it as `undefined`. **Every local
> gate was green**: `deno check` (the module compiles), `check:declarations` (the symbol has a type),
> and the suite (core's tests import schema files directly, not through the barrel). Found only by
> probing the PUBLISHED tarball from `manager/node_modules`. ⭐ **Verify a core publish against the
> tarball, not the source tree** — and `tests/item-shape-parity.test.ts` now asserts all three grain
> guards are barrel-reachable, importing dynamically and by NAME because a static unused import is
> elided before the module links.
>
> **Split OUT, with reasons:**
> - ✅ **The destination-pair backfill is DONE** — core#101, 16 absent flags across 8 invoices,
>   repaired in prod and dev, closed. Values were **projected from each invoice's source order**
>   (8/8 resolved), because a blanket `false` would have been **wrong on 5 of the 8**. So
>   `InvoiceDocDestination` adopting a shared `DestinationPairCore` is now UNBLOCKED — see § *3*.
> - ✅ **core#102 (the input schema) is DONE** — the input refused nothing the document refuses.
>   Closed; guard in `tests/invoice.test.ts`.
> - **`TotalsCore` — deferred, not blocked.** `PriceModifier` lives in `order.ts`, so a `TotalsCore`
>   in `_items.ts` is an import cycle. The six fields are byte-identical today and have not drifted;
>   worth its own commit after `PriceModifier` moves.
> - 🔴 **`Invoice.subject` is NOT free** — see § *3*. The writer produces the `null` a tightening
>   would refuse, so it needs the api-cloudrun change deployed first.
> - **Increment 1a** is its own campaign (core#100), ~9,214 rows, and it *would* break the
>   `templates` fixtures where increment 1 did not: 27 of 154 committed line items state no
>   `zero_priced`.
>
> **NEXT: `api-cloudrun` pins `10.0.0-beta.390`.** ⚠️ Not a `sed` — it reshapes schemas the API reads
> on nearly every write path, so budget a typecheck-driven change plus the deploy ordering. The
> manager is already ahead of it, which is the correct direction for a REFINE.
>
> ⚠️ **The hold on the core#91/#92/#93 campaign is LIFTED** (templates#292 merged). The mechanism this
> doc originally named was wrong: it was never a stale pin, it was `lint:capture-floor` comparing
> `min_core` against the newest *published* core, so only a beta adding a `pii: "mask"` tag can turn
> it red. Increment 1 added none.
>
> ⭐ **Three clean counts today were clean for three different reasons, and none was about the
> document** — the fixtures because of *when* they were sampled, the `subject` census because of
> *what the writer emits*, the destination flags because *the schema's own inert default* kept the
> field absent. That pattern is now in `core/CLAUDE.md` beside the inert-default table.

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
8** — four pairs are `true/true` and two more carry a `true`. Re-run the audit rather than trusting
this table for anything else.

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

### 1 — the shared `_items` module, and adopt it (the core PR's first commit)

Shared shapes; every grain rebuilt as a spread. Where the census cleared it, adoption **is**
the tightening — invoice `name`, `quantity` and `chargeable_days` become the order's
declarations because they come from the same instance. Also in this commit:

- `InvoiceDocDestination` = `z.strictObject({ uid_order: FirestoreId, ...DestinationPairCore })`
  — which drops the two inert `.default(false)`s and closes the `9435a15` gap.
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

**Clear. Increment 0 is DONE (2026-09-09) — start at increment 1, in a fresh window.**

The census no longer needs running; its numbers are in § *0* above and they are the durable
half of that work. Increment 1 touches four large schema files and wants a window of its own,
with none of the coordination context that produced the census in it.

⚠️ **One precondition, and it is narrower than it was:** the core#91/#92/#93 campaign's
`templates` PR must **MERGE** — not merely be in progress, and not "that session went idle."
Confirmed with that session 2026-09-09: the 14-fixture re-capture may be handed to a fresh
session, and cutting a `core` beta before the merge lands a stale pin in whichever checkout is
running the re-capture. The campaign has twice discovered a schema fix during that re-capture,
so treat another beta as live until the PR is merged.

⚠️ **`core`'s gate judges the WHOLE working tree at both commit and push**, so check for a peer
before starting — `git -C core status --short` and `pgrep -fl "deno.*test"`. (Unlike
`api-cloudrun` and `manager`'s pre-commit, which gate the subject.)

⭐ **Increment 1a is no longer part of this plan's critical path** — it is ~9,214 rows and is
tracked as its own campaign. Ship increment 1 without it.

⚠️ **This doc's own line numbers will rot the same way the campaign's did.** Re-derive before
acting on any of them; the measurements and the reasoning are the durable half.

**Delete this doc in the commit that lands the last increment.** A stale plan reads as current
intent — which is exactly the trap recorded above.
