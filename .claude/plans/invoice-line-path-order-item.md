# Invoice line → order line pointer: `path_order_item` (core#125)

**Date:** 2026-10-03 • **Repo:** core (+ api-cloudrun, manager) • **Status:** planned (design draft — D1–D3 proposed; Q1–Q3 ruled 2026-10-03, Q4 ruled)
**Origin:** core#125 (core#124 Phase 4). Sequenced ahead of core#127 (standalone invoices) — see core#127 comment of 2026-10-03.
**Related:** core#124, core#127, manager#472, api-cloudrun#538 §2, `core/src/utils/substitutions.ts`, `core/src/utils/invoices.ts` (`syncOrderToInvoiceSelective`), `manager/src/utils/invoiceDrop.ts`

## START HERE

An operator can drag an invoice LINE into a different group or destination **inside its own order block**
(manager's `planInvoiceDrop` allows it; cross-block drops are already blocked). Its path changes, so it
stops matching order line X: X reads uninvoiced, "invoice remaining" re-offers X, and manager#472's
realign would delete and re-add the line, losing its overrides. This doc decides how a line records
"I am order line X, moved". Nothing is built. Q1–Q4 ruled 2026-10-03. Next step: confirm D1–D3, then run Phase 0
(read-only checks) and start Phase 1.

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

Field `path_order_item: string[]` (Q4 ruled 2026-10-03 — the invoice-grain twin of `path_invoice_item` in `schemas/credit-note.ts`), order-relative
(no `O` prefix), `.optional()`, `.min(1)` when present. Meaning: *this row is order line X, at a
different position.*

- **One path, no quantity.** The row IS X. Quantity, labels and price merge three-way against X.
- **Root only.** A moved kit carries its components. Component `[...P, c]` corresponds to `[...X, c]` by
  suffix, so no D1-style stamping on every row. ⚠️ If an invoice can edit a kit's components
  independently of the order, a suffix that the order lacks is an ordinary invoice-authored row. Confirm.
- **Chained moves keep the original X**: the stamp is `source.path_order_item ?? relPath(source)`.
- **Moving back clears it**: if the pointer equals the row's own order-relative path, the writer deletes it.
- Propagation tag: an invoice-only key → added to `INVOICE_ONLY_ITEM_FIELDS`. Not a shared field, so
  `classifySharedFields` never sees it.

### D3 — Valid only inside an order block, naming a line of THAT order (the core#127 constraint)

Server-validated in api-cloudrun at write time:

1. The row sits under an `order` divider `O` (a line outside any order block, which includes every line
   of a standalone invoice, may not carry one).
2. X is a line on order `O` **now** (dangling pointers: see open question Q2).
3. ~~At most one row per invoice claims a given X.~~ **Ruled (Q1, 2026-10-03): ALLOWED.** Several rows may
   claim one X, and X may also stay at its own path. The difference is surfaced, never refused: coverage
   sums every claim, so an over-bill reads as a `quantity` diff entry with `invoiced > ordered`. This is also
   what a legitimate SPLIT looks like (X ×4 billed as 2 under Grip + 2 under Misc), and manager's invoice
   `splitInvoiceItem` produces that shape today (⚠️ check in Phase 0 whether a split line is the same gap,
   and if so, stamp there too).
   Known cost: the three-way merge runs per row, so a row still EQUAL to X follows X's edits. Two full-quantity
   copies both follow a 4→6 edit and bill 12. That case is already a visible over-bill, and a split row
   (quantity ≠ X's) reads as overridden and does not follow. Manager#472's "move back" must handle a second
   row landing on X's path (uniqueness 400).

## Readers (what changes)

| reader | change |
|---|---|
| `invoicedByPath` / `computeOrderInvoiceCoverage` | credit X (and X's components by suffix) with the row's quantity, the same way `substitutionCredit` credits a substituted X |
| `syncOrderToInvoiceSelective` | treat the row as X: `mergeLine(prevX, nextX, row)` **in place** (keep its position and path), once per claiming row; re-point the pointer when X moves (`moved.toPath`); X removed by the order → removed unless overridden, and **if kept, the pointer is dropped** (Q2 ruled) so it becomes plainly invoice-authored; X never re-projected because a row claims it (left-out rule already covers this) |
| `buildRemainingInvoice` | reads coverage, so it stops re-offering X with no change of its own (verify) |
| `computeDocumentDiffs` | compare the row against X; emit one entry of a new kind (working name `moved`) instead of `not_on_source` + uninvoiced `quantity`. ⚠️ `DocumentDiffEntry["kind"]` is a closed vocabulary — survey it before the first beta |
| manager `planInvoiceDrop` / items store | stamp on drop (D2); manager#472's realign offers "move back" for a `moved` entry instead of delete+re-add |

## Not in scope

- **Fulfillments.** The analogue core#125 named (`replaces`, now `exchanged_for`) is a different relation:
  units taken back mid-rental, not a row's identity. Fulfillment rows keep order paths, so nothing to do
  unless the fulfillment UI allows regrouping (⚠️ check in Phase 0, and if it does, file an issue).
- **Lost/damaged and cleaning lines** (`uid_out_of_service`). They bill no order line by design.
- **The core#124 Phase 1 edge**: an order MOVING a group that holds an invoice-authored line leaves a
  stale group copy on the invoice. That line is invoice-authored, not moved, so this pointer does not fix
  it. Re-file as its own issue if it still reproduces.

## Open questions (owner)

- **Q1 — RULED: allow and surface** (see D3.3).
- **Q2 — RULED: drop the pointer** when X leaves the order and the row survives as an override.
- **Q3 — RULED: backfill**, only where X is unambiguous: exactly one line on that order with the row's
  product uid, under the same order block, not already carried at its own path. Everything else is reported,
  not guessed. Script in api-cloudrun, `--dry-run` first, both envs. ⚠️ Before running, confirm that adding
  a key to a stored invoice line does not trigger a Xero re-push (`api-cloudrun/src/services/xeroInvoicePush.ts`). Widening a line's
  key set re-pushes on an `isEqual` diff elsewhere (core CLAUDE.md, `assembleLinePrice`). Also decide whether
  frozen (settled/paid/void) invoices get the pointer. It is metadata, but it changes their coverage reading.
- **Q4 — RULED: `path_order_item`.** Prefix form = a reference to a row in another document (`path_invoice_item`, `uid_*`); the suffix form (`organization_path`, `owner_path`) means the path OF the thing named. Rejected: `order_path` (reads as the order's own path), `path_order` (names the document, which `uid_order` already does), `moved_from` (false after a re-point), `stands_for` (the substitution confusion D1 rejects).

## Remaining — phases

**Phase 0 — confirm the assumptions (core, read-only).** Launch from `~/cfs/core`.
- Drop into a group already holding the product → 400 from `validateItemUniqueness`. Proof: an api-cloudrun
  integration step, or read `validateBeforeWrite`'s invoice path.
- Fulfillment UI regrouping: `grep -rn "planFulfillmentDrop\|moveBefore" manager/src`.
- Prod count of lines that would carry a pointer today (lines absent from both orders, under an order
  block, with a same-uid order line in the same order that is not on the invoice):
  `api-cloudrun/scripts/audit-order-invoice-coverage.ts`'s "251 extra invoice lines" is the superset.

**Phase 1 — core** (schema + readers + tests → one beta). Skills: cfs-order-projections, cfs-items,
cfs-release-order. Proof: `deno task test`, `deno task check:declarations`, barrel check for any new export
(`deno eval 'import { X } from "./src/schemas/mod.ts"; console.log(typeof X)'`), plus tests:
- sync: a moved line follows X's quantity and label edits, stays at its position, re-points when X's group
  moves, goes when X is removed (not overridden);
- coverage: X reads invoiced; "remaining" does not re-offer it;
- diff: one `moved` entry, nothing else;
- D3 rejections (outside an order block; X not on the order; double claim).

**Phase 2 — api-cloudrun.** D3 validation in the invoice write path; pin bump. Proof: integration step
per D3 rule; prod coverage audit unchanged (0 unaligned).

**Phase 2b — backfill (Q3).** api-cloudrun script, dry-run report (count per env, ambiguous rows listed),
then apply. Proof: coverage audit's "extra invoice lines" count drops by exactly the stamped count; 0 unaligned.

**Phase 3 — manager.** Stamp on drop and clear on move-back; diff surface; manager#472's realign uses
`moved`. Pin bump. Proof: unit tests on `planInvoiceDrop` output carrying the pointer.

Release order: core beta → api-cloudrun (validator) → manager (writer). The writer must not ship before the
validator accepts the field (`z.strictObject` on the stored line).

## Context recommendation
**Context:** CLEAR CONTEXT — Q1–Q4 are ruled; confirm D1–D3 with the owner, then execute Phase 0 → 1 from this doc alone.
**Execute with:** opus — the sync change is a merge-semantics edit where a wrong diff compiles and passes (it moves billed quantities on live invoices).
