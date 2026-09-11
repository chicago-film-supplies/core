# Retiring inert `.default()` on stored schemas

*Promoted from the session of 2026-09-09. Owning repo is `core` — the schema policy is the work.
`api-cloudrun` owns the repair scripts and the census this doc names; `manager` is named only by
api-cloudrun#943's remaining half.*

> ## ⚠️ STATUS 2026-09-11 — **batch 4 is LANDED, published and IN PROD. Backlog 153 → 143.**
> Four batches done. Batches 1–3 are history and their details live below; this is the one current
> statement the convention asks for, compacted rather than stacked.
>
> | batch | what | backlog | state |
> |---|---|---:|---|
> | 1 | 20 `totals` defaults | 259 → 239 | ✅ prod, `v0.247.0` |
> | 2 | 20 `query_by_*` + 8 `bookings_breakdown` | 239 → 211 | ✅ prod, `v0.248.0` |
> | — | **the ratchet hole**: +47 paths nothing had ever enumerated | 211 → 258 | ✅ `core` `4f73bca` |
> | 3 | the seven `Address` keys — 105 paths, 15 positions | 258 → 153 | ✅ `core` `ce8272d` → `beta.404` |
> | 4 | **`phones` ×9 + `organizations.emails` — 10 paths, 3 declarations** | 153 → **143** | ✅ **prod, `v0.248.1`, revision `api-cloudrun-00366-whd`** |
>
> ✅ **The batch-3 open item is CLOSED as a side effect.** Prod was stuck on `beta.403` because batch
> 3's consumer commits were `chore(deps)`/`test(fixtures)` — non-releasable — so Release Please cut
> nothing. Batch 4's api-cloudrun commit is a genuine `fix(orders)`, which cut **`v0.248.1`** and
> carried `beta.405` (and with it batch 3's `Address` tightening) to prod. Verified by image digest,
> not by the tag: revision `api-cloudrun-00366-whd` serves
> `sha256:5a1eaf3f…a763f10`, byte-identical to what build `fac78f9f` produced. Dev runs `1080ca2`.
>
> ⭐ **That is the standing "decide the commit TYPE deliberately" warning paying off, and it
> generalises: the pin rides whatever the commit says it is.** A campaign whose consumer work is
> genuinely only a pin bump has no vehicle and will sit in dev indefinitely; one that carries real
> behaviour types as `fix`/`feat` and ships itself.
>
> 🔴 **Batch 4's finding: the corpus said almost NOTHING, and the parse still read 0 failures.**
> 4,560 prod / 4,571 dev documents parsed, 0 failures — but the per-position denominator is what the
> batch actually rests on. `organizations.emails`/`phones` carry **319 prod / 323 dev non-null objects
> with 0 absences**; the eight destination-contact positions hold **18 prod / 22 dev non-null contact
> objects between them**, and `invoices.destinations[].delivery.contact` holds **none in either
> project**. A clean parse over a population that thin is a fact about the WRITER, which is
> `core/CLAUDE.md` § *Making a field REQUIRED* step 2 in its literal form. ⭐ **So report the
> denominator beside every clean verdict** — batch 3 added the per-position count because a position
> of all-nulls passes while saying nothing; batch 4 is the case where it changed which evidence was
> load-bearing.
>
> 🔴 **And the writer gap was a 500, measured rather than argued.** The input
> `DestinationContact.phones` is `.optional()` and `buildDestinationPair` spread it verbatim, so once
> the document schema required it the same accepted payload failed `validateBeforeWrite` from inside
> the create transaction — `500 INTERNAL_ERROR`, not a `400`. Proved by stashing the fix: exactly one
> step of `orders.test.ts` fails and the other 50 pass. `withStatedContactPhones` supplies `?? []` at
> the one root author, which is step 3's split — tighten the INPUT only where the writer CANNOT supply
> the value. ⚠️ **`?? []` in a forward writer is not the backfill the campaign forbids**; that rule is
> about existing documents, whose omission is a biased sample.
>
> ⭐ **A node can be unshared and still look shared.** Batch 3's rule is *grep the NODE, not the path*.
> Here `phones` appears on six declarations under three names — `DocDestinationContact` (stored),
> `DestinationContact`, `NewContactInput`, `Create`/`UpdateOrganizationInput` (inputs) and
> `ContactSchema` (already required) — all separate objects. So unlike `Address` this was a **pure
> storage tightening with no API-input change**, and only reading the declarations says so.
>
> ⭐ **Step 4 was NOT a no-op this time, and that is the durable half.**
> `DocDestinationContactType.phones` was `?: string[]` while the schema defaulted it — the exact
> `z.ZodType<T>` blind spot — so unlike batch 2 typed literals were *not* already compiler-gated.
> Dropping the `?` makes every future hand-built one a compile error. It broke nothing: `deno check`
> green across core, api-cloudrun (2,024 unit tests) and manager (`tsc` + 1,977 tests).
>
> ⭐ **Zero fixture repairs — a first for this campaign, and each exoneration had a different
> reason.** A shape-keyed sweep of all four repos found 21 literals bound to a `contact` key carrying
> `uid` + `first_name`; the 7 without `phones` were all correctly so: two typed `DestinationType`
> (the INPUT pair, which keeps `.optional()`), two per-rule field projections in
> `audit-denorm-freshness.ts` whose sibling `phones-to-orders` row carries `phones` and no name parts
> at all, two untyped manager display fixtures, and one parameter type for `OrganizationContact`,
> which has no `phones` field. **Omission identifies the schema**, again.
>
> ⚠️ **A gate can pass without asking.** `templates` `lint:fixtures` went clean — and its denominator
> for `organizations` is **zero**, because no fixture holds an organization document. It said nothing
> about half the batch. Read a green gate's population before crediting it.
>
> ⚠️ **The type-escape ratchet refused BOTH halves of the first attempt, and it was right twice** —
> `dest as unknown as {…}` in the writer and the same form in the test. Neither was budgeted: the
> writer now declares `delivery`/`collection` on its generic constraint and the test builds a fresh
> payload literal. ⭐ **Both anti-vacuity runs were redone against the rewritten test** — a fix
> verified before a tidy-up is not a fix verified.
>
> ⭐ **`organizations.emails` was folded in on ADJACENCY** — the line above `phones` in the same
> `z.strictObject`, same `z.array(X).default([])` shape, already required on the interface, and the
> parse had to cover `organizations` either way. Batch 2's selector was *"what does the codebase treat
> as one family"*; adjacency in a declaration is a cheaper form of the same question.

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

- **The wider campaign — 143 inert paths remain**, and the arithmetic is NOT a subtraction:
  259 − 20 − 28 + **47** (the paths the ratchet had never enumerated) − 105 (batch 3) − 10 (batch 4)
  = 143. Concentrated in `invoices` (23), `orders` (21), `credit-notes` (19), `fulfillments` (10),
  `cards` (10) — 76 scalar and 67 `array[]` (re-derived 2026-09-11). Read the live split off
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

### 🔴 Batch 5 — `items[]` is what is left, and it is 57 of the 143

Re-derived 2026-09-11 off the post-batch-4 catalogue: **143 paths — 76 scalar, 67 `array[]`.**

| family | paths | note |
|---|---:|---|
| **`items[]` across orders / invoices / credit-notes / fulfillments** | **57** | the dominant family, and every remaining hazard note below is about it |
| `products` / `webshop-products` (`webshop.*`, `component_of[]`) | 15 | two collections, one shared `component_of` block |
| `cards` (+ `recurrences.prototype.*`, which mirrors it) | 16 | `attachments`, `locked`, `body_text`, `dates.*`, `uid_assignees`, `sources` |
| `stores` / `stores[].locations` / `store_breakdown` | 6 | `bookings`, `out-of-service`, `inventory-ledgers` — one shape, three collections |
| `sources` | 4 | `credit-notes`, `out-of-service`, `recurrences.prototype`, `transactions` |
| `reference` | 3 | `orders`, `credit-notes`, `fulfillments` — small, scalar, likely free |

⭐ **Inside `items[]` the leaf names cluster harder than the collections do** — `description` ×12,
`path` ×10, `taxes` ×9, `quantity` ×4 — so the batch boundary is probably ONE leaf across four
grains rather than one grain's whole item. That is batch 2's family selector applied one level down,
and it keeps the writer audit to a single author per batch.

⚠️ **`organizations.contacts[].roles` is a 1-path straggler worth taking with something else.**
`OrganizationContactType.roles` is REQUIRED on the interface while `OrganizationContact` defaults it
— the batch-2 blind shape — and `organizations` is otherwise now clear.

⚠️ **Batch 4's parse probe is the instrument to lift, and it is DELETED again.** It has now been
written five times. It handles `array[]` positions natively, reports a per-position denominator, and
REACH-verifies each one by deleting a key from a real document. **api-cloudrun#951 is the issue that
asks for it to become a committed guard** — do that before batch 5 rather than writing it a sixth
time.


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
  ⚠️ **Reach: 57 of the 143 remaining paths are `items[]` paths** — unchanged by batches 3 and 4,
  which took nothing out of this family. `zero_priced` is the only sort key today and is NOT itself in the
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

## Context recommendation

**Clear before batch 5.** Batch 4 is fully landed: `core` published `beta.405`, all three consumer
pins are in, `templates` #308 is merged, and — unlike batch 3 — it **reached prod**, verified by
image digest rather than by a tag. There is nothing mechanical left to watch.

Batch 5 depends on none of this session's analysis. Everything it needs is written down: the backlog
is read off `core/tests/stored-defaults.test.ts` (143 paths), the partition is re-derived by the
recipe above, the `items[]` hazards are in the section above this one, and the policy — the
parse-not-census rule, the shared stored/input-node rule, and the denominator rule batch 4 sharpened
— is in `core/CLAUDE.md` § *`.default()` and `.optional()`*.

⚠️ **Do not carry this doc's numbers into batch 5 — re-run the recipe.** Batch 3 proved the doc's own
table can be wrong in both directions with the errors in the INSTRUMENTS; batch 4 proved the numbers
can be right and still mean something different from what they look like. **Re-derive, and ask what
the instrument can see.**

🔴 **Do api-cloudrun#951 FIRST.** Batch 4's corpus probe was the fifth writing of the same script, and
it is deleted again. Batch 5 is `items[]` — 57 of the 143 paths, all `array[]` members the `orderBy`
oracle cannot address at all — so it *needs* that instrument and cannot fall back to a census. Lifting
it into a committed guard is the batch's cheapest prerequisite, not a tidy-up after it.

**One thing batch 4 did NOT do, deliberately:** `updateOrganization` still carries
`organization.emails = organization.emails || []` and the same for `phones`
(`api-cloudrun/src/services/organizations.ts`). Those are workarounds for exactly the absence this
batch removed, and they are now inert — both fields are required and both corpora are complete. They
were left because removing them is a separate, behaviour-bearing change with its own argument, and
folding it into a pin-carrying release would have hidden it. **A fix expires its workarounds; expiring
them is its own commit.**
