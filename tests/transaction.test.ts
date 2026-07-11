import { assertEquals, assertThrows } from "@std/assert";
import { getInitialValues } from "../src/schemas/initial.ts";
import { CreateTransactionInput, TransactionSchema, getTransactionMultiplier } from "../src/schemas/transaction.ts";
import { mockTimestamp } from "./helpers/timestamp.ts";

const transactionBase = getInitialValues(TransactionSchema) as Record<string, unknown>;

const validTransaction = {
  ...transactionBase,
  uid: "testtxn1000000000000",
  uid_product: "testprod100000000000",
  type: "purchase",
  quantity: 10,
  total_cost: 2500,
  unit_cost: 250,
  unit_costs: [250],
  date: "2026-03-01T00:00:00Z",
  date_fs: mockTimestamp,
  reference: "PO-001",
  source: { type: "manual", number: null, uid: null },
  serialized_details: null,
  created_at: mockTimestamp,
  updated_at: mockTimestamp,
};

Deno.test("TransactionSchema validates a complete document", () => {
  assertEquals(TransactionSchema.safeParse(validTransaction).success, true);
});

Deno.test("TransactionSchema validates all transaction types", () => {
  const types = [
    "purchase", "find", "make", "opening_balance", "adjustment_increase",
    "sale", "write_off", "trade_in", "adjustment_decrease",
    "transfer_increase", "transfer_decrease",
    "acquisition", "disposal", "partial_disposal",
    "depreciation_tax", "depreciation_gaap",
  ];
  for (const type of types) {
    const doc = { ...validTransaction, type };
    assertEquals(TransactionSchema.safeParse(doc).success, true, `type "${type}" should be valid`);
  }
});

Deno.test("TransactionSchema rejects invalid type", () => {
  const doc = { ...validTransaction, type: "invalid" };
  assertEquals(TransactionSchema.safeParse(doc).success, false);
});

Deno.test("TransactionSchema validates with source", () => {
  const doc = {
    ...validTransaction,
    source: { type: "order", number: 1001, uid: "testorder10000000000" },
  };
  assertEquals(TransactionSchema.safeParse(doc).success, true);
});

Deno.test("TransactionSchema validates with stores", () => {
  const doc = {
    ...validTransaction,
    stores: [{
      uid_store: "teststore10000000000",
      name: "Main",
      default: true,
      quantity: 10,
      locations: [{
        uid_location: "testloc1000000000000",
        name: "Shelf A",
        quantity: 20,
        transactionQuantity: 10,
        default: true,
        max: null,
      }],
    }],
  };
  assertEquals(TransactionSchema.safeParse(doc).success, true);
});

Deno.test("TransactionSchema validates with serialized_details", () => {
  const doc = {
    ...validTransaction,
    serialized_details: {
      asset_tags: ["AT-001", "AT-002"],
      serial_numbers: ["SN-001"],
    },
  };
  assertEquals(TransactionSchema.safeParse(doc).success, true);
});

Deno.test("TransactionSchema validates with crms_sync", () => {
  const doc = {
    ...validTransaction,
    crms_sync: {
      "teststore10000000000": { stock_level_id: 100, transaction_id: 200 },
    },
  };
  assertEquals(TransactionSchema.safeParse(doc).success, true);
});

Deno.test("TransactionSchema rejects additional properties", () => {
  const doc = { ...validTransaction, bogus: true };
  assertEquals(TransactionSchema.safeParse(doc).success, false);
});

// ── #287: a store may not list the same location twice ────────────

const twoLocationStore = (locA: string, locB: string) => ({
  uid_store: "teststore10000000000",
  name: "Main",
  default: true,
  quantity: 10,
  locations: [
    { uid_location: locA, name: "Shelf A", quantity: 20, transactionQuantity: 5, default: true, max: null },
    { uid_location: locB, name: "Shelf B", quantity: 20, transactionQuantity: 5, default: false, max: null },
  ],
});

Deno.test("TransactionSchema rejects a duplicate uid_location within one store (#287)", () => {
  const doc = { ...validTransaction, stores: [twoLocationStore("testloc1000000000000", "testloc1000000000000")] };
  assertEquals(TransactionSchema.safeParse(doc).success, false);
});

Deno.test("TransactionSchema allows two DIFFERENT uid_locations in one store", () => {
  const doc = { ...validTransaction, stores: [twoLocationStore("testloc1000000000000", "testloc2000000000000")] };
  assertEquals(TransactionSchema.safeParse(doc).success, true);
});

const createInputStore = (locA: string, locB: string) => ({
  uid_store: "teststore10000000000",
  name: "Main",
  default: true,
  quantity: 10,
  locations: [
    { uid_location: locA, name: "Shelf A", transactionQuantity: 5, default: true, max: null },
    { uid_location: locB, name: "Shelf B", transactionQuantity: 5, default: false, max: null },
  ],
});

const validCreateInput = {
  uid: "testtxn1000000000000",
  uid_product: "testprod100000000000",
  type: "purchase",
  quantity: 10,
  total_cost: 2500,
  date: "2026-03-01T00:00:00Z",
  reference: "PO-001",
};

Deno.test("CreateTransactionInput rejects a duplicate uid_location within one store (#287)", () => {
  const input = { ...validCreateInput, stores: [createInputStore("testloc1000000000000", "testloc1000000000000")] };
  assertEquals(CreateTransactionInput.safeParse(input).success, false);
});

Deno.test("CreateTransactionInput accepts distinct uid_locations in one store", () => {
  const input = { ...validCreateInput, stores: [createInputStore("testloc1000000000000", "testloc2000000000000")] };
  assertEquals(CreateTransactionInput.safeParse(input).success, true);
});

// getTransactionMultiplier tests

Deno.test("getTransactionMultiplier returns 1 for increase types", () => {
  const increaseTypes = [
    "purchase", "make", "find", "opening_balance",
    "adjustment_increase", "transfer_increase",
  ] as const;
  for (const type of increaseTypes) {
    assertEquals(getTransactionMultiplier(type), 1, `${type} should return 1`);
  }
});

Deno.test("getTransactionMultiplier returns -1 for decrease types", () => {
  const decreaseTypes = [
    "sale", "trade_in", "write_off",
    "adjustment_decrease", "transfer_decrease",
  ] as const;
  for (const type of decreaseTypes) {
    assertEquals(getTransactionMultiplier(type), -1, `${type} should return -1`);
  }
});

Deno.test("getTransactionMultiplier throws for financial-only types", () => {
  const financialTypes = [
    "acquisition", "disposal", "partial_disposal",
    "depreciation_tax", "depreciation_gaap",
  ] as const;
  for (const type of financialTypes) {
    assertThrows(() => getTransactionMultiplier(type), Error);
  }
});
