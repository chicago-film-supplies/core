# CLAUDE.md

## Overview

The single shared CFS package, published to JSR as `@cfs/core`. Two namespaces with **no bare root export**: `@cfs/core/schemas[/*]` — Zod 4 schemas for Firestore + Typesense collections, programmatically enforceable propagation rules, and shared TS types (sources in `src/schemas/`); and `@cfs/core/utils/*` — pure helper functions for dates/invoices/orders/products/etc. (sources in `src/utils/`). Utils import schemas one-way via the relative `../schemas/mod.ts` barrel, so both ship in a single publish (no cross-package lockstep). Merged 2026-06 from the former `schemas-next`/`utilities-next` repos.

## Setup

- **Deno** runtime
- `deno task setup` — install dependencies and enable git hooks

## Commands

- `deno task check` — type-check (`deno check src/` — covers `src/schemas/` + `src/utils/`)
- `deno task lint` — lint (includes JSR `no-slow-types` validation)
- `deno task test` — run tests

## Publish
- git commit, git push to beta branch, gh action will trigger semantic release and publish

## Commit conventions

This repo uses [semantic-release](https://github.com/semantic-release/semantic-release) with the **Conventional Commits** preset. The commit message determines the version bump automatically.

### Format

```
<type>(<optional scope>): <description>

[optional body]

[optional footer(s)]
```

### Types

| Type | Version bump | When to use |
|------|-------------|-------------|
| `fix` | Patch (1.0.x) | Bug fixes |
| `feat` | Minor (1.x.0) | New schemas, fields, or features |
| `feat!` / `fix!` / `BREAKING CHANGE:` footer | Major (x.0.0) | Removing/renaming fields, changing validation rules, any change that breaks existing consumers |
| `chore` | No release | Tooling, CI, deps, docs |
| `refactor` | No release | Code restructuring with no behavior change |
| `test` | No release | Adding or updating tests |
| `docs` | No release | Documentation only |

### Scopes

Use the schema/module name as the scope when the change is limited to one area:

```
feat(contact): add middle_name field
fix(order): correct line_items default
feat!: remove deprecated AddressV1 schema
```

### Breaking changes

Any commit that removes a field, renames an export, or changes validation in a way that could break consumers **must** be marked as breaking — either with `!` after the type or a `BREAKING CHANGE:` footer.

## Conventions

### Money arithmetic — never a float factor

**Stored money is integer cents, and the rule is closure under that quantum.** An operation is *closed* when its result is representable at the quantum — then no rounding decision exists and any correctly-quantized type is exact. It is *not closed* when a rounding decision is forced, and the only question is whether that decision is made explicitly or supplied silently by a default.

- **Closed — add, subtract, multiply by an INTEGER.** Measured 0 of 200,000 against an exact BigInt reference (`tests/money.test.ts` → *"closure: add, subtract and multiply-by-INTEGER are exact"*). The multiply ban is deliberately narrow: `replacement × quantity` is exact because `quantity` is `z.int()`.
- **Not closed — divide, or multiply by a fraction.** Make the rounding explicit: integer cents, `roundDivHalfUp`, `distributeCents`. Round **once**, at the end, half-up.
- **Never `currency(a).divide(b)` to get a ratio.** It quantizes the *ratio* at `precision`, discarding the rate's decimals before they are applied — 199,829 of 200,000 wrong, worst $373.53. A ratio near 1 collapses to exactly 1.

⚠️ **`× n ÷ d` is a rule about INTEGER arithmetic, not advice about a currency.js chain.** Measured 2026-08-08: staging the multiply and divide as two currency.js operations quantizes the intermediate at 2dp and is wrong 1,016 times in 200,000, while a single raw-float multiply is exact. On a chain where every step rounds, fewer steps beat a better order. The defect the ban names is quantizing the ratio — not "a float touched the money". Full table: `tests/money.test.ts` → *"closure: the non-closed forms"*, and the `cfs-money` skill.

```ts
const toCents = (money: number) => BigInt(Math.round(money * 100)); // inputs are 2dp → lossless
const roundDivHalfUp = (num: bigint, den: bigint) => (2n * num + den) / (2n * den); // non-negative num only
```

`calculateItemSubtotal` (`src/utils/orders.ts`) is the reference: the day factor is `× days ÷ 5`, the percent discount is `× (100·S − rate·S) ÷ 100·S`. Verified against an exact BigInt rational reference over 300k random lines, 0 disagreements. The float form it replaced mis-rounded ~1 line in 21,000 by a cent, always upward.

**That sweep runs** — `tests/orders.test.ts`, *"matches exact rational arithmetic over 300k random lines"*, ~120 ms. Read its companion (*"…and a divide-first implementation DOES disagree"*) before trusting it: a BigInt-vs-BigInt oracle mirroring the implementation's own decomposition can only ever agree with it, so the companion sweeps a divide-first form and asserts it fails. `tests/movements.test.ts` (`costOfUnits`, 200k draws) is the same shape.

**That companion counts its two arms SEPARATELY, and the split found something.** It used to report one merged number — 1,150 of 300,000, quoted here and in two other CLAUDE.md files as evidence the guard bites. Splitting it (re-measured 2026-08-07, by execution) shows the **subtotal arm has always been 0** and the whole 1,150 was the **discount arm**. That is not a regression: `divideFirstLine`'s only pre-divided quotient on the subtotal path is `days / 5`, which this file has always described as the benign one — *"the subtotal path tolerated it… the discount path did not"*. But it means a merged counter was reporting "the guard bites" while one of its two arms had never fired. The subtotal arm is now **reported, not asserted**; the discount arm keeps its floor. Verified against the pre-migration dollar draw as well as the cents one, so the finding is about the counter, not about the migration.

**Since Phase 11, `currency.js` is NOT used for summing** — money is stored as integer cents, and addition is closed in cents by construction, so `a + b` over two exact cent counts has nothing for a decimal type to protect. `utils/money.ts` is the one remaining importer (`parseMoney` / `parseRate` wrap the library rather than reimplementing string parsing), and `tests/moneyArithmeticCoverage.test.ts` pins that at exactly one.

`Discount.rate` means two things: for `percent` it is a percentage bounded `[0, 100]`; for `flat` it is **dollars per unit, per pricing factor** (`rate × quantity × pricingFactor === amount_cents / 100`), unbounded above, never negative. `RateType` is `["percent", "flat"]` — there is no `"amount"` member. **`rate` stays 4dp DOLLARS through the cents migration** and sits directly beside `amount_cents`; so do `cost.unit_cost` and `average_unit_cost`. Quantizing one to the cent is the `10.0.0-beta.117` regression (a 100-unit $6.39 purchase reporting $0.06/unit). Full cross-repo rule: the **`cfs-money` skill** (`cfs-skills` plugin) — org-shared, so it is reachable from every machine and every cloud agent. The workspace `~/cfs/CLAUDE.md` carries the same rule but is untracked and machine-local (verified 2026-08-08), so cite the skill rather than the path.

### Stored money is integer cents

Every stored **amount** is a `z.int()` count of cents with a `_cents` suffix, so a missed reader is a compile error rather than a 100×. Every stored **rate** stays 4dp dollars with no suffix. The two families are adjacent in four schemas — `cost.amount_cents` beside `cost.unit_cost`, `total_cost_basis_cents` beside `average_unit_cost` — and telling them apart is the single most important rule in this package.

`price.base` split into **`base_cents`** (money) and **`base_percent`** (the `percent_of_total` fee percentage, 4dp), because it carried two units discriminated only by a sibling `formula`. `checkPriceBaseUnit` in `schemas/common.ts` enforces exactly-one-of, and `tests/common.test.ts` proves each arm fires.

### JSR imports over npm

Prefer `jsr:` imports over `npm:` when a package is available on JSR. JSR packages are Deno-native, faster to install, and have better type integration.

### Explicit type annotations for JSR (`no-slow-types`)

JSR requires explicit type annotations on all public exports. For Zod schemas, the pattern is:

1. Define the TypeScript interface first
2. Annotate the schema const with `z.ZodType<T>`

```typescript
export interface Contact {
  uid: string;
  name: string;
  emails: string[];
}

export const ContactSchema: z.ZodType<Contact> = z.strictObject({
  uid: z.string(),
  name: z.string().min(1).max(100),
  emails: z.array(Email).default([]),
});
```

This satisfies JSR's `no-slow-types` rule and gives consumers clean importable interfaces.

### Zod 4 API

This package uses Zod 4 (`jsr:@zod/zod@^4`), not Zod 3. Key differences from v3:

- `z.strictObject()` instead of `z.object().strict()`
- `z.email()` instead of `z.string().email()` (top-level string formats)
- `z.infer<>` still works as a type utility but we define interfaces explicitly for JSR

For the full Zod 4 API reference, read `.claude/zod-llms.txt` (auto-fetched from zod.dev/llms.txt). For Deno runtime/API reference, read `.claude/deno-llms.txt` (auto-fetched from docs.deno.com). Run `deno task fetch-llms-docs` to refresh manually.

### Schema structure

- `src/schemas/common.ts` — shared fragments (Email, Phone, Address, Coordinates, TimestampFields)
- `src/schemas/contact.ts` — contact document + input schemas
- `src/schemas/organization.ts` — organization document schema
- `src/schemas/mod.ts` — re-exports everything (the `@cfs/core/schemas` barrel)
- `src/utils/` — pure helper modules (`@cfs/core/utils/*`)

Each schema file exports: Zod schema object, TypeScript interface, and input schemas (where applicable).

**A label on an object-valued key prefixes every descendant, and `.meta()` clones.**
That pair is the non-obvious mechanic behind display columns (below) and is worth
stating here because it applies to any subtree-scoped annotation:

```ts
delivery:   DocDestinationEndpoint.meta({ label: "Delivery" }),
collection: DocDestinationEndpoint.meta({ label: "Collection" }),
```

Two keys, **one schema instance**, two headings — `Leg.meta({…}) !== Leg`, the two
annotated instances are distinct, and the base schema stays unannotated. So a
shared building block (`Address.full`, `UidNameRef.name`, `PriceModifier.rate`)
is annotated **once**, and each site names it by labelling the key that holds it.
`destinations[].delivery.address.full` composes to "Delivery Address" without
forking `Address`.

⚠️ **`.meta()` also breaks instance identity**, which is what any
`node === SomeExportedSchema` check depends on. `isDateLikeNode` used to
recognise `FirestoreTimestamp` that way, and annotating `created_at` silently
turned every timestamp column into a raw epoch until it was changed to read the
`FIRESTORE_TIMESTAMP_META` marker (which survives the clone, because `.meta()`
**merges**).

### UID property naming

Any `uid` property should be named either `uid` (for the document's own user ID) or `uid_{descriptor}` (e.g., `uid_owner`, `uid_creator`) when referencing another user.

### Dependencies

When introducing a new dependency, always double check you are introducing the latest version.

### PII classification

When adding or changing a field, always consider whether it needs a `.meta({ pii })` annotation. Sensitive fields must be classified so API middleware can mask, hash, or redact them in logs. See `src/schemas/log/` for the `PiiClassification` type (`"none"`, `"mask"`, `"hash"`, `"redact"`). The `tests/pii.test.ts` enforcement test will fail if a field matching a sensitive pattern (email, phone, password, address, name, notes, etc.) is missing a `pii` meta value.

**This is not the only per-field duty** — see *Display columns* below. A field
classified for `pii` and left unannotated for `column` is invisible in every
table by design, and nothing says so.

### Display columns — declared, opt-in, and labelled

When adding or changing a field, decide whether it is a **table column**, the
same way you decide its `pii` class. Both are per-field duties and neither has a
safe default; the difference is that a missing `pii` fails loudly in
`tests/pii.test.ts` while a missing `column` just means the field is invisible.

```ts
total_cents: z.int().meta({ column: true, label: "Total" }),
```

- **`column: true` is opt-in.** Before this, a walker enumerated ~375 columns
  across the manager's 14 live table surfaces and structural regexes generated a
  heading for each — nobody chose either, so both drifted on every rename
  ("Totals - Total Cents", `date_fs` → **"Fs"**). Opt-out would be that exclusion
  predicate relocated, drifting the same way.
- **The heading composes down the key path** — see *Schema structure* above.
  Annotate a shared block once with no `label`; name it at each key.
- **Never annotate an `_fs` mirror.** `dates.start_fs` is `dates.start` under the
  Timestamp encoding; annotating both mints two columns with one heading. The
  pairing is declared by `.meta({ serverSortVia })`, which the Typesense
  derivation inverts.
- **A rate names its unit** (`unit: "usd" | "percent"`), never mere rate-ness — a
  marker carrying no unit is what shipped every money mirror 100× (root
  `CLAUDE.md`).
- **…unless the unit belongs to the ROW, in which case it names where to look.**
  `10.25` is `10.25%` under `type: "percent"` and `$10.25` per unit under
  `"flat"`, so no static per-field value can be right — one arm would always
  render wrongly. Those columns spread `RATE_UNIT_META` (`src/schemas/common.ts`,
  beside `RateTypeEnum`), which carries `unitVia` — a **sibling key resolved
  against the leaf's own parent object** at render time — and `unitMap`, the
  per-member unit. The map is the load-bearing half: `unitVia` alone would be
  `money: boolean` again, a definition with no unit. Four sites today
  (`PriceModifier.rate`, `TaxRef.rate`, `Discount.rate`, `Tax.rate`), one
  constant, so a new `RateType` member is one edit.
- **Computed Typesense fields** have no Firestore field to hang a label on and go
  in `TYPESENSE_ROLLUP_COLUMNS` (`src/schemas/display-columns.ts`) — 19 entries,
  all `deriveOrderDateEnvelope` / `postProcess` output.

Enforced by `tests/display-columns.test.ts`: **T8** every `displayDefaults.columns`
key (Typesense *and* Firestore) is a declared column; **T9** every column composes
a non-empty heading, no two columns on one surface share one, and no heading ends
in `Cents`/`Fs`/`At`/`Uid`/`Str`; **T10** the rollup table names real fields and
shadows no declared column; **T11** a column only ever names a field its
collection actually indexes; **T14** every `unitVia` names an enum sibling the
schema really has, every `unitMap` covers every member of it, and the nineteen
columns the four annotation sites fan out to are pinned by name — the two
property arms pass vacuously over the empty set a deleted annotation produces.

Resolving the unit is the **consumer's** job and needs its own value assertion
there: the schema says `flat` means dollars, it cannot say what `$` the cell
printed. See `manager/CLAUDE.md` § *Money in collection tables*.

### Document vs input schemas

- **Document schemas** (`ContactSchema`, `OrganizationSchema`) — full Firestore document shape, use `z.strictObject()`
- **Input schemas** (`CreateContactInput`, `UpdateContactInput`) — what API endpoints accept, use `z.object()` (no strict)

This applies to nested objects too — if a field inside an input schema contains an object, use `z.object()` so extra properties are silently stripped rather than rejected.

## API Reference

A full OpenAPI spec for the CFS API is available at `~/cfs/api-cloudrun/openapi.json`. It is auto-generated on each commit in that repo and documents all endpoints, request/response schemas, and propagation rules.
