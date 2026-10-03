# Invoice line → order line pointer: `path_order_item` (core#125)

**Date:** 2026-10-03 • **Repo:** core (+ api-cloudrun, manager) • **Status:** in progress — Phases 0–3 built; prod release order + 2b remain
**Origin:** core#125 (core#124 Phase 4). Sequenced ahead of core#127 (standalone invoices) — see core#127 comment of 2026-10-03.
**Related:** core#124, core#127, manager#472, api-cloudrun#538 §2, api-cloudrun#1189, `core/src/utils/substitutions.ts`, `core/src/utils/invoices.ts` (`syncOrderToInvoiceSelective`), `manager/src/utils/invoiceDrop.ts`
**Closes:** core#125 when Phase 3 lands (core#125 stays the tracker until then).

> ## ⚠️ STATUS UPDATE 2026-10-03 (session 2) — Phases 0–3 built; prod release and 2b remain
>
> **Shipped.** core `beta.590` (`e98d558`, the field + readers) and `beta.591` (`837733e`, credit-note
> `path_invoice_item` seed fix). Plugin `cfs-skills` 1.40.0 (Phase 1b). api-cloudrun `e2dfa92d` (pin) +
> `65b0bed3` (Phase 2) are on local `main`, riding a peer's push. ⚠️ Confirm with
> that `api-cloudrun/src/lib/invoiceOrderLineClaims.ts` is on `origin/main`. manager `a786b783` (pin `beta.591`)
> + `fe574d7d` (Phase 3) are pushed to `main` (preview).
>
> **Phase 3 (manager), as built.** `withOrderLinePointers` (`manager/src/utils/invoiceDrop.ts`) recomputes paths
> after a move and stamps the moved ROOT line from where it came from (`createReorderable`'s `onReorder` now also
> passes the original array; `splitInvoiceItem` maps each clone to its source). It keeps a chained move's
> original X, clears the pointer on a move back, and strips it from components. Every pointer is filtered through core's
> `orderLineClaimIssues`, the check the API 400s on. So a line the order lacks (custom, substitute) moves with
> no pointer, and with the order not cached (`peekOrderItems`, no listener) a NEW pointer is dropped. The diff's
> `moved` entry renders in `DiffRow`: "Moved here · bills its line on Order #N" at the row, "Billed from another
> group on Invoice #N" at X, plus the row's terms. manager#472's realign is not built yet; it should offer
> "move back" (clear the pointer) for a `moved` entry instead of delete + re-add. Noted on that issue.
>
> **Phase 0 facts that still matter.** The uniqueness 400 is real (`validateInvoiceItemUniqueness` on every
> invoice write). Fulfillments have no regrouping UI and stay out of scope.
>
> **Phase 1/2 departures from the design below (all still current):** the key is in `INVOICE_ROW_POINTER_FIELDS`,
> NOT `INVOICE_ONLY_ITEM_FIELDS` (carry-forward keys on uid, so resync drops pointers like every override). One reader:
> `orderLineClaims`. D3 lives in core as `orderLineClaimIssues`; an unchanged stored pointer is grandfathered. Diff
> kind `moved`. `.meta({ seed: false })`. api-cloudrun clears self-pointers and 400s on core's issues
> (`api-cloudrun/src/lib/invoiceOrderLineClaims.ts`).
>
> 🔴 **Release order, which is the next step.** api-cloudrun's release PR (pinned ≥ `beta.590`) must reach PROD
> before manager's next release PR is merged. The stored line is `z.strictObject`, so an older prod API 400s every
> drop that stamps a pointer. Arm 2 of `requires-manager` checks the other direction and will NOT catch this.
> Merge the API release first.
>
> **Phase 2b (backfill), still open.** Preconditions: the API prod release above; no Xero re-push
> (`invoiceXeroProjection` has a fixed field set, ✅ settled); hold `version` and pause the invoice consumer queues;
> ⚠️ **owner decision still open:** do frozen (settled/paid/void) invoices get the pointer? Derive the prod/dev
> candidate count (Q3's predicate) in the dry-run, then confirm the coverage audit's "extra invoice lines" drops by the
> stamped count. Proof of Phase 2 in prod ("coverage audit still 0 unaligned") also waits on the release.

## START HERE

An operator can drag an invoice LINE into a different group or destination **inside its own order block**
(manager's `planInvoiceDrop` allows it; cross-block drops are already blocked). Its path changes, so it
stops matching order line X: X reads uninvoiced, "invoice remaining" re-offers X, and manager#472's
realign would delete and re-add the line, losing its overrides. This doc decides how a line records
"I am order line X, moved". D1–D3 and Phase 3 are built as amended in the status block. Next: release the API to
prod BEFORE manager's next release, then Phase 2b.

## The problem in one example

Order: `D1 / Grip / C-stand ×4` (order path `[D1, Grip, cstand]`).
Invoice: operator drags the C-stand line into `D1 / Misc` → stored path `[O, D1, Misc, cstand]`.

- `invoicedByPath` keys it at `[D1, Misc, cstand]`, which the order lacks → order line reads 0 invoiced.
- Sync: absent from both orders ⇒ invoice-authored ⇒ kept verbatim. Good — but an order edit of X
  (quantity 4→6, name fix) never reaches it, and an order REMOVAL of X never removes it.
- Diff: one `not_on_source` (the moved line) + one uninvoiced `quantity` on X. Two findings for one move.

## Decisions (proposed)

### D1 — Do NOT reuse `substituted_for`. Four behaviours would fork on a "same product?" test.

Read against `utils/substitutions.ts` and the sync's substitution arm (by reading, not executed):

| behaviour | `substituted_for` does | a moved line needs |
|---|---|---|
| **placement** | substitute rows the order lacks are flushed *right after X's subtree* (`flushEntryRows`) | stay where the operator dropped it. Flushing a same-uid row next to X re-derives **X's own path** — the regroup silently undone |
| **quantity** | entry `quantity` is a fixed stand-in count; order edits to X don't move it (D2 offset) | follow X's quantity through the three-way merge, like any synced line |
| **labels** | Y is a different product, so X's name/description never flow to Y | X's label corrections should flow (same product) |
| **diff** | `substituted` kind | "moved", not "substituted X with X" |

Every reader would branch on `product(row) === product(X)`, which is two fields sharing a name.
`substituted_for` also allows several entries plus merges into an existing row (D2). A moved line is
exactly one X and never a merge: manager's drop doesn't merge, and a drop into a group that already holds
the product fails `validateItemUniqueness` (⚠️ verify that 400 path in Phase 0).

**What IS reused:** the re-pointing mechanics (`mapPathsAcrossRebuild` → `toPath`, as
`substitutionResync` and `repointExchangedFor` do) and the element-wise path helpers.

### D2 — A new single-path field on the invoice line, stamped on the ROOT row only

Field `path_order_item: string[]` (Q4) — the invoice-grain twin of `path_invoice_item` in
`schemas/credit-note.ts`. Order-relative (no `O` prefix), `z.array(ItemUid).min(1).optional()`.
Meaning: *this row is order line X, at a different position.*

- **One path, no quantity.** The row IS X. Quantity, labels and price merge three-way against X.
- **Root only.** A moved kit carries its components. Component `[...P, c]` corresponds to `[...X, c]` by
  suffix, so no D1-style stamping on every row. ⚠️ If an invoice can edit a kit's components
  independently of the order, a suffix that the order lacks is an ordinary invoice-authored row. Confirm.
- **Chained moves keep the original X**: the stamp is `source.path_order_item ?? relPath(source)`.
- **Moving back clears it**: if the pointer equals the row's own order-relative path, the writer deletes it.
- Propagation tag: an invoice-only key → added to `INVOICE_ONLY_ITEM_FIELDS`. Not a shared field, so
  `classifySharedFields` never sees it.
- PII: none (`.meta({ pii: "none" })` if the PII test asks). Display column: no.

### D3 — Valid only inside an order block, naming a line of THAT order (the core#127 constraint)

Server-validated in api-cloudrun at write time:

1. The row sits under an `order` divider `O` (a line outside any order block, which includes every line
   of a standalone invoice, may not carry one) → 400.
2. X is a line on order `O` at write time → 400 otherwise. Once stored, an order removal of X is
   handled by the sync, not by refusal (Q2).
3. **Multiple claims are ALLOWED (Q1).** Several rows may claim one X, and X may also stay at its own
   path. Surfaced, never refused: coverage sums every claim, so an over-bill reads as a `quantity` diff
   entry with `invoiced > ordered`. This is also what a legitimate SPLIT looks like (X ×4 billed as 2 under
   Grip + 2 under Misc); manager's invoice `splitInvoiceItem` may produce that shape today (Phase 0).
   Known cost: the three-way merge runs per row, so a row still EQUAL to X follows X's edits — two
   full-quantity copies both follow a 4→6 edit and bill 12. That case is already a visible over-bill; a
   split row (quantity ≠ X's) reads as overridden and does not follow. Manager#472's "move back" must
   handle a second row landing on X's path (uniqueness 400).

## Readers (what changes)

| reader | change |
|---|---|
| `invoicedByPath` / `computeOrderInvoiceCoverage` | credit X (and X's components by suffix) with each claiming row's quantity, the way `substitutionCredit` credits a substituted X |
| `syncOrderToInvoiceSelective` | treat the row as X: `mergeLine(prevX, nextX, row)` **in place** (keep position and path), once per claiming row; re-point when X moves (`moved.toPath`); X removed by the order → row removed unless overridden, and **if kept, the pointer is dropped** (Q2) so it becomes plainly invoice-authored; X is not re-projected because a row claims it (left-out rule already covers this) |
| `buildRemainingInvoice` | reads coverage, so it stops re-offering X with no change of its own (verify) |
| `computeDocumentDiffs` | compare the row against X; emit one entry of a new kind (working name `moved`) instead of `not_on_source` + uninvoiced `quantity`. ⚠️ `DocumentDiffEntry["kind"]` is a closed vocabulary — survey before the first beta |
| manager `planInvoiceDrop` / items store | stamp on drop (D2), and on `splitInvoiceItem` if Phase 0 says so; manager#472's realign offers "move back" for a `moved` entry instead of delete+re-add |

## Not in scope

- **Fulfillments.** The analogue core#125 named (`replaces`, now `exchanged_for`) is a different relation:
  units taken back mid-rental, not a row's identity. Fulfillment rows keep order paths, so nothing to do
  unless the fulfillment UI allows regrouping (Phase 0; file an issue if it does).
- **Lost/damaged and cleaning lines** (`uid_out_of_service`). They bill no order line by design.
- **The core#124 Phase 1 edge**: an order MOVING a group that holds an invoice-authored line leaves a
  stale group copy on the invoice. That line is invoice-authored, not moved; this pointer does not fix
  it. File its own issue if it still reproduces.

## Rulings (owner, 2026-10-03)

- **Q1 — allow and surface** multiple claims (D3.3). Matches "surface, never resolve".
- **Q2 — drop the pointer** when X leaves the order and the row survives as an override.
- **Q3 — backfill**, only where X is unambiguous: exactly one line on that order with the row's product
  uid, under the same order block, not already carried at its own path. Everything else is reported, not
  guessed. Script in api-cloudrun, `--dry-run` first, both envs. ⚠️ Before running: confirm adding a key to
  a stored invoice line does not trigger a Xero re-push (`api-cloudrun/src/services/xeroInvoicePush.ts`) —
  widening a line's key set re-pushes on an `isEqual` diff elsewhere (core CLAUDE.md, `assembleLinePrice`);
  and decide whether frozen (settled/paid/void) invoices get the pointer (metadata, but it changes their
  coverage reading). api-cloudrun#1189 (name the unaligned invoices) helps the dry-run report.
- **Q4 — `path_order_item`.** Prefix form = a reference to a row in another document
  (`path_invoice_item`, `uid_*`); the suffix form (`organization_path`, `owner_path`) is the path OF the
  thing named. Rejected: `order_path` (reads as the order's own path), `path_order` (names the document,
  which `uid_order` already does), `moved_from` (false after a re-point), `stands_for` (the substitution
  confusion D1 rejects).

## Remaining — phases

**Phase 0 — confirm the assumptions (read-only).** Launch from `~/cfs/core`.
- Drop into a group already holding the product → 400 from `validateItemUniqueness`. Proof: read
  `validateBeforeWrite`'s invoice path in api-cloudrun, or an integration step.
- `splitInvoiceItem` (manager `src/stores/invoices.ts`): does the split copy land at a path the order lacks?
  If yes, it is the same gap and Phase 3 stamps there too.
- Fulfillment UI regrouping: `grep -rn "planFulfillmentDrop\|moveBefore" manager/src`.
- Prod count of candidate lines (absent from both orders, under an order block, same-uid order line in
  that order not on the invoice): `api-cloudrun/scripts/audit-order-invoice-coverage.ts`'s "251 extra
  invoice lines" is the superset.

**Phase 1 — core** (schema + readers + tests → one beta). Skills: cfs-order-projections, cfs-items,
cfs-release-order. **Read:** `core/CLAUDE.md` (`git -C core show origin/beta:CLAUDE.md`) — the parts that
bite here: § *Before you cut the first beta* (survey `DocumentDiffEntry["kind"]` and write the first
consumer before publishing), § *Schema structure* (`schemas/mod.ts` lists exports by hand), § *PII
classification* and § *Display columns* (per-field duties on the new key), § *Making a field REQUIRED* step 4
(interface and schema optionality must agree), and the `feat` commit type (a new field is a minor bump). Proof: `deno task test`, `deno task check:declarations`, barrel check for any new value
export (`deno eval 'import { X } from "./src/schemas/mod.ts"; console.log(typeof X)'`), plus tests:
- sync: a moved line follows X's quantity and label edits, stays at its position, re-points when X's group
  moves, goes when X is removed (not overridden), keeps and loses its pointer when X is removed (overridden);
- sync: two rows claiming X — a split pair does not follow a quantity edit; an equal copy does;
- coverage: X reads invoiced (summed across claims); "remaining" does not re-offer it;
- diff: one `moved` entry per claiming row, and a `quantity` entry only when the claims' sum ≠ ordered.

**Phase 1b — skill docs, same session as the Phase 1 beta** (`claude-plugins` repo,
`plugins/cfs-skills/skills/cfs-order-projections/SKILL.md`; bump the plugin version per that repo's rules):
- § *The difference is SURFACED by one author*: "Seven kinds" → "Eight kinds", add `moved` to the
  enumeration with one line on what it reports (a row whose `path_order_item` names X, compared against X).
- § *What a projection holds that the order does not is an override POLICY*: add `path_order_item` beside
  `substituted_for` — the record that a line IS order line X at another position, and why it is not a
  substitution (D1).
- § *Per-row outcomes*: add a "Moved" row (merged in place against X; pointer dropped if X is removed and
  the row survives).
Proof: `grep -c "moved" plugins/cfs-skills/skills/cfs-order-projections/SKILL.md` ≥ 3, and
`grep -n "Seven kinds"` returns nothing.

**Phase 2 — api-cloudrun.** D3.1 and D3.2 validation in the invoice write path; pin bump. Proof: one
integration step per rule (outside an order block → 400; X not on the order → 400; two claims → 200);
prod coverage audit still 0 unaligned.

**Phase 2b — backfill (Q3).** api-cloudrun script, dry-run report (count per env, ambiguous rows listed),
then apply. Proof: coverage audit's "extra invoice lines" drops by exactly the stamped count; 0 unaligned.

**Phase 3 — manager.** Stamp on drop (and split, per Phase 0), clear on move-back; diff surface;
manager#472's realign uses `moved`. Pin bump. Proof: unit tests on `planInvoiceDrop` output carrying the
pointer.

Release order: core beta → api-cloudrun (validator) → manager (writer). The writer must not ship before the
validator accepts the field (`z.strictObject` on the stored line).

## Context recommendation
**Context:** CLEAR CONTEXT — everything learned is in the status block. Phase 2b launches from `~/cfs/api-cloudrun` (skills: cfs-order-projections, cfs-items, cfs-release-order; read `api-cloudrun/.claude/skills/cfs-invoices/SKILL.md` and the queueing/bulk-write rule in `api-cloudrun/CLAUDE.md`).
**Execute with:** opus — a backfill on live invoices where a wrong pointer moves billed coverage.
