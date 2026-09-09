# Aligning the order / invoice / fulfillment schemas

*Promoted from a machine-local draft on 2026-09-09. Owning repo is `core` — the schemas are
the work; `api-cloudrun` owns only the census/backfill script this doc names.*

## Status — this runs AFTER the core#91/#92/#93 campaign

**Nothing here is started.** The campaign that precedes it is planned by a separate session
and tracked in `core/.claude/plans/fixture-pii-identity.md`, which owns its own status. This
doc is the follow-on work.

The two are deliberately separate: the campaign's corpus is the committed `templates`
fixtures, this one's is stored Firestore documents across `orders`, `invoices` and
`fulfillments`. Different corpus, different failure mode, and this one is gated on a census
that has not run. Consolidating them would produce one unshippable campaign.

### Findings handed to that campaign on 2026-09-09 — recorded, not owned

Delivered by message to the session planning it; `fixture-pii-identity.md` is their home now.
Kept here only because they were expensive to measure and cheap to keep, and because a reader
of THIS doc may wonder whether they were checked. **If they disagree with the campaign's doc,
the campaign's doc is right.**

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

- `src/utils/fulfillment-items.ts:154` — `computeItemPaths(out as never) as FulfillmentItemType[]`
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

⚠️ **`orderBy` cannot answer any of these.** They all sit inside arrays of maps, which is
`stored-optionality.test.ts`'s own `array-member-uncensusable`. This needs a **paging**
script, not `api-cloudrun/scripts/audit-field-presence.ts`.

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
  core's `isStructural` (`src/utils/fulfillment-items.ts:50`) and its two casts, including
  `computeItemPaths(out as never)`.
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
increment 0's paging script. ⭐ Precedent and script shape already exist: the *other* direction
was repaired on 2026-09-07 — **44 top-level flagged lines across 35 documents**, all from the
deleted CRMS ingest — and the guard was closed behind it.

⚠️ **Writing `false` is a real value, not a cushion.** It says *this component is charged*,
which a writer genuinely produces — the `orders.crms_id` case, not the case
`CLAUDE.md` § *Making a field REQUIRED* warns against.

### 2 — Bookings

⚠️ `PickSheetDestination.due_at` and `MovementSessionItem.owner_path` **moved to the
core#91/#92/#93 campaign** (`core/.claude/plans/fixture-pii-identity.md`) — they land in the
files and fixture families that campaign already opens. What remains here is bookings only.

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

### 3 — The three that need a ruling, not a sweep

File as `kind:decision` on `core`; do not pick a side in the PR.

- **`Invoice.subject`** is `string | null`; order and fulfillment are `string` with
  `.default("")`. `createInvoice` writes `input.subject ?? null`. Aligning either direction
  is a backfill. (`reference` is *already* nullable on all three — only `.max(255)` is
  missing on the invoice, which increment 1 fixes.)
- **`Invoice.destinations` `.default([])` vs `.min(1)`** — the 28 flat CRMS invoices with no
  order divider decide this. Census question 6 answers it.
- **`crms_id`** is `z.int()` on the order line and `z.union([z.int(), z.string()])` on the
  invoice line, both marked `@deprecated`. This is probably a **removal**, not an alignment.

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

**Runs BEFORE this plan, and takes two items from it:** core#91 + core#92 + core#93
(`core/.claude/plans/fixture-pii-identity.md`), plus `PickSheetDestination.due_at`,
`MovementSessionItem.owner_path` and `TEMPLATE_COMMIT_TYPES`. See § *Status* above.

**Adjacent, do not absorb:** core#83 (`.nullable().optional()` ratchet — respect it, do not
add entries), core#95 (inert `.default()` guard — this pass removes two of its instances but
does not build the guard), core#94 (excluded from both campaigns, already decided),
api-cloudrun#890 / api-cloudrun#664 (invoice destination override behaviour — this pass
changes the *schema*, not the override policy).

---


## Context recommendation

**Clear. Do not start this from a session that has been planning it.**

Start at increment 0, the census, in a fresh window — it is short, its numbers gate every
decision below it, and they belong in this doc before anyone opens a schema file. Increment 1
touches four large schema files and wants its own window after that.

⚠️ **Two preconditions, both outside this doc:**

1. The core#91/#92/#93 campaign lands first. It rewrites `pick-sheet.ts` and
   `movement-session.ts`, and re-captures five `templates` fixture families.
2. `core`'s gate judges the WHOLE working tree at both commit and push, so check for a peer
   before starting — `git -C core status --short` and `pgrep -fl "deno.*test"`.

⚠️ **This doc's own line numbers will rot the same way the campaign's did.** Re-derive before
acting on any of them; the measurements and the reasoning are the durable half.

**Delete this doc in the commit that lands the last increment.** A stale plan reads as current
intent — which is exactly the trap recorded above.
