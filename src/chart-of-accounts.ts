/**
 * ChartOfAccounts document schema — Firestore collection: chart-of-accounts
 */
import { z } from "zod";
import { ActorRef, type ActorRefType, type FirestoreTimestampType, TimestampFields } from "./common.ts";

const COA_CODES = [
  2210, 2800,
  4000, 4100, 4110, 4120, 4130, 4140, 4150,
  4200, 4210, 4300, 4400, 4600, 4700, 4800, 4810, 4820, 4830,
  5000, 5001, 5100, 5200, 5300, 5400, 5500, 5600,
] as const;

const COA_TYPES = [
  "Current Asset", "Fixed Asset", "Inventory", "Non-current Asset", "Prepayment",
  "Equity", "Depreciation", "Direct Costs", "Expense", "Overhead",
  "Current Liability", "Liability", "Non-current Liability",
  "Other Income", "Revenue", "Sales",
] as const;

/** Valid chart of accounts code values. */
export type COACodeType = typeof COA_CODES[number];
/** Valid chart of accounts type values. */
export type COATypeType = typeof COA_TYPES[number];

/** Zod schema for COACode. */
export const COACode: z.ZodType<COACodeType> = z.union(
  COA_CODES.map((c) => z.literal(c)) as [z.ZodLiteral<COACodeType>, ...z.ZodLiteral<COACodeType>[]]
);
/** Zod schema for COAType. */
export const COAType: z.ZodType<COATypeType> = z.enum(COA_TYPES);

/** A chart of accounts document in Firestore. */
export interface ChartOfAccounts {
  uid: string;
  code: COACodeType;
  name: string;
  type: COATypeType;
  description?: string;
  default_tax_profile: string;
  version: number;
  created_by: ActorRefType;
  updated_by: ActorRefType;
  created_at?: FirestoreTimestampType;
  updated_at?: FirestoreTimestampType;
}

/** Zod schema for ChartOfAccounts. */
export const ChartOfAccountsSchema: z.ZodType<ChartOfAccounts> = z.strictObject({
  uid: z.string(),
  code: COACode,
  name: z.string().min(1).max(100),
  type: COAType,
  description: z.string().optional(),
  default_tax_profile: z.string(),
  version: z.int().min(0).default(0),
  created_by: ActorRef,
  updated_by: ActorRef,
  ...TimestampFields,
}).meta({
  title: "Chart of Accounts",
  collection: "chart-of-accounts",
  displayDefaults: {
    columns: ["code", "name", "type"],
    filters: {},
    sort: { column: "code", direction: "asc" },
  },
});
