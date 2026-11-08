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
 * the organization tombstone and Xero-contact re-address checks, the automatic
 * Xero pushes and `XERO_RETRACTION`, CAS/version checks, idempotency and counter
 * allocation. An offer is a snapshot of the documents it was handed; the server
 * re-checks.
 *
 * The one Xero push an OPERATOR may request is `push_to_xero`
 * (api-cloudrun#1332). It only enqueues the edit push; the task re-plans and
 * still stops at its own seams. Like `edit_items`, it takes a server-computed
 * answer, `xero_sync_status`, because the status needs the invoice's whole Xero
 * projection and its sidecar.
 *
 * ## Calling an `assert*` on a write path — what to hand it
 *
 * The `api-cloudrun` `firestore-transactions` skill decides this, and two
 * contexts are easy to get wrong:
 *
 * - 🔴 **`reverse_settlement` needs only the TARGET row and any row that NAMES
 *   it** — never the invoice's whole settlement list. Inside the reversal's
 *   transaction pass `[target]`, plus the derived reverser when its point-get
 *   exists. A `uid_invoice` range read there would block every concurrent
 *   appender (the range-lock family). A pre-read outside the transaction would
 *   decide on a stale `xero_payment_id`, which `linkSettlementToXero` binds
 *   null → value after the row is written: the #358 hoist-data-not-ids
 *   prohibition.
 * - **`add_payment`'s cap is only as strong as the read it is checked against.**
 *   The payment path claims its row and then CASes the invoice outside any
 *   transaction, and a refusal after the claim would strand a committed row.
 *   So the cap is checked against the read the claim was decided on, and two
 *   concurrent payments can still overpay between them. The fold keeps that
 *   visible as a negative `amount_due_cents`; it does not prevent it.
 * - `close` needs no context at all: assert it against the transaction's own
 *   invoice snapshot. The total it tests can change under any read outside the
 *   transaction.
 *
 * @module
 */
import {
  type CreditNote,
  CREDIT_NOTE_STATUS_CONTRACTS,
  type CreditNoteStatusContract,
  canOperatorTransition,
  INVOICE_ACTIONS,
  INVOICE_FIELD_CLASSES,
  INVOICE_STATUS_CONTRACTS,
  type InvoiceActionId,
  type InvoiceActionSubject,
  type InvoiceDocItemType,
  type InvoiceFieldClass,
  type InvoiceStatusContract,
  type InvoiceStatusType,
  isInvoiceLineItem,
  type Order,
  type PurchaseActionId,
  type Settlement,
  SETTLEMENT_CONTRACTS,
} from "../schemas/mod.ts";
import { invoiceFieldIsFrozen, invoiceHasMoneySettlement, type InvoiceSettledTotals, liveSettlements } from "./invoices.ts";
import { invoiceStatusTracksXeroEdits, type InvoiceXeroSyncStatus } from "./invoice-xero-sync.ts";
import {
  type AccountedCreditNote,
  type AccountingContext,
  type AccountedInvoice,
  buildOverbillingCredits,
  type OverbillingCredits,
  remainingForOrder,
} from "./quantityAccounting.ts";

// ── refusal ──────────────────────────────────────────────────────────

/**
 * A refused invoice or purchase action. The API maps it to a 400 in its error middleware
 * (`api-cloudrun/src/middleware/error.ts`), so a route never builds one by hand.
 */
export class InvoiceActionRefusal extends Error {
  /** The action that was refused. */
  readonly action: InvoiceActionId | PurchaseActionId;
  constructor(action: InvoiceActionId | PurchaseActionId, message: string) {
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
  /**
   * The time one unit billed: Σ the line's `counts` as an exact rational (in
   * its formula's own periods — weeks on Five-day week), `1/1` on a flat line.
   */
  billed_time: TimeAmount;
  /** Unit-time still creditable: `billed × billed_time − Σ prior`, exact. */
  unit_time: TimeAmount;
  /** Whole units still creditable at the line's full time: `⌊unit_time ÷ billed_time⌋`. */
  units: number;
}

/** An exact, non-negative-denominator rational — a quantity of a formula's periods. */
export interface TimeAmount {
  num: number;
  den: number;
}

function gcd(a: number, b: number): number {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b) [a, b] = [b, a % b];
  return a || 1;
}

function reduceTime(t: TimeAmount): TimeAmount {
  const g = gcd(t.num, t.den);
  return { num: t.num / g, den: t.den / g };
}

function addTime(a: TimeAmount, b: TimeAmount): TimeAmount {
  return reduceTime({ num: a.num * b.den + b.num * a.den, den: a.den * b.den });
}

function scaleTime(t: TimeAmount, k: number): TimeAmount {
  return reduceTime({ num: t.num * k, den: t.den });
}

/** `a − b ≥ 0`? and `a < b`? — compared exactly by cross-multiplying. */
function compareTime(a: TimeAmount, b: TimeAmount): number {
  return a.num * b.den - b.num * a.den;
}

/**
 * **One unit's billed time**: Σ a line's `counts`, exact. A line with no counts
 * (none stored) counts as one period, so the budget is exactly its unit count.
 */
export function countsTime(counts: readonly { num: number; den: number }[] | null | undefined): TimeAmount {
  if (!counts || counts.length === 0) return { num: 1, den: 1 };
  return counts.reduce<TimeAmount>((acc, c) => addTime(acc, { num: c.num, den: c.den }), { num: 0, den: 1 });
}

/** A time amount for a message: `2`, or `3/2`. */
function timeLabel(t: TimeAmount): string {
  return t.den === 1 ? String(t.num) : `${t.num}/${t.den}`;
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
   * `edit_items`: whether line MONEY is frozen (D8) — `frozen_classes` includes
   * `"line_money"`. Kept for the callers that ask only that.
   */
  money_frozen?: boolean;
  /**
   * `edit_items`: every field class that is frozen on this invoice, in
   * `INVOICE_FIELD_CLASSES` order (`INVOICE_FIELD_FREEZE`, `@cfs/core/schemas`).
   * A class not listed is editable. Read it per class rather than as one
   * "settled" boolean: on a paid invoice the revenue account is locked while
   * tracking and text are not.
   */
  frozen_classes?: readonly InvoiceFieldClass[];
}

// ── invoice ──────────────────────────────────────────────────────────

/** An invoice as the ruleset reads it. */
export interface OfferInvoice {
  status: InvoiceStatusType;
  totals: InvoiceSettledTotals & { total_cents: number; amount_due_cents: number };
  /** Read only by `add_credit_note`; the dividers are skipped. */
  items?: readonly InvoiceDocItemType[];
  /** Read only by `push_to_xero`. **Absent ⇒ unlinked**, so it is not offered. */
  xero_id?: string | null;
}

/** A settlement row as `reverse_settlement` reads it. */
export type OfferSettlement = Pick<Settlement, "uid" | "type" | "reverses" | "xero_payment_id">;

/** A prior credit-note line, as the credit cap reads it. */
export interface CappedCreditLine {
  name: string;
  quantity: number;
  uid_invoice_item: string | null;
  path_invoice_item?: readonly string[];
  price: { counts?: readonly { num: number; den: number }[] };
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
  /**
   * `invoiceXeroSyncStatus(invoice, sidecar)` from `@cfs/core/utils/invoice-xero-sync`.
   * **Absent ⇒ `push_to_xero` is not offered**: the state is unknown to the
   * caller, which is different from the `unknown` status (no hash recorded yet).
   */
  xero_sync_status?: InvoiceXeroSyncStatus;
  /**
   * Does Xero hold a payment or credit allocation against this invoice?
   * `invoiceSettlementsHeldByXero(rows).length > 0`, from
   * `@cfs/core/utils/invoice-xero-sync`. Xero refuses to void an invoice that
   * carries one, so `void` is not offered while it is `true`.
   * **Absent ⇒ not known**, and `void` is offered exactly as before; the server
   * computes it at void time and refuses there.
   */
  xero_held_settlements?: boolean;
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
 * ONE budget, in unit-TIME: quantity × Σ `counts`, exact (ruling 8 — the days
 * a line bills are its frozen counts, in its formula's own periods). A prior
 * note line credited its own counts: the invoice line's for whole units, the
 * credited days stated through the formula for a days credit
 * (`priceCreditNote`). A line with no counts counts as one period, which makes
 * the budget exactly the unit count.
 */
export function creditableLines(
  items: readonly InvoiceDocItemType[],
  priorNotes: readonly CappedNote[],
): CreditableLine[] {
  const lines = items.filter(isInvoiceLineItem);
  const credited = new Map<string, TimeAmount>();
  for (const note of priorNotes) {
    if (note.status === "void") continue;
    for (const line of note.items) {
      const target = creditedLine(lines, line);
      if (!target) continue;
      const k = pathKey(target.path);
      const spent = scaleTime(noteLineTime(line, target), line.quantity);
      credited.set(k, addTime(credited.get(k) ?? { num: 0, den: 1 }, spent));
    }
  }
  return lines.map((line) => {
    const billedTime = countsTime(line.price.counts);
    const already = credited.get(pathKey(line.path)) ?? { num: 0, den: 1 };
    const unitTime = addTime(scaleTime(billedTime, line.quantity), scaleTime(already, -1));
    // ⌊unit_time ÷ billed_time⌋, exact: (u.num·b.den) ÷ (u.den·b.num).
    const units = Math.floor((unitTime.num * billedTime.den) / (unitTime.den * billedTime.num));
    return {
      path: [...line.path],
      uid: line.uid,
      billed: line.quantity,
      billed_time: billedTime,
      unit_time: unitTime,
      units: Math.max(0, units),
    };
  });
}

/** The time one unit of a note line credited: its own counts, else (none stored) the invoice line's. */
function noteLineTime(
  line: CappedCreditLine,
  target: { price: { counts?: readonly { num: number; den: number }[] } },
): TimeAmount {
  return line.price.counts && line.price.counts.length > 0 ? countsTime(line.price.counts) : countsTime(target.price.counts);
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
    if (line.quantity > billed) {
      return `crediting ${line.quantity} of "${line.name}" exceeds what invoice ${invoiceNumber} billed (${billed})`;
    }
    if (!target) continue;
    const billedTime = countsTime(target.price.counts);
    const capacity = scaleTime(billedTime, billed);
    const remaining = left.get(pathKey(target.path))?.unit_time ?? { num: 0, den: 1 };
    const already = addTime(capacity, scaleTime(remaining, -1));
    const lineTime = noteLineTime(line, target);
    const consumed = scaleTime(lineTime, line.quantity);
    if (compareTime(consumed, remaining) > 0) {
      // A row billing one whole period per unit (a sale, a flat line) keeps the
      // plain unit wording; a time row names the periods it spends.
      return billedTime.num === 1 && billedTime.den === 1
        ? `crediting ${line.quantity} of "${line.name}" exceeds what invoice ${invoiceNumber} ` +
          `billed (${billed}) less what is already credited (${timeLabel(already)})`
        : `crediting ${line.quantity} × ${timeLabel(lineTime)} period(s) of "${line.name}" is ` +
          `${timeLabel(consumed)} unit-periods, and invoice ${invoiceNumber} billed ${timeLabel(capacity)} ` +
          `(${billed} × ${timeLabel(billedTime)}) less ${timeLabel(already)} already credited`;
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
  // A cash refund Xero has linked is a Xero payment on the note, for the same
  // reason (api-cloudrun#1207). An UNLINKED one is the operator's own record.
  if (row.type === "refund" && row.xero_payment_id !== null) {
    return `settlement ${row.uid} is a Xero refund; it is removed in Xero, not here`;
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
 *   `void` is also refused while `ctx.xero_held_settlements` is `true` (D8).
 * - `close` — a live invoice totalling $0, nothing money-settled, no live
 *   closure. ⚠️ Offered on a `paid` $0 invoice too: the ones today's derivation
 *   copied PAID from Xero (#2197) are closed by exactly this action.
 * - `add_payment` (D1) — the status `accepts_payment` and something is due;
 *   `max_cents` is the amount due, a hard cap with no overpay override.
 * - `reverse_settlement` (D2) — one offer per reversible row.
 * - `add_credit_note` (D3) — a status live in Xero, with credit left on a line.
 * - `edit_items` (D8) — always; `frozen_classes` says which field classes are
 *   frozen, and `money_frozen` whether `line_money` is among them.
 * - `edit_organization` / `edit_date` — while their field class is not frozen.
 * - `push_to_xero` — `issued` / `part_paid` / `paid`, linked to Xero, and the
 *   caller's `xero_sync_status` is `out_of_sync` or `unknown`. `paid` is CFS's
 *   status, not Xero's: whether Xero holds the payment is the task's question.
 */
export function invoiceActionsFor(invoice: OfferInvoice, ctx: InvoiceOfferContext = {}): InvoiceActionOffer[] {
  const contract = invoiceContract(invoice.status);
  if (!contract) return [];
  const offers: InvoiceActionOffer[] = [];
  const offer = (action: InvoiceActionId, extra: Omit<InvoiceActionOffer, "key" | "action"> = {}) =>
    offers.push({ key: action, action, ...extra });

  if (canOperatorTransition(invoice.status, "issued")) offer("issue");
  if (invoiceVoidRefusal(invoice, ctx) === null) offer("void");
  if (closeRefusal(invoice) === null) offer("close");

  const due = invoice.totals.amount_due_cents;
  if (contract.accepts_payment && due > 0) offer("add_payment", { max_cents: due });

  for (const row of ctx.settlements ?? []) {
    if (reversalRefusal(row, ctx.settlements ?? []) !== null) continue;
    offers.push({ key: `reverse_settlement:${row.uid}`, action: "reverse_settlement", uid_settlement: row.uid });
  }

  if (contract.live_in_xero) {
    const lines = creditableLines(invoice.items ?? [], ctx.creditNotes ?? []).filter((l) => l.unit_time.num > 0);
    if (lines.length > 0) offer("add_credit_note", { lines });
  }

  const frozen = INVOICE_FIELD_CLASSES.filter((cls) => invoiceFieldIsFrozen(invoice, cls));
  offer("edit_items", { money_frozen: frozen.includes("line_money"), frozen_classes: frozen });
  if (!frozen.includes("counterparty")) offer("edit_organization");
  if (!frozen.includes("date")) offer("edit_date");
  if (pushRefusal(invoice, ctx) === null) offer("push_to_xero");
  return offers;
}

// A hashless `paid` invoice passes the status half and is refused by its
// `not_applicable` sync status below.
function pushRefusal(invoice: OfferInvoice, ctx: InvoiceOfferContext): string | null {
  if (!invoiceStatusTracksXeroEdits(invoice.status)) return `a ${invoice.status} invoice is not pushed to Xero`;
  if (!invoice.xero_id) return "the invoice is not linked to Xero; it is pushed by issuing it";
  const status = ctx.xero_sync_status;
  if (status === undefined) return "the invoice's Xero sync status is unknown to the caller";
  if (status !== "out_of_sync" && status !== "unknown") return `the invoice is ${status} with Xero; there is nothing to push`;
  return null;
}

// Xero refuses to void an invoice it holds a payment or credit allocation
// against. Without this gate the CFS void committed first and the Xero void
// then failed with only a log line, leaving the two systems disagreeing.
function invoiceVoidRefusal(invoice: OfferInvoice, ctx: InvoiceOfferContext): string | null {
  if (!canOperatorTransition(invoice.status, "void")) return `a ${invoice.status} invoice cannot be voided`;
  if (ctx.xero_held_settlements === true) {
    return "Xero holds a payment or credit against this invoice; remove it in Xero before voiding";
  }
  return null;
}

/**
 * Why a $0 billing document may not be marked paid, or `null` when it may — one
 * rule for an invoice and a bill (`noun` is for the message only).
 */
export function closeRefusal(
  doc: Pick<OfferInvoice, "status" | "totals">,
  noun: "invoice" | "bill" = "invoice",
): string | null {
  const contract = invoiceContract(doc.status);
  if (!contract?.live_in_xero) return `a ${doc.status} ${noun} cannot be closed`;
  if (doc.totals.total_cents !== 0) return `only ${noun === "invoice" ? "an invoice" : "a bill"} totalling $0 can be closed; record a payment instead`;
  if (invoiceHasMoneySettlement(doc)) return `the ${noun} already has money settled against it`;
  if ((doc.totals.closure_count ?? 0) > 0) return `the ${noun} is already closed`;
  return null;
}

/** What an operator route asks to do to an invoice. */
export type InvoiceActionRequest =
  | { action: "add_payment"; amount_cents: number }
  | { action: "reverse_settlement"; uid_settlement: string }
  | { action: "add_credit_note"; invoice_number: number; lines: readonly CappedCreditLine[] }
  /** `money_moved` is the server's `lineMoneyAgrees` answer, negated. */
  | { action: "edit_items"; money_moved: boolean }
  | { action: "issue" | "void" | "close" | "edit_organization" | "edit_date" | "push_to_xero" };

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
      if (request.money_moved && invoiceFieldIsFrozen(invoice, "line_money")) refuse("Cannot reprice a settled invoice");
      return;
    }
    case "close": {
      const why = closeRefusal(invoice);
      if (why !== null) refuse(why);
      return;
    }
    case "void": {
      const why = invoiceVoidRefusal(invoice, ctx);
      if (why !== null) refuse(why);
      return;
    }
    case "push_to_xero": {
      const why = pushRefusal(invoice, ctx);
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
   * Every settlement drawing on this note — its `credit` and `refund` rows and
   * their reversals. **Required**: a note voids only with no live allocation
   * and no live refund (D4), and an absent list cannot say that.
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

/** Live rows of `type`: rows of that type no reversal names. */
function liveRows(rows: CreditNoteOfferContext["allocations"], type: "credit" | "refund"): number {
  return liveSettlements(rows).filter((r) => r.type === type).length;
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
  const live = liveRows(ctx.allocations, "credit");
  if (live > 0) return `the credit note has ${live} live allocation(s); reverse them first`;
  // Xero refuses to void a note that carries a payment, and a cash refund IS one
  // (`ARCREDITPAYMENT`) — the same rule as an allocation, for the same reason
  // (api-cloudrun#1207). The refund is removed in Xero, and the reap reverses it.
  const refunds = liveRows(ctx.allocations, "refund");
  if (refunds > 0) return `the credit note has ${refunds} live refund(s); remove them in Xero first`;
  return null;
}

/**
 * Is a refund recordable on this note? A refund spends credit exactly as an
 * allocation does, so it is legal in exactly the statuses that accept one
 * (`accepts_allocation`) and only while credit remains. No invoice and no Xero
 * contact check: a refund pays the customer, not an invoice.
 */
function refundRefusal(note: OfferCreditNote): string | null {
  if (!creditNoteContract(note.status)?.accepts_allocation) return `a ${note.status} credit note cannot be refunded`;
  if (note.remaining_credit_cents <= 0) return "the credit note has no credit left";
  return null;
}

/**
 * Every action the UI may offer on this credit note.
 *
 * - `void_credit_note` (D4) — the status is voidable and no allocation or refund is live.
 * - `allocate_credit_note` (D5, D6) — credit left, and with an invoice in the
 *   context, an invoice that `accepts_payment`, owes something, and sits on the
 *   same Xero contact. `max_cents` is the remaining credit, capped by the
 *   invoice's amount due when one is given.
 * - `record_refund` (api-cloudrun#1207) — note-level only (no invoice in the
 *   context), a status that accepts allocation, and credit left; `max_cents` is
 *   the remaining credit.
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
  // Note-level only: a refund names no invoice, so an invoice in the context
  // says nothing about it.
  if (!ctx.invoice && refundRefusal(note) === null) {
    offers.push({ key: "record_refund", action: "record_refund", max_cents: note.remaining_credit_cents });
  }
  return offers;
}

/** What an operator route asks to do to a credit note. */
export type CreditNoteActionRequest =
  | { action: "void_credit_note" }
  | { action: "allocate_credit_note"; amount_cents: number }
  | { action: "record_refund"; amount_cents: number };

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
  if (request.action === "record_refund") {
    if (request.amount_cents <= 0) refuse("a refund must be more than $0");
    const why = refundRefusal(note);
    if (why !== null) refuse(why);
    if (request.amount_cents > note.remaining_credit_cents) {
      refuse(`a refund of ${request.amount_cents} cents exceeds ${note.remaining_credit_cents} cents of remaining credit`);
    }
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
   * The formulas and holidays an extension is metered with (ruling 8).
   * **Absent ⇒ unknown**, exactly like `invoices`: Invoice Remaining is offered
   * and the over-billing credit is not.
   */
  accounting?: AccountingContext;
  /**
   * Lost and damaged units not yet billed (`seedReplacementLines`). **Absent ⇒
   * 0**: an unknown count offers nothing rather than an empty invoice.
   */
  replacement_units?: number;
  /**
   * Cleaning and maintenance units not yet billed (`seedOnRequestLines`).
   * **Absent ⇒ 0.** The manager passes 0 while `settings/billing` leaves the
   * reason's product unset, so an unmapped reason offers nothing.
   */
  on_request_units?: number;
}

/**
 * Every invoicing action the UI may offer on this order.
 *
 * - The three CREATE actions (D7) refuse a `canceled` order and nothing else —
 *   there is no organization-match rule, because billing a third party is a real
 *   pattern (13 imported invoices). A `draft` order is reserved by the create
 *   route before it is invoiced.
 * - `create_remaining_invoice` — `remainingForOrder` finds a line the remainder
 *   build would bill (`RemainingLine.bills`). An over-billed line is not one: it
 *   is `credit_overbilling`'s (core#120).
 * - `create_replacement_invoice` — `replacement_units > 0`.
 * - `create_service_charge_invoice` — `on_request_units > 0`: cleaning and
 *   maintenance, billed as `service` lines on request (api-cloudrun#1163).
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
  if (open && (ctx.on_request_units ?? 0) > 0) {
    offers.push({ key: "create_service_charge_invoice", action: "create_service_charge_invoice" });
  }
  if ((overbilling(order, ctx)?.notes.length ?? 0) > 0) {
    offers.push({ key: "credit_overbilling", action: "credit_overbilling" });
  }
  return offers;
}

/** Lines the remainder build would bill, or `null` when the invoices are unknown. */
function remainingLines(order: OfferOrder, ctx: OrderInvoiceOfferContext): number | null {
  if (!ctx.invoices || !ctx.accounting) return null;
  return remainingForOrder(order.uid, order.items, ctx.invoices, order.destinations, ctx.accounting, ctx.creditNotes ?? []).lines
    .filter((l) => l.bills).length;
}

function overbilling(order: OfferOrder, ctx: OrderInvoiceOfferContext): OverbillingCredits | null {
  if (!ctx.invoices || !ctx.accounting) return null;
  return buildOverbillingCredits(order, ctx.invoices, ctx.accounting, ctx.creditNotes ?? []);
}

/** What an operator route asks to do from an order. */
export interface OrderInvoiceActionRequest {
  action:
    | "create_invoice"
    | "create_remaining_invoice"
    | "create_replacement_invoice"
    | "create_service_charge_invoice"
    | "credit_overbilling";
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
