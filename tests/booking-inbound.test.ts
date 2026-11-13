/**
 * `InboundBookingSchema` (`schemas/booking-inbound.ts`, one-document-model 7a C5):
 * each document refine planted both ways, so a refine that stopped firing fails
 * here rather than reading as a clean corpus.
 */
import { assert, assertEquals } from "@std/assert";
import {
  BulkInboundBookingUpdateInput,
  emptyInboundBreakdown,
  InboundBookingAction,
  InboundBookingActions,
  emptyInboundUnitSets,
  type InboundBooking,
  InboundBookingSchema,
  schemas,
} from "../src/schemas/mod.ts";
import { getTestDoc, type TestDocOptionsWithNow } from "../src/schemas/testing.ts";
import { mockTimestamp } from "./helpers/timestamp.ts";

const NOW: TestDocOptionsWithNow = { now: mockTimestamp };
const PURCHASE = "PPPPPPPPPPPPPPPPPPPP";
const PRODUCT = "AAAAAAAAAAAAAAAAAAAA";
const LEG = "00000000-0000-4000-8000-000000000000";
const DEST = "DDDDDDDDDDDDDDDDDDDD";
const BACK = "CCCCCCCCCCCCCCCCCCCC";

/** A minimal valid Buy: 2 units ordered, nothing moved. */
function buy(): InboundBooking {
  return getTestDoc(InboundBookingSchema, {
    uid: `${PURCHASE}:${PRODUCT}:${LEG}`,
    source: { collection: "purchases", uid: PURCHASE },
    uid_product: PRODUCT,
    type: "sale",
    status: "ordered",
    quantity: 2,
    quantity_ordered: 2,
    breakdown: { ...emptyInboundBreakdown(), ordered: 2 },
    destinations: { delivery: { uid: DEST, address: null }, collection: null },
    uid_destination_delivery: DEST,
    uid_destination_collection: null,
  }, NOW);
}

/** The issue paths a parse reports, joined, or `""` when it parses. */
function issues(doc: unknown): string {
  const r = InboundBookingSchema.safeParse(doc);
  return r.success ? "" : r.error.issues.map((i) => i.path.join(".")).join(" | ");
}

Deno.test("inbound booking: a minimal Buy parses, and the registry answers for bookings-inbound only", () => {
  assertEquals(issues(buy()), "");
  assertEquals(schemas["bookings-inbound"], InboundBookingSchema);
  assert(!("booking-inbound" in schemas), "one key, like templates-versions — no singular alias");
});

Deno.test("inbound booking: source.uid must be the purchase the id names", () => {
  const doc = { ...buy(), source: { collection: "purchases" as const, uid: "XXXXXXXXXXXXXXXXXXXX" } };
  assertEquals(issues(doc), "source.uid");
});

Deno.test("inbound booking: source names a purchase and nothing else", () => {
  const doc = { ...buy(), source: { collection: "orders", uid: PURCHASE } };
  assertEquals(issues(doc), "source.collection");
});

Deno.test("inbound booking: a Buy names no collection, a Subrent must name one", () => {
  const buyBack = {
    ...buy(),
    destinations: { delivery: { uid: DEST, address: null }, collection: { uid: BACK, address: null } },
    uid_destination_collection: BACK,
  };
  assertEquals(issues(buyBack), "destinations.collection");

  const subrentNoBack = { ...buy(), type: "rental" as const };
  assertEquals(issues(subrentNoBack), "destinations.collection");

  const subrent = { ...buyBack, type: "rental" as const };
  assertEquals(issues(subrent), "");
});

Deno.test("inbound booking: the flat delivery id mirrors the nested ref", () => {
  assertEquals(issues({ ...buy(), uid_destination_delivery: BACK }), "uid_destination_delivery");
});

Deno.test("inbound booking: a bucket names at most the units it holds, over the INBOUND buckets", () => {
  const base = buy();
  const breakdown = { ...base.breakdown, ordered: 0, stocked: 2 };
  const ok = { ...base, breakdown, units: { ...emptyInboundUnitSets(), stocked: [1001, 1002] } };
  assertEquals(issues(ok), "");

  const over = { ...ok, units: { ...emptyInboundUnitSets(), stocked: [1001, 1002, 1003] } };
  assertEquals(issues(over), "units.stocked");

  // An outbound bucket name is not an inbound one: the strict unit-sets object refuses it.
  const outbound = { ...ok, units: { ...emptyInboundUnitSets(), returned: [1001] } };
  assertEquals(issues(outbound), "units");
});

Deno.test("inbound booking: a unit sits in one bucket at a time", () => {
  const base = buy();
  const doc = {
    ...base,
    breakdown: { ...base.breakdown, ordered: 0, received: 1, stocked: 1 },
    units: { ...emptyInboundUnitSets(), received: [1001], stocked: [1001] },
  };
  assertEquals(issues(doc), "units.stocked");
});

Deno.test("inbound booking: quantity_ordered is REQUIRED, and the status is not the outbound vocabulary", () => {
  const { quantity_ordered: _drop, ...rest } = buy();
  assertEquals(issues(rest), "quantity_ordered");
  assertEquals(issues({ ...buy(), status: "reserved" }), "status");
  assertEquals(issues({ ...buy(), type: "service" }), "type");
});

// ── The inbound lever's wire (ruling 75) ──

const ROW = [LEG, PRODUCT];

/** The issue paths an action parse reports, or `""`. */
function actionIssues(a: unknown): string {
  const r = InboundBookingAction.safeParse(a);
  return r.success ? "" : r.error.issues.map((i) => i.path.join(".")).join(" | ");
}

Deno.test("inbound lever: an action names its row, and a settle is the record's, never the wire's", () => {
  assertEquals(actionIssues({ rule: "receive", quantity: 2, path_source_item: ROW }), "");
  assertEquals(actionIssues({ rule: "receive", quantity: 2 }), "path_source_item");
  assertEquals(actionIssues({ rule: "settle_lost", quantity: 1, path_source_item: ROW }), "rule");
  assertEquals(actionIssues({ rule: "settle_damaged_undo", quantity: 1, path_source_item: ROW }), "rule");
  assertEquals(actionIssues({ rule: "send_back", quantity: 1, path_source_item: ROW }), "");
  // The one paired exception (ruling 83): admitted per action, judged per request.
  assertEquals(actionIssues({ rule: "settle_damaged", quantity: 1, path_source_item: ROW }), "");
});

Deno.test("inbound lever: a wire settle_damaged travels with a receive in the same request (ruling 83)", () => {
  const X = `${PURCHASE}:${PRODUCT}:${LEG}`;
  const Y = `${PURCHASE}:${PRODUCT}:22222222-2222-4222-8222-222222222222`;
  const settle = { uid: X, version: 0, actions: [{ rule: "settle_damaged", quantity: 1, path_source_item: ROW }] };
  const receive = {
    uid: Y,
    version: 0,
    actions: [{ rule: "receive", quantity: 1, path_source_item: ["22222222-2222-4222-8222-222222222222", PRODUCT] }],
  };
  const body = { version: 0, uuid_session: "11111111-1111-4111-8111-111111111111" };
  const bare = BulkInboundBookingUpdateInput.safeParse({ ...body, updates: [settle] });
  assert(!bare.success, "a bare settle_damaged stays refused: a record's units are settled on the record");
  assertEquals(bare.error.issues.map((i) => i.path.join(".")), ["updates.0.actions.0.rule"]);
  assert(BulkInboundBookingUpdateInput.safeParse({ ...body, updates: [receive, settle] }).success, "paired with a receive, the lever judges it");
});

Deno.test("inbound lever: allocations sum to the quantity, units are exactly `quantity` and ascending", () => {
  const shelf = "LLLLLLLLLLLLLLLLLLLL";
  assertEquals(actionIssues({ rule: "put_away", quantity: 2, path_source_item: ROW, allocations: [{ uid_location: shelf, quantity: 2 }] }), "");
  assertEquals(actionIssues({ rule: "put_away", quantity: 3, path_source_item: ROW, allocations: [{ uid_location: shelf, quantity: 2 }] }), "quantity");
  assertEquals(actionIssues({ rule: "receive", quantity: 2, path_source_item: ROW, units: [{ number: 3001 }, { number: 3002 }] }), "");
  assertEquals(actionIssues({ rule: "receive", quantity: 2, path_source_item: ROW, units: [{ number: 3001 }] }), "units");
  assertEquals(actionIssues({ rule: "receive", quantity: 2, path_source_item: ROW, units: [{ number: 3002 }, { number: 3001 }] }), "units.1");
});

Deno.test("inbound lever: only a receive_damaged_undo names the record it consumes (the outbound loss undo's twin)", () => {
  const record = "RRRRRRRRRRRRRRRRRRRR";
  assertEquals(actionIssues({ rule: "receive_damaged_undo", quantity: 1, path_source_item: ROW, uid_out_of_service: record }), "");
  assertEquals(actionIssues({ rule: "receive_damaged", quantity: 1, path_source_item: ROW, uid_out_of_service: record }), "uid_out_of_service");
  assertEquals(actionIssues({ rule: "receive_damaged_undo", quantity: 1, path_source_item: ROW, uid_out_of_service: "not an id" }), "uid_out_of_service");
});

Deno.test("inbound lever: only a receive captures a serial", () => {
  assertEquals(actionIssues({ rule: "receive", quantity: 1, path_source_item: ROW, units: [{ number: 3001, serial_number: "SN1" }] }), "");
  assertEquals(
    actionIssues({ rule: "send_back", quantity: 1, path_source_item: ROW, units: [{ number: 3001, serial_number: "SN1" }] }),
    "units.0.serial_number",
  );
});

Deno.test("inbound lever: one (rule, row) per booking, and one booking per request", () => {
  const twice = [{ rule: "receive", quantity: 1, path_source_item: ROW }, { rule: "receive", quantity: 1, path_source_item: ROW }];
  assert(!InboundBookingActions.safeParse(twice).success, "one row received twice in one save would write one movement id twice");
  const twoRows = [{ rule: "receive", quantity: 1, path_source_item: ROW }, { rule: "receive", quantity: 1, path_source_item: [LEG, "11111111-2222-4333-8444-555555555555", PRODUCT] }];
  assert(InboundBookingActions.safeParse(twoRows).success, "two rows sharing one booking take their own sub-sessions");
  const update = { uid: `${PURCHASE}:${PRODUCT}:${LEG}`, version: 0, actions: [{ rule: "receive", quantity: 1, path_source_item: ROW }] };
  const body = { version: 0, uuid_session: "11111111-1111-4111-8111-111111111111", updates: [update] };
  assert(BulkInboundBookingUpdateInput.safeParse(body).success);
  assert(!BulkInboundBookingUpdateInput.safeParse({ ...body, updates: [update, update] }).success);
  assert(!BulkInboundBookingUpdateInput.safeParse({ ...body, date: "2026-11-12" }).success, "a bare date is refused, as everywhere");
});
