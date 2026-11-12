/**
 * The inbound ladder's derivations (`utils/bookings-inbound.ts`,
 * one-document-model 7a C6–C8): the projection, the booking status, the
 * custody-only purchase status, the cancel refusal, and the received / returned
 * counts that replaced the purchase line buckets.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
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
  custodyBySourceItem,
  deriveInboundBookingStatus,
  derivePurchaseStatus,
  inboundCancelRefusal,
  inboundCustodyCounts,
  inboundLiveCustody,
  inboundReceived,
  inboundReturned,
  isInboundBookingClosed,
  lineCustodyAt,
  NO_LINE_CUSTODY,
  type SourceItemMovement,
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

// ── Received and returned, derived (C8) ─────────────────────────────

Deno.test("inboundReceived / inboundReturned: the C12 identity, pinned key by key", () => {
  // Each key alone, so a key moved between the sets — or a new key — is seen.
  const received = ["received", "stocked", "transit_outbound", "sent_back", "lost", "damaged"];
  const returned = ["sent_back", "lost", "damaged"];
  for (const key of INBOUND_BREAKDOWN_KEYS) {
    const one = bd({ [key]: 1 });
    assertEquals(inboundReceived(one), received.includes(key) ? 1 : 0, `received counts ${key}?`);
    assertEquals(inboundReturned(one), returned.includes(key) ? 1 : 0, `returned counts ${key}?`);
  }
  // Nothing promised or still on its way counts as received.
  assertEquals(inboundReceived(bd({ quoted: 4, ordered: 3, transit_inbound: 2 })), 0);
  assertEquals(inboundCustodyCounts(bd({ ordered: 1, stocked: 2, sent_back: 3, lost: 1 })), { received: 6, returned: 4 });
});

const LEG = "9a1b2c3d-0000-4000-8000-0000000000d1";
const ROW = [LEG, "testprod100000000000"];
const OTHER = [LEG, "testprod200000000000"];
const step = (
  from: string | null,
  to: string | null,
  quantity: number,
  path: string[] | undefined = ROW,
): SourceItemMovement => ({ path_source_item: path, custody: { from, to } as SourceItemMovement["custody"], quantity });

Deno.test("custodyBySourceItem: each row's net custody, read as received and returned", () => {
  const journal = [
    step("ordered", "received", 3), // receive
    step("received", "stocked", 3), // put away
    step("stocked", "sent_back", 2), // send back
    step("sent_back", "stocked", 1), // a reversed send-back: its pair swapped
    step("stocked", "lost", 1), // settle
    step("ordered", "received", 4, OTHER),
    step("received", "ordered", 1, OTHER), // an undone receipt
  ];
  const custody = custodyBySourceItem(journal);
  assertEquals(lineCustodyAt(custody, ROW), { received: 3, returned: 2 });
  assertEquals(lineCustodyAt(custody, OTHER), { received: 3, returned: 0 });
  // A row nothing names has nothing.
  assertEquals(lineCustodyAt(custody, [LEG, "testprod300000000000"]), NO_LINE_CUSTODY);
});

Deno.test("custodyBySourceItem: a row-less or custody-less movement is skipped, and a damage flag on arrival counts once", () => {
  const custody = custodyBySourceItem([
    step("ordered", "received", 2),
    step("received", "damaged", 1), // receive_flag {none → damaged}
    { ...step("ordered", "received", 9), path_source_item: undefined },
    { ...step("ordered", "received", 9), custody: null },
  ]);
  assertEquals(lineCustodyAt(custody, ROW), { received: 2, returned: 1 });
});

Deno.test("custodyBySourceItem agrees with the booking it replays, for a row that holds its grain alone", () => {
  // The fold applies each movement to a net breakdown exactly as the booking's
  // own replay does, so on a one-row grain the two answers are one number.
  const journal = [step("ordered", "received", 5), step("received", "stocked", 4), step("stocked", "sent_back", 2)];
  const booking = bd({ ordered: 0, received: 1, stocked: 2, sent_back: 2 });
  assertEquals(lineCustodyAt(custodyBySourceItem(journal), ROW), inboundCustodyCounts(booking));
  assert(inboundReturned(booking) <= inboundReceived(booking));
});
