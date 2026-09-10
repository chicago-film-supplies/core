# `zero_priced` stage two — carrying an answer the order already has

*Owning repo is `core`: it holds both projections, the refine, and the release train the other
two repos pin against. `api-cloudrun` owns the backfill script and `createInvoice`'s
hand-mirrored copy of the projection; `manager` owns the four guards that opened the whole
thing. Issues: **manager#421** (the campaign) and **core#100** (the refine, `blocked:sequenced`
behind it).*

*Split out of core#97's plan doc on 2026-09-09, when the census that plan called for came back
saying something different from what it predicted. That doc — `document-grain-alignment.md`, in
this directory — is **deleted**, its structural work having landed and its every leftover now
sitting on an issue (core#100, core#103, core#105, api-cloudrun#943, api-cloudrun#944).*

> ## ⚠️ STATUS UPDATE 2026-09-10 — steps 1-3 and 6 are DONE. Steps 4, 5 and 7 remain.
>
> ⭐ **The corpus is repaired and the emit is live.** Both environments read **0 unstated
> component rows on all three grains**, from 9,213. Prod write: 2 orders, 1,040 invoices,
> 1,014 fulfillments, zero failures, consumer queues paused and drained (three passes —
> `gcloud tasks queues purge` really does return before it finishes: 0 → 100 → 25 → 0).
> `@cfs/core@10.0.0-beta.401` published and verified **against the tarball** from a consumer,
> not against core's own gates. All three consumers pinned: api-cloudrun `0f729d47`, manager
> `20fd0c0`, templates still on beta.400 (it moves with the fixture PR below).
>
> **What is LEFT, in order:**
>
> 1. 🔴 **`templates` — and it is a PREREQUISITE for step 4, not the tail this plan called
>    it.** `lintFixture` parses every fixture against the real `InvoiceSchema`, so an
>    array-level refine refuses any fixture whose components are unstated. Measured
>    2026-09-10: the INVOICE family is **20 of 20 line rows unstated across all 8 fixtures**
>    (8 of those rows are components, across 5 files — that smaller number is what the refine
>    refuses; the larger one is what a re-capture must fix). The QUOTE family is **0 of 134**,
>    because its fixtures are captured from ORDERS, which always carried the flag.
>    ⭐ **A captured fixture is only as complete as the document it captured** — capture buys
>    PII safety and shape fidelity, never completeness. Re-capture all 8 with
>    `templates_capture_fixture` (never `templates_set_fixture`); every source document is
>    inside the backfilled corpus, so the capture fixes them by construction:
>    `zero-priced-flat-tax` + `-hidden` ← #2390 `wDBAH05fWHmNi5m94an8` (one document
>    deliberately — the pair is a controlled comparison), `billing-foreign-country` ← #1918,
>    `rental-discount-taxed` ← #1902, `rental-discount-untaxed` ← #1996, plus `part-paid`,
>    `credits-applied`, `service-untaxed-fee`. Then re-bless goldens in BOTH namespaces via
>    `--env=dev`, and bump the pin to beta.401 in the same PR.
> 2. **Step 4 — the refine (core#100).** Array-level, both directions, on all three grains.
> 3. **Step 5 — `AuthoredProductComponent.zero_priced` required.** Still a zero-row backfill.
>
> ⭐ **Owner ruling 2026-09-10 — the templates key on `zero_priced`**, which is what
> `quote.eta:307` already does. **Measured before shipping: near-inert.** The proxy
> (`price.base_cents === 0 && componentDepth > 0`) hides 3,557 rows, the real flag 3,556 —
> **1 row becomes visible** (invoice #2411, draft, a genuinely-charged-at-$0 component the
> proxy was wrongly hiding) and **0 become hidden**, which is invariant (1) holding. Also
> repair the "an invoice line has NO `zero_priced` field" claim in `invoice.eta` and in two
> `invoice.meta.json` fixture descriptions.
>
> ## 🔴 Three things this plan did not know, all found by RUNNING
>
> 1. **The emit's population is LINES, not components.** `invoiceItemDifferences` counts a
>    null-valued key as PRESENT and `buildOrderLineFromProduct` writes `zero_priced: null` on
>    every order line — so the emit had to be unconditional and the backfill had to cover
>    every line. The narrow value-conditional rule saved only **102 documents of 1,037** and
>    would have made a line's key set depend on its VALUE, so clearing a catalog flag strands
>    the stored key and reports `out_of_sync` forever. Not worth it; **(a) unconditional
>    `?? null`** is what shipped.
> 2. **Stamping the flag can make a document UNWRITABLE.** `computeItemPaths` sorts
>    `zero_priced === true` ahead of its priced siblings and `validatePathsAgainst` compares
>    `items[i].uid` positionally — so the write boundary checks the LINEARIZATION, not just
>    paths. There is no stamp-but-keep-the-order option. 3 prod invoices reordered (#1850
>    paid, #2299 and #2303 void; accessories moving inside one kit, money identical) and were
>    written in canonical order under `--allow-reorder`. ⚠️ **Any future items[] backfill must
>    WRITE IN CANONICAL ORDER rather than patch a key in place**, and must expect arrays a
>    previous backfill already reordered.
> 3. **The input channel created a way to LOSE the field.** `buildInvoiceItems` rebuilds
>    every line from typed fields and the input schema strips unknowns, so `zero_priced` had
>    to be added to `InvoiceItemInputLineType` — and that turns an omitted key into `?? null`,
>    wiping a backfilled answer off every line of that invoice. Closed by
>    `preserveStoredZeroPriced` (`api-cloudrun/src/lib/invoiceLineDenorms.ts`), a third
>    carry-forward on the shared `(uid, k-th occurrence)` pairing.
>
> ⚠️ **Two residue classes the census structurally could not see**, both found by the
> backfill's own fallbacks and both now derived rather than left silent. The catalog must be
> keyed on the **(parent product, component) PAIR** — 5 component uids are stated both ways by
> different parents, which made 2 rows look unanswerable while their own parent was
> unambiguous. And a **component that carries a charge is not zero-priced**, so its own money
> answers: 3 rows are a *Chicago Bottled Water Tax ( $0.05/bottle )* under an *Open Water 16oz
> Aluminum Bottle (24 Case)*, in no product's `components[]` and billing 6 cents on 96-240
> bottles. The census reads 0 for the unsafe arm because its partition (7) asks only about
> rows whose paired ORDER line says true — prod invoice #2316 (paid) charges $6.80 for a
> component the catalog calls free, and only the catalog fallback can reach it.
>
> ⚠️ **Two tests INVERTED rather than being deleted**, and expect one per grain for anything
> that tightens `items[]`: core's *"the PROJECTION does not emit zero_priced yet"* was
> literally the stage-one spec, and api-cloudrun's *"buildFulfillment line items expose only
> fulfillment-safe fields"* listed the key among the order-only leaks.

> **State at hand-off, 2026-09-09:** nothing in *The order of work* below has started. What
> exists is the measurement (`api-cloudrun/scripts/audit-zero-priced-components.ts`, api-cloudrun
> `d8c93822`), the issues (manager#421 re-titled and re-sized, core#100 re-scoped to `kind:guard`
> and `blocked:sequenced`), and two docblock repairs in `core` — `f64122f` and `5f01294`. Step 1
> is the next thing anyone does.

## The one-sentence version

**Every component line on an invoice or a fulfillment is missing `zero_priced`, and the order
line it was projected from already has the answer** — 9,197 of 9,220 rows derive with no
judgment call at all. This is not a backlog of undecided billing questions; it is one decision,
taken upstream, that two projection functions do not carry.

## What is measured, and by what

`api-cloudrun/scripts/audit-zero-priced-components.ts` (api-cloudrun `d8c93822`), run against
both projects on 2026-09-09. Read-only, exit 0 always — it reports, it does not gate.
**Re-run it rather than citing the tables below**; the numbers moved inside a day the last time
this corpus was sized.

| grain | `true` | `false` | `null` | absent | component rows |
|---|---:|---:|---:|---:|---:|
| `orders` | 3,916 | 905 | 2 | 0 | 4,823 |
| `invoices` | 0 | 0 | 0 | **4,397** | 4,397 |
| `fulfillments` | 0 | 0 | 0 | **4,823** | 4,823 |

| of the 9,220 rows to fill | prod | dev |
|---|---:|---:|
| paired order line states `true` | 7,461 | 7,452 |
| paired order line states `false` | 1,736 | 1,736 |
| paired order line unstated too | 4 | 4 |
| no paired order line | 18 | 26 |
| no such order document | 1 | 1 |

⚠️ **prod and dev agree to within one invoice row.** `devReplica` mirrors prod; this is ONE
corpus measured twice, not two confirmations.

## The three facts the plan rests on

1. 🔴 **The ORDER is the authoring grain and both projections are addressable from it without
   an extra read.** An invoice line's `path[0]` **is** its source order's Firestore doc id
   (`InvoiceDocOrderItemInner`: *"the order divider's identity IS the source order's Firestore
   doc-id"*), and a fulfillment's own `uid` is its order's with `projectItem` copying `path`
   through. ⚠️ **Do not join on `item.uid`** — it repeats within one document, in 18% of prod
   orders (`cfs-items`).

2. 🔴 **The emit is gated on the backfill, not on taste, and a conditional spread does not
   rescue it.** `invoiceItemDifferences` compares top-level KEY SETS, and `buildOrderLine`
   writes `zero_priced` explicitly on *every* order line. Emit before the stored invoice lines
   carry it and every paired line reports a key-set difference at once — the shape
   `utils/invoices.ts` already records happening three times (`base_percent`, `crms_id`,
   `price.discount_percent`; 8,015 of 8,978 paired lines). The condition a conditional spread
   would test is true for every line, which is what makes this one different from its three
   neighbours.

3. ⭐ **The backfill is SAFE, and this is the arm whose non-zero answer would have stopped
   everything.** Deriving from the *current* order line is not recovering what an invoice was
   billed on — the 18 unpaired rows are the proof orders drift after invoicing — and
   `checkZeroPricedAmount` couples the flag to the money (`zero_priced === true` requires
   `base_cents === 0`). An invoice line still carrying a charge under a drifted `true` would be
   a row the backfill stamps and the refine then refuses. **0 such rows in both projects.**

## The residue, and why no owner ruling is needed

- **2 order rows** state nothing — the *same component in two orders*: `liZq0omBzLAOaU2EquYL`
  (*Makeup Mirror Case (2 Mirrors)*) under `F4uPA273BUHa0Qf5ZLVr` (*Hair & Makeup Mirror*),
  `zero_priced: null`, `inclusion_type: null`, `base_cents: 0`. Its catalog entry says
  **`true`**, from both parents that carry it, with no conflict. ⭐ **The stored money
  corroborates the catalog**, so this is derivable rather than a judgment call. The 4 "unstated
  too" rows above are its two projections.
- **0 of 175** `products.components[]` entries state nothing (122 `true`, 53 `false`, 68
  products). No upstream silence either.
- **0 documents** carry a stated component beside an unstated sibling under one parent. That
  was core#100's own second narrowing and it is answered: **nothing in the corpus is evidence
  that absence was ever a deliberate answer.**

## The order of work

Each step's verification is the thing that licenses the next one. Nothing here needs a deploy
before a backfill — the field has been declared `.nullable().optional()` on all three grains
since `@cfs/core@10.0.0-beta.366` (manager#421 stage one) and every consumer is past it, so the
`z.strictObject` ADD hazard in `cfs-release-order` was paid a release ago.

1. **Backfill** (`api-cloudrun`, a new script). Derive each invoice and fulfillment component
   row from its paired order line; fall back to the catalog `components[]` entry for the ~19
   with no paired line and for the 2 order rows themselves. **Baseline the census before the
   write and re-run it after** — only a before/after pair says what the run caused.
   ⚠️ Drive the real writer rather than writing documents directly; grep `scripts/` for a
   repair that already does.
2. **Assert the key-set fact directly, do not trust the ordering.** The census re-run must read
   **0 absent** on both projected grains before step 3 begins. Fact (2) above is the reason:
   any subset the backfill missed becomes a key-set difference on every paired line the moment
   the emit lands.
3. **Emit** — `projectOrderItemToInvoiceItem` and `projectItem`, plus `createInvoice`'s
   hand-mirrored mapping in `api-cloudrun` (`projectOrderItemToInvoiceItem`'s own docblock says
   the two mirror each other hand-for-hand). Publish, pin all three consumers.
   ⚠️ **This step must also DELETE the 🔴 *"DECLARED, NOT YET EMITTED"* blocks on
   `InvoiceDocLineItemType.zero_priced` and `FulfillmentLineItemType.zero_priced`** (core
   `5f01294`). They carry measured counts — 0 of 4,397 and 0 of 4,823 — that this step makes
   false, and a stale present-tense claim in a schema docblock is the exact defect they were
   added to repair. The docblocks were asserting the mirroring as fact while nothing stored it.
4. **The refine** — core#100. Array-level, **both directions** in one place: a flagged line is
   a component, and a component states the flag. It cannot be a per-item refine;
   `checkZeroPricedAmount`'s docblock says why (componenthood is positional, so deciding it
   needs the sibling array). All three schemas currently have a bare
   `z.array(X).default([]).meta({ label: "Item" })` with no array-level refine at all.
5. **`AuthoredProductComponent.zero_priced` becomes required** — see below.
6. **`manager`** — the four guards, the collapse rule and the `component-row` class stop being
   dead.

## 🔴 The step that makes the refine hold instead of decay

Step 4's refine is satisfiable only while `buildOrderComponentLines` has something to copy: it
writes `zero_priced: comp.zero_priced ?? null`, so **one catalog component authored without the
flag puts a `null` on every order line built from it** and the refine begins refusing live
writes. `AuthoredProductComponent.zero_priced` is `boolean | undefined` today, so the schema
permits exactly that.

It is **175/175 stated in prod — a zero-row backfill**, the same shape as making
`inclusion_type` required on that same interface, which this repo has already done for the same
reason. Requiring it makes the document-level invariant true *by construction* rather than true
*until someone adds a component*.

⚠️ **Not `.default(...)`** — `validateBeforeWrite` writes the RAW document, so a schema default
never materialises and the field is still written absent. `AuthoredProductComponent`'s own
docblock records that trap for `inclusion_type`.

## Deliberately not doing

- **Asking the owner to rule on the population.** The measurement answers it. If there is still
  a question worth asking it is about **175 catalog rows**, not 9,214 document rows — and the
  honest framing is *"were these consciously considered?"*, which no census can answer.
- **Requiring `zero_priced` on the three document line-item schemas.** manager#421's owner call
  is on record: requiring it makes an invoice line *stricter* than the order line it mirrors,
  which is the opposite of the alignment the field exists for.

## What could still surprise you

⚠️ **The ~19 rows with no paired order line are not noise, and 6 of them are one kit.** Invoice
1850 carries the whole *Hair & Makeup Mirror* component block at a path its order no longer
has. Worth one look before the fallback is written — if orders are dropping component subtrees
after invoicing, that is its own finding and this campaign is not its home.

⚠️ **A gating census against live dev can read non-zero because a PEER'S SUITE is mid-run.**
`pgrep -fl "deno.*test"` before believing a dev number, in either direction.

## Context recommendation

**CLEAR.** Nothing here depends on the session that measured it — every number is reproducible
from one script, and every ruling it replaced is written down above. A fresh window starting at
step 1 loses nothing.

**Delete this doc in the commit that lands step 6.**
