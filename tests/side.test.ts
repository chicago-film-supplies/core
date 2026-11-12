/**
 * `SIDE_CONTRACTS` (`schemas/side.ts`) and the shared line types the payable
 * grains take (api-cloudrun's `one-document-model` plan, Phase 1).
 *
 * Each claim is asserted against a fact stated somewhere else in the package,
 * never against the table itself, so a wrong entry cannot agree with its own
 * restatement.
 */
import { assert, assertEquals } from "@std/assert";
import {
  COA_ASSET_CODES,
  COA_COST_CODES,
  COA_EXPENSED_ASSET_CODES,
  FULFILLMENT_LINE_ITEM_TYPES,
  ITEM_CONTRACTS,
  MOVEMENT_CONTRACTS,
  PRE_TAX_ITEM_TYPES,
  payablePostingIssues,
  PURCHASE_ITEM_TYPES,
  PURCHASE_PRODUCT_ITEM_TYPES,
  PurchaseDocumentItemSchema,
  PurchaseItemSchema,
  SHARED_LINE_TYPES,
  SIDE_CONTRACTS,
  SIDES,
  SUBSTITUTABLE_ITEM_TYPES,
} from "../src/schemas/mod.ts";

Deno.test("SIDE_CONTRACTS is total over both sides and every shared line type", () => {
  assertEquals(Object.keys(SIDE_CONTRACTS).sort(), [...SIDES].sort());
  for (const side of SIDES) {
    const c = SIDE_CONTRACTS[side];
    for (const entry of [c.line_labels, c.posting_class, c.custody]) {
      assertEquals(Object.keys(entry).sort(), [...SHARED_LINE_TYPES].sort(), side);
    }
  }
});

Deno.test("the payable grains take exactly the shared line types (owner, 2026-11-07)", () => {
  assertEquals([...PURCHASE_ITEM_TYPES].sort(), [...SHARED_LINE_TYPES].sort());
  // Every shared type is also a receivable line type, so the vocabulary is
  // genuinely shared rather than parallel.
  for (const t of SHARED_LINE_TYPES) assert(t in ITEM_CONTRACTS, `${t} is not a receivable line type`);
});

Deno.test("receivable custody is ITEM_CONTRACTS.fulfillable, restated literally — and the two agree", () => {
  // A schema table cannot import a derived set, so the receivable row is a
  // literal copy. This is the assertion that keeps the copy honest.
  for (const t of SHARED_LINE_TYPES) {
    assertEquals(
      SIDE_CONTRACTS.receivable.custody[t],
      ITEM_CONTRACTS[t].fulfillable ? "custody" : "none",
      t,
    );
  }
  // And the derived receivable set is unchanged by the payable side (0b ruling:
  // FULFILLABLE / SUBSTITUTABLE stay receivable-only).
  assertEquals([...FULFILLMENT_LINE_ITEM_TYPES].sort(), ["rental", "sale", "service"]);
  assertEquals([...SUBSTITUTABLE_ITEM_TYPES].sort(), ["rental", "sale"]);
  assertEquals([...PRE_TAX_ITEM_TYPES].sort(), ["rental", "replacement", "sale", "service", "surcharge"]);
});

Deno.test("payable custody is exactly the arms that ORDER a product", () => {
  // A freight line must never land on a receipt, and a supplier's lost-unit
  // charge bills a record, not custody (0b design decision).
  const custody = SHARED_LINE_TYPES.filter((t) => SIDE_CONTRACTS.payable.custody[t] === "custody");
  assertEquals(custody.sort(), [...PURCHASE_PRODUCT_ITEM_TYPES].sort());
  assertEquals([...PURCHASE_PRODUCT_ITEM_TYPES].sort(), ["rental", "sale"]);
});

Deno.test("payable labels are the operator's names: Buy, Subrent, Charge", () => {
  assertEquals(SIDE_CONTRACTS.payable.line_labels.sale, "Buy");
  assertEquals(SIDE_CONTRACTS.payable.line_labels.rental, "Subrent");
  assertEquals(SIDE_CONTRACTS.payable.line_labels.service, "Charge");
});

Deno.test("payablePostingIssues: each class against the account lists it names", () => {
  const ok = (type: Parameters<typeof payablePostingIssues>[0], code: number) =>
    payablePostingIssues(type, code).length === 0;
  for (const code of [...COA_ASSET_CODES, ...COA_EXPENSED_ASSET_CODES]) assert(ok("sale", code), `sale ${code}`);
  for (const code of [6000, 5100, 4000]) assert(!ok("sale", code), `sale ${code} must be refused`);
  for (const code of COA_COST_CODES) assert(ok("rental", code), `rental ${code}`);
  for (const code of [1999, 6500]) assert(!ok("rental", code), `rental ${code} must be refused`);
  for (const code of [6000, 6100, 1400, 5300]) {
    assert(ok("service", code), `service ${code}`);
    assert(ok("replacement", code), `replacement ${code}`);
  }
  assertEquals(payablePostingIssues("sale", 6000)[0].path, ["ledger_account"]);
});

Deno.test("each payable union refuses the receivable-only and the retired types", () => {
  for (const type of ["surcharge", "transaction_fee", "buy", "subrent", "charge", "destination"]) {
    assertEquals(PurchaseItemSchema.safeParse({ type }).success, false, `purchase ${type}`);
    assertEquals(PurchaseDocumentItemSchema.safeParse({ type }).success, false, `bill ${type}`);
  }
});

Deno.test("SIDE_CONTRACTS: each side's custody ladder is the one its custody movements stand on (C11)", () => {
  // Stated against the movement contracts, never against the table: a payable
  // receipt is a `purchase` / `subrent_in`, a receivable prep a `prep`.
  assertEquals(SIDE_CONTRACTS.payable.custody_ladder, MOVEMENT_CONTRACTS.purchase.booking_ladder);
  assertEquals(SIDE_CONTRACTS.payable.custody_ladder, MOVEMENT_CONTRACTS.subrent_in.booking_ladder);
  assertEquals(SIDE_CONTRACTS.receivable.custody_ladder, MOVEMENT_CONTRACTS.prep.booking_ladder);
  assert(SIDE_CONTRACTS.payable.custody_ladder !== SIDE_CONTRACTS.receivable.custody_ladder);
});
