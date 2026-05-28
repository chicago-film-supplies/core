import { assertEquals } from "@std/assert";
import { UpdateTemplateVersionInput } from "../src/template-version.ts";

Deno.test("UpdateTemplateVersionInput accepts a content-only update", () => {
  assertEquals(UpdateTemplateVersionInput.safeParse({ content: { "a.eta": "x" }, version: 1 }).success, true);
});

Deno.test("UpdateTemplateVersionInput accepts a params-only update (version 0)", () => {
  assertEquals(UpdateTemplateVersionInput.safeParse({ params: [{ key: "k", type: "boolean" }], version: 0 }).success, true);
});

Deno.test("UpdateTemplateVersionInput accepts a display_name-only update", () => {
  assertEquals(UpdateTemplateVersionInput.safeParse({ display_name: "Branch", version: 2 }).success, true);
});

Deno.test("UpdateTemplateVersionInput strips an injected uid (non-strict)", () => {
  const res = UpdateTemplateVersionInput.safeParse({ content: { "a.eta": "x" }, uid: "tv-1", version: 1 });
  assertEquals(res.success, true);
  if (res.success) assertEquals("uid" in res.data, false);
});

Deno.test("UpdateTemplateVersionInput rejects a missing version", () => {
  assertEquals(UpdateTemplateVersionInput.safeParse({ content: { "a.eta": "x" } }).success, false);
});

Deno.test("UpdateTemplateVersionInput rejects a negative version", () => {
  assertEquals(UpdateTemplateVersionInput.safeParse({ display_name: "Branch", version: -1 }).success, false);
});
