/**
 * **The one line-edit module, both sides, run twice** (one-document-model rulings
 * 190, 191, 193, 195–197; spec S6/S7 in
 * `api-cloudrun/.claude/plans/line-model-spec.md`).
 *
 * A client submits FULL rows (ruling 190): a submitted row IS the row, and an
 * omitted key resets or re-derives. So "what did the operator change" is a
 * comparison by VALUE against the stored row it pairs with, and that comparison
 * — plus what an edit does to a line's money — lives here once, for the order,
 * the invoice, the purchase and the bill. The manager runs it before sending, to
 * refuse on the row's own field; the api runs it as the authority.
 *
 * - {@link diffLine} first: a submitted row's changes against its stored pair,
 *   over the keys the grain's update INPUT accepts, minus the keys the stored
 *   schema marks `derived` (the manager sends its optimistic recompute, and a
 *   derived key is the pricer's). Absent ≡ null. An echoed stored row is no
 *   change (ruling 193).
 * - {@link applyLineEdit} applies one change: the edited row, or every refusal
 *   with the row-relative path it lands on.
 * - {@link diffItems} pairs whole arrays (`pairItemsAcrossRebuild`, ruling 192).
 *
 * Both key sets are READ OFF THE SCHEMAS ({@link lineEditKeys}), never listed:
 * the input's leaves say what a client may send, `.meta({ derived: true })` what
 * the pricer owns, and `.meta({ server_owned: true })` (ruling 197) what a
 * client may echo but never change.
 *
 * Pure and side-generic; the per-side differences are entries in
 * {@link LINE_EDIT_SIDES}, never a branch on the document.
 *
 * ⚠️ The returned line's DERIVED money (`subtotal_cents`, `taxes`, `total_cents`)
 * is stale by design: the writer prices the whole document (`priceDocument`).
 * What this module writes is the money an edit DECIDES — a stated line's
 * discount cents (the one rate event, D7) and a payable line's net.
 *
 * @module
 */
import type { z } from "zod";
import { collectLeafPaths } from "../schemas/zod-walk.ts";
import {
  isKitHeaderLine,
  isLineItemType,
  OrderSchema,
  InvoiceSchema,
  PurchaseBillSchema,
  PurchaseSchema,
  type Side,
  UpdateInvoiceInput,
  UpdateOrderInput,
  UpdatePurchaseBillInput,
  UpdatePurchaseInput,
} from "../schemas/mod.ts";
import { applyDiscountTerms, formulaPartMoney, lineKindOf } from "../schemas/_line-money.ts";
import { pairItemsAcrossRebuild, type PathedItem } from "./item-pairing.ts";
import { sameSharedValue } from "./shared-fields.ts";

// ── Grains and sides ─────────────────────────────────────────────────

/** The items-bearing documents whose lines an operator edits. */
export const LINE_EDIT_GRAINS: readonly ["order", "invoice", "purchase", "bill"] = ["order", "invoice", "purchase", "bill"];
/** One of {@link LINE_EDIT_GRAINS}. */
export type LineEditGrain = typeof LINE_EDIT_GRAINS[number];

/** The meta key marking a key a client may echo but never change (ruling 197). */
export const SERVER_OWNED_META_KEY = "server_owned";

/**
 * **What differs per SIDE, as entries** (ruling 33): the line's posting key, and
 * which rows are UNCOUNTED (carry no money and no account: a payable kit header,
 * `isKitHeaderLine`; the receivable side has none).
 */
export const LINE_EDIT_SIDES: {
  readonly [S in Side]: {
    /** The line key naming the account it posts to. */
    readonly account: "coa_revenue" | "ledger_account";
    /** Is this stored row uncounted — no money, no account? */
    readonly uncounted: (row: object) => boolean;
  };
} = {
  receivable: { account: "coa_revenue", uncounted: () => false },
  payable: { account: "ledger_account", uncounted: (row) => isKitHeaderLine(row) },
};

const GRAINS: {
  readonly [G in LineEditGrain]: { side: Side; input: z.ZodType; stored: readonly z.ZodType[] };
} = {
  order: { side: "receivable", input: UpdateOrderInput, stored: [OrderSchema, InvoiceSchema] },
  invoice: { side: "receivable", input: UpdateInvoiceInput, stored: [OrderSchema, InvoiceSchema] },
  purchase: { side: "payable", input: UpdatePurchaseInput, stored: [PurchaseSchema, PurchaseBillSchema] },
  bill: { side: "payable", input: UpdatePurchaseBillInput, stored: [PurchaseSchema, PurchaseBillSchema] },
};

/** The side a grain is on. */
export function lineEditSide(grain: LineEditGrain): Side {
  return GRAINS[grain].side;
}

// ── The key sets, read off the schemas ───────────────────────────────

/** {@link lineEditKeys}' answer for one grain. */
export interface LineEditKeys {
  /**
   * Row-relative dotted keys {@link diffLine} compares, per line `type` (an array
   * is one key, compared whole). PER ARM, because the arms of one input differ:
   * a purchase `sale` line takes no `name` (the writer derives it from the
   * product) while a `service` line does, so a union would read every echoed
   * Buy line as having cleared its name.
   */
  compared: Readonly<Record<string, readonly string[]>>;
  /** Keys a submitted row may not change (ruling 197). */
  serverOwned: readonly string[];
}

/**
 * The formula snapshot's re-derived half: a client names a formula by
 * `price.price_formula.uid` alone (ruling 204 R3, one spelling on both sides),
 * which is an ordinary compared key; the snapshot's `name` and `basis` are the
 * writer's to re-derive (`ItemPriceType`).
 */
const FORMULA_KEYS: ReadonlySet<string> = new Set(["price.price_formula.name", "price.price_formula.basis"]);
/** A row's identity, never an edit: `path` pairs it, `uid` names its product (`cfs-items`). */
const IDENTITY_KEYS: ReadonlySet<string> = new Set(["uid", "path"]);

/** `a.b[].c` → `a.b`: cut at the first array, which is compared whole. */
const cutAtArray = (path: string) => path.split("[]")[0].replace(/\.$/, "");

/** Every row-relative key of a document's `items[]` (or, `prefix` empty, of one row) carrying `meta`, or every key. */
function leafKeys(schema: z.ZodType, meta?: string, prefix = "items[]."): Set<string> {
  const { leaves, unhandled } = collectLeafPaths(schema, { inherit: meta === undefined ? [] : [meta] });
  if (unhandled.length > 0) throw new Error(`line-edit: the schema walk could not read ${JSON.stringify(unhandled)}`);
  const out = new Set<string>();
  for (const leaf of leaves) {
    if (meta !== undefined && leaf.meta[meta] !== true) continue;
    if (!leaf.path.startsWith(prefix)) continue;
    const key = cutAtArray(leaf.path.slice(prefix.length));
    if (key) out.add(key);
  }
  return out;
}

interface Def {
  type: string;
  shape?: Record<string, z.ZodType>;
  innerType?: z.ZodType;
  in?: z.ZodType;
  element?: z.ZodType;
  options?: z.ZodType[];
  values?: unknown[];
  entries?: Record<string, unknown>;
}
const defOf = (n: z.ZodType) => (n as { _zod: { def: Def } })._zod.def;
/** Past optional/nullable/default wrappers and pipes, to the node that has a shape (or the array). */
function unwrapNode(node: z.ZodType): z.ZodType {
  let n = node;
  for (let d = defOf(n); !d.shape && d.type !== "array" && (d.innerType ?? d.in); d = defOf(n)) n = (d.innerType ?? d.in)!;
  return n;
}

/** The arms of an input's `items[]` element, each with the `type` values it takes. */
function inputArms(input: z.ZodType): { types: string[]; arm: z.ZodType }[] {
  const items = unwrapNode(defOf(unwrapNode(input)).shape!.items);
  const element = unwrapNode(defOf(items).element!);
  const options = defOf(element).options ?? [element];
  return options.map((o) => {
    const arm = unwrapNode(o);
    const typeDef = defOf(unwrapNode(defOf(arm).shape!.type));
    const types = (typeDef.values ?? Object.values(typeDef.entries ?? {})) as string[];
    return { types, arm };
  });
}

const keyCache = new Map<LineEditGrain, LineEditKeys>();

/**
 * **The keys a grain's line edit reads, off its schemas** (C10, ruling 197):
 * `compared` = the update input's line keys − the side's `derived` keys − a
 * row's identity − the formula snapshot's re-derived half; `serverOwned` = the
 * stored keys tagged `server_owned`. Memoized per grain.
 */
export function lineEditKeys(grain: LineEditGrain): LineEditKeys {
  const hit = keyCache.get(grain);
  if (hit) return hit;
  const { input, stored } = GRAINS[grain];
  const derived = new Set(stored.flatMap((s) => [...leafKeys(s, "derived")]));
  const serverOwned = [...new Set(stored.flatMap((s) => [...leafKeys(s, SERVER_OWNED_META_KEY)]))].sort();
  const compared: Record<string, readonly string[]> = {};
  for (const { types, arm } of inputArms(input)) {
    const keys = [...leafKeys(arm, undefined, "")]
      .filter((k) => !derived.has(k) && !IDENTITY_KEYS.has(k) && !FORMULA_KEYS.has(k))
      .sort();
    for (const t of types) compared[t] = keys;
  }
  const keys = { compared, serverOwned };
  keyCache.set(grain, keys);
  return keys;
}

// ── diffLine ─────────────────────────────────────────────────────────

/** One key a submitted row changes: `from` the stored value, `to` the submitted one (`null` for absent). */
export interface LineFieldChange {
  key: string;
  from: unknown;
  to: unknown;
}

/** What a submitted row changes against its stored pair. Empty `fields` is no change. */
export interface LineChange {
  fields: LineFieldChange[];
}

/** A line as this module reads it: any grain's stored or submitted row. */
export type LineLike = { [key: string]: unknown };

function getKey(row: LineLike, key: string): unknown {
  let at: unknown = row;
  for (const seg of key.split(".")) {
    if (at === null || typeof at !== "object") return undefined;
    at = (at as Record<string, unknown>)[seg];
  }
  return at;
}

// The one comparison rule (ruling 204 F4.5), shared with the merge and the pair diff.
const same = sameSharedValue;


/**
 * **What a submitted row changes against its stored pair** — by VALUE, over the
 * grain's compared keys ({@link lineEditKeys}), absent ≡ null. It runs FIRST:
 * comparing is what tells an echoed key from an edited one (the bill writer's
 * `grossEdited` read every echoed `stated_cents` as an edit). Derived money a
 * client sends (its optimistic recompute) is never a change.
 */
export function diffLine(grain: LineEditGrain, stored: LineLike, submitted: LineLike): LineChange {
  const fields: LineFieldChange[] = [];
  // The submitted row's arm decides what it may say; a TYPE change is compared
  // too, since `type` is one of every arm's keys.
  const type = String(submitted.type ?? stored.type);
  const keys = lineEditKeys(grain).compared[type];
  if (keys === undefined) throw new Error(`diffLine: a ${grain} line of type "${type}" is not one its input accepts`);
  for (const key of keys) {
    const from = getKey(stored, key);
    const to = getKey(submitted, key);
    if (!same(from, to)) fields.push({ key, from: from ?? null, to: to ?? null });
  }
  return { fields };
}

// ── applyLineEdit ────────────────────────────────────────────────────

/** The closed refusal vocabulary (an explicit tuple, core#43). */
export const LINE_EDIT_REFUSALS: readonly ["server_owned", "discount_exceeds_gross", "uncounted_row", "no_money_input"] = [
  "server_owned",
  "discount_exceeds_gross",
  "uncounted_row",
  "no_money_input",
];
/** One of {@link LINE_EDIT_REFUSALS}. */
export type LineEditRefusalCode = typeof LINE_EDIT_REFUSALS[number];

/** A refusal, pathed relative to the ROW (`["price", "stated_cents"]`); the manager prefixes `items.N`. */
export interface LineEditRefusal {
  code: LineEditRefusalCode;
  path: (string | number)[];
  message: string;
}

/** The posting defaults a cleared account resets to (ruling 196). */
export interface LinePostingDefault {
  account: number | null;
  uid_tracking_category: string | null;
}

/** What a pure function cannot read for itself. */
export interface LineEditContext {
  /**
   * The product's posting defaults per product uid, for a cleared account or
   * tracking category (ruling 196). A line whose uid is absent here is reset to
   * the side's default.
   */
  products: ReadonlyMap<string, LinePostingDefault>;
  /** The side's default account, for a line with no product. */
  default_account: number;
}

/** {@link applyLineEdit}'s answer. */
export type LineEditResult =
  | { ok: true; line: LineLike }
  | { ok: false; refusals: LineEditRefusal[] };

/** Keys whose change moves a STATED line's money: the rate event (D7). */
const STATED_MONEY_KEYS: ReadonlySet<string> = new Set(["price.stated_cents", "quantity", "price.discount.rate", "price.discount.type"]);
/** Keys that put money or a posting on a row. */
const MONEY_KEYS: ReadonlySet<string> = new Set(["price.stated_cents", "price.rates", "price.discount.rate", "price.discount.type"]);

function setKey(row: LineLike, key: string, value: unknown): void {
  const segs = key.split(".");
  let at = row as Record<string, unknown>;
  for (const seg of segs.slice(0, -1)) {
    if (at[seg] === null || typeof at[seg] !== "object") at[seg] = {};
    at = at[seg] as Record<string, unknown>;
  }
  // Written explicitly, `null` included: a row states every key (ruling 204).
  at[segs[segs.length - 1]] = value;
}

/** A line's product uid, or `null` on a custom line (`custom-…`, `payableLineUid`). */
function productUidOf(line: LineLike): string | null {
  const uid = typeof line.uid === "string" ? line.uid : "";
  return uid.startsWith("custom-") ? null : uid;
}

/**
 * **Apply one change to one stored row** — the edited row, or every refusal.
 *
 * - A change to a `server_owned` key is refused (ruling 197).
 * - An UNCOUNTED row ({@link LINE_EDIT_SIDES}) takes no money and no account.
 * - A cleared account or tracking category resets to the product's, or to the
 *   side's default account on a line with no product (ruling 196).
 * - **A STATED line:** a change to its gross, quantity or discount terms — or a
 *   switch to stated — restates its discount cents through `applyDiscountTerms`
 *   on its gross at its quantity (D7, the one rate event); a quantity edit keeps
 *   the gross. A payable line's `amount_cents` is the net.
 * - **A RATE line:** its money is `rates × counts`; a switch from stated needs
 *   rates (`no_money_input`). A payable line's `amount_cents` is the net where
 *   its counts are stated.
 * - A discount larger than the gross is refused on both sides (ruling 195).
 */
export function applyLineEdit(
  grain: LineEditGrain,
  stored: LineLike,
  change: LineChange,
  ctx: LineEditContext,
): LineEditResult {
  const side = LINE_EDIT_SIDES[GRAINS[grain].side];
  const refusals: LineEditRefusal[] = [];
  const serverOwned = new Set(lineEditKeys(grain).serverOwned);
  const uncounted = side.uncounted(stored);
  for (const f of change.fields) {
    const path = f.key.split(".");
    if (serverOwned.has(f.key)) {
      refusals.push({ code: "server_owned", path, message: `${f.key} is the server's; a submitted row may echo it but not change it` });
    }
    const putsMoney = MONEY_KEYS.has(f.key) && !same(f.to, null) && !(f.key === "price.rates" && Array.isArray(f.to) && f.to.length === 0);
    if (uncounted && (putsMoney || (f.key === side.account && f.to !== null))) {
      refusals.push({ code: "uncounted_row", path, message: "an uncounted row carries no account or amount" });
    }
  }
  if (refusals.length > 0) return { ok: false, refusals };
  if (change.fields.length === 0) return { ok: true, line: stored };

  const line = structuredClone(stored) as LineLike;
  for (const f of change.fields) {
    if (f.key === "price.price_formula.uid") {
      // The writer re-derives the snapshot's name and basis (`ItemPriceType`).
      const price = (line.price ??= {}) as Record<string, unknown>;
      price.price_formula = { ...(price.price_formula as object ?? {}), uid: f.to };
      continue;
    }
    setKey(line, f.key, f.to === undefined ? null : f.to);
  }
  const changed = new Set(change.fields.map((f) => f.key));

  // Ruling 196: a cleared posting key resets to the product's (or the side's default).
  if (!uncounted) {
    const product = productUidOf(line);
    const defaults = product === null ? undefined : ctx.products.get(product);
    if (changed.has(side.account) && line[side.account] == null) line[side.account] = defaults?.account ?? ctx.default_account;
    if (changed.has("uid_tracking_category") && line.uid_tracking_category == null) {
      line.uid_tracking_category = defaults?.uid_tracking_category ?? null;
    }
  }

  const price = line.price as Record<string, unknown> | undefined;
  if (price === undefined || uncounted) return { ok: true, line };
  // A discount with no rate left is no discount.
  const discount = price.discount as { rate?: number | null; type?: "percent" | "flat" | null; amount_cents?: number } | null | undefined;
  const terms = discount != null && discount.rate != null && discount.type != null ? { rate: discount.rate, type: discount.type } : null;
  if (discount !== undefined && terms === null) price.discount = null;
  const quantity = typeof line.quantity === "number" ? line.quantity : 0;
  const hasAmount = "amount_cents" in line;

  if (lineKindOf(line as { price: { stated_cents?: number | null } }) === "stated") {
    const kindSwitched = lineKindOf(stored as { price: { stated_cents?: number | null } }) !== "stated";
    if (!kindSwitched && ![...changed].some((k) => STATED_MONEY_KEYS.has(k))) return { ok: true, line };
    const gross = price.stated_cents as number;
    const money = applyDiscountTerms(gross, quantity, terms);
    if (money.amount_cents < 0) {
      return {
        ok: false,
        refusals: [{ code: "discount_exceeds_gross", path: ["price", "discount", "rate"], message: "the discount is larger than the line's amount" }],
      };
    }
    price.discount = money.discount;
    if (hasAmount) line.amount_cents = money.amount_cents;
    return { ok: true, line };
  }

  // A RATE line: its rates price it (ruling 189).
  const rates = (price.rates ?? []) as { rate_key: string; amount_cents: number }[];
  const basis = (price.price_formula as { basis?: string } | null | undefined)?.basis;
  if (rates.length === 0 && basis !== "time") {
    return {
      ok: false,
      refusals: [{ code: "no_money_input", path: ["price", "stated_cents"], message: "a line states its total or the rates it prices from" }],
    };
  }
  const counts = (price.counts ?? []) as { rate_key: string; num: number; den: number }[];
  if (counts.length === 0) {
    // Not metered yet (a time line priced from its pair): the pricer decides its money.
    if (terms !== null) price.discount = { ...terms, amount_cents: 0 };
    return { ok: true, line };
  }
  let money: { subtotal_cents: number; subtotal_discounted_cents: number };
  try {
    money = formulaPartMoney(rates, counts, (line.units_from as number | null | undefined) ?? 0, quantity, terms);
  } catch {
    return { ok: true, line }; // a count naming a rate the line lacks: the pricer refuses it by name
  }
  if (money.subtotal_discounted_cents < 0) {
    return {
      ok: false,
      refusals: [{ code: "discount_exceeds_gross", path: ["price", "discount", "rate"], message: "the discount is larger than the line's amount" }],
    };
  }
  if (terms !== null) price.discount = { ...terms, amount_cents: money.subtotal_cents - money.subtotal_discounted_cents };
  if (hasAmount && basis !== "time") line.amount_cents = money.subtotal_discounted_cents;
  return { ok: true, line };
}

// ── diffItems ────────────────────────────────────────────────────────

/** One paired line and what its submitted row changes. */
export interface PairedLineChange<R> {
  stored: R;
  submitted: R;
  change: LineChange;
}

/** {@link diffItems}' answer. */
export interface ItemsChange<R> {
  /** Every LINE paired with a stored one, changed or not. */
  paired: PairedLineChange<R>[];
  /** Submitted lines no stored line pairs with. */
  added: R[];
  /** Stored lines no submitted line pairs with. */
  removed: R[];
}

/**
 * **Pair a submitted items array with the stored one and diff each line**
 * (rulings 191, 192): pairs through `pairItemsAcrossRebuild` (exact path, then
 * `(uid, component ancestry, k)`, then `(uid, k)`), so a moved or renamed-group
 * line still pairs with the stored row it is. Dividers pair but are not lines.
 */
export function diffItems<R extends PathedItem & { type: string }>(
  grain: LineEditGrain,
  stored: readonly R[],
  submitted: readonly R[],
): ItemsChange<R> {
  const { forward, matched } = pairItemsAcrossRebuild(submitted, stored);
  const paired: PairedLineChange<R>[] = [];
  const added: R[] = [];
  for (const row of submitted) {
    if (!isLineItemType(row.type as never)) continue;
    const pair = forward.get(row);
    if (pair === undefined) added.push(row);
    else paired.push({ stored: pair, submitted: row, change: diffLine(grain, pair as unknown as LineLike, row as unknown as LineLike) });
  }
  const removed = stored.filter((r) => isLineItemType(r.type as never) && !matched.has(r));
  return { paired, added, removed };
}
