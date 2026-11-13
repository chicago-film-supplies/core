/**
 * `exchanged_for` on a BILLING document (ruling 82 of the one-document-model plan):
 * `billingExchangedForViolations` and the invoice's `checkInvoiceExchangedFor`, and the
 * projection that carries the field (`projectOrderItemToInvoiceItem`).
 *
 * Every rule here has its complement, because the billing form is the custody rule
 * run per scope with ONE deferral, and a deferral that swallowed too much would read
 * as a pass.
 */
import { assertEquals } from "@std/assert";
import { billingExchangedForViolations, exchangedForViolations } from "../src/schemas/mod.ts";
import { projectOrderItemToInvoiceItem } from "../src/utils/invoices.ts";
import type { LineItem } from "../src/utils/orders.ts";

const O = "orderoooooooooooooo1";
const PARENT = "11111111-1111-4111-8111-111111111111";
const EXCHANGE = "22222222-2222-4222-8222-222222222222";
const SIBLING = "33333333-3333-4333-8333-333333333333";
const X = "prodxxxxxxxxxxxxxxxx";

const entry = (path: string[], reason: "damaged" | "lost" = "damaged") => ({ path, quantity: 1, reason });

/** An invoice billing order O's exchange leg only — its parent leg is billed elsewhere. */
function doc(exchanged_for: ReturnType<typeof entry>[], disposition = "same_trip") {
  return {
    destinations: [{ uid: EXCHANGE, uid_order: O, exchange: { uid_pair: PARENT, disposition: disposition as "same_trip" } }],
    items: [
      { path: [O] },
      { path: [O, EXCHANGE] },
      { path: [O, EXCHANGE, X], exchanged_for },
    ],
  };
}

Deno.test("billing: a pointer at the PARENT leg passes, though this invoice does not carry it", () => {
  assertEquals(billingExchangedForViolations(doc([entry([PARENT, X])]), "uid_order"), []);
});

Deno.test("billing: a leg this invoice does not carry is DEFERRED (a sibling may be billed elsewhere)", () => {
  assertEquals(billingExchangedForViolations(doc([entry([SIBLING, X])]), "uid_order"), []);
});

Deno.test("…and its complement: the CUSTODY form refuses that same leg", () => {
  const custody = {
    destinations: [{ uid: PARENT, exchange: null }, { uid: EXCHANGE, exchange: { uid_pair: PARENT, disposition: "same_trip" as const } }],
    items: [{ path: [EXCHANGE, X], exchanged_for: [entry([SIBLING, X])] }],
  };
  assertEquals(exchangedForViolations(custody).length, 1);
});

Deno.test("billing: a pointer at the exchange's OWN leg is refused — the deferral is not a hole", () => {
  const v = billingExchangedForViolations(doc([entry([EXCHANGE, X])]), "uid_order");
  assertEquals(v.map((x) => [x.index, x.field]), [[2, "path"]], "the index is the INVOICE row's, not the scope's");
});

Deno.test("billing: the reason is still checked against the disposition", () => {
  const v = billingExchangedForViolations(doc([entry([PARENT, X], "lost")]), "uid_order");
  assertEquals(v.map((x) => x.field), ["reason"]);
});

Deno.test("billing: `exchanged_for` under no exchange pair is refused", () => {
  const d = doc([entry([PARENT, X])]);
  d.destinations[0].exchange = null as unknown as typeof d.destinations[0]["exchange"];
  assertEquals(billingExchangedForViolations(d, "uid_order").map((x) => x.field), ["exchanged_for"]);
});

Deno.test("billing: pairs are scoped by `uid_order` — another order's exchange pair of the same uid does not count", () => {
  const d = doc([entry([PARENT, X])]);
  d.destinations[0].uid_order = "orderother000000000";
  assertEquals(billingExchangedForViolations(d, "uid_order").map((x) => x.field), ["exchanged_for"]);
});

Deno.test("projection: an exchange line's list is carried ORDER-relative; a line stating none carries none", () => {
  const line = {
    uid: X,
    type: "rental",
    name: "X",
    path: [EXCHANGE, X],
    quantity: 1,
    uid_tax_class: "TaxC1assDefau1tAAAAA",
    exchanged_for: [entry([PARENT, X])],
  } as LineItem;
  assertEquals((projectOrderItemToInvoiceItem(line, O) as { exchanged_for?: unknown }).exchanged_for, [entry([PARENT, X])]);
  const { exchanged_for: _none, ...plain } = line;
  assertEquals("exchanged_for" in projectOrderItemToInvoiceItem(plain as LineItem, O), false);
});
