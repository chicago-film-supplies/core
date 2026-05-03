/**
 * Transaction document schema — Firestore collection: transactions
 */
import { z } from "zod";
import { chicagoInstant } from "./_datetime.ts";
import { FirestoreTimestamp, type FirestoreTimestampType } from "./common.ts";

/** All possible transaction type identifiers. */
export const TRANSACTION_TYPES = [
  "opening_balance", "purchase", "find", "make", "adjustment_increase",
  "sale", "write_off", "trade_in", "adjustment_decrease",
  "transfer_increase", "transfer_decrease",
  "acquisition", "disposal", "partial_disposal",
  "depreciation_tax", "depreciation_gaap",
] as const;
/** Union of all transaction type string literals. */
export type TransactionTypeType = typeof TRANSACTION_TYPES[number];
const TransactionType: z.ZodType<TransactionTypeType> = z.enum(TRANSACTION_TYPES);

const INCREASE_TYPES: TransactionTypeType[] = [
  "purchase", "make", "find", "opening_balance", "adjustment_increase", "transfer_increase",
];
const DECREASE_TYPES: TransactionTypeType[] = [
  "sale", "trade_in", "write_off", "adjustment_decrease", "transfer_decrease",
];

/**
 * Returns +1 for increase types, -1 for decrease types.
 * Throws for financial-only types (acquisition, disposal, depreciation).
 */
export function getTransactionMultiplier(type: TransactionTypeType): 1 | -1 {
  if (INCREASE_TYPES.includes(type)) return 1;
  if (DECREASE_TYPES.includes(type)) return -1;
  throw new Error("Transaction type does not have a quantity multiplier: " + type);
}

/** Financial-only types that don't involve physical inventory movement. */
const FINANCIAL_ONLY_TYPES: TransactionTypeType[] = [
  "acquisition", "disposal", "partial_disposal",
  "depreciation_tax", "depreciation_gaap",
];

/**
 * Determines if a transaction type should track costs (total_cost / unit_cost).
 * Returns false for transfers and financial-only types.
 */
export function hasCosts(type: TransactionTypeType): boolean {
  if (FINANCIAL_ONLY_TYPES.includes(type)) return false;
  if (type === "transfer_increase" || type === "transfer_decrease") return false;
  return true;
}

/**
 * Returns transaction types suitable for UI display in manual transaction forms.
 * Excludes financial-only types (acquisition, disposal, depreciation) and transfers.
 * When `increaseOnly` is true, returns only types that increase inventory
 * (for first transactions / opening balance scenarios).
 */
export function getDisplayTransactionTypes(increaseOnly?: boolean): TransactionTypeType[] {
  if (increaseOnly) {
    return ["purchase", "make", "find"];
  }
  return TRANSACTION_TYPES.filter(
    (t) => !FINANCIAL_ONLY_TYPES.includes(t) && t !== "transfer_increase" && t !== "transfer_decrease" && t !== "opening_balance",
  );
}

const TRANSACTION_SOURCE_TYPES = ["manual", "order", "internal"] as const;
type TransactionSourceTypeType = typeof TRANSACTION_SOURCE_TYPES[number];

/** A location within a store affected by a transaction. */
export interface TransactionStoreLocation {
  uid_location: string;
  name: string;
  quantity: number;
  transactionQuantity: number;
  default: boolean;
  max: number | null;
}

/** A store affected by a transaction, including its locations. */
export interface TransactionStore {
  uid_store: string;
  name: string;
  default: boolean;
  quantity: number;
  locations: TransactionStoreLocation[];
}

/** The origin source of a transaction (manual, order, or internal). */
export interface TransactionSource {
  type: TransactionSourceTypeType;
  number: string | number | null;
  uid: string | null;
}

/** A transaction document representing an inventory movement or financial event. */
export interface Transaction {
  uid: string;
  uid_product: string;
  type: TransactionTypeType;
  quantity: number;
  total_cost: number;
  unit_cost: number;
  unit_costs: number[];
  date: string;
  date_fs: FirestoreTimestampType;
  reference: string;
  source: TransactionSource;
  stores: TransactionStore[];
  query_by_uid_store: string[];
  serialized_details: {
    asset_tags: string[];
    serial_numbers: string[];
  } | null;
  crms_sync: Record<string, {
    stock_level_id: number | null;
    transaction_id: number | null;
  }>;
  defaultThreadId?: string;
  version: number;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}

/** Zod schema for TransactionStoreLocation. */
export const TransactionStoreLocationSchema: z.ZodType<TransactionStoreLocation> = z.strictObject({
  uid_location: z.string(),
  name: z.string(),
  quantity: z.number(),
  transactionQuantity: z.number(),
  default: z.boolean(),
  max: z.number().nullable(),
});

/** Zod schema for TransactionStore. */
export const TransactionStoreSchema: z.ZodType<TransactionStore> = z.strictObject({
  uid_store: z.string(),
  name: z.string(),
  default: z.boolean(),
  quantity: z.number(),
  locations: z.array(TransactionStoreLocationSchema).default([]),
});

const SourceSchema: z.ZodType<TransactionSource> = z.strictObject({
  type: z.enum(TRANSACTION_SOURCE_TYPES),
  number: z.union([z.string(), z.number()]).nullable(),
  uid: z.string().nullable(),
});

/** Zod schema for Transaction. */
export const TransactionSchema: z.ZodType<Transaction> = z.strictObject({
  uid: z.string(),
  uid_product: z.string(),
  type: TransactionType,
  quantity: z.number().meta({ serverSortVia: "quantity" }),
  total_cost: z.number(),
  unit_cost: z.number(),
  unit_costs: z.array(z.number()).default([]),
  date: chicagoInstant().meta({ serverSortVia: "date_fs" }),
  date_fs: FirestoreTimestamp,
  reference: z.string(),
  source: SourceSchema,
  stores: z.array(TransactionStoreSchema).default([]),
  query_by_uid_store: z.array(z.string()).default([]),
  serialized_details: z.strictObject({
    asset_tags: z.array(z.string()).default([]),
    serial_numbers: z.array(z.string()).default([]),
  }).nullable(),
  crms_sync: z.record(z.string(), z.strictObject({
    stock_level_id: z.number().nullable(),
    transaction_id: z.number().nullable(),
  })).default({}),
  defaultThreadId: z.string().optional(),
  version: z.int().min(0).default(0),
  created_at: FirestoreTimestamp,
  updated_at: FirestoreTimestamp,
}).meta({
  title: "Transaction",
  collection: "transactions",
  displayDefaults: {
    columns: ["date", "quantity", "total_cost", "source.type", "type", "reference"],
    filters: {},
    sort: { column: "date", direction: "desc" },
    groupBy: [
      { field: null, label: "None" },
      { field: "type", label: "Type", kind: "enum" },
    ],
  },
});

// ── Input schemas for manual transactions ────────────────────────

const MANUAL_TRANSACTION_TYPES = [
  "purchase", "find", "make", "opening_balance", "adjustment_increase",
  "sale", "write_off", "trade_in", "adjustment_decrease",
] as const;

interface InputTransactionStoreLocation {
  uid_location: string;
  name: string;
  transactionQuantity: number;
  default: boolean;
  max: number | null;
}

const InputTransactionStoreLocationSchema: z.ZodType<InputTransactionStoreLocation> = z.object({
  uid_location: z.string(),
  name: z.string(),
  transactionQuantity: z.number().int(),
  default: z.boolean(),
  max: z.number().nullable(),
});

interface InputTransactionStore {
  uid_store: string;
  name: string;
  default: boolean;
  quantity: number;
  locations: InputTransactionStoreLocation[];
}

const InputTransactionStoreSchema: z.ZodType<InputTransactionStore> = z.object({
  uid_store: z.string(),
  name: z.string(),
  default: z.boolean(),
  quantity: z.number(),
  locations: z.array(InputTransactionStoreLocationSchema).min(1),
});

/** Input type for creating a manual transaction. */
export interface CreateTransactionInputType {
  uid: string;
  uid_product: string;
  type: typeof MANUAL_TRANSACTION_TYPES[number];
  quantity: number;
  total_cost: number;
  date: string;
  reference: string;
  stores: InputTransactionStore[];
  serialized_details?: {
    asset_tags: string[];
    serial_numbers: string[];
  } | null;
}

/** Input schema for creating a manual transaction. */
export const CreateTransactionInput: z.ZodType<CreateTransactionInputType> = z.object({
  uid: z.string().min(1),
  uid_product: z.string().min(1),
  type: z.enum(MANUAL_TRANSACTION_TYPES),
  quantity: z.number().int().positive(),
  total_cost: z.number().min(0),
  date: chicagoInstant(),
  reference: z.string(),
  stores: z.array(InputTransactionStoreSchema).min(1),
  serialized_details: z.object({
    asset_tags: z.array(z.string()).default([]),
    serial_numbers: z.array(z.string()).default([]),
  }).nullable().optional(),
});

/** Input type for updating a manual transaction. */
export interface UpdateTransactionInputType {
  uid: string;
  uid_product: string;
  type: typeof MANUAL_TRANSACTION_TYPES[number];
  quantity: number;
  total_cost: number;
  date: string;
  reference: string;
  stores: InputTransactionStore[];
  serialized_details?: {
    asset_tags: string[];
    serial_numbers: string[];
  } | null;
  version: number;
}

/** Input schema for updating a manual transaction. */
export const UpdateTransactionInput: z.ZodType<UpdateTransactionInputType> = z.object({
  uid: z.string().min(1),
  uid_product: z.string().min(1),
  type: z.enum(MANUAL_TRANSACTION_TYPES),
  quantity: z.number().int().positive(),
  total_cost: z.number().min(0),
  date: chicagoInstant(),
  reference: z.string(),
  stores: z.array(InputTransactionStoreSchema).min(1),
  serialized_details: z.object({
    asset_tags: z.array(z.string()).default([]),
    serial_numbers: z.array(z.string()).default([]),
  }).nullable().optional(),
  version: z.int().min(0),
});

/** Input type for creating a store-to-store transfer. */
export interface CreateStoreTransferInputType {
  uid_product: string;
  quantity: number;
  date: string;
  reference: string;
  stores_from: InputTransactionStore[];
  stores_to: InputTransactionStore[];
  total_cost?: number;
  serialized_details?: {
    asset_tags: string[];
    serial_numbers: string[];
  } | null;
}

/** Input schema for creating a store-to-store transfer. */
export const CreateStoreTransferInput: z.ZodType<CreateStoreTransferInputType> = z.object({
  uid_product: z.string().min(1),
  quantity: z.number().int().positive(),
  date: chicagoInstant(),
  reference: z.string(),
  stores_from: z.array(InputTransactionStoreSchema).min(1),
  stores_to: z.array(InputTransactionStoreSchema).min(1),
  total_cost: z.number().min(0).optional().default(0),
  serialized_details: z.object({
    asset_tags: z.array(z.string()).default([]),
    serial_numbers: z.array(z.string()).default([]),
  }).nullable().optional(),
});

/** Input type for updating a store-to-store transfer. */
export interface UpdateStoreTransferInputType {
  uid_product: string;
  transfer_number: number;
  quantity: number;
  date: string;
  reference: string;
  stores_from: InputTransactionStore[];
  stores_to: InputTransactionStore[];
  total_cost?: number;
  serialized_details?: {
    asset_tags: string[];
    serial_numbers: string[];
  } | null;
  version: number;
}

/** Input schema for updating a store-to-store transfer. */
export const UpdateStoreTransferInput: z.ZodType<UpdateStoreTransferInputType> = z.object({
  uid_product: z.string().min(1),
  transfer_number: z.number().int(),
  quantity: z.number().int().positive(),
  date: chicagoInstant(),
  reference: z.string(),
  stores_from: z.array(InputTransactionStoreSchema).min(1),
  stores_to: z.array(InputTransactionStoreSchema).min(1),
  total_cost: z.number().min(0).optional().default(0),
  serialized_details: z.object({
    asset_tags: z.array(z.string()).default([]),
    serial_numbers: z.array(z.string()).default([]),
  }).nullable().optional(),
  version: z.int().min(0),
});
