/**
 * **The class-based tax rule** — `taxes-classes` × jurisdiction → `taxes-codes`
 * → the `taxes-rates` version live at an instant (api-cloudrun#993, plan
 * `api-cloudrun/.claude/plans/tax-classes.md`).
 *
 * ⚠️ **During the expand/dual-write steps this runs BESIDE `utils/taxes.ts`,
 * and nothing prices on it yet.** It exists now so the step-3 property check —
 * *every live line reprices identically under both rules* — has something to
 * run, and so the manager's matrix can be built against the real resolver
 * rather than a sketch. At the reader switch it becomes the only path.
 *
 * ## The four stages, and which one this module owns
 *
 * ```
 * 1. FACTS    line.type, line.uid_tax_class(_override), line destination
 * 2. CONTEXT  jurisdiction = destination → org claim → derive(address, origin)
 *             exempt       = org.tax_exempt || doc.tax_exempt
 *             ▶ replacement: jurisdiction = origin, exempt = false
 * 3. SELECT   codes in the class whose jurisdiction matches; each code's rate at asOf
 * 4. PRICE    percent → subtotal × rate ÷ 100 ; flat → rate × quantity
 * ```
 *
 * Stage 2 is `resolveJurisdiction` in `utils/taxes.ts` and does not change.
 * Stage 4 is `computeItemTaxAmountCents` and does not change. **This module is
 * stage 3** ({@link resolveClassTaxes}) plus the cross-document invariants that
 * make stage 3 unambiguous ({@link validateTaxSetup}).
 *
 * Pure and db-free: the catalog is injected, `asOf` is injected.
 */

import type { ProductTypeType, RateType, TaxClass, TaxCode, TaxRate } from "../schemas/mod.ts";
import { COLLECTING_JURISDICTIONS } from "./taxes.ts";

/** The three catalog collections, unfiltered — historical rates included. */
export interface TaxCatalog {
  codes: readonly TaxCode[];
  rates: readonly TaxRate[];
  classes: readonly TaxClass[];
}

// ── windows ──────────────────────────────────────────────────────────────

/** `[from, to)` as instants. Stored bounds are Chicago-offset strings, so never compare them as text. */
function windowOf(rate: TaxRate): { from: number; to: number } {
  return {
    from: Date.parse(rate.applied_from),
    to: rate.applied_to === null ? Infinity : Date.parse(rate.applied_to),
  };
}

function contains(rate: TaxRate, t: number): boolean {
  const { from, to } = windowOf(rate);
  return from <= t && t < to;
}

function overlaps(a: TaxRate, b: TaxRate): boolean {
  const wa = windowOf(a);
  const wb = windowOf(b);
  return wa.from < wb.to && wb.from < wa.to;
}

// ── validateTaxSetup ─────────────────────────────────────────────────────

/** Closed vocabulary, so a caller can switch on it and an audit can count it. */
export type TaxSetupViolationCode =
  | "duplicate_code_name"
  | "duplicate_class_name"
  | "orphan_rate"
  | "rate_type_mismatch"
  | "rate_overlap"
  | "rate_gap"
  | "unknown_code_in_class"
  | "inactive_code_in_class"
  | "multiple_percent_rates"
  | "duplicate_type_default";

/** One broken invariant, with every uid it involves so a writer can name them in a 400. */
export interface TaxSetupViolation {
  code: TaxSetupViolationCode;
  message: string;
  uids: string[];
}

/**
 * **The cross-document invariants of the tax catalog.** An empty array is the
 * healthy answer.
 *
 * One function, three callers, which is the drift resistance the plan asks for:
 * every API writer of a code, rate or class runs it on the catalog AS IT WOULD
 * BE after the write and refuses on any violation; `audit-tax-catalog.ts` runs
 * it on the stored catalog; and the daily watch runs it too.
 *
 * | code | why it is a defect |
 * |---|---|
 * | `multiple_percent_rates` | an active class has two percent rates live for one jurisdiction at one instant. Xero takes one TaxType per line, and it is how a line would get double sales tax |
 * | `rate_overlap` | two versions of one code bracket one instant — pricing cannot pick |
 * | `rate_gap` | an interior hole between two versions of one code. A schedule lapsing at the END is a review, not this; see `UnreviewedTaxWarning` |
 * | `rate_type_mismatch` | a rate's `type` copy disagrees with its code's, so the unit it renders is wrong |
 * | `orphan_rate` / `unknown_code_in_class` | a reference to nothing |
 * | `inactive_code_in_class` | an ACTIVE class draws from a code an operator retired |
 * | `duplicate_type_default` | two active classes both preselect one product type |
 * | `duplicate_*_name` | a label that no longer identifies one thing (whole collection, inactive included) |
 *
 * ⚠️ **Jurisdictions are the TAX vocabulary, not the live registrations.** A
 * closed registration (paxton) still has codes and rates, and a class listing
 * two percent codes there is still a contradiction for the frozen documents
 * that resolve it — so every code jurisdiction is checked, not only
 * `COLLECTING_JURISDICTIONS`.
 */
export function validateTaxSetup(catalog: TaxCatalog): TaxSetupViolation[] {
  const violations: TaxSetupViolation[] = [];
  const codeByUid = new Map(catalog.codes.map((c) => [c.uid, c]));
  const ratesByCode = new Map<string, TaxRate[]>();

  for (const [label, docs, code] of [
    ["tax code", catalog.codes, "duplicate_code_name"],
    ["tax class", catalog.classes, "duplicate_class_name"],
  ] as const) {
    const byName = new Map<string, string[]>();
    for (const doc of docs) byName.set(doc.name, [...(byName.get(doc.name) ?? []), doc.uid]);
    for (const [name, uids] of byName) {
      if (uids.length > 1) {
        violations.push({ code, message: `${uids.length} ${label}s are named "${name}".`, uids });
      }
    }
  }

  for (const rate of catalog.rates) {
    const code = codeByUid.get(rate.uid_tax_code);
    if (!code) {
      violations.push({
        code: "orphan_rate",
        message: `Rate ${rate.uid} names tax code ${rate.uid_tax_code}, which does not exist.`,
        uids: [rate.uid, rate.uid_tax_code],
      });
      continue;
    }
    if (rate.type !== code.type) {
      violations.push({
        code: "rate_type_mismatch",
        message: `Rate ${rate.uid} is ${rate.type} but its code "${code.name}" is ${code.type}.`,
        uids: [rate.uid, code.uid],
      });
    }
    ratesByCode.set(code.uid, [...(ratesByCode.get(code.uid) ?? []), rate]);
  }

  for (const [uid, rates] of ratesByCode) {
    const name = codeByUid.get(uid)?.name ?? uid;
    const sorted = [...rates].sort((a, b) => windowOf(a).from - windowOf(b).from);
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        if (overlaps(sorted[i], sorted[j])) {
          violations.push({
            code: "rate_overlap",
            message: `Two rates of "${name}" overlap: ${sorted[i].uid} and ${sorted[j].uid}.`,
            uids: [sorted[i].uid, sorted[j].uid],
          });
        }
      }
      const next = sorted[i + 1];
      if (next) {
        const end = windowOf(sorted[i]).to;
        if (end !== Infinity && end < windowOf(next).from) {
          violations.push({
            code: "rate_gap",
            message:
              `"${name}" has no rate between ${sorted[i].applied_to} and ${next.applied_from} ` +
              `(${sorted[i].uid} → ${next.uid}).`,
            uids: [sorted[i].uid, next.uid],
          });
        }
      }
    }
  }

  const activeClasses = catalog.classes.filter((c) => c.active);
  for (const cls of catalog.classes) {
    for (const uid of cls.uid_tax_codes) {
      const code = codeByUid.get(uid);
      if (!code) {
        violations.push({
          code: "unknown_code_in_class",
          message: `Tax class "${cls.name}" lists tax code ${uid}, which does not exist.`,
          uids: [cls.uid, uid],
        });
      } else if (cls.active && !code.active) {
        violations.push({
          code: "inactive_code_in_class",
          message: `Active tax class "${cls.name}" lists inactive tax code "${code.name}".`,
          uids: [cls.uid, uid],
        });
      }
    }
  }

  for (const cls of activeClasses) {
    const percentCodes = cls.uid_tax_codes
      .map((uid) => codeByUid.get(uid))
      .filter((c): c is TaxCode => c !== undefined && c.type === "percent");
    const byJurisdiction = new Map<string, TaxCode[]>();
    for (const code of percentCodes) {
      byJurisdiction.set(code.jurisdiction, [...(byJurisdiction.get(code.jurisdiction) ?? []), code]);
    }
    for (const [jurisdiction, codes] of byJurisdiction) {
      for (let i = 0; i < codes.length; i++) {
        for (let j = i + 1; j < codes.length; j++) {
          const clash = (ratesByCode.get(codes[i].uid) ?? []).flatMap((a) =>
            (ratesByCode.get(codes[j].uid) ?? []).filter((b) => overlaps(a, b)).map((b) => [a.uid, b.uid])
          );
          if (clash.length > 0) {
            violations.push({
              code: "multiple_percent_rates",
              message:
                `Tax class "${cls.name}" has two percent taxes live in ${jurisdiction} at once: ` +
                `"${codes[i].name}" and "${codes[j].name}".`,
              uids: [cls.uid, codes[i].uid, codes[j].uid, ...clash.flat()],
            });
          }
        }
      }
    }
  }

  const defaults = new Map<ProductTypeType, string[]>();
  for (const cls of activeClasses) {
    for (const type of cls.is_default_for) defaults.set(type, [...(defaults.get(type) ?? []), cls.uid]);
  }
  for (const [type, uids] of defaults) {
    if (uids.length > 1) {
      violations.push({
        code: "duplicate_type_default",
        message: `${uids.length} active tax classes are the default for "${type}" products.`,
        uids,
      });
    }
  }

  return violations;
}

// ── resolveClassTaxes ────────────────────────────────────────────────────

/**
 * Why each code in the class did or did not contribute a rate — the explain
 * output the manager renders on a product or line, and the audits reuse.
 *
 * - `matched` — a rate brackets `asOf` (or the document's frozen rate).
 * - `expired` — nothing brackets `asOf` but a version closed before it; priced
 *   on that version and reported, never refused (`UnreviewedTaxWarning`'s rule).
 * - `wrong_jurisdiction` — the code levies somewhere else. The normal case for
 *   most of a class's codes.
 * - `no_rate` — the code has never had a rate at or before `asOf`.
 * - `unknown_code` — the class names a code the catalog does not hold.
 */
export type ClassTaxOutcome = "matched" | "expired" | "wrong_jurisdiction" | "no_rate" | "unknown_code";

/** One row of the explain output. */
export interface ClassTaxConsidered {
  uid_tax_code: string;
  /** `null` only for `unknown_code`. */
  name: string | null;
  outcome: ClassTaxOutcome;
  /** The rate priced on — set for `matched` and `expired` only. */
  rate: TaxRate | null;
}

/** A rate the line carries, with the code name `PriceModifier.name` snapshots. */
export interface ClassAppliedRate {
  rate: TaxRate;
  code: TaxCode;
  /** `true` when priced on a lapsed review — the fall-forward, reported. */
  expired: boolean;
}

/** The whole answer for one line. */
export interface ClassTaxResolution {
  /** The class that was resolved, or `null` when the line has none. */
  uid_tax_class: string | null;
  /** Before exemption — what `price.taxes_base` records. */
  base: ClassAppliedRate[];
  /** After exemption — what `price.taxes` carries. `[]` when exempt. */
  applied: ClassAppliedRate[];
  /** Every code of the class, in class order, with why. */
  considered: ClassTaxConsidered[];
}

/**
 * The class a line resolves: the operator's override, else the product
 * snapshot. `null` when neither is stamped — during expand the CALLER supplies
 * a derived class for such a line, because the legacy mapping
 * (`taxed_as ?? type` plus the explicit-only bottle ref) needs the migrated
 * class uids, which only the backfill knows.
 */
export function lineTaxClass(
  item: { uid_tax_class?: string | null; uid_tax_class_override?: string | null },
): string | null {
  return item.uid_tax_class_override ?? item.uid_tax_class ?? null;
}

/**
 * **Stage 3 for one line**: the class's codes, filtered to the jurisdiction
 * stage 2 resolved, each taken at the rate live at `asOf`.
 *
 * ```
 * codes = class.uid_tax_codes where code.jurisdiction === jurisdiction
 * rate  = frozen rate of that code  ??  rate bracketing asOf  ??  most recently CLOSED rate (expired)
 * applied = exempt ? [] : base
 * ```
 *
 * - **`jurisdiction` and `exempt` arrive already decided** — including the
 *   replacement rule (origin, not exempt), which is stage 2's and keyed on
 *   `line.type`, never on the class. Re-deriving either here would be a second
 *   copy of stage 2.
 * - **`no_nexus` matches nothing** by construction: no code can carry it.
 * - **A missing or unknown class is untaxed**, not an error. The caller that
 *   must refuse (a writer) refuses on `validateTaxSetup` or on the missing
 *   stamp, not on a pricing throw — the tax-review outage recorded in
 *   `utils/taxes.ts` is the reason pricing never throws for configuration.
 * - **`frozenRateUids`**: a frozen document's stored `price.taxes[].uid`s. Where
 *   one of them is a version of a matched code it wins over today's version, so
 *   a completed order keeps the rate it was billed at. It replaces the legacy
 *   name-keyed `frozenVersions`: a line stores the RATE uid, and a rate knows
 *   its code, so no name is needed.
 *
 * ⚠️ **"Most recent" means most recently CLOSED at or before `asOf`**, the same
 * rule as `mostRecentClosedTax`: a document inside an interior gap gets the
 * version that ran up to the gap, never one that had not started.
 */
export function resolveClassTaxes(
  uidTaxClass: string | null,
  jurisdiction: string,
  exempt: boolean,
  asOf: string,
  catalog: TaxCatalog,
  frozenRateUids?: ReadonlySet<string>,
): ClassTaxResolution {
  const cls = uidTaxClass === null ? undefined : catalog.classes.find((c) => c.uid === uidTaxClass);
  if (!cls) return { uid_tax_class: uidTaxClass, base: [], applied: [], considered: [] };

  const t = Date.parse(asOf);
  const base: ClassAppliedRate[] = [];
  const considered: ClassTaxConsidered[] = [];

  for (const uid of cls.uid_tax_codes) {
    const code = catalog.codes.find((c) => c.uid === uid);
    if (!code) {
      considered.push({ uid_tax_code: uid, name: null, outcome: "unknown_code", rate: null });
      continue;
    }
    if (code.jurisdiction !== jurisdiction) {
      considered.push({ uid_tax_code: uid, name: code.name, outcome: "wrong_jurisdiction", rate: null });
      continue;
    }

    const rates = catalog.rates.filter((r) => r.uid_tax_code === uid);
    const frozen = frozenRateUids ? rates.find((r) => frozenRateUids.has(r.uid)) : undefined;
    const live = rates.find((r) => contains(r, t));
    const chosen = frozen ?? live;
    if (chosen) {
      base.push({ rate: chosen, code, expired: false });
      considered.push({ uid_tax_code: uid, name: code.name, outcome: "matched", rate: chosen });
      continue;
    }

    let lapsed: TaxRate | undefined;
    for (const r of rates) {
      const end = windowOf(r).to;
      if (end <= t && (lapsed === undefined || end > windowOf(lapsed).to)) lapsed = r;
    }
    if (lapsed) {
      base.push({ rate: lapsed, code, expired: true });
      considered.push({ uid_tax_code: uid, name: code.name, outcome: "expired", rate: lapsed });
    } else {
      considered.push({ uid_tax_code: uid, name: code.name, outcome: "no_rate", rate: null });
    }
  }

  return { uid_tax_class: cls.uid, base, applied: exempt ? [] : base, considered };
}

/**
 * **The class × jurisdiction matrix at an instant** — the settings page and the
 * body of `audit-tax-catalog.ts`. One row per ACTIVE class, one cell per
 * collecting jurisdiction, each cell the resolver's own answer (not exempt), so
 * the page can never show a combination pricing would not produce.
 *
 * Collecting jurisdictions only: a matrix is a statement about what CFS charges
 * TODAY, and a closed registration is not somewhere a new line can land.
 */
export function taxClassMatrix(
  catalog: TaxCatalog,
  asOf: string,
): Array<{ tax_class: TaxClass; cells: Array<{ jurisdiction: string; rates: Array<{ name: string; rate: number; type: RateType; expired: boolean }> }> }> {
  return catalog.classes
    .filter((c) => c.active)
    .map((tax_class) => ({
      tax_class,
      cells: COLLECTING_JURISDICTIONS.map((jurisdiction) => ({
        jurisdiction,
        rates: resolveClassTaxes(tax_class.uid, jurisdiction, false, asOf, catalog).base.map((a) => ({
          name: a.code.name,
          rate: a.rate.rate,
          type: a.rate.type,
          expired: a.expired,
        })),
      })),
    }));
}
