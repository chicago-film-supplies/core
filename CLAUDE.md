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

`currency.js` is the money type; **BigInt integer cents is the arithmetic whenever a factor or ratio is applied to money.** currency.js quantizes *every* intermediate at its `precision`, so a pre-divided float factor rides its representation error straight into the cents. `precision` is configurable, so precision is rarely the objection — **operation order** is.

- Apply factors as `× n ÷ d`, never `× (n / d)`. Neither `chargeable_days / 5` nor `(100 − rate) / 100` is representable in binary.
- Never `currency(a).divide(b)` to get a ratio: it quantizes the *ratio*, leaving only `precision − 2` decimals once you scale to a percent, and a ratio near 1 collapses to exactly 1.
- Round **once**, at the end, half-up.

```ts
const toCents = (money: number) => BigInt(Math.round(money * 100)); // inputs are 2dp → lossless
const roundDivHalfUp = (num: bigint, den: bigint) => (2n * num + den) / (2n * den); // non-negative num only
```

`calculateItemSubtotal` (`src/utils/orders.ts`) is the reference: the day factor is `× days ÷ 5`, the percent discount is `× (100·S − rate·S) ÷ 100·S`. Verified against an exact BigInt rational reference over 300k random lines, 0 disagreements. The float form it replaced mis-rounded ~1 line in 21,000 by a cent, always upward.

**That sweep runs** — `tests/orders.test.ts`, *"matches exact rational arithmetic over 300k random lines"*, ~120 ms. Read its companion (*"…and a divide-first implementation DOES disagree"*) before trusting it: a BigInt-vs-BigInt oracle mirroring the implementation's own decomposition can only ever agree with it, so the companion sweeps a divide-first form and asserts it fails — measured at 1,150 of 300,000 lines, 1 in 261. `tests/movements.test.ts` (`costOfUnits`, 200k draws) is the same shape.

`currency.js` stays for **summing** money (`calculateOrderTotals`) — that is what it is good at.

`Discount.rate` means two things: for `percent` it is a percentage bounded `[0, 100]`; for `flat` it is **dollars per unit, per pricing factor** (`rate × quantity × pricingFactor === amount`), unbounded above, never negative. `RateType` is `["percent", "flat"]` — there is no `"amount"` member. Full cross-repo rule: workspace `CLAUDE.md` → "Money arithmetic (authoritative)".

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

### UID property naming

Any `uid` property should be named either `uid` (for the document's own user ID) or `uid_{descriptor}` (e.g., `uid_owner`, `uid_creator`) when referencing another user.

### Dependencies

When introducing a new dependency, always double check you are introducing the latest version.

### PII classification

When adding or changing a field, always consider whether it needs a `.meta({ pii })` annotation. Sensitive fields must be classified so API middleware can mask, hash, or redact them in logs. See `src/schemas/log/` for the `PiiClassification` type (`"none"`, `"mask"`, `"hash"`, `"redact"`). The `tests/pii.test.ts` enforcement test will fail if a field matching a sensitive pattern (email, phone, password, address, name, notes, etc.) is missing a `pii` meta value.

### Document vs input schemas

- **Document schemas** (`ContactSchema`, `OrganizationSchema`) — full Firestore document shape, use `z.strictObject()`
- **Input schemas** (`CreateContactInput`, `UpdateContactInput`) — what API endpoints accept, use `z.object()` (no strict)

This applies to nested objects too — if a field inside an input schema contains an object, use `z.object()` so extra properties are silently stripped rather than rejected.

## API Reference

A full OpenAPI spec for the CFS API is available at `~/cfs/api-cloudrun/openapi.json`. It is auto-generated on each commit in that repo and documents all endpoints, request/response schemas, and propagation rules.
