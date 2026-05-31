import { assertEquals } from "@std/assert";
import { ThreadSchema, UpdateThreadInput } from "../src/thread.ts";
import { mockTimestamp } from "./helpers/timestamp.ts";

const validThread = {
  uid: "thread10000000000000",
  sources: [{ collection: "orders", uid: "order100000000000000" }],
  title: null,
  last_message_at: null,
  last_message_preview: "",
  comment_count: 0,
  created_by: { uid: "user1000000000000000", name: "Alex" },
  updated_by: { uid: "user1000000000000000", name: "Alex" },
  created_at: mockTimestamp,
  updated_at: mockTimestamp,
};

Deno.test("ThreadSchema validates a default thread", () => {
  assertEquals(ThreadSchema.safeParse(validThread).success, true);
});

Deno.test("ThreadSchema accepts multi-source threads", () => {
  const doc = {
    ...validThread,
    sources: [
      { collection: "cards", uid: "card1000000000000000" },
      { collection: "orders", uid: "order100000000000000" },
    ],
  };
  assertEquals(ThreadSchema.safeParse(doc).success, true);
});

Deno.test("ThreadSchema rejects empty sources array", () => {
  const doc = { ...validThread, sources: [] };
  assertEquals(ThreadSchema.safeParse(doc).success, false);
});

Deno.test("ThreadSchema accepts non-null title", () => {
  const doc = { ...validThread, title: "Delivery planning" };
  assertEquals(ThreadSchema.safeParse(doc).success, true);
});

Deno.test("ThreadSchema rejects unknown properties", () => {
  const doc = { ...validThread, extra: "nope" };
  assertEquals(ThreadSchema.safeParse(doc).success, false);
});

Deno.test("UpdateThreadInput accepts null title", () => {
  assertEquals(UpdateThreadInput.safeParse({ title: null, version: 1 }).success, true);
});

Deno.test("UpdateThreadInput accepts string title", () => {
  assertEquals(UpdateThreadInput.safeParse({ title: "Renamed", version: 1 }).success, true);
});

Deno.test("UpdateThreadInput rejects missing version", () => {
  assertEquals(UpdateThreadInput.safeParse({ title: "Renamed" }).success, false);
});
