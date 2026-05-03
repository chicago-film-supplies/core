import { assertEquals, assertNotEquals } from "@std/assert";
import {
  aggregates,
  rules,
  transactions,
  createOrderRules,
  updateOrderRules,
  createTransactionRules,
  createProductRules,
  updateProductRules,
  updateProductOrderRules,
  createOrganizationRules,
  updateOrganizationRules,
  createContactRules,
  updateContactRules,
  createUserRules,
  createUserTransaction,
  updateUserRules,
  updateUserTransaction,
  deleteUserRules,
  deleteUserTransaction,
  updateTagRules,
  deleteTagRules,
  updateTrackingCategoryRules,
  updateLocationTypeRules,
  updateLocationRules,
  createLocationRules,
  updateLocationTransactionalRules,
  createInvoiceRules,
  createInvoiceTransaction,
  updateInvoiceTransaction,
  updateInvoiceOrderRules,
  updateOrderInvoiceRules,
  updateTaxRules,
  createLocationTransaction,
  updateLocationTransaction,
  createOrderTransaction,
  updateOrderTransaction,
  createTransactionTransaction,
  updateTransactionRules,
  updateTransactionTransaction,
  createProductTransaction,
  updateProductTransaction,
  createOrganizationTransaction,
  updateOrganizationTransaction,
  createContactTransaction,
  updateContactTransaction,
  threadCowriteRules,
  createCommentRules,
  createCommentTransaction,
  createRoleTransaction,
  cardRules,
  createCardTransaction,
  deleteCardTransaction,
  recurrenceRules,
  createRecurrenceTransaction,
  materializeHorizonTransaction,
  updateRecurrenceTransaction,
  deleteRecurrenceTransaction,
  updateCardScopeFollowingTransaction,
  updateCardScopeAllTransaction,
  deleteCardScopeThisTransaction,
  deleteCardScopeFollowingTransaction,
  deleteCardScopeAllTransaction,
  updateBookingRules,
  updateBookingTransaction,
  bulkCheckoutOrderTransaction,
  bulkReturnOrderTransaction,
  createOutOfServiceRules,
  createOutOfServiceTransaction,
  updateOutOfServiceRules,
  updateOutOfServiceTransaction,
} from "../src/propagation/mod.ts";
import { schemas } from "../src/mod.ts";

// ── Rule integrity ───────────────────────────────────────────────

Deno.test("all rule IDs are unique", () => {
  const ids = rules.map((r) => r.id);
  const unique = new Set(ids);
  assertEquals(ids.length, unique.size, `Duplicate rule IDs: ${ids.filter((id, i) => ids.indexOf(id) !== i)}`);
});

Deno.test("rules array contains all individual rule sets", () => {
  const allRuleSets = [
    ...createOrderRules,
    ...updateOrderRules,
    ...createTransactionRules,
    ...updateTransactionRules,
    ...createProductRules,
    ...updateProductRules,
    ...updateProductOrderRules,
    ...createOrganizationRules,
    ...updateOrganizationRules,
    ...createContactRules,
    ...updateContactRules,
    ...createUserRules,
    ...updateUserRules,
    ...deleteUserRules,
    ...updateTaxRules,
    ...updateTagRules,
    ...deleteTagRules,
    ...updateTrackingCategoryRules,
    ...updateLocationTypeRules,
    ...createLocationRules,
    ...updateLocationTransactionalRules,
    ...updateLocationRules,
    ...createInvoiceRules,
    ...updateInvoiceOrderRules,
    ...updateOrderInvoiceRules,
    ...threadCowriteRules,
    ...createCommentRules,
    ...cardRules,
    ...recurrenceRules,
    ...updateBookingRules,
    ...createOutOfServiceRules,
    ...updateOutOfServiceRules,
  ];
  assertEquals(rules.length, allRuleSets.length);
  for (const rule of allRuleSets) {
    const found = rules.find((r) => r.id === rule.id);
    assertNotEquals(found, undefined, `Rule ${rule.id} missing from rules array`);
  }
});

Deno.test("every rule has at least one field mapping", () => {
  for (const rule of rules) {
    assertNotEquals(rule.fields.length, 0, `Rule ${rule.id} has no field mappings`);
  }
});

// ── Transaction integrity ────────────────────────────────────────

Deno.test("all transaction IDs are unique", () => {
  const ids = transactions.map((t) => t.id);
  const unique = new Set(ids);
  assertEquals(ids.length, unique.size);
});

Deno.test("transactions array contains all individual transactions", () => {
  const allTransactions = [
    createOrderTransaction,
    updateOrderTransaction,
    createTransactionTransaction,
    updateTransactionTransaction,
    createProductTransaction,
    updateProductTransaction,
    createOrganizationTransaction,
    updateOrganizationTransaction,
    createContactTransaction,
    updateContactTransaction,
    createUserTransaction,
    updateUserTransaction,
    deleteUserTransaction,
    createLocationTransaction,
    updateLocationTransaction,
    createInvoiceTransaction,
    updateInvoiceTransaction,
    createRoleTransaction,
    createCommentTransaction,
    createCardTransaction,
    deleteCardTransaction,
    createRecurrenceTransaction,
    materializeHorizonTransaction,
    updateRecurrenceTransaction,
    deleteRecurrenceTransaction,
    updateCardScopeFollowingTransaction,
    updateCardScopeAllTransaction,
    deleteCardScopeThisTransaction,
    deleteCardScopeFollowingTransaction,
    deleteCardScopeAllTransaction,
    updateBookingTransaction,
    bulkCheckoutOrderTransaction,
    bulkReturnOrderTransaction,
    createOutOfServiceTransaction,
    updateOutOfServiceTransaction,
  ];
  assertEquals(transactions.length, allTransactions.length);
  for (const txn of allTransactions) {
    const found = transactions.find((t) => t.id === txn.id);
    assertNotEquals(found, undefined, `Transaction ${txn.id} missing from transactions array`);
  }
});

Deno.test("every transaction step references an existing rule", () => {
  const ruleIds = new Set(rules.map((r) => r.id));
  for (const txn of transactions) {
    for (const step of txn.steps) {
      assertEquals(ruleIds.has(step), true, `Transaction ${txn.id} references unknown rule: ${step}`);
    }
  }
});

// ── Aggregate integrity ──────────────────────────────────────────

Deno.test("all aggregate IDs are unique", () => {
  const ids = aggregates.map((a) => a.id);
  const unique = new Set(ids);
  assertEquals(ids.length, unique.size);
});

Deno.test("aggregate root collections exist in schemas (when set)", () => {
  for (const agg of aggregates) {
    if (agg.root) {
      assertEquals(agg.root in schemas, true, `Aggregate ${agg.id} root "${agg.root}" not found in schemas`);
    }
  }
});

Deno.test("aggregate member collections exist in schemas", () => {
  for (const agg of aggregates) {
    for (const member of agg.members) {
      assertEquals(member in schemas, true, `Aggregate ${agg.id} member "${member}" not found in schemas`);
    }
  }
});
