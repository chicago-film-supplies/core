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

> ## ⚠️ STATUS UPDATE 2026-09-10 — DONE except the templates PR. Delete this doc when it merges.
>
> ⭐ **Steps 1-6 have landed. The only thing left is
> [templates#304](https://github.com/chicago-film-supplies/templates/pull/304)**, which is open,
> green on all four checks at its HEAD sha (`visual-diff` included), and needs a human merge —
> merge is the publish authority and agents open PRs only. **Delete this doc in the commit that
> merges it**; nothing else here is outstanding.
>
> | what | where |
> |---|---|
> | backfill, both projects | **0 unstated component rows on all three grains, from 9,213** |
> | emit + input channel | `@cfs/core@10.0.0-beta.401` |
> | refine + catalog required | `@cfs/core@10.0.0-beta.402` |
> | consumers | api-cloudrun `c4ad7a1a`, manager `0c6748c` — both on beta.402 |
> | templates | PR #304, on beta.401; a later bump to .402 is routine (Renovate #197 is open) |
>
> Prod write: 2 orders, 1,040 invoices, 1,014 fulfillments, zero failures, queues paused and
> drained. Both betas verified **against the tarball** from a consumer, not against core's own
> gates. Both live corpora re-parsed against the LOCAL core before the refine was cut — 1,020
> orders, 1,040 invoices, 1,020 fulfillments, 570 products, all parse, in both projects.
>
> ## 🔴 Five things this plan did not know, every one found by RUNNING rather than reading
>
> 1. **The emit's population is LINES, not components.** `invoiceItemDifferences` counts a
>    null-valued key as PRESENT and `buildOrderLineFromProduct` writes `zero_priced: null` on
>    every order line, so the emit had to be unconditional and the backfill had to cover every
>    line. The narrow value-conditional rule saved only **102 documents of 1,037** and would have
>    made a line's KEY SET depend on its VALUE.
> 2. **Stamping the flag can make a document UNWRITABLE.** `computeItemPaths` sorts
>    `zero_priced === true` ahead of its priced siblings and `validatePathsAgainst` compares
>    `items[i].uid` positionally, so the write boundary checks the LINEARIZATION. 3 prod invoices
>    reordered. ⚠️ **Any future items[] backfill must WRITE IN CANONICAL ORDER rather than patch a
>    key in place.**
> 3. **The input channel the emit needed created a way to LOSE the field** — `?? null` on an
>    omitted key wipes a backfilled answer. Closed by `preserveStoredZeroPriced`.
> 4. 🔴 **A SUBSTITUTED component had no way to get the flag, and that was a live 400.** The
>    carry-forward keys on `(uid, k-th occurrence)` and a substitution puts product Y in product
>    X's slot, so there is no uid to pair on. It now inherits from the slot — `zero_priced` is a
>    property of the POSITION, not the product. ⚠️ The first fix was silently wrong:
>    `path_substituted_for` holds the ORDER path while stored rows are divider-scoped, which
>    `lib/invoiceSubstitutions.ts` names as "the silent failure mode".
> 5. **`templates` was a PREREQUISITE for the refine, not its tail.** `lintFixture` parses every
>    fixture against the real `InvoiceSchema`; the invoice family was 20 of 20 line rows unstated
>    across all 8 files while the quote family was 0 of 134, because quote fixtures are captured
>    from ORDERS. ⭐ **A captured fixture is only as complete as the document it captured.**
>
> ⚠️ **Two tests INVERTED rather than being deleted, and expect one per grain for anything that
> tightens `items[]`:** core's *"the PROJECTION does not emit zero_priced yet"* was literally the
> stage-one spec, and api-cloudrun's *"buildFulfillment line items expose only fulfillment-safe
> fields"* listed the key among the order-only leaks.
>
> ⚠️ **And the retry ladder's "transient" label is per FILE.** `invoiceSubstitution.test.ts` reads
> *"seen 5 times before, 4 called transient"*, and finding (4) was sitting underneath it,
> deterministic. Read the assertion, not the label.

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
