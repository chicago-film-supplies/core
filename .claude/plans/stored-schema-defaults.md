# Retiring inert `.default()` on stored schemas

*Promoted from the session of 2026-09-09. Owning repo is `core` — the schema policy is the work.
`api-cloudrun` owns the repair scripts and the census this doc names; `manager` is named only by
api-cloudrun#943's remaining half.*

> ## ⚠️ STATUS 2026-09-09 — **batch 1 SHIPPED to all four repos. Backlog 259 → 239, and now PARTITIONED.**
> `@cfs/core@10.0.0-beta.400` is published and swept: api-cloudrun `2e633487`, manager `88c8543`,
> templates #302 (merged). All four repos clean on their canonical branches. **Not yet in prod** —
> that waits on api-cloudrun's next release cut.
>
> **What landed:** the 20 inert `.default()` on the three `totals` blocks (core `1827843`, core#95's
> first removal batch) and `path` required on all four invoice items INPUT arms (core `e0c71dd`,
> **core#105 — closed**, folded in to share this beta's 56-pin sweep). Two fixture repairs in
> api-cloudrun; none needed in templates or manager.
>
> **The campaign now has a measured denominator rather than an estimate.** No new instrument was
> built — `api-cloudrun/scripts/audit-field-presence.ts` already was the oracle step 1 needs, found by
> grepping `scripts/` first. Run over all 30 collections in BOTH projects:
>
> | | count | meaning |
> |---|---:|---|
> | reachable by the cheap oracle | **184** | scalar/nested-map — one `orderBy` count each, no document reads |
> | **not** reachable | **75** | `array[]` members; Firestore cannot `orderBy` inside an array of maps |
> | **FREE** (0 absent, both projects) | **122** | removable with no backfill |
> | **BLOCKED** (absence measured) | **47** | needs a backfill or a decision first |
> | **VACUOUS** | **15** | `location-types` + `recurrences` are EMPTY in both projects |
>
> ⭐ **The blocked 47 are mostly ONE shared block.** The 7-key `Address` group is blocked in five
> embeddings at once (`organizations.billing_address`, `orders.organization.billing_address`,
> `destinations.address`, `cards.destination.address`, `bookings.destinations.delivery.address`) —
> 35 of the 47. The rest: `bookings.stores`/`query_by_uid_store` (4,205 each), the two
> `transactions.serialized_details` arrays, `cards.destination.contact.phones` (1,156),
> `transactions.cost.unit_costs_cents` (908), `orders.xero_id` (3), `orders.invoices` (2).
>
> ⚠️ **The 15 vacuous paths are the MOST dangerous, not the least.** An empty collection makes the
> corpus gate pass by vacuity while saying nothing about the writer — the first `recurrence` ever
> created would be the test. The tool refuses to report on a 0-document collection rather than
> printing 0/0 as clean, which is the only reason this was visible.
>
> ⚠️ **prod and dev are ONE sample** (`devReplica` mirrors prod), so it was used as a consistency
> check instead: dev-absent >= prod-absent holds on all 169 paths. Three paths are 0-absent in prod
> and non-zero in dev — a prod-only reading would have proposed all three for tightening.
>
> **The earlier `OrderDocDates` work that opened this campaign is recorded in *What shipped* below**;
> its ratchet (`tests/stored-defaults.test.ts`, `5d14347`) is what made this batch mechanical.
> `beta.399` reached prod as `v0.247.0` / revision `api-cloudrun-00364-v6z`.

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

- **The wider campaign — 239 inert paths remain** (259 minus this session's 20 totals removals),
  concentrated in `orders` (48), `invoices` (41), `credit-notes` (33), `fulfillments` (22),
  `cards` (20) — read the live split off `tests/stored-defaults.test.ts` rather than this list, which
  is the one thing here that can rot. ⚠️ The older "~250 sites / ~335 distinct" figures counted
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
  - **`INERT_DEFAULTS` (239 as of `1827843`; 259 when first catalogued)** — the campaign backlog. Only shrinks.
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

⚠️ **Dev was ATTEMPTED AND ABANDONED, not run — say so rather than implying a pair.** It cleared
`orders` (1,020/1,020, 0 issues) and then made no progress for 40 minutes at load average 10.4,
because a peer session's api-cloudrun suite was exercising dev Firestore concurrently. It was
killed rather than waited out: it had stopped being a measurement and become a confounder in
someone else's push. The prod number stands on its own; the dev half is **unmeasured for
`invoices`, `fulfillments` and `credit-notes`**.
⚠️ Cheap to finish when dev is quiet, and worth finishing rather than assuming: `devReplica`
mirrors prod so most rows are the same corpus, but dev also carries native documents the legacy
ingest never wrote — which is exactly the population a prod-only reading cannot see.

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

## The next batch

Read the split off `tests/stored-defaults.test.ts` rather than this doc, but the shape of the
decision is stable:

- **The 122 FREE paths are the cheap ones** and several are shared blocks like `TotalsCore` was, so
  a batch is chosen by DECLARATION rather than by path count.
- **The `Address` block is the biggest single decision** — 35 blocked paths in five embeddings, and
  one `.default("")` per key. It needs the core#101 treatment: find the value's AUTHOR (a
  geocode? the CRMS import?), not a plausible default. ⚠️ Its absences differ per embedding
  (49/53 on organizations, 2/11 on cards, 1/11 on bookings), so it is more than one population.
- **The 75 `array[]` paths need a different instrument** — a paged census in the shape of
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
  ⚠️ **Reach: 57 of the 239 remaining paths are `items[]` paths** — 19 invoices, 16 orders,
  14 credit-notes, 8 fulfillments. `zero_priced` is the only sort key today and is NOT itself in the
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
  🔴 **And it has a KNOWN expiry, not merely a general one: manager#421 is re-capturing all 8
  invoice fixtures** (all 8, rather than the 5 its refine forces, so there is no second pass). That
  rewrites the corpus this 224-row measurement was taken over. **Re-run it after that PR merges** —
  it should move the invoice family to 20/20 stated, and until it does the number above describes a
  corpus that no longer exists.
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

**Clear before the wider campaign.** It does not need this session's working context — the policy is
in `core/CLAUDE.md`, the worked example is this doc, and the campaign starts from a fresh grep of
`src/schemas/`. The pin sweep is done, so the fresh-session warning that stood here is discharged;
what it was protecting against turned out to be real, and the census discriminator above is the
cheap form of it.

**Continue in-session** only for an immediate follow-up that leans on what is already loaded —
merging api-cloudrun#948 to carry `beta.399` to prod, picking up api-cloudrun#943's manager half, or
measuring the second class named above.
