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
import { type ReceiptRowSource, receiptRowSources } from "../src/utils/purchase-receipts.ts";
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
