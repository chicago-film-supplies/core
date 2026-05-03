import { assertEquals, assertThrows } from "@std/assert";
import { getInitialValues } from "../src/initial.ts";
import { TransactionSchema, getTransactionMultiplier } from "../src/transaction.ts";

const transactionBase = getInitialValues(TransactionSchema) as Record<string, unknown>;

const validTransaction = {
  ...transactionBase,
  uid: "test-txn-1",
  uid_product: "test-prod-1",
  type: "purchase",
  quantity: 10,
  total_cost: 2500,
  unit_cost: 250,
  unit_costs: [250],
  date: "2026-03-01T00:00:00Z",
  date_fs: null,
  reference: "PO-001",
  source: { type: "manual", number: null, uid: null },
  serialized_details: null,
  created_at: null,
  updated_at: null,
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
    source: { type: "order", number: 1001, uid: "test-order-1" },
  };
  assertEquals(TransactionSchema.safeParse(doc).success, true);
});

Deno.test("TransactionSchema validates with stores", () => {
  const doc = {
    ...validTransaction,
    stores: [{
      uid_store: "test-store-1",
      name: "Main",
      default: true,
      quantity: 10,
      locations: [{
        uid_location: "test-loc-1",
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
      "test-store-1": { stock_level_id: 100, transaction_id: 200 },
    },
  };
  assertEquals(TransactionSchema.safeParse(doc).success, true);
});

Deno.test("TransactionSchema rejects additional properties", () => {
  const doc = { ...validTransaction, bogus: true };
  assertEquals(TransactionSchema.safeParse(doc).success, false);
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
