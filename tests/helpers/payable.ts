/**
 * Payable line prices for fixtures (api-cloudrun `one-document-model` Phase 2).
 *
 * A payable line states its net in `amount_cents`, and its `price` carries the
 * money `priceDocument`'s stated-total arm derives from it. Built here from the
 * amount so a fixture cannot state money its own amount disagrees with — the
 * schema refuses that, and a hand-spelled triple per fixture is how one would.
 *
 * ⚠️ The money is computed by the rule, not by `priceStatedTotalLine`, so a
 * fixture built here can still catch a regression in the pricer.
 */
import {
  type DiscountType,
  type PriceFormulaRef,
  type PriceModifierType,
  type PurchaseRentalItem,
  PurchaseRentalItemSchema,
  type PurchaseReplacementItem,
  PurchaseReplacementItemSchema,
  type PurchaseSaleItem,
  PurchaseSaleItemSchema,
  type PurchaseServiceItem,
  PurchaseServiceItemSchema,
} from "../../src/schemas/mod.ts";
import { getTestDoc } from "../../src/schemas/testing.ts";
import { canonicalChargeWindows } from "../../src/utils/dates.ts";
import { tsAt } from "./timestamp.ts";

/** The Fixed formula snapshot every flat payable line carries. */
export const FIXED_REF: PriceFormulaRef = { uid: "FixedFormula00000000", name: "Fixed", basis: "flat" };

/** A flat payable line price for a stated net of `amountCents`. */
export function payablePrice(
  amountCents: number,
  opts: { discount?: DiscountType | null; taxes?: PriceModifierType[]; formula?: PriceFormulaRef } = {},
) {
  const discount = opts.discount ?? null;
  const taxes = opts.taxes ?? [];
  return {
    price_formula: opts.formula ?? FIXED_REF,
    rates: [] as never[],
    discount,
    taxes,
    subtotal_cents: amountCents + (discount?.amount_cents ?? 0),
    subtotal_discounted_cents: amountCents,
    total_cents: amountCents + taxes.reduce((sum, t) => sum + t.amount_cents, 0),
  };
}

/** {@link payablePrice} plus the bill/credit line's `counts: []`. */
export function payableDocPrice(
  amountCents: number,
  opts: { discount?: DiscountType | null; taxes?: PriceModifierType[]; formula?: PriceFormulaRef } = {},
) {
  return { ...payablePrice(amountCents, opts), counts: [] as never[] };
}

/**
 * A fixture line with its price money restated from its own `amount_cents` —
 * applied LAST in a builder, after the caller's overrides, so an override of
 * the amount or the discount cannot leave the money stale. A line with no
 * `price` is returned as it is (a test dropping the key on purpose).
 */
export function withPayableMoney<T>(line: T): T {
  const l = line as unknown as { amount_cents?: number | null; price?: Record<string, unknown> };
  if (!l.price) return line;
  const discount = (l.price.discount ?? null) as DiscountType | null;
  const taxes = (l.price.taxes ?? []) as PriceModifierType[];
  const money = payablePrice(l.amount_cents ?? 0, { discount, taxes });
  return {
    ...line,
    price: {
      ...l.price,
      subtotal_cents: money.subtotal_cents,
      subtotal_discounted_cents: money.subtotal_discounted_cents,
      total_cents: money.total_cents,
    },
  } as T;
}

/** The store endpoint every default purchase pair names (one-document-model Phase 3). */
export const STORE_ENDPOINT = {
  uid: null,
  address: {
    city: "Chicago",
    country_name: "United States",
    full: "1234 W Store St, Chicago, Illinois 60612, United States",
    name: "CFS",
    postcode: "60612",
    region: "IL",
    street: "1234 W Store St",
  },
  instructions: null,
  contact: null,
};

/**
 * A purchase destination pair's `dates`, in the ORDER's shape (api-cloudrun#1469):
 * possession `delivery_start` → `collection_start`, each `*_end` following its
 * start, one charge window over possession and `days_active` counted (no
 * holidays) — what the API's `set_possession` + `reset_windows` writes. A `null`
 * end is a standing hire: no collection bound and no window. The `_fs` mirrors
 * are fixture timestamps from {@link tsAt}, so a schema parse sees a consistent pair.
 */
export function hireDates(window: { start: string; end: string | null } | null) {
  const start = window?.start ?? null;
  const end = window?.end ?? null;
  const at = (iso: string | null) => (iso === null ? null : tsAt(iso));
  const dates = {
    delivery_start: start,
    delivery_start_fs: at(start),
    delivery_end: start,
    delivery_end_fs: at(start),
    collection_start: end,
    collection_start_fs: at(end),
    collection_end: end,
    collection_end_fs: at(end),
    days_active: null as number | null,
    charge_windows: start !== null && end !== null ? [{ start, end }] : null,
  };
  return canonicalChargeWindows(dates, []);
}

/**
 * A purchase destination pair at the store: `collection` is the store too when
 * the pair carries a hire window (a subrent goes back), else `null`.
 */
export function purchasePair(uid: string, window: { start: string; end: string | null } | null = null) {
  return {
    uid,
    dates: hireDates(window),
    delivery: STORE_ENDPOINT,
    collection: window ? STORE_ENDPOINT : null,
  };
}

/** A destination divider row for a purchase (`path: [uid]`). */
export function purchaseDivider(uid: string, name = "Chicago") {
  return { uid, type: "destination" as const, name, path: [uid], description: "" };
}

/**
 * A supplier credit's rows as its writer stores them: every LINE row states
 * `reverses_billing` (ruling 84, beta B), `true` unless the row already says
 * otherwise — the writer's R4 answer for a line placed on a purchase line.
 */
export function asCreditRows<R extends { type: string }>(rows: readonly R[]): R[] {
  return rows.map((r) =>
    r.type === "purchase" || r.type === "destination" || r.type === "group" || "reverses_billing" in r
      ? r
      : { ...r, reverses_billing: true }
  );
}

// ── Purchase line fixtures ───────────────────────────────────────────

/** The purchase line arms {@link payableLine} builds, by type. */
interface PayableLineByType {
  sale: PurchaseSaleItem;
  rental: PurchaseRentalItem;
  service: PurchaseServiceItem;
  replacement: PurchaseReplacementItem;
}

/** The default pair a {@link payableLine} sits under when the caller names none. */
export const DEFAULT_PAYABLE_PAIR = "9a1b2c3d-0000-4000-8000-0000000000d1";

const SEED: { [K in keyof PayableLineByType]: { schema: unknown; uid: string; ledger_account: number; extra?: Record<string, unknown> } } = {
  sale: { schema: PurchaseSaleItemSchema, uid: "testprod000000000001", ledger_account: 1999 },
  rental: { schema: PurchaseRentalItemSchema, uid: "testprod000000000002", ledger_account: 5100 },
  service: { schema: PurchaseServiceItemSchema, uid: "custom-0b9e2f4a-0000-4000-8000-000000000003", ledger_account: 5300 },
  replacement: {
    schema: PurchaseReplacementItemSchema,
    uid: "testprod000000000004",
    ledger_account: 5300,
    extra: { out_of_service: [{ uid: "testoos0000000000001", quantity: 1 }] },
  },
};

/**
 * ONE purchase line builder for every payable test (7a): a valid SEED for the
 * arm from its schema (`getTestDoc`, so a new required key reaches every
 * fixture with no edit here), the product keying rule (`uid` names the product
 * — or is `custom-` on a service — and `path` is `[pair, uid]`), then the
 * caller's overrides, then the money restated from the line's own amount
 * ({@link withPayableMoney}).
 *
 * ⚠️ **The overrides are NOT re-parsed**, on purpose: negative tests build a
 * line the schema must refuse. Only the seed is guaranteed valid.
 *
 * @param type - The arm
 * @param over - Field overrides; an override of `uid` re-keys `path` unless `path` is given too
 * @param pair - The destination divider the line sits under
 */
export function payableLine<K extends keyof PayableLineByType>(
  type: K,
  over: Partial<PayableLineByType[K]> = {},
  pair: string = DEFAULT_PAYABLE_PAIR,
): PayableLineByType[K] {
  const seed = SEED[type];
  const uid = (over.uid as string | undefined) ?? seed.uid;
  const base = getTestDoc(
    seed.schema as typeof PurchaseSaleItemSchema,
    { uid: seed.uid, path: [pair, seed.uid], ledger_account: seed.ledger_account, ...(seed.extra ?? {}) } as never,
  ) as unknown as PayableLineByType[K];
  return withPayableMoney({ ...base, uid, path: [pair, uid], ...over } as PayableLineByType[K]);
}
