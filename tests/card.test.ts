import { assertEquals } from "@std/assert";
import { CardSchema, CreateCardInput, UpdateCardInput } from "../src/schemas/card.ts";
import { mockTimestamp } from "./helpers/timestamp.ts";

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
  sources: [{ collection: "orders", uid: "order100000000000000" }],
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
 * The HAND-AUTHORED to-do: no order source, so no destination, no organization
 * and no date. 7 of these exist in dev and none in prod, and they are why
 * `destination` / `organization` / `date_fs` stay nullable on the schema
 * instead of being required outright.
 */
const validTodoCard = {
  ...validCard,
  uid: "card1000000000000000",
  uid_thread: "thread10000000000000",
  sources: [],
  locked: [],
  destination: null,
  organization: null,
  date_fs: null,
  dates: { start: null, end: null },
};

/**
 * The pre-migration id form, whose segment 2 is a `destinations/{uid}` document
 * id. 🔴 **Delete this fixture together with `EventCardId`'s legacy arm** — the
 * two are one change, and a fixture outliving the arm it pins is how a
 * transitional branch becomes permanent.
 */
const legacyEventCard = {
  ...validCard,
  uid: "order100000000000000:0BIQ73UMiHTtd8mo0yNk:start",
  uid_thread: "order100000000000000:0BIQ73UMiHTtd8mo0yNk:start",
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

Deno.test("EventCardId: the legacy destination-keyed form still parses (TRANSITIONAL)", () => {
  // 🔴 Flip this to `false` and delete `legacyEventCard` in the release that
  // removes `EventCardId`'s legacy arm — step 4 of the four-step.
  assertEquals(CardSchema.safeParse(legacyEventCard).success, true);
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

Deno.test("checkEventCard: a NON-orders source does not make a card an event card", () => {
  const doc = {
    ...validTodoCard,
    sources: [{ collection: "organizations", uid: "org10000000000000000" }],
  };
  assertEquals(CardSchema.safeParse(doc).success, true);
});

Deno.test("CardSchema accepts multiple polymorphic sources", () => {
  const doc = {
    ...validCard,
    sources: [
      { collection: "orders", uid: "order100000000000000" },
      { collection: "organizations", uid: "org10000000000000000" },
    ],
  };
  assertEquals(CardSchema.safeParse(doc).success, true);
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
