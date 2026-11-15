/**
 * The one billing fold (`billedByPath`, one-document-model 6e-0b2 F1–F2).
 *
 * Where the fold AGREES with the functions it replaces (`invoicedByPath`,
 * `invoiceOnlyLines`, `purchaseDocumentBilling` / `purchaseCreditBilling`) it was
 * proved by running it beside them over every fixture in this suite. These
 * cases pin where it deliberately DIFFERS, each with the old behaviour as the
 * companion that must read differently:
 *
 * - AR folds money (rule 7), and an over-credit stays negative (R2);
 * - an AP row under a divider the bill authored bills no purchase line, and
 *   goes to `document_only` (rule 3, ruling 86), never its own join;
 * - an AP extension section is an extension row (rule 4, ruling 89);
 * - the ratio walk is summed across documents (rule 6, ruling 87).
 *
 * Fixtures are the fold's structural surface, cast: the fold reads paths,
 * types, quantities and stored money, and nothing else of a row.
 */
import { assert, assertEquals } from "@std/assert";
import {
  type AccountedCreditNote,
  type AccountedInvoice,
  billedByPath,
  type PayableFoldBill,
  type PayableFoldCredit,
} from "../src/utils/quantityAccounting.ts";
import type { LineItem } from "../src/utils/orders.ts";

const O = "order-1";
const P = "purchase-1";
const D = "dest-1";
const X = "prod-x";

const row = (o: Record<string, unknown>) => o as unknown as LineItem;

// ── Receivable ────────────────────────────────────────────────────

const ORDER_ITEMS: LineItem[] = [
  row({ uid: D, type: "destination", path: [D], name: "", description: "" }),
  row({ uid: X, type: "rental", path: [D, X], quantity: 3 }),
];

const invoice = (uid: string, quantity: number, cents: number, status: AccountedInvoice["status"] = "issued"): AccountedInvoice => ({
  uid,
  status,
  items: [
    { uid: O, type: "order", path: [O] },
    { uid: D, type: "destination", path: [O, D] },
    { uid: X, type: "rental", path: [O, D, X], quantity, price: { subtotal_discounted_cents: cents } },
  ] as unknown as AccountedInvoice["items"],
});

const note = (quantity: number, cents: number, status: AccountedCreditNote["status"] = "issued"): AccountedCreditNote => ({
  uid: "cn-1",
  status,
  sources: [{ collection: "invoices", uid: "inv-1" }],
  items: [{ quantity, path_invoice_item: [O, D, X], reverses_billing: true, price: { subtotal_discounted_cents: cents } }],
});

Deno.test("billedByPath (AR): folds each row's STORED net, summed across invoices", () => {
  const out = billedByPath("receivable", { uid: O, items: ORDER_ITEMS }, [invoice("inv-1", 2, 2000), invoice("inv-2", 1, 999)]);
  assertEquals(out.byPath.get(`${D}/${X}`)?.quantity, 3);
  assertEquals(out.byPath.get(`${D}/${X}`)?.amount_cents, 2999);
  assertEquals(out.byPath.get(`${D}/${X}`)?.rows.map((r) => [r.documentUid, r.quantity, r.amount_cents]), [["inv-1", 2, 2000], ["inv-2", 1, 999]]);
  assertEquals(out.compared, ["inv-1", "inv-2"]);
});

Deno.test("billedByPath (AR): a void invoice and a draft credit note count for nothing", () => {
  const out = billedByPath("receivable", { uid: O, items: ORDER_ITEMS }, [invoice("inv-1", 3, 3000), invoice("inv-2", 3, 3000, "void")], [
    note(1, 1000, "draft"),
  ]);
  assertEquals(out.byPath.get(`${D}/${X}`)?.quantity, 3);
  assertEquals(out.byPath.get(`${D}/${X}`)?.amount_cents, 3000);
});

Deno.test("billedByPath (AR): a reversing credit nets units AND money; an over-credit stays NEGATIVE (R2)", () => {
  const credited = billedByPath("receivable", { uid: O, items: ORDER_ITEMS }, [invoice("inv-1", 3, 3000)], [note(1, 1000)]);
  assertEquals([credited.byPath.get(`${D}/${X}`)?.quantity, credited.byPath.get(`${D}/${X}`)?.amount_cents], [2, 2000]);

  const over = billedByPath("receivable", { uid: O, items: ORDER_ITEMS }, [invoice("inv-1", 3, 3000)], [note(4, 4000)]);
  const at = over.byPath.get(`${D}/${X}`);
  assertEquals([at?.quantity, at?.amount_cents], [-1, -1000]);
  // The companion: a floored fold would read 0 here and hide the over-credit.
  assert(Math.max(0, at?.quantity ?? 0) !== at?.quantity);
  // A row whose net count is not positive is not a row that bills the path.
  assertEquals(at?.rows, []);
});

// ── Payable ───────────────────────────────────────────────────────

const flat = (cents: number) => ({ price_formula: { basis: "flat" }, discount: null, stated_cents: cents, counts: [] });

const PURCHASE_ITEMS: LineItem[] = [
  row({ uid: D, type: "destination", path: [D], name: "", description: "" }),
  row({ uid: X, type: "sale", path: [D, X], quantity: 3 }),
];

const bill = (uid: string, rows: Record<string, unknown>[], status = "issued"): PayableFoldBill =>
  ({
    uid,
    status,
    destinations: [],
    items: [{ uid: P, type: "purchase", path: [P] }, { uid: D, type: "destination", path: [P, D] }, ...rows],
  }) as unknown as PayableFoldBill;

const billX = (quantity: number, cents: number) => ({ uid: X, type: "sale", path: [P, D, X], quantity, amount_cents: cents, price: flat(cents) });

Deno.test("billedByPath (AP): bills net of reversing supplier credits; a void bill counts for nothing", () => {
  const credit = {
    uid: "credit-1",
    status: "issued",
    destinations: [],
    items: [
      { uid: P, type: "purchase", path: [P] },
      { uid: D, type: "destination", path: [P, D] },
      { ...billX(1, 1000), reverses_billing: true },
      { uid: "freight", type: "service", path: [P, D, "freight"], quantity: 1, amount_cents: 500, reverses_billing: false, price: flat(500) },
    ],
  } as unknown as PayableFoldCredit;
  const out = billedByPath("payable", { uid: P, items: PURCHASE_ITEMS }, [bill("bill-1", [billX(3, 3000)]), bill("bill-2", [billX(3, 3000)], "void")], [
    credit,
  ]);
  assertEquals([out.byPath.get(`${D}/${X}`)?.quantity, out.byPath.get(`${D}/${X}`)?.amount_cents], [2, 2000]);
  // An unmarked credit line (a goodwill or freight credit) un-bills nothing.
  assertEquals(out.byPath.get(`${D}/freight`), undefined);
  assertEquals(out.compared, ["bill-1"]);
});

Deno.test("billedByPath (AP): a row under a group the BILL authored is document-only, never keyed at its own join (ruling 86)", () => {
  const G = "group-bill";
  const F = "fee-1";
  const out = billedByPath("payable", { uid: P, items: PURCHASE_ITEMS }, [
    bill("bill-1", [
      billX(3, 3000),
      { uid: G, type: "group", path: [P, D, G], name: "Extras", description: "" },
      { uid: F, type: "service", path: [P, D, G, F], quantity: 2, amount_cents: 700, price: flat(700) },
    ]),
  ]);
  // The companion: the old payable fold keyed this row at `D/G/F`, a key no purchase line carries.
  assertEquals(out.byPath.get(`${D}/${G}/${F}`), undefined);
  assertEquals(out.document_only.lines.map((l) => [l.path, l.quantity]), [[[D, G, F], 2]]);
  assertEquals(out.document_only.amount_cents.get(`${D}/${G}/${F}`), 700);
  assertEquals(out.document_only.dividers.map((d) => d.path), [[D, G]]);
  assertEquals(out.document_only.documentUids.get(`${D}/${G}/${F}`), ["bill-1"]);
  assertEquals(out.unaligned, []);
});

Deno.test("billedByPath (AP): a bill's extension section is an extension row at the path it extends, adding no units (ruling 89)", () => {
  const E = "dest-ext";
  const out = billedByPath("payable", { uid: P, items: PURCHASE_ITEMS }, [
    bill("bill-1", [billX(3, 3000)]),
    bill("bill-2", [
      { uid: E, type: "destination", path: [P, E], path_extension_for: [D], name: "", description: "" },
      { uid: X, type: "sale", path: [P, E, X], quantity: 3, amount_cents: 900, price: flat(900) },
    ]),
  ]);
  const at = out.byPath.get(`${D}/${X}`);
  assertEquals(at?.quantity, 3);
  assertEquals(at?.amount_cents, 3000, "an extension's money is on its row, not in the path's units money");
  assertEquals(at?.rows.map((r) => [r.documentUid, r.via, r.quantity, r.amount_cents]), [["bill-1", "direct", 3, 3000], ["bill-2", "extension", 3, 900]]);
  assertEquals(out.unaligned, [], "an extension section reads as the destination it extends");
});

Deno.test("billedByPath (AP): the ratio walk is SUMMED across bills, rounding once (ruling 87)", () => {
  const K = "kit-1";
  const C = "comp-1";
  const Y = "alt-1";
  const items: LineItem[] = [
    row({ uid: D, type: "destination", path: [D], name: "", description: "" }),
    row({ uid: K, type: "sale", path: [D, K], quantity: 2 }),
    row({ uid: C, type: "sale", path: [D, K, C], quantity: 3 }),
  ];
  const y = { uid: Y, type: "sale", path: [P, D, Y], quantity: 1, amount_cents: 100, price: flat(100), substituted_for: [{ path: [D, K], quantity: 1 }] };
  const bills = [bill("bill-1", [y]), bill("bill-2", [y])];
  const summed = billedByPath("payable", { uid: P, items }, bills);
  assertEquals(summed.byPath.get(`${D}/${K}`)?.quantity, 2);
  assertEquals(summed.byPath.get(`${D}/${K}`)?.amount_cents, 200, "a substitute's money lands on X");
  // 2 kits stood in for × 3 components ÷ 2 per kit = 3, rounded once.
  assertEquals(summed.byPath.get(`${D}/${K}/${C}`)?.quantity, 3);

  // The companion: a per-document walk rounds 1.5 up on each bill and reads 4.
  const perDocument = bills.reduce((sum, b) => sum + (billedByPath("payable", { uid: P, items }, [b]).byPath.get(`${D}/${K}/${C}`)?.quantity ?? 0), 0);
  assertEquals(perDocument, 4);
});
