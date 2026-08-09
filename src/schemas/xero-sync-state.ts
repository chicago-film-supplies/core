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
  pushed_at: FirestoreTimestampType;
}

/** Zod schema for XeroSyncState. */
export const XeroSyncStateSchema: z.ZodType<XeroSyncState> = z.strictObject({
  uid: z.literal("state"),
  pushed_hash: z.string().min(1).meta({ column: true, label: "Pushed Hash" }),
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
