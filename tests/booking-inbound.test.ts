/**
 * `InboundBookingSchema` (`schemas/booking-inbound.ts`, one-document-model 7a C5):
 * each document refine planted both ways, so a refine that stopped firing fails
 * here rather than reading as a clean corpus.
 */
import { assert, assertEquals } from "@std/assert";
import {
  emptyInboundBreakdown,
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
