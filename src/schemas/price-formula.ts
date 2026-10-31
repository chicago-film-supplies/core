/**
 * PriceFormula document schema — Firestore collection: price-formulas
 *
 * **How time becomes money on a line.** A formula is the RULE; the money it
 * multiplies is a separately dated RATE (`rate_key` → an absolute
 * `amount_cents`), the way a tax class names codes and the codes carry dated
 * rates. Purchases-as-documents D1/D4
 * (`api-cloudrun/.claude/plans/purchases-as-documents.md`).
 *
 * ```
 * metered time  = meter(windows | span − free gaps | nothing)
 * tier counts   = the segment ladder, largest period first, the remainder last
 * money         = Σ tier  rate[tier.rate_key] × quantity × count   (rounded once per tier)
 * ```
 *
 * The engine is `@cfs/core/utils/price-formulas` (`meterUnits`,
 * `priceFromFormula`); this file is the shape and the single-document rules.
 *
 * ## Vendor-agnostic, and immutable once referenced
 *
 * There are no vendor-shaped rule types (owner, 2026-10-31, Q4). Five-day week,
 * Fixed, Vision's "weekly while on, monthly blocks" and Verizon's "monthly
 * unless suspended" are all rows of this one shape. A formula a line has priced
 * with is never edited — a change is a NEW formula, the old one goes
 * `active: false` with `uid_superseded_by`. A rate change is not a formula
 * change: rates are dated inputs, never part of the rule.
 *
 * ## Day conventions — read before writing a formula
 *
 * - `calendar_day` counts the NIGHTS a window spans: Chicago dates from the
 *   start date up to, not including, the end date. Vision's "5/12–5/19 is one
 *   week" (Appendix A, case A) is only true on this convention.
 * - `business_day` counts business DATES inclusive of both ends, skipping
 *   weekends and CFS holidays — exactly `countCfsBusinessDays`, which is how
 *   every stored customer `charge_windows[].days` was counted.
 *
 * ## Divergences from the plan's sketch (recorded so they are not "fixed")
 *
 * - `anchor` is `null` on a `week`/`day`/`none` segment: those are COUNT
 *   segments, priced from how many metered days remain, so no anchor exists to
 *   state. The plan's `"calendar"` member is dropped as identical to
 *   `{ day_of_month: 1 }`.
 * - `gap_allowance` is `{ free_days, per_months }`: rolling and per-line are
 *   the only modes any researched product has, so single-member literals for
 *   them would be noise. Verizon's published allowances are in days (30/90/180).
 * - `uid_superseded_by` is required-and-nullable rather than optional — a new
 *   collection has no corpus to be lenient about.
 */
import { z } from "zod";
import { FirestoreId } from "./_uid.ts";
import { chicagoStartOfDay } from "./_datetime.ts";
import {
  ActorRef,
  type ActorRefType,
  type FirestoreTimestampType,
  TimestampFields,
} from "./common.ts";

// ── Vocabularies ─────────────────────────────────────────────────────

const METER_SOURCES = ["windows", "span_less_gaps", "none"] as const;
/**
 * WHAT time counts.
 *
 * - `windows` — only the line's charge windows (Five-day week, Vision). Each
 *   window is metered on its own: a `window_start` anchor restarts at every
 *   window (Q1, Q5).
 * - `span_less_gaps` — the line's whole span, minus the gaps between windows
 *   the allowance forgives (Verizon: a gap is a suspension).
 * - `none` — no time; a flat amount (Fixed).
 */
export type PriceFormulaMeterSource = typeof METER_SOURCES[number];
/** Zod schema for {@link PriceFormulaMeterSource}. */
export const PriceFormulaMeterSourceEnum: z.ZodType<PriceFormulaMeterSource> = z
  .enum(METER_SOURCES);

const METER_COUNTS = ["calendar_day", "business_day"] as const;
/** Which days count. See the module docblock for the two conventions. */
export type PriceFormulaMeterCount = typeof METER_COUNTS[number];
/** Zod schema for {@link PriceFormulaMeterCount}. */
export const PriceFormulaMeterCountEnum: z.ZodType<PriceFormulaMeterCount> = z
  .enum(METER_COUNTS);

const SEGMENT_UNITS = ["month", "week", "day", "none"] as const;
/**
 * A segment's period. `month` is a CALENDAR period walked from its anchor;
 * `week` and `day` are COUNT periods (a week is `divisor ?? 7` counted days);
 * `none` is the single period of a flat formula.
 */
export type PriceFormulaSegmentUnit = typeof SEGMENT_UNITS[number];
/** Zod schema for {@link PriceFormulaSegmentUnit}. */
export const PriceFormulaSegmentUnitEnum: z.ZodType<PriceFormulaSegmentUnit> = z
  .enum(SEGMENT_UNITS);

const SEGMENT_CONSUME = ["whole", "remainder"] as const;
/** `whole` takes only complete periods and passes the rest on; `remainder` prices what is left. */
export type PriceFormulaSegmentConsume = typeof SEGMENT_CONSUME[number];
/** Zod schema for {@link PriceFormulaSegmentConsume}. */
export const PriceFormulaSegmentConsumeEnum: z.ZodType<
  PriceFormulaSegmentConsume
> = z.enum(SEGMENT_CONSUME);

const SEGMENT_ROUNDING = ["floor", "ceil", "prorate"] as const;
/** How a partial period counts: not at all, as a whole one, or as its fraction. */
export type PriceFormulaSegmentRounding = typeof SEGMENT_ROUNDING[number];
/** Zod schema for {@link PriceFormulaSegmentRounding}. */
export const PriceFormulaSegmentRoundingEnum: z.ZodType<
  PriceFormulaSegmentRounding
> = z.enum(SEGMENT_ROUNDING);

const MINIMUM_UNITS = ["business_day", "day", "week"] as const;
/** The unit a minimum is stated in. Must agree with the meter's count (refine). */
export type PriceFormulaMinimumUnit = typeof MINIMUM_UNITS[number];
/** Zod schema for {@link PriceFormulaMinimumUnit}. */
export const PriceFormulaMinimumUnitEnum: z.ZodType<PriceFormulaMinimumUnit> = z
  .enum(MINIMUM_UNITS);

const MINIMUM_SCOPES = ["window", "line"] as const;
/** Whether a minimum floors each window (Five-day week) or the line's total. */
export type PriceFormulaMinimumScope = typeof MINIMUM_SCOPES[number];
/** Zod schema for {@link PriceFormulaMinimumScope}. */
export const PriceFormulaMinimumScopeEnum: z.ZodType<PriceFormulaMinimumScope> =
  z.enum(MINIMUM_SCOPES);

// ── Fragments ────────────────────────────────────────────────────────

/** A rate key: names a dated rate row, never an amount. */
export const RateKey: z.ZodType<string> = z.string().regex(
  /^[a-z][a-z0-9_]*$/,
  "lower_snake_case",
).max(40);

/**
 * Free suspension time per line, over a ROLLING window: a gap day is free while
 * fewer than `free_days` gap days were free in the `per_months` months up to
 * and including it. Gap days beyond it are metered again (Verizon, Q2).
 */
export interface PriceFormulaGapAllowance {
  free_days: number;
  per_months: number;
}

const gapAllowanceShape = {
  free_days: z.int().min(1).max(366),
  per_months: z.int().min(1).max(60),
};
/** Zod schema for {@link PriceFormulaGapAllowance}. */
export const PriceFormulaGapAllowanceSchema: z.ZodType<
  PriceFormulaGapAllowance
> = z.strictObject(gapAllowanceShape);
const GapAllowanceInput: z.ZodType<PriceFormulaGapAllowance> = z.object(
  gapAllowanceShape,
);

/** WHAT time counts, and how. */
export interface PriceFormulaMeter {
  source: PriceFormulaMeterSource;
  count: PriceFormulaMeterCount;
  /** Only on `span_less_gaps`; `null` = every gap is free. */
  gap_allowance: PriceFormulaGapAllowance | null;
}

/** Zod schema for {@link PriceFormulaMeter}. */
export const PriceFormulaMeterSchema: z.ZodType<PriceFormulaMeter> = z
  .strictObject({
    source: PriceFormulaMeterSourceEnum,
    count: PriceFormulaMeterCountEnum,
    gap_allowance: PriceFormulaGapAllowanceSchema.nullable(),
  });
const MeterInput: z.ZodType<PriceFormulaMeter> = z.object({
  source: PriceFormulaMeterSourceEnum,
  count: PriceFormulaMeterCountEnum,
  gap_allowance: GapAllowanceInput.nullable(),
});

/** Where a `month` segment's periods start. */
export type PriceFormulaAnchor = "window_start" | { day_of_month: number };

/**
 * Zod schema for {@link PriceFormulaAnchor}. A `day_of_month` past a month's
 * last day anchors on that last day — a start on the 31st is the month's end,
 * defined once in `@cfs/core/utils/price-formulas`.
 */
export const PriceFormulaAnchorSchema: z.ZodType<PriceFormulaAnchor> = z.union([
  z.literal("window_start"),
  z.strictObject({ day_of_month: z.int().min(1).max(31) }),
]);
const AnchorInput: z.ZodType<PriceFormulaAnchor> = z.union([
  z.literal("window_start"),
  z.object({ day_of_month: z.int().min(1).max(31) }),
]);

/** One rung of the ladder. */
export interface PriceFormulaSegment {
  rate_key: string;
  unit: PriceFormulaSegmentUnit;
  /** Required on `month`, `null` on every count segment. */
  anchor: PriceFormulaAnchor | null;
  consume: PriceFormulaSegmentConsume;
  rounding: PriceFormulaSegmentRounding;
  /**
   * A METHOD constant, never a commercial term. On a count segment: counted days
   * per period (`5` = a five-business-day week); `null` = the unit's natural
   * length (week 7, day 1). On a `month`: `"days_in_period"` to prorate by the
   * period's own length, else `null`.
   */
  divisor: number | "days_in_period" | null;
}

const segmentLeaves = {
  rate_key: RateKey,
  unit: PriceFormulaSegmentUnitEnum,
  consume: PriceFormulaSegmentConsumeEnum,
  rounding: PriceFormulaSegmentRoundingEnum,
  divisor: z.union([z.int().min(1).max(31), z.literal("days_in_period")])
    .nullable(),
};
/** Zod schema for {@link PriceFormulaSegment}. */
export const PriceFormulaSegmentSchema: z.ZodType<PriceFormulaSegment> = z
  .strictObject({
    ...segmentLeaves,
    anchor: PriceFormulaAnchorSchema.nullable(),
  });
const SegmentInput: z.ZodType<PriceFormulaSegment> = z.object({
  ...segmentLeaves,
  anchor: AnchorInput.nullable(),
});

/** A floor on metered days, applied before the ladder's last (count) segment. */
export interface PriceFormulaMinimum {
  units: number;
  unit: PriceFormulaMinimumUnit;
  scope: PriceFormulaMinimumScope;
}

const minimumShape = {
  units: z.int().min(1).max(366),
  unit: PriceFormulaMinimumUnitEnum,
  scope: PriceFormulaMinimumScopeEnum,
};
/** Zod schema for {@link PriceFormulaMinimum}. */
export const PriceFormulaMinimumSchema: z.ZodType<PriceFormulaMinimum> = z
  .strictObject(minimumShape);
const MinimumInput: z.ZodType<PriceFormulaMinimum> = z.object(minimumShape);

/** The rule half of a formula — everything the engine reads. */
export interface PriceFormulaRule {
  meter: PriceFormulaMeter;
  segments: PriceFormulaSegment[];
  /**
   * Crossing into a bigger segment never re-prices earlier periods (Current RMS,
   * RMS Cloud). `"whole"` (Texada, Odoo) is a closed-enum extension no current
   * pattern needs.
   */
  reprice: "remainder";
  minimum: PriceFormulaMinimum | null;
}

// ── Single-document rules ────────────────────────────────────────────

const UNIT_RANK: Record<PriceFormulaSegmentUnit, number> = {
  month: 3,
  week: 2,
  day: 1,
  none: 0,
};

/**
 * Every rule a formula can break on its own. Exported so the input schemas and
 * the engine's own guard read the same list.
 *
 * Returns `{ path, message }[]`; empty means the rule is well-formed.
 */
export function priceFormulaRuleIssues(
  rule: PriceFormulaRule,
): { path: (string | number)[]; message: string }[] {
  const issues: { path: (string | number)[]; message: string }[] = [];
  const add = (path: (string | number)[], message: string) =>
    issues.push({ path, message });
  const { meter, segments, minimum } = rule;

  if (segments.length === 0) {
    add(["segments"], "A formula needs at least one segment.");
  }

  const keys = new Set<string>();
  segments.forEach((s, i) => {
    if (keys.has(s.rate_key)) {
      add(["segments", i, "rate_key"], `rate_key ${s.rate_key} repeats.`);
    }
    keys.add(s.rate_key);
  });

  if (meter.source === "none") {
    if (segments.length !== 1 || segments[0]?.unit !== "none") {
      add(
        ["segments"],
        "A `none` meter prices one flat segment of unit `none`.",
      );
    }
    if (minimum !== null) {
      add(["minimum"], "A `none` meter has no time to floor.");
    }
  } else {
    segments.forEach((s, i) => {
      if (s.unit === "none") {
        add(["segments", i, "unit"], "Unit `none` is only for a `none` meter.");
      }
    });
  }
  if (meter.gap_allowance !== null && meter.source !== "span_less_gaps") {
    add(
      ["meter", "gap_allowance"],
      "A gap allowance only applies to `span_less_gaps`.",
    );
  }
  if (meter.source === "span_less_gaps" && meter.count !== "calendar_day") {
    add(["meter", "count"], "`span_less_gaps` meters calendar days.");
  }

  segments.forEach((s, i) => {
    const last = i === segments.length - 1;
    if (i > 0 && UNIT_RANK[s.unit] >= UNIT_RANK[segments[i - 1].unit]) {
      add(
        ["segments", i, "unit"],
        "Segments run largest period first, strictly descending.",
      );
    }
    if (last && s.consume !== "remainder") {
      add(["segments", i, "consume"], "The last segment prices the remainder.");
    }
    if (!last && s.consume !== "whole") {
      add(
        ["segments", i, "consume"],
        "Only the last segment takes the remainder.",
      );
    }
    if (s.consume === "whole" && s.rounding !== "floor") {
      add(
        ["segments", i, "rounding"],
        "A `whole` segment counts complete periods only, so it rounds `floor`.",
      );
    }
    if (s.unit === "month") {
      if (s.anchor === null) {
        add(["segments", i, "anchor"], "A `month` segment needs an anchor.");
      }
      if (meter.count !== "calendar_day") {
        add(["segments", i, "unit"], "A `month` segment meters calendar days.");
      }
      if (s.rounding === "prorate" && s.divisor !== "days_in_period") {
        add(
          ["segments", i, "divisor"],
          "A prorated month divides by `days_in_period`.",
        );
      }
      if (s.rounding !== "prorate" && s.divisor !== null) {
        add(
          ["segments", i, "divisor"],
          "Only a prorated month states a divisor.",
        );
      }
    } else {
      if (s.anchor !== null) {
        add(["segments", i, "anchor"], "Only a `month` segment is anchored.");
      }
      if (s.divisor === "days_in_period") {
        add(
          ["segments", i, "divisor"],
          "`days_in_period` is for `month` segments.",
        );
      }
      if (s.unit === "none" && s.divisor !== null) {
        add(["segments", i, "divisor"], "A flat segment has no divisor.");
      }
      if (s.unit === "day" && s.divisor !== null) {
        add(["segments", i, "divisor"], "A day is one counted day.");
      }
      if (
        s.unit === "week" && meter.count === "business_day" &&
        s.divisor === null
      ) {
        add(
          ["segments", i, "divisor"],
          "A business-day week states how many days it has.",
        );
      }
    }
  });

  if (minimum !== null) {
    const wantsBusiness = minimum.unit === "business_day";
    if (wantsBusiness !== (meter.count === "business_day")) {
      add(["minimum", "unit"], "A minimum is stated in the meter's own days.");
    }
    const tail = segments[segments.length - 1];
    if (tail && tail.unit !== "week" && tail.unit !== "day") {
      add(
        ["minimum"],
        "A minimum tops up the last segment, which must be a `week` or `day` count.",
      );
    }
  }
  return issues;
}

function checkRule(rule: PriceFormulaRule, ctx: z.RefinementCtx): void {
  for (const issue of priceFormulaRuleIssues(rule)) {
    ctx.addIssue({ code: "custom", path: issue.path, message: issue.message });
  }
}

// ── What a line carries ──────────────────────────────────────────────

/**
 * Does a formula multiply TIME, or price a flat amount? Derived, never chosen:
 * a `none` meter is `flat`, every other meter is `time`
 * ({@link priceFormulaBasis}).
 *
 * A line snapshots it beside the formula's uid and name (`price.price_formula`)
 * so a single-document rule can branch on it without reading the formula: a
 * purchase line's money shape (flat ⇒ a stated `amount_cents`, time ⇒ dated
 * `rates`) and whether `quantity_billed` is a co-written bucket (flat only) are
 * both decided by it (purchases-as-documents, Phase 2 ruling 1).
 */
export const PRICE_FORMULA_BASES = ["flat", "time"] as const;
/** One {@link PRICE_FORMULA_BASES} member. */
export type PriceFormulaBasis = typeof PRICE_FORMULA_BASES[number];
/** Zod schema for {@link PriceFormulaBasis}. */
export const PriceFormulaBasisEnum: z.ZodType<PriceFormulaBasis> = z.enum(PRICE_FORMULA_BASES);

/** The basis a formula rule implies — see {@link PRICE_FORMULA_BASES}. */
export function priceFormulaBasis(rule: Pick<PriceFormulaRule, "meter">): PriceFormulaBasis {
  return rule.meter.source === "none" ? "flat" : "time";
}

/**
 * A line's snapshot of the formula it is priced by — `{ uid, name }` like
 * `PriceModifier` and `TaxRef` (`schemas/order.ts`), plus the derived
 * {@link PriceFormulaBasis}. A point-in-time copy: a formula is immutable once
 * referenced, and a renamed one is a superseding formula, so the snapshot never
 * needs re-pointing.
 */
export interface PriceFormulaRef {
  uid: string;
  name: string;
  basis: PriceFormulaBasis;
}

/** Zod schema for {@link PriceFormulaRef}. */
export const PriceFormulaRefSchema: z.ZodType<PriceFormulaRef> = z.strictObject({
  uid: FirestoreId,
  name: z.string().min(1).max(100).meta({ pii: "none", column: true, label: "Formula" }),
  basis: PriceFormulaBasisEnum,
});

/**
 * One rate a line PRICED with — the snapshot it owns (Q13), taken for the
 * line's pricing date from the dated rows ({@link DatedRate}). An AMOUNT in
 * house vocabulary (integer cents per counted period), not a 4dp rate, hence
 * `amount_cents`. Later rate changes never reprice a line.
 */
export interface RateSnapshotType {
  rate_key: string;
  amount_cents: number;
}

/** Zod schema for {@link RateSnapshotType}. */
export const RateSnapshotSchema: z.ZodType<RateSnapshotType> = z.strictObject({
  rate_key: RateKey,
  // Signed: a credit line's base is negative (core#88).
  amount_cents: z.int().meta({ column: true, label: "Rate" }),
});

/**
 * One tier's metered count as a line STORES it — the engine's exact rational
 * (`TierCount`, `@cfs/core/utils/price-formulas`), frozen when the line is
 * written because the holiday list has no versions (Phase 2 ruling 8). With
 * the line's `rates`, `quantity` and `discount` it reproduces the line's money
 * from the line alone. `num` may be zero, and negative on a stated extension
 * count.
 */
export interface TierCountType {
  rate_key: string;
  num: number;
  den: number;
}

/** Zod schema for {@link TierCountType}. */
export const TierCountSchema: z.ZodType<TierCountType> = z.strictObject({
  rate_key: RateKey,
  num: z.int(),
  den: z.int().min(1),
});

/**
 * One dated rate row (D4): `amount_cents` for `rate_key` over
 * `[applied_from, applied_to)`. Calendar dates (`chicagoStartOfDay`), the
 * taxes-rate window — but an ARRAY MEMBER, so no `_fs` twins (`unit.ts`,
 * `ChargeWindow`): nothing range-queries inside an array.
 *
 * Per key the rows are ordered, never overlap, leave no gap, and only the last
 * may be open ({@link datedRatesIssues}). A new rate for a key closes that key's
 * open row in the same write (the `POST /taxes-codes/{uid}/rates` precedent).
 */
export interface DatedRate {
  /** Array-member id, minted by the writer (`crypto.randomUUID()`). */
  uid: string;
  rate_key: string;
  amount_cents: number;
  applied_from: string;
  /** Exclusive; `null` = open. */
  applied_to: string | null;
}

const datedRateShape = {
  uid: z.uuid(),
  rate_key: RateKey,
  amount_cents: z.int().min(0).meta({ column: true, label: "Rate" }),
  applied_from: chicagoStartOfDay().meta({ column: true, label: "From" }),
  applied_to: chicagoStartOfDay().nullable().meta({ column: true, label: "Until" }),
};

/** Zod schema for {@link DatedRate}. */
export const DatedRateSchema: z.ZodType<DatedRate> = z.strictObject(datedRateShape);
/** {@link DatedRateSchema} for an INPUT: unknown keys are stripped, not refused. */
export const DatedRateInput: z.ZodType<DatedRate> = z.object(datedRateShape);

/**
 * The single-document rules of a dated-rate array, per `rate_key`: rows ascend
 * by `applied_from`, each closed row ends where the next begins (no overlap, no
 * gap), only the last row of a key may be open, `applied_to > applied_from`, and
 * uids are unique. Instants compared with `Date.parse`, never lexically.
 *
 * It cannot say "every key the formula names has a row in force" — the formula
 * is another document; the writer checks that (`snapshotRates` throws).
 */
export function datedRatesIssues(
  rates: readonly DatedRate[],
): { path: (string | number)[]; message: string }[] {
  const issues: { path: (string | number)[]; message: string }[] = [];
  const uids = new Set<string>();
  const byKey = new Map<string, number[]>();
  rates.forEach((r, i) => {
    if (uids.has(r.uid)) issues.push({ path: [i, "uid"], message: "a rate uid appears once" });
    uids.add(r.uid);
    if (r.applied_to !== null && Date.parse(r.applied_to) <= Date.parse(r.applied_from)) {
      issues.push({ path: [i, "applied_to"], message: "a rate ends after it starts" });
    }
    byKey.set(r.rate_key, [...(byKey.get(r.rate_key) ?? []), i]);
  });
  for (const [key, idx] of byKey) {
    const rows = [...idx].sort((a, b) => Date.parse(rates[a].applied_from) - Date.parse(rates[b].applied_from));
    rows.forEach((i, k) => {
      const r = rates[i];
      const next = rows[k + 1];
      if (next === undefined) return;
      if (r.applied_to === null) {
        issues.push({ path: [i, "applied_to"], message: `only the last "${key}" rate may be open` });
      } else if (Date.parse(r.applied_to) !== Date.parse(rates[next].applied_from)) {
        issues.push({
          path: [next, "applied_from"],
          message: `"${key}" rates leave no gap and never overlap: each starts where the one before ends`,
        });
      }
    });
  }
  return issues;
}

/** Refine adapter for {@link datedRatesIssues}, for a `rates` array node. */
export function checkDatedRates(rates: readonly DatedRate[], ctx: z.RefinementCtx): void {
  for (const issue of datedRatesIssues(rates)) {
    ctx.addIssue({ code: "custom", path: issue.path, message: issue.message });
  }
}

// ── Document ─────────────────────────────────────────────────────────

/** A price formula document in Firestore. */
export interface PriceFormula extends PriceFormulaRule {
  uid: string;
  /** Title Case, e.g. "Five-day week". */
  name: string;
  description: string | null;
  /** Whether a NEW line may pick it. A referenced formula is retired, never edited. */
  active: boolean;
  /** The formula that replaced this one; `null` while it is current. */
  uid_superseded_by: string | null;
  version: number;
  created_by: ActorRefType;
  updated_by: ActorRefType;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}

const ruleShape = {
  meter: PriceFormulaMeterSchema,
  segments: z.array(PriceFormulaSegmentSchema).min(1).max(6),
  reprice: z.literal("remainder"),
  minimum: PriceFormulaMinimumSchema.nullable(),
};

/** Zod schema for {@link PriceFormula}. */
export const PriceFormulaSchema: z.ZodType<PriceFormula> = z.strictObject({
  uid: FirestoreId,
  name: z.string().min(1).max(100).meta({ column: true, label: "Name" }),
  description: z.string().max(500).nullable(),
  active: z.boolean().meta({ column: true, label: "Active" }),
  uid_superseded_by: FirestoreId.nullable(),
  ...ruleShape,
  version: z.int().min(0),
  created_by: ActorRef.meta({ column: true, label: "Created By" }),
  updated_by: ActorRef.meta({ column: true, label: "Updated By" }),
  ...TimestampFields,
}).superRefine((doc, ctx) => {
  checkRule(doc, ctx);
  if (doc.uid_superseded_by !== null) {
    if (doc.uid_superseded_by === doc.uid) {
      ctx.addIssue({
        code: "custom",
        path: ["uid_superseded_by"],
        message: "A formula cannot supersede itself.",
      });
    }
    if (doc.active) {
      ctx.addIssue({
        code: "custom",
        path: ["active"],
        message: "A superseded formula is inactive.",
      });
    }
  }
}).meta({
  title: "Price Formula",
  collection: "price-formulas",
  displayDefaults: {
    columns: ["name", "active"],
    filters: {},
    sort: { column: "name", direction: "asc" },
  },
});

// ── Inputs ───────────────────────────────────────────────────────────

/** Input for creating a price formula. */
export interface CreatePriceFormulaInputType extends PriceFormulaRule {
  name: string;
  description?: string | null;
  active: boolean;
}

/** Zod schema for {@link CreatePriceFormulaInputType}. */
export const CreatePriceFormulaInput: z.ZodType<CreatePriceFormulaInputType> = z
  .object({
    name: z.string().min(1).max(100),
    description: z.string().max(500).nullable().optional(),
    active: z.boolean(),
    meter: MeterInput,
    segments: z.array(SegmentInput).min(1).max(6),
    reprice: z.literal("remainder"),
    minimum: MinimumInput.nullable(),
  }).superRefine(checkRule);

/**
 * Input for updating a price formula.
 *
 * ⚠️ **Only labels and retirement.** The rule (`meter`, `segments`, `minimum`)
 * is not on this input at all: a formula any line has priced with is
 * immutable, and core cannot see references — so the safe shape is the one
 * that cannot express the edit. A changed rule is a new formula, and this one
 * points at it with `uid_superseded_by`.
 */
export interface UpdatePriceFormulaInputType {
  uid: string;
  version?: number;
  name?: string;
  description?: string | null;
  active?: boolean;
  uid_superseded_by?: string | null;
}

/** Zod schema for {@link UpdatePriceFormulaInputType}. */
export const UpdatePriceFormulaInput: z.ZodType<UpdatePriceFormulaInputType> = z
  .object({
    uid: FirestoreId,
    version: z.int().min(0).optional(),
    name: z.string().min(1).max(100).optional(),
    description: z.string().max(500).nullable().optional(),
    active: z.boolean().optional(),
    uid_superseded_by: FirestoreId.nullable().optional(),
  });
