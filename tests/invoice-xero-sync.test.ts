import { assertEquals, assertNotEquals } from "@std/assert";
import type { Invoice } from "../src/schemas/mod.ts";
import {
  canonicalJson,
  hash48,
  invoiceXeroProjectionHash,
  invoiceXeroSyncStatus,
} from "../src/utils/invoice-xero-sync.ts";

const line = (uid: string, subtotal: number) => ({
  uid, type: "rental", name: uid, quantity: 1, path: ["o", uid], coa_revenue: 4000,
  price: { subtotal_cents: subtotal, discount: null, taxes: [{ uid: "t", amount_cents: 10 }], total_cents: subtotal + 10 },
});
const invoice = (over: Record<string, unknown> = {}) => ({
  status: "issued", xero_id: "x-1", version: 3, date: "2026-09-01T00:00:00.000-05:00", due_date: null,
  reference: null, subject: "Shoot", organization: { uid: "org", xero_id: "contact-1" },
  items: [{ uid: "o", type: "order", path: ["o"] }, line("tent", 5000)],
  totals: { total_cents: 5010, amount_paid_cents: 0 },
  ...over,
}) as unknown as Invoice;

Deno.test("invoiceXeroSyncStatus: a watermark at the current projection is in sync; any Xero-carried edit is not", () => {
  const inv = invoice();
  const state = { pushed_hash: invoiceXeroProjectionHash(inv) };
  assertEquals(invoiceXeroSyncStatus(inv, state), "in_sync");

  const edits: Record<string, unknown>[] = [
    { items: [{ uid: "o", type: "order", path: ["o"] }, line("tent", 5100)] },
    { subject: "Other" },
    { reference: "PO-9" },
    { organization: { uid: "org", xero_id: "contact-2" } },
    { due_date: "2026-10-01T00:00:00.000-05:00" },
  ];
  for (const edit of edits) assertEquals(invoiceXeroSyncStatus(invoice(edit), state), "out_of_sync", JSON.stringify(edit));
});

Deno.test("invoiceXeroSyncStatus: settlement and bookkeeping writes do not read as drift", () => {
  const state = { pushed_hash: invoiceXeroProjectionHash(invoice()) };
  const moved = invoice({ version: 9, status: "part_paid", totals: { total_cents: 5010, amount_paid_cents: 1000 }, notes: "called" });
  assertEquals(invoiceXeroSyncStatus(moved, state), "in_sync");
});

Deno.test("invoiceXeroSyncStatus: unknown without a recorded hash; not_applicable off the live, linked set", () => {
  assertEquals(invoiceXeroSyncStatus(invoice(), null), "unknown");
  assertEquals(invoiceXeroSyncStatus(invoice(), { pushed_hash: "v7" }), "unknown", "the pre-hash spelling");
  for (const over of [{ status: "draft" }, { status: "paid" }, { status: "void" }, { xero_id: null }]) {
    assertEquals(invoiceXeroSyncStatus(invoice(over), { pushed_hash: "x" }), "not_applicable", JSON.stringify(over));
  }
});

Deno.test("canonicalJson/hash48: key order does not move the hash; content does", () => {
  assertEquals(canonicalJson({ b: 1, a: { d: 2, c: 3 } }), canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
  assertEquals(hash48(canonicalJson({ b: 1, a: 2 })), hash48(canonicalJson({ a: 2, b: 1 })));
  assertNotEquals(hash48("a"), hash48("b"));
  // Pinned values, produced by api-cloudrun's pre-existing `src/lib/contentHash.ts` for the
  // same inputs — so moving the function here changes no stored task name or watermark.
  assertEquals(hash48("xero"), "2qcdkbu6zt");
  assertEquals(hash48(canonicalJson({ b: [1, { d: null, c: "x" }], a: true })), "ks5pjp85x");
});
