# `NamePartsFields` → bare `.nullable()` — expand/migrate/contract

> Owning repo `core`; the work also lands in `api-cloudrun` and `manager`.
> **Steps 1–4 are DONE. Steps 5–6 remain — core#84.** Tracks the owner's ruling in core#83.
>
> ## ⚠️ STATUS 2026-09-05 (3rd update, compacted) — steps 1–4 DONE, prod backfilled
>
> | step | state |
> |---|---|
> | 1 — core WIDEN | ✅ `@cfs/core@10.0.0-beta.337` (`fa41c5f`); latest is now `beta.341` |
> | 2 — api-cloudrun writers | ✅ pushed AND **DEPLOYED** — prod `v0.228.0`, revision `api-cloudrun-00342-8zk` |
> | 3 — manager pin + writers | ✅ pushed `eedaced`, pinned `beta.341`; preview deploy follows `main` |
> | 4 — prod backfill | ✅ **DONE 2026-09-05** — 354 prod docs, 18 dev residue, both post-audit 0 |
> | 5 — core CONTRACT | ⛔ ← NEXT |
> | 6 — pins, deploys, fixture sweep | ⛔ **blocked** — see api-cloudrun#865 |
>
> ### Step 4 — done, and it CORRECTED this plan's central sizing claim
>
> 🔴 **The population was 354 documents, not the ~4,835 sized below.** The surface table's
> per-collection counts are DOCUMENT counts, and this plan read them as documents needing
> repair. They are not — the destination-embedded contacts are almost entirely **null legs**:
> 1,151 of 1,153 cards, 2,032 of 2,032 order legs, 2,012 of 2,012 invoice legs. So the
> **"3,711 whole-document array rewrites" flagged as the risky bulk were 2 documents**, and
> the real work was `contacts` 170 and `organizations` 179 — both flat shapes.
> ⭐ **The instrument is `api-cloudrun/scripts/backfill-name-parts-null.ts`**, which reports
> `contact objects entered` and `null legs left alone` per collection precisely so this
> distinction cannot be lost again.
>
> | | prod `cfs-3100` | dev residue |
> |---|---|---|
> | written | **354** | **18** |
> | post-audit re-run | **0** | **0** |
> | unexpected shapes | 0 | 0 |
>
> **Verified by a SECOND, independent instrument**, because the backfill's own re-read
> agrees with itself by construction. `api-cloudrun/scripts/audit-field-presence.ts` asks
> key-presence through `orderBy` instead, and its deltas match the writer's own tallies
> exactly: `contacts.middle_name` 8/170 present → 170/170 with **162 null** (+162),
> `last_name` 165 → 170 with 5 null (+5), `pronunciation` 0 → 170 with 170 null (+170).
>
> **Typesense parity re-checked per collection against a PRE-write baseline** — a post-hoc
> reading alone only says "is it clean now". Identical both sides: contacts 170, orgs 318,
> orders 1,017, invoices 1,037, fulfillments 1,017.
>
> ⚠️ **The deploy really was the gate, and it is now proven rather than assumed.** Prod ran
> `v0.227.0`, which pins `@cfs/core@10.0.0-beta.336` — whose `NamePartsFields` is
> `z.ZodType<string | undefined>`, i.e. **null-rejecting**. Backfilling before the rollout
> would have made all 354 documents fail `validateBeforeWrite` on their next write through
> the live API. `v0.228.0` pins `beta.338`. ⚠️ **Check the deployed TAG's pin, not `main`'s.**
>
> ⚠️ **A Cloud Run deploy is not done when the image spec changes.**
> `spec.template.spec.containers[0].image` is the DESIRED state and flips immediately; a
> watcher on it reported "deployed" while revision `00342-8zk` was still provisioning and
> 100% of traffic sat on the old one. **The predicate is `status.latestReadyRevisionName`
> plus the traffic split.**
>
> ⭐ **The fan-out was assessed before writing, and the activity feed's own filters carried
> it** — ~3 rows, not ~352. `contacts`' name parts carry `pii: "mask"` but **no `label`**, so
> capture filter 2 drops them; `organizations` is `NO_ARRAYS` in `DIFFED_ARRAYS`, so its
> `contacts` path is dropped as an undiffed array. Only the 1 order (`destinations` IS
> diffed) and the 2 cards (`destination.contact` is labelled) produce rows. **Ask this
> before any bulk write — the answer was not obvious from the collection list.**
>
> 🔴 **Step 6 has a NEW blocker that has nothing to do with this work: api-cloudrun cannot
> pin past `beta.338`.** `beta.339` deleted the CRMS transaction/rule definitions, and
> api-cloudrun still names `crms-opportunity-order` as a live `RebuildOrigin` in
> `api-cloudrun/src/lib/taskQueues.ts` and `api-cloudrun/src/services/bookingAllocationRecompute.ts`, so
> `api-cloudrun/tests/unit/propagationCoverage.test.ts` reds on any bump. Removal belongs to
> api-cloudrun#556 and carries its own ordering question (a queued stock-summary rebuild
> already in flight carries that origin and would fail on dequeue). Tracked as
> **api-cloudrun#865**. ⚠️ Step 5 publishes a beta that api-cloudrun must then pin — so
> **#865 is on step 6's critical path**, and it is not this campaign's to decide.
>
> ### Step 3 — what actually landed, and the finding that changes step 4's ordering
>
> The plan said "readers are unaffected; audit the 8 files naming a part for form writers."
> The measured surface was **12 files**, and it split three ways, not one.
>
> 🔴 **manager constructs 2 of the 6 STORED `z.strictObject` types CLIENT-SIDE** —
> `DocDestinationContact` and `OrganizationContact` — through **9 conditional spreads**
> (`manager/src/components/organizations/OrgContacts.tsx` ×3,
> `manager/src/components/orders/OrderDestination.tsx` ×6) plus one construction that omitted all
> three parts outright. That makes manager a *stored* writer, not merely an input client,
> and gives it two ordering consequences the plan did not name:
> 1. **after step 4 the spreads would silently RE-OMIT keys the backfill had just written**,
>    decaying `orders/invoices/fulfillments.destinations[]` and `organizations.contacts[]`
>    row by row on every contact re-selection;
> 2. **after step 5 they would 400**, the key being required.
>
> ⭐ **So manager's writers had to ship BEFORE the backfill, not after it** — step 3 is not
> the "pin + deploy" the plan described. All 9 converted with `|| null`; input-side writers
> (`dropBlankNameParts`, `InviteUser`, `AcceptInvite`'s overrides) deliberately left
> omitting, because their schemas are `z.object` INPUT sites that keep
> `.nullable().optional()`. **Normalize at the writer, require at storage** — verified, not
> assumed: the 6/6 STORED/INPUT split was re-derived independently and matches (table below).
>
> ⭐ **The completeness grep earned its cost again, and in a new way.** The site it caught —
> `manager/src/components/threads/buildThreadLabel.ts` — is invisible to a
> `middle_name|pronunciation` grep because it names only `first_name`/`last_name`.
> **The miss was in the PATTERN, not in the walk.** Widen the pattern to all four parts, and
> re-run it after every batch.
>
> ⚠️ **`getInitialValues` now seeds `null`, and `draftSeed` deletes it** —
> `manager/src/primitives/createEntityCache.ts:57-61` strips every null from the seed, so a
> draft carries absent keys where storage wants null. Harmless today (masked by
> normalization at every stored-write site) and **filed rather than changed**, since the
> blast radius is cross-store: **manager#388**. ⭐ Expect this shape at every core#83
> conversion — a seed and a schema that disagree about what `null` means, both individually
> correct.
>
> ⚠️ **A stale test oracle, not a code defect.**
> `manager/src/stores/__tests__/contacts-create.test.ts` asserted a raw
> draft is REJECTED on all three parts — true only while the seed was `""`. It now seeds
> `null`, `draftSeed` strips it, and the draft is accepted. Replaced with the chain asserted
> end to end plus a guard that `""` is still rejected. **A green suite would have hidden the
> widen working; the red one is what surfaced the seed change.**
>
> ⚠️ **manager#338 is NOT unblocked by this campaign.** Clearing a part on a SAVED contact
> goes through `NamePartsFieldsPartial`, which was deliberately left un-widened —
> **core#70**, not core#83/84. Commented on the issue so a triage pass does not read step 5
> landing as this becoming ready.
>
> ⭐ **The Typesense hazard is DISPROVEN** and needs no work at any step — see below.
>
> ### Kept, because it explains the shas
>
> Step 2 landed in an 11-commit push across six sessions (`origin/main` = `2be67cda`). The
> first attempt failed the gate on an unrelated peer's fixture defect — fulfillment seeds
> copying a live order's `items[]` without restamping `uid_order` — which is worth knowing
> as evidence the ~9min gate earns its cost. Five commits had sat unpushed across three
> sessions; a push carried all of them. Oldest first: `18da711c` (docs, peer) · `cfa294da`
> (mine) · `009fe58d` (docs, peer) · `07b20755` (`fix(rbac)`, peer) · `5342a1ac` (mine).
> ⚠️ Only `18da711c:main` excludes both of mine — `07b20755:main` carries `cfa294da`,
> because a push range is decided by ANCESTRY, not by the order a log was read in.
>
> **Step 2 verified**: `check` 0, `lint` 0, `test:units` 1816/0, and integration
> contacts 2/30 · invites 1/8 · organizations 4/67 · crms webhooks 2/65 — the last
> being the one the pre-push gate `--ignore`s, so it needs running by hand.
> **Step 3 verified**: `tsc` 0, `lint` 0 (372 citations, 0 broken), `vitest` 1502/1502.
>
> ### 🔴 Two findings from step 2 that still change steps 5–6
>
> 1. **There is a second writer family: MUTATIONS and COMPARISONS, not just
>    constructions.** Nine `delete target.<part>` clears beyond `applyNameParts`, and —
>    the sharp one — **three change-detection comparisons that fire a FALSE RENAME
>    CASCADE once storage holds `null`.** `splitFullName` yields `undefined` for an
>    absent part; `undefined !== null`; so every CRMS member webhook for a contact with
>    no middle name would report a rename and fan out. **The writers are what make the
>    readers wrong**, so the two cannot be split across commits. ⭐ Expect the same
>    shape at every other `.nullable().optional()` conversion in core#83 — any reader
>    comparing a fresh value against a stored one. ✅ manager's equivalent comparisons
>    (`manager/src/routes/AcceptInvite.tsx`) were checked and are already null-safe: both sides
>    normalize through `?? ""`.
> 2. **`|| null`, not `?? null`.** The conditional being replaced tested TRUTHINESS, so
>    `""` produced an absent key. `?? null` passes `""` through to fail `min(1)`;
>    `|| null` is exactly equivalent to what was there. ✅ Applied throughout step 3.

## Context

The owner ruled 2026-09-05: **prefer `.nullable()` over `.optional()`** for a stored field —
present-and-null, never absent, because absence is the state that yields `undefined` and
breaks writers (an invoice missing `reference` 400'd an unrelated ORDER update).

`NamePartsFields` (`src/schemas/common.ts`) declares `middle_name` / `last_name` /
`pronunciation` as **bare `.optional()`**, so they are not among core#83's 178 — they sit in
the ~559 that issue excludes as "a different question". **That exclusion is over-broad.**
These three have one owner, one edit, and **30 resolved storage positions across ten stored
surfaces** — more stored reach than core#83's entire censusable set.

## The surface — measured in prod 2026-09-05

| stored at | docs | backfill shape |
|---|---|---|
| `contacts` | 170 (dev 178) | field write |
| `users` | 1 (dev 2) | field write |
| `invites` | **0** (dev 3) | field write |
| `cards.destination.contact` | 1,153 | **filtered** field write — a blind write CREATES the map where `destination` is null |
| `recurrences.prototype.destination.contact` | **0** | — |
| `organizations.contacts[]` | 318 | **document rewrite** |
| `destinations.contacts[]` | 322 | **document rewrite** |
| `orders.destinations[]` | 1,017 | **document rewrite** |
| `invoices.destinations[]` | 1,037 | **document rewrite** |
| `fulfillments.destinations[]` | 1,017 | **document rewrite** |

**~4,835 prod documents; 3,711 need whole-document array rewrites.** `pick-sheets` is a
render model, never stored — type only.

Key presence, prod / dev: `middle_name` 8/8, `last_name` 165/171, `pronunciation` **0/0**.
The `pronunciation` reading reproduces the "0 of 166, 2026-08-23" note in
`src/schemas/common.ts` independently, which also calibrates the oracle — a disabled
single-field index would read 0 across all three, and `last_name` is 165.

## Two things that already hold, both checked

- ⭐ **`deriveName` needs no change.** `[first, middle, last].filter(Boolean)` drops `null`
  exactly as it drops `undefined`. Its *parameter* widened to `NamePartsLike` —
  deliberately not a widening of `PartialNameParts`, because whether the INPUT contract
  gains a `null` "unset" verb is core#70's open decision.
- ⭐ **Typesense accepts these nulls.** Measured against the prod index, not reasoned:
  `Invoice.reference` is null on 857/1,037 invoices against a sortable `string` field and
  `search_invoices` returns 1037/1037; `orders.items[].inclusion_type` (`string[]`),
  `.price.replacement_cents` (`int64[]`) and `.price` (`object[]`) all carry nulls today
  and `search_orders` returns 1017/1017. **No translate change, no config change.**
  The `GEOPOINT_KEYS` carve-out in `api-cloudrun/src/lib/typesenseTranslate.ts` is specific
  to `geopoint[]` requiring a `[lat, lng]` 2-tuple per element and does not generalise —
  which is why it had to be measured rather than assumed either way.

## The ordering — two publishes, and why it cannot be one

`.optional()` accepts `string | undefined` and **not** `null`, so under the deployed schema
no writer could stamp a null and no backfill could run. Hence expand/migrate/contract.

1. ✅ **`core` — WIDEN.** `.nullable().optional()`, interfaces `?: string | null`.
   Published `10.0.0-beta.337`. The 30 transit paths are catalogued `mid-expand` in
   `tests/stored-optionality.test.ts`; the contract step empties that block.
2. ✅ **`api-cloudrun` — committed, not pushed; the PROD deploy is still owed.**
   - pin to `10.0.0-beta.337` **by pattern** (`grep -c 'jsr:@cfs/core@' deno.json` says how
     many — 33 today), then `deno task check`. ⚠️ This is what reveals whether the widened
     `string | null | undefined` breaks a consumer; `ContactDenormPatch`
     (`api-cloudrun/src/lib/contactDenorms.ts`) declares its own `middle_name?: string` and
     is the likeliest break. `buildActorRef` is already fine.
   - the 10 conditional spreads `...(middleName ? { middle_name: middleName } : {})` →
     `middle_name: middleName ?? null` — `api-cloudrun/src/routes/auth.ts:417`,
     `api-cloudrun/src/services/users.ts:117`, `api-cloudrun/src/services/contacts.ts:151,185,453`,
     `api-cloudrun/src/services/organizations.ts:1022,1047,1861,1887`, `api-cloudrun/src/services/invites.ts:144`.
   - `api-cloudrun/src/routes/invites.ts:153-156` `??` → `"key" in body`. Needed regardless
     of core#70's shape: that path cannot express a clear today, while
     `api-cloudrun/src/services/contacts.ts:414-416` already can.
   - 🔴 **merge the release-please PR.** Dev is not enough — the backfill needs the
     *deployed* build (api-cloudrun#782), and until this ships nothing may write a null.
3. ✅ **`manager` — pin + WRITERS.** Committed `eedaced`, pinned `10.0.0-beta.341`.
   ⚠️ **Not the "pin + deploy" this line originally described** — manager builds two of the
   six STORED `z.strictObject` types client-side, so its 9 conditional spreads had to be
   normalized to `|| null` BEFORE the backfill, not after it (see the status block). Readers
   were indeed unaffected (`filter(Boolean)` / `?? ""`). The surface was 12 files, not 8, and
   three narrow local interfaces receiving stored data were widened to `string | null` —
   invisible to the type checker today, a compile error the moment step 5 lands.
   ⛔ **Deploy still owed** (manager deploys continuously from `main`; push carries it).
4. ✅ **Backfill — PROD only. DONE 2026-09-05** (354 prod / 18 dev residue, both
   post-audit 0). Instrument: `api-cloudrun/scripts/backfill-name-parts-null.ts` — a
   one-shot, so DELETE it once step 6 lands. Details in the status block above. `devReplica` mirrors prod→dev, so a dev-first pass **doubles
   every row**: run prod, let the mirror carry it, then a dev-only residue pass (dev has
   documents prod does not — contacts 178/170, users 2/1, invites 3/0).
   - baseline audit → repair → post audit → **diff the pair**; a post-hoc audit answers
     "is it clean", only the pair answers "what did I cause";
   - resumable, asserting the destination rather than the absence;
   - **verify array members by paged re-read** — `orderBy` cannot see one. That instrument
     also serves core#83's 29 `array-member-uncensusable` paths.
   - re-check Typesense parity per collection afterwards (`found` vs the Firestore count).
5. ⛔ **`core` — CONTRACT.** Bare `.nullable()`, interfaces `: string | null`. Breaking,
   cheap on `beta`.
   🔴 **Before cutting the beta, grep the `enforced_by` anchors against the CONSUMER tree.**
   `@cfs/core` ships *claims about its consumer* — `enforced_by` refs, citation paths —
   alongside its types, and those resolve at the **consumer's** gate, invisibly to the type
   checker. `core`'s own `propagation.test.ts` validates ref SHAPE but only resolves refs
   into `core/`, so an `api-cloudrun/...` anchor is unchecked until a consumer's pin moves.
   Measured 2026-09-05 by a peer: `beta.338` declared two `enforced_by` refs naming an
   api-cloudrun test anchor that did not exist yet, and the bump alone reddened a hermetic
   ratchet for the whole checkout. Anchor first, then publish.
   🔴 **This step must SPLIT the block.** `NamePartsFields` is spread into **6 STORED
   (`z.strictObject`) and 6 INPUT (`z.object`)** sites, and requiring the key on an input
   would 400 every create client that omits a middle name. Normalize at the writer, require
   at storage.
6. ⛔ **Pins, deploys, fixture sweep.** `getTestDoc` flips OMIT → `null` automatically
   (`src/schemas/testing.ts`), so core's own fixtures move for free; api-cloudrun's
   hand-spelled seeds do not. Census **by document shape**, classify **by receiver bound to
   its declaration**, skip any body containing `...`. Expect the 7-red-files class.

## ⚠️ Blocker as of 2026-09-05

`api-cloudrun`'s working tree is held by another session — 9 uncommitted files
(five `api-cloudrun/src/lib/` and `api-cloudrun/src/services/` modules + 4 tests), unrelated to this work. That
repo's pre-commit and pre-push gates scan the **whole working tree**, so their unfinished
work would gate any commit here, and editing `deno.json` risks their next `git add .`
sweeping the pin bump in. **Resume step 2 when their tree is clean, or take a worktree.**

⚠️ Renovate auto-bumps `api-cloudrun` and `manager` "before 5am", so `beta.337` may arrive
as a routine dependency PR before step 2 is done. That is safe — the widen only ever
ACCEPTS more — but if that PR goes red, the typecheck in step 2 is the reason.

## Context recommendation

**Clear between steps**, which the ordering forces rather than merely suggests: step 4
cannot start until step 2's build is live in prod, and step 5 cannot start until step 4 is
verified. Step 4 deserves its own session — it is an irreversible bulk write across five
collections with a baseline/verify discipline that should not share attention.

## Related

- core#83 — the campaign this belongs to; its body carries the corrected scope and the
  both-environment census.
- core#70 — the INPUT-side "unset" verb. Independent: `tests/stored-optionality.test.ts` is
  registry-scoped, so its three arms are excluded by construction.
- api-cloudrun#556 — the CRMS removal decision that core#83's `crms-pending-removal`
  exclusion defers to.
