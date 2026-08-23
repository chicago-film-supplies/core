/**
 * ChartOfAccounts document schema — Firestore collection: chart-of-accounts
 *
 * **This collection is the catalog, and the code list is no longer a literal
 * union.** It used to be `COA_CODES`, 27 hand-written literals that happened to
 * match a one-time seed — and the day a credit note needed account 6900 (Bad
 * Debt) the union could not express it, while the collection could not hold it
 * either. Measured 2026-08-01: the live Xero tenant has **140 accounts**; CFS
 * held 27, frozen since the 2025-11-29 bulk seed, and `readableCollections.ts`
 * described them as *"synced from Xero"* when nothing had ever synced them.
 *
 * So `code` is now a plain positive integer and **membership is a lookup in this
 * collection**, refreshed by `api-cloudrun/scripts/reconcile-chart-of-accounts.ts`.
 * That kills four of the five hand-maintained copies of the account list; the
 * fifth, `COA_REVENUE_CODES` in `schemas/common.ts`, is deliberately kept because it is a
 * *policy* subset (what a product or an invoice line may be coded to), not a
 * catalog.
 *
 * ## Why `code` stays an integer even though Xero's is a nullable string
 *
 * Of the 140 live accounts, **5 carry no `Code` at all** (all BANK — personal
 * cards and a dead account) and **one is non-numeric** (`2105-OLD`). Those six
 * are not mirrored. The boundary is structural rather than a judgment about
 * relevance: CFS references an account by numeric code everywhere it matters
 * (`String(coa_revenue)` becomes Xero's `AccountCode` on every pushed line), and
 * an account with no numeric code cannot be referenced by a document line at all.
 * Keeping `code` an int also keeps it usable as Typesense's
 * `default_sorting_field`.
 */
import { z } from "zod";
import { FirestoreId } from "./_uid.ts";
import { ActorRef, type ActorRefType, type FirestoreTimestampType, TimestampFields } from "./common.ts";

/**
 * Xero's `Type`, in prose form. Thirteen distinct values appear in the live
 * tenant; the four unobserved members are retained because Xero can emit them.
 */
const COA_TYPES = [
  "Bank",
  "Current Asset", "Fixed Asset", "Inventory", "Non-current Asset", "Prepayment",
  "Equity", "Depreciation", "Direct Costs", "Expense", "Overhead",
  "Current Liability", "Liability", "Non-current Liability",
  "Other Income", "Revenue", "Sales",
] as const;

/**
 * Xero's `Class` — the axis that says which side of a posting an account sits
 * on, and **the one CFS previously did not store at all**.
 *
 * `type` is presentation (Xero splits REVENUE class across `SALES`, `REVENUE`
 * and `OTHERINCOME`, which is why three prose types all mean "revenue"). `class`
 * is the machine axis: it is what decides whether an account is debited or
 * credited by a given event, and it is what a future double-entry ledger needs
 * in order to map an account at all. Deriving it from `type` would be a fifth
 * hand-maintained mapping.
 */
const COA_CLASSES = ["Asset", "Equity", "Expense", "Liability", "Revenue"] as const;

/** Xero's `Status`. Archived accounts are mirrored so historical documents still resolve. */
const COA_STATUSES = ["Active", "Archived"] as const;

/** Valid chart of accounts type values. */
export type COATypeType = typeof COA_TYPES[number];
/** Which side of a posting this account sits on. */
export type COAClassType = typeof COA_CLASSES[number];
/** Whether Xero still offers this account for new coding. */
export type COAStatusType = typeof COA_STATUSES[number];

/**
 * A chart-of-accounts code.
 *
 * No longer a closed union — see the module docstring. The catalog is the
 * `chart-of-accounts` collection, so an unknown code is caught by a lookup that
 * can actually be refreshed, not by a literal list that goes stale silently.
 */
export type COACodeType = number;

/** Zod schema for COACode. */
export const COACode: z.ZodType<COACodeType> = z.int().min(1).max(99999);
/** Zod schema for COAType. */
export const COAType: z.ZodType<COATypeType> = z.enum(COA_TYPES);
/** Zod schema for COAClass. */
export const COAClass: z.ZodType<COAClassType> = z.enum(COA_CLASSES);
/** Zod schema for COAStatus. */
export const COAStatus: z.ZodType<COAStatusType> = z.enum(COA_STATUSES);

/** A chart of accounts document in Firestore. */
export interface ChartOfAccounts {
  uid: string;
  code: COACodeType;
  name: string;
  type: COATypeType;
  /** REVENUE / EXPENSE / ASSET / LIABILITY / EQUITY — the posting-side axis. */
  class: COAClassType;
  /** `Archived` accounts stay mirrored so a historical line still resolves. */
  status: COAStatusType;
  /**
   * Xero's `AccountID`. The stable key.
   *
   * `code` is operator-editable in the Xero UI, and this codebase has already
   * paid for trusting a mutable Xero identifier: Xero frees an invoice *number*
   * when its holder is voided, which is why every invoice match keys on
   * `xero_id`. Same rule, same reason.
   */
  xero_id: string | null;
  description?: string;
  version: number;
  created_by: ActorRefType;
  updated_by: ActorRefType;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}

/** Zod schema for ChartOfAccounts. */
export const ChartOfAccountsSchema: z.ZodType<ChartOfAccounts> = z.strictObject({
  uid: FirestoreId,
  code: COACode.meta({ column: true, label: "Code" }),
  name: z.string().min(1).max(100).meta({ column: true, label: "Name" }),
  type: COAType.meta({ column: true, label: "Type" }),
  class: COAClass.meta({ column: true, label: "Class" }),
  status: COAStatus.meta({ column: true, label: "Status" }),
  xero_id: z.uuid().nullable(),
  description: z.string().optional(),
  // `default_tax_profile` was removed here (api-cloudrun#435). It had one
  // writer (`scripts/reconcile-chart-of-accounts.ts`) and **zero readers**, was
  // typed `z.string()` rather than an enum, and emitted a THIRD tax vocabulary
  // (`tax_chicago_rental_tax`…) that agreed with neither `TaxProfileEnum` nor
  // the live COA→tax map — including an outright disagreement on 4140.
  //
  // ⚠️ This object is strict, so the field must be gone from the STORED docs
  // before any writer touches one — an undeclared key fails the parse, the same
  // way a `roles/{name}` doc does. The stripper is
  // `api-cloudrun/scripts/cleanup-coa-default-tax-profile.ts`, and it runs in
  // the same sitting as the pin bump that takes this schema.
  version: z.int().min(0).default(0),
  created_by: ActorRef.meta({ column: true, label: "Created By" }),
  updated_by: ActorRef.meta({ column: true, label: "Updated By" }),
  ...TimestampFields,
}).meta({
  title: "Chart of Accounts",
  collection: "chart-of-accounts",
  displayDefaults: {
    columns: ["code", "name", "type", "class", "status"],
    filters: {},
    sort: { column: "code", direction: "asc" },
  },
});
