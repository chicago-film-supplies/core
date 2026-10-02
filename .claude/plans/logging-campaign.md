# Structured logging campaign — predictable, discoverable querying

**Status 2026-10-02: the live query defects are fixed. Everything left is PARKED on core#65**,
which closes on a clean corpus audit on 2026-12-31. The history (five corrections, the census, the phase plans)
is in git: `git log -p -- .claude/plans/logging-campaign.md`. The design sections below
still say "defect N" and "Phase N"; both are defined in that history (the revision before
2026-10-02).

## Current statement

**Done:**
- **Phase 0.** `api-cloudrun/scripts/audit-log-corpus.ts` reconciles the registry, the alert
  rules and the live corpus.
- **Phase 2.** `api-cloudrun/tests/unit/alertRuleContract.test.ts` requires every field a rule
  groups by to be declared. It runs in the gate with an empty allowlist.
- **Phase 1, declaration half** (`beta.253`).
- **Phase 5a.** The order reference converged on `uid_order` and the product reference on
  `uid_product` (`beta.584`, api-cloudrun write-path-and-logging B1–B3). The five alert rules
  that read them carry a query-time bridge, and a `LegacyLogFieldEmitted` canary watches for
  a missed site. Both are removed by api-cloudrun#1181. ⚠️ The bridge form this doc prescribed
  (`keep_original_fields skip_empty_results`) does not parse on VictoriaLogs v1.52.0, and vmalert
  exits on it. The rules use `keep_original_fields` alone.
- **Also done:** `error` → `error_message` (propagation arm and 11 plain sites); `logError`
  and `logTimed` typed through the registry; the `log.*` shim deleted; and `logTyped` now
  checks every DECLARED field's type, not only the `msg`. Its `OmitTs` had flattened each arm
  to its index signature; the fix found 8 src emitters the schema disagreed with.
- **`user_id` on request records** (api-cloudrun#816).
- **The "add a log message" recipe and the naming rule** now live in api-cloudrun's
  `logging-propagation` skill, per owner decision (2026-09-30), not in a new plugin skill.

**Still open elsewhere:** manager's browser logs send `order_uid`
(chicago-film-supplies/manager#591).

## Parked on core#65 — each with its trigger

**Scheduled 2026-12-31 (owner, 2026-10-02):** run `api-cloudrun/scripts/audit-log-corpus.ts` against
prod and dev. **If it is clean, close core#65 and drop every item below**: a clean corpus is the
evidence they are not needed. If it finds a defect, justify only the item that would have
prevented it. The date matches api-cloudrun#1181, after which no old-spelling record remains in
retention.

1. **Delete the arms' `[key: string]: unknown` and add `NoExcessProperties`** (Phase 1, churny
   half). That makes an undeclared field NAME a compile error. ⚠️ Three things depend on the
   signature today:
   - about 10 of `SAFE_PASSTHROUGH`'s keys exist in logs only because of it;
   - `api-cloudrun/.claude/plans/dev-database-pool.md` adds an undeclared `database` field to
     the `mirror_*` records on the strength of it;
   - every top-level spread site (below).
2. **A named `context` bag in place of the index signature.** 🔴 **PII trap:** a naively
   declared `context` turns the scrub OFF for exactly the fields that need it. `denylistScrub`
   skips any key tier 1 reports in `schemaTopLevelKeys`, and tier 1 walks nothing inside an
   untagged `z.record`. So an `email` inside `context` would pass raw. Verify by planting a
   `RUNTIME_DENYLIST` key both inside `context` and at the top level; the second is the
   control.
3. **`LOG_EVENTS`** (Phase 3, design below), with `MSG_SCHEMA_REGISTRY` derived from it, and
   then the generated catalogue (Phase 4).
4. **Smaller items that ride along with whichever of these runs first:**
   - the prune of dead msg literals (on the emitter column, never the hit count);
   - the 5b consistency renames (`invoice_uid`, `organization_uid`, …). They are
     single-spelling, so no bridge is needed;
   - typing `collection` as `CollectionName`;
   - `ClientLogRecord.subject` → `email_subject`.

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

## Context recommendation

**Clear.** Nothing here is scheduled except the 2026-12-31 audit. Whoever picks up a parked item starts from core#65, then
this doc's design sections, then the `logging-propagation` skill in api-cloudrun. Re-run the
corpus audit first, since every number in the design sections is from 2026-08-24.
