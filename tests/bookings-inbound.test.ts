/**
 * The inbound ladder's derivations (`utils/bookings-inbound.ts`,
 * one-document-model 7a C6–C8): the projection, the booking status, the
 * custody-only purchase status, the cancel refusal, and the received / returned
 * counts that replaced the purchase line buckets.
 */
import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
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
  applyInboundCustodyActions,
  calculateInboundBreakdown,
  custodyBySourceItem,
  inboundBookingIdFor,
  isReceiveDamagedMark,
  receiveDamagedReasonRefusal,
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
import { CustodyRefusal } from "../src/utils/custody.ts";
import { firstNegativePrefix } from "../src/utils/journal.ts";

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

// ── applyInboundCustodyActions (W3, the inbound lever's pure half) ──

const act = (rule: Parameters<typeof applyInboundCustodyActions>[1][number]["rule"], quantity: number, units?: number[]) => ({
  rule,
  quantity,
  path_source_item: [...ROW],
  ...(units ? { units: units.map((number) => ({ number })) } : {}),
});

Deno.test("applyInboundCustodyActions: receive, put away and send back walk a Subrent up its ladder, one movement each", () => {
  const app = applyInboundCustodyActions(
    { type: "rental", breakdown: bd({ ordered: 5 }) },
    [act("receive", 5), act("put_away", 4), act("send_back", 2)],
  );
  assertEquals(app.breakdown, bd({ received: 1, stocked: 2, sent_back: 2 }));
  assertEquals(app.transitions.map((t) => [t.type, t.from, t.to, t.quantity]), [
    ["subrent_in", "ordered", "received", 5],
    ["put_away", "received", "stocked", 4],
    ["subrent_out", "stocked", "sent_back", 2],
  ]);
  assertEquals(app.transitions[0].path_source_item, [...ROW]);
  assertEquals(app.status, "active");
  assertEquals(app.units, null);
});

Deno.test("applyInboundCustodyActions: a Buy receives as a purchase and closes once stocked", () => {
  const app = applyInboundCustodyActions({ type: "sale", breakdown: bd({ ordered: 3 }) }, [act("receive", 3), act("put_away", 3)]);
  assertEquals(app.transitions.map((t) => t.type), ["purchase", "put_away"]);
  assertEquals(app.status, "complete");
});

Deno.test("applyInboundCustodyActions refuses a step its line type may not take, a short bucket, and one movement written twice", () => {
  assertThrows(() => applyInboundCustodyActions({ type: "sale", breakdown: bd({ stocked: 2 }) }, [act("send_back", 1)]), CustodyRefusal, "cannot take");
  assertThrows(() => applyInboundCustodyActions({ type: "rental", breakdown: bd({ ordered: 1 }) }, [act("receive", 2)]), CustodyRefusal, "holds 1");
  // Both are a receive_flag on one row, so they would share a movement id.
  assertThrows(
    () => applyInboundCustodyActions({ type: "rental", breakdown: bd({ received: 2 }) }, [act("receive_damaged", 1), act("receive_damaged_undo", 1)]),
    CustodyRefusal,
    "same \"receive_flag\" movement",
  );
});

Deno.test("applyInboundCustodyActions: a settle is legal here (the record's internal row), with its service axis", () => {
  const app = applyInboundCustodyActions({ type: "rental", breakdown: bd({ stocked: 2 }) }, [act("settle_lost", 1)]);
  assertEquals(app.breakdown, bd({ stocked: 1, lost: 1 }));
  assertEquals(app.transitions[0].type, "return_to_supplier");
  assertEquals(app.transitions[0].service, { from: "lost", to: null });
});

Deno.test("applyInboundCustodyActions on a tracked booking: units are named, follow their bucket, and a held unit is not drawn twice", () => {
  const tracked = { damaged: [], lost: [], received: [], sent_back: [], stocked: [], transit_inbound: [], transit_outbound: [] };
  const app = applyInboundCustodyActions(
    { type: "rental", breakdown: bd({ ordered: 2 }), units: tracked },
    [act("receive", 2, [1001, 1002]), act("put_away", 1, [1002])],
  );
  assertEquals(app.units?.received, [1001]);
  assertEquals(app.units?.stocked, [1002]);
  assertEquals(app.transitions[1].units, [1002]);
  assertThrows(
    () => applyInboundCustodyActions({ type: "rental", breakdown: bd({ ordered: 1 }), units: tracked }, [act("receive", 1)]),
    CustodyRefusal,
    "must name the units",
  );
  assertThrows(
    () => applyInboundCustodyActions({ type: "rental", breakdown: bd({ ordered: 1 }) }, [act("receive", 1, [7])]),
    CustodyRefusal,
    "not unit-tracked",
  );
  assertThrows(
    () => applyInboundCustodyActions(
      { type: "rental", breakdown: bd({ ordered: 1, stocked: 1 }), units: { ...tracked, stocked: [1001] } },
      [act("receive", 1, [1001])],
    ),
    CustodyRefusal,
    "holds it in stocked",
  );
});

Deno.test("firstNegativePrefix: a step dated before the step that filled its source bucket reads negative (ruling 76)", () => {
  const receive = { custody: { from: "ordered" as const, to: "received" as const }, quantity: 2, date: "2026-11-10T10:00:00.000-06:00" };
  const putAway = (date: string) => ({ custody: { from: "received" as const, to: "stocked" as const }, quantity: 2, date });
  assertEquals(firstNegativePrefix([receive, putAway("2026-11-11T09:00:00.000-06:00")], "inbound"), false);
  assertEquals(firstNegativePrefix([receive, putAway("2026-11-09T09:00:00.000-06:00")], "inbound"), true);
  // One instant folds as one step, so the same timestamp is never negative.
  assertEquals(firstNegativePrefix([receive, putAway(receive.date)], "inbound"), false);
});

Deno.test("inboundBookingIdFor — a row books into {purchase}:{product}:{leg}[:{sig}]", async (t) => {
  // Dividers are bare UUIDs: a non-UUID segment reads as a product in the ancestry.
  const LEG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  await t.step("a top-level row's grain is three segments: the leg is path[0], the product the row's uid", () => {
    assertEquals(inboundBookingIdFor("po1", { uid: "prodA", path: [LEG, "prodA"] }), `po1:prodA:${LEG}`);
  });
  await t.step("a group does not enter the grain: two groups on one leg share a booking (ruling 65)", () => {
    assertEquals(
      inboundBookingIdFor("po1", { uid: "prodA", path: [LEG, "11111111-1111-4111-8111-111111111111", "prodA"] }),
      inboundBookingIdFor("po1", { uid: "prodA", path: [LEG, "prodA"] }),
    );
  });
  await t.step("a kit component carries its ancestry as a fourth segment, so it is not its standalone twin's grain", () => {
    const component = inboundBookingIdFor("po1", { uid: "prodA", path: [LEG, "kitK", "prodA"] });
    assertEquals(component.split(":").length, 4);
    assert(component !== inboundBookingIdFor("po1", { uid: "prodA", path: [LEG, "prodA"] }));
  });
});

Deno.test("isReceiveDamagedMark — the forward receive_flag naming its booking, and nothing else (ruling 80)", async (t) => {
  const mark = { type: "receive_flag" as const, service: { from: null, to: "damaged" as const }, uid_booking: "po1:prodA:leg" };
  await t.step("the forward flag is the mark", () => assert(isReceiveDamagedMark(mark)));
  await t.step("no mark, a clearing flag, an outbound flag and a booking-less flag are not", () => {
    assertEquals(isReceiveDamagedMark(null), false);
    assertEquals(isReceiveDamagedMark({ ...mark, service: { from: "damaged", to: null } }), false);
    assertEquals(isReceiveDamagedMark({ ...mark, type: "flag" }), false);
    assertEquals(isReceiveDamagedMark({ ...mark, uid_booking: null }), false);
  });
  await t.step("the refusal names the record", () => assertStringIncludes(receiveDamagedReasonRefusal(42), "#42: it was received damaged"));
});
