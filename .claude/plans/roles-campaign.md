# Roles: centralize the type in core, and add the missing lifecycle operations

**Date:** 2026-08-17 • **Repo:** core (+ api-cloudrun, manager) • **Status:** 🚧 Phase 2 landed; Phase 3's API half landed; **the manager UI is all that remains** (manager#321)
**Origin:** the question "is keying `roles` by `name` a mistake — what does renaming cost, should it move to a generated auto-id?" The answer is **no**, and the evidence is recorded below so no future session re-litigates it. What the audit *did* find is that the role surface is missing operations and that a role's id shape is defined nine times across three repos, two of which disagree.
**Tracking issue:** **manager#321** — the UI half, which is all that remains. core#59 is **closed** (its core and API halves landed); this doc is kept for the `roles.name` decision below, which `CLAUDE.md` and `src/schemas/_uid.ts` both cite as the standing authority.
**Related:** core#58 (**closed** — it declared `roles.name` as a carve-out and pointed here for the reason; its plan doc has been retired) · api-cloudrun#655 (the consumer half of #58's Phase 4 — the write-time drift guard still reads a hardcoded `uid` and so does **not** yet guard this carve-out, despite `roles` now declaring `idField: "name"`) • api-cloudrun#574 (`POST /users` writes roles unchecked, and the absent-role skip has no log or metric — the same silent de-privileging this campaign's rename must avoid) • api-cloudrun#548 (`cleanup-orphan-threads` can delete a thread that still has comments — blocks one option in Phase 3a)

> ## ⚠️ STATUS UPDATE 2026-08-24 — Phase 2 and Phase 3's API half are DONE. Only the manager UI is left.
>
> | Phase | State |
> |---|---|
> | **2** — `RoleId` centralized in core | ✅ core `976646a`, published and pinned everywhere (currently `@cfs/core@10.0.0-beta.251`) |
> | **3, API half** — delete + rename/replace routes | ✅ api-cloudrun `5aa19607` |
> | **3, UI half** — wire both into `RolesManager` | ⏳ **the only thing left**, tracked as **manager#321** |
>
> ⚠️ **The rename route exists and has no caller.** That is the current state, and it is the one
> worth knowing before touching this: the dangerous fan-out — seven Firestore write targets across
> six collections, failure mode silent de-privileging — is *written and deployed*, and the manager
> UI is what will first exercise it against real data. Phase 3's dev rehearsal below has not been
> superseded by the route landing; run it before the UI ships, not after.
>
> 🔴 **`roles.name` is declared as a carve-out but still not guarded.** core#58 Phase 4 landed the
> declaration — `roles` carries `.meta({ idField: "name" })` — but api-cloudrun's
> `assertValidForWrite` / `assertValidPatch` still read a hardcoded `uid` field, so a `roles`
> document whose `name` disagrees with its id passes **silently**, exactly as before. The rename
> route has to assert it by hand for that reason. Filed as **api-cloudrun#655**.

## START HERE

**`roles.name` stays** — decided, with the evidence in the next section; do not reopen it. Phase 2 is done and Phase 3's routes are deployed; what is left is the manager UI (manager#321), and the dev rehearsal that must precede it.

Phase 2 made the role-name shape one exported schema in core and retyped its carriers. Phase 3 adds the two operations the surface was missing — wiring the **already-existing** delete endpoint into the manager UI, and a **rename/replace** route that did not exist at all. The rename touches seven Firestore write targets across six collections and its failure mode is **silent de-privileging**, which is why it is last and why it is rehearsed in dev.

---

## Why `roles.name` stays

### Measured facts (verified live, 2026-08-17)

- **6 roles, identical doc ids in `cfs-3100` and `cfs-dev-3100`** — down to matching `uid_thread` values (`admin` → `VBKQaoOnFjCvSVhiY2CD` in both).
- **1 user in prod**, holding `["admin"]`.
- **All 6 declared in `api-cloudrun/scripts/rbacRoles.ts`**; `api-cloudrun/scripts/seed-rbac.ts:60` writes `roles/{role.name}` as a deterministic point write. **Zero operator-created roles in either environment.**

### What name-as-doc-id buys

- 🔴 **It is the only lookup Firestore security rules can perform.** `manager/firestore.rules:33-41` does `get(/databases/$(database)/documents/roles/$(userRoles()[i])).data.permissions.hasAny([p])`, where `userRoles()` is `request.auth.token.roles`. **Rules cannot query — only `get()` by path — so the claim string must BE the doc id.** `hasPermission` gates every collection the manager reads (`:68-82`). Auto-ids would force opaque claims and a same-deploy rewrite of `users.roles[]`, `invites.roles[]`, `sessions.preview_role` and every issued token; a half-migration blanks the app for every user, symptom-free, **including the admin who would fix it.**
- 🔴 **The prod→dev mirror would produce unreconcilable duplicates.** `roles` is **not** in `SKIP_COLLECTIONS` (`api-cloudrun/src/lib/devReplicaRules.ts:29-137`); `mirrorDocument` writes `devDb.collection(c).doc(docId)` (`api-cloudrun/src/services/devReplica.ts:27`) — same id, whole-document replace, via the prod-only `mirror-top-level` trigger. That is *why* the two environments are byte-identical. Under auto-ids a dev-seeded role and its mirrored prod twin become two docs both named `warehouse`, which a same-id replace can never reconcile.
- **Environment portability, and the audit built on it.** `api-cloudrun/scripts/audit-env-definitions.ts` diffs `roles/{name}.permissions ⇔ rbacRoles.ts ROLES` per environment, joining on the **doc id** (`:303` derives it from the REST path's last segment). Its docstring cites api-cloudrun#419 — prod's `roles/admin` silently missing permissions. Auto-ids make `seed-rbac.ts:60` a query-then-upsert, losing point-get idempotency.
- **Name uniqueness is free**, enforced by the Firestore primary key; `api-cloudrun/src/routes/roleAdmin.ts:214` (`existing.exists`) is the only conflict check in the repo.
- **Human-readable everywhere** — URLs, ~12 log fields, 10 error messages, the `users_v3.roles` Typesense facet (a default display column), and **two Prometheus alert labels**, including the critical `RbacRoleSchemaInvalid` whose runbook LogsQL interpolates `role_name` (`api-cloudrun/infra/observability/vmalert/rules-vlogs.yml:344-360`).

**Precedent already in the repo:** `api-cloudrun/src/lib/readableCollections.ts:94-99` says the `stockSummaries.read` permission *"keeps its name and MUST NOT be renamed"* because the string is stored on every `roles/{name}` document — the identical argument one level down. **An identifier that leaks into stored data is immutable; that is a property to accept, not a defect to fix.**

### What was rejected

| Rejected | Why |
|---|---|
| Move `roles` to Firestore auto-ids | Breaks `firestore.rules`' `get()`-by-path (the only lookup rules can do), and the prod→dev mirror would mint duplicate `warehouse` docs. |
| Rename `roles.name` → `roles.uid` | The doc id must equal the **claim string**; `name` is the wire contract across users, invites, sessions, threads, comments, logs, alert labels and the Typesense facet. |
| Leave the surface as-is | The UI instructs operators to "delete and recreate", and **`RolesManager` never calls the delete endpoint.** There is no rename path at all. |

---

## What actually needs fixing (independent of the id decision)

### (a) A rename has no supported path, and the UI tells operators to do something it cannot do

`manager/src/components/settings/RolesManager.tsx:221` disables the name input; `:229` says *"Role names are immutable. Delete and recreate to change a name."* — but **`RolesManager` never calls the delete endpoint.** `DELETE /admin/roles/{name}` exists server-side (`api-cloudrun/src/routes/roleAdmin.ts:336-390`, 409 `ROLE_IN_USE` while any holder remains) and is **unused**. There is no rename endpoint at all: `RoleUpdateInput` (`:46-50`) accepts only `label`, `permissions`, `description`.

A rename must touch **seven Firestore write targets across six collections**:

1. `roles/{name}` — the doc id (delete + recreate; Firestore has no rename)
2. `roles/{name}.name`
3. every `users/{uid}.roles[]` — *plus a `token_version` bump, the only way to invalidate the claim (`api-cloudrun/src/routes/roleAdmin.ts:465`)*
4. every `invites/{token}.roles[]` — *7-day TTL*
5. every `sessions/{id}.preview_role` — *TTL'd; self-heals (`api-cloudrun/src/routes/auth.ts:487-508`)*
6. every `threads/*.sources[]` with `collection: "roles"`
7. ⭐ every `comments/*.sources[]` — a **denormalized copy** of the thread's sources (`api-cloudrun/src/services/comments.ts:61`)

Typesense follows for free — `users_v3.roles` and `comments_v1.sources.uid` are both faceted and both Eventarc-synced, so the Firestore writes resync them (see Phase 3d). `threads` is `enabled: false` and is correctly skipped.

⚠️ **A half-finished rename fails SILENTLY.** `permissionCache.loadRole` caches `{doc: null}` for an absent doc and `resolveUserPermissions` skips it with `if (!role) continue` — **no log, no metric** (`api-cloudrun/src/lib/permissionCache.ts:48-50,126`). `api-cloudrun/src/routes/roleAdmin.ts:441-449` names it: *"resolves to NOTHING… just a user who is 403'd on everything they were supposedly granted."* Only the *unparseable* case throws 503.

### (b) A role's id is defined nine times across three repos, and two of the nine disagree

Full census by grep:

| Location | Pattern | Underscores |
|---|---|---|
| `core/src/schemas/role.ts:65` — the role's own id | `/^[a-z][a-z0-9_-]*$/` | **allowed** |
| `core/src/schemas/session.ts:42` — `preview_role` | `/^[a-z][a-z0-9_-]*$/` | **allowed** |
| `api-cloudrun/src/routes/roleAdmin.ts:41` — create body | `/^[a-z][a-z0-9_-]*$/` | **allowed** |
| `api-cloudrun/src/routes/roleAdmin.ts:58` — `NameParam` | `/^[a-z][a-z0-9_-]*$/` | **allowed** |
| ⚠️ `api-cloudrun/src/routes/roleAdmin.ts:425` — a bare `.test()`, **not a zod schema** | `/^[a-z][a-z0-9_-]*$/` | **allowed** |
| `api-cloudrun/src/routes/auth.ts:169` — preview-role body | `/^[a-z][a-z0-9_-]*$/` | **allowed** |
| `manager/src/components/settings/RolesManager.tsx:11` — `NAME_PATTERN` | `/^[a-z][a-z0-9_-]*$/` | **allowed** |
| `core/src/schemas/_uid.ts:172` — `AnyUid`, types `DocSource.uid` | `/^[a-z][a-z0-9-]*$/` | **rejected** |
| `core/src/schemas/_uid.ts:153` — `ListId` | `/^[a-z][a-z0-9-]*$/` | **rejected** |

Plus a prose copy at `api-cloudrun/tests/unit/permissionCache.test.ts:19`. **`roleAdmin.ts:425` is the one to watch** — an inline `.test()` in the assign-roles handler rather than a zod schema, so a schema-driven refactor walks straight past it.

Executed against the real schemas:

```
warehouse          Role.name regex: true   AnyUid (thread sources[].uid): true
warehouse_lead     Role.name regex: true   AnyUid (thread sources[].uid): false
on_call            Role.name regex: true   AnyUid (thread sources[].uid): false
```

`create-role` cowrites a thread with `sources: [{collection:"roles", uid: name}]` (`api-cloudrun/src/routes/roleAdmin.ts:221`) and `DocSource.uid` is `AnyUid` (`core/src/schemas/common.ts:318-321`). **A role named `on_call` — which `role.ts`'s own error message invites — fails its own creation transaction.** Latent only because no live role uses an underscore. This is what centralizing the type fixes.

---

## Phase 2 — centralize the role type in core, and consume it everywhere

Follow the existing `PERMISSIONS` / `Permission` precedent (`core/src/schemas/permissions.ts:11,189`), which `api-cloudrun/src/routes/roleAdmin.ts:19` already imports.

- **`RoleId` in `core/src/schemas/_uid.ts`** — reachable with **no new export subpath**: `_uid.ts` is internal, but its validators are already re-exported through `core/src/schemas/common.ts` into the `./schemas` barrel (`core/src/schemas/mod.ts:299`).
  One definition of the role-name shape, replacing all **seven** enforcing copies — `role.ts:65`, `session.ts:42`, `roleAdmin.ts:41`, `:58`, **`:425` (the bare `.test()`)**, `auth.ts:169`, `RolesManager.tsx:11` — plus the prose copy at `api-cloudrun/tests/unit/permissionCache.test.ts:19`.
  **Decide the underscore question here and settle it once. Recommendation: drop underscores**, so `RoleId` and `AnyUid`'s slug arm agree — all 6 live roles comply, and it fixes the `on_call` defect. Then point `AnyUid`'s and `ListId`'s slug arms at the same fragment so they can never diverge again.
- **`SEEDED_ROLE_NAMES` as an `as const` tuple + a `SeededRoleName` type** for the 6 git-declared roles, so the hardcoded literals become compile-checked:
  - `api-cloudrun/src/services/userLifecycle.ts:38-39` (`["customer"]` — the one behavioral role literal in production source, and it **overwrites** rather than appends)
  - `api-cloudrun/scripts/seed-rbac.ts:94,111` (`"authenticated"`)
  - `api-cloudrun/tests/helpers/auth.ts:76`

  ⚠️ **Keep `RoleSchema.name` an open `RoleId` string, not a closed enum** — `POST /admin/roles` exists, so operator-created roles must stay representable. `SeededRoleName` is the narrower literal type, not the storage type.
- **One shared public role shape.** Verified field-for-field identical today, no drift: api-cloudrun's `RoleSummary` (`api-cloudrun/src/routes/roleAdmin.ts:69-74`) and manager's `RoleRow` (`src/stores/roles.ts:4-9`) are both `{ name, label, permissions[], description? }`. Export it once from core and have both import it.
  Note it is a deliberate **public projection** of `Role` — it drops `uid_thread` and the timestamps — so export it as its own `RoleSummary`, **not** by re-exporting `Role`. Keep `name` as the field name (the wire contract), consistent with the decision above.
- **Retype the carriers, or the Phase 3 derivation has nothing to match.** `users.roles` is `z.array(z.string())` today (`core/src/schemas/user.ts:98`); `invites.roles` and `sessions.preview_role` are likewise plain strings or inline regexes. They must become `RoleId` for a schema-identity walk to find them.

  ⚠️ **The two `sources[]` sites cannot be derived this way and must be handled separately.** `threads.sources[].uid` and its `comments.sources[]` denorm are typed `AnyUid` — deliberately polymorphic, pointing at any collection — so their role-ness is carried by the sibling `collection: "roles"` discriminator, not by the field's type. Expect the site map to be **derived** for the three direct carriers and **discriminator-matched** for the two polymorphic ones. Do **not** retype `AnyUid` to make the walk uniform; that would break every non-role source.
- ⚠️ **`RoleId` must accept every stored value before it ships** — run it over both environments' live role names, and over every `threads.sources[]` / `comments.sources[]` entry with `collection: "roles"`, since `AnyUid` already gates those on write.

---

## Phase 3 — the missing role lifecycle operations

⭐ **Phase 2 must land first, and this is the reason.** `api-cloudrun/src/lib/actorRefPaths.ts` opens with the lesson: *"Where `ActorRef`s live in each schema — **derived from the schemas, never listed by hand.** … the cascade shipped with 10 collections while 18 schemas carry an ActorRef, so the published invariant was false the moment a new schema was written."* Detection there is **schema identity** — it matches `ActorRef` itself or any `.meta()` clone, deliberately *not* a `{uid,name}` name-match, which would have swept in `price.taxes[]` and every order line item. A hand-written list of seven queries for the role rename is precisely the mistake that file exists to record. **Once `RoleId` is one exported schema instance, Phase 3 derives its site map by walking the registry for fields whose identity is `RoleId`** — same technique, same guarantee, and a future role-name carrier is covered the day it is written.

### 3a. Wire the existing delete into manager

`DELETE /admin/roles/{name}` already exists with its 409 `ROLE_IN_USE` guard; `RolesManager` just needs to call it.

- Add `deleteRole(name)` to `manager/src/stores/roles.ts` → `apiFetch("/admin/roles/" + encodeURIComponent(name), { method: "DELETE" })`, then `refreshRoles()`. The store has `loadRoles` / `refreshRoles` / `roles()` / `rolesLoading` / `rolesError` today and **no delete and no rename**.
- ⚠️ **The 409 needs a NEW error branch — the existing one cannot reach it.** `PreconditionError` maps to `code: "FAILED_PRECONDITION"` / status 409 (`api-cloudrun/src/lib/errors.ts:50-55`), and the useful payload is `details: { code: "ROLE_IN_USE", role, user_count, users: [{uid,email}] }` (`api-cloudrun/src/routes/roleAdmin.ts:369-379`). But `RolesManager.tsx:139` only destructures `details.code` **inside** the `err.code === "VALIDATION_ERROR"` guard (`:139`), so `ROLE_IN_USE` falls through to the raw message. Add a sibling branch on `err.status === 409 || err.code === "FAILED_PRECONDITION"` and render `users[]` (server caps the list at 25; `user_count` is authoritative).
- **Destructive confirm: use `manager/src/components/ConfirmPopover.tsx`** — `tone="remove"` (default), `note` for the consequence, `ariaLabel`, `disabled` while saving, `onConfirm`. The canonical call site to copy is `manager/src/components/settings/RecurrencesManager.tsx:217-228` (a `<Trash2 size={14}>` trigger inside `<Show when={canDelete()}>`, consequence in `note`); its docstring records that it replaced stacked `window.confirm`s. Role delete gates on `roles.edit` — the whole surface is already behind `<PermissionGate permission="roles.edit">` (`manager/src/routes/Settings.tsx:53-59`).

⚠️ **Decide the thread question before exposing delete.** `deleteRoleRoute`'s handler is `ref.delete()` + `invalidateRoleCache(name)` (`api-cloudrun/src/routes/roleAdmin.ts:386-388`) — it does **not** touch the role's `uid_thread`, so every delete orphans a thread plus any comments on it. Tolerable while nothing calls the endpoint; wiring it into the UI makes it routine. Either delete/detach the thread in the same handler, or state that `cleanup-orphan-threads` owns it — **and note that script has an open defect where it can delete a thread that still has comments (api-cloudrun#548), so leaning on it is not currently safe.**

### 3b. The rename route

**Shape: `POST /admin/roles/{name}/rename`, body `{ new_name }`, guarded `roles.edit`** via `createProtectedRoute`, beside delete in `api-cloudrun/src/routes/roleAdmin.ts:336`. **Not** an extension of `PUT /admin/roles/{name}` — that route deliberately does not accept `name` (`:267-331`), and a rename is a fan-out while the PUT is a single-doc write. Keeping them separate also lets the UI force two steps rather than racing a rename against a label/permissions edit.

**Preconditions, all asserted before any write:**

- `new_name` parses as `RoleId` (Phase 2's single definition), ≤64 chars. ⚠️ **The 64-char cap is a token-size constraint, not cosmetic** (`core/src/schemas/role.ts:22-23`): `customClaims.roles[]` must stay under Firebase's 1000-byte limit.
- `roles/{new_name}` does not exist → reuse `ValidationError` + `code: "ROLE_EXISTS"` (`roleAdmin.ts:215-218`), which manager already handles (`RolesManager.tsx:135-139`).
- `roles/{old}` exists → `NotFoundError` (`roleAdmin.ts:299`).
- ⚠️ **Refuse to rename a seeded role, or own `api-cloudrun/scripts/rbacRoles.ts` in the same commit.** Renaming one of the 6 declared roles makes `api-cloudrun/scripts/audit-env-definitions.ts` red and makes `seed-rbac.ts --write` **re-mint the old name**. Pick one and state it in the route description.

⚠️ **The blast radius is bigger than delete's.** `manager/firestore.rules:35` resolves permissions by `get(/databases/$(db)/documents/roles/$(userRoles()[i]))` where `userRoles()` is `request.auth.token.roles` (`:13-15`). Any client holding an ID token minted with the **old** name gets a missing-doc `get()` → `roleGrants()` false → **every gated Firestore read denied** until the token is re-minted. That is what makes the `token_version` bump non-optional.

### 3c. The seven rewrite targets — query shape and index status

Verified against `api-cloudrun/infra/firestore-indexes.json` (175 composites; the only ones touching these collections are `threads`: `sources CONTAINS` + `last_message_at DESC`, and `comments`: `uid_thread` + `deleted_at` + `created_at`). `fieldOverrides` covers only `bookings`, `inventory-ledgers`, `transactions`, so **every single-field automatic index below is intact.**

| # | Target | Query | New index needed? |
|---|---|---|---|
| 1 | `roles/{name}` doc id | point read `roles/{old}` → `set(roles/{new})` + `delete(roles/{old})`. **Firestore cannot rename a doc; it is copy + delete.** | No |
| 2 | `roles.name` field | same doc, rewrite `name` in the copied body. ⚠️ `assertValidForWrite` only checks a **`uid`** field against `ref.id` (`api-cloudrun/src/lib/firestoreWrite.ts:300-308`) and `Role` has no `uid`, so **nothing catches `name ≠ docId` — assert it by hand** (until Campaign A's Phase 4 lands the declared `idField`). | No |
| 3 | `users[].roles[]` | `where("roles","array-contains", old)` — exactly `roleAdmin.ts:364` | No (automatic array index) |
| 4 | `invites.roles[]` | `where("roles","array-contains", old)`. ⚠️ **Adding `.where("used","==",false)` WOULD need a new composite** — filter `used` in memory instead. `invites.roles` is written at `api-cloudrun/src/services/invites.ts:85` and never queried by role today. | No, if `used` is filtered client-side |
| 5 | `sessions.preview_role` | `where("preview_role","==", old)` | No (automatic single-field) |
| 6 | `threads.sources[]` where `collection === "roles"` | `where("sources","array-contains",{collection:"roles",uid:old})` — the shape used at `api-cloudrun/src/services/threads.ts:48`, `api-cloudrun/src/lib/orderThreadSweep.ts:37,52`, `api-cloudrun/src/services/orders.ts:1104`. **Verified live on prod: returns 1.** ⚠️ **Do NOT add `.orderBy("last_message_at")`** — you don't need it, and the existing composite is the only thing that would support it. | No |
| 7 | `comments.sources[]` (the denorm copy, written at `api-cloudrun/src/services/comments.ts:61`) | same `array-contains` | No |

**Two hazards on 6/7 that shape the design:**

- ⚠️ **`array-contains` on an object is EXACT WHOLE-OBJECT equality, and `DocSource` carries an optional `label`** (`core/src/schemas/common.ts:317-326` — verified `.nullable().optional()`). Prod's role sources are bare `{collection,uid}` today (`threads/VBKQaoOnFjCvSVhiY2CD` → `sources: [{collection:"roles",uid:"admin"}]`), but a source that ever grows a `label` becomes **invisible** to this query. ⭐ **So make the pointer the primary path, not the query:** `roles/{old}.uid_thread` names the thread directly (all 6 prod roles carry one), then `comments.where("uid_thread","==", threadUid)` names its comments. Use the `array-contains` sweep as a **completeness cross-check**, not the sole discovery mechanism.
- **`sources` is an array, so no dotted field path reaches an element** — the whole array is read-modify-written. That is exactly the "container site" strategy `api-cloudrun/src/services/userNameCascade.ts:33-38` documents and `rewriteByScan` (`:167-227`) implements.

### 3d. Existing helpers to reuse — do not reinvent any of these

**Structure — two templates, and they are not interchangeable:**

- ⭐ **`api-cloudrun/src/services/cardCascade.ts` is the best STRUCTURAL template.** It is already a source-scoped, threads+comments-touching, batched multi-collection rewrite over the same `sources[]` arrays: chunked bounded reads (`chunk(uids, IN_LIMIT=30)` under `mapWithConcurrency(READ_CONCURRENCY=20)`), dedup via a `Map<id, doc>`, then one ordered `BatchOp[]` flushed by **`flushBatchedWrites` (`:76-82`, ≤`BATCH_LIMIT`=500 per `db.batch()`)** — the ready-made chunked-bulk-write primitive. **Ordering is its resumability mechanism** (`:19-27`): each op sits at or after its dependency, so a partial commit is re-discoverable and a retry is safe. It uses narrow `validatedPatch` on `sources`, never a full stale clone (rationale at `:29-35`), has a whole-set preflight that fails *before any write* (`assertCardsDeletable`, `:92`), and returns a typed per-collection count struct (`:117-126`).
- ⭐ **`api-cloudrun/src/services/userNameCascade.ts` is the best DOCSTRING** — copy its container-site reasoning verbatim for `threads.sources` / `comments.sources` (the read-modify-write-in-a-transaction rationale at `:155-165` is exactly the role-rename hazard). Note what does **not** carry over: its schema-derived target discovery (`actorRefSitesFor`) keys on node shape, and a role name is a plain string in known places. It also deliberately does **not** bump `updated_at` / `version` (`:39-49`), has no dry-run and no resumability, and its inline 450-op batch loop (`:146-155`) is superseded by `flushBatchedWrites`.

**Writes:** `runInstrumentedTransaction(name, fn, opts)` (`api-cloudrun/src/lib/instrumentedTransaction.ts:501-513`; opts at `:404-499` — `maxAttempts` default 10, `deadlineMs` default 15 000, `benignAborts`, `readOnly`). `validatedSet` / `validatedSetMerge` / `validatedSetDoc` / `validatedUpdate(Doc)` / `validatedPatch(Doc)` in `api-cloudrun/src/lib/firestoreWrite.ts`. For array rewrites: `validatedPatch(batch, ref, { sources: next, version: FieldValue.increment(1), updated_at: now }, "threads")` — the narrow-patch form, as `cardCascade.ts:200-207`.

**Cache:** `invalidateRoleCache(name)` (`api-cloudrun/src/lib/permissionCache.ts:145-147`). ⚠️ **Call it for BOTH names**, and know its limits: it is a plain `cache.delete` on a **60 s-TTL in-process map**, so on multi-instance Cloud Run other instances keep the stale entry for up to the TTL.

**Typesense: nothing to hand-roll.** `roles` has no Typesense config at all. `users_v3` (`roles` facet) and `comments_v1` (`sources.uid` facet) are both Eventarc-triggered — `api-cloudrun/src/routes/eventarc.ts:178-190` calls `syncToTypesense(collection, docId)` for any top-level doc in `typesenseEnabledCollections` — so **the Firestore writes resync Typesense for free.** `threads` is `enabled: false` (`core/src/schemas/typesense/threads.ts:16`) and is correctly skipped. *(This supersedes the earlier plan's "resync the two Typesense facets" step — it is not a step.)* Explicit entry points if a belt-and-braces pass is ever wanted: `syncToTypesense` / `deleteFromTypesense` (`src/lib/typesense.ts:47,112`), `reindexCollection` (`api-cloudrun/src/services/reindexTypesense.ts:80`).

**`token_version`:** the bump is a one-liner done identically at `roleAdmin.ts:465` (`token_version: (user.token_version ?? 0) + 1`, written via `validatedUpdateDoc` at `:468`) and `api-cloudrun/src/services/users.ts:363`. ⭐ **It is what makes the manager self-heal**: `manager/src/stores/user.ts:243-263` watches both `roles` and `token_version` via `onSnapshot` and calls `getIdToken(true)` then re-`GET /auth/me` (`:219-241`). With prod at 1 user this is 1 write.

**`preview_role`:** already self-heals gracefully — `api-cloudrun/src/routes/auth.ts:487-509` clears an unresolvable `session.preview_role` and logs `preview_role_self_healed` with `reason: "role_missing"`. So a *missed* session is not fatal; rewriting it is still strictly better (the operator keeps their preview). Same call shape as `auth.ts:504-506`.

### 3e. Sizing, and why the batched fan-out is built anyway

Limits: transaction write cap **500** (and no `set` after a `get`), plus an app-level **15 s deadline** and 10 commit attempts (`instrumentedTransaction.ts:402,432-457` — retries back off `1s × 1.5^n`, so the budget is spent around attempt 7); `WriteBatch` cap **500**; `in` / `array-contains-any` cap **30**.

Measured against prod (`cfs-3100`, 2026-08-17):

| Collection | Total | Role-scoped |
|---|---|---|
| `roles` | **6** (`admin`, `authenticated`, `customer`, `template-editor`, `template-maintainer`, `warehouse`) | — |
| `users` | **1** | ≤1 per role |
| `threads` | 4 164 | **1 per role** — each carries a distinct `uid_thread` |
| `comments` | 44 | **0** on any role thread |
| `invites` | not exposed via MCP | expected ~0 |
| `sessions` | not exposed via MCP | bounded by live sessions |

**A rename today is ~5 writes and would fit in one transaction. Do not design for that.** Two collections have no ceiling: `sessions` is unbounded and unmeasurable from here, and `comments` grows without limit once role threads are used — and it is the one whose rewrite is a whole-array read-modify-write.

⭐ **Ordering is the correctness property, and it has two halves.** *Within* the fan-out: **create-new first, delete-old last**, so every holder points at a role that exists at every instant and the silent `if (!role) continue` de-privileging window never opens. *Across* the phases: put only the authoritative part (the role doc copy + delete) in a `runInstrumentedTransaction("rename-role", …)`, then run users/invites/sessions/threads/comments as a batched fan-out ordered so a crash mid-fan-out leaves a state a retry re-discovers — `cardCascade`'s ordering invariant applied in reverse.

**Recommended shape:** a `renameRole(oldName, newName)` service in a new `api-cloudrun/src/services/roles.ts`, built on `cardCascade`'s skeleton with `userNameCascade`'s container-site transaction for the two `sources[]` collections; route handler beside delete in `roleAdmin.ts`. Run it as a **Cloud Task** (`api-cloudrun/src/lib/taskQueues.ts`, `src/routes/tasks.ts`) rather than inline, as `userNameCascade` does.

### 3f. Declare it in the propagation catalog

A rename that rewrites `threads.sources[]` and the `comments.sources[]` denorm is a propagation and must be declared. Read `core/CLAUDE.md` § *Propagation* first — one `PropagationModule` per file, a rule id is owned by the file that declares it, factories are file-local.

**`core/src/schemas/propagation/ids.ts` — hand-written unions** (and `propagation/ids.ts:1-41` explains why they cannot be derived: JSR `no-slow-types` erases the literals at the publish boundary). `tests/propagation.test.ts` asserts **set equality in both directions** against the folded catalog, so an id added in one place and not the other is red. Add:

- `TransactionId`: `"rename-role"`
- `RuleId`: `"rename-role:name-to-thread-sources"`, `"rename-role:name-to-comment-sources"`, `"rename-role:name-to-user-roles"`, `"rename-role:name-to-invite-roles"`, `"rename-role:name-to-session-preview"`

**Owning file: `core/src/schemas/propagation/threads.ts`.** It already owns every `roles`-sourced rule and the roles↔threads relationship; `propagation/users.ts`'s rules are all sourced *from* `users`. Declare all five there and put them under that file's header comment in `propagation/ids.ts`. The model to copy is `createRoleTransaction` (`propagation/threads.ts:220`) and, for a rewrite-shaped rule, `update-user:name-to-actor-refs` (`propagation/users.ts:82`, reached from a transaction's `steps` at `:122`).

⚠️ **Field paths are PATHS, not sibling lists** — the class-A defect from api-cloudrun#568, which type-checks because `FieldPath` is `string[]`. Write `{ source: ["name"], target: ["sources","uid"] }`, matching `cowriteRulesFor`'s own `{ source: [idField], target: ["sources","uid"] }` (`propagation/threads.ts:117`).

✅ **All four fan-out targets are legal `PropagationEndpoint`s** — verified in `CollectionDocs`: `comments:1138`, `invites:1153`, `roles:1184`, `sessions:1186`, `threads:1201`, `users:1207` (`core/src/schemas/mod.ts`).

**`enforced_by` (`EnforcementRef`, `propagation/types.ts:120-153` — needs `kind`, `ref`, optional `clause`, required `gates`):**

- ⭐ `api-cloudrun/scripts/audit-default-threads.ts` **property 3 (MIRROR)** — *"the comment's denormalized sources[] still equals its thread's"*. **This is exactly the invariant a rename breaks if it rewrites threads but not comments**, it `gates: true`, and it is already cited at `propagation/threads.ts:243-245`. Strongest available ref; also run it as the post-rename check.
- `api-cloudrun/scripts/audit-env-definitions.ts` — diffs live `roles/*.permissions` against `api-cloudrun/scripts/rbacRoles.ts` per environment.
- `api-cloudrun/scripts/audit-propagation-observed-writes.ts` — ⚠️ read its limits (`:31-50`) before citing: only 14 of 60 declared transactions ran in prod over 30 days, so a clean run proves nothing about an unexercised transaction.
- 🔴 **Do NOT cite `audit-name-forms.ts`.** `propagation/types.ts:183-188` names it as *the* disqualifying example: it reads as though it owns the name cascades and only compares an embedded ref against its own fields, so *a rename reaching zero targets passes it.*
- Recommended new detector, not yet written, which would earn `gates: true` if it exits non-zero (`propagation/types.ts:146-152`): `api-cloudrun/scripts/audit-role-name-integrity.ts` — no `users[].roles[]` / `invites.roles[]` / `sessions.preview_role` / `threads.sources[]` / `comments.sources[]` names a role with no doc, and every `roles/{id}.name === id`.

**Wiring on the api side:** route description via `getPropagationMarkdown("rename-role")` (`api-cloudrun/src/lib/propagation-docs.ts:51`, as `roleAdmin.ts:180`); fire `logTransactionPropagation("rename-role", { source_doc_id, status, duration_ms, rules_fired: [...], target_counts })` (`api-cloudrun/src/lib/logPropagation.ts:110`; `target_counts` is **required** on the closed context type at `:46-63`), modelled on `roleAdmin.ts:243-254`. ⚠️ `api-cloudrun/tests/unit/propagationCoverage.test.ts` asserts every declared step is fired **by that transaction** and **strips comment lines before matching** (`:14-33`) — a rule id that appears only in a docstring will not satisfy it.

### 3g. Then fix the UI copy

`manager/src/components/settings/RolesManager.tsx:229` — its instruction ("Role names are immutable. Delete and recreate to change a name.") becomes **true** once delete is wired (3a), and **obsolete** once rename ships (3b). Drop `disabled={mode() === "edit"}` at `:221` when rename ships, reuse the existing `validateCreateName()` (`:83-100`) for the new name, and **wrap the rename in `ConfirmPopover` too** — it is destructive-adjacent — with a `note` naming the real consequence: *"Every user, invite, session and comment thread referencing `old` is rewritten. Signed-in users are forced to re-authenticate their Firebase token."* Then `refreshRoles()`; the `token_version` bump propagates on its own.

### 3h. Docs and registries

**Update `api-cloudrun/CLAUDE.md`'s RBAC section in the same commit** — it documents the role surface, the rename route is new, and check nothing there still asserts that role names cannot change. Add the route to `api-cloudrun/openapi.json` (regenerated on commit) and to `api-cloudrun/tests/integration/permissionsManifest/manifest.test.ts:43`, which asserts the route registry. Extend `api-cloudrun/tests/integration/roleAdmin/roleAdmin.test.ts` — the delete steps at `:216-330` are the shape to mirror.

### Files to touch, in order

| Repo | File | Change |
|---|---|---|
| core | `src/schemas/propagation/ids.ts` | `"rename-role"` on `TransactionId`; 5 rule ids on `RuleId`, under the `propagation/threads.ts` header |
| core | `src/schemas/propagation/threads.ts` | declare the 5 rules + `renameRoleTransaction`; append to the file's single `PropagationModule` |
| api | `api-cloudrun/src/services/roles.ts` **(not yet written)** | `renameRole()` — preflight, `runInstrumentedTransaction("rename-role")` for the role doc, batched fan-out via `flushBatchedWrites`, typed counts, `logTransactionPropagation` |
| api | `api-cloudrun/src/routes/roleAdmin.ts` | new protected route beside delete (`:336`), `getPropagationMarkdown("rename-role")`, `invalidateRoleCache(old)` **and** `(new)` |
| api | `api-cloudrun/scripts/rbacRoles.ts` | only if seeded-role renames are allowed |
| api | `api-cloudrun/scripts/audit-role-name-integrity.ts` **(not yet written, recommended)** | the `enforced_by` detector; must exit non-zero |
| api | `tests/integration/roleAdmin/roleAdmin.test.ts` | extend; mirror the delete steps at `:216-330` |
| manager | `src/stores/roles.ts` | `deleteRole`, `renameRole` |
| manager | `src/components/settings/RolesManager.tsx` | rename affordance, `ConfirmPopover` on both, the new 409 / `ROLE_IN_USE` branch |

**No `api-cloudrun/infra/firestore-indexes.json` change is required** for any of the seven rewrites, provided you (a) do not add an `orderBy` to the `array-contains` sweeps and (b) filter `invites.used` in memory.

---

## Cross-repo release order (per `~/cfs/CLAUDE.md`)

Each core phase: commit on `beta` → push → JSR `-beta.N` → then bump `api-cloudrun/deno.json` (the explicit `jsr:@cfs/core@<ver>/…` subpath entries), `manager/package.json` (the single alias), and `templates/deno.json` (**exact** pins, one per subpath — **do not carry a count**: `origin/main` had 7 on 2026-08-23 while an unmerged draft branch had 8, so the number is a property of the branch, not of the repo). ⚠️ **Read the version off `origin/main`, not off the checked-out branch** — `templates` branches are user-generated drafts and the local one can predate the last pin PR. Measured 2026-08-23: the working copy showed `beta.240` while `origin/main` was at `beta.241`. **Bump by PATTERN, never by the remembered count** — a `sed` over `jsr:@cfs/core@<old>/` cannot miss a line; a remembered number can, and has. The root `~/cfs/CLAUDE.md` records its own copy of this count going stale twice (missing `utils/templates`, then missing `utils/citations`, core#66); this doc was stale by both additions at once, which is how a new subpath gets stranded on the old version. Run `deno install` / `npm install` so the lockfiles match. Templates has branch protection: **open the PR, never merge it.**

Templates is a pin bump and nothing else — no role type is reachable from that repo.

---

## Verification

- `deno task check && deno task lint && deno task test` in core after each phase.
- **Phase 2** — parse every live role name in **both** environments through `RoleId` before shipping. Parse `on_call` through `RoleSchema` **and** `DocSource`: both must now agree. Confirm `SeededRoleName` makes a typo'd literal a compile error.
- **Phase 3** — rehearse the rename end-to-end **in dev**, against a throwaway role with a holder, a thread and a comment. Assert afterwards that:
  - no `users.roles[]`, `threads.sources[]` or `comments.sources[]` still names the old value;
  - the holder's permissions never dropped mid-run;
  - `search_users` / `search_comments` facets reflect the new name.

  Then run **`api-cloudrun/scripts/audit-default-threads.ts` (property 3, MIRROR)** — the existing enforcer for the comments denorm, and the check that catches a rename which updated threads but missed comments — and `api-cloudrun/scripts/audit-env-definitions.ts --only=roles` → exit 0.

  **Do not rehearse in prod.**

---

## Context recommendation

**CLEAR CONTEXT.** This doc is written to be picked up cold, and Phase 3's rename fan-out — seven write targets with a silent de-privileging failure mode — wants a fresh window of its own rather than one already spent on the census that produced this plan.
