import { assertEquals } from "@std/assert";
import { InventoryLedgerSchema } from "../src/inventory-ledger.ts";

const validLedger = {
  uid: "test-il-1",
  uid_product: "test-prod-1",
  type: "rental",
  stock_method: "bulk",
  quantity_held: 20,
  quantity_in_service: 18,
  quantity_out_of_service: 2,
  average_unit_cost: 250.50,
  total_cost_basis: 5010,
  out_of_service_breakdown: {
    cleaning: 0,
    damaged: 1,
    maintenance: 1,
    lost: 0,
  },
  store_breakdown: [{
    uid_store: "test-store-1",
    name: "Main",
    default: true,
    crms_stock_level_id: null,
    quantity: 20,
    locations: [{
      uid_location: "test-loc-1",
      name: "Shelf A",
      quantity: 20,
      default: true,
      max: null,
    }],
  }],
  query_by_uid_store: ["test-store-1"],
  created_at: null,
  updated_at: null,
};

Deno.test("InventoryLedgerSchema validates a complete document", () => {
  assertEquals(InventoryLedgerSchema.safeParse(validLedger).success, true);
});

Deno.test("InventoryLedgerSchema rejects invalid type", () => {
  const doc = { ...validLedger, type: "invalid" };
  assertEquals(InventoryLedgerSchema.safeParse(doc).success, false);
});

Deno.test("InventoryLedgerSchema rejects invalid stock_method", () => {
  const doc = { ...validLedger, stock_method: "none" };
  assertEquals(InventoryLedgerSchema.safeParse(doc).success, false);
});

Deno.test("InventoryLedgerSchema accepts location with max value", () => {
  const doc = {
    ...validLedger,
    store_breakdown: [{
      ...validLedger.store_breakdown[0],
      locations: [{
        ...validLedger.store_breakdown[0].locations[0],
        max: 50,
      }],
    }],
  };
  assertEquals(InventoryLedgerSchema.safeParse(doc).success, true);
});

Deno.test("InventoryLedgerSchema accepts store with crms_stock_level_id", () => {
  const doc = {
    ...validLedger,
    store_breakdown: [{
      ...validLedger.store_breakdown[0],
      crms_stock_level_id: 789,
    }],
  };
  assertEquals(InventoryLedgerSchema.safeParse(doc).success, true);
});

Deno.test("InventoryLedgerSchema rejects additional properties", () => {
  const doc = { ...validLedger, bogus: true };
  assertEquals(InventoryLedgerSchema.safeParse(doc).success, false);
});
