/**
 * The presentation fold over a reporting document — everything a SURFACE has to
 * derive from a response that nothing else derives for it.
 *
 * 🔴 **This module exists because the derivation had already been written
 * twice.** `manager/src/utils/agingReport.ts` and `templates/aging-report.eta`
 * each built the account × bucket matrix from `AgingReport.organizations[]`, and
 * a third copy was about to be written for the CSV export. They had already
 * drifted: the manager subtracts the residual per bucket and labels the row, the
 * template subtracts only the total and leaves the bucket cells blank. Neither
 * is observable today, because prod's residual is zero — which is exactly the
 * shape a drift takes before it is a defect.
 *
 * ⚠️ **What belongs here is narrow, and the boundary is worth stating.** Every
 * FIGURE on a report is read off the document: `AgingReport.organizations[]` is
 * already a second derivation of `AgingReport.totals`, deliberately, so the two
 * can disagree and catch a roll-up bug. A third derivation could only drift.
 * What this module owns is the one thing that is not on the document — the
 * arithmetic RESIDUAL between those two derivations — plus the ordering and the
 * labelling a table needs. Nothing here re-folds the report.
 */
import { AGING_BUCKETS, type AgingBucketType, type AgingReport, type AgingTotals } from "../schemas/reporting.ts";
import { composeOrgName } from "./organizations.ts";

/**
 * One bucket's amount out of an {@link AgingTotals}.
 *
 * 🔴 **Keyed by NAME, never by array position.** `AgingTotals.buckets` is a
 * `z.array(...).default([])` — the schema neither requires every member nor
 * fixes their order, so a matrix built by index would silently shift every
 * column the first time a bucket was omitted. Today's fold does emit all five in
 * order (`totalsOf` in `api-cloudrun/src/lib/agingFold.ts` maps over
 * `AGING_BUCKETS`), which is exactly why the positional form would pass every
 * test written against a live response and be wrong against the contract.
 *
 * An absent bucket reads as `0`, which is what the fold means by omitting it.
 */
export function bucketAmountCents(totals: AgingTotals, bucket: AgingBucketType): number {
  return totals.buckets.find((b) => b.bucket === bucket)?.amount_cents ?? 0;
}

/**
 * Sum the same field across several totals blocks.
 *
 * Integer cents, so addition is closed at the storage quantum and no rounding
 * decision exists — see the `cfs-money` skill. Emits every member of
 * {@link AGING_BUCKETS} in report order, so the result is a complete block
 * whatever the inputs omitted.
 */
export function sumAgingTotals(all: readonly AgingTotals[]): AgingTotals {
  return {
    buckets: AGING_BUCKETS.map((bucket) => ({
      bucket,
      amount_cents: all.reduce((sum, t) => sum + bucketAmountCents(t, bucket), 0),
    })),
    credit_cents: all.reduce((sum, t) => sum + t.credit_cents, 0),
    total_cents: all.reduce((sum, t) => sum + t.total_cents, 0),
  };
}

/** `a − b`, field by field. Closed for the same reason {@link sumAgingTotals} is. */
export function subtractAgingTotals(a: AgingTotals, b: AgingTotals): AgingTotals {
  return {
    buckets: AGING_BUCKETS.map((bucket) => ({
      bucket,
      amount_cents: bucketAmountCents(a, bucket) - bucketAmountCents(b, bucket),
    })),
    credit_cents: a.credit_cents - b.credit_cents,
    total_cents: a.total_cents - b.total_cents,
  };
}

/** Whether every figure in a totals block is zero — the normal case for a residual. */
export function isZeroAgingTotals(t: AgingTotals): boolean {
  return t.credit_cents === 0 && t.total_cents === 0 &&
    AGING_BUCKETS.every((bucket) => bucketAmountCents(t, bucket) === 0);
}

/**
 * `report.totals` minus the sum of `report.organizations[].totals` — what the
 * grouped rows do not account for.
 *
 * ⭐ **Stated as an arithmetic residual rather than as a list of causes, so it
 * ties by construction.** api-cloudrun#923 closed the credit case upstream — the
 * fold now emits a node for an organization holding credits and no rows — and
 * did not close the other one: a node whose chain is empty cannot be labelled at
 * all, so `AgingReportSchema`'s `.min(1)` refuses it and its money stays in
 * `totals`. Enumerating the causes would leave the third one unhandled.
 *
 * ⚠️ **That remaining hole is narrower than it reads**, and worth stating so a
 * reader does not delete this on a wrong premise:
 * `DocumentOrganizationSnapshot.path` is `.min(1).max(3)` and both
 * `Invoice.organization` and `CreditNote.organization` require it, so no
 * validated write can produce an empty chain. It covers a document predating
 * api-cloudrun#782's contract step, or a raw write bypassing
 * `validateBeforeWrite` — plus any third cause, which is the property that comes
 * from stating it as arithmetic rather than as a list.
 */
export function residualAgingTotals(report: AgingReport): AgingTotals {
  return subtractAgingTotals(report.totals, sumAgingTotals(report.organizations.map((o) => o.totals)));
}

/**
 * How a surface names the residual row.
 *
 * ⚠️ **A label with one author, for the same reason `composeOrgName` has one.**
 * A row that says something different on the screen, in the PDF and in the CSV
 * export is three descriptions of one figure, and a reader comparing two of them
 * cannot tell whether they are looking at the same thing. Recognise the row by
 * `uid === null`, not by this string.
 */
export const UNATTRIBUTED_ACCOUNT_LABEL = "Not attributed to an account";

/** One row of the account × bucket matrix — an account, or the reconciling residual. */
export interface AgingAccountRow {
  /** The organization node uid, or `null` on the residual row. */
  uid: string | null;
  /** The account's breadcrumb, or {@link UNATTRIBUTED_ACCOUNT_LABEL}. */
  label: string;
  totals: AgingTotals;
}

/**
 * The account × bucket matrix: one row per account, plus a residual row when the
 * accounts do not add up to the report's own totals.
 *
 * 🔴 **A surface prints `report.totals` as its footer and these rows must sum to
 * it**, or the reader sees an aged-receivables report whose accounts disagree
 * with its total — the one defect a customer finds and CFS does not. The
 * residual row is what makes that hold for every response, rather than for the
 * responses that happen to have no unattributed money.
 *
 * ⭐ **The label is composed from the node's own chain, which the response
 * carries** (api-cloudrun#923). It used to be joined out of `rows[]` because
 * `organizations[]` sent only a leaf segment; that workaround is gone along with
 * the `name` field that made it necessary — an organization is a `uid` and a
 * path, and `composeOrgName` is the one author of a label built from one.
 *
 * ⚠️ **Sorted here rather than trusting the response's order.** The API does
 * sort by the same composed label today, but a table's ordering is the
 * renderer's own guarantee and it costs one comparison. The residual is appended
 * last whatever the sort, because it is not an account.
 */
export function agingAccountRows(report: AgingReport): AgingAccountRow[] {
  const rows: AgingAccountRow[] = report.organizations
    .map((org) => ({
      uid: org.uid as string | null,
      label: composeOrgName(org.organization_path),
      totals: org.totals,
    }))
    .sort((a, b) => a.label.localeCompare(b.label) || String(a.uid).localeCompare(String(b.uid)));
  const residual = residualAgingTotals(report);
  if (!isZeroAgingTotals(residual)) {
    rows.push({ uid: null, label: UNATTRIBUTED_ACCOUNT_LABEL, totals: residual });
  }
  return rows;
}
