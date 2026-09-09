/**
 * `src/utils/reporting.ts` — the presentation fold over an `AgingReport`.
 *
 * ⭐ **These arms were ported from `manager/tests/utils/agingReport.test.ts`
 * rather than written fresh, and the reason is the point of the module.** The
 * derivation had already been implemented twice (the manager and
 * `templates/aging-report.eta`) and a third was about to be written for the CSV
 * export; the manager's suite is the one that had already found the positional
 * bucket read and the residual's fail-closed companion. Moving the code without
 * moving the arms that hold it would have been the worse half of the change.
 */
import { assertEquals, assertNotEquals } from "@std/assert";
import {
  AGING_BUCKETS,
  type AgingBucketType,
  type AgingReport,
  type AgingRow,
  type AgingTotals,
  type OrgPathNodeType,
} from "../src/schemas/mod.ts";
import {
  agingAccountRows,
  bucketAmountCents,
  residualAgingTotals,
  UNATTRIBUTED_ACCOUNT_LABEL,
} from "../src/utils/reporting.ts";

// ── The corpus this file keeps ───────────────────────────────────────────────
//
// 🔴 **TWO LEAF NODES SHARING A NAME**, because prod has them and they are the
// case the grouped presentation gets wrong. Measured 2026-09-07 over the 28 open
// receivables: `Enemies Movie, LLC / (default) / Locations` and
// `Netflix Productions, LLC / Big Red / Locations` are two unrelated customers
// whose leaf segment is the single word "Locations" in both rows.
//
// ⚠️ The `(default)` node also earns its place: `composeOrgName` drops `derived`
// segments, so a fixture without one cannot tell a composed label apart from a
// naive `path.map((n) => n.name).join(" / ")`.

const node = (uid: string, name: string, derived = false): OrgPathNodeType =>
  ({ uid, name, derived }) as OrgPathNodeType;

const ENEMIES_LOCATIONS = [
  node("PRqxpQMdcfhdEIabdw7C", "Enemies Movie, LLC"),
  node("bJ9uakUaNOBLJNIEHnuX", "(default)", true),
  node("YWRsfgi3ARPpivx4eLh7", "Locations"),
];

const NETFLIX_LOCATIONS = [
  node("gql6Tjro2tSVrgP5NKOH", "Netflix Productions, LLC"),
  node("TXQfo7P2LXDFzesvdhbS", "Big Red"),
  node("s7WXepzsnaTbaKF0Et1T", "Locations"),
];

function totals(
  buckets: Partial<Record<AgingBucketType, number>>,
  creditCents = 0,
): AgingTotals {
  const entries = AGING_BUCKETS.map((bucket) => ({
    bucket,
    amount_cents: buckets[bucket] ?? 0,
  }));
  const bucketed = entries.reduce((sum, b) => sum + b.amount_cents, 0);
  return { buckets: entries, credit_cents: creditCents, total_cents: bucketed - creditCents };
}

function row(overrides: Partial<AgingRow> & Pick<AgingRow, "uid" | "organization_path">): AgingRow {
  return {
    number: 2364,
    anchor_date: "2026-08-22T00:00:00.000-05:00",
    days_overdue: 16,
    bucket: "1-30",
    amount_due_cents: 11025,
    ...overrides,
  } as AgingRow;
}

function report(overrides: Partial<AgingReport> = {}): AgingReport {
  return {
    scope: { kind: "all", uid: null, uids: [] },
    // `null` because the default scope here is `kind: "all"` — the run is not
    // about one account, which is a different statement from an account with no
    // name (core#92).
    organization_path: null,
    anchor: "due_date",
    as_of_invoice_date: "2026-09-07T00:00:00.000-05:00",
    as_of_payment_date: "2026-09-07T00:00:00.000-05:00",
    rows: [],
    totals: totals({}),
    organizations: [],
    missing_anchor_uids: [],
    ...overrides,
  };
}

// ── bucketAmountCents ────────────────────────────────────────────────────────

// 🔴 The buckets arrive as an ARRAY that the schema neither orders nor requires
// to be complete, so this is the arm that separates a name lookup from a
// positional one.
Deno.test("bucketAmountCents reads a bucket by name out of a shuffled, incomplete array", () => {
  const shuffled: AgingTotals = {
    buckets: [
      { bucket: "90+", amount_cents: 900 },
      { bucket: "current", amount_cents: 100 },
      { bucket: "31-60", amount_cents: 300 },
    ],
    credit_cents: 0,
    total_cents: 1300,
  };

  assertEquals(bucketAmountCents(shuffled, "current"), 100);
  assertEquals(bucketAmountCents(shuffled, "31-60"), 300);
  assertEquals(bucketAmountCents(shuffled, "90+"), 900);
});

// The fail-closed companion: without it, the arm above passes against a
// positional implementation on a *sorted, complete* array, which is the only
// array today's API sends.
Deno.test("bucketAmountCents disagrees with a positional read on that same array", () => {
  const shuffled: AgingTotals = {
    buckets: [
      { bucket: "90+", amount_cents: 900 },
      { bucket: "current", amount_cents: 100 },
      { bucket: "31-60", amount_cents: 300 },
    ],
    credit_cents: 0,
    total_cents: 1300,
  };
  const positional = shuffled.buckets[AGING_BUCKETS.indexOf("current")];

  assertEquals(positional.amount_cents, 900);
  assertNotEquals(bucketAmountCents(shuffled, "current"), positional.amount_cents);
});

Deno.test("bucketAmountCents reads an absent bucket as zero", () => {
  assertEquals(bucketAmountCents(totals({ current: 500 }), "61-90"), 0);
  assertEquals(bucketAmountCents({ buckets: [], credit_cents: 0, total_cents: 0 }, "current"), 0);
});

// ── agingAccountRows ─────────────────────────────────────────────────────────

Deno.test("agingAccountRows sorts by the composed label, not by the leaf segment", () => {
  const r = report({
    rows: [
      row({ uid: "a", organization_path: NETFLIX_LOCATIONS }),
      row({ uid: "b", organization_path: ENEMIES_LOCATIONS }),
    ],
    // Deliberately in the WRONG order for the rendered label — Netflix first, as
    // a uid-tie would have emitted them. The API sorts by the composed label
    // itself now, so this fixture is what keeps this sort honest rather than
    // passing because the input happened to arrive sorted.
    organizations: [
      { uid: "s7WXepzsnaTbaKF0Et1T", organization_path: NETFLIX_LOCATIONS, totals: totals({ current: 100 }) },
      { uid: "YWRsfgi3ARPpivx4eLh7", organization_path: ENEMIES_LOCATIONS, totals: totals({ current: 200 }) },
    ],
    totals: totals({ current: 300 }),
  });

  assertEquals(agingAccountRows(r).map((a) => a.label), [
    "Enemies Movie, LLC / Locations",
    "Netflix Productions, LLC / Big Red / Locations",
  ]);
});

// 🔴 The load-bearing property: a surface prints `report.totals` as its footer,
// so the rows above it must add up to that.
Deno.test("agingAccountRows ties to the report's own totals when every account is accounted for", () => {
  const r = report({
    rows: [row({ uid: "a", organization_path: ENEMIES_LOCATIONS })],
    organizations: [
      { uid: "YWRsfgi3ARPpivx4eLh7", organization_path: ENEMIES_LOCATIONS, totals: totals({ "1-30": 11025 }) },
    ],
    totals: totals({ "1-30": 11025 }),
  });

  const rows = agingAccountRows(r);
  assertEquals(rows.length, 1);
  assertEquals(rows.reduce((s, a) => s + a.totals.total_cents, 0), r.totals.total_cents);
});

Deno.test("agingAccountRows appends a residual row for money the grouped rows cannot hold", () => {
  // ⚠️ **The CAUSE here is historical; the row is not.** api-cloudrun#923 taught
  // the fold to emit a node for an organization holding credits and no rows, so
  // that particular hole is closed upstream. What survives is the arithmetic:
  // any total the accounts do not account for renders here, whatever produced it.
  const r = report({
    rows: [row({ uid: "a", organization_path: ENEMIES_LOCATIONS })],
    organizations: [
      { uid: "YWRsfgi3ARPpivx4eLh7", organization_path: ENEMIES_LOCATIONS, totals: totals({ "1-30": 11025 }) },
    ],
    totals: totals({ "1-30": 11025 }, 5000),
  });

  const rows = agingAccountRows(r);
  assertEquals(rows.length, 2);
  assertEquals(rows[1].uid, null);
  assertEquals(rows[1].label, UNATTRIBUTED_ACCOUNT_LABEL);
  assertEquals(rows[1].totals.credit_cents, 5000);
  assertEquals(rows[1].totals.total_cents, -5000);
  assertEquals(rows.reduce((s, a) => s + a.totals.total_cents, 0), r.totals.total_cents);

  // The fail-closed companion. Without it the tie above is algebra rather than
  // evidence: it would pass on a fixture where nothing is unattributed, and then
  // this file would certify a residual row it never exercised.
  const withoutResidual = r.organizations.reduce((s, o) => s + o.totals.total_cents, 0);
  assertNotEquals(withoutResidual, r.totals.total_cents);
});

Deno.test("agingAccountRows carries the residual PER BUCKET, not only as a total", () => {
  // 🔴 The arm that separates the two implementations this module replaced.
  // `manager` subtracted field by field; `templates/aging-report.eta` subtracts
  // only `total_cents` and leaves the bucket cells blank, so its bucket COLUMNS
  // do not tie when a residual exists. Neither is observable on prod today,
  // because the residual is zero — which is the shape a drift takes before it is
  // a defect, and the reason this now has one author.
  const r = report({
    rows: [row({ uid: "a", organization_path: [] })],
    organizations: [],
    totals: totals({ "1-30": 11025, "90+": 4000 }),
  });

  const rows = agingAccountRows(r);
  assertEquals(rows.length, 1);
  assertEquals(rows[0].uid, null);
  assertEquals(bucketAmountCents(rows[0].totals, "1-30"), 11025);
  assertEquals(bucketAmountCents(rows[0].totals, "90+"), 4000);
  assertEquals(rows[0].totals.total_cents, 15025);
});

Deno.test("agingAccountRows emits no residual row when nothing is unattributed", () => {
  const r = report({
    organizations: [
      { uid: "YWRsfgi3ARPpivx4eLh7", organization_path: ENEMIES_LOCATIONS, totals: totals({ "1-30": 11025 }) },
    ],
    totals: totals({ "1-30": 11025 }),
  });

  assertEquals(agingAccountRows(r).every((a) => a.uid !== null), true);
  assertEquals(residualAgingTotals(r).total_cents, 0);
});
