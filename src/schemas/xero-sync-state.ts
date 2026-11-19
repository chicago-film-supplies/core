/**
 * XeroSyncState document schema — Firestore sidecar:
 * `{orders,invoices,purchase-bills}/{uid}/xero-sync/state`.
 *
 * The hash of the document state that was last **successfully** pushed to Xero
 * (an order as a Quote, an invoice or a bill as itself). Every enqueue gate reads
 * it: recompute the document's tagged Xero projection (`utils/xero-sync.ts`), and
 * if it equals `pushed_hash`, don't enqueue at all. **One meaning per field, all
 * three parents** (one-document-model F16).
 *
 * **Why a persisted hash rather than a stateless `event.oldValue` diff.** Both
 * suppress the storm (a migration touching unrelated fields enqueues nothing),
 * but they diverge on the case that matters:
 *
 * | | stateless diff | persisted hash |
 * |---|---|---|
 * | push **succeeded**, later unrelated write | no enqueue | no enqueue |
 * | push **failed** (400-breaker drop, max_attempts), later write | **no enqueue — the drop is permanent** | hash never advanced → re-enqueues → **self-heals** |
 *
 * Today's self-heal ("a missed enqueue self-heals on the order's next write")
 * is *accidental* — it works only because the enqueue is unconditional. A
 * stateless gate would silently destroy it and force a reconcile sweep to buy
 * it back. The persisted hash preserves it by construction: the hash only
 * advances on a **successful** push.
 *
 * **Why a sidecar subdoc rather than a field on the order.** A field on the
 * order would re-fire `afterOrderWrite` on every push. Even a non-version-
 * bumping `ref.update()` costs an extra eventarc round-trip per push; and a
 * version-bumping write-back would be actively harmful — it re-mints the
 * `order-docs-` / `draft-quote-` / `calendar-` / `trello-{uid}-v{N+1}` task
 * names under *fresh* names whose supersede checks all **pass**, paying a CRMS
 * doc regen + a Gotenberg PDF + a Calendar write + a Trello write per Xero
 * push. The sidecar keeps the hot order doc clean and mirrors the existing
 * `orders/{uid}/task-leases` pattern.
 */
import { z } from "zod";
import { FirestoreTimestamp, type FirestoreTimestampType } from "./common.ts";

/** The per-order Xero-quote sync watermark (`orders/{uid}/xero-sync/state`). */
export interface XeroSyncState {
  uid: "state";
  /**
   * The Xero PROJECTION hash of the document as of its last push that
   * **succeeded** — `billingXeroProjectionHash` for an invoice or a bill,
   * `xeroQuoteProjectionHash` for an order (`utils/xero-sync.ts`): the leaves
   * tagged `.meta({ xero: true })`, plus the quote's derived inputs. Advances only
   * after a successful push, so a push that never landed reads out of sync
   * (`billingXeroSyncStatus`; api-cloudrun#1009).
   */
  pushed_hash: string;
  /**
   * `hash48` of the Xero **body** that was last successfully pushed — the
   * SECOND, independent watermark (api-cloudrun#703). `null` when the last write
   * sent no body CFS built for an edit (an issue or a create).
   *
   * The two answer different questions and neither replaces the other:
   *
   * | | `pushed_hash` | `pushed_body_hash` |
   * |---|---|---|
   * | question | *has the document moved since we pushed?* | *would we send the same bytes?* |
   * | cost | free — pure, from the order alone | 1–4 Firestore reads, O(items) |
   * | where | the enqueue gate + the Cloud Task name | inside the task, before the first Xero call |
   *
   * 🔴 **The body hash is a PURE SUPPRESSOR, and that is the property that makes
   * it safe.** It is only ever reached once the cheap gate has already fired, so
   * it can never *add* a push. That matters because the body is not a pure
   * function of the document — it folds in `product.price.coa_revenue`,
   * `product.xero_code`, the `tracking-categories` corpus and the `taxes` docs,
   * two of which ride process-lifetime memo caches with no TTL. As a suppressor,
   * two instances with divergent caches merely disagree about whether to skip;
   * as an *enqueue* gate they would push work back and forth at each other,
   * unbounded, against a live ~1,000-call/day quota.
   *
   * ⚠️ Nullable **and** optional: every sidecar written before this field
   * existed still has to parse a `z.strictObject`, and "we have never recorded a
   * body" is a real state that must be distinguishable from any hash value.
   */
  pushed_body_hash?: string | null;
  /**
   * 🔴 **RETIRED — no reader in core, and no writer once api-cloudrun stops
   * writing it** (one-document-model F16, H1). A bill's `pushed_hash` used to hash
   * the API-built body, so the bill's projection hash lived here; `pushed_hash` is
   * the projection hash on every parent now. Kept declared (optional) so stored
   * bill sidecars still parse until H2 purges them and deletes the field.
   */
  pushed_projection_hash?: string;
  pushed_at: FirestoreTimestampType;
}

/** Zod schema for XeroSyncState. */
export const XeroSyncStateSchema: z.ZodType<XeroSyncState> = z.strictObject({
  uid: z.literal("state"),
  pushed_hash: z.string().min(1).meta({ column: true, label: "Pushed Hash" }),
  pushed_body_hash: z.string().min(1).nullable().optional().meta({ column: true, label: "Pushed Body Hash" }),
  pushed_projection_hash: z.string().min(1).optional().meta({ column: true, label: "Pushed Projection Hash" }),
  pushed_at: FirestoreTimestamp.meta({ column: true, label: "Pushed" }),
}).meta({
  title: "Xero Sync State",
  collection: "xero-sync",
  displayDefaults: {
    columns: ["pushed_hash", "pushed_at"],
    filters: {},
    sort: { column: "pushed_at", direction: "desc" },
  },
});
