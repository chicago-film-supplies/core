/**
 * Settlement document schema — Firestore collection: `settlements`
 *
 * One settlement event against an invoice. **The revenue-side twin of the
 * `transactions` movement journal**: append-only, dated, reversible, and
 * type-blind by design — a cash payment and a credit-note allocation differ
 * only in `type` and `reason`.
 *
 * CFS puts event journals in collections and value-detail in arrays. `items[]`
 * is detail; movements are events; a settlement is an event. `transaction.ts`
 * draws the boundary from the other side — *"cost is cost only, never revenue —
 * customer-facing money lives in Xero"* — so the shape is the model and revenue
 * is exactly what it excludes. This is that missing half.
 *
 * **APPEND-ONLY.** Nothing is edited or deleted; a correction is a NEW document
 * carrying `reverses`. There is deliberately no `status` field, for the same
 * reason `Movement` has none: a status flag *and* a reverser link is two sources
 * of truth. The one permitted mutation in the whole design is
 * `linkSettlementToXero` (api-cloudrun `src/lib/settlements.ts`) writing
 * `xero_payment_id` null → value once — late-binding external linkage is not
 * part of the money fact.
 *
 * The invoice's `totals.{amount_paid, amount_credited, amount_due}` are a
 * **co-written projection** of this log, produced only by
 * `recomputeSettlementTotals` and rebuildable from it. That is CFS v2's shape —
 * an event log plus a client-ready projection for snapshot listeners — arriving
 * early in one domain, and it is `transactions` + `stock` for money.
 *
 * @module
 */
import { z } from "zod";
import { FirestoreId } from "./_uid.ts";
import { chicagoInstant } from "./_datetime.ts";
import {
  ActorRef,
  type ActorRefType,
  FirestoreTimestamp,
  type FirestoreTimestampType,
  SETTLEMENT_CONTRACTS,
  SettlementReasonEnum,
  type SettlementReasonType,
  SettlementTypeEnum,
  type SettlementTypeType,
  TimestampFields,
} from "./common.ts";

/**
 * One settlement event against an invoice.
 *
 * @see {@link SETTLEMENT_CONTRACTS} for which combinations are legal.
 */
export interface Settlement {
  uid: string;
  uid_invoice: string;
  /** Denormalized so per-customer settlement reporting needs no join. */
  uid_organization: string;

  // ── what happened ─────────────────────────────────────────────────
  type: SettlementTypeType;
  reason: SettlementReasonType;
  /**
   * **Integer minor units, ALWAYS POSITIVE.** Direction comes from `type` via
   * `getSettlementMultiplier` — never from the sign of this field.
   */
  amount_cents: number;
  /**
   * The instant the money moved. For a credit this is the **allocation** date,
   * not the credit note's: Xero must post journals on both a cash and an accrual
   * basis when an allocation is made, so the allocation carries its own date and
   * it is `max(credit_note.date, invoice.date)` — the only date on which both
   * facts are true (verified 6/6 on prod).
   */
  date: string;
  date_fs: FirestoreTimestampType;
  reference: string | null;

  // ── grouping, correction ──────────────────────────────────────────
  /** One per operator action — groups a batch payment or a multi-invoice allocation. */
  uid_session: string;
  /**
   * The settlement this one retracts. **Provenance only, never arithmetic** —
   * the totals are a signed fold over every row, and a reversal contributes by
   * being a `*_reversal` type, not by being pointed at.
   */
  reverses: string | null;

  // ── the value instrument ──────────────────────────────────────────
  uid_credit_note: string | null;
  /** Denormalized display number: `"CN-1014"` (Xero) / `"CN-0007"` (CFS). */
  number_credit_note: string | null;

  // ── external linkage ──────────────────────────────────────────────
  xero_payment_id: string | null;
  xero_credit_note_id: string | null;
  /** Set once by `linkSettlementToXero`, never by a money edit. */
  synced_at: FirestoreTimestampType | null;
  /**
   * The pre-migration `invoice.payments[].uid` this row came from.
   *
   * @deprecated Forensics only. It was the per-payment idempotency key during
   * the migration — `xero_payment_id` could not serve, because a client-added
   * payment has none — and it stays as the answer to "which row did this
   * settlement come from" during any post-migration investigation.
   */
  legacy_payment_uid: string | null;

  // ── standard ──────────────────────────────────────────────────────
  /**
   * Scaffolding for consistency with `Movement` and the generic doc tooling.
   *
   * **NOT the concurrency token — do not build on it.** It can only ever be 0:
   * the document is written once and a reversal appends a sibling rather than
   * mutating it. The live optimistic-concurrency token for every settlement
   * operation is the **INVOICE's** `version`, because the invoice is the
   * document that actually changes — its totals are the co-written projection.
   * A client that if-matched on a settlement's version would be guarding a
   * document nothing ever writes twice.
   */
  version: number;
  created_by: ActorRefType;
  updated_by: ActorRefType;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}

/**
 * Contract enforcement — the same three-part rig `MOVEMENT_CONTRACTS` and
 * `ITEM_CONTRACTS` use, so a contradiction is a validation error rather than
 * something every consumer restates.
 */
function checkSettlementContract(s: Settlement, ctx: z.RefinementCtx): void {
  const contract = SETTLEMENT_CONTRACTS[s.type];
  if (!contract) return;

  if (!contract.reasons.includes(s.reason)) {
    ctx.addIssue({
      code: "custom",
      path: ["reason"],
      message: `"${s.reason}" is not a legal reason for a "${s.type}" settlement ` +
        `(expected one of: ${contract.reasons.join(", ")})`,
    });
  }

  if (contract.reverses === "required" && s.reverses === null) {
    ctx.addIssue({
      code: "custom",
      path: ["reverses"],
      message: `a "${s.type}" retracts another settlement and must name it in reverses`,
    });
  }
  if (contract.reverses === "forbidden" && s.reverses !== null) {
    ctx.addIssue({
      code: "custom",
      path: ["reverses"],
      message: `a "${s.type}" applies value rather than retracting it; reverses must be null`,
    });
  }

  // A type may carry only the external id its contract names. Without this a
  // credit could claim a `xero_payment_id`, and the sync's pass-1 index would
  // then match a Xero payment against a credit-note allocation.
  for (const field of ["xero_payment_id", "xero_credit_note_id"] as const) {
    if (s[field] !== null && contract.xero_id_field !== field) {
      ctx.addIssue({
        code: "custom",
        path: [field],
        message: contract.xero_id_field === null
          ? `a "${s.type}" is a CFS event with no Xero counterpart; ${field} must be null`
          : `a "${s.type}" carries ${contract.xero_id_field}, not ${field}`,
      });
    }
  }

  // Derived from `sums_into` rather than declared as a fifth contract axis: the
  // credit bucket is the ONLY one whose value instrument is a credit note.
  //
  // ⚠️ Written as `!== "amount_credited_cents"`, not `=== "amount_paid_cents"`.
  // The positive form was correct while `sums_into` had two members and became
  // silently permissive the moment it gained a third: a `void` row would have
  // been exempted from the check and could have carried a `uid_credit_note`.
  // Naming the ONE bucket the exemption belongs to is what makes a fourth
  // bucket default to being checked rather than to being skipped.
  if (contract.sums_into !== "amount_credited_cents") {
    for (const field of ["uid_credit_note", "number_credit_note"] as const) {
      if (s[field] !== null) {
        ctx.addIssue({
          code: "custom",
          path: [field],
          message: `a "${s.type}" feeds ${contract.sums_into} and cannot reference a credit note`,
        });
      }
    }
  }
}

/** Zod schema for a Settlement. */
export const SettlementSchema: z.ZodType<Settlement> = z.strictObject({
  // A document id now, so `FirestoreId` — not the `z.uuid()` the embedded
  // `payments[].uid` used. The repo rule: every doc carries a `uid` property and
  // its ID is a Firestore auto-ID.
  uid: FirestoreId,
  uid_invoice: FirestoreId,
  uid_organization: FirestoreId,
  type: SettlementTypeEnum.meta({ column: true, label: "Type" }),
  reason: SettlementReasonEnum.meta({ column: true, label: "Reason" }),
  amount_cents: z.int().nonnegative().meta({ column: true, label: "Amount" }),
  // `chicagoInstant()`, NOT `chicagoStartOfDay()`. A settlement is an event, and
  // the workspace table puts "true instants — moments when something happened"
  // under `chicagoInstant()` with `transaction.date` as its example. Truncating
  // to midnight would also collapse a busy day's settlements into a tie on the
  // one axis bitemporal reporting needs ordered.
  date: chicagoInstant().meta({ serverSortVia: "date_fs", column: true, label: "Date" }),
  date_fs: FirestoreTimestamp,
  reference: z.string().nullable().meta({ column: true, label: "Reference" }),
  uid_session: z.uuid(),
  reverses: FirestoreId.nullable(),
  uid_credit_note: FirestoreId.nullable(),
  number_credit_note: z.string().nullable(),
  xero_payment_id: z.string().nullable(),
  xero_credit_note_id: z.string().nullable(),
  synced_at: FirestoreTimestamp.nullable(),
  legacy_payment_uid: z.string().nullable(),
  version: z.int().min(0).default(0),
  created_by: ActorRef.meta({ column: true, label: "Created By" }),
  updated_by: ActorRef.meta({ column: true, label: "Updated By" }),
  ...TimestampFields,
}).superRefine(checkSettlementContract).meta({
  title: "Settlement",
  collection: "settlements",
  displayDefaults: {
    columns: ["date", "type", "reason", "amount_cents", "reference"],
    filters: {},
    sort: { column: "date", direction: "desc" },
    groupBy: [
      { field: null, label: "None" },
      { field: "type", label: "Type", kind: "enum" },
      { field: "reason", label: "Reason", kind: "enum" },
    ],
  },
});
