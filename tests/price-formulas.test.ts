/**
 * The price-formula engine (`utils/price-formulas.ts`) and the formula schema's
 * single-document rules (`schemas/price-formula.ts`).
 *
 * Three sweeps, each against an oracle that is structurally distinct from the
 * engine, each with a companion that is ASSERTED to disagree (`cfs-money` § The
 * sweep discipline) and one counter per arm:
 *
 * (i)   the money step reproduces `the retired calculateItemSubtotal` for every shape it has
 *       today (Five-day week ↔ `five_day_week`, Fixed ↔ `fixed`, percent and flat
 *       discounts, negative bases, several windows), and an exact rational
 *       oracle that rounds by the DEFINITION;
 * (ii)  supplier units — Vision's "monthly blocks from switch-on, then part
 *       weeks rounded up", restarting at every window (Q1, Q5);
 * (iii) Verizon's prorated month anchored on day 2, with its gap allowance.
 *
 * ⚠️ **(ii) deliberately does NOT reproduce `billablePeriods`.** The plan's
 * Phase 1 line asked for parity with it ("two windows in one anchored week →
 * 1"), but that line predates Q1/Q5: `billablePeriods` anchors a whole line on
 * its FIRST activation, and the owner ruled from the SPEND evidence that the
 * count restarts at each switch-on. The companion below runs the
 * billablePeriods-style accumulating anchor and asserts it DISAGREES — that
 * disagreement is the ruling, pinned.
 */
import { assert, assertEquals, assertThrows } from "@std/assert";
import { addMonths, differenceInCalendarDays, parseISO } from "date-fns";
import { tz } from "@date-fns/tz";
import {
  formulaPeriods,
  meterUnits,
  openRateAmount,
  priceFromFormula,
  rateInForce,
  ratesForFormula,
  snapshotRates,
  statedUnits,
  type TierCount,
  withOpenRateAmount,
} from "../src/utils/price-formulas.ts";
import {
  CreatePriceFormulaInput,
  type DatedRate,
  datedRatesIssues,
  type PriceFormula,
  type PriceFormulaRule,
  priceFormulaRuleIssues,
  PriceFormulaSchema,
  UpdatePriceFormulaInput,
} from "../src/schemas/price-formula.ts";
import { countCfsBusinessDays } from "../src/utils/dates.ts";
import { roundDivHalfAwayFromZero, toCentsBig } from "../src/utils/money.ts";

/** Σ max(d, 5) — the retired `billableDays`, frozen here as an oracle. */
const billableDays = (days: readonly number[]) => days.reduce((sum, d) => sum + Math.max(d, 5), 0);

/**
 * **The retired `the retired calculateItemSubtotal`**, frozen as a test oracle (ruling 8
 * replaced it with the engine): `base × qty × max(days/5, 1)` on
 * `five_day_week`, `base × qty` on `fixed`, an extension's signed day count
 * with the floor skipped, and the discount scaled by the same factor. What the
 * ruling-8 backfill must reproduce byte for byte, so the engine is held to it.
 */
function retiredSubtotal(
  item: { quantity: number; price: { base_cents: number; formula: "five_day_week" | "fixed"; chargeable_days: number | null; discount: { type: "percent" | "flat"; rate: number } | null } },
  opts: { extensionDays?: number } = {},
): { subtotal_cents: number; subtotal_discounted_cents: number } {
  const QTY = 10_000n, RATE = 1_000_000n;
  const { base_cents, formula, chargeable_days, discount } = item.price;
  const quantity = BigInt(Math.round(item.quantity * Number(QTY)));
  const ext = opts.extensionDays;
  const days = Math.round(ext ?? chargeable_days ?? 0);
  const useDays = ext !== undefined || (formula === "five_day_week" && days > 5);
  let num = BigInt(base_cents) * quantity, den = QTY;
  if (useDays) { num *= BigInt(days); den *= 5n; }
  const subtotal = roundDivHalfAwayFromZero(num, den);
  if (!discount) return { subtotal_cents: Number(subtotal), subtotal_discounted_cents: Number(subtotal) };
  let discounted: bigint;
  if (discount.type === "percent") {
    const rate = BigInt(Math.round(discount.rate * Number(RATE)));
    discounted = roundDivHalfAwayFromZero(subtotal * (100n * RATE - rate), 100n * RATE);
  } else {
    let dNum = toCentsBig(discount.rate) * quantity, dDen = QTY;
    if (useDays) { dNum *= BigInt(days); dDen *= 5n; }
    discounted = subtotal - roundDivHalfAwayFromZero(dNum, dDen);
  }
  return { subtotal_cents: Number(subtotal), subtotal_discounted_cents: Number(discounted) };
}

function lcg(seed: number): () => number {
  let s = seed;
  return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
}
const int = (rand: () => number, lo: number, hi: number) =>
  lo + Math.floor(rand() * (hi - lo + 1));

const CHICAGO = tz("America/Chicago");

// ── The formulas of the plan's D1 table ──────────────────────────────

const FIVE_DAY_WEEK: PriceFormulaRule = {
  meter: { source: "windows", count: "business_day", gap_allowance: null },
  segments: [{
    rate_key: "week",
    unit: "week",
    anchor: null,
    consume: "remainder",
    rounding: "prorate",
    divisor: 5,
  }],
  reprice: "remainder",
  minimum: { units: 5, unit: "business_day", scope: "window" },
};

const FIXED: PriceFormulaRule = {
  meter: { source: "none", count: "calendar_day", gap_allowance: null },
  segments: [{
    rate_key: "flat",
    unit: "none",
    anchor: null,
    consume: "remainder",
    rounding: "ceil",
    divisor: null,
  }],
  reprice: "remainder",
  minimum: null,
};

const VISION: PriceFormulaRule = {
  meter: { source: "windows", count: "calendar_day", gap_allowance: null },
  segments: [
    {
      rate_key: "month",
      unit: "month",
      anchor: "window_start",
      consume: "cap",
      rounding: "floor",
      divisor: null,
    },
    {
      rate_key: "week",
      unit: "week",
      anchor: null,
      consume: "remainder",
      rounding: "ceil",
      divisor: null,
    },
  ],
  reprice: "remainder",
  minimum: null,
};

const VERIZON: PriceFormulaRule = {
  meter: {
    source: "span_less_gaps",
    count: "calendar_day",
    gap_allowance: { free_days: 30, per_months: 12 },
  },
  segments: [{
    rate_key: "month",
    unit: "month",
    anchor: { day_of_month: 2 },
    consume: "remainder",
    rounding: "prorate",
    divisor: "days_in_period",
  }],
  reprice: "remainder",
  minimum: null,
};

/** A Chicago start-of-day instant for a calendar date. */
const day = (ymd: string) => parseISO(ymd, { in: CHICAGO }).toISOString();
const ratio = (t: TierCount) => `${t.num}/${t.den}`;

// ── Schema rules ─────────────────────────────────────────────────────

Deno.test("every D1 formula is well-formed", () => {
  for (const f of [FIVE_DAY_WEEK, FIXED, VISION, VERIZON]) {
    assertEquals(priceFormulaRuleIssues(f), []);
  }
});

Deno.test("each single-document rule bites, naming its path", () => {
  const cases: [string, PriceFormulaRule, string][] = [
    ["remainder not last", {
      ...VISION,
      segments: [VISION.segments[1], VISION.segments[0]],
    }, "segments.1.unit"],
    ["month without anchor", {
      ...VISION,
      segments: [{ ...VISION.segments[0], anchor: null }, VISION.segments[1]],
    }, "segments.0.anchor"],
    ["cap not floor", {
      ...VISION,
      segments: [
        { ...VISION.segments[0], rounding: "ceil" },
        VISION.segments[1],
      ],
    }, "segments.0.rounding"],
    ["whole not floor", {
      ...VISION,
      segments: [
        { ...VISION.segments[0], consume: "whole", rounding: "ceil" },
        VISION.segments[1],
      ],
    }, "segments.0.rounding"],
    ["cap as the last segment", {
      ...VISION,
      segments: [VISION.segments[0]],
    }, "segments.0.consume"],
    ["cap on a week", {
      ...VISION,
      segments: [
        { ...VISION.segments[1], consume: "cap", rounding: "floor" },
        { ...VISION.segments[1], rate_key: "day", unit: "day" },
      ],
    }, "segments.0.consume"],
    ["repeated rate_key", {
      ...VISION,
      segments: [VISION.segments[0], {
        ...VISION.segments[1],
        rate_key: "month",
      }],
    }, "segments.1.rate_key"],
    ["none meter with a time segment", {
      ...FIXED,
      segments: [FIVE_DAY_WEEK.segments[0]],
    }, "segments"],
    ["gap allowance off span", {
      ...VISION,
      meter: {
        ...VISION.meter,
        gap_allowance: { free_days: 1, per_months: 1 },
      },
    }, "meter.gap_allowance"],
    ["minimum in the wrong days", {
      ...FIVE_DAY_WEEK,
      minimum: { units: 1, unit: "week", scope: "window" },
    }, "minimum.unit"],
    ["minimum under a month tail", {
      ...VERIZON,
      minimum: { units: 1, unit: "day", scope: "line" },
    }, "minimum"],
    ["prorated month without days_in_period", {
      ...VERIZON,
      segments: [{ ...VERIZON.segments[0], divisor: null }],
    }, "segments.0.divisor"],
    ["business week without divisor", {
      ...FIVE_DAY_WEEK,
      segments: [{ ...FIVE_DAY_WEEK.segments[0], divisor: null }],
    }, "segments.0.divisor"],
  ];
  for (const [label, rule, path] of cases) {
    const paths = priceFormulaRuleIssues(rule).map((i) => i.path.join("."));
    assert(
      paths.includes(path),
      `${label}: expected an issue at ${path}, got ${JSON.stringify(paths)}`,
    );
  }
});

Deno.test("the document refuses a superseded-but-active or self-superseding formula; the engine refuses a malformed rule", () => {
  const doc: PriceFormula = {
    uid: "AAAAAAAAAAAAAAAAAAAA",
    name: "Fixed",
    description: null,
    active: true,
    uid_superseded_by: null,
    ...FIXED,
    version: 0,
    created_by: { uid: "system", name: "System" } as PriceFormula["created_by"],
    updated_by: { uid: "system", name: "System" } as PriceFormula["updated_by"],
    created_at: { seconds: 0, nanoseconds: 0 } as PriceFormula["created_at"],
    updated_at: { seconds: 0, nanoseconds: 0 } as PriceFormula["updated_at"],
  };
  const base = PriceFormulaSchema.safeParse(doc);
  // The actor and timestamp shapes are not under test; only the two invariants are.
  const issues = (d: PriceFormula) =>
    (PriceFormulaSchema.safeParse(d).error?.issues ?? []).map((i) =>
      i.path.join(".")
    );
  const baseIssues = base.success
    ? []
    : base.error.issues.map((i) => i.path.join("."));
  assert(
    !baseIssues.includes("active") && !baseIssues.includes("uid_superseded_by"),
  );
  assert(
    issues({ ...doc, uid_superseded_by: "BBBBBBBBBBBBBBBBBBBB" }).includes(
      "active",
    ),
  );
  assert(
    issues({ ...doc, active: false, uid_superseded_by: doc.uid }).includes(
      "uid_superseded_by",
    ),
  );

  assertThrows(() =>
    meterUnits({
      ...VISION,
      segments: [VISION.segments[1]].concat(VISION.segments[0]),
    }, { windows: [], holidays: [] })
  );
});

Deno.test("the create input runs the rule; the update input cannot express a rule edit", () => {
  const ok = CreatePriceFormulaInput.safeParse({
    name: "Vision",
    active: true,
    ...VISION,
  });
  assert(ok.success);
  const bad = CreatePriceFormulaInput.safeParse({
    name: "Vision",
    active: true,
    ...VISION,
    segments: [VISION.segments[0]],
  });
  assert(!bad.success);
  // Unknown keys strip on an input, so a `segments` on an update never reaches the writer.
  const upd = UpdatePriceFormulaInput.parse({
    uid: "AAAAAAAAAAAAAAAAAAAA",
    segments: VISION.segments,
    name: "X",
  });
  assertEquals(Object.keys(upd).sort(), ["name", "uid"]);
});

// ── (i) The money step vs the retired calculateItemSubtotal and an exact rational oracle ──

type Discount = { rate: number; type: "percent" | "flat" } | null;

/**
 * The oracle: `rate × qty × num ÷ den` and its discount as exact rationals, each
 * tier rounded half-away-from-zero BY THE DEFINITION — floor, then compare the
 * doubled remainder — never by the engine's `(2n + d) / 2d` identity.
 */
function roundRational(num: bigint, den: bigint): bigint {
  const neg = (num < 0n) !== (den < 0n);
  const n = num < 0n ? -num : num;
  const d = den < 0n ? -den : den;
  const q = n / d;
  const r = n - q * d;
  const up = 2n * r >= d ? q + 1n : q;
  return neg ? -up : up;
}

/**
 * The exact rational, rounded ONCE per figure (one-document-model ruling 39,
 * owner 2026-11-13): the subtotal from Σ tiers, and the discounted amount from
 * the EXACT sum, never from the rounded subtotal.
 */
function oracle(
  rates: Record<string, number>,
  tiers: readonly TierCount[],
  quantity: number,
  discount: Discount,
): { subtotal_cents: number; subtotal_discounted_cents: number } {
  // Exact sums as fractions over the product of the dens (structurally unlike the
  // engine's lcm).
  let den = 1n;
  for (const t of tiers) den *= BigInt(t.den);
  let sub = 0n;
  let off = 0n;
  const flatCents = discount?.type === "flat"
    ? roundRational(BigInt(Math.round(discount.rate * 10_000)), 100n) // whole cents first
    : 0n;
  for (const t of tiers) {
    const units = BigInt(quantity) * BigInt(t.num) * (den / BigInt(t.den));
    sub += BigInt(rates[t.rate_key]) * units;
    off += flatCents * units;
  }
  let disc: bigint;
  if (discount?.type === "percent") {
    const r6 = BigInt(Math.round(discount.rate * 1_000_000));
    disc = roundRational(sub * (100_000_000n - r6), den * 100_000_000n);
  } else disc = roundRational(sub - off, den);
  return {
    subtotal_cents: Number(roundRational(sub, den)),
    subtotal_discounted_cents: Number(disc),
  };
}

function randomDiscount(rand: () => number): Discount {
  const k = int(rand, 0, 2);
  if (k === 0) return null;
  if (k === 1) {
    return { type: "percent", rate: int(rand, 0, 1_000_000) / 10_000 };
  }
  return { type: "flat", rate: int(rand, 0, 50_000) / 100 };
}

Deno.test("(i) the money step is the exact rational rounded once, and keeps the retired calculateItemSubtotal's undiscounted money — 300k lines, one counter per arm", () => {
  const rand = lcg(20261031);
  // The retired form rounded the subtotal and then the discount; since the
  // single-rounding change it must still agree on an UNDISCOUNTED line and is
  // expected to disagree on some discounted ones (reported, and asserted > 0 as
  // the two-rounding companion).
  let vsLegacyUndiscounted = 0, vsLegacyDiscounted = 0, vsOracle = 0;
  let fiveDay = 0,
    fixed = 0,
    belowFloor = 0,
    negative = 0,
    percent = 0,
    flat = 0;
  // Companion arms, per arm: a divide-first SUBTOTAL (round the per-unit price
  // first) and a quantized-ratio DISCOUNT (form B).
  let wrongSubtotal = 0, wrongDiscount = 0;

  for (let i = 0; i < 300_000; i++) {
    const isFixed = rand() < 0.3;
    const base = int(rand, -20_000, 500_000);
    const quantity = int(rand, 1, 40);
    const days = int(rand, 0, 45);
    const discount = randomDiscount(rand);
    const formula = isFixed ? FIXED : FIVE_DAY_WEEK;
    const key = isFixed ? "flat" : "week";
    const tiers = statedUnits(formula, days, { minimum: true });
    const got = priceFromFormula(
      [{ rate_key: key, amount_cents: base }],
      tiers,
      quantity,
      discount,
    );

    const legacy = retiredSubtotal({
      quantity,
      price: {
        base_cents: base,
        formula: isFixed ? "fixed" : "five_day_week",
        chargeable_days: days,
        discount,
      },
    });
    if (
      got.subtotal_cents !== legacy.subtotal_cents ||
      got.subtotal_discounted_cents !== legacy.subtotal_discounted_cents
    ) {
      if (discount === null) vsLegacyUndiscounted++;
      else vsLegacyDiscounted++;
    }
    const exact = oracle({ [key]: base }, tiers, quantity, discount);
    if (
      got.subtotal_cents !== exact.subtotal_cents ||
      got.subtotal_discounted_cents !== exact.subtotal_discounted_cents
    ) vsOracle++;

    // Companion — subtotal arm: round the per-unit prorated price, then × qty.
    const t = tiers[0];
    const perUnit = roundRational(BigInt(base) * BigInt(t.num), BigInt(t.den));
    if (Number(perUnit * BigInt(quantity)) !== got.subtotal_cents) {
      wrongSubtotal++;
    }
    // Companion — discount arm: the quantized ratio (2dp) applied as a factor.
    if (discount?.type === "percent") {
      const factor = Math.round((100 - discount.rate) / 100 * 100) / 100;
      if (
        Math.round(got.subtotal_cents * factor) !==
          got.subtotal_discounted_cents
      ) wrongDiscount++;
    }

    if (isFixed) fixed++;
    else fiveDay++;
    if (!isFixed && days < 5) belowFloor++;
    if (base < 0) negative++;
    if (discount?.type === "percent") percent++;
    if (discount?.type === "flat") flat++;
  }

  assertEquals(vsLegacyUndiscounted, 0, "the engine disagrees with the retired calculateItemSubtotal on an undiscounted line");
  console.log(`the retired two-rounding form disagrees on ${vsLegacyDiscounted} discounted lines of 300,000`);
  assert(vsLegacyDiscounted > 0, "the two-rounding form never disagreed: the corpus does not discriminate");
  assertEquals(
    vsOracle,
    0,
    "the engine disagrees with the exact rational oracle",
  );
  // The domain was exercised, arm by arm.
  for (
    const [arm, n] of Object.entries({
      fiveDay,
      fixed,
      belowFloor,
      negative,
      percent,
      flat,
    })
  ) {
    assert(n > 10_000, `arm ${arm} barely ran: ${n}`);
  }
  // Each companion bites. Floors, not remembered counts (`cfs-money` rule 3).
  assert(
    wrongSubtotal > 1_000,
    `divide-first subtotal arm stopped discriminating: ${wrongSubtotal}`,
  );
  assert(
    wrongDiscount > 1_000,
    `quantized-ratio discount arm stopped discriminating: ${wrongDiscount}`,
  );
  console.log(
    `(i) companions: divide-first subtotal ${wrongSubtotal}, quantized-ratio discount ${wrongDiscount}`,
  );
});

Deno.test("(i) an extension section passes a signed count with no minimum, as the retired calculateItemSubtotal's extensionDays does", () => {
  for (const ext of [-7, -2, 0, 2, 4, 9]) {
    const tiers = statedUnits(FIVE_DAY_WEEK, ext, { minimum: false });
    const got = priceFromFormula(
      [{ rate_key: "week", amount_cents: 12_345 }],
      tiers,
      3,
      { type: "flat", rate: 1.5 },
    );
    const legacy = retiredSubtotal(
      {
        quantity: 3,
        price: {
          base_cents: 12_345,
          formula: "five_day_week",
          chargeable_days: 0,
          discount: { type: "flat", rate: 1.5 },
        },
      },
      { extensionDays: ext },
    );
    assertEquals(got, legacy, `extension ${ext}`);
  }
});

Deno.test("(i) metered windows: each window counts like countCfsBusinessDays, and several windows price as billableDays — 1k lines", () => {
  const rand = lcg(4242);
  const holidays = [
    "2026-01-01",
    "2026-05-25",
    "2026-07-03",
    "2026-09-07",
    "2026-11-26",
    "2026-12-25",
  ];
  let wrongCount = 0, wrongMoney = 0, multi = 0;
  // Companion: a minimum applied to the LINE's total instead of each window.
  let lineScopedDisagrees = 0;
  const LINE_SCOPED: PriceFormulaRule = {
    ...FIVE_DAY_WEEK,
    minimum: { units: 5, unit: "business_day", scope: "line" },
  };

  for (let i = 0; i < 1_000; i++) {
    const n = int(rand, 1, 3);
    let cursor = Date.UTC(2026, 0, 1) + int(rand, 0, 300) * 86_400_000;
    const windows: { start: string; end: string }[] = [];
    const counts: number[] = [];
    for (let w = 0; w < n; w++) {
      const s = new Date(cursor).toISOString().slice(0, 10);
      const e = new Date(cursor + int(rand, 0, 20) * 86_400_000).toISOString()
        .slice(0, 10);
      windows.push({
        start: `${s}T09:00:00.000-06:00`,
        end: `${e}T16:00:00.000-06:00`,
      });
      counts.push(
        countCfsBusinessDays(
          parseISO(s, { in: CHICAGO }),
          parseISO(e, { in: CHICAGO }),
          holidays,
        ).days,
      );
      cursor = Date.parse(e) + int(rand, 2, 10) * 86_400_000;
    }
    const metered = meterUnits(FIVE_DAY_WEEK, { windows, holidays });
    metered.windows.forEach((t, w) => {
      if (t[0].num * 5 !== Math.max(counts[w], 5) * t[0].den) wrongCount++;
    });
    // `lineChargeableDays`: one window keeps its raw count, 2+ store billableDays.
    const chargeable = n === 1 ? counts[0] : billableDays(counts);
    if (n > 1) multi++;
    const base = int(rand, 100, 90_000);
    const got = priceFromFormula(
      [{ rate_key: "week", amount_cents: base }],
      metered.tiers,
      2,
      null,
    );
    const legacy = retiredSubtotal({
      quantity: 2,
      price: {
        base_cents: base,
        formula: "five_day_week",
        chargeable_days: chargeable,
        discount: null,
      },
    });
    if (got.subtotal_cents !== legacy.subtotal_cents) wrongMoney++;
    const line = meterUnits(LINE_SCOPED, { windows, holidays });
    if (ratio(line.tiers[0]) !== ratio(metered.tiers[0])) lineScopedDisagrees++;
  }
  assertEquals(wrongCount, 0);
  assertEquals(wrongMoney, 0);
  assert(multi > 300, `multi-window arm barely ran: ${multi}`);
  assert(
    lineScopedDisagrees > 60,
    `line-scoped companion stopped discriminating: ${lineScopedDisagrees}`,
  );
});

// ── (ii) Supplier units: Vision ──────────────────────────────────────

const VISION_RATES = [{ rate_key: "week", amount_cents: 4_500 }, {
  rate_key: "month",
  amount_cents: 15_750,
}];

Deno.test("(ii) Vision: the Appendix A/B rentals meter to the weeks the SPENDs billed", () => {
  const cases: [string, string, number, number][] = [
    ["2025-05-12", "2025-05-19", 0, 1], // #452 — 14 HS × 1 wk = $630
    ["2025-05-22", "2025-05-27", 0, 1], // #466
    ["2025-12-24", "2026-01-04", 0, 2], // #795 — 11 nights = 2 wk
    ["2026-01-12", "2026-01-30", 0, 3], // #802
    ["2024-09-23", "2024-09-26", 0, 1], // #200
    ["2025-02-07", "2025-04-20", 2, 2], // a two-month block, then a 10-night tail
  ];
  for (const [s, e, months, weeks] of cases) {
    const m = meterUnits(VISION, {
      windows: [{ start: day(s), end: day(e) }],
      holidays: [],
      rates: VISION_RATES,
    });
    assertEquals(
      m.tiers.map(ratio),
      [`${months}/1`, `${weeks}/1`],
      `${s} → ${e}`,
    );
  }
  const a = meterUnits(VISION, {
    windows: [{ start: day("2025-05-12"), end: day("2025-05-19") }],
    holidays: [],
    rates: VISION_RATES,
  });
  assertEquals(
    priceFromFormula(VISION_RATES, a.tiers, 14, null).subtotal_cents,
    63_000,
  );
});

const VISION_RATES_2024 = [{ rate_key: "week", amount_cents: 4_500 }, {
  rate_key: "month",
  amount_cents: 13_500,
}];

/** The pre-Q14 ladder: whole months, then uncapped weeks — the companion. */
const VISION_UNCAPPED: PriceFormulaRule = {
  ...VISION,
  segments: [{ ...VISION.segments[0], consume: "whole" }, VISION.segments[1]],
};

Deno.test("(ii) Q14: a Vision month is capped at the month PRICE, decided per anchored period at the line's own rates", () => {
  const meter = (s: string, e: string, rates: typeof VISION_RATES) =>
    meterUnits(VISION, { windows: [{ start: day(s), end: day(e) }], holidays: [], rates });
  const bill = (s: string, e: string, rates: typeof VISION_RATES) =>
    priceFromFormula(rates, meter(s, e, rates).tiers, 1, null).subtotal_cents;

  // V246: 27 nights in 2024 → four started weeks ($180) ≥ $135, so one block.
  assertEquals(meter("2024-04-03", "2024-04-30", VISION_RATES_2024).tiers.map(ratio), ["1/1", "0/1"]);
  assertEquals(bill("2024-04-03", "2024-04-30", VISION_RATES_2024), 13_500);
  // Companion: the uncapped ladder bills V246 four weeks.
  const uncapped = meterUnits(VISION_UNCAPPED, {
    windows: [{ start: day("2024-04-03"), end: day("2024-04-30") }],
    holidays: [],
  });
  assertEquals(uncapped.tiers.map(ratio), ["0/1", "4/1"]);
  assertEquals(priceFromFormula(VISION_RATES_2024, uncapped.tiers, 1, null).subtotal_cents, 18_000);

  // #802: 18 nights → three weeks. At 2026 rates $135 < $157.50 stays weeks;
  // at 2024 rates $135 ≥ $135 caps — the decision moves with the rate era.
  assertEquals(meter("2026-01-12", "2026-01-30", VISION_RATES).tiers.map(ratio), ["0/1", "3/1"]);
  assertEquals(meter("2026-01-12", "2026-01-30", VISION_RATES_2024).tiers.map(ratio), ["1/1", "0/1"]);
  // 22 nights at 2026 rates: four weeks ($180) ≥ $157.50 → a block.
  assertEquals(meter("2026-01-01", "2026-01-23", VISION_RATES).tiers.map(ratio), ["1/1", "0/1"]);
  assertEquals(meter("2026-01-01", "2026-01-22", VISION_RATES).tiers.map(ratio), ["0/1", "3/1"]);

  // A 60-night run (#690's shape): a full month, then 29 nights → capped.
  assertEquals(meter("2025-12-01", "2026-01-30", VISION_RATES).tiers.map(ratio), ["2/1", "0/1"]);
  assertEquals(bill("2025-12-01", "2026-01-30", VISION_RATES), 31_500);

  // A capped formula refuses to meter without its rates.
  assertThrows(
    () => meterUnits(VISION, { windows: [{ start: day("2026-01-01"), end: day("2026-01-08") }], holidays: [] }),
    Error,
    "rates",
  );
});

Deno.test("(ii) Vision restarts at every window — the accumulating (billablePeriods) anchor is the companion, and it disagrees", () => {
  // Two windows inside one week of the first switch-on.
  const two = [
    { start: day("2026-03-02"), end: day("2026-03-04") },
    { start: day("2026-03-06"), end: day("2026-03-08") },
  ];
  assertEquals(
    meterUnits(VISION, { windows: two, holidays: [], rates: VISION_RATES }).tiers.map(ratio),
    ["0/1", "2/1"],
  );
  assertEquals(accumulatingWeeks(two), 1);
});

/** `billablePeriods`' rule: 7-day periods from the FIRST window's start; a period bills iff any night touches it. */
function accumulatingWeeks(
  windows: readonly { start: string; end: string }[],
): number {
  const anchor = parseISO(windows[0].start, { in: CHICAGO });
  const touched = new Set<number>();
  for (const w of windows) {
    const s = differenceInCalendarDays(
      parseISO(w.start, { in: CHICAGO }),
      anchor,
    );
    const e = differenceInCalendarDays(
      parseISO(w.end, { in: CHICAGO }),
      anchor,
    );
    for (let d = s; d < e; d++) touched.add(Math.floor(d / 7));
  }
  return touched.size;
}

/**
 * An independent Vision oracle on date-fns: whole months by `addMonths` from the
 * start; the part-month tail is one more month when its started weeks cost at
 * least the month (Q14), else ceil weeks.
 */
function visionOracle(
  start: string,
  end: string,
  week: number,
  month: number,
): [number, number] {
  const s = parseISO(start, { in: CHICAGO });
  const e = parseISO(end, { in: CHICAGO });
  let months = 0;
  while (differenceInCalendarDays(e, addMonths(s, months + 1)) >= 0) months++;
  const rest = differenceInCalendarDays(e, addMonths(s, months));
  const weeks = Math.ceil(rest / 7);
  return weeks * week >= month ? [months + 1, 0] : [months, weeks];
}

Deno.test("(ii) Vision vs a date-fns oracle — 10k windows; the accumulating anchor disagrees on multi-window lines", () => {
  const rand = lcg(31);
  let wrong = 0,
    withMonth = 0,
    withTail = 0,
    monthEnd = 0,
    multi = 0,
    capped = 0,
    accumulateDisagrees = 0;
  for (let i = 0; i < 10_000; i++) {
    const rates = rand() < 0.5 ? VISION_RATES : VISION_RATES_2024;
    const week = rates.find((r) => r.rate_key === "week")!.amount_cents;
    const month = rates.find((r) => r.rate_key === "month")!.amount_cents;
    const startDay = Date.UTC(2023, 9, 1) + int(rand, 0, 1_000) * 86_400_000;
    const windows: { start: string; end: string }[] = [];
    let cursor = startDay;
    const n = rand() < 0.3 ? int(rand, 2, 3) : 1;
    for (let w = 0; w < n; w++) {
      const len = int(rand, 1, 140);
      const s = new Date(cursor).toISOString().slice(0, 10);
      const e = new Date(cursor + len * 86_400_000).toISOString().slice(0, 10);
      windows.push({ start: day(s), end: day(e) });
      cursor += (len + int(rand, 1, 6)) * 86_400_000;
      if (s.endsWith("-31") || s.endsWith("-30") || s.endsWith("-29")) {
        monthEnd++;
      }
    }
    const m = meterUnits(VISION, { windows, holidays: [], rates });
    m.windows.forEach((t, w) => {
      const [months, weeks] = visionOracle(windows[w].start, windows[w].end, week, month);
      if (t[0].num !== months || t[1].num !== weeks) wrong++;
      const plain = visionOracle(windows[w].start, windows[w].end, 0, 1);
      if (months !== plain[0]) capped++;
      if (months > 0) withMonth++;
      if (weeks > 0) withTail++;
    });
    if (n > 1) {
      multi++;
      // The anchor companion reads the UNCAPPED ladder: it tests restart vs
      // accumulate, and the cap would absorb most of its domain.
      const u = meterUnits(VISION_UNCAPPED, { windows, holidays: [] });
      const weeksOnly = u.windows.reduce(
        (k, t) => k + (t[0].num === 0 ? t[1].num : 0),
        0,
      );
      if (
        u.windows.every((t) => t[0].num === 0) &&
        weeksOnly !== accumulatingWeeks(windows)
      ) accumulateDisagrees++;
    }
  }
  assertEquals(wrong, 0);
  for (
    const [arm, n] of Object.entries({ withMonth, withTail, monthEnd, multi, capped })
  ) assert(n > 150, `arm ${arm} barely ran: ${n}`);
  assert(
    accumulateDisagrees > 20,
    `accumulating companion stopped discriminating: ${accumulateDisagrees}`,
  );
});

Deno.test("(ii) a month anchored on the 31st lands on each month's last day, computed from the anchor", () => {
  // Jan 31 → Feb 28 → Mar 31: two whole months by Mar 31, none if chained (Feb 28 → Mar 28).
  // Uncapped, so the anchor alone decides (the cap would absorb a 30-night tail).
  const m = meterUnits(VISION_UNCAPPED, {
    windows: [{ start: day("2026-01-31"), end: day("2026-03-31") }],
    holidays: [],
  });
  assertEquals(m.tiers.map(ratio), ["2/1", "0/1"]);
  const short = meterUnits(VISION_UNCAPPED, {
    windows: [{ start: day("2026-01-31"), end: day("2026-03-30") }],
    holidays: [],
  });
  assertEquals(short.tiers.map(ratio), ["1/1", "5/1"]); // Feb 28 → Mar 30 is 30 nights
});

// ── (iii) Verizon: prorated month on day 2, with the gap allowance ───

Deno.test("(iii) Verizon: a full period is one month, a part period its fraction of THAT month", () => {
  const span = { start: day("2026-01-02"), end: day("2026-02-02") };
  assertEquals(
    meterUnits(VERIZON, { windows: [span], span, holidays: [] }).tiers.map(
      ratio,
    ),
    ["1/1"],
  );
  const part = { start: day("2026-01-02"), end: day("2026-01-17") };
  assertEquals(
    meterUnits(VERIZON, { windows: [part], span: part, holidays: [] }).tiers
      .map(ratio),
    ["15/31"],
  );
  const feb = { start: day("2026-02-10"), end: day("2026-03-02") };
  assertEquals(
    meterUnits(VERIZON, { windows: [feb], span: feb, holidays: [] }).tiers.map(
      ratio,
    ),
    ["5/7"],
  ); // 20/28

  // Companion: anchored on CALENDAR months the same full Verizon period is not one.
  const calendar: PriceFormulaRule = {
    ...VERIZON,
    segments: [{ ...VERIZON.segments[0], anchor: { day_of_month: 1 } }],
  };
  const c =
    meterUnits(calendar, { windows: [span], span, holidays: [] }).tiers[0];
  assert(
    ratio(c) !== "1/1",
    `a calendar anchor billed exactly one month (${
      ratio(c)
    }) — the companion is vacuous`,
  );
});

Deno.test("(iii) Verizon: 30 free gap nights per rolling 12 months, then billing resumes", () => {
  // A 40-night suspension Mar 2 → Apr 11: 30 free (Mar 2–31), Apr 1–10 metered.
  const span = { start: day("2026-01-02"), end: day("2026-07-02") };
  const windows = [
    { start: day("2026-01-02"), end: day("2026-03-02") },
    { start: day("2026-04-11"), end: day("2026-07-02") },
  ];
  const m = meterUnits(VERIZON, { windows, span, holidays: [] });
  // Jan, Feb, May, Jun whole; [Mar 2, Apr 2) holds Apr 1 only = 1/31; [Apr 2, May 2) all 30 nights.
  assertEquals(m.tiers.map(ratio), [`${5 * 31 + 1}/31`]);

  // Rolling: a second 20-night gap two months after a first 20-night one gets 10 free.
  const span2 = { start: day("2026-01-02"), end: day("2026-06-02") };
  const w2 = [
    { start: day("2026-01-02"), end: day("2026-01-10") },
    { start: day("2026-01-30"), end: day("2026-03-10") },
    { start: day("2026-03-30"), end: day("2026-06-02") },
  ];
  const nights = differenceInCalendarDays(
    parseISO("2026-06-02"),
    parseISO("2026-01-02"),
  );
  const metered = meterUnits(VERIZON, {
    windows: w2,
    span: span2,
    holidays: [],
  });
  const noGaps = meterUnits(VERIZON, {
    windows: [span2],
    span: span2,
    holidays: [],
  });
  assertEquals(noGaps.tiers.map(ratio), ["5/1"]);
  // Gaps Jan 10–29 (20 nights, all free) and Mar 10–29 (10 free, Mar 20–29
  // metered): [Jan 2, Feb 2) = 11/31, Feb whole, [Mar 2, Apr 2) = 21/31, Apr, May whole.
  assertEquals(metered.tiers.map(ratio), [`${3 * 31 + 11 + 21}/31`]);
  assert(nights > 100);

  // Companion: with NO allowance every gap night is free, so the second gap is free too.
  const free: PriceFormulaRule = {
    ...VERIZON,
    meter: { ...VERIZON.meter, gap_allowance: null },
  };
  assert(
    ratio(
      meterUnits(free, { windows: w2, span: span2, holidays: [] }).tiers[0],
    ) !== ratio(metered.tiers[0]),
  );
});

/** Independent Verizon oracle on date-fns: periods [day 2, next day 2), nights covered / nights in period. */
function verizonOracle(
  start: string,
  end: string,
): { num: number; den: number }[] {
  const s = parseISO(start, { in: CHICAGO });
  const e = parseISO(end, { in: CHICAGO });
  // A Chicago TZDate, not `new Date(s)`: a plain Date does its calendar
  // arithmetic in the MACHINE's zone, so the anchors moved with TZ and the
  // oracle disagreed with the (zone-independent) engine on 1,038 of 5k spans
  // under CI's UTC while agreeing on all of them in Chicago.
  let p = parseISO(start, { in: CHICAGO });
  p.setDate(2);
  if (s.getDate() < 2) p = addMonths(p, -1);
  const out: { num: number; den: number }[] = [];
  while (differenceInCalendarDays(e, p) > 0) {
    const q = addMonths(p, 1);
    const from = differenceInCalendarDays(s, p) > 0 ? s : p;
    const to = differenceInCalendarDays(q, e) > 0 ? e : q;
    out.push({
      num: differenceInCalendarDays(to, from),
      den: differenceInCalendarDays(q, p),
    });
    p = q;
  }
  return out;
}

Deno.test("(iii) Verizon vs a date-fns oracle — 5k gapless spans, summed exactly", () => {
  const rand = lcg(7);
  let wrong = 0, partial = 0, whole = 0;
  for (let i = 0; i < 5_000; i++) {
    const s0 = Date.UTC(2024, 0, 1) + int(rand, 0, 900) * 86_400_000;
    const s = new Date(s0).toISOString().slice(0, 10);
    const e = new Date(s0 + int(rand, 1, 400) * 86_400_000).toISOString().slice(
      0,
      10,
    );
    const span = { start: day(s), end: day(e) };
    const got =
      meterUnits(VERIZON, { windows: [span], span, holidays: [] }).tiers[0];
    const parts = verizonOracle(span.start, span.end);
    // Σ num_i/den_i compared to got by cross-multiplication in BigInt.
    let n = 0n, d = 1n;
    for (const p of parts) {
      n = n * BigInt(p.den) + BigInt(p.num) * d;
      d *= BigInt(p.den);
      if (p.num === p.den) whole++;
      else partial++;
    }
    if (n * BigInt(got.den) !== BigInt(got.num) * d) wrong++;
  }
  assertEquals(wrong, 0);
  assert(
    partial > 1_500 && whole > 1_500,
    `arms: partial ${partial}, whole ${whole}`,
  );
});

// ── Stated counts and rates ──────────────────────────────────────────

Deno.test("statedUnits refuses a ladder and a fractional count", () => {
  assertThrows(() => statedUnits(VISION, 10, { minimum: true }));
  assertThrows(() => statedUnits(VERIZON, 10, { minimum: true }));
  assertThrows(() => statedUnits(FIVE_DAY_WEEK, 2.5, { minimum: true }));
  assertEquals(statedUnits(FIXED, 99, { minimum: true }).map(ratio), ["1/1"]);
});

Deno.test("priceFromFormula refuses a tier with no rate", () => {
  assertThrows(
    () => priceFromFormula([], [{ rate_key: "week", num: 1, den: 1 }], 1, null),
    Error,
    `No rate for key "week"`,
  );
});

Deno.test("rateInForce compares instants, not strings; snapshotRates names a missing key", () => {
  // Vision's month moved on 2025-02-01; its week never did.
  const rates = [
    {
      rate_key: "week",
      amount_cents: 4_500,
      applied_from: "2023-01-01T00:00:00.000-06:00",
      applied_to: null,
    },
    {
      rate_key: "month",
      amount_cents: 13_500,
      applied_from: "2023-01-01T00:00:00.000-06:00",
      applied_to: "2025-02-01T00:00:00.000-06:00",
    },
    {
      rate_key: "month",
      amount_cents: 15_750,
      applied_from: "2025-02-01T00:00:00.000-06:00",
      applied_to: null,
    },
  ];
  assertEquals(snapshotRates(VISION, rates, "2025-01-31T23:00:00.000-06:00"), [
    { rate_key: "month", amount_cents: 13_500 },
    { rate_key: "week", amount_cents: 4_500 },
  ]);
  assertEquals(
    rateInForce(rates, "month", "2025-02-01T00:00:00.000-06:00")?.amount_cents,
    15_750,
  );
  // 2025-07-01T00:30-05:00 sorts BEFORE 2025-07-01T01:00-06:00 lexically and is
  // still the earlier instant; the trap is the reverse case below, where the
  // later string is the EARLIER instant.
  const dst = [{
    rate_key: "x",
    amount_cents: 1,
    applied_from: "2025-03-09T01:30:00.000-06:00",
    applied_to: null,
  }];
  assertEquals(
    rateInForce(dst, "x", "2025-03-09T03:15:00.000-05:00")?.amount_cents,
    1,
  ); // 08:15Z ≥ 07:30Z
  assertEquals(rateInForce(dst, "x", "2025-03-09T02:15:00.000-05:00"), null); // 07:15Z < 07:30Z, though "02" > "01"
  assertThrows(
    () =>
      snapshotRates(VISION, rates.slice(0, 1), "2024-01-01T00:00:00.000-06:00"),
    Error,
    `No "month" rate`,
  );
});

Deno.test("an input price names its formula by uid_price_formula, and a percent fee naming one is refused", async () => {
  const { ItemPrice } = await import("../src/schemas/order.ts");
  assert(ItemPrice.safeParse({ uid_price_formula: "AAAAAAAAAAAAAAAAAAAA", rates: [] }).success);
  assert(ItemPrice.safeParse({ base_percent: 4 }).success);
  const both = ItemPrice.safeParse({ uid_price_formula: "AAAAAAAAAAAAAAAAAAAA", base_percent: 4 });
  assert(!both.success);
  assertEquals(both.error!.issues[0].path, ["price_formula"]);
});

// ── formulaPeriods: the report's billed periods (Q9) ─────────────────

Deno.test("formulaPeriods: Vision's month restarts at every window; month-end anchors on the last day", () => {
  const windows = [
    { start: "2026-01-31T09:00:00.000-06:00", end: "2026-03-05T09:00:00.000-06:00" },
    { start: "2026-03-10T09:00:00.000-05:00", end: "2026-03-12T09:00:00.000-05:00" },
  ];
  const got = formulaPeriods(VISION, { windows }, { start: "2026-02-01", end: "2026-04-01" });
  assertEquals(got, [
    { start: "2026-01-31", end: "2026-02-28" },
    { start: "2026-02-28", end: "2026-03-31" },
    { start: "2026-03-10", end: "2026-04-10" },
  ]);
  // Companion: one anchor across both windows would put the second window inside [02-28, 03-31).
  assert(got.some((p) => p.start === "2026-03-10"), "the second window restarts the count");
});

Deno.test("formulaPeriods: Verizon's months fall on the 2nd across the SPAN, on or off; a flat formula cuts none", () => {
  const span = { start: "2026-01-15T00:00:00.000-06:00", end: "2026-03-20T00:00:00.000-05:00" };
  const got = formulaPeriods(VERIZON, { windows: [], span }, { start: "2026-02-01", end: "2026-03-01" });
  assertEquals(got, [{ start: "2026-01-02", end: "2026-02-02" }, { start: "2026-02-02", end: "2026-03-02" }]);
  assertEquals(formulaPeriods(FIXED, { windows: [span] }, { start: "2026-01-01", end: "2027-01-01" }), []);
});

Deno.test("formulaPeriods: a week segment walks 7 days from each window's start, clipped to the range", () => {
  const windows = [{ start: "2026-01-05T09:00:00.000-06:00", end: "2026-01-20T09:00:00.000-06:00" }];
  assertEquals(formulaPeriods(FIVE_DAY_WEEK, { windows }, { start: "2026-01-10", end: "2026-02-01" }), [
    { start: "2026-01-05", end: "2026-01-12" },
    { start: "2026-01-12", end: "2026-01-19" },
    { start: "2026-01-19", end: "2026-01-26" },
  ]);
});

Deno.test("formulaPeriods: a range ending MID-DAY keeps that day's periods; a midnight end excludes its day", () => {
  // Switched on at 22:52 and reported at 22:53 the same evening — the report's `as_of`.
  const windows = [{ start: "2026-10-31T22:52:30.000-05:00", end: "2026-10-31T22:53:30.000-05:00" }];
  assertEquals(
    formulaPeriods(VISION, { windows }, { start: "2026-10-01T00:00:00.000-05:00", end: "2026-10-31T22:53:30.000-05:00" }),
    [{ start: "2026-10-31", end: "2026-11-30" }],
  );
  // Companion: a range that ends at that day's Chicago midnight does not reach it.
  assertEquals(
    formulaPeriods(VISION, { windows }, { start: "2026-10-01T00:00:00.000-05:00", end: "2026-10-31T00:00:00.000-05:00" }),
    [],
  );
});

// ── The catalog rate edit (D4, core#146) ─────────────────────────────

const JAN1 = "2026-01-01T00:00:00.000-06:00";
const OCT5 = "2026-10-05T00:00:00.000-05:00";
const weekRow = (over: Partial<DatedRate> = {}): DatedRate => ({
  uid: "row-1",
  rate_key: "week",
  amount_cents: 1000,
  applied_from: JAN1,
  applied_to: null,
  ...over,
});
const mint = (...uids: string[]) => () => uids.shift() ?? "row-x";

Deno.test("withOpenRateAmount: a change closes the open row on the Chicago day and opens a new one; the result is a legal dated array", () => {
  const out = withOpenRateAmount([weekRow()], "week", 1200, "2026-10-05T15:00:00.000Z", mint("row-2"));
  assertEquals(out, [
    weekRow({ applied_to: OCT5 }),
    { uid: "row-2", rate_key: "week", amount_cents: 1200, applied_from: OCT5, applied_to: null },
  ]);
  assertEquals(datedRatesIssues(out), []);
});

Deno.test("withOpenRateAmount: the day is CHICAGO's — 02:00 UTC on Oct 5 is still Oct 4 there", () => {
  const out = withOpenRateAmount([weekRow()], "week", 1200, "2026-10-05T02:00:00.000Z", mint("row-2"));
  assertEquals(out[1].applied_from, "2026-10-04T00:00:00.000-05:00");
  assertEquals(out[0].applied_to, "2026-10-04T00:00:00.000-05:00");
});

Deno.test("withOpenRateAmount: a second change the SAME day overwrites that day's row — no zero-length row", () => {
  const once = withOpenRateAmount([weekRow()], "week", 1200, "2026-10-05T15:00:00.000Z", mint("row-2"));
  const twice = withOpenRateAmount(once, "week", 1300, "2026-10-05T20:00:00.000Z", mint("row-3"));
  assertEquals(twice.length, 2);
  assertEquals(twice[1], { uid: "row-2", rate_key: "week", amount_cents: 1300, applied_from: OCT5, applied_to: null });
  assertEquals(datedRatesIssues(twice), []);
  // Companion: the close-and-open form on the same day IS what the refine refuses.
  const stacked: DatedRate[] = [...once.slice(0, 1), { ...once[1], applied_to: OCT5 }, { ...once[1], uid: "row-3", amount_cents: 1300 }];
  assert(datedRatesIssues(stacked).length > 0);
});

Deno.test("withOpenRateAmount: an unchanged amount moves nothing; a key with no open row gains one; other keys are untouched", () => {
  const rows = [weekRow(), { ...weekRow(), uid: "row-m", rate_key: "month", amount_cents: 4000 }];
  assertEquals(withOpenRateAmount(rows, "week", 1000, "2026-10-05T15:00:00.000Z"), rows);
  assertEquals(withOpenRateAmount([], "week", 500, "2026-10-05T15:00:00.000Z", mint("row-2")), [
    { uid: "row-2", rate_key: "week", amount_cents: 500, applied_from: OCT5, applied_to: null },
  ]);
  const moved = withOpenRateAmount(rows, "week", 1200, "2026-10-05T15:00:00.000Z", mint("row-2"));
  assertEquals(moved[1], rows[1]);
});

Deno.test("withOpenRateAmount: every row of the result is a fresh object and the input is not mutated (a store may hold it)", () => {
  const rows = [weekRow({ applied_to: "2026-06-01T00:00:00.000-05:00" }), weekRow({ uid: "row-2", applied_from: "2026-06-01T00:00:00.000-05:00" })];
  const before = structuredClone(rows);
  for (const amount of [1000, 1200]) {
    const out = withOpenRateAmount(rows, "week", amount, "2026-10-05T15:00:00.000Z");
    for (const r of rows) assert(!out.includes(r), `amount ${amount}: an input row is aliased into the result`);
  }
  assertEquals(rows, before);
  assert(withOpenRateAmount(rows, "week", 1000, "2026-10-05T15:00:00.000Z") !== rows);
});

Deno.test("openRateAmount: the open row's amount, else null — a closed-only key and a missing array are null", () => {
  assertEquals(openRateAmount([weekRow({ applied_to: OCT5 }), weekRow({ uid: "row-2", applied_from: OCT5, amount_cents: 1200 })], "week"), 1200);
  assertEquals(openRateAmount([weekRow({ applied_to: OCT5 })], "week"), null);
  assertEquals(openRateAmount([weekRow()], "month"), null);
  assertEquals(openRateAmount(undefined, "week"), null);
  assertEquals(openRateAmount(null, "week"), null);
});

Deno.test("ratesForFormula: a shared key keeps its whole history, a new key opens at the first open amount, a dropped key's rows go", () => {
  const history = [weekRow({ applied_to: OCT5 }), weekRow({ uid: "row-2", applied_from: OCT5, amount_cents: 1200 })];
  const onVision = ratesForFormula(history, VISION, "2026-10-20T15:00:00.000Z", mint("row-m"));
  assertEquals(onVision.filter((r) => r.rate_key === "week"), history);
  assertEquals(onVision.filter((r) => r.rate_key === "month"), [
    { uid: "row-m", rate_key: "month", amount_cents: 1200, applied_from: "2026-10-20T00:00:00.000-05:00", applied_to: null },
  ]);
  assertEquals(datedRatesIssues(onVision), []);
  const onFixed = ratesForFormula(onVision, FIXED, "2026-10-21T15:00:00.000Z", mint("row-f"));
  assertEquals(onFixed, [
    { uid: "row-f", rate_key: "flat", amount_cents: 1200, applied_from: "2026-10-21T00:00:00.000-05:00", applied_to: null },
  ]);
  assertEquals(ratesForFormula([], FIXED, "2026-10-21T15:00:00.000Z", mint("row-f"))[0].amount_cents, 0);
});
