/**
 * The purchase action vocabulary — what an operator may DO to a purchase, one
 * of its lines, a bill or a supplier credit. The twin of
 * `schemas/invoice-action.ts`, built for the same reason: the manager and the
 * API decided these separately and had drifted (`closable` offered a close the
 * API refuses, `billMax` a bill it answers `nothing_to_bill`).
 *
 * The offers live in `@cfs/core/utils/purchase-actions`, which returns only ids
 * from this list.
 *
 * Ids follow the invoice convention: a bare verb acts on the subject itself;
 * `verb_object` acts on something else.
 *
 * @module
 */
import { z } from "zod";

/**
 * Every purchase action id. `tests/purchase-actions.test.ts` asserts it equals
 * {@link PURCHASE_ACTIONS}' keys in both directions.
 */
export const PURCHASE_ACTION_IDS = [
  // on a purchase
  "close",
  "add_bill",
  "add_credit",
  // on one of its lines
  "close_item",
  "bill_item",
  "remove_item",
  "change_basis",
  // on a bill
  "allocate_credit",
  "void_bill",
  "push_to_xero",
  // on a supplier credit
  "void_credit",
] as const;

/** One purchase action id. */
export type PurchaseActionId = typeof PURCHASE_ACTION_IDS[number];
/** Zod schema for {@link PurchaseActionId}. */
export const PurchaseActionIdEnum: z.ZodType<PurchaseActionId> = z.enum(PURCHASE_ACTION_IDS);

/** What an action acts on — and so which offer function lists it. */
export type PurchaseActionSubject = "purchase" | "purchase_item" | "purchase_bill" | "purchase_credit";

/** One row of {@link PURCHASE_ACTIONS}. */
export interface PurchaseActionDefinition {
  subject: PurchaseActionSubject;
  /** One line, for a tooltip or a log. */
  description: string;
}

/**
 * Every action, keyed by id. `Readonly<Record<PurchaseActionId, …>>` makes an id
 * with no row a type error; the both-ways test makes a row with no id one.
 */
export const PURCHASE_ACTIONS: Readonly<Record<PurchaseActionId, PurchaseActionDefinition>> = {
  close: { subject: "purchase", description: "Close every open line; refused while sub-rented units are out." },
  add_bill: { subject: "purchase", description: "Bill the purchase, including a charge nobody expected." },
  add_credit: { subject: "purchase", description: "Record a supplier credit against what was billed." },
  close_item: { subject: "purchase_item", description: "Close one open line." },
  bill_item: { subject: "purchase_item", description: "Bill a line that still has something to bill." },
  remove_item: { subject: "purchase_item", description: "Remove a line with no history." },
  change_basis: { subject: "purchase_item", description: "Move a line with no history between flat and time." },
  allocate_credit: { subject: "purchase_bill", description: "Spend supplier credit on a live bill with money due." },
  void_bill: { subject: "purchase_bill", description: "Void a pushed bill nothing has settled." },
  push_to_xero: { subject: "purchase_bill", description: "Ask for a bill Xero is behind on to be pushed again." },
  void_credit: { subject: "purchase_credit", description: "Void a credit nothing has drawn on." },
};
