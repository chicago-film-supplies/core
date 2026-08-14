/**
 * The two stock documents — Firestore collections: `stock`, `stock-locks`.
 *
 * They replace `stock-summaries` + `public-stock-summaries` (the internal doc and
 * its sanitized twin) with **one** projection, and add the serialization token
 * that gives the oversell gate something to compare-and-set against. See
 * `api-cloudrun/.claude/plans/stock-model.md` for the campaign; the reasoning
 * that has to survive the plan's deletion is here.
 *
 * ## Why one collection now, when there were two
 *
 * The twin existed because {@link Stock}'s predecessor carried a booking's uid,
 * number and full breakdown, none of which an anonymous reader may see — so a
 * second document held the same intervals with the identifying fields stripped,
 * and `audit-stock-summaries.ts` grew an invariant asserting the two agreed
 * byte-for-byte.
 *
 * Pre-reducing removes the reason for the split rather than automating it: an
 * entry is now `{ start, end, quantity, kind }` and there is nothing left to
 * strip, so one document serves the operator UI and the public storefront, under
 * one security rule (`allow read: if true`), with one writer and half the writes.
 * That is affordable **because the projection has exactly one writer** — the
 * rebuild — so changing its shape is a rewrite of one function, not a fan-out.
 *
 * ⚠️ **`kind` is the one thing a reader learns beyond the number, and it is
 * deliberate.** The operator UI's stock panel breaks its count into Booked and
 * Out Of Service, so the distinction has to survive pre-reduction or that feature
 * dies with the twin. What it discloses to an anonymous reader is
 * "unavailable because booked" vs "unavailable because out of service" —
 * materially less than the old internal doc (no uid, no booking number, no order,
 * no OOS reason, no breakdown), and in particular **not correlatable**: a
 * booking's doc id is `orderUid:productUid:destUid`, so a uid-keyed entry would
 * have let an outsider join across products and read *"someone booked these 12
 * items for these dates"*. An anonymous interval cannot. If that trade is ever
 * revisited, the alternative is not "add the twin back" — it is to drop `kind`
 * and have the operator UI count from `bookings` / `out-of-service` directly,
 * which it already reads for the per-section lists.
 *
 * ## The bounds carry no `_fs` twin, on purpose
 *
 * Every *source* datetime is stored twice — the canonical Chicago-offset ISO
 * string and a `_fs` Firestore `Timestamp` — because Firestore orders and
 * range-filters on the `Timestamp`, and `bookings`/`out-of-service` are queried
 * that way. **Nothing queries an array member**, so inside `unavailable[]` the
 * twin buys nothing and costs a second thing to keep in step. One bound per side,
 * in the schema-enforced canonical form.
 *
 * **Null means open-ended** (`start: null` = −∞, `end: null` = +∞) — one rule for
 * bookings and OOS alike, and load-bearing rather than a formality: a pending
 * *sale* booking carries no end date because a sold unit does not come back, so
 * it must keep consuming stock in every window after its sale date until the
 * booking completes and an operator's `sale` transaction drops `quantity_held`.
 * Collapsing a null end to a point would hand those units back as available the
 * day after the sale — a live oversell.
 *
 * ## What is deliberately absent
 *
 * - **No `version`.** Nothing does optimistic concurrency against availability.
 *   The CAS loop that guards a claim is entirely server-side (a precondition
 *   failure is re-read and retried before the client hears anything), and the
 *   public gate's staleness signal is its 409 carrying the real number, so a
 *   client-supplied token would have nothing to do.
 * - **No `type`.** Its predecessor denormed `inventory-ledgers/{P}.type`, and the
 *   only consumer that ever read it was the audit invariant checking it still
 *   matched the ledger — a field whose sole reader is the check that the field is
 *   fresh. Dropping it makes `type_stale` unrepresentable instead of policed.
 */
import { z } from "zod";
import { FirestoreId } from "./_uid.ts";
import { chicagoInstant } from "./_datetime.ts";
import { FirestoreTimestamp, type FirestoreTimestampType } from "./common.ts";

/** What made an interval unavailable. The only non-quantitative fact a reader gets. */
export const STOCK_UNAVAILABLE_KINDS = ["booking", "oos"] as const;
/** Union of {@link STOCK_UNAVAILABLE_KINDS}. */
export type StockUnavailableKindType = typeof STOCK_UNAVAILABLE_KINDS[number];
/** Zod enum for {@link StockUnavailableKindType}. */
export const StockUnavailableKindEnum: z.ZodType<StockUnavailableKindType> = z.enum(
  STOCK_UNAVAILABLE_KINDS,
);

/**
 * One pre-reduced, anonymous unavailable interval.
 *
 * `quantity` is what the source **still consumes**, already folded — a booking
 * contributes `heldByBooking` (which excludes a sale's `out` units, since the
 * sale movement already dropped `quantity_held`), an OOS record contributes its
 * full `quantity` until terminal. An entry that consumes nothing is not written
 * at all: it would affect no answer while disclosing that something exists.
 */
export interface StockUnavailableEntry {
  start: string | null;
  end: string | null;
  quantity: number;
  kind: StockUnavailableKindType;
}

/**
 * Window-independent availability inputs for one product. Doc id == `uid` ==
 * `uid_product` == the product's / inventory-ledger's Firestore id.
 *
 * The window enters only as an overlap filter, so **any** window is derivable
 * from this one document by `computeStockAvailability`
 * (`@cfs/core/utils/stock`) — on the server, in the browser against an
 * `onSnapshot`, or over a plain JSON fixture, with no round-trip and no document
 * minted per question asked.
 */
export interface Stock {
  uid: string;
  uid_product: string;
  quantity_held: number;
  unavailable: StockUnavailableEntry[];
  /**
   * The value of `stock-locks/{P}.seq` this projection was built from — a
   * **watchdog** field, not a client token and not a concurrency guard.
   *
   * It buys one thing: a freshness check that costs **two point reads** (this
   * against the token's `seq`) instead of re-reading every booking and OOS record
   * for the product and re-folding them. That is what makes a frequent check
   * affordable, so the expensive recompute-and-diff can stay on a slow cadence.
   *
   * ⚠️ **It proves the projection SAW every claim, never that it folded them
   * correctly.** An equal `seq` says no claim has landed since the rebuild read
   * its sources; it says nothing about arithmetic, so it does not replace the
   * recompute — it decides how often the recompute has to run.
   */
  claim_seq: number;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}

/**
 * The per-product serialization token — one document per product, whose *only*
 * content is a counter, and whose only writers are claim writers.
 *
 * ## Why the token is a separate document from {@link Stock}
 *
 * A claim has to be serializable per product: read the sources, decide, write —
 * and refuse if anyone claimed the same product in between. Firestore's only
 * write preconditions are `exists` and `lastUpdateTime`; there is no
 * field-value precondition. So the thing being preconditioned on must be a
 * document that **nothing else writes**:
 *
 * - Preconditioning on `stock/{P}` itself fails, because the rebuild writes it
 *   constantly — every claim would lose to a projection refresh that changed
 *   nothing it cared about.
 * - Reading-then-writing one document inside a transaction is the hot-doc
 *   read-modify-write pathology, measured at **60–87 s per contender** against
 *   **1.3–1.5 s** for the compare-and-set form.
 *
 * Hence: read outside, write under `lastUpdateTime`. A loser is told so in
 * ~266 ms and retries against fresh state, rather than blocking to a deadline.
 *
 * ## What a forgotten bump costs, and why that is the cheap failure
 *
 * A writer that claims stock without bumping `seq` loses serialization under an
 * exact race — i.e. a possible oversell, which is what **every** write does
 * today. It fails soft and self-corrects on the next claim. Contrast the shape
 * this design rejected (the projection holding claims as a delta), where the
 * symmetric slip is a claim that is never *released*: stock consumed forever,
 * repairable only by a rebuild. Under a query-rebuilt projection the absence of
 * a row IS the release, and an absence cannot be forgotten.
 */
export interface StockLock {
  uid: string;
  uid_product: string;
  /**
   * Monotonically increasing count of claims made against this product. Only its
   * *movement* is meaningful — nothing reads the value as a quantity.
   */
  seq: number;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}

const StockUnavailableEntrySchema: z.ZodType<StockUnavailableEntry> = z.strictObject({
  start: chicagoInstant().meta({ column: true, label: "Start" }).nullable(),
  end: chicagoInstant().meta({ column: true, label: "End" }).nullable(),
  // `.min(1)` restates the reducers' own rule — an entry that consumes nothing is
  // never emitted — so it cannot fire on anything `unavailableFromBooking` /
  // `unavailableFromOOS` produced. It is here for a hand-built entry, which is
  // the only way a zero could arrive, and which is exactly what should be
  // refused rather than stored as a disclosure that affects no answer.
  quantity: z.int().min(1).meta({ column: true, label: "Quantity" }),
  kind: StockUnavailableKindEnum.meta({ column: true, label: "Kind" }),
});

/** Zod schema for {@link Stock}. */
export const StockSchema: z.ZodType<Stock> = z.strictObject({
  uid: FirestoreId,
  uid_product: FirestoreId,
  // Mirrors `inventory-ledgers/{P}.quantity_held` exactly (`z.number().min(0)`),
  // deliberately NOT tightened to `z.int()`. This is a copy of the ledger's
  // number, and a projection stricter than its source refuses to store a value
  // the source permits — which fails the rebuild rather than the write that
  // created the situation.
  quantity_held: z.number().min(0).meta({ column: true, label: "Quantity Held" }),
  unavailable: z.array(StockUnavailableEntrySchema).default([]).meta({ label: "Unavailable" }),
  claim_seq: z.int().min(0).meta({ column: true, label: "Claim Seq" }),
  created_at: FirestoreTimestamp.meta({ column: true, label: "Created" }),
  updated_at: FirestoreTimestamp.meta({ column: true, label: "Updated" }),
}).meta({
  title: "Stock",
  collection: "stock",
  displayDefaults: {
    columns: ["quantity_held", "unavailable.kind", "unavailable.quantity", "claim_seq"],
    filters: {},
    sort: { column: null, direction: "desc" },
  },
});

/** Zod schema for {@link StockLock}. */
export const StockLockSchema: z.ZodType<StockLock> = z.strictObject({
  uid: FirestoreId,
  uid_product: FirestoreId,
  seq: z.int().min(0).meta({ column: true, label: "Seq" }),
  created_at: FirestoreTimestamp.meta({ column: true, label: "Created" }),
  updated_at: FirestoreTimestamp.meta({ column: true, label: "Updated" }),
}).meta({
  title: "Stock Lock",
  collection: "stock-locks",
  displayDefaults: {
    columns: ["seq", "updated_at"],
    filters: {},
    sort: { column: null, direction: "desc" },
  },
});
