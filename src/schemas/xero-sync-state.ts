/**
 * XeroSyncState document schema — Firestore sidecar: orders/{uid}/xero-sync/state
 *
 * The hash of the order state that was last **successfully** pushed to Xero as
 * a Quote. The eventarc order fan-out gates its enqueue on this: recompute the
 * quote-determining projection of the order, and if it equals `pushed_hash`,
 * don't enqueue at all.
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
   * `hash48(version|targetStatus|invoiceSig)` of the order state whose push to
   * Xero last **succeeded** — the same projection `xeroQuoteTaskName` addresses
   * its Cloud Task by. Advances only after a successful push.
   */
  pushed_hash: string;
  /**
   * `hash48` of the Xero quote **body** that was last successfully pushed —
   * the SECOND, independent watermark (api-cloudrun#703).
   *
   * The two answer different questions and neither replaces the other:
   *
   * | | `pushed_hash` | `pushed_body_hash` |
   * |---|---|---|
   * | question | *has the order moved since we pushed?* | *would we send the same bytes?* |
   * | cost | free — pure, from the order alone | 1–4 Firestore reads, O(items) |
   * | where | the enqueue gate + the Cloud Task name | inside the task, before the first Xero call |
   *
   * 🔴 **The body hash is a PURE SUPPRESSOR, and that is the property that makes
   * it safe.** It is only ever reached once the cheap gate has already fired, so
   * it can never *add* a push. That matters because the body is not a pure
   * function of the order — it folds in `product.price.coa_revenue`,
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
  pushed_at: FirestoreTimestampType;
}

/** Zod schema for XeroSyncState. */
export const XeroSyncStateSchema: z.ZodType<XeroSyncState> = z.strictObject({
  uid: z.literal("state"),
  pushed_hash: z.string().min(1).meta({ column: true, label: "Pushed Hash" }),
  pushed_body_hash: z.string().min(1).nullable().optional().meta({ column: true, label: "Pushed Body Hash" }),
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
