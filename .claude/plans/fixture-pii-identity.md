# core#91 + #92 + #93 — one campaign. Everything is SHIPPED; one PR is awaiting merge.

> **Compacted 2026-09-09.** This doc previously carried two stacked status blocks. It now reads as
> one current statement, per the plan-doc convention. **Delete it in the commit that closes
> core#91/#92/#93** — only the two lines under *What is left* survive it, and both are issues.

## Where this stands

| | state |
|---|---|
| `core` | **beta.387 published.** beta.385 the masker + walker `siblings`, beta.386 `MovementSessionItem.owner_path`, **beta.387 the oracle fix** (below). |
| `api-cloudrun` | **`v0.244.0` deployed to PROD and DEV** (revision `api-cloudrun-00360-l2w`, 2026-09-09 05:01 UTC), pinning beta.386. |
| prod data | 2 documents repaired, verified 0 remaining. |
| `manager` | `14f3cb9` on `main`, deployed. |
| `templates` | **PR #292 open** — the whole fixture corpus. `deno task lint:fixtures` **14 findings → 0**. |

🔴 **The hard serialization point (api-cloudrun#838) is PASSED and was verified against the running
revision, not assumed** — a capture is sanitized by the DEPLOYED core, and prod serves beta.386.

## What is left

1. **PR #292 merges** (auto-merges ~1 min after CI is green — there is no review window, which is why
   the goldens were blessed and eyeballed before it was opened). Then close **core#91, #92, #93**
   and delete this doc.
2. **`api-cloudrun` + `manager` pin bumps to beta.387.** Not urgent and not blocking: .387 fixes the
   fixture-lint ORACLE, so until it lands the api's *advisory* capture lint keeps reporting a
   `scope.name` false positive on the two `pick-sheets` families. Renovate normally does these.
   ⚠️ At the time of writing `api-cloudrun/main` is `[ahead 1]` with a peer session's commit, so a
   push there needs the owner's say-so first.
3. **templates#290** — open, and it should land independently of #292.

## The two findings worth carrying out of this campaign

### 🔴 A fold captured from LIVE OPEN WORK has a stable ADDRESS and an unstable DOCUMENT

`pick-sheets` and `aging-reports` are folds over whatever is open *today*. In the single day between
the first capture and the re-capture:

- `packing-list/multi-order-delivery` — an order went `out`, so an organization-scoped delivery sheet
  returned **one** order. A fixture named *multi-order* covering one order **renders fine and covers
  nothing**; nothing goes red. Re-pointed to an organization with three orders still to deliver.
- `packing-list/single-order-collection` — a **second** order joined its organization's collection
  sheet. Re-pointed to the degenerate `order:<uid>` scope (api-cloudrun#821).
- `statement/open-item-floor` — two invoices were paid in full, taking the account from three open
  invoices to one. **Kept**: the `open_item` population rule dropping them *is the arm working*.

⭐ **An `order:`-scoped address is the only shape that cannot decay**, because it names one order by
construction. Two fixtures now use it deliberately. ⚠️ Its CONTENTS can still move — a split
breakdown is live custody — so check the property before blessing.

⭐ **The general form: a fixture whose source is a query is dated; a fixture whose source is a
document is not.** A movement session folds from an append-only journal and re-captures identically.

### 🔴 An oracle that drops an argument the masker reads (core beta.387)

`utils/template-lint.ts` called `maskVerdict(value, fieldPath)` and `categoryForField(fieldPath)`
with **no `siblings`**, while core#91 had given `scope.name` a sibling-discriminated route. So every
discriminated leaf fell through to `text` — whose only legal value is the filler — and the masker
began minting values its own oracle called leaks. **3 of the 4 `pick-sheets` fixtures could not pass
their own gate while being correctly masked.**

`MaskedLeaf.siblings` was added in the same beta carrying the exact warning — *"an oracle that drops
it judges `scope.name` against the wrong category"* — and this was the one call site that dropped it.

⭐ **It failed in the SAFE direction, which is why it shipped green.** `text` accepts strictly less
than any other category, so the omission could only ever over-report; and before core#91 every
`scope.name` **was** the filler, so the corpus agreed with the broken oracle by construction. **A
guard that can only over-report still blocks, and it goes wrong exactly when the thing it guards
starts working.**

## Smaller things this turned up, all filed

- **templates#290 / #291** — `aging-report`'s sidecar `render.filename` still read the deleted
  `scope.name`, so scoped AR Aging PDFs download as `AR Aging - undefined - <date>.pdf` **in prod**.
  #290 repairs it (its own PR — `render` has one writer that cannot target a feature branch); #291 is
  the missing guard, since no gate reads a sidecar Eta expression as code.
- **templates#286, #287, #288, #289** and **core#99** — filed earlier in the campaign, all still open.
- ⚠️ **`templates/capture-floor.json` `min_core` stays at beta.386, deliberately.** That floor asks what a
  capture STORES; .387 repairs an oracle, not a masker. `lint:capture-floor` measures 194 tagged
  leaves at both versions.

## Verified by looking, not by a gate

None of what this campaign fixes is visible to any check — every layer was green while the corpus was
wrong. What the rendered pages now show:

- `aging-report/all-accounts`: **16 accounts under 16 DISTINCT labels**, matrix and detail naming each
  account identically. Before core#91: 14 accounts under 10 labels, two rows both reading
  `Foxglove Films LLC` at $8,350.00 and $49.92 — which looked exactly like api-cloudrun#923 and was
  not it.
- `aging-report/nothing-outstanding`: a real three-node chain where the scope line read
  `Sample text for name..........`.
- `pick-sheet/multi-order-destination`: **0 same-uid endpoint pairs disagreeing** on their masked
  address, measured over the fixture, where it was 6 of 6.

## Context recommendation

**Clear.** What remains is three bounded items, each verifiable from GitHub in one command — the merge
state of #292, two pin bumps, and the issue closures. None of it needs this session's context, and
the two findings above are the only things worth carrying forward.
