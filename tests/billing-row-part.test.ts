/**
 * Ruling 178 (one-document-model): a part's money is decided by LINE KIND, never
 * side. One door, `billingRowPart`; a rate row through the formula, a stated row
 * through its stated gross and declared discount cents.
 */
import { assertEquals } from "@std/assert";
import { billingRowPart } from "../src/utils/price-document.ts";
import { lineMoneyAtCents } from "../src/schemas/_line-money.ts";

/** A small deterministic PRNG, so a failure reproduces. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

/** Cut 0..q into random cumulative points. */
function cuts(r: () => number, q: number): number[] {
  const out = [0];
  while (out[out.length - 1] < q) out.push(Math.min(q, out[out.length - 1] + 1 + Math.floor(r() * 3)));
  return out;
}

Deno.test("billingRowPart: a RATE row's parts are formula differences and sum exactly to its money, any discount", () => {
  const r = rng(178);
  for (let i = 0; i < 20_000; i++) {
    const q = 1 + Math.floor(r() * 12);
    const rate = 1 + Math.floor(r() * 50_000);
    const den = 1 + Math.floor(r() * 7);
    const num = Math.floor(r() * 30);
    const discount = r() < 0.5 ? { type: "percent" as const, rate: Math.round(r() * 1000) / 100 } : r() < 0.5 ? { type: "flat" as const, rate: Math.round(r() * 500) / 100 } : null;
    const row = { quantity: q, price: { rates: [{ rate_key: "day", amount_cents: rate }], counts: [{ rate_key: "day", num, den }], discount } };
    const whole = lineMoneyAtCents({ quantity: q, price: { ...row.price, stated_cents: null } }, q);
    let net = 0, gross = 0, off = 0;
    const c = cuts(r, q);
    for (let k = 1; k < c.length; k++) {
      const part = billingRowPart(row, c[k - 1], c[k]);
      assertEquals(part.net_cents, part.gross_cents - part.discount_cents, "a part is closed");
      net += part.net_cents; gross += part.gross_cents; off += part.discount_cents;
    }
    assertEquals(net, whole, `rate row ${JSON.stringify(row)} cut ${c}`);
    assertEquals(gross - off, whole);
  }
});

Deno.test("billingRowPart: a STATED row slices its stated gross and declared cents, on either side's row shape", () => {
  const r = rng(1780);
  for (let i = 0; i < 20_000; i++) {
    const q = 1 + Math.floor(r() * 12);
    const stated = Math.floor(r() * 1_000_000);
    const cents = Math.floor(r() * stated);
    // Rates present beside a stated total (a linked time row): the stated total governs.
    const rates = r() < 0.5 ? [{ rate_key: "day", amount_cents: 999 }] : [];
    const row = { quantity: q, price: { rates, counts: [], stated_cents: stated, discount: { type: "percent" as const, rate: 10, amount_cents: cents } } };
    let net = 0, gross = 0;
    const c = cuts(r, q);
    for (let k = 1; k < c.length; k++) {
      const part = billingRowPart(row, c[k - 1], c[k]);
      net += part.net_cents; gross += part.gross_cents;
    }
    assertEquals([gross, net], [stated, stated - cents]);
  }
});

Deno.test("billingRowPart: the side does not enter — the old payable door's slice of a TIME row's net is gone (ruling 178)", () => {
  // 3 units at $10.05/day for 1 day, 10% off. The formula rounds the NET once from
  // the exact figure (904.5 → 905 for 1 unit, 1809 for 2, 2713.5 → 2714 for 3), so
  // the parts are 905, 904, 905 and sum to the whole line's 2714. A slice of a
  // stored net would have rounded a second time.
  const row = { quantity: 3, price: { rates: [{ rate_key: "day", amount_cents: 1005 }], counts: [{ rate_key: "day", num: 1, den: 1 }], discount: { type: "percent" as const, rate: 10 } } };
  assertEquals([0, 1, 2].map((k) => billingRowPart(row, k, k + 1).net_cents), [905, 904, 905]);
});
