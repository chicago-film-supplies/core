# Retiring inert `.default()` on stored schemas

*Promoted from the session of 2026-09-09. Owning repo is `core` — the schema policy is the work.
`api-cloudrun` owns the repair scripts and the census this doc names; `manager` is named only by
api-cloudrun#943's remaining half.*

> ## ✅ STATUS 2026-09-13 — **batch 11 landed. Backlog 69 → 62. Chain verified by digest.**
>
> The templates family — 7 paths across three collections: `templates.active_semver` /
> `depends_on.components` / `fixtures` / `draft_uids`, `templates-versions.params` /
> `consumed_components`, `template-components.draft_uids`. `core` published **`beta.415`**
> (`dc900c2`). Writer audit (agent-run): of the 16 (field × real create-site) combinations across
> `registerTemplateFamily`, `publishFromMerge` and the manager-facing draft flow, **15 already
> stated the field explicitly**; the one exception, `active_semver` at `registerTemplateFamily`,
> writes via a raw `tx.set()` that bypasses schema validation entirely (so no default was ever
> consulted there either). Census, both projects, 100% present / 0 null on all seven paths before
> the edit: `templates` 7/7 prod · 9/9 dev, `templates-versions` 137/137 · 741/741,
> `template-components` 1/1 · 1/1 — thin denominators, so the writer audit carried the claim, not
> the census (batch 4's rule).
>
> 🔴 **`active_semver` is the one field whose interface was already optional (`?: string | null`),
> and the right fix was NOT `.nullable().optional()` — a sibling ratchet (`tests/stored-optionality.test.ts`,
> core#83) caught that immediately.** Owner ruling there: a stored field is `.nullable()` (present,
> possibly null) or fully required, never `.nullable().optional()` — the absent state is what once
> made a legally-missing `Invoice.reference` hand a stray `undefined` into an unrelated ORDER update
> and 400 it. Fixed by making `active_semver` required-and-nullable like its sibling `uid_active`,
> and having `registerTemplateFamily` state `active_semver: null` explicitly.
>
> ⚠️ **The `Template` interface change (making `active_semver` non-optional) surfaced 9 more
> hand-spelled/seed `Template` literals the compiler had never checked** — `api-cloudrun/tests/helpers/seedTemplate.ts`,
> `api-cloudrun/scripts/seed-quote-template.ts`, and 7 integration-test fixtures across
> `api-cloudrun/tests/integration/templates/` — all "create-shaped" literals; every `...fam`-spread
> update-path literal was already safe by
> construction. `deno task check` against a `file://`-pinned local core found all of them.
>
> ✅ **The chain is CLOSED, by digest.** Release PR #970 merged as `cb2a7930`, cutting **`v0.251.1`**.
> Build `afa77e2f` (region `us-central1`) produced `sha256:a3d0973811adf56c129d427f193b956583d418048714db3e15b227b6f614f297`,
> and revision **`api-cloudrun-00376-sl6`** serves exactly that digest at 100% traffic. Deployed
> tree's `deno.json`/`deno.lock` pulled off the Artifact Registry blob store (Docker Registry HTTP
> API, no `docker` on the box) — both byte-identical to the checkout. Reparse with no `--core` flag:
> **all 3 positions `REACHED`, 0 new failures, in both projects** — the same pre-existing
> `api-cloudrun#955` transactions row (plus dev's known `locations`/`users` rows) unrelated to this
> batch.
>
> ⭐ **`getInitialValues` checked and unaffected**: before/after dump of all three schemas is
> byte-identical — every one of the 7 defaults equalled its node's type-zero (`active_semver` seeds
> `null`, matching its own `.nullable()`), so no `.meta({ initial })` was needed.
>
> ⚠️ **A peer's uncommitted, in-progress WIP in the shared `manager` checkout (a pane-rail component)
> failed my pre-push suite on the first try — not my change.** Messaged the peer rather than
> stashing their files; they confirmed their tree was green minutes later and the retry passed.
> **`manager` was released (`manager-v26.2.1`) before api-cloudrun's release PR was merged**, as the
> ordering rule requires — `requires-manager`'s measured arm needed a manual re-run (it had cached
> the pre-release-manager result) but came back green before the merge.
>
> 🔴 **A stale citation from batch 10's OWN status-update commit broke `beta.415`'s first push —
> not this batch's schema change.** A backticked path naming only `fixtureFormat.test.ts`'s
> directory and filename, with no `api-cloudrun/` prefix inside the backticks, resolved against
> core's own tree in CI's core-alone checkout ("no such file"), even though the surrounding prose
> named `api-cloudrun` outside the backticks — the audit only reads what is inside them. Blocked
> the `release` job; fixed in a follow-up commit
> (`f485a32`) and republished as `beta.415` (the `beta.414`-tagged `dc900c2` commit never actually
> published — CI failed before the `release` job ran). **Two full-workspace `deno task
> audit:citations` runs missed it**; only CI's core-alone run (the doc's own "STRONGER" claim) caught
> it, exactly as `core/CLAUDE.md`'s citations section already predicted.
>
> | batch | what | backlog | state |
> |---|---|---:|---|
> | 1–9 | see `core/CLAUDE.md` § *`.default()` and `.optional()`* and the table two sections below | 259 → 75 | ✅ prod |
> | 10 | `sources`/`reference` tidy-up — 6 paths, 5 declarations | 75 → 69 | ✅ prod, `v0.251.0` |
> | 11 | the templates family — 7 paths, 3 declarations | 69 → **62** | ✅ prod, `v0.251.1`, revision `api-cloudrun-00376-sl6`, digest-verified |

## What shipped

| piece | where | state |
|---|---|---|
| 14 `.default(null)` removed from `OrderDocDates` | `core/src/schemas/order.ts` | ✅ landed |
| parity-test fixture completed to all 14 keys | `core/tests/destination-pair-parity.test.ts` | ✅ landed |
| 20 fabricated invoice windows repaired, prod + dev | `api-cloudrun/scripts/backfill-invoice-destination-windows.ts` | ✅ applied |
| the rule + the symptom lesson | `core/CLAUDE.md` § *`.default()` and `.optional()`* | ✅ landed |
| 40 pins + 2 parsed fixtures | `api-cloudrun` `adc121bf` | ✅ landed on `main` |
| 1 pin | `manager` `8edfa7b` | ✅ landed on `main` |
| 15 pins + 1 parsed fixture | `templates` `cb9b44b` (PR #301) | ✅ merged |
| `beta.399` reaching **prod** | `v0.247.0` → revision `api-cloudrun-00364-v6z` | ✅ deployed |
| the campaign's ratchet, 291 paths partitioned | `core/tests/stored-defaults.test.ts` (`5d14347`) | ✅ landed |
| **batch 2** — 28 defaults on the derived-denorm family | `core` `fb4a572` → `beta.403` | ✅ published |
| 2 order literals completed to the four new keys | `api-cloudrun` `c499891d` | ✅ landed on `main` |
| 40 pins | `api-cloudrun` `1c552f07` | ✅ landed on `main` |
| 1 pin | `manager` `3fed294` | ✅ landed on `main` |
| 1 quote fixture + templates#305 + 15 pins | `templates` PR #306 | ✅ merged |
| **the ratchet hole** — all three walks re-scoped, +47 then +19 paths | `core` `4f73bca` | ✅ landed |
| **batch 3** — the seven `.default("")` on `Address`, 105 paths | `core` `ce8272d` → `beta.404` | ✅ published |
| the parse-not-census rule + the shared stored/input node rule | `core/CLAUDE.md` § *`.default()` and `.optional()`* | ✅ landed |
| 4 inverted tests repaired as mirrors | `core/tests/{usState,organization}.test.ts` | ✅ landed |
| 42 pins | `api-cloudrun` `200af2cf` | ✅ pushed |
| 15 pins + lockfile | `templates` PR #307 | ✅ merged |
| **batch 4** — `phones` ×9 + `organizations.emails`, 10 paths | `core` `a109c22` → `beta.405` | ✅ published |
| the writer fix that makes it reachable + 42 pins | `api-cloudrun` `be9965b8` | ✅ landed on `main` |
| a stored-VALUE assertion for it, verified against its own absence | `api-cloudrun/tests/integration/orders/orders.test.ts` | ✅ landed |
| 1 pin | `manager` `ea454f2` | ✅ landed on `main` |
| 15 pins + lockfile | `templates` `41f6f9b` (PR #308) | ✅ merged |
| **`beta.405` reaching prod, and batch 3 with it** | `v0.248.1` → revision `api-cloudrun-00366-whd` | ✅ deployed |
| **the corpus-parse instrument** — batch 5's prerequisite, `api-cloudrun#951` + `#636` | `api-cloudrun/scripts/audit-schema-validation.ts` + `_corpusReparse.ts` (`5ed776fe`) | ✅ landed on `main` |
| its calibration, four mutations each failing one arm | `api-cloudrun/tests/unit/corpusReparse.test.ts` | ✅ landed on `main` |
| `typesense-pulse` catalogued — the prod collection census goes exit 1 → 0 | `api-cloudrun` `310dd3bc` | ✅ landed on `main` |
| **batch 5** — `items[].description` ×11, 5 declarations | `core` `27be0ad` → `beta.406` | ✅ published |
| 8 repaired tests — the `docLine` factory + two raw literals routed through it | `core/tests/order.test.ts` | ✅ in `27be0ad` |
| the citation that had silently skipped two publishes | `core` `2dc6b6b` | ✅ landed on `beta` |
| 40 pins, as a release-cutting `fix` rather than a `chore(deps)` | `api-cloudrun` `ab9013a4` | ✅ landed on `main` |
| 1 pin | `manager` `313bfd0` | ✅ landed on `main` |
| 15 pins | `templates` PR #310 (`c10574d`) | ✅ merged |
| `v0.249.0` reaching prod, verified by digest and by a pinned-core reparse | revision `api-cloudrun-00367-xm4` | ✅ deployed |
| **batch 6** — the `price` block ×3, 24 paths, 3 declarations | `core` `9a48a5a` → `beta.407` | ✅ published |
| 40 pins + two EXPIRED comments re-stated as history | `api-cloudrun` `05e1e65c` | ✅ landed on `main` |
| the shared-counter assertion repaired on the RESULT, mutation-verified | `api-cloudrun` `b0961b80` | ✅ landed on `main` |
| 1 pin | `manager` `7697e16` | ✅ landed on `main` |
| 15 pins + lockfile | `templates` `3d6d491` (PR #311) | ✅ merged |
| `beta.407` reaching prod, verified by digest and by a pinned-core reparse | `v0.249.1` (`d640a907`) → revision `api-cloudrun-00368-bx8` | ✅ deployed |
| **batch 7** — `quantity` ×4 + `name` ×4, 8 paths, 4 declarations | `core` `37c4209` → `beta.408` | ✅ published |
| the `docLine` factory completed — 7 failures, one cause | `core/tests/order.test.ts` (in `37c4209`) | ✅ published |
| 40 pins, as a release-cutting `fix` | `api-cloudrun` `24cb4c9e` | ✅ landed on `main` |
| 1 pin | `manager` `4f0a481` | ✅ landed on `main` |
| 15 pins + lockfile | `templates` `1b5e754f` (PR #312) | ✅ merged, verified on the remote |
| `beta.408` reaching prod, verified by digest and by a pinned-core reparse | `v0.249.2` (`7bd11246`) → revision `api-cloudrun-00369-7rk` | ✅ deployed |
| **batch 8** — the `cards` family's pure-storage half, 10 paths, 2 declarations | `core` `5b31d93` → `beta.409` | ✅ published |
| 40 pins, as a release-cutting `fix` | `api-cloudrun` `215d00ff` | ✅ landed on `main` |
| 1 pin, released so the new measured manager gate has a green other side | `manager` `8e03fb8` → `manager-v26.0.2` | ✅ released |
| 15 pins + lockfile | `templates` PR #314 | ✅ merged, verified on the remote |
| `beta.409` reaching prod, verified by digest and by a deployed-core reparse | `v0.249.4` (`c22b6cf1`) → revision `api-cloudrun-00371-zqw` | ✅ deployed |
| **batch 9** — the `products` family + 2 card stragglers, 15 paths, 3 declarations | `core` `22e695e` → `beta.410` | ✅ published |
| 15 direct requirement assertions — the `getInitialValues` fixtures cannot fail one | `core/tests/{product,webshop-product,card}.test.ts` (in `22e695e`) | ✅ published |
| the two-parse-seams rule + the blind-fixture rule | `core/CLAUDE.md` § *`.default()` and `.optional()`* | ✅ in `22e695e` |
| 40 pins, as a release-cutting `fix` | `api-cloudrun` `1cdb3a2a` | ✅ landed on `main` |
| 1 pin, RELEASED FIRST so `requires-manager` measured green | `manager` `156d470` → `manager-v26.0.3` | ✅ released |
| 15 pins + lockfile | `templates` `a069082` (PR #315) | ✅ merged, verified on the remote |
| `beta.410` reaching prod, verified by digest and by a deployed-core reparse | `v0.249.5` (`6bcefeed`) → revision `api-cloudrun-00372-f6z` | ✅ deployed |
| **follow-up 1** — `CreateProductInput` stops defaulting 4 arrays; `createProduct` authors them | `core` `933248c` → `beta.411` | ✅ published |
| the writer + the create that OMITS all four, mutation-verified as a pair | `api-cloudrun` `1e6fc531` | ✅ landed on `main` |
| 1 pin, released first so `requires-manager` measured green | `manager` `156d470` → `manager-v26.0.5` | ✅ released |
| 15 pins | `templates` `a069082` (PR #316) | ✅ merged |
| `beta.411` reaching prod, digest-verified, deployed tree carrying BOTH halves | `v0.250.0` (`9e8d6070`) → revision `api-cloudrun-00373-nwx` | ✅ deployed |
| **follow-up 2** — `price.taxes` REQUIRED on both product inputs, correcting follow-up 1 | `core` `4c41d10` → `beta.412` | ✅ published |
| the dead `"taxes" in update.price` presence test deleted + 40 pins | `api-cloudrun` `2c38a3bb` | ✅ landed on `main` |
| 1 pin, released first | `manager` → `manager-v26.0.6` | ✅ released |
| 15 pins | `templates` `55d59a3` (PR #317) | ✅ merged |
| `beta.412` reaching prod, digest-verified | `v0.250.1` (`1b1dcf47`) → revision `api-cloudrun-00374-r6f` | ✅ deployed |
| **the prod repair** — 3 rentals + 3 component copies restored to Chicago Rental Tax | `api-cloudrun/scripts/repair-product-missing-rental-tax.ts` (`0b6ab037`) | ✅ applied, both projects |
| **batch 10** — the `sources`/`reference` tidy-up, 6 paths across 5 declarations | `core` `720a8f6` → `beta.414` | ✅ published |
| the `updateOrder` typed-assignment fix (`?? null`, matching `uid_store`) + a fixture completed + 40 pins | `api-cloudrun` `15fe1094` | ✅ landed on `main` |
| 1 pin, released first so `requires-manager` measured green | `manager` `7350791` → `manager-v26.2.0` | ✅ released |
| 15 pins | `templates` `0be9047` (PR #323) | ✅ merged |
| `beta.414` reaching prod, verified by digest (deno.json/deno.lock pulled off the registry blob store, no docker available) and by a deployed-core reparse | `v0.251.0` (`b3607570`) → revision `api-cloudrun-00375-cxd` | ✅ deployed |
| **batch 11** — the templates family, 7 paths across 3 declarations | `core` `dc900c2` → `beta.414` (never published — citation broke the release; see next row) | ✅ merged |
| the citation fix that unblocked the publish | `core` `f485a32` → **`beta.415`** | ✅ published |
| `registerTemplateFamily` states `active_semver: null` + 9 completed `Template` literals (`api-cloudrun/tests/helpers/seedTemplate.ts`, `api-cloudrun/scripts/seed-quote-template.ts`, 7 integration fixtures) + 40 pins | `api-cloudrun` `757540a9` | ✅ landed on `main` |
| 1 pin, released first so `requires-manager` measured green (needed a manual gate re-run — see below) | `manager` `695aa4b` → `manager-v26.2.1` | ✅ released |
| 1 pin + `deno install`-regenerated lockfile | `templates` `e6bdcd5` (PR #324) | ✅ merged |
| `beta.415` reaching prod, verified by digest and by a deployed-core reparse | `v0.251.1` (`cb2a7930`) → revision `api-cloudrun-00376-sl6` | ✅ deployed |

`OrderDocDates` is `DestinationPairCore.dates`, so it is the dates map on **all three grains** —
one edit changed orders, invoices and fulfillments together. That is also why an *invoice* parity
test went red on an edit to `order.ts`.

## 🔴 The finding that outlives this doc: the absent key was a SYMPTOM

The census gated cleanly on twelve keys and blocked on the two DERIVED ones, `days_active` /
`days_charged`, absent on 20 invoice pairs (the 2025-12-02 CRMS import, all `paid`, all
order-linked).

The obvious repair was to project the durations from each source order — exactly what core#101 did
for the flags on this same seam. **It was wrong**, and the only thing that caught it was an
anti-vacuity arm asserting the two documents' windows already agreed *before* projecting a value
derived from them:

```
invoice #1216   all six boundaries = 2026-01-24T15:37:56.377-06:00   ← a migration's own clock
order   #18     delivery 2023-02-22T09:00 → collection 2023-03-10T15:00, days_active 13
```

All six boundary instants — delivery, collection AND charge — held one value. There was no duration
because there was no window. Projecting the order's real duration onto that fabricated window would
have written 20 plausible wrong values and turned the census green.

⭐ **The rule: a repair that projects from an authority must assert the authority and the subject
already agree on everything the projected value DEPENDS on.** One predicate, fails closed.

⭐ **And the predicate that selects the population needs the same scepticism.** The repair is
triple-confirmed — six boundaries identical to each other, AND disagreeing with the source order,
AND both durations absent. Criterion 1 alone matches **66** pairs, of which **46 are legitimate**
same-day jobs that agree with their order and carry real business timestamps. Criterion 2 alone
matches pairs an order edit legitimately moved. Only the conjunction names the migration's output,
and on the measured corpus all three agree on the same 20.

## Batch 2 — the derived-denorm family, and what it cost

**The partition, RE-DERIVED 2026-09-10 by the recipe below** (do not quote these either):

| | count | note |
|---|---:|---|
| backlog before | 239 | |
| reachable by the cheap oracle | 164 | scalar / nested-map |
| **not** reachable | 75 | `array[]` members |
| FREE (0 absent, both projects) | 102 | |
| BLOCKED | 47 | mostly the one shared `Address` block |
| VACUOUS | 15 | `location-types` + `recurrences` are EMPTY in both projects |
| **taken by batch 2** | **28** | 20 `query_by_*` + 8 `bookings_breakdown` |
| backlog after | **211** | |

⭐ It reconciles exactly with the 2026-09-09 table minus batch 1's 20 removals (184 − 20 = 164
reachable, 122 − 20 = 102 free), which is itself a check that the re-derivation was not a fresh
guess. The dev-absent >= prod-absent consistency check held on all 164.

**Three `query_by_*` were deliberately LEFT** — each has measured absences and stays in the backlog:
`bookings.query_by_uid_store` (4,205), `contacts.query_by_organizations` (dev 2),
`orders.query_by_invoices` (2). ⭐ Each is absent on exactly the same documents as its SOURCE field
(`bookings.stores` is absent on the same 4,205; `orders.invoices` on the same 2), which is what a
denorm's absence should look like and is the reason to treat them as one repair rather than four.

### What made this batch cheap, and what will not generalise

⭐ **`validatedUpdate` validates the full MERGED document, never the patch**
(`api-cloudrun/src/lib/firestoreWrite.ts`), and `updateOrder` builds it with `cloneDeep(order)`. So
**update paths are safe by construction**: a stored key carries forward. Only a from-scratch
construction can regress, which collapses the writer audit from "every write site" to "every create
site" — a much smaller set. ⚠️ This holds only while a caller builds `merged` from the stored doc; a
caller that hand-builds a partial `merged` would have been leaning on the default invisibly.

⭐ **All 28 interface members were ALREADY non-optional.** The schema defaulted what the interface
required — the exact blind spot `z.ZodType<T>`'s one-directional check cannot see — so procedure
step 4 was a no-op and typed document literals were already compiler-gated. **That is why the only
two defects were untyped fixtures**, and it predicts the same for any batch where the interface
already states the field.

### The two repairs, and the one that was a MIRROR

- `api-cloudrun/tests/unit/fixtureFormat.test.ts` and
  `api-cloudrun/tests/integration/templates/fixtures.test.ts` — both hand-spelled `orders` literals,
  both missing all four. ⭐ **The cheap tier and the expensive one each found exactly one**:
  `test:units` caught the first in 9 seconds; only the integration tier reached the second, where all
  five failures traced to one `orderDoc()` helper.
- `core/tests/inventory-ledger.test.ts` — a literal that calls itself *"a complete document"* while
  carrying `query_by_uid_store` **without its sibling** `query_by_uid_location`.
- 🔴 `core/tests/location.test.ts` had an **INVERTED test**: `LocationSchema defaults arrays when
  omitted` asserted that all four could be dropped and still parse. **That assertion was the
  default's own spec.** Rewritten as its mirror — one dropped key per step, so each case names the
  constraint it tests rather than failing for some reason. ⭐ `product_capacities` / `products` are
  deliberately left unasserted *in either direction*: they are still backlog, and pinning their
  current defaults would recreate this same inverted test for the next batch to undo.

### ⚠️ Whether dev is a second sample is PER COLLECTION, not a property of the campaign

Batch 1's four grains are the same size to the document, so `devReplica` made it one corpus measured
twice. **Six of batch 2's ten collections differ** — transactions 2,148 vs 1,958, bookings 7,120 vs
7,112, organizations 322 vs 318, locations 210 vs 209, out-of-service 4 vs 2 — so the dev run added
~200 rows the legacy ingest never wrote, and was a real second sample. **Compare the two counts
before claiming either.**

### The classifier that was wrong by 42

A first pass over the `templates` fixtures reported **43** exposed documents. The real number is
**1**. The classifier matched invoice-SHAPED maps anywhere in the tree and swept in `aging-report`'s
`.rows[]` — but `lintFixture` parses only the top-level `fixture.doc`, against the FAMILY's declared
`collection_source`, and `aging-report` resolves to `aging-reports`, which never meets
`InvoiceSchema` at all. ⭐ **Read the gate's own dispatch before writing a census of what the gate
will refuse** — the sidecar (`templates/templates/<family>.meta.json`) names the collection, so the
mapping is a lookup rather than an inference.

## Verification, and how it was gated

The gate is a key census over `destinations[].dates` on all three grains, both projects — absent is
the question; `null` is a legal stored value and is counted separately so the probe can be seen to
tell them apart. Baseline 2026-09-09: prod and dev each 40 absent-key occurrences (20 invoices × 2).
After the repair: **0 across all three grains in both projects**, confirmed by two independent
instruments (the repair's own predicate reads 0, and the census reads 0).

⚠️ **Dev was not a second sample.** `devReplica` mirrors prod writes, so dev healed from the prod
run — one confirmation, not two. Measured after, not assumed.

⚠️ **The repair does NOT reach Xero, and this was verified rather than hoped.** `invoices` carries
Eventarc triggers for Typesense sync, the activity feed and the prod→dev mirror only
(`api-cloudrun/infra/eventarc.tf` + `local.typesense_collections`); the Xero push is enqueued by
SERVICE code (`/tasks/push-xero-invoice`), never by a Firestore write. That is the **opposite** of
`afterProductWrite`, which does fire from Eventarc — so the question has to be asked per collection
and cannot be generalised. `version` is deliberately not bumped either.

## What is left

- ✅ **The pin sweep is DONE** — 40 pins in `api-cloudrun`, 1 in `manager`, 15 in `templates`, all
  bumped by `sed` over `jsr:@cfs/core@10.0.0-beta.398/` rather than by a count. The prediction held
  exactly: `deno check` and `tsc --noEmit` were green everywhere because `OrderDocDatesType` never
  moved, and **every one of the three real defects was a fixture the compiler cannot see**.
  ⚠️ One correction to the prediction: it said the api-cloudrun *pre-push* suite would be where this
  surfaces. It was not — `test:units` caught the first one in 9 seconds, and the second was found by
  reading the file's own comment (*"`saveFixture` parses this against the `collection_source`
  schema"*) rather than by running anything. **The cheap tier found more than the expensive one.**
  The three: `api-cloudrun/tests/unit/fixtureFormat.test.ts`,
  `api-cloudrun/tests/integration/templates/fixtures.test.ts`,
  `templates/fixtures/quote/discounts-and-fee.json` — each missing **exactly the six `_fs` twins**.

- 🔴 **CARRY THIS INTO THE CAMPAIGN: a sweep hit must be classified by WHICH SCHEMA IT IS, not by
  which one it is not.** A naive census of `dates` literals reported 47 dangerous hits. It was wrong
  in both directions — it swept in `Booking.dates` and Typesense shapes, and it **missed every JSON
  fixture**, because `"dates":` carries a quote before the colon and a bare `\bdates\s*:` never
  matches it. Narrowed to real destination-pair literals: 69 scanned, 36 complete, 33 incomplete —
  **and 22 of those 33 are `OrderDates` INPUT payloads that are CORRECT and must not be touched.**

  ⭐ **The discriminator, which generalises to every tightening in this campaign: omission
  identifies the schema.** `OrderDates` (input) is exactly six nullable ISO keys; `OrderDocDates`
  (stored) is fourteen. So *missing exactly the six `_fs` twins plus `days_active`/`days_charged`
  is the signature of an input payload*, not of a defect. The positive form is better still — a
  doc-shaped pair carries `customer_collecting`/`customer_returning` and the two durations; an
  input-shaped one never does. That is what turned 33 things to look at into 3 to repair.
  ⚠️ The classifier is still a heuristic derived from the same text it measures; **the suite is the
  oracle.** It agreed: 2,022 unit tests and the full integration tier green, including
  `orders/jurisdiction.test.ts` and `orderOrigin.test.ts`, which are among the 22 left alone.

- ✅ **Corpus re-censused immediately before the push, because the DEPLOY is what makes the
  tightening bite**: **3,049 destination pairs** across orders, invoices and fulfillments, in both
  projects, **0 absent-key occurrences and 0 stored nulls**.
  ⚠️ `destinations` is an array of maps, so `orderBy` cannot reach inside it — this has to page and
  check in code, and it is exactly the `array-member-uncensusable` case `cfs-release-order` names.
  ⭐ **The probe was controlled against a synthetic pair FIRST** (it correctly reported 3 missing and
  2 nulls), because 0-absent *and* 0-null across 42,686 key slots reads identically to a broken `in`
  check. ⚠️ And prod/dev are **not** independent samples — `devReplica` mirrors prod writes, and the
  two read identically — so that is one confirmation, not two.

- **The wider campaign — 143 inert paths remained AS OF BATCH 4** (it is **69** after batch 10; this
  paragraph is kept for the arithmetic, not the number), and that arithmetic is NOT a subtraction:
  259 − 20 − 28 + **47** (the paths the ratchet had never enumerated) − 105 (batch 3) − 10 (batch 4)
  = 143. Concentrated in `invoices` (23), `orders` (21), `credit-notes` (19), `fulfillments` (10),
  `cards` (10) — 76 scalar and 67 `array[]` (re-derived 2026-09-10). Read the live split off
  `tests/stored-defaults.test.ts` rather than this list, which is the one thing here that can rot. ⚠️ The older "~250 sites / ~335 distinct" figures counted
  DECLARATIONS; 291 is *resolved paths*, which is what actually reaches storage — a shared block like
  `Address` appears once per embedding collection. Each needs the same
  two-part gate: writers compliant in source, AND a corpus census proving no stored document leans
  on the default. **Tracked by core#95** (`kind:guard`, `size:campaign`), which already counts ~335 sites and
  asks for a detector as well as a sweep. `OrderDocDates` is now its worked example — including
  that the census can block on a SYMPTOM rather than on the field itself. ⚠️ Some of these are on
  INPUT schemas, where a default is legitimate and must not be swept — the rule is about STORED
  schemas.
- ✅ **The ratchet is LANDED** — `core/tests/stored-defaults.test.ts` (`5d14347`). It walks the
  Firestore registry, which excludes every INPUT schema by construction, and catalogues all **291
  resolved `.default()` paths across 37 collections**, partitioned:
  - **`SENTINEL_DEFAULTS` (32) — legitimate, not debt.** The writer sends a FieldValue sentinel that
    `validateBeforeWrite` STRIPS before parsing, so the key really is absent at validation time. 29
    are `version` under `FieldValue.increment(1)`; the other three are `arrayUnion`/`arrayRemove`
    targets — `cards.recurrence_overrides`, `recurrences.exception_dates`, `products.tags` — each
    entry naming its write site. **This is the partition core#95 asked for, and it is now made.**
  - **`INERT_DEFAULTS` (211 as of `fb4a572`; 259 when first catalogued)** — the campaign backlog. Only shrinks.
  ⚠️ **The catalogue was GENERATED from the walk, so it agrees by construction and the first green
  run proved nothing.** Both directions were verified by mutation instead: `.default("untitled")` on
  `TagSchema.name` failed the *catalogued* arm naming `tags.name`, and an unfindable catalogue entry
  failed the *shrink* arm naming it — each failing only its own arm.
  ⭐ It also pins the property the whole campaign rests on: **a parse does not add the key to the
  input object**, which is exactly why a `.default()` cannot seed a stored document.
- **api-cloudrun#943's remaining half** — the manager needs `collection_end` / `delivery_end`
  editors, and `assertWalkableWindow` must order four boundaries rather than two. Re-scoped to
  `kind:gap` this session.
- **A second class noticed and deliberately NOT touched**: invoice pairs whose window disagrees with
  their order but is *not* all-identical (#2335, #2342, #2355…). An order edited after invoicing
  looks exactly like that, so they may be entirely legitimate. **Unmeasured — do not assume the
  count is small.**

## ⚠️ Step 6 was SKIPPED on batch 1, and closed retroactively

> ✅ **Batch 2 ran it BEFORE committing, which is where it belongs** — every document of all ten
> affected collections, both projects: **26,147 parsed, 0 failures on any batch field.** It also
> found two documents that fail their own schema for unrelated reasons (api-cloudrun#951), which a
> census could never have seen. ⭐ Because the change was UNPUBLISHED, this used the **relative
> import** form sited in `core/scripts/` — the variant the siting rule below describes — and it
> worked exactly as predicted.

core#95's procedure ends *"re-parse both live corpora against the tightened schema before
committing."* Batch 1 did **not** do that. It ran the key-presence census (step 1), the writer
audit (step 2) and the fixture sweep (step 5), and treated the census as sufficient.

🔴 **A census and a re-parse are not the same check.** The census asks whether the KEY is present;
only a parse asks whether the VALUE is legal. A wrong-typed value — a float under `z.int()`, a
string under `z.array()` — is **present**, so it passes an absence census and fails a parse. Batch 1
was lucky rather than gated: the two questions coincide for a family whose defaults were all `0`
and `[]`, and they will not coincide for a family with a narrower leaf type.

✅ **Run retroactively, 2026-09-10, against the published `beta.402` — PROD only:** orders
1,020/1,020, invoices 1,040/1,040, fulfillments 1,020/1,020, credit-notes 13/13 — **3,093
documents, 0 parse failures and 0 issues anywhere under `totals`**.

✅ **Dev completed 2026-09-10 when the corpus was quiet** (an earlier attempt was killed mid-run
at load 10.4 while a peer's suite held dev Firestore): orders 1,020/1,020, invoices 1,040/1,040,
fulfillments 1,020/1,020, credit-notes 13/13 — **0 parse failures, 0 `totals` issues**, identical
to prod.

⚠️ **And the dev half added no independent rows, which is worth knowing before paying for it
again.** On these four collections the two projects are the SAME SIZE to the document (1,020 /
1,040 / 1,020 / 13), so `devReplica` is a pure mirror here and this is one corpus measured twice.
The general warning still holds and is simply not about these collections: dev's extra
native documents are real on `contacts` (182 vs 173), `cards` and `bookings` — the collections the
legacy CRMS ingest did not write. **Check the two counts before claiming a dev run is a second
sample.**

⚠️ **That result is JOINT, not isolating.** Parsing against `beta.402` exercises manager#421's
`zero_priced` required + array refinement at the same time as this campaign's totals removals, so a
failure would have needed attributing before it could be reported. Pin the beta deliberately when a
batch wants to isolate its own change.

⭐ **For a batch whose core change is UNPUBLISHED, import core by relative path instead** — that
tests the code about to be published rather than the one already out. That is the variant the
`items[]` batch needs; batch 1 did not, because its schemas were already on JSR.

⚠️ **And the two forms have different siting rules, which is the part that wastes an hour.**
A direct `jsr:`/`npm:` specifier carries its own resolution, so a probe using one runs from
**anywhere** — that is why batch 1's re-parse worked out of the scratchpad. A **relative** import
into a workspace does not: `zod` has to resolve through that workspace's import map — `core/deno.json`
— so the probe file must physically sit inside that workspace (drop it in `core/scripts/`, run it,
delete it) or it dies on *"Import zod not a dependency"*. The specifier trick cannot cover the unpublished case, which is
exactly the case the `items[]` batch is.
Three more things that are load-bearing in such a probe, all learned the expensive way by
manager#421's run:
- Build Firestore from a bare `initializeApp({ projectId })` + `getFirestore`, **never from
  `api-cloudrun/src/db.ts`** — importing that drags the consumer's PINNED core in beside the local
  one, and you are then parsing against two versions without noticing.
- **Bucket failures by the SHAPE of the issue path**, mapping every numeric segment to `#`
  (`items.#.zero_priced`), so 9,000 rows of one defect read as one line rather than flooding.
- ⚠️ `deno run -A` inside `core` will **rewrite `core/deno.lock`** when it pulls `firebase-admin`.
  Check `git status` and revert it; the probe is a probe, not a keeper.

## Reproducing the census — the recipe, because the numbers above will rot

The partition is a MEASUREMENT, not a fact about the schemas, and it moves whenever the corpus or
the backlog does. Re-derive it rather than quoting the table. Nothing here is a committed script on
purpose: it is campaign-scoped and goes when this doc does.

```sh
# 1. the backlog, straight from the ratchet — never a hand-kept list
cd core && awk '/^const INERT_DEFAULTS/,/^\]\);/' tests/stored-defaults.test.ts \
  | grep -o '"[^"]*"' | tr -d '"' > /tmp/inert.txt

# 2. split by what the cheap oracle can reach
grep -v '\[\]' /tmp/inert.txt > /tmp/scalar.txt   # orderBy-censusable
grep    '\[\]' /tmp/inert.txt > /tmp/arrays.txt   # needs a paged probe

# 3. group the scalar half per collection
while IFS= read -r p; do echo "${p%%.*} ${p#*.}"; done < /tmp/scalar.txt \
  | awk '{a[$1]=a[$1]" "$2} END {for (c in a) print c a[c]}' | sort > /tmp/bycoll.txt

# 4. census both projects (api-cloudrun owns the tool)
cd ../api-cloudrun
for PROJ in cfs-3100 cfs-dev-3100; do
  while IFS= read -r line; do
    GCLOUD_PROJECT=$PROJ deno run --allow-env --allow-net --allow-read \
      scripts/audit-field-presence.ts ${=line}          # zsh: ${=line} SPLITS
  done < /tmp/bycoll.txt
done
```

⚠️ **`${=line}`, not `$line`.** zsh does not word-split an unquoted expansion, so the plain form
hands the whole line to the script as ONE argument and every run prints usage — it fails loudly,
but it looks like a broken tool rather than a broken invocation.

⚠️ **A collection with 0 documents prints no rows at all**, which is how the 15 vacuous paths were
found. Reconcile the paths you asked about against the paths you got answers for; the difference is
not "clean".

⭐ **Control the probe before believing a clean sweep.** 0-absent everywhere reads identically to a
broken oracle. `contacts.crms_id` is the built-in calibration case — it read 12 absent of 182 on
2026-09-10 (the tool's own docblock says 166 of 178, measured 2026-08-23; the corpus grew, the
absences did not).

⭐ **Consistency check in place of a second sample:** dev-absent >= prod-absent must hold on every
path, because `devReplica` mirrors prod. It did, on all 169 measured.

## The next batch

Read the split off `tests/stored-defaults.test.ts` rather than this doc, but the shape of the
decision is stable:

- **The FREE paths are the cheap ones** (102 before batch 2 took 28 of them; re-derive rather than
  subtract) and several are shared blocks like `TotalsCore` was, so a batch is chosen by DECLARATION
  rather than by path count. ⭐ **Batch 2 found a better selector than "which paths are free": ask
  what the codebase already treats as one FAMILY.** `propagation/orders.ts` had already written down
  that `totals`, `number`, `query_by_*` and `bookings_breakdown` are the client-untouchable derived
  set — so the batch boundary was a lookup, and the writer audit generalised across all 11
  collections instead of being re-argued per path.
### ✅ `Address` WAS batch 3 — and what its table got wrong is the lesson

**Done** (`core` `ce8272d` → `beta.404`). The table that stood here is kept only as a worked error,
because it was wrong in both directions and both errors were in the INSTRUMENTS:

- It said **63 paths across 9 embeddings**. The real figure is **105 across 15** — the ratchet's walk
  deduped on node identity and could not see six of them (`4f73bca`).
- It said **35 blocked, in five embeddings carrying 49 / 2 / 1 / 1 / 1 absences**. Those counts were
  right and they were **stored nulls**: a leaf census cannot see a null parent. A whole-document
  parse found **0 defects across 24,120 prod address objects**, so every "blocked" path was free.
- Its plan of work — *"find the AUTHOR of an address"*, *"expect several populations"* — was sound
  advice aimed at a defect that did not exist. ⭐ **Ask what the instrument can SEE before designing
  a repair around what it reported.**

### ✅ `phones` WAS batch 4 — and what it proved is that a clean parse can be nearly vacuous

**Done** (`core` `a109c22` → `beta.405`, in prod as `v0.248.1`). The section that stood here called it
*"the same shape, one tenth the size"* as `Address`, and predicted the batch-3 null-parent confound
would recur. **Both halves were wrong in an instructive direction:**

- The confound never fired, because the population is too small for it to matter. `Address` had
  24,120 prod objects; the eight destination-contact positions have **18**, and one has **none**. The
  parse read 0 failures and was almost saying nothing.
- ⭐ **So the thing that carried batch 4 was the WRITER audit, not the corpus** — and the section
  predicting otherwise is why the denominator has to be reported beside every clean verdict rather
  than filed as a batch-3 refinement. See the status block.
- It also predicted a possible shared INPUT node and there was none — six declarations of `phones`
  across three names, all separate objects. **A field name is not a node.**

### ✅ `items[].description` WAS batch 5 — and dev turned out not to be a second sample

**Done and in prod** (`core` `27be0ad` → `beta.406`, `v0.249.0`, revision `api-cloudrun-00367-xm4`).
Re-derived 2026-09-10 off the post-batch-4 catalogue: **143 paths — 76 scalar, 67 `array[]`**;
batch 5 took 11 of them, leaving **132**, of which 46 were `items[]`.

### ✅ the `price` BLOCK WAS batch 6 — and the corpus discharged step 2 on its own

**Done** (`core` `9a48a5a` → `beta.407`, in prod as `v0.249.1`, revision `api-cloudrun-00368-bx8`,
digest-verified), 24 paths across three declarations, leaving **108**. Its two durable findings —
that a COMPLETE denominator lets the corpus discharge the writer audit outright, and that `present`
and `non-null` answer different claims — are both in `core/CLAUDE.md` § *`.default()` and
`.optional()`*, which is where they belong now.

### ✅ batches 7, 8 and 9 are done — what they leave behind

Batch 7 (`core` `37c4209` → `beta.408`) took 8 paths across four declarations, leaving 100. Batch 8
(`core` `5b31d93` → `beta.409`) took 10 across two, leaving 90. Batch 9 (`core` `22e695e` →
`beta.410`) took 15 across three, leaving **75**. All three write-ups are in the status block; what
follows is only what they leave behind.

**RE-DERIVED 2026-09-11 AFTER batch 9, by the recipe below — do not quote it, re-run it:**
**75 paths — 53 scalar, 22 `array[]`, 14 of them `items[]`.**

🔴 **`items[]` is `path` ×10 plus four credit-note-only keys, and NOTHING ELSE.** Unchanged by
batches 8 and 9, neither of which took an `items[]` path:

| what | paths | note |
|---|---:|---|
| `path` on every arm of all four grains | 10 | 🔴 the row identity, ONE author (`computeItemPaths`), and the array-ordering hazard below is about it |
| `credit-notes.items[].{tracking_category, uid_invoice_item, xero_id, xero_tracking_option_id}` | 4 | all `.default(null)`, all Xero-side, 146 rows |

⚠️ **The cheap `items[]` batches are EXHAUSTED** — batches 5, 6 and 7 took `description`, the `price`
block and `quantity`/`name`, every leaf that clustered across grains.

**The per-FAMILY split, re-derived 2026-09-11 after batch 9:**

| family | paths | note |
|---|---:|---|
| **`items[]` across orders / invoices / credit-notes / fulfillments** | **14** | 🔴 **now the largest family left** — `path` ×10 + 4 credit-note-only keys; the cheap leaves are gone |
| `templates` / `templates-versions` / `template-components` | 7 | `draft_uids`, `fixtures`, `params`, `consumed_components`, `active_semver`, `depends_on.components` |
| `stores` / `stores[].locations` / `store_breakdown` | 6 | `bookings`, `out-of-service`, `inventory-ledgers` — one shape, three collections |
| `sources` | 4 | `credit-notes`, `out-of-service`, `recurrences.prototype`, `transactions` |
| the `cards` family's REMAINDER | 3 | **all STRUCTURAL now** — see below; batch 9 took the two corpus-blocked ones |
| `reference` | 3 | `orders`, `credit-notes`, `fulfillments` — small, scalar, likely free |
| ~~`products` / `webshop-products`~~ | ~~15~~ → **2** | ✅ **batch 9 took 13**; the 2 left are `components[]`/`component_of[].price.taxes`, a shared stored/input node |

⚠️ **The per-COLLECTION split, re-derived 2026-09-11 after batch 9** (`credit-notes` 9 · `orders` 8 ·
`invoices` 8 · `transactions` 5 · `fulfillments` 5 · `templates` 4 · `out-of-service` 3 · `cards` 3 ·
`bookings` 3 · then a tail of 1-2 across ~20 more collections). The FAMILY table above groups these
across collections, which is the unit a batch is chosen in; the two do not add up on purpose.

### ✅ The `cards` remainder is now ONE reason, not two

✅ **`cards.action` and `cards.organization` were taken by batch 9** — the corpus reason expired when
the 7 dev rows were repaired. What remains on `cards` is **entirely structural**, which is what makes
it legible:

| path(s) | why it is left | what it would take |
|---|---|---|
| `cards.attachments[].locked`, `recurrences.prototype.attachments[].locked` | **STRUCTURE** — ONE node (`CardAttachment.locked`), shared with `CreateCardInput`, `UpdateCardInput` and both recurrence inputs | an API-input tightening with a client-first ordering |
| `cards.dates.start`, `cards.dates.end` | **STRUCTURE** — `CardDates`, shared the same way via `dates: CardDates.optional()` | same |

⚠️ **Do not take these as a "cards batch"** — they are an input change that happens to live in the
same file, and `CardAttachment` is embedded by `recurrences` too.

⭐ **They now share a class with `products.components[]`/`component_of[].price.taxes`** (`ComponentObject.price`,
shared with `CreateProductInput` + `UpdateProductInput`). That is **5 paths across 2 repos' worth of
clients** with one shape: a stored/input shared node needing a client-first ordering. If an
API-input tightening is ever wanted, they are one batch, not two — and `cfs-release-order`'s REFINE
case (manager ships BEFORE the API) is the ordering.

### ⭐ The new step every batch now owes: check `getInitialValues`

Batch 8 found that `manager/src/stores/cards.ts` and `manager/src/stores/recurrences.ts` seed drafts
from `getInitialValues(<StoredSchema>)`. **Before removing a `.default(V)`, ask whether `V` equals
the node's type-zero** — `resolveField` (`core/src/schemas/initial.ts`) returns `[]` for an array,
`""` for a string, `false` for a boolean, `null` for a nullable, the FIRST MEMBER for an enum.

- Equal → the removal is invisible to every form seed. All ten of batch 8's were.
- **Not equal → the form silently reseeds**, and the field needs `.meta({ initial: V })` in the same
  commit. The canonical case is `z.boolean().default(true)`, whose type-zero is `false`; the note in
  `initial.ts` records five product fields that would have shipped new products inactive.

🔴 **RE-CENSUSED 2026-09-11 AFTER batch 9 — it is now 2 of 75, and they are named.** Every other
path's default equals its node's type-zero, so 73 of 75 removals are invisible to `getInitialValues`
and need nothing:

| path | default | type-zero |
|---|---|---|
| `holiday-definitions.active` | `true` | `false` |
| `location-types.active` | `true` | `false` |
| ~~`products.price.discountable`~~ | ~~`true`~~ | ✅ **taken by batch 9, with `.meta({ initial: true })` in the same commit** |

⭐ **The prediction held exactly, which is the reason to keep making it.** This table named
`products.price.discountable` as the one live case before batch 9 existed; batch 9 removed its
default, the before/after `getInitialValues` dump stayed byte-identical *because* the annotation went
in the same commit, and removing the annotation moved the seed to `false` under mutation control.
**A census written one batch ahead paid for itself.**

⭐ **Cross-checked by a second, independent method**: `grep -rn 'default(true)' src/schemas/` now
finds exactly two live ones — `holiday-definition.ts:77` and `location-type.ts:51` — which is the
same set the registry walk produces. A source grep and a schema walk fail in different directions,
so agreeing is worth more than either alone.

⚠️ The census reaches most paths directly; the `items[]|N.path` ×10 are notation the walker spells
differently and were confirmed by reading the declarations — all `z.array(X).default([])`, type-zero
`[]`. **Reconciling them is the point**: a partial count with no account of the rest is not a clean
count.

⭐ **Measure it, do not reason it**: dump `getInitialValues` for the affected schemas to JSON before
the edit and diff after, and mutation-control the probe by re-adding a non-type-zero default. Which
manager stores are affected is a `grep -rn getInitialValues manager/src` away — ⚠️ **unbounded**;
batch 8's first attempt was `| head -20` and cut off both card stores, and a truncated grep reads
exactly like a complete answer.


⚠️ **`organizations.contacts[].roles` is a 1-path straggler worth taking with something else.**
`OrganizationContactType.roles` is REQUIRED on the interface while `OrganizationContact` defaults it
— the batch-2 blind shape — and `organizations` is otherwise now clear.

✅ **The parse probe is COMMITTED — `deno task audit:reparse` in `api-cloudrun`.** It was written
five times as a throwaway and is now `api-cloudrun/scripts/audit-schema-validation.ts`
(`5ed776fe`), with `api-cloudrun#951` and `api-cloudrun#636` closed on it. For batch 5 the two
flags that matter are `--core=../core/src/schemas/mod.ts` (parse against the UNPUBLISHED tightening)
and `--positions=… --reach`, whose discriminator filter addresses union arms:

```sh
cd api-cloudrun && deno task audit:reparse --core=../core/src/schemas/mod.ts \
  '--positions=orders.items[type!=destination|group].description,invoices.items[type!=destination|group].description' --reach
```

⚠️ **Read the denominator and the reach verdict, not the failure count.** `OPTIONAL-HERE` before the
tightening is the expected state and is the reading that says there is something to do; after it,
the same position must read `REACHED` or the tightening is not gated by anything.

✅ **The BEFORE/AFTER pair, all eleven positions, both projects.** Before: every position
`OPTIONAL-HERE`. After, parsed against the working tree with
`--core=../core/src/schemas/mod.ts`: every position `REACHED`, 0 failures, exit 0.

| arm | declaration | prod rows |
|---|---|---:|
| `orders.items[type!=destination\|group]` | `LineItemCore` | 10,065 |
| `orders.items[type=destination]` | `DestinationDividerArm` | 1,021 |
| `orders.items[type=group]` | `GroupDividerArm` | 2,898 |
| `invoices.items[type!=destination\|group\|order]` | `LineItemCore` | 9,590 |
| `invoices.items[type=group]` | `GroupDividerArm` | 3,135 |
| `invoices.items[type=destination]` | `DestinationDividerArm` | 1,009 |
| `invoices.items[type=order]` | `InvoiceDocOrderItem` | 1,009 |
| `fulfillments.items[type!=destination\|group]` | `LineItemCore` | 9,986 |
| `fulfillments.items[type=destination]` | `DestinationDividerArm` | 1,021 |
| `fulfillments.items[type=group]` | `GroupDividerArm` | 2,898 |
| `credit-notes.items[]` | `CreditNoteDocLineItem` | 146 |

**42,778 item rows, every one stating a non-null `description`, 0 parse failures.**

🔴 **`OPTIONAL-HERE` is the BEFORE half and it only exists because it was taken first.** A post-hoc
`REACHED` proves only that the probe found *an* issue.

🔴 **CORRECTION — dev is NOT a second sample on these four grains, and this doc said it was.** The
line here read *"a genuine second sample on `orders` (1,023 vs prod's 1,021) and on `invoices`
(1,064 vs 1,040)"*. Measured 2026-09-10: both projects are **1,021 / 1,040 / 1,021 / 13 to the
document**, and the reparse returned byte-identical denominators and the *same witness document ids*
in both. Confirmed independently by the dev and prod MCP `db_*_count` endpoints, so the instrument
was not lying — the doc was. ⭐ **The check this doc already prescribes is the one that caught it**:
compare the two counts before crediting either. It is worth knowing that this campaign's own record
failed its own rule.

🔴 **CORRECTION — the earlier invoice baseline conflated two declarations.** It filtered
`items[type!=destination|group]`, which leaves the **order divider** inside the line-item
denominator: 10,599 = 9,590 line rows + 1,009 order dividers. Those are separate declarations
(`LineItemCore` vs `InvoiceDocOrderItem`), so one of the five had never been measured on its own.
⭐ **A discriminator filter that names what to EXCLUDE silently absorbs any arm you forgot exists.**

⭐ **The batch boundary was ONE LEAF across four grains** — batch 2's family selector one level down.
`description` clusters ×12 in the backlog where no grain's whole item does, so the writer audit
stayed a single author. The prediction in the previous revision of this section held exactly.

⭐ **It was a PURE STORAGE tightening — no API-input change**, like batch 4's `phones` and unlike
`Address`. Every consumer of `LineItemCore` and the two divider arms is a stored schema; the input
schemas each declare their own `description ... .optional()` instance. Only grepping the NODE says
so.

⚠️ **The suite was the oracle and it bit: 8 failures in `tests/order.test.ts`**, two of them negative
tests asserting an exact issue-path set — the *"requiring a field rewrites every negative test that
spelled its fields inline"* hazard, firing exactly as core/CLAUDE.md predicts. Repaired by completing
the `docLine` factory and routing the two raw literals through it, so each case again drops exactly
one field.

⚠️ **Still to measure for the REST of the family:** the other clustered leaves — `path` ×10,
`taxes` ×9, `quantity` ×4. **One leaf measured is not the family**, and `path` is the one to treat
with most care: it is the row identity, and the `items[]` backfill/ordering hazard below is about it.


- **The 67 `array[]` paths need a different instrument** — a paged census in the shape of
  `audit-zero-priced-components.ts`, which already pages `items[]` on three grains. The stored
  invoice item `path` (`schemas/invoice.ts:487`, `z.array(ItemUid).default([])`) is in this family.

  🔴 **And an `items[]` batch has a second hazard the scalar batches do not: a backfill can make
  the array UNWRITABLE.** `validatePathsAgainst` (`utils/orders.ts`) compares
  `items[i].uid !== recomputed[i].uid` **position by position**, so the write boundary validates the
  LINEARIZATION and not merely the paths — while `resolveBlock` sorts `zero_priced === true` ahead
  of its priced siblings within each parent's direct children. So stamping a sort-participating flag
  onto a stored items array changes the recomputed order, and the stored array then fails its own
  boundary check. **Measured by the zero_priced stage-two backfill (cfs-f0, 2026-09-10): three prod
  invoices reordered and had to be written in canonical order.**
  ⚠️ **Reach, AS OF BATCH 5: 46 of the then-132 remaining paths were `items[]`** — batch 5 took 11 of
  the 57, and batches 3 and 4 took none. **After batch 9 it is 14 of 75**, all of them `path` ×10
  plus the four credit-note Xero keys; batches 6 and 7 took the rest of the cheap leaves and batches
  8 and 9 took none. `zero_priced` is the only sort key today and is NOT itself in the
  backlog, so the hazard is not that this campaign stamps it; it is that any items-array backfill
  must WRITE IN CANONICAL ORDER rather than patching a key in place, and must expect arrays a
  previous backfill has already reordered.
  ⭐ The transferable question: **before backfilling a key into an array, ask whether the key
  participates in the array's own ordering** — and if the boundary re-derives that ordering, a
  correct value written in the stored order is still a refused write.

  🔴 **A committed templates fixture is a PREREQUISITE for an `items[]` tightening, not a tail** —
  `lintFixture` parses every fixture against the real `InvoiceSchema`/`OrderSchema`, so a fixture
  missing a newly-required items key fails the templates gate before anything reaches prod.
  ⚠️ **And the exposure is per-GRAIN, wildly so.** Measured here 2026-09-10 over the committed
  fixtures: the **quote** family (orders-sourced) is **0 of 134 line rows** unstated for
  `zero_priced`, while the **invoice** family is **20 of 20** across 8 files. Not a skew — total, in
  both directions, because quote fixtures are captured from orders that always carried the flag.
  ⭐ **So a fixture captured from a real document is only as complete as the document it captured.**
  It inherits the CORPUS's holes, not the schema's requirements. ⚠️ That corrects the reason given in
  the `beta.400` templates pin (`templates` #302), which said no fixture needed repair *"because they
  were produced by `templates_capture_fixture` from real documents rather than hand-written"*. The
  conclusion was right and the mechanism claim was too broad: those same captured invoice fixtures
  are missing `zero_priced` on every line row. Capture-completeness is a fact about the source
  documents, per field and per grain — measure it, do not infer it from provenance.
  ✅ **Measured for THIS backlog: 0 exposure today.** Every one of the 57 `items[]` backlog keys is
  stated on every row of both families (224 item rows). `zero_priced` is not in the backlog, so its
  20 unstated rows belong to manager#421's campaign, not this one — but the measurement is the
  prerequisite an `items[]` batch must re-run, since it is a fact about fixtures that change.
  ✅ **RE-RUN AND STILL 0, against the post-recapture corpus.** manager#421's re-capture landed as
  `templates` #304 (`6675703`) and moved the invoice family from 20-of-20 `zero_priced`-unstated to
  **0 of 20**, exactly as predicted. Re-measured here after it merged: **0 of the 57 `items[]`
  backlog keys unstated**, across 224 item rows in both families. The expiry recorded above is
  discharged; the next one arrives with the next fixture change.
  ✅ **Re-run again for BATCH 5 specifically, 2026-09-10: 224 item rows across the committed
  `invoice` + `quote` families, 0 missing `description`.** ⚠️ **And the probe needed controlling
  twice.** The first form queried `.doc.items` and returned zero rows — a fixture file *is* the
  document, `items` is top-level — which reads identically to a clean sweep. The second form found
  28 rows apparently missing the key, all in the **`receipt`** family, whose `collection_source` is
  `movement-sessions` — a schema carrying no `description` at all. ⭐ **Both halves are the
  `aging-report` classifier error recurring**: read the sidecar's declared collection before counting
  what a gate will refuse, and control a zero against a key that IS sometimes absent (`zero_priced`,
  98 rows) before believing it.
  ⚠️ Three populations, three different questions, and they are easy to conflate: the template
  predicate switch exposes **2** fixtures, the refine refuses **5**, full corpus fidelity is all
  **8** — and *line rows* (20) is a different count again from *component rows* (8). Name which one
  a number answers.

  ⚠️ **Expect an INVERTED test per grain when an `items[]` batch lands.** A guard written while a
  field was legitimately absent asserts that absence: `buildFulfillment line items expose only
  fulfillment-safe fields` listed `zero_priced` among the order-only keys that must NOT leak, and
  core carried *"the PROJECTION does not emit `zero_priced` yet"* — the stage-one spec. Both had to
  be rewritten against the source line rather than deleted, so they read as mirrors. A green test
  can be the workaround's spec (cfs-f0, 2026-09-10).

## What is LEFT — read this first

**Batches 9, 10 and 11, and batch 9's two follow-ups, have NO residue** — published, swept, merged,
deployed, digest-verified, and the prod data the beta.412 follow-up exposed is repaired and
independently re-censused (`api-cloudrun#966`, closed). What follows is everything else this
campaign knows about, in order of who is blocked:

| # | what | owner | blocked on |
|---|---|---|---|
| 1 | **`api-cloudrun#955`'s prod row** — the last thing between `audit:reparse` and being a scheduled job | the owner | a call between four options, all measured |
| 2 | **Batch 12** — 62 paths, 22 of them `array[]` (14 `items[]`). The cheap tidy-up is gone; see below | next session | nothing |
| 3 | `api-cloudrun#943`'s remaining half — manager `collection_end`/`delivery_end` editors | — | nothing; pre-existing |
| 4 | `core#106` — nothing runs the citation audit at CI scope, so a publish can silently skip. ⚠️ **Batch 11 is a live counter-example this issue should cite**: a stale bare-basename citation from batch 10's own status-update commit blocked `beta.415`'s first publish attempt, and only CI's core-alone run caught it — two prior full-workspace `audit:citations` runs had read it clean | — | nothing |
| 5 | **Historic orders/invoices priced from the 3 untaxed rentals** — lines carry a tax SNAPSHOT, so the catalog repair does NOT reach them. Unmeasured on purpose | the owner | a money call; wants its own issue with `risk:money-path` |

⚠️ **The deploy verification is a four-link chain and the batch-6 near-miss still applies.** A
revision NUMBER moving is good evidence the build arrived and **no evidence at all that the image
carries the beta**. Read the digest: `gcloud builds describe --region=us-central1` for what the tag
built (⚠️ **regional — a bare `gcloud builds list --project=` returns "Listed 0 items" and reads
exactly like "no build was triggered"**), `gcloud run revisions describe` for what the live revision
serves, diff the deployed tree's `deno.json` against the checkout you probe from, and only then run
`deno task audit:reparse` with **no `--core` flag**. Published → pinned → deployed → enforcing are
four different claims. Batches 7, 8 and 9 and both `beta.411`/`beta.412` follow-ups each ran all
four and they all held.

**(1) is NOT "delete a row", and that is the finding.** `transactions` is an append-only journal:
there is no `DELETE` route, `updateTransaction` edits `reference` alone, and this row cannot take
even that — it writes through `ValidatedTx.set`, which validates first. So a **reversal** mints a new
movement and leaves the bad row in place (the reparse still exits non-zero), **stamping a supplier**
makes the parse pass while leaving $2.00 of cost basis Xero does not have, and a **hard delete**
needs a one-shot prod script plus manual `quantity_held` surgery, because `LEDGER_REBUILD_FIELDS`
deliberately makes a replayed quantity unreachable from the write path. The fourth option — a
documented schema carve-out naming the one uid — costs a comment and a test. ⭐ The row itself is
adjudicated: it is a **duplicate of #1162**, which carries Home Depot and posted as `CFS-MOV-1162`;
there is no `CFS-MOV-1161` anywhere in the ACCPAY window. Full evidence on the issue.

### ✅ the `sources`/`reference` tidy-up WAS batch 10 — and it really was free

**Done** (`core` `720a8f6` → `beta.414`, in prod as `v0.251.0`, revision `api-cloudrun-00375-cxd`,
digest-verified), 6 paths across 5 declarations, leaving **69**. `recurrences.prototype.sources`,
which the table below had counted as a 7th, was not in the backlog when re-derived — the campaign's
own rule held: re-run the recipe, never subtract from a remembered number.

No new instrument, no backfill, no client ordering, exactly as predicted. The one real cost was one
level down from the plan: the STORED-INTERFACE-vs-SCHEMA mismatch batch 9 found on `products` also
existed on `Order.reference`, and fixing the interface immediately reddened `updateOrder`'s own
`"reference" in update` assignment with the exact `TS2322` its own comment had predicted for
`subject` — caught by `deno task check`, not by a census, and fixed the same way `uid_store` beside
it already is (`?? null`). ⭐ **Reading the templates sidecar's `collection_source` FIRST (rather
than sweeping all seven families) meant checking exactly one fixture family** — `quote` was the only
one touching any of these six fields, and all 15 committed fixtures already stated `reference`.

### ✅ the templates family WAS batch 11 — the writer audit carried it, not the census

**Done** (`core` `dc900c2` → `beta.414`, republished as `beta.415` after a citation fix, in prod as
`v0.251.1`, revision `api-cloudrun-00376-sl6`, digest-verified), 7 paths across 3 declarations,
leaving **62**. The predicted cost — "the widest spread of small declarations; needs a
per-declaration writer read" — was real but cheap: an agent-run writer audit across
`registerTemplateFamily`, `publishFromMerge` and the draft flow found **15 of 16** (field ×
create-site) combinations already stated the field explicitly; the sixteenth
(`active_semver` at `registerTemplateFamily`) writes via a raw `tx.set()` that bypasses schema
validation entirely, so no default was ever consulted there either. No backfill, no fixture repair
(`templates`/`templates-versions`/`template-components` are never rendered — no committed fixture
touches them).

🔴 **One field's own interface was already optional, and the obvious fix was wrong.** `active_semver`
was `?: string | null` — the ONE exception among the seven — and reaching for
`.nullable().optional()` (present, null, or absent) is exactly what core#83's sibling ratchet
(`tests/stored-optionality.test.ts`) exists to catch. Made required-and-nullable instead, matching
its sibling `uid_active`, and had the one writer that could legitimately omit it state
`active_semver: null` explicitly. **Two campaigns' guards intersecting on one field is a preview of
what batch 12+ will hit more often as the backlog thins** — check both ratchets, not just this one's.

⭐ **Making a previously-optional interface field required re-runs batch 10's lesson at a WIDER
radius.** `deno check` against a `file://`-pinned local core found **9** hand-spelled/seed `Template`
literals across `api-cloudrun` (`api-cloudrun/tests/helpers/seedTemplate.ts`, `api-cloudrun/scripts/seed-quote-template.ts`, 7 integration test
files) that had never stated `active_semver` — invisible until the interface changed, because a
`z.ZodType<T>` check runs one direction only. Every `...fam`-spread update-path literal was already
safe by construction (the `updateOrder` pattern generalises past order objects).

**(2) batch 12 — read the split off `core/tests/stored-defaults.test.ts`, not this doc.**

🔴 **The cheap era is over, and saying so is the most useful thing this section can do.** Batches
1–11 each had an obvious candidate: a shared block, a leaf clustering across grains, a family with a
complete corpus and a typed writer, or — batches 10 and 11 — a scalar tidy-up nobody had swept.
**None of the 62 remaining paths is that any more.** The two plausible batches each carry a cost the
previous eleven did not:

| candidate | paths | the cost |
|---|---:|---|
| `stores` / `stores[].locations` / `store_breakdown` | 7 | one shape across `bookings`, `out-of-service` and `inventory-ledgers`; `bookings.query_by_uid_store` has **4,205 measured absences** and its SOURCE `bookings.stores` is absent on the same 4,205 — one repair, not two, and it is a real backfill |
| `items[].path` ×10 | 10 | 🔴 **take deliberately or last.** `path` is the row identity with ONE author (`computeItemPaths`), and the array-ordering hazard above is entirely about it |

⭐ **The remaining tail (organizations.contacts[].roles, the `cards`/`products` shared-node
remainders, orders.invoices+query_by_invoices, credit-notes.remaining_credit_cents+
xero_credit_note_id, invoices' three Xero/Uploadcare scalars, comments.reactions,
contacts.organizations+query_by_organizations, invites.roles+used, lists.description+locked,
location-types/locations.product_capacities+products, roles.permissions, stock.unavailable,
stores.default_location, taxes.crms_id, threads.last_message_preview, transactions' three cost/
serialized-detail leaves) is small singles and pairs — batch 10 was the last FREE cluster; the next
tidy-up batch, if one is taken, has to be assembled from this tail deliberately rather than found.**

⚠️ **Whatever is chosen, three things are NOT re-derivable from this doc and must be re-run:**

1. **The backlog itself** — the recipe above, off `tests/stored-defaults.test.ts`.
2. **The `getInitialValues` census** — still **2 of 62** (`holiday-definitions.active`,
   `location-types.active`), both `.default(true)` over a `false` type-zero, unaffected by batches
   10 or 11. Neither is in either candidate above, so batch 12 probably needs no
   `.meta({ initial })` — but check, do not assume.
3. **Whether each node is SHARED with an input schema.** Batch 9's two exclusions and the whole
   `cards` remainder are this class; batches 10 and 11 had none. A path-level view cannot see it —
   **grep the node.**

🔴 **And carry batch 9's two findings into the writer audit, because they change what a clean census
means.** (a) A 100%-present column can be produced by the INPUT schema's `.default()` rather than by
any writer, because the route validator returns `result.data` — so ask which seam the completeness
comes from. (b) A fixture built from `getInitialValues` cannot fail a required-key tightening, so a
green core suite over such a fixture is not evidence; assert each path directly.

## Context recommendation

**Clear before batch 12.**

Batches 9, 10 and 11 and batch 9's two follow-ups are closed — nothing mechanical is left to watch,
and the prod repair is applied and verified. **Batch 12 depends on none of this session's
analysis.** Everything it requires is written down: the backlog is read off
`core/tests/stored-defaults.test.ts` (**62** paths — 40 scalar, 22 `array[]`, 14 of them `items[]`),
the partition is re-derived by the recipe above, the `items[]` hazards are in the section above, and
the policy — the parse-not-census rule, the shared stored/input-node rule, the denominator rule
batches 4 and 6 sharpened between them, batch 7's *require the KEY, claim nothing about the VALUE*,
batch 8's *a VACUOUS declaration is gated by the TYPE and the SUITE*, batch 9's *two parse seams*,
*a `getInitialValues` fixture is blind*, *"a branch READS this default" and "a branch is HARMED by
it" produce the same grep*, and *a whole-object replacement INVERTS what a default means*, batch
10's *check the local corpus TYPE surface too — an interface/schema mismatch on a stored field
reddens its writer the moment the interface is fixed, and the compiler finds it before any census
does*, and batch 11's *`.nullable().optional()` on a stored field is core#83's defect, not this
campaign's fix — check that ratchet too when a field's own interface is already optional* — is in
`core/CLAUDE.md` § *`.default()` and `.optional()`*.

⭐ **The batch-9 session's own shape is worth carrying: it shipped, then its FINDING shipped
(`beta.411`), then a CORRECTION to that shipment shipped (`beta.412`), then the prod data the
correction exposed was repaired.** Three deploys and a data fix off one batch. Each step was
cheap only because the one before it was closed and verified first — and the correction was found
by a peer's question, not by a gate, which is the argument for writing findings down where someone
can disagree with them. Batch 10 was a smaller instance of the same shape: the tidy-up shipped, and
finding the reddened writer was cheap only because `deno task check` ran before the push rather than
after.

⚠️ **Do not carry this doc's numbers into batch 12 — re-run the recipe.** Batch 3 proved the doc's
own table can be wrong in both directions with the errors in the INSTRUMENTS; batch 4 proved the
numbers can be right and still mean something different from what they look like; batch 6 proved a
column labelled VACUOUS can be decisive for the claim actually being made; batch 7 proved a
documented guard class can be three files rather than two the first time anyone counts it; batch 8
proved the doc's own *"dev is not a second sample"* habit had become an assumption — `cards` is
1,159 / 1,166 and the 7-document difference decided which paths the batch could take; batch 9
proved a 100%-present column can be produced by a schema this campaign never looks at, because the
route validator returns `result.data` where `validateBeforeWrite` discards it; batch 10 proved the
doc's own "7 paths" count for `sources`+`reference` had already drifted by one (`recurrences.
prototype.sources` was gone from the backlog before the batch started) and that the `stores`
family's count moves too (6 → 7, re-derived); **batch 11 proved a citation drift outside the
schema entirely (a status-update commit's own bare-basename citation) can block a publish that has
nothing to do with the citation's subject** — the schema change was clean, the corpus was clean, and
the release still failed on a sentence written two commits earlier. Re-derive, and ask what the
instrument can see — including the instruments that have nothing to do with the batch's own diff.

⭐ **Batch 11's transferable habits**, all cheap:
- **A writer audit beats a census when the denominator is thin.** 7-9 documents per collection is
  too small for a census to mean much either way; the writer audit (every real create site, read
  directly) was the actual gate, and an agent-run pass covered it in one turn.
- 🔴 **When a field's OWN interface is already optional, ask which of `.nullable()` or
  `.nullable().optional()` is right BEFORE editing the schema — they are different campaigns'
  answers to the same-looking question**, and getting it backwards is caught by a sibling ratchet,
  not by this one's own suite. Grep for a `NULLABLE_OPTIONAL`/`stored-optionality`-shaped test
  before assuming this campaign's rule is the only one that applies to a stored field.
- **Making one interface field non-optional can surface a compiler-invisible backlog of hand-spelled
  literals far wider than the fields actually touched** — batch 10 found one (`updateOrder`'s
  `?? null`); batch 11 found nine, because `active_semver` had been silently optional on every
  `Template` literal in the repo, not just the one writer that mattered. Grep broadly
  (`: Template = {`, not just `src/` or `tests/` alone — `scripts/` had one too) once an interface
  member's optionality changes.
- **Repo-qualify a citation the moment you write it, in the SAME commit — don't rely on a later
  audit run to catch a bare basename**, because a full-workspace run can resolve it against a
  sibling repo's copy while CI's core-alone run cannot. This is the concrete case `core#106` names.

⭐ **Batch 9's transferable habits**, all cheap:
- **Run the consumer suite BEFORE the publish** (batches 7 and 8's habit, repeated and again worth
  it) — and then run it AGAIN after, against the real pin. The three `file://` guard-class failures
  going green on the real version is what CONFIRMS the diagnosis rather than merely asserting it.
- **Check `getInitialValues` per batch**, with an UNBOUNDED grep, and mutation-control the probe.
- 🔴 **Ask where a fixture came from before crediting its green.** One built from
  `getInitialValues` cannot fail a required-key tightening; a hand-spelled one can. Two of core's
  three affected fixtures were the first kind, and the batch would have looked fully gated.
- 🔴 **Ask which parse seam a key's completeness comes from.** `validateBeforeWrite` discards
  `result.data`; the route validator returns it. A stored key can be 100% present because of an
  INPUT default rather than because any writer named it.
  ⚠️ **This line first said such a default "must not be swept later". That is NOT the rule** — the
  `beta.411`/`beta.412` follow-ups swept four of them deliberately. The rule is that the key needs
  ONE VISIBLE AUTHOR: move it to the writer, in a commit that states the key BEFORE the default
  comes off. Pinning the default with a test is policing a coupling, which is the weaker option and
  was this session's first instinct.
- 🔴 **"A live branch READS this default" and "a live branch is HARMED by it" produce the same
  grep.** The question that separates them is whether the branch could ever observe the key ABSENT.
  If not, the default is what made the test unfalsifiable — it is the defect, not the dependant.
  ⭐ And **a whole-object replacement INVERTS what a default means**: on a patch it fills a gap, on
  a replacement it deletes whatever the client did not restate. `price.taxes` was both at once, and
  reading it as a dependant cost a beta.
- ⭐ **Derive a repair's value from the CATALOG, never from a sibling row.** `Chicago Rental Tax`
  has three versions and only one is current, so a sibling copy is one stale window from writing a
  wrong rate. And give every target its OWN witness — a COPY of that document (a same-day
  replacement twin, its webshop mirror), never a neighbour.
- **Release `manager` BEFORE merging api-cloudrun's release PR**, so `requires-manager`'s measured
  arm is green on its first run rather than red-then-fixed. Held again for batch 10
  (`manager-v26.2.0` before PR #967).

⭐ **Batch 10's transferable habits**, all cheap:
- **A `.default()` retired on a stored field is not merely inert on the WRITE path — check whether
  fixing its interface reddens a WRITER'S assignment.** `Order.reference`'s `?` came off, and
  `updateOrder`'s own `"reference" in update` line — narrowing the object, not the already-optional
  input property — immediately failed to typecheck against the new required field. The comment
  beside it had predicted exactly this failure mode for `subject` two batches earlier; predicting a
  class of bug in prose does not retire the class, and `deno task check` found the instance the
  comment did not prevent.
- **Read the templates sidecar's `collection_source` before sweeping fixtures**, not after. Batch 10
  checked which of the seven template families resolved to any of the six touched collections
  (exactly one, `quote` → `orders`) before looking at a single fixture file, instead of grepping all
  38 fixtures for the field names and re-deriving the classifier error batches 1 and 5 both hit.
- **When `docker`/`crane`/`skopeo` are unavailable, the Docker Registry HTTP API is a straight
  substitute for the deploy-verification digest chain** — `gcloud auth print-access-token` as the
  Basic-auth password, `GET /v2/<repo>/manifests/<digest>` for the layer list, then download the
  smallest layers first: a COPY-only Dockerfile step produces a layer of a few hundred bytes to a
  few KB, which is exactly the one holding `deno.json`/`deno.lock` and far cheaper to fetch than the
  multi-hundred-MB base or `node_modules` layers.
- ⚠️ **A family's re-derived path count can DROP even though nothing was taken from it** —
  `recurrences.prototype.sources` had left the backlog before batch 10 touched anything, so the
  doc's own "sources (4) + reference (3) = 7" table was already one path stale the moment it was
  read. The recipe is the source of truth; a table is a cached read of it.

**Three things this session left deliberately:**
- The two documents `api-cloudrun#951` names are **still unrepaired** — a prod `transactions`
  purchase with `supplier: null` (an accounting fact, not a default: find its Xero bill or ask the
  owner) and a dev `locations` id. A third turned up, dev-only: `users/test-user`. Until they are
  gone the parse cannot be scheduled, because a nightly alert on known-dirty rows is one nobody
  reads. ✅ The 7 dev cards that were a fourth item on that list were repaired on 2026-09-11 and
  batch 9 took the two paths they blocked, so that item is closed.
- `updateOrganization` still carries `organization.emails = organization.emails || []` and the same
  for `phones` (`api-cloudrun/src/services/organizations.ts`) — inert since batch 4, because both
  fields are required and both corpora are complete.
- `PickSheetDestinationSchema.name` (`core/src/schemas/pick-sheet.ts`) still carries `.default("")`
  and is `DestinationDividerArm.name` copied byte-for-byte. **Out of scope on purpose**: `pick-sheets`
  is a computed view, not a Firestore collection, so the ratchet cannot see it and `audit:reparse`
  has no corpus to gate it. This campaign is about STORED schemas.

**A fix expires its workarounds; expiring them is its own commit** — which is why the `|| []` pair is
listed rather than folded in. Removing it is behaviour-bearing, and hiding it inside a pin-carrying
release is how a behaviour change ships unreviewed. ⭐ **Batch 6 met the same rule in its milder
form**: two comments in `api-cloudrun` asserted, in the present tense, a fact the tightening made
false, while the code they defended stayed correct. **A tightening can expire a comment's REASON
without expiring the code** — say which one moved, and re-state rather than delete.