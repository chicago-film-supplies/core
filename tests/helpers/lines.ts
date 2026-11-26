/**
 * **One line-row fixture builder per arm, every grain** (ruling 204: a row
 * states every key). Each is `getTestDoc` of the arm's schema — the shared seed,
 * never a re-implementation of it (the deleted `makeDoc` reproduced the defect
 * it was written to remove) — plus the two things a fixture needs that
 * `getTestDoc` deliberately does not do, exactly as {@link payableLine} does for
 * the purchase grain (`./payable.ts`):
 *
 * - **The overrides are applied AFTER the seed and NOT re-parsed**, so a
 *   negative test can build the row the schema must refuse. Only the seed is
 *   guaranteed valid.
 * - **`price` is merged over the seeded price**, so an override naming some
 *   price keys still states the rest (a required key added to a price reaches
 *   every fixture with no edit here).
 *
 * The point of the module: a newly required line key reaches every fixture
 * built here with no fixture edit. ⚠️ So a fixture built here is NOT evidence
 * that a required key is enforced — the seed states it by construction (core
 * `CLAUDE.md` § *Seeding*). That evidence is the drop-one-key property test in
 * `tests/line-edit.test.ts`, which deletes each key directly.
 *
 * @module
 */
import {
  CreditNoteDocLineItem,
  FulfillmentItemInputLine,
  type FulfillmentItemInputLineType,
  FulfillmentLineItem,
  type FulfillmentLineItemType,
  InvoiceDocDestinationItem,
  type InvoiceDocDestinationItemType,
  InvoiceDocLineItem,
  type InvoiceDocLineItemType,
  InvoiceItemInputLine,
  type InvoiceItemInputLineType,
  OrderDocLineItem,
  type OrderDocLineItemType,
  OrderItemLine,
  type OrderItemLineType,
  PurchaseDocumentProductItemSchema,
  PurchaseDocumentReplacementItemSchema,
  PurchaseDocumentServiceItemSchema,
  PurchaseReceiptLineItem,
  type PurchaseReceiptLineItemType,
  PurchaseBillRowInput,
  type PurchaseBillProductLineInputType,
  type PurchaseBillReplacementLineInputType,
  type PurchaseBillServiceLineInputType,
  PurchaseItemInput,
  type PurchaseItemInputType,
  PurchaseRowInput,
  type PurchaseRowInputType,
} from "../../src/schemas/mod.ts";
import type { CreditNoteDocLineItem as CreditNoteDocLineItemType } from "../../src/schemas/credit-note.ts";
import type {
  PurchaseDocumentProductItem,
  PurchaseDocumentReplacementItem,
  PurchaseDocumentServiceItem,
} from "../../src/schemas/purchase-bill.ts";
import { getTestDoc } from "../../src/schemas/testing.ts";

/** A priced row's overrides: any key, `price` partially. */
export type LineOverrides<T extends { price: object }> = Partial<Omit<T, "price">> & { price?: Partial<T["price"]> };

/** The seed, then the overrides, then the price merged over the seeded price — see the module docblock. */
function seeded<T extends { price: object }>(seed: T, over: LineOverrides<T>): T {
  return { ...seed, ...over, price: { ...seed.price, ...over.price } };
}

// ── Stored rows ─────────────────────────────────────────────────────

/** An order line (`OrderDocLineItem`). */
export function orderLine(over: LineOverrides<OrderDocLineItemType> = {}): OrderDocLineItemType {
  return seeded(getTestDoc(OrderDocLineItem), over);
}

/** An invoice line (`InvoiceDocLineItem`). */
export function invoiceLine(over: LineOverrides<InvoiceDocLineItemType> = {}): InvoiceDocLineItemType {
  return seeded(getTestDoc(InvoiceDocLineItem), over);
}

/** An invoice (or bill, or credit) destination divider, `path_extension_for: null` unless stated. */
export function billingDestinationDivider(
  over: Partial<InvoiceDocDestinationItemType> = {},
): InvoiceDocDestinationItemType {
  return { ...getTestDoc(InvoiceDocDestinationItem), ...over };
}

/** A fulfillment line (`FulfillmentLineItem`). */
export function fulfillmentLine(over: Partial<FulfillmentLineItemType> = {}): FulfillmentLineItemType {
  return { ...getTestDoc(FulfillmentLineItem), ...over };
}

/** A purchase receipt line (`PurchaseReceiptLineItem`). */
export function receiptLine(over: Partial<PurchaseReceiptLineItemType> = {}): PurchaseReceiptLineItemType {
  return { ...getTestDoc(PurchaseReceiptLineItem), ...over };
}

/** An AR credit-note line (`CreditNoteDocLineItem`). */
export function creditNoteLine(over: LineOverrides<CreditNoteDocLineItemType> = {}): CreditNoteDocLineItemType {
  return seeded(getTestDoc(CreditNoteDocLineItem), over);
}

/** A bill or supplier-credit `sale`/`rental` line. */
export function billProductLine(over: LineOverrides<PurchaseDocumentProductItem> = {}): PurchaseDocumentProductItem {
  return seeded(getTestDoc(PurchaseDocumentProductItemSchema), over);
}

/** A bill or supplier-credit `service` line. */
export function billServiceLine(over: LineOverrides<PurchaseDocumentServiceItem> = {}): PurchaseDocumentServiceItem {
  return seeded(getTestDoc(PurchaseDocumentServiceItemSchema), over);
}

/** A bill or supplier-credit `replacement` line. */
export function billReplacementLine(
  over: LineOverrides<PurchaseDocumentReplacementItem> = {},
): PurchaseDocumentReplacementItem {
  return seeded(getTestDoc(PurchaseDocumentReplacementItemSchema), over);
}

// ── Input rows ──────────────────────────────────────────────────────

/** An order line as a client sends it (`OrderItemLine`). */
export function orderLineInput(over: LineOverrides<OrderItemLineType> = {}): OrderItemLineType {
  return seeded(getTestDoc(OrderItemLine), over);
}

/** An invoice line as a client sends it (`InvoiceItemInputLine`). */
export function invoiceLineInput(over: LineOverrides<InvoiceItemInputLineType> = {}): InvoiceItemInputLineType {
  return seeded(getTestDoc(InvoiceItemInputLine), over);
}

/** A fulfillment picker row as a client sends it (`FulfillmentItemInputLine`). */
export function fulfillmentLineInput(over: Partial<FulfillmentItemInputLineType> = {}): FulfillmentItemInputLineType {
  return { ...getTestDoc(FulfillmentItemInputLine), ...over };
}

/**
 * The member of union `R` whose `type` admits `K`, narrowed to `K`. Not
 * `Extract`: an arm may declare several literals at once (a bill row's product
 * arm is `"sale" | "rental"`), and `Extract<R, { type: "sale" }>` drops it.
 */
export type ArmOf<R, K extends string> = R extends { type: infer T } ? (K extends T ? R & { type: K } : never) : never;

/** Narrow a union row to the arm its `type` names — a predicate, never a cast. */
function isArm<R extends { type: string }, K extends R["type"]>(row: R, type: K): row is ArmOf<R, K> {
  return row.type === type;
}

/**
 * The money a payable LINE seed states: a stated $0 gross, which satisfies "a
 * Buy line states its gross or its rates" — a cross-field rule the structural
 * seed cannot derive (as `payablePrice` supplies it for stored lines).
 */
const PAYABLE_SEED_MONEY = { price: { stated_cents: 0, rates: [] } };

/** A replacement row's records must share out its quantity — also cross-field. */
const seedFor = (type: string) =>
  type === "replacement"
    ? { ...PAYABLE_SEED_MONEY, quantity: 1, out_of_service: [{ uid: "testoos0000000000001", quantity: 1 }] }
    : PAYABLE_SEED_MONEY;

/** A purchase line as a client sends it, in the arm `type` names (`PurchaseItemInput`). */
export function purchaseLineInput<K extends PurchaseItemInputType["type"]>(
  type: K,
  over: LineOverrides<ArmOf<PurchaseItemInputType, K>> = {},
): ArmOf<PurchaseItemInputType, K> {
  const row = getTestDoc(PurchaseItemInput, { type, ...seedFor(type) });
  if (!isArm(row, type)) throw new Error(`purchaseLineInput: seeded a ${row.type}, not a ${type}`);
  return seeded(row, over);
}

/** A bill `sale`/`rental` row as a client sends it (`PurchaseBillRowInput`). */
export function billProductLineInput(
  type: "sale" | "rental",
  over: LineOverrides<PurchaseBillProductLineInputType> = {},
): PurchaseBillProductLineInputType {
  const row = getTestDoc(PurchaseBillRowInput, { type, ...seedFor(type) });
  if (row.type !== "sale" && row.type !== "rental") throw new Error(`billProductLineInput: seeded a ${row.type}`);
  return seeded(row, { type, ...over });
}

/** A bill `service` row as a client sends it (`PurchaseBillRowInput`). */
export function billServiceLineInput(
  over: LineOverrides<PurchaseBillServiceLineInputType> = {},
): PurchaseBillServiceLineInputType {
  const row = getTestDoc(PurchaseBillRowInput, { type: "service", ...seedFor("service") });
  if (row.type !== "service") throw new Error(`billServiceLineInput: seeded a ${row.type}`);
  return seeded(row, over);
}

/** A bill `replacement` row as a client sends it (`PurchaseBillRowInput`). */
export function billReplacementLineInput(
  over: LineOverrides<PurchaseBillReplacementLineInputType> = {},
): PurchaseBillReplacementLineInputType {
  const row = getTestDoc(PurchaseBillRowInput, { type: "replacement", ...seedFor("replacement") });
  if (row.type !== "replacement") throw new Error(`billReplacementLineInput: seeded a ${row.type}`);
  return seeded(row, over);
}

/** A purchase DIVIDER row as a client sends it (`PurchaseRowInput`'s destination or group arm). */
export function purchaseDividerInput<K extends "destination" | "group">(
  type: K,
  over: Partial<ArmOf<PurchaseRowInputType, K>> = {},
): ArmOf<PurchaseRowInputType, K> {
  const row = getTestDoc(PurchaseRowInput, { type });
  if (!isArm(row, type)) throw new Error(`purchaseDividerInput: seeded a ${row.type}, not a ${type}`);
  return { ...row, ...over };
}
