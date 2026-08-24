# Structured logging campaign — predictable, discoverable querying

**This is what core#65 becomes.** It was Wave 3 of the core issues roadmap, deferred
2026-08-23 with *"census done, prescribed fix refuted"*. ⚠️ **That roadmap has since been
retired** (`bf72ce7`, all 9 issues closed or reissued, doc deleted), so there is no campaign
index to hang off any more — this doc is free-standing, and **core#65 is one of only two open
core issues** (the other is #69, Typesense projection, unrelated).

> ## ⚠️ STATUS UPDATE 2026-08-24 — Phases 0 and 2 are LANDED. Three claims below are corrected.
>
> **Phase 2 is the headline: the alert contract now gates in `scripts/gate.sh`.** A vmalert
> rule can no longer key on a `msg` no arm declares, or group by a field the matching arm
> does not carry, without turning the build red.
>
> | item | State |
> |---|---|
> | **Phase 2** — `api-cloudrun/tests/unit/alertRuleContract.test.ts` | ✅ landed, wired into the gate, all three arms proven to fail |
> | **Phase 2 follow-up** — 3 of the 68 pairs were renames, not declarations | ✅ fixed; ratchet now **66** |
> | **Phase 0** — `api-cloudrun/scripts/audit-log-corpus.ts` | ✅ written, run against prod **and** dev |
> | Fix `typesense_collection_created` | ✅ writes `typesense_collection`; `collection` now holds the logical name |
> | Repair the three `stats by (collection)` rules | ⛔ **no-op — the claim was wrong, see below** |
> | Prune dead msg literals | ⏳ **not started** — and it is a `core` edit, so it belongs to Phase 1's publish, not here |
> | Re-census | ✅ numbers below supersede *What is true today* |
>
> ### 🔴 Correction 1 — "three alert rules mix them" is FALSE
>
> Defect 11's first half is confirmed and measured: `collection` really did carry 20 logical
> names **and** 28 Typesense physical index names, all from `typesense_collection_created`.
> Its second half is not. **No vmalert rule references `typesense_collection_created` — zero
> occurrences across all three rule files.** Every rule that does `stats by (collection)`
> (9 clauses, 7 alerts) is `msg:`-scoped to a *different* message, so none of them could ever
> see a polluted value. The blast radius was ad-hoc queries and the future typing of
> `collection`, never live alerting. The emitter fix still lands — it is the precondition for
> typing `collection` — but it repairs no rule, and nothing needed editing in the YAML.
>
> ### 🔴 Correction 2 — Phase 0's credential instruction would not work
>
> This doc said the script queries `$DEV_OBS`/`$PROD_OBS` with **`$OBS_ADMIN` from `.envrc`**.
> `api-cloudrun/scripts/_obsCredential.ts` exists precisely to stop that: there is
> deliberately **no generic `OBS_ADMIN`**, because `.envrc` carries the *dev* password under
> that name, so pointing it at prod sends the wrong credential and 401s with a message that
> reads like an UNSET variable rather than a wrong one. The script uses `resolveObsTarget(env)`
> (per-env, from Secret Manager). The endpoint is also `/logs/select/logsql/…`, not
> `/select/logsql/…`.
>
> ### 🔴 Correction 3 — the undeclared-alert-field count is 46, not 37
>
> Defect 8 predicted the census was a floor. It was. Measured 2026-08-24 by the script:
> **46 distinct fields across 68 rule×field pairs**, against 77 fields and 51 msgs the rules
> reference. `unknown_permission` is in the list, exactly as defect 8 said it would be.
>
> ### Re-census — supersedes *What is true today*
>
> | | doc (08-23) | measured 08-24 |
> |---|---:|---:|
> | Registered `msg` literals | 289 | **289** ✅ |
> | vmalert rules | 70 | **70** ✅ |
> | Emitted, not registered | 1 (`xero_quote_transition_rejected`, 28) | **1, 28** ✅ |
> | Distinct `msg` emitted, prod ∪ dev | 149 | **148** |
> | Registered, never emitted | 141 | **142** (only **6** with no emitter in `src/`) |
> | Distinct `msg` referenced by rules | 46 | **51** |
> | Distinct fields referenced by rules | 73 | **77** |
> | Undeclared alert fields | 37 | **46** |
> | Typesense index names in `collection` | 29 | **28** prod / **30** dev |
>
> The `order_*` drift (defect 7) re-measured **exactly**: 12,030 / 2,869 / 170, so a query on
> `order_uid` still misses 3,039 of 15,069 — 20.2%. Defects 10 and 11 re-confirmed unchanged.
> The one Typesense name the doc cited by example (`templates_v2_fdcacf9e`) has aged out of the
> 90-day window — that is the corpus moving, which is what the doc says these numbers are for.
>
> ⭐ **Expect 289 → ~183, not → 180 or → 149.** 182 registered msgs emitted nothing in 90 days,
> but only **6** have no emitter in `src/`, and all six are already in the reviewed
> `SCHEMA_PENDING_EMISSION` allowlist. The prune is far smaller than this doc estimated,
> and the emitter column is why.
>
> ### Phase 2 landed as a shrinking ratchet — a deliberate deviation
>
> This doc says the test should "land red on the 37 → declare them → green", never by
> allowlist. The declarations land in **`core`** — a JSR publish plus three pin bumps — and
> the churny phases are gated on #442/#444-B. A test that stays red until an unrelated gate
> opens cannot be wired into `scripts/gate.sh` at all, and an unwired ratchet is one
> `--no-verify` from nothing (that file documents 21 that were).
>
> So it gates **today** against anything new, with the current **68 pairs** itemized, dated,
> and grouped by the msg whose arm needs each field — **that grouping is Phase 1's work
> list**, already written out. A third arm fails when an entry stops being a violation, so
> the list cannot rot into a permanent exemption. Emptying it is what "green only by
> declaration" means here, and Phase 1 is what empties it.
>
> Two structural notes worth keeping:
>
> - **Arm 1 (every explicit `msg:` is registered) is strict, has no allowlist, and is green
>   today.** It uses an explicit-`msg:`-only extractor, because the general one resolves
>   *bare* tokens by intersecting against a vocabulary — so a misspelt bare token belongs to
>   no vocabulary and vanishes rather than being reported. Bare misspellings stay the
>   corpus's job (the script's check F).
> - **The parse has ONE owner**, `api-cloudrun/scripts/_alertRules.ts`, shared by the script
>   and the test. This campaign exists because "what fields does this message carry" has six
>   owners that disagree; a script and a test parsing the same YAML differently would be that
>   defect committed by the guard against it.
>
> ⭐ **The hermetic boundary is where the plan's "pair it with an independent property"
> actually lands.** `gate.sh` is hermetic by construction, so the corpus half *cannot* live
> in the test — it stays in the script. That is not a compromise; it is the reason the two
> halves are two artifacts.
>
> ### 🔴 Correction 4 — the rename table is INCOMPLETE. Three more synonym families, measured.
>
> Defect 7 concluded *"the drift is confined to the order concept"*. It is not. Working the
> Phase 2 ratchet's list surfaced three more live pairs, none of them in the rename table:
>
> | minority spelling | records | established name | records | status |
> |---|---:|---|---:|---|
> | `error` | 720 | `error_message` | 20,326 | 🔴 **open** — needs Phase 1 |
> | `version_uid` | 3 | `template_version_uid` | 24 | ✅ fixed |
> | `git_branch` | 0 | `branch` | 695 | ✅ fixed |
>
> ⚠️ **This changes what Phase 1 must do with the ratchet's list.** Four of its entries are
> the `error` pair, and **declaring `error` would make the gate green by minting the very
> drift this campaign exists to kill** — a schema-blessed synonym, which is strictly worse
> than an undeclared field. The fix is the rename, and it needs `core` because the arms that
> emit `error` do not declare `error_message` either. **Phase 1's own prescription settles all
> four at once**: promote `error_name` / `error_message` / `error_stack` to the envelope.
>
> ⭐ **The measurement method is defect 7's, and it is the reusable part.** Both template
> pairs looked like declaration work and were renames; a query on the declared name was
> missing the records entirely. **Before declaring any field to satisfy the ratchet, count it
> against its established sibling.** `template_release_auto_merge_failed` carries the same
> `version_uid` drift (3 records), is not alert-consumed so the ratchet cannot see it, and
> belongs in Phase 5b.
>
> ⭐ A rename is only free if the corpus says so, and that is checkable rather than assumable:
> `template_abandon_close_pr_failed` has **zero** records over 90 days, so no bridge and no
> canary were warranted. The plan's "single-spelling ⇒ no ceremony" rule generalises to
> "no records ⇒ no ceremony".
>
> ### One alert named a field that has never existed
>
> `DmarcReportIngestFailed` unpacked `filename`; `api-cloudrun/src/services/dmarcReports.ts`
> writes `message_id`. The file *has* a `filename` concept for the Gmail attachment, which is
> presumably where it came from, but it never reaches the record. This is the class the
> campaign named — a rule referencing a field nothing supplies — caught by the reconcile
> rather than by anyone noticing, because such a rule fails by matching nothing.
>
> ### Bonus finding, fixed in passing
>
> `SCHEMA_PENDING_EMISSION` had a **stale entry** (`uploadcare_upload_abandoned`, whose emitter
> landed at `api-cloudrun/src/services/processOrderDocs.ts`) and — unlike its sibling
> `MIGRATION_DEBT` — **no reverse guard**, so a revived entry could sit there suppressing
> nothing forever. Entry removed, reverse guard added beside the existing one, and verified to
> fail on a re-planted entry. Same lesson as defect 10, one directory over.
>
> ### Still gated
>
> **api-cloudrun#442 and #444-B remain OPEN**, so the churny phases (1, 3, 5 — 367 call sites
> across 104 files) have not started, per this doc's own sequencing rule. Phase 0's remaining
> item (the prune) is a `core` edit and batches with Phase 1.
>
> **Everything reachable without a `core` publish is now done.** The next step is Phase 1,
> and it is a `core` change: declare the **62** genuinely-undeclared pairs and RENAME the
> other four (`error` → `error_message`, via the envelope promotion this doc already
> prescribes) — the ratchet's list is the work order and flags which is which —
> close the envelope, name the `context` bag, type `collection`. ⭐ Phase 0 measured one
> thing that de-risks it — the corpus carries **zero** singular collection values, so the
> plural-only subset of `CollectionName` fits 90 days of real data, not just in principle.

Owning repo **`core`** (the artifact every phase converges on is core's, and three of six
phases land there); `api-cloudrun` carries the call sites, the alert rules and the audit
scripts; `claude-plugins` carries the skill. Lives beside the surviving
`core/.claude/plans/roles-campaign.md`.

## Sequencing — the core gate is now CLEAR; two api-cloudrun issues are not

Re-checked 2026-08-24. **The core roadmap prerequisite is satisfied**: Waves 4 · 5 · 6 · 7 all
landed, the roadmap doc is retired, all four repos are pinned to `10.0.0-beta.251` with no
skew, and `core/src/schemas/log/` and `core/src/schemas/pii/` are **unchanged** since these
measurements — so every number below still holds.

What remains is narrower than "wait for the campaign", and it is two open api-cloudrun issues:

🔴 **api-cloudrun#442 and #444-B run first.** The retired roadmap's ruling, which stands on its
own reasoning: *"Wave 3 touches 367 log call sites across 104 files and would churn the
api-cloudrun lines those two plans cite. They need nothing from core … so there is no reason
for them to wait."* Both are still OPEN. Whoever goes second eats the churn, and this campaign
is the one touching 104 files.

🔴 **api-cloudrun#506 needs an ordering answer before Phase 5.** It renames the *document*
field `uid_session` → `uuid_session`, because it holds a client-minted v4 UUID and references
no document. Phase 5 mints a *log* field called `uid_session` whose value **is** a session
document id. If #506 lands second, one 90-day retention window holds `uid_session` under two
incompatible meanings and every `uid_session:"…"` query is ambiguous — the same defect as
`order_uid`, self-inflicted this time. #506 is the harder one to move (32 core / 66 api / 52
manager occurrences, a 1,991-document backfill, and the doc id embeds the value: `movementId`
is `{uid_session}|{type}|{subject}`), so **the cheap resolution is Phase 5 choosing another
name for the session-doc reference.** Decide it when Phase 5 is scoped, not before.

Also add **`prior_session_uid`** (`api-cloudrun/src/routes/invites.ts`) to Phase 5's rename
set — same family, currently missing from the table.

⭐ **Nothing else blocks.** `CollectionName` / `CollectionDocs` / `DocFor` are already in the
`beta.251` pin every consumer holds, so §*The collection registry is the enum* needs no new
export and no version floor. Phases 0–4 have no dependency on #442/#444 beyond file churn;
only Phase 5 waits on #506.

### Two things worth knowing before Phase 0 runs

- **Re-census; do not inherit.** The #65 census is a floor, not a measurement: Wave 2c (roles, landed) minted
  ten more undeclared log fields *after* it was taken, one of them (`unknown_permission`) a
  live vmalert `stats by` key. See defect 8.
- **Don't carve the two live query defects out early.** Defect 7's 20.2% order-reference miss
  and defect 11's `collection` overloading are both small and both tempting. Each is a
  field-name change, so each needs the coalescing bridge and the canary Phase 5 sets up;
  doing them loose runs that ceremony twice. They have been live for months.

### Related work now filed separately

- **api-cloudrun#655** — the consumer half of core#58 Phase 4: core declares `.meta({ idField })`
  on three collections whose doc id is deliberately not `uid`, and the drift guard still reads a
  hardcoded `uid`. Not a blocker, but it is the unfinished edge Phase 5 would otherwise inherit
  if it became `idField`'s first consumer.
- **core#59 / manager#321** — roles UI. `core/.claude/plans/roles-campaign.md` was deliberately
  kept when the roadmap was retired and remains the standing authority for why `role_name` is
  frozen (defect 8).

## Context

core#65 asks for `[key: string]: unknown` to be deleted from the 22 log-record arms so a
misspelt field name is a compile error. A census comment on the issue (2026-08-23) already
pushed back: 87% of declarations are optional, adding ~296 more takes it to 97%, and
near-miss analysis over every field name in use found **no misspellings**. It proposed
re-scoping to synonym normalisation.

Both are aiming at the wrong measurement, and two facts settled from research say why the
issue's fix is actively wrong:

- **VictoriaLogs indexes every field automatically and charges nothing for an undeclared
  one.** Only *stream* fields carry cardinality cost, and no application field is a stream
  field here — the stream tuple is OTLP resource attributes only (`deployment.environment`,
  `service.name`, `telemetry.sdk.*`). Closing the type buys **zero** query benefit.
- **The openness is load-bearing.** core is published to JSR, so adding one log field costs
  commit → publish → pin bump → install. `feat(log): register …` is a recurring commit type
  in core's history. Deleting the valve without replacing it relocates the pain to
  mid-incident debugging.

The defect worth fixing is a different one, and it is live:

🔴 **37 of the 73 distinct fields that 70 production vmalert rules group by are declared in
no schema arm.** They exist only because the index signature admits them. And **nothing in
the build reconciles the alert rules, the registry and the corpus** — a rename or a typo
produces a rule that matches zero rows, which is indistinguishable from a healthy system.

Honeycomb's framing of the discoverability half is this problem verbatim: *"If you don't
know what an attribute means, you can't write a good query. And if an AI agent doesn't know
what it means, it guesses."*

## What is true today (measured 2026-08-23; re-verified unchanged 2026-08-24)

| | |
|---|---|
| Registered `msg` literals | **289** |
| Distinct `msg` emitted in 90d, prod ∪ dev | **149** |
| Registered, never emitted in either env | **141** (49%) |
| Emitted, not registered | **1** — `xero_quote_transition_rejected`, 28 prod hits, deliberately removed from the registry, still inside the retention window and still queryable |
| Arms carrying `[key: string]: unknown` | **22 of 22** (the "22 of 24" in two CLAUDE.mds counts *files*, not union arms) |
| `logTyped` call sites | 371 |
| `logError` / `logTimed` / `log.*` | 94 / 2 / 5 — **all take `msg: string` + `Record<string, unknown>`; no type at all** |
| vmalert LogsQL rules | 70, referencing 46 distinct `msg` and 73 distinct fields |
| Grafana dashboards | **none** — vmalert rules are the whole machine-consumer surface |
| Retention | **90 days** |

### The eleven defects, in cost order

1. **Alert rules depend on 37 fields nothing declares.**
   `order_invoice_mirror_repaired` groups by `status_from` / `status_to` / `source`;
   `stock_oversold` by `quantity_held` / `quantity_available`; `tax_expiry_check` by
   `checked` / `expired` / `expiring_soon`. All ride the index signature. All appear as
   prose in a docstring and in no type.

2. **20% of emissions are untyped** — `logError` alone is 94 call sites of `msg: string`.

3. **The envelope is copied 22 times and has drifted.** Each arm interface hand-lists 7 of
   `BaseLogFields`' 12 fields. `subject`, `duration_ms` and `dry_run` are in the Zod
   envelope and in **no** arm interface — they compile only via the index signature, and
   `subject` is emitted (116 records on one msg alone). `BaseLogFields` exists and nothing
   extends it.

4. **`subject` means two things.** `baseLogFields.subject` is the namespaced id of the
   thing a request is about, `pii: "none"`. `core/src/schemas/log/client.ts` redeclares `subject` as an *email*
   subject with `pii: "mask"`, overriding the spread. One key, two concepts, opposite PII
   posture.

5. **Six owners of "what fields does this message carry"** — the TS interface, the Zod
   schema, the prose docstring on the msg literal, the alert rule's `stats by (…)`,
   `SAFE_PASSTHROUGH` (27 entries, `core/src/schemas/pii/safe-passthrough.ts`), and `api-cloudrun/.claude/commands/obs.md`'s
   hand-maintained catalogue, which is stale in every row and says so in its own text
   (*"278 total — derive it, do not trust this number"*; real count 289).

   ⭐ **`store_destination_no_default` is the worked example: three owners, three
   answers.** The docstring says it carries `{ store_uid }`; the Zod arm declares
   `store_uid` (and the TS interface does not); and the emitter in `api-cloudrun/src/lib/destinations.ts`
   supplies neither — it supplies `detail`, which is undeclared and *is* one of the 37
   alert-consumed fields.

6. **The grain is wrong, and the code already admits it.** `XeroEventLogRecord` is 41 msgs
   × 33 fields, 30 optional. Its own `reason` docstring: *"each msg owns its own value
   space … a query is always scoped by `msg` anyway."*

7. 🔴 **Synonym drift, measured by RECORD rather than by call site — and it is 380× worse
   than the census reported.** The core#65 census counted static call sites and concluded a
   dashboard querying `order_uid` *"silently misses 8 records"*. Queried against the prod
   corpus, 90 days:

   | spelling | records | |
   |---|---:|---|
   | `order_uid` | 12,030 | 79.8% |
   | `order_id` | 2,869 | 19.0% — **all of them `trello_queue_error`** |
   | `uid_order` | 170 | 1.1% |
   | **total carrying an order reference** | **15,069** | |

   **A query on `order_uid` misses 3,039 records — 20.2%.** Five cold call sites in
   `api-cloudrun/src/services/processTrelloQueue.ts` are a fifth of the corpus, because call-site count and record
   count are different measurements and only one of them is what a query sees.

   ⭐ **But the drift is confined to the order concept.** `invoice_uid` 1,015 / `uid_invoice`
   **0**; `product_uid` 12 / `uid_product` **0** — the four static `uid_product` sites are
   cold paths (`api-cloudrun/src/services/stockSummaryRebuild.ts`, `api-cloudrun/src/services/resyncLocationQuantities.ts`) that emitted nothing
   in 90 days. So `order_*` is a live query defect and everything else in the rename table is
   consistency work with no repair in it. Phase 5 should be sequenced accordingly.

8. 🔴 **The census is already stale, and the campaign that deferred it is what staled it.**
   Wave 2c shipped role delete + rename into api-cloudrun *after* the census was taken, and
   those calls supply ten fields `AccessControlEventLogRecord` does not declare:
   `role_deleted` → `name`, `threads_deleted`, `threads_modified`, `comments_deleted`
   (`api-cloudrun/src/routes/roleAdmin.ts`); `role_renamed` → `users`, `invites`, `sessions`,
   `threads`, `comments`; `role_permission_unknown` → `unknown_permission`
   (`api-cloudrun/src/lib/permissionCache.ts`). The arm's undeclared count went 23 → ~30.

   Two things follow. **`unknown_permission` is a live vmalert `stats by` field**
   (`api-cloudrun/infra/observability/vmalert/rules-vlogs.yml`, `RbacRoleReferencesUnknownPermission`), so Phase 2 lands red on a
   field this campaign *shipped*, not on legacy debt. And `role_deleted` supplies a bare
   **`name`** where every sibling role msg uses `role_name` — **a fresh instance of defect 7,
   minted after the census diagnosed it.** ⚠️ `role_name` itself is **frozen**: it is a wire
   contract across users, invites, sessions, threads, comments, logs, the Typesense facet and
   two Prometheus alert labels including the critical `RbacRoleSchemaInvalid`. Normalise
   `name` → `role_name`; never the reverse.

9. **Map-valued fields explode into one field name per key** — `read_counts.orders`,
   `target_counts.bookings`, `range_reads.invoices`, `claimed_ranges.*`. Bounded by the
   collection registry (~40) so not a cardinality hazard, but not a queryable dimension
   either: you cannot `stats by` over "which collection".

10. 🔴 **`schemas/log/mod.ts` claims a guard that does not exist.** Its docstring says
   *"The `core/tests/log-records.test.ts` coverage test asserts union ↔ registry symmetry so it's
   impossible to add one without the other."* `core/tests/log-records.test.ts` has exactly
   two tests and neither does that:
   - *"each entry's key is accepted by its schema's `msg`"* walks `MSG_SCHEMA_REGISTRY` and
     checks each key against the schema it was built from — **a fixed-point check**, which
     can only ever agree with itself. It cannot see a `TypedLogRecord` arm missing from the
     registry.
   - *"contains every Phase 0 archetype"* is a hand-listed allowlist of **9** entries, and
     `core/src/schemas/mod.ts`'s own Phase 0 block has **10** — `client_log` is not in the list.

   So adding a union arm and forgetting the registry compiles and passes. This is the exact
   defect class `core/CLAUDE.md`'s `lint` entry exists to name (*"a gate-claim that names a
   check nothing runs"*), and the same fixed-point lesson as the item-path invariants: **a
   guard that can only consult its own oracle is not a guard.** Phase 3 fixes it by
   construction — deriving the registry from `LOG_EVENTS` makes symmetry unrepresentable
   rather than asserted.

11. 🔴 **`collection` carries two different value spaces, and three alert rules mix them.**
   Measured in prod over 90 days: 20 real Firestore collection names (73,891 records) *and*
   **29 Typesense physical index names** — `orders_v24_2ed14c9e`, `invoices_v10_165f85d0`,
   `templates_v2_fdcacf9e`. Every one comes from `typesense_collection_created`, which
   writes the physical index into `collection` while every other Typesense message correctly
   uses `typesense_collection`. So `collection:"orders"` silently misses those records, and
   `stats by (collection)` — which three rules do — buckets two vocabularies together.
   `collection` is also one of the 37 undeclared fields.

## Design — one artifact owns the fact

The keystone is a single record in core:

```ts
export const LOG_EVENTS = {
  order_invoice_mirror_repaired: {
    archetype: "domain",
    level: "info",
    brief: "an order.invoices[] entry disagreed with the invoice doc and was converged",
    fields: ["uid_order", "uid_invoice", "source", "status_from", "status_to",
             "number_changed"],
  },
  // … one entry per live msg
} as const satisfies Record<string, EventSpec>;
```

`fields` is typed `readonly (keyof ArmFields)[]`, so naming a field the arm does not
declare is a compile error — the record adds the per-msg grain **as data over the existing
archetype types**, without a second owner and without restructuring 294 arms.

That one artifact is simultaneously the enforcement mechanism, the codemod target, the
generated-catalogue source, and the thing an agent greps. Anything that splits those into
separate systems is the over-engineering.

**Three mechanics are load-bearing and non-obvious:**

- 🔴 **Do NOT build a flat per-msg discriminated union.** TypeScript
  [#42518](https://github.com/microsoft/TypeScript/issues/42518): *"Unions of more than 25
  values cannot be used to discriminate other unions."* The current discriminant is already
  294 literals — past the cliff. Narrow through **indexed access on the record**
  (`LOG_EVENTS[M]`), which is O(1) and touches no union. Zod 4's `discriminatedUnion`
  eagerly maps over variants for the same reason ([zod#5991](https://github.com/colinhacks/zod/issues/5991)).
- **Close the object literal with `NoExcessProperties`, not by deleting the bag.** One line
  (Effect's): `type NoExcessProperties<T, U> = T & Readonly<Record<Exclude<keyof U, keyof T>, never>>`.
  ⚠️ TS's built-in excess-property check fires **only on object literals** — hoisting the
  argument to a `const` silently bypasses it, which is exactly what the 11 spread sites do.
  This type is what fixes that.
- **The open bag becomes a declared, named field**: `context?: Record<string, JsonPrimitive
  | JsonPrimitive[]>`. VictoriaLogs flattens nested JSON to dotted names, so it queries as
  `context.foo` with **no penalty relative to a flat field** — verified live against prod on
  the existing dotted fields: `read_counts.orders:>0` filters, and
  `| stats by (read_counts.orders) count()` groups (1,979 records). Both halves work, which
  is the whole dependency.

🔴 **The `context` bag has one blocking constraint, and getting it wrong is a PII leak.**
Declaring `context` naively turns the scrub OFF for exactly the fields that need it most.
The mechanism, read out of `api-cloudrun/src/lib/logger.ts` and
`core/src/schemas/pii/walker.ts`:

- Tier 1 records `schemaTopLevelKeys = Object.keys(schema.shape)`, so a declared `context`
  lands in that set.
- Tier 2 (`denylistScrub`) then skips it outright — *"Schema walker has already handled this
  whole subtree — don't re-touch."*
- But tier 1 handled **nothing**: the walker does recurse into a `z.record()`, against the
  record's *value* schema, and an open bag's value schema is `z.unknown()` with no `pii` tag.

So an `email` inside `context` would be redacted today (undeclared → top level → tier 2
recurses → `RUNTIME_DENYLIST` hit) and **passed through raw** after the refactor. This is a
regression the refactor introduces, not a pre-existing hole. **`context` must be exempted
from the `schemaTopLevelKeys` exemption** — either `getSchemaTopLevelKeys` omits it or
`denylistScrub` special-cases it — and Phase 1 needs a test that plants a denylisted key
inside `context` and asserts it is redacted. The `context.` prefix is the query-time
  marker that a field is unschema'd, which is the discoverability property the index
  signature can never have. ⚠️ Field names over **128 bytes are silently dropped**, and the
  cap is 2000 fields per record.

## The collection registry is the enum

Defect 11 settles a question the arms currently duck: a log field naming a CFS collection or
a CFS document should be **keyed off `CollectionName`**, not left a free string. The
precedent is already in this package — `PropagationEndpoint = CollectionName | "*" |
"orders/documents"`, *"keyed off this package's own collection registry, so there is no
second list to drift."* The same argument, unchanged, applies here.

Three concrete moves:

- **`collection: <plural-only subset of CollectionName>`.** 🔴 **Not bare `CollectionName`.**
  That type is `keyof CollectionDocs` = **96 keys**, singular *and* plural, so it would make
  `collection: "order"` and `collection: "orders"` both compile — in the field vmalert groups
  by 9 times and references 56 times. Typing it that way would **mint the exact synonym drift
  defect 7 exists to kill**, in the most-queried field in the corpus. Derive the plural subset
  (`{ [K in CollectionName]: \`${K}s\` extends CollectionName ? never : K }[CollectionName]`,
  the same "appending an `s` yields another `CollectionName`" test core already uses) or
  enumerate it. ⚠️ Keep the `import type` **type-only**, as `propagation/types.ts` does — a
  value import would drag the whole schema barrel into `@cfs/core/schemas/log` and into
  manager's browser bundle. This is the same constraint core#58 already ruled on when it
  chose to check `idField` in a **test** rather than read it at runtime: *"`propagation/types.ts`
  must stay runtime-free — a value import there undoes the reason propagation has its own
  subpath."* Same reasoning, same answer. ⭐ **And it is already enforced for free**:
  `core/tests/log-imports.test.ts` asserts *"no schema under `log/` transitively imports
  `core/src/schemas/common.ts` as a value"*. A value import of `CollectionName` fails that test on the way in,
  so this constraint needs no new guard — only that nobody weakens the existing one.
- **Repair `typesense_collection_created`** to write the physical index into
  `typesense_collection` (which every sibling msg already uses) and leave `collection` for
  the logical name. This is a live fix, not a refactor, and it is what makes typing
  `collection` possible at all.
- **Validate the `uid_{descriptor}` family against the registry — by test, not by type.**
  A derived `uid_${Singular<CollectionName>}` template-literal type is tempting and is the
  wrong tool: the plural rule is irregular (`holiday-dates` ↔ `dates`), several entries have
  no partner (`chart-of-accounts`, `holiday-snapshot`, `documents`), hyphens are not legal
  in an identifier, and a recursive conditional type over ~96 literals sits exactly where
  TS [#47481](https://github.com/microsoft/TypeScript/issues/47481) reports multilinear
  blow-up. **The mechanism already exists as a test**: core's `tests/propagation.test.ts`
  derives "is a singular alias" as *"appending an `s` yields another `CollectionName`"*.
  Reuse that shape to assert every `uid_*` log field resolves to a collection. Zero compile
  cost, catches `uid_orderr`, and no second list.

⭐ **This makes the log fields the first real consumer of the registry's singular half** —
which `core/src/schemas/mod.ts`'s own docstring currently calls *"may be vestigial … there are
zero literal `schemas["order"]`-style lookups … removing them would halve this file's
hand-written surface."*

Checked: **nothing is scheduled to delete it.** The docstring declines the work itself
(*"Not folded in here"*), `core/tests/propagation.test.ts` already fails loudly if the singular
half is purged so it cannot go vacuous, and core#60 (landed) entrenches `CollectionDocs` rather
than shrinking it. The one live intent is `api-cloudrun/.claude/plans/write-path-typing.md` §3
item B — *"check, but do not blind-delete"* — which defers until *"the dynamic callers' domain"*
is established. ⭐ **So amending that docstring in Phase 1 is an enabler in the other
direction: it supplies the domain and closes that plan's open decision for free.** Say so in
both places.

⚠️ Note the tension with the plural-only subset above: the log field is typed on the *plural*
half, while the *singular* half is what the `uid_{descriptor}` test resolves against. Both
halves end up consumed, for different reasons — state that, or the next reader deletes one.

**Where a named reference still earns its place**: only when a record is about a
*relationship*, not a document — `order_invoice_mirror_repaired` is genuinely about an order
**and** an invoice, and a single `(collection, uid)` pair cannot say that. For a record about
one arbitrary document, the existing `document_path` (`orders/abc`) plus `collection` is the
generic subject and no per-entity field is needed. That test is what decides which `uid_*`
fields survive Phase 3.

## Naming convention (the decided direction)

**`uid_{descriptor}` everywhere — one convention across documents and logs.** core's
existing rule wins; the log schemas' entity-suffix form (`order_uid`) is the minority
convention and is being retired.

⚠️ **State plainly that this WIDENS the convention rather than applying it.**
`core/.claude/plans/uid-convention-and-doc-identity.md` defines it as *"`uid` / `uid_{domain}`
refers to a **Firestore document id**"* — it is scoped to document identity and says nothing
about log fields. Extending it to a second namespace is a decision this campaign is making,
so it needs its own line in `core/CLAUDE.md` § *UID property naming*; otherwise the next
reader finds a rule whose stated scope does not cover half its instances. The counter-case
(OTel and ECS both name attributes entity-first, `user.id` / `http.request.method`) is real
and is why `user_id` and the `xero_*_id` family are carved out below.

Rename set (log field names only), with measured blast radius:

| rename | alert refs | src refs |
|---|---:|---:|
| `order_uid` → `uid_order` | 9 | 44 |
| `invoice_uid` → `uid_invoice` | 8 | 49 |
| `recurrence_uid` → `uid_recurrence` | 5 | 6 |
| `product_uid` → `uid_product` | 3 | 12 |
| `organization_uid` → `uid_organization` | 0 | 8 |
| `settlement_uid` → `uid_settlement` | 0 | 11 |
| `template_uid`, `template_version_uid` | 0 | 7 |
| `session_uid` | 0 | 2 |
| `store_uid`, `invite_uid`, `booking_uid` | 0 | 0 → **delete, don't rename** (dead declarations) |

**Not renamed, and the plan states why so nobody "fixes" them later:**

- `request_id`, `trace_id`, `span_id` — correlation ids, not document references.
- `xero_*_id`, `crms_id`, `calendar_event_id`, `report_id` — **third-party** ids. core's own
  rule reserves `uid_` for CFS document ids.
- `source_doc_id` / `target_doc_id` / `doc_id` — a generic "the document this record is
  about", not a typed reference to a named collection.
- ⚠️ **`user_id` — recommended carve-out, flagged for you to overrule.** It is a `users`
  document reference, so the rule strictly reaches it. Against: `user.id` is the OTel *and*
  ECS conventional name; it is the DSAR redaction key in `scripts/dsar-redact-logs.ts`
  (which deletes by `user_id:"<uid>"`); and it carries a written PII rationale in `core/src/schemas/log/base.ts`
  that names the query form. core/CLAUDE.md already sanctions exactly this carve-out class —
  *"an OAuth 2.1 / RFC 7591 wire name, on the one surface whose job is to mirror an external
  spec"*. 85 src refs, 7 doc refs, 0 alert refs. **Recommendation: carve out and write the
  reason down.** If you'd rather include it, it is a self-contained step in Phase 5.

The rest of the convention, adopted from OTel/ECS and written into the skill: lowercase
snake_case; one name per concept; units in numeric names (`_ms`, `_cents`, `_s`); primitives
or arrays of primitives only, never objects outside `context`; **event names carry no
dynamic values**; never reuse a name for a second meaning.

## Phases

Each phase is one GitHub issue hanging off this doc.

### Phase 0 — Reconcile and prune · `api-cloudrun` · no publish
- A new read-only `api-cloudrun/scripts/audit-log-corpus.ts` — **not yet written**: reconcile
  registry ↔ `rules-vlogs*.yml` ↔ live
  VictoriaLogs. Reports registered-never-emitted, emitted-never-registered, alert msgs
  missing from the registry, and alert group-by fields undeclared. Prints the counts in this
  doc so they can be re-derived rather than trusted. **Add a fifth check: every `collection`
  value in the corpus is a `CollectionName`** — that is the assertion that found defect 11.
  ⚠️ **The obs stack is not reachable from the `cfs-api` MCP.** `cfs-api` / `cfs-api-prod`
  are Firestore + Typesense only (`db_*`, `search_*`, `get_*`, `db_schema`), and the API
  exposes no `/logs` route. Logs live on the separate `victorialogs` / `victoriametrics` /
  `victoriatraces` MCP servers, each with a `-prod` twin — those produced every corpus number
  in this doc. A *script* is not an MCP client, so it queries
  `$DEV_OBS`/`$PROD_OBS` `/select/logsql/{query,field_values,field_names}` with `$OBS_ADMIN`
  from `.envrc`, the form `manager/.claude/skills/logging/SKILL.md` already documents.
- **Fix `typesense_collection_created`** to write `typesense_collection`, and repair the
  three `stats by (collection)` rules that were bucketing physical index names with logical
  ones. Do this in Phase 0, not Phase 1 — it is a live query defect and it is the
  precondition for typing `collection` at all.
- Prune dead msg literals. 🔴 **The criterion is "no emitter in `api-cloudrun/src`",
  cross-checked against live hits — never "no live hits".** Getting this backwards deletes
  correct, brand-new declarations: core has been steadily registering *state-record* messages
  for conditions that have not yet occurred (`il_tax_rate_check`, `settlement_totals_sweep`,
  `store_destination_no_default`, `typesense_sync_state`, `recurrence_horizon_failed`), and
  the four role-lifecycle msgs from Wave 2c whose only UI caller is **manager#321, still
  open**. The `SCHEMA_PENDING_EMISSION` allowlist (11 entries, dated) already tracks part of
  this. Expect 289 → ~180, not → 149.
- ⚠️ **Re-census; do not inherit.** The census on core#65 is a **floor**, not a
  measurement — defect 8 shows the campaign minted ten more undeclared fields after the
  census was taken, and Waves 4/5 will mint more. Take the census after the prerequisite
  waves land.
- ⚠️ Use `rg -a` throughout. `api-cloudrun/src/services/stockSummarySweep.ts` and
  `api-cloudrun/scripts/repair-invoice-structure.ts` still contain raw NUL bytes (`file` reports `data`),
  so a bare grep silently skips them — api-cloudrun#645, still open.

### Phase 1 — Close the envelope, name the bag · `core` · publish
- Every arm interface `extends BaseLogFields`; delete the 22 hand-copies of 7 fields.
- Promote to the envelope what is universal or logger-supplied: `service`, `document_path`,
  `error_name`, `error_message`, `error_stack`.
- Rename `ClientLogRecord.subject` → `email_subject` (breaking; one emitter,
  `routes/clientLogs.ts`; one line in `manager/.claude/skills/logging/SKILL.md`'s field
  table).
- Replace `[key: string]: unknown` with `context?: Record<string, JsonPrimitive | JsonPrimitive[]>`
  on every arm. Move the 11 top-level spread sites into it
  (`middleware/logging.ts`, `lib/logPropagation.ts` ×2, `lib/xeroIntervention.ts`,
  `lib/taxReviewReport.ts`, `lib/uploadcare.ts`, `lib/instrumentedTransaction.ts` ×2,
  `routes/clientLogs.ts`, `routes/tasks.ts`, `services/trackingOptionAudit.ts`).
- Add `NoExcessProperties` to `logTyped`'s signature in `api-cloudrun/src/lib/logger.ts`.
- Type `logError` / `logTimed` / `log.*` through the registry so `msg` narrows `fields`.
- **Type `collection` as `CollectionName`** (type-only import — see the section above), and
  amend `schemas/mod.ts`'s `CollectionDocs` docstring: the singular half is no longer
  "may be vestigial", the log fields consume it.

### Phase 2 — The alert contract test · `api-cloudrun` · no publish
A new `api-cloudrun/tests/unit/alertRuleContract.test.ts` — **not yet written** — parses
`api-cloudrun/infra/observability/vmalert/rules-vlogs*.yml`
and asserts, in both directions:
- every `msg:<literal>` in an `expr:` or a `logsql:` annotation is in `MSG_SCHEMA_REGISTRY`;
- every field in a `stats by (…)` / `unpack_json fields (…)` is declared for the msg that
  rule filters on.

Lands red on the 37 → declare them → green. ⚠️ **Pair it with an independent property, per
the item-paths lesson**: a check defined in terms of the registry can only ever agree with
the registry. The independent half is Phase 0's corpus reconcile — the alert names a field
the *corpus* actually carries. **This is the highest-value single item and it does not
depend on Phase 3.**

### Phase 3 — Per-msg grain · `core` · publish
- Add `LOG_EVENTS` as designed above. Derive `MSG_SCHEMA_REGISTRY` from it so the two cannot
  drift; the union↔registry symmetry test in `core` becomes a symmetry test against one
  source.
- The prose field lists already in msg docstrings (`{ checked, expiring_soon, expired,
  sample }`) become the `fields` arrays. **The docstring keeps the *why*; the array owns the
  *what*.**
- Apply the relationship test from the collection-registry section: a `uid_*` field survives
  only where the record is about a *relationship* between named entities. Records about one
  arbitrary document drop theirs in favour of `collection` + `document_path`. Add the
  registry-resolution test for whatever survives.
- ⚠️ Keep arm-level Zod schemas as they are. Do not mint 294 Zod objects, do not build a
  per-msg `z.discriminatedUnion` (see the two mechanics above).

### Phase 4 — Catalogue and skill · `core` + `claude-plugins` · publish
- `deno task docs:log-catalogue` renders `LOG_EVENTS` to a committed
  `core/docs/log-catalogue.generated.md` (**not yet written**) — msg, archetype, level, brief,
  declared fields with
  types, and which alert consumes it. Gate with the **existing non-destructive pattern**:
  generator takes `--stdout`, task pipes into `diff -u` against the committed copy, wired
  into `check:generated` (`.githooks/pre-commit` + CI). Proving the file is current must
  never write it.
- New `cfs-logging` skill in the `cfs-skills` plugin (org-shared, so cloud agents get it):
  the naming convention, the `uid_{descriptor}` ↔ log-field boundary, the "how to add a
  message" recipe, the `context`-bag rule, and the LogsQL cookbook.
- **Retire the duplicates**: delete `api-cloudrun/.claude/commands/obs.md`'s hand-maintained msg catalogue and field table
  and point at the generated file; cut `manager/.claude/skills/logging/SKILL.md`'s
  convention section down to a pointer (⚠️ its example currently teaches `order_id`, a
  third spelling, and is a live drift source); trim `api-cloudrun/CLAUDE.md`'s Structured
  Logging section to the skill reference. Derive `SAFE_PASSTHROUGH` from `LOG_EVENTS` rather
  than hand-listing 27 names. ⚠️ **That derivation is gated on Phases 1 and 3 having landed**
  — about 10 of the 27 keys (`estimated_json_bytes`, `fields_declared`, `rules_fired_count`,
  `rules_expected`, `target_count`, `mode`, `source`, `target`, `tx_name`, `rule_id`) exist in
  logs *only* because the arms carry index signatures. Derive it earlier and it collapses to a
  list that exempts the wrong keys.
- ⚠️ **Deleting a cited path turns the OTHER repo red.** The retirement edits remove prose
  that the cross-repo citation gate resolves; sequence each deletion with the edit that stops
  citing it, in the same push.

### Phase 5 — Normalise the names · `api-cloudrun` + `core` · publish

⚠️ **Split this by whether there is a defect to repair.** Defect 7's corpus measurement says
`order_*` is the only live one.

- **5a — the repair (do first, alone).** `order_uid` / `order_id` / `uid_order` → `uid_order`.
  3,039 records currently unreachable from the majority spelling; 9 alert references; the
  `order_id` fifth is five call sites in `api-cloudrun/src/services/processTrelloQueue.ts`.
  This is the half that needs the coalescing bridge and the canary.
- **5b — the consistency pass (batch with any later publish).** `invoice_uid`,
  `product_uid`, `recurrence_uid`, `organization_uid`, `settlement_uid`, `template_uid`,
  `template_version_uid`, `session_uid`. Single-spelling in the corpus today, so **no bridge
  and no canary are needed** — nothing is being missed by a query now. Do not spend the
  90-day ceremony on these.
- **Delete, don't rename**, the three dead declarations (`store_uid`, `invite_uid`,
  `booking_uid` — 0 src references, 0 records).
- Codemod the call sites with **ast-grep**, scoped to the logger call — never a blanket
  `sed`, because the same identifiers are Firestore *document* fields elsewhere:
  ```yaml
  rule:
    kind: property_identifier
    regex: ^(order_uid|invoice_uid|product_uid|recurrence_uid|order_id)$
    inside:
      any: [ {pattern: logTyped($$$A)}, {pattern: logError($$$A)}, {pattern: logTimed($$$A)} ]
      stopBy: end
  ```
  ⚠️ Four classes the rule cannot see, each needing a hand pass: **shorthand properties**
  (`{ order_uid }` is `shorthand_property_identifier`, a different node, and renaming the
  key alone breaks the binding), **computed keys**, **spreads**, and **string-keyed access**
  downstream.
- **Do not dual-emit.** Retention is 90 days, so dual-emitting for N days pushes the last
  legacy record to `cutover + N + 90`. Hard cutover plus **query-time coalescing** in the 25
  affected alert-rule references for one retention window:
  ```
  | format "<order_uid><uid_order>" as uid_order keep_original_fields skip_empty_results
  | stats by (uid_order) count()
  ```
  `keep_original_fields` makes an existing value win; `skip_empty_results` writes nothing
  when all sources are empty. ⚠️ Confirm the deployed VictoriaLogs is ≥ v1.35.0 — pipes
  ahead of `| stats` in vmalert instant queries landed there.
- **Add the canary** (5a only), the cheapest completeness proof available:
  ```
  _time:1h (order_uid:* OR order_id:*) | stats count() legacy_hits
  ```
  Alert on `legacy_hits > 0` after cutover. Converts "did the codemod get them all?" from
  hope into a page. A non-zero reading means a missed call site — fix it, never extend the
  window.
- Day 91: strip the `format` pipes, collapse the rules to the single name, retire or demote
  the canary.

## Corrections this campaign makes to the core#65 census — do not re-derive

The census was right to refute the prescribed fix and wrong on three figures. All three come
from the same cause: **it measured source, and the thing a query sees is the corpus.**

- **"A dashboard querying `order_uid` silently misses 8 records."** It misses **3,039**
  (20.2% of 15,069). Eight is the call-site count; the record count is 380× larger, because
  five cold-looking sites in `api-cloudrun/src/services/processTrelloQueue.ts` produce a fifth of the corpus.
- **"`order_uid`(30) / `order_id`(4) / `uid_order`(4)."** By record: 12,030 / 2,869 / 170 —
  `order_id` is the *second* spelling, not the third.
- 🔴 **"7 of 20 arms … have zero undeclared fields and can lose their signature today" is
  false for at least `client`, and it is labelled "free".** There are **22 union arms, not
  20** (24 files, two of them infra). And a real prod `client_log` record reads:

  ```json
  { "msg":"client_log", "client_msg":"listener_error", "page":"/templates/9c4…",
    "error":"Missing or insufficient permissions.",
    "error_name":"FirebaseError", "error_code":"permission-denied" }
  ```

  `error`, `error_name` and `error_code` are **not declared on `ClientLogRecord`** — they
  arrive through `...entry.data` in `api-cloudrun/src/routes/clientLogs.ts`, the exact
  top-level-spread class the census itself flagged as invisible to a key-based parse. The
  "free 7" list was derived by that parse and inherits its blind spot. **Re-derive every arm
  against the corpus before deleting any signature**, and expect the same to hold for
  `propagation` (`...context`, `...extra`) and `transaction` (`...counts`).
- **`~296 undeclared field names`** is not the number that matters. **37** is: the count that
  a production alert rule actually groups by.

## Explicitly not doing

| | Why |
|---|---|
| OTel Weaver registry + Rego policies | Governance tooling for multi-team public telemetry. `LOG_EVENTS` is 90% of it at 2% of the setup. Revisit at ~10 people. |
| OTel schema files + `schemaprocessor` | Development-stability, not in official collector distros; and a many-to-one alias collapse is *irreversible* in that format anyway. |
| An MCP server for the catalogue | MCP **resources** are not read by any major client, and a tool call is strictly worse than an agent grepping a typed source file it already has open. |
| A custom `deno lint` plugin | Types + `tsc` cover it. Revisit only for what types cannot express (computed keys, string-literal keys, PII-shaped names). |
| Dotted OTel field names (`order.uid`) | Most conformant, but rewrites all 70 alert rules and every documented query. The resource attributes already use dots; application fields stay flat. |
| Backfilling historical logs | They expire in 90 days. |
| Segment / Avo tracking-plan SaaS | Right architecture, wrong product shape. The patterns are stolen above. |

## Landing this doc, and the issues

⚠️ **This file is inside `deno task audit:citations --strict`'s scan set**, which fails
AMBIGUOUS as well as BROKEN — and CI checks out core *alone*, so a bare "logger dot ts" or
"destinations dot ts" would be broken there, not merely ambiguous. Every core path is
directory-qualified (`schemas/log/base.ts`) and every foreign one repo-qualified
(`api-cloudrun/src/lib/logger.ts`,
`api-cloudrun/infra/observability/vmalert/rules-vlogs.yml`,
`manager/.claude/skills/logging/SKILL.md`). Keep it that way when editing.

⚠️ **`core` was being actively worked by a peer session while this was written, and the state
moved underneath it.** Between the first and last draft the core issues roadmap was retired
and deleted, Waves 4–7 landed, all four pins converged on `beta.251`, and api-cloudrun#655 was
filed. Every state claim here was re-verified on 2026-08-24 — but **re-verify again before
acting**, and treat this paragraph as the reason to, not as an excuse to skip it.

**Filed 2026-08-24 — two issues, not six.** Per the deferred-work rule (*cross-repo work gets
one issue in the primary repo, with the others named in the body*), the phases are grouped by
repo rather than one issue each:

- **core#65**, re-scoped and retitled — the core half (Phases 1, 3, 4). Not closed: its census
  comment is the campaign's origin.
- **api-cloudrun#656** — the api-cloudrun half (Phases 0, 2, 5).

Both link this doc; each carries the constraints that bite in its own repo. Cross-reference `api-cloudrun#645` from
Phase 0 (its NUL bytes make every grep-based census in that repo incomplete, and both files
are still `data` to `file(1)` today).

**Publish cost.** Each core publish needs three pin bumps. ⭐ **The skew is currently zero** —
re-verified 2026-08-24: `api-cloudrun/deno.json`, `manager/package.json` and `templates`
`origin/main` are all on `10.0.0-beta.251`. That is the cleanest starting position this
campaign will get; the previous 248/247/244/241 spread was cleared by the roadmap's last waves.

⚠️ **Carry no subpath count, for either repo.** The retired roadmap recorded the correction and
this plan repeated the mistake twice before it was caught: *"the templates pin count is
BRANCH-DEPENDENT (`main` 7, a draft branch 8) — read the version off `origin/main`, bump by
`sed` over the pattern, carry no count."* And `api-cloudrun/deno.json` reads **29** `@cfs/core`
lines today, against 26 / 28 / 30 in three separate prior write-ups including this one. `sed`
over `jsr:@cfs/core@<old>/`; never a remembered number. templates' bump goes via a PR.

The logging campaign adds **no new subpath**: manager imports only `ClientLogEntry` /
`LogLevelType` from the `@cfs/core/schemas` barrel and never `ClientLogRecord`, so the
`email_subject` rename does not reach it; templates does not import `schemas/log` at all.

⭐ **The log schemas have exactly one real consumer** — api-cloudrun. So a logging publish
costs one substantive pin bump and two mechanical ones, and with no skew to resolve these 2–3
publishes are a clean block.

## Verification

- **Phase 0**: `deno run -A api-cloudrun/scripts/audit-log-corpus.ts` re-derives the counts in
  this doc.
  Numbers that disagree mean the corpus moved, not that the doc is wrong — update both. The
  `collection` check must land red on the 29 Typesense index names and go green only after
  the emitter is fixed; re-verify with
  `mcp__victorialogs-prod__field_values` on `collection` (the query that found it).
- **Phase 1, PII**: plant a `RUNTIME_DENYLIST` key (`email`, `authorization`) inside
  `context` and assert the emitted JSON shows `[REDACTED]`. Then plant the same key at the
  top level and assert it still is. **Both arms** — the first fails today if `context` is
  declared naively, the second is the control that proves the test can see anything at all.
- **Phase 1/3**: `deno task check`, `deno task lint`, `deno task check:declarations` (the
  JSR-emit gate — a type it cannot derive is *published wrong*, not rejected), `deno task
  test` in core; then `deno task check` in api-cloudrun against the new pin. A green
  `check:declarations` is not optional here — `LOG_EVENTS` is exactly the shape of construct
  that broke in core#43/#44.
- **Phase 2**: the test lands red at 37 findings and goes green only by declaration, never
  by allowlist. Verify it can still fail: plant a bogus field in a rule's `stats by`.
- **Phase 4**: `deno task check:generated` red on a stale catalogue; confirm proving it
  current does not rewrite it.
- **Phase 5**: `deno task test` in api-cloudrun; then the live checks — run each edited
  alert's `expr:` against dev and prod VictoriaLogs via the MCP tools and confirm it returns
  rows for both spellings during the bridge; watch the canary for one week.
- **End to end**: emit one record of a renamed msg from dev, then
  `mcp__victorialogs__field_names` on it and confirm the field set matches the generated
  catalogue row exactly. That is the only check that closes the loop from type → emitter →
  storage → catalogue.

## When to pick this up

The core gate is **clear as of 2026-08-24** — the roadmap is retired, pins are level at
`beta.251`, and `core/src/schemas/log/` is unchanged since these measurements. The remaining
trigger is **"api-cloudrun#442 and #444-B have landed"**; #506 only gates Phase 5.

First action when it is next: re-run the census (Phase 0). The numbers in *What is true today*
are recorded so movement is visible, not so they can be trusted — and defect 8 is the standing
proof that they move without anyone touching this campaign.

## Context recommendation

**Clear.** This session's value is the measurement and the design, both captured above, and
its outcome is a promoted doc plus filed issues, not started work — the remaining gate is
api-cloudrun#442 / #444-B, which share nothing with this transcript. When Phase 0 eventually
runs it is a fresh, self-contained session — write the audit script, run it, prune from its
output — and needs none of the exploration here; the numbers it must reproduce are in the
tables above.
