/**
 * W4K (one-document-model, owner ruling 12, 2026-11-10): a payable catalog
 * line's `uid` is its product's, as an order or invoice line's is. Since 7a
 * (owner, 2026-11-11) the uid is the ONLY place it names the product: the
 * separate `uid_product` key is gone from every line, a service's included. The key
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

Deno.test("payableLineUid: a line keeps a uid naming a product; a service or replacement naming none takes custom-", () => {
  // 7a (owner, 2026-11-11): the uid is the only place a line names its product.
  assertEquals(payableLineUid({ type: "sale", uid: VEST }), VEST);
  assertEquals(payableLineUid({ type: "rental", uid: VEST }), VEST);
  assertEquals(payableLineUid({ type: "replacement", uid: VEST }), VEST);
  assertEquals(payableLineUid({ type: "replacement", uid: `custom-${old(1)}` }), `custom-${old(1)}`);
  // A service names its catalog SERVICE product by its uid, as an invoice line does.
  assertEquals(payableLineUid({ type: "service", uid: VEST }), VEST);
  // A service naming no product: the old uid is kept behind the prefix.
  assertEquals(payableLineUid({ type: "service", uid: old(1) }), `custom-${old(1)}`);
  // Already keyed: unchanged, so a re-key is repeatable.
  assertEquals(payableLineUid({ type: "service", uid: `custom-${old(1)}` }), `custom-${old(1)}`);
  assertThrows(() => payableLineUid({ type: "sale", uid: `custom-${old(1)}` }), Error, "names no product");
});

Deno.test("payableLineUidIssue: the stored rule, both directions", () => {
  assertEquals(payableLineUidIssue({ type: "sale", uid: VEST }), null);
  assertEquals(payableLineUidIssue({ type: "service", uid: `custom-${old(1)}` }), null);
  assertEquals(payableLineUidIssue({ type: "replacement", uid: `custom-${old(1)}` }), null);
  assertEquals(payableLineUidIssue({ type: "replacement", uid: VEST }), null);
  assert(payableLineUidIssue({ type: "sale", uid: `custom-${old(1)}` })?.includes("product"));
  assert(payableLineUidIssue({ type: "rental", uid: `custom-${old(1)}` })?.includes("product"));
  assertEquals(payableLineUidIssue({ type: "service", uid: VEST }), null, "a catalog service line");
  // A bare uuid names no catalog product and is not custom-: refused on both no-custody arms.
  assert(payableLineUidIssue({ type: "service", uid: old(1) })?.includes("custom-"));
  assert(payableLineUidIssue({ type: "replacement", uid: old(1) })?.includes("custom-"));
});

Deno.test("payableInputUidIssue: a sale or rental names its product by its uid; a service's uid is the writer's", () => {
  assertEquals(payableInputUidIssue({ type: "service", uid: old(1) }), null);
  assertEquals(payableInputUidIssue({ type: "replacement", uid: old(1) }), null);
  assertEquals(payableInputUidIssue({ type: "rental", uid: VEST }), null);
  assert(payableInputUidIssue({ type: "rental", uid: `custom-${old(1)}` }) !== null);
});

// ── the input refines ──────────────────────────────────────────────

Deno.test("PurchaseItemInput: a catalog line names its product by its uid, and a custom- uid is refused at `uid`", () => {
  const line = { type: "sale", uid: VEST, path: [PAIR_A, VEST], quantity: 1, price: { stated_cents: 100 } };
  assert(PurchaseItemInput.safeParse(line).success, "control");
  const custom = PurchaseItemInput.safeParse({ ...line, uid: `custom-${old(1)}`, path: [PAIR_A, `custom-${old(1)}`] });
  assertEquals(custom.error?.issues.map((i) => i.path.join(".")), ["uid"]);
  const rental = PurchaseItemInput.safeParse({ ...line, type: "rental", uid: `custom-${old(1)}`, path: [PAIR_A, `custom-${old(1)}`] });
  assertEquals(rental.error?.issues.map((i) => i.path.join(".")), ["uid"]);
  // A retired `uid_product` on a sale line is stripped, never stored.
  const echoed = PurchaseItemInput.safeParse({ ...line, uid_product: VEST });
  assert(echoed.success && !("uid_product" in echoed.data), "a sale input carries no uid_product");
  const replacement = { type: "replacement", uid: old(2), path: [PAIR_A, old(2)], name: "Lost unit", ledger_account: 5300, out_of_service: [{ uid: "testoos0000000000001", quantity: 1 }] };
  assert(PurchaseItemInput.safeParse(replacement).success, "the writer derives the twin or mints its custom- uid");
  // A service names its catalog product by its uid too; an attribution key is stripped.
  const service = PurchaseItemInput.safeParse({ type: "service", uid: VEST, path: [PAIR_A, VEST], name: "Freight", ledger_account: 5300, uid_product: VEST });
  assert(service.success && !("uid_product" in service.data), "no line input carries uid_product");
});

Deno.test("PurchaseBillRowInput: a sale or rental row names its product by its uid", () => {
  const row = { type: "rental", uid: VEST, path: [PURCHASE, PAIR_A, VEST] };
  assert(PurchaseBillRowInput.safeParse(row).success, "control");
  const custom = PurchaseBillRowInput.safeParse({ ...row, uid: `custom-${old(1)}`, path: [PURCHASE, PAIR_A, `custom-${old(1)}`] });
  assertEquals(custom.error?.issues.map((i) => i.path.join(".")), ["uid"]);
  const stripped = PurchaseBillRowInput.safeParse({ ...row, uid_product: VEST });
  assert(stripped.success && !("uid_product" in stripped.data), "no bill row carries uid_product");
  const service = PurchaseBillRowInput.safeParse({ type: "service", uid: `custom-${old(2)}`, path: [PURCHASE, PAIR_A, `custom-${old(2)}`], uid_product: VEST });
  assert(service.success && !("uid_product" in service.data), "a service row's included");
});

// ── the re-key author ──────────────────────────────────────────────
//
// Since 7a a sale or rental row names its product BY its uid, so the re-key
// leaves it where it stands; what it still re-keys is a service row (and a
// product-less replacement) onto its `custom-` uid, and the paths that name it.

const dest = (uid: string) => ({ type: "destination", uid, path: [uid] });
const group = (uid: string, pair: string) => ({ type: "group", uid, path: [pair, uid] });
const line = (type: string, uid: string, path: string[]) => ({ type, uid, path, quantity: 1 });

Deno.test("rekeyPayableLines: a kit keyed by its products is unchanged; dividers keep their uids", () => {
  const rows = [dest(PAIR_A), line("sale", KIT, [PAIR_A, KIT]), line("sale", VEST, [PAIR_A, KIT, VEST])];
  const { items, map, collisions } = rekeyPayableLines(rows);
  assertEquals(items, rows);
  assertEquals(collisions, []);
  assertEquals(map.toPath([PAIR_A, KIT, VEST]), [PAIR_A, KIT, VEST]);
  assertEquals(map.toPath([PAIR_A, old(9)]), undefined);
});

Deno.test("rekeyPayableLines: one product under two pairs is two rows with one uid and two paths", () => {
  const rows = [dest(PAIR_A), line("rental", VEST, [PAIR_A, VEST]), dest(PAIR_B), line("rental", VEST, [PAIR_B, VEST])];
  const { items, collisions } = rekeyPayableLines(rows);
  assertEquals(items.map((r) => r.path), [[PAIR_A], [PAIR_A, VEST], [PAIR_B], [PAIR_B, VEST]]);
  assertEquals(collisions, []);
});

Deno.test("rekeyPayableLines: a service line takes custom- + its old uid, under its group", () => {
  const rows = [dest(PAIR_A), group(GROUP, PAIR_A), line("service", old(3), [PAIR_A, GROUP, old(3)])];
  const { items, map } = rekeyPayableLines(rows);
  assertEquals(items[2].uid, `custom-${old(3)}`);
  assertEquals(items[2].path, [PAIR_A, GROUP, `custom-${old(3)}`]);
  assertEquals(map.toPath([PAIR_A, GROUP, old(3)]), [PAIR_A, GROUP, `custom-${old(3)}`]);
});

Deno.test("rekeyPayableLines: a bill's lines keep their leading purchase divider", () => {
  const rows = [
    { type: "purchase", uid: PURCHASE, path: [PURCHASE] },
    { type: "destination", uid: PAIR_A, path: [PURCHASE, PAIR_A] },
    line("sale", VEST, [PURCHASE, PAIR_A, VEST]),
    line("service", old(4), [PURCHASE, PAIR_A, old(4)]),
  ];
  const { items } = rekeyPayableLines(rows);
  assertEquals(items.map((r) => r.path), [[PURCHASE], [PURCHASE, PAIR_A], [PURCHASE, PAIR_A, VEST], [PURCHASE, PAIR_A, `custom-${old(4)}`]]);
});

Deno.test("rekeyPayableLines: a product twice under one parent is reported, never merged (PO-313)", () => {
  const rows = [dest(PAIR_A), line("sale", VEST, [PAIR_A, VEST]), line("sale", VEST, [PAIR_A, VEST])];
  const { items, collisions } = rekeyPayableLines(rows);
  assertEquals(items.length, 3);
  assertEquals(collisions, [{ index: 2, earlier: 1, path: [PAIR_A, VEST] }]);
});

Deno.test("rekeyPayableLines: a fixed point — keyed rows come back unchanged, with an identity map", () => {
  const rows = [dest(PAIR_A), line("sale", KIT, [PAIR_A, KIT]), line("sale", VEST, [PAIR_A, KIT, VEST]), line("service", old(3), [PAIR_A, old(3)])];
  const once = rekeyPayableLines(rows).items;
  const twice = rekeyPayableLines(once);
  assertEquals(twice.items, once);
  for (const row of once) assertEquals(twice.map.toPath(row.path), row.path);
});

Deno.test("rekeyPayablePointer: exact where the row stands; a dangling pointer kept and reported, never thrown", () => {
  const rows = [dest(PAIR_A), line("service", old(1), [PAIR_A, old(1)])];
  const { map } = rekeyPayableLines(rows);
  assertEquals(rekeyPayablePointer(map, [PAIR_A, old(1)]), { path: [PAIR_A, `custom-${old(1)}`], exact: true });
  assertEquals(rekeyPayablePointer(map, [PAIR_B, old(9)]), { path: [PAIR_B, old(9)], exact: false });
});
