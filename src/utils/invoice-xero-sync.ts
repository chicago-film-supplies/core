/**
 * **Is this issued invoice's Xero twin up to date?** — answered from the invoice
 * and its `invoices/{uid}/xero-sync/state` watermark alone, with no Xero call.
 *
 * ## Why it exists (api-cloudrun#1009, gate (c) of the order-propagation plan)
 *
 * An edit to an issued invoice reaches Xero through `/tasks/push-xero-invoice`.
 * When that push does not land — Xero refuses the payload (the task is dropped),
 * Cloud Tasks exhausts its retries, the day budget defers it to abandonment, or
 * the invoice needs manual intervention (payments applied) — the only record was
 * a log line. The invoice looked fine.
 *
 * So the state is DERIVED rather than recorded: the watermark's `pushed_hash` holds
 * the hash of {@link invoiceXeroProjection} as of the last push that SUCCEEDED, and the invoice
 * is out of sync whenever its current projection hashes differently. Every failure
 * mode above leaves the watermark behind, so every one shows, including those no
 * handler ever observes (a dropped task, a retry exhausted after the process died).
 *
 * ## One author for the projection
 *
 * The projection is also what decides whether a write enqueues an edit push
 * (`api-cloudrun/src/lib/xeroInvoiceEdit.ts` `shouldEnqueueInvoiceEditPush`). It
 * lives here so the push trigger and the out-of-sync badge cannot disagree about
 * what "the part Xero carries" means: a change that should have pushed and did not
 * is exactly a change this reports.
 *
 * @module
 */
import type { Invoice, XeroSyncState } from "../schemas/mod.ts";
import { isInvoiceLineItem } from "../schemas/mod.ts";

/**
 * The part of an invoice that the Xero update body is built from.
 *
 * ⚠️ **Money totals and `status` are deliberately absent.** A settlement writer
 * advances `version` and moves `status` / `amount_*_cents` without touching a
 * line, and Xero learns of a payment from its own ledger, not from a push.
 *
 * ⚠️ **Lines are projected to what the body reads, never compared whole.**
 * api-cloudrun's `assembleXeroInvoiceUpdateBody` reads, per billable line: `uid`,
 * `name`, `quantity`, `coa_revenue`, `price.subtotal_cents`, `price.discount`,
 * and each tax's `uid` and `amount_cents`. Comparing `items` whole made every
 * key-only change a real Xero POST (api-cloudrun#993). api-cloudrun's
 * `tests/unit/xeroInvoiceEdit.test.ts` perturbs every leaf of a real line through
 * the real assembler, so a field the body starts reading cannot be missing here
 * unnoticed.
 */
export function invoiceXeroProjection(invoice: Partial<Invoice>): unknown {
  return {
    items: invoice.items?.filter(isInvoiceLineItem).map((line) => ({
      uid: line.uid,
      name: line.name ?? null,
      quantity: line.quantity ?? null,
      coa_revenue: line.coa_revenue ?? null,
      subtotal_cents: line.price?.subtotal_cents ?? null,
      discount: line.price?.discount ?? null,
      taxes: (line.price?.taxes ?? []).map((tax) => ({ uid: tax.uid, amount_cents: tax.amount_cents ?? 0 })),
    })) ?? null,
    date: invoice.date ?? null,
    due_date: invoice.due_date ?? null,
    reference: invoice.reference ?? null,
    subject: invoice.subject ?? null,
    contact: invoice.organization?.xero_id ?? null,
  };
}

/**
 * Stable JSON: object keys sorted recursively, arrays in order. An object with
 * `toJSON` (a Firestore `Timestamp`) serializes through it.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalJson).join(",") + "]";
  }
  if (typeof (value as { toJSON?: unknown }).toJSON === "function") {
    return JSON.stringify(value);
  }
  const obj = value as { [key: string]: unknown };
  return "{" + Object.keys(obj).sort().map((k) => JSON.stringify(k) + ":" + canonicalJson(obj[k])).join(",") + "}";
}

/** 48-bit FNV-1a of a string, base36. Deterministic, dependency-free, browser-safe. */
export function hash48(input: string): string {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = (1n << 64n) - 1n;
  for (let i = 0; i < input.length; i++) {
    h = (h ^ BigInt(input.charCodeAt(i))) * prime & mask;
  }
  return (h & ((1n << 48n) - 1n)).toString(36);
}

/** The hash a successful push records as the invoice sidecar's `pushed_hash`. */
export function invoiceXeroProjectionHash(invoice: Partial<Invoice>): string {
  return hash48(canonicalJson(invoiceXeroProjection(invoice)));
}

/**
 * - `in_sync` — the invoice's Xero-carried fields are what was last pushed.
 * - `out_of_sync` — they have changed since, and no push has landed; OR the invoice
 *   is issued and has no `xero_id` at all, because the issue POST never landed
 *   (a non-throttle refusal is logged and the status flip is not rolled back). For
 *   the moment between the status commit and the POST this reads out of sync too,
 *   which is true.
 * - `unknown` — linked and live, but no push has recorded a projection hash: no
 *   sidecar, or one written before this carried a hash (its `pushed_hash` is the
 *   old `v<version>` spelling). Not a claim either way.
 * - `not_applicable` — no Xero twin to keep in step: a draft, a void, or a paid
 *   invoice (exempt by owner rule).
 */
export type InvoiceXeroSyncStatus = "in_sync" | "out_of_sync" | "unknown" | "not_applicable";

/**
 * The spelling invoice sidecars carried before this module: `v<version>`. A hash
 * could in principle take that shape; if one ever did, it reads `unknown` — the
 * no-claim answer — rather than a wrong one.
 */
const LEGACY_VERSION_WATERMARK = /^v\d+$/;

/** Statuses whose Xero twin is live and should track CFS edits. */
const TRACKED_STATUSES: ReadonlySet<string> = new Set(["issued", "part_paid"]);

/** See {@link InvoiceXeroSyncStatus}. `state` is the watermark, or `null` when absent. */
export function invoiceXeroSyncStatus(
  invoice: Pick<Invoice, "status" | "xero_id"> & Partial<Invoice>,
  state: Pick<XeroSyncState, "pushed_hash"> | null,
): InvoiceXeroSyncStatus {
  if (!TRACKED_STATUSES.has(invoice.status)) return "not_applicable";
  if (!invoice.xero_id) return "out_of_sync";
  const pushed = state?.pushed_hash ?? null;
  if (pushed === null || LEGACY_VERSION_WATERMARK.test(pushed)) return "unknown";
  return pushed === invoiceXeroProjectionHash(invoice) ? "in_sync" : "out_of_sync";
}
