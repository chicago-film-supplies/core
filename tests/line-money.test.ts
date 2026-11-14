/**
 * The one line-money function (one-document-model ruling 39): property sweeps.
 *
 * The oracle checks PROPERTIES, never the formula: a partition sums to the whole,
 * each part sits near the exact rational, a closed line prices at `rate × n`, and
 * the old call sites agree on their own domain. Each sweep has a companion that
 * sweeps a deliberately wrong form and is asserted to DISAGREE, and each arm keeps
 * its own counter (the `cfs-money` sweep discipline).
 */
import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  type LineMoneyLike,
  lineDiscountAtCents,
  lineMoneyAtCents,
  lineUnitsCents,
  priceFromFormula,
} from "../src/utils/price-formulas.ts";
import { roundDivHalfUp } from "../src/utils/money.ts";
import {
  frozenCumulativeShareCents as cumulativeShareCents,
  frozenFlatPurchaseLineMoney as flatPurchaseLineMoney,
  frozenFlatShareCents as flatShareCents,
} from "./helpers/frozen-line-money.ts";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const int = (rand: () => number, lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));

const stated = (cents: number, quantity: number, discount: LineMoneyLike["price"]["discount"] = null): LineMoneyLike => ({
  quantity,
  price: { rates: [], counts: [], discount, stated_cents: cents },
});

/** A random cut of `(0, end]` into consecutive parts. */
function randomPath(rand: () => number, end: number): number[] {
  const cuts = new Set<number>([0, end]);
  const n = int(rand, 0, Math.min(end, 6));
  for (let i = 0; i < n; i++) cuts.add(int(rand, 0, end));
  return [...cuts].sort((a, b) => a - b);
}

/** Exact rational money of a stated line at k, as num/den over BigInt. */
function exactStated(line: LineMoneyLike, k: number): { num: bigint; den: bigint } {
  const s = BigInt(line.price.stated_cents!);
  const q = BigInt(line.quantity);
  const d = line.price.discount;
  if (d === null) return { num: s * BigInt(k), den: q };
  if (d.type === "percent") {
    const r = BigInt(Math.round(d.rate * 1_000_000));
    return { num: s * BigInt(k) * (100_000_000n - r), den: q * 100_000_000n };
  }
  const f = BigInt(Math.round(d.rate * 100));
  return { num: s * BigInt(k) - f * BigInt(k) * q, den: q };
}

/** |part − exact part| in units of 1/den, compared against `limit` cents. */
function withinCents(part: number, a: { num: bigint; den: bigint }, b: { num: bigint; den: bigint }, limit: number) {
  // exact part = a − b, both over (possibly) different dens.
  const den = a.den * b.den;
  const exact = a.num * b.den - b.num * a.den;
  const diff = BigInt(part) * den - exact;
  const abs = diff < 0n ? -diff : diff;
  return abs <= BigInt(limit) * den;
}

const N = 100_000;

Deno.test("line money: a partition sums to the whole line, along any path, on every arm", () => {
  const rand = mulberry32(39_2026);
  const arms = { stated_plain: 0, stated_percent: 0, stated_flat: 0, rate_line: 0, zero_units: 0, past_quantity: 0 };
  for (let i = 0; i < N; i++) {
    const q = int(rand, 0, 40);
    const pick = int(rand, 0, 3);
    let line: LineMoneyLike;
    if (pick === 3) {
      const den = int(rand, 1, 7);
      line = {
        quantity: q,
        price: {
          rates: [{ rate_key: "day", amount_cents: int(rand, 0, 500_00) }],
          counts: [{ rate_key: "day", num: int(rand, 0, 30), den }],
          discount: rand() < 0.5 ? null : { type: "percent", rate: int(rand, 0, 1000_0000) / 10_0000 },
        },
      };
      arms.rate_line++;
    } else {
      const discount = pick === 0
        ? null
        : pick === 1
        ? { type: "percent" as const, rate: int(rand, 0, 1000_0000) / 10_0000 }
        : { type: "flat" as const, rate: int(rand, 0, 50_00) / 100 };
      line = stated(int(rand, 0, 5_000_00), q, discount);
      arms[pick === 0 ? "stated_plain" : pick === 1 ? "stated_percent" : "stated_flat"]++;
    }
    if (q === 0) arms.zero_units++;
    const end = q + (rand() < 0.2 ? int(rand, 1, 10) : 0);
    if (end > q) arms.past_quantity++;
    const path = randomPath(rand, end);
    let sum = 0;
    for (let j = 1; j < path.length; j++) sum += lineUnitsCents(line, path[j - 1], path[j]);
    assertEquals(sum, lineMoneyAtCents(line, end), `path ${path} of ${JSON.stringify(line)}`);
    assertEquals(lineMoneyAtCents(line, 0), 0);
  }
  for (const [arm, n] of Object.entries(arms)) assert(n > 1000, `arm ${arm} exercised only ${n} times`);
});

Deno.test("line money: each part of a stated line sits near the exact rational", () => {
  const rand = mulberry32(2026_11_13);
  const worst = { stated_plain: 0, stated_flat: 0, stated_percent: 0 };
  const over1 = { stated_plain: 0, stated_flat: 0, stated_percent: 0 };
  for (let i = 0; i < N; i++) {
    const q = int(rand, 1, 40);
    const pick = int(rand, 0, 2);
    const discount = pick === 0
      ? null
      : pick === 1
      ? { type: "flat" as const, rate: int(rand, 0, 50_00) / 100 }
      : { type: "percent" as const, rate: int(rand, 0, 1000_0000) / 10_0000 };
    const arm = pick === 0 ? "stated_plain" : pick === 1 ? "stated_flat" : "stated_percent";
    const line = stated(int(rand, 0, 5_000_00), q, discount);
    const b = int(rand, 0, q);
    const a = int(rand, b, q);
    const part = lineUnitsCents(line, b, a);
    if (!withinCents(part, exactStated(line, a), exactStated(line, b), 1)) over1[arm]++;
    for (let lim = worst[arm] + 1; lim <= 3; lim++) {
      if (!withinCents(part, exactStated(line, a), exactStated(line, b), lim - 1)) worst[arm] = lim;
      else break;
    }
  }
  console.log(`parts beyond 1¢ of exact: ${JSON.stringify(over1)}; worst bound (¢): ${JSON.stringify(worst)}`);
  // Every part is the difference of two values each rounded ONCE from the exact
  // rational, so it sits within 1¢ of exact on every arm.
  assertEquals(over1, { stated_plain: 0, stated_flat: 0, stated_percent: 0 });
});

/** The PRE-2026-11-13 form: round each tier, then round the discount on the rounded subtotal. */
function twoRoundings(rate: number, num: number, den: number, q: number, pr: number): bigint {
  const sub = (2n * BigInt(rate) * BigInt(q) * BigInt(num) + BigInt(den)) / (2n * BigInt(den));
  return (2n * sub * (100_00000n - BigInt(pr)) + 100_00000n) / (2n * 100_00000n);
}

Deno.test("line money: a discounted RATE line's parts sit within 1¢ — and the two-rounding form does not", () => {
  const rand = mulberry32(285);
  let over1 = 0, oldOver1 = 0, multiTier = 0;
  for (let i = 0; i < N; i++) {
    const rate = int(rand, 0, 500_00), num = int(rand, 0, 30), den = int(rand, 1, 7), q = int(rand, 1, 40);
    const pr = int(rand, 0, 100_00000); // percent × 1e5
    const second = rand() < 0.3; // a second tier, fractional too
    const rate2 = int(rand, 0, 500_00), num2 = int(rand, 0, 30), den2 = int(rand, 1, 7);
    const line: LineMoneyLike = {
      quantity: q,
      price: {
        rates: [{ rate_key: "day", amount_cents: rate }, { rate_key: "week", amount_cents: rate2 }],
        counts: second
          ? [{ rate_key: "day", num, den }, { rate_key: "week", num: num2, den: den2 }]
          : [{ rate_key: "day", num, den }],
        discount: { type: "percent", rate: pr / 100_000 },
      },
    };
    if (second) multiTier++;
    const b = int(rand, 0, q);
    const a = int(rand, b, q);
    const exact = (k: number) => {
      const t1 = BigInt(rate) * BigInt(k) * BigInt(num) * BigInt(den2);
      const t2 = second ? BigInt(rate2) * BigInt(k) * BigInt(num2) * BigInt(den) : 0n;
      return { num: (t1 + t2) * (100_00000n - BigInt(pr)), den: BigInt(den) * BigInt(den2) * 100_00000n };
    };
    if (!withinCents(lineUnitsCents(line, b, a), exact(a), exact(b), 1)) over1++;
    if (!second) {
      const oldPart = Number(twoRoundings(rate, num, den, a, pr) - twoRoundings(rate, num, den, b, pr));
      if (!withinCents(oldPart, exact(a), exact(b), 1)) oldOver1++;
    }
  }
  console.log(`rate-line parts beyond 1¢: ${over1}; the two-rounding form: ${oldOver1} of ${N} (multi-tier ${multiTier})`);
  assertEquals(over1, 0);
  assert(oldOver1 > 0, "the two-rounding form never exceeded 1¢: the corpus does not discriminate");
  assert(multiTier > 1000);
});

Deno.test("line money: a closed rate line prices every part at rate × n", () => {
  const rand = mulberry32(77);
  for (let i = 0; i < N; i++) {
    const rate = int(rand, 0, 500_00);
    const per = int(rand, 0, 30); // whole counted periods
    const q = int(rand, 1, 40);
    const line: LineMoneyLike = {
      quantity: q,
      price: { rates: [{ rate_key: "day", amount_cents: rate }], counts: [{ rate_key: "day", num: per, den: 1 }], discount: null },
    };
    const b = int(rand, 0, q);
    const a = int(rand, b, q);
    assertEquals(lineUnitsCents(line, b, a), rate * per * (a - b));
  }
});

Deno.test("line money: at the whole quantity it is exactly today's money (rate arm, and flatPurchaseLineMoney)", () => {
  const rand = mulberry32(4040);
  let rate = 0, statedArm = 0;
  for (let i = 0; i < N; i++) {
    const q = int(rand, 1, 40);
    if (rand() < 0.5) {
      const line: LineMoneyLike = {
        quantity: q,
        price: {
          rates: [{ rate_key: "day", amount_cents: int(rand, 0, 500_00) }],
          counts: [{ rate_key: "day", num: int(rand, 0, 30), den: int(rand, 1, 7) }],
          discount: rand() < 0.5 ? null : { type: "flat", rate: int(rand, 0, 50_00) / 100 },
        },
      };
      const m = priceFromFormula(line.price.rates, line.price.counts, q, line.price.discount);
      assertEquals(lineMoneyAtCents(line, q), m.subtotal_discounted_cents);
      assertEquals(lineDiscountAtCents(line, q), m.subtotal_cents - m.subtotal_discounted_cents);
      rate++;
    } else {
      const gross = int(rand, 0, 5_000_00);
      const discount = rand() < 0.5
        ? { type: "flat" as const, rate: int(rand, 0, 50_00) / 100 }
        : { type: "percent" as const, rate: int(rand, 0, 1000_0000) / 10_0000 };
      const old = flatPurchaseLineMoney(gross, q, discount);
      const line = stated(gross, q, discount);
      assertEquals(lineMoneyAtCents(line, q), old.amount_cents);
      assertEquals(lineDiscountAtCents(line, q), old.discount!.amount_cents);
      statedArm++;
    }
  }
  assert(rate > 1000 && statedArm > 1000);
});

Deno.test("line money: on an UNDISCOUNTED stated line it is cumulativeShareCents, and flatShareCents past the quantity", () => {
  const rand = mulberry32(1210);
  let within = 0, past = 0;
  for (let i = 0; i < N; i++) {
    const q = int(rand, 1, 40);
    const amount = int(rand, 0, 5_000_00);
    const line = stated(amount, q);
    const b = int(rand, 0, q + 5);
    const a = int(rand, b, q + 5);
    if (a <= q) {
      assertEquals(lineUnitsCents(line, b, a), cumulativeShareCents(amount, q, b, a));
      within++;
    } else {
      assertEquals(lineUnitsCents(line, b, a), flatShareCents(amount, q, b, a));
      past++;
    }
  }
  assert(within > 1000 && past > 1000);
});

Deno.test("…and the wrong forms DO disagree: per-part rounding, last-n placement, half-up on a negative", () => {
  const rand = mulberry32(13);
  let perPart = 0, lastN = 0, halfUpNeg = 0;
  for (let i = 0; i < N; i++) {
    const q = int(rand, 2, 40);
    const amount = int(rand, 1, 5_000_00);
    const line = stated(amount, q);
    // per-part: three parts each rounded on their own.
    const path = randomPath(rand, q);
    let parts = 0;
    for (let j = 1; j < path.length; j++) {
      parts += Number(roundDivHalfUp(BigInt(amount) * BigInt(path[j] - path[j - 1]), BigInt(q)));
    }
    if (parts !== lineMoneyAtCents(line, q)) perPart++;
    // last-n: crediting n of the first `credited + n` from the TOP of the line.
    const credited = int(rand, 0, q - 1);
    const n = int(rand, 1, q - credited);
    const top = cumulativeShareCents(amount, q, q - n, q);
    if (top !== lineUnitsCents(line, credited, credited + n)) lastN++;
    // half-up on a negative total: rounds toward +∞, not away from zero.
    const neg = stated(-amount, q);
    const k = int(rand, 1, q);
    const halfUp = Number((2n * BigInt(-amount) * BigInt(k) + BigInt(q)) / (2n * BigInt(q)));
    if (halfUp !== lineMoneyAtCents(neg, k)) halfUpNeg++;
  }
  console.log(`wrong forms disagree: per-part ${perPart}, last-n ${lastN}, half-up-on-negative ${halfUpNeg} of ${N}`);
  assert(perPart > 0, "per-part rounding never disagreed: the corpus does not discriminate");
  assert(lastN > 0, "last-n placement never disagreed: the corpus does not discriminate");
  assert(halfUpNeg > 0, "half-up on a negative never disagreed: the corpus does not discriminate");
});

Deno.test("line money: refusals", () => {
  assertThrows(() => lineMoneyAtCents(stated(100, 3), -1), RangeError);
  assertThrows(() => lineMoneyAtCents(stated(100, 3), 1.5), RangeError);
  // A stated total governs a line that also carries rates (a linked time line).
  assertEquals(
    lineMoneyAtCents({
      quantity: 2,
      price: { rates: [{ rate_key: "day", amount_cents: 999 }], counts: [{ rate_key: "day", num: 3, den: 1 }], discount: null, stated_cents: 101 },
    }, 1),
    51,
  );
  assertThrows(() => lineMoneyAtCents({ type: "transaction_fee", ...stated(100, 1) }, 1));
  assertEquals(lineMoneyAtCents(stated(100, 0), 5), 0);
});
