import { assertEquals } from "@std/assert";
import { InventoryLedgerSchema } from "../src/schemas/inventory-ledger.ts";
import { mockTimestamp } from "./helpers/timestamp.ts";

const validLedger = {
  uid: "testil10000000000000",
  uid_product: "testprod100000000000",
  type: "rental",
  stock_method: "bulk",
  quantity_held: 20,
  quantity_in_service: 18,
  quantity_out_of_service: 2,
  average_unit_cost: 250.50,
  total_cost_basis_cents: 501000,
  out_of_service_breakdown: {
    cleaning: 0,
    damaged: 1,
    maintenance: 1,
    lost: 0,
  },
  store_breakdown: [{
    uid_store: "teststore10000000000",
    name: "Main",
    default: true,
    crms_stock_level_id: null,
    quantity: 20,
    locations: [{
      uid_location: "testloc1000000000000",
      name: "Shelf A",
      quantity: 20,
      default: true,
      max: null,
    }],
  }],
  query_by_uid_store: ["teststore10000000000"],
  query_by_uid_location: ["testloc1000000000000"],
  created_at: mockTimestamp,
  updated_at: mockTimestamp,
};

Deno.test("InventoryLedgerSchema validates a complete document", () => {
  assertEquals(InventoryLedgerSchema.safeParse(validLedger).success, true);
});

Deno.test("InventoryLedgerSchema rejects invalid type", () => {
  const doc = { ...validLedger, type: "invalid" };
  assertEquals(InventoryLedgerSchema.safeParse(doc).success, false);
});

Deno.test("InventoryLedgerSchema rejects invalid stock_method", () => {
  // Not `none`: that is a member now (the uncounted ledger), so a `none` here
  // would fail on the uncounted refine instead and prove nothing about the enum.
  const doc = { ...validLedger, stock_method: "consignment" };
  assertEquals(InventoryLedgerSchema.safeParse(doc).success, false);
});

// ── The uncounted ledger (`quantity_held: null`) ──

const uncountedLedger = {
  ...validLedger,
  stock_method: "none",
  quantity_held: null,
  quantity_in_service: null,
  quantity_out_of_service: 0,
  out_of_service_breakdown: { cleaning: 0, damaged: 0, maintenance: 0, lost: 0 },
  average_unit_cost: 0,
  total_cost_basis_cents: 0,
  store_breakdown: [],
  query_by_uid_store: [],
  query_by_uid_location: [],
};

Deno.test("InventoryLedgerSchema accepts an uncounted ledger", () => {
  assertEquals(InventoryLedgerSchema.safeParse(uncountedLedger).success, true);
  // Out-of-service is still counted on one: a lost uncounted unit is real.
  assertEquals(
    InventoryLedgerSchema.safeParse({
      ...uncountedLedger,
      quantity_out_of_service: 2,
      out_of_service_breakdown: { cleaning: 0, damaged: 0, maintenance: 0, lost: 2 },
    }).success,
    true,
  );
});

Deno.test("InventoryLedgerSchema: null held and stock_method none are ONE fact", () => {
  // null held on a counted method — a serialized roster with no count to match.
  for (const stock_method of ["bulk", "serialized"]) {
    assertEquals(InventoryLedgerSchema.safeParse({ ...uncountedLedger, stock_method }).success, false, stock_method);
  }
  // a count on a `none` ledger — the estimate the owner ruled out.
  assertEquals(
    InventoryLedgerSchema.safeParse({ ...uncountedLedger, quantity_held: 0, quantity_in_service: 0 }).success,
    false,
    "0 is a count, and null is not 0",
  );
});

Deno.test("InventoryLedgerSchema: quantity_in_service is null exactly when quantity_held is", () => {
  assertEquals(InventoryLedgerSchema.safeParse({ ...uncountedLedger, quantity_in_service: 0 }).success, false);
  assertEquals(InventoryLedgerSchema.safeParse({ ...validLedger, quantity_in_service: null }).success, false);
});

Deno.test("InventoryLedgerSchema: an uncounted ledger has no shelves and no basis", () => {
  assertEquals(
    InventoryLedgerSchema.safeParse({ ...uncountedLedger, store_breakdown: validLedger.store_breakdown }).success,
    false,
    "shelves",
  );
  assertEquals(InventoryLedgerSchema.safeParse({ ...uncountedLedger, total_cost_basis_cents: 100 }).success, false, "basis");
  assertEquals(InventoryLedgerSchema.safeParse({ ...uncountedLedger, average_unit_cost: 1.5 }).success, false, "average");
});

Deno.test("InventoryLedgerSchema: a COUNTED ledger may have no shelves (everything out)", () => {
  // The shelf refine is one-directional on purpose — the plan's first sketch had
  // it as ⟺, which would have refused every product with all its units on jobs.
  assertEquals(
    InventoryLedgerSchema.safeParse({
      ...validLedger,
      store_breakdown: [],
      query_by_uid_store: [],
      query_by_uid_location: [],
    }).success,
    true,
  );
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
