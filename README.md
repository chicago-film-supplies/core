# @cfs/core

The single shared CFS package, published to JSR as `@cfs/core`. Two namespaces, **no bare root export**:

- **`@cfs/core/schemas[/*]`** — Zod 4 schemas for Firestore + Typesense collections, programmatically enforceable propagation rules, and shared TypeScript types/interfaces (sources under `src/schemas/`).
- **`@cfs/core/utils/*`** — pure helper functions: dates, invoices, orders, products, bookings, cards, contact-name, templates (sources under `src/utils/`).

Utils depend one-way on schemas (via the relative `../schemas/mod.ts` barrel), so the two ship in one publish — no cross-package lockstep.

## Usage

```ts
// Schemas — the ./schemas barrel re-exports everything (incl. typesense, log, pii).
import { ContactSchema, type Contact } from "jsr:@cfs/core/schemas";
import { CreateOrderInput } from "jsr:@cfs/core/schemas/order";
import { type BookingDocument, bookings } from "jsr:@cfs/core/schemas/typesense";

// Utils — one entrypoint per module.
import { toChicagoStartOfDay, countCfsBusinessDays } from "jsr:@cfs/core/utils/dates";
import { calculateOrderTotals, consolidateItems } from "jsr:@cfs/core/utils/orders";

// Validate a Firestore document
const contact: Contact = ContactSchema.parse(firestoreDoc);

// Validate API input (strips unknown fields)
const input = CreateOrderInput.parse(requestBody);

// Access Typesense collection config
console.log(bookings.schema.name); // "bookings"

// Compute order pricing totals
const totals = calculateOrderTotals(items, taxes);
```

## Setup

Requires [Deno](https://deno.land/).

```sh
deno task setup   # install dependencies and enable git hooks
```

## Commands

```sh
deno task check   # type-check
deno task lint    # lint (includes JSR no-slow-types validation)
deno task test    # run tests
```

## Publishing

Push to the `beta` branch to trigger a GitHub Actions workflow that runs [semantic-release](https://github.com/semantic-release/semantic-release) and publishes to JSR.

## Commit conventions

This repo uses semantic-release with the **Conventional Commits** preset. The commit message determines the version bump automatically.

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

## Project structure

- `src/schemas/common.ts` — shared fragments (Email, Phone, Address, Coordinates, TimestampFields)
- `src/schemas/mod.ts` — re-exports all schemas (the `@cfs/core/schemas` barrel)
- `src/schemas/typesense/` — Typesense collection schemas
- `src/utils/` — pure helper modules (`@cfs/core/utils/*`: dates, orders, invoices, products, bookings, cards, contact-name, templates)
- `tests/` — test suite

## Schema conventions

- **Document schemas** (`ContactSchema`, `OrganizationSchema`) use `z.strictObject()` — rejects unknown properties
- **Input schemas** (`CreateContactInput`, `UpdateContactInput`) use `z.object()` — silently strips unknown properties

This applies to nested objects within each schema type as well.

## License

MIT
