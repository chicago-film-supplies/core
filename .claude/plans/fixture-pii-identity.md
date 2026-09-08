# core#91 — review, verification, and the repair

## Context

`core#91` (`kind:defect`, `area:testing` `area:templates` `area:data-integrity`) reports two defects
in how `src/utils/fixture-pii.ts` fakes a `pii: "mask"` **organization name** during template
fixture capture, plus a third in a follow-up comment. They surfaced together because
`templates/templates/aging-report.eta` is the first template to print an org chain in two tables
*and* print `scope.name`, so all three landed on one rendered golden at once.

I verified every claim against the code and against the committed fixture corpus. **All three
defects are real.** Three of its numbers are stale (the corpus grew the same day it was filed), one
sub-claim in the comment is refuted, one is understated, and — most importantly — **the comment's
proposed fix is arithmetically impossible as stated**: it says the repair "does not need a bigger
vocabulary", but the injective draw it asks for is a pigeonhole failure at the current vocabulary
size.

The intended outcome: one organization is one company name everywhere in a document, two
organizations are never the same company name, `scope.name` renders an account instead of
`Sample text for name....`, and both defect classes become structurally impossible rather than
policed.

---

## Verification

Measured 2026-09-08 over all **36** committed fixtures on `templates` `main`, walking each document
with core's own `categoryForField`.

| # | Claim | Verdict |
|---|---|---|
| §1 | The seed is `HMAC(salt, fieldPath, value)`, so one org uid draws a different company at each path | **TRUE.** `fixturePiiStrategy.ts:70` hashes `` `${fieldPath}::${value}` ``; `fixture-pii.ts:533` is `pick(FAKE_ORGANIZATIONS, seed)` |
| §1 | "28 uids across 6 fixtures" | **TRUE at filing, now 29 across 7.** `packing-list/single-order-collection.json` landed hours later and brought one more |
| §1 | api-cloudrun#778's closure does not extend to this | **TRUE for §1** — two frozen chains, neither derived from the other. **False for §2; see the correction below** |
| §2 | `scope.name` falls to `text` and renders self-announcing filler | **TRUE.** No `scope.name` in `QUALIFIED_CATEGORY`; `name` deliberately absent from `LEAF_CATEGORY` |
| §2 | "6 of 27 fixtures hold filler" | **TRUE at filing, now 8 of 36.** `aging-report/credits-applied` and `packing-list/single-order-collection` joined it |
| §2 | The category depends on a sibling discriminant, and `(parent, leaf)` structurally cannot see one | **TRUE**, and it is the same structural gap as §1 |
| §3 | 16 vocabulary entries; `all-accounts.png` renders 14 accounts | **TRUE** |
| §3 | "three collided pairs" | **UNDERSTATED.** Three collided *labels*, but one is a **triple** — `Foxglove Films LLC` carries $8,350.00, $49.92 **and $2,495.60**. 14 accounts render under **10** distinct labels; 7 accounts are in a collision, not 6 |
| §3 | "a collided chain renders as a single-segment label… every one of these is a three-node chain" | **REFUTED.** The depth histogram on `all-accounts` is `{1: 11, 3: 3}` — eleven accounts genuinely carry a one-node chain, so the varying depth is real data, and that fixture has **no** within-chain collisions |
| §3 | (the real form of that tell) | A collided chain renders a **repeated** segment, and it exists — **5 chains in 2 fixtures, both outside the aging-report family**: `invoice/rental-discount-taxed.json` → `Silverline Media Group / Silverline Media Group` (uids `5LDGUhVHsvXOqgsFzhke` + `nWlYCEzuc1we7xqF7aYZ`), and `statement/open-item-floor.json` lines 0–3 → `Sixpoint Pictures Inc / Sixpoint Pictures Inc` |
| — | Sequencing: beta → pin + prod DEPLOY → floor raise → re-capture → re-bless | **TRUE in shape**, but cheaper than stated — see below |

### Two facts the issue does not have, and both decide the design

🔴 **190 of 190 organization-category leaves in the corpus have a sibling `uid` in the same object.**
`OrgPathNode` is `{uid, name, derived}`, a scope is `{kind, uid, name, uids}`, an org ref is
`{uid, name, path}`. The identity the fix needs is always exactly one key away — so no fallback
population has to be designed for, and §1 needs no document-wide plumbing at all.

🔴 **The injective `pick` the comment asks for is unrepresentable today.**
`fixtures/aging-report/all-accounts.json` carries **18 distinct organization uids** against a
**16-entry** vocabulary — drawing without replacement is a pigeonhole failure before it is a design
question. So the comment's *"It does not need a bigger vocabulary — that treats the symptom and the
bound just moves"* is **false**: injectivity **requires** one.

⚠️ **But a bigger list is only half the answer, and a COMPOSED one is the wrong half.** Prod holds
**317 organizations** (counted 2026-09-08), so an `all`-scope run can in principle carry hundreds
of accounts and no curated list can be sized against that grain. The tempting fix — a
`<stem> <trade> <suffix>` grammar — breaks the ORACLE, because real production companies follow
exactly that grammar and `maskVerdict` would start judging a real customer name `masked`. The
honest answer is a longer literal list plus a **loud refusal** when a document exhausts it. See
*The repair* §2(c).

### One correction to the issue's api-cloudrun#778 argument

The issue says *"There is no derived scalar here."* True of §1. **False of §2.**
`src/schemas/reporting.ts:492-512` — `OrgStatement` carries `scope: AgingScope` (whose `name`
is `composeOrgName(chain)`) **and** `organization_path: OrgPathNodeType[]`, documented as *"The
scoped organization's LIVE chain, for the document heading"*, directly beside it. That is exactly
the *derived-scalar-beside-its-source* pattern #778's closure says is being eliminated by design.
`AgingReport` has no such sibling field, so the pattern is half-present rather than absent.
**Deferred, not folded in** — see *Follow-ups*.

### Three things cheaper than the issue implies

- **No committed fixture goes red.** The oracle accepts the self-announcing filler for *every*
  category (`isFiller`, `fixture-pii.ts:611`), and every existing org value is still a
  `FAKE_ORGANIZATIONS` member. So as long as the vocabulary is **appended to** rather than edited,
  `template-lint`'s blocking check 2b stays green across all 36 fixtures. **Re-capture is a
  legibility choice, not a lint obligation** — which is why it can be scoped instead of paid whole.
- The two hand-set `path[0].name` values (templates#185) are both `Wayfarer Productions LLC` for the
  same uid `nTpq3YIY4cth5todd4PV` — already consistent with each other and still oracle-valid. They
  churn only if re-captured.
- `aging-report/credits-applied.json` is **hand-built from `subtree-invoice-date`'s already-masked
  capture**, so it accidentally already has the property the masker lacks (its two tables agree —
  its own sidecar says so). It cannot be re-captured; it must be **rebuilt**.

### One gap that would silently stall the fix — and it is wider than it first looks

`templates/scripts/lint-capture-floor.ts:386` builds its route map as
`routes.set(leaf.path, categoryForField(leaf.path))` — **path only, no siblings** — so a
discriminant-dependent route is invisible to `covers()` (:481-492).

🔴 **But the deeper problem is that routes never reach the TRIGGER at all.** Staleness is detected
at `:437` as `missing = newestTags − floorTags`, over the **tag set alone**, and `:445` is
`if (missing.length === 0) { … Deno.exit(0) }`. `newestRoutes` is consulted only inside `covers()`,
which runs *after* `missing` is already non-empty — so routes refine the *suggested answer* and
never arm the *trigger*. **Any route-only change is invisible today**, discriminant or not: adding
a plain `QUALIFIED_CATEGORY` row would pass silently too. templates#251 raised the bar of the
answer without arming the trigger, and this repair adds no new tag, so today's lint would print
`✅ min_core covers every pii tag` and let the floor rot at `beta.376`. Closing both halves is part
of the work.

### One correction to the file's own comment — and a trap inside it

`fixture-pii.ts:97-99` says `scope.name` "is a street address for `kind: "destination"` and an
organization for `kind: "organization"`". `PickSheetScope` has **three** arms, and `kind: "order"`
is `composeOrgName(order.organization.path)` too — so by *category* it is an organization
(`api-cloudrun/src/services/pickSheets.ts:203`).

🔴 **It still must not be routed there, because its identity is missing.** `resolveOrderScope` sets
`scope.uid` to the **ORDER's** document id, not the organization's. Seeding an organization fake on
an order id would mint a label unrelated to that same pick sheet's `organizations[]` and
`orders[].organization` — manufacturing a fresh §1 on the one document that physically leaves the
building. The `order` arm therefore stays `text`.

### And only 5 of the 8 filler fixtures actually RENDER it

`templates/templates/statement.eta:237-241` names `scope.name` in a *"what this template
deliberately does NOT render"* block: *"the letterhead already prints the same customer, composed
from `organization_path` … printing both puts one name on the page twice."* So the three
`statement/*` fixtures carry a dead field, and the live blast radius is 3 aging-report goldens plus
2 packing-list goldens.

⭐ **That is also the strongest single argument for the deferred cleanup below** — one of the three
consumers has already independently reached the conclusion that deleting `AgingScope.name` would
enforce.

---

## The repair

Scope chosen: **fix the masker, including the collision half. No stored field moves.**
Re-capture: **the aging-report family only.**

One mechanism closes all three symptoms — **give the masker and the oracle access to the leaf's
sibling fields.** §1 needs the sibling `uid`; §2 needs the sibling `kind`; §3 needs a vocabulary
that can hold the document's distinct identities.

### 1. `src/schemas/pii/walker.ts` — thread the containing object

Widen the strategy seam with a fourth, optional parameter:

```ts
export interface PiiStrategy {
  apply(
    value: unknown,
    classification: PiiClassification,
    fieldPath: string,
    /** The object CONTAINING this leaf, pre-transform, when there is one. */
    siblings?: Readonly<Record<string, unknown>>,
  ): unknown;
}
```

A 3-parameter implementer is assignable to a 4-parameter signature, so **both existing implementers
keep compiling untouched** — `createLoggerStrategy` (`walker.ts:130`) and api-cloudrun's
`createFixtureStrategy`. No consumer breaks; the change is additive.

Thread it through `transformField` (:454), `applyTagged` (:335) and `applyInherited` (:415), setting
it at the two sites that already hold the container:

- `walkObject` (:302-309) — pass the **pristine `record`**, never the `out` copy it is mutating, so
  the seed cannot depend on key order or on an already-masked sibling.
- `applyTagged` (:391-396) — pass the pristine `value` for the same reason.
- `transformField`'s array arm (:476-481) passes its own `siblings` straight through: an array of
  objects re-establishes them when the walk descends into each element, and an array of scalars
  (`contact.phones`) correctly keeps the containing object's.

### 2. `src/utils/fixture-pii.ts` — routing, identity, vocabulary, oracle

**(a) Discriminant routing.** A third table beside `LEAF_CATEGORY` and `QUALIFIED_CATEGORY`, keyed
on `(parent, leaf)` → discriminant field → arm. `categoryForField` gains an optional `siblings`
parameter and consults it first; **an absent or unrecognised discriminant falls through to the
existing tables, i.e. to `text`** — the safe direction is preserved exactly as the file's docstring
argues for it.

```ts
"scope.name": { on: "kind", arms: {
  organization: "organization",  // AgingScope, OrgStatementScope, PickSheetScope
  destination:  "address_full",  // PickSheetScope — destination.address.full
  all:          "text",          // AgingScope — always "", never reaches a fake
  // 🔴 `order` is `composeOrgName(order.organization.path)`, so the CATEGORY is
  // organization — but `resolveOrderScope` sets `scope.uid` to the ORDER's
  // document id, NOT the organization's. Seeding an org fake on an order id
  // would mint a name that CONTRADICTS the same pick sheet's `organizations[]`
  // and `orders[].organization` — a new §1 on the one document that physically
  // leaves the building. The filler claims nothing; a contradiction is a lie.
  order:        "text",
}}
```

⚠️ **The `order` arm is the one place this repair deliberately leaves the filler in
place.** Its durable fix is the same one core has applied twice already
(api-cloudrun#780 / #782 / #923): replace `scope.name` with the chain it composes
from, so it masks by composition and needs no discriminant at all. Filed as a
follow-up, not folded in.

**(b) Identity seeding.** A `MaskCategory → sibling field` table (`organization → "uid"`) plus a
constant synthetic seed path. `fakeForMask` gains `siblings` and, where an identity resolves,
draws with `seedFor(IDENTITY_SEED_PATH, uid)` instead of its own field-path seed. **The salt still
never crosses into core** — this reuses the existing `SeedFor` callback, which is exactly the seam
`fakeAddressFull` already uses. Falls back to the field-path seed when no identity is present, so
nothing regresses for a leaf without one.

This alone makes §1 unrepresentable: the draw is a function of the subject, not of where it appears.

**(c) Vocabulary — append literals, do NOT compose a grammar.**

🔴 **A composed grammar would break the oracle, and that overturns the first draft of this plan.**
`maskVerdict`'s organization arm would have to become a regex like
`^(?:Stem…) (?:Media|Films|Pictures…) (?:LLC|Inc|Group)$` — and **real production companies follow
exactly that grammar**, so a genuine customer called *"Anderson Media Group"* would be judged
`masked`. The oracle's entire question is *"is this a leak?"*, so an arm that accepts real company
names is a leak-detection regression, not a widening. A literal list cannot do that.

So: **append 24 entries, 16 → 40** — 2.2× headroom over the largest observed document (18 uids).
Keep the ≥3-token floor; `tests/fixture-pii.test.ts:240` already asserts it over the whole list, and
`:251` hard-asserts `FAKE_ORGANIZATIONS.length === 16`, so the widening is a test edit as well as a
data edit. Replace that with a `>= 40` floor carrying the arithmetic in its failure message, so a
later deletion is a failure rather than a silent capacity cut.

⚠️ **Append at the END only — never insert, never reorder.** `pick` is `items[n % items.length]`,
so an insertion re-seeds every entry after it exactly as an edit would.

**And the 317-org bound is answered by a LOUD REFUSAL, not by a bigger list.** The allocator throws
when identities exceed the vocabulary, naming the remedy. A capture that fails is recoverable; a
capture that silently collides, or an oracle that accepts a real name, is not.

**(d) Injective assignment.** A document-scoped reservation built in one read-only pre-pass:
collect the distinct organization identities, order them **by identity seed** (not by document
order, so reordering a document reshuffles nothing), then assign `seed % N` with forward linear
probing on collision, and **throw on exhaustion** — a wrapped allocation is precisely the defect the
allocator exists to remove. Sorting by identity rather than by walk order is what makes the result a
function of the SET: an org whose first-choice slot is free is unaffected by everything else in the
document, so churn is bounded to colliders (expected ≈ 3.8 at k=18, N=40; ≤ 0.5 for every other
fixture in the corpus, where k ≤ 7).

Core owns the orchestration — a `createFixtureMasker(doc, schema, seedFor)` factory returning a
per-leaf mask function, with `fakeForMask` staying the pure function underneath. api-cloudrun's
`createFixtureStrategy` takes it as an optional argument and defaults to `fakeForMask`, so the 44
existing strategy tests that construct a strategy with no document keep working.

**(e) The oracle.** `maskVerdict` gains the same optional `siblings`, `MaskedLeaf` gains a
`siblings` field, and `collectMaskedLeaves` populates it. The organization arm becomes
`legacy set membership || composed-grammar regex` — the same shape `MASKED_STREET_RE` already uses.
`template-lint.ts:517-525` passes siblings into both `maskVerdict` and the `categoryForField` call
in its finding text.

### 3. The guard

The mechanism makes both classes impossible for anything freshly captured, so the guard is a
**canary that the mechanism still reaches the corpus** — the planted-construct pattern this package
uses everywhere — not a policy check.

- **Unit** (`tests/fixture-pii.test.ts`): the same uid at two field paths draws one name; two
  uids sharing a real name draw two (the `Locations`/`Office`/`Transpo` case api-cloudrun#923
  exists for); a `scope.name` with each discriminant arm routes correctly and an unknown/absent
  discriminant still falls to `text`; re-running the masker is byte-stable.
- **Corpus** (a new `template-lint` check): in one fixture, no organization uid carries two fake
  names and no fake name carries two uids. ⚠️ **It must land ADVISORY**, because the seven
  fixtures outside aging-report still violate it — the same reason check 2b shipped advisory in
  2026-09-06 and flipped later. It flips to blocking when the rest are re-captured.

---

## Release order

🔴 **A capture is sanitized by the DEPLOYED core** (api-cloudrun#838), so the prod deploy sits in
the middle of this, not at the end. Nothing enforces the order — write it into the PRs.

1. **`core`, on `beta`** — the walker, the masker, the oracle, the tests. `feat`, not breaking (every
   new parameter is optional). Push → semantic-release publishes `10.0.0-beta.N`.
   Gates: `deno task check`, `check:declarations`, `check:generated`, `test`, `audit:citations`.
2. **`api-cloudrun`, on `main`** — bump the pins **by pattern, never by count**
   (`sed` over `jsr:@cfs/core@<old>/`; `grep -c 'jsr:@cfs/core@' deno.json` says 39 today).
   Wire the reservation pre-pass into `captureFixture` (`api-cloudrun/src/services/templates/fixtures.ts`).
   Update `fixturePiiStrategy.ts` and its 44 tests — **including `EXPECTED_ROUTES` at
   `api-cloudrun/tests/unit/fixturePiiStrategy.test.ts`, which is deliberately hand-maintained rather than
   derived from core's table, so editing it by hand is the point rather than a chore.**
   Run `deno task test:units` after the bump (~9 s, hermetic) — a pin bump's red rarely names the
   thing you changed.
3. **🔴 Deploy api-cloudrun to PROD** — merge the release-please PR. Until this lands, every capture
   is still sanitized by the old masker. Prod runs `api-cloudrun-00357-mzf`; `v0.241.0` pins
   `beta.380`.
4. **`templates` PR A** — bump the 14 pin entries; fix `lint-capture-floor.ts` in **both** halves —
   expand the route fingerprint at `:386` over a `MASK_ROUTE_PROBES` set that core exports (derived
   from the discriminant table, so a future discriminated route gets its probes for free), **and arm
   the trigger at `:445`** so a non-empty `rerouted = newestRoutes ∖ floorRoutes` counts as staleness
   alongside `missing`. Then raise `capture-floor.json` `min_core` to the new beta **with a `why`
   naming this issue** and saying plainly that this is a ROUTE raise, not a TAG raise. ⚠️ Raise it only to a version api-cloudrun has actually deployed — the
   floor file says so itself, and templates#155's carve-out does not apply here (no deployed-enums
   lint is blocking this PR in parallel).
5. **`templates` PR B** — re-capture `aging-report/{all-accounts, subtree-invoice-date,
   nothing-outstanding}`; **rebuild** `aging-report/credits-applied` from the re-captured
   `subtree-invoice-date` (it is hand-built and has no capture to run); re-bless
   `goldens/main/aging-report/` **and** `goldens/sandbox/aging-report/`; update the four sidecar
   descriptions, which currently say "re-capture when core#91 lands".
   ⚠️ `buildAgingReport` refuses any as-of but today's, so `subtree-invoice-date` re-renders
   **different money by construction** — its sidecar's anchor argument ($1,135.57 / $1,514.95) must
   be re-measured, not carried over.

**`manager` needs nothing** — it has no consumer of `fixture-pii` or of the pii walker.

---

## Verification

- `core`: the new unit arms above, plus the full suite (`deno task test`, hermetic, `--parallel`).
- `api-cloudrun`: `deno task test:units`, then the strategy suite's idempotence arm
  (`api-cloudrun/tests/unit/fixturePiiStrategy.test.ts`, its idempotence arm) — that is what proves a re-capture stays byte-stable.
- **Re-run the corpus measurement** after PR B. Over the four aging-report fixtures, expect
  `uid carrying >1 name` = **0** and `fake name carrying >1 uid` = **0** (they are 18 and 11 today
  on `all-accounts` alone). Walk each fixture with core's `categoryForField`, group
  organization-category leaves by their sibling `uid`.
- **Look at the rendered page.** Open `goldens/main/aging-report/all-accounts.png` and count the
  Account column: 14 accounts, 14 distinct labels (10 today). Open
  `goldens/main/aging-report/nothing-outstanding.png` — the scope line is most of that page and
  currently reads `Sample text for name..........`.
- `templates`: `deno task lint:fixtures` and `deno task lint:capture-floor` must both be green, and
  the capture-floor lint must now *want* the raised floor rather than accepting the old one — that
  is the check that the §2 route is actually visible to it.

---

## Follow-ups (file before the session ends)

- **`templates`** — re-capture the remaining 7 affected fixtures (`statement` ×3, `packing-list` ×2,
  `invoice/rental-discount-taxed`, and the two hand-set templates#185 values) and **flip the new
  corpus check from advisory to blocking**. `kind:cleanup`, `area:templates`, `size:one-session`.
- **`core`** — `AgingScope.name` is a derived scalar sitting beside `OrgStatement.organization_path`,
  which is the pattern api-cloudrun#778's closure says is being eliminated. **Cite
  `templates/templates/statement.eta:237-241` as the consumer that already refuses to render it** —
  that is the strongest single argument for the deletion and it is already written down. Deleting it
  is a four-step cross-repo removal (the corpus is the committed fixtures, per templates#187, not
  Firestore — the fold is not stored) and it does **not** remove the need for discriminant routing,
  because `PickSheetScope.name` for `kind:"destination"` is an ADDRESS and no chain can replace one.
  `kind:cleanup`, `area:schema`, `size:campaign`.
- **`core` / `api-cloudrun`** — the `scope.name` `kind:"order"` arm left as filler by this repair:
  `PickSheetScope` states an order id where an organization identity is needed. The durable fix is
  the same composition change as above. `kind:gap`, `area:templates`.
- **Comment on core#91** with the corrections: the stale counts (29/7 and 8/36), the refuted
  reverse-tell and its real form, the pigeonhole finding that overturns "it does not need a bigger
  vocabulary", the derived-scalar correction, the `lint-capture-floor` gap, and the `kind:"order"`
  arm the file's own comment omits. Add `size:campaign` — this crosses three repos with a prod
  deploy in the middle.

---

## Context recommendation

**Continue** into implementation. The verification above is the expensive half and it is all in this
session's context — the measured corpus numbers, the pigeonhole bound, the walker call sites, and
the release order. A fresh session would have to re-derive the measurements before it could trust
the design. If implementation is deferred, promote this doc to `core/.claude/plans/` first, since
`~/.claude/plans/` is invisible to every other machine and every cloud agent.
