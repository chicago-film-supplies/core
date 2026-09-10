# Retiring inert `.default()` on stored schemas

*Promoted from the session of 2026-09-09. Owning repo is `core` — the schema policy is the work.
`api-cloudrun` owns the repair scripts and the census this doc names; `manager` is named only by
api-cloudrun#943's remaining half.*

> ## ⚠️ STATUS 2026-09-09 (later) — **first removal batch DONE in `core`; NOT yet published.**
> Two commits on `beta`, gates green, **push/publish deliberately held**:
> `1827843` (20 totals defaults, core#95) and `e0c71dd` (`path` required on all four
> invoice INPUT arms, core#105 — folded in to share this beta's pin sweep). Working tree
> clean, `origin/beta` unmoved, newest published is still `beta.399`.
>
> **The campaign now has a measured denominator, not an estimate.** A full absence census
> ran over all 30 collections in BOTH projects using the existing
> `api-cloudrun/scripts/audit-field-presence.ts` — no new instrument was needed, and it was
> found by grepping `scripts/` before building one. Of the 259 inert paths:
>
> | | count | meaning |
> |---|---:|---|
> | reachable by the cheap oracle | **184** | scalar/nested-map — one `orderBy` count each, no document reads |
> | need paging | **75** | `array[]` members; Firestore cannot `orderBy` inside an array of maps |
> | **FREE** (0 absent, both projects) | **122** | removable with no backfill |
> | **BLOCKED** (absence measured) | **47** | needs a backfill or a decision first |
> | **VACUOUS** | **15** | `location-types` + `recurrences` are EMPTY in both projects |
>
> ⭐ **The blocked 47 are almost all ONE shared block.** The 7-key `Address` group is
> blocked in five embeddings at once (`organizations.billing_address`,
> `orders.organization.billing_address`, `destinations.address`,
> `cards.destination.address`, `bookings.destinations.delivery.address`) — 35 of the 47.
> The rest: `bookings.stores`/`query_by_uid_store` (4,205 each), the two
> `transactions.serialized_details` arrays, `cards.destination.contact.phones` (1,156),
> `transactions.cost.unit_costs_cents` (908), `orders.xero_id` (3), `orders.invoices`.
>
> ⚠️ **The 15 vacuous paths are the MOST dangerous, not the least.** An empty collection
> makes the corpus gate pass by vacuity while saying nothing about the writer — the first
> `recurrence` ever created would be the test. The census tool refuses to report on a
> 0-document collection rather than printing 0/0 as clean, which is the only reason this
> was visible at all.

> ## ⚠️ STATUS 2026-09-09 — `OrderDocDates` DONE, **pin sweep DONE, shipped to PROD, ratchet LANDED.**
> All four repos are on `beta.399` — `api-cloudrun` `adc121bf`, `manager` `8edfa7b`, `templates`
> `cb9b44b` (PR #301 merged). **Prod runs it**: `v0.247.0`, Cloud Run revision
> `api-cloudrun-00364-v6z`, verified against the release tag's own `deno.json` rather than the tag
> alone.
> **The campaign's INSTRUMENT now exists** — `tests/stored-defaults.test.ts` (`5d14347`) pins all 291
> stored `.default()` paths and makes the partition core#95 asked for: 32 sentinel-legitimate, 259
> debt. The 259 removals themselves are unstarted.
>
> **A `.default()` on a stored schema is inert and its only live effect is a hole.**
> `validateBeforeWrite` discards `result.data` and persists the raw document, so the default never
> materializes in Firestore. What it does do is let a writer OMIT a non-optional key and still pass
> validation — which is how documents end up missing fields their schema says they have.
>
> Owner ruling, 2026-09-09: *"we dont use default, you can remove it, confirm the writers are
> compliant."*
>
> This is not a new policy. `customer_collecting` / `customer_returning` in this same
> `DestinationPairCore` lost theirs on **2026-09-08** (`9435a15`), and the comment at
> `schemas/order.ts` states the reasoning verbatim. `OrderDocDates` is the sibling field group.

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

## Context recommendation

**Clear before the wider campaign.** It does not need this session's working context — the policy is
in `core/CLAUDE.md`, the worked example is this doc, and the campaign starts from a fresh grep of
`src/schemas/`. The pin sweep is done, so the fresh-session warning that stood here is discharged;
what it was protecting against turned out to be real, and the census discriminator above is the
cheap form of it.

**Continue in-session** only for an immediate follow-up that leans on what is already loaded —
merging api-cloudrun#948 to carry `beta.399` to prod, picking up api-cloudrun#943's manager half, or
measuring the second class named above.
