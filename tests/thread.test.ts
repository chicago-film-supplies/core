import { assertEquals } from "@std/assert";
import { ThreadSchema, UpdateThreadInput } from "../src/thread.ts";

const validThread = {
  uid: "thread-1",
  sources: [{ collection: "orders", uid: "order-1" }],
  title: null,
  last_message_at: null,
  last_message_preview: "",
  comment_count: 0,
  created_by: { uid: "user-1", name: "Alex" },
  updated_by: { uid: "user-1", name: "Alex" },
  created_at: null,
  updated_at: null,
};

Deno.test("ThreadSchema validates a default thread", () => {
  assertEquals(ThreadSchema.safeParse(validThread).success, true);
});

Deno.test("ThreadSchema accepts multi-source threads", () => {
  const doc = {
    ...validThread,
    sources: [
      { collection: "cards", uid: "card-1" },
      { collection: "orders", uid: "order-1" },
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
