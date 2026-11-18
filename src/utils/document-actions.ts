/**
 * **The one action catalog, keyed by role** (one-document-model ruling 43; F15,
 * rulings 110–118) — ONE answer, for the manager and the API alike and for both
 * sides, to "what may an operator do to this initiator, this billing document,
 * or this credit?".
 *
 * Three offer functions, one per ROLE, each over both sides and each returning
 * only ids from `DOCUMENT_ACTION_IDS` whose `roles` include its role:
 *
 * - {@link initiatorActionsFor} — on an order or a purchase, and its lines;
 * - {@link billingActionsFor} — on an invoice or a bill;
 * - {@link creditActionsFor} — on a credit note or a supplier credit;
 *
 * and an `assert*` per function, throwing {@link DocumentActionRefusal}, that the
 * API runs on its OPERATOR routes, so a button cannot be offered that the server
 * refuses. It replaced `utils/invoice-actions.ts` and `utils/purchase-actions.ts`,
 * both deleted with F15.
 *
 * ## The side is DATA, never a branch
 *
 * Everything that differs between the sides is a row of {@link ACTION_SIDES} (the
 * `BILLING_FOLD` / `DIFF_SIDES` form), each with its reason, or an entry of
 * {@link ACTION_GAPS} / {@link SIDE_ONLY_ACTIONS}. `tests/billing-fold-coverage.test.ts`
 * holds this file to `SIDE_FREE_FILES`, so a `side ===` here fails the suite.
 *
 * ## Rules every caller keeps
 *
 * 1. 🔴 **Operator policy is not legality.** The `assert*` functions belong on
 *    operator routes only — never on the Xero webhook, the reap, void-from-cancel
 *    or a status derivation. Xero is the authority on payments.
 * 2. **Fail closed.** Every context is REQUIRED: an absent list used to read as
 *    "nothing billed" (and offered a removal) or "unknown" (and offered a remainder
 *    the server then refused). A status outside the vocabulary offers nothing.
 * 3. **An offer is a snapshot** of the documents it was handed; the server
 *    re-checks inside its transaction.
 *
 * ## Calling an `assert*` on a write path — what to hand it
 *
 * The `assert*` takes a per-action REQUEST carrying only what that action reads,
 * so no caller reads more than its transaction may:
 *
 * - 🔴 **`reverse_settlement` needs only the TARGET row and any row that NAMES
 *   it** — never the whole settlement list. A range read inside the reversal's
 *   transaction would block every concurrent appender, and a pre-read outside it
 *   would decide on a stale Xero id (the #358 hoist-data-not-ids prohibition).
 * - `close` and `add_payment` assert against the transaction's own snapshot of
 *   the document: the totals they test can change under any read outside it.
 *   `add_payment`'s cap is only as strong as that read — two concurrent payments
 *   can still overpay between them, and the fold keeps that visible.
 *
 * @module
 */
import {
  canOperatorTransition,
  CREDIT_NOTE_STATUS_CONTRACTS,
  type CreditNote,
  type CreditNoteStatusContract,
  DOCUMENT_ACTIONS,
  type DocumentActionId,
  type DocumentActionRole,
  INVOICE_FIELD_CLASSES,
  INVOICE_STATUS_CONTRACTS,
  type InvoiceFieldClass,
  type InvoiceStatusContract,
  type InvoiceStatusType,
  isKitHeaderLine,
  isLineItemType,
  type Order,
  type Purchase,
  type PurchaseBill,
  type PurchaseCredit,
  type PurchaseDestination,
  type Settlement,
  type SettlementContract,
  SETTLEMENT_CONTRACTS,
  SIDE_CONTRACTS,
  type Side,
  type SharedLineType,
} from "../schemas/mod.ts";
import { invoiceFieldIsFrozen, invoiceHasMoneySettlement, invoiceIsFrozen, type InvoiceSettledTotals, liveSettlements } from "./invoices.ts";
import { invoiceStatusTracksXeroEdits, type InvoiceXeroSyncStatus } from "./invoice-xero-sync.ts";
import {
  type AccountedInitiator,
  type AccountingContext,
  accountBilling,
  addTime,
  billedByPath,
  BILLING_FOLD,
  type BillingFoldDocuments,
  billingNamesLine,
  buildOverbillingCredits,
  compareTime,
  countsTime,
  type CreditDividerRow,
  type InitiatorAccount,
  type KeyableCreditLine,
  type KeyedBillingRow,
  keyCreditLines,
  type LineAccount,
  remainingBilling,
  rowCreditedBefore,
  scaleTime,
  type TimeAmount,
} from "./quantityAccounting.ts";
import { collectSubstitutionAnchors, sliceSubstitutedFor } from "./substitutions.ts";
import type { PurchaseLineCustody } from "./bookings-inbound.ts";

export { countsTime, type TimeAmount };

// ── refusal ──────────────────────────────────────────────────────────

/**
 * A refused document action. The API maps it to a 400 `ACTION_REFUSED` naming
 * `action` in its error middleware (`api-cloudrun/src/middleware/error.ts`), so a
 * route never builds one by hand.
 */
export class DocumentActionRefusal extends Error {
  /** The action that was refused. */
  readonly action: DocumentActionId;
  constructor(action: DocumentActionId, message: string) {
    super(message);
    this.name = "DocumentActionRefusal";
    this.action = action;
  }
}

// ── the side table ───────────────────────────────────────────────────

/** A billing document's authorship: CFS on the receivable side; `pushed` or `linked` on the payable. */
export type BillingAuthorship = "cfs" | "pushed" | "linked";

/**
 * **Everything that differs between the sides in the action catalog** — data,
 * never an `if side`, each entry a domain fact with its reason (ruling 51).
 */
export interface ActionSide {
  /** The operator-facing nouns, for refusal messages only. */
  nouns: Readonly<Record<DocumentActionRole, string>>;
  /** Who authored a billing document. A `linked` document's money is Xero's, so CFS neither voids nor pushes it once settled. */
  authorship(doc: object): BillingAuthorship;
  /**
   * Whether a billing document takes credit at all, beside having money due. A
   * payable card bill (`xero_document: "bank_transaction"`) is born paid and has
   * no Xero ACCPAY to allocate against.
   */
  takesCredit(doc: object): boolean;
  /**
   * May an operator push a billing document Xero has not got yet? The create
   * idempotency differs (`SIDE_CONTRACTS` list, ruling 51): an invoice `POST`
   * upserts on its number, so an unlinked invoice is pushed by ISSUING it; the
   * bill task reads before it creates, and that read is the only remedy for a
   * create Xero refused.
   */
  pushCreates: boolean;
  /**
   * Which settlement rows an operator may reverse here, beyond the contract
   * rules (ruling 116's gap): 369 of 401 prod `bill_payment` rows carry no Xero
   * id (card bills born paid, written by the link writer), so the contract rule
   * alone would offer their reversal. Until 6e-0b3 builds payable operator
   * payments, the payable side reverses its closure row only.
   */
  reversible(contract: SettlementContract): boolean;
  /**
   * Credit offer arm: cap a billing row's units by what the initiator's fold
   * still bills there (the payable pool). The receivable side has never capped
   * by the order fold, and carrying it there would drop offers on
   * invoice-authored and document-only rows (F15 item 5).
   */
  creditCapsByPool: boolean;
  /**
   * Credit offer arm: drop a billing row under no initiator the context carries
   * (a supplier credit names ONE purchase). The receivable side credits any row
   * of the invoice.
   */
  creditNeedsScope: boolean;
  /**
   * The key two documents must share for credit to move between them: the Xero
   * CONTACT on the receivable side (two departments under one contact share a
   * ledger), the supplier on the payable side.
   */
  counterparty(doc: object): string | null;
  /**
   * A whole-initiator close waits for every sub-rented unit to go back: the close
   * zeroes the subrent's supply. Read only where `close_remaining` is offered.
   */
  closeWaitsForReturn: boolean;
}

/** The two sides' action data. */
export const ACTION_SIDES: Readonly<Record<Side, ActionSide>> = {
  receivable: {
    nouns: { initiator: "order", billing: "invoice", credit: "credit note" },
    authorship: () => "cfs",
    takesCredit: () => true,
    pushCreates: false,
    reversible: () => true,
    creditCapsByPool: false,
    creditNeedsScope: false,
    counterparty: (doc) => (doc as { organization?: { xero_id: string | null } }).organization?.xero_id ?? null,
    closeWaitsForReturn: false,
  },
  payable: {
    nouns: { initiator: "purchase", billing: "bill", credit: "supplier credit" },
    authorship: (doc) => (doc as { origin?: string }).origin === "linked" ? "linked" : "pushed",
    takesCredit: (doc) => (doc as { xero_document?: string }).xero_document === "invoice",
    pushCreates: true,
    reversible: (contract) => contract.counts_into === "closure_count",
    creditCapsByPool: true,
    creditNeedsScope: true,
    counterparty: (doc) => (doc as { supplier?: { uid: string } }).supplier?.uid ?? null,
    closeWaitsForReturn: true,
  },
};

/** One action a side does not offer until its route exists (ruling 116). */
export interface ActionGap {
  /** Why it is not offered. */
  reason: string;
  /** The slice that removes the row. */
  removed_by: string;
}

/**
 * **What each side does not offer YET, because no route performs it** (ruling
 * 116). Every row names the slice that removes it, and
 * `tests/document-actions.test.ts` asserts the table only SHRINKS. An `assert*`
 * refuses a gap by its reason.
 */
export const ACTION_GAPS: Readonly<Record<Side, Readonly<Partial<Record<DocumentActionId, ActionGap>>>>> = {
  receivable: {
    close_remaining: {
      reason: "an order has no close route: its lines are closed by editing their quantities",
      removed_by: "an order close route (ruling 113); unscheduled",
    },
    close_item: {
      reason: "an order has no line-close route: edit the line's quantity to what custody holds",
      removed_by: "an order close route (ruling 113); unscheduled",
    },
  },
  payable: {
    add_payment: { reason: "a bill payment is recorded in Xero", removed_by: "6e-0b3 (ruling 44)" },
    record_refund: { reason: "a supplier's cash refund is recorded in Xero", removed_by: "6e-0b3 (ruling 44)" },
    edit_counterparty: {
      reason: "a bill's supplier cannot be changed: `UpdatePurchaseBillInput` has no `supplier`",
      removed_by: "Phase 8 (ruling 50)",
    },
    create_replacement_billing: {
      reason: "the bill create has no replacement seed from return-to-supplier records",
      removed_by: "6e-0d, the billing page's create mode (rulings 30, 111)",
    },
    credit_overbilling: {
      reason: "supplier over-billing is credited from the bill (ruling 112); no over-billing supplier-credit route exists",
      removed_by: "unscheduled: owed an owner ruling",
    },
  },
};

/** One action a role offers on ONE side only, BY DESIGN — a contract entry, not a gap. */
export interface SideOnlyAction {
  action: DocumentActionId;
  role: DocumentActionRole;
  reason: string;
}

/**
 * **The actions a role offers on one side only, keyed by the side that offers
 * them, and why** — the contract half of ruling 51's single list of differences.
 * Not a gap: nothing removes these by building a route.
 */
export const SIDE_ONLY_ACTIONS: Readonly<Record<Side, readonly SideOnlyAction[]>> = {
  receivable: [
    {
      action: "create_service_charge_billing",
      role: "initiator",
      reason: "it bills CFS's own on-request charge from `settings/billing`; a supplier states its own charges (ruling 111)",
    },
  ],
  payable: [
    {
      action: "add_credit",
      role: "initiator",
      reason: "the PO credit entry (ruling 21) for a time line or an unpointed line; it retires once billing-role `add_credit` takes unpointed lines (ruling 112)",
    },
  ],
};

/**
 * Is `action` offered on `role` of `side`? Its `roles`, less this side's gaps,
 * and less an entry some side offers ONLY that this side does not list.
 */
export function sideOffers(side: Side, role: DocumentActionRole, action: DocumentActionId): boolean {
  if (!DOCUMENT_ACTIONS[action].roles.includes(role)) return false;
  if (ACTION_GAPS[side][action] !== undefined) return false;
  const matches = (entry: SideOnlyAction) => entry.action === action && entry.role === role;
  const sideOnly = Object.values(SIDE_ONLY_ACTIONS).some((entries) => entries.some(matches));
  return !sideOnly || SIDE_ONLY_ACTIONS[side].some(matches);
}

// ── offers ───────────────────────────────────────────────────────────

/**
 * One line a billing document may still be credited (F15 item 5) — one element,
 * both sides, keyed by the billing row's PATH (its row identity).
 */
export interface CreditableLine {
  /** The billing row's `path`: what a credit line names as `path_billing_item`. */
  path: string[];
  uid: string;
  /** Units the row bills. */
  billed: number;
  /** One billed unit's time: Σ the row's `counts`, exact; `1/1` on a flat line. */
  billed_time: TimeAmount;
  /** Unit-time still creditable: `billed × billed_time − Σ prior`, exact. */
  unit_time: TimeAmount;
  /**
   * Whole units ONE credit may take now: the rest of the current segment, capped
   * by `⌊unit_time ÷ billed_time⌋` and, on the payable side, by the pool.
   */
  units: number;
  /**
   * Present when those units stand in for a substitution: the initiator path of
   * the X they stand in for. The row's other units are offered once these are
   * credited (one segment per credit).
   */
  stands_in_for?: string[];
}

/** One initiator line {@link DocumentActionOffer} `create_billing` may bill, and the most it may. */
export interface BillableLine {
  /** The initiator line's path. */
  path: string[];
  uid: string;
  /** Always > 0. A time line offers its ordered units: owed time is the writer's split. */
  max_quantity: number;
}

/**
 * One action the UI may offer. `key` is what a menu de-duplicates on: the action
 * id, `<id>:<path>` for a per-line action, or `reverse_settlement:<uid>`.
 */
export interface DocumentActionOffer {
  key: string;
  action: DocumentActionId;
  /** A per-line action: the initiator line, by its path. */
  path?: string[];
  /** `add_payment`, `allocate_credit`, `record_refund`: the most cents it may move. Always > 0. */
  max_cents?: number;
  /** `reverse_settlement`: the row it reverses. */
  uid_settlement?: string;
  /** `add_credit` on a billing document: every row with credit left. Never empty. */
  lines?: CreditableLine[];
  /** `create_billing`: every initiator line with something to bill (ruling 114). May be empty: an unexpected charge is billable too. */
  bill_lines?: BillableLine[];
  /** `edit_items`: whether `line_money` is among `frozen_classes`. */
  money_frozen?: boolean;
  /** `edit_items`: every frozen field class, in `INVOICE_FIELD_CLASSES` order. */
  frozen_classes?: readonly InvoiceFieldClass[];
  /** `close_remaining`: `cancel` when no line has anything received or billed (ruling 55), else `close`. */
  outcome?: "cancel" | "close";
}

const pathKey = (path: readonly string[]): string => path.join("/");
const ZERO: TimeAmount = { num: 0, den: 1 };

function statusContract(status: string): InvoiceStatusContract | undefined {
  return (INVOICE_STATUS_CONTRACTS as Record<string, InvoiceStatusContract | undefined>)[status];
}

function creditContract(status: string): CreditNoteStatusContract | undefined {
  return (CREDIT_NOTE_STATUS_CONTRACTS as Record<string, CreditNoteStatusContract | undefined>)[status];
}

/** "an invoice", "a bill". */
function a(noun: string): string {
  return /^[aeiou]/.test(noun) ? `an ${noun}` : `a ${noun}`;
}

/** A line's basis: its formula's, `flat` when it has none. */
function basisOf(item: { price?: unknown }): string {
  const formula = (item.price as { price_formula?: { basis?: string } | null } | undefined)?.price_formula;
  return formula?.basis ?? "flat";
}

/** Does a line of this type move custody on this side? Not a shared type (a surcharge, a fee) moves none. */
function movesCustody(side: Side, type: string): boolean {
  return (SIDE_CONTRACTS[side].custody as Record<string, string | undefined>)[type as SharedLineType] === "custody";
}

// ── the billing role ─────────────────────────────────────────────────

/** A billing row as the offers read it: a line or a divider of an invoice or a bill. */
export interface OfferRow {
  uid: string;
  type: string;
  path: readonly string[];
  quantity?: number;
  price?: { counts?: readonly { num: number; den: number }[] | null; price_formula?: { basis: string } | null };
  /** A substitute's entries. Initiator-relative. */
  substituted_for?: readonly { path: readonly string[]; quantity: number }[];
  /** Payable: `null` on a kit header (`isKitHeaderLine`). */
  ledger_account?: unknown;
}

/** What every billing document carries for the offers. */
export interface OfferBillingCore {
  uid: string;
  number: number;
  status: InvoiceStatusType;
  totals: InvoiceSettledTotals & { total_cents: number; amount_due_cents: number };
  /** Its rows, dividers included. */
  items: readonly OfferRow[];
  xero_id: string | null;
}

/** A billing document, per side: a bill also says who authored it and which Xero document it is. */
export interface BillingOfferDocuments {
  receivable: OfferBillingCore;
  payable: OfferBillingCore & Pick<PurchaseBill, "origin" | "xero_document">;
}

/** A settlement row as `reverse_settlement` reads it. */
export type OfferSettlement = Pick<Settlement, "uid" | "type" | "reverses" | "xero_payment_id">;

/**
 * One initiator a billing document bills, with EVERY billing and credit document
 * of it — the stranded-credit rule's fold, and the payable credit pool.
 */
export interface OfferInitiatorDocuments<S extends Side> {
  /** Its uid and CURRENT rows. Substitution entries are live while it still carries their X. */
  initiator: { uid: string; items: readonly OfferRow[] };
  billing: readonly BillingFoldDocuments[S]["billing"][];
  credits: readonly BillingFoldDocuments[S]["credit"][];
}

/** What {@link billingActionsFor} needs that the document alone does not carry. Every key is required. */
export interface BillingOfferContext<S extends Side> {
  /** Every settlement row on the document, reversals included. */
  settlements: readonly OfferSettlement[];
  /** Every credit that names the document (`query_by_sources`), void ones included. */
  credits: readonly BillingFoldDocuments[S]["credit"][];
  /** Every initiator the document bills. */
  initiators: readonly OfferInitiatorDocuments<S>[];
  /** The document's Xero sync status (`invoiceXeroSyncStatus` / `purchaseBillXeroSyncStatus`). */
  xero_sync_status: InvoiceXeroSyncStatus;
}

/**
 * Is `row` reversible by an operator? `null` when it is, else why not — read
 * off the row's CONTRACT, never its type literal, so a payable row is refused
 * exactly as its receivable twin is (F15 item 4).
 */
function reversalRefusal(side: Side, row: OfferSettlement, rows: readonly OfferSettlement[]): string | null {
  const contract = (SETTLEMENT_CONTRACTS as Record<string, SettlementContract | undefined>)[row.type];
  if (!contract) return `settlement ${row.uid} has an unknown type "${row.type}"`;
  if (contract.reverses === "required") return `settlement ${row.uid} is itself a reversal`;
  if (rows.some((r) => r.reverses === row.uid)) return `settlement ${row.uid} is already reversed`;
  // Xero is the authority on payments and refunds: CFS pushes nothing for their
  // reversal, so reversing a linked one here would leave the two disagreeing. A
  // Xero-linked CREDIT allocation is different: its reversal pushes the
  // allocation DELETE, step one of voiding a credit.
  if (contract.xero_id_field === "xero_payment_id" && row.xero_payment_id !== null) {
    return `settlement ${row.uid} is a Xero payment; it is reversed in Xero, not here`;
  }
  // Un-voiding is a recovery with two acts, never one row's reversal.
  if (contract.sums_into === "amount_void_cents") return `settlement ${row.uid} is a void; it is undone by recovery, not by reversal`;
  if (!ACTION_SIDES[side].reversible(contract)) {
    return `settlement ${row.uid} is not reversible here until operator payments exist (6e-0b3); only a closure is`;
  }
  return null;
}

/** Why `doc` may not be marked paid at $0, or `null` when it may — one rule for an invoice and a bill. */
export function closeRefusal(
  side: Side,
  doc: Pick<OfferBillingCore, "status" | "totals">,
): string | null {
  const noun = ACTION_SIDES[side].nouns.billing;
  if (!statusContract(doc.status)?.live_in_xero) return `${a(doc.status)} ${noun} cannot be closed`;
  if (doc.totals.total_cents !== 0) return `only ${a(noun)} totalling $0 can be closed; record a payment instead`;
  if (invoiceHasMoneySettlement(doc)) return `the ${noun} already has money settled against it`;
  if ((doc.totals.closure_count ?? 0) > 0) return `the ${noun} is already closed`;
  return null;
}

/**
 * **Why an operator may not void this billing document, or `null`** (F15 item 4;
 * ruling 117). One rule, both sides:
 *
 * 1. the status admits a void (`canOperatorTransition`);
 * 2. not a LINKED document (its money is Xero's: void it in Xero);
 * 3. nothing paid or credited against it, on the FOLDED totals (ruling 117 —
 *    a CFS-recorded payment Xero has not yet seen is still money the operator
 *    reverses first; release-on-void is how a payment silently disappeared);
 * 4. 🔴 **the POINTER arm**: no live credit has a line naming this document
 *    (`uid_billing`). The fold arm below cannot see one: `placeCredits` skips a
 *    credit line naming a billing document the fold is not reading, so a
 *    pointed credit of the voided document never showed and was stranded;
 * 5. the FOLD arm: voiding leaves no flat initiator line it names billed below
 *    zero by an unpointed reversing credit. A time line's billing is its metered
 *    time, which a void cannot strand a credit under.
 *
 * A void from Xero is never refused and never reads this.
 */
export function voidRefusal<S extends Side>(
  side: S,
  doc: BillingOfferDocuments[S],
  credits: readonly BillingFoldDocuments[S]["credit"][],
  initiators: readonly OfferInitiatorDocuments<S>[],
): string | null {
  const data = ACTION_SIDES[side];
  const noun = data.nouns.billing;
  if (!canOperatorTransition(doc.status, "void")) return `${a(doc.status)} ${noun} cannot be voided`;
  if (data.authorship(doc) === "linked") return `${noun} ${doc.number} is linked to a document in Xero; void it in Xero`;
  if (doc.totals.amount_paid_cents > 0 || (doc.totals.amount_credited_cents ?? 0) > 0) {
    return `${noun} ${doc.number} has payments or credits applied to it; remove them first`;
  }
  const fold = BILLING_FOLD[side];
  const pointed = credits.some((credit) =>
    fold.creditIsLive(credit) &&
    (credit.items as readonly (KeyableCreditLine | CreditDividerRow)[]).some((line) =>
      (line as KeyableCreditLine).uid_billing === doc.uid
    )
  );
  if (pointed) {
    return `${noun} ${doc.number} has a live ${data.nouns.credit} raised from it; void the ${data.nouns.credit} first`;
  }
  const stranded = initiators.some((p) => {
    const initiator = p.initiator as unknown as AccountedInitiator;
    const others = p.billing.filter((b) => (b as { uid: string }).uid !== doc.uid);
    const named = billedByPath(side, initiator, [doc as unknown as BillingFoldDocuments[S]["billing"]], []);
    const after = billedByPath(side, initiator, others, p.credits);
    return p.initiator.items.some((item) =>
      isLineItemType(item.type) && basisOf(item) === "flat" &&
      billingNamesLine(named.byPath.get(pathKey(item.path))) &&
      (after.byPath.get(pathKey(item.path))?.quantity ?? 0) < 0
    );
  });
  if (stranded) {
    return `${noun} ${doc.number} cannot be voided: a ${data.nouns.credit} would be left with nothing billed under it; void the ${data.nouns.credit} first`;
  }
  return null;
}

/**
 * Why an operator may not ask for this billing document to be pushed to Xero, or
 * `null`. One refusal (F15 item 4): a status that tracks Xero edits, a sync
 * status Xero is behind on, a document already linked where the side's push
 * does not create ({@link ActionSide.pushCreates}), and never a LINKED document
 * once settled.
 */
export function pushRefusal<S extends Side>(side: S, doc: BillingOfferDocuments[S], status: InvoiceXeroSyncStatus): string | null {
  const noun = ACTION_SIDES[side].nouns.billing;
  if (!invoiceStatusTracksXeroEdits(doc.status)) return `${a(doc.status)} ${noun} is not pushed to Xero`;
  if (!doc.xero_id && !ACTION_SIDES[side].pushCreates) return `the ${noun} is not linked to Xero; it is pushed by issuing it`;
  // A LINKED document's money is Xero's: once settled, CFS does not push it.
  if (ACTION_SIDES[side].authorship(doc) === "linked" && invoiceIsFrozen(doc)) {
    return `${noun} ${doc.number} is linked to a Xero document that has a payment or credit, so CFS does not push it`;
  }
  if (status !== "out_of_sync" && status !== "unknown") return `the ${noun} is ${status} with Xero; there is nothing to push`;
  return null;
}

/** The most credit a billing document can take now: what is due, where it accepts payment and the side takes credit on it. */
function creditRoom<S extends Side>(side: S, doc: BillingOfferDocuments[S]): number {
  if (!statusContract(doc.status)?.accepts_payment || !ACTION_SIDES[side].takesCredit(doc)) return 0;
  return Math.max(0, doc.totals.amount_due_cents);
}

/** The substitution entries of a row that are LIVE: the initiator still carries their X. */
function liveEntries(row: OfferRow, initiatorKeys: ReadonlySet<string> | undefined): { path: readonly string[]; quantity: number }[] {
  const entries = row.substituted_for ?? [];
  return initiatorKeys === undefined ? [] : entries.filter((e) => initiatorKeys.has(pathKey(e.path)));
}

/**
 * The billing document's line rows split into what a credit names on its own and
 * what a substitute KIT root binds: a substituted kit's components carry a share
 * of the root's entries, which a credit row cannot carry without its root above
 * it (api-cloudrun#1475), so a credit of such a kit copies the root WITH its
 * subtree and a component is never offered alone.
 */
function creditRows(items: readonly OfferRow[]): { offered: OfferRow[]; kits: Map<string, OfferRow[]> } {
  const rows = items.filter((r) => isLineItemType(r.type));
  const withEntries = rows
    .filter((r) => (r.substituted_for?.length ?? 0) > 0)
    .map((r) => ({ path: r.path, substituted_for: r.substituted_for! }));
  const roots = new Set(collectSubstitutionAnchors(withEntries).map((x) => pathKey(x.path)));
  const components = new Set(withEntries.map((r) => pathKey(r.path)).filter((k) => !roots.has(k)));
  const kits = new Map<string, OfferRow[]>();
  for (const r of withEntries) {
    const k = pathKey(r.path);
    if (!roots.has(k)) continue;
    const below = rows.filter((x) => x.path.length > r.path.length && r.path.every((p, i) => x.path[i] === p));
    if (below.length > 0) kits.set(k, below);
  }
  const bound = new Set([...kits.values()].flat().map((r) => pathKey(r.path)));
  const offered = rows.filter((r) => {
    const k = pathKey(r.path);
    if (components.has(k) || bound.has(k)) return false;
    return !isKitHeaderLine(r) || kits.has(k);
  });
  return { offered, kits };
}

/** What {@link creditableLines} reads besides the billing document. */
export interface CreditableContext<S extends Side> {
  /** Every credit naming the document; void ones are skipped. */
  credits: readonly BillingFoldDocuments[S]["credit"][];
  /** Every initiator the document bills: live substitution entries, and the payable pool and scope. */
  initiators: readonly OfferInitiatorDocuments<S>[];
}

/**
 * **What each line of a billing document may still be credited** — ONE function,
 * both sides (ruling 43's second clause; F15 item 5).
 *
 * - **A unit-TIME budget**: `billed × billed_time − Σ prior`, exact, every prior
 *   credit line keyed to the row counted (a units credit by the row's time, a
 *   time credit by its own; ruling 106).
 * - **First-come units, one segment per credit**: a row's first units stand in
 *   for its live substitution entries, in stored order, then its own. Only a
 *   UNITS credit advances `c` (`rowCreditedBefore`); a time credit takes time,
 *   never units (R3). A credit row's fold splits its money over its entries, so
 *   a credit spanning two segments could move a cent between two lines.
 * - **Time lines on both sides; $0 lines on both** (ruling 118): a $0 line
 *   credits no money, but a units credit of it un-bills units the fold counts.
 * - **A substitute kit's root** is offered for its whole subtree, a $0 header
 *   included; its components never alone ({@link creditRows}).
 * - **Per side** ({@link ACTION_SIDES}): the payable pool cap and scope arm.
 *
 * A document not live in Xero offers nothing.
 */
export function creditableLines<S extends Side>(
  side: S,
  billing: Pick<OfferBillingCore, "uid" | "status" | "items">,
  ctx: CreditableContext<S>,
): CreditableLine[] {
  if (!statusContract(billing.status)?.live_in_xero) return [];
  const data = ACTION_SIDES[side];
  const { offered } = creditRows(billing.items);
  const allRows = billing.items.filter((r) => isLineItemType(r.type)) as unknown as { uid: string; path: string[]; quantity: number }[];
  const keyed = { uid: billing.uid, rows: allRows };
  const notes = ctx.credits as unknown as readonly { status: string; items: readonly (KeyableCreditLine | CreditDividerRow)[] }[];
  const live = notes.filter((n) => n.status !== "void");
  const credited = new Map<string, TimeAmount>();
  for (const note of live) {
    for (const { line, row, time } of keyCreditLines(keyed, note.items).keyed) {
      const k = pathKey(row.path);
      credited.set(k, addTime(credited.get(k) ?? ZERO, scaleTime(time, line.quantity)));
    }
  }
  const folds = new Map<string, { keys: Set<string>; pool: (path: readonly string[]) => number }>();
  for (const p of ctx.initiators) {
    const fold = billedByPath(side, p.initiator as unknown as AccountedInitiator, p.billing, p.credits);
    folds.set(p.initiator.uid, {
      keys: new Set(p.initiator.items.map((i) => pathKey(i.path))),
      pool: (path) => Math.max(0, fold.byPath.get(pathKey(path))?.quantity ?? 0),
    });
  }
  const out: CreditableLine[] = [];
  for (const line of offered) {
    const scope = folds.get(line.path[0]);
    if (data.creditNeedsScope && (scope === undefined || line.path.length < 2)) continue;
    const quantity = line.quantity ?? 0;
    const billedTime = countsTime(line.price?.counts ?? undefined);
    const unitTime = addTime(scaleTime(billedTime, quantity), scaleTime(credited.get(pathKey(line.path)) ?? ZERO, -1));
    // ⌊unit_time ÷ billed_time⌋, exact. A row billing no time has no time cap.
    const timeCap = billedTime.num > 0
      ? Math.floor((unitTime.num * billedTime.den) / (unitTime.den * billedTime.num))
      : quantity;
    const taken = rowCreditedBefore(keyed, line, live as never).quantity;
    const entries = liveEntries(line, scope?.keys);
    const standIns = entries.reduce((n, e) => n + e.quantity, 0);
    const relative = line.path.slice(1);
    const pool = (path: readonly string[]) => data.creditCapsByPool && scope ? scope.pool(path) : Infinity;
    const base = { path: [...line.path], uid: line.uid, billed: quantity, billed_time: billedTime, unit_time: unitTime };
    const next = sliceSubstitutedFor(entries, Math.min(taken, standIns), standIns)[0];
    if (next !== undefined) {
      const units = Math.max(0, Math.min(next.quantity, timeCap, pool(next.path)));
      out.push({ ...base, units, stands_in_for: [...next.path] });
      continue;
    }
    const own = quantity - Math.max(taken, standIns);
    // The pool of the initiator line the row bills: its move pointer, or its own path.
    const source = (line as { path_source_item?: readonly string[] }).path_source_item ?? relative;
    const units = Math.max(0, Math.min(own, timeCap, pool(source)));
    out.push({ ...base, units });
  }
  return out;
}

/** A requested credit line, as {@link creditRefusal} reads it. */
export interface CappedCreditLine extends KeyableCreditLine {
  name: string;
  quantity: number;
  price?: { counts?: readonly { num: number; den: number }[] };
}

const timeLabel = (t: TimeAmount): string => t.den === 1 ? String(t.num) : `${t.num}/${t.den}`;

/**
 * **Why crediting `requested` from this billing document would exceed what it
 * billed, or `null`** — the server's half of {@link creditableLines}, both sides
 * (F15 item 5). Requests naming one row are SUMMED (the stricter rule):
 *
 * - arm A: the units named on one row may not exceed the units it billed;
 * - a units credit takes at most the row's offered `units` (segment, time and,
 *   payable, pool);
 * - arm B: every request's time on one row together fits its unit-time budget.
 *
 * A line naming no row of this document, or a row the offer does not list, is
 * refused by name.
 */
export function creditRefusal<S extends Side>(
  side: S,
  billing: Pick<OfferBillingCore, "uid" | "number" | "status" | "items">,
  ctx: CreditableContext<S>,
  requested: readonly CappedCreditLine[],
): string | null {
  const noun = ACTION_SIDES[side].nouns.billing;
  if (!statusContract(billing.status)?.live_in_xero) {
    return `${noun} ${billing.number} is ${billing.status}; a credit is raised only on an issued ${noun}`;
  }
  const rows = billing.items.filter((r) => isLineItemType(r.type)) as unknown as { uid: string; path: string[]; quantity: number; price?: OfferRow["price"] }[];
  const offered = new Map(creditableLines(side, billing, ctx).map((l) => [pathKey(l.path), l]));
  const { keyed, unmatched, unpointed } = keyCreditLines({ uid: billing.uid, rows: rows as unknown as KeyedBillingRow[] }, requested);
  for (const line of [...unmatched, ...unpointed]) {
    return `crediting ${line.quantity} of "${line.name}" exceeds what ${noun} ${billing.number} billed (0)`;
  }
  if (keyed.length < requested.length) {
    return `a credit line names another billing document than ${noun} ${billing.number}`;
  }
  const byRow = new Map<string, typeof keyed>();
  for (const k of keyed) byRow.set(pathKey(k.row.path), [...(byRow.get(pathKey(k.row.path)) ?? []), k]);
  for (const [k, lines] of byRow) {
    const row = lines[0].row;
    const name = lines[0].line.name;
    const units = lines.reduce((n, l) => n + l.line.quantity, 0);
    if (units > (row.quantity ?? 0)) return `crediting ${units} of "${name}" exceeds what ${noun} ${billing.number} billed (${row.quantity ?? 0})`;
    const offer = offered.get(k);
    if (offer === undefined) return `${noun} ${billing.number} has no line at ${k} a credit may name`;
    // Arm B first, in the row's own terms: the time every request spends on it.
    const consumed = lines.reduce((t, l) => addTime(t, scaleTime(l.time, l.line.quantity)), ZERO);
    if (compareTime(consumed, offer.unit_time) > 0) {
      const capacity = scaleTime(offer.billed_time, offer.billed);
      const already = addTime(capacity, scaleTime(offer.unit_time, -1));
      // A row billing one whole period per unit (a sale, a flat line) keeps the
      // plain unit wording; a time row names the periods it spends.
      return offer.billed_time.num === 1 && offer.billed_time.den === 1
        ? `crediting ${units} of "${name}" exceeds what ${noun} ${billing.number} billed (${offer.billed}) less what is already credited (${timeLabel(already)})`
        : `crediting ${lines.map((l) => `${l.line.quantity} × ${timeLabel(l.time)}`).join(" + ")} period(s) of "${name}" is ` +
          `${timeLabel(consumed)} unit-periods, and ${noun} ${billing.number} billed ${timeLabel(capacity)} ` +
          `(${offer.billed} × ${timeLabel(offer.billed_time)}) less ${timeLabel(already)} already credited`;
    }
    // Then the units a units credit may take: the current segment and, payable, the pool.
    const wholeUnits = lines.filter((l) => l.kind === "units").reduce((n, l) => n + l.line.quantity, 0);
    if (wholeUnits > offer.units) {
      return offer.stands_in_for !== undefined
        ? `crediting ${wholeUnits} of "${name}" exceeds the ${offer.units} of its units that stand in for ${offer.stands_in_for.join("/")}; credit those first, and the rest in another credit`
        : `crediting ${wholeUnits} of "${name}" exceeds what ${noun} ${billing.number} has left to credit there (${offer.units} of ${offer.billed})`;
    }
  }
  return null;
}

/** One row a credit of `n` units of a billing row pre-fills: {@link creditParts}' element. */
export interface CreditPart {
  /** The billing row's path. */
  path: string[];
  uid: string;
  /** Units pre-filled for this row. */
  quantity: number;
  /**
   * `true` when the row is bound to the credited root: a substitute kit's
   * component, which the API refuses to credit on its own. `false` for an
   * ordinary kit's component, which is a suggestion the operator may change.
   */
  bound: boolean;
}

/**
 * **The rows a credit of `n` units of the billing row at `path` pre-fills** —
 * one function, both sides (F15 item 5): the row itself, then, when it is a KIT
 * (ordinary or substitute), every line row below it at the document's own ratio.
 * A row of `q` units under a root of `Q` takes `(⌊cq/Q⌉, ⌊(c + n)q/Q⌉]`, `c` the
 * root's units already credited, half-up, so credits that sum to the root's
 * quantity sum to each row's. A row the ratio gives no unit is left out.
 *
 * BINDING only below a substitute kit's root (the fold reads its entries off the
 * root); a SUGGESTION below an ordinary kit's.
 *
 * Quantities only: each part's money is the writer's (`priceCreditNote`,
 * `billLineCreditParts`).
 *
 * @returns `[]` when no line row sits at `path`, or `n` is not positive
 */
export function creditParts<S extends Side>(
  billing: Pick<OfferBillingCore, "uid" | "items">,
  path: readonly string[],
  n: number,
  credits: readonly BillingFoldDocuments[S]["credit"][],
): CreditPart[] {
  const rows = billing.items.filter((r) => isLineItemType(r.type));
  const root = rows.find((r) => pathKey(r.path) === pathKey(path));
  if (root === undefined || n <= 0) return [];
  const notes = credits as unknown as readonly { status: string; items: readonly (KeyableCreditLine | CreditDividerRow)[] }[];
  const keyedRows = rows as unknown as { uid: string; path: string[] }[];
  const c = rowCreditedBefore({ uid: billing.uid, rows: keyedRows }, root, notes as never).quantity;
  const out: CreditPart[] = [{ path: [...root.path], uid: root.uid, quantity: n, bound: false }];
  const Q = root.quantity ?? 0;
  if (Q <= 0) return out;
  const bound = creditRows(billing.items).kits.has(pathKey(root.path));
  const at = (units: number, q: number) => Math.floor((2 * units * q + Q) / (2 * Q));
  for (const row of rows) {
    if (row.path.length <= root.path.length || !root.path.every((p, i) => row.path[i] === p)) continue;
    const quantity = at(c + n, row.quantity ?? 0) - at(c, row.quantity ?? 0);
    if (quantity > 0) out.push({ path: [...row.path], uid: row.uid, quantity, bound });
  }
  return out;
}

/**
 * **Every action an operator may take on this billing document** (F15 items 3–4).
 *
 * - `issue` — `canOperatorTransition(…, "issued")`. A bill is never a draft until
 *   6e-0d, so the status contract fails closed with no branch.
 * - `void` — {@link voidRefusal}.
 * - `close` — {@link closeRefusal}.
 * - `add_payment` — the status `accepts_payment` and something is due; `max_cents`
 *   is the amount due.
 * - `allocate_credit` — the document has credit room (due, and the side takes credit on it).
 * - `reverse_settlement` — one offer per reversible row ({@link reversalRefusal}); a
 *   $0 document is un-closed by reversing its closure row (ruling 115).
 * - `add_credit` — a status live in Xero with credit left on a line ({@link creditableLines}).
 * - `edit_items` — always; `frozen_classes` from `INVOICE_FIELD_FREEZE`, both sides.
 * - `edit_date` / `edit_counterparty` — while their field class is not frozen.
 * - `push_to_xero` — {@link pushRefusal}.
 *
 * Gaps ({@link ACTION_GAPS}) are never offered.
 */
export function billingActionsFor<S extends Side>(
  side: S,
  doc: BillingOfferDocuments[S],
  ctx: BillingOfferContext<S>,
): DocumentActionOffer[] {
  const contract = statusContract(doc.status);
  if (!contract) return [];
  const offers: DocumentActionOffer[] = [];
  const offer = (action: DocumentActionId, extra: Omit<DocumentActionOffer, "key" | "action"> = {}) => {
    if (sideOffers(side, "billing", action)) offers.push({ key: action, action, ...extra });
  };
  if (canOperatorTransition(doc.status, "issued")) offer("issue");
  if (voidRefusal(side, doc, ctx.credits, ctx.initiators) === null) offer("void");
  if (closeRefusal(side, doc) === null) offer("close");
  const due = doc.totals.amount_due_cents;
  if (contract.accepts_payment && due > 0) offer("add_payment", { max_cents: due });
  const room = creditRoom(side, doc);
  if (room > 0) offer("allocate_credit", { max_cents: room });
  if (sideOffers(side, "billing", "reverse_settlement")) {
    for (const row of ctx.settlements) {
      if (reversalRefusal(side, row, ctx.settlements) !== null) continue;
      offers.push({ key: `reverse_settlement:${row.uid}`, action: "reverse_settlement", uid_settlement: row.uid });
    }
  }
  const lines = creditableLines(side, doc, ctx).filter((l) => l.units > 0 || l.unit_time.num > 0);
  if (lines.length > 0) offer("add_credit", { lines });
  const frozen = INVOICE_FIELD_CLASSES.filter((cls) => invoiceFieldIsFrozen(doc, cls));
  offer("edit_items", { money_frozen: frozen.includes("line_money"), frozen_classes: frozen });
  if (!frozen.includes("date")) offer("edit_date");
  if (!frozen.includes("counterparty")) offer("edit_counterparty");
  if (pushRefusal(side, doc, ctx.xero_sync_status) === null) offer("push_to_xero");
  return offers;
}

/** What an operator route asks to do to a billing document: each request carries only what its action reads. */
export type BillingActionRequest<S extends Side> =
  | { action: "issue" | "close" | "edit_date" | "edit_counterparty" }
  | { action: "add_payment" | "allocate_credit"; amount_cents: number }
  /** The target row and any row that names it — never the whole list (module doc). */
  | { action: "reverse_settlement"; uid_settlement: string; settlements: readonly OfferSettlement[] }
  | { action: "void"; credits: readonly BillingFoldDocuments[S]["credit"][]; initiators: readonly OfferInitiatorDocuments<S>[] }
  | { action: "push_to_xero"; xero_sync_status: InvoiceXeroSyncStatus }
  /** `money_moved` is the server's `lineMoneyAgrees` answer, negated. */
  | { action: "edit_items"; money_moved: boolean }
  | ({ action: "add_credit"; lines: readonly CappedCreditLine[] } & CreditableContext<S>);

/** Refuse a billing action the catalog does not offer, or one past its offer's limit. Operator routes only. */
export function assertBillingAction<S extends Side>(
  side: S,
  doc: BillingOfferDocuments[S],
  request: BillingActionRequest<S>,
): void {
  const { action } = request;
  const noun = ACTION_SIDES[side].nouns.billing;
  const refuse = (message: string): never => {
    throw new DocumentActionRefusal(action, message);
  };
  const why = (reason: string | null) => {
    if (reason !== null) refuse(reason);
  };
  const gap = ACTION_GAPS[side][action];
  if (gap !== undefined) refuse(`${action} is not available on ${a(noun)}: ${gap.reason}`);
  const contract = statusContract(doc.status) ?? refuse(`${noun} status "${doc.status}" admits no action`);
  switch (request.action) {
    case "issue":
      return why(canOperatorTransition(doc.status, "issued") ? null : `${a(doc.status)} ${noun} cannot be issued`);
    case "close":
      return why(closeRefusal(side, doc));
    case "edit_date":
    case "edit_counterparty": {
      const cls: InvoiceFieldClass = request.action === "edit_date" ? "date" : "counterparty";
      return why(invoiceFieldIsFrozen(doc, cls) ? `the ${noun}'s ${cls} is frozen` : null);
    }
    case "add_payment": {
      if (request.amount_cents <= 0) refuse("a payment must be more than $0");
      const due = doc.totals.amount_due_cents;
      if (!contract.accepts_payment || due <= 0) refuse(`${a(doc.status)} ${noun} with ${due} cents due does not accept a payment`);
      if (request.amount_cents > due) refuse(`a payment of ${request.amount_cents} cents exceeds the amount due (${due} cents)`);
      return;
    }
    case "allocate_credit": {
      if (request.amount_cents <= 0) refuse("an allocation must be more than $0");
      const room = creditRoom(side, doc);
      if (room === 0) refuse(`${noun} ${doc.number} has nothing due to allocate credit to`);
      if (request.amount_cents > room) refuse(`an allocation of ${request.amount_cents} cents exceeds the ${room} cents due`);
      return;
    }
    case "reverse_settlement": {
      const row = request.settlements.find((r) => r.uid === request.uid_settlement) ??
        refuse(`settlement ${request.uid_settlement} is not on this ${noun}`);
      return why(reversalRefusal(side, row, request.settlements));
    }
    case "void":
      return why(voidRefusal(side, doc, request.credits, request.initiators));
    case "push_to_xero":
      return why(pushRefusal(side, doc, request.xero_sync_status));
    case "edit_items":
      return why(request.money_moved && invoiceFieldIsFrozen(doc, "line_money") ? `cannot reprice a settled ${noun}` : null);
    case "add_credit":
      return why(creditRefusal(side, doc, request, request.lines));
  }
}

// ── the credit role ──────────────────────────────────────────────────

/** A credit, per side, as the offers read it. */
export interface CreditOfferDocuments {
  receivable: Pick<CreditNote, "uid" | "status" | "remaining_credit_cents"> & { organization: { xero_id: string | null } };
  payable: Pick<PurchaseCredit, "uid" | "status" | "remaining_credit_cents" | "supplier">;
}

/** A billing document a credit might be allocated to, per side. */
export interface AllocationTargets {
  receivable: { status: InvoiceStatusType; totals: { amount_due_cents: number }; organization: { xero_id: string | null } };
  payable: { status: InvoiceStatusType; totals: { amount_due_cents: number }; supplier: { uid: string } } & Pick<PurchaseBill, "xero_document">;
}

/** A settlement row drawing on a credit, as the credit's offers read it. */
export type OfferCreditRow = Pick<Settlement, "uid" | "type" | "reverses">;

/** What {@link creditActionsFor} needs that the credit alone does not carry. */
export interface CreditOfferContext<S extends Side> {
  /** Every settlement drawing on the credit — allocations, refunds and their reversals. Required: a credit voids only with none live. */
  allocations: readonly OfferCreditRow[];
  /** The billing document an allocation would go to. `null` ⇒ the credit-level offer, the pair checks run once one is chosen. */
  target: AllocationTargets[S] | null;
}

/** Live rows drawing on the credit: an allocation (it settles a billing document) or a refund (it settles the credit itself). */
function liveDraws(rows: readonly OfferCreditRow[]): { allocations: number; refunds: number } {
  let allocations = 0;
  let refunds = 0;
  for (const row of liveSettlements(rows)) {
    const contract = (SETTLEMENT_CONTRACTS as Record<string, SettlementContract | undefined>)[row.type];
    if (!contract?.draws_credit || contract.reverses === "required") continue;
    if (contract.settles === "credit_note" || contract.settles === "purchase_credit") refunds++;
    else allocations++;
  }
  return { allocations, refunds };
}

function voidCreditRefusal(side: Side, credit: { status: string }, rows: readonly OfferCreditRow[]): string | null {
  const noun = ACTION_SIDES[side].nouns.credit;
  if (!creditContract(credit.status)?.voidable) return `${a(credit.status)} ${noun} cannot be voided`;
  const { allocations, refunds } = liveDraws(rows);
  if (allocations > 0) return `the ${noun} has ${allocations} live allocation(s); reverse them first`;
  // Xero refuses to void a credit that carries a payment, and a cash refund IS
  // one, so it is removed in Xero first (api-cloudrun#1207).
  if (refunds > 0) return `the ${noun} has ${refunds} live refund(s); remove them in Xero first`;
  return null;
}

function allocationRefusal<S extends Side>(side: S, credit: CreditOfferDocuments[S], target: AllocationTargets[S] | null): string | null {
  const data = ACTION_SIDES[side];
  const noun = data.nouns.credit;
  if (!creditContract(credit.status)?.accepts_allocation) return `${a(credit.status)} ${noun} cannot be allocated`;
  if (credit.remaining_credit_cents <= 0) return `the ${noun} has no credit left`;
  if (target === null) return null;
  const billing = data.nouns.billing;
  if (!statusContract(target.status)?.accepts_payment || !data.takesCredit(target)) return `${a(target.status)} ${billing} does not accept credit`;
  if (target.totals.amount_due_cents <= 0) return `the ${billing} has nothing due`;
  const key = data.counterparty(credit);
  if (key === null || key !== data.counterparty(target)) return `the ${noun} and the ${billing} are not on the same counterparty`;
  return null;
}

function refundRefusal(side: Side, credit: { status: string; remaining_credit_cents: number }): string | null {
  const noun = ACTION_SIDES[side].nouns.credit;
  if (!creditContract(credit.status)?.accepts_allocation) return `${a(credit.status)} ${noun} cannot be refunded`;
  if (credit.remaining_credit_cents <= 0) return `the ${noun} has no credit left`;
  return null;
}

/**
 * **Every action an operator may take on this credit.**
 *
 * - `void_credit` — the status is voidable and no allocation or refund is live.
 * - `allocate_credit` — credit left; with a target, one that accepts credit,
 *   owes something and shares the counterparty. `max_cents` is the remaining
 *   credit, capped by the target's due.
 * - `record_refund` — credit-level only (no target), credit left.
 */
export function creditActionsFor<S extends Side>(
  side: S,
  credit: CreditOfferDocuments[S],
  ctx: CreditOfferContext<S>,
): DocumentActionOffer[] {
  if (!creditContract(credit.status)) return [];
  const offers: DocumentActionOffer[] = [];
  const offer = (action: DocumentActionId, extra: Omit<DocumentActionOffer, "key" | "action"> = {}) => {
    if (sideOffers(side, "credit", action)) offers.push({ key: action, action, ...extra });
  };
  if (voidCreditRefusal(side, credit, ctx.allocations) === null) offer("void_credit");
  if (allocationRefusal(side, credit, ctx.target) === null) {
    const max = ctx.target === null
      ? credit.remaining_credit_cents
      : Math.min(credit.remaining_credit_cents, ctx.target.totals.amount_due_cents);
    offer("allocate_credit", { max_cents: max });
  }
  if (ctx.target === null && refundRefusal(side, credit) === null) offer("record_refund", { max_cents: credit.remaining_credit_cents });
  return offers;
}

/** What an operator route asks to do to a credit. */
export type CreditActionRequest<S extends Side> =
  | { action: "void_credit"; allocations: readonly OfferCreditRow[] }
  | { action: "allocate_credit"; amount_cents: number; target: AllocationTargets[S] | null }
  | { action: "record_refund"; amount_cents: number };

/** Refuse a credit action the catalog does not offer, or one past its limit. Operator routes only. */
export function assertCreditAction<S extends Side>(side: S, credit: CreditOfferDocuments[S], request: CreditActionRequest<S>): void {
  const refuse = (message: string): never => {
    throw new DocumentActionRefusal(request.action, message);
  };
  const noun = ACTION_SIDES[side].nouns.credit;
  const gap = ACTION_GAPS[side][request.action];
  if (gap !== undefined) refuse(`${request.action} is not available on ${a(noun)}: ${gap.reason}`);
  switch (request.action) {
    case "void_credit": {
      const why = voidCreditRefusal(side, credit, request.allocations);
      if (why !== null) refuse(why);
      return;
    }
    case "record_refund": {
      if (request.amount_cents <= 0) refuse("a refund must be more than $0");
      const why = refundRefusal(side, credit);
      if (why !== null) refuse(why);
      if (request.amount_cents > credit.remaining_credit_cents) {
        refuse(`a refund of ${request.amount_cents} cents exceeds ${credit.remaining_credit_cents} cents of remaining credit`);
      }
      return;
    }
    case "allocate_credit": {
      if (request.amount_cents <= 0) refuse("an allocation must be more than $0");
      const why = allocationRefusal(side, credit, request.target);
      if (why !== null) refuse(why);
      const max = request.target === null
        ? credit.remaining_credit_cents
        : Math.min(credit.remaining_credit_cents, request.target.totals.amount_due_cents);
      if (request.amount_cents > max) refuse(`an allocation of ${request.amount_cents} cents exceeds ${max} cents`);
      return;
    }
  }
}

// ── the initiator role ───────────────────────────────────────────────

/** An initiator, per side, as the offers read it. */
export interface InitiatorOfferDocuments {
  receivable: Pick<Order, "uid" | "number" | "status" | "items" | "destinations">;
  payable: Pick<Purchase, "uid" | "number" | "status" | "items" | "destinations">;
}

/**
 * One initiator line's custody, side-neutral: `received` is the units custody
 * has MOVED for the line (payable: arrived; receivable: left the shelf for it),
 * `returned` the units no longer away (payable: back with the supplier;
 * receivable: back from the customer). Build the payable map with
 * `custodyBySourceItem`.
 */
export type InitiatorLineCustody = PurchaseLineCustody;

/** What {@link initiatorActionsFor} needs that the initiator alone does not carry. Every key is required. */
export interface InitiatorOfferContext<S extends Side> {
  /** EVERY billing document linked to the initiator, live or not, never a page. */
  billing: readonly BillingFoldDocuments[S]["billing"][];
  /** EVERY credit against them. */
  credits: readonly BillingFoldDocuments[S]["credit"][];
  /** The formulas and holidays an extension is metered with (ruling 8). */
  accounting: AccountingContext;
  /** Each line's custody, by its path joined with "/". A line with no entry has moved nothing. */
  custody: ReadonlyMap<string, InitiatorLineCustody>;
  /** The instant the offer is made for, a Chicago instant: a time line closes while its charge window is open at it (ruling 63). */
  now: string;
  /** Lost and damaged units not yet billed (`seedReplacementLines`). */
  replacement_units: number;
  /** Cleaning and maintenance units not yet billed (`seedOnRequestLines`); 0 where `settings/billing` leaves the reason unmapped. */
  on_request_units: number;
}

const NO_CUSTODY: InitiatorLineCustody = Object.freeze({ received: 0, returned: 0 });

/** Is a time line's pair still charging at `now`? Its last charge window ends after `now`; with none, its hire runs on. */
function chargeWindowOpenAt(pair: Pick<PurchaseDestination, "dates"> | undefined, now: string): boolean {
  if (pair === undefined) return false;
  const at = Date.parse(now);
  const windows = pair.dates.charge_windows;
  if (windows !== null && windows.length > 0) return Date.parse(windows[windows.length - 1].end) > at;
  return pair.dates.collection_end === null || Date.parse(pair.dates.collection_end) > at;
}

/**
 * **Has anything happened to this line that makes it history as well as an
 * order?** Ruling 102: the account NAMES it (a live billing row, a substitute
 * standing in for it, a live credit that took something back), or, on a line
 * that moves custody, custody has moved units for it. A touched line is neither
 * removed nor moved across bases.
 */
export function initiatorLineTouched(side: Side, line: Pick<LineAccount, "named" | "item">, custody: InitiatorLineCustody): boolean {
  return line.named || (movesCustody(side, line.item.type) && custody.received > 0);
}

/**
 * **Would a close change this line?** A charge (no custody) drops its unbilled
 * units, or, on a TIME basis, ends its pair's charge window while it is open at
 * `now` (ruling 63). A custody line drops the units still to move — a subrent
 * not while units are out where the side's close waits for their return.
 */
function lineClosable(side: Side, line: LineAccount, custody: InitiatorLineCustody, pair: Pick<PurchaseDestination, "dates"> | undefined, now: string): boolean {
  if (!movesCustody(side, line.item.type)) {
    return basisOf(line.item) === "time" ? chargeWindowOpenAt(pair, now) : line.remaining.units > 0;
  }
  const out = custody.received - custody.returned;
  if (line.item.type === "rental" && ACTION_SIDES[side].closeWaitsForReturn && out > 0) return false;
  return line.ordered - custody.received > 0;
}

/** A per-line offer's key: the action and the line's path, the row identity. */
export function lineActionKey(action: DocumentActionId, path: readonly string[]): string {
  return `${action}:${pathKey(path)}`;
}

/** The initiator's billing account: what every offer here reads, never a re-fold. */
function initiatorAccount<S extends Side>(side: S, initiator: InitiatorOfferDocuments[S], ctx: InitiatorOfferContext<S>): InitiatorAccount {
  return accountBilling(side, initiator as unknown as AccountedInitiator, ctx.billing, ctx.credits, ctx.accounting);
}

/**
 * **Every action an operator may take on this initiator and its lines.** Per-line
 * offers follow the initiator-level ones, in line order.
 *
 * - `create_billing` — the initiator is not canceled; `bill_lines` names every
 *   line with something to bill (ruling 114): a flat line's units the account
 *   leaves (`remaining.units`), a TIME line its ordered units (what is left of its
 *   time is the writer's split, `splitBillTime`).
 * - `create_remaining_billing` — the account finds a line the remainder would bill
 *   ({@link remainingBilling}). An over-billed line is not one: it is `credit_overbilling`'s.
 * - `create_replacement_billing` / `create_service_charge_billing` — their unit counts.
 * - `credit_overbilling` — `buildOverbillingCredits` offers at least one note.
 * - `close_remaining` — an active initiator with a closable line and, where the
 *   side's close waits for returns, no subrented unit out; `outcome` says
 *   whether it cancels.
 * - `add_credit` — (payable, until ruling 112) any billing document exists.
 * - per line: `close_item`; `remove_item` and `change_basis` on an untouched
 *   line ({@link initiatorLineTouched}), `change_basis` only on a line with a
 *   formula. A kit header (payable) may be removed while nothing under it is touched.
 */
export function initiatorActionsFor<S extends Side>(
  side: S,
  initiator: InitiatorOfferDocuments[S],
  ctx: InitiatorOfferContext<S>,
): DocumentActionOffer[] {
  const offers: DocumentActionOffer[] = [];
  const offer = (action: DocumentActionId, extra: Omit<DocumentActionOffer, "key" | "action"> = {}) => {
    if (sideOffers(side, "initiator", action)) offers.push({ key: action, action, ...extra });
  };
  const open = initiator.status !== "canceled";
  const account = initiatorAccount(side, initiator, ctx);
  const custodyOf = (path: readonly string[]) => ctx.custody.get(pathKey(path)) ?? NO_CUSTODY;
  const lines = account.lines.filter((l) => !isKitHeaderLine(l.item));
  const pairOf = (path: readonly string[]) =>
    (initiator.destinations as readonly { uid: string }[]).find((d) => d.uid === path[0]) as Pick<PurchaseDestination, "dates"> | undefined;
  const closable = (l: LineAccount) => lineClosable(side, l, custodyOf(l.path), pairOf(l.path), ctx.now);

  if (open) {
    const bill_lines: BillableLine[] = [];
    for (const l of lines) {
      const max = basisOf(l.item) === "time" ? l.ordered : l.remaining.units;
      if (max > 0) bill_lines.push({ path: [...l.path], uid: l.item.uid, max_quantity: max });
    }
    offer("create_billing", { bill_lines });
    if (remainingBilling(account).bills) offer("create_remaining_billing");
    if (ctx.replacement_units > 0) offer("create_replacement_billing");
    if (ctx.on_request_units > 0) offer("create_service_charge_billing");
  }
  if (buildOverbillingCredits(account).notes.length > 0) offer("credit_overbilling");
  if (initiator.status === "active" && lines.some(closable)) {
    const waits = ACTION_SIDES[side].closeWaitsForReturn &&
      lines.some((l) => l.item.type === "rental" && custodyOf(l.path).received - custodyOf(l.path).returned > 0);
    if (!waits) {
      const cancels = lines.every((l) => movesCustody(side, l.item.type) ? custodyOf(l.path).received === 0 : !l.named);
      offer("close_remaining", { outcome: cancels ? "cancel" : "close" });
    }
  }
  if (ctx.billing.length > 0) offer("add_credit");

  const line = (action: DocumentActionId, path: readonly string[]) => {
    if (sideOffers(side, "initiator", action)) offers.push({ key: lineActionKey(action, path), action, path: [...path] });
  };
  for (const l of lines) {
    if (initiator.status === "active" && closable(l)) line("close_item", l.path);
    if (!initiatorLineTouched(side, l, custodyOf(l.path))) {
      line("remove_item", l.path);
      if ((l.item.price as { price_formula?: unknown } | undefined)?.price_formula) line("change_basis", l.path);
    }
  }
  // A kit header has no receipt, bill or close of its own. It may be removed while
  // nothing under it has happened, and the removal takes its subtree.
  for (const header of account.lines.filter((l) => isKitHeaderLine(l.item))) {
    const under = (l: LineAccount) => l.path.length > header.path.length && header.path.every((seg, k) => l.path[k] === seg);
    if (!lines.some((l) => under(l) && initiatorLineTouched(side, l, custodyOf(l.path)))) line("remove_item", header.path);
  }
  return offers;
}

/** What an operator route asks to do from an initiator. */
export type InitiatorActionRequest =
  | {
    action:
      | "create_billing"
      | "create_remaining_billing"
      | "create_replacement_billing"
      | "create_service_charge_billing"
      | "credit_overbilling"
      | "close_remaining"
      | "add_credit";
  }
  | { action: "close_item" | "remove_item" | "change_basis"; path: readonly string[] };

/** Refuse an initiator action the catalog does not offer. Operator routes only. */
export function assertInitiatorAction<S extends Side>(
  side: S,
  initiator: InitiatorOfferDocuments[S],
  ctx: InitiatorOfferContext<S>,
  request: InitiatorActionRequest,
): void {
  const k = "path" in request ? lineActionKey(request.action, request.path) : request.action;
  if (initiatorActionsFor(side, initiator, ctx).some((o) => o.key === k)) return;
  const noun = ACTION_SIDES[side].nouns.initiator;
  const gap = ACTION_GAPS[side][request.action];
  throw new DocumentActionRefusal(
    request.action,
    gap !== undefined
      ? `${request.action} is not available on ${a(noun)}: ${gap.reason}`
      : initiator.status === "canceled" && request.action.startsWith("create_")
      ? `${noun} ${initiator.number} is canceled and cannot be billed`
      : `"${request.action}" has nothing to do on ${noun} ${initiator.number} as it stands`,
  );
}

// ── the remainder (ruling 101) ───────────────────────────────────────

// `remainingBilling` is the remainder's DECISION author, beside the account it
// reads (`utils/quantityAccounting.ts`), so the receivable row author can call it
// without an import cycle. Re-exported here: it is the catalog's
// `create_remaining_billing` answer on both sides.
export { remainingBilling, type RemainingBilling } from "./quantityAccounting.ts";
