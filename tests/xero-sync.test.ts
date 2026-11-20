import { assertEquals, assertNotEquals, assertThrows } from "@std/assert";
import { z } from "zod";
import {
  collectLeafPaths,
  INVOICE_STATUS_CONTRACTS,
  type Invoice,
  InvoiceSchema,
  type InvoiceStatusType,
  type Order,
  OrderSchema,
  type PurchaseBill,
  PurchaseBillSchema,
  type Settlement,
} from "../src/schemas/mod.ts";
import { canonicalJson, hash48 } from "../src/utils/contentHash.ts";
import { invoiceStatusTracksXeroEdits } from "../src/utils/invoices.ts";
import {
  billingXeroProjectionHash,
  billingXeroSyncStatus,
  collectXeroProjection,
  settlementsHeldByXero,
  shouldPushBillingToXero,
  XERO_META_KEY,
  xeroProjection,
  xeroProjectionHash,
  xeroLineRefs,
  xeroQuoteProjectionHash,
  xeroTaggedPaths,
} from "../src/utils/xero-sync.ts";

// ── the tagged sets, pinned by name (one-document-model F16 item 2) ──

// A deleted or misspelt tag is a red test here, never an empty walk: meta keys
// are untyped, so this is the only guard. The line cores' tags are shared across
// grains (instance identity), so each set is the union of what the three bodies
// read on a shared node; the over-tags are named in the plan's † column.
const TAX_LEAVES = ["amount_cents", "name", "rate", "type", "uid"].map((k) => `items[].price.taxes[].${k}`);
const DISCOUNT_LEAVES = ["amount_cents", "rate", "type"].map((k) => `items[].price.discount.${k}`);

Deno.test("xeroTaggedPaths: the invoice's set", () => {
  assertEquals(
    xeroTaggedPaths(InvoiceSchema),
    [
      "date",
      "due_date",
      "items[].coa_revenue",
      "items[].description",
      "items[].name",
      ...DISCOUNT_LEAVES,
      "items[].price.subtotal_cents",
      ...TAX_LEAVES,
      "items[].quantity",
      "items[].uid",
      "items[].uid_tracking_category",
      "items[].zero_priced",
      "organization.xero_id",
      "reference",
      "subject",
    ].sort(),
  );
});

Deno.test("xeroTaggedPaths: the bill's set", () => {
  assertEquals(xeroTaggedPaths(PurchaseBillSchema), [
    "date",
    "due_date",
    "items[].amount_cents",
    "items[].description",
    "items[].ledger_account",
    "items[].name",
    "items[].quantity",
    "items[].type",
    "items[].uid",
    "items[].uid_tracking_category",
    "items[].zero_priced",
    "reference",
  ]);
});

Deno.test("xeroTaggedPaths: the order's (quote's) set", () => {
  assertEquals(
    xeroTaggedPaths(OrderSchema),
    [
      "items[].coa_revenue",
      "items[].description",
      "items[].name",
      ...DISCOUNT_LEAVES,
      "items[].price.subtotal_cents",
      ...TAX_LEAVES,
      "items[].quantity",
      "items[].uid",
      "items[].uid_tracking_category",
      "items[].zero_priced",
      "number",
      "organization.xero_id",
      "reference",
      "subject",
    ].sort(),
  );
});

Deno.test("xeroTaggedPaths: the walker reaches a tag, inherits a key tag, honours an opt-out, and reads an empty set as empty", () => {
  const planted = z.strictObject({
    a: z.string().meta({ [XERO_META_KEY]: true }),
    b: z.string(),
    block: z.strictObject({ c: z.int(), d: z.string().meta({ [XERO_META_KEY]: false }) }).nullable().meta({ [XERO_META_KEY]: true }),
  });
  assertEquals(xeroTaggedPaths(planted), ["a", "block.c"]);
  // The empty-set companion: a schema with no tag says so, so a set above that
  // shrank to nothing could not pass as "matches".
  assertEquals(xeroTaggedPaths(z.strictObject({ a: z.string() })), []);
});

Deno.test("collectLeafPaths with inherit: one node under a tagged arm and an untagged arm is reported tagged", () => {
  // The bill's `items[]` union puts untagged dividers (`uid: ItemUid`) ahead of
  // the lines (`uid: ItemUid.meta({ xero })`); deduping on (path, node) alone
  // dropped the line arm's `ItemUid` options and lost `items[].uid`.
  const shared = z.union([z.string(), z.int()]);
  const schema = z.strictObject({
    items: z.array(z.discriminatedUnion("type", [
      z.strictObject({ type: z.literal("divider"), uid: shared }),
      z.strictObject({ type: z.literal("line"), uid: shared.meta({ [XERO_META_KEY]: true }) }),
    ])),
  });
  assertEquals(xeroTaggedPaths(schema), ["items[].uid"]);
  const { leaves } = collectLeafPaths(schema);
  assertEquals([...new Set(leaves.map((l) => l.path))].sort(), ["items[].type", "items[].uid"], "no inherit: unchanged");
});

// ── the value walk ───────────────────────────────────────────────────

const line = (uid: string, subtotal: number) => ({
  uid, type: "rental", name: uid, quantity: 1, path: ["o", uid], coa_revenue: 4000, zero_priced: null,
  uid_tracking_category: null,
  price: { subtotal_cents: subtotal, discount: null, taxes: [{ uid: "t", amount_cents: 10 }], total_cents: subtotal + 10 },
});
const invoice = (over: Record<string, unknown> = {}) => ({
  status: "issued", xero_id: "x-1", version: 3, date: "2026-09-01T00:00:00.000-05:00", due_date: null,
  reference: null, subject: "Shoot", organization: { uid: "org", xero_id: "contact-1" },
  items: [{ uid: "o", type: "order", path: ["o"] }, line("tent", 5000)],
  totals: { total_cents: 5010, amount_paid_cents: 0 },
  ...over,
}) as unknown as Invoice;
const inv = (over: Record<string, unknown> = {}) => billingXeroProjectionHash("receivable", invoice(over));

Deno.test("xeroProjection: tagged leaves only, absent reads null, and a divider is dropped", () => {
  assertEquals(xeroProjection(InvoiceSchema, invoice()), {
    date: "2026-09-01T00:00:00.000-05:00",
    due_date: null,
    reference: null,
    subject: "Shoot",
    organization: { xero_id: "contact-1" },
    items: [{
      uid: "tent", name: "tent", description: null, quantity: 1, zero_priced: null, coa_revenue: 4000,
      uid_tracking_category: null,
      price: { subtotal_cents: 5000, discount: null, taxes: [{ uid: "t", amount_cents: 10, name: null, rate: null, type: null }] },
    }],
  });
});

Deno.test("xeroProjection: adding or moving a divider does not move the hash", () => {
  const base = inv();
  assertEquals(inv({ items: [line("tent", 5000)] }), base, "no divider");
  assertEquals(inv({ items: [line("tent", 5000), { uid: "g", type: "group", name: "G", path: ["g"] }] }), base, "a group added");
});

Deno.test("collectXeroProjection: an element no arm claims is unhandled, and the hash refuses it", () => {
  const bad = invoice({ items: [{ uid: "z", type: "no-such-type", path: ["z"] }] });
  assertEquals(collectXeroProjection(InvoiceSchema, bad).unhandled, [{ path: "items[]", type: "union" }]);
  assertThrows(() => xeroProjectionHash(InvoiceSchema, bad));
});

Deno.test("xeroProjectionHash: the stored form is byte-stable", () => {
  // What `pushed_hash` records. A change here reads every stored watermark as an
  // edit and enqueues a push for every live document, so it needs a re-stamp
  // window (F16 Rollout; moved again by 6e-0b4 tagging `description`). FNV-1a 48
  // of the canonical projection.
  assertEquals(inv(), hash48(canonicalJson(xeroProjection(InvoiceSchema, invoice()))));
  assertEquals(inv(), "1df85glx1o");
  assertEquals(billingXeroProjectionHash("payable", bill()), "zh9chajf2");
});

// ── the receivable side (ported from invoice-xero-sync) ─────────────

Deno.test("billingXeroSyncStatus receivable: a watermark at the current projection is in sync; any Xero-carried edit is not", () => {
  const state = { pushed_hash: inv() };
  assertEquals(billingXeroSyncStatus("receivable", invoice(), state), "in_sync");
  const edits: Record<string, unknown>[] = [
    { items: [{ uid: "o", type: "order", path: ["o"] }, line("tent", 5100)] },
    { subject: "Other" },
    { reference: "PO-9" },
    { organization: { uid: "org", xero_id: "contact-2" } },
    { due_date: "2026-10-01T00:00:00.000-05:00" },
    { date: "2026-09-02T00:00:00.000-05:00" },
  ];
  for (const edit of edits) assertEquals(billingXeroSyncStatus("receivable", invoice(edit), state), "out_of_sync", JSON.stringify(edit));
});

Deno.test("billingXeroSyncStatus receivable: every line leaf the body reads moves the hash", () => {
  const base = inv();
  const edits: Record<string, unknown>[] = [
    { uid: "tent-2" },
    { name: "Tent XL" },
    { description: "Tent, 20x20" },
    { quantity: 2 },
    { coa_revenue: 4100 },
    { uid_tracking_category: "cat-grip" },
    { zero_priced: false },
    { price: { ...line("tent", 5000).price, subtotal_cents: 5001 } },
    { price: { ...line("tent", 5000).price, discount: { type: "percent", rate: 10, amount_cents: 500 } } },
    { price: { ...line("tent", 5000).price, taxes: [{ uid: "t2", amount_cents: 10 }] } },
    { price: { ...line("tent", 5000).price, taxes: [{ uid: "t", amount_cents: 11 }] } },
  ];
  for (const edit of edits) {
    assertNotEquals(inv({ items: [{ ...line("tent", 5000), ...edit }] }), base, JSON.stringify(edit));
  }
});

Deno.test("billingXeroSyncStatus receivable: settlement and bookkeeping writes do not read as drift", () => {
  const state = { pushed_hash: inv() };
  const moved = invoice({ version: 9, status: "part_paid", totals: { total_cents: 5010, amount_paid_cents: 1000 }, notes: "called" });
  assertEquals(billingXeroSyncStatus("receivable", moved, state), "in_sync");
  // A line key the body does not read.
  const untouched = invoice({ items: [{ uid: "o", type: "order", path: ["o"] }, { ...line("tent", 5000), order_number: 7 }] });
  assertEquals(billingXeroSyncStatus("receivable", untouched, state), "in_sync");
});

Deno.test("billingXeroSyncStatus receivable: unknown without a hash; out of sync when issued but unlinked; not_applicable off the live set", () => {
  assertEquals(billingXeroSyncStatus("receivable", invoice(), null), "unknown");
  assertEquals(billingXeroSyncStatus("receivable", invoice({ xero_id: null }), null), "out_of_sync", "issued, never reached Xero");
  for (const over of [{ status: "draft" }, { status: "void" }]) {
    assertEquals(billingXeroSyncStatus("receivable", invoice(over), { pushed_hash: "x" }), "not_applicable", JSON.stringify(over));
  }
});

Deno.test("billingXeroSyncStatus receivable: CFS paid is tracked once a push has recorded a hash, and not before", () => {
  // Prod #2399: the card fee was added, then a CFS-only payment flipped it `paid`
  // before the push ran. Xero holds no payment, so the edit must still reach it.
  const state = { pushed_hash: inv() };
  const lines = [{ uid: "o", type: "order", path: ["o"] }, line("tent", 5000), line("fee", 200)];
  const paid = (over: Record<string, unknown> = {}) =>
    invoice({ status: "paid", totals: { total_cents: 5010, amount_paid_cents: 5010 }, ...over });
  assertEquals(billingXeroSyncStatus("receivable", paid(), state), "in_sync");
  assertEquals(billingXeroSyncStatus("receivable", paid({ items: lines }), state), "out_of_sync");
  // No hash: nearly all such invoices are Xero-paid. Tracking them would enqueue
  // on every write and report an edit nobody made.
  assertEquals(billingXeroSyncStatus("receivable", paid(), null), "not_applicable", "no sidecar");
  assertEquals(billingXeroSyncStatus("receivable", paid({ xero_id: null }), state), "not_applicable", "unlinked");
});

Deno.test("invoiceStatusTracksXeroEdits: the status half, true for paid — whose watermark then decides", () => {
  for (const status of ["issued", "part_paid", "paid"]) assertEquals(invoiceStatusTracksXeroEdits(status), true, status);
  for (const status of ["draft", "void"]) assertEquals(invoiceStatusTracksXeroEdits(status), false, status);
  // The trap it exists for: `null` is not "status only" for paid.
  assertEquals(billingXeroSyncStatus("receivable", invoice({ status: "paid" }), null), "not_applicable");
});

Deno.test("D7 tracks_xero_edits: literal per status, and non-null exactly where live_in_xero", () => {
  const statuses = Object.keys(INVOICE_STATUS_CONTRACTS) as InvoiceStatusType[];
  assertEquals(
    Object.fromEntries(statuses.map((s) => [s, INVOICE_STATUS_CONTRACTS[s].tracks_xero_edits])),
    { draft: null, issued: "always", part_paid: "always", paid: "once_pushed", credited: "once_pushed", void: null },
  );
  for (const s of statuses) {
    const c = INVOICE_STATUS_CONTRACTS[s];
    assertEquals(c.tracks_xero_edits !== null, c.live_in_xero, s);
    assertEquals(invoiceStatusTracksXeroEdits(s), c.tracks_xero_edits !== null, s);
  }
  assertEquals(invoiceStatusTracksXeroEdits("voided"), false, "outside the vocabulary");
});

Deno.test("canonicalJson/hash48: key order does not move the hash; content does", () => {
  assertEquals(canonicalJson({ b: 1, a: { d: 2, c: 3 } }), canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
  assertEquals(hash48(canonicalJson({ b: 1, a: 2 })), hash48(canonicalJson({ a: 2, b: 1 })));
  assertNotEquals(hash48("a"), hash48("b"));
  // Pinned values, produced by api-cloudrun's own (since deleted) `contentHash`
  // module for the same inputs.
  assertEquals(hash48("xero"), "2qcdkbu6zt");
  assertEquals(hash48(canonicalJson({ b: [1, { d: null, c: "x" }], a: true })), "ks5pjp85x");
});

// ── the enqueue gate (api-cloudrun#1332; ruling 122) ─────────────────

Deno.test("shouldPushBillingToXero: fires on a projection change against the watermark, not on old-vs-new", () => {
  const before = invoice();
  const state = { pushed_hash: inv() };
  const edited = invoice({ items: [{ uid: "o", type: "order", path: ["o"] }, line("tent", 5100)], version: 4 });
  assertEquals(shouldPushBillingToXero("receivable", before, edited, state), true);
  assertEquals(shouldPushBillingToXero("receivable", before, invoice({ version: 4 }), state), false, "in sync: nothing to push");
});

Deno.test("shouldPushBillingToXero: the #1332 sequence — every write re-arms while the watermark is behind", () => {
  // prod #2459: an edit's task was superseded by a no-op PUT and then by a
  // payment, neither of which enqueued, so the edit never reached Xero.
  const pushed = invoice({ version: 20 });
  const state = { pushed_hash: billingXeroProjectionHash("receivable", pushed) };
  const lines = [{ uid: "o", type: "order", path: ["o"] }, line("tent", 5000), line("bottle", 4420)];
  const edit = invoice({ version: 21, items: lines });
  const noop = invoice({ version: 22, items: lines });
  const paid = invoice({ version: 23, items: lines, status: "part_paid", totals: { total_cents: 9430, amount_paid_cents: 2630 } });
  assertEquals(shouldPushBillingToXero("receivable", pushed, edit, state), true, "the edit");
  assertEquals(shouldPushBillingToXero("receivable", edit, noop, state), true, "the no-op PUT — old-vs-new would read false here");
  assertEquals(shouldPushBillingToXero("receivable", noop, paid, state), true, "the settlement append");
  const landed = { pushed_hash: billingXeroProjectionHash("receivable", edit) };
  assertEquals(shouldPushBillingToXero("receivable", edit, noop, landed), false);
  assertEquals(shouldPushBillingToXero("receivable", noop, paid, landed), false);
});

Deno.test("shouldPushBillingToXero: unlinked old side, unknown watermark, and the exempt statuses", () => {
  const state = { pushed_hash: "stale" };
  assertEquals(shouldPushBillingToXero("receivable", invoice({ xero_id: null }), invoice(), state), false, "the issue path's own xero_id patch");
  assertEquals(shouldPushBillingToXero("receivable", null, invoice(), state), false, "a create");
  assertEquals(shouldPushBillingToXero("receivable", invoice(), invoice(), null), true, "no sidecar ⇒ unknown ⇒ push");
  for (const status of ["void", "draft"]) {
    assertEquals(shouldPushBillingToXero("receivable", invoice(), invoice({ status }), state), false, status);
  }
  assertEquals(shouldPushBillingToXero("receivable", invoice(), invoice({ status: "paid" }), state), true, "paid, stale against a hash");
  assertEquals(shouldPushBillingToXero("receivable", invoice(), invoice({ status: "paid" }), null), false, "paid, no hash");
});

// ── the payable side (ported from purchase-bill-xero-sync) ───────────

const item = {
  // A stored service line names a catalog product or is `custom-` (7a).
  uid: "custom-line-1", path: ["custom-line-1"], type: "service", name: "Dolly", quantity: 3, amount_cents: 12345,
  ledger_account: 5100, uid_tracking_category: "cat", zero_priced: null,
};
const PAID_TOTALS = { total_cents: 12345, amount_paid_cents: 12345, amount_credited_cents: 0, amount_void_cents: 0, amount_due_cents: 0 };
const bill = (over: Record<string, unknown> = {}) => ({
  uid: "b", number: 7, status: "issued", origin: "pushed", xero_id: "x-1", version: 2, items: [item],
  date: "2026-10-19T00:00:00.000-05:00", due_date: "2026-11-18T00:00:00.000-06:00", reference: "INV-7",
  totals: { total_cents: 12345, amount_paid_cents: 0, amount_credited_cents: 0, amount_void_cents: 0, amount_due_cents: 12345 },
  ...over,
}) as unknown as PurchaseBill;
const billHash = (over: Record<string, unknown> = {}) => billingXeroProjectionHash("payable", bill(over));

Deno.test("billingXeroProjectionHash payable: every field the body reads moves it", () => {
  const base = billHash();
  const edits: Record<string, unknown>[] = [
    { date: "2026-10-20T00:00:00.000-05:00" },
    { due_date: "2026-11-19T00:00:00.000-06:00" },
    { reference: "INV-8" },
    { items: [{ ...item, name: "Cart" }] },
    { items: [{ ...item, quantity: 4 }] },
    { items: [{ ...item, description: "moved" }] },
    { items: [{ ...item, amount_cents: 12346 }] },
    { items: [{ ...item, ledger_account: 5200 }] },
    { items: [{ ...item, uid_tracking_category: null }] },
    { items: [{ ...item, type: "replacement", out_of_service: [] }] },
    // The product the line names: its uid, tagged on the shared line core.
    { items: [{ ...item, uid: "testprod000000000001" }] },
  ];
  for (const edit of edits) assertNotEquals(billHash(edit), base, JSON.stringify(edit));
});

Deno.test("billingXeroProjectionHash payable: line order is part of it", () => {
  const other = { ...item, uid: "custom-line-2", name: "Cart" };
  assertNotEquals(billHash({ items: [item, other] }), billHash({ items: [other, item] }));
});

Deno.test("billingXeroProjectionHash payable: what Xero does not carry does not move it", () => {
  const base = billHash();
  const moved = {
    version: 9, xero_id: "x-2", subject: "other", items: [{ ...item, uid_purchase_line: "moved" }],
    totals: { total_cents: 12345, amount_paid_cents: 100, amount_credited_cents: 0, amount_void_cents: 0, amount_due_cents: 12245 },
  };
  assertEquals(billHash(moved), base);
});

Deno.test("billingXeroSyncStatus payable: each answer", () => {
  const current = { pushed_hash: billHash() };
  assertEquals(billingXeroSyncStatus("payable", bill(), current), "in_sync");
  assertEquals(billingXeroSyncStatus("payable", bill({ reference: "other" }), current), "out_of_sync");
  assertEquals(billingXeroSyncStatus("payable", bill(), null), "unknown");
  assertEquals(billingXeroSyncStatus("payable", bill({ xero_id: null }), null), "out_of_sync");
  assertEquals(billingXeroSyncStatus("payable", bill({ origin: "linked" }), current), "in_sync", "an unpaid linked bill compares");
  assertEquals(
    billingXeroSyncStatus("payable", bill({ origin: "linked", status: "part_paid", totals: { ...PAID_TOTALS, amount_paid_cents: 1 } }), current),
    "not_applicable",
    "a settled linked bill takes tracking alone",
  );
});

Deno.test("billingXeroSyncStatus payable: void and draft are not applicable; a settled pushed one still compares", () => {
  const current = { pushed_hash: billHash() };
  assertEquals(billingXeroSyncStatus("payable", bill({ status: "void" }), current), "not_applicable");
  assertEquals(billingXeroSyncStatus("payable", bill({ status: "draft" }), current), "not_applicable");
  const paid = { status: "paid", totals: PAID_TOTALS };
  assertEquals(billingXeroSyncStatus("payable", bill({ ...paid, reference: "other" }), current), "out_of_sync");
});

Deno.test("billingXeroSyncStatus payable: a paid pushed bill with no sidecar reads not_applicable, as an AR paid invoice does", () => {
  // The F16 item 3 behaviour change (BILL-299, -301, -303, -304 in prod): it read `unknown`.
  assertEquals(billingXeroSyncStatus("payable", bill({ status: "paid", totals: PAID_TOTALS }), null), "not_applicable");
});

Deno.test("shouldPushBillingToXero payable: the same gate", () => {
  const state = { pushed_hash: billHash() };
  assertEquals(shouldPushBillingToXero("payable", bill(), bill({ reference: "INV-8" }), state), true);
  assertEquals(shouldPushBillingToXero("payable", bill(), bill({ version: 3 }), state), false);
  assertEquals(shouldPushBillingToXero("payable", bill({ xero_id: null }), bill(), state), false);
});

// ── the quote (ruling 125) ───────────────────────────────────────────

const destination = (start: string) => ({ uid: "d", dates: { delivery_start: start } });
const order = (over: Record<string, unknown> = {}) => ({
  number: 905, reference: null, subject: "Shoot", organization: { uid: "org", xero_id: "contact-1" },
  destinations: [destination("2026-09-01T09:00:00.000-05:00")],
  items: [{ uid: "d", type: "destination", path: ["d"] }, line("tent", 5000)],
  version: 4,
  ...over,
}) as unknown as Order;

Deno.test("xeroQuoteProjectionHash: each derived input moves it, and version does not", () => {
  const base = xeroQuoteProjectionHash(order(), "SENT");
  assertNotEquals(xeroQuoteProjectionHash(order(), "ACCEPTED"), base, "the target status");
  assertNotEquals(xeroQuoteProjectionHash(order(), null), base, "no target");
  assertNotEquals(
    xeroQuoteProjectionHash(order({ destinations: [destination("2026-09-02T09:00:00.000-05:00")] }), "SENT"),
    base,
    "the date envelope's delivery_start",
  );
  assertEquals(xeroQuoteProjectionHash(order({ version: 5 }), "SENT"), base, "a version bump alone");
});

Deno.test("xeroQuoteProjectionHash: the tagged order leaves move it", () => {
  const base = xeroQuoteProjectionHash(order(), "SENT");
  const edits: Record<string, unknown>[] = [
    { number: 906 },
    { reference: "PO-1" },
    { subject: "Other" },
    { organization: { uid: "org", xero_id: "contact-2" } },
    { items: [{ ...line("tent", 5000), uid: "tent-2" }] },
    { items: [{ ...line("tent", 5000), description: "Tent, 20x20" }] },
    { items: [line("tent", 5100)] },
  ];
  for (const edit of edits) assertNotEquals(xeroQuoteProjectionHash(order(edit), "SENT"), base, JSON.stringify(edit));
  assertEquals(
    xeroQuoteProjectionHash(order({ items: [line("tent", 5000)] }), "SENT"),
    base,
    "the destination divider is dropped",
  );
});

// ── settlements Xero holds ───────────────────────────────────────────

const settlement = (uid: string, type: string, over: Record<string, unknown> = {}, collection = "invoices") =>
  ({ uid, type, reverses: null, xero_id: null, billing: { collection, uid: "billing" }, ...over }) as unknown as Settlement;

Deno.test("settlementsHeldByXero: only live rows of the side carrying their Xero id", () => {
  assertEquals(settlementsHeldByXero("receivable", [settlement("p", "payment")]), [], "a CFS-only payment");
  const linked = settlement("p", "payment", { xero_id: "xp-1" });
  assertEquals(settlementsHeldByXero("receivable", [linked]), [linked], "a linked payment");
  assertEquals(
    settlementsHeldByXero("receivable", [linked, settlement("r", "payment_reversal", { reverses: "p" })]),
    [],
    "a linked payment that has been reversed",
  );
  const credit = settlement("c", "credit", { xero_id: "xcn-1" });
  assertEquals(settlementsHeldByXero("receivable", [credit]), [credit], "a linked credit");
  assertEquals(settlementsHeldByXero("receivable", [settlement("c", "credit")]), [], "an unlinked credit");
  assertEquals(settlementsHeldByXero("receivable", [settlement("v", "void"), settlement("z", "closure")]), [], "no Xero id by contract");
  // The side is not in the type any more (ruling 44), so the reader takes it:
  // a linked BILL payment is not a linked invoice payment, and vice versa.
  const billPayment = settlement("b", "payment", { xero_id: "xp-2" }, "purchase-bills");
  assertEquals(settlementsHeldByXero("receivable", [billPayment]), [], "a bill's payment on the invoice side");
  assertEquals(settlementsHeldByXero("payable", [billPayment]), [billPayment], "a bill's payment on its own side");
  assertEquals(settlementsHeldByXero("payable", [linked]), [], "an invoice's payment on the bill side");
});

// ── the line refs (6e-0b4 K2.3; moved from tests/invoices.test.ts) ───

Deno.test("xeroLineRefs: the caller's account, the line's tracking first, the product's item code", () => {
  const known = new Set(["opt-line", "opt-product"]);
  // The line names a category by uid; its option is looked up when the body is built.
  const options = new Map<string, string | null>([
    ["cat-line", "opt-line"],
    ["cat-product", "opt-product"],
    ["cat-retired", "opt-retired"],
    ["cat-no-option", null],
  ]);
  const product = { xero_tracking_option_id: "opt-product", xero_code: "CAM-1" };
  const cases: [string, Parameters<typeof xeroLineRefs>[0], typeof product | undefined, ReturnType<typeof xeroLineRefs>][] = [
    ["the line's category's option wins",
      { uid: "cam", uid_tracking_category: "cat-line" }, product,
      { account_code: "4100", tracking_option_id: "opt-line", item_code: "CAM-1" }],
    ["a line naming the product's own category",
      { uid: "cam", uid_tracking_category: "cat-product" }, product,
      { account_code: "4100", tracking_option_id: "opt-product", item_code: "CAM-1" }],
    ["a line with no category falls back to the product",
      { uid: "cam", uid_tracking_category: null }, product,
      { account_code: "4100", tracking_option_id: "opt-product", item_code: "CAM-1" }],
    ["a line option Xero no longer knows falls back to the product's",
      { uid: "cam", uid_tracking_category: "cat-retired" }, product,
      { account_code: "4100", tracking_option_id: "opt-product", item_code: "CAM-1" }],
    ["a category the lookup does not know falls back to the product's",
      { uid: "cam", uid_tracking_category: "cat-unknown" }, product,
      { account_code: "4100", tracking_option_id: "opt-product", item_code: "CAM-1" }],
    ["a category whose option is null falls back to the product's",
      { uid: "cam", uid_tracking_category: "cat-no-option" }, product,
      { account_code: "4100", tracking_option_id: "opt-product", item_code: "CAM-1" }],
    ["a custom line sends its own category's option and never reads a product",
      { uid: "custom-tent-repair", uid_tracking_category: "cat-line" }, product,
      { account_code: "4100", tracking_option_id: "opt-line", item_code: null }],
    ["no product and no category: no tracking, no item code",
      { uid: "cam", uid_tracking_category: null }, undefined,
      { account_code: "4100", tracking_option_id: null, item_code: null }],
  ];
  for (const [label, line, p, want] of cases) {
    assertEquals(xeroLineRefs(line, p, "4100", options, known), want, label);
  }
});
