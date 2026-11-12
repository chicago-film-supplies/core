/**
 * The inbound ladder's derivations (`utils/bookings-inbound.ts`,
 * one-document-model 7a C6–C7): the projection, the booking status, the
 * custody-only purchase status and the cancel refusal.
 */
import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  emptyInboundBreakdown,
  INBOUND_BOOKING_TYPES,
  INBOUND_BREAKDOWN_KEYS,
  type InboundBookingTypeType,
  type InboundBreakdown,
  PURCHASE_STATUSES,
  PURCHASE_STATUS_TRAITS,
} from "../src/schemas/mod.ts";
import {
  calculateInboundBreakdown,
  deriveInboundBookingStatus,
  derivePurchaseStatus,
  inboundCancelRefusal,
  inboundLiveCustody,
  isInboundBookingClosed,
  sumInboundBreakdown,
} from "../src/utils/bookings-inbound.ts";
import { derivePurchaseStatus as viaPurchases } from "../src/utils/purchases.ts";

const bd = (over: Partial<InboundBreakdown>): InboundBreakdown => ({ ...emptyInboundBreakdown(), ...over });
const bk = (type: InboundBookingTypeType, over: Partial<InboundBreakdown>, uid = "b1") => ({
  uid,
  type,
  breakdown: bd(over),
});

Deno.test("PURCHASE_STATUS_TRAITS: total, only canceled authored, and canceled books no plan", () => {
  assertEquals(Object.keys(PURCHASE_STATUS_TRAITS).sort(), [...PURCHASE_STATUSES].sort());
  assertEquals(PURCHASE_STATUSES.filter((s) => PURCHASE_STATUS_TRAITS[s].authored), ["canceled"]);
  assertEquals(PURCHASE_STATUS_TRAITS.canceled.planBucket, null);
  assertEquals(PURCHASE_STATUS_TRAITS.complete.planBucket, "ordered", "a raise on a complete purchase is ordered work");
});

Deno.test("calculateInboundBreakdown: the plan is quantity − carried, floored; custody is carried as it stands", () => {
  assertEquals(calculateInboundBreakdown("active", "sale", 5), bd({ ordered: 5 }));
  assertEquals(calculateInboundBreakdown("active", "sale", 5, bd({ ordered: 5, received: 2 })), bd({ ordered: 3, received: 2 }));
  // A stale plan is replaced, never added to.
  assertEquals(calculateInboundBreakdown("active", "sale", 5, bd({ ordered: 9, stocked: 1 })), bd({ ordered: 4, stocked: 1 }));
  // An over-receipt keeps its units: the physical number follows the breakdown.
  const over = calculateInboundBreakdown("active", "sale", 2, bd({ stocked: 3 }));
  assertEquals(over, bd({ stocked: 3 }));
  assertEquals(sumInboundBreakdown(over), 3);
  // A complete purchase raised past what came books the raise as ordered.
  assertEquals(calculateInboundBreakdown("complete", "rental", 4, bd({ sent_back: 3 })), bd({ ordered: 1, sent_back: 3 }));
});

Deno.test("calculateInboundBreakdown: canceled keeps every history key and drops the plan (the keepCustodyOnly arm)", () => {
  const prev = bd({ quoted: 1, ordered: 4, received: 1, stocked: 2, sent_back: 1 });
  assertEquals(calculateInboundBreakdown("canceled", "rental", 9, prev), bd({ received: 1, stocked: 2, sent_back: 1 }));
});

Deno.test("isInboundBookingClosed: a Buy closes on a shelf or damaged; a Subrent only once its units are back or settled", () => {
  assertEquals(isInboundBookingClosed(bk("sale", { stocked: 2, damaged: 1 })), true);
  assertEquals(isInboundBookingClosed(bk("sale", { stocked: 2, received: 1 })), false, "a unit in receiving is still work");
  assertEquals(isInboundBookingClosed(bk("rental", { stocked: 2 })), false, "a rented unit on a CFS shelf must go back");
  assertEquals(isInboundBookingClosed(bk("rental", { sent_back: 2, lost: 1, damaged: 1 })), true);
  assertEquals(isInboundBookingClosed(bk("sale", {})), true, "a booking holding nothing is closed");
  assertEquals(isInboundBookingClosed(bk("sale", { ordered: 1 })), false);
});

Deno.test("deriveInboundBookingStatus: ordered → active → complete, read off the breakdown", () => {
  assertEquals(deriveInboundBookingStatus(bk("sale", { ordered: 3 })), "ordered");
  assertEquals(deriveInboundBookingStatus(bk("sale", { ordered: 2, received: 1 })), "active");
  assertEquals(deriveInboundBookingStatus(bk("sale", { stocked: 3 })), "complete");
  assertEquals(deriveInboundBookingStatus(bk("rental", { stocked: 3 })), "active");
  assertEquals(deriveInboundBookingStatus(bk("rental", { sent_back: 3 })), "complete");
});

Deno.test("derivePurchaseStatus: custody-only, canceled authored, and a purchase booking nothing is complete (rulings 55, 56, 61)", () => {
  const open = bk("sale", { ordered: 1, stocked: 1 });
  const done = bk("sale", { stocked: 2 });
  for (const stored of ["active", "complete"] as const) {
    assertEquals(derivePurchaseStatus(stored, [done, open]), "active", `${stored}: one open booking holds it open`);
    assertEquals(derivePurchaseStatus(stored, [done]), "complete", `${stored}: every booking closed`);
    assertEquals(derivePurchaseStatus(stored, []), "complete", `${stored}: books nothing (ruling 61)`);
  }
  assertEquals(derivePurchaseStatus("canceled", [open]), "canceled");
  assertEquals(derivePurchaseStatus("canceled", []), "canceled");
  // PO-92 / PO-93's shape: received in full, never billed. Billing holds nothing open (ruling 55).
  assertEquals(derivePurchaseStatus("active", [bk("sale", { stocked: 4 })]), "complete");
  assertEquals(viaPurchases, derivePurchaseStatus, "@cfs/core/utils/purchases re-exports the one function");
});

Deno.test("inboundLiveCustody and the cancel refusal read the isInboundLive keys per type", () => {
  assertEquals(inboundLiveCustody(bk("sale", { transit_inbound: 1, received: 2, stocked: 5 })), 3);
  assertEquals(inboundLiveCustody(bk("rental", { received: 1, stocked: 2, transit_outbound: 1, sent_back: 9 })), 4);

  assertEquals(inboundCancelRefusal([bk("sale", { ordered: 3, stocked: 2 }), bk("rental", { sent_back: 1 }, "b2")]), null);

  const refused = inboundCancelRefusal([
    bk("sale", { received: 2, stocked: 1 }, "buy"),
    bk("rental", { stocked: 3 }, "hire"),
    bk("rental", { sent_back: 2 }, "back"),
  ]);
  assertEquals(refused?.bookings, [
    { uid: "buy", live: { received: 2 } },
    { uid: "hire", live: { stocked: 3 } },
  ]);
  assertStringIncludes(refused!.message, "5 unit(s) on 2 inbound booking(s)");
});

Deno.test("the derivations are total over every inbound type and key", () => {
  for (const type of INBOUND_BOOKING_TYPES) {
    for (const key of INBOUND_BREAKDOWN_KEYS) {
      const b = bk(type, { [key]: 1 });
      const status = deriveInboundBookingStatus(b);
      // Closed exactly when the one occupied key is terminal; live custody never on a closed booking.
      if (isInboundBookingClosed(b)) assertEquals(inboundLiveCustody(b), 0, `${type}.${key}`);
      assertEquals(status === "complete", isInboundBookingClosed(b), `${type}.${key}`);
    }
  }
});
