/**
 * The invoice action ruleset — ONE answer, for the manager and the API alike, to
 * "what may an operator do to this invoice, this credit note, or this order's
 * invoicing?" (api-cloudrun#1169, R3).
 *
 * Three offer functions, each returning only ids from `INVOICE_ACTION_IDS`:
 *
 * - {@link invoiceActionsFor} — on an invoice;
 * - {@link creditNoteActionsFor} — on a credit note;
 * - {@link orderInvoiceActionsFor} — creating invoices or credits from an order.
 *
 * and an `assert*` per function, throwing {@link InvoiceActionRefusal}, that the
 * API runs on its OPERATOR routes. The shape is custody's (`utils/custody.ts`):
 * the UI renders the offers, the server asserts the same rules, so a button
 * cannot be offered that the server refuses.
 *
 * ## Two rules every caller must keep
 *
 * 1. 🔴 **Operator policy is not legality.** The `assert*` functions belong on
 *    operator routes only — never on the Xero webhook, the reap, void-from-cancel
 *    or {@link deriveInvoiceStatus}. Xero is the authority on payments: an
 *    overpayment that arrives from Xero is a fact to record, not a request to
 *    refuse. `add_payment`'s cap applies to the operator, never to the ledger.
 * 2. **Fail closed.** An action this module does not offer is refused, and an
 *    unknown status offers nothing rather than throwing.
 *
 * ## What stays server-only
 *
 * Referenced by the ruleset, never duplicated into it: `lineMoneyAgrees` (it
 * needs the REBUILT lines, so `edit_items` takes its answer as `money_moved`),
 * the organization tombstone and Xero-contact re-address checks, the Xero pushes
 * and `XERO_RETRACTION`, CAS/version checks, idempotency and counter allocation.
 * The server re-checks every limit inside its own transaction; an offer is a
 * snapshot of the documents it was handed.
 *
 * @module
 */
import {
  type CreditNote,
  CREDIT_NOTE_STATUS_CONTRACTS,
  type CreditNoteStatusContract,
  canOperatorTransition,
  INVOICE_ACTIONS,
  INVOICE_STATUS_CONTRACTS,
  type InvoiceActionId,
  type InvoiceActionSubject,
  type InvoiceDocItemType,
  type InvoiceStatusContract,
  type InvoiceStatusType,
  isInvoiceLineItem,
  type Order,
  type Settlement,
  SETTLEMENT_CONTRACTS,
} from "../schemas/mod.ts";
import { invoiceHasMoneySettlement, invoiceIsFrozen, type InvoiceSettledTotals } from "./invoices.ts";
import {
  type AccountedCreditNote,
  type AccountedInvoice,
  buildOverbillingCredits,
  type OverbillingCredits,
  remainingForOrder,
} from "./quantityAccounting.ts";

// ── refusal ──────────────────────────────────────────────────────────

/**
 * A refused invoice action. The API maps it to a 400 in its error middleware
 * (`api-cloudrun/src/middleware/error.ts`), so a route never builds one by hand.
 */
export class InvoiceActionRefusal extends Error {
  /** The action that was refused. */
  readonly action: InvoiceActionId;
  constructor(action: InvoiceActionId, message: string) {
    super(message);
    this.name = "InvoiceActionRefusal";
    this.action = action;
  }
}

// ── offers ───────────────────────────────────────────────────────────

/**
 * What one billed line may still be credited (D3) — arm B of the credit-note
 * cap, as an offer. All three numbers are net of every prior non-void note.
 */
export interface CreditableLine {
  /** The invoice line's `path` — its row identity on the invoice. */
  path: string[];
  uid: string;
  /** Units the line billed. */
  billed: number;
  /** The line's own `chargeable_days`, or 1 for a line with none. */
  billed_days: number;
  /** Unit-days still creditable: `billed × billed_days − Σ prior`. */
  unit_days: number;
  /** Whole units still creditable at the line's full days: `⌊unit_days ÷ billed_days⌋`. */
  units: number;
}

/**
 * One action the UI may offer. `key` is what a menu de-duplicates on: the action
 * id, or `reverse_settlement:<uid>` for a per-row reversal.
 */
export interface InvoiceActionOffer {
  key: string;
  action: InvoiceActionId;
  /** `add_payment`, `allocate_credit_note`: the most cents it may move. Always > 0. */
  max_cents?: number;
  /** `reverse_settlement`: the row it reverses. */
  uid_settlement?: string;
  /** `add_credit_note`: every line with credit left. Never empty. */
  lines?: CreditableLine[];
  /**
   * `edit_items`: whether line MONEY is frozen (D8). Names, descriptions,
   * `tracking_category` and `coa_revenue` stay editable either way.
   */
  money_frozen?: boolean;
}

// ── invoice ──────────────────────────────────────────────────────────

/** An invoice as the ruleset reads it. */
export interface OfferInvoice {
  status: InvoiceStatusType;
  totals: InvoiceSettledTotals & { total_cents: number; amount_due_cents: number };
  /** Read only by `add_credit_note`; the dividers are skipped. */
  items?: readonly InvoiceDocItemType[];
}

/** A settlement row as `reverse_settlement` reads it. */
export type OfferSettlement = Pick<Settlement, "uid" | "type" | "reverses" | "xero_payment_id">;

/** A prior credit-note line, as the credit cap reads it. */
export interface CappedCreditLine {
  name: string;
  quantity: number;
  uid_invoice_item: string | null;
  path_invoice_item?: readonly string[];
  price: { chargeable_days: number | null };
}

/** A prior credit note, as the credit cap reads it. Void notes are skipped. */
export interface CappedNote {
  status: string;
  items: readonly CappedCreditLine[];
}

/** What {@link invoiceActionsFor} needs that the invoice alone does not carry. */
export interface InvoiceOfferContext {
  /**
   * Every settlement row on the invoice, reversals included. **Absent ⇒ no row
   * is offered for reversal** — the rows are unknown — and nothing else changes.
   */
  settlements?: readonly OfferSettlement[];
  /**
   * Every credit note crediting the invoice, void ones included (skipped).
   * **Absent ⇒ no prior credit**: every line's full capacity is offered, and the
   * server re-checks against the notes inside its transaction.
   */
  creditNotes?: readonly CappedNote[];
}

/** A status outside the vocabulary has no contract, and every gate reads false. */
function invoiceContract(status: string): InvoiceStatusContract | undefined {
  return (INVOICE_STATUS_CONTRACTS as Record<string, InvoiceStatusContract | undefined>)[status];
}

const pathKey = (path: readonly string[]): string => path.join("/");

/**
 * Credit left on every billed line, net of `priorNotes` (D3). **Arm B of the
 * api's credit-note cap, lifted here** (`api-cloudrun/src/lib/creditNoteCap.ts`)
 * so the manager offers exactly what the server will accept.
 *
 * ONE budget, in unit-days. A null `chargeable_days` on a prior note line means
 * "whole units at the row's own terms", NOT one day — every note stored before
 * api-cloudrun#1028 has it null, and reading those as one day would leave room
 * to credit units the note already gave back. A line with no `chargeable_days`
 * of its own counts as 1 day, which makes the budget exactly the unit count.
 */
export function creditableLines(
  items: readonly InvoiceDocItemType[],
  priorNotes: readonly CappedNote[],
): CreditableLine[] {
  const lines = items.filter(isInvoiceLineItem);
  const credited = new Map<string, number>();
  for (const note of priorNotes) {
    if (note.status === "void") continue;
    for (const line of note.items) {
      const target = creditedLine(lines, line);
      if (!target) continue;
      const days = target.price.chargeable_days ?? 1;
      const k = pathKey(target.path);
      credited.set(k, (credited.get(k) ?? 0) + line.quantity * (line.price.chargeable_days ?? days));
    }
  }
  return lines.map((line) => {
    const billedDays = line.price.chargeable_days ?? 1;
    const unitDays = line.quantity * billedDays - (credited.get(pathKey(line.path)) ?? 0);
    return {
      path: [...line.path],
      uid: line.uid,
      billed: line.quantity,
      billed_days: billedDays,
      unit_days: unitDays,
      units: Math.max(0, Math.floor(unitDays / billedDays)),
    };
  });
}

/** The invoice line a note line credits: by path, or — for a note stored before paths — the first line with its uid. */
function creditedLine<T extends { uid: string; path: readonly string[] }>(
  lines: readonly T[],
  line: CappedCreditLine,
): T | undefined {
  if (line.path_invoice_item) {
    const k = pathKey(line.path_invoice_item);
    return lines.find((item) => pathKey(item.path) === k);
  }
  if (line.uid_invoice_item === null) return undefined;
  return lines.find((item) => item.uid === line.uid_invoice_item);
}

/**
 * Why crediting `requested` would exceed what the invoice billed, or `null` when
 * it would not. **The api's whole credit-note cap**, both arms, with its
 * messages unchanged but one (a null-day line now names the days it spends) — arm A (one line may not claim more units than the row
 * billed) checked first, then arm B (the cumulative unit-day budget).
 *
 * `invoiceNumber` is for the message only.
 */
export function creditNoteOverCredit(
  invoiceNumber: number,
  items: readonly InvoiceDocItemType[],
  requested: readonly CappedCreditLine[],
  priorNotes: readonly CappedNote[],
): string | null {
  const lines = items.filter(isInvoiceLineItem);
  const left = new Map(creditableLines(items, priorNotes).map((l) => [pathKey(l.path), l]));
  for (const line of requested) {
    const target = creditedLine(lines, line);
    const billed = target?.quantity ?? 0;
    const billedDays = target?.price.chargeable_days ?? 1;
    if (line.quantity > billed) {
      return `crediting ${line.quantity} of "${line.name}" exceeds what invoice ${invoiceNumber} billed (${billed})`;
    }
    const capacity = billed * billedDays;
    const remaining = target ? (left.get(pathKey(target.path))?.unit_days ?? 0) : 0;
    const already = capacity - remaining;
    const consumed = line.quantity * (line.price.chargeable_days ?? billedDays);
    if (consumed > remaining) {
      return billedDays === 1
        ? `crediting ${line.quantity} of "${line.name}" exceeds what invoice ${invoiceNumber} ` +
          `billed (${billed}) less what is already credited (${already})`
        // `?? billedDays`, not the api's old `?? 1`: a null-day line spends the
        // row's full days (see `creditableLines`), so "× 1 day(s)" misstated it.
        : `crediting ${line.quantity} × ${line.price.chargeable_days ?? billedDays} day(s) of "${line.name}" is ` +
          `${consumed} unit-days, and invoice ${invoiceNumber} billed ${capacity} ` +
          `(${billed} × ${billedDays}) less ${already} already credited`;
    }
  }
  return null;
}

/** Is `row` reversible by an operator (D2)? `null` when it is, else why not. */
function reversalRefusal(row: OfferSettlement, rows: readonly OfferSettlement[]): string | null {
  const contract = SETTLEMENT_CONTRACTS[row.type];
  if (!contract) return `settlement ${row.uid} has an unknown type "${row.type}"`;
  if (contract.reverses === "required") return `settlement ${row.uid} is itself a reversal`;
  if (rows.some((r) => r.reverses === row.uid)) return `settlement ${row.uid} is already reversed`;
  // CFS pushes nothing for a payment reversal — Xero is the authority on
  // payments and the reap is the path — so reversing a Xero-linked payment here
  // would leave the two systems disagreeing. A Xero-linked CREDIT is different:
  // its reversal pushes the allocation DELETE, and it is step one of voiding a
  // note.
  if (row.type === "payment" && row.xero_payment_id !== null) {
    return `settlement ${row.uid} is a Xero payment; it is reversed in Xero, not here`;
  }
  // Un-voiding is not an operator move (`operator_moves` for `void` is empty);
  // it is a recovery with two acts, never one row's reversal.
  if (row.type === "void") return `settlement ${row.uid} is a void; an invoice is un-voided by recovery, not by reversal`;
  return null;
}

/**
 * Every action the UI may offer on this invoice.
 *
 * - `issue` / `void` — `canOperatorTransition`, the column `updateInvoice` gates on.
 * - `close` — a live invoice totalling $0, nothing money-settled, no live
 *   closure. ⚠️ Offered on a `paid` $0 invoice too: the ones today's derivation
 *   copied PAID from Xero (#2197) are closed by exactly this action.
 * - `add_payment` (D1) — the status `accepts_payment` and something is due;
 *   `max_cents` is the amount due, a hard cap with no overpay override.
 * - `reverse_settlement` (D2) — one offer per reversible row.
 * - `add_credit_note` (D3) — a status live in Xero, with credit left on a line.
 * - `edit_items` (D8) — always; `money_frozen` says whether line money is.
 * - `edit_organization` / `edit_date` — while not {@link invoiceIsFrozen}.
 */
export function invoiceActionsFor(invoice: OfferInvoice, ctx: InvoiceOfferContext = {}): InvoiceActionOffer[] {
  const contract = invoiceContract(invoice.status);
  if (!contract) return [];
  const offers: InvoiceActionOffer[] = [];
  const offer = (action: InvoiceActionId, extra: Omit<InvoiceActionOffer, "key" | "action"> = {}) =>
    offers.push({ key: action, action, ...extra });

  if (canOperatorTransition(invoice.status, "issued")) offer("issue");
  if (canOperatorTransition(invoice.status, "void")) offer("void");
  if (closeRefusal(invoice, contract) === null) offer("close");

  const due = invoice.totals.amount_due_cents;
  if (contract.accepts_payment && due > 0) offer("add_payment", { max_cents: due });

  for (const row of ctx.settlements ?? []) {
    if (reversalRefusal(row, ctx.settlements ?? []) !== null) continue;
    offers.push({ key: `reverse_settlement:${row.uid}`, action: "reverse_settlement", uid_settlement: row.uid });
  }

  if (contract.live_in_xero) {
    const lines = creditableLines(invoice.items ?? [], ctx.creditNotes ?? []).filter((l) => l.unit_days > 0);
    if (lines.length > 0) offer("add_credit_note", { lines });
  }

  offer("edit_items", { money_frozen: invoiceIsFrozen(invoice) });
  if (!invoiceIsFrozen(invoice)) {
    offer("edit_organization");
    offer("edit_date");
  }
  return offers;
}

function closeRefusal(invoice: OfferInvoice, contract: InvoiceStatusContract): string | null {
  if (!contract.live_in_xero) return `a ${invoice.status} invoice cannot be closed`;
  if (invoice.totals.total_cents !== 0) return "only an invoice totalling $0 can be closed; record a payment instead";
  if (invoiceHasMoneySettlement(invoice)) return "the invoice already has money settled against it";
  if ((invoice.totals.closure_count ?? 0) > 0) return "the invoice is already closed";
  return null;
}

/** What an operator route asks to do to an invoice. */
export type InvoiceActionRequest =
  | { action: "add_payment"; amount_cents: number }
  | { action: "reverse_settlement"; uid_settlement: string }
  | { action: "add_credit_note"; invoice_number: number; lines: readonly CappedCreditLine[] }
  /** `money_moved` is the server's `lineMoneyAgrees` answer, negated. */
  | { action: "edit_items"; money_moved: boolean }
  | { action: "issue" | "void" | "close" | "edit_organization" | "edit_date" };

/**
 * Refuse an invoice action the ruleset does not offer, or one that exceeds its
 * offer's limits. Operator routes only — see the module doc.
 */
export function assertInvoiceAction(
  invoice: OfferInvoice,
  ctx: InvoiceOfferContext,
  request: InvoiceActionRequest,
): void {
  const { action } = request;
  const refuse = (message: string): never => {
    throw new InvoiceActionRefusal(action, message);
  };
  const contract = invoiceContract(invoice.status);
  if (!contract) refuse(`invoice status "${invoice.status}" admits no action`);
  const offers = invoiceActionsFor(invoice, ctx);
  const offered = (key: string) => offers.find((o) => o.key === key);

  switch (request.action) {
    case "add_payment": {
      if (request.amount_cents <= 0) refuse("a payment must be more than $0");
      const o = offered("add_payment") ??
        refuse(`a ${invoice.status} invoice with ${invoice.totals.amount_due_cents} cents due does not accept a payment`);
      if (request.amount_cents > o.max_cents!) {
        refuse(`a payment of ${request.amount_cents} cents exceeds the amount due (${o.max_cents} cents)`);
      }
      return;
    }
    case "reverse_settlement": {
      const rows = ctx.settlements ?? [];
      const row = rows.find((r) => r.uid === request.uid_settlement) ??
        refuse(`settlement ${request.uid_settlement} is not on this invoice`);
      const why = reversalRefusal(row, rows);
      if (why !== null) refuse(why);
      return;
    }
    case "add_credit_note": {
      if (!contract!.live_in_xero) refuse(`invoice ${request.invoice_number} is ${invoice.status}; a credit is raised only on an issued invoice`);
      const why = creditNoteOverCredit(request.invoice_number, invoice.items ?? [], request.lines, ctx.creditNotes ?? []);
      if (why !== null) refuse(why);
      return;
    }
    case "edit_items": {
      if (request.money_moved && invoiceIsFrozen(invoice)) refuse("Cannot reprice a settled invoice");
      return;
    }
    case "close": {
      const why = closeRefusal(invoice, contract!);
      if (why !== null) refuse(why);
      return;
    }
    default:
      if (!offered(request.action)) refuse(`"${request.action}" is not legal on a ${invoice.status} invoice`);
  }
}

// ── credit note ──────────────────────────────────────────────────────

/** A credit note as the ruleset reads it. */
export type OfferCreditNote = Pick<CreditNote, "status" | "remaining_credit_cents"> & {
  organization: { xero_id: string | null };
};

/** An invoice a credit note might be allocated to. */
export interface OfferAllocationTarget {
  status: InvoiceStatusType;
  totals: { amount_due_cents: number };
  organization: { xero_id: string | null };
}

/** What {@link creditNoteActionsFor} needs that the note alone does not carry. */
export interface CreditNoteOfferContext {
  /**
   * Every settlement drawing on this note — its `credit` rows and their
   * reversals. **Required**: a note voids only with no live allocation (D4), and
   * an absent list cannot say that.
   */
  allocations: readonly Pick<Settlement, "uid" | "type" | "reverses">[];
  /**
   * The invoice an allocation would go to. **Absent ⇒ the note-level offer**:
   * `max_cents` is the remaining credit, and the pair checks (D5) run once an
   * invoice is chosen.
   */
  invoice?: OfferAllocationTarget;
}

function creditNoteContract(status: string): CreditNoteStatusContract | undefined {
  return (CREDIT_NOTE_STATUS_CONTRACTS as Record<string, CreditNoteStatusContract | undefined>)[status];
}

/** Live credit rows: `credit` rows no `credit_reversal` names. */
function liveAllocations(rows: CreditNoteOfferContext["allocations"]): number {
  const reversed = new Set(rows.map((r) => r.reverses).filter((r): r is string => r !== null));
  return rows.filter((r) => r.type === "credit" && !reversed.has(r.uid)).length;
}

function allocationRefusal(note: OfferCreditNote, ctx: CreditNoteOfferContext): string | null {
  const contract = creditNoteContract(note.status);
  if (!contract?.accepts_allocation) return `a ${note.status} credit note cannot be allocated`;
  if (note.remaining_credit_cents <= 0) return "the credit note has no credit left";
  const invoice = ctx.invoice;
  if (!invoice) return null;
  if (!invoiceContract(invoice.status)?.accepts_payment) return `a ${invoice.status} invoice does not accept credit`;
  if (invoice.totals.amount_due_cents <= 0) return "the invoice has nothing due";
  // Same Xero CONTACT, not the same CFS organization: two departments under one
  // contact share a ledger, and Xero allocates only within one contact.
  if (note.organization.xero_id === null || note.organization.xero_id !== invoice.organization.xero_id) {
    return "the credit note and the invoice are not on the same Xero contact";
  }
  return null;
}

function voidRefusal(note: OfferCreditNote, ctx: CreditNoteOfferContext): string | null {
  if (!creditNoteContract(note.status)?.voidable) return `a ${note.status} credit note cannot be voided`;
  const live = liveAllocations(ctx.allocations);
  if (live > 0) return `the credit note has ${live} live allocation(s); reverse them first`;
  return null;
}

/**
 * Every action the UI may offer on this credit note.
 *
 * - `void_credit_note` (D4) — the status is voidable and no allocation is live.
 * - `allocate_credit_note` (D5, D6) — credit left, and with an invoice in the
 *   context, an invoice that `accepts_payment`, owes something, and sits on the
 *   same Xero contact. `max_cents` is the remaining credit, capped by the
 *   invoice's amount due when one is given.
 */
export function creditNoteActionsFor(note: OfferCreditNote, ctx: CreditNoteOfferContext): InvoiceActionOffer[] {
  if (!creditNoteContract(note.status)) return [];
  const offers: InvoiceActionOffer[] = [];
  if (voidRefusal(note, ctx) === null) offers.push({ key: "void_credit_note", action: "void_credit_note" });
  if (allocationRefusal(note, ctx) === null) {
    const max = ctx.invoice
      ? Math.min(note.remaining_credit_cents, ctx.invoice.totals.amount_due_cents)
      : note.remaining_credit_cents;
    offers.push({ key: "allocate_credit_note", action: "allocate_credit_note", max_cents: max });
  }
  return offers;
}

/** What an operator route asks to do to a credit note. */
export type CreditNoteActionRequest =
  | { action: "void_credit_note" }
  | { action: "allocate_credit_note"; amount_cents: number };

/** Refuse a credit-note action the ruleset does not offer. Operator routes only. */
export function assertCreditNoteAction(
  note: OfferCreditNote,
  ctx: CreditNoteOfferContext,
  request: CreditNoteActionRequest,
): void {
  const refuse = (message: string): never => {
    throw new InvoiceActionRefusal(request.action, message);
  };
  if (request.action === "void_credit_note") {
    const why = voidRefusal(note, ctx);
    if (why !== null) refuse(why);
    return;
  }
  if (request.amount_cents <= 0) refuse("an allocation must be more than $0");
  const why = allocationRefusal(note, ctx);
  if (why !== null) refuse(why);
  const max = ctx.invoice
    ? Math.min(note.remaining_credit_cents, ctx.invoice.totals.amount_due_cents)
    : note.remaining_credit_cents;
  if (request.amount_cents > max) refuse(`an allocation of ${request.amount_cents} cents exceeds ${max} cents`);
}

// ── order ────────────────────────────────────────────────────────────

/** An order as the ruleset reads it. */
export type OfferOrder = Pick<Order, "uid" | "number" | "status" | "items" | "destinations">;

/** What {@link orderInvoiceActionsFor} needs that the order alone does not carry. */
export interface OrderInvoiceOfferContext {
  /**
   * Every live invoice billing the order. **Absent ⇒ unknown**: Invoice
   * Remaining is offered (the server reads every invoice and 409s when nothing
   * is left — the manager's over-cap rule) and the over-billing credit is not.
   */
  invoices?: readonly AccountedInvoice[];
  /** Every credit note against those invoices. Absent ⇒ none. */
  creditNotes?: readonly AccountedCreditNote[];
  /**
   * Lost and damaged units not yet billed (`seedReplacementLines`). **Absent ⇒
   * 0**: an unknown count offers nothing rather than an empty invoice.
   */
  replacement_units?: number;
}

/**
 * Every invoicing action the UI may offer on this order.
 *
 * - The three CREATE actions (D7) refuse a `canceled` order and nothing else —
 *   there is no organization-match rule, because billing a third party is a real
 *   pattern (13 imported invoices). A `draft` order is reserved by the create
 *   route before it is invoiced.
 * - `create_remaining_invoice` — `remainingForOrder` finds a line nothing bills.
 * - `create_replacement_invoice` — `replacement_units > 0`.
 * - `credit_overbilling` — `buildOverbillingCredits` offers at least one note,
 *   on any status. The manager's 10-invoice cap stays a display limit.
 */
export function orderInvoiceActionsFor(order: OfferOrder, ctx: OrderInvoiceOfferContext = {}): InvoiceActionOffer[] {
  const offers: InvoiceActionOffer[] = [];
  const open = order.status !== "canceled";
  if (open) offers.push({ key: "create_invoice", action: "create_invoice" });
  if (open && remainingLines(order, ctx) !== 0) {
    offers.push({ key: "create_remaining_invoice", action: "create_remaining_invoice" });
  }
  if (open && (ctx.replacement_units ?? 0) > 0) {
    offers.push({ key: "create_replacement_invoice", action: "create_replacement_invoice" });
  }
  if ((overbilling(order, ctx)?.notes.length ?? 0) > 0) {
    offers.push({ key: "credit_overbilling", action: "credit_overbilling" });
  }
  return offers;
}

/** Lines nothing bills, or `null` when the invoices are unknown. */
function remainingLines(order: OfferOrder, ctx: OrderInvoiceOfferContext): number | null {
  if (!ctx.invoices) return null;
  return remainingForOrder(order.uid, order.items, ctx.invoices, order.destinations, ctx.creditNotes ?? []).lines.length;
}

function overbilling(order: OfferOrder, ctx: OrderInvoiceOfferContext): OverbillingCredits | null {
  if (!ctx.invoices) return null;
  return buildOverbillingCredits(order, ctx.invoices, ctx.creditNotes ?? []);
}

/** What an operator route asks to do from an order. */
export interface OrderInvoiceActionRequest {
  action: "create_invoice" | "create_remaining_invoice" | "create_replacement_invoice" | "credit_overbilling";
}

/** Refuse an order-invoicing action the ruleset does not offer. Operator routes only. */
export function assertOrderInvoiceAction(
  order: OfferOrder,
  ctx: OrderInvoiceOfferContext,
  request: OrderInvoiceActionRequest,
): void {
  if (orderInvoiceActionsFor(order, ctx).some((o) => o.action === request.action)) return;
  throw new InvoiceActionRefusal(
    request.action,
    order.status === "canceled" && request.action !== "credit_overbilling"
      ? `order ${order.number} is canceled and cannot be invoiced`
      : `"${request.action}" has nothing to do on order ${order.number}`,
  );
}

/** Which offer function lists `action` — read off {@link INVOICE_ACTIONS}. */
export function invoiceActionSubject(action: InvoiceActionId): InvoiceActionSubject {
  return INVOICE_ACTIONS[action].subject;
}
