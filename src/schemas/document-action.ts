/**
 * The document action vocabulary — what an operator may DO to an initiator
 * (an order or a purchase), a billing document (an invoice or a bill) or a
 * credit (a credit note or a supplier credit), ONE catalog for both sides
 * (one-document-model ruling 43; F15, rulings 110–118).
 *
 * It replaced two vocabularies, `INVOICE_ACTION_IDS` (18 ids) and
 * `PURCHASE_ACTION_IDS` (13), which named one operation twice (`void` /
 * `void_bill`, `add_credit_note` / `add_credit`) and one name twice for two
 * operations (`close` on a purchase and on an invoice). The offers live in
 * `@cfs/core/utils/document-actions`, one function per ROLE, each over both
 * sides, and they return only ids from this list.
 *
 * ## Conventions
 *
 * - **Ids are unique across the catalog**, so a refusal's `action` names one
 *   operation: `void` is the billing document's, `void_credit` the credit's.
 * - **A bare verb acts on the subject itself** (`issue`, `void`, `close`);
 *   `verb_object` acts on something else (`add_payment`, `create_billing`).
 *   There are no `_undo` ids: undoing a payment or a closure is
 *   `reverse_settlement` on its row (ruling 115).
 * - **`roles` is a LIST**, because one operation can be offered from two
 *   documents: `add_credit` from a billing document and (payable, until ruling
 *   112 retires it) from the initiator; `allocate_credit` from the credit and
 *   from the billing document it lands on.
 * - **`per_line`** marks an action offered once per initiator line, keyed by
 *   the line's path. It is not a role: the line belongs to its initiator.
 * - Custody actions are not here: they are the custody levers' rule tables
 *   (`CUSTODY_RULE_IDS`, `INBOUND_CUSTODY_RULE_IDS`).
 *
 * Tables live here and functions in `utils/`, so the vocabulary is importable
 * without the ruleset. Descriptions are one line on purpose: this module ships
 * in the manager's bundle.
 *
 * @module
 */

/** The roles an operator action is offered on. Custody is the levers'. */
export type DocumentActionRole = "initiator" | "billing" | "credit";

/**
 * Every document action id. `tests/document-actions.test.ts` asserts it equals
 * {@link DOCUMENT_ACTIONS}' keys in both directions, and the manager
 * de-duplicates its menus by an offer's `key`, never by a label.
 */
export const DOCUMENT_ACTION_IDS: readonly [
  "create_billing",
  "create_remaining_billing",
  "create_replacement_billing",
  "create_service_charge_billing",
  "credit_overbilling",
  "close_remaining",
  "close_item",
  "remove_item",
  "change_basis",
  "add_credit",
  "issue",
  "void",
  "close",
  "add_payment",
  "reverse_settlement",
  "edit_items",
  "edit_date",
  "edit_counterparty",
  "push_to_xero",
  "allocate_credit",
  "void_credit",
  "record_refund",
] = [
  // on an initiator
  "create_billing",
  "create_remaining_billing",
  "create_replacement_billing",
  "create_service_charge_billing",
  "credit_overbilling",
  "close_remaining",
  // on one initiator line
  "close_item",
  "remove_item",
  "change_basis",
  // on a billing document (and, payable, on the initiator until ruling 112 lands)
  "add_credit",
  // on a billing document
  "issue",
  "void",
  "close",
  "add_payment",
  "reverse_settlement",
  "edit_items",
  "edit_date",
  "edit_counterparty",
  "push_to_xero",
  // on a credit, and on the billing document it lands on
  "allocate_credit",
  // on a credit
  "void_credit",
  "record_refund",
];

/** One document action id. */
export type DocumentActionId = typeof DOCUMENT_ACTION_IDS[number];

/** One row of {@link DOCUMENT_ACTIONS}. */
export interface DocumentActionDefinition {
  /** The roles whose offer function may list it. Never empty. */
  roles: readonly DocumentActionRole[];
  /** Offered once per initiator line, keyed `<id>:<path joined by "/">`. */
  per_line: boolean;
  /** One line, for a tooltip or a log. */
  description: string;
}

/**
 * Every action, keyed by id. `Readonly<Record<DocumentActionId, …>>` makes an id
 * with no row a type error; the both-ways test makes a row with no id one.
 */
export const DOCUMENT_ACTIONS: Readonly<Record<DocumentActionId, DocumentActionDefinition>> = {
  create_billing: { roles: ["initiator"], per_line: false, description: "Bill the initiator; each line offered with the most it may bill." },
  create_remaining_billing: { roles: ["initiator"], per_line: false, description: "Bill what no billing document bills yet." },
  create_replacement_billing: { roles: ["initiator"], per_line: false, description: "Bill lost and damaged units." },
  create_service_charge_billing: { roles: ["initiator"], per_line: false, description: "Bill cleaning and maintenance units, on request." },
  credit_overbilling: { roles: ["initiator"], per_line: false, description: "Credit what the billing documents over-billed." },
  close_remaining: { roles: ["initiator"], per_line: false, description: "Close every open line." },
  close_item: { roles: ["initiator"], per_line: true, description: "Close one open line." },
  remove_item: { roles: ["initiator"], per_line: true, description: "Remove a line nothing has billed or moved." },
  change_basis: { roles: ["initiator"], per_line: true, description: "Move a line nothing has billed or moved between flat and time." },
  add_credit: { roles: ["billing", "initiator"], per_line: false, description: "Credit billed lines, net of prior credits." },
  issue: { roles: ["billing"], per_line: false, description: "Issue the draft to Xero." },
  void: { roles: ["billing"], per_line: false, description: "Void a billing document nothing is paid, credited or raised against." },
  close: { roles: ["billing"], per_line: false, description: "Mark a $0 billing document paid (a closure row)." },
  add_payment: { roles: ["billing"], per_line: false, description: "Record a payment, up to the amount due." },
  reverse_settlement: { roles: ["billing"], per_line: false, description: "Reverse one settlement row, a closure included." },
  edit_items: { roles: ["billing"], per_line: false, description: "Edit lines; each field class freezes per INVOICE_FIELD_FREEZE." },
  edit_date: { roles: ["billing"], per_line: false, description: "Change the document date." },
  edit_counterparty: { roles: ["billing"], per_line: false, description: "Re-address the document to another customer or supplier." },
  push_to_xero: { roles: ["billing"], per_line: false, description: "Re-push a billing document Xero is behind on." },
  allocate_credit: { roles: ["credit", "billing"], per_line: false, description: "Spend remaining credit on a billing document with money due." },
  void_credit: { roles: ["credit"], per_line: false, description: "Void a credit nothing has drawn on." },
  record_refund: { roles: ["credit"], per_line: false, description: "Record remaining credit refunded in cash." },
};
