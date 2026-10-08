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
  /**
   * Where a replay of this ledger's journal STARTS, when the ledger became
   * counted by a `stock_method` flip rather than by a movement
   * (api-cloudrun#1205 item 1; owner ruling 2026-10-07).
   *
   * A flip to a counted method seeds `quantity_held` (the units owned off any
   * shelf) and `out_of_service_breakdown` (the open records' away units) with
   * NO movement, because a flip changes what the ledger claims to know, not
   * where any unit is. A replay that starts at zero therefore cannot reach the
   * stored state, and reads every flipped product as diverged. This records the
   * seed so the replay can fold onto it instead.
   *
   * - **Stamped** by the counting flip, **cleared** (key absent) by the
   *   un-counting one, and carried unchanged by every movement.
   * - **Absent** on a ledger that was counted from its first movement, which is
   *   every ledger written before this field existed. Optional rather than
   *   nullable for that reason: the stored corpus has no key to state.
   * - 🔴 **The cut is `created_at`, not `date_fs`.** A movement's business date
   *   is operator-supplied and may be backdated, so a receipt recorded after the
   *   flip and dated before it would be dropped by a date cut. A replay folds
   *   exactly the movements whose `created_at` is after `at`.
   */
  counted_from?: InventoryLedgerCountedFrom;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}

/** The seed a counting flip stamps. See {@link InventoryLedger.counted_from}. */
export interface InventoryLedgerCountedFrom {
  /** When the flip ran — compared against each movement's `created_at`. */
  at: FirestoreTimestampType;
  /** `quantity_held` as the flip seeded it. */
  quantity_held: number;
  /** `out_of_service_breakdown` as the flip seeded it. */
  out_of_service_breakdown: InventoryLedger["out_of_service_breakdown"];
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
  // Absent on every ledger counted from its first movement — see the interface.
  counted_from: z.strictObject({
    at: FirestoreTimestamp,
    quantity_held: z.int().min(0),
    out_of_service_breakdown: z.strictObject({
      cleaning: z.int().min(0),
      damaged: z.int().min(0),
      maintenance: z.int().min(0),
      lost: z.int().min(0),
    }),
  }).optional(),
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
  // A marker records how a COUNTED ledger began; an uncounted one has no count
  // to have begun, so the un-counting flip must clear it.
  if (uncounted && ledger.counted_from !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["counted_from"],
      message: "an uncounted ledger (quantity_held: null) carries no counted_from marker",
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
