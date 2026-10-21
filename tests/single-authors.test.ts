/**
 * core#130 — one core author per domain rule that api-cloudrun, the manager and
 * the templates each used to implement on their own.
 *
 * Each block plants the input on which a deleted copy DISAGREED with the rule
 * that won, and asserts the winning answer — so the test names the divergence
 * it closed rather than restating the happy path.
 */
import { assertEquals } from "@std/assert";
import {
  deriveCreditNoteStatus,
  deriveInvoiceStatus,
  derivePurchaseCreditStatus,
  computeInvoiceItemPaths,
  INVOICE_ITEM_LEVELS,
  type InvoiceItem,
  invoiceHasMoneySettlement,
  invoicePairKey,
} from "../src/utils/invoices.ts";
import { formatDiscriminatedRate, formatRate } from "../src/utils/money.ts";
import { seedChargeableDays } from "../src/utils/price-document.ts";
import { cardNextStatus, cardStatusOptions, isCardFieldLocked, isEventCard } from "../src/utils/cards.ts";
import { type Card, type Movement, takeBackReasonsFor } from "../src/schemas/mod.ts";
import { reclassPairReversal, standaloneReversalRefusal } from "../src/utils/movements.ts";
import { buildDocumentTaxContext } from "../src/utils/taxes.ts";
import { type ComponentDraft, normalizeAuthoredComponents } from "../src/utils/products.ts";
import { derivedProjectOf, isOrgDerived } from "../src/utils/organizations.ts";
import { type RebookLine, rebookProblems } from "../src/utils/custody.ts";
import { documentRenderRows, getGroupPath, itemDividers, ORDER_ITEM_LEVELS, type StructuralItem } from "../src/utils/orders.ts";

// ── Row 1: credit-note status ────────────────────────────────────────

Deno.test("row 1: a racing over-allocation leaves the note ISSUED, never a stale applied", () => {
  // `api-cloudrun/src/services/creditNotes.ts` kept `fresh.status`, so an `applied` note driven negative
  // by a concurrent allocation stayed `applied` — a document the refine rejects.
  assertEquals(deriveCreditNoteStatus({ status: "applied" }, -500), "issued");
  assertEquals(deriveCreditNoteStatus({ status: "issued" }, -1), "issued");
});

Deno.test("row 1: zero remaining is applied; void and draft are never promoted", () => {
  assertEquals(deriveCreditNoteStatus({ status: "issued" }, 0), "applied");
  assertEquals(deriveCreditNoteStatus({ status: "applied" }, 1200), "issued");
  assertEquals(deriveCreditNoteStatus({ status: "void" }, 0), "void");
  assertEquals(deriveCreditNoteStatus({ status: "void" }, -10), "void");
  // `api-cloudrun/src/services/invoices.ts` mapped draft → issued; a reap or repair must not promote one.
  assertEquals(deriveCreditNoteStatus({ status: "draft" }, 700), "draft");
});

Deno.test("row 1: a supplier credit has no draft, and a $0 credit is never applied", () => {
  assertEquals(derivePurchaseCreditStatus({ status: "issued", total_cents: 900 }, 0), "applied");
  assertEquals(derivePurchaseCreditStatus({ status: "applied", total_cents: 900 }, -50), "issued");
  assertEquals(derivePurchaseCreditStatus({ status: "issued", total_cents: 0 }, 0), "issued");
  assertEquals(derivePurchaseCreditStatus({ status: "void", total_cents: 900 }, 0), "void");
});

// ── Row 2: settlement predicate ──────────────────────────────────────

Deno.test("row 2: a net-negative bucket still MOVED money, so it is a settlement", () => {
  // The deleted `hasSettlement` used `> 0` and answered false here.
  assertEquals(invoiceHasMoneySettlement({ totals: { amount_paid_cents: -100 } }), true);
  assertEquals(invoiceHasMoneySettlement({ totals: { amount_paid_cents: 0, amount_void_cents: 300 } }), true);
  // An absent bucket reads as zero — the manager's `!== 0` with no `?? 0` read
  // a missing `amount_credited_cents` as settled.
  assertEquals(invoiceHasMoneySettlement({ totals: { amount_paid_cents: 0 } }), false);
});

Deno.test("row 2: a negative bucket is NOT part paid — status keeps its `> 0`", () => {
  const totals = { total_cents: 1000, amount_paid_cents: -100, amount_credited_cents: 0 };
  assertEquals(deriveInvoiceStatus({ status: "issued", totals }), "issued");
  assertEquals(deriveInvoiceStatus({ status: "issued", totals: { ...totals, amount_paid_cents: 100 } }), "part_paid");
});

// ── Row 3: group path reads `path`, not position ─────────────────────

Deno.test("row 3: for [O, A, G, X, B, Y], Y sits in destination B with NO group", () => {
  // The manager's invoice copy walked past destination B and put Y in G.
  const items = computeInvoiceItemPaths([
    { uid: "O", type: "order" },
    { uid: "A", type: "destination" },
    { uid: "G", type: "group" },
    { uid: "X", type: "rental" },
    { uid: "B", type: "destination" },
    { uid: "Y", type: "rental" },
  ] as unknown as InvoiceItem[]);
  const y = items.find((i) => i.uid === "Y")!;
  assertEquals(itemDividers(y, items, INVOICE_ITEM_LEVELS), {
    order: "O",
    destination: "B",
    group: null,
    product: null,
    productPath: null,
  });
  const x = items.find((i) => i.uid === "X")!;
  assertEquals(itemDividers(x, items, INVOICE_ITEM_LEVELS).group, "G");
  // A divider row never reports itself.
  const g = items.find((i) => i.uid === "G")!;
  assertEquals(itemDividers(g, items, INVOICE_ITEM_LEVELS), {
    order: "O",
    destination: "A",
    group: null,
    product: null,
    productPath: null,
  });
});

Deno.test("row 3: a component reports its parent product and the parent's path", () => {
  const items = [
    { uid: "A", type: "destination", path: ["A"] },
    { uid: "G", type: "group", path: ["A", "G"] },
    { uid: "K", type: "rental", path: ["A", "G", "K"] },
    { uid: "C", type: "rental", path: ["A", "G", "K", "C"] },
  ] as StructuralItem[];
  const c = itemDividers(items[3], items, ORDER_ITEM_LEVELS);
  assertEquals(c, { destination: "A", group: "G", product: "K", productPath: ["A", "G", "K"] });
  assertEquals(getGroupPath(items as never, 3), c);
});

// ── Row 4: formatRate ────────────────────────────────────────────────

Deno.test("row 4: a flat rate keeps its sub-cent digits and its cents", () => {
  // The manager's copy rounded to the cent ("$0.06"); core printed "$43.6".
  assertEquals(formatDiscriminatedRate({ type: "flat", rate: 0.055 }), "$0.055");
  assertEquals(formatDiscriminatedRate({ type: "flat", rate: 43.6 }), "$43.60");
  assertEquals(formatDiscriminatedRate({ type: "flat", rate: 0.0639 }), "$0.0639");
  assertEquals(formatDiscriminatedRate({ type: "flat", rate: 5 }), "$5.00");
  assertEquals(formatDiscriminatedRate({ type: "flat", rate: 1250.5 }), "$1,250.50");
  assertEquals(formatRate(-43.6, { symbol: "$" }), "-$43.60");
  assertEquals(formatRate(-0.00001, { symbol: "$" }), "$0.00");
});

Deno.test("row 4: a percent rate is capped at 4dp and trims to the digit", () => {
  // The manager's copy printed the raw float.
  assertEquals(formatDiscriminatedRate({ type: "percent", rate: 0.1 + 0.2 }), "0.3%");
  assertEquals(formatDiscriminatedRate({ type: "percent", rate: 10.25 }), "10.25%");
  assertEquals(formatDiscriminatedRate({ type: "percent", rate: 10 }), "10%");
  assertEquals(formatRate(1250.5), "1250.5");
});

// ── Row 5: chargeable_days seed ──────────────────────────────────────

Deno.test("row 5: a 2+ window pair seeds BILLABLE days, joined by divider path", () => {
  const items = [
    { uid: "B", type: "destination", path: ["B"] },
    { uid: "A", type: "destination", path: ["A"] },
  ] as StructuralItem[];
  // `destinations[]` is in a different order from the dividers: a positional
  // join would read B's windows for A.
  const destinations = [
    { uid: "A", dates: { charge_windows: [{ days: 8 }, { days: 3 }] } },
    { uid: "B", dates: { charge_windows: [{ days: 2 }] } },
  ];
  // chargedDays (Σ) said 11; the pricer bills max(8,5) + max(3,5) = 13.
  assertEquals(seedChargeableDays(items, destinations, "A"), 13);
  assertEquals(seedChargeableDays(items, destinations, "B"), 2);
  assertEquals(seedChargeableDays(items, [{ uid: "A", dates: { charge_windows: null } }], "A"), null);
  assertEquals(seedChargeableDays(items, destinations, "nope"), null);
});

// ── Row 6: card locks and status options ─────────────────────────────

Deno.test("row 6: a status lock offers NO status, where the manager offered all six", () => {
  const card = { locked: ["status"], status: "active" } as Pick<Card, "locked" | "status">;
  assertEquals(cardStatusOptions(card), []);
  assertEquals(cardNextStatus(card), null);
  assertEquals(isCardFieldLocked(card, "status"), true);
});

Deno.test("row 6: status_auto narrows to current + blocked; all_day rides the dates lock", () => {
  const auto = { locked: ["status_auto"], status: "active" } as Pick<Card, "locked" | "status">;
  assertEquals(cardStatusOptions(auto), ["active", "blocked"]);
  assertEquals(cardNextStatus(auto), "blocked");
  assertEquals(isCardFieldLocked(auto, "status"), false);
  assertEquals(cardStatusOptions({ ...auto, status: "blocked" }), ["blocked"]);
  assertEquals(cardNextStatus({ ...auto, status: "blocked" }), null);
  const dated = { locked: ["dates"] } as Pick<Card, "locked">;
  assertEquals(isCardFieldLocked(dated, "all_day"), true);
  assertEquals(isCardFieldLocked(dated, "subject"), false);
  assertEquals(cardStatusOptions({ locked: [], status: "draft" }).length, 6);
  assertEquals(cardNextStatus({ locked: [], status: "draft" }), "planned");
});

Deno.test("row 6: an event card is sourced from a fulfillment; an orders source marks nothing", () => {
  assertEquals(isEventCard({ sources: [{ collection: "fulfillments", uid: "F" }] } as Pick<Card, "sources">), true);
  assertEquals(isEventCard({ sources: [{ collection: "orders", uid: "O" }] } as unknown as Pick<Card, "sources">), false);
});

// ── Row 7: document tax context ──────────────────────────────────────

Deno.test("row 7: exemption is sticky from either side, and a pair keeps its join key", () => {
  const base = { origin: "IL-CHICAGO" as never, catalog: {} as never, asOf: "2026-10-01T00:00:00.000-05:00" };
  const exemptOrg = buildDocumentTaxContext({
    ...base,
    organization: { tax_exempt: true },
    documentExempt: false,
    destinations: [{ uid: "P1", delivery: undefined } as never],
  });
  // `doc ?? org` would un-exempt here.
  assertEquals(exemptOrg.exempt, true);
  assertEquals((exemptOrg.destinations[0] as { uid: string }).uid, "P1");
  assertEquals((exemptOrg.destinations[0] as { jurisdiction: unknown }).jurisdiction, null);
  // The manager passes a missing snapshot; it degrades to no claim, not exempt.
  const bare = buildDocumentTaxContext({ ...base, organization: null, destinations: undefined });
  assertEquals([bare.exempt, bare.organizationClaim, bare.destinations], [false, null, []]);
});

// ── Row 8: standalone reversal ───────────────────────────────────────

const reclassHalf = (uid: string, type: "reclass_out" | "reclass_in", partner: string) => ({
  uid,
  type,
  reverses: null,
  sources: [
    { collection: "transactions", uid: partner, label: "reclass counterpart" },
    { collection: "products", uid: "P-twin", label: "Twin" },
  ],
}) as unknown as Movement;

Deno.test("row 8: a reclass half refuses with reclass_pair, naming its counterpart", () => {
  // Neither deleted copy refused it; reversing one half double-counts.
  assertEquals(standaloneReversalRefusal(reclassHalf("OUT", "reclass_out", "IN")), { code: "reclass_pair", uid: "IN" });
  assertEquals(standaloneReversalRefusal(reclassHalf("IN", "reclass_in", "OUT")), { code: "reclass_pair", uid: "OUT" });
});

Deno.test("row 8: the seven older classes, and a shelf write-off stays reversible", () => {
  assertEquals(standaloneReversalRefusal({ type: "count_open" }), { code: "count_boundary" });
  assertEquals(standaloneReversalRefusal({ type: "unenroll" }), { code: "roster_boundary" });
  assertEquals(standaloneReversalRefusal({ type: "check_out" as never, uid_booking: "B" }), { code: "booking", uid: "B" });
  assertEquals(
    standaloneReversalRefusal({ type: "purchase", sources: [{ collection: "purchases", uid: "PO" }] as never }),
    { code: "purchase_receipt", uid: "PO" },
  );
  assertEquals(
    standaloneReversalRefusal({
      type: "return_to_service",
      lines: [{ location: { from: { collection: "out-of-service", uid: "R" }, to: null } }] as never,
    }),
    { code: "out_of_service", uid: "R" },
  );
  const oos = (uids: string[]) => uids.map((uid) => ({ collection: "out-of-service", uid })) as never;
  assertEquals(
    standaloneReversalRefusal({ type: "transfer", service: {} as never, sources: oos(["R1", "R2"]) }),
    { code: "oos_split", uid: "R1", uids: ["R1", "R2"] },
  );
  assertEquals(
    standaloneReversalRefusal({ type: "transfer", service: {} as never, sources: oos(["R1"]) }),
    { code: "oos_flagged_transfer", uid: "R1" },
  );
  assertEquals(
    standaloneReversalRefusal({ type: "write_off", service: {} as never, sources: oos(["R1"]) }),
    { code: "oos_flagged", uid: "R1" },
  );
  assertEquals(
    standaloneReversalRefusal({
      type: "write_off",
      lines: [{ location: { from: { collection: "locations", uid: "L" }, to: null } }] as never,
    }),
    null,
  );
});

Deno.test("row 8: a reclass pair reverses its IN half first, from either end", () => {
  const out = reclassHalf("OUT", "reclass_out", "IN");
  const inn = reclassHalf("IN", "reclass_in", "OUT");
  for (const [requested, partner] of [[out, inn], [inn, out]]) {
    const plan = reclassPairReversal(requested, partner);
    assertEquals("first" in plan && [plan.first.uid, plan.second.uid], ["IN", "OUT"]);
  }
  assertEquals(reclassPairReversal(out, reclassHalf("X", "reclass_in", "OTHER")), { refusal: "not_a_pair" });
  assertEquals(reclassPairReversal(out, reclassHalf("IN", "reclass_out", "OUT")), { refusal: "not_a_pair" });
  assertEquals(reclassPairReversal({ ...out, reverses: "Z" }, inn), { refusal: "is_reversal" });
  assertEquals(
    reclassPairReversal({ ...out, type: "transfer" } as Movement, inn),
    { refusal: "not_reclass" },
  );
});

// ── Row 9: component authoring ───────────────────────────────────────

Deno.test("row 9: zero-priced siblings sort first, so the optimistic order is the server's", () => {
  const draft = (uid: string, extra: Partial<ComponentDraft> = {}) =>
    ({ uid, path: [uid], quantity: 1, ...extra }) as unknown as ComponentDraft;
  const input = [draft("A"), draft("B", { zero_priced: true }), draft("C", { inclusion_type: "optional", quantity: 3 })];
  const out = normalizeAuthoredComponents(input);
  assertEquals(out.map((c) => c.uid), ["B", "A", "C"]);
  assertEquals(out.map((c) => [c.zero_priced, c.inclusion_type, c.quantity, c.price_overridden]), [
    [true, "default", 1, []],
    [false, "default", 1, []],
    [false, "optional", 0, []],
  ]);
  // The input is not reordered.
  assertEquals(input.map((c) => c.uid), ["A", "B", "C"]);
});

// ── Row 10: derived org nodes ────────────────────────────────────────

Deno.test("row 10: a derived node is read off its OWN segment; its project is found under the root", () => {
  const seg = (uid: string, derived = false) => ({ uid, name: uid, derived });
  const root = { uid: "R", path: [seg("R")] };
  const def = { uid: "D", path: [seg("R"), seg("D", true)] };
  const proj = { uid: "P", path: [seg("R"), seg("P")] };
  const grand = { uid: "G", path: [seg("R"), seg("P"), seg("G", true)] };
  assertEquals([root, def, proj].map((n) => isOrgDerived(n as never)), [false, true, false]);
  // An index-sourced segment carries no `derived`, so reads false.
  assertEquals(isOrgDerived({ path: [{ uid: "R", name: "R" }] } as never), false);
  assertEquals(isOrgDerived(null), false);
  assertEquals(derivedProjectOf([root, proj, def, grand] as never[], "R"), def as never);
  assertEquals(derivedProjectOf([root, proj, grand] as never[], "R"), null);
});

// ── Row 11: document render rows ─────────────────────────────────────

Deno.test("row 11: a fee strands no banner, and a hidden component's money rolls up by path", () => {
  const price = (cents: number, tax = 0) => ({
    subtotal_cents: cents,
    subtotal_discounted_cents: cents,
    total_cents: cents + tax,
    taxes: tax ? [{ amount_cents: tax }] : [],
  });
  const items = [
    { uid: "O", type: "order", path: ["O"] },
    { uid: "A", type: "destination", path: ["O", "A"] },
    { uid: "K", type: "rental", path: ["O", "A", "K"], price: price(1000, 100) },
    { uid: "C", type: "rental", path: ["O", "A", "K", "C"], zero_priced: true, price: price(0, 25) },
    { uid: "Z", type: "rental", path: ["O", "A", "Z"], zero_priced: true, price: price(0) },
    { uid: "F", type: "group", path: ["O", "A", "F"] },
    { uid: "fee", type: "transaction_fee", path: ["O", "A", "F", "fee"], price: price(300) },
  ];
  const rows = documentRenderRows(items, INVOICE_ITEM_LEVELS, { hideZeroPricedComponents: true });
  // The fee and its now-empty group are gone; the top-level zero-priced Z stays.
  assertEquals(rows.shownItems.map((i) => i.uid), ["O", "A", "K", "C", "Z"]);
  assertEquals(rows.renderedItems.map((i) => i.uid), ["O", "A", "K", "Z"]);
  assertEquals(rows.rolledUp.get(rows.pathKey(items[2])), { tax: 25, subtotal: 0, total: 25 });
  assertEquals(rows.componentDepth(items[3]), 1);
  // A quote has no `order` level: the same rows, one level shallower.
  const quote = documentRenderRows(items.slice(1).map((i) => ({ ...i, path: i.path.slice(1) })), ORDER_ITEM_LEVELS);
  assertEquals(quote.renderedItems.map((i) => i.uid), ["A", "K", "C", "Z"]);
});

// ── Row 12: rental-extension rebook checks ───────────────────────────

const rebookLine = (extra: Partial<RebookLine> = {}): RebookLine => ({
  path: ["A", "K"],
  name: "Chair",
  uidProduct: "P",
  quantity: 2,
  orderQuantity: 10,
  pickedQuantity: 10,
  serialized: false,
  from: "bA",
  to: "bB",
  ...extra,
});
const bookingOut = (out: number, unitsOut: number[] | null = null) =>
  new Map([["bA", {
    uid: "bA",
    name: "Chair",
    breakdown: { out } as never,
    quantity_ordered: out,
    units: unitsOut === null ? null : { out: unitsOut } as never,
  }]]);

Deno.test("row 12: an order row of 10 the warehouse holds 8 of refuses — the manager allowed it", () => {
  const problems = rebookProblems({
    kind: "extend",
    lines: [rebookLine({ pickedQuantity: 8 })],
    bookings: bookingOut(10),
    unattributed: () => [],
  });
  assertEquals(problems.map((p) => p.code), ["picker_mismatch"]);
});

Deno.test("row 12: per-grain folds, units and the unrecorded pool", () => {
  // Two rows of one grain extend 6 + 6 against 10 out.
  assertEquals(
    rebookProblems({
      kind: "extend",
      lines: [rebookLine({ quantity: 6 }), rebookLine({ path: ["A", "K2"], quantity: 6 })],
      bookings: bookingOut(10),
      unattributed: () => [],
    }).map((p) => p.code),
    ["exceeds_out"],
  );
  const serial = (units: number[]) => rebookLine({ serialized: true, quantity: units.length, units });
  // Unit 7 is unrecorded and the booking has one untracked out: allowed.
  assertEquals(rebookProblems({ kind: "extend", lines: [serial([1, 7])], bookings: bookingOut(3, [1, 2]), unattributed: () => [7] }), []);
  assertEquals(
    rebookProblems({ kind: "extend", lines: [serial([1, 9])], bookings: bookingOut(3, [1, 2]), unattributed: () => [7] })
      .map((p) => p.code),
    ["unit_not_out"],
  );
  assertEquals(
    rebookProblems({ kind: "extend", lines: [serial([1])], bookings: bookingOut(3, [1, 2]), unattributed: () => null })
      .map((p) => p.code),
    ["not_numbered"],
  );
  assertEquals(
    rebookProblems({ kind: "extend", lines: [rebookLine({ serialized: true })], bookings: bookingOut(3), unattributed: () => [] })
      .map((p) => p.code),
    ["units_required"],
  );
  // An undo must return the leg whole.
  assertEquals(
    rebookProblems({ kind: "undo", lines: [rebookLine({ quantity: 2 })], bookings: bookingOut(3), unattributed: () => [] })
      .map((p) => p.code),
    ["undo_partial"],
  );
});

// ── Row 13: invoice pair key ─────────────────────────────────────────

Deno.test("row 13: a pair's identity is scoped to its order", () => {
  assertEquals(invoicePairKey({ uid_order: "O1", uid: "P" }), "O1/P");
  assertEquals(invoicePairKey({ uid_order: "O2", uid: "P" }) === invoicePairKey({ uid_order: "O1", uid: "P" }), false);
});

// ── Row 14: take-back reasons ────────────────────────────────────────

Deno.test("row 14: lost needs send_now", () => {
  assertEquals(takeBackReasonsFor("send_now").includes("lost"), true);
  assertEquals([...takeBackReasonsFor("same_trip")].sort(), ["cleaning", "damaged", "maintenance"]);
});
