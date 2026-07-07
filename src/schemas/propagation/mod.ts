/**
 * Propagation rules — documents how data flows between Firestore collections.
 *
 * Re-exports types, aggregate definitions, and all concrete rules.
 * The doc generator imports `rules`, `transactions`, and `aggregates` from here.
 */

// ── Types ────────────────────────────────────────────────────────────

export type {
  FieldPath,
  PropagationMode,
  FieldMapping,
  CollectionRule,
  TransactionDefinition,
  AggregateDefinition,
} from "./types.ts";

// ── Aggregates ───────────────────────────────────────────────────────

export { aggregates } from "./aggregates.ts";

// ── Order rules ──────────────────────────────────────────────────────

export {
  createOrderRules,
  createOrderTransaction,
  updateOrderRules,
  updateOrderTransaction,
  updateBookingRules,
  updateBookingTransaction,
  bulkCheckoutOrderTransaction,
  bulkReturnOrderTransaction,
  bulkFulfillmentBookingsTransaction,
  processOrderDocsRules,
  processOrderDocsTransaction,
} from "./orders.ts";

// ── Out-of-service rules ─────────────────────────────────────────────

export {
  createOutOfServiceRules,
  createOutOfServiceTransaction,
  updateOutOfServiceRules,
  updateOutOfServiceTransaction,
} from "./out-of-service.ts";

// ── Transaction rules ────────────────────────────────────────────────

export {
  createTransactionRules,
  createTransactionTransaction,
  updateTransactionRules,
  updateTransactionTransaction,
} from "./transactions.ts";

// ── Product rules ────────────────────────────────────────────────────

export {
  createProductRules,
  createProductTransaction,
  updateProductRules,
  updateProductOrderRules,
  updateProductTransaction,
} from "./products.ts";

// ── Organization rules ───────────────────────────────────────────────

export {
  createOrganizationRules,
  createOrganizationTransaction,
  updateOrganizationRules,
  updateOrganizationTransaction,
} from "./organizations.ts";

// ── Contact rules ────────────────────────────────────────────────────

export {
  createContactRules,
  createContactTransaction,
  updateContactRules,
  updateContactTransaction,
} from "./contacts.ts";

// ── User rules ───────────────────────────────────────────────────────

export {
  createUserRules,
  createUserTransaction,
  updateUserRules,
  updateUserTransaction,
  deleteUserRules,
  deleteUserTransaction,
} from "./users.ts";

// ── Invoice rules ───────────────────────────────────────────────────

export {
  createInvoiceRules,
  createInvoiceTransaction,
  updateInvoiceOrderRules,
  updateInvoiceTransaction,
  updateOrderInvoiceRules,
} from "./invoices.ts";

// ── Fulfillment rules ───────────────────────────────────────────────

export {
  updateFulfillmentItemsRules,
  updateFulfillmentItemsTransaction,
} from "./fulfillments.ts";

// ── Location rules ──────────────────────────────────────────────────

export {
  createLocationRules,
  createLocationTransaction,
  updateLocationTransactionalRules,
  updateLocationTransaction,
} from "./locations.ts";

// ── Tax rules ───────────────────────────────────────────────────────

export { updateTaxRules } from "./taxes.ts";

// ── Reference data rules ─────────────────────────────────────────────

export {
  updateTagRules,
  deleteTagRules,
  updateTrackingCategoryRules,
  updateLocationTypeRules,
  updateLocationRules,
  rematerializeHolidaySnapshotRules,
  recomputeHolidayDraftOrderRules,
  recomputeHolidayDraftInvoiceRules,
} from "./reference-data.ts";

// ── Store rules ──────────────────────────────────────────────────────

export { createStoreRules, updateStoreRules } from "./stores.ts";

// ── Threads & comments rules ─────────────────────────────────────────

export {
  threadCowriteRules,
  threadOrderRules,
  threadInvoiceRules,
  threadContactRules,
  threadOrganizationRules,
  threadProductRules,
  threadTransactionRules,
  threadRoleRules,
  threadOutOfServiceRules,
  createRoleTransaction,
  createCommentRules,
  createCommentTransaction,
} from "./threads.ts";

// ── Cards rules ──────────────────────────────────────────────────────

export {
  cardRules,
  createCardRules,
  createCardTransaction,
  deleteCardRules,
  deleteCardTransaction,
} from "./cards.ts";

// ── Template (git-canonical) rules ───────────────────────────────────

export {
  templateRules,
  createTemplateRules,
  createTemplateTransaction,
  manageDraftRules,
  manageDraftTransaction,
  publishTemplateRules,
  publishTemplateTransaction,
} from "./templates.ts";

// ── Recurrences rules ────────────────────────────────────────────────

export {
  recurrenceRules,
  createRecurrenceRules,
  createRecurrenceTransaction,
  materializeHorizonRules,
  materializeHorizonTransaction,
  updateRecurrenceRules,
  updateRecurrenceTransaction,
  deleteRecurrenceRules,
  deleteRecurrenceTransaction,
  updateCardScopeFollowingRules,
  updateCardScopeFollowingTransaction,
  updateCardScopeAllRules,
  updateCardScopeAllTransaction,
  deleteCardScopeThisRules,
  deleteCardScopeThisTransaction,
  deleteCardScopeFollowingRules,
  deleteCardScopeFollowingTransaction,
  deleteCardScopeAllRules,
  deleteCardScopeAllTransaction,
} from "./recurrences.ts";

// ── Convenience arrays ───────────────────────────────────────────────

import type { CollectionRule, TransactionDefinition } from "./types.ts";

import {
  createOrderRules,
  createOrderTransaction,
  updateOrderRules,
  updateOrderTransaction,
  updateBookingRules,
  updateBookingTransaction,
  bulkCheckoutOrderTransaction,
  bulkReturnOrderTransaction,
  bulkFulfillmentBookingsTransaction,
  processOrderDocsRules,
  processOrderDocsTransaction,
} from "./orders.ts";
import {
  createOutOfServiceRules,
  createOutOfServiceTransaction,
  updateOutOfServiceRules,
  updateOutOfServiceTransaction,
} from "./out-of-service.ts";
import { createTransactionRules, createTransactionTransaction, updateTransactionRules, updateTransactionTransaction } from "./transactions.ts";
import { createProductRules, createProductTransaction, updateProductRules, updateProductOrderRules, updateProductTransaction } from "./products.ts";
import { createOrganizationRules, createOrganizationTransaction, updateOrganizationRules, updateOrganizationTransaction } from "./organizations.ts";
import { createContactRules, createContactTransaction, updateContactRules, updateContactTransaction } from "./contacts.ts";
import { createUserRules, createUserTransaction, updateUserRules, updateUserTransaction, deleteUserRules, deleteUserTransaction } from "./users.ts";
import { createLocationRules, createLocationTransaction, updateLocationTransactionalRules, updateLocationTransaction } from "./locations.ts";
import { createInvoiceRules, createInvoiceTransaction, updateInvoiceOrderRules, updateInvoiceTransaction, updateOrderInvoiceRules } from "./invoices.ts";
import { updateFulfillmentItemsRules, updateFulfillmentItemsTransaction } from "./fulfillments.ts";
import { updateTaxRules } from "./taxes.ts";
import { updateTagRules, deleteTagRules, updateTrackingCategoryRules, updateLocationTypeRules, updateLocationRules, rematerializeHolidaySnapshotRules, recomputeHolidayDraftOrderRules, recomputeHolidayDraftInvoiceRules } from "./reference-data.ts";
import { createStoreRules, updateStoreRules } from "./stores.ts";
import {
  threadCowriteRules,
  createCommentRules,
  createCommentTransaction,
  createRoleTransaction,
} from "./threads.ts";
import {
  cardRules,
  createCardTransaction,
  deleteCardTransaction,
} from "./cards.ts";
import {
  templateRules,
  createTemplateTransaction,
  manageDraftTransaction,
  publishTemplateTransaction,
} from "./templates.ts";
import {
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
} from "./recurrences.ts";

export const transactions: TransactionDefinition[] = [
  createOrderTransaction,
  updateOrderTransaction,
  updateBookingTransaction,
  bulkCheckoutOrderTransaction,
  bulkReturnOrderTransaction,
  bulkFulfillmentBookingsTransaction,
  processOrderDocsTransaction,
  createOutOfServiceTransaction,
  updateOutOfServiceTransaction,
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
  updateFulfillmentItemsTransaction,
  createRoleTransaction,
  createCommentTransaction,
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
];

/** All propagation rules across all transactions and cascades. */
export const rules: CollectionRule[] = [
  ...createOrderRules,
  ...updateOrderRules,
  ...updateBookingRules,
  ...processOrderDocsRules,
  ...createOutOfServiceRules,
  ...updateOutOfServiceRules,
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
  ...createInvoiceRules,
  ...updateInvoiceOrderRules,
  ...updateOrderInvoiceRules,
  ...updateFulfillmentItemsRules,
  ...updateTaxRules,
  ...updateTagRules,
  ...deleteTagRules,
  ...updateTrackingCategoryRules,
  ...updateLocationTypeRules,
  ...createStoreRules,
  ...updateStoreRules,
  ...createLocationRules,
  ...updateLocationTransactionalRules,
  ...updateLocationRules,
  ...rematerializeHolidaySnapshotRules,
  ...recomputeHolidayDraftOrderRules,
  ...recomputeHolidayDraftInvoiceRules,
  ...threadCowriteRules,
  ...createCommentRules,
  ...cardRules,
  ...templateRules,
  ...recurrenceRules,
];
