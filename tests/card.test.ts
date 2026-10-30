import { assertEquals } from "@std/assert";
import { CardSchema, CreateCardInput, UpdateCardInput } from "../src/schemas/card.ts";
import { mockTimestamp } from "./helpers/timestamp.ts";
import { getTestDoc } from "../src/schemas/testing.ts";
import {
  computeCardActionFromPurchase,
  computeCardStatusFromPurchase,
  isPurchaseCard,
  PURCHASE_CARD_LOCKED,
  purchaseCardDue,
} from "../src/utils/cards.ts";
import type { BuyItem, SubrentItem } from "../src/schemas/purchase.ts";

/**
 * A genuine ORDER-DERIVED EVENT CARD — `sources` names an order, so
 * `checkEventCard` applies and every field that refinement requires is present.
 *
 * ⚠️ **It did not used to be one, and it called itself complete anyway.** This
 * fixture carried an `orders` source beside `destination: null`,
 * `organization: null` and `date_fs: null` — a to-do wearing an event card's
 * provenance, a shape `buildEventCards` cannot emit and prod has 0 of. It
 * passed because nothing checked the pairing. {@link validTodoCard} below is
 * the to-do, spelled separately, so neither fixture has to stand in for the
 * other.
 *
 * The uid is the PAIR-KEYED form (segment 2 is the destination divider's
 * `z.uuid()`); {@link legacyEventCard} pins the transitional arm.
 */
const validCard = {
  uid: "order100000000000000:3f1c9b2e-5d4a-4c7b-9e18-2a6f0d3b7c51:start",
  uid_list: "list1000000000000000",
  uid_thread: "order100000000000000:3f1c9b2e-5d4a-4c7b-9e18-2a6f0d3b7c51:start",
  status: "planned",
  // Both REQUIRED since core#95 batch 9. They sat absent here while the
  // fixture called itself complete — the same shape that made 7 dev cards the
  // only evidence batch 8 had.
  action: null,
  position: 1000,
  subject: "Deliver to Warehouse A",
  body: null,
  body_text: "",
  dates: {
    start: "2026-04-25T09:00:00.000-05:00",
    end: null,
  },
  all_day: false,
  date_fs: mockTimestamp,
  destination: {
    uid: "dest1000000000000000",
    address: null,
    // `null` MEANS "no special instructions" and 19 event cards in each corpus
    // carry it, which is why `checkEventCard` does NOT require this one.
    instructions: null,
    contact: null,
  },
  organization: {
    uid: "org10000000000000000",
    path: [{ uid: "org10000000000000000", name: "Acme Productions", derived: false }],
  },
  sources: [{ collection: "fulfillments", uid: "order100000000000000" }],
  fulfillments: { leg: "start", customer_collecting: false },
  attachments: [],
  uid_assignees: [],
  locked: ["card", "subject", "sources"],
  recurrence_parent_uid: null,
  recurrence_index: null,
  recurrence_overrides: [],
  created_by: { uid: "user1000000000000000", name: "Alex" },
  updated_by: { uid: "user1000000000000000", name: "Alex" },
  created_at: mockTimestamp,
  updated_at: mockTimestamp,
};

/**
 * The HAND-AUTHORED to-do: no event source, so no source payload, no destination, no organization
 * and no date. 7 of these exist in dev and none in prod, and they are why
 * `destination` / `organization` / `date_fs` stay nullable on the schema
 * instead of being required outright.
 */
const { fulfillments: _eventPayload, ...validCardWithoutPayload } = validCard;
const validTodoCard = {
  ...validCardWithoutPayload,
  uid: "card1000000000000000",
  uid_thread: "thread10000000000000",
  sources: [],
  locked: [],
  destination: null,
  organization: null,
  date_fs: null,
  dates: { start: null, end: null },
};

Deno.test("CardSchema validates a complete document", () => {
  assertEquals(CardSchema.safeParse(validCard).success, true);
});

Deno.test("CardSchema accepts an empty sources array (generic to-do)", () => {
  assertEquals(CardSchema.safeParse(validTodoCard).success, true);
});

Deno.test("EventCardId: segment 2 is the destination PAIR's uuid", () => {
  assertEquals(CardSchema.safeParse(validCard).success, true);
});

Deno.test("EventCardId: the legacy destination-keyed form is REFUSED", () => {
  // The transitional arm is gone (step 4). Segment 2 is a `destinations/{uid}`
  // here — a 20-char FirestoreId, not the pair's uuid — and it must not parse.
  const legacy = {
    ...validCard,
    uid: "order100000000000000:0BIQ73UMiHTtd8mo0yNk:start",
    uid_thread: "order100000000000000:0BIQ73UMiHTtd8mo0yNk:start",
  };
  assertEquals(CardSchema.safeParse(legacy).success, false);
});

Deno.test("checkEventCard: an order-sourced card with no destination is REFUSED", () => {
  const doc = { ...validCard, destination: null };
  const r = CardSchema.safeParse(doc);
  assertEquals(r.success, false);
  if (!r.success) {
    assertEquals(r.error.issues.some((i) => i.path.join(".") === "destination"), true);
  }
});

Deno.test("checkEventCard: an order-sourced card with a null destination.uid is REFUSED", () => {
  const doc = { ...validCard, destination: { ...validCard.destination, uid: null } };
  const r = CardSchema.safeParse(doc);
  assertEquals(r.success, false);
  if (!r.success) {
    assertEquals(r.error.issues.some((i) => i.path.join(".") === "destination.uid"), true);
  }
});

Deno.test("checkEventCard: an order-sourced card with no organization is REFUSED", () => {
  assertEquals(CardSchema.safeParse({ ...validCard, organization: null }).success, false);
});

Deno.test("checkEventCard: an order-sourced card with a null organization.uid is REFUSED", () => {
  const doc = {
    ...validCard,
    organization: { ...validCard.organization, uid: null },
  };
  assertEquals(CardSchema.safeParse(doc).success, false);
});

Deno.test("checkEventCard: an order-sourced card with no date_fs is REFUSED", () => {
  assertEquals(CardSchema.safeParse({ ...validCard, date_fs: null }).success, false);
});

Deno.test("checkEventCard: `instructions: null` is ACCEPTED — 19 real cards carry it", () => {
  const doc = { ...validCard, destination: { ...validCard.destination, instructions: null } };
  assertEquals(CardSchema.safeParse(doc).success, true);
});

Deno.test("checkEventCard: `address: null` is ACCEPTED — the Phase 3 backlog, 11 real cards", () => {
  const doc = { ...validCard, destination: { ...validCard.destination, address: null } };
  assertEquals(CardSchema.safeParse(doc).success, true);
});

Deno.test("checkEventCard: the SAME nulls on a to-do are accepted — the refinement is per KIND", () => {
  // The discriminating half: every field the four tests above refuse is null
  // here too, and this parses. Without it the refinement could be a blanket
  // requirement and every test above would still be green.
  assertEquals(CardSchema.safeParse(validTodoCard).success, true);
});

Deno.test("checkEventCard: a non-fulfillments source does not make a card an event card", () => {
  const doc = {
    ...validTodoCard,
    sources: [{ collection: "invoices", uid: "inv10000000000000000" }],
  };
  assertEquals(CardSchema.safeParse(doc).success, true);
});

Deno.test("CardSchema accepts multiple polymorphic sources", () => {
  const doc = {
    ...validCard,
    sources: [
      { collection: "fulfillments", uid: "order100000000000000" },
      { collection: "invoices", uid: "inv10000000000000000" },
    ],
  };
  assertEquals(CardSchema.safeParse(doc).success, true);
});

Deno.test("CardSources: an organization source is refused on the document and on both inputs (api-cloudrun#978)", () => {
  const org = { collection: "organizations" as const, uid: "org10000000000000000" };
  const inv = { collection: "invoices" as const, uid: "inv10000000000000000" };
  const doc = CardSchema.safeParse({ ...validTodoCard, sources: [inv, org] });
  assertEquals(doc.success, false);
  assertEquals(doc.error?.issues.map((i) => i.path.join(".")), ["sources"]);
  const create = CreateCardInput.safeParse({ uid_list: validTodoCard.uid_list, subject: "x", sources: [org] });
  assertEquals(create.error?.issues.map((i) => i.path.join(".")), ["sources"]);
  const update = UpdateCardInput.safeParse({ version: 1, sources: [org] });
  assertEquals(update.error?.issues.map((i) => i.path.join(".")), ["sources"]);
  // The discriminating half: the SAME inputs with the org entry removed parse.
  // A blanket refusal of `sources` would fail these.
  assertEquals(CardSchema.safeParse({ ...validTodoCard, sources: [inv] }).success, true);
  assertEquals(CreateCardInput.safeParse({ uid_list: validTodoCard.uid_list, subject: "x", sources: [inv] }).success, true);
  assertEquals(UpdateCardInput.safeParse({ version: 1, sources: [inv] }).success, true);
});

Deno.test("CardSchema accepts an EventCardId composite uid_thread (deterministic event-card thread)", () => {
  assertEquals(CardSchema.safeParse(validCard).success, true);
});

Deno.test("CardSchema rejects a malformed composite uid_thread", () => {
  const doc = { ...validCard, uid_thread: "order100000000000000:0BIQ73UMiHTtd8mo0yNk:middle" };
  assertEquals(CardSchema.safeParse(doc).success, false);
});

Deno.test("CardSchema rejects invalid status", () => {
  const doc = { ...validCard, status: "done" };
  assertEquals(CardSchema.safeParse(doc).success, false);
});

Deno.test("CardSchema rejects invalid lock key", () => {
  const doc = { ...validCard, locked: ["subject", "uid"] };
  assertEquals(CardSchema.safeParse(doc).success, false);
});

Deno.test("CardSchema rejects unknown properties", () => {
  const doc = { ...validCard, extra: "nope" };
  assertEquals(CardSchema.safeParse(doc).success, false);
});

Deno.test("CardSchema accepts null dates.start (no-date card)", () => {
  // A dateless card is a TO-DO by construction — `checkEventCard` requires
  // `date_fs` on the order-derived kind, and `buildEventCards` always has one.
  const doc = { ...validTodoCard, dates: { start: null, end: null }, date_fs: null };
  assertEquals(CardSchema.safeParse(doc).success, true);
});

Deno.test("CardSchema accepts dates.start + dates.end (delivery window)", () => {
  const doc = {
    ...validCard,
    dates: {
      start: "2026-04-25T09:00:00.000-05:00",
      end: "2026-04-25T17:30:00.000-05:00",
    },
  };
  assertEquals(CardSchema.safeParse(doc).success, true);
});

Deno.test("CardSchema canonicalizes dates.start to Chicago offset form", () => {
  const doc = {
    ...validCard,
    dates: {
      start: "2026-04-25T14:00:00.000Z",
      end: null,
    },
  };
  const parsed = CardSchema.safeParse(doc);
  assertEquals(parsed.success, true);
  if (parsed.success) {
    // 14:00 UTC on Apr 25 is 09:00 CDT (-05:00)
    assertEquals(parsed.data.dates.start, "2026-04-25T09:00:00.000-05:00");
  }
});

Deno.test("CardSchema rejects bare YYYY-MM-DD on dates.start", () => {
  const doc = {
    ...validCard,
    dates: { start: "2026-04-25", end: null },
  };
  assertEquals(CardSchema.safeParse(doc).success, false);
});

Deno.test("CardSchema accepts an all_day card", () => {
  const doc = {
    ...validCard,
    all_day: true,
    dates: {
      start: "2026-04-25T00:00:00.000-05:00",
      end: null,
    },
  };
  assertEquals(CardSchema.safeParse(doc).success, true);
});

Deno.test("CardSchema accepts the 'dates' lock key", () => {
  const doc = { ...validCard, locked: ["dates"] };
  assertEquals(CardSchema.safeParse(doc).success, true);
});

Deno.test("CreateCardInput accepts minimal payload", () => {
  const input = { uid_list: "list1000000000000000", subject: "Buy tape" };
  assertEquals(CreateCardInput.safeParse(input).success, true);
});

Deno.test("CreateCardInput accepts dates + all_day", () => {
  const input = {
    uid_list: "list1000000000000000",
    subject: "Site visit",
    dates: {
      start: "2026-04-25T09:00:00.000-05:00",
      end: "2026-04-25T11:00:00.000-05:00",
    },
    all_day: false,
  };
  assertEquals(CreateCardInput.safeParse(input).success, true);
});

Deno.test("CreateCardInput rejects empty subject", () => {
  const input = { uid_list: "list1000000000000000", subject: "" };
  assertEquals(CreateCardInput.safeParse(input).success, false);
});

Deno.test("UpdateCardInput accepts position-only patch", () => {
  assertEquals(UpdateCardInput.safeParse({ position: 2000, version: 1 }).success, true);
});

Deno.test("UpdateCardInput accepts status change", () => {
  assertEquals(UpdateCardInput.safeParse({ status: "active", version: 1 }).success, true);
});

Deno.test("UpdateCardInput accepts dates patch", () => {
  const input = {
    dates: {
      start: "2026-04-25T09:00:00.000-05:00",
      end: null,
    },
    version: 1,
  };
  assertEquals(UpdateCardInput.safeParse(input).success, true);
});

Deno.test("UpdateCardInput rejects missing version", () => {
  assertEquals(UpdateCardInput.safeParse({ status: "active" }).success, false);
});

Deno.test("CardSchema defaults recurrence_overrides to []", () => {
  const { recurrence_overrides: _omit, ...doc } = validCard;
  const parsed = CardSchema.safeParse(doc);
  assertEquals(parsed.success, true);
  if (parsed.success) {
    assertEquals(parsed.data.recurrence_overrides, []);
  }
});

Deno.test("CardSchema accepts a recurring-instance card with overrides", () => {
  const doc = {
    ...validCard,
    recurrence_parent_uid: "rec10000000000000000",
    recurrence_index: 3,
    recurrence_overrides: ["dates", "subject"],
  };
  assertEquals(CardSchema.safeParse(doc).success, true);
});

// 🔴 One dropped key per case, so each names the constraint it tests rather
// than failing for some reason — core#95 batch 9's two paths. `null` stays a
// legal stored VALUE for both; these assert the KEY.
for (const key of ["action", "organization"] as const) {
  Deno.test(`CardSchema requires ${key} (core#95 batch 9)`, () => {
    const { [key]: _omit, ...doc } = validCard;
    const parsed = CardSchema.safeParse(doc);
    assertEquals(parsed.success, false);
    if (!parsed.success) {
      assertEquals(parsed.error.issues.map((i) => i.path.join(".")), [key]);
    }
  });
}

// ── The `fulfillments` source payload ─────────────────────────────────

Deno.test("fulfillments payload: a :start card carrying leg=start is ACCEPTED", () => {
  assertEquals(CardSchema.safeParse(validCard).success, true);
});

Deno.test("fulfillments payload: ABSENT on an event card is REFUSED — required since the relabel", () => {
  const { fulfillments: _payload, ...doc } = validCard;
  const r = CardSchema.safeParse(doc);
  assertEquals(r.success, false);
  if (!r.success) assertEquals(r.error.issues.map((i) => i.path.join(".")), ["fulfillments"]);
});

Deno.test("fulfillments payload: leg disagreeing with the id's :start is REFUSED", () => {
  const doc = { ...validCard, fulfillments: { leg: "end", customer_returning: false } };
  const r = CardSchema.safeParse(doc);
  assertEquals(r.success, false);
  if (!r.success) assertEquals(r.error.issues.map((i) => i.path.join(".")), ["fulfillments.leg"]);
});

Deno.test("fulfillments payload: leg=end on an :end card is ACCEPTED — the pin is not a constant", () => {
  // The other polarity: without it a refinement refusing every `end` would pass
  // the test above.
  const uid = validCard.uid.replace(/:start$/, ":end");
  const doc = { ...validCard, uid, uid_thread: uid, fulfillments: { leg: "end", customer_returning: true } };
  assertEquals(CardSchema.safeParse(doc).success, true);
});

Deno.test("fulfillments payload: the flag must match the leg's arm — start carries customer_collecting", () => {
  const doc = { ...validCard, fulfillments: { leg: "start", customer_returning: true } };
  assertEquals(CardSchema.safeParse(doc).success, false);
});

Deno.test("fulfillments payload: PRESENT on a to-do is REFUSED — present iff the source is", () => {
  const doc = { ...validTodoCard, fulfillments: { leg: "start", customer_collecting: false } };
  const r = CardSchema.safeParse(doc);
  assertEquals(r.success, false);
  if (!r.success) assertEquals(r.error.issues.map((i) => i.path.join(".")), ["fulfillments"]);
});

Deno.test("fulfillments payload: null is REFUSED — absent, never null", () => {
  assertEquals(CardSchema.safeParse({ ...validCard, fulfillments: null }).success, false);
});

Deno.test("the retired `orders` label: its payload key is REFUSED, and its source marks no event card", () => {
  // The contract step (P4 of the api-cloudrun cards-from-fulfillments plan):
  // both corpora read 0 `orders`-labelled event cards before it was taken.
  assertEquals(CardSchema.safeParse({ ...validCard, orders: { leg: "start", customer_collecting: false } }).success, false);
  // An `orders` source alone is not an event card, so a to-do shaped like one
  // passes the per-kind nulls.
  const todo = { ...validTodoCard, sources: [{ collection: "orders", uid: "order100000000000000" }] };
  assertEquals(CardSchema.safeParse(todo).success, true);
});

// ── A subrent's return-to-supplier card ──────────────────────────────

const PO = "testpurch10000000000";

/** Every field a purchase writer states, built through the fixture contract so it must PARSE. */
function purchaseCard(over: Record<string, unknown> = {}) {
  return getTestDoc(CardSchema, {
    uid: "testcard100000000000",
    uid_list: "field-service",
    uid_thread: "testcard100000000000",
    status: "active",
    action: { source: "purchase", value: "return_to_supplier" },
    subject: "Return 10 × J-2000 to Baycom (PO-212)",
    dates: { start: "2026-10-25T17:00:00.000-05:00", end: null },
    date_fs: mockTimestamp,
    destination: null,
    organization: null,
    sources: [{ collection: "purchases", uid: PO }],
    purchases: { number: 212, supplier: { uid: "testsupp100000000000", name: "Baycom" } },
    locked: [...PURCHASE_CARD_LOCKED],
    ...over,
  } as never, { now: mockTimestamp });
}

const cardPaths = (doc: unknown) => {
  const r = CardSchema.safeParse(doc);
  return r.success ? [] : r.error.issues.map((i) => i.path.join("."));
};

Deno.test("purchase card: getTestDoc builds one, and it is a purchase card, not an event card", () => {
  const card = purchaseCard();
  assertEquals(cardPaths(card), []);
  assertEquals(isPurchaseCard(card), true);
});

Deno.test("purchase card: the payload names exactly one purchase source; the source alone is a to-do", () => {
  assertEquals(cardPaths({ ...purchaseCard(), sources: [] }), ["sources"]);
  assertEquals(
    cardPaths({ ...purchaseCard(), sources: [{ collection: "purchases", uid: PO }, { collection: "purchases", uid: "testpurch20000000000" }] }),
    ["sources"],
  );
  // A hand-authored to-do linking a PO: no payload, no action — legal, and NOT the projection's.
  const todo = { ...purchaseCard(), action: null };
  delete (todo as Record<string, unknown>).purchases;
  assertEquals(cardPaths(todo), []);
  assertEquals(isPurchaseCard(todo), false);
});

Deno.test("purchase card: a purchase action sits only on a purchase card, and a purchase card carries no other", () => {
  const todo = { ...purchaseCard() };
  delete (todo as Record<string, unknown>).purchases;
  assertEquals(cardPaths(todo), ["action"]);
  assertEquals(cardPaths({ ...purchaseCard(), action: { source: "fulfillment", value: "return" } }), ["action"]);
  assertEquals(cardPaths({ ...purchaseCard(), action: null }), []);
});

const pline = (over: Partial<SubrentItem> = {}): SubrentItem => {
  const uid = over.uid ?? "9a1b2c3d-0000-4000-8000-000000000002";
  return {
    type: "subrent",
    uid,
    path: [uid],
    uid_product: "testprod100000000000",
    name: "J-2000",
    quantity: 10,
    coa_posting: 5100,
    uid_tracking_category: null,
    billing: { basis: "fixed", amount_cents: 50_000 },
    quantity_received: 0,
    quantity_billed: 0,
    quantity_canceled: 0,
    dates: { start: "2026-10-18T09:00:00.000-05:00", end: "2026-10-25T17:00:00.000-05:00" },
    quantity_returned: 0,
    uid_orders: [],
    ...over,
  };
};

/** A buy item on the same purchase — a return card never reads it (D3). */
const bline: BuyItem = {
  type: "buy",
  uid: "9a1b2c3d-0000-4000-8000-000000000001",
  path: ["9a1b2c3d-0000-4000-8000-000000000001"],
  uid_product: "testprod200000000000",
  name: "Gaff tape",
  quantity: 5,
  amount_cents: 1_000,
  coa_posting: 1400,
  uid_tracking_category: null,
  expected_date: null,
  quantity_received: 0,
  quantity_billed: 0,
  quantity_canceled: 0,
  landed_costs: [],
};

Deno.test("computeCardStatusFromPurchase / computeCardActionFromPurchase — the table", () => {
  const cases: [string, "active" | "canceled" | "complete", Partial<SubrentItem>, string, string | null][] = [
    ["nothing received", "active", {}, "planned", null],
    ["received, none returned", "active", { quantity_received: 10 }, "active", "return_to_supplier"],
    ["partly returned", "active", { quantity_received: 10, quantity_returned: 4 }, "active", "return_to_supplier"],
    ["all received returned, more to come", "active", { quantity_received: 6, quantity_returned: 6 }, "planned", null],
    ["all returned, rest canceled (unbilled)", "active", { quantity_received: 6, quantity_returned: 6, quantity_canceled: 4 }, "complete", null],
    ["all returned and billed", "complete", { quantity_received: 10, quantity_returned: 10, quantity_billed: 10 }, "complete", null],
    ["canceled outright", "canceled", { quantity_canceled: 10 }, "canceled", null],
  ];
  for (const [name, status, over, want, action] of cases) {
    const p = { status, items: [pline(over)] };
    assertEquals(computeCardStatusFromPurchase(p, "planned"), want, name);
    assertEquals(computeCardActionFromPurchase(p)?.value ?? null, action, name);
    // A buy item beside it changes nothing: the card is about the subrent items.
    assertEquals(computeCardStatusFromPurchase({ status, items: [bline, pline(over)] }, "planned"), want, `${name} + buy`);
  }
  // An operator's `blocked` is theirs.
  assertEquals(computeCardStatusFromPurchase({ status: "active", items: [pline({ quantity_received: 10 })] }, "blocked"), "blocked");
});

Deno.test("purchaseCardDue: the earliest due-back among OPEN subrent items, else among all; null when none is due", () => {
  const early = "2026-10-22T17:00:00.000-05:00";
  const late = "2026-10-25T17:00:00.000-05:00";
  const a = pline({ uid: "9a1b2c3d-0000-4000-8000-00000000000a", dates: { start: early, end: early }, quantity_received: 3, quantity_returned: 3, quantity_canceled: 7 });
  const b = pline({ uid: "9a1b2c3d-0000-4000-8000-00000000000b", dates: { start: early, end: late }, quantity_received: 10 });
  assertEquals(purchaseCardDue({ items: [a, b] }), late, "a is settled, so b's date leads");
  assertEquals(purchaseCardDue({ items: [a, { ...b, quantity_returned: 10 }] }), early, "nothing open: the earliest of all");
  // A standing subrent is due back on nothing; a buy item never enters.
  assertEquals(purchaseCardDue({ items: [pline({ dates: { start: early, end: null } }), bline] }), null);
  assertEquals(purchaseCardDue({ items: [bline] }), null);
});
