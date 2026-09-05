# `NamePartsFields` → bare `.nullable()` — expand/migrate/contract

> Owning repo `core`; the work also lands in `api-cloudrun` and `manager`.
> **Step 1 of 3 is published (`10.0.0-beta.337`, `fa41c5f`). Steps 2–6 remain — core#84.**
> Tracks the owner's ruling in core#83.

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
2. ⛔ **`api-cloudrun` — one PROD deploy.**
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
3. ⛔ **`manager` — pin + deploy.** Readers are unaffected (`filter(Boolean)`); audit the 8
   files naming a part for form writers needing `?? null`.
4. ⛔ **Backfill — PROD only.** `devReplica` mirrors prod→dev, so a dev-first pass **doubles
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
