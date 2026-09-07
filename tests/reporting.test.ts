import { assertEquals, assertThrows } from "@std/assert";
import {
  AGING_ANCHORS,
  AGING_BUCKET_EDGES,
  AGING_BUCKETS,
  agingBucketOf,
  AgingReportSchema,
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
    name: "Netflix Productions, LLC",
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
  for (const path of ["scope.name", "rows.organization_path.name", "organizations.name"]) {
    assertEquals(leaves.includes(path), true, `${path} is not classified pii:"mask" — leaves: ${leaves}`);
  }
});
