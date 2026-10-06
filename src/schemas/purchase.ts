/**
 * Purchase document schema — Firestore collection: `purchases`
 *
 * What CFS ORDERED from a supplier: one line per product, each with the
 * quantity and the amount agreed. It moves nothing. api-cloudrun#1210 split a
 * `purchase` movement, which used to be the order, the delivery, the bill and
 * (through Xero) the debt all at once, into four facts with four homes:
 *
 * | fact     | home                                                   | moves                         |
 * |----------|--------------------------------------------------------|-------------------------------|
 * | ordered  | this document                                          | nothing                       |
 * | received | `purchase` movements naming it in `sources[]`          | `quantity_held`, basis, units |
 * | billed   | `purchase-bills` / `purchase-credits` naming it        | the Xero document             |
 * | paid     | `settlements` rows against a bill                      | the bill's `totals`           |
 *
 * The owner's real sequence is order → bill → delivery (days or weeks later,
 * possibly partial) → payment, and before this document nothing could hold
 * "billed, not received" — movement #3882 recorded three radios that had not
 * arrived. Plan: `api-cloudrun/.claude/plans/purchases.md`.
 *
 * ## The shape is the out-of-service record's, on purpose
 *
 * `schemas/out-of-service.ts` is the package's parent-with-movements shape and this
 * copies every part of it:
 *
 * - **Its receipts name it in `sources[]`** and it finds them through
 *   `query_by_sources`. There is no `Movement.purchase` field and no back-list
 *   of movement ids here — the HISTORY of a purchase is the journal.
 * - **Co-written buckets** per line (`quantity_received`, `quantity_billed`,
 *   `quantity_canceled`), each written in the same transaction as the receipt,
 *   bill or close that moves it — the analogue of the record's `breakdown`.
 * - **A derived status** in the record's vocabulary (`active | complete |
 *   canceled`), authored by {@link derivePurchaseStatus} and refined here, so a
 *   document asserting one status and holding buckets that say another does not
 *   parse.
 *
 * ## A line is `(purchase, uid_product)`
 *
 * One line per product, refined below. A receipt's subject is already
 * `uid_product`, so a movement needs no line slot in `sources[]` to say which
 * line it received against. A second price for the same product is a second
 * PURCHASE, never a second line (see the plan's *Money rules*).
 *
 * ## Money
 *
 * `amount_cents` is what the whole line costs, integer cents. The k-th receipt
 * or bill against a line is priced by `cumulativeShareCents`
 * (`@cfs/core/utils/purchases`), which rounds the CUMULATIVE share once, so the
 * partials sum to `amount_cents` exactly with no remainder rule. There is no
 * stored `unit_cost`: it is a display rate, derivable by `perUnitCostAt4dp`, and
 * a stored copy beside the amount it derives from is a second source of truth.
 *
 * There is no tax anywhere on a purchase (owner, 2026-10-05): stock bought for
 * sale or rent is bought resale-exempt and the tax is collected from the end
 * user, so `priceDocument` never runs here.
 *
 * @module
 */
import { z } from "zod";
import { FirestoreId, ThreadId } from "./_uid.ts";
import { chicagoInstant, chicagoStartOfDay } from "./_datetime.ts";
import {
  ActorRef,
  type ActorRefType,
  FirestoreTimestamp,
  type FirestoreTimestampType,
  TimestampFields,
  UidNameRef,
  type UidNameRefType,
} from "./common.ts";
import {
  allocationUnitsIssue,
  MovementAllocationInput,
  type MovementAllocationInputType,
  MovementUnitInput,
  type MovementUnitInputType,
} from "./transaction.ts";

// ── Status ───────────────────────────────────────────────────────

/**
 * Derived by {@link derivePurchaseStatus}, never client-set. The out-of-service
 * vocabulary, for the reason `OOS_STATUSES` gives: orders, bookings and cards
 * all say `active` for "in progress".
 *
 * Partial progress — some received, some billed — is read off the buckets, not
 * encoded here. A status per stage (`partially_received`, `billed`, …) would be
 * a second rendering of numbers the line already carries.
 */
export const PURCHASE_STATUSES = ["active", "complete", "canceled"] as const;
/** Allowed purchase statuses. See {@link PURCHASE_STATUSES}. */
export type PurchaseStatusType = typeof PURCHASE_STATUSES[number];
/** Zod schema for PurchaseStatusType. */
export const PurchaseStatusEnum: z.ZodType<PurchaseStatusType> = z.enum(PURCHASE_STATUSES);

// ── Lines ────────────────────────────────────────────────────────

/** One product ordered on a purchase. */
export interface PurchaseLine {
  uid_product: string;
  /** The product's name when ordered — a point-in-time snapshot, like `Movement.supplier`. */
  name: string;
  quantity: number;
  /** What the whole line costs, integer cents. */
  amount_cents: number;
  /**
   * When the supplier says this line will arrive, or `null` when nobody said.
   * A calendar date. Read by nothing that moves stock today; inbound stock in
   * availability is a follow-up, and adding it makes this a supply input that
   * must bump `stock-locks`.
   */
  expected_date: string | null;
  /** Units received — Σ of the receipts naming this purchase for this product, net of reversals. */
  quantity_received: number;
  /** Units billed — Σ of bill lines minus Σ of credit lines for this product. */
  quantity_billed: number;
  /** Units that will never be received — set by a short close or a cancel. */
  quantity_canceled: number;
}

/** Zod schema for PurchaseLine. */
export const PurchaseLineSchema: z.ZodType<PurchaseLine> = z.strictObject({
  uid_product: FirestoreId,
  name: z.string().min(1).meta({ column: true, label: "Product" }),
  quantity: z.int().min(1).meta({ column: true, label: "Quantity" }),
  amount_cents: z.int().min(0).meta({ column: true, label: "Amount" }),
  expected_date: chicagoStartOfDay().nullable().meta({ column: true, label: "Expected" }),
  quantity_received: z.int().min(0).meta({ column: true, label: "Received" }),
  quantity_billed: z.int().min(0).meta({ column: true, label: "Billed" }),
  quantity_canceled: z.int().min(0).meta({ column: true, label: "Canceled" }),
}).superRefine((line, ctx) => {
  // Two invariants, not one Σ: receiving and billing are independent axes, so
  // `received + billed` means nothing. Each axis is bounded by what is still
  // coming — the out-of-service `Σ breakdown ≤ quantity`, once per axis.
  if (line.quantity_received + line.quantity_canceled > line.quantity) {
    ctx.addIssue({
      code: "custom",
      path: ["quantity_received"],
      message: `received ${line.quantity_received} + canceled ${line.quantity_canceled} exceeds the ${line.quantity} ordered`,
    });
  }
  if (line.quantity_billed + line.quantity_canceled > line.quantity) {
    ctx.addIssue({
      code: "custom",
      path: ["quantity_billed"],
      message: `billed ${line.quantity_billed} + canceled ${line.quantity_canceled} exceeds the ${line.quantity} ordered; ` +
        "a short close that leaves more billed than received credits the excess",
    });
  }
});

/**
 * The purchase's status, derived — never client-set.
 *
 * - `canceled` when every line is canceled in full: nothing received, nothing
 *   left billed. A cancel is a close with nothing received.
 * - `complete` when every line is RESOLVED on BOTH axes: each unit either
 *   received or canceled, and billed for exactly what was not canceled. Payment
 *   is the bill's business and does not hold a purchase open.
 * - `active` otherwise.
 *
 * ⚠️ **Received in full but unbilled is `active`, deliberately.** The owner's
 * sequence bills before delivery as often as after, and a purchase that reads
 * `complete` while a bill is still owed hides exactly the work the split exists
 * to show.
 *
 * Lives in the schema module, not in `utils/`, because the document refine
 * calls it and `utils/` imports `schemas/` one way only.
 * `@cfs/core/utils/purchases` re-exports it.
 */
export function derivePurchaseStatus(purchase: Pick<Purchase, "lines">): PurchaseStatusType {
  const { lines } = purchase;
  if (lines.length === 0) return "active";
  if (lines.every((l) => l.quantity_canceled === l.quantity && l.quantity_billed === 0)) {
    return "canceled";
  }
  const resolved = lines.every((l) =>
    l.quantity_received + l.quantity_canceled === l.quantity &&
    l.quantity_billed + l.quantity_canceled === l.quantity
  );
  return resolved ? "complete" : "active";
}

// ── Document ─────────────────────────────────────────────────────

/** A purchase order placed with a supplier. */
export interface Purchase {
  uid: string;
  /** Monotonic per-collection sequence (`counters/purchases`). Displayed `PO-n`; stored bare. */
  number: number;
  status: PurchaseStatusType;
  /**
   * Who CFS is buying from — a point-in-time `{uid, name}` snapshot. Every
   * receipt's `Movement.supplier` and every bill's `supplier` must equal it;
   * the writers assert that, since it spans documents.
   */
  supplier: UidNameRefType;
  /** The store the goods are coming to — a `{uid, name}` snapshot. */
  store: UidNameRefType;
  /** The day the order was placed. A calendar date. */
  date: string;
  date_fs: FirestoreTimestampType;
  /** The supplier's order or quote number, or `null`. */
  reference: string | null;
  /** Internal note, or `null` for none. */
  notes: string | null;
  lines: PurchaseLine[];
  /** Σ `lines[].amount_cents` — refined. */
  total_cents: number;
  uid_thread?: string;
  version: number;
  created_by: ActorRefType;
  updated_by: ActorRefType;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}

function checkPurchase(p: Purchase, ctx: z.RefinementCtx): void {
  const seen = new Set<string>();
  p.lines.forEach((line, i) => {
    if (seen.has(line.uid_product)) {
      ctx.addIssue({
        code: "custom",
        path: ["lines", i, "uid_product"],
        message: "a purchase has one line per product; a second price for a product is a second purchase",
      });
    }
    seen.add(line.uid_product);
  });

  const total = p.lines.reduce((sum, l) => sum + l.amount_cents, 0);
  if (p.total_cents !== total) {
    ctx.addIssue({
      code: "custom",
      path: ["total_cents"],
      message: `total_cents ${p.total_cents} must equal the lines' ${total}`,
    });
  }

  const derived = derivePurchaseStatus(p);
  if (p.status !== derived) {
    ctx.addIssue({
      code: "custom",
      path: ["status"],
      message: `status "${p.status}" contradicts the lines, which derive "${derived}"`,
    });
  }
}

/** Zod schema for Purchase. */
export const PurchaseSchema: z.ZodType<Purchase> = z.strictObject({
  uid: FirestoreId,
  number: z.int().min(1).meta({ column: true, label: "#", linkTo: "purchaseDetail", serverSortVia: "number" }),
  status: PurchaseStatusEnum.meta({ column: true, label: "Status" }),
  supplier: UidNameRef.meta({ label: "Supplier" }),
  store: UidNameRef.meta({ label: "Store" }),
  date: chicagoStartOfDay().meta({ serverSortVia: "date_fs", column: true, label: "Date" }),
  date_fs: FirestoreTimestamp,
  reference: z.string().max(200).nullable().meta({ column: true, label: "Reference" }),
  notes: z.string().meta({ pii: "mask", column: true, label: "Notes" }).nullable(),
  lines: z.array(PurchaseLineSchema).min(1).meta({ label: "Line" }),
  total_cents: z.int().min(0).meta({ column: true, label: "Total" }),
  uid_thread: ThreadId.optional(),
  version: z.int().min(0).default(0),
  created_by: ActorRef.meta({ column: true, label: "Created By" }),
  updated_by: ActorRef.meta({ column: true, label: "Updated By" }),
  ...TimestampFields,
}).superRefine(checkPurchase).meta({
  title: "Purchase",
  collection: "purchases",
  displayDefaults: {
    columns: ["number", "date", "supplier.name", "status", "total_cents"],
    filters: { status: [] },
    sort: { column: "number", direction: "desc" },
    groupBy: [
      { field: null, label: "None" },
      { field: "status", label: "Status", kind: "enum" },
    ],
  },
});

// ── Inputs ───────────────────────────────────────────────────────

/** One line as an operator orders it — the buckets are the server's. */
export interface PurchaseLineInputType {
  uid_product: string;
  quantity: number;
  amount_cents: number;
  expected_date?: string | null;
}

/** Zod schema for PurchaseLineInputType. */
export const PurchaseLineInput: z.ZodType<PurchaseLineInputType> = z.object({
  uid_product: FirestoreId,
  quantity: z.int().min(1),
  amount_cents: z.int().min(0),
  expected_date: chicagoStartOfDay().nullable().optional(),
});

function uniqueProducts(lines: readonly { uid_product: string }[], ctx: z.RefinementCtx): void {
  const seen = new Set<string>();
  lines.forEach((line, i) => {
    if (seen.has(line.uid_product)) {
      ctx.addIssue({
        code: "custom",
        path: ["lines", i, "uid_product"],
        message: "one line per product",
      });
    }
    seen.add(line.uid_product);
  });
}

/**
 * Input for creating a purchase.
 *
 * `supplier` and `store` are uids only — the server resolves the names, as
 * `CreateTransactionInput.supplier` does, so a snapshot never disagrees with
 * its document.
 */
export interface CreatePurchaseInputType {
  supplier: { uid: string };
  store: { uid: string };
  date: string;
  reference?: string | null;
  notes?: string | null;
  lines: PurchaseLineInputType[];
  /**
   * One per operator action, client-minted OUTSIDE any retry loop. The purchase
   * id is derived from it (`derivedId("purchase:{uuid_session}")`), so a retried
   * create lands on the same document.
   */
  uuid_session: string;
}

/** Zod schema for CreatePurchaseInputType. */
export const CreatePurchaseInput: z.ZodType<CreatePurchaseInputType> = z.object({
  supplier: z.object({ uid: FirestoreId }),
  store: z.object({ uid: FirestoreId }),
  date: chicagoStartOfDay(),
  reference: z.string().max(200).nullable().optional(),
  notes: z.string().meta({ pii: "mask" }).nullable().optional(),
  lines: z.array(PurchaseLineInput).min(1),
  uuid_session: z.uuid(),
}).superRefine((p, ctx) => uniqueProducts(p.lines, ctx));

/**
 * Input for amending a purchase — a PATCH.
 *
 * `lines`, when present, is the complete next set. The writer refuses to change
 * a line's `quantity` below what is received or billed, and refuses to change
 * its `amount_cents` once it has any receipt or bill: a price that moved after
 * goods or a bill exist is a short close plus a new purchase (the plan's *Money
 * rules*), because every receipt already carries its share of the old price.
 * Those are cross-document facts the writer holds, so they are not refined here.
 */
export interface UpdatePurchaseInputType {
  date?: string;
  reference?: string | null;
  notes?: string | null;
  lines?: PurchaseLineInputType[];
  version: number;
}

/** Zod schema for UpdatePurchaseInputType. */
export const UpdatePurchaseInput: z.ZodType<UpdatePurchaseInputType> = z.object({
  date: chicagoStartOfDay().optional(),
  reference: z.string().max(200).nullable().optional(),
  notes: z.string().meta({ pii: "mask" }).nullable().optional(),
  lines: z.array(PurchaseLineInput).min(1).optional(),
  version: z.int().min(0),
}).superRefine((p, ctx) => {
  if (p.lines) uniqueProducts(p.lines, ctx);
});

/**
 * Input for a short close or a cancel.
 *
 * Sets each named line's `quantity_canceled` to `quantity − quantity_received`.
 * `uid_products` absent closes every line; a cancel is a close of a purchase
 * with nothing received. When the close leaves a line billed beyond what was
 * received, the writer raises a `purchase-credits` document for the excess.
 */
export interface ClosePurchaseInputType {
  uid_products?: string[];
  /** Client-minted per operator action; keys the auto-credit, so a retry cannot mint two. */
  uuid_session: string;
  version: number;
}

/** Zod schema for ClosePurchaseInputType. */
export const ClosePurchaseInput: z.ZodType<ClosePurchaseInputType> = z.object({
  uid_products: z.array(FirestoreId).min(1).optional(),
  uuid_session: z.uuid(),
  version: z.int().min(0),
});

/** One product received in a delivery. */
export interface ReceivePurchaseLineInputType {
  uid_product: string;
  quantity: number;
  /** Which shelves the units go to. Absent means the server allocates. */
  allocations?: MovementAllocationInputType[];
  /**
   * Which units arrive, on a serialized product: exactly `quantity`, ascending
   * by number, each with the serial it arrives with — the receipt is where
   * serials are captured (serial-tracking D8), exactly as on a manual purchase.
   */
  units?: MovementUnitInputType[];
}

/** Zod schema for ReceivePurchaseLineInputType. */
export const ReceivePurchaseLineInput: z.ZodType<ReceivePurchaseLineInputType> = z.object({
  uid_product: FirestoreId,
  quantity: z.int().min(1),
  allocations: z.array(MovementAllocationInput).min(1).optional(),
  units: z.array(MovementUnitInput).optional(),
}).superRefine((l, ctx) => {
  if (l.allocations && l.quantity !== l.allocations.reduce((sum, a) => sum + a.quantity, 0)) {
    ctx.addIssue({ code: "custom", path: ["quantity"], message: "quantity must equal the sum of per-location allocation quantities" });
  }
  if (l.units !== undefined) {
    if (l.units.length !== l.quantity) {
      ctx.addIssue({ code: "custom", path: ["units"], message: "a receipt that names units names exactly `quantity` of them" });
    }
    for (let i = 1; i < l.units.length; i++) {
      if (l.units[i].number <= l.units[i - 1].number) {
        ctx.addIssue({ code: "custom", path: ["units", i], message: "units must be ascending by number, each named once" });
        break;
      }
    }
  }
  const issue = allocationUnitsIssue(l.units?.map((u) => u.number), l.allocations);
  if (issue !== null) ctx.addIssue({ code: "custom", path: ["allocations"], message: issue });
});

/**
 * Input for receiving goods against a purchase.
 *
 * Each line becomes ONE `purchase` movement naming the purchase in `sources[]`,
 * all in one transaction with the bucket co-write. The movement id is
 * `{uuid_session}|purchase|{uid_product}`, so a delivery of several products
 * shares one session and a retry lands on the same movements. Cost is not an
 * input: each receipt costs its cumulative share of the line
 * (`cumulativeShareCents`), which is what keeps basis equal to what is billed.
 */
export interface ReceivePurchaseInputType {
  /** The physical instant the goods arrived. */
  date: string;
  reference?: string;
  lines: ReceivePurchaseLineInputType[];
  uuid_session: string;
  version: number;
}

/** Zod schema for ReceivePurchaseInputType. */
export const ReceivePurchaseInput: z.ZodType<ReceivePurchaseInputType> = z.object({
  date: chicagoInstant(),
  reference: z.string().optional(),
  lines: z.array(ReceivePurchaseLineInput).min(1),
  uuid_session: z.uuid(),
  version: z.int().min(0),
}).superRefine((p, ctx) => uniqueProducts(p.lines, ctx));

/**
 * Input for reversing one receipt (`POST /purchases/{uid}/receipts/{movementUid}/reverse`).
 *
 * A standalone reversal of a receipt is refused; this lever reverses it AND
 * decrements `quantity_received` in one transaction. It posts nothing to Xero —
 * a receipt never did.
 */
export interface ReversePurchaseReceiptInputType {
  uuid_session: string;
  reference?: string;
  version: number;
}

/** Zod schema for ReversePurchaseReceiptInputType. */
export const ReversePurchaseReceiptInput: z.ZodType<ReversePurchaseReceiptInputType> = z.object({
  uuid_session: z.uuid(),
  reference: z.string().optional(),
  version: z.int().min(0),
});
