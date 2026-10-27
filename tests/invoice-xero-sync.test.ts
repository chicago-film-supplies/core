import { assertEquals, assertNotEquals } from "@std/assert";
import { INVOICE_STATUS_CONTRACTS, type Invoice, type InvoiceStatusType, type Settlement } from "../src/schemas/mod.ts";
import {
  canonicalJson,
  hash48,
  invoiceSettlementsHeldByXero,
  invoiceStatusTracksXeroEdits,
  invoiceXeroProjectionHash,
  invoiceXeroSyncStatus,
  shouldPushInvoiceToXero,
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

Deno.test("invoiceXeroSyncStatus: unknown without a recorded hash; out of sync when issued but unlinked; not_applicable off the live set", () => {
  assertEquals(invoiceXeroSyncStatus(invoice(), null), "unknown");
  assertEquals(invoiceXeroSyncStatus(invoice(), { pushed_hash: "v7" }), "unknown", "the pre-hash spelling");
  assertEquals(invoiceXeroSyncStatus(invoice({ xero_id: null }), null), "out_of_sync", "issued, never reached Xero");
  for (const over of [{ status: "draft" }, { status: "void" }]) {
    assertEquals(invoiceXeroSyncStatus(invoice(over), { pushed_hash: "x" }), "not_applicable", JSON.stringify(over));
  }
});

Deno.test("invoiceXeroSyncStatus: CFS paid is tracked once a push has recorded a hash, and not before", () => {
  // Prod #2399: the card fee was added, then a CFS-only payment flipped it `paid`
  // before the push ran. Xero holds no payment, so the edit must still reach it.
  const pushed = invoice();
  const state = { pushed_hash: invoiceXeroProjectionHash(pushed) };
  const lines = [{ uid: "o", type: "order", path: ["o"] }, line("tent", 5000), line("fee", 200)];
  const paid = (over: Record<string, unknown> = {}) =>
    invoice({ status: "paid", totals: { total_cents: 5010, amount_paid_cents: 5010 }, ...over });
  assertEquals(invoiceXeroSyncStatus(paid(), state), "in_sync");
  assertEquals(invoiceXeroSyncStatus(paid({ items: lines }), state), "out_of_sync");
  // No hash: 979 of 1,026 prod paid invoices, nearly all Xero-paid. Tracking them
  // would enqueue on every write and report an edit nobody made.
  assertEquals(invoiceXeroSyncStatus(paid(), null), "not_applicable", "no sidecar");
  assertEquals(invoiceXeroSyncStatus(paid(), { pushed_hash: "v7" }), "not_applicable", "the pre-hash spelling");
  assertEquals(invoiceXeroSyncStatus(paid({ xero_id: null }), state), "not_applicable", "unlinked");
});

Deno.test("invoiceStatusTracksXeroEdits: the status half, true for paid — whose watermark then decides", () => {
  for (const status of ["issued", "part_paid", "paid"]) assertEquals(invoiceStatusTracksXeroEdits(status), true, status);
  for (const status of ["draft", "void"]) assertEquals(invoiceStatusTracksXeroEdits(status), false, status);
  // The trap it exists for: `null` is not "status only" for paid.
  assertEquals(invoiceXeroSyncStatus(invoice({ status: "paid" }), null), "not_applicable");
});

Deno.test("D7 tracks_xero_edits: literal per status, and non-null exactly where live_in_xero", () => {
  const statuses = Object.keys(INVOICE_STATUS_CONTRACTS) as InvoiceStatusType[];
  assertEquals(
    Object.fromEntries(statuses.map((s) => [s, INVOICE_STATUS_CONTRACTS[s].tracks_xero_edits])),
    { draft: null, issued: "always", part_paid: "always", paid: "once_pushed", void: null },
  );
  for (const s of statuses) {
    const c = INVOICE_STATUS_CONTRACTS[s];
    assertEquals(c.tracks_xero_edits !== null, c.live_in_xero, s);
    assertEquals(invoiceStatusTracksXeroEdits(s), c.tracks_xero_edits !== null, s);
  }
  assertEquals(invoiceStatusTracksXeroEdits("voided"), false, "outside the vocabulary");
});

Deno.test("D9: a tracking-only line edit moves the projection hash", () => {
  const tagged = (over: Record<string, unknown>) =>
    invoice({ items: [{ uid: "o", type: "order", path: ["o"] }, { ...line("tent", 5000), ...over }] });
  const base = invoiceXeroProjectionHash(tagged({ tracking_category: "Lighting", xero_tracking_option_id: "opt-1" }));
  assertNotEquals(invoiceXeroProjectionHash(tagged({ tracking_category: "Grip", xero_tracking_option_id: "opt-1" })), base);
  assertNotEquals(invoiceXeroProjectionHash(tagged({ tracking_category: "Lighting", xero_tracking_option_id: "opt-2" })), base);
  assertEquals(invoiceXeroProjectionHash(tagged({ tracking_category: "Lighting", xero_tracking_option_id: "opt-1" })), base);
});

Deno.test("canonicalJson/hash48: key order does not move the hash; content does", () => {
  assertEquals(canonicalJson({ b: 1, a: { d: 2, c: 3 } }), canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
  assertEquals(hash48(canonicalJson({ b: 1, a: 2 })), hash48(canonicalJson({ a: 2, b: 1 })));
  assertNotEquals(hash48("a"), hash48("b"));
  // Pinned values, produced by api-cloudrun's own (since deleted) `contentHash` module for the
  // same inputs — so moving the function here changes no stored task name or watermark.
  assertEquals(hash48("xero"), "2qcdkbu6zt");
  assertEquals(hash48(canonicalJson({ b: [1, { d: null, c: "x" }], a: true })), "ks5pjp85x");
});

// ── the enqueue gate (api-cloudrun#1332) ─────────────────────────────

Deno.test("shouldPushInvoiceToXero: fires on a projection change against the watermark, not on old-vs-new", () => {
  const before = invoice();
  const state = { pushed_hash: invoiceXeroProjectionHash(before) };
  const edited = invoice({ items: [{ uid: "o", type: "order", path: ["o"] }, line("tent", 5100)], version: 4 });
  assertEquals(shouldPushInvoiceToXero(before, edited, state), true);
  assertEquals(shouldPushInvoiceToXero(before, invoice({ version: 4 }), state), false, "in sync: nothing to push");
});

Deno.test("shouldPushInvoiceToXero: the #1332 sequence — every write re-arms while the watermark is behind", () => {
  // prod #2459: an edit's task was superseded by a no-op PUT and then by a payment,
  // neither of which enqueued, so the edit never reached Xero.
  const pushed = invoice({ version: 20 });
  const state = { pushed_hash: invoiceXeroProjectionHash(pushed) };
  const lines = [{ uid: "o", type: "order", path: ["o"] }, line("tent", 5000), line("bottle", 4420)];
  const edit = invoice({ version: 21, items: lines });
  const noop = invoice({ version: 22, items: lines });
  const paid = invoice({ version: 23, items: lines, status: "part_paid", totals: { total_cents: 9430, amount_paid_cents: 2630 } });
  assertEquals(shouldPushInvoiceToXero(pushed, edit, state), true, "the edit");
  assertEquals(shouldPushInvoiceToXero(edit, noop, state), true, "the no-op PUT — old-vs-new would read false here");
  assertEquals(shouldPushInvoiceToXero(noop, paid, state), true, "the settlement append");
  // Once the push lands the same writes go quiet.
  const landed = { pushed_hash: invoiceXeroProjectionHash(edit) };
  assertEquals(shouldPushInvoiceToXero(edit, noop, landed), false);
  assertEquals(shouldPushInvoiceToXero(noop, paid, landed), false);
});

Deno.test("shouldPushInvoiceToXero: unlinked old side, unknown watermark, and the exempt statuses", () => {
  const state = { pushed_hash: "stale" };
  assertEquals(shouldPushInvoiceToXero(invoice({ xero_id: null }), invoice(), state), false, "the issue path's own xero_id patch");
  assertEquals(shouldPushInvoiceToXero(null, invoice(), state), false, "a create");
  assertEquals(shouldPushInvoiceToXero(invoice(), invoice(), null), true, "no sidecar ⇒ unknown ⇒ push");
  assertEquals(shouldPushInvoiceToXero(invoice(), invoice(), { pushed_hash: "v7" }), true, "legacy watermark ⇒ unknown ⇒ push");
  for (const status of ["void", "draft"]) {
    assertEquals(shouldPushInvoiceToXero(invoice(), invoice({ status }), state), false, status);
  }
  assertEquals(shouldPushInvoiceToXero(invoice(), invoice({ status: "paid" }), state), true, "paid, stale against a hash");
  assertEquals(shouldPushInvoiceToXero(invoice(), invoice({ status: "paid" }), null), false, "paid, no hash");
});

// ── settlements Xero holds ───────────────────────────────────────────

const settlement = (uid: string, type: string, over: Record<string, unknown> = {}) =>
  ({ uid, type, reverses: null, xero_payment_id: null, xero_credit_note_id: null, ...over }) as unknown as Settlement;

Deno.test("invoiceSettlementsHeldByXero: only live rows carrying their contract's Xero id", () => {
  assertEquals(invoiceSettlementsHeldByXero([settlement("p", "payment")]), [], "a CFS-only payment");
  const linked = settlement("p", "payment", { xero_payment_id: "xp-1" });
  assertEquals(invoiceSettlementsHeldByXero([linked]), [linked], "a linked payment");
  assertEquals(
    invoiceSettlementsHeldByXero([linked, settlement("r", "payment_reversal", { reverses: "p" })]),
    [],
    "a linked payment that has been reversed",
  );
  const credit = settlement("c", "credit", { xero_credit_note_id: "xcn-1" });
  assertEquals(invoiceSettlementsHeldByXero([credit]), [credit], "a linked credit");
  assertEquals(invoiceSettlementsHeldByXero([settlement("c", "credit")]), [], "an unlinked credit");
  assertEquals(invoiceSettlementsHeldByXero([settlement("v", "void"), settlement("z", "closure")]), [], "no Xero id by contract");
});
