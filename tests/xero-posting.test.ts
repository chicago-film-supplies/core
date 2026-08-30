import { assertEquals } from "@std/assert";
import {
  MOVEMENT_TYPES,
  type MovementTypeType,
} from "../src/schemas/mod.ts";
import {
  XERO_ASSET_ACCOUNTS,
  XERO_OFFSET_ACCOUNTS,
  xeroPostingFor,
} from "../src/utils/movements.ts";

// `PRODUCT_TYPES` is not exported; the union is what matters here.
const PRODUCT_TYPES = [
  "rental",
  "sale",
  "service",
  "surcharge",
  "replacement",
  "transaction_fee",
] as const;

// ── Totality ────────────────────────────────────────────────────

Deno.test("xeroPostingFor is total over every (movement type, product type) pair", () => {
  for (const type of MOVEMENT_TYPES) {
    for (const productType of PRODUCT_TYPES) {
      for (const cost of [null, 0, 12_345, -12_345]) {
        const d = xeroPostingFor(type, productType, cost);
        // Every branch resolves to one of the four kinds — no throw, no undefined.
        assertEquals(
          ["bill", "skip", "manual", "terminal"].includes(d.kind),
          true,
          `${type}/${productType}/${cost} → ${JSON.stringify(d)}`,
        );
      }
    }
  }
});

// ── The carve-outs ──────────────────────────────────────────────

Deno.test("opening_balance and sale never post", () => {
  for (const productType of PRODUCT_TYPES) {
    assertEquals(xeroPostingFor("opening_balance", productType, 100), {
      kind: "skip",
      reason: "opening_balance",
    });
    assertEquals(xeroPostingFor("sale", productType, 100), {
      kind: "skip",
      reason: "sale_posts_on_accrec",
    });
  }
});

Deno.test("custody-only types and transfer carry no cost contract", () => {
  const custodyOnly: MovementTypeType[] = [
    "prep",
    "check_out",
    "check_in",
    "mark_damaged",
    "mark_lost",
    "transfer",
  ];
  for (const type of custodyOnly) {
    assertEquals(xeroPostingFor(type, "sale", null), {
      kind: "skip",
      reason: "no_cost_contract",
    });
  }
});

// ── sale_return: the zero IS the decision ───────────────────────

Deno.test("a no-refund return posts a $0 bill; a refunded one goes to ACCREC", () => {
  const noRefund = xeroPostingFor("sale_return", "sale", 0);
  assertEquals(noRefund, {
    kind: "bill",
    asset_account: XERO_ASSET_ACCOUNTS.retail,
    offset_account: XERO_OFFSET_ACCOUNTS.adjustment_clearing,
    direction: 1,
    zero_total: true,
  });
  assertEquals(xeroPostingFor("sale_return", "sale", 1), {
    kind: "skip",
    reason: "refunded_return_posts_on_accrec",
  });
});

// ── The account choice is the product type, and nothing else ────

Deno.test("a purchase is the ONLY non-zero-total bill, and AP is implicit", () => {
  const retail = xeroPostingFor("purchase", "sale", 500_00);
  assertEquals(retail, {
    kind: "bill",
    asset_account: 1400,
    offset_account: 2000,
    direction: 1,
    zero_total: false,
  });
  // The fleet capitalises to 1999, at ANY cost — no threshold in the writer.
  for (const cents of [1, 99_99, 100_000_00]) {
    const fleet = xeroPostingFor("purchase", "rental", cents);
    assertEquals(fleet.kind, "bill");
    assertEquals((fleet as { asset_account: number }).asset_account, 1999);
  }
});

Deno.test("every OTHER posting bill totals zero", () => {
  for (const type of MOVEMENT_TYPES) {
    for (const productType of ["sale", "rental"] as const) {
      const d = xeroPostingFor(type, productType, 0);
      if (d.kind !== "bill") continue;
      if (type === "purchase") continue;
      assertEquals(d.zero_total, true, `${type}/${productType} must total zero`);
    }
  }
});

// ── Increases vs decreases ──────────────────────────────────────

Deno.test("$0 increases clear through 2510", () => {
  for (const type of ["find", "make", "adjustment_increase"] as const) {
    assertEquals(xeroPostingFor(type, "sale", 0), {
      kind: "bill",
      asset_account: 1400,
      offset_account: 2510,
      direction: 1,
      zero_total: true,
    });
  }
});

Deno.test("an EXPENSED decrease books shrink to 5700", () => {
  for (const type of ["write_off", "adjustment_decrease", "trade_in"] as const) {
    assertEquals(xeroPostingFor(type, "sale", 0), {
      kind: "bill",
      asset_account: 1400,
      offset_account: 5700,
      direction: -1,
      zero_total: true,
    }, `${type} should expense through 5700`);
  }
});

Deno.test("a CAPITALISED disposal refuses, and routes to the manual seam", () => {
  // The entry CFS could write never clears accumulated depreciation, and Xero
  // cannot do a partial disposal by quantity at all. Refusing is the honest
  // boundary — see the reason's docblock.
  for (const type of ["write_off", "adjustment_decrease", "trade_in"] as const) {
    assertEquals(xeroPostingFor(type, "rental", 0), {
      kind: "manual",
      reason: "capitalised_disposal",
    }, `${type} on the fleet must not post a journal`);
  }
});

// ── trade_in follows its CONTRACT, not a remembered list ────────

Deno.test("trade_in is a DECREASE, on its contract", () => {
  // A planning-era census grouped `trade_in` with the increase types. Its
  // contract (`from: locations`, `to: outside`) says otherwise, and the
  // contract is the authority — which is the whole reason this table derives
  // direction rather than hand-listing it.
  const d = xeroPostingFor("trade_in", "sale", 0);
  assertEquals(d.kind, "bill");
  assertEquals((d as { direction: number }).direction, -1);
});

// ── Non-stock-bearing product types are terminal, not silent ────

Deno.test("a cost-bearing movement on a non-stock product is TERMINAL", () => {
  for (const productType of ["service", "surcharge", "replacement", "transaction_fee"] as const) {
    assertEquals(xeroPostingFor("purchase", productType, 100), {
      kind: "terminal",
      reason: "product_type_not_stock_bearing",
    });
  }
});
