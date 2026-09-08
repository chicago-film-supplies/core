/**
 * Receivables reporting — the AR Aging report and the Org Statement.
 *
 * Both are **derived documents**, like a pick sheet ({@link ./pick-sheet.ts}) or
 * a movement session: nothing is stored at this shape and every call rebuilds
 * from `invoices` and the `settlements` journal, which are read-only inputs.
 *
 * ## What is NOT here yet, deliberately
 *
 * ⚠️ **The `Dataset` / `Dimension` / `Measure` vocabulary of the declared
 * semantic layer is NOT in this module, and its absence is a decision rather
 * than an omission.** `core/CLAUDE.md` requires surveying a closed vocabulary
 * *and writing its first consumer* before publishing it, and that layer's first
 * consumer is the sales-reporting phase — it does not exist. Publishing the
 * vocabulary a beta early would freeze three enums against zero call sites,
 * which is the shape core#43 and `beta.342` are both about. It lands with its
 * consumer.
 *
 * ⭐ **Nothing here is closed against it.** The aging vocabulary below is a
 * `dimension`-shaped axis (`AGING_BUCKETS`) over a `measure`-shaped column
 * (cents), so the later layer describes these reports rather than replacing
 * them. The same applies to the eventual allocation primitive — spreading one
 * population's cost over another is a third primitive beside dimension and
 * measure, and **this module must not grow a shape that forecloses it.**
 *
 * ## The one rule that decides membership
 *
 * 🔴 **The aging population is `totals.amount_due_cents > 0`, never a status
 * set.** `INVOICE_STATUS_CONTRACTS` ({@link ./invoice.ts}) deliberately has no
 * `amounts` column, and paging prod killed both candidate rules: `paid ⟹
 * amount_due <= 0` fails on **20 of 813**, `issued ⟹ amount_paid == 0` fails on
 * **75 of 98** (measured 2026-09-07). A status is a workflow position; the
 * balance is a number, and only the number is the receivable.
 *
 * @module
 */
import { z } from "zod";
import { FirestoreId } from "./_uid.ts";
import {
  Address,
  type AddressType,
  OrgPathNode,
  type OrgPathNodeType,
  SettlementTypeEnum,
  type SettlementTypeType,
} from "./common.ts";

// ── The anchor ──────────────────────────────────────────────────────

/**
 * Which stored date an invoice is aged from.
 *
 * ⭐ **Both members name a REAL STORED FIELD on `invoices`** — `date` and
 * `due_date` — rather than a report-local alias. That is what lets the
 * aggregator use the member as the projection path and the sort key, so an
 * anchor cannot name something the query cannot order by.
 *
 * `due_date` is the default and matches the live Xero tenant, whose every
 * aged-receivables link carries `ageingBy=due` (read 2026-09-07). `date` stays
 * available as a request parameter because an invoice-date run is the one an
 * auditor asks for.
 *
 * 🔴 **Xero buckets by CALENDAR MONTH and this report buckets by ROLLING 30
 * DAYS** — its report links carry `periodCount=4&periodFrequency=1&periodKind=2`,
 * four periods of one month. The two tie on the TOTAL and are guaranteed to
 * differ per bucket, so a per-bucket comparison against Xero is a false failure
 * by construction. See {@link AGING_BUCKETS}.
 */
export const AGING_ANCHORS = ["date", "due_date"] as const;

/** One member of {@link AGING_ANCHORS}. */
export type AgingAnchorType = typeof AGING_ANCHORS[number];

/** Zod enum over {@link AGING_ANCHORS}. */
export const AgingAnchorEnum: z.ZodType<AgingAnchorType> = z.enum(AGING_ANCHORS);

// ── The buckets ─────────────────────────────────────────────────────

/**
 * The aging buckets, in report order.
 *
 * Rolling 30 days from the anchor. `current` is *not yet due* — an invoice due
 * today is current, not one day overdue.
 *
 * ⚠️ **The names are stable identifiers, not labels.** `90+` reads as
 * "over 90", and the label in {@link AGING_BUCKET_EDGES} says so; the edges are
 * `61-90 = 61..90` and `90+ = 91..∞`, so nothing is double-counted at 90.
 */
export const AGING_BUCKETS = ["current", "1-30", "31-60", "61-90", "90+"] as const;

/** One member of {@link AGING_BUCKETS}. */
export type AgingBucketType = typeof AGING_BUCKETS[number];

/** Zod enum over {@link AGING_BUCKETS}. */
export const AgingBucketEnum: z.ZodType<AgingBucketType> = z.enum(AGING_BUCKETS);

/** One bucket's inclusive edges, in whole days overdue. */
export interface AgingBucketEdge {
  /** What the column heading says. */
  label: string;
  /** Inclusive lower bound in days overdue; `null` is unbounded below. */
  from_days: number | null;
  /** Inclusive upper bound in days overdue; `null` is unbounded above. */
  to_days: number | null;
}

/**
 * Each bucket's edges — **the single owner of the bucket boundaries.**
 *
 * ⭐ **A `Record` over {@link AgingBucketType}, so a member added to
 * {@link AGING_BUCKETS} without edges is a COMPILE ERROR.** The same idiom as
 * `INVOICE_STATUS_CONTRACTS`. {@link agingBucketOf} walks this table rather than
 * carrying its own thresholds, so there is no second copy of the rule to drift
 * from the names.
 */
export const AGING_BUCKET_EDGES: Readonly<Record<AgingBucketType, AgingBucketEdge>> = {
  "current": { label: "Current", from_days: null, to_days: 0 },
  "1-30": { label: "1–30 days", from_days: 1, to_days: 30 },
  "31-60": { label: "31–60 days", from_days: 31, to_days: 60 },
  "61-90": { label: "61–90 days", from_days: 61, to_days: 90 },
  "90+": { label: "Over 90 days", from_days: 91, to_days: null },
};

/**
 * Which bucket a given number of days overdue falls in.
 *
 * `days_overdue` is signed: negative or zero means not yet due. Callers should
 * prefer {@link agingOf}, which computes the count DST-correctly and returns
 * both halves so they cannot disagree.
 *
 * ⚠️ **Total by construction** — the first and last buckets are unbounded, so
 * every integer lands somewhere and there is no fallthrough to explain.
 */
export function agingBucketOf(daysOverdue: number): AgingBucketType {
  for (const bucket of AGING_BUCKETS) {
    const { from_days, to_days } = AGING_BUCKET_EDGES[bucket];
    if (from_days !== null && daysOverdue < from_days) continue;
    if (to_days !== null && daysOverdue > to_days) continue;
    return bucket;
  }
  // Unreachable: `current` is unbounded below and `90+` unbounded above.
  return "90+";
}

/**
 * Age one invoice: how many whole Chicago calendar days past its anchor date the
 * report is being drawn, and which bucket that puts it in.
 *
 * 🔴 **Calendar days, not elapsed milliseconds.** `anchor` is a
 * `chicagoStartOfDay()` field and Chicago days are 23 or 25 hours long twice a
 * year, so a millisecond subtraction moves invoices between buckets on every
 * bucket edge, twice a year. `chicagoDaysBetween` is the owner of that
 * arithmetic; see `core/src/utils/dates.ts` for the measured counterexample.
 *
 * ⚠️ **Kept as a pair, deliberately.** A caller that computed the day count
 * itself and then asked for a bucket would be a second copy of the rule, and the
 * two would drift the first time an edge moved.
 */
export interface InvoiceAging {
  /** Whole Chicago calendar days past the anchor; ≤ 0 means not yet due. */
  days_overdue: number;
  bucket: AgingBucketType;
}

// ── A row ───────────────────────────────────────────────────────────

/**
 * One open invoice, as the aging report states it — the receivables fact.
 *
 * ⚠️ **`amount_due_cents` is READ from the invoice, never re-folded from the
 * settlements journal.** `recomputeSettlementTotals` already derives it and
 * `settlementTotalsSweep` already checks it against the journal hourly; a second
 * fold here would be an instrument sharing an ancestor with its subject, and it
 * would disagree with the number the customer sees on their invoice.
 */
export interface AgingRow {
  uid: string;
  /** The human invoice number, for a reader reconciling against Xero by hand. */
  number: number;
  /**
   * The invoice's own organization chain, **frozen as the invoice recorded it**.
   *
   * ⭐ The report GROUPS by the live tree and each line PRINTS its own frozen
   * chain. A reader arriving from the cascade rules will read that as crossing
   * the freeze boundary; it is not. The freeze governs what a *document*
   * records, not how a *report* groups documents.
   */
  organization_path: OrgPathNodeType[];
  /** The anchor's stored value — `date` or `due_date`, per the request. */
  anchor_date: string;
  days_overdue: number;
  bucket: AgingBucketType;
  amount_due_cents: number;
}

/** Zod schema for {@link AgingRow}. */
export const AgingRowSchema: z.ZodType<AgingRow> = z.strictObject({
  uid: FirestoreId,
  number: z.int(),
  // PII rides in by COMPOSITION: `OrgPathNode.name` is already `pii: "mask"`, so
  // this array sanitizes without a fresh ruling. ⭐ That is the whole reason to
  // carry the chain rather than a composed label — a flattened string copy is
  // exactly the shape that slipped `applyPii` untouched on the pick sheet.
  organization_path: z.array(OrgPathNode).min(1).max(3),
  anchor_date: z.string(),
  days_overdue: z.int(),
  bucket: AgingBucketEnum,
  amount_due_cents: z.int(),
});

// ── Totals ──────────────────────────────────────────────────────────

/**
 * Money per bucket, plus the credit-note column.
 *
 * 🔴 **Credit notes get their OWN COLUMN and are never bucketed.** Surveyed
 * across six systems there is no convention — NetSuite buckets by the credit
 * note's own date, QuickBooks puts it inside "Current" as a negative, Open
 * Dental excludes it from buckets but keeps it in the total, Dynamics gives it
 * its own column and Xero its own row. **A column is the only presentation where
 * the reader cannot be misled**, and it is also the only one that survives
 * Xero's own warning that a due-date basis *"won't include credit notes as they
 * don't have due dates"* — a naive due-date implementation silently drops every
 * one of them, the report stops tying to AR, and nothing errors.
 */
export interface AgingTotals {
  /** One entry per {@link AGING_BUCKETS} member, in report order. */
  buckets: Array<{ bucket: AgingBucketType; amount_cents: number }>;
  /**
   * Unapplied credit-note value, in its own column.
   *
   * Positive as stated; a renderer shows it as a deduction. It has no bucket
   * because a credit note has no due date to age from.
   */
  credit_cents: number;
  /**
   * Σ buckets − credits. **This is the number that must tie to AR.**
   *
   * ⚠️ Tie it to Xero on the TOTAL ONLY. Xero buckets by calendar month and this
   * report by rolling 30 days, so a per-bucket assertion is a guaranteed false
   * failure. See {@link AGING_ANCHORS}.
   */
  total_cents: number;
}

/** Zod schema for {@link AgingTotals}. */
export const AgingTotalsSchema: z.ZodType<AgingTotals> = z.strictObject({
  buckets: z.array(z.strictObject({
    bucket: AgingBucketEnum,
    amount_cents: z.int(),
  })).default([]),
  credit_cents: z.int(),
  total_cents: z.int(),
});

// ── The report ──────────────────────────────────────────────────────

/**
 * What an aging run was drawn for — echoed back, so a stored or forwarded report
 * says what question it answers. Same contract as `PickSheetScope`.
 */
export interface AgingScope {
  /** `organization` rolls up one subtree; `all` is every open receivable. */
  kind: "organization" | "all";
  /** The organization asked about, or `null` for `all`. */
  uid: string | null;
  /** Its display name at run time; `""` when it could not be read. */
  name: string;
  /**
   * Every organization uid the roll-up actually ran on.
   *
   * ⭐ **The LIVE tree** (`query_by_path array-contains`, self-inclusive), not
   * the frozen chains — settled on api-cloudrun#712. A re-parent should move the
   * money in the next run; that is the report working. The cascade keeps
   * unsettled invoices' chains current, so live and frozen agree by construction
   * for exactly the population this report covers.
   */
  uids: string[];
}

/** Zod schema for {@link AgingScope}. */
export const AgingScopeSchema: z.ZodType<AgingScope> = z.strictObject({
  kind: z.enum(["organization", "all"]),
  uid: FirestoreId.nullable(),
  // `mask` — an organization name is `pii: "mask"` at its source, and a copy must
  // not be classified independently of the value it copies.
  name: z.string().default("").meta({ pii: "mask" }),
  uids: z.array(FirestoreId).default([]),
});

/**
 * The AR Aging report.
 *
 * ⭐ **Two as-of dates, not one, and they are free here only because
 * `settlements` is already a dated allocation journal.** `as_of_invoice_date`
 * says which invoices existed; `as_of_payment_date` says which settlements
 * count. An *audit* view sets both to the period end; a *collections* view sets
 * invoices to the period end and payments to today. Dynamics 365 ships these
 * separately, Xero and NetSuite conflate them, and Oracle warns of "balance
 * discrepancies" as a result. **A system without a dated journal cannot add this
 * later.**
 */
export interface AgingReport {
  scope: AgingScope;
  anchor: AgingAnchorType;
  /** Which invoices existed. Defaults to today. */
  as_of_invoice_date: string;
  /** Which settlements count. Defaults to today. */
  as_of_payment_date: string;
  /** One per open invoice, in bucket order then anchor-date order. */
  rows: AgingRow[];
  /** Scope-wide, across every row. */
  totals: AgingTotals;
  /**
   * Per-organization-node subtotals, for the grouped presentation.
   *
   * 🔴 **This is a SECOND code path to the same number, and that is the point.**
   * Σ of these per-node totals (which never walks the tree) must equal
   * {@link AgingReport.totals} (which does). Two independent derivations of one
   * figure is the only check that can catch a roll-up bug; an assertion derived
   * from the roll-up itself would agree by construction.
   */
  organizations: Array<{
    uid: string;
    /**
     * The node's OWN segment.
     *
     * 🔴 **Not an identity, and the level it fails at is the one a receivables
     * roll-up sits on.** The tree is `[organization] [project] [department]`
     * (`ORG_LEVELS`); censused over all 318 prod organizations on 2026-09-07,
     * root names are unique 264/264 and project names 15/15, while the 29
     * department nodes carry only 8 distinct names — 24 of them share just
     * `Locations` (12), `Office` (10) and `Transpo` (2). A department name is a
     * small closed vocabulary a production reuses, which is the whole reason
     * the tree exists. **Compose the label from
     * {@link AgingReport.organizations.organization_path} instead.**
     */
    name: string;
    /**
     * The node's own chain from the root, so every consumer composes one label
     * with `composeOrgName` — the one author of a composed organization name.
     *
     * ⚠️ **The join a client would otherwise have to do is not available to
     * every client.** A `rows[]` entry carries the same chain, but adding a GET
     * route auto-publishes an MCP tool, and an agent reading `organizations[]`
     * without `rows[]` cannot tell two `Locations` nodes apart at all
     * (api-cloudrun#923).
     *
     * PII rides in by COMPOSITION — `OrgPathNode.name` is already
     * `pii: "mask"`, so this array sanitizes without a fresh ruling, exactly as
     * {@link AgingRow.organization_path} does.
     */
    organization_path: OrgPathNodeType[];
    totals: AgingTotals;
  }>;
  /**
   * Invoices in the population whose anchor field is absent.
   *
   * 🔴 **Surfaced as an exception, never given a bucket.** Prod carries **0**
   * (1,037 of 1,037 invoices hold both `date` and `due_date`, re-measured
   * 2026-09-07) and `createInvoice` now defaults `due_date`, so a non-empty list
   * here is a **data defect to repair**, not a state the report supports. Giving
   * it a bucket would build a vocabulary for a gap that is being closed, and
   * would make the defect permanent by making it representable.
   *
   * ⚠️ `updateInvoice` still accepts an explicit `null` as a CLEAR verb, so this
   * is reachable today. That is the remaining hole, and it is why this list
   * exists rather than an assertion.
   */
  missing_anchor_uids: string[];
}

/** Zod schema for {@link AgingReport}. */
export const AgingReportSchema: z.ZodType<AgingReport> = z.strictObject({
  scope: AgingScopeSchema,
  anchor: AgingAnchorEnum,
  as_of_invoice_date: z.string(),
  as_of_payment_date: z.string(),
  rows: z.array(AgingRowSchema).default([]),
  totals: AgingTotalsSchema,
  organizations: z.array(z.strictObject({
    uid: FirestoreId,
    name: z.string().default("").meta({ pii: "mask" }),
    // `.min(1)` on purpose: a node whose chain is empty cannot be labelled, and
    // emitting one under a blank heading is the ambiguity this field exists to
    // remove. The fold skips such a node and its money stays in `totals`, where
    // the reader sees it as the residual rather than as a nameless account.
    organization_path: z.array(OrgPathNode).min(1).max(3),
    totals: AgingTotalsSchema,
  })).default([]),
  missing_anchor_uids: z.array(FirestoreId).default([]),
}).meta({ title: "AgingReport" });

// ── The Org Statement ───────────────────────────────────────────────

/**
 * How a statement presents the account.
 *
 * 🔴 **Storage is OPEN-ITEM; balance-forward is a RENDERING.** Both formats read
 * the same lines — the difference is whether the document leads with an opening
 * balance and a running column, or lists the outstanding items. A `param` on one
 * template family, never two families.
 *
 * ⚠️ **The balance-forward presentation must not imply a posting policy.**
 * Historically it implies FIFO application — Oracle's wording is that payments
 * *"are not matched to bills… implicitly relieve a customer's oldest debt"* — and
 * CFS does not work that way: every settlement names its `uid_invoice`
 * explicitly. {@link StatementLine.balance_cents} is therefore arithmetic over
 * dated events and nothing more. A template must not caption it as an
 * application order.
 */
export const STATEMENT_FORMATS = ["open_item", "balance_forward"] as const;

/** One member of {@link STATEMENT_FORMATS}. */
export type StatementFormatType = typeof STATEMENT_FORMATS[number];

/** Zod enum over {@link STATEMENT_FORMATS}. */
export const StatementFormatEnum: z.ZodType<StatementFormatType> = z.enum(STATEMENT_FORMATS);

/**
 * One dated event against the account.
 *
 * ⭐ **Two money fields on purpose, and a refinement makes them agree.**
 * `amount_cents` mirrors the journal — **always positive**, exactly as
 * `settlement.ts` stores it, because direction there comes from `type` via
 * `getSettlementMultiplier` and never from a sign. `effect_cents` is that
 * direction already applied, resolved ONCE by the aggregator. Carrying only the
 * positive value would push `getSettlementMultiplier` into every renderer;
 * carrying only the signed one would lose the journal's own number. The
 * refinement on {@link OrgStatementSchema} asserts `|effect| === amount`, so the
 * pair cannot drift.
 */
export interface StatementLine {
  /** `invoice` raises the balance; `settlement` moves it by its type's direction. */
  kind: "invoice" | "settlement";
  /** The invoice this line concerns — a settlement names the invoice it settled. */
  uid_invoice: string;
  /** The human invoice number, so a customer can match it to their copy. */
  number: number;
  /** The settlement document, or `null` on an invoice line. */
  uid_settlement: string | null;
  /** The journal's own type, or `null` on an invoice line. */
  settlement_type: SettlementTypeType | null;
  /** Invoice date, or the settlement's ALLOCATION date. */
  date: string;
  reference: string | null;
  /** Always positive. See the note above. */
  amount_cents: number;
  /** Signed effect on the balance. `|effect_cents| === amount_cents`. */
  effect_cents: number;
  /** Running balance after this line, in statement order. */
  balance_cents: number;
  /**
   * The source document's own FROZEN organization chain.
   *
   * ⭐ The statement GROUPS by the live tree and each line PRINTS the chain its
   * document recorded — api-cloudrun#712's rule. A statement handed to a customer
   * and re-rendered after a re-parent must not silently rewrite history.
   */
  organization_path: OrgPathNodeType[];
}

/** Zod schema for {@link StatementLine}. */
export const StatementLineSchema: z.ZodType<StatementLine> = z.strictObject({
  kind: z.enum(["invoice", "settlement"]),
  uid_invoice: FirestoreId,
  number: z.int(),
  uid_settlement: FirestoreId.nullable(),
  settlement_type: SettlementTypeEnum.nullable(),
  date: z.string(),
  reference: z.string().nullable(),
  amount_cents: z.int().nonnegative(),
  effect_cents: z.int(),
  balance_cents: z.int(),
  // PII by composition — `OrgPathNode.name` is already `pii: "mask"`.
  organization_path: z.array(OrgPathNode).min(1).max(3),
});

/**
 * A customer statement for one organization subtree.
 *
 * ⭐ **Two dates, as on {@link AgingReport}, and for the same reason.** `to_date`
 * says which invoices existed; `as_of_payment_date` says which settlements count.
 * Free because `settlements` is a dated allocation journal.
 */
export interface OrgStatement {
  scope: AgingScope;
  format: StatementFormatType;
  /** Period start, or `null` for the whole account (the open-item default). */
  from_date: string | null;
  /** Period end — which invoices existed. */
  to_date: string;
  /** Which settlements count. */
  as_of_payment_date: string;
  /** The scoped organization's LIVE chain, for the document heading. */
  organization_path: OrgPathNodeType[];
  /** Resolved "bill to" block; `null` when the organization records none. */
  billing_address: AddressType | null;
  /** Balance before `from_date`. `0` when `from_date` is null. */
  opening_balance_cents: number;
  lines: StatementLine[];
  /** `opening_balance_cents + Σ lines[].effect_cents`, asserted below. */
  closing_balance_cents: number;
  /** The aging strip a statement carries, over the same population. */
  aging: AgingTotals;
}

/**
 * Zod schema for {@link OrgStatement}.
 *
 * 🔴 **The refinement is the control total, and it is the reason this is a
 * schema rather than a plain interface.** A statement whose lines do not add up
 * to its own closing balance is the single defect a customer will find and CFS
 * will not, so it is made UNREPRESENTABLE rather than checked by a test that
 * only ever sees fixtures. Three clauses:
 *
 * 1. `|effect_cents| === amount_cents` on every line — the journal's positive
 *    amount and the applied direction cannot disagree.
 * 2. `balance_cents` is the running sum from `opening_balance_cents` — so the
 *    printed column is derived, not asserted separately by a renderer.
 * 3. `opening + Σ effect === closing` — the statement ties to itself.
 *
 * ⚠️ Clause 3 is NOT implied by clause 2 when `lines` is empty, which is a real
 * case (a customer with an opening balance and no activity in the period).
 */
export const OrgStatementSchema: z.ZodType<OrgStatement> = z.strictObject({
  scope: AgingScopeSchema,
  format: StatementFormatEnum,
  from_date: z.string().nullable(),
  to_date: z.string(),
  as_of_payment_date: z.string(),
  organization_path: z.array(OrgPathNode).min(1).max(3),
  billing_address: Address,
  opening_balance_cents: z.int(),
  lines: z.array(StatementLineSchema).default([]),
  closing_balance_cents: z.int(),
  aging: AgingTotalsSchema,
}).superRefine((doc, ctx) => {
  let running = doc.opening_balance_cents;
  doc.lines.forEach((line, i) => {
    if (Math.abs(line.effect_cents) !== line.amount_cents) {
      ctx.addIssue({
        code: "custom",
        message:
          `effect_cents (${line.effect_cents}) must have magnitude amount_cents (${line.amount_cents})`,
        path: ["lines", i, "effect_cents"],
      });
    }
    running += line.effect_cents;
    if (line.balance_cents !== running) {
      ctx.addIssue({
        code: "custom",
        message: `balance_cents (${line.balance_cents}) is not the running total (${running})`,
        path: ["lines", i, "balance_cents"],
      });
    }
  });
  if (running !== doc.closing_balance_cents) {
    ctx.addIssue({
      code: "custom",
      message:
        `closing_balance_cents (${doc.closing_balance_cents}) must equal opening_balance_cents + the sum of every line's effect_cents (${running})`,
      path: ["closing_balance_cents"],
    });
  }
}).meta({ title: "OrgStatement" }) as z.ZodType<OrgStatement>;
