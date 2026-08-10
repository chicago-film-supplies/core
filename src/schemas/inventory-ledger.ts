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

const INVENTORY_STOCK_METHODS = ["bulk", "serialized"] as const;
type InventoryStockMethodType = typeof INVENTORY_STOCK_METHODS[number];


/** An inventory ledger document tracking stock quantities and costs per product. */
export interface InventoryLedger {
  uid: string;
  uid_product: string;
  type: ProductTypeType;
  stock_method: InventoryStockMethodType;
  quantity_held: number;
  quantity_in_service: number;
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
  // value below zero units). Demand-side availability lives on stock-summaries
  // (quantity_available) and is intentionally left unconstrained so overbooking
  // can show negative.
  quantity_held: z.number().min(0).meta({ column: true, label: "Quantity Held" }),
  quantity_in_service: z.number().min(0),
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
  store_breakdown: z.array(StoreBreakdownEntrySchema).default([]).meta({ label: "Store" }),
  query_by_uid_store: z.array(FirestoreId).default([]),
  query_by_uid_location: z.array(FirestoreId).default([]),
  created_at: FirestoreTimestamp.meta({ column: true, label: "Created" }),
  updated_at: FirestoreTimestamp.meta({ column: true, label: "Updated" }),
}).meta({
  title: "Inventory Ledger",
  collection: "inventory-ledgers",
  displayDefaults: {
    columns: ["type", "stock_method", "quantity_held", "store_breakdown.quantity"],
    filters: {},
    sort: { column: null, direction: "desc" },
  },
});
