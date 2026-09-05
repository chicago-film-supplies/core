# `NamePartsFields` → bare `.nullable()` — expand/migrate/contract

> Owning repo `core`; the work also landed in `api-cloudrun`, `manager` and `templates`.
> **Steps 1–6 are DONE except one merge. Tracks core#84 / the owner's ruling in core#83.**
>
> ## ⚠️ STATUS 2026-09-05 (4th update, compacted) — the contract is SHIPPED; one PR left
>
> | step | state |
> |---|---|
> | 1 — core WIDEN | ✅ `@cfs/core@10.0.0-beta.337` |
> | 2 — api-cloudrun writers | ✅ deployed, prod `v0.228.0` |
> | 3 — manager pin + writers | ✅ `eedaced` |
> | 4 — prod backfill | ✅ 354 prod docs, 18 dev residue, both post-audit 0 |
> | 5 — core CONTRACT | ✅ **`39e7c45`, published `10.0.0-beta.343`** |
> | 6 — pins, deploys, fixture sweep | ✅ `api-cloudrun` `14c70c61` · `manager` `48ffa36` · ⛔ **`templates` PR #219 awaits a human merge** |
>
> ### What is actually left
>
> 1. **Merge `chicago-film-supplies/templates#219`** (pin + one fixture repair). It is
>    deliberately NOT auto-mergeable: `templates/CLAUDE.md` limits that row to
>    `deno.json`/`deno.lock`-only PRs, and a pin bump that also repairs a fixture is the
>    combination § *"Adding a dependency"* says to expect and to land as one PR.
> 2. **Delete `api-cloudrun/scripts/backfill-name-parts-null.ts`** — a one-shot, applied in
>    both environments. ⚠️ **Delete THIS DOC in the same sitting and FIRST**: those two files
>    are the only things in the workspace naming that script (grepped 2026-09-05), so
>    removing the script while this doc still cites it turns `core`'s citation gate BROKEN
>    and makes `core` unpushable for every session sharing the checkout.
>
> ### Step 5 — what shipped, and the one thing it corrected
>
> The block **SPLIT**, as planned, 6 STORED / 6 INPUT. What the plan got wrong is that the
> split is not a property of the TYPE:
>
> 🔴 **An INPUT schema can embed a STORED strict object, and one does.**
> `CreateOrganizationInput.contacts` and `UpdateOrganizationInput.contacts` are
> `z.array(OrganizationContact)` — the stored `z.strictObject` — so those HTTP request
> bodies inherited the tightening and now need all three keys. Six api-cloudrun test
> payloads were repaired for exactly that reason. ⭐ **The split is a property of each
> SITE, not of the type**; the next tightening should look for embedded stored objects
> before trusting a 6/6 table.
>
> **Naming, and why the tightened half kept the established name.** `NameParts` /
> `NamePartsFields` are now the STORED pair (`: string | null`, key required); the new
> `NamePartsInput` / `NamePartsFieldsInput` are the INPUT pair. Had it gone the other way —
> `NameParts` left loose with a `StoredNameParts` beside it — every consumer holding stored
> data would have compiled unchanged and stayed silently over-loose. A compile error is the
> cheaper failure, and it is what named manager's two form models
> (`AcceptInvite.tsx`, `ContactName.tsx`, both now `NamePartsInput`).
> `NamePartsFieldsPartial` / `PartialNameParts` are a THIRD block and untouched — core#70's
> call, so **manager#338 is still not resolved.**
>
> ### Step 6 — the fixture sweep, and the two census defects
>
> `getTestDoc` emits `null` for all three (verified against the published build), so core's
> own fixtures moved for free. The hand-spelled ones did not: **4 caught by the compiler,
> 41 invisible to it.** A raw `ref.set()` seed never reaches a typed receiver, so it
> compiles today and becomes a `ValidationError` from inside a transaction the first time
> the code under test writes that document back.
>
> 🔴 **`\bfirst_name\s*:` does not match a SHORTHAND property.** `seedUser` in
> `api-cloudrun/tests/integration/users/users.test.ts` is written `{ first_name, name: first_name }`,
> and it stands behind several tests. Matching property POSITION (`first_name` followed by
> `:`, `,` or `}`) took the candidate count 114 → 116 and caught it. ⭐ **A source-text scan
> measures its own pattern, not the corpus** — and a 2-in-116 gap reads as complete.
>
> 🔴 **The inserter put the new keys in the enclosing ARRAY** on 6 of 9 sites, because those
> objects are written on ONE line and it appended after that line. Caught by a verifier that
> re-derives each inserted key's enclosing block and asserts a `first_name` beside it — a
> check that cannot pass vacuously. ⭐ **The finder and the writer need separate
> verification**; a correct census does not imply a correct repair.
>
> ⚠️ **Two deliberate NON-repairs, commented in place** so a later census does not
> re-propose them: `api-cloudrun/tests/integration/contacts/contacts.test.ts`'s
> `userRef.update({ first_name, name })` is a partial MERGE onto a copied dev user that
> carries the keys; and `api-cloudrun/scripts/audit-denorm-freshness.ts`'s fixture stays
> absent-on-both-sides because `sameValue` (`api-cloudrun/scripts/_denormEquality.ts`) folds
> `null` in WITH `undefined` on one branch.
>
> ### Ordering: nothing is owed a deploy in a particular order
>
> ⚠️ **Storage was already at the destination before step 5**, so the contract could not
> break the corpus — only a client that omits a key. And every writer had already been
> converted: api-cloudrun's `?? null` shipped in `v0.228.0`, manager's nine spreads in
> `eedaced`. So prod on `beta.339` and a future prod on `beta.343` both accept what the
> other writes, and **the three consumers could move in any order.** Templates' fixture
> carrying `middle_name: null` renders identically under either.
>
> ### Kept, because a resumed session will re-derive them otherwise
>
> - 🔴 **The population was 354 documents, not the ~4,835 sized below.** The surface table's
>   per-collection counts are DOCUMENT counts; the destination-embedded contacts are almost
>   entirely null legs (1,151 of 1,153 cards, 2,032 of 2,032 order legs, 2,012 of 2,012
>   invoice legs), so the "3,711 whole-document array rewrites" were **2 documents**. The
>   real work was `contacts` 170 and `organizations` 179, both flat.
> - ⚠️ **api-cloudrun#865's `beta.338` pin ceiling is long gone** and was never on this
>   plan's critical path — its title names the ceiling, but the ISSUE is a peer's
>   fulfillment work that was waiting on it. Reading an issue's blocking CLAUSE as its
>   subject cost this plan a wrong dependency once already.
> - ⭐ **The Typesense hazard is DISPROVEN** — measured against the prod index, not reasoned.
>   No translate change, no config change.
> - ⚠️ **`manager#388` still stands**: `getInitialValues` seeds `null` and `draftSeed` strips
>   every null from a seed, so a draft carries absent keys where storage wants null.
>   Harmless today because every stored-write site normalizes.

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
5. ✅ **`core` — CONTRACT.** Landed `39e7c45`, published `10.0.0-beta.343`. Bare `.nullable()`, interfaces `: string | null`. Breaking,
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
   at storage. **Re-derived independently 2026-09-05 and it matches — the 12 sites are:**

   | STORED → key becomes REQUIRED | INPUT → stays `.nullable().optional()` |
   |---|---|
   | `user.ts` `UserSchema` | `user.ts` `CreateUserInput` |
   | `contact.ts` `ContactSchema` | `contact.ts` `CreateContactInput` |
   | `invite.ts` `InviteSchema` | `invite.ts` `CreateInviteInput` |
   | `organization.ts` `OrganizationContact` | `organization.ts` `NewContactInput` |
   | `order.ts` `DocDestinationContact` | `order.ts` `DestinationContact` |
   | `destination.ts` `DestinationContactRef` | `auth.ts` `RegisterInput` |

   ⚠️ **`NamePartsFieldsPartial` is a THIRD block and stays untouched** — it is
   `z.ZodType<string | undefined>`, deliberately not widened, because whether the partial
   INPUT contract gains a `null` unset verb is **core#70**'s call. That is also why
   manager#338 is not resolved by this campaign.
6. ✅ **Pins, deploys, fixture sweep** — except the `templates` merge.
   `api-cloudrun` `14c70c61` (`beta.342 → .343`, 45 seeds), `manager` `48ffa36`
   (`beta.341 → .343`, two form models), `templates` PR #219 (`beta.335 → .343`, one
   fixture) **open, awaiting a human**. `getTestDoc` flipped OMIT → `null` for free as
   predicted; the hand-spelled seeds did not, and only 4 of 45 were visible to the
   compiler.

## Finishing it — the two remaining actions, in order

1. **Merge `chicago-film-supplies/templates#219`.** A human, not an agent: `templates/CLAUDE.md`
   scopes the auto-merge row to `deno.json`/`deno.lock`-only PRs, and this one also repairs
   `templates/fixtures/quote/multi-dest.json`. ⚠️ Read the CI verdict as **passed on the head
   sha, on the newest run** — `cancel-in-progress` means a conclusion on a superseded sha
   says nothing, and a not-reported arm is not a passing one.
2. **Delete `api-cloudrun/scripts/backfill-name-parts-null.ts` and this doc, together.**
   The script is a one-shot, applied in both environments with a post-audit of 0, and the
   repo's convention is to delete rather than keep it green.
   🔴 **This doc must go FIRST or in the same sitting.** It and the script are the only two
   files in the workspace naming that path (grepped 2026-09-05), so deleting the script
   while this doc still cites it turns `core`'s citation gate BROKEN and makes `core`
   unpushable for **every session sharing the checkout** — a repo that never saw the
   deletion, which is the whole shape of that hazard.

⚠️ **Neither is blocked on the other's environment.** Nothing further is owed a deploy:
prod on `beta.339` and a prod on `beta.343` accept exactly the same writes, because every
writer was converted before the contract landed.

## Context recommendation

**Clear.** The contract is published and both code consumers have swept and landed; what
remains is one PR merge and a two-file deletion, and each is fully specified above. Nothing
from the session that did the work is load-bearing for either.

⚠️ Two things NOT to carry forward from memory. This plan's original sizing (~4,835
documents, 3,711 array rewrites) was **wrong** — the figure is 354. And the pin table it
carried went stale twice while the work was in flight; **read the pins from the repos**, not
from any doc.

## Related

- core#83 — the campaign this belongs to; its body carries the corrected scope and the
  both-environment census.
- core#70 — the INPUT-side "unset" verb. Independent: `tests/stored-optionality.test.ts` is
  registry-scoped, so its three arms are excluded by construction.
- api-cloudrun#556 — the CRMS removal decision that core#83's `crms-pending-removal`
  exclusion defers to.
