/**
 * Settlement document schema — Firestore collection: `settlements`
 *
 * One settlement event against an invoice — or, for a `refund`, against a credit
 * note (api-cloudrun#1207; the contract's `settles` axis) — or, on the PAYABLE
 * side, against a supplier bill or supplier credit (api-cloudrun#1210).
 * **The money-side twin of the `transactions` movement journal**: append-only, dated, reversible, and
 * type-blind by design — a cash payment and a credit-note allocation differ
 * only in `type` and `reason`.
 *
 * CFS puts event journals in collections and value-detail in arrays. `items[]`
 * is detail; movements are events; a settlement is an event. `schemas/transaction.ts`
 * draws the boundary from the other side — *"cost is cost only, never revenue —
 * customer-facing money lives in Xero"* — so the shape is the model and revenue
 * is exactly what it excludes. This is that missing half.
 *
 * **APPEND-ONLY.** Nothing is edited or deleted; a correction is a NEW document
 * carrying `reverses`. There is deliberately no `status` field, for the same
 * reason `Movement` has none: a status flag *and* a reverser link is two sources
 * of truth. The one permitted mutation in the whole design is
 * `linkSettlementToXero` (api-cloudrun `api-cloudrun/src/lib/settlements.ts`) writing
 * `xero_payment_id` null → value once — late-binding external linkage is not
 * part of the money fact.
 *
 * ## One journal, two sides, no stored side
 *
 * A receivable row names `uid_organization` and an `uid_invoice` or
 * `uid_credit_note`; a payable row names `uid_supplier` and a `uid_purchase_bill`
 * or `uid_purchase_credit`. Every target key is `null` on the other side, and the
 * refine ties each to the type's `settles`, so **every existing equality query
 * (`uid_invoice` / `uid_organization` / `uid_credit_note`) is blind to payable rows
 * by construction**, and {@link isInvoiceSettlement} excludes them for free. Only
 * a reader that SCANS the collection holds both sides, and it must narrow with
 * {@link isReceivableSettlement} / {@link isPayableSettlement}. There is no
 * `side` field: it would be a second source of truth for the key that is present.
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
  SETTLEMENT_TARGET_SIDE,
  SettlementReasonEnum,
  type SettlementReasonType,
  SettlementTypeEnum,
  type SettlementTypeType,
  TimestampFields,
} from "./common.ts";

/**
 * One settlement event against an invoice, a customer credit note, a supplier
 * bill or a supplier credit — the contract's `settles` says which.
 *
 * @see {@link SETTLEMENT_CONTRACTS} for which combinations are legal.
 */
export interface Settlement {
  uid: string;
  /**
   * The invoice this row settles, or `null` on a row that settles anything else
   * (a `refund`'s credit note, or any payable row). The refine makes this and
   * `SETTLEMENT_CONTRACTS[type].settles === "invoice"` agree, so a reader
   * filtering by `uid_invoice` can never receive a refund or a payable, and
   * neither can ever be folded into an invoice.
   */
  uid_invoice: string | null;
  /**
   * The customer, denormalized so per-customer settlement reporting needs no
   * join. `null` exactly on a payable row, which names `uid_supplier` instead.
   */
  uid_organization: string | null;
  /** The bill a payable row settles; `null` on every other row. */
  uid_purchase_bill: string | null;
  /**
   * The supplier credit a payable row draws on (`bill_credit`) or settles
   * (`supplier_refund`); `null` on every other row. The payable twin of
   * `uid_credit_note`.
   */
  uid_purchase_credit: string | null;
  /** The supplier, on a payable row; `null` exactly on a receivable row. */
  uid_supplier: string | null;

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
  uuid_session: string;
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
 * A RECEIVABLE settlement — one that settles an invoice or a customer credit
 * note, and so names its customer. The refine makes `uid_organization !== null`
 * and `SETTLEMENT_TARGET_SIDE[settles] === "receivable"` the same fact.
 */
export type ReceivableSettlement = Settlement & {
  uid_organization: string;
  uid_supplier: null;
  uid_purchase_bill: null;
  uid_purchase_credit: null;
};

/**
 * A settlement that settles an INVOICE — every receivable type but `refund` and
 * `refund_reversal` (api-cloudrun#1207). The refine makes `uid_invoice !== null`
 * and `SETTLEMENT_CONTRACTS[type].settles === "invoice"` the same fact, so this
 * is the type a reader holds once it has filtered.
 */
export type InvoiceSettlement = ReceivableSettlement & { uid_invoice: string };

/**
 * A PAYABLE settlement — one that settles a supplier bill or supplier credit
 * (api-cloudrun#1210), and so names its supplier.
 */
export type PayableSettlement = Settlement & {
  uid_supplier: string;
  uid_organization: null;
  uid_invoice: null;
  uid_credit_note: null;
  number_credit_note: null;
};

/** A payable settlement that settles a supplier BILL — every payable type but the `supplier_refund` pair. */
export type PurchaseBillSettlement = PayableSettlement & { uid_purchase_bill: string };

/**
 * Narrow a settlement to {@link InvoiceSettlement}. A reader that queried by
 * `uid_invoice` already holds only these; a reader that scans the collection,
 * or reads by `uid_credit_note`, holds refunds too and MUST filter — a refund
 * folded into an invoice is money from nowhere. A payable row has a `null`
 * `uid_invoice`, so this excludes the whole payable side as well.
 */
export function isInvoiceSettlement(s: Settlement): s is InvoiceSettlement {
  return s.uid_invoice !== null;
}

/**
 * Narrow a settlement to {@link ReceivableSettlement}. A reader that scans the
 * collection (an audit, a per-customer statement built from a full read) holds
 * payable rows too and MUST filter before treating `uid_organization` as set.
 */
export function isReceivableSettlement(s: Settlement): s is ReceivableSettlement {
  return s.uid_organization !== null;
}

/** Narrow a settlement to {@link PayableSettlement}. */
export function isPayableSettlement(s: Settlement): s is PayableSettlement {
  return s.uid_supplier !== null;
}

/** Narrow a settlement to {@link PurchaseBillSettlement}. */
export function isPurchaseBillSettlement(s: Settlement): s is PurchaseBillSettlement {
  return s.uid_purchase_bill !== null;
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

  // A COUNT type moves no money (api-cloudrun#1169). Any amount on one would be
  // money that no cents bucket folds — the projection would silently disagree
  // with the journal, and nothing in the invoice identity could see it.
  if (contract.counts_into !== null && s.amount_cents !== 0) {
    ctx.addIssue({
      code: "custom",
      path: ["amount_cents"],
      message: `a "${s.type}" feeds ${contract.counts_into} and moves no money; amount_cents must be 0`,
    });
  }

  // Which document the row settles (api-cloudrun#1207, #1210). Each target has
  // its own key, set exactly when the type settles that target — so a reader
  // filtering by `uid_invoice` can never receive a refund or a payable row, and
  // a reader filtering by `uid_purchase_bill` can never receive a receivable.
  // `uid_credit_note` and `uid_purchase_credit` are also the DRAWN instrument on
  // a `credit` / `bill_credit` row, so their "must be null" half is the
  // `draws_*` checks below rather than this one.
  const settles = contract.settles;
  if ((settles === "invoice") !== (s.uid_invoice !== null)) {
    ctx.addIssue({
      code: "custom",
      path: ["uid_invoice"],
      message: settles === "invoice"
        ? `a "${s.type}" settles an invoice and must name it in uid_invoice`
        : `a "${s.type}" settles a ${settles.replace("_", " ")}, not an invoice; uid_invoice must be null`,
    });
  }
  if ((settles === "purchase_bill") !== (s.uid_purchase_bill !== null)) {
    ctx.addIssue({
      code: "custom",
      path: ["uid_purchase_bill"],
      message: settles === "purchase_bill"
        ? `a "${s.type}" settles a supplier bill and must name it in uid_purchase_bill`
        : `a "${s.type}" does not settle a supplier bill; uid_purchase_bill must be null`,
    });
  }
  if (settles === "credit_note" && s.uid_credit_note === null) {
    ctx.addIssue({
      code: "custom",
      path: ["uid_credit_note"],
      message: `a "${s.type}" settles a credit note and must name it in uid_credit_note`,
    });
  }
  // A `"purchase_credit"` row's key is required by the `draws_purchase_credit`
  // check below — every type settling a supplier credit also draws on it.

  // Which party the row names. A receivable names its customer and no supplier;
  // a payable the reverse. Both directions are checked, so a row can never carry
  // both — which is what keeps the per-customer and per-supplier queries disjoint.
  const payable = SETTLEMENT_TARGET_SIDE[settles] === "payable";
  if (payable !== (s.uid_supplier !== null)) {
    ctx.addIssue({
      code: "custom",
      path: ["uid_supplier"],
      message: payable
        ? `a "${s.type}" is a payable and must name its supplier in uid_supplier`
        : `a "${s.type}" is a receivable; uid_supplier must be null`,
    });
  }
  if (payable === (s.uid_organization !== null)) {
    ctx.addIssue({
      code: "custom",
      path: ["uid_organization"],
      message: payable
        ? `a "${s.type}" is a payable; uid_organization must be null`
        : `a "${s.type}" is a receivable and must name its customer in uid_organization`,
    });
  }

  // Only a row that draws on a note's credit may name a credit note.
  //
  // ⚠️ This read `contract.sums_into !== "amount_credited_cents"` until the
  // refund pair, and before that `=== "amount_paid_cents"`. The positive form was
  // correct while `sums_into` had two members and became silently permissive the
  // moment it gained a third: a `void` row would have been exempted from the
  // check and could have carried a `uid_credit_note`. The bucket form then
  // refused a refund, whose `sums_into` is `null`. `draws_credit` is the fact
  // the rule was always about — the credit bucket was a proxy for it — and it is
  // `false` by declaration on every type that is not a credit or refund, so a
  // new type still defaults to being CHECKED.
  if (!contract.draws_credit) {
    for (const field of ["uid_credit_note", "number_credit_note"] as const) {
      if (s[field] !== null) {
        ctx.addIssue({
          code: "custom",
          path: [field],
          message: `a "${s.type}" does not draw on a credit note and cannot reference one`,
        });
      }
    }
  }
  // The payable twin. A `bill_credit` names the supplier credit it draws, and a
  // `supplier_refund` the one it settles; nothing else may name one.
  if (!contract.draws_purchase_credit && s.uid_purchase_credit !== null) {
    ctx.addIssue({
      code: "custom",
      path: ["uid_purchase_credit"],
      message: `a "${s.type}" does not draw on a supplier credit and cannot reference one`,
    });
  }
  if (contract.draws_purchase_credit && s.uid_purchase_credit === null) {
    ctx.addIssue({
      code: "custom",
      path: ["uid_purchase_credit"],
      message: `a "${s.type}" draws on a supplier credit and must name it in uid_purchase_credit`,
    });
  }
}

/** Zod schema for a Settlement. */
export const SettlementSchema: z.ZodType<Settlement> = z.strictObject({
  // A document id now, so `FirestoreId` — not the `z.uuid()` the embedded
  // `payments[].uid` used. The repo rule: every doc carries a `uid` property and
  // its ID is a Firestore auto-ID.
  uid: FirestoreId,
  uid_invoice: FirestoreId.nullable(),
  uid_organization: FirestoreId.nullable(),
  uid_purchase_bill: FirestoreId.nullable(),
  uid_purchase_credit: FirestoreId.nullable(),
  uid_supplier: FirestoreId.nullable(),
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
  uuid_session: z.uuid(),
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
