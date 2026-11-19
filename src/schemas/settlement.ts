/**
 * Settlement document schema — Firestore collection: `settlements`
 *
 * One settlement event against a billing document — an invoice or a supplier
 * bill — or, for a `refund`, against a credit document (api-cloudrun#1207,
 * #1210; the contract's `settles` axis names the role).
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
 * `xero_id` null → value once — late-binding external linkage is not
 * part of the money fact.
 *
 * ## One journal, two sides, no stored side
 *
 * A row names its targets by ROLE (one-document-model ruling 131): `billing`,
 * an invoice or a supplier bill, and `credit`, a customer credit note or a
 * supplier credit — each a `{ collection, uid }` ref, the narrowed `DocSource`
 * twin `bookings-inbound.source` uses. **The side is the ref's collection**, read
 * through `SIDE_OF_COLLECTION` (`schemas/side.ts`), and never stored: a `side`
 * field would be a second source of truth for it. The party is
 * `uid_counterparty`: the customer on a receivable row, the supplier on a
 * payable one.
 *
 * A target query (`billing.uid ==`, `credit.uid ==`) is one-sided by
 * construction, since an invoice and a bill never share an auto-id. Only a
 * reader that SCANS the collection holds both sides, and it narrows with
 * {@link settlementSide} / {@link isSideSettlement}.
 *
 * A billing document's `totals.{amount_paid, amount_credited, amount_due}` are a
 * **co-written projection** of this log, produced only by
 * `recomputeSettlementTotals` and rebuildable from it. That is CFS v2's shape —
 * an event log plus a client-ready projection for snapshot listeners — arriving
 * early in one domain, and it is `transactions` + `stock` for money.
 *
 * @module
 */
import { z } from "zod";
import { FirestoreId, XeroId } from "./_uid.ts";
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
import {
  type BillingCollection,
  type CreditCollection,
  type Side,
  SIDE_CONTRACTS,
  SIDE_OF_COLLECTION,
} from "./side.ts";

/**
 * The billing document a row settles: an invoice or a supplier bill. The
 * narrowed `DocSource` twin (`bookings-inbound.source`), so it is assignable
 * wherever a `DocSourceType` is read.
 */
export interface SettlementBillingRef<S extends Side = Side> {
  collection: BillingCollection<S>;
  uid: string;
}

/**
 * The credit document a row draws on (an allocation) or settles (a refund): a
 * customer credit note or a supplier credit.
 */
export interface SettlementCreditRef<S extends Side = Side> {
  collection: CreditCollection<S>;
  uid: string;
  /**
   * The credit's display number, denormalized: `"CN-1014"` (Xero-numbered) or
   * the CFS number. `DocSource`'s own display key, so no new name. `null` where
   * the writer had none to state.
   */
  label: string | null;
}

const billingRefObject = z.strictObject({
  collection: z.enum(["invoices", "purchase-bills"]).meta({ column: true, label: "Collection" }),
  uid: FirestoreId,
});

/** Zod schema for {@link SettlementBillingRef}. */
export const SettlementBillingRefSchema: z.ZodType<SettlementBillingRef> = billingRefObject;

/** Zod schema for {@link SettlementCreditRef}. */
export const SettlementCreditRefSchema: z.ZodType<SettlementCreditRef> = z.strictObject({
  collection: z.enum(["credit-notes", "purchase-credits"]).meta({ column: true, label: "Collection" }),
  uid: FirestoreId,
  label: z.string().max(200).nullable().meta({ column: true, label: "Number" }),
});

/**
 * One settlement event against a billing document or a credit document — the
 * contract's `settles` says which role, the ref's collection which side.
 *
 * @see {@link SETTLEMENT_CONTRACTS} for which combinations are legal.
 */
export interface Settlement {
  uid: string;
  /**
   * The billing document this row settles, or `null` on a `refund` pair (which
   * settles its credit). On a `credit` allocation it is the document the credit
   * is allocated TO.
   */
  billing: SettlementBillingRef | null;
  /**
   * The credit document this row draws on: the credit an allocation spends, or
   * the one a refund pays back. `null` on every row that does not draw credit.
   * Same side as `billing` whenever both are set.
   */
  credit: SettlementCreditRef | null;
  /**
   * The counterparty, denormalized so per-party reporting needs no join: the
   * customer (`organizations`) on a receivable row, the supplier (`suppliers`)
   * on a payable one — the side says which collection. ⚠️ Not core's
   * `ActionSide.counterparty`, which names a Xero contact id or a supplier uid
   * for the action catalog: a homonym.
   */
  uid_counterparty: string;

  // ── what happened ─────────────────────────────────────────────────
  type: SettlementTypeType;
  /** Legal per side: `SIDE_CONTRACTS[side].settlement_reasons[type]` labels it. */
  reason: SettlementReasonType;
  /**
   * **Integer minor units, ALWAYS POSITIVE.** Direction comes from `type` via
   * `getSettlementMultiplier` — never from the sign of this field.
   */
  amount_cents: number;
  /**
   * The instant the money moved. For a credit allocation this is the
   * **allocation** date, not the credit's: Xero posts journals on both a cash
   * and an accrual basis when an allocation is made, so it is
   * `max(credit.date, billing.date)` — the only date on which both facts are
   * true (verified 6/6 on prod).
   */
  date: string;
  date_fs: FirestoreTimestampType;
  reference: string | null;

  // ── grouping, correction ──────────────────────────────────────────
  /** One per operator action — groups a batch payment or a multi-document allocation. */
  uuid_session: string;
  /**
   * The settlement this one retracts. **Provenance only, never arithmetic** —
   * the totals are a signed fold over every row, and a reversal contributes by
   * being a `*_reversal` type, not by being pointed at.
   */
  reverses: string | null;

  // ── external linkage ──────────────────────────────────────────────
  /**
   * The id of the ONE Xero object that settles this row (ruling 129), or `null`:
   * recorded in CFS, not yet linked by Xero. What it names is derived, never
   * stored — `SETTLEMENT_CONTRACTS[type].xero_object` (a Payment, or a credit's
   * CreditNoteID), and for a `payment` on a `bank_transaction` bill the SPEND's
   * BankTransactionID, which is both the bill and its payment.
   */
  xero_id: string | null;
  /** Set once by `linkSettlementToXero`, never by a money edit. */
  synced_at: FirestoreTimestampType | null;
  /**
   * The pre-migration `invoice.payments[].uid` this row came from.
   *
   * @deprecated Forensics only, on receivable history: the answer to "which row
   * did this settlement come from" during any post-migration investigation.
   */
  legacy_payment_uid: string | null;

  // ── standard ──────────────────────────────────────────────────────
  /**
   * Scaffolding for consistency with `Movement` and the generic doc tooling.
   *
   * **NOT the concurrency token — do not build on it.** It can only ever be 0:
   * the document is written once and a reversal appends a sibling. The live
   * token for every settlement operation is the TARGET document's `version`,
   * because that is the document whose totals change.
   */
  version: number;
  created_by: ActorRefType;
  updated_by: ActorRefType;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}

/**
 * A settlement of side `S`: its refs name only that side's collections. A
 * reader holding a document of one side reads rows by its ref and holds these;
 * a collection scan narrows with {@link isSideSettlement}.
 */
export type SideSettlement<S extends Side> = Omit<Settlement, "billing" | "credit"> & {
  billing: SettlementBillingRef<S> | null;
  credit: SettlementCreditRef<S> | null;
};

/**
 * A settlement that settles a BILLING document of side `S` — every type but the
 * `refund` pair. What a fold over one invoice's or one bill's rows holds.
 */
export type BillingSettlement<S extends Side = Side> = SideSettlement<S> & { billing: SettlementBillingRef<S> };

/**
 * **The side of a settlement row**, read off its target ref's collection
 * (ruling 131). Every row names at least one ref (the contract requires it), so
 * this is total over parsed rows; it throws on a row that names none, which
 * only an unparsed one can.
 */
export function settlementSide(s: { billing: { collection: string } | null; credit: { collection: string } | null }): Side {
  const collection = s.billing?.collection ?? s.credit?.collection;
  const side = collection === undefined
    ? undefined
    : (SIDE_OF_COLLECTION as Readonly<Record<string, Side | undefined>>)[collection];
  if (side === undefined) throw new Error(`settlement names no billing or credit document`);
  return side;
}

/** Narrow a settlement to side `side` — what a collection scan holding both sides does first. */
export function isSideSettlement<S extends Side>(side: S, s: Settlement): s is Settlement & SideSettlement<S> {
  return settlementSide(s) === side;
}

/**
 * Narrow a settlement to one that settles a billing document of side `side`.
 * A reader that queried by `billing.uid` already holds only these; one that read
 * by `credit.uid` holds refunds too and must filter — a refund folded into a
 * billing document is money from nowhere.
 */
export function isBillingSettlement<S extends Side>(side: S, s: Settlement): s is Settlement & BillingSettlement<S> {
  return s.billing !== null && settlementSide(s) === side;
}

/** Is `reason` legal on a `type` row of `side`? One entry answers legality and label (ruling 130). */
export function settlementReasonLegal(side: Side, type: SettlementTypeType, reason: SettlementReasonType): boolean {
  return SIDE_CONTRACTS[side].settlement_reasons[type][reason] !== undefined;
}

/**
 * Contract enforcement — the same three-part rig `MOVEMENT_CONTRACTS` and
 * `ITEM_CONTRACTS` use, so a contradiction is a validation error rather than
 * something every consumer restates.
 */
function checkSettlementContract(s: Settlement, ctx: z.RefinementCtx): void {
  const contract = SETTLEMENT_CONTRACTS[s.type];
  if (!contract) return;

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

  // Only a type with a Xero counterpart may carry its id.
  if (contract.xero_object === null && s.xero_id !== null) {
    ctx.addIssue({
      code: "custom",
      path: ["xero_id"],
      message: `a "${s.type}" is a CFS event with no Xero counterpart; xero_id must be null`,
    });
  }

  // A COUNT type moves no money (api-cloudrun#1169). Any amount on one would be
  // money that no cents bucket folds — the projection would silently disagree
  // with the journal, and nothing in the identity could see it.
  if (contract.counts_into !== null && s.amount_cents !== 0) {
    ctx.addIssue({
      code: "custom",
      path: ["amount_cents"],
      message: `a "${s.type}" feeds ${contract.counts_into} and moves no money; amount_cents must be 0`,
    });
  }

  // Which documents the row names, by role. A billing type names its billing
  // document; a credit type (`refund`) names none. Only a credit-drawing type
  // names a credit, and every one must.
  const settlesBilling = contract.settles === "billing";
  if (settlesBilling !== (s.billing !== null)) {
    ctx.addIssue({
      code: "custom",
      path: ["billing"],
      message: settlesBilling
        ? `a "${s.type}" settles a billing document and must name it in billing`
        : `a "${s.type}" settles its credit, not a billing document; billing must be null`,
    });
  }
  if (contract.draws_credit !== (s.credit !== null)) {
    ctx.addIssue({
      code: "custom",
      path: ["credit"],
      message: contract.draws_credit
        ? `a "${s.type}" draws on a credit and must name it in credit`
        : `a "${s.type}" does not draw on a credit and cannot name one`,
    });
  }

  // One side per row: an allocation's credit and billing document are both
  // receivable or both payable. The side then decides which reasons are legal.
  const billingSide = s.billing ? SIDE_OF_COLLECTION[s.billing.collection] : null;
  const creditSide = s.credit ? SIDE_OF_COLLECTION[s.credit.collection] : null;
  if (billingSide !== null && creditSide !== null && billingSide !== creditSide) {
    ctx.addIssue({
      code: "custom",
      path: ["credit", "collection"],
      message: `a settlement's credit (${s.credit!.collection}) and billing document ` +
        `(${s.billing!.collection}) must be on the same side`,
    });
    return;
  }
  const side = billingSide ?? creditSide;
  if (side !== null && !settlementReasonLegal(side, s.type, s.reason)) {
    const legal = Object.keys(SIDE_CONTRACTS[side].settlement_reasons[s.type]);
    ctx.addIssue({
      code: "custom",
      path: ["reason"],
      message: `"${s.reason}" is not a legal reason for a ${side} "${s.type}" settlement ` +
        `(expected one of: ${legal.join(", ")})`,
    });
  }
}

/** Zod schema for a Settlement. */
export const SettlementSchema: z.ZodType<Settlement> = z.strictObject({
  // A document id, so `FirestoreId`. Payable and session-keyed ids are derived
  // but still 20-char ids (`src/lib/settlementIds.ts` in api-cloudrun).
  uid: FirestoreId,
  billing: SettlementBillingRefSchema.nullable().meta({ label: "Billing" }),
  credit: SettlementCreditRefSchema.nullable().meta({ label: "Credit" }),
  uid_counterparty: FirestoreId,
  type: SettlementTypeEnum.meta({ column: true, label: "Type" }),
  reason: SettlementReasonEnum.meta({ column: true, label: "Reason" }),
  amount_cents: z.int().nonnegative().meta({ column: true, label: "Amount" }),
  // `chicagoInstant()`, NOT `chicagoStartOfDay()`. A settlement is an event, and
  // the workspace table puts "true instants" under `chicagoInstant()`.
  date: chicagoInstant().meta({ serverSortVia: "date_fs", column: true, label: "Date" }),
  date_fs: FirestoreTimestamp,
  reference: z.string().nullable().meta({ column: true, label: "Reference" }),
  uuid_session: z.uuid(),
  reverses: FirestoreId.nullable(),
  xero_id: XeroId.nullable(),
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

// ── Inputs (one route for both sides, rulings 132, 133, 137) ────────

/**
 * A billing document named by an input: the stored ref's STRIPPING twin
 * (`.strip()` keeps the node's checks), so a client echoing a stored ref with
 * extra keys is not refused (`tests/input-strictness.test.ts`).
 */
export const SettlementBillingRefInput: z.ZodType<SettlementBillingRef> = billingRefObject.strip();

/** A credit document named by an input: no `label`, which the writer reads off the credit. */
export interface SettlementCreditRefInputType {
  collection: CreditCollection;
  uid: string;
}

/** Zod schema for {@link SettlementCreditRefInputType}. */
export const SettlementCreditRefInput: z.ZodType<SettlementCreditRefInputType> = z.object({
  collection: z.enum(["credit-notes", "purchase-credits"]),
  uid: FirestoreId,
});

/** One allocation of a credit, to one billing document of its side. */
export interface SettlementAllocationInputType {
  billing: SettlementBillingRef;
  amount_cents: number;
}

/**
 * **`POST /settlements`, both sides** (ruling 132): one route records a payment,
 * a closure, a cash refund or a credit allocation against a document of either
 * side, the side read off the ref's collection. It replaced
 * `POST /credit-notes/{uid}/allocations`, `POST /purchase-bills/{uid}/close` and
 * `/reopen`, and `POST /purchase-credits/{uid}/allocations`.
 *
 * - **`uuid_session` keys every write** (ruling 137): a replay of the same
 *   session returns the row it wrote; a second press under a new session is a
 *   new attempt the action catalog refuses.
 * - **`version` is the TARGET's**: the billing document's for a payment or a
 *   closure, the credit's for a refund or an allocation.
 * - **`reason` is legal per side** (`settlementReasonLegal`), checked here so a
 *   wrong one is a 400. An allocation carries no reason: it takes its credit's.
 */
export type CreateSettlementInputType =
  | {
    type: "payment";
    billing: SettlementBillingRef;
    reason: SettlementReasonType;
    amount_cents: number;
    date: string;
    reference?: string | null;
    uuid_session: string;
    version: number;
  }
  | {
    type: "closure";
    billing: SettlementBillingRef;
    reason: SettlementReasonType;
    amount_cents: 0;
    date: string;
    reference?: string | null;
    uuid_session: string;
    version: number;
  }
  | {
    type: "refund";
    credit: SettlementCreditRefInputType;
    reason: SettlementReasonType;
    amount_cents: number;
    date: string;
    reference?: string | null;
    uuid_session: string;
    version: number;
  }
  | {
    type: "credit";
    credit: SettlementCreditRefInputType;
    allocations: SettlementAllocationInputType[];
    uuid_session: string;
    version: number;
  };

const inputCommon = {
  date: chicagoInstant(),
  reference: z.string().nullable().optional(),
  uuid_session: z.uuid(),
  version: z.int().min(0),
};

/** Zod schema for {@link CreateSettlementInputType}. */
export const CreateSettlementInput: z.ZodType<CreateSettlementInputType> = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("payment"),
    billing: SettlementBillingRefInput,
    reason: SettlementReasonEnum,
    amount_cents: z.int().positive(),
    ...inputCommon,
  }),
  z.object({
    type: z.literal("closure"),
    billing: SettlementBillingRefInput,
    reason: SettlementReasonEnum,
    // A closure moves no money; the contract refuses any other amount, so the
    // wire states it rather than defaulting it.
    amount_cents: z.literal(0),
    ...inputCommon,
  }),
  z.object({
    type: z.literal("refund"),
    credit: SettlementCreditRefInput,
    reason: SettlementReasonEnum,
    amount_cents: z.int().positive(),
    ...inputCommon,
  }),
  z.object({
    type: z.literal("credit"),
    credit: SettlementCreditRefInput,
    allocations: z.array(z.object({
      billing: SettlementBillingRefInput,
      amount_cents: z.int().positive(),
    })).min(1),
    uuid_session: z.uuid(),
    version: z.int().min(0),
  }),
]).superRefine((input, ctx) => {
  if (input.type === "credit") {
    const side = SIDE_OF_COLLECTION[input.credit.collection];
    input.allocations.forEach((a, i) => {
      if (SIDE_OF_COLLECTION[a.billing.collection] !== side) {
        ctx.addIssue({
          code: "custom",
          path: ["allocations", i, "billing", "collection"],
          message: `a ${side} credit cannot be allocated to ${a.billing.collection}`,
        });
      }
    });
    return;
  }
  const side = input.type === "refund"
    ? SIDE_OF_COLLECTION[input.credit.collection]
    : SIDE_OF_COLLECTION[input.billing.collection];
  if (!settlementReasonLegal(side, input.type, input.reason)) {
    ctx.addIssue({
      code: "custom",
      path: ["reason"],
      message: `"${input.reason}" is not a legal reason for a ${side} "${input.type}"`,
    });
  }
}) as z.ZodType<CreateSettlementInputType>;

/**
 * **`POST /settlements/{uid}/reverse`, both sides.** `version` is the version of
 * the document the reversed row settles (the billing document, or the credit for
 * a refund); `uuid_session` keys the reversal (ruling 137). It replaced
 * `POST /purchase-credits/{uid}/allocations/{settlement}/reverse` and
 * `POST /purchase-bills/{uid}/reopen` (reopening is reversing the closure row).
 */
export interface ReverseSettlementInputType {
  reason: SettlementReasonType;
  date?: string;
  uuid_session: string;
  version: number;
}

/** Zod schema for {@link ReverseSettlementInputType}. */
export const ReverseSettlementInput: z.ZodType<ReverseSettlementInputType> = z.object({
  // `source_retracted` / `correction` for every type and side — including a
  // `closure`, whose reversal REOPENS a closed $0 document.
  reason: z.enum(["source_retracted", "correction"]),
  date: chicagoInstant().optional(),
  uuid_session: z.uuid(),
  version: z.int().min(0),
});
