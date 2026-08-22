/**
 * The `Tax` document's new axes as SCHEMA facts (api-cloudrun#409) — the
 * calendar-date factory on the applied window, the explicit-only biconditional,
 * and the Xero component sum.
 *
 * These are assertions about what the schema REFUSES, which is the half a
 * round-trip test cannot see.
 */
import { assertEquals, assertStringIncludes } from "@std/assert";
import { TaxSchema } from "../src/schemas/mod.ts";
import { mockTimestamp } from "./helpers/timestamp.ts";

const ACTOR = { uid: "test", name: "Test" };

function tax(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    uid: "0sfD0ca1LvwWR0pTJtqw",
    name: "Chicago Sales Tax",
    rate: 10.5,
    type: "percent",
    active: true,
    crms_id: 3,
    item_types: ["sale", "replacement"],
    applied_from: "2026-01-01T00:00:00.000-06:00",
    applied_from_fs: mockTimestamp,
    applied_to: null,
    applied_to_fs: null,
    version: 0,
    created_by: ACTOR,
    updated_by: ACTOR,
    created_at: mockTimestamp,
    updated_at: mockTimestamp,
    ...overrides,
  };
}

// ── The applied window is a CALENDAR DATE ────────────────────────

Deno.test("applied_from snaps a time-of-day to Chicago midnight", () => {
  // The whole reason it is `chicagoStartOfDay()` and not `chicagoInstant()`.
  // Under an instant factory an operator can open a rate window at 14:30 and
  // half a day silently prices at the old rate.
  const parsed = TaxSchema.parse(tax({ applied_from: "2026-08-18T14:30:00.000-05:00" }));
  assertEquals(
    (parsed as { applied_from?: string }).applied_from,
    "2026-08-18T00:00:00.000-05:00",
  );
});

Deno.test("applied_from is idempotent on an already-canonical Chicago midnight", () => {
  const parsed = TaxSchema.parse(tax({ applied_from: "2026-01-01T00:00:00.000-06:00" }));
  assertEquals(
    (parsed as { applied_from?: string }).applied_from,
    "2026-01-01T00:00:00.000-06:00",
  );
});

Deno.test("applied_from converts a UTC instant to the CHICAGO calendar day", () => {
  // 2026-08-19T02:00Z is still 2026-08-18 in Chicago. A `.slice(0,10)` or a
  // UTC-midnight read lands on the wrong day, which is the banned pattern.
  const parsed = TaxSchema.parse(tax({ applied_from: "2026-08-19T02:00:00.000Z" }));
  assertEquals(
    (parsed as { applied_from?: string }).applied_from,
    "2026-08-18T00:00:00.000-05:00",
  );
});

Deno.test("effective_from and applied_to take the same calendar-date factory", () => {
  const parsed = TaxSchema.parse(tax({
    effective_from: "2026-08-01T09:15:00.000-05:00",
    applied_to: "2026-09-01T23:59:00.000-05:00",
  })) as { effective_from?: string; applied_to?: string };
  assertEquals(parsed.effective_from, "2026-08-01T00:00:00.000-05:00");
  assertEquals(parsed.applied_to, "2026-09-01T00:00:00.000-05:00");
});

Deno.test("a bare YYYY-MM-DD is REFUSED on the applied window", () => {
  // It would parse as UTC midnight — 5–6h off Chicago — and force every
  // comparison site to re-apply the zone.
  assertEquals(TaxSchema.safeParse(tax({ applied_from: "2026-08-18" })).success, false);
});

// ── The explicit-only class, and its SCOPE ───────────────────────

Deno.test("explicit-only: jurisdiction null WITH item_types [] parses", () => {
  const r = TaxSchema.safeParse(tax({ jurisdiction: null, item_types: [] }));
  assertEquals(r.success, true);
});

Deno.test("resolvable: a jurisdiction WITH item_types parses", () => {
  const r = TaxSchema.safeParse(tax({ jurisdiction: "chicago", item_types: ["sale", "replacement"] }));
  assertEquals(r.success, true);
});

Deno.test("a null jurisdiction with NON-empty item_types is refused", () => {
  // Types the rule could resolve, and no jurisdiction for them to resolve
  // UNDER — so nothing can ever match them. The one direction that is still a
  // contradiction rather than a configuration.
  const r = TaxSchema.safeParse(tax({ jurisdiction: null, item_types: ["sale"] }));
  assertEquals(r.success, false);
  assertStringIncludes(r.error?.issues[0].message ?? "", "explicit-only");
});

Deno.test("🔴 a jurisdiction with EMPTY item_types is ALLOWED — it is a SCOPE", () => {
  // ⚠️ This arm asserted the opposite until api-cloudrun#409, and the
  // biconditional it enforced made a real tax unrepresentable: the Chicago
  // Bottled Water Tax is levied per bottle SOLD IN CHICAGO, so it needs a
  // jurisdiction to be scoped by — and it must NOT be resolvable by type,
  // because `(chicago, sale)` is already Chicago Sales Tax's and `findTaxFor`
  // throws on two taxes covering one pair.
  //
  // The two fields answer different questions: `item_types` is "can the rule
  // find me?", `jurisdiction` is "where do I apply?". Welding them made the
  // second unaskable.
  const r = TaxSchema.safeParse(tax({ jurisdiction: "chicago", item_types: [] }));
  assertEquals(r.success, true);
});

Deno.test("item_types is REQUIRED — an omitted list is not a way to say 'none'", () => {
  // ⚠️ This arm asserted the opposite through Phase 1, when every new field
  // shipped optional. The owner ruling that closed it: `service`, `surcharge`
  // and `transaction_fee` are untaxed TODAY and could be taxed tomorrow, so
  // the absence has to be a STATED fact. With the field optional, "nobody
  // decided" and "decided: none" were the same document.
  const { item_types: _omitted, ...withoutItemTypes } = tax();
  assertEquals(TaxSchema.safeParse(withoutItemTypes).success, false);

  // `[]` is how you say none — the explicit-only class, still admitted.
  assertEquals(TaxSchema.safeParse(tax({ item_types: [] })).success, true);
});

// ── The applied window REPLACED valid_*, and the old pair is REFUSED ─────────

Deno.test("🔴 a document still carrying valid_from is REFUSED, not ignored", () => {
  // The discriminating half. `TaxSchema` is a `z.strictObject`, so the four
  // `valid_*` keys are now unknown keys rather than tolerated legacy ones —
  // which is what makes the strip migration verifiable: a document that kept
  // the old pair cannot be written back.
  for (const key of ["valid_from", "valid_to", "valid_from_fs", "valid_to_fs"]) {
    assertEquals(
      TaxSchema.safeParse(tax({ [key]: "2026-01-01T00:00:00.000-06:00" })).success,
      false,
      key,
    );
  }
});

Deno.test("applied_from and applied_to are REQUIRED — a missing bound reads as OPEN", () => {
  // Not a tidiness rule. `taxAppliedWindow` maps an absent bound to `null` and
  // every bracket check treats `null` as open, so an unbounded version
  // brackets every instant, two versions of one name bracket the same instant,
  // and `findTaxAt` throws `Tax catalog drift` — on the pricing path, out of a
  // CRMS Cloud Task handler, which retries forever.
  for (const key of ["applied_from", "applied_from_fs", "applied_to", "applied_to_fs"]) {
    const doc = tax();
    delete doc[key];
    assertEquals(TaxSchema.safeParse(doc).success, false, key);
  }
  // `applied_to: null` is the OPEN-ENDED answer and stays admitted — the
  // distinction absent-vs-null is the whole point.
  assertEquals(TaxSchema.safeParse(tax({ applied_to: null })).success, true);
});

Deno.test("an invalid applied_from is still refused", () => {
  assertEquals(TaxSchema.safeParse(tax({ applied_from: "not-a-date" })).success, false);
  assertEquals(TaxSchema.safeParse(tax({ applied_from: null })).success, false);
});

Deno.test("item_types cannot name transaction_fee — it is not REPRESENTABLE", () => {
  // Stronger than "no tax lists it": `calculateItemTax` throws
  // `Item is not priceable` on a from_total line, so the type system refuses
  // the configuration rather than the runtime refusing the call.
  const r = TaxSchema.safeParse(
    tax({ jurisdiction: "chicago", item_types: ["sale", "transaction_fee"] }),
  );
  assertEquals(r.success, false);
});

Deno.test("item_types cannot name a divider", () => {
  for (const divider of ["destination", "group", "order"]) {
    assertEquals(
      TaxSchema.safeParse(tax({ jurisdiction: "chicago", item_types: ["sale", divider] })).success,
      false,
      divider,
    );
  }
});

// ── Xero components ──────────────────────────────────────────────

Deno.test("xero_components summing to rate parses — the real 10.50 split", () => {
  const r = TaxSchema.safeParse(tax({
    rate: 10.5,
    xero_tax_type: "TAX002",
    xero_components: [
      { name: "Illinois Department of Revenue", rate: 6.25 },
      { name: "Northern Illinois Transit Authority", rate: 1.25 },
      { name: "Cook County", rate: 1.75 },
      { name: "City of Chicago", rate: 1.25 },
    ],
  }));
  assertEquals(r.success, true);
});

Deno.test("the Frankfort 8.25 split parses", () => {
  const r = TaxSchema.safeParse(tax({
    name: "Frankfort Sales Tax",
    rate: 8.25,
    xero_components: [
      { name: "State Tax", rate: 6.25 },
      { name: "Non-Home Rule Municipal Tax", rate: 1.0 },
      { name: "Northern Illinois Transit Authority", rate: 1.0 },
    ],
  }));
  assertEquals(r.success, true);
});

Deno.test("xero_components NOT summing to rate is refused", () => {
  // Xero computes EffectiveRate FROM the components, so this pushes a tax at a
  // different rate than CFS bills — silently, and only on the Xero side.
  const r = TaxSchema.safeParse(tax({
    rate: 10.5,
    xero_components: [
      { name: "Illinois Department of Revenue", rate: 6.25 },
      // the pre-increase NITA component — the exact defect this catches
      { name: "Northern Illinois Transit Authority", rate: 1.0 },
      { name: "Cook County", rate: 1.75 },
      { name: "City of Chicago", rate: 1.25 },
    ],
  }));
  assertEquals(r.success, false);
  assertStringIncludes(r.error?.issues[0].message ?? "", "10.25");
});

Deno.test("the component sum is compared in basis points, not floats", () => {
  // 0.1 + 0.2 !== 0.3 as doubles. A naive float compare fails this.
  const r = TaxSchema.safeParse(tax({
    rate: 0.3,
    xero_components: [{ name: "A", rate: 0.1 }, { name: "B", rate: 0.2 }],
  }));
  assertEquals(r.success, true);
});

Deno.test("a FLAT tax's components are not summed — its rate is dollars per unit", () => {
  // `rate: 0.05` on the bottle tax is $0.05/unit, not 0.05%. Summing components
  // against it would compare a dollar amount to a percentage.
  const r = TaxSchema.safeParse(tax({
    name: "Water Bottle Tax",
    rate: 0.05,
    type: "flat",
    jurisdiction: null,
    item_types: [],
    xero_components: [{ name: "City of Chicago", rate: 5 }],
  }));
  assertEquals(r.success, true);
});

Deno.test("an empty xero_components is not a sum violation", () => {
  assertEquals(TaxSchema.safeParse(tax({ rate: 10.5, xero_components: [] })).success, true);
});
