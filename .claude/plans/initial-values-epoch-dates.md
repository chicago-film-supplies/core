# core#107 — `getInitialValues` stops seeding dates with the EPOCH

> Status 2026-09-13: **the `core` change, its guard and the fixture verification are
> DONE and green.** What remains is the consumer pin wave (§ Release order). Delete
> this doc in the commit that lands the last pin.

## What this fixes

`resolveField`'s `case "string"` seeded any datetime/date-format field with
`"1970-01-01T00:00:00Z"` / `"1970-01-01"`. For a `chicagoStartOfDay()` field that
canonicalizes to `1969-12-31T00:00:00.000-06:00`, and **because the epoch is not
nullish it defeats every `input.x ?? <server default>` on the writer side.** That is
how 8 prod invoices reached `due_date: 1969-12-31`, 7 of them AUTHORISED in the live
Xero AR ledger at ~57 years overdue.

Both data repairs and the writer mitigation landed earlier (manager `b5747a3` /
`manager-v26.0.4` strips `date` + `due_date` from the invoice seed; api-cloudrun
`fa9052fb` repaired all 8 documents and pushed 7 to Xero). This is the **class fix**.

The fix is two returns: `SKIP` instead of an epoch, in both format branches
(`src/schemas/initial.ts`). An absent key is what lets the writer's `??` fire.

## Step 1 — the enumeration (re-measured 2026-09-13 against `core` @ `beta.437`)

**222 object schemas walked, 22 seeded an epoch, 26 fields.** The probe is now the
guard arm in `tests/initial.test.ts` (§ Step 5) rather than a throwaway — re-run it
with `deno test tests/initial.test.ts`.

| schema | field(s) |
|---|---|
| `ActivitySchema` | `at` |
| `ClientLogEntrySchema` | `ts` |
| `CreateInvoiceInput` | `date`, `due_date` |
| `CreateProductInput` | `transaction.date` |
| `CreateRecurrenceInput` | `active_from` |
| `CreateStoreTransferInput` | `date` |
| `CreateTaxInput` | `applied_from` |
| `CreateTransactionInput` | `date` |
| `CreditNoteSchema` | `date` |
| `HolidayDatesSchema` | `date` |
| `InvoiceSchema` | `date`, `due_date` |
| `MovementSchema` | `date` |
| `MovementSessionSchema` | `date` |
| `RecurrenceSchema` | `active_from` |
| `ReverseTransactionInput` | `date` |
| `SettlementSchema` | `date` |
| `SupersedeTaxInput` | `applied_from` |
| `TaxSchema` | `applied_from` |
| `UpdateInvoiceInput` | `date` |
| `UpdateRecurrenceInput` | `active_from` |
| `UpdateTaxInput` | `applied_from` |
| `XeroBudgetSchema` | `observed_at`, `resets_at` |

🔴 **`nullable` returns `null` BEFORE recursing, so a `.nullable()` date never
reaches the string branch at all.** That is the fact that bounds this to 22.

🔴 **The `format === "date"` branch is LIVE, and in more places than the draft plan
knew.** It named only `HolidayDatesSchema.date`. Measured: `RecurrenceSchema`,
`CreateRecurrenceInput` and `UpdateRecurrenceInput` all seed `active_from` as
`"1970-01-01"` too — the draft's table implied that field was a datetime. Both
branches needed the same treatment; neither SKIP was free.

**The decision is UNIFORM SKIP across all 22 rows**, and the three measurements that
decide it hold for every one:

1. **No consumer anywhere reads an affected key.** The only `getInitialValues` call
   sites outside `core/tests/` are four `manager` stores (below) — every other
   apparent hit in `manager/src`, `api-cloudrun/src` and `core/src` is a **prose
   mention inside a comment**, verified 2026-09-13. In particular
   `manager/src/stores/transactions.ts:65` and `api-cloudrun/src/services/invoices.ts:800`
   look like call sites in a grep and are not.
2. **`draftSeed` already deletes top-level `null` keys**
   (`manager/src/primitives/createEntityCache.ts:59`), so for a draft **absent and
   null are the same state**. SKIP is behaviourally identical to what every
   `.nullable()` date already does.
3. **Both live forms author their own date** — `TaxManager.tsx:435` uses
   `todayChicago()`, `MakeRecurringModal.tsx:55` uses `todayIso()`. Credit notes have
   no create path.

**The four manager-facing rows**, all `initialValues`-only:

| schema | field(s) | store | consumer |
|---|---|---|---|
| `TaxSchema` | `applied_from` | `src/stores/taxes.ts:12` | `initialValues` only |
| `InvoiceSchema` | `date`, `due_date` | `src/stores/invoices.ts:23` | **already deleted** at `:56-57` |
| `RecurrenceSchema` | `active_from` | `src/stores/recurrences.ts:28` | `initialValues` only |
| `CreditNoteSchema` | `date` | `src/stores/creditNotes.ts:8` | `initialValues` only |

⭐ **Two measured negatives, so nobody re-derives them:**

- **core#95's `fix(schemas)!: require …` wave added ZERO manager-facing epoch seeds.**
  The obvious risk did not materialize — the fields it tightened were nullable or
  non-date.
- ⚠️ **The `size:campaign` comment on core#107 is FALSIFIED on one point.** It says
  `manager/src/stores/orders.ts:40-54` reads seeded date keys and that under SKIP
  each becomes `null` instead of the epoch. Measured: every field on `OrderSchema`
  and `OrderDocDates` is `chicagoInstant().nullable()`, so `orderDocDatesInitial.*`
  is **already `null`** and the `?? null` is already a no-op. **SKIP changes nothing
  there.** `OrganizationSchema` is clean too — its required `activity_at` is a
  `FirestoreTimestamp` (`z.custom`), which already SKIPs.

## Steps 3–5 — done

- **`src/schemas/initial.ts`** — both format branches return `SKIP`. The `pipe` and
  `getInitialValues` docblocks are corrected: the "three separate holes" list gains a
  fourth, and `pipe`'s note no longer claims dates inherit an ISO-datetime initial.
- **`tests/initial.test.ts`** — the assertion pinning `applied_from` to the epoch is
  gone from the *"defaults are used when present"* arm (where it never belonged:
  `applied_from` has no default). Replaced by two arms — a named-witness arm covering
  **both** format branches, and the sweep.
- **The sweep** walks every object schema `src/schemas/mod.ts` exports and fails on any epoch
  value at any depth. It carries a **non-vacuity floor** (`walked > 150`) because a
  walk that resolved nothing would otherwise pass silently.
  ✅ **Verified RED without the fix** — reverting the two `SKIP`s fails both arms.

⭐ **Step 4 turned out to be a no-op, and that is worth recording rather than
re-deriving.** The draft plan predicted `tests/tax.test.ts:6`,
`tests/transaction.test.ts:41` and `tests/invoice.test.ts:9` would each need their
date key added. None did: all three already state their dates explicitly
(`tax.test.ts:19`, `transaction.test.ts:93`, `invoice.test.ts:56`), and
`InvoiceSchema.due_date` is `.optional()` so its absence is legal. **`deno task test`
is green at 2354 passed / 0 failed with no fixture edit at all**, plus `deno task
check` and `deno task lint`.

⚠️ **api-cloudrun's integration fixtures are unaffected** — re-verified 2026-09-13.
Both `CreateProductInput` consumers (`tests/integration/products/products.test.ts:21`
and `tests/integration/products/componentAssembly.test.ts:54`) already
`delete productBase.transaction`, which is the only affected sub-block.

This discharges the first half of **manager#435** (a seed that materializes a *wrong*
value). The second half — a seed that *hides a missing* field, because a payload
seeded from the schema it is testing cannot falsify that schema — stays open.

## Step 6 — release order

Measured 2026-09-13, after the `documentDiff` wave (manager#467 Phase C) landed:
newest published beta `.437`, `manager` `.437`, `api-cloudrun` `.435`, `templates`
`.433`.

1. Commit on `core`'s **`beta`** branch (workspace rule — not a feature branch). The
   push publishes the JSR beta. Keep `core/deno.json` `version` at `"0.0.0"`.
2. Bump **manager** (`package.json`, npm alias `@jsr/cfs__core`), push, **merge its
   release PR and wait for the release to cut**.
3. Bump **api-cloudrun**, push, merge its release PR.
4. Open the **templates** pin PR.

🔴 **Step 2 must complete before step 3** — `api-cloudrun`'s `requires-manager.yaml`
measures manager's latest *published release*, not its `main`.

🔴 **Bump by `sed` over the version string, never by a remembered count**, then read
the subpath names back out of each file.

⚠️ Nothing here changes a stored field or a `z.strictObject`, so there is no
deploy-before-backfill ordering beyond the release train itself.

## Verification

- ✅ `deno task test` / `check` / `lint` green in `core`; the sweep shown to fail when
  the two `SKIP` returns are reverted.
- ✅ The probe reports **zero** epoch seeds across all 222 schemas.
- ⬜ `manager`: `npm run build` + `vitest run`, and confirm
  `tests/stores/invoices-seed-dates.test.ts` still passes — its own sweep arm fails
  on any epoch-shaped value, so it is an independent check on this change.
- ⬜ Exercise the two live forms in the manager preview: create a tax version
  (`TaxManager`) and make a card recurring (`MakeRecurringModal`), confirming each
  still submits a real date. They are the only surfaces where an affected field
  reaches a form.
- ⬜ After the wave, confirm all three consumers report the same beta.

## Issues

- **core#107** — closes when the core fix, the guard and the pin wave have all
  landed. Post the re-measurement as a comment so the `stores/orders.ts` claim is not
  acted on.
- **manager#435** — comment naming which half this discharges; do not close.
- **api-cloudrun** — delete `scripts/repair-invoice-epoch-due-dates.ts` (an applied
  one-shot) in the same PR as the api-cloudrun pin bump, and drop its catalogue entry.
- Leave the **onset** as "first observed 2026-09-11" — the 189/3/8 gap table is the
  constraint, no cause was reproduced, and the fix does not depend on it.

## Context recommendation

**Context:** CONTINUE if you are mid-wave (the pin bumps are mechanical and the
ordering above is the whole of it); CLEAR if picking this up cold after the wave, in
which case only the Issues section is left.
