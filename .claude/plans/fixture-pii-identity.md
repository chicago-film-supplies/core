# core#91 + #92 + #93 — one campaign. Code LANDED; the fixture re-capture is what remains.

> ## ⚠️ STATUS 2026-09-08 — everything except the templates fixture corpus has SHIPPED, including to PROD
>
> This doc replaces the earlier plan of the same name, whose *"Blocked on a peer session"* claim was
> false when written and whose `## Context recommendation` had expired. Do not look for that version.

## Context

Three `core` issues describing one defect shape, plus three riders, shipped as one beta because the
dependency graph is a fan-in rather than a chain: one publish, one re-capture cycle, one manager
deploy.

- **core#91** (`kind:defect`) — `applyPii` faked one organization as two different companies in one
  document and masked `scope.name` as `Sample text for name....`
- **core#92** (`kind:cleanup`) — `AgingScope.name`, a derived scalar beside its own source.
- **core#93** (`kind:cleanup`) — three `{uid, name}` org refs stating a pre-joined name.

## What has LANDED

| repo | state |
|---|---|
| `core` | **`@cfs/core@10.0.0-beta.385` published.** `8ec3809` walker `siblings` · `52f2c16` masker · `ce80fea` core#92 · `0da1432` core#93 + `due_at` + `TEMPLATE_COMMIT_TYPES`. Suite 2244 green. |
| `api-cloudrun` | **`v0.243.0` MERGED AND DEPLOYED TO PROD** — revision `api-cloudrun-00359-928`, pinning beta.385. 2014 unit tests green. |
| prod data | **2 documents repaired** (`scripts/repair-template-commit-types.ts`), verified 0 remaining. |
| `manager` | `14f3cb9` on `main`, deployed. Typecheck clean, 1977 tests green. |
| `templates` | branch **`core-91-92-93-campaign`**, commit `6f0b98c` — pin, `lint-capture-floor` trigger, `min_core` → beta.385, four `.eta` files. **NOT pushed, no PR yet.** |

🔴 **The hard serialization point is PASSED.** A capture is sanitized by the DEPLOYED core
(api-cloudrun#838); prod now serves beta.385, so captures taken from here get the fixed masker.

## What REMAINS — the fixture corpus, and only that

`deno task lint:fixtures` is **red on 14 of 38** on that branch. That is expected and is templates#187's
class: a `z.strictObject` shape change invalidates committed fixtures without touching a fixture file.

| family | fixtures red | why |
|---|---|---|
| aging-report | 4 | `scope.name` gone; `organization_path` added |
| statement | 3 | `scope.name` gone |
| packing-list | 2 | org ref `{uid,name}` → `{uid,organization_path}` |
| pick-sheet | 2 | same |
| receipt | 3 | same (`anonymous-cross-customer` is fine — its org is `null`) |

⚠️ **Three of these cannot be repaired by hand, and the reason decides the approach.** The old fixture
carries only the COMPOSED NAME; the chain is not in it. So the `{uid, organization_path}` shape cannot
be derived from what is on disk without inventing a single-node chain, which would be a lie about the
org tree. `packing-list`, `pick-sheet` and `receipt` **must be re-captured**.

`statement` × 3 is a pure key deletion and IS mechanical. `aging-report` needs `scope.name` deleted and
`organization_path` added — derivable in-document from the scoped uid's chain, which already appears
under `rows[]`/`organizations[]`.

⚠️ **But re-capture is wanted for all of them anyway**, because it is what actually delivers core#91:
the identity seeding and the injective allocation only reach the corpus through a fresh capture. A
shape-only migration would leave `all-accounts` rendering 14 accounts under 10 labels.

⚠️ `aging-report/credits-applied` is **HAND-BUILT and cannot be captured** — its sidecar says so. It
must be REBUILT from a re-captured `subtree-invoice-date`.

⚠️ `buildAgingReport` refuses any as-of but today's, so `subtree-invoice-date` re-renders **different
money by construction**. Its sidecar's anchor figures must be re-measured, not carried.

### The capture parameters are NOT recorded anywhere

Sidecar entries carry `slug`, `label`, `description` and nothing else — no source collection, no
`doc_uid`, no params. Each fixture's capture inputs have to be reconstructed from its `description`,
which does name them in prose (e.g. *"`organization-subtree` on Netflix Productions, LLC"*, *"Captured
from prod order 991"*). **That reconstruction is the bulk of the remaining work.** Worth filing
separately: a sidecar that recorded its own capture inputs would make a re-capture mechanical.

### Then

1. Re-bless goldens, **both namespaces** — `api-cloudrun/scripts/rebless-goldens.ts --env=dev --write`
   with an impersonated `golden-diff-ci` token. `--env=prod` 403s **by design** (prod's Gotenberg
   grants invoker to `api-runtime-prod` only).
2. `deno task lint:fixtures` and `deno task lint:capture-floor` both green.
3. **Look at the rendered page.** `goldens/main/aging-report/all-accounts.png` — 14 accounts should
   show **14** distinct labels (10 today). `nothing-outstanding.png`'s scope line currently reads
   `Sample text for name..........`.
4. Open the PR. 🔴 **templates PRs AUTO-MERGE ~1 min after CI goes green** — have the goldens right
   BEFORE CI passes; there is no review window.

## Also outstanding

- **`api-cloudrun/.claude/skills/templates/SKILL.md:70` is now FALSE** in both clauses: *"`path` is on
  orders, invoices and credit-notes ONLY. The light shapes carry `{uid, name}` and no chain, so
  `session.organization` on a receipt has nothing to compose from."* After core#93 they do carry the
  chain and the receipt does compose. It is a skill — the org-shared authority every machine and cloud
  agent reads — and no gate checks a skill's *claims*, only that its paths resolve.
- Close **core#91, core#92, core#93** when the corpus lands.
- File **`MovementSessionItem.owner_path`** — DESCOPED from this campaign. It was assumed cheap; it is
  not. `services/movementSessions.ts` never loads fulfillments, so populating it needs a new per-order
  fulfillment join. Shipping the field without the populator would be a declared-but-inert value.
- File the **`lint-capture-floor` discriminant-probe** limit (see `6f0b98c`'s message).
- File the **sidecar capture-inputs** gap above.
- `templates#270` — **already closed** (superseded, pinned beta.374).

## Findings worth keeping

- **The address defect is 4× larger than reported.** Measured over all 38 fixtures: **26 same-uid
  destination leg pairs, 23 masking to two different streets** — not the "6 of 6" the handoff claimed.
  17 of the 23 are in `invoice`/`quote`, i.e. **core#94's corpus, outside this campaign**. Those stay
  oracle-valid, so nothing is red; they simply churn when next re-captured.
- **`DocDestinationEndpoint.uid` is a sibling of `address`, not of `address.full`**, so the `siblings`
  seam does NOT reach it. The fix is value-identity seeding, which is simpler and also fixes emails,
  phones and people.
- **`AgingReport` had no top-level `organization_path`.** core#92 is not a symmetric delete; the ADD is
  load-bearing or `aging-report.eta:149` has nothing to compose from.
- **Two api-cloudrun tests pinned the defect as a requirement** (`fixturePiiStrategy.test.ts:45`, `:768`)
  and went red only on the pin bump — `core`'s own suite stays green through the fix.

## Context recommendation

**Clear, then resume from this doc.** The landed half is verifiable from git and JSR and needs no
context to trust. The remaining work is one bounded task — reconstruct 14 captures, re-bless, open one
PR — and it is better done with a full window than with what is left of the session that shipped the
rest.
