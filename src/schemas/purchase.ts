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
 * arrived. Design: api-cloudrun#1210.
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
 * PURCHASE, never a second line (see the plan's *Money rules*) — with one
 * exception: a PACK (`expandPurchaseLines`, `@cfs/core/utils/purchases`) is
 * stored as its stocked component, and when that product already has a line
 * the two MERGE, amounts summed (owner, 2026-10-22, api-cloudrun#1081). The
 * ledger averages the cost either way. Merging into a line already received or
 * billed changes its amount, which the API's amend refuses, so that case still
 * becomes a second purchase.
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
 * ## Two kinds: a buy and a subrent
 *
 * `kind` says what CFS is getting from the supplier. A **buy** transfers
 * ownership: its receipts are `purchase` movements that raise `quantity_held`
 * and the cost basis. A **subrent** borrows units for a hire window and gives
 * them back: its receipts are `subrent_in` movements and its returns `subrent_out`,
 * both cost-forbidden, so the units are in CFS's CUSTODY without ever being
 * OWNED (`InventoryLedger.quantity_rented_in`). Everything else — supplier,
 * store, number, bills, credits, the Xero ACCPAY and the thread — is shared, so
 * a subrent is the same document rather than a second collection.
 *
 * A subrent line carries three members a buy line never does, and the document
 * refine below holds the arm strictly in both directions: `dates` (the hire
 * window, which is SUPPLY in availability from the moment the purchase exists —
 * owner, 2026-10-24), `quantity_returned`, and `uid_orders` (the orders it was
 * raised for, for margin; never a reservation — the units stay fungible).
 *
 * The document stays one `z.strictObject` with a `superRefine` rather than a
 * root `discriminatedUnion`: no registered document schema has one, and the
 * column walker, `getInitialValues`, `getTestDoc` and the stored-defaults walk
 * all assume a root object (the precedent is the card's per-kind refine).
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

// ── Kind ─────────────────────────────────────────────────────────

/**
 * What a purchase gets from its supplier — see the module docblock. `buy` is
 * FIRST so `getInitialValues` seeds a buy.
 */
export const PURCHASE_KINDS = ["buy", "subrent"] as const;
/** Allowed purchase kinds. See {@link PURCHASE_KINDS}. */
export type PurchaseKindType = typeof PURCHASE_KINDS[number];
/** Zod schema for PurchaseKindType. */
export const PurchaseKindEnum: z.ZodType<PurchaseKindType> = z.enum(PURCHASE_KINDS);

// ── Lines ────────────────────────────────────────────────────────

/**
 * A subrent line's hire window — two Chicago instants. `end` is when the units
 * are due back to the SUPPLIER, not when the customer returns them.
 *
 * Named `dates` after out-of-service, bookings and cards. The object carries no
 * label of its own; its children are labelled, so the composed heading stays
 * "Line Hire Start" rather than doubling a word.
 */
export interface PurchaseLineDates {
  start: string;
  end: string;
}

/** Zod schema for PurchaseLineDates. */
export const PurchaseLineDatesSchema: z.ZodType<PurchaseLineDates> = z.strictObject({
  start: chicagoInstant().meta({ column: true, label: "Hire Start" }),
  end: chicagoInstant().meta({ column: true, label: "Hire End" }),
});

/**
 * One landed cost on a BUY line: freight, duty or a fee the operator attributes
 * to the units still to arrive (api-cloudrun#1227). It is cost basis, so it
 * reaches the ledger only through the receipts that price it.
 *
 * ⚠️ **It lives on the PURCHASE LINE, not on the bill.** 276 of 299 historic
 * bills are linked card-purchase bills with `direct_lines: []`, and the receipt
 * transaction reads the purchase, never its bills. The Xero side is unchanged:
 * the freight still posts through a bill's direct line to its own account.
 * `uid_purchase_bill` is traceability only. A `PurchaseDirectLine` carries no
 * id of its own, so the pointer names the bill.
 *
 * **What it spreads over is fixed at entry.** `quantity` is the line's
 * outstanding count when the entry was made, and `received_at_entry` is
 * `quantity_received` at that moment. The k-th receipt prices the units received
 * since the entry, `clamp(received − received_at_entry, 0, quantity)`, with
 * `cumulativeShareCents`, so the shares telescope to `amount_cents` exactly when
 * every outstanding unit arrives (`purchaseLineReceiptTargetCents`,
 * `@cfs/core/utils/purchases`).
 *
 * **Append-only, the way the line amount is.** An entry no receipt has priced
 * (`quantity_received ≤ received_at_entry`) is editable and removable. One that
 * a receipt has priced any part of is frozen. A short close still proceeds:
 * the unpriced remainder is DERIVED (`strandedLandedCents`), never stored. The
 * post-receipt re-base waits on depreciation (api-cloudrun#1388).
 */
export interface PurchaseLandedCost {
  /** Array-member id, minted by the writer (`crypto.randomUUID()`). */
  uid: string;
  description: string;
  /** What this entry adds to the line's units, integer cents. */
  amount_cents: number;
  /** The line's outstanding count (`quantity − canceled − received`) when the entry was made. */
  quantity: number;
  /** The line's `quantity_received` when the entry was made. */
  received_at_entry: number;
  /** The bill this cost was charged on, or `null`. Traceability only; nothing reads it to price. */
  uid_purchase_bill: string | null;
}

/** Zod schema for PurchaseLandedCost. */
export const PurchaseLandedCostSchema: z.ZodType<PurchaseLandedCost> = z.strictObject({
  uid: z.uuid(),
  description: z.string().min(1).max(200).meta({ column: true, label: "Description" }),
  amount_cents: z.int().min(1).meta({ column: true, label: "Amount" }),
  quantity: z.int().min(1).meta({ column: true, label: "Spread Over" }),
  received_at_entry: z.int().min(0),
  uid_purchase_bill: FirestoreId.nullable(),
});

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
  /**
   * SUBRENT ONLY — the hire window. Required on every subrent line and refused
   * on a buy line by the document refine; optional here because a buy never
   * carries it, not because a subrent may omit it.
   */
  dates?: PurchaseLineDates;
  /**
   * SUBRENT ONLY — units no longer owed to the supplier: Σ of the
   * `subrent_out` (handed back) and `return_to_supplier` (lost or damaged,
   * settled to the supplier's account) movements naming this purchase for this
   * product, net of reversals. Never more than received.
   *
   * ⚠️ **A settled unit counts as returned** (api-cloudrun#1360, D3). Every
   * reader means "no longer owed" — `remainingToReturn`, the return card,
   * `derivePurchaseStatus` and supply — so the "Returned" column includes units
   * that were never physically handed back. A separate counter was rejected:
   * `quantity_canceled` earns its own bucket by bounding billing, and a settle
   * bounds nothing differently. Present-iff-subrent, as `dates`.
   */
  quantity_returned?: number;
  /**
   * SUBRENT ONLY — the orders this line was raised for, possibly none. For
   * margin and for raising a subrent from an order's shortage; it is NOT a
   * reservation, and the units stay fungible across every booking.
   * Present-iff-subrent, as `dates`.
   */
  uid_orders?: string[];
  /**
   * BUY ONLY — freight, duty and fees spread onto the units still to arrive
   * ({@link PurchaseLandedCost}). Refused on a subrent line, which never owns
   * units.
   *
   * Present-iff-buy, as `dates` is present-iff-subrent, so the key stays
   * optional on the type and the document refine (`checkPurchase`) holds the
   * contract. The api stamps `[]` on every buy line it writes, and every stored
   * buy line was backfilled on 2026-10-27 (api-cloudrun#1227).
   */
  landed_costs?: PurchaseLandedCost[];
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
  dates: PurchaseLineDatesSchema.optional(),
  quantity_returned: z.int().min(0).meta({ column: true, label: "Returned" }).optional(),
  uid_orders: z.array(FirestoreId).optional(),
  landed_costs: z.array(PurchaseLandedCostSchema).meta({ label: "Landed Cost" }).optional(),
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
  // A unit can only go back to the supplier once it has come in.
  if (line.quantity_returned !== undefined && line.quantity_returned > line.quantity_received) {
    ctx.addIssue({
      code: "custom",
      path: ["quantity_returned"],
      message: `returned ${line.quantity_returned} exceeds the ${line.quantity_received} received`,
    });
  }
  if (line.dates && Date.parse(line.dates.end) < Date.parse(line.dates.start)) {
    ctx.addIssue({ code: "custom", path: ["dates", "end"], message: "a hire ends at or after it starts" });
  }
  const entryUids = new Set<string>();
  line.landed_costs?.forEach((entry, k) => {
    if (entryUids.has(entry.uid)) {
      ctx.addIssue({ code: "custom", path: ["landed_costs", k, "uid"], message: "a landed cost uid appears once per line" });
    }
    entryUids.add(entry.uid);
    // The units it spreads over had not arrived when it was entered, so they
    // fit inside what was ordered then. A later quantity cut must keep it so:
    // the writer re-bases an entry no receipt has priced, and refuses the cut
    // under a frozen one (a short close is the channel for "fewer will come").
    if (entry.received_at_entry + entry.quantity > line.quantity) {
      ctx.addIssue({
        code: "custom",
        path: ["landed_costs", k, "quantity"],
        message: `a landed cost spreads over ${entry.quantity} units after ${entry.received_at_entry} received, ` +
          `more than the ${line.quantity} ordered`,
      });
    }
  });
});

/**
 * The purchase's status, derived — never client-set.
 *
 * - `canceled` when every line is canceled in full: nothing received, nothing
 *   left billed. A cancel is a close with nothing received.
 * - `complete` when every line is RESOLVED on BOTH axes: each unit either
 *   received or canceled, and billed for exactly what was not canceled. Payment
 *   is the bill's business and does not hold a purchase open. A SUBRENT adds a
 *   third axis: every unit received has also been RETURNED, because a hire with
 *   units still in CFS's custody is not finished.
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
export function derivePurchaseStatus(purchase: Pick<Purchase, "lines" | "kind">): PurchaseStatusType {
  const { lines } = purchase;
  const subrent = purchase.kind === "subrent";
  if (lines.length === 0) return "active";
  if (lines.every((l) => l.quantity_canceled === l.quantity && l.quantity_billed === 0)) {
    return "canceled";
  }
  const resolved = lines.every((l) =>
    l.quantity_received + l.quantity_canceled === l.quantity &&
    l.quantity_billed + l.quantity_canceled === l.quantity &&
    (!subrent || (l.quantity_returned ?? 0) === l.quantity_received)
  );
  return resolved ? "complete" : "active";
}

/**
 * Derive `query_by_products` — every line's product, in line order. The one
 * author of the mirror, called by every writer; it lives here because the
 * document refine needs it and `utils/` imports `schemas/` one way only.
 * `@cfs/core/utils/purchases` re-exports it.
 */
export function deriveQueryByProducts(lines: readonly Pick<PurchaseLine, "uid_product">[]): string[] {
  return lines.map((l) => l.uid_product);
}

/**
 * Derive `query_by_orders` — the distinct union of the lines' `uid_orders`, in
 * first-seen order. `[]` on a buy. Same home and re-export as
 * {@link deriveQueryByProducts}.
 */
export function deriveQueryByOrders(lines: readonly Pick<PurchaseLine, "uid_orders">[]): string[] {
  return [...new Set(lines.flatMap((l) => l.uid_orders ?? []))];
}

// ── Document ─────────────────────────────────────────────────────

/** A purchase order placed with a supplier. */
export interface Purchase {
  uid: string;
  /** Monotonic per-collection sequence (`counters/purchases`). Displayed `PO-n`; stored bare. */
  number: number;
  status: PurchaseStatusType;
  /**
   * `buy` or `subrent` — see the module docblock. Fixed at create.
   *
   * Required since beta B: the 303 pre-subrent purchases were stamped `buy` by
   * `api-cloudrun/scripts/backfill-purchase-kind.ts` on 2026-10-24 (prod, dev and
   * the `test` database, 0 missing after).
   */
  kind: PurchaseKindType;
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
  /**
   * Mirror of every line's `uid_product` ({@link deriveQueryByProducts}), for
   * "which purchases name this product" as one `array-contains` — the stock
   * rebuild's subrent-supply read. On both kinds. Refused when it disagrees
   * with the lines. Required since beta B (backfilled 2026-10-24, as `kind`).
   */
  query_by_products: string[];
  /**
   * Mirror of the lines' `uid_orders` ({@link deriveQueryByOrders}): "which
   * subrents were raised for this order". `[]` on a buy. Required and refined
   * exactly as `query_by_products`.
   */
  query_by_orders: string[];
  uid_thread?: string;
  version: number;
  created_by: ActorRefType;
  updated_by: ActorRefType;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}

const SUBRENT_LINE_MEMBERS = ["dates", "quantity_returned", "uid_orders"] as const;

function sameMembers(mirror: readonly string[], derived: readonly string[]): boolean {
  const want = new Set(derived);
  return mirror.length === want.size && mirror.every((u) => want.has(u));
}

function checkPurchase(p: Purchase, ctx: z.RefinementCtx): void {
  // The kind arm, strict in both directions: no subrent document predates it,
  // so there is nothing for a lenient arm to protect.
  const subrent = p.kind === "subrent";
  p.lines.forEach((line, i) => {
    for (const key of SUBRENT_LINE_MEMBERS) {
      const present = line[key] !== undefined;
      if (subrent && !present) {
        ctx.addIssue({ code: "custom", path: ["lines", i, key], message: `a subrent line states ${key}` });
      } else if (!subrent && present) {
        ctx.addIssue({ code: "custom", path: ["lines", i, key], message: `${key} is a subrent line's; a buy line never carries it` });
      }
    }
    // Present-iff-buy, the mirror of the subrent members: a subrent never owns
    // its units, so there is no cost basis to land on, and every buy line states
    // its landed costs (`[]` at least) since the 2026-10-27 backfill.
    if (subrent && line.landed_costs !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["lines", i, "landed_costs"],
        message: "landed_costs is a buy line's; a subrent never owns the units it would land on",
      });
    } else if (!subrent && line.landed_costs === undefined) {
      ctx.addIssue({ code: "custom", path: ["lines", i, "landed_costs"], message: "a buy line states landed_costs" });
    }
  });

  if (!sameMembers(p.query_by_products, deriveQueryByProducts(p.lines))) {
    ctx.addIssue({
      code: "custom",
      path: ["query_by_products"],
      message: "query_by_products must list exactly the lines' products",
    });
  }
  if (!sameMembers(p.query_by_orders, deriveQueryByOrders(p.lines))) {
    ctx.addIssue({
      code: "custom",
      path: ["query_by_orders"],
      message: "query_by_orders must list exactly the distinct uid_orders on the lines",
    });
  }

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
  kind: PurchaseKindEnum.meta({ column: true, label: "Kind" }),
  supplier: UidNameRef.meta({ label: "Supplier" }),
  store: UidNameRef.meta({ label: "Store" }),
  date: chicagoStartOfDay().meta({ serverSortVia: "date_fs", column: true, label: "Date" }),
  date_fs: FirestoreTimestamp,
  reference: z.string().max(200).nullable().meta({ column: true, label: "Reference" }),
  notes: z.string().meta({ pii: "mask", column: true, label: "Notes" }).nullable(),
  lines: z.array(PurchaseLineSchema).min(1).meta({ label: "Line" }),
  total_cents: z.int().min(0).meta({ column: true, label: "Total" }),
  query_by_products: z.array(FirestoreId),
  query_by_orders: z.array(FirestoreId),
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

/**
 * One landed cost as the operator states it on a buy line. `quantity` and
 * `received_at_entry` are the server's, stamped from the stored line.
 *
 * `uid` names a stored entry to keep or edit. A uid the line does not hold
 * is a NEW entry stored under it (the manager mints one as it adds the entry, so
 * a re-send before the Firestore echo is the same entry), and absent mints one
 * server-side. Splitting
 * one amount across several lines is `allocateLandedCostCents`
 * (`@cfs/core/utils/purchases`), run by the client so the preview it shows is the
 * split it sends. Any per-line split is legal; the allocator is the default,
 * not a rule.
 */
export interface PurchaseLandedCostInputType {
  uid?: string;
  description: string;
  amount_cents: number;
  uid_purchase_bill?: string | null;
}

/** Zod schema for PurchaseLandedCostInputType. */
export const PurchaseLandedCostInput: z.ZodType<PurchaseLandedCostInputType> = z.object({
  uid: z.uuid().optional(),
  description: z.string().min(1).max(200),
  amount_cents: z.int().min(1),
  uid_purchase_bill: FirestoreId.nullable().optional(),
});

/** One line as an operator orders it — the buckets are the server's. */
export interface PurchaseLineInputType {
  uid_product: string;
  quantity: number;
  amount_cents: number;
  expected_date?: string | null;
  /** Subrent only — the hire window. Required on a subrent create; the document refine holds it. */
  dates?: PurchaseLineDates;
  /** Subrent only — the orders the line was raised for. Absent is `[]`: the writer states it. */
  uid_orders?: string[];
  /**
   * Buy only — the line's WHOLE landed-cost set. Absent keeps what is stored,
   * so a client that never names landed costs cannot erase them: this is a
   * replacement, and a default here would delete what the client did not
   * restate. Present: a stored entry missing from it is removed, which the
   * writer refuses once a receipt has priced it.
   */
  landed_costs?: PurchaseLandedCostInputType[];
}

/** Zod schema for PurchaseLineInputType. */
export const PurchaseLineInput: z.ZodType<PurchaseLineInputType> = z.object({
  uid_product: FirestoreId,
  quantity: z.int().min(1),
  amount_cents: z.int().min(0),
  expected_date: chicagoStartOfDay().nullable().optional(),
  dates: z.object({ start: chicagoInstant(), end: chicagoInstant() }).optional(),
  uid_orders: z.array(FirestoreId).optional(),
  landed_costs: z.array(PurchaseLandedCostInput).optional(),
}).superRefine((l, ctx) => {
  const named = new Set<string>();
  l.landed_costs?.forEach((entry, k) => {
    if (entry.uid === undefined) return;
    if (named.has(entry.uid)) {
      ctx.addIssue({ code: "custom", path: ["landed_costs", k, "uid"], message: "a landed cost uid appears once per line" });
    }
    named.add(entry.uid);
  });
  if (l.dates && Date.parse(l.dates.end) < Date.parse(l.dates.start)) {
    ctx.addIssue({ code: "custom", path: ["dates", "end"], message: "a hire ends at or after it starts" });
  }
});

/**
 * The input-side kind arm: a subrent names a hire on every line, a buy names
 * none. Only CREATE can check it — an update does not restate the kind, so its
 * writer checks against the stored one.
 */
function kindLines(kind: PurchaseKindType | undefined, lines: readonly PurchaseLineInputType[], ctx: z.RefinementCtx): void {
  const subrent = kind === "subrent";
  lines.forEach((line, i) => {
    if (subrent && line.dates === undefined) {
      ctx.addIssue({ code: "custom", path: ["lines", i, "dates"], message: "a subrent line names its hire window" });
    }
    if (!subrent) {
      for (const key of ["dates", "uid_orders"] as const) {
        if (line[key] !== undefined) {
          ctx.addIssue({ code: "custom", path: ["lines", i, key], message: `${key} is a subrent line's; a buy line never carries it` });
        }
      }
    }
    if (subrent && line.landed_costs !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["lines", i, "landed_costs"],
        message: "landed_costs is a buy line's; a subrent never owns the units it would land on",
      });
    }
  });
}

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
  /** Absent is `buy`; the WRITER states it on the document (never an input `.default()`). */
  kind?: PurchaseKindType;
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
  kind: PurchaseKindEnum.optional(),
  supplier: z.object({ uid: FirestoreId }),
  store: z.object({ uid: FirestoreId }),
  date: chicagoStartOfDay(),
  reference: z.string().max(200).nullable().optional(),
  notes: z.string().meta({ pii: "mask" }).nullable().optional(),
  lines: z.array(PurchaseLineInput).min(1),
  uuid_session: z.uuid(),
}).superRefine((p, ctx) => {
  uniqueProducts(p.lines, ctx);
  kindLines(p.kind, p.lines, ctx);
});

/**
 * Input for amending a purchase — a PATCH.
 *
 * `lines`, when present, is the complete next set. The writer refuses to change
 * a line's `quantity` below what is received or billed, and refuses to change
 * its `amount_cents` once it has any receipt or bill: a price that moved after
 * goods or a bill exist is a short close plus a new purchase (the plan's *Money
 * rules*), because every receipt already carries its share of the old price.
 * Those are cross-document facts the writer holds, so they are not refined here.
 *
 * ⚠️ **A SUBRENT line's price is not frozen by a receipt**, because its receipts
 * carry no cost (`subrent_in` is cost-forbidden). So on a subrent the writer lets
 * `amount_cents` and `dates.end` move after receipt — a paid hire extension —
 * with `quantity` still floored at what is received. Without that, an
 * extension is unwritable: a close is refused while units are out.
 *
 * `kind` is not here: it is fixed at create, and the writer checks the lines'
 * subrent members against the stored kind.
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
  /**
   * Which locations the units go to. Absent means they land at the store's
   * default staging location (`store.default_location`, the arrivals inbox),
   * as every arrival does — a receipt is an arrival (api-cloudrun#1302 ruling
   * 12; api-cloudrun#1308). Name a storage location to shelve them directly.
   */
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

/** One product given back to the supplier on a subrent. */
export interface ReturnPurchaseLineInputType {
  uid_product: string;
  quantity: number;
  /**
   * Which locations the units leave FROM. Absent means the writer picks the
   * shelves, as a check-out does.
   */
  allocations?: MovementAllocationInputType[];
  /**
   * Which units go back, on a serialized product: exactly `quantity`,
   * ascending by number, by NUMBER only (a serial is captured on the way in,
   * never on the way out). The writer requires them on a seeded roster and
   * refuses any unit not subrented from this purchase's supplier
   * (api-cloudrun `.claude/plans/serialized-subrent.md` § 2).
   */
  units?: MovementUnitInputType[];
}

/** Zod schema for ReturnPurchaseLineInputType. */
export const ReturnPurchaseLineInput: z.ZodType<ReturnPurchaseLineInputType> = z.object({
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
      ctx.addIssue({ code: "custom", path: ["units"], message: "a return that names units names exactly `quantity` of them" });
    }
    for (let i = 1; i < l.units.length; i++) {
      if (l.units[i].number <= l.units[i - 1].number) {
        ctx.addIssue({ code: "custom", path: ["units", i], message: "units must be ascending by number, each named once" });
        break;
      }
    }
    l.units.forEach((u, i) => {
      if (u.serial_number !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["units", i, "serial_number"],
          message: "a return names units by number only; a serial arrives with a unit coming in",
        });
      }
    });
  }
  const issue = allocationUnitsIssue(l.units?.map((u) => u.number), l.allocations);
  if (issue !== null) ctx.addIssue({ code: "custom", path: ["allocations"], message: issue });
});

/**
 * Input for returning subrented units to the supplier
 * (`POST /purchases/{uid}/returns`) — the mirror of {@link ReceivePurchaseInput}.
 *
 * Each line becomes ONE `subrent_out` movement naming the purchase in `sources[]`,
 * in one transaction with the `quantity_returned` co-write. The movement id is
 * `{uuid_session}|subrent_out|{uid_product}`, so a retry lands on the same
 * movements. There is no cost: a returned unit was never owned.
 */
export interface ReturnPurchaseInputType {
  /** The physical instant the units left for the supplier. */
  date: string;
  reference?: string;
  lines: ReturnPurchaseLineInputType[];
  uuid_session: string;
  version: number;
}

/** Zod schema for ReturnPurchaseInputType. */
export const ReturnPurchaseInput: z.ZodType<ReturnPurchaseInputType> = z.object({
  date: chicagoInstant(),
  reference: z.string().optional(),
  lines: z.array(ReturnPurchaseLineInput).min(1),
  uuid_session: z.uuid(),
  version: z.int().min(0),
}).superRefine((p, ctx) => uniqueProducts(p.lines, ctx));

/**
 * Input for reversing one return (`POST /purchases/{uid}/returns/{movementUid}/reverse`)
 * — the mirror of {@link ReversePurchaseReceiptInput}: it reverses the
 * `subrent_out` AND decrements `quantity_returned` in one transaction.
 */
export interface ReversePurchaseReturnInputType {
  uuid_session: string;
  reference?: string;
  version: number;
}

/** Zod schema for ReversePurchaseReturnInputType. */
export const ReversePurchaseReturnInput: z.ZodType<ReversePurchaseReturnInputType> = z.object({
  uuid_session: z.uuid(),
  reference: z.string().optional(),
  version: z.int().min(0),
});
