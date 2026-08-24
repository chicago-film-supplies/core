# Roadmap: the 9 open `core` issues, plus the two campaigns that came out of reviewing them

**Date:** 2026-08-23 • **Repo:** core (+ api-cloudrun, manager, templates) • **Status:** 🚧 Waves 0 · 0.5 · 1 · 2 · 4 landed; Wave 3 deferred; **Wave 5 is COMPLETE (5a · 5b · 5c · 5d)**; Wave 6 is next
**Ordering:** risk-first (owner's call), with one half-sitting prerequisite ahead of it (Wave 0 — drop it if you disagree with the reasoning there).

> ## ⚠️ STATUS UPDATE 2026-08-23 — Wave 5 is DONE. Wave 6 is next.
>
> *(One compacted block, not a stack — per `cfs-plan-docs`. This is the current state; earlier
> per-wave updates are folded in.)*
>
> | Wave | State |
> |---|---|
> | **0a** non-destructive staleness tests | ✅ core `b640b62` |
> | **0b** declarations gate | ✅ core `80144dc` |
> | **0c** templates pin count | ✅ `89e8dc0`, corrected twice more |
> | **0.5** core#68 golden aggregate | ✅ **#68 CLOSED** |
> | **1** core#58 Phases 0 + 1 (incl. 1c) | ✅ shipped **to prod**, both migrations run |
> | **2a** core#59 `RoleId` | ✅ core `976646a` |
> | **2b** core#58 Phase 4 (core half) | ✅ core `019e45d` |
> | **2c** core#59 Phase 3 (API half) | ✅ api-cloudrun `5aa19607` |
> | **3** core#65 log signatures | ⏸️ **DEFERRED** — census done, prescribed fix refuted |
> | **4** core#53 `getTestDoc` | ✅ **#53 CLOSED** — core `3ff0298`, api `04b06c9d`, manager `56e41fd` |
> | **5a** delete the dead fields | ✅ **DONE, and it deletes NOTHING** — all 14 candidates refuted, core `0b7e6e6` |
> | **5b** tighten, three tiers | ✅ **DONE** — core `86df446` `59fcf7b` `9704dee` `eada285` |
> | **5c** the procedure | ✅ applied per tier; **5d** ✅ written into `core/CLAUDE.md` |
> | **6 · 7** | ⏳ **NEXT** |
>
> ### 🎯 Wave 5b's result — read this before re-proposing anything
>
> **Tier 1 (49 paths / 21 declarations + 2 input): all deleted.** `.default(x).optional()` is
> `Optional(Default(x))` — the outer node short-circuits, so the default fires **nowhere**, not even
> on a parse. Every one named the value its own leaf type already derives, so `getInitialValues` was
> proved byte-identical across all 252 exported schemas. `tests/inert-defaults.test.ts` is the
> ratchet, with the construct planted in eight container shapes.
>
> **Tier 2: one of two.** `products.description` required (568/568 both envs).
> `tracking-categories.crms_product_group_id` **refuted** — 18/20, and the two holdouts are SERVICE
> groups that `crmsProduct.ts` reads. The defect is on the input; filed as **api-cloudrun#652**.
>
> **Tier 3: nine of eighteen.** Required now: `orders.crms_id` (nullable) · `orders.uid_thread` ·
> `invoices.subject` (nullable) · `invoices.uid_thread` · `contacts.uid_thread` ·
> `organizations.uid_thread` · `taxes.effective_from` (nullable) · `taxes.xero_components` ·
> `products.price.coa_revenue` (+ **both** product inputs — it was an erasure path, since
> `UpdateProductInput.price` is a whole-object replacement).
>
> 🔴 **The nine refusals are the more valuable half, and each is now a docblock beside its field.**
> - `orders.crms_status` (995/995) and `invoices.crms_id` (1,019/1,019) are facts about the CRMS
>   INGEST. `createOrder` stamps no `crms_status`; `createInvoice` stamps no top-level `crms_id`.
>   Requiring either 400s the native create path. ⚠️ `orders.crms_id` reads **identically** and IS
>   required, because `createOrder` writes an explicit `null` — same census, opposite verdicts, and
>   only the writer separates them.
> - `orders.xero_id` and `orders.organization.xero_id` were **already non-optional** — stale entries.
> - `invoices.due_date`/`due_date_fs` — removed by the manager#326 decision (below) and independently
>   by `createInvoice`, which writes neither key when no due date is supplied.
> - `contacts.crms_id` 166/166 prod but **166 of 178 dev**; `locations.name_key` 209/209 vs **209/210**.
>   Prod-only measurement would have shipped both.
> - `products.xero_code` (567/568) · `uid_thread` (558/568) · `shipping` (541/568) — backfill first.
>
> **Verification actually run**: every document in prod AND dev re-parsed against the tightened
> schemas offline — 995 orders, 1,019 invoices, 166/178 contacts, 291/313 organizations, 11 taxes,
> 568 products — zero failures either side. Tool: `api-cloudrun/scripts/audit-field-presence.ts`
> (key-presence) plus an offline parse pass.
>
> ⚠️ **Two test files were found already passing for the WRONG reason** — `contact.test.ts`'s four
> rejection cases and `organization.test.ts`'s "rejects additional properties" each omitted fields
> that were required long before this wave, so each asserted "rejects SOMETHING". Both now build from
> a minimal-valid factory. **The change that would have hidden this permanently is the change that
> surfaced it.**
>
> ### Folded in from outside the roadmap
> **manager#326 — `UpdateInvoiceInput.due_date` takes `null` as a CLEAR VERB** (core `157dd10`).
> Wire-level only: `Invoice` and `CreateInvoiceInput` are deliberately NOT widened, so a cleared
> invoice loses both keys rather than storing null. Storing null would put an explicit null on an
> `int64` Typesense field, a path **nothing in either corpus has ever exercised**.
> 🔴 **Carried obligation, ships with the pin bump:** `updateInvoice`'s
> `if (input.due_date !== undefined)` arm stamps `due_date_fs = 1970-01-01` on a null, into the field
> `serverSortVia` sorts on. Do not ship the pin without the guard.
>
> ### What is still left on the three "closed" campaigns
> - **#58** — the CONSUMER half of Phase 4: widen `assertValidForWrite` / `assertValidPatch` in
>   api-cloudrun to read the declared `.meta({ idField })`. Core declares it; nothing reads it yet.
> - **#59** — the manager UI, filed as **manager#321**. The API surface is complete.
> - **#53** — the fixture MIGRATION: **api-cloudrun#647** and **manager#322**.
>
> ### Corrections this campaign made to its own plan — do not re-derive
> - **0b's prescribed fix for `schemas/common.ts` does not work.** The diagnostic is on the USE site,
>   so the reference must leave the `as const`.
> - **The declarations gate is a TASK, not a test** — `npm:typescript` reads `process.env`.
> - **0a needed `--allow-run` removed, not `--allow-write`** — a spawned child carries its own perms.
> - 🔴 **The templates pin count is BRANCH-DEPENDENT.** Read the version off `origin/main`, bump by
>   `sed` over the pattern, carry no count. ⚠️ **And a pinned VERSION is as perishable as a count** —
>   read the pin, never the plan.
> - **Wave 1's "legacy auto-id tail" DOES NOT EXIST** — prod is `{"2": 994}`.
> - 🔴 **Wave 5a deleted NOTHING and that was correct** — all 14 candidates refuted, 9 key-present and
>   5 with live writers. Per-field verdicts are docblocks (core `0b7e6e6`); method is
>   `core/CLAUDE.md` § *"Is a field dead?"*.
>
> ### Cross-repo findings worth carrying
> - 🔴 **`cardCascade.ts` — the plan's own recommended structural template — has a read-derive-write
>   with NO precondition**, and following it reproduced api-cloudrun#643's prod-corrupting bug.
>   Ranked list: **api-cloudrun#644**. ⭐ **A template propagates its defects along with its shape.**
> - ⚠️ **`set()` accepts no `Precondition`** — only `update()`/`delete()` do. Whole-document replace
>   needs a transaction.
> - ⚠️ **A ratchet with a hole reports CLEAN, not smaller.** Same shape as the fixed-point `path`
>   guard: a guard that can only consult its own oracle is not a guard.
> - 🔴 **A raw `ref.set()` fixture is unvalidated by construction, and a WHOLE-OBJECT override is
>   where a required field goes to die.** Found by reconstructing the seeder's output and parsing it
>   OFFLINE — the suite cannot see it, because the suite exercises the write and the write is what
>   skips validation.
>
> ### Issues filed across this campaign
> api-cloudrun **#640 #641 #643 #644 #645 #647 #649 #650 #651**, and **#652** (tracking-category
> service groups, filed by Wave 5b) · manager **#321 #322**.


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

## Wave 3 — core#65 — ⏸️ **DEFERRED 2026-08-23. Census done; the prescribed fix is refuted.**

> 🔴 **Do not execute the steps below as written.** The census (3.1) was taken and it says
> "declare every harvested field" does not buy the benefit we want. Recorded in full on core#65.
>
> - **The defect targeted has not occurred** — 323 field names in use, near-miss analysis returns 5
>   candidates, **none a misspelling** (`retry_after_ms` vs `retry_after_s` are different units).
> - **Declaring would buy spelling only** — 87% of existing declarations are already optional; +296
>   takes it to ~97%, an interface where any combination compiles.
> - ⭐ **The real queryability defect is SYNONYM DRIFT, and declaring cannot fix it:**
>   `order_uid`(30) / `order_id`(4) / `uid_order`(4) are three names for one concept across 38 sites,
>   so a dashboard querying one silently misses 8 records. All three would be declared and all three
>   would keep compiling. ⚠️ `order_uid` — the majority — also violates this package's own
>   `uid_{descriptor}` convention, so the *minority* spelling is the correct one.
> - **The grain is wrong**: `IntegrationEventLogRecord` is 42 message types flattened into one bag,
>   discriminating by SUBSYSTEM where the fields vary by MESSAGE.
> - **The signature is load-bearing for a real workflow**: core is a published package, so adding one
>   log field costs edit → push → JSR → bump → install. That friction is why ~228 one-off fields ride
>   it. Removing the valve without removing the friction relocates the pain to mid-incident.
>
> **Re-scoped question:** *how do we make log fields predictably queryable?* Candidates: normalise the
> synonyms (cheap, fixes a live defect, no schema change); discriminate on `msg` rather than
> subsystem; or split a closed envelope from an explicitly-open `context`.
>
> **Free regardless:** 7 of 20 arms — `client`, `dmarc`, `email`, `propagation`, `request`, `sync`,
> `validation` — have zero undeclared fields and can lose their signature today.
>
> Needs a design decision, not an execution pass. The original steps are kept below for the record.

### The original plan (superseded — read the census first)

1. **Census.** Point api-cloudrun's `@cfs/core/schemas/log` entry at a local core checkout, delete all
   22 signatures, `deno check`. Harvest the per-arm field list the 367 call sites actually supply.
   **That list is step 1's deliverable — write it down before writing schema.**
2. **Declare** every harvested field, including `collection`/`doc_id`/`operation` on
   `IntegrationEventLogRecord`, which the docstrings already admit ride the signature.
3. **Delete** the 22 signatures, publish, bump api-cloudrun, fix the residue.
4. Fix the stale docstrings (`src/schemas/log/integration-event.ts:255-266`, `src/schemas/log/domain-event.ts:180-188`) and the
   "24 arms / ~100 message types" figures in `api-cloudrun/src/lib/logger.ts:370,397`.

⚠️ **Manager and templates import no log schemas** — verified. Single consumer.

### 3.1 CENSUS — done 2026-08-23. **This is the deliverable; read it before writing schema.**

**Scale: ~296 distinct field names are supplied by call sites and NOT declared**, across
364 `logTyped` object literals and 20 arms.

⚠️ **The plan's stated method UNDER-REPORTS, and by a lot.** "Delete the signatures and `deno check`"
gives **103** distinct names, not ~296 — because **TS2353 reports only the FIRST excess
property per object literal**. One pass is not a census; it is the first layer of one. Reaching the
real list needs either iterating check→fix→check to a fixed point, or a static parse.

⚠️ **And a static parse alone is also wrong.** 8 names it misses show up only in the type-check,
because **14 of the 364 call sites spread a value in at top level** (`...input`, `...ta`) and a
key-based parse cannot see through them. Neither method dominates: the numbers below are the UNION.

| Arm | supplied | already declared | **undeclared** |
|---|---|---|---|
| `integration-event` | 85 | — | **85** |
| `domain-event` | 51 | — | **51** |
| `template-event` | 45 | — | **45** |
| `xero-event` | 43 | — | **43** |
| `typesense-event` | 27 | — | **27** |
| `system-event` | 26 | — | **26** |
| `access-control-event` | 23 | — | **23** |
| `oauth-event` | 21 | — | **21** |
| `calendar-event` | 10 | — | **10** |
| `user-session-event` | 9 | — | **9** |
| `mcp-event` | 4 | — | **4** |
| `cloud-task-event` | 2 | — | **2** |
| `transaction` | 1 | — | **1** |

**⭐ 7 of 20 arms have ZERO undeclared fields — their signature can be deleted for free, today:**
`client`, `dmarc`, `email`, `propagation`, `request`, `sync`, `validation`. That is the natural first cut and it de-risks the rest.

**🔴 The finding that should decide the shape of this wave: 228 of 347 undeclared field-names are
supplied at exactly ONE call site.** Declaring ~228 single-use fields to delete 22 index signatures
is a different trade from declaring the ~119 that recur, and the plan did not anticipate it.
Three defensible answers, and this is an owner call:

- **Declare all of them.** Faithful to the issue. Biggest schema, and ~228 declarations exist to
  serve one call site each.
- **Declare the recurring ones; fold the single-use ones into an existing field** (most are ad-hoc
  debug context that belongs in a `context`/`detail` object, not on the envelope).
- **Delete the 7 free signatures now**, declare the recurring fields, and leave the rest —
  banking most of the value without a 300-declaration commit.

⚠️ `IntegrationEventLogRecord` is the extreme: **88 fields supplied, 3 declared.** Its own docstring
already admits `collection`/`doc_id`/`operation` ride the signature — the census confirms
`collection` (6 sites) and `operation` (4) among many others.

⚠️ **`ValidationIssue` is a 24th signature and is NOT an arm.** It is the nested Zod-issue shape, and
its openness is arguably correct (Zod issue shapes vary by code). Decide it separately; do not sweep
it in with the 22 record arms.

**Closes #65.**

## Wave 4 — core#53: split the seed helper ✅ LANDED 2026-08-23

**Shipped as `@cfs/core/schemas/testing` in `10.0.0-beta.249`** (core `3ff0298`, api-cloudrun
`04b06c9d`, manager `56e41fd`). `getInitialValues` is unchanged; fixtures got their own contract.
**core#53 is CLOSED** — its own prescribed fix (`case "optional" → SKIP`) is refuted three ways, the
decisive one being that it breaks manager's create-product form at the first keystroke.

`getTestDoc` / `getFullTestDoc` / `getTestDocPartial`, plus `TestDocOptions`. Full reference:
`core/CLAUDE.md` § *Seeding: form values vs test fixtures*, `api-cloudrun/CLAUDE.md` § *Testing*,
`manager/CLAUDE.md` § *Test fixtures come from `getTestDoc`*. Implementation and its reasoning:
`schemas/testing.ts`; 14 property arms in `tests/testing.test.ts`.

### What this wave corrected in its own plan — do not re-derive

- 🔴 **Structural coverage is 55 of 56, not the gate's 53.** Two more came free from building a
  composite id out of its own `z.templateLiteral` parts — the only way `BookingId`, `MovementId`,
  `QuoteId` and `EventCardId` are reachable at all. **One** override remains (`transactions`: every
  movement type demands either a booking-scoped custody transition or a cost plus a line, so no
  single choice of `type` works). Its list length is asserted, so a second entry is visible.
- ⚠️ **"`omit(doc, k)` is rejected for EVERY k" is not something the schemas say.** A `.default(x)`
  declaration is required in `z.output` and present in the built document, and the schema still
  accepts a document without it — the default re-materializes. Measured: **465 of 595** top-level
  declarations covered. The test asserts the property over the required class and counts BOTH
  classes, so neither arm can pass vacuously.
- ⚠️ **The plan's two timestamp mechanisms conflicted; one shipped.** `options.now` is the single
  mechanism, required at compile time via a conditional rest tuple whenever the document carries
  `created_at`/`updated_at`. It keeps the compile error, keeps `getTestDoc(CreateOrderInput, {})`
  legal, and also reaches the nested `*_fs` leaves a top-level-key intersection cannot see.
- ⚠️ **No `mockTimestamp` / `tsAt` export.** They already exist at `tests/helpers/timestamp.ts` and
  stay there. NOT shipping a fabricator is the reversible direction: api-cloudrun's write boundary
  can assert `instanceof Timestamp` first and the module can add the convenience afterwards; the
  reverse cannot be undone. (The type already helps — `FirestoreTimestampValue` demands `toMillis` /
  `toDate`, which a bare `{ seconds, nanoseconds }` literal does not have.)
- **The input-schema arm needed no third entry point.** `getTestDoc` handles `Create*Input` directly:
  the conditional options argument collapses to its optional arm for a schema with no `created_at`.
- ⚠️ **A negative fixture puts its invalid value ON TOP of the built base**, never through the
  helper — `getTestDoc` parses, so `getTestDoc(S, { first_name: "" })` throws rather than producing
  the document a rejection test needs. This is the first thing anyone converting a fixture hits.

### 🔴 The ordering rule that cost the prototype the most time

**Sweep candidates FIRST, introspect second.** Detecting a leaf's format first and falling back to
the sweep silently stops reaching it for every `z.email()` / `z.uuid()` / `z.iso.datetime()` leaf,
and the failure is invisible — introspection finding nothing looks exactly like a leaf with no
constraints. The Zod-4 value keys (`greater_than`→`value`, `length_equals`→`length`,
`min_length`→`minimum`) are in the module docblock; they disagree, and guessing cost more than the
design did.

### What the parse found the moment it ran

Each of these had been latent for the life of its fixture, and none was reachable by grep:

- A Xero contact id that **Xero could not have issued** — `11111111-2222-3333-4444-555555555555`
  against `z.uuid()`, whose variant nibble must be in `{8,9,a,b}`. In a money-wire fixture.
- Fixture uids that were **not ids** — `"inv-golden"`, `"prod-1"`, `"custom-clean"` against
  `FirestoreId` / `ItemUid`.
- `eligible_delivery` / `eligible_in_store_pickup` on the shared stock fixture were **inherited, not
  chosen** — they arrived `true` from `getInitialValues` reading `.meta({ initial })`, a FORM intent.
  Value preserved, now stated.
- `src/services/eventCardReconcile.ts`'s docstring **had it backwards**: it claimed a schema-seed
  spread prevented drift, when a seed guarantees a key is PRESENT and presence is what defeats
  `validateBeforeWrite`. Now an explicit `Card` literal.
- `tests/unit/typeEscapeRatchet.test.ts`'s regex required `}` to be the LAST character before the
  cast, so `}) as unknown as`, `})) as unknown as` and `] as unknown as` escaped — **20 sites did**,
  one of them in `src/`. A ratchet with a hole that shape does not report a smaller number; it
  reports a clean one.

### What is left, and where it lives now

- **api-cloudrun#647** — **11** integration files still seed through `getInitialValues` + a cast
  (was 33), plus the newly-visible `services/orders.ts:2221` launder. The ORDER and INVOICE families
  are done — see *The pre-Wave-5 conversion* below. The rest are other collections and can drain
  whenever.
- **api-cloudrun `seedDoc(ref, Schema, overrides)`** — construct → validate → track → write, and the
  ratchet making it the only sanctioned way to write a fixture. **Not built.** Folded into #647's
  scope; it is what makes the next required field visible, and it is worth doing before the 34-file
  sweep rather than after.
- **manager#322** — 9 of 20 stores pass `initialValues` and never mint a draft. Needs
  `EntityCacheOptions.initialValues` to become optional with a **typed** (not runtime-throw) answer
  for `newDraft` on a seedless store.
- **Manager's form-seed cleanup** stays sequenced **after Wave 5** — `buildDefaultDocDates` and the
  no-op spread in `manager/src/stores/orders.ts` can only collapse once `ProductSchema.shipping` is
  required.


### The pre-Wave-5 conversion (done 2026-08-23) — and why it was not optional

⚠️ **Wave 5's stated safety net did not yet cover the collections Wave 5 tightens.** The claim below
— *"a minimal-valid factory is exactly the tool that keeps negative tests honest through a bulk
tightening"* — only holds where the factory is used. On the day Wave 4 landed that was 4 api-cloudrun
files and 6 manager files, while **13 integration files seeded orders** through
`getInitialValues(CreateOrderInput)` and **9 seeded invoices** through `getInitialValues(InvoiceSchema)`
— which is almost exactly the Tier-3 candidate list (`orders.crms_id`/`crms_status`/`uid_thread`/
`xero_id`, `invoices.due_date`/`subject`/`uid_thread`).

🔴 **And the old base SUPPLIED those keys, with zero values.** So a tightening would not have failed
cleanly at construction; it would either 400 mid-suite against dev Firestore, or **pass spuriously**
on a `""` that satisfied a presence check. That is the noisy version of the very signal 5c's
before/after census is trying to read.

**22 files converted** (api-cloudrun `968c9542`): 13 order-payload seeds, 9 order/invoice document
seeds. Verified in two batches — 41 passed (217 steps) and 27 passed (174 steps), 0 failed.

⭐ **What it found, and the reason no existing gate could have.**
`DocumentOrganizationSnapshot.xero_id` is `z.uuid().nullable()` — required, no `.default()` — and two
document seeders (`tests/integration/invoices/invoices.test.ts`,
`tests/integration/creditNotes/creditNotes.test.ts`) override `organization` with a **whole-object
literal** that omits it. A whole-object override REPLACES the base rather than merging with it, and
these seeds write through a raw `ref.set()` that never reaches `validateBeforeWrite` — so both have
been writing an invalid `OrderSchema` document into dev for the life of the seeder.

⚠️ **Both sites carried a comment asserting the opposite.** `creditNotes`: *"this order is written
straight to Firestore, so it must be shaped like one a writer produces."* `invoices`: *"lets
subsequent PUT /orders flows pass `validateBeforeWrite`."* Neither was true of the document beneath
it. Corrected in place rather than quietly fixed — **a fixture's docstring is a claim about the
corpus, and nothing was checking it.**

📝 **The method is the reusable part, and Wave 5 should use it.** The defect was found by
reconstructing each seeder's *full output* offline and calling `safeParse` on it — a check the
integration suite **structurally cannot make**, because the suite exercises the write and the write
is the thing that skips validation. Two consequences for Wave 5:

- Its instrument (`api-cloudrun/scripts/audit-schema-validation.ts`) reads the STORED corpus, so a
  test seed writing invalid documents into dev pollutes the dev half of every before/after reading
  (the api-cloudrun#637 family). Both are fixed; the other nine document-seed `organization`
  literals were audited and already carried the field, so the class is closed rather than sampled.
- **A whole-object override is where a required field goes to die.** Wave 5 makes fields required;
  every such override in a fixture is a site that will silently stop matching the schema. Grep for
  them per collection *before* tightening it, and reconstruct-and-parse rather than trusting a green
  suite.


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

### 5a. DELETE the dead fields — ✅ **DONE 2026-08-23, and it deleted NOTHING**

> **Result first, so nobody re-runs the census.** The key-presence pass was run over prod and
> dev for all 14 candidates. **Not one is deletable.** The buckets below are kept as the
> reasoning trail; the per-field verdicts are now docblocks in the schemas (core `0b7e6e6`) and
> the method is `core/CLAUDE.md` § *"Is a field dead?"*. Three issues were filed: **#649**, **#650**,
> **#651**.
>
> | verdict | fields |
> |---|---|
> | **key-PRESENT** (never dead) | `cards.body`/`body_text`/`recurrence_parent_uid`/`recurrence_index` (1,129/1,129) · `locations.uid_location_type` (209/209) · `transactions.reverses` (932/932) · `taxes.xero_components` (11/11) · `products.webshop.description` (544/568) · `products.images` (1/568) |
> | **key-absent, but WRITER BUILT** | `products.query_by_images` · `contacts.uid_user` · `contacts.pronunciation` · `orders.uid_store` · `orders.created_by` |
>
> ⚠️ **The second row is the one the plan did not have a test for.** Key-absence was treated as
> sufficient; it is not. A key no document carries can equally mean *the feature ships and nobody
> has used it* — which is exactly `products.images`. **Both tests, every time.**

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

### 5b. Tighten, in three tiers — ✅ **DONE 2026-08-23. Nine of eighteen tightened.**

> **Result first.** Tier 1 deleted all 21+2 inert defaults; Tier 2 tightened one of two;
> Tier 3 tightened nine and refused nine. The per-field verdicts — including every refusal — are
> now **docblocks beside the fields**, and the method is `core/CLAUDE.md` § *"Making a field
> REQUIRED"*. The status block at the top of this doc carries the summary. What follows is the
> reasoning trail that produced it; the two preflight steps below were both run and both bit.


🔴 **Before tightening ANY collection, do these two things — in this order.** They are cheap, and
each one has already caught a defect nothing else could see.

1. **Re-measure the collection.** Every "100% today" figure below is a fact about 2026-08-23, and
   5c's whole procedure is a before/after comparison — a stale number is the one input that makes
   the commit message wrong. Two already moved: `taxes.xero_components` **joins** Tier 3 (11/11
   key-present), and `products.webshop.description` **leaves** it (544/568 — 24 docs need a
   backfill first).
2. **Grep that collection's fixtures for a WHOLE-OBJECT override, then reconstruct-and-parse.**
   ⭐ *A whole-object override is precisely where a newly-required field disappears without
   anything going red.* It REPLACES the base rather than merging with it, so the field is simply
   gone — and if the seed writes through a raw `ref.set()` it never reaches `validateBeforeWrite`
   either. That is how two seeders wrote invalid orders into dev for their whole lives, each
   under a comment claiming the opposite (see *The pre-Wave-5 conversion*).

   Make it mechanical, not remembered — the suite **structurally cannot** catch this, because the
   suite exercises the write and the write is the thing that skips validation:

   ```sh
   # 1. every fixture that replaces a sub-object wholesale for this collection
   rg -n "(organization|destination|contact|price|totals):\s*\{" api-cloudrun/tests manager/src
   # 2. every seed that bypasses the write guard entirely
   rg -n "\.set\(" api-cloudrun/tests
   ```
   Then rebuild each seeder's FULL output offline and `safeParse` it against the document schema.
   A green suite is not evidence here.

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

### 5c. The procedure — ✅ applied per tier; now `core/CLAUDE.md` § *"Making a field REQUIRED"*
**Measure the corpus, prod and dev, and put the numbers and date in the commit message** — that is the
branch point. Clean → tighten in one commit (`8bb64f7`). Dirty → **expand → backfill → tighten**, naming
the backfill in the `BREAKING CHANGE:` footer (`affb480`). **Required, never `.nullable()`**. **Never
`.default()` as the cushion.** Tighten the input schemas in the same commit. Drop the `?` on the
interface. ⚠️ **Expect fixtures the compiler cannot see** — `2915c782` found **nine** raw `ref.set({…})`
sites needing a new required field, and *none* was a compile error; they were found by grep.

### 5d. Write down the conventions — ✅ **DONE**, core `CLAUDE.md` (two new sections)
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

**CLEAR CONTEXT, then start at Wave 5b.**

Everything needed to resume cold is durable: this doc (status block first), the three repos'
`CLAUDE.md` sections written this session, and the GitHub issues. Nothing is held only in a session.

✅ **Wave 5a is DONE and deleted nothing** — see its section. All 14 candidates refuted, the
verdicts are docblocks in the schemas (core `0b7e6e6`), the method is `core/CLAUDE.md` § *"Is a field
dead?"*, and three api-cloudrun issues carry what a core schema wave must not absorb: **#649**
(`organizations.last_order` never stamped), **#650** (`destinations.query_by_organizations` — no
writer *and* no reader, which is not the "drift + backfill" this plan predicted), **#651**
(`invoices.pdf_versions`, a product question).

**Wave 5b is the right next unit.** The `FieldValue`-sentinel do-not-require list is written out, and
the measuring instrument (`api-cloudrun/scripts/audit-schema-validation.ts`) was verified to cover
every collection the wave touches, so it will not move mid-campaign.

✅ **The pre-Wave-5 fixture conversion is DONE** (see the section of that name) — the order and
invoice seeds now fail loudly rather than spuriously when a field becomes required.

⚠️ **Two things to do FIRST, before the first tightening — both are now written into 5b as steps:**

1. **Read 5b's three tiers against the corpus again, not against this doc.** Every "100% today"
   figure is a fact about data on 2026-08-23, and 5c's whole procedure is a before/after
   measurement — a stale number is the one input that makes the commit messages wrong. **Two have
   already moved**: `taxes.xero_components` joins Tier 3 (11/11 key-present);
   `products.webshop.description` leaves it (544/568, so 24 docs need a backfill first).
2. **Grep each collection's fixtures for a WHOLE-OBJECT override before tightening it**, and
   reconstruct-and-parse rather than trusting a green suite. A whole-object override REPLACES the
   base rather than merging, so a newly-required field vanishes with nothing going red — and a raw
   `ref.set()` seed never reaches `validateBeforeWrite` either. That is how two seeders wrote
   invalid orders into dev for their whole lives, each under a comment claiming the opposite. **The
   suite structurally cannot catch this**, because it exercises the write and the write is what
   skips validation. 5b carries the two `rg` commands; run them, do not remember them.

**Do not start Wave 3.** Its census refuted its own prescribed fix; it needs a design decision
(owner: predictable querying is the benefit, synonym drift is the defect), not an execution pass.

**Do not assume #53, #58 and #59 are closed just because the issues are.** Each has a named piece
left, and all three are in the status block above with their issue numbers.

⚠️ **templates PR #121 is open and must not be merged by an agent.** If core publishes another beta
before it lands, roll it forward by `sed` over the `jsr:@cfs/core@<old>/` pattern — never by a
remembered line count, and never by a version quoted from this doc.
