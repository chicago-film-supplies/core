/**
 * InventoryLedger document schema — Firestore collection: inventory-ledgers
 */
import { z } from "zod";
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
  average_unit_cost: number;
  total_cost_basis: number;
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
  uid: z.string(),
  uid_product: z.string(),
  type: ProductTypeEnum,
  stock_method: z.enum(INVENTORY_STOCK_METHODS),
  quantity_held: z.number(),
  quantity_in_service: z.number(),
  quantity_out_of_service: z.number(),
  average_unit_cost: z.number(),
  total_cost_basis: z.number(),
  out_of_service_breakdown: z.strictObject({
    cleaning: z.number(),
    damaged: z.number(),
    maintenance: z.number(),
    lost: z.number(),
  }),
  store_breakdown: z.array(StoreBreakdownEntrySchema).default([]),
  query_by_uid_store: z.array(z.string()).default([]),
  query_by_uid_location: z.array(z.string()).default([]),
  created_at: FirestoreTimestamp,
  updated_at: FirestoreTimestamp,
}).meta({
  title: "Inventory Ledger",
  collection: "inventory-ledgers",
  displayDefaults: {
    columns: ["type", "stock_method", "quantity_held", "store_breakdown"],
    filters: {},
    sort: { column: null, direction: "desc" },
  },
});
