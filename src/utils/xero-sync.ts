/**
 * **Is a billing document's (or an order's quote's) Xero twin up to date?** One
 * projection, one sync status and one push gate for both sides, answered from the
 * document and its `{orders,invoices,purchase-bills}/{uid}/xero-sync/state`
 * watermark alone, with no Xero call (one-document-model F16, ruling 45).
 *
 * ## The projection is declared on the SCHEMA (rulings 120, 124, 125)
 *
 * Every leaf a Xero body reads carries `.meta({ xero: true })` ({@link XERO_META_KEY})
 * on its declaration, and {@link xeroProjection} walks the tagged leaves of a
 * document into a canonical object. There is no hand list: the two per-side
 * projections this replaced (`invoiceXeroProjection`, `purchaseBillXeroProjection`)
 * each restated what their body builder read, and the quote's hash read no field
 * at all.
 *
 * - **A tag on a shared core tags every grain that spreads it**, as `propagate`
 *   does: `tests/item-shape-parity.test.ts` asserts instance identity, so a
 *   per-site tag on `LineItemCore.name` is unrepresentable. The tagged sets are
 *   therefore unions of what the bodies read on a shared node; the cores' tags
 *   also land, inert, on fulfillments, receipts, purchases and credits, which
 *   nothing walks. `tests/xero-sync.test.ts` pins the set per walked schema.
 * - **A shared BLOCK is tagged at the KEY that holds it** (`price.discount`,
 *   `price.taxes`), and the tag is inherited by every leaf beneath it, as `pii`
 *   is; never inside `Discount` / `PriceModifier`, which would tag
 *   `totals.taxes[]` and every other grain's copies.
 * - **An `items[]` element is narrowed to its arm by discriminator**, and an arm
 *   with no tag (a divider) emits nothing at all: it is dropped, not an empty
 *   entry, so adding or moving a divider does not move the hash.
 * - The tag is read from the MERGED meta through wrappers and pipes, never from
 *   instance identity (`.meta()` clones).
 *
 * 🔴 **A tag is a claim; the BODY is the oracle.** api-cloudrun's leaf-perturbation
 * tests drive the real body builders (`api-cloudrun/tests/unit/xeroInvoiceEdit.test.ts`,
 * `api-cloudrun/tests/unit/purchaseBillXeroProjection.test.ts`) and assert both directions:
 * every leaf the body reads moves the hash, and a leaf it does not read moves
 * neither.
 *
 * ## One meaning per watermark field, all three parents
 *
 * `pushed_hash` is {@link xeroProjectionHash} as of the last push that SUCCEEDED;
 * `pushed_body_hash` the hash of the body last sent. Every way a push can fail
 * leaves the watermark behind, so every one shows as out of sync.
 *
 * @module
 */
import type { z } from "zod";
import {
  collectLeafPaths,
  getNodeMeta,
  INVOICE_STATUS_CONTRACTS,
  InvoiceSchema,
  OrderSchema,
  PurchaseBillSchema,
  SETTLEMENT_CONTRACTS,
  SIDE_OF_COLLECTION,
} from "../schemas/mod.ts";
import type {
  Invoice,
  InvoiceStatusContract,
  Order,
  PurchaseBill,
  Settlement,
  Side,
  XeroSyncState,
} from "../schemas/mod.ts";
import { canonicalJson, hash48 } from "./contentHash.ts";
import { ACTION_SIDES } from "./document-actions.ts";
import { invoiceIsFrozen, liveSettlements } from "./invoices.ts";
import { deriveOrderDateEnvelope } from "./orders.ts";

// ── the tag and the walker ───────────────────────────────────────────

/**
 * The meta key that marks a leaf a Xero body reads: `.meta({ xero: true })`. On
 * an object or array key it covers every leaf beneath; `xero: false` beneath
 * opts back out.
 *
 * ⚠️ Meta keys are untyped, so a misspelt tag is silent. The pinned-path test in
 * `tests/xero-sync.test.ts` is the only guard.
 */
export const XERO_META_KEY = "xero";

/** The result of {@link collectXeroProjection}. `unhandled` MUST be empty. */
export interface XeroProjectionResult {
  /** The tagged leaves of the document, nested as they are stored. */
  projection: Record<string, unknown>;
  /** Nodes the walker could not interpret. A non-empty array means the projection is incomplete. */
  unhandled: Array<{ path: string; type: string }>;
}

interface Def {
  type: string;
  innerType?: z.ZodType;
  in?: z.ZodType;
  shape?: Record<string, z.ZodType>;
  element?: z.ZodType;
  valueType?: z.ZodType;
  options?: z.ZodType[];
  discriminator?: string;
}

function def(node: z.ZodType): Def {
  return (node as { _zod: { def: Def } })._zod.def;
}

function propValues(node: z.ZodType): Record<string, Set<unknown>> | undefined {
  return (node as { _zod?: { propValues?: Record<string, Set<unknown>> } })._zod?.propValues;
}

const TRANSPARENT = new Set(["optional", "default", "nullable", "prefault", "catch", "readonly", "nonoptional"]);
const LEAVES = new Set([
  "string",
  "number",
  "boolean",
  "enum",
  "literal",
  "template_literal",
  "custom",
  "unknown",
  "any",
  "null",
  "undefined",
  "date",
  "bigint",
]);

/** The tag state below `node`: its own `xero` meta wins over what it inherited. */
function tagAt(node: z.ZodType, inherited: boolean): boolean {
  const own = getNodeMeta(node);
  return own && XERO_META_KEY in own ? own[XERO_META_KEY] === true : inherited;
}

const taggedCache = [new WeakMap<z.ZodType, boolean>(), new WeakMap<z.ZodType, boolean>()];

/** Does any leaf under `node` carry the tag (given the inherited state)? Static, cached per node. */
function hasTag(node: z.ZodType, inherited: boolean): boolean {
  const cache = taggedCache[inherited ? 1 : 0];
  const hit = cache.get(node);
  if (hit !== undefined) return hit;
  cache.set(node, false); // a cycle answers "no" rather than recursing forever
  const tagged = tagAt(node, inherited);
  const d = def(node);
  let out: boolean;
  if (TRANSPARENT.has(d.type) && d.innerType) out = hasTag(d.innerType, tagged);
  else if (d.type === "pipe" && d.in) out = hasTag(d.in, tagged);
  else if (d.type === "object") out = Object.values(d.shape ?? {}).some((c) => hasTag(c, tagged));
  else if (d.type === "array" && d.element) out = hasTag(d.element, tagged);
  else if (d.type === "record" && d.valueType) out = hasTag(d.valueType, tagged);
  else if (d.type === "union") out = (d.options ?? []).some((o) => hasTag(o, tagged));
  else out = LEAVES.has(d.type) ? tagged : tagged && d.type !== "never";
  cache.set(node, out);
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The member of a discriminated union `value` belongs to, or `null`. */
function unionMember(d: Def, value: Record<string, unknown>): z.ZodType | null {
  if (d.discriminator === undefined) return null;
  const tag = value[d.discriminator];
  return (d.options ?? []).find((o) => propValues(o)?.[d.discriminator!]?.has(tag)) ?? null;
}

const NONE: unique symbol = Symbol("none");

function project(
  node: z.ZodType,
  value: unknown,
  inherited: boolean,
  path: string,
  unhandled: XeroProjectionResult["unhandled"],
): unknown {
  if (!hasTag(node, inherited)) return NONE;
  const tagged = tagAt(node, inherited);
  const d = def(node);
  if (TRANSPARENT.has(d.type) && d.innerType) return project(d.innerType, value, tagged, path, unhandled);
  if (d.type === "pipe" && d.in) return project(d.in, value, tagged, path, unhandled);
  // A tagged leaf the document does not state reads `null`, so absent and null
  // hash alike (the old projections' `?? null`).
  if (value === undefined || value === null) return null;
  if (LEAVES.has(d.type)) return value;
  if (d.type === "object" && d.shape && isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(d.shape)) {
      const r = project(child, value[key], tagged, path ? `${path}.${key}` : key, unhandled);
      if (r !== NONE) out[key] = r;
    }
    return out;
  }
  if (d.type === "array" && d.element && Array.isArray(value)) {
    const element = d.element;
    // An element whose arm carries no tag (a divider) is dropped, not emitted empty.
    return value.map((v) => project(element, v, tagged, `${path}[]`, unhandled)).filter((r) => r !== NONE);
  }
  if (d.type === "record" && d.valueType && isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      const r = project(d.valueType, v, tagged, `${path}.<key>`, unhandled);
      if (r !== NONE) out[key] = r;
    }
    return out;
  }
  if (d.type === "union") {
    if (isPlainObject(value)) {
      const member = unionMember(d, value);
      if (member) return project(member, value, tagged, path, unhandled);
      unhandled.push({ path, type: "union" });
      return NONE;
    }
    // A scalar union (`z.union([z.int(), z.string()])`): the value is the leaf.
    if (tagged) return value;
  }
  unhandled.push({ path, type: d.type });
  return NONE;
}

/**
 * Walk `doc` against `schema`, keeping every leaf tagged {@link XERO_META_KEY}.
 * Fails closed: a node it cannot interpret lands in `unhandled`.
 */
export function collectXeroProjection(schema: z.ZodType, doc: unknown): XeroProjectionResult {
  const unhandled: XeroProjectionResult["unhandled"] = [];
  const r = project(schema, doc, false, "", unhandled);
  return { projection: isPlainObject(r) ? r : {}, unhandled };
}

/** {@link collectXeroProjection}'s projection; throws when the walk is incomplete. */
export function xeroProjection(schema: z.ZodType, doc: unknown): Record<string, unknown> {
  const { projection, unhandled } = collectXeroProjection(schema, doc);
  if (unhandled.length > 0) {
    throw new Error(`xeroProjection: unhandled nodes ${unhandled.map((u) => `${u.path} (${u.type})`).join(", ")}`);
  }
  return projection;
}

/** The hash of {@link xeroProjection}: what `pushed_hash` records. */
export function xeroProjectionHash(schema: z.ZodType, doc: unknown): string {
  return hash48(canonicalJson(xeroProjection(schema, doc)));
}

/**
 * The static set of tagged leaf paths of `schema` (`collectLeafPaths` with the
 * tag inherited), sorted and deduplicated. Throws when the walk is incomplete.
 */
export function xeroTaggedPaths(schema: z.ZodType): string[] {
  const { leaves, unhandled } = collectLeafPaths(schema, { inherit: [XERO_META_KEY] });
  if (unhandled.length > 0) {
    throw new Error(`xeroTaggedPaths: unhandled nodes ${unhandled.map((u) => `${u.path} (${u.type})`).join(", ")}`);
  }
  return [...new Set(leaves.filter((l) => l.meta[XERO_META_KEY] === true).map((l) => l.path))].sort();
}

// ── the billing roles, both sides ────────────────────────────────────

/** A billing document as the Xero sync reads it, per side. */
export interface BillingXeroDocuments {
  receivable: Pick<Invoice, "status" | "xero_id"> & Partial<Invoice>;
  payable: Pick<PurchaseBill, "status" | "xero_id" | "origin" | "totals"> & Partial<PurchaseBill>;
}

/** The schema whose tags each side's projection walks. */
const BILLING_XERO_SCHEMAS: Readonly<Record<Side, z.ZodType>> = {
  receivable: InvoiceSchema,
  payable: PurchaseBillSchema,
};

/** The hash a successful push records as a billing document's `pushed_hash`. */
export function billingXeroProjectionHash<S extends Side>(side: S, doc: Partial<BillingXeroDocuments[S]>): string {
  return xeroProjectionHash(BILLING_XERO_SCHEMAS[side], doc);
}

/**
 * - `in_sync` — the Xero-carried fields are what was last pushed.
 * - `out_of_sync` — they have changed since and no push has landed; or the
 *   document is live and has no `xero_id` at all, because its create never landed.
 * - `unknown` — linked and live, but no push has recorded a hash. Not a claim either way.
 * - `not_applicable` — no Xero twin to keep in step: a draft or a void; a
 *   `paid` / `credited` document no push has recorded a hash for (its status's
 *   `tracks_xero_edits` is `"once_pushed"`); a LINKED payable document once
 *   settled (its money is Xero's, so CFS sends it nothing).
 */
export type BillingXeroSyncStatus = "in_sync" | "out_of_sync" | "unknown" | "not_applicable";

/**
 * See {@link BillingXeroSyncStatus}: one function, both sides, on the status
 * contract's `tracks_xero_edits` column. `state` is the watermark, or `null`
 * when absent.
 *
 * ⚠️ **A settled pushed document still compares.** Out of sync is a true
 * statement about Xero whether or not CFS can do anything about it; settlement
 * only loses the push (`pushRefusal`).
 */
export function billingXeroSyncStatus<S extends Side>(
  side: S,
  doc: BillingXeroDocuments[S],
  state: Pick<XeroSyncState, "pushed_hash"> | null,
): BillingXeroSyncStatus {
  const tracks = (INVOICE_STATUS_CONTRACTS as Record<string, InvoiceStatusContract | undefined>)[doc.status]
    ?.tracks_xero_edits ?? null;
  if (tracks === null) return "not_applicable";
  // A LINKED document's money and lines are Xero's: once settled CFS sends it
  // nothing. The receivable side is never linked.
  if (
    ACTION_SIDES[side].authorship(doc) === "linked" &&
    invoiceIsFrozen(doc as BillingXeroDocuments["payable"])
  ) return "not_applicable";
  const pushed = state?.pushed_hash ?? null;
  if (tracks === "once_pushed" && (!doc.xero_id || pushed === null)) return "not_applicable";
  if (!doc.xero_id) return "out_of_sync";
  if (pushed === null) return "unknown";
  return pushed === billingXeroProjectionHash(side, doc) ? "in_sync" : "out_of_sync";
}

/**
 * **Should this write enqueue a Xero edit push?** The one enqueue gate, both
 * sides (ruling 122; api-cloudrun#1332).
 *
 * - `old.xero_id` must be set. The create path patches `xero_id` onto the
 *   document before it writes the watermark, so that write would read `unknown`
 *   and enqueue an edit push for a document whose create has only just landed.
 * - The new state must read `out_of_sync` or `unknown` against the watermark.
 *
 * Nothing here compares `old` to `next`. A write that changes no Xero-carried
 * field still enqueues while an earlier edit's push has not landed: the earlier
 * task may already have been superseded by this write.
 */
export function shouldPushBillingToXero<S extends Side>(
  side: S,
  old: Partial<BillingXeroDocuments[S]> | null | undefined,
  next: Partial<BillingXeroDocuments[S]> | null | undefined,
  state: Pick<XeroSyncState, "pushed_hash"> | null,
): boolean {
  // Both sides are `Partial` because that is what an Eventarc write carries; a
  // delete (no `next`) or a document with no status has nothing to push.
  if (!old?.xero_id || !next?.status) return false;
  const status = billingXeroSyncStatus(side, { ...next, xero_id: next.xero_id ?? null } as BillingXeroDocuments[S], state);
  return status === "out_of_sync" || status === "unknown";
}

// ── the quote (ruling 125) ───────────────────────────────────────────

/**
 * The inputs a quote body reads that are not stored leaves of the order — each
 * moves the hash (`tests/xero-sync.test.ts`).
 *
 * - `target_status` — api-cloudrun's `computeXeroQuoteTargetStatus(order)`. An
 *   invoice issue or void moves `order.invoices[].status` without bumping
 *   `version`, and the expiry sweep moves nothing stored at all, so the target
 *   is what reopens the gate for both.
 * - `delivery_start` — `deriveOrderDateEnvelope(destinations).delivery_start`,
 *   which the body's `Date` and `ExpiryDate` read. Derived rather than tagged
 *   because the pair schema is shared with invoices and bills, and a tag there
 *   would move their hashes on every pair date edit.
 */
export interface XeroQuoteDerivedInputs {
  target_status: string | null;
  delivery_start: string | null;
}

/** The order's tagged leaves plus {@link XeroQuoteDerivedInputs}. */
export function xeroQuoteProjection(
  order: Partial<Order> & Pick<Order, "destinations">,
  targetStatus: string | null,
): { document: Record<string, unknown>; derived: XeroQuoteDerivedInputs } {
  return {
    document: xeroProjection(OrderSchema, order),
    derived: {
      target_status: targetStatus,
      delivery_start: deriveOrderDateEnvelope(order.destinations).delivery_start ?? null,
    },
  };
}

/** The hash an order's quote sidecar records as `pushed_hash`; the quote gate and supersede key. */
export function xeroQuoteProjectionHash(
  order: Partial<Order> & Pick<Order, "destinations">,
  targetStatus: string | null,
): string {
  return hash48(canonicalJson(xeroQuoteProjection(order, targetStatus)));
}

// ── settlements Xero holds ───────────────────────────────────────────

/**
 * The live rows settling a `side` billing document that **Xero holds** — a
 * payment or credit allocation carrying its Xero id (`xero_id` set, on a type
 * whose contract names a `xero_object`). Xero refuses an edit to an invoice
 * carrying one, so the edit push stops at a manual seam when this is non-empty.
 *
 * ⚠️ **Takes the side** (ruling 44): with unprefixed types a payable `payment`
 * is a `payment`, so a reader that did not name the side would match a bill's
 * rows silently. A row of the other side, or one naming no billing document (a
 * refund), is skipped — the caller read by `billing.uid`, so it holds none.
 *
 * ⚠️ **Not CFS's `status` or `amount_paid_cents`.** A payment an operator records
 * in CFS has no Xero id until Xero reports it, and Xero accepts an edit until
 * then. When CFS lags Xero, this reads empty and Xero's own ValidationException
 * is the seam. Reversed rows are skipped; reversers carry no Xero id by contract.
 */
export function settlementsHeldByXero<
  T extends Pick<Settlement, "uid" | "type" | "reverses" | "xero_id" | "billing">,
>(side: Side, settlements: readonly T[]): T[] {
  return liveSettlements(settlements).filter((s) => {
    const contract = SETTLEMENT_CONTRACTS[s.type];
    if (contract?.settles !== "billing" || contract.xero_object === null) return false;
    if (s.billing === null || SIDE_OF_COLLECTION[s.billing.collection] !== side) return false;
    return s.xero_id !== null;
  });
}

// ── the line refs (6e-0b4 K2.3) ──────────────────────────────────────

/** The product fields {@link xeroLineRefs} reads — a structural slice of `Product`. */
export interface XeroLineProduct {
  xero_tracking_option_id?: string | null;
  xero_code?: string | null;
}

/**
 * A tracking category's Xero option id, by `tracking-categories` uid — the
 * lookup {@link xeroLineRefs} resolves a line's `uid_tracking_category`
 * through. The API builds it from its category cache; a uid with no entry, or a
 * `null` option, resolves to nothing.
 */
export type XeroOptionByCategoryUid = ReadonlyMap<string, string | null>;

/** What one Xero line names besides its money and tax. */
export interface XeroLineRefs {
  /** Xero `AccountCode`: the posting account the caller passed. */
  account_code: string;
  /**
   * The tracking option to send, or `null` for none. Not yet checked against
   * Xero when it came from the product or is a custom line's own: the API's
   * `resolveXeroTracking` drops (and logs) an option Xero does not know.
   */
  tracking_option_id: string | null;
  /** Xero `ItemCode`: the product's own Xero code, or `null` to omit it. */
  item_code: string | null;
}

/**
 * **The one rule for which account, tracking option and item code a Xero line
 * carries**, on both sides and every role (6e-0b4 K2.3, replacing the
 * receivable-only `xeroAccrecLineRefs`).
 *
 * - **Account: the caller's.** The line's posting account differs by side
 *   (`coa_revenue ?? product's ?? 4800` on a receivable initiator or billing
 *   line until Phase 8, `ledger_account` everywhere else), and a side branch
 *   here is what `SIDE_COMPARISON_RE` refuses, so the caller passes it.
 * - **Tracking: the line's category's option when Xero still knows it, else
 *   the product's** (owner, 2026-10-26). The option is looked up from the
 *   line's `uid_tracking_category` through `optionByCategoryUid` at build time;
 *   the line stores no option id. An option Xero has since retired falls back
 *   rather than sending none. A line with no product sends its own category's.
 * - **Item code: the product's `xero_code`**, never `crms_id` (#256).
 *
 * A `custom-` line is never matched to a product, whatever the caller passes.
 * The tax mapping and the money stay in the API.
 */
export function xeroLineRefs(
  line: { uid: string; uid_tracking_category?: string | null },
  product: XeroLineProduct | undefined,
  accountCode: string,
  optionByCategoryUid: XeroOptionByCategoryUid,
  knownTrackingOptionIds: ReadonlySet<string>,
): XeroLineRefs {
  const p = line.uid.startsWith("custom-") ? undefined : product;
  const lineOption = line.uid_tracking_category == null
    ? null
    : optionByCategoryUid.get(line.uid_tracking_category) ?? null;
  const productOption = p?.xero_tracking_option_id ?? null;
  return {
    account_code: accountCode,
    tracking_option_id: lineOption !== null && knownTrackingOptionIds.has(lineOption)
      ? lineOption
      : productOption ?? lineOption,
    item_code: p?.xero_code ?? null,
  };
}
