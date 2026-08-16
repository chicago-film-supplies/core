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
  createStoreRules,
  createStoreTransferRules,
  createStoreTransferTransaction,
  updateStoreRules,
  updateLocationRules,
  materializeHolidayDateRules,
  rematerializeHolidaySnapshotRules,
  recomputeHolidayDraftOrderRules,
  recomputeHolidayDraftInvoiceRules,
  createLocationRules,
  updateLocationTransactionalRules,
  createInvoiceRules,
  createCreditNoteRules,
  allocateCreditNoteRules,
  voidCreditNoteRules,
  createInvoiceTransaction,
  createCreditNoteTransaction,
  allocateCreditNoteTransaction,
  voidCreditNoteTransaction,
  updateInvoiceTransaction,
  updateInvoiceOrderRules,
  updateOrderInvoiceRules,
  createSettlementRules,
  createSettlementTransaction,
  reverseSettlementRules,
  reverseSettlementTransaction,
  syncXeroSettlementRules,
  syncXeroSettlementTransaction,
  voidInvoiceFromCrmsRules,
  voidInvoiceFromCrmsTransaction,
  voidInvoiceFromXeroRules,
  voidInvoiceFromXeroTransaction,
  crmsInvoiceUpsertTransaction,
  crmsOpportunityOrderTransaction,
  voidInvoiceRules,
  voidInvoiceTransaction,
  updateTaxRules,
  createLocationTransaction,
  updateLocationTransaction,
  createOrderTransaction,
  updateOrderTransaction,
  createTransactionTransaction,
  reverseTransactionRules,
  reverseTransactionTransaction,
  createProductTransaction,
  updateProductTransaction,
  createOrganizationTransaction,
  updateOrganizationTransaction,
  createContactTransaction,
  updateContactTransaction,
  threadCowriteRules,
  createCommentRules,
  createCommentTransaction,
  deleteCommentRules,
  deleteCommentTransaction,
  crmsMemberOrganizationTransaction,
  crmsMemberContactTransaction,
  createHolidayDefinitionTransaction,
  updateHolidayDefinitionTransaction,
  deleteHolidayDefinitionTransaction,
  createRoleTransaction,
  cardRules,
  createCardTransaction,
  deleteCardTransaction,
  templateRules,
  createTemplateTransaction,
  manageDraftTransaction,
  publishTemplateTransaction,
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
  bulkFulfillmentBookingsTransaction,
  finalizeOrderTransaction,
  processOrderDocsRules,
  processOrderDocsTransaction,
  createOutOfServiceRules,
  createOutOfServiceTransaction,
  updateOutOfServiceRules,
  updateOutOfServiceTransaction,
  updateFulfillmentItemsRules,
  updateFulfillmentItemsTransaction,
  uploadcareWorkListRules,
} from "../src/schemas/propagation/mod.ts";
import { schemas } from "../src/schemas/mod.ts";

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
    ...reverseTransactionRules,
    ...createStoreTransferRules,
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
    ...createStoreRules,
    ...updateStoreRules,
    ...materializeHolidayDateRules,
    ...rematerializeHolidaySnapshotRules,
    ...recomputeHolidayDraftOrderRules,
    ...recomputeHolidayDraftInvoiceRules,
    ...createLocationRules,
    ...updateLocationTransactionalRules,
    ...updateLocationRules,
    ...createInvoiceRules,
    ...updateInvoiceOrderRules,
    ...updateOrderInvoiceRules,
    ...createSettlementRules,
    ...reverseSettlementRules,
    ...syncXeroSettlementRules,
    ...voidInvoiceRules,
    ...voidInvoiceFromCrmsRules,
    ...voidInvoiceFromXeroRules,
    ...createCreditNoteRules,
    ...allocateCreditNoteRules,
    ...voidCreditNoteRules,
    ...threadCowriteRules,
    ...createCommentRules,
    ...deleteCommentRules,
    ...cardRules,
    ...templateRules,
    ...recurrenceRules,
    ...updateBookingRules,
    ...processOrderDocsRules,
    ...createOutOfServiceRules,
    ...updateOutOfServiceRules,
    ...updateFulfillmentItemsRules,
    ...uploadcareWorkListRules,
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
    reverseTransactionTransaction,
    createStoreTransferTransaction,
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
    createSettlementTransaction,
    reverseSettlementTransaction,
    syncXeroSettlementTransaction,
    voidInvoiceTransaction,
    voidInvoiceFromCrmsTransaction,
    voidInvoiceFromXeroTransaction,
  crmsInvoiceUpsertTransaction,
  crmsOpportunityOrderTransaction,
    crmsMemberOrganizationTransaction,
    crmsMemberContactTransaction,
    createCreditNoteTransaction,
    allocateCreditNoteTransaction,
    voidCreditNoteTransaction,
    createRoleTransaction,
    createCommentTransaction,
    deleteCommentTransaction,
    createHolidayDefinitionTransaction,
    updateHolidayDefinitionTransaction,
    deleteHolidayDefinitionTransaction,
    createCardTransaction,
    deleteCardTransaction,
    createTemplateTransaction,
    manageDraftTransaction,
    publishTemplateTransaction,
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
    bulkFulfillmentBookingsTransaction,
    finalizeOrderTransaction,
    processOrderDocsTransaction,
    createOutOfServiceTransaction,
    updateOutOfServiceTransaction,
    updateFulfillmentItemsTransaction,
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

// ── enforced_by integrity ────────────────────────────────────────
//
// `enforced_by` is a CLAIM about what checks a rule's `invariant`, and it is
// rendered into `/openapi.json` for API consumers. A wrong entry converts an
// honest "unverified" into a false "verified" and publishes it, which is worse
// than the absent field it replaced. These are the properties that can be
// checked without leaving this package.

Deno.test("enforced_by only appears on rules that state an invariant", () => {
  for (const rule of rules) {
    if (!rule.enforced_by) continue;
    assertNotEquals(
      rule.invariant,
      undefined,
      `Rule ${rule.id} names its enforcement but states no invariant — ` +
        `there is nothing for the pointer to be enforcing.`,
    );
  }
});

Deno.test("every enforced_by ref is a repo-relative path", () => {
  // A bare filename cannot be resolved from another repo, and this field is
  // read by humans in four of them.
  const shape = /^[a-z0-9-]+\/[A-Za-z0-9_./-]+\.(ts|tsx|json|ya?ml)(:\d+)?$/;
  for (const rule of rules) {
    for (const ref of rule.enforced_by ?? []) {
      assertEquals(
        shape.test(ref.ref),
        true,
        `Rule ${rule.id}: enforced_by ref "${ref.ref}" is not a repo-relative path ` +
          `(expected e.g. "api-cloudrun/scripts/audit-x.ts:42").`,
      );
    }
  }
});

Deno.test("a non-gating enforced_by entry must say why it does not gate", () => {
  // `gates: false` means the pointer CANNOT fail today — a vacuous corpus, an
  // audit that always exits 0, a writer-path test with no corpus detector.
  // Recording that without saying which is how a known-inert pointer reads as a
  // deliberate one six months later.
  for (const rule of rules) {
    for (const ref of rule.enforced_by ?? []) {
      if (ref.gates) continue;
      assertNotEquals(
        ref.clause,
        undefined,
        `Rule ${rule.id}: enforced_by "${ref.ref}" is marked gates:false with no clause. ` +
          `A pointer that cannot fail must record why, or it reads as verification.`,
      );
    }
  }
});

Deno.test("no rule lists the same (ref, clause) pair twice", () => {
  // Two entries sharing a `ref` are legitimate — one audit can cover two
  // distinct clauses — so the identity is the pair, not the path.
  for (const rule of rules) {
    const seen = new Set<string>();
    for (const ref of rule.enforced_by ?? []) {
      const key = `${ref.ref}|${ref.clause ?? ""}`;
      assertEquals(
        seen.has(key),
        false,
        `Rule ${rule.id} lists ${ref.ref} twice for the same clause.`,
      );
      seen.add(key);
    }
  }
});

Deno.test("the enforced_by field is actually populated (non-vacuity)", () => {
  // Every assertion above is vacuously true over an empty field. This one fails
  // if the triage is reverted or the field is dropped, so the four guards above
  // cannot silently stop testing anything.
  const withEnforcement = rules.filter((r) => (r.enforced_by?.length ?? 0) > 0);
  assertEquals(
    withEnforcement.length > 0,
    true,
    "No rule carries enforced_by — the guards above are testing nothing.",
  );
});
