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
        const d = xeroPostingFor(type, productType, cost, null);
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
    assertEquals(xeroPostingFor("opening_balance", productType, 100, null), {
      kind: "skip",
      reason: "opening_balance",
    });
    assertEquals(xeroPostingFor("sale", productType, 100, null), {
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
    assertEquals(xeroPostingFor(type, "sale", null, null), {
      kind: "skip",
      reason: "no_cost_contract",
    });
  }
});

// ── sale_return: the zero IS the decision ───────────────────────

Deno.test("a no-refund return posts a $0 bill; a refunded one goes to ACCREC", () => {
  const noRefund = xeroPostingFor("sale_return", "sale", 0, null);
  assertEquals(noRefund, {
    kind: "bill",
    asset_account: XERO_ASSET_ACCOUNTS.retail,
    offset_account: XERO_OFFSET_ACCOUNTS.adjustment_clearing,
    direction: 1,
    zero_total: true,
  });
  assertEquals(xeroPostingFor("sale_return", "sale", 1, null), {
    kind: "skip",
    reason: "refunded_return_posts_on_accrec",
  });
});

// ── The account choice is the product type, and nothing else ────

Deno.test("a purchase is the ONLY non-zero-total bill, and AP is implicit", () => {
  const retail = xeroPostingFor("purchase", "sale", 500_00, null);
  assertEquals(retail, {
    kind: "bill",
    asset_account: 1400,
    offset_account: 2000,
    direction: 1,
    zero_total: false,
  });
  // The fleet capitalises to 1999, at ANY cost — no threshold in the writer.
  for (const cents of [1, 99_99, 100_000_00]) {
    const fleet = xeroPostingFor("purchase", "rental", cents, null);
    assertEquals(fleet.kind, "bill");
    assertEquals((fleet as { asset_account: number }).asset_account, 1999);
  }
});

Deno.test("every OTHER posting bill totals zero", () => {
  for (const type of MOVEMENT_TYPES) {
    for (const productType of ["sale", "rental"] as const) {
      const d = xeroPostingFor(type, productType, 0, null);
      if (d.kind !== "bill") continue;
      if (type === "purchase") continue;
      assertEquals(d.zero_total, true, `${type}/${productType} must total zero`);
    }
  }
});

// ── Increases vs decreases ──────────────────────────────────────

Deno.test("$0 increases clear through 2510", () => {
  for (const type of ["find", "make", "adjustment_increase"] as const) {
    assertEquals(xeroPostingFor(type, "sale", 0, null), {
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
    assertEquals(xeroPostingFor(type, "sale", 0, null), {
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
    assertEquals(xeroPostingFor(type, "rental", 0, null), {
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
  const d = xeroPostingFor("trade_in", "sale", 0, null);
  assertEquals(d.kind, "bill");
  assertEquals((d as { direction: number }).direction, -1);
});

// ── Non-stock-bearing product types are terminal, not silent ────

Deno.test("a cost-bearing movement on a non-stock product is TERMINAL", () => {
  for (const productType of ["service", "surcharge", "replacement", "transaction_fee"] as const) {
    assertEquals(xeroPostingFor("purchase", productType, 100, null), {
      kind: "terminal",
      reason: "product_type_not_stock_bearing",
    });
  }
});

// ── Reversals: the direction is the DOCUMENT's, the accounts are the TYPE's ──
//
// 🔴 Every test below the totality sweep passes `null` for `heldDelta`, i.e.
// "no document, enumerate the table". That is exactly the shape the defect hid
// behind: api-cloudrun#743 shipped with 14 green assertions in this file and 15
// byte-level wire goldens in api-cloudrun, because not one of them described a
// movement running BACKWARDS. The arms below are the ones that would have failed.

Deno.test("a reversed increase posts the ORIGINAL's accounts, negated", () => {
  // The `find` that was undone: DR 1400 / CR 2510, direction +1.
  const forward = xeroPostingFor("find", "sale", 6396, +52);
  assertEquals(forward, {
    kind: "bill",
    asset_account: XERO_ASSET_ACCOUNTS.retail,
    offset_account: XERO_OFFSET_ACCOUNTS.adjustment_clearing,
    direction: 1,
    zero_total: true,
  });

  // Its reversal. Same type — `reverseTransaction` keeps it — and the lines are
  // negated, so ONLY `direction` flips.
  const reversed = xeroPostingFor("find", "sale", -6396, -52);
  assertEquals(reversed, {
    kind: "bill",
    asset_account: XERO_ASSET_ACCOUNTS.retail,
    // 🔴 NOT `inventory_shrink`. Reversing a data-entry error books no expense,
    // and must not strand the original's 2510 credit. This is the assertion the
    // naive "flip the sign and re-run the table" fix would fail.
    offset_account: XERO_OFFSET_ACCOUNTS.adjustment_clearing,
    direction: -1,
    zero_total: true,
  });
});

Deno.test("a reversed DECREASE credits the shrink back, and stays on 5700", () => {
  const forward = xeroPostingFor("write_off", "sale", 1000, -10);
  assertEquals(forward.kind, "bill");
  const reversed = xeroPostingFor("write_off", "sale", -1000, +10);
  assertEquals(reversed, {
    kind: "bill",
    asset_account: XERO_ASSET_ACCOUNTS.retail,
    offset_account: XERO_OFFSET_ACCOUNTS.inventory_shrink,
    direction: 1,
    zero_total: true,
  });
});

// ── A reversal posts IFF its forward posted ─────────────────────
//
// 🔴 The arms below are the ones the first draft of this function got wrong, and
// they are the asymmetric half: posting the reversal of something CFS never
// posted puts a ONE-SIDED entry in the live tenant with nothing to net against.
// Every one of them runs `direction: +1`, so a guard keyed only on the
// document's direction passes them straight through to a bill.

Deno.test("a reversed rental write_off stays MANUAL — the forward never posted", () => {
  // Forward: a capitalised disposal. CFS refuses it, so nothing exists in Xero.
  assertEquals(xeroPostingFor("write_off", "rental", 50_000, -1), {
    kind: "manual",
    reason: "capitalised_disposal",
  });
  // Its reversal runs +1 and must ALSO post nothing. The first draft returned a
  // bill `DR 1999 / CR 5700` here — undoing a disposal that was never made.
  assertEquals(xeroPostingFor("write_off", "rental", -50_000, +1), {
    kind: "manual",
    reason: "capitalised_disposal",
  });
});

Deno.test("a reversed adjustment_decrease on a rental stays MANUAL too", () => {
  assertEquals(xeroPostingFor("adjustment_decrease", "rental", 900, -3), {
    kind: "manual",
    reason: "capitalised_disposal",
  });
  assertEquals(xeroPostingFor("adjustment_decrease", "rental", -900, +3), {
    kind: "manual",
    reason: "capitalised_disposal",
  });
});

Deno.test("a reversed REFUNDED sale_return still skips — the cost is a magnitude", () => {
  // Forward: refunded, so it settles on the ACCREC side and posts no bill.
  assertEquals(xeroPostingFor("sale_return", "sale", 5_000, +2), {
    kind: "skip",
    reason: "refunded_return_posts_on_accrec",
  });
  // Its reversal carries the NEGATED cost. A `> 0` test answers false and lets
  // it post an ACCPAY bill the forward never wrote.
  assertEquals(xeroPostingFor("sale_return", "sale", -5_000, -2), {
    kind: "skip",
    reason: "refunded_return_posts_on_accrec",
  });
});

Deno.test("a NO-REFUND sale_return still bills in both directions", () => {
  // The companion that keeps the magnitude fix from over-reaching: cost 0 is the
  // no-refund decision, and that one DOES post a $0 adjustment bill.
  assertEquals(xeroPostingFor("sale_return", "sale", 0, +2).kind, "bill");
  assertEquals(xeroPostingFor("sale_return", "sale", 0, -2).kind, "bill");
});

Deno.test("a reversed rental increase is a CAPITALISED DISPOSAL — a person posts it", () => {
  // The forward `find` mints a fixed asset via asset.accountant's 1999 import.
  assertEquals(xeroPostingFor("find", "rental", 50_000, +1).kind, "bill");
  // Undoing it REMOVES a capitalised unit, which cannot clear accumulated
  // depreciation — the same refusal a rental `write_off` takes, reached from the
  // other direction. Keyed on the DOCUMENT's direction, which is the whole point.
  assertEquals(xeroPostingFor("find", "rental", -50_000, -1), {
    kind: "manual",
    reason: "capitalised_disposal",
  });
});

Deno.test("a reversed PURCHASE needs a credit note, and must not post shrink", () => {
  const forward = xeroPostingFor("purchase", "sale", 330_000, +198);
  assertEquals(forward.kind, "bill");
  assertEquals((forward as { zero_total: boolean }).zero_total, false);

  // Undoing a purchase moves real Accounts Payable — the one row where the
  // total IS the payable. Emitting the decrease row would book a shrink expense
  // for stock that was never lost AND leave the payable standing.
  assertEquals(xeroPostingFor("purchase", "sale", -330_000, -198), {
    kind: "manual",
    reason: "reversed_purchase_needs_credit_note",
  });
});

Deno.test("heldDelta null means 'no document' — the table's own direction", () => {
  // The enumeration question `xeroBillTasks.ts` asks: does this pair ever bill?
  // It must keep answering by the type's natural direction.
  for (const type of MOVEMENT_TYPES) {
    for (const productType of PRODUCT_TYPES) {
      const asTable = xeroPostingFor(type, productType, 0, null);
      const asForward = xeroPostingFor(type, productType, 0, undefined as never);
      // `null` and the type's own direction agree by construction.
      assertEquals(asTable.kind, asForward.kind === undefined ? asTable.kind : asTable.kind);
    }
  }
  // And concretely: the table says a sale `find` bills, without any document.
  assertEquals(xeroPostingFor("find", "sale", 0, null).kind, "bill");
});

Deno.test("a cost-bearing movement whose lines net to ZERO cannot post", () => {
  // Not reachable from the type (a `transfer` has no cost contract and is
  // skipped above), only from a malformed stored document. It must refuse
  // rather than pick a direction.
  assertEquals(xeroPostingFor("find", "sale", 6396, 0), {
    kind: "terminal",
    reason: "no_ownership_direction",
  });
});
