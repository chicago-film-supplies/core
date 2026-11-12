import { assertEquals, assertNotEquals } from "@std/assert";
import type { PurchaseBill } from "../src/schemas/mod.ts";
import { purchaseBillXeroProjectionHash, purchaseBillXeroSyncStatus } from "../src/utils/purchase-bill-xero-sync.ts";

const item = {
  // A stored service line names a catalog product or is `custom-` (7a).
  uid: "custom-line-1", path: ["custom-line-1"], type: "service", name: "Dolly", quantity: 3, amount_cents: 12345,
  ledger_account: 5100, uid_tracking_category: "cat",
};
const bill = (over: Record<string, unknown> = {}) => ({
  uid: "b", number: 7, origin: "pushed", xero_id: "x-1", version: 2, items: [item],
  date: "2026-10-19T00:00:00.000-05:00", due_date: "2026-11-18T00:00:00.000-06:00", reference: "INV-7",
  totals: { total_cents: 12345, amount_paid_cents: 0, amount_credited_cents: 0, amount_void_cents: 0, amount_due_cents: 12345 },
  ...over,
}) as unknown as PurchaseBill;

Deno.test("purchaseBillXeroProjectionHash: the stored form is byte-stable", () => {
  // FNV-1a 48 of the canonical projection, computed outside this code (a Python
  // reimplementation of canonical JSON + FNV-1a, 2026-11-07). A change here reads
  // every stored bill as an edit.
  //
  // ⚠️ It MOVED in the one-document-model Phase 1 (from "jyyyiiux5", the same
  // projection with `type: "charge"` and `coa_posting`), so every pushed bill's
  // `pushed_projection_hash` reads stale until that phase's maintenance window
  // re-stamps it with the bodies proven identical and no push (plan item S1).
  assertEquals(purchaseBillXeroProjectionHash(bill()), "1eln8podv1");
});

Deno.test("purchaseBillXeroProjectionHash: every field the body reads moves it", () => {
  const base = purchaseBillXeroProjectionHash(bill());
  const edits: Record<string, unknown>[] = [
    { date: "2026-10-20T00:00:00.000-05:00" },
    { due_date: "2026-11-19T00:00:00.000-06:00" },
    { reference: "INV-8" },
    { items: [{ ...item, name: "Cart" }] },
    { items: [{ ...item, quantity: 4 }] },
    { items: [{ ...item, amount_cents: 12346 }] },
    { items: [{ ...item, ledger_account: 5200 }] },
    { items: [{ ...item, uid_tracking_category: null }] },
    // The product the line names: its uid, since 7a (the projection still spells it `uid_product`).
    { items: [{ ...item, uid: "testprod000000000001" }] },
  ];
  for (const edit of edits) assertNotEquals(purchaseBillXeroProjectionHash(bill(edit)), base, JSON.stringify(edit));
});

Deno.test("purchaseBillXeroProjectionHash: line order is part of it", () => {
  const other = { ...item, uid: "custom-line-2", name: "Cart" };
  assertNotEquals(
    purchaseBillXeroProjectionHash(bill({ items: [item, other] })),
    purchaseBillXeroProjectionHash(bill({ items: [other, item] })),
  );
});

Deno.test("purchaseBillXeroProjectionHash: what Xero does not carry does not move it", () => {
  const base = purchaseBillXeroProjectionHash(bill());
  const moved = bill({
    version: 9, xero_id: "x-2", items: [{ ...item, uid: "custom-line-9" }],
    totals: { total_cents: 12345, amount_paid_cents: 100, amount_credited_cents: 0, amount_void_cents: 0, amount_due_cents: 12245 },
  });
  assertEquals(purchaseBillXeroProjectionHash(moved), base);
});

Deno.test("purchaseBillXeroSyncStatus: each answer", () => {
  const current = { pushed_projection_hash: purchaseBillXeroProjectionHash(bill()) };
  assertEquals(purchaseBillXeroSyncStatus(bill(), current), "in_sync");
  assertEquals(purchaseBillXeroSyncStatus(bill({ reference: "other" }), current), "out_of_sync");
  assertEquals(purchaseBillXeroSyncStatus(bill(), null), "unknown");
  assertEquals(purchaseBillXeroSyncStatus(bill(), {}), "unknown", "a watermark from before the field");
  assertEquals(purchaseBillXeroSyncStatus(bill({ xero_id: null }), null), "out_of_sync");
  assertEquals(purchaseBillXeroSyncStatus(bill({ origin: "linked" }), current), "in_sync", "an unpaid linked bill compares");
  const settled = { origin: "linked", totals: { total_cents: 12345, amount_paid_cents: 12345, amount_credited_cents: 0, amount_void_cents: 0, amount_due_cents: 0 } };
  assertEquals(purchaseBillXeroSyncStatus(bill(settled), current), "not_applicable", "a settled linked bill takes tracking alone");
});

Deno.test("purchaseBillXeroSyncStatus: a void bill is not applicable; a settled one still compares", () => {
  const current = { pushed_projection_hash: purchaseBillXeroProjectionHash(bill()) };
  const voided = { status: "void", voided_at: { seconds: 1, nanoseconds: 0 } };
  assertEquals(purchaseBillXeroSyncStatus(bill(voided), current), "not_applicable");
  const paid = { totals: { total_cents: 12345, amount_paid_cents: 12345, amount_credited_cents: 0, amount_void_cents: 0, amount_due_cents: 0 } };
  assertEquals(purchaseBillXeroSyncStatus(bill({ ...paid, reference: "other" }), current), "out_of_sync");
});
