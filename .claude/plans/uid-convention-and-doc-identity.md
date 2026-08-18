# Doc identity: the `uid`/`uuid` convention, and the types that carry no `uid`

**Date:** 2026-08-17 • **Repo:** core (+ api-cloudrun, manager) • **Status:** ⏳ planned, nothing implemented
**Origin:** an audit of "which Firestore and Typesense doc types have no `uid`, and should each get one?" — the full census is below, executed against `CollectionDocs` and the 22 Typesense configs.
**Tracking issue:** core#58
**Related:** `.claude/plans/roles-campaign.md` + core#59 (the sibling campaign; `roles.name` is a carve-out declared here and defended there) • core#60 (the `TypesenseDocumentMap` gap this audit surfaced) • api-cloudrun#506 (`uid_session` holds a UUID — the same convention, opposite direction; Phase 0 is its shared premise) • manager#300 (which side wins when a stored `uid` disagrees with the snapshot id — wants an answer before Phase 4)

## START HERE

Nothing has been built. This doc holds a **completed census** plus a decided plan; the next session executes Phase 0 first (pure documentation, no runtime change), then Phase 1's four schema changes **in the stated risk order** — they are not one homogeneous change and one of them (`sessions.id` → `uid`) will log every user out if shipped naively.

Read Findings 1–3 for the evidence, then Phase 0. The one thing to internalise before touching anything: **all four affected schemas are `z.strictObject`, so every stored doc fails validation the moment its schema changes** (unknown old key *and* missing new key). What differs per type is whether anything reads them through a parse, and whether the docs age out on a TTL.

---

## The convention (currently written down nowhere)

> `uid` / `uid_{domain}` refers to a **Firestore document id** — a native auto-id or a CFS deterministic composite.
> `uuid` refers to an **actual UUID from elsewhere** (Uploadcare, some line-item types).

`core/CLAUDE.md` § *UID property naming* covers `uid` / `uid_{descriptor}` and is **silent on `uuid`**; `core/src/schemas/_uid.ts` documents id *shapes*, not naming. Phase 0 fixes both.

---

## Finding 1 — Typesense: nothing is missing

**All 22 config files declare `uid` as a required, sortable `string`.** None declares `id`; api-cloudrun sets it at `api-cloudrun/src/lib/typesenseTranslate.ts:332` (`doc.id = firestoreDoc.uid`), the last statement of `translateForTypesense`. The `typesense.id === uid === Firestore doc id` invariant is held by `api-cloudrun/src/lib/firestoreWrite.ts:303`.

**No action.** Two adjacent gaps surfaced, neither about `uid` — both filed as issues rather than folded in:

- `TypesenseDocumentMap` (`core/src/schemas/typesense/documents.ts:878`) covers 20 of 22 aliases — `cards` and `threads` have configs but no typed search-hit shape, and no `CardDocument` / `ThreadDocument` exists at all. ⚠️ **Not latent for `cards`**: `cards.ts:26` is `enabled: true` (only `threads` and `bookings` are `enabled: false`, and `bookings` *is* in the map), so a live index is unreachable from manager's typed search surface, which is generic over `keyof TypesenseDocumentMap`.
- (core#60) `api-cloudrun/scripts/reindexTypesense.ts:118` builds its orphan-purge set from the **Firestore doc id** while the import keys on **`data.uid`**; they agree only because of the write guard.

---

## Finding 2 — Firestore: 15 of 56 document types have no `uid`

Registry: `CollectionDocs`, `core/src/schemas/mod.ts:1128–1225` (96 keys, 56 distinct types). No document schema exists outside it. **41 have `uid`; 15 do not**, in four classes.

| Class | Types | Verdict |
|---|---|---|
| **A — the doc id is a credential** | `sessions`\*, `email-verifications`, `password-resets`, `mcp-oauth-codes`, `mcp-oauth-tokens` | **No `uid`** |
| **B — the doc id is in the body under another name** | `sessions.id`, `webhook-events.id`, `mcp-oauth-authorize-requests.id` → **rename to `uid`**; `mcp-oauth-clients.client_id`, `uploadcare-worklist.uuid`, `roles.name` → **leave, as declared carve-outs** | **Mixed** |
| **C — natural key not in the body** | `counters`, `rate-limits`, `cache-geocodes`, `uploadcare-sweep` | **No `uid`** |
| **D — child doc with no identity at all** | `orders/{uid}/documents` | **Add `uid`** |

\* `sessions` is in both A and B: its id is a bearer token *and* it is copied into the body as `id`.

**Class A — why not.** The id is the bearer token, or `sha256(token)` for the mcp-oauth pair. Copying it into the body widens what a log or export leak reveals and buys nothing. *Stated plainly: the package is already inconsistent here — `sessions.id` stores the full 40-char token today, and `template_previews.uid` is its own bearer token (`core/src/schemas/template-preview.ts:25`). The argument is "no reader needs it", not "this is a new security boundary".*

**Class B — the three that stay.** `mcp-oauth-clients.client_id` is an OAuth 2.1 / RFC 7591 wire name, on the one surface whose job is to mirror an external spec. `uploadcare-worklist.uuid` is already correct — it **is** an Uploadcare UUID that doubles as the doc id. `roles.name` is a decided carve-out; the evidence is in `.claude/plans/roles-campaign.md` § *Why `roles.name` stays*.

**Class C — why not.** Hot-path and TTL-swept plumbing with zero readers of a body id. `counters/transactions` is already an in-transaction hot-doc RMW (api-cloudrun#516). `cache-geocodes` is worse than neutral: the id is `normalizeQuery(q)` while the body's `query` is the raw string, so a `uid` would be a *third* representation.

**Class D — the one addition.** The only uid-less type with declared display columns **and** no body field naming its own doc id, and the single hand-written member of `PropagationEndpoint`. Its existing `uuid` is the Uploadcare CDN file id — correct. So it ends up carrying `uid` **and** `uuid` side by side: the convention's clearest illustration.

⚠️ **Its docstring is wrong.** `core/src/schemas/order-document.ts:7` says "auto-id", but `api-cloudrun/src/services/processOrderDocs.ts:66-68` derives the id from the filename (`orderDocumentId(name)`, applied at `:256`). The id is already deterministic, so `uid` can be stamped with **no id change**.

---

## Finding 3 — the drift guard's coverage is accidental

`assertValidForWrite` (`api-cloudrun/src/lib/firestoreWrite.ts:302-308`) and `assertValidPatch` (`:560-565`):

```ts
const uid = (doc as { uid?: unknown }).uid;
if (typeof uid === "string" && uid !== ref.id) { throw ... }
```

**A doc with no `uid` passes silently.** The guard covers exactly "types that happened to name their id field `uid`" — 41 of 56 — and nothing says which 15 are uncovered. Acknowledged in one comment only (`core/src/schemas/uploadcare-worklist.ts:153-158`).

**Not theoretical for `sessions`:** `getSession(id)` (`api-cloudrun/src/auth/session.ts:55-66`) reads by doc id then returns `snap.data() as Session` — a **bare cast, no parse** — so `session.id` comes from the **body**. `api-cloudrun/src/auth/session.ts:80` and `api-cloudrun/src/routes/auth.ts:504/563/611` then write back via `.doc(session.id)`. A divergent body `id` would redirect the sliding-window extension and the preview-role writes onto a *different* session doc — the `stageLocationUpdates` failure mode the guard was written for, unguarded because the field is named `id`.

Renaming Class B's three closes this for them by construction. **The three carve-outs stay uncovered until Phase 4** makes the id field declarable.

---

## Phase 0 — write the convention down (no runtime change)

- `core/CLAUDE.md` § *UID property naming*: state the `uid` / `uid_{domain}` vs `uuid` rule; that it governs **document identity and cross-doc references** (array-element ids are `ItemUid`'s separate, already-typed concern); and the **sanctioned carve-outs with their reasons**:
  - `roles.name` — the doc id must be the claim string, because `manager/firestore.rules:33-41` can only `get()` by path, never query. See `.claude/plans/roles-campaign.md`.
  - `mcp-oauth-clients.client_id` — RFC 7591 wire name.
  - `uploadcare-worklist.uuid` and other third-party UUIDs.
  - `ActorRef.uid`, polymorphic `DocSource` / `UidNameRef`.
- Mirror it into `core/src/schemas/_uid.ts`'s module docstring, which already carries the shape table and already names most carve-outs.

Phase 0 is a `docs:` commit — no release.

---

## Phase 1 — the three renames, the one addition, and the stale prose

**Order by risk. These are four separate changes.**

### 1a. `webhook-events.id` → `uid` — free

One writer (`api-cloudrun/src/lib/webhooks.ts:32-38`), **zero readers of the field** (every consumer checks `snap.exists` only), no test constructs the literal, no route or MCP surface, and a **24 h TTL** (`api-cloudrun/infra/firestore.tf:57`). Deploy and wait a day; no backfill, no shim.

⚠️ The rename does **not** buy the drift guard here: `webhooks.ts:44` calls `validateBeforeWrite` directly and `:59` does a raw `eventRef.create(doc)`, so `assertValidForWrite` never runs on this path. Convention only.

### 1b. `mcp-oauth-authorize-requests.id` → `uid` — near-free, but it has a public contract

10-minute TTL (`STAGING_DURATION_MS`, `api-cloudrun/src/auth/mcpOAuth.ts:62`) and `getAuthorizeRequest` **parses** (`:162`), so an unmigrated doc fails closed as a consent-page 404 — correct behaviour. Blast radius is any handshake in flight during the deploy.

⚠️ **`GET /oauth/authorize-request/:id` returns `{ id: r.staged.id, … }`** (`api-cloudrun/src/routes/mcpOAuth.ts:206`) and `manager/src/routes/OAuthConsent.tsx:9` declares it. It is **declared-but-unused** there (the component renders from `params.id`), so either drop it or rename in lockstep — but **ship api-cloudrun and manager together** either way.

`api-cloudrun/src/auth/mcpOAuth.ts` **re-exports** core's four mcp-oauth schemas rather than duplicating them (verified) — a barrel to follow through, not a second definition site. Regenerate `api-cloudrun/src/static/reference/search_index.js` (stale deno-doc still naming `McpOAuthAuthorizeRequest.id`).

### 1c. `sessions.id` → `uid` — the risky one. Do not rely on natural TTL

`getSession` returns `snap.data() as Session` — a **bare cast, not a parse** (`api-cloudrun/src/auth/session.ts:59`). So for the whole 30-day TTL window every pre-existing session yields `session.uid === undefined`, and three things break rather than fail closed:

- `api-cloudrun/src/middleware/session.ts:117,134` — `setCookie(c, COOKIE_NAME, session.uid)` writes `session=undefined`, logging users out
- `api-cloudrun/src/auth/session.ts:80` — `.doc(undefined)` throws on the sliding-window extension
- `api-cloudrun/src/middleware/global-rate-limit.ts:229` — `auth:session:${undefined}` collapses every authed user into one shared bucket

**So: purge the `sessions` collection as part of the deploy** rather than waiting it out — with 1 prod user that is one forced re-login. Note `deleteAllUserSessions` (`api-cloudrun/src/auth/session.ts:97-109`) is **per-user** (`where("user_id","==",…)`), not global, so this is either one call per user or a small collection-wipe script; **don't assume a ready-made global purge exists.**

*Alternative if a forced logout is unacceptable:* make `getSession` parse and accept both keys for one release.

Converge the log field while here: `core/src/schemas/log/user-session-event.ts:36,52` already declares **`session_uid`**, while `api-cloudrun/src/routes/auth.ts:570,618` and `api-cloudrun/src/routes/invites.ts:183` emit `session_id` / `prior_session_id`.

Fixtures to flip: `core/tests/session.test.ts` (6), `api-cloudrun/tests/helpers/auth.ts:21,40,97-105` — **and its comment claiming "38 chars, fits schema's ≤40 bound"; the schema is `.length(40)`, so that comment is already wrong** — plus 4 fixtures in `api-cloudrun/tests/integration/auth/auth.test.ts`.

### 1d. `OrderDocument` gains `uid` — the only one needing a real backfill

- **No TTL.** `documents` is absent from `local.firestore_ttls` (`api-cloudrun/infra/firestore.tf:54-74`) — these are permanent, ~1,836 CDN refs (≈900 orders × 2), and `processOrderDocs` is version-keyed, so closed orders are **never** rewritten. Natural turnover will not happen.
- ⚠️ **The write IS validated** — `api-cloudrun/src/services/processOrderDocs.ts:329`'s `transaction.set` routes to `validatedSet` (`api-cloudrun/src/lib/instrumentedTransaction.ts:1042`), so adding `uid` **activates** the drift guard and requires `uid === ref.id` = `"quote"` / `"packing-list"`. It must **not** be `file.uuid`.
- ⚠️ **The literal is built where the id is unknown**: `processDocs` returns `{uuid, mime, name, orderUpdatedAt}` at `:145-150`, while the refs are derived later at `:256` via `orderDocumentId(d.name)`. Move the derivation into `processDocs`, or set `uid` at `:256`, so the literal and the ref cannot drift.
- **Ship as optional → backfill → tighten to required.** Safer than required-plus-same-window, and there is no read-side parse on the hot path to force the issue.
- **Backfill: use `ref.id`, never `orderDocumentId(data.name)`** — `api-cloudrun/scripts/audit-order-documents-cardinality.ts` shows a tail of orders with >2 documents (legacy auto-id survivors) whose ids are neither literal.
  - Template: borrow the collection-group scan + dry-run / `--write` / `--allow-prod` rails from `api-cloudrun/scripts/purge-orphaned-order-subcollections.ts`, and the write loop from `api-cloudrun/scripts/repair-ledger-shelf-drift.ts:175,194`.
  - Pre-flight with the existing read-only `api-cloudrun/scripts/audit-order-documents-cardinality.ts`.
- Note `documents` is **not** in `api-cloudrun/scripts/audit-schema-validation.ts` (top-level collections only), so only `POST /admin/validate-collection` with `useCollectionGroup: true` would catch a bad state.

### 1e. Prose fixes

- `core/src/schemas/order-document.ts:5-9` — "auto-id" → filename-derived and deterministic.
- `core/src/schemas/uploadcare-sweep.ts:2` — "singleton `last-run`" → per-partition (`api-cloudrun/src/lib/uploadcareReferenceMap.ts:91`).
- `api-cloudrun/src/services/dbRead.ts:48` — the `data.uid === id` invariant comment is false for 9 collections, and `roles` — which violates it — is on the readable allowlist.
- `api-cloudrun/scripts/seed-rbac.ts:5-8` — lists 4 roles, there are 6 (the core#55 stale-count class).

### 1f. Regenerate the docs

`deno task docs` in core → `core/API.json` + `core/API.md`. `docs:check` gates CI and both are in the publish include list.

---

## Phase 4 — make "which field is this doc's id" total

Per collection in the registry, assert exactly one of:

1. declares `uid`;
2. declares `.meta({ idField })` naming a **real required string leaf**; or
3. is on an explicit id-less list **with a reason**.

Then widen `assertValidForWrite` / `assertValidPatch` (`api-cloudrun/src/lib/firestoreWrite.ts:302-308,560-565`) to read the declared `idField`, so the three carve-outs — **`roles.name` above all**, plus `uploadcare-worklist.uuid` and `mcp-oauth-clients.client_id` — become guarded rather than merely documented.

⚠️ **Do not wire propagation to read this at runtime.** `core/src/schemas/propagation/types.ts`'s `import type { CollectionName }` must stay type-only (`core/CLAUDE.md` § *Propagation*), so agreement between the declared `idField` and `cowriteRulesFor`'s existing `idField: "name"` override belongs in a **test**, which may import both. That override **stays**, and `core/CLAUDE.md`'s ⭐ `cowriteRulesFor` lesson remains accurate.

---

## Decisions taken — and what was rejected

| Decision | Rejected alternative | Why |
|---|---|---|
| Class A keeps no `uid` | Copy the credential into the body for uniformity | Widens leak surface, zero readers. Uniformity is not worth it here. |
| `mcp-oauth-clients.client_id` stays | Rename to `uid` | RFC 7591 wire name on a spec-mirroring surface. |
| `uploadcare-worklist.uuid` stays | Rename to `uid` | It genuinely *is* an Uploadcare UUID — the convention already covers it. |
| `roles.name` stays | Rename to `uid`; or move to an auto-id | Security rules can only `get()` by path; the prod→dev mirror would mint unreconcilable duplicates. Full argument in `.claude/plans/roles-campaign.md`. |
| Class C keeps no `uid` | Add one for guard coverage | Hot-path plumbing, no readers; `cache-geocodes` would gain a *third* representation of its key. |
| `sessions`: purge on deploy | Wait out the 30-day TTL | The read is a bare cast, so unmigrated docs produce `undefined` cookies and a shared rate-limit bucket rather than failing closed. |
| `OrderDocument`: optional → backfill → required | Required in one shot | No TTL, no natural turnover, ~1,836 permanent docs; and the write is validated, so a required field breaks every regen immediately. |
| Phase 4 `idField` checked in a **test** | Read it at runtime from propagation | `propagation/types.ts` must stay runtime-free — a value import there undoes the reason propagation has its own subpath. |

---

## Cross-repo release order (per `~/cfs/CLAUDE.md`)

Each core phase: commit on `beta` → push → JSR `-beta.N` → then bump

- `api-cloudrun/deno.json` (the explicit `jsr:@cfs/core@<ver>/…` subpath entries; 28 `@cfs/core` lines at time of writing),
- `manager/package.json` (the single `@cfs/core` → `npm:@jsr/cfs__core@<ver>` alias),
- `templates/deno.json` — **exact pins, not a caret**: 1 `schemas` entry + 5 `utils/*` (`orders`, `invoices`, `dates`, `icons`, `money`), 6 lines; currently `10.0.0-beta.196`.

Run `deno install` / `npm install` so the lockfiles match (Cloud Build uses `deno install --frozen`).

**Templates is a pin bump and nothing else** — verified: none of the four Phase-1 types is reachable from that repo. Its only registry contact is `templates/scripts/lint-fixtures.ts:38,113` validating `collection_source`, and the sole value in the repo is `"orders"`. Re-run `deno task lint:fixtures` after the bump. Templates has branch protection: **open the PR, never merge it.**

---

## Verification

- `deno task check && deno task lint && deno task test` in core after each phase.
- **Phase 1** — confirm the `uid === ref.id` guard passes at each write:
  - sessions ✅ (`api-cloudrun/src/auth/session.ts:48`)
  - mcp-oauth ✅ (`api-cloudrun/src/auth/mcpOAuth.ts:153`)
  - webhook-events — **guard does not run** (`api-cloudrun/src/lib/webhooks.ts:44,59`)
  - order-documents ⚠️ **must be wired**
- After 1d's backfill: `POST /admin/validate-collection` for `documents` with `useCollectionGroup: true`, expect zero invalid.
- **None of the four is Typesense-indexed**, so no reindex. No `firestore_ttls` change is needed for any of them (`api-cloudrun/infra/firestore.tf:54-74` keys on `expiresAt`, not the renamed field).
- **Phase 4** — the new test must be **shown to fail**: temporarily strip a `uid` from one schema and confirm red, per this repo's companion-test discipline.

---

## Context recommendation

**CLEAR CONTEXT.** This doc plus `core/CLAUDE.md` is sufficient to execute cold, and Phase 1c's session-purge sequencing wants a fresh window rather than one already full of census exploration.
