import { assertEquals } from "@std/assert";
import {
  GOLDEN_DIFF_VERDICTS,
  GoldenDiffSchema,
  TemplateVersionSchema,
  UpdateTemplateVersionInput,
} from "../src/template-version.ts";
import { mockTimestamp } from "./helpers/timestamp.ts";

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
  const res = UpdateTemplateVersionInput.safeParse({ content: { "a.eta": "x" }, uid: "tv100000000000000000", version: 1 });
  assertEquals(res.success, true);
  if (res.success) assertEquals("uid" in res.data, false);
});

Deno.test("UpdateTemplateVersionInput rejects a missing version", () => {
  assertEquals(UpdateTemplateVersionInput.safeParse({ content: { "a.eta": "x" } }).success, false);
});

Deno.test("UpdateTemplateVersionInput rejects a negative version", () => {
  assertEquals(UpdateTemplateVersionInput.safeParse({ display_name: "Branch", version: -1 }).success, false);
});

// ── GoldenDiff (per-fixture) ────────────────────────────────────────

Deno.test("GoldenDiffSchema accepts a per-fixture match result", () => {
  const res = GoldenDiffSchema.safeParse({
    fixture: "order-841",
    verdict: "match",
    delta: 0.0001,
    image_uuids: { candidate: "uc-1", diff: "uc-2" },
    sha: "deadbeef",
    checked_at: mockTimestamp,
  });
  assertEquals(res.success, true);
});

Deno.test("GoldenDiffSchema requires the fixture slug", () => {
  const res = GoldenDiffSchema.safeParse({
    verdict: "match",
    delta: 0,
    image_uuids: {},
    sha: "deadbeef",
    checked_at: mockTimestamp,
  });
  assertEquals(res.success, false);
});

Deno.test("GoldenDiffSchema accepts the no-fixtures verdict", () => {
  const res = GoldenDiffSchema.safeParse({
    fixture: "_",
    verdict: "no-fixtures",
    delta: 0,
    image_uuids: {},
    sha: "deadbeef",
    checked_at: mockTimestamp,
  });
  assertEquals(res.success, true);
});

Deno.test("GOLDEN_DIFF_VERDICTS includes no-fixtures", () => {
  assertEquals(GOLDEN_DIFF_VERDICTS.includes("no-fixtures"), true);
});

// ── TemplateVersion.golden_results[] ────────────────────────────────

Deno.test("TemplateVersionSchema accepts a draft with golden_results array", () => {
  const res = TemplateVersionSchema.safeParse({
    uid: "tv100000000000000000",
    uid_template: "t1000000000000000000",
    status: "draft",
    content: { "templates/quote.eta": "x" },
    params: [],
    consumed_components: [],
    git_branch: "draft/quote/abc",
    base_sha: "deadbeef",
    base_seq: 0,
    golden_results: [
      {
        fixture: "order-841",
        verdict: "match",
        delta: 0,
        image_uuids: {},
        sha: "deadbeef",
        checked_at: mockTimestamp,
      },
    ],
    written_by: { uid: "u1000000000000000000", name: "Tester" },
    version: 0,
    created_at: mockTimestamp,
    updated_at: mockTimestamp,
  });
  if (!res.success) console.log(res.error.message);
  assertEquals(res.success, true);
});

Deno.test("TemplateVersionSchema accepts a draft without golden_results (pre-first-run)", () => {
  const res = TemplateVersionSchema.safeParse({
    uid: "tv100000000000000000",
    uid_template: "t1000000000000000000",
    status: "draft",
    content: {},
    params: [],
    consumed_components: [],
    git_branch: "draft/quote/abc",
    base_sha: "deadbeef",
    base_seq: 0,
    written_by: { uid: "u1000000000000000000", name: "Tester" },
    version: 0,
    created_at: mockTimestamp,
    updated_at: mockTimestamp,
  });
  if (!res.success) console.log(res.error.message);
  assertEquals(res.success, true);
});
