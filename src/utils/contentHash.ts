/**
 * Deterministic content hashing, shared by the API and the manager.
 *
 * Two jobs, one implementation, so the two sides cannot drift:
 *
 * 1. **Content-addressed Cloud Task names and Xero push watermarks** (api-cloudrun) —
 *    `${prefix}-${literalId}-${hash48(canonicalJson(state))}` makes duplicate
 *    eventarc redeliveries of the SAME state collide (409 → dedup to one task)
 *    while any real state change mints a new name. Keeping the id literal keeps
 *    the hash namespace per-entity, so a 48-bit hash is ample.
 * 2. **"Is the saved version of this document out of date?"** — a saved quote or
 *    invoice PDF records {@link documentSourceHash} of the document it was
 *    rendered from, and the manager recomputes it over the live document. A
 *    difference is the flag. See {@link isSourceHashStale}.
 *
 * ⚠️ **`hash48` and `canonicalJson` are BYTE-STABLE by contract.** Their output is
 * persisted (Xero's `pushed_hash`) and used as a dedup key, so changing either
 * re-pushes or re-renders every document once. They moved here verbatim from
 * api-cloudrun's own `contentHash` module (since deleted); do not "improve" them.
 */

/** 48-bit FNV-1a of a string, base36 — compact, deterministic, no deps. */
export function hash48(input: string): string {
  // FNV-1a over 64-bit BigInt, masked to 48 bits so it stays well inside
  // Number range when re-parsed and short as base36 (~10 chars).
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = (1n << 64n) - 1n;
  for (let i = 0; i < input.length; i++) {
    h = (h ^ BigInt(input.charCodeAt(i))) * prime & mask;
  }
  return (h & ((1n << 48n) - 1n)).toString(36);
}

/**
 * Stable JSON serialization: object keys are sorted recursively so the output
 * is invariant to key insertion order.
 *
 * This matters for hashing a Firestore-event document: `unwrapProtoValue`
 * (api-cloudrun `firestoreEvent.ts`) builds maps by iterating a proto field map
 * whose order is not guaranteed stable across redeliveries, so a plain
 * `JSON.stringify` would let the hash flap and defeat dedup on redelivery.
 * Arrays keep their order (order is semantic there). Any object exposing
 * `toJSON` (e.g. a firebase-admin `Timestamp`, which serializes to a stable
 * `{_seconds,_nanoseconds}`) is emitted via its `toJSON` form rather than
 * recursed into.
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
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" +
    keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(obj[k])).join(",") +
    "}";
}

// ─── documentSourceHash ──────────────────────────────────────────────────────

/**
 * What a PDF was rendered from. Three kinds, because the order-derived
 * documents do not read the same fields: a quote renders the order alone, while
 * the packing list renders a PICK SHEET, which folds the order's open bookings —
 * so `bookings_breakdown` is input to the second and noise to the first.
 */
export type SourceHashKind = "order" | "packing-list" | "invoice";

/**
 * Bumped whenever the NORMALIZATION or an exclusion set changes in a way that
 * moves the hash of an unchanged document. It is the first token of every
 * hash, so {@link isSourceHashStale} can tell "the document changed" from "the
 * two sides disagree about how to hash" and answer *not stale* for the second.
 */
export const SOURCE_HASH_VERSION = 1;

/**
 * Top-level keys that never change what an order-derived document (quote,
 * packing list) renders.
 *
 * Each entry is a claim that **no template reads it** — checked against the
 * `templates/` repo 2026-09-23 (`bookings_breakdown`, `query_by_*`, `invoices`,
 * `xero_id`, `uid_thread`, `crms_*`: no `.eta` file or partial names any of
 * them; `it.invoices` there is the invoice util namespace, not the order field).
 * ⚠️ **The failure is one-sided and quiet**: an entry that IS rendered means a
 * saved version never flags when that field changes; an entry missing here only
 * flags a version that did not need it. Re-grep before adding a template that
 * reads one of these.
 *
 * `bookings_breakdown` and `invoices` are the two that earn their place for
 * behaviour, not tidiness: they change on every checkout, return and invoice
 * creation, so leaving them in would flag every saved quote "out of date" after
 * the most ordinary events in an order's life.
 *
 * ⚠️ This is NOT api-cloudrun's `ORDER_FANOUT_EXCLUDED_FIELDS`, and must not be
 * merged with it: that set answers "does any fan-out JOB read this", this one
 * answers "does any TEMPLATE render this". The two have different readers, so a
 * field added to one for its own reason would silently narrow the other.
 */
export const ORDER_SOURCE_HASH_EXCLUDED_FIELDS: ReadonlySet<string> = new Set([
  "uid",
  "version",
  "updated_at",
  "created_by",
  "updated_by",
  "bookings_breakdown",
  "invoices",
  "query_by_invoices",
  "query_by_items",
  "query_by_contacts",
  "query_by_dates",
  "xero_id",
  "uid_thread",
  "crms_id",
  "crms_status",
]);

/**
 * {@link ORDER_SOURCE_HASH_EXCLUDED_FIELDS} minus `bookings_breakdown`.
 *
 * The packing list renders a pick sheet (`completePickSheet` in api-cloudrun),
 * which folds only the order's OPEN bookings, and `bookings_breakdown` is the
 * order-side record of exactly that progress — it is what moves when a booking
 * is picked or closed. Excluding it would serve a stale sheet after a pick;
 * including it for a QUOTE would flag every saved quote after every checkout.
 * Each kind takes the answer that is right for what it renders.
 */
export const PACKING_LIST_SOURCE_HASH_EXCLUDED_FIELDS: ReadonlySet<string> = new Set(
  [...ORDER_SOURCE_HASH_EXCLUDED_FIELDS].filter((k) => k !== "bookings_breakdown"),
);

/**
 * Top-level keys that never change what an invoice PDF renders.
 *
 * The first block is the PDF pipeline's own write-back — everything
 * `generateInvoicePdf` / `saveInvoicePdfVersion` stamp on the invoice they just
 * rendered. Hashing any of it would make a save change the very hash it
 * records. The second block is bookkeeping no template reads.
 *
 * ⚠️ `totals` is deliberately NOT excluded: the invoice template prints
 * `amount_paid_cents` / `amount_credited_cents` / `amount_due_cents`, so a
 * payment landing after a save legitimately makes that saved PDF out of date.
 */
export const INVOICE_SOURCE_HASH_EXCLUDED_FIELDS: ReadonlySet<string> = new Set([
  "uid",
  "version",
  "updated_at",
  "created_by",
  "updated_by",
  // PDF pipeline write-back.
  "uploadcare_uuid",
  "pdf_generated_at",
  "pdf_params",
  "pdf_params_context",
  "pdf_versions",
  // Bookkeeping no template reads.
  "xero_id",
  "query_by_orders",
  "query_by_out_of_service",
  "uid_thread",
  "crms_id",
  "crms_opportunity_ids",
]);

const EXCLUDED_BY_KIND: Readonly<Record<SourceHashKind, ReadonlySet<string>>> = {
  order: ORDER_SOURCE_HASH_EXCLUDED_FIELDS,
  "packing-list": PACKING_LIST_SOURCE_HASH_EXCLUDED_FIELDS,
  invoice: INVOICE_SOURCE_HASH_EXCLUDED_FIELDS,
};

const TIMESTAMP_KEYS: ReadonlySet<string> = new Set([
  "seconds",
  "nanoseconds",
  "_seconds",
  "_nanoseconds",
  "type",
]);

/**
 * `{seconds,nanoseconds}` → `"ts:<s>.<ns>"`, or `null` when `value` is not a
 * Firestore timestamp in either SDK's spelling.
 *
 * 🔴 **This is the parity trap.** The Admin SDK holds `_seconds`/`_nanoseconds`
 * (public getters `seconds`/`nanoseconds`); the web SDK holds `seconds` /
 * `nanoseconds` and serializes with a `type` tag. Left alone they hash
 * differently for the same instant, and every saved version would read as out
 * of date. Orders carry four `_fs` timestamps, so this is not a corner case.
 */
function timestampToken(value: object): string | null {
  const keys = Object.keys(value);
  if (keys.length === 0 || !keys.every((k) => TIMESTAMP_KEYS.has(k))) return null;
  const v = value as {
    seconds?: unknown;
    nanoseconds?: unknown;
    _seconds?: unknown;
    _nanoseconds?: unknown;
  };
  const s = typeof v.seconds === "number" ? v.seconds : v._seconds;
  const ns = typeof v.nanoseconds === "number" ? v.nanoseconds : v._nanoseconds;
  return typeof s === "number" && typeof ns === "number" ? `ts:${s}.${ns}` : null;
}

/**
 * A JSON-shaped copy of `value` in which every timestamp is one token, every
 * `undefined` object member is ABSENT (a stored document never carries one, a
 * client cache may), and every `Date` is its ISO string.
 */
function normalizeForSourceHash(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object") return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalizeForSourceHash);
  const token = timestampToken(value);
  if (token !== null) return token;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (v !== undefined) out[k] = normalizeForSourceHash(v);
  }
  return out;
}

/**
 * The canonical string {@link documentSourceHash} hashes. Exported for tests and
 * for diagnosing a disagreement: two sides that differ in the hash can be
 * diffed here.
 */
export function documentSourceCanonical(
  kind: SourceHashKind,
  doc: object,
): string {
  const excluded = EXCLUDED_BY_KIND[kind];
  const content: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(doc)) {
    if (!excluded.has(k) && v !== undefined) content[k] = v;
  }
  return canonicalJson(normalizeForSourceHash(content));
}

/**
 * What a saved quote / invoice PDF was rendered FROM, as a short token.
 *
 * Pass the document **as stored** — the Firestore snapshot's data on the API
 * side and the raw snapshot data on the manager side — never a Zod-parsed copy:
 * a parse materializes schema defaults, and those depend on which `@cfs/core`
 * each side pins, while the two products deploy on independent release trains.
 * A raw document changes only when the document does.
 *
 * Form: `"<SOURCE_HASH_VERSION>:<hash48>"`, e.g. `"1:abc123def"`.
 */
export function documentSourceHash(
  kind: SourceHashKind,
  doc: object,
): string {
  return `${SOURCE_HASH_VERSION}:${hash48(documentSourceCanonical(kind, doc))}`;
}

/**
 * Is a saved version out of date against the live document?
 *
 * `false` — never a flag — when the saved version recorded no hash (`null` or
 * absent: every version saved before this existed), or recorded one under a
 * different {@link SOURCE_HASH_VERSION}, since a hash the two sides compute
 * differently says nothing about the document.
 */
export function isSourceHashStale(
  stored: string | null | undefined,
  live: string,
): boolean {
  if (stored === null || stored === undefined || stored === "") return false;
  const storedColon = stored.indexOf(":");
  const liveColon = live.indexOf(":");
  // A token with no version prefix is not one this function can compare.
  if (storedColon < 0 || liveColon < 0) return false;
  if (stored.slice(0, storedColon) !== live.slice(0, liveColon)) return false;
  return stored !== live;
}
