# @cfs/utilities

Shared date and order utility functions for CFS applications, published to
[JSR](https://jsr.io/@cfs/utilities).

See [API.md](./API.md) for the full symbol reference (generated from source),
or browse on [JSR](https://jsr.io/@cfs/utilities/doc/all_symbols).

## Usage

### Dates

```ts
import {
  formatChargeDays,
  countCfsBusinessDays,
  getDefaultStartDate,
} from "@cfs/utilities/dates";

// Format chargeable days for display
const result = formatChargeDays(10);
console.log(result.periodLabel); // "2 weeks"

// Count business days between two dates (excluding weekends and holidays)
const start = new Date("2025-01-06");
const end = new Date("2025-01-10");
const days = countCfsBusinessDays(start, end, ["2025-01-20"]);
console.log(days.days); // 5

// Get the next available rental start date
const startDate = getDefaultStartDate(["2025-12-25"]);
```

### Orders

```ts
import { calculateOrderTotals, consolidateItems } from "@cfs/utilities/orders";

// Calculate pricing totals for an order
const items = [
  {
    type: "rental",
    quantity: 2,
    price: {
      base: 50,
      formula: "five_day_week",
      chargeable_days: 5,
      discount: null,
      taxes: [{ uid: "tax-1", name: "Sales Tax", rate: 10, type: "percent" }],
      subtotal: 100,
      subtotal_discounted: 100,
    },
  },
];
const taxes = [{ uid: "tax-1", name: "Sales Tax", rate: 10, type: "percent" }];
const totals = calculateOrderTotals(items, taxes);
console.log(totals.total); // 110
```

## Commit Guidelines (Semantic Release)

All commits must follow the [Conventional Commits](https://www.conventionalcommits.org/) format. Semantic Release parses these to determine the next version.

| Prefix | Version Bump | Example |
|---|---|---|
| `fix:` | Patch (`1.14.1`) | `fix(orders): correct tax rounding` |
| `feat:` | Minor (`1.15.0`) | `feat(orders): add bulk create` |
| `feat!:` / `BREAKING CHANGE:` | Major (`2.0.0`) | `feat!: remove legacy order format` |
| `chore:` / `docs:` / `ci:` | No release | `chore: update dev deps` |

## Publish Protocol

1. **Develop locally** — commit to a feature branch, then push/merge to `beta`.
2. **Beta publish** — a GitHub Action runs semantic release on the `beta` branch, publishing to JSR with a `-beta.N` prerelease tag.
   - e.g. if current version is `1.14.0`: a `fix:` commit → `1.14.1-beta.1`, a `feat:` commit → `1.15.0-beta.1`, a breaking commit → `2.0.0-beta.1`.
   - Subsequent pushes to `beta` increment the prerelease number (`-beta.2`, `-beta.3`, …).
3. **Stable publish** — merge the `beta` branch into `main` via GitHub PR. Semantic release runs again and publishes the stable version (e.g. `1.15.0`) to JSR.
