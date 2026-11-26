/**
 * One-document-model ruling 189 — a line's money KIND belongs to the line, not
 * the side: an order or invoice line may STATE its total (`price.stated_cents`),
 * as a payable line does. Spec: `api-cloudrun/.claude/plans/line-model-spec.md`
 * S1–S4 with C4/C5.
 *
 * The receivable half is new, so every expectation here is written out by hand:
 * the one stated pricer (D7: stored cents, never a re-applied rate), the two
 * refusals (an extension, a fee), the remainder's part slice, and the order →
 * invoice sync's part follow and requantify.
 */
import { assert, assertEquals, assertThrows } from "@std/assert";
import { fdwPrice } from "./helpers/formulas.ts";
import type { InvoiceDocItemType } from "../src/schemas/mod.ts";
import { buildOrderScopedItems, syncOrderToInvoiceSelective } from "../src/utils/invoices.ts";
import { calculateItemSubtotal, computeLineMoney, type LineItem, PriceRefusalError } from "../src/utils/orders.ts";
import { REMAINDER_SIDES } from "../src/utils/billing-remainder.ts";

const O = "order-1";
const D = "0b6c3a51-6c1a-4f0e-9a51-6f1f2b9d0a01";
const LIGHT = "prod-light";

/** A STATED order line: `stated` cents over `quantity` units, 10% off with its stored `cents`. */
function statedLine(stated: number, quantity: number, cents: number): LineItem {
  return {
    uid: LIGHT, type: "rental", name: "Light", description: "", quantity, path: [D, LIGHT],
    stock_method: "reserve", zero_priced: false, uid_tax_class: "TaxC1assDefau1tAAAAA",
    price: {
      ...fdwPrice(1000, 5),
      stated_cents: stated,
      subtotal_cents: stated,
      subtotal_discounted_cents: stated - cents,
      discount: { rate: 10, type: "percent", amount_cents: cents },
      taxes: [],
      total_cents: stated - cents,
      replacement_cents: 1000,
    },
  } as unknown as LineItem;
}
const dest = { uid: D, type: "destination", name: "Venue", description: "", path: [D] } as unknown as LineItem;

/** A billing line as these tests read it. */
type Row = {
  path: string[];
  quantity: number;
  units_from?: number | null;
  price: Record<string, unknown> & { stated_cents?: number | null; discount: { amount_cents: number } | null };
};

/** The invoice line at `path` under the order divider. */
const at = (items: readonly InvoiceDocItemType[], uid = LIGHT) =>
  items.find((r) => r.path.join("/") === [O, D, uid].join("/")) as unknown as Row;

// ── The one stated pricer (S3) ─────────────────────────────────────

Deno.test("a STATED receivable line prices as its gross less its STORED discount cents (D7), never a re-applied rate", () => {
  // 10% of $10.00 is $1.00, but the line stores 101¢: the stored cents govern.
  const line = statedLine(1000, 3, 101);
  assertEquals(calculateItemSubtotal(line), { subtotal_cents: 1000, subtotal_discounted_cents: 899 });
  const money = computeLineMoney(line, [], LIGHT);
  assertEquals(money.subtotal_cents, 1000);
  assertEquals(money.subtotal_discounted_cents, 899);
  assertEquals(money.discount, { rate: 10, type: "percent", amount_cents: 101 });
  assertEquals(money.total_cents, 899);
  // Control: the same line with NO stored cents (a client's input carries terms
  // only) is the rate event, the terms applied once to the gross.
  const input = { ...line, price: { ...line.price, discount: { rate: 10, type: "percent" } } } as LineItem;
  assertEquals(calculateItemSubtotal(input), { subtotal_cents: 1000, subtotal_discounted_cents: 900 });
  // And the rate line under it is untouched: the formula's money, not the gross.
  const rate = { ...line, price: { ...line.price, stated_cents: null, discount: null } } as LineItem;
  assertEquals(calculateItemSubtotal(rate).subtotal_cents, 3000);
});

Deno.test("a stated line in an EXTENSION section, and a stated transaction fee, are refused by name", () => {
  assertThrows(() => computeLineMoney(statedLine(1000, 3, 100), [], LIGHT, { extension: true }), PriceRefusalError, "extension");
  const fee = {
    uid: "fee", type: "transaction_fee", name: "Card fee", quantity: 1, path: [D, "fee"],
    price: { ...fdwPrice(300, 5), stated_cents: 300, discount: null, taxes: [] },
  } as unknown as LineItem;
  assertThrows(() => computeLineMoney(fee, [], "fee"), PriceRefusalError, "states no total");
});

// ── The remainder's part (C5) ──────────────────────────────────────

Deno.test("the AR remainder cuts a STATED order line's part as its SLICE of the stored gross and cents (C5), not the whole gross", () => {
  // $30.00 over 3 units, 300¢ off: units 2–3 are 2000 gross, 200 off.
  const row = REMAINDER_SIDES.receivable.projectLine(statedLine(3000, 3, 300), O, 2, 1) as unknown as Row;
  assertEquals(row.quantity, 2);
  assertEquals(row.units_from, 1);
  assertEquals(row.price.stated_cents, 2000);
  assertEquals(row.price.discount?.amount_cents, 200);
  // The three parts of the line sum EXACTLY to it on both figures.
  const parts = [[0, 1], [1, 1], [2, 1]].map(([from, q]) =>
    REMAINDER_SIDES.receivable.projectLine(statedLine(1000, 3, 101), O, q, from) as unknown as Row
  );
  assertEquals(parts.reduce((s, p) => s + (p.price.stated_cents ?? 0), 0), 1000);
  assertEquals(parts.reduce((s, p) => s + (p.price.discount?.amount_cents ?? 0), 0), 101);
  // A RATE order line's part carries no gross: the pricer prices its formula at `units_from`.
  const rate = REMAINDER_SIDES.receivable.projectLine(
    { ...statedLine(3000, 3, 300), price: { ...statedLine(3000, 3, 300).price, stated_cents: null } } as LineItem,
    O,
    2,
    1,
  );
  assertEquals((rate as unknown as Row).price.stated_cents, null, "a rate part states no gross: `null` (ruling 204)");
});

// ── The order → invoice sync (S2, C4) ──────────────────────────────

Deno.test("sync: a WHOLE invoice line follows its stated order line's gross AND its cents together", () => {
  const prev = [dest, statedLine(3000, 3, 300)];
  const next = [dest, statedLine(6000, 3, 600)];
  const out = syncOrderToInvoiceSelective(prev, next, buildOrderScopedItems(prev, O), O);
  assertEquals(at(out).price.stated_cents, 6000);
  assertEquals(at(out).price.discount?.amount_cents, 600, "the cents follow with the gross, never stale beside a new gross");
});

Deno.test("sync: an untouched PART (units 0–1 of 3) is re-sliced from the order's new money; an overridden part keeps its own", () => {
  const prev = [dest, statedLine(3000, 3, 300)];
  const next = [dest, statedLine(6000, 3, 600)];
  const whole = buildOrderScopedItems(prev, O);
  const part = (stated: number, cents: number) =>
    whole.map((r) => {
      if (r.path.join("/") !== [O, D, LIGHT].join("/")) return r;
      const row = r as unknown as Row;
      return {
        ...row,
        quantity: 1,
        units_from: 0,
        price: { ...row.price, stated_cents: stated, discount: { rate: 10, type: "percent", amount_cents: cents } },
      } as unknown as InvoiceDocItemType;
    });
  // Untouched: exactly its slice of the previous line (1000 gross, 100 off).
  const followed = syncOrderToInvoiceSelective(prev, next, part(1000, 100), O);
  assertEquals(at(followed).quantity, 1, "the merge keeps a part's quantity (the group differs from the order's)");
  assertEquals(at(followed).price.stated_cents, 2000);
  assertEquals(at(followed).price.discount?.amount_cents, 200);
  assertEquals(at(followed).units_from, 0);
  // Overridden: an operator stated 1234 on the part. It stays.
  const kept = syncOrderToInvoiceSelective(prev, next, part(1234, 123), O);
  assertEquals(at(kept).price.stated_cents, 1234);
  assertEquals(at(kept).price.discount?.amount_cents, 123);
});

Deno.test("sync: a RATE line states no gross — `stated_cents` stays `null` (ruling 204)", () => {
  const rate = (base: number) =>
    ({ ...statedLine(0, 3, 0), price: { ...fdwPrice(base, 5), subtotal_cents: base * 3, subtotal_discounted_cents: base * 3, discount: null, taxes: [], total_cents: base * 3, replacement_cents: 1000 } }) as unknown as LineItem;
  const prev = [dest, rate(1000)];
  const next = [dest, rate(2000)];
  const out = syncOrderToInvoiceSelective(prev, next, buildOrderScopedItems(prev, O), O);
  assertEquals(at(out).price.stated_cents, null);
  assert(at(out).price !== undefined);
});
