# Retiring inert `.default()` on stored schemas

*Promoted from the session of 2026-09-09. Owning repo is `core` — the schema policy is the work.
`api-cloudrun` owns the repair scripts and the census this doc names; `manager` is named only by
api-cloudrun#943's remaining half.*

> ## ⚠️ STATUS 2026-09-11 — **batch 7 is published and swept; the prod deploy is one merge away. Backlog 100.**
> One statement, compacted rather than stacked. Seven batches. Batch 7 is `quantity` ×4 + `name` ×4
> — **8 paths across FOUR declarations** (`LineItemCore`, `CreditNoteDocLineItemInner`,
> `DestinationDividerArm`, `InvoiceDocOrderItemInner`), taking the backlog **108 → 100** and the
> `items[]` family **22 → 14**. `core` published **`beta.408`**; `api-cloudrun` (40 pins,
> `24cb4c9e`, on `main`), `manager` (1 pin, `4f0a481`, on `main`) and `templates` (15 pins, PR #312)
> are all bumped.
>
> ✅ **`templates` #312 is MERGED** — squashed to `main` as `1b5e754f`, and the 15 pins verified by
> reading the REMOTE's `templates/deno.json` (15 × `beta.408`, 0 × `beta.407`) rather than by a merge exit
> code. Its worktree (`templates/.claude/worktrees/core-beta-408`, branch `chore/core-beta-408`) is
> removed, local and remote; the peer's checkout was never touched. It needed a worktree because the
> main `templates` checkout is sitting on a peer session's pushed branch
> (`docs/rebless-recipe-needs-the-bearer`) — the same reason PR #311 needed one.
>
> 🔴 **The chain stops at `pinned`, and the ONE open step is a merge this session could not make.**
> **`api-cloudrun` release PR #960** (`chore(main): release 0.249.2`) — Release Please generated it
> from `24cb4c9e` and its checks pass. **Merging it is what cuts `v0.249.2` and fires the prod
> trigger**; until then prod still serves revision `api-cloudrun-00368-bx8` on `beta.407`, and
> **batch 7 is NOT enforcing in prod.** The auto-mode classifier refused `gh pr merge` on it
> (*Merge Without Review*), twice, and it was left for the owner rather than routed around.
>
> ### The BEFORE/AFTER pair, both projects, 8 positions
>
> | position | declaration | containers | present | non-null |
> |---|---|---:|---:|---:|
> | `orders.items[type!=destination\|group].quantity` | `LineItemCore` | 10,065 | 10,065 | 10,065 |
> | `invoices.items[type!=destination\|group\|order].quantity` | `LineItemCore` | 9,590 | 9,590 | 9,590 |
> | `fulfillments.items[type!=destination\|group].quantity` | `LineItemCore` | 9,986 | 9,986 | 9,986 |
> | `credit-notes.items[].quantity` | `CreditNoteDocLineItemInner` | 146 | 146 | 146 |
> | `orders.items[type=destination].name` | `DestinationDividerArm` | 1,021 | 1,021 | 1,021 |
> | `invoices.items[type=destination].name` | `DestinationDividerArm` | 1,009 | 1,009 | 1,009 |
> | `fulfillments.items[type=destination].name` | `DestinationDividerArm` | 1,021 | 1,021 | 1,021 |
> | `invoices.items[type=order].name` | `InvoiceDocOrderItemInner` | 1,009 | 1,009 | 1,009 |
>
> BEFORE, against the PINNED `beta.407`: all 8 `OPTIONAL-HERE`. AFTER, against the working tree
> (`--core=../core/src/schemas/mod.ts`): all 8 `REACHED`, **33,847 item rows, 0 failures over 3,095
> documents per project, exit 0**. No position is value-vacuous this time, unlike batch 6.
> ⚠️ **Dev is NOT a second sample** — byte-identical denominators AND the same witness document ids
> in both projects, the third batch running for which this holds.
>
> ### ⭐ The finding: the consumer suite can be run BEFORE the publish, and it is worth the hour
>
> Batches 5 and 6 published, then bumped pins, then found fixture defects with `test:units` — so a
> defect would have cost a beta. This batch ran **both** api-cloudrun tiers against the unpublished
> core first, by rewriting its 40 pins to `file://` (the `build-the-consumer-against-a-local-core`
> recipe): **2,637 passed, 5 failed, and all 5 were the `file://`-pin guard class.** Zero fixture
> defects, established before `beta.408` existed.
>
> 🔴 **That guard class is FIVE tests across THREE files, not the two the recipe records** —
> `api-cloudrun/tests/unit/lockfileSync.test.ts`, `.../referenceCoverage.test.ts`,
> `.../captureFloor.test.ts`'s *"THIS build resolves a real version"* arm, and **two floor tests in
> `api-cloudrun/tests/integration/templates/fixtures.test.ts`** that call `resolvedCoreVersion()`.
> ⭐ **The discriminator is not the file, it is the question**: anything that reads the resolved
> `@cfs/core` VERSION out of the import map fails closed, because a `file://` pin carries no version
> to resolve. Name the class, not the list — the list grew by three the first time anyone checked.
> ⚠️ The control that made the whole run credible: a one-file probe parsing a `quantity`-less line
> and printing its ISSUE PATHS. `["quantity"]` proves the local core resolved AND that it failed for
> the right reason; a bare `success: false` would not have.
>
> ### ⭐ The batch boundary was TWO LEAVES across four grains — and the split is what to copy
>
> Batches 5 and 6 took one leaf and one block. Batch 7 took two unrelated leaves at once because
> they share an INSTRUMENT (one `audit:reparse` run answers all 8 positions) and a REVIEWER
> (`items[]` arms, one fixture census) — not because they are one family. ⚠️ **What was deliberately
> NOT folded in is the better half of the lesson**: `CreditNoteDocLineItemInner.quantity` spells
> `z.int()` where `LineItemCore` spells `z.number().int().min(0)`, and `DestinationDividerArm.name`
> has no `.min(1)` where `GroupDividerArm.name` does. Both divergences are left exactly as they
> were. **A bound is a different change from a presence tightening**, and a batch that fixes
> whatever it notices stops being reviewable. *Requiring the KEY makes no claim about the VALUE* —
> and both comments now say so out loud, so the next reader does not read the omission as an
> oversight.
>
> ⭐ **`GroupDividerArm.name` was never in the backlog**, which is the pair that made batch 5's
> reach check legible: `orders.items[type=group].name` → REACHED, `[type=destination].name` →
> OPTIONAL-HERE, same document, same leaf name, opposite verdicts.
>
> ⚠️ **One straggler NOT taken, and the reason is the campaign's own scope rule.**
> `PickSheetDestinationSchema.name` (`core/src/schemas/pick-sheet.ts`) still carries `.default("")`
> and is `DestinationDividerArm.name` copied byte-for-byte by `foldPickSheet`. It is **not** in the
> ratchet, because `pick-sheets` is a computed view rather than a Firestore collection — so the
> registry walk cannot see it and `audit:reparse` has no corpus to measure it against. The campaign
> is about STORED schemas; tightening this one would be a change with no instrument behind it.
>
> ⚠️ **The `templates` fixture census is a PREREQUISITE for an `items[]` batch and was re-run:**
> **224 item rows across the 23 files of the `invoice` + `quote` families — 154 line rows all
> stating `quantity`, 24 destination dividers and 8 order dividers all stating `name`, 0 missing.**
> The other five families never meet these schemas (sidecars declare `pick-sheets`,
> `movement-sessions`, `aging-reports`, `statements`). Controlled by asking for a key nothing
> carries and confirming all 224 rows reported missing — the `aging-report` classifier error, not
> repeated.
>
> ⚠️ **The suite bit once and it was ONE cause**: 7 failures in `core/tests/order.test.ts`, all the
> `docLine` factory, completed with `quantity`. Batch 5 had already routed that file's two raw
> literals through the factory, so every negative test still drops exactly one field —
> **batch 5's repair is what made batch 7's repair a one-liner.**
>
> 🔴 **A manager pre-push failure that was NOT a test failure.** `npm run test:rules` printed
> `✔ Script exited successfully (code 0)` — 365 rules tests green — and then
> `Error: An unexpected error has occurred` during emulator teardown, which `firebase
> emulators:exec` reported as the command's own failure, so the push was refused. Re-run clean,
> exit 0, pushed. ⭐ **Read WHERE in the output the failure sits**: after the script's own success
> line, the suite is not what failed.
>
> ### 🔴 A shared-counter assertion, found by this campaign's own push
>
> `publishResolvedTemplates: idempotent re-publish (same sha) is a noop` compared
> `counters/templates-publish-seq` before and after with `assertEquals`. That counter is ONE
> document for the whole dev project and the suite runs `--parallel` across FILES, so the
> assertion froze a global across a window it does not own — `131217 !== 131216`, green in
> isolation. ⭐ **Its sibling assertion in the same file has always used `>` and was never
> affected: the DIRECTION of the comparison is what made one contention-safe and the other not.**
> Repaired in `api-cloudrun` `b0961b80` by asserting on the RESULT (a redelivery returns the
> existing version's seq), with a non-vacuity guard because both sides are `number | null`, and
> verified by mutation — comparing against `seq + 1` fails exactly that step and nothing else.
>
> 🔴 **The batch-5 citation trap did NOT fire this time, and the reason was deliberate**: this doc
> was held unpushed until after the publish, so no plan-doc citation could gate `release`. The rule
> that bought that stands — **repo-qualify every sibling path in this doc.** Core's own
> `deno task audit:citations` resolves a bare `scripts/` against the whole workspace and passes; CI
> checks core out ALONE, where `scripts/` is core's own top-level directory, so it is BROKEN rather
> than ambiguous, and `publish.yaml` gates `release` on `needs: ci`. **Two betas silently did not
> publish** that way (`34549009010`, `34549265656`, both `release: skipped`). Tracked as `core#106`.
> ⚠️ Reproducing it needs the extracted dir NAMED `core` (the resolver derives the workspace from
> the PARENT), and **not** `HOME=/tmp/nonexistent`, which just breaks Deno's module cache.
>
> | batch | what | backlog | state |
> |---|---|---:|---|
> | 1 | 20 `totals` defaults | 259 → 239 | ✅ prod, `v0.247.0` |
> | 2 | 20 `query_by_*` + 8 `bookings_breakdown` | 239 → 211 | ✅ prod, `v0.248.0` |
> | — | **the ratchet hole**: +47 paths nothing had ever enumerated | 211 → 258 | ✅ `core` `4f73bca` |
> | 3 | the seven `Address` keys — 105 paths, 15 positions | 258 → 153 | ✅ prod, `v0.248.1` |
> | 4 | `phones` ×9 + `organizations.emails` — 10 paths, 3 declarations | 153 → 143 | ✅ prod, `v0.248.1`, revision `api-cloudrun-00366-whd` |
> | — | **the corpus-parse instrument** (`api-cloudrun#951` + `#636`) | — | ✅ `api-cloudrun` `5ed776fe` |
> | 5 | `items[].description` ×11 — 5 declarations, one leaf, four grains | 143 → 132 | ✅ prod, `v0.249.0`, revision `api-cloudrun-00367-xm4` |
> | 6 | the `price` block ×3 — 24 paths, 3 declarations, one block | 132 → **108** | ✅ prod, `v0.249.1`, revision `api-cloudrun-00368-bx8`, digest-verified |
> | 7 | `quantity` ×4 + `name` ×4 — 8 paths, 4 declarations, two leaves | 108 → **100** | ⏳ `beta.408` published, all three consumers pinned (`templates` merged); **prod deploy blocked on merging `api-cloudrun` #960** |
>
> ### ✅ The prerequisite is DONE — and `api-cloudrun#951`'s premise was partly WRONG
>
> The issue said *"nothing re-parses the live corpus"*. **`api-cloudrun/scripts/audit-schema-validation.ts`
> already existed and already re-parsed it.** Five sessions wrote their own probe anyway, and the
> reason is one line: it did `import { db } from "../src/db.ts"`, which drags the repo's PINNED
> `@cfs/core` in beside any local one — so a probe of an UNPUBLISHED tightening parsed against the OLD
> schema and read 0 failures. **The instrument was there; it could not answer the question, and
> nothing said so.**
>
> ⭐ **The transferable half: before building the instrument an issue asks for, look for the one that
> is already committed and ask why nobody used it.** `api-cloudrun#636` had been open for weeks saying
> the same script under-covered; the two issues were the same artifact seen from two sides, and
> building a sixth script would have left both open plus a seventh thing to maintain.
>
> **What it now does** (`deno task audit:reparse`, `api-cloudrun` `5ed776fe`): paged
> `orderBy("__name__")` walk, collection set derived from `listCollections()` ∩ the registry rather
> than a hand-written block of 40 imports, failures bucketed by issue-path SHAPE, **exit non-zero**,
> `--groups` for subcollections, `--core=../core/src/schemas/mod.ts` for an unpublished tightening,
> `--positions` for the per-position denominator, and `--reach`.
>
> ⭐ **`--positions` takes a DISCRIMINATOR FILTER, which is what makes it usable on `items[]`** —
> `orders.items[type!=destination|group].description`. The backlog addresses union members
> positionally (`|0` is the line-item arm, `|1` a destination divider, `|2` a group divider), so an
> unfiltered path over-counts a denominator in the one direction that makes a vacuous position look
> populated. ⚠️ **Quote it in zsh** — a bare `[]` is a glob.
>
> ### 🔴 The instrument was controlled before any of its numbers were believed
>
> Four controls, because "0 failures" and "traversed nothing" print the same line:
> - **Three distinct verdicts on one run** — `organizations.phones` REACHED (required since batch 4),
>   `orders.reference` OPTIONAL-HERE (still backlog), `invoices.destinations[].delivery.contact`
>   REACHED-but-VACUOUS (1,009 containers, **0 non-null** — batch 4's finding, reproduced
>   mechanically).
> - ⭐ **The sharpest one: same document, same leaf name, two union arms, opposite verdicts.**
>   `orders.items[type=group].name` → REACHED, `orders.items[type=destination].name` →
>   OPTIONAL-HERE. Nothing but a probe that genuinely resolves through the discriminated union can
>   produce that pair.
> - **`--core` proved load-bearing, not decorative** — pointed at a shim registry that refuses
>   everything, `taxes` went 0/12 failing → 12/12.
> - **The filter PARTITIONS exactly** — 10,065 + 1,021 + 2,898 = 13,984 dev order item rows. An
>   arithmetic identity the run can check on itself.
>
> ### The measurement it was built to make, run before landing it
>
> | | collections | documents | failures |
> |---|---:|---:|---|
> | **prod** top-level | 49 | **29,013** | **1** — the `transactions` purchase with `supplier: null` |
> | **dev** top-level | 49 | **116,570** | 3 — that row mirrored, the `-default` location id, `users/test-user` |
> | prod subcollection groups | 3 | 5,442 | 0 |
> | dev subcollection groups | 3 | 220,583 | 3 legacy-shaped `events` rows |
>
> ⭐ **So `api-cloudrun#636`'s widening found exactly ONE new class, dev-only.** The collections the
> old hand-written list never validated — `credit-notes`, `settlements`, `fulfillments`, `cards`,
> `templates-versions`, `template-components`, `uploadcare-worklist`, `quotes`, `stock`, `activities`
> and the rest — are clean in both projects, as are the three subcollection groups it could not reach
> at all (`orders/{id}/documents`, `orders/{id}/xero-sync`, `webhooks/{s}/events`).
>
> ⚠️ **It is HAND-RUN, and scheduling it is blocked on repairing the rows it already finds.** An alert
> firing on two known-dirty documents every night is an alert nobody reads. The exit code is there so
> a tightening's rollout can gate on it.
>
> ⭐ **The pure half is `api-cloudrun/scripts/_corpusReparse.ts`, pinned by
> `api-cloudrun/tests/unit/corpusReparse.test.ts`** — because those are the functions that read
> identically when broken. Anti-vacuity: four mutations (a permissive `namesPosition`, a
> null-admitting filter, a null-descending walk, an `undefined`-based presence test) each fail
> **exactly one** arm, its own.
>
> ### 🔴 A side finding the parse surfaced: two catalogs disagreeing about one fact
>
> `api-cloudrun/scripts/scan-firestore-subcollections.ts` had been exiting 1 on **PROD** for as long as the
> Typesense sync pulse existed — `typesense-pulse` is blessed in the write-guard allowlist and was
> absent from `UNVALIDATED_COLLECTIONS`. Fixed in `api-cloudrun` `310dd3bc`, verified by a before/after
> pair on the census itself (exit 1 → exit 0), with a population assertion beside the declaration.
> ⚠️ **A standing red hides the next genuinely unaccounted collection behind it.** Dev stays red on
> `api-cloudrun#637`'s two paths, which are a different cause and already tracked there.
>
> ⚠️ **Dates in this doc were off by one until now** — the previous session stamped UTC where CFS
> canonicalizes to Chicago, so "2026-09-11" was the evening of 2026-09-10. Corrected throughout; the
> `cfs-datetime` rule applies to prose that records a measurement date, not only to stored fields.
>
> ### Batch 4's findings, which still stand
>
> 🔴 **The corpus said almost NOTHING and the parse still read 0 failures.** 4,560 prod / 4,571 dev
> documents, 0 failures — but `organizations.emails`/`phones` carry **319 prod / 323 dev non-null
> objects with 0 absences** while the eight destination-contact positions hold **18 prod / 22 dev
> between them**, and `invoices.destinations[].delivery.contact` holds **none**. ⭐ **Report the
> denominator beside every clean verdict**, and say which half the tightening rests on.
>
> 🔴 **The writer gap was a 500, measured rather than argued.** `DestinationContact.phones` is
> `.optional()` and `buildDestinationPair` spread it verbatim, so once the document schema required it
> the same accepted payload failed `validateBeforeWrite` from inside the create transaction.
> `withStatedContactPhones` supplies `?? []` at the one root author. ⚠️ **`?? []` in a forward writer
> is not the backfill the campaign forbids** — that rule is about existing documents, whose omission
> is a biased sample.
>
> ⭐ **A node can be unshared and still look shared.** `phones` appears on six declarations under three
> names, all separate objects — so unlike `Address` this was a pure storage tightening with no
> API-input change, and only reading the declarations says so. **A field name is not a node.**
>
> ⭐ **Step 4 was NOT a no-op.** `DocDestinationContactType.phones` was `?: string[]` while the schema
> defaulted it — the `z.ZodType<T>` blind spot — so typed literals were *not* already compiler-gated.
>
> ⚠️ **A gate can pass without asking.** `templates` `lint:fixtures` went clean and its denominator for
> `organizations` is **zero**. Read a green gate's population before crediting it.
>
> ⭐ **The pin rides whatever the commit says it is.** Batch 3 sat in dev because its consumer commits
> were `chore(deps)`/`test(fixtures)`; batch 4's genuine `fix(orders)` cut `v0.248.1` and carried both
> to prod. Verified by image digest, not by the tag.

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
| `beta.408` reaching prod | `api-cloudrun` release PR #960 → `v0.249.2` | ⏳ **blocked on a merge** |

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

### ✅ `quantity` ×4 + `name` ×4 WAS batch 7 — and `path` ×10 is what the family is now

**Done** (`core` `37c4209` → `beta.408`), 8 paths across four declarations, leaving **100**. Full
write-up in the status block. The one thing to carry forward is what it leaves behind.

**RE-DERIVED 2026-09-11 by the recipe below — do not quote it, re-run it:**
**100 paths — 76 scalar, 24 `array[]`.** The `items[]` family is now **14**, and the scalar count
did not move at all, because every one of batch 7's 8 paths was an array member.

🔴 **`items[]` is now `path` ×10 plus four credit-note-only keys, and NOTHING ELSE.** That is the
whole remaining items family:

| what | paths | note |
|---|---:|---|
| `path` on every arm of all four grains | 10 | 🔴 the row identity, ONE author (`computeItemPaths`), and the array-ordering hazard below is about it |
| `credit-notes.items[].{tracking_category, uid_invoice_item, xero_id, xero_tracking_option_id}` | 4 | all `.default(null)`, all Xero-side, 146 rows |

⚠️ **So the cheap `items[]` batches are EXHAUSTED.** Batches 5, 6 and 7 took `description`, the
`price` block and `quantity`/`name` — every leaf that clustered across grains. What is left inside
`items[]` is one leaf that needs care and four keys on the thinnest grain in the corpus. **Batch 8
is a choice between a small `items[]` batch and leaving `items[]` for a non-items family**
(`cards` 10, `products`/`webshop-products` 15) — read the table below, which is the re-derived
per-collection split.

| family | paths | note |
|---|---:|---|
| **`items[]` across orders / invoices / credit-notes / fulfillments** | **14** | `path` ×10 + 4 credit-note-only keys — see the table above; the cheap leaves are gone |
| `cards` (+ `recurrences.prototype.*`, which mirrors it) | 16 | `attachments`, `locked`, `body_text`, `dates.*`, `uid_assignees`, `sources` |
| `products` / `webshop-products` (`webshop.*`, `component_of[]`, `components[]`) | 15 | two collections, one shared `component_of` block |
| `templates` / `templates-versions` / `template-components` | 7 | `draft_uids`, `fixtures`, `params`, `consumed_components`, `active_semver`, `depends_on.components` |
| `stores` / `stores[].locations` / `store_breakdown` | 6 | `bookings`, `out-of-service`, `inventory-ledgers` — one shape, three collections |
| `sources` | 4 | `credit-notes`, `out-of-service`, `recurrences.prototype`, `transactions` |
| `reference` | 3 | `orders`, `credit-notes`, `fulfillments` — small, scalar, likely free |

⭐ **Inside `items[]` the leaf names clustered harder than the collections did — and batch 7 spent
the last of that.** `description` (batch 5), the `price` block (batch 6) and `quantity`/`name`
(batch 7) were the leaves that repeated across grains; what remains is `path` ×10 and four
credit-note-only keys. **The "one leaf across the grains that have it" selector has no cheap
candidate left**, which is itself the reason batch 8 should look at a non-items family.
🔴 **`path` is the row identity with exactly one author, and the array-ordering hazard below is
about it — take it last, or deliberately.**

⚠️ **The per-collection split, RE-DERIVED 2026-09-11** (`cards` 10 · `credit-notes` 9 · `products`
8 · `orders` 8 · `invoices` 8 · `webshop-products` 7 · `recurrences` 6 · `transactions` 5 ·
`fulfillments` 5 · `templates` 4 · then a tail of 1-3 across 19 more collections). The FAMILY table
above groups these across collections, which is the unit a batch is chosen in; this is the raw
per-collection count and the two do not add up to each other on purpose.

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
  ⚠️ **Reach: 46 of the 132 remaining paths are `items[]` paths** — batch 5 took 11 of the 57, and
  batches 3 and 4 took none. `zero_priced` is the only sort key today and is NOT itself in the
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

🔴 **Batch 7 has ONE piece of residue and it is a merge.** Everything mechanical is done —
published, pinned in all three consumers (`templates` #312 merged as `1b5e754f`), both api-cloudrun
tiers green — but the chain stops at `pinned`, because this session's auto-mode classifier refused
`gh pr merge` on the release PR (*Merge Without Review*). **Until #960 merges, batch 7 is not
enforcing in prod.**

| # | what | owner | blocked on |
|---|---|---|---|
| 1 | **`api-cloudrun` release PR #960** (`chore(main): release 0.249.2`) — merging it cuts the version and fires the prod trigger | the owner, or a session allowed to merge | a merge |
| 2 | **verify the chain end-to-end after (1)** — digest, not tag; then `audit:reparse` with NO `--core` | next session | (1) |
| 3 | **`api-cloudrun#955`'s prod row** — the last thing between `audit:reparse` and being a scheduled job | the owner | a call between four options, all measured |
| 4 | **Batch 8** — 100 paths, only 14 of them `items[]` | next session | nothing |
| 5 | `api-cloudrun#943`'s remaining half — manager `collection_end`/`delivery_end` editors | — | nothing; pre-existing |
| 6 | `core#106` — nothing runs the citation audit at CI scope, so a publish can silently skip | — | nothing |

**(2) is the step batch 6 nearly skipped and is worth restating.** A revision NUMBER moving is good
evidence the build arrived and **no evidence at all that the image carries `beta.408`**. Read the
digest: `gcloud run revisions describe` for the image, `gcloud builds` for what the tag built, and
then `deno task audit:reparse` with **no `--core` flag** from a checkout whose `deno.json` matches
the deployed tree — that parses against the core the image itself resolves. All 8 positions must
read `REACHED`. Published → pinned → deployed → enforcing are four different claims.

**(3) is NOT "delete a row", and that is the finding.** `transactions` is an append-only journal:
there is no `DELETE` route, `updateTransaction` edits `reference` alone, and this row cannot take
even that — it writes through `ValidatedTx.set`, which validates first. So a **reversal** mints a new
movement and leaves the bad row in place (the reparse still exits non-zero), **stamping a supplier**
makes the parse pass while leaving $2.00 of cost basis Xero does not have, and a **hard delete**
needs a one-shot prod script plus manual `quantity_held` surgery, because `LEDGER_REBUILD_FIELDS`
deliberately makes a replayed quantity unreachable from the write path. The fourth option — a
documented schema carve-out naming the one uid — costs a comment and a test. ⭐ The row itself is
adjudicated: it is a **duplicate of #1162**, which carries Home Depot and posted as `CFS-MOV-1162`;
there is no `CFS-MOV-1161` anywhere in the ACCPAY window. Full evidence on the issue.

**(4) batch 8 — read the split off `core/tests/stored-defaults.test.ts`, not this doc.**
🔴 **The cheap `items[]` batches are exhausted**: `items[]` is down to `path` ×10 (the row identity,
one author, and the array-ordering hazard above is about it) and four credit-note-only Xero keys on
146 rows. **So batch 8 is a genuine choice for the first time since batch 2** — a small deliberate
`path` batch, the four thin credit-note keys, or a non-items family (`cards` 10 ·
`products`/`webshop-products` 15 · `templates`* 7). The `cards` family is the largest single one
left and needs no new instrument; `path` needs the ordering hazard read first.

## Context recommendation

**Continue if you can merge #960; otherwise clear after handing it over.**

The remaining work splits cleanly. **Merging #960 and then verifying the chain (items 1-2)
needs this session's context** — the shas, the BEFORE/AFTER readings and what each verification
claim actually means are all here, and item (2) is the step a fresh session most often downgrades
into reading a revision counter.

**Batch 8 needs none of it.** Everything it requires is written down: the backlog is read off
`core/tests/stored-defaults.test.ts` (**100** paths — 76 scalar, 24 `array[]`, 14 of them `items[]`),
the partition is re-derived by the recipe above, the `items[]` hazards are in the section above this
one, and the policy — the parse-not-census rule, the shared stored/input-node rule, the denominator
rule batches 4 and 6 sharpened between them, and batch 7's *require the KEY, claim nothing about the
VALUE* — is in `core/CLAUDE.md` § *`.default()` and `.optional()`*.

⚠️ **Do not carry this doc's numbers into batch 8 — re-run the recipe.** Batch 3 proved the doc's own
table can be wrong in both directions with the errors in the INSTRUMENTS; batch 4 proved the numbers
can be right and still mean something different from what they look like; batch 6 proved a column
labelled VACUOUS can be decisive for the claim actually being made; batch 7 proved a documented
guard class can be **three files rather than two** the first time anyone counts it. **Re-derive, and
ask what the instrument can see.**

⭐ **Batch 7's transferable habit: run the consumer suite BEFORE the publish.** Repointing
api-cloudrun's 40 pins at a `file://` core and running both tiers cost about an hour and would have
caught a fixture defect for free; batches 5 and 6 each found theirs only after spending a beta. The
`build-the-consumer-against-a-local-core` recipe is the mechanism, and its guard-class list needs
the correction above.

**Two things this session left deliberately:**
- The two documents `api-cloudrun#951` names are **still unrepaired** — a prod `transactions`
  purchase with `supplier: null` (an accounting fact, not a default: find its Xero bill or ask the
  owner) and a dev `locations` id. A third turned up, dev-only: `users/test-user`. Until they are
  gone the parse cannot be scheduled, because a nightly alert on known-dirty rows is one nobody
  reads.
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
