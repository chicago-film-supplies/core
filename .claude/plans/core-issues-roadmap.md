# Roadmap: the 9 open `core` issues, plus the two campaigns that came out of reviewing them

**Date:** 2026-08-23 • **Repo:** core (+ api-cloudrun, manager, templates) • **Status:** 🚧 Waves 0 and 0.5 landed (see the status block); Wave 1 onwards not started
**Ordering:** risk-first (owner's call), with one half-sitting prerequisite ahead of it (Wave 0 — drop it if you disagree with the reasoning there).

> ## ⚠️ STATUS UPDATE 2026-08-23 — Waves 0, 0.5 and 1 are DONE, deployed to dev; start at Wave 2
>
> | Wave | State |
> |---|---|
> | **0a** non-destructive staleness tests | ✅ core `b640b62` |
> | **0b** declarations gate | ✅ core `80144dc` |
> | **0c** templates pin count | ✅ core `89e8dc0`, corrected twice more — see below |
> | **0.5** core#68 golden aggregate | ✅ core `a1cab8f` → **beta.243**; api-cloudrun `b67bb890`; manager `dd0db53` |
> | **1** core#58 Phases 0 + 1 (incl. 1c) | ✅ core `a7dea49` + `a99ecce` → **beta.244**; api-cloudrun `3d16987f`; manager `99a5c5b`; templates PR **#121** (open at beta.244, not merged) |
> | **2 onwards** | ⏳ not started |
>
> `@cfs/core` is at **`10.0.0-beta.244`**; api-cloudrun, manager and the open templates PR are all
> pinned to it. Everything is **pushed** — api-cloudrun's dev deploy is live
> (`api-cloudrun-dev-01328-rt5`).
>
> 🔴 **Wave 1's two migrations have run in DEV ONLY. Prod is outstanding and must not be skipped.**
> - `api-cloudrun/scripts/purge-sessions.ts` — dev: **133,911 sessions purged**. Prod: **not run.**
>   It must run in the same deploy that ships beta.244, because `getSession` is a bare cast, so a
>   pre-rename doc yields `session.uid === undefined` for its whole 30-day TTL and writes
>   `session=undefined` cookies rather than failing closed. One prod user, one forced re-login.
> - `api-cloudrun/scripts/backfill-order-document-uid.ts` — dev: **1,988 stamped**, idempotent re-run
>   confirms 0 remaining. Prod: **not run.** Then tighten `OrderDocument.uid` to required.
> - Prod deploy is gated behind merging the release-please PR, so both are operator steps.
>
> **What the plan got wrong, corrected in place below:**
>
> - **0b's prescribed fix for `schemas/common.ts` does not work.** Annotating `LINE_PARENTS` /
>   `DIVIDER_PARENTS` leaves all six TS9013s standing: the diagnostic is on the *use* site, because it
>   is `ITEM_CONTRACTS_INNER`'s own type that must be written down. The reference has to leave the
>   `as const` entirely, so `parentable_by` moved out to the already-annotated `ITEM_CONTRACTS`.
> - **0a's shape had to change**, because a spawned child carries its OWN permissions — so a test
>   that spawns a generator rewrites `src/` no matter what the test process may do. `--allow-run` is
>   the load-bearing removal, not `--allow-write`. One staleness check became an in-process compare,
>   the other became `deno task check:generated`.
> - **The declarations gate is a TASK, not a test in `jsr-emit-safety.test.ts`** — `npm:typescript`
>   reads `process.env`, and `deno task test` is now `--allow-read` only. That file is deleted, as
>   core#44 itself asked; TS9018 was confirmed to catch its construct first.
> - 🔴 **The templates pin count is BRANCH-DEPENDENT and this doc twice stated it as a fact.**
>   `origin/main` carried **7** core pins; the unmerged `ci/citation-gate` branch carries **8** (it
>   adds `utils/citations`). A local checkout sitting on that branch also reported `beta.240` while
>   `origin/main` was already at `beta.241`, which is where this doc's "templates is one publish
>   behind" claim came from. **It was wrong.** Bump by `sed` over the version pattern and read the
>   version off `origin/main`.
> - **Wave 0.5's sequencing blocker had already cleared.** Manager's `feat/templates-editor-lifecycle`
>   is merged; the branch and the `~/cfs-templates-editor` worktree are gone in both repos.
>
> **New, found while doing the work:**
>
> - `check:generated` caught its first defect immediately: an exported function in
>   `utils/templates.ts` ships into the template editor's helper panel, so `aggregateGoldenVerdict`
>   needed a denylist entry.
> - The reassuring claim *"a real fixture slug can never be `_`"* is **false** —
>   `parseFixturePath` parses `fixtures/<gp>/_.json` into slug `"_"`. The sentinel is a convention,
>   not an invariant.
> - **api-cloudrun#640** filed for the retired plan's P0 (an operator bless that publishes to prod).
>
> **Wave 1 findings, all measured:**
>
> - **Finding 2 reproduces exactly** — 96 registry keys → 56 distinct types, **41 with `uid`, 15
>   without**. The 40/16 figure this doc told us to re-measure does **not** reproduce.
> - The rename produced **21 compile errors across 12 files** in api-cloudrun. That is the whole
>   value of it: a field not named `uid` is invisible to the `uid === ref.id` drift guard.
> - `api-cloudrun/src/services/dbRead.ts`'s `data.uid === id` comment was **already fixed** (#619)
>   and its numbers match this measurement. `scripts/seed-rbac.ts` listed 4 roles against 6 — the
>   list is now deleted rather than corrected, since a hand-copy beside its own source is the
>   core#55 class.
> - `tests/helpers/auth.ts`'s shared session id was **37** chars behind a comment claiming "38
>   chars, fits schema's <=40 bound" — wrong about the string AND the constraint (`.length(40)` is
>   exact). It survived only because that fixture uses a raw `ref.set()` that never parses.
> - ⚠️ **A bug in the backfill's first draft**, caught before it ran: it also stamped `updated_at`.
>   `OrderDocumentSchema` is a `z.strictObject` with no timestamp field, so that would have made all
>   ~1,836 docs invalid — failing `validate-collection` and, since `validateBeforeWrite` parses the
>   whole document, refusing every later read-modify-write.
> - Dev shows **0** order documents whose id is neither `"quote"` nor `"packing-list"`. The legacy
>   auto-id tail the plan warns about may be prod-only; the script keys on `ref.id` regardless and
>   reports the count on the prod dry run.
>
> **Still open from Wave 0's issues:** #54 and #44 do not close until Wave 7. **#58 does not close
> until its Phase 4** (Wave 2b).

## Context

`chicago-film-supplies/core` has 9 open issues. Two (#58, #59) are completed audits with committed,
cold-startable plan docs. The other seven are smaller. Reviewing them surfaced that **five had measurably
rotted** — and in two cases the issue's own recommended fix is now the wrong one. Reviewing #53
(`getInitialValues`) then opened two larger questions the owner asked to pursue: what the seed helper
should actually be, and whether many `.optional()` fields could simply be required.

This plan covers all three: the nine issues, the seed-helper split, and the optionality campaign.

⚠️ **#68 arrived on 2026-08-23 at 17:17, after the census below was taken**, which is why it has no
row in *What verification changed*. It was verified separately on the same day and lands as Wave 0.5.

**Owner decisions already taken** (do not re-litigate):
- Ordering is **risk-first**.
- **#65** is taken **census-first, then one cut**.
- The seed helper is **split into two functions**, not given a mode param.
- **Breaking changes are cheap** — betas roll into one major at merge. Versioning is *not* a constraint;
  corpus cleanliness is.

## What verification changed

| Issue | The issue says | Measured today |
|---|---|---|
| **#54** | suite is 28–32 s | **15.5 s**, 1,663 tests |
| **#54** | batching `deno doc` saves 8–15 s | **1.03 s**. The issue's own "measure first" gate fires — **drop item 2.** |
| **#54** | 17 `runDenoDoc` entrypoints | **18** (`./utils/citations` landed in `c553f3c`) |
| **#54** | `.github/workflows/publish.yaml`'s `ci` job is a verbatim copy, so dropping `push` from `.github/workflows/ci.yaml` is zero-risk | ⚠️ **Rotted.** `.github/workflows/ci.yaml` gained a **Citations** step `.github/workflows/publish.yaml` lacks. Executing item 4 as written **removes the citation gate from core's normal workflow.** |
| **#44** | 21 TS9xxx in 4 files | **Reproduces exactly.** Plus 2 new in `src/utils/citations.ts:101,173` (same false-positive class). |
| **#44** | `src/schemas/common.ts:612-620` | now **`686-698`** — the issue's own line refs rotted |
| **#44** | assert the count, not the exit code | Necessary but **insufficient**: raw count is **1056**, because tsc resolves a stray `~/node_modules/zod@3.25.76`. Filter `/error TS9\d+/` **and** pin zod resolution. |
| **#44** | fix `core/CLAUDE.md:15` | **Already done.** Note it when closing. |
| **#65** | 22 of 24 arms | **22 of 22.** No clean arm exists. `api-cloudrun/src/lib/logger.ts:370`'s "24" is stale too. |
| **#65** | ~100 message types | **286 msg literals**, **367 call sites in 104 files** |
| **#53** | fix is `case "optional" → SKIP` | ⚠️ **Refuted three ways** — see Wave 4. |
| **#56** | widening is backward-compatible | **Confirmed** — core already passes `LineItem` into `PricingItem` entry points (`src/utils/orders.ts:1214`, `:1055`) |
| **#60** | 20 of 22 aliases | **Confirmed.** Missing `cards` (live, 1,097 prod docs) and `threads`. |

## The shared release loop

Referenced by number from each wave.

1. Commit on `beta`, push → semantic-release publishes the next `-beta.N`.
2. Bump `api-cloudrun/deno.json` (28 subpath lines), `manager/package.json` (1 line),
   `templates/deno.json` (exact pins, one per subpath). `deno install` / `npm install`.
3. ⚠️ **Bump ALL THREE by PATTERN** — `sed 's|jsr:@cfs/core@<old>/|jsr:@cfs/core@<new>/|g'` (and the
   `npm:@jsr/cfs__core@` form for manager). **Do not carry a line count.** Measured 2026-08-23:
   templates' count is *branch-dependent* — `origin/main` had 7 core pins, the unmerged
   `ci/citation-gate` branch has 8 — and both campaign plan docs stated a single number as though it
   were a property of the repo. Read the current version off `origin/main`, never off whatever draft
   branch the templates checkout is sitting on.
4. `templates` has branch protection — **open the PR, never merge it.**
5. A "missing" JSR version is almost always a stale edge cache — read `~/cfs/CLAUDE.md` § 2a first.

---

## Wave 0 — the two gates the campaigns need (half a sitting, no publish)

⚠️ Placed ahead of the risk-first campaigns deliberately: both edit `src/schemas/` heavily and add new
exported consts. Fix 1 stops a green test run rewriting tracked files *during* a migration; the
declarations gate catches the exact class of mistake new exports make. Skip it if you'd rather start on
#58 — nothing downstream hard-depends on it.

**First: `git checkout -- deno.lock`** (an exploration agent's tsc run added a typescript entry).

### 0a. Non-destructive staleness tests — core#54 fix 1
`tests/schema-fields.test.ts:250` and `tests/template-helpers.test.ts:330` spawn the generators, which
write into `src/`, then read back and byte-compare — **the generator is the oracle**, so a green run
necessarily rewrites two tracked files.
- Give both generators a stdout mode (neither parses `Deno.args`; the write is one hardcoded
  `Deno.writeTextFile` at `:70-71` and `:160-161`).
- Diff captured stdout against the committed file.
- **Drop `--allow-run --allow-write` from the `test` task.** Measured: **exactly 2 of 1,663 tests need
  them, and they are the two that rewrite tracked files.**
- ⚠️ Do **not** add `.generated.` filters to `tests/moneyArithmeticCoverage.test.ts:63` /
  `tests/interface-optionality.test.ts:262` — fix 1 makes them unnecessary and both carry floor assertions.
- 📝 **`core/CLAUDE.md` § Commands, the `deno task test` line:** record that `test` deliberately runs
  **without** `--allow-run`/`--allow-write`, that the permission removal *is* the enforcement stopping a
  green run from rewriting tracked files, and that the two staleness tests compare against generator
  **stdout**. Without this, a future session adding a shell-out test hits an unexplained permission failure.

### 0b. The declarations gate — core#44
Land it **inside `tests/jsr-emit-safety.test.ts`** (it invites this at `:28-30`); delete its
`SPREAD_IN_AS_CONST` regex once subsumed.
- Add `"typescript": "npm:typescript@6.0.3"` (api-cloudrun's pin).
- `tsc --strict --declaration --isolatedDeclarations --emitDeclarationOnly --outDir <gitignored>
  --skipLibCheck --allowImportingTsExtensions`. **Never `--noEmit`** — silent false zero.
- **Filter `/error TS9\d+/`; pin zod resolution.**
- **Fix 18:** `log/base.ts:47-64` (×12, annotate against the existing `BaseLogFields` interface at `:71`)
  and `src/schemas/common.ts:679,682`. ⚠️ `ITEM_CONTRACTS_INNER` feeds five mapped types at
  `src/schemas/common.ts:885,904,970,975,1027`; they key on `kind`/`pricing`/`fulfillable`, not `parentable_by` —
  verify before committing.
- **Exempt 5, and express the second class as a RULE:** `src/schemas/_dividers.ts:24,47` (annotating them *breaks*
  the discriminated union — justification pre-written at `src/schemas/_dividers.ts:1-19`), and bare top-level
  `export const X = /…/flags` regex literals (`uploadcare/dictionary.ts:26`, `utils/citations.ts:101,173`
  — that class grew 1 → 3 in one day).
- Add `deno publish --dry-run` to `.github/workflows/ci.yaml`. ⚠️ It covers **none** of this defect class.
- 📝 **`core/CLAUDE.md:15-19`, the `deno task lint` entry, MUST be updated in this same commit.** It
  currently states, emphatically, that JSR `no-slow-types` runs *"**only** via `.githooks/pre-push`"* —
  adding the dry-run to `.github/workflows/ci.yaml` makes that false. That entry is the file's most self-referential
  claim: its own prose calls a gate-claim naming a check nothing runs *"the exact defect class this
  package's ratchets exist to kill."* Leaving it pointing at an incomplete enforcement location is
  precisely the failure it warns about. Say both locations, and keep the caveat that the dry-run covers
  none of the TS9xxx class so the line does not overclaim.

### 0c. Fix the stale templates-pin count in both plan docs.
⚠️ Record the **skew**, not only the count: api-cloudrun and manager are at `10.0.0-beta.241`
(`api-cloudrun/deno.json`, `manager/package.json`) while `templates/deno.json` is still at
`10.0.0-beta.240` — so `templates` is already one publish behind before any wave starts. **Wave 0.5
executes the `sed` for real**, which is the check this item cannot perform on paper.

---

## Wave 0.5 — core#68, the golden aggregate (one publish, ~20 lines of logic)

`aggregateVerdict` (`api-cloudrun/src/services/templates/goldenDiff.ts`) and `aggregateGolden`
(`manager/src/components/templates/goldenReview.ts`) implement one precedence with no shared code.

Placed here deliberately. It pays its own publish and buys three things for it: it retires an
otherwise-complete committed plan doc, it unblocks manager's stalled branch, and — the reason it
sits *before* the risky waves — it **rehearses the publish + bump-by-pattern loop on 20 low-stakes
lines before Wave 1's prod-auth deploy depends on that loop working.** Wave 0c is a paper fix to a
stale pin count; this is the same fix executed.

### What moves into `src/utils/templates.ts`

**1. The `no-fixtures` sentinel — the load-bearing half of the duplication, and the issue does not
mention it.** `"_"` is a bare string literal in api-cloudrun
(`api-cloudrun/src/services/templates/goldenDiff.ts`, in `runGoldenDiff`'s empty-fixture
short-circuit) and a named local const in manager (`manager/src/components/templates/goldenReview.ts`).
Two authors, one magic value, no shared declaration — and manager's `no-fixtures` arm *and* its
`goldenBySlug` filter are correct only because they agree with a string the API writes. Change it on
one side and manager silently renders a fixture literally named `_` and reports `match` where it
should report `no-fixtures`.

**2. The precedence**, as a function over bare verdicts:

```ts
export function aggregateGoldenVerdict(
  verdicts: readonly GoldenDiffVerdict[],
): GoldenDiffVerdict | null
```

### 🔴 The signature decision the issue does not make — because the two functions do not agree

The issue asserts one shared precedence. Measured 2026-08-23, there are **three real differences**:

- **`no-fixtures` is not in the API's chain at all.** Its element type is
  `GoldenDiffFixtureVerdict = Exclude<GoldenDiffVerdict, "no-fixtures">`, and the empty-fixture case
  is short-circuited **upstream** in `runGoldenDiff` before any fan-out, then persisted as a
  synthetic single-entry array with `fixture: "_"`. Manager's extra arm is the *reader* side of that
  write, not a second copy of the same branch.
- **Manager returns `null`** for an absent/empty array — a sixth state meaning "CI has not run",
  distinct from `match`. The API has no null arm and no undefined input.
- Manager's arm is `rs.length === 1 && rs[0].verdict === "no-fixtures"`, so a sentinel riding
  alongside real results falls through to `match`. The API has no analogue.

**Resolve it this way:**

- **Take `readonly GoldenDiffVerdict[]`, not either repo's envelope.** The API's element is a local
  wire shape (`GoldenDiffFixtureResult`); manager's is core's `GoldenDiff`. A function over the
  verdict union alone serves both without importing either envelope.
- **Return `GoldenDiffVerdict | null`.** Keep the null arm — it is a real manager state with a test.
- **Do not let the API's call site collapse `null` to `"match"`.** It never sees null: the upstream
  short-circuit runs before fan-out, so the results array is non-empty by construction. Treat it as
  unreachable and say so in a comment. A silent `?? "match"` erases the one distinction manager
  depends on.
- **Keep the lone-sentinel arm.** Inert in the API (excluded by type), load-bearing in manager.

### ⚠️ Two constraints, one of which the issue would violate

- `src/utils/templates.ts`'s module header states: *"No runtime dependency on `@cfs/core/schemas`:
  the declared-param shape is accepted structurally so this module type-checks independent of the
  schemas publish cadence."* So `import type { GoldenDiffVerdict }` **only**. Importing
  `GOLDEN_DIFF_VERDICTS` (`src/schemas/template-version.ts`) as a runtime **value** breaks that
  stated invariant — if the union must be enumerated at runtime, restate it locally or pick a
  different module.
- 🔴 **`goldenBySlug` does NOT move.** The issue says it "also exists in both"; **it does not** —
  there is no `goldenBySlug` anywhere in api-cloudrun's `src`. It is manager-only with 3 call sites,
  and moving a single-consumer function into core adds a publish hop and de-duplicates nothing. It
  stays in manager and imports the sentinel from core.
  The api-cloudrun templates-editor-lifecycle plan carried this correction inline under P12 and the
  issue text reintroduced an error that plan had fixed. (That plan doc is **deleted** — P12 was its
  last code phase and this wave landed it.)
- `verdictLabel` in `manager/src/components/templates/goldenReview.ts` is UI copy — manager-local,
  leave it.

### Consumer side

- **api-cloudrun:** delete `aggregateVerdict`, repoint its single call in `runGoldenDiff`. ⚠️ A
  `{@link}` and two nearby comments reason about its `some(...)` semantics — they explain why the
  transient skip fires on ANY rather than EVERY fixture — and must be repointed, not deleted.
- **manager:** delete `aggregateGolden`, repoint
  `manager/src/components/templates/TemplateEditor.tsx` and
  `manager/src/components/templates/FixturesPanel.tsx`. Its docstring's *"Precedence mirrors the
  API's `aggregateVerdict`"* — a comment asserting agreement with another repo that nothing checks —
  goes away with it, which is the point.
- **Tests:** manager's `describe("aggregateGolden")` (7 cases, in
  `manager/src/components/templates/__tests__/goldenReview.test.ts`) is the ready-made suite — move
  it to core beside the function. The API has **zero** direct coverage today.

⭐ **Side win worth naming in the commit:** `aggregateVerdict` is untestable in api-cloudrun's unit
lane because its file imports the db module, and `api-cloudrun/tests/unit/dbReachCoverage.test.ts`
(the #279 ratchet) forbids any `tests/unit/**` file from transitively reaching it. Moving the
precedence to core makes it unit-testable there for the first time — the duplication was
*load-bearing for a test gap*, not merely untidy.

### ✅ Sequencing — RESOLVED before this wave ran

This section warned that manager had 4 unmerged commits on `feat/templates-editor-lifecycle` plus a
dirty worktree at `~/cfs-templates-editor`, and that deleting `aggregateGolden` underneath them
would generate conflicts. **Checked 2026-08-23: that work is merged.** The branch and the worktree
are gone in both `manager` and `api-cloudrun`, and no conflict arose.

### Release loop — the cheapest possible rehearsal

Loop steps 1-5 above. **No new pin line:** `@cfs/core/utils/templates` is already pinned in
`api-cloudrun/deno.json` and `templates/deno.json`, and manager's single alias covers it. Contrast
Wave 4, which adds a new `@cfs/core/schemas/testing` subpath and therefore a **new** line to bump —
which is exactly the case the remembered count gets wrong.

### Retiring the other plan doc

`api-cloudrun/.claude/plans/templates-editor-lifecycle.md` lists **P12 as its only outstanding code
phase**, and #68 **is** P12. Its only other ❌ is P0 — an operator UI action on a templates PR, not
code. So when this lands: delete that plan doc in the same commit and file P0 as an api-cloudrun
issue, per the `cfs-plan-docs` retire rule. **A stale plan reads as current intent.**

**Closes #68.**

## Wave 1 — core#58, doc identity (Phases 0 + 1)

Execute `core/.claude/plans/uid-convention-and-doc-identity.md` (208 lines, cold-startable). Do not re-derive it.

- **Phase 0** — write the `uid`/`uuid` convention into `core/CLAUDE.md` § *UID property naming* and
  `src/schemas/_uid.ts`'s module docstring. Documentation only. Shared premise for `api-cloudrun#506`.
- **Phase 1** in the plan's risk order: `1a` `webhook-events.id` (free) → `1b`
  `mcp-oauth-authorize-requests.id` (ship api-cloudrun + manager together) → **`1c` `sessions.id`** 🔴 →
  `1d` `OrderDocument` gains `uid` (backfill) → `1e/1f` prose + `deno task docs`.
- 🔴 **1c can break prod auth.** `getSession` is a bare cast, not a parse. **Purge the sessions
  collection as part of the deploy** — 1 prod user, one forced re-login.
- ⚠️ **1d's backfill keys on `ref.id`, never `orderDocumentId(data.name)`.**
- Re-measure Finding 2 first — the issue says 41 of 56, manager#300 measured **40 / 16**.

## Wave 2 — core#59 roles, with core#58 Phase 4 interleaved

Execute `core/.claude/plans/roles-campaign.md` (276 lines). **`roles.name` stays — decided.**

- **2a — #59 Phase 2:** one `RoleId` in `src/schemas/_uid.ts` replacing seven copies. **Drop underscores** so
  `RoleId` and `AnyUid`'s slug arm agree — verified today: `src/schemas/_uid.ts:163` allows `[a-z0-9-]` while
  `src/schemas/role.ts:65`/`src/schemas/session.ts:42` allow `[a-z0-9_-]`, so `on_call` **fails its own creation transaction**.
  All 6 live roles comply. ⚠️ `api-cloudrun/src/routes/roleAdmin.ts:425` is a bare inline `.test()`.
- **2b — #58 Phase 4:** make "which field is this doc's id" total. Ordered here because 2a is what
  turns the `roles.name` carve-out from documented into derivable.
- **2c — #59 Phase 3:** wire the existing `DELETE /admin/roles/{name}` (has a 409 guard, **zero
  callers**) into manager, then add the rename route. Seven write targets, six collections.
- 🔴 Failure mode is **silent de-privileging** — `permissionCache.loadRole` caches `{doc:null}` and
  `resolveUserPermissions` skips with no log, no metric. Create-new-first, delete-old-last.
  **Rehearse in dev**, then `api-cloudrun/scripts/audit-default-threads.ts` property 3 (MIRROR). **Not in prod.**

**Closes #58, #59.**

## Wave 3 — core#65, log index signatures (census first, then one cut)

1. **Census.** Point api-cloudrun's `@cfs/core/schemas/log` entry at a local core checkout, delete all
   22 signatures, `deno check`. Harvest the per-arm field list the 367 call sites actually supply.
   **That list is step 1's deliverable — write it down before writing schema.**
2. **Declare** every harvested field, including `collection`/`doc_id`/`operation` on
   `IntegrationEventLogRecord`, which the docstrings already admit ride the signature.
3. **Delete** the 22 signatures, publish, bump api-cloudrun, fix the residue.
4. Fix the stale docstrings (`src/schemas/log/integration-event.ts:255-266`, `src/schemas/log/domain-event.ts:180-188`) and the
   "24 arms / ~100 message types" figures in `api-cloudrun/src/lib/logger.ts:370,397`.

⚠️ **Manager and templates import no log schemas** — verified. Single consumer.

**Closes #65.**

## Wave 4 — core#53: split the seed helper

**#53's own proposed fix is refuted three ways.** A blanket `case "optional" → SKIP` (a) breaks
`tests/initial.test.ts:178` and `:216`, (b) deletes the `.nullable().optional() → null` behaviour
`src/schemas/order.ts:1144` calls load-bearing, and (c) 🔴 **breaks manager's create-product form at the first
keystroke** — `manager/src/components/products/DeliveryShipping.tsx` writes `setField("shipping.height", …)` unguarded, and Solid's
`setStore` throws descending into an `undefined` intermediate. No manager test covers it.

**⭐ The real fault line is document-schema vs input-schema, not form vs test.** Doc-schema seeds are
*unparseable but harmless* (only the `z.custom` timestamps are missing). Input-schema seeds are
*actively invalid* — `""` vs `.min(1)`/`z.uuid()`/`z.email()`, `[]` vs `.min(1)`. **Every workaround in
both repos is on an input schema**, discovered independently four times:
`manager/src/stores/transactions.ts:60-79` (a **production form** that abandoned the helper),
`manager/src/primitives/__tests__/createZodValidation.test.ts:5`,
`api-cloudrun/tests/integration/contacts/contacts.test.ts:12-16`, and
`api-cloudrun/tests/integration/stores/stores.test.ts:16-19` + `api-cloudrun/tests/integration/tracking-categories/trackingCategories.test.ts:18-21` (both patch `uid` because `FirestoreId`
walks to `""`). A form/test split fixes one of four.

### The design

`getInitialValues` **stays exactly as it is** (form seeding; manager's 11 live drafts want today's
output, materialized optional objects included). New subpath **`@cfs/core/schemas/testing`** — namespaced,
so manager's bundle pays nothing, matching the `src/utils/citations.ts` precedent.

```ts
getTestDoc<S>(schema: S, overrides?: DeepPartial<z.output<S>>): z.output<S>
getFullTestDoc<S>(schema: S, overrides?: DeepPartial<z.output<S>>): z.output<S>
export const mockTimestamp; export function tsAt(iso): FirestoreTimestampValue;
```

Five differences from `getInitialValues`, each with a caller behind it. **Both domain briefs converged
independently on 1, 3, 4 and 5** — that agreement is the main evidence the contract is right.

1. **Complete, not `Partial`** — kills ~40 downstream `as LineItem` casts in core and **33
   `as Record<string, unknown>` casts** in api-cloudrun, each of which erases every downstream type.
2. **Required-only; optional keys OMITTED, not recursed into.** This single change is the root fix.
   It deletes **27 `uid_thread: testFid()` repairs**, the `delete productBase.transaction`, the contacts
   empty-string filter, and core's 3 `uid_thread` repairs — all one cause (`src/schemas/initial.ts:34-37`).
   It also gives `omit(doc, k)` rejection for **every** `k` *by construction* — the `8bb64f7` property,
   and the defence **151 inline negative fixtures** currently lack.
3. **Every leaf parses against its own leaf schema** — generate-then-verify, using the leaf's own
   `safeParse` as oracle: try `""`, and on rejection walk a candidate list (20-char base62, uuid, `"x"`,
   email, ISO datetime, `1`). `""` for a `FirestoreId` is a valid *form input* and an invalid *document*.
4. **Honours `z.array(...).min(n)`** — 19 sites; `src/schemas/order.ts:1165` is the sole reason core's `minimalDoc`
   can't be a bare seed. ⚠️ Integration rates this **medium value only**: it buys parse-validity, not
   usefulness — a recursed `dates` block is epoch-valued and every order test overrides it anyway.
5. **`safeParse`s its own result and throws listing every failing path.** Load-bearing, not defensive:
   39 `.refine`/`.superRefine` sites across 11 schemas (`checkTaxAxes`, `checkItemContract`,
   `checkPriceBaseUnit`) are not derivable from structure. This is what turns `2915c782`'s *"nine
   fixture sites found by grepping `crms_store_id`"* into *"nine tests fail at construction naming
   `jurisdiction`."*

### 🔴 Timestamps are CALLER-INJECTED. Core must not fabricate them.

The two briefs **conflicted here and integration's argument wins.** Core's suite wanted the helper to
fill `z.custom` with a plain `mockTimestamp` (deleting 92 hand-written lines). It must not, because
**Firestore stores a plain `{seconds, nanoseconds}` as a MAP, not a Timestamp**, which silently breaks
three things at once in api-cloudrun:

- `tests/helpers/cleanup.ts:100-101` — `isEphemeralDoc()` is `c instanceof Timestamp && c.toMillis() >=
  RUN_FLOOR_MS`. A map-timestamped fixture is **invisible to the ephemeral filter**, so a parallel
  worker selects it as "a real order" — **api-cloudrun#278 reproducing**, the exact flake class
  `api-cloudrun/tests/helpers/fixtures.ts` exists to kill.
- `api-cloudrun/tests/helpers/setup.ts:127-129` — `createdByThisRun()` is the same `instanceof` test, so the fixture
  also **leaks past cleanup**.
- Any read doing `.toMillis()` throws.

**A value that parses and is wrong is worse than no value.** So: `options.now` carries the timestamp,
is **not defaulted**, and the universal `created_at`/`updated_at` pair is forced at compile time via
`TestDocOverrides<T> = Partial<T> & Pick<T, Extract<keyof T, "created_at"|"updated_at">>` — which
resolves to plain `Partial<T>` for input schemas, so `getTestDoc(CreateOrderInput, {})` still
type-checks. That intersection is **the one place a missing required field is a compile error rather
than a runtime throw**; `options.now` covers the remaining `*_fs` timestamp leaves. Core's own tests
pass `{ now: mockTimestamp }` and still lose their 39 relative imports.

### Three exports, each with callers found

- `getTestDoc(schema, overrides, options?)` — the above.
- `getFullTestDoc(...)` — also emits optional/`.default()` keys, for tests that need an optional field
  present (`product.webshop`, `order.tax_exempt`). Separate function, not a flag: the default must be
  the one that keeps negative tests honest.
- `getTestDocPartial(...)` — same walk, **no parse**, returns `Partial<z.output<S>>`. For the
  *deliberately* incomplete stand-in: `api-cloudrun/tests/integration/services/xeroInvoiceBody.test.ts:32-40` builds a 4-field Product because
  the function reads exactly four fields and says a fuller fixture "would hide which fields actually
  matter." Exists so those stop reaching for `as unknown as T`. A −0-line, +1-honesty change.

Overrides **deep-merge — objects merge key-wise, arrays replace wholesale**. Core's brief proved the
need (`totals: { ...totalsBase, subtotal_cents: 10000 }` at `tests/invoice.test.ts:66-72`,
`tests/order.test.ts:429-434`); with a shallow merge every such site keeps its spread and the win halves.

Deliberately **not** included, each because no caller was found across 200+ files: a union-arm selector,
an array-count parameter, a pluggable custom resolver, and any FieldValue-sentinel awareness (only 9
`FieldValue.*` uses in integration, none in fixture construction — ship it sentinel-unaware and say so).

### The aligned standard — three named contracts, one layer line

Seeding is ad hoc today: **five idioms across three repos** — `getInitialValues`+cast (42 integration
sites, 17 core sites), raw `ref.set()` (**171 blocks / 2,183 lines**, untyped and unvalidated),
`validateBeforeWrite`+`set` (~30 sites, the `templates/` subtree — the *only* idiom that would have
caught `2915c782`), `makeDoc` (7 sites), and hand-built full documents (31 core files, 55 per-file
`seed*` helpers in integration). The point of this wave is to collapse that to one per role.

| Contract | Exported from | Consumers |
|---|---|---|
| `getInitialValues` — form seed; bindable, **may not parse** | `@cfs/core/schemas` (unchanged) | manager's 11 live drafts |
| `getTestDoc` / `getFullTestDoc` / `getTestDocPartial` — fixture; **parses or throws** | `@cfs/core/schemas/testing` | all three repos' tests |
| `seedDoc(ref, Schema, overrides)` — construct → validate → track → write | **api-cloudrun only** | integration fixtures |

🔴 **`seedDoc` must NOT go in core.** It needs `firebase-admin` and `trackDoc`; `src/` is platform-free
by deliberate policy — manager pulls it into a **browser** and JSR serves it over `https:`. Core owns
schema-derived *construction*; each repo owns its own *write boundary*.

### Rollout
- 🔴 **`api-cloudrun/tests/helpers/makeDoc.ts` (58 lines) is DELETED, not re-exported and not wrapped.**
  It is already this idea with a weaker contract (`{...getInitialValues(s), ...o} as T` — no parse, no
  optional-omission, no leaf validity), and exporting it as-is would bless that. Its 7 call sites
  repoint to `getTestDoc`. **This is the pass/fail test on the API**: if `getTestDoc` is not a drop-in
  superset, this domain ends up with three idioms instead of two and the wave fails on its own metric.
- `api-cloudrun/tests/unit/` wants **nothing new** — 1 of 171 files calls the seed; point it at `getTestDoc`.
- **Then make `seedDoc` the only sanctioned way to write a fixture in api-cloudrun**, and ratchet it.
  That — not the line count — is what makes the next required field visible.
- 📝 **`core/CLAUDE.md` gains a § *Seeding: form values vs test fixtures*** — the three contracts, the
  layer line (why `seedDoc` cannot live in core), and 🔴 **why timestamps are injected rather than
  fabricated**. The last one is the highest-value sentence in the section: the hazard is invisible
  (a map-timestamped fixture parses fine and silently defeats both `isEphemeralDoc` and
  `createdByThisRun`), so nothing but prose will stop the next person "helpfully" defaulting it.
  `api-cloudrun/CLAUDE.md` and `manager/CLAUDE.md` each get a pointer, not a copy.
- **Delete ~9 dead `getInitialValues` calls in manager** (stores that pass `initialValues` but never call
  `newDraft`/`resetDraft`). Shrinks manager's real surface from 20 files to 11. Manager's 6 test files
  (`stores/__tests__/*`, `manager/src/primitives/__tests__/createZodValidation.test.ts`) move to `getTestDoc`.
- ⚠️ **Manager's form-seed cleanup is a FOLLOW-ON, sequenced after Wave 5 — not part of this wave.**
  Its one hard dependency on optional-object expansion is `ProductSchema.shipping`, which is a Wave 5
  make-required candidate (541 of 568 populated; 27-doc backfill). Once it is required the landmine is
  gone, and only then can `buildDefaultDocDates` (14 hand-written lines, `manager/src/stores/orders.ts:23-67`)
  and the no-op spread at `manager/src/stores/orders.ts:114-115` collapse. Order: **Wave 4 → Wave 5 → manager cleanup.**
- **Rewrite `api-cloudrun/src/services/eventCardReconcile.ts:160` as an explicit object literal.** Its
  docstring claims the seed spread prevents drift; it does the opposite — the spread guarantees a *key is
  present*, and presence is exactly what defeats the write-time validator, so a new required field lands
  as a fabricated zero (`""`, `0`, `[]`, or **the first enum member**) in prod with no alarm. An explicit
  literal makes core adding a field a compile error right there. Keep
  `api-cloudrun/tests/unit/eventCardReconcile.test.ts:119-125` pointed at the same values.
- **Fix `api-cloudrun/tests/unit/typeEscapeRatchet.test.ts`'s regex** — it requires `}` before `as unknown as`, so
  `}) as unknown as` and `] as unknown as` escape. ≥3 uncatalogued escapees, including
  `api-cloudrun/src/services/eventCardReconcile.ts:160` itself; the allowlist header's "src/ carries exactly two" is false.
- **Consider an input-schema arm.** `manager/src/stores/transactions.ts` and three test sites hit the same two bugs on
  `Create*Input`. Decide explicitly whether `getTestDoc` handles input schemas or a third entry point does.

### Estimated win — stated honestly, including where there isn't one

| Tranche | Scope | Lines |
|---|---|---|
| Core helper alone, api-cloudrun integration | 27 `uid_thread` repairs, 6 `uid` repairs, the `delete`, the contacts filter, the core#53 comment, 33 casts | **≈ 100** |
| Core helper alone, core's own suite | 92 timestamp lines, ~40 casts, 3 `uid_thread` repairs | **≈ 100–150** |
| With api-cloudrun's `seedDoc` on top | ~70 of 171 raw `.set()` blocks, at 12.8 → ~6 lines | **≈ 480** |
| Unlocked but not counted | 31 core files that hand-write full documents; 151 inline negative fixtures gaining a structural defence | 400–700 |

**Where there is no win, stated plainly:** a new required field is still **not a compile error** in the
general case — runtime-throw-at-construction is a real improvement over "grep and hope" but it is not
what `2915c782` asked for. The 55 per-file `seed*` helpers do **not** collapse (they encode per-suite
semantics); only their boilerplate goes. The `.min(n)` auto-fill is medium value at best. The minimal
stand-ins get no smaller and should not. Two of core's six utils test files gain **zero** —
`tests/order-lines.test.ts` drives `ProductDocument`, and **the entire hand-written Typesense `*Document`
family (all 20) has no runtime Zod schema**, so no schema-walking helper can reach any of them.
`ProductSchema` is Zod but a *different shape* (`_str` money mirrors, `_fs` epoch ints, geopoints as
`[lat,lng]`, computed rollups with no storage counterpart), and `typesenseSchemas.products.schema` is a
Zod-validated **config** — a field list, not a document validator. ⚠️ Deriving the document type from
the config was **measured and rejected** (`tests/typesenseFieldCoverage.test.ts:730-736`): it needs
`as const` on a published export, but JSR `no-slow-types` forces the `: TypesenseCollectionConfig`
annotation, which erases every literal field name to `string`.

⚠️ **Verify before committing to the contract:** nobody has empirically confirmed that a required-only,
leaf-valid, `.min(n)`-honouring build actually parses for each of the ~40 collection schemas. The known
static blockers are the 19 array `.min(n)` sites and 39 `.refine`/`.superRefine` sites in 11 schemas.
**Write that script first** — it is a measurement, not a guess, and it is what decides whether the
throw-with-issues path is a rare escape hatch or the common case.

**Closes #53**, and closes the four invalid-`Organization`-fixture defects by construction.

## Wave 5 — the optionality campaign (new work; only 3 api-cloudrun bugs get filed)

`getTestDoc` lands **before** this deliberately: a minimal-valid factory is exactly the tool that keeps
negative tests honest through a bulk tightening. That is the `tests/store.test.ts:8-17` lesson.

⚠️ **Preflight — pin the measuring instrument before the campaign starts.** This wave's whole
procedure is a before/after corpus measurement (5c), and its instrument is
`api-cloudrun/scripts/audit-schema-validation.ts`, which **api-cloudrun#636** rewrites: it resolves
collections from a hand-written ~40-entry list rather than from core's registry, and misses 10
schema-backed collections. Run #636's widened set **read-only** over prod and dev first and record
what it reports. Do **not** gate this wave on *fixing* #636 — if those collections are dirty,
repairing them is its own campaign. Gate only on knowing what it would say, so the instrument does
not move mid-campaign and make the commit-message numbers incomparable.
✅ Verified 2026-08-23: every collection this wave touches — `orders`, `invoices`, `contacts`,
`organizations`, `locations`, `taxes`, `products`, `tracking-categories`, `destinations`, `cards`,
`transactions` — **is** already covered, so the verification below stands as written. (#636's own
list is wrong on two entries: `cards` has been covered since 2026-04-20 and `fulfillments` since
2026-05-04, both predating the issue.)

**Census (done, 2026-08-23):** 333 optional paths / 211 declaration sites in the 56 document schemas
(the 668 figure splits **333 doc : 536 input**). Shapes: 158 bare, 126 `.nullable().optional()`, 49
`.default(x).optional()`. `.optional().nullable()` has **zero** instances and `.meta({initial})` is never
combined with `.optional()` — both already de-facto conventions worth writing into `core/CLAUDE.md`.

🔴 **The hard constraint, and the one that must not be got wrong:**

> **Any field written through a `FieldValue` sentinel must stay `.optional()`.** `validateBeforeWrite`
> (`api-cloudrun/src/lib/validate.ts:206-215`) **omits** top-level sentinels before parsing, then
> discards `result.data` and the caller writes the raw doc. So the field is *absent* at parse time.
> Requiring it turns every sentinel write into a 400. The strip is **top-level only** — a nested
> sentinel is not stripped and fails the parse.

Do-not-require list: `version`, `comment_count`, `seq`, `updates`, `reindex_attempts` (increment, 23
sites); `preview_role`, `chain_broken_at`, `lock`, `creating_cards`, `start_card`/`end_card`, comment
reactions (delete, 18); `recurrence_overrides`, `exception_dates`, `tags`, `query_by_tags` (array ops, 11).
**Timestamps are not at risk** — `serverTimestamp` has zero live call sites (3 mentions, all comments);
writers stamp real `Timestamp.now()` at 155 sites.

### 5a. DELETE the dead fields — split by KEY-presence first

⭐ **The delete test is key-ABSENCE, not value-absence, and the census measured the wrong one.**
A field no document carries **the key for** is dead. A field 876 documents carry **as `[]`** is not:
something wrote that key, so a writer exists and only the feature it feeds is missing. Two of the
original 18 were reclassified on exactly this ground (owner's call, 2026-08-23), and the schemas
corroborate it — `src/schemas/invoice.ts`'s own docblock records that *"82 prod invoices already
lack the field"*, i.e. the other ~876 were explicitly written an empty journal.

⚠️ **So the census below cannot be taken at face value.** It reports non-null *values*; entries
phrased *"0 non-null"* (`locations.uid_location_type`, `products.webshop.description`) do not say
whether the key is present. **Measure key-presence for all remaining candidates before deleting
any** — Firestore's discriminator is `orderBy(field)`, which excludes documents missing the field
while still including null-valued ones. A `select` projection cannot tell absent from null.

#### A. Keep — declared ahead of use (NOT dead)

- **`destinations.contacts` / `query_by_contacts`** — 192 docs present, 0 with an element.
  `src/schemas/destination.ts` declares both `.default([]).optional()`. The feature has not shipped.
- **`invoices.pdf_versions`** — 876 present, 0 with an element, and 82 invoices lack the key
  entirely. PDFs *are* generated (`pdf_generated_at` / `uploadcare_uuid` non-null on all 1,019); the
  version **journal** is created empty and never appended to. Whether that append path is still
  intended is a **product** question, not a schema one.
- 📝 **Record the reason in the schema, not only here.** Both declarations get a docblock line —
  *"declared ahead of use; no path appends to it as of 2026-08-23"* — because this plan doc is
  deleted when the wave lands and the next census will otherwise re-derive "dead" from the same
  numbers. That is 5d's rule applied to a *keep* decision rather than an optionality one.

#### B. File an api-cloudrun issue — key present, writer broken

Deleting the field would be the wrong repair. **One issue per item, census numbers and date in the
body**; do not fold them into a core schema wave — that is the scope-widening that makes a wave
un-shippable.

- **`organizations.last_order`** — written `null` on **all 291** docs, valued on none. Whatever was
  meant to stamp it never runs.
- **`destinations.query_by_organizations` mirror drift** — `organizations[]` non-empty on **436**
  docs, the mirror on only **171**. 265 destinations carry org refs the search mirror does not
  reflect. Needs a backfill as well as a fix.

#### C. Delete candidates — after confirming the KEY is absent

Take them as a single `feat(schemas)!:` commit.

- `orders.uid_store` — 0 of 994. `orders.created_by` — 0 of 994.
- `products.images` / `query_by_images` — 0 of 568. `products.webshop.description` — 0 non-null ⚠️.
- `contacts.uid_user`, `contacts.pronunciation` — 0 of 166.
- `cards.body`, `body_text`, `recurrence_parent_uid`, `recurrence_index` — 0 of 1,127.
- `locations.uid_location_type` — 0 non-null of 209 ⚠️.
- `taxes.xero_components` — **11 present, all `[]`** ⚠️ — by the rule above this is a *bucket A or B*
  candidate, not a delete. Establish which writer emits the empty array first.
- `transactions.reverses` — 0 of 930.

⚠️ Two further tests before deleting any of these. (1) *Is the field dead, or is its writer broken?*
(2) *Is it dead, or merely unbuilt?* `cards.body`/`body_text`/`recurrence_*` are 0 of 1,127 because
the whole prod card corpus is machine-generated from orders and the hand-authored path has never
run — which is question (2), a **product** question, not automatically a delete.

#### 🔴 If any key-present field is ever deleted, purge the key in the same release

Every top-level document schema is `z.strictObject` (`src/schemas/tax.ts`, `src/schemas/destination.ts`,
`src/schemas/invoice.ts`, `src/schemas/organization.ts`, `src/schemas/order.ts`, `src/schemas/card.ts`).
Delete a field whose key is still stored and every such document becomes an `unrecognized_keys`
failure:

- `api-cloudrun/scripts/audit-schema-validation.ts` and `POST /admin/validate-collection` go red for
  that collection — the very tools this wave uses to prove itself, reporting a failure this wave caused.
- 🔴 **`validateBeforeWrite` parses the whole document** (`api-cloudrun/src/lib/validate.ts` — it
  strips top-level `FieldValue` sentinels into `cleaned`, then `safeParse`s it), so any
  **read-modify-write** path over those docs is refused outright. Writers that rebuild the document
  from typed code are unaffected and drop the stale key on their next full `set()`.

The repair is 5c's shape applied to a deletion: **purge the key with `FieldValue.delete()` before or
in the same release as the schema change**, named in the `BREAKING CHANGE:` footer. 5c establishes
this for tightening; it had no deletion arm.

### 5b. Tighten, in three tiers
- **Tier 1 — inert defaults (49 sites).** `.default(x).optional()` where the default **never
  materializes on a write** (the doctrine in `src/schemas/initial.ts` and `tests/typesense-parity.test.ts`). The source
  reads as though a value is guaranteed and it is not. Cleanup, not a data risk.
- **Tier 2 — accidental optionality (2 sites).** `product.description` and
  `tracking-category.crms_product_group_id` are **required on their own create input**. Nothing can
  create the document without them.
- **Tier 3 — clean-corpus candidates.** Measured at 100% today: `orders.crms_id`/`crms_status`/
  `uid_thread`/`xero_id`, `invoices.due_date`/`due_date_fs`/`subject`/`uid_thread`,
  `contacts.crms_id`/`uid_thread`, `organizations.uid_thread`, `locations.name_key` (the backfill its
  docblock mentions is **complete** — 209/209), `taxes.effective_from`, `products.price.coa_revenue`.
  NEARLY (needs a 1–27 doc backfill): `products.xero_code` (1), `invoices.crms_id` (1),
  `orders.organization.xero_id` (1), `products.uid_thread` (10), `products.shipping` (27).
- ⚠️ **`cards.destination`/`organization` are 100% and must NOT be required** — the entire prod corpus
  is machine-generated from orders, so 100% is evidence about the generator, not about the document.
- **Untestable by filter:** anything inside an array of maps (`orders.items[].*`, `invoices.items[].*`,
  `products.components[].*`). Needs a paged projection.

### 5c. The procedure (already established — 5 prior commits, don't reinvent)
**Measure the corpus, prod and dev, and put the numbers and date in the commit message** — that is the
branch point. Clean → tighten in one commit (`8bb64f7`). Dirty → **expand → backfill → tighten**, naming
the backfill in the `BREAKING CHANGE:` footer (`affb480`). **Required, never `.nullable()`**. **Never
`.default()` as the cushion.** Tighten the input schemas in the same commit. Drop the `?` on the
interface. ⚠️ **Expect fixtures the compiler cannot see** — `2915c782` found **nine** raw `ref.set({…})`
sites needing a new required field, and *none* was a compile error; they were found by grep.

### 5d. Write down the conventions the corpus already follows
166 of 211 declarations carry **no stated reason** for their optionality. The 45 that do are uniformly
excellent — each cites a corpus count and names its expand/migrate/contract step. Promote that to a rule
in `core/CLAUDE.md`, along with nullable-inside-optional and "null when absence would be a lie".

## Wave 6 — core#56 + core#60 (one publish), and file the split-brain issue behind them

### 6a. File the split-brain issue — do NOT hand-write 22 Zod schemas

⚠️ **An earlier draft of this wave proposed hand-writing `z.ZodType<XDocument>` for all 22. That is the
wrong shape and is dropped.** Typesense is a *derived* artifact, so a hand-maintained Zod copy entrenches
the duplication instead of removing it, and its own `pii` meta would be a second source of truth for a
classification the storage leaf already carries.

**The root cause, which explains core#57, core#60 and `getTestDoc`'s blind spot at once:** the projection
is **declared in core** (22 configs + 20 hand-written `*Document` interfaces) but **transformed in
api-cloudrun** (`api-cloudrun/src/lib/typesenseTranslate.ts` — `translateForTypesense`, `postProcess`). The
transformation *is* the definition of the projection, so **neither repo can derive the documents**: core
has the declarations and not the transform, api-cloudrun has the transform and no reason to own the types.

**What unblocks it — measured:** the transformation is already platform-free and already half in core.

| Module | Lines | Deps |
|---|---|---|
| `api-cloudrun/src/lib/typesenseTranslate.ts` | 441 | core's typesense configs, **core's `deriveOrderDateEnvelope`**, + 2 local |
| `api-cloudrun/src/lib/moneyMirrorString.ts` | 91 | **core's `formatCents`** only |
| `api-cloudrun/src/lib/testDocIds.ts` | — | **no imports at all** |

**Zero firebase-admin.** Timestamps are handled by a structural duck-type
(`isTimestamp(value): value is { toMillis(): number }`), the same technique as core's own
`FirestoreTimestamp` `z.custom`. So core's platform-free policy does **not** block the move.

**Scope of the issue:** move `typesenseTranslate` + `moneyMirrorString` into core on their own subpath
(`isTestDocId` stays in api-cloudrun — an env concern — injected as a predicate). Then:
- **`getTestDoc` reaches Typesense documents for free** — `translate(getTestDoc(ProductSchema))` — which
  is the *only* thing that fixes `tests/order-lines.test.ts`'s zero-gain.
- The parity arm stops **regex-scraping interface source** and checks the **real transformation**.
- **PII derives through the translation** from the storage leaf that already carries it — the cheap,
  correct version of the finding, with no second classification table.
- api-cloudrun and manager cannot disagree about the projection — the `src/utils/order-lines.ts` rationale verbatim.

⚠️ **Two things this does NOT solve, state them in the issue.** (1) The static `XDocument` **type** still
cannot be derived — JSR `no-slow-types` forces the `: TypesenseCollectionConfig` annotation, erasing
literal field names (`tests/typesenseFieldCoverage.test.ts:730-736`). The interfaces stay hand-written;
they just become *verifiable against the real transformation* instead of against a regex. (2) It is **not
a licence to parse at the Typesense boundary** — an outbound parse must model the 19 computed rollups,
`_str` mirrors and `_fs` companions exactly or it **stops indexing in prod**; an inbound parse would throw
on documents written under an older schema and **break search for historical rows**. Shadow-mode only, later.

⚠️ **Correct the premise while scoping:** Typesense is *derived from* Firestore but **not a 1:1
projection** — `TYPESENSE_ROLLUP_COLUMNS` holds 19 computed fields with no storage counterpart, plus the
`_str` and `_fs` families. A field-level derive would miss them; a **transformation-level** derive is
exactly what handles them, which is the argument for moving the transform rather than mapping fields.

⚠️ **Bundle:** put it on its own subpath. Manager imports `@cfs/core/schemas/typesense` for **types only**
today (erased); a transformation module is real bytes — the propagation-catalog lesson.

**Context to put in the issue body, since it explains why nobody noticed:** Firestore already enforces
"every collection has a Zod schema" *by construction* — `src/schemas/mod.ts:1260` declares
`schemasTyped: { [C in CollectionName]: z.ZodType<CollectionDocs[C]> }`, a mapped type over every
collection name, so a key without a schema is a compile error. (`UNVALIDATED_COLLECTIONS` —
`trello-lookup`, `config`, `templates-publish-seq` — is a *write-path* exemption, not a missing schema.)
The Typesense family is the **one** document family outside that guarantee, and it is outside it because
it is derived, not because it was forgotten.

⚠️ **Fold in the Typesense type-fidelity finding as a SUB-SCOPE, do not file it separately.**
`ProductDocumentComponent.inclusion_type` is declared `?: string` in
`src/schemas/typesense/documents.ts` where the storage leaf is an enum — a looseness nothing
catches today, because core#57's parity arm compares field NAMES and not types, so it passes
cleanly. It is the same root cause as everything else in 6a: the projection is declared here and
transformed in api-cloudrun, so neither side can check the other. Filing it as its own issue would
make this ledger −4 instead of −5 while adding no information. (Raised by the api-cloudrun#442
planning session, verified against HEAD.)

**Ledger effect: this is a 4th filed issue, so the net becomes −4.** Worth it — it is the root cause
behind three existing issues, and scoping it may change what #60 should eventually look like.

### 6b. core#56 — the fee pricing level mismatch

- **#56** — widen `calculateTransactionFeeAmountCents` (`src/utils/orders.ts:753`) and `isTransactionFeeItem`
  (`:558`) to `PricingItem`; add `isTransactionFeePricingItem`, mirroring the `isPreTaxItem` /
  `isPreTaxPricingItem` pair at `:569`/`:589`. Consider pulling up `isFromTotalItemType`. Then delete the
  `uid:""`/`name:""`/`path:[]` shim and `isTransactionFeeLine`.
- 🔴 **The api-cloudrun half is NOT ours to do — it belongs to
  `api-cloudrun/.claude/plans/line-price-single-author.md`** (api-cloudrun#570). That plan's Step 1
  **is** this wave, and its Step 3 absorbs the whole of `transactionFeeLine.ts` into a new
  `api-cloudrun/src/lib/linePrice.ts` — **not yet written**, which is why that path does not resolve
  today — rather than editing it in place. ⚠️ Cited without a line number deliberately: a
  `path:N` into another repo's plan resolves as long as the file is long enough, which is never what
  the claim means — the same reason `enforced_by` bans the form. So this wave stops at core's boundary:
  widen the two functions, publish, bump the pins. Deleting the shim from here would put two owners
  on one file.
- ⚠️ **This wave and #570 have a hard ordering: #570 runs AFTER Wave 6**, because its Step 1 depends
  on the widened `PricingItem` API this publishes.
- ⚠️ **The citation gate makes that ordering load-bearing, in both directions.**
  `api-cloudrun/scripts/gate.sh` runs `audit-plan-citations.ts --strict` cross-repo, and core's own
  `deno task audit:citations --strict` does the same from `.githooks/pre-push`. Any doc citing
  `transactionFeeLine.ts` by path — this roadmap did, and the `cfs-money` skill cites its test —
  goes RED the moment #570 deletes it. Those edits must land in the same commit stack as the
  deletion, which is why the paths above are named in prose rather than cited.
### 6c. core#60 — scoped as originally filed, and worth doing regardless of 6a
`cards` is `enabled: true`, live with 1,097 prod docs, and **unreachable from manager's typed search
surface** — every typed consumer is generic over `keyof TypesenseDocumentMap`. That gap is real whatever
happens to the split-brain issue, and the fix is cheap.
- Add `CardDocument` (~24 fields) and `ThreadDocument` (16) as part of the 22, plus both map keys.
- Add the arm asserting `keyof TypesenseDocumentMap` equals the declared alias set — after the parity
  arm at `:754`, reusing `typesenseSchemas` (`:66`) and `aliasCandidatesFor` (`:746`) in reverse.
  **Pair it with a companion that proves it can fail**, and **bump the `blocks.length >= 18` vacuity
  guard at `:766`**. **Assert all 22 aliases** — `enabled` defaults to on and `bookings` is disabled
  *and* present, so the map is about type reachability, not liveness.
- ⚠️ `CardDocument` must mirror the translation conventions: **`date_fs` (int64), not `dates.start`**;
  `address_coordinates` is a geopoint → `[lat, lng]`; `created_at`/`updated_at` are `int64`.

### 6d. Derive `SchemaDocType` from the registry instead of hand-writing it

Folded in from the api-cloudrun#444 planning session (work item A), and **rides Wave 6's publish —
it does not get a beta of its own.**

`SchemaDocType` (`src/schemas/mod.ts`) is a hand-written 56-member union of every document type,
sitting a few hundred lines below `CollectionDocs`, which already knows all of them. It becomes
`CollectionDocs[CollectionName]`.

- **Measured a no-op.** The only textual difference against the hand-written union is the
  `Destination` / `DestinationDocType` import alias. Nothing else in the expansion moves.
- The value is that the two lists **cannot drift**: a new collection currently needs an edit in both
  places, and only one of them fails to compile if you forget.
- ⚠️ **Re-derive the line refs off beta.244** — that region moved this session when a stale core#44
  claim in its docblock was corrected.
- ⚠️ **Run `deno task check:declarations` before settling the shape**, and **expect a no-op**:
  `CollectionDocs[CollectionName]` is an indexed access over a written-out mapped type, so nothing
  needs inference to expand. If it *does* fire, that is a real finding about the registry — not a
  reason to revert to the hand-written union. The gate matters here because a derived type whose
  declaration needs inference does not fail to publish; it publishes a DIFFERENT, wrong type to
  manager only, which this package has shipped twice.
- **Line refs, verified at `25b69b8`:** `SchemaDocType` is `src/schemas/mod.ts:1041` (the thing this
  replaces) and `CollectionDocs` is `:1155`. ⚠️ Those are two different symbols and were briefly
  conflated in cross-session coordination — `:1041` has always been `SchemaDocType`. Re-derive off
  whatever you actually commit rather than off either number.

**Closes #56, #60.**

### Downstream — which wave unblocks or perturbs which api-cloudrun plan

Coordination map, so neither side edits the other's file. **api-cloudrun owns everything in the
right column**; this roadmap owns core.

| This wave | Effect on an api-cloudrun plan |
|---|---|
| **Wave 3** (core#65, log index signatures) | 🔴 **api-cloudrun#442 and #444-B run BEFORE this wave, deliberately.** Wave 3 touches 367 log call sites across 104 files and would churn the api-cloudrun lines those two plans cite. They need nothing from core — `CollectionDocs` / `CollectionName` / `DocFor` are already in the beta.244 pin — so there is no reason for them to wait. |
| **Wave 5** (optionality) | Same: its tightening churns the same api files. Same ordering — #442 / #444-B first. |
| **Wave 6b** (core#56) | **Hard blocker for api-cloudrun#570 Step 1.** #570 runs after Wave 6. Its Step 3 absorbs `transactionFeeLine.ts` wholesale, so this wave must not touch it. |
| **Wave 6a** (Typesense split-brain issue) | Carries #442's `inclusion_type` fidelity finding as a sub-scope rather than a fifth issue. |
| **Wave 6d** | Is api-cloudrun#444 work item A, relocated here to ride Wave 6's publish. |
| **Wave 4** (`getTestDoc`) | Shares `typeEscapeRatchet.test.ts` with #442 §E and #444-B — see the hygiene note. |

⚠️ **The citation gate couples the two repos both ways.** `api-cloudrun/scripts/gate.sh` runs
`audit-plan-citations.ts --strict` cross-repo, and core's `deno task audit:citations --strict` runs
from `.githooks/pre-push`. So a file deleted in one repo turns a doc in the other RED. Any plan that
deletes a cited path must land its doc edits in the same commit stack.

## Wave 7 — remainder of core#54 and core#44

- **#54 item 5 — drop the full suite from `.githooks/pre-commit`.** Biggest real win now that the suite is
  15.5 s: a 5-commit-1-push session runs it 8 times. Keep `lint`, `check`, `docs` (docs must stay ahead of
  the `git add`).
- **#54 item 4 — invert it.** Do **not** just drop `push` from `.github/workflows/ci.yaml`. Either add Citations to
  `.github/workflows/publish.yaml`'s `ci` job, or — better, and in this repo's idiom of deleting the thing that requires a
  second copy — extract one reusable `workflow_call` job. Note they also differ in `permissions`.
- **#54 item 2 — close as refuted** with the measurement.
- **#54 item 3 (`--parallel`)** — ~5 s off 15.5 s at 2 vCPU. Take it or record it as declined.
- **#44 part 1 — file the upstream report.** Declined at one instance; there are now two.
- 📝 **`core/CLAUDE.md:23-28`, the `audit:citations` entry.** It states the audit *"Runs in
  `.githooks/pre-push` and in `.github/workflows/ci.yaml`"*, and the following lines lean on the CI run
  being **"the STRONGER one."** Both moves above relocate that step — name the new home (the reusable
  `workflow_call` job, or both workflow files). In the same commit record the pre-commit change: the
  hook now runs `lint`, `check` and `docs` only, with the suite moved to CI/pre-push, **keeping** the
  note that the `docs` step must stay ahead of the `git add`.

**Closes #54, #44.**

---

## Issue ledger — the net, stated up front

**Closed: all 9.** #68 (Wave 0.5) · #58 + #59 (Wave 2) · #65 (Wave 3) · #53 (Wave 4) ·
#56 + #60 (Wave 6) · #54 + #44 (Wave 7).

**Filed: 4.** Three from Wave 5a that a core schema wave must not absorb —
`organizations.last_order` never stamped (writer bug), the 265-doc `destinations.query_by_organizations`
mirror drift (writer bug + backfill), and `invoices.pdf_versions` (**not** a writer bug: the journal is
created empty and never appended, so the issue asks whether that append path is still intended) — each
with the census numbers and the 2026-08-23 date in its body. Plus **the Typesense split-brain issue
(Wave 6a)**, the root cause behind #57, #60 and `getTestDoc`'s blind spot, which needs its own sitting.

⚠️ **`destinations.contacts` / `query_by_contacts` gets NO issue** — it is a known, accepted
declared-ahead-of-use state, recorded as a schema docblock line instead (5a bucket A). Do not file
one on the next census.

**Deliberately not filed:** the dead-field deletions (Wave 5a does them), the tightening campaign
(Wave 5 does it), the four invalid fixtures (Wave 4 fixes them by construction), and the two
declared-ahead-of-use keeps (5a bucket A — schema docblocks, not issues).

**Net: −5.**

## Issue and doc hygiene

- Post the measured corrections as **comments** on #54, #65 and #53 before starting each wave — the trail
  matters more than the edit.
- 🔴 **Four live invalid fixtures found during this review** — fixed by construction in Wave 4, so no
  issue needed, but check them explicitly when that wave lands. `OrganizationSchema`
  (`core/src/schemas/organization.ts:114`) is a `z.strictObject` with **no `notes`, `active`, `tags`,
  `query_by_tags` or `type`. Four api-cloudrun fixtures write them anyway** —
  `invoices/invoiceTransitions.test.ts:92-93`, `creditNotes/creditNotes.test.ts:73-74`,
  `invoices/invoices.test.ts:112-114`, `services/orgXeroSync.test.ts:45-49`. Every one is an
  `unrecognized_keys` failure `validateBeforeWrite` would refuse; three write raw and untyped, and the
  fourth is annotated `const orgDoc: Organization` **and then `as unknown as Organization` at :56**,
  which defeats the annotation entirely.
- **`api-cloudrun/tests/unit/typeEscapeRatchet.test.ts` has THREE claimants — coordinate, do not
  race.** Our bullet is the regex fix (also listed in Wave 4): it requires `}` before
  `as unknown as`, so `}) as unknown as` and `] as unknown as` escape. api-cloudrun#442's plan adds
  an `as unknown as <document type>` arm scoped to `src/`, and api-cloudrun#444-B rewrites the very
  cast that file allowlists. **The regex fix belongs with #442's arm**, since both edit the same
  predicate and doing them separately means one rewrites the other. We keep only the *reason* it
  matters here: it is what stops the `eventCardReconcile` rewrite in Wave 4 silently regressing.
- **Delete `notes/table-cell-linkTo-migration.md`** — April 2026, tracked by no issue, and overtaken:
  `manager/src/components/TableCell.tsx:123` reads `column().meta.linkTo` and `:146` says the substring dispatch must not
  "grow back."
- **Delete both campaign plan docs** in the commit that lands their last phase (Waves 1, 2).
- **Two api-cloudrun issues are deliberately OUT of scope, for different reasons.**
  **#637** (dev census exits 1 — 14 dev-native orphan docs, one leaked test collection) has no core
  content, no publish and no coupling to any wave; it pairs with #636 as one small api-cloudrun
  sitting. ⚠️ Its item-2 premise is stale — the holidays test's `finally` already wipes all three
  suffixed collections (since 2026-06-30, moved into `finally` 2026-07-09), so the open question is
  *why one survived a teardown that runs*, not *add a teardown*.
  **#636** is out of scope but **sequenced** — see the Wave 5 preflight above.
- **Branches — nothing outstanding.** Both `feat/templates-editor-lifecycle` branches and the
  `~/cfs-templates-editor` worktree are gone; manager's 4 commits merged. The unrelated api-cloudrun
  commit noted here has been pushed by another session.
- ⚠️ `templates` is normally checked out on a user draft branch (`ci/citation-gate` today), which is
  exempt from hygiene but **will misreport the core pin version and count** if read instead of
  `origin/main`.

## Verification

- **Every wave:** `deno task check && deno task lint && deno task test`, then `git status --short`
  **clean** — that property does not hold today and is what Wave 0a buys.
- **Wave 0:** three consecutive clean `deno task test` runs; suite passes without `--allow-run
  --allow-write`; the declarations gate goes **red** when an un-annotated `parentable_by: LINE_PARENTS`
  row is restored.
- **Wave 0.5:** the issue's own test — delete `aggregateGoldenVerdict`'s body in core and confirm
  **both** repos' suites fail; if only one does, the implementation is not actually shared. Then
  confirm `api-cloudrun/tests/unit/dbReachCoverage.test.ts` stays green with the API's new unit test
  in place, and that the `sed` moved **all** of `templates/deno.json`'s core pins off `beta.240`.
- **Wave 1:** the `uid === ref.id` guard at each write, then `POST /admin/validate-collection` for
  `documents` with `useCollectionGroup: true`, expecting zero invalid.
- **Wave 2:** parse every live role name in both environments through `RoleId`; parse `on_call` through
  `RoleSchema` **and** `DocSource` and confirm they agree. Then the dev rehearsal.
- **Wave 3:** `deno check` api-cloudrun clean; a deliberately misspelt field is a compile error.
- **Wave 4:** the "does every collection schema's minimal fixture parse" script is the gate. Then confirm
  `omit(doc, k)` is rejected for every `k` on every schema.
- **Wave 5:** `api-cloudrun/scripts/audit-schema-validation.ts --only=<collection>` and
  `POST /admin/validate-collection` before **and** after each tightening.
- **Wave 5a:** for every field deleted, `orderBy(field)` must return **zero** documents in prod and
  dev *before* the schema change — that is the key-absence proof the value census cannot give. If a
  key-present field is deleted anyway, the same two tools must be as clean after the change as
  before it; a red run means the `FieldValue.delete()` purge did not reach every doc. Rehearse the
  whole delete-plus-purge in dev first.
- **Wave 6:** the new Typesense arm fails when a `TypesenseDocumentMap` key is removed.
- **Cross-repo:** `deno install --frozen` (api-cloudrun), `npm install` (manager), `deno task
  lint:fixtures` (templates) after its pin PR.

## Context recommendation

**CLEAR CONTEXT.** This doc plus `core/CLAUDE.md` and the two committed campaign plan docs is enough to
execute cold, and Wave 1's session-purge sequencing wants a fresh window rather than one already spent
verifying eight issues and running six exploration agents. Start at Wave 0 (or Wave 1 if you skip it).
