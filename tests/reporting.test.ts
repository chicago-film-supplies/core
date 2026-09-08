import { assertEquals, assertThrows } from "@std/assert";
import {
  AGING_ANCHORS,
  AGING_BUCKET_EDGES,
  AGING_BUCKETS,
  agingBucketOf,
  AgingReportSchema,
  OrgStatementSchema,
  type AgingBucketType,
} from "../src/schemas/reporting.ts";
import { agingOf } from "../src/utils/invoices.ts";
import { collectMaskedLeaves } from "../src/utils/fixture-pii.ts";

// ── The bucket table ────────────────────────────────────────────────
//
// ⭐ These are PROPERTIES of the edge table, not a second copy of it. Asserting
// the six literals back would agree with the table by construction and could
// only ever catch a typo in the test; asserting contiguity and totality catches
// a real edit — a moved edge, a duplicated range, a bucket that swallows its
// neighbour — which is the class of change these boundaries actually get.

Deno.test("the bucket edges are contiguous and leave no gap", () => {
  let expectedNext: number | null = null; // null until the first bounded edge
  for (const bucket of AGING_BUCKETS) {
    const { from_days, to_days } = AGING_BUCKET_EDGES[bucket];
    if (expectedNext !== null) {
      assertEquals(from_days, expectedNext, `${bucket} does not start where its predecessor ended`);
    }
    expectedNext = to_days === null ? null : to_days + 1;
  }
  assertEquals(expectedNext, null, "the last bucket must be unbounded above");
  assertEquals(
    AGING_BUCKET_EDGES[AGING_BUCKETS[0]].from_days,
    null,
    "the first bucket must be unbounded below",
  );
});

Deno.test("every bucket's range is non-empty and ordered", () => {
  for (const bucket of AGING_BUCKETS) {
    const { from_days, to_days } = AGING_BUCKET_EDGES[bucket];
    if (from_days !== null && to_days !== null) {
      assertEquals(from_days <= to_days, true, `${bucket} has an inverted range`);
    }
  }
});

Deno.test("agingBucketOf is TOTAL and assigns each day to exactly one bucket", () => {
  for (let days = -400; days <= 400; days++) {
    const matches = AGING_BUCKETS.filter((b) => {
      const { from_days, to_days } = AGING_BUCKET_EDGES[b];
      return (from_days === null || days >= from_days) &&
        (to_days === null || days <= to_days);
    });
    assertEquals(matches.length, 1, `${days} days matched ${matches.length} buckets`);
    assertEquals(agingBucketOf(days), matches[0] as AgingBucketType);
  }
});

Deno.test("🔴 not-yet-due and due-today are both Current", () => {
  assertEquals(agingBucketOf(-1), "current");
  // Due today is CURRENT, not one day overdue. Off-by-one here silently moves
  // every invoice due today into the first overdue bucket.
  assertEquals(agingBucketOf(0), "current");
  assertEquals(agingBucketOf(1), "1-30");
});

Deno.test("the 90 boundary is not double-counted", () => {
  assertEquals(agingBucketOf(90), "61-90");
  assertEquals(agingBucketOf(91), "90+");
});

// ── agingOf ─────────────────────────────────────────────────────────

Deno.test("agingOf composes the count and the bucket from two Chicago dates", () => {
  assertEquals(
    agingOf("2026-08-01T00:00:00.000-05:00", "2026-09-07T00:00:00.000-05:00"),
    { days_overdue: 37, bucket: "31-60" },
  );
});

Deno.test("agingOf is negative before the anchor and Current", () => {
  assertEquals(
    agingOf("2026-09-20T00:00:00.000-05:00", "2026-09-07T00:00:00.000-05:00"),
    { days_overdue: -13, bucket: "current" },
  );
});

Deno.test("🔴 agingOf is DST-correct at a bucket edge across fall-back", () => {
  // 2026-10-02 → 2026-11-01 is 30 calendar days and the fall-back is inside it.
  // Millisecond arithmetic yields 30.04 days, which floors to 30 and agrees here
  // by luck; the edge that actually moves is the one below.
  assertEquals(agingOf("2026-10-02T00:00:00.000-05:00", "2026-11-01T00:00:00.000-06:00").bucket, "1-30");
  // …and one day later it must tip, on the calendar rather than on 24-hour
  // multiples. A naive implementation is still inside `1-30` here.
  assertEquals(
    agingOf("2026-10-02T00:00:00.000-05:00", "2026-11-02T00:00:00.000-06:00"),
    { days_overdue: 31, bucket: "31-60" },
  );
});

// ── The anchors ─────────────────────────────────────────────────────

Deno.test("🔴 every anchor names a real stored field on the invoice document", async () => {
  // The anchor doubles as the projection path and the sort key, so a member that
  // is not a stored field would be a query the aggregator cannot run — and it
  // would fail at request time, not here, on a report nobody runs often.
  const { InvoiceSchema } = await import("../src/schemas/invoice.ts");
  // deno-lint-ignore no-explicit-any
  const shape = (InvoiceSchema as any).shape ?? (InvoiceSchema as any)._def?.shape?.();
  for (const anchor of AGING_ANCHORS) {
    assertEquals(
      Object.hasOwn(shape, anchor),
      true,
      `AGING_ANCHORS names "${anchor}", which is not a field on InvoiceSchema`,
    );
  }
});

// ── The response schema ─────────────────────────────────────────────

const REPORT = {
  scope: { kind: "organization", uid: "a".repeat(20), name: "Netflix Productions, LLC", uids: ["a".repeat(20)] },
  anchor: "due_date",
  as_of_invoice_date: "2026-09-07T00:00:00.000-05:00",
  as_of_payment_date: "2026-09-07T00:00:00.000-05:00",
  rows: [{
    uid: "b".repeat(20),
    number: 2247,
    organization_path: [{ uid: "a".repeat(20), name: "Netflix Productions, LLC", derived: false }],
    anchor_date: "2026-08-01T00:00:00.000-05:00",
    days_overdue: 37,
    bucket: "31-60",
    amount_due_cents: 44350,
  }],
  totals: {
    buckets: AGING_BUCKETS.map((b) => ({ bucket: b, amount_cents: b === "31-60" ? 44350 : 0 })),
    credit_cents: 0,
    total_cents: 44350,
  },
  organizations: [{
    uid: "a".repeat(20),
    organization_path: [{ uid: "a".repeat(20), name: "Netflix Productions, LLC", derived: false }],
    totals: {
      buckets: AGING_BUCKETS.map((b) => ({ bucket: b, amount_cents: b === "31-60" ? 44350 : 0 })),
      credit_cents: 0,
      total_cents: 44350,
    },
  }],
  missing_anchor_uids: [],
};

Deno.test("AgingReportSchema accepts a well-formed report", () => {
  const parsed = AgingReportSchema.parse(REPORT);
  assertEquals(parsed.rows[0].bucket, "31-60");
  assertEquals(parsed.totals.total_cents, 44350);
});

Deno.test("AgingReportSchema is strict — an undeclared key is refused", () => {
  assertThrows(() => AgingReportSchema.parse({ ...REPORT, as_of: "2026-09-07" }));
});

Deno.test("AgingReportSchema refuses a bucket that is not in the vocabulary", () => {
  assertThrows(() =>
    AgingReportSchema.parse({
      ...REPORT,
      rows: [{ ...REPORT.rows[0], bucket: "120+" }],
    })
  );
});

Deno.test("🔴 every organization name on the report is PII-classified as mask", () => {
  // ⭐ Asserted through `collectMaskedLeaves`, which reports which leaves the
  // walker actually REACHES and classifies — not through a masked output, where
  // a name that merely looks changed proves nothing about the classification.
  //
  // The chain is carried as `OrgPathNode[]` rather than a composed label
  // precisely so the mask it already carries applies here without a fresh
  // ruling. A flattened string copy is the shape that slipped `applyPii`
  // untouched on the pick sheet — measured, not hypothetical.
  const leaves = collectMaskedLeaves(AgingReportSchema.parse(REPORT), AgingReportSchema)
    .map((l) => l.fieldPath);

  // ⚠️ `collectMaskedLeaves` reports SCHEMA paths, so array steps carry no index
  // — `rows.organization_path.name`, not `rows.0.organization_path.0.name`. It
  // is a statement about the declaration, which is exactly the claim being made.
  for (
    const path of [
      "scope.name",
      "rows.organization_path.name",
      // The grouped node's own chain (api-cloudrun#923). There is no sibling
      // `name` on these nodes any more — `uid` identifies and the chain labels —
      // so this is the ONLY organization name the grouped presentation carries,
      // and its classification cannot be inherited from a neighbour by adjacency.
      "organizations.organization_path.name",
    ]
  ) {
    assertEquals(leaves.includes(path), true, `${path} is not classified pii:"mask" — leaves: ${leaves}`);
  }
});

Deno.test("🔴 a grouped organization node without a chain is REFUSED", () => {
  // The whole point of api-cloudrun#923 is that a bare `name` cannot identify a
  // department node, so a node that carries none is not a shape this report
  // supports. `.min(1)` says so at the contract, which is why the fold can skip
  // such a node rather than inventing a blank heading for it.
  assertThrows(() =>
    AgingReportSchema.parse({
      ...REPORT,
      organizations: [{ ...REPORT.organizations[0], organization_path: [] }],
    })
  );
  assertThrows(() =>
    AgingReportSchema.parse({
      ...REPORT,
      organizations: [{
        uid: REPORT.organizations[0].uid,
        totals: REPORT.organizations[0].totals,
      }],
    })
  );
});

Deno.test("🔴 a grouped node carrying a composed `name` beside its chain is REFUSED", () => {
  // ⭐ The removal is enforced by `z.strictObject`, not merely documented.
  // api-cloudrun#782 deleted the composed label from `DocumentOrganizationSnapshot`
  // for the same reason — a name stored beside the path it composes from is a
  // second owner of one fact — and this asserts the report cannot re-introduce it.
  assertThrows(() =>
    AgingReportSchema.parse({
      ...REPORT,
      organizations: [{ ...REPORT.organizations[0], name: "Netflix Productions, LLC" }],
    })
  );
});

// ── The Org Statement ───────────────────────────────────────────────
//
// 🔴 Each clause of OrgStatementSchema's refinement gets a PLANTED failure, not
// just a happy path. A refinement that has never gone red is indistinguishable
// from one the walker stopped reaching — and the whole reason this is a
// refinement rather than a test is to make a statement that does not add up
// unrepresentable.

const ORG = [{ uid: "a".repeat(20), name: "Netflix Productions, LLC", derived: false }];

const STATEMENT = {
  scope: { kind: "organization", uid: "a".repeat(20), name: "Netflix Productions, LLC", uids: ["a".repeat(20)] },
  format: "balance_forward",
  from_date: "2026-08-01T00:00:00.000-05:00",
  to_date: "2026-09-07T00:00:00.000-05:00",
  as_of_payment_date: "2026-09-07T00:00:00.000-05:00",
  organization_path: ORG,
  billing_address: null,
  opening_balance_cents: 10_000,
  lines: [
    {
      kind: "invoice", uid_invoice: "b".repeat(20), number: 2247, uid_settlement: null,
      settlement_type: null, date: "2026-08-01T00:00:00.000-05:00", reference: null,
      amount_cents: 44_350, effect_cents: 44_350, balance_cents: 54_350, organization_path: ORG,
    },
    {
      kind: "settlement", uid_invoice: "b".repeat(20), number: 2247, uid_settlement: "c".repeat(20),
      settlement_type: "payment", date: "2026-08-20T00:00:00.000-05:00", reference: "ACH 8891",
      amount_cents: 20_000, effect_cents: -20_000, balance_cents: 34_350, organization_path: ORG,
    },
  ],
  closing_balance_cents: 34_350,
  aging: {
    buckets: AGING_BUCKETS.map((b) => ({ bucket: b, amount_cents: b === "31-60" ? 34_350 : 0 })),
    credit_cents: 0,
    total_cents: 34_350,
  },
};

Deno.test("OrgStatementSchema accepts a statement that ties", () => {
  const parsed = OrgStatementSchema.parse(STATEMENT);
  assertEquals(parsed.closing_balance_cents, 34_350);
  assertEquals(parsed.lines[1].effect_cents, -20_000);
});

Deno.test("🔴 clause 1 — a line whose effect_cents disagrees with amount_cents is refused", () => {
  // The journal stores a POSITIVE amount and takes direction from `type`. A
  // renderer that flipped one and not the other would print a payment as a
  // charge; this makes the pair unrepresentable rather than merely wrong.
  assertThrows(() =>
    OrgStatementSchema.parse({
      ...STATEMENT,
      lines: [STATEMENT.lines[0], { ...STATEMENT.lines[1], effect_cents: -19_999 }],
    })
  );
});

Deno.test("🔴 clause 2 — a running balance that is not the running sum is refused", () => {
  assertThrows(() =>
    OrgStatementSchema.parse({
      ...STATEMENT,
      lines: [{ ...STATEMENT.lines[0], balance_cents: 54_351 }, STATEMENT.lines[1]],
    })
  );
});

Deno.test("🔴 clause 3 — a closing balance that does not tie is refused", () => {
  assertThrows(() => OrgStatementSchema.parse({ ...STATEMENT, closing_balance_cents: 34_351 }));
});

Deno.test("🔴 clause 3 fires on an EMPTY statement, where clause 2 cannot", () => {
  // A customer carrying an opening balance and no activity in the period is a
  // real case, and the running-sum clause is vacuous over zero lines — so this
  // is the arm that catches a wrong closing balance there.
  const empty = { ...STATEMENT, lines: [], closing_balance_cents: 10_000 };
  assertEquals(OrgStatementSchema.parse(empty).closing_balance_cents, 10_000);
  assertThrows(() => OrgStatementSchema.parse({ ...empty, closing_balance_cents: 0 }));
});

Deno.test("a settlement reversal RAISES the balance", () => {
  // Direction comes from `type`, so a reversal is a positive effect against a
  // positive amount — the one case where kind:"settlement" does not reduce.
  const reversal = {
    ...STATEMENT,
    lines: [...STATEMENT.lines, {
      kind: "settlement" as const, uid_invoice: "b".repeat(20), number: 2247,
      uid_settlement: "d".repeat(20), settlement_type: "payment_reversal" as const,
      date: "2026-08-25T00:00:00.000-05:00", reference: null,
      amount_cents: 20_000, effect_cents: 20_000, balance_cents: 54_350, organization_path: ORG,
    }],
    closing_balance_cents: 54_350,
  };
  assertEquals(OrgStatementSchema.parse(reversal).closing_balance_cents, 54_350);
});

Deno.test("OrgStatementSchema is strict and refuses an unknown format", () => {
  assertThrows(() => OrgStatementSchema.parse({ ...STATEMENT, format: "aged" }));
  assertThrows(() => OrgStatementSchema.parse({ ...STATEMENT, period: "august" }));
});

Deno.test("🔴 a statement line's organization names are PII-classified as mask", () => {
  const leaves = collectMaskedLeaves(OrgStatementSchema.parse(STATEMENT), OrgStatementSchema)
    .map((l) => l.fieldPath);
  for (const path of ["scope.name", "organization_path.name", "lines.organization_path.name"]) {
    assertEquals(leaves.includes(path), true, `${path} is not pii:"mask" — leaves: ${leaves}`);
  }
});
