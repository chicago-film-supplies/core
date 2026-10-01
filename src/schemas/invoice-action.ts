/**
 * The invoice action vocabulary — what an operator may DO to an invoice, a
 * credit note, or an order's invoicing (api-cloudrun#1169, R3).
 *
 * The manager and the API used to decide these separately, and they had
 * drifted on eight actions (D1–D8 in api-cloudrun's invoice-actions plan): the
 * API accepted a payment on a `paid` invoice the manager hid, the manager
 * offered a credit-note void the API refused. Both now draw from ONE ruleset,
 * `@cfs/core/utils/invoice-actions`, whose functions offer only ids from this
 * list — the same shape `CUSTODY_RULE_IDS` gives custody.
 *
 * Ids follow one convention: a bare verb acts on the subject itself (`issue`,
 * `void`, `close`); `verb_object` acts on something else (`add_payment`,
 * `void_credit_note`). There are no `_undo` ids — undoing a payment or a
 * closure is `reverse_settlement` on its row.
 *
 * Tables live here and functions in `utils/`, so the vocabulary is importable
 * without the ruleset. Descriptions are kept to one line on purpose: this
 * module ships in the manager's bundle.
 *
 * @module
 */
import { z } from "zod";

/**
 * Every invoice action id. `tests/invoice-actions.test.ts` asserts it equals
 * {@link INVOICE_ACTIONS}' keys in both directions, and the manager
 * de-duplicates its menus by these ids, never by a label.
 */
export const INVOICE_ACTION_IDS = [
  // on an invoice
  "issue",
  "void",
  "close",
  "add_payment",
  "reverse_settlement",
  "add_credit_note",
  "edit_items",
  "edit_organization",
  "edit_date",
  // on a credit note
  "void_credit_note",
  "allocate_credit_note",
  // on an order
  "create_invoice",
  "create_remaining_invoice",
  "create_replacement_invoice",
  "credit_overbilling",
] as const;

/** One invoice action id. */
export type InvoiceActionId = typeof INVOICE_ACTION_IDS[number];
/** Zod schema for {@link InvoiceActionId}. */
export const InvoiceActionIdEnum: z.ZodType<InvoiceActionId> = z.enum(INVOICE_ACTION_IDS);

/** Which document an action acts on — and so which offer function lists it. */
export type InvoiceActionSubject = "invoice" | "credit_note" | "order";

/** One row of {@link INVOICE_ACTIONS}. */
export interface InvoiceActionDefinition {
  subject: InvoiceActionSubject;
  /** One line, for a tooltip or a log. */
  description: string;
}

/**
 * Every action, keyed by id. `Readonly<Record<InvoiceActionId, …>>` makes an id
 * with no row a type error; the both-ways test makes a row with no id one.
 */
export const INVOICE_ACTIONS: Readonly<Record<InvoiceActionId, InvoiceActionDefinition>> = {
  issue: { subject: "invoice", description: "Issue the draft to Xero." },
  void: { subject: "invoice", description: "Void the invoice; its settlements are released." },
  close: { subject: "invoice", description: "Mark a $0 invoice paid (a closure row)." },
  add_payment: { subject: "invoice", description: "Record a payment, up to the amount due." },
  reverse_settlement: { subject: "invoice", description: "Reverse one settlement row." },
  add_credit_note: { subject: "invoice", description: "Credit billed lines, net of prior notes." },
  edit_items: { subject: "invoice", description: "Edit lines; money is frozen once settled." },
  edit_organization: { subject: "invoice", description: "Re-address the invoice." },
  edit_date: { subject: "invoice", description: "Change the invoice date." },
  void_credit_note: { subject: "credit_note", description: "Void a note with no live allocation." },
  allocate_credit_note: { subject: "credit_note", description: "Allocate remaining credit to an invoice." },
  create_invoice: { subject: "order", description: "Invoice the order." },
  create_remaining_invoice: { subject: "order", description: "Invoice the lines nothing bills yet." },
  create_replacement_invoice: { subject: "order", description: "Bill lost and damaged units." },
  credit_overbilling: { subject: "order", description: "Credit what the order's invoices over-billed." },
};
