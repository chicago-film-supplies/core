/**
 * `PurchaseReceiptSchema` (`schemas/purchase-receipt.ts`), `receiptRowSources`
 * (`utils/purchase-receipts.ts`) and `purchaseReceiptSharedFields`
 * (`utils/shared-fields.ts`) — one-document-model 7a C9. Each refine planted
 * both ways, so a refine that stopped firing fails here rather than reading as a
 * clean corpus.
 */
import { assert, assertEquals } from "@std/assert";
import {
  isPurchaseReceiptLineItem,
  type PurchaseReceipt,
  type PurchaseReceiptItemType,
  type PurchaseReceiptLineItemType,
  PurchaseReceiptSchema,
  schemas,
} from "../src/schemas/mod.ts";
import { getTestDoc, type TestDocOptionsWithNow } from "../src/schemas/testing.ts";
import {
  deriveReceiptDueAt,
  receiptQueryByUidStore,
  type ReceiptRowSource,
  receiptRowSources,
} from "../src/utils/purchase-receipts.ts";
import { mergeSharedFields, purchaseReceiptSharedFields } from "../src/utils/shared-fields.ts";
import { mockTimestamp } from "./helpers/timestamp.ts";

const NOW: TestDocOptionsWithNow = { now: mockTimestamp };
const LEG = "00000000-0000-4000-8000-000000000000";
const GROUP = "11111111-1111-4111-8111-111111111111";
const PRODUCT = "AAAAAAAAAAAAAAAAAAAA";
const OTHER = "BBBBBBBBBBBBBBBBBBBB";

const destination = { uid: LEG, type: "destination" as const, name: "Warehouse", path: [LEG], description: "" };

function line(over: Partial<PurchaseReceiptLineItemType> = {}): PurchaseReceiptLineItemType {
  return {
    uid: PRODUCT,
    type: "sale",
    name: "Chair",
    description: "",
    quantity: 4,
    zero_priced: null,
    path: [LEG, PRODUCT],
    quantity_ordered: 4,
    ...over,
  };
}

/** A minimal valid receipt: one leg, one Buy line of 4. */
function receipt(items: PurchaseReceiptItemType[] = [destination, line()]): PurchaseReceipt {
  return { ...getTestDoc(PurchaseReceiptSchema, {}, NOW), items, query_by_items: [PRODUCT] };
}

const issues = (doc: unknown) => {
  const r = PurchaseReceiptSchema.safeParse(doc);
  return r.success ? [] : r.error.issues.map((i) => i.message);
};

Deno.test("PurchaseReceiptSchema: registered under the singular and plural pair", () => {
  assert(schemas["purchase-receipts"] === PurchaseReceiptSchema);
  assert(schemas["purchase-receipt"] === PurchaseReceiptSchema);
});

Deno.test("PurchaseReceiptSchema: a minimal receipt parses", () => {
  assertEquals(issues(receipt()), []);
});

Deno.test("PurchaseReceiptSchema: a line carries no price — money is not a receiving concern", () => {
  const priced = { ...line(), price: { total_cents: 100 } };
  assert(issues(receipt([destination, priced as PurchaseReceiptLineItemType])).length > 0);
});

Deno.test("PurchaseReceiptSchema: only sale and rental rows — a service line moves no custody", () => {
  assertEquals(issues(receipt([destination, line({ type: "rental" })])), []);
  const service = { ...line(), type: "service" } as unknown as PurchaseReceiptLineItemType;
  assert(issues(receipt([destination, service])).length > 0);
});

Deno.test("PurchaseReceiptSchema: quantity_ordered is REQUIRED-nullable", () => {
  assertEquals(issues(receipt([destination, line({ quantity_ordered: null })])), []);
  assertEquals(issues(receipt([destination, line({ quantity_ordered: 0, quantity: 0 })])), []);
  const { quantity_ordered: _, ...absent } = line();
  assert(issues(receipt([destination, absent as PurchaseReceiptLineItemType])).length > 0);
});

Deno.test("PurchaseReceiptSchema: it leads with a destination divider its pair answers", () => {
  const group = { uid: GROUP, type: "group" as const, name: "G", path: [GROUP], description: "" };
  assert(
    issues(receipt([group, destination, line()])).some((m) => m.includes("a purchase receipt must lead with a destination")),
  );
  const orphan = { ...destination, uid: GROUP, path: [GROUP] };
  assert(issues(receipt([orphan, line({ path: [GROUP, PRODUCT] })])).some((m) => m.includes("names no destination divider")));
});

Deno.test("isPurchaseReceiptLineItem: decided by the row's type", () => {
  assert(isPurchaseReceiptLineItem(line()));
  assert(!isPurchaseReceiptLineItem(destination));
});

Deno.test("receiptRowSources: purchase, kept, receipt_extra and unexplained, in that precedence", () => {
  const atPurchase = line();
  // A purchase path wins whatever quantity_ordered says (the sync re-stamps it later).
  const atPurchaseStale = line({ uid: OTHER, path: [LEG, OTHER], quantity_ordered: null });
  const kept = line({ uid: "CCCCCCCCCCCCCCCCCCCC", path: [LEG, "CCCCCCCCCCCCCCCCCCCC"], quantity_ordered: 0, quantity: 1 });
  const extra = line({ uid: "DDDDDDDDDDDDDDDDDDDD", path: [LEG, "DDDDDDDDDDDDDDDDDDDD"], quantity_ordered: null });
  const stale = line({ uid: "EEEEEEEEEEEEEEEEEEEE", path: [LEG, "EEEEEEEEEEEEEEEEEEEE"], quantity_ordered: 3 });
  const purchase = {
    items: [
      { type: "destination", path: [LEG] },
      { type: "sale", path: [LEG, PRODUCT] },
      { type: "rental", path: [LEG, OTHER] },
      // A charge line at the stale row's path moves no custody, so it explains nothing.
      { type: "service", path: [LEG, "EEEEEEEEEEEEEEEEEEEE"] },
    ],
  };
  const sources = receiptRowSources({ items: [destination, atPurchase, atPurchaseStale, kept, extra, stale] }, purchase);
  const got: ReceiptRowSource[] = [atPurchase, atPurchaseStale, kept, extra, stale].map((r) => sources.get(r)!);
  assertEquals(got, ["purchase", "purchase", "kept", "receipt_extra", "unexplained"]);
  assertEquals(sources.size, 5, "dividers are not classified");
});

Deno.test("purchaseReceiptSharedFields: classified once, grouped by merge unit", () => {
  const a = purchaseReceiptSharedFields();
  assert(a === purchaseReceiptSharedFields(), "memoized");
  assertEquals(a.line.map((f) => `${f.kind} ${f.path}${f.group ? ` [${f.group}]` : ""}`), [
    "propagated type",
    "propagated name",
    "propagated description",
    // The purchase's `flat_money` group, with one member on this pair.
    "propagated quantity [flat_money]",
    "propagated zero_priced",
    "propagated quantity_per_parent",
  ]);
  assert(a.pair.some((f) => f.path === "dates.delivery_start" && f.kind === "propagated"));
  assert(a.pair.some((f) => f.path === "delivery" && f.kind === "atom"));
  assert(a.doc.some((f) => f.path === "supplier" && f.kind === "atom"));

  // 🔴 The fields the writer must copy UNCONDITIONALLY are exactly the ones the
  // merge refuses. `reference` is among them on this pair (the purchase tags it a
  // homonym for its bills), unlike the fulfillment's, which merges per field.
  assertEquals(
    a.doc.filter((f) => f.kind !== "propagated" && f.kind !== "atom").map((f) => `${f.kind} ${f.path}`),
    [
      "homonym uid",
      "homonym number",
      "homonym status",
      "homonym reference",
      "homonym version",
      "homonym created_by",
      "homonym updated_by",
      "homonym created_at",
      "homonym updated_at",
    ],
  );
});

Deno.test("purchaseReceiptSharedFields: an untouched row follows the purchase; a receiver's count stays", () => {
  const { line: fields } = purchaseReceiptSharedFields();
  const prev = line({ quantity: 4, name: "Chair" });
  const next = line({ quantity: 6, name: "Folding chair" });

  const untouched = mergeSharedFields(fields, prev, next, line({ quantity: 4, name: "Chair" }));
  assertEquals([untouched.merged.quantity, untouched.merged.name], [6, "Folding chair"]);

  // The supplier sent 3 of 4: the receiver's count survives the PO edit, and a
  // label correction still reaches the row.
  const short = mergeSharedFields(fields, prev, next, line({ quantity: 3, name: "Chair" }));
  assertEquals([short.merged.quantity, short.merged.name], [3, "Folding chair"]);
});

// ── due_at and query_by_uid_store (owner, 2026-11-11) ──────────────────

const LEG_B = "22222222-2222-4222-8222-222222222222";
const PURCHASE_UID = "PPPPPPPPPPPPPPPPPPPP";
const iso = (d: number) => `2026-12-${String(d).padStart(2, "0")}T09:00:00.000-06:00`;
const fsOf = (d: number) => ({ ...mockTimestamp, seconds: d });
const pair = (uid: string, deliver: number | null, back: number | null, end: number | null = null) => ({
  uid,
  dates: {
    delivery_start: deliver === null ? null : iso(deliver),
    delivery_start_fs: deliver === null ? null : fsOf(deliver),
    collection_start: back === null ? null : iso(back),
    collection_start_fs: back === null ? null : fsOf(back),
    collection_end: end === null ? null : iso(end),
    collection_end_fs: end === null ? null : fsOf(end),
  },
});
const zero = { ordered: 0, transit_inbound: 0, received: 0, stocked: 0, transit_outbound: 0 };
const booking = (type: "sale" | "rental", leg: string, held: Partial<typeof zero>, stores: string[] = []) => ({
  uid: `${PURCHASE_UID}:${PRODUCT}:${leg}`,
  type,
  breakdown: { ...zero, ...held },
  query_by_uid_store: stores,
});
const active = (destinations: ReturnType<typeof pair>[]) => ({ status: "active" as const, destinations });

Deno.test("deriveReceiptDueAt: a unit still to arrive is due at its pair's delivery_start", () => {
  const got = deriveReceiptDueAt(active([pair(LEG, 5, 9)]), [booking("sale", LEG, { ordered: 2 })]);
  assertEquals(got, { iso: iso(5), fs: fsOf(5) });
});

Deno.test("deriveReceiptDueAt: a held SUBRENT is due back at collection_start; a stocked BUY is due nowhere", () => {
  const dests = [pair(LEG, 5, 9, 12)];
  assertEquals(deriveReceiptDueAt(active(dests), [booking("rental", LEG, { stocked: 2 })]).iso, iso(9));
  // The same key, a Buy: terminal, so nothing is due — what a summed rollup cannot tell apart.
  assertEquals(deriveReceiptDueAt(active(dests), [booking("sale", LEG, { stocked: 2 })]), { iso: null, fs: null });
  // No hire end stated: the supply end stands in.
  assertEquals(deriveReceiptDueAt(active([pair(LEG, 5, null, 12)]), [booking("rental", LEG, { received: 1 })]).iso, iso(12));
});

Deno.test("deriveReceiptDueAt: the earliest open leg across pairs wins, its _fs from the same pair", () => {
  const dests = [pair(LEG, 20, 25), pair(LEG_B, 8, 14)];
  const got = deriveReceiptDueAt(active(dests), [booking("sale", LEG, { ordered: 1 }), booking("rental", LEG_B, { stocked: 1 })]);
  assertEquals(got, { iso: iso(14), fs: fsOf(14) });
});

Deno.test("deriveReceiptDueAt: null when the purchase is closed, nothing is open, or the pair states no date", () => {
  const dests = [pair(LEG, 5, 9)];
  const open = [booking("sale", LEG, { ordered: 2 })];
  assertEquals(deriveReceiptDueAt({ status: "complete", destinations: dests }, open), { iso: null, fs: null });
  assertEquals(deriveReceiptDueAt({ status: "canceled", destinations: dests }, open), { iso: null, fs: null });
  assertEquals(deriveReceiptDueAt(active(dests), [booking("rental", LEG, {})]), { iso: null, fs: null });
  assertEquals(deriveReceiptDueAt(active([pair(LEG, null, null)]), open), { iso: null, fs: null });
});

Deno.test("receiptQueryByUidStore: the purchase's store first, then each booking store once", () => {
  assertEquals(receiptQueryByUidStore({ uid_store: "S1" }, []), ["S1"]);
  assertEquals(
    receiptQueryByUidStore({ uid_store: "S1" }, [{ query_by_uid_store: ["S2", "S1"] }, { query_by_uid_store: ["S2", "S3"] }]),
    ["S1", "S2", "S3"],
  );
});

Deno.test("PurchaseReceiptSchema: due_at and query_by_uid_store are REQUIRED keys (nullable due)", () => {
  const { due_at: _d, ...noDue } = receipt();
  assert(issues(noDue).length > 0, "an absent due_at is refused, not defaulted");
  const { query_by_uid_store: _q, ...noStores } = receipt();
  assert(issues(noStores).length > 0);
  assertEquals(issues({ ...receipt(), due_at: null, due_at_fs: null }), []);
});
