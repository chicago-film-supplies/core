import { assertEquals } from "@std/assert";
import { CardSchema, CreateCardInput, UpdateCardInput } from "../src/card.ts";

const validCard = {
  uid: "card-1",
  uid_list: "list-1",
  uid_thread: "thread-1",
  status: "planned",
  position: 1000,
  subject: "Deliver to Warehouse A",
  body: null,
  body_text: "",
  dates: {
    start: "2026-04-25T09:00:00.000-05:00",
    end: null,
  },
  all_day: false,
  date_fs: null,
  destination: null,
  sources: [{ collection: "orders", uid: "order-1" }],
  attachments: [],
  uid_assignees: [],
  locked: ["card", "subject", "sources"],
  recurrence_parent_uid: null,
  recurrence_index: null,
  recurrence_overrides: [],
  created_by: { uid: "user-1", name: "Alex" },
  updated_by: { uid: "user-1", name: "Alex" },
  created_at: null,
  updated_at: null,
};

Deno.test("CardSchema validates a complete document", () => {
  assertEquals(CardSchema.safeParse(validCard).success, true);
});

Deno.test("CardSchema accepts an empty sources array (generic to-do)", () => {
  const doc = { ...validCard, sources: [], locked: [] };
  assertEquals(CardSchema.safeParse(doc).success, true);
});

Deno.test("CardSchema accepts multiple polymorphic sources", () => {
  const doc = {
    ...validCard,
    sources: [
      { collection: "orders", uid: "order-1" },
      { collection: "organizations", uid: "org-1" },
    ],
  };
  assertEquals(CardSchema.safeParse(doc).success, true);
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
  const doc = {
    ...validCard,
    dates: { start: null, end: null },
    date_fs: null,
  };
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
  const input = { uid_list: "list-1", subject: "Buy tape" };
  assertEquals(CreateCardInput.safeParse(input).success, true);
});

Deno.test("CreateCardInput accepts dates + all_day", () => {
  const input = {
    uid_list: "list-1",
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
  const input = { uid_list: "list-1", subject: "" };
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
    recurrence_parent_uid: "rec-1",
    recurrence_index: 3,
    recurrence_overrides: ["dates", "subject"],
  };
  assertEquals(CardSchema.safeParse(doc).success, true);
});
