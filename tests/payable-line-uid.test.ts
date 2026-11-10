/**
 * W4K (one-document-model, owner ruling 12, 2026-11-10): a payable catalog
 * line's `uid` is its product's, as an order or invoice line's is. The key
 * rule, its refines, and the re-key author the migration and the writers call.
 */
import { assert, assertEquals, assertThrows } from "@std/assert";
import { PurchaseBillRowInput, PurchaseItemInput } from "../src/schemas/mod.ts";
import { payableInputUidIssue, payableLineUid, payableLineUidIssue } from "../src/utils/purchases.ts";
import { rekeyPayableLines, rekeyPayablePointer } from "../src/utils/purchase-documents.ts";

const PAIR_A = "9a1b2c3d-0000-4000-8000-000000000901";
const PAIR_B = "9a1b2c3d-0000-4000-8000-000000000902";
const GROUP = "9a1b2c3d-0000-4000-8000-000000000903";
const PURCHASE = "testpurchase00000001";
const KIT = "testkit0000000000001";
const VEST = "testvest000000000001";
const old = (n: number) => `0b9e2f4a-0000-4000-8000-${String(n).padStart(12, "0")}`;

// ── the key rule ───────────────────────────────────────────────────

Deno.test("payableLineUid: a sale, rental or product replacement is its product; anything else custom-", () => {
  assertEquals(payableLineUid({ type: "sale", uid: old(1), uid_product: VEST }), VEST);
  assertEquals(payableLineUid({ type: "rental", uid: old(1), uid_product: VEST }), VEST);
  assertEquals(payableLineUid({ type: "replacement", uid: old(1), uid_product: VEST }), VEST);
  // A service's product is attribution, never its key; the old uid is kept behind the prefix.
  assertEquals(payableLineUid({ type: "service", uid: old(1), uid_product: VEST }), `custom-${old(1)}`);
  assertEquals(payableLineUid({ type: "replacement", uid: old(1) }), `custom-${old(1)}`);
  // Already keyed: unchanged, so a re-key is repeatable.
  assertEquals(payableLineUid({ type: "service", uid: `custom-${old(1)}` }), `custom-${old(1)}`);
  assertThrows(() => payableLineUid({ type: "sale", uid: old(1) }), Error, "names no product");
});

Deno.test("payableLineUidIssue: the stored rule, both directions", () => {
  assertEquals(payableLineUidIssue({ type: "sale", uid: VEST, uid_product: VEST }), null);
  assertEquals(payableLineUidIssue({ type: "service", uid: `custom-${old(1)}`, uid_product: VEST }), null);
  assertEquals(payableLineUidIssue({ type: "replacement", uid: `custom-${old(1)}` }), null);
  assert(payableLineUidIssue({ type: "sale", uid: old(1), uid_product: VEST })?.includes(VEST));
  assert(payableLineUidIssue({ type: "service", uid: old(1) })?.includes("custom-"));
  assert(payableLineUidIssue({ type: "replacement", uid: old(1) })?.includes("custom-"));
});

Deno.test("payableInputUidIssue: only a line naming its product is checked; a service's uid is the writer's", () => {
  assertEquals(payableInputUidIssue({ type: "service", uid: old(1), uid_product: VEST }), null);
  assertEquals(payableInputUidIssue({ type: "replacement", uid: old(1) }), null);
  assert(payableInputUidIssue({ type: "rental", uid: old(1), uid_product: VEST }) !== null);
});

// ── the input refines ──────────────────────────────────────────────

Deno.test("PurchaseItemInput: a catalog line keyed by another uid is refused at `uid`, and only there", () => {
  const line = { type: "sale", uid: VEST, path: [PAIR_A, VEST], uid_product: VEST, quantity: 1, amount_cents: 100 };
  assert(PurchaseItemInput.safeParse(line).success, "control");
  const minted = PurchaseItemInput.safeParse({ ...line, uid: old(1), path: [PAIR_A, old(1)] });
  assertEquals(minted.error?.issues.map((i) => i.path.join(".")), ["uid"]);
  const rental = PurchaseItemInput.safeParse({ ...line, type: "rental", uid: old(1), path: [PAIR_A, old(1)] });
  assertEquals(rental.error?.issues.map((i) => i.path.join(".")), ["uid"]);
  // A replacement is checked only when it names a product.
  const replacement = { type: "replacement", uid: old(2), path: [PAIR_A, old(2)], name: "Lost unit", ledger_account: 5300, out_of_service: [{ uid: "testoos0000000000001", quantity: 1 }] };
  assert(PurchaseItemInput.safeParse(replacement).success, "no product: the writer mints its custom- uid");
  const named = PurchaseItemInput.safeParse({ ...replacement, uid_product: VEST });
  assertEquals(named.error?.issues.map((i) => i.path.join(".")), ["uid"]);
  // A service is never checked: its uid is the writer's to mint.
  assert(PurchaseItemInput.safeParse({ type: "service", uid: old(3), path: [PAIR_A, old(3)], name: "Freight", ledger_account: 5300, uid_product: VEST }).success);
});

Deno.test("PurchaseBillRowInput: a bill row naming its product is keyed by it", () => {
  const row = { type: "rental", uid: VEST, path: [PURCHASE, PAIR_A, VEST], uid_product: VEST };
  assert(PurchaseBillRowInput.safeParse(row).success, "control");
  const minted = PurchaseBillRowInput.safeParse({ ...row, uid: old(1), path: [PURCHASE, PAIR_A, old(1)] });
  assertEquals(minted.error?.issues.map((i) => i.path.join(".")), ["uid"]);
  // An identity-only echo names no product, so it is not checked here.
  assert(PurchaseBillRowInput.safeParse({ type: "rental", uid: old(1), path: [PURCHASE, PAIR_A, old(1)] }).success);
});

// ── the re-key author ──────────────────────────────────────────────

const dest = (uid: string) => ({ type: "destination", uid, path: [uid] });
const group = (uid: string, pair: string) => ({ type: "group", uid, path: [pair, uid] });
const line = (type: string, uid: string, path: string[], uid_product?: string) => ({ type, uid, path, ...(uid_product ? { uid_product } : {}), quantity: 1 });

Deno.test("rekeyPayableLines: a kit's components follow their re-keyed parent; dividers keep their uids", () => {
  const rows = [
    dest(PAIR_A),
    line("sale", old(1), [PAIR_A, old(1)], KIT),
    line("sale", old(2), [PAIR_A, old(1), old(2)], VEST),
  ];
  const { items, map, collisions } = rekeyPayableLines(rows);
  assertEquals(items.map((r) => r.path), [[PAIR_A], [PAIR_A, KIT], [PAIR_A, KIT, VEST]]);
  assertEquals(items.map((r) => r.uid), [PAIR_A, KIT, VEST]);
  assertEquals((items[1] as { quantity?: number }).quantity, 1, "every other key is carried");
  assertEquals(collisions, []);
  assertEquals(map.toPath([PAIR_A, old(1), old(2)]), [PAIR_A, KIT, VEST]);
  assertEquals(map.toPath([PAIR_A, old(9)]), undefined);
});

Deno.test("rekeyPayableLines: one product under two pairs is two rows with one uid and two paths", () => {
  const rows = [dest(PAIR_A), line("rental", old(1), [PAIR_A, old(1)], VEST), dest(PAIR_B), line("rental", old(2), [PAIR_B, old(2)], VEST)];
  const { items, collisions } = rekeyPayableLines(rows);
  assertEquals(items.map((r) => r.path), [[PAIR_A], [PAIR_A, VEST], [PAIR_B], [PAIR_B, VEST]]);
  assertEquals(collisions, []);
});

Deno.test("rekeyPayableLines: a service line takes custom- + its old uid, under its group", () => {
  const rows = [dest(PAIR_A), group(GROUP, PAIR_A), line("service", old(3), [PAIR_A, GROUP, old(3)], VEST)];
  const { items } = rekeyPayableLines(rows);
  assertEquals(items[2].uid, `custom-${old(3)}`);
  assertEquals(items[2].path, [PAIR_A, GROUP, `custom-${old(3)}`]);
});

Deno.test("rekeyPayableLines: a bill's lines keep their leading purchase divider", () => {
  const rows = [
    { type: "purchase", uid: PURCHASE, path: [PURCHASE] },
    { type: "destination", uid: PAIR_A, path: [PURCHASE, PAIR_A] },
    line("sale", old(1), [PURCHASE, PAIR_A, old(1)], VEST),
  ];
  const { items } = rekeyPayableLines(rows);
  assertEquals(items.map((r) => r.path), [[PURCHASE], [PURCHASE, PAIR_A], [PURCHASE, PAIR_A, VEST]]);
});

Deno.test("rekeyPayableLines: a product twice under one parent is reported, never merged (PO-313)", () => {
  const rows = [dest(PAIR_A), line("sale", old(1), [PAIR_A, old(1)], VEST), line("sale", old(2), [PAIR_A, old(2)], VEST)];
  const { items, collisions } = rekeyPayableLines(rows);
  assertEquals(items.length, 3);
  assertEquals(collisions, [{ index: 2, earlier: 1, path: [PAIR_A, VEST] }]);
});

Deno.test("rekeyPayableLines: a fixed point — keyed rows come back unchanged, with an identity map", () => {
  const rows = [dest(PAIR_A), line("sale", old(1), [PAIR_A, old(1)], KIT), line("sale", old(2), [PAIR_A, old(1), old(2)], VEST), line("service", old(3), [PAIR_A, old(3)])];
  const once = rekeyPayableLines(rows).items;
  const twice = rekeyPayableLines(once);
  assertEquals(twice.items, once);
  for (const row of once) assertEquals(twice.map.toPath(row.path), row.path);
});

Deno.test("rekeyPayablePointer: exact where the row stands; a dangling pointer kept and reported, never thrown", () => {
  const rows = [dest(PAIR_A), line("sale", old(1), [PAIR_A, old(1)], KIT), line("sale", old(2), [PAIR_A, old(1), old(2)], VEST)];
  const { map } = rekeyPayableLines(rows);
  assertEquals(rekeyPayablePointer(map, [PAIR_A, old(1), old(2)]), { path: [PAIR_A, KIT, VEST], exact: true });
  // A spent substitution naming a removed component: the kit above it is re-keyed, the gone leaf kept.
  assertEquals(rekeyPayablePointer(map, [PAIR_A, old(1), old(8)]), { path: [PAIR_A, KIT, old(8)], exact: false });
  assertEquals(rekeyPayablePointer(map, [PAIR_B, old(9)]), { path: [PAIR_B, old(9)], exact: false });
});
