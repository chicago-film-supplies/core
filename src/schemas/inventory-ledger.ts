/**
 * InventoryLedger document schema — Firestore collection: inventory-ledgers
 */
import { z } from "zod";
import { FirestoreId } from "./_uid.ts";
import {
  FirestoreTimestamp,
  type FirestoreTimestampType,
  StoreBreakdownEntrySchema,
  type StoreBreakdownEntry,
  ProductTypeEnum,
  type ProductTypeType,
} from "./common.ts";

/**
 * The ledger's mirror of `product.stock_method`. `none` is an **uncounted** ledger
 * (see {@link InventoryLedger.quantity_held}); it exists so a `none` rental/sale
 * product can carry bookings, out-of-service records and a `stock/{P}` projection
 * without anyone having to invent a count for it.
 */
const INVENTORY_STOCK_METHODS = ["bulk", "serialized", "none"] as const;
type InventoryStockMethodType = typeof INVENTORY_STOCK_METHODS[number];


/** An inventory ledger document tracking stock quantities and costs per product. */
export interface InventoryLedger {
  uid: string;
  uid_product: string;
  type: ProductTypeType;
  stock_method: InventoryStockMethodType;
  /**
   * Units CFS owns, or **`null` when the product is uncounted** — and `null` is
   * not 0.
   *
   * An uncounted ledger belongs to a `stock_method: "none"` rental/sale product:
   * supply on demand (gas, ice), a no-stock kit parent, an owned item nobody has
   * counted yet, or equipment CFS does not own. Owner ruling 2026-10-03: *"a wrong
   * count is worse than no count"*, so the ledger says "no count" rather than
   * carrying an estimate, and availability treats it as unbounded. It is a
   * tracker of active bookings and out-of-service records, nothing more.
   *
   * `null` rather than `Infinity` because Infinity claims a number:
   * `JSON.stringify(Infinity)` is `"null"` (so every REST, Typesense and browser
   * reader would see `null` anyway), and it turns every sum it enters into ∞
   * silently. It also matches the engine's existing rule that a `null` bound is
   * open-ended.
   *
   * Exactly when `stock_method === "none"`, and an uncounted ledger has no
   * shelves, no in-service count and no cost basis — all enforced below.
   */
  quantity_held: number | null;
  /** `quantity_held − quantity_out_of_service`; `null` exactly when `quantity_held` is. */
  quantity_in_service: number | null;
  quantity_out_of_service: number;
  /** A per-unit RATE at 4dp — dollars, NOT cents. See {@link MovementCostType.unit_cost}. */
  average_unit_cost: number;
  total_cost_basis_cents: number;
  out_of_service_breakdown: {
    cleaning: number;
    damaged: number;
    maintenance: number;
    lost: number;
  };
  store_breakdown: StoreBreakdownEntry[];
  query_by_uid_store: string[];
  query_by_uid_location: string[];
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}

/** Zod schema for an InventoryLedger document. */
export const InventoryLedgerSchema: z.ZodType<InventoryLedger> = z.strictObject({
  uid: FirestoreId,
  uid_product: FirestoreId,
  type: ProductTypeEnum.meta({ column: true, label: "Type" }),
  stock_method: z.enum(INVENTORY_STOCK_METHODS).meta({ column: true, label: "Stock Method" }),
  // Physical / valuation scalars are floored at 0 — fail-closed backstop behind
  // the server-side over-decrease + OOS-cap guards (you can't physically hold or
  // value below zero units). Demand-side availability lives on `stock/{P}`
  // (quantity_available) and is intentionally left unconstrained so overbooking
  // can show negative.
  //
  // `null` = uncounted (see the interface), never a stand-in for 0.
  quantity_held: z.number().min(0).meta({ column: true, label: "Quantity Held" }).nullable(),
  quantity_in_service: z.number().min(0).nullable(),
  quantity_out_of_service: z.number().min(0),
  // 4dp DOLLARS, deliberately not `_cents` — the beta.117 regression was
  // exactly this field quantized to the cent. Its neighbour below is cents.
  average_unit_cost: z.number().min(0).meta({ column: true, label: "Average Unit Cost", unit: "usd" }),
  total_cost_basis_cents: z.int().min(0).meta({ column: true, label: "Cost Basis" }),
  out_of_service_breakdown: z.strictObject({
    cleaning: z.number(),
    damaged: z.number(),
    maintenance: z.number(),
    lost: z.number(),
  }),
  store_breakdown: z.array(StoreBreakdownEntrySchema).meta({ label: "Store" }),
  query_by_uid_store: z.array(FirestoreId),
  query_by_uid_location: z.array(FirestoreId),
  created_at: FirestoreTimestamp.meta({ column: true, label: "Created" }),
  updated_at: FirestoreTimestamp.meta({ column: true, label: "Updated" }),
}).superRefine((ledger, ctx) => {
  // ── The uncounted ledger, as ONE fact ──
  //
  // `stock_method === "none"` and `quantity_held === null` are the same
  // statement, so neither may appear without the other: a counted `none` ledger
  // would be availability-bounded by a number the owner ruled must not exist,
  // and an uncounted `bulk`/`serialized` one would let a serialized roster
  // (whose invariant is `count(units) === quantity_held`) sit on no count.
  const uncounted = ledger.quantity_held === null;
  if (uncounted !== (ledger.stock_method === "none")) {
    ctx.addIssue({
      code: "custom",
      path: ["quantity_held"],
      message: 'quantity_held is null exactly when stock_method is "none" (an uncounted ledger)',
    });
  }
  if (uncounted !== (ledger.quantity_in_service === null)) {
    ctx.addIssue({
      code: "custom",
      path: ["quantity_in_service"],
      message: "quantity_in_service is null exactly when quantity_held is",
    });
  }
  if (!uncounted) return;
  // One direction only: a COUNTED ledger may legitimately have no shelves (every
  // unit out on a job, or held 0). An uncounted one has no shelves by
  // definition — a check-out folds no shelf leg — so a shelf here means some
  // writer folded placement onto a ledger with no count to balance it against.
  if (ledger.store_breakdown.length > 0) {
    ctx.addIssue({
      code: "custom",
      path: ["store_breakdown"],
      message: "an uncounted ledger (quantity_held: null) has no store_breakdown",
    });
  }
  // A basis divided by no count is no average. `applyMovementToLedger` never
  // moves either on an uncounted ledger; this is the backstop.
  if (ledger.total_cost_basis_cents !== 0 || ledger.average_unit_cost !== 0) {
    ctx.addIssue({
      code: "custom",
      path: ["total_cost_basis_cents"],
      message: "an uncounted ledger (quantity_held: null) carries no cost basis",
    });
  }
}).meta({
  title: "Inventory Ledger",
  collection: "inventory-ledgers",
  displayDefaults: {
    columns: ["type", "stock_method", "quantity_held", "store_breakdown.quantity"],
    filters: {},
    sort: { column: null, direction: "desc" },
  },
});
