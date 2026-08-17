import { assertEquals } from "@std/assert";
import {
  GOLDEN_DIFF_VERDICTS,
  GoldenDiffSchema,
  TemplateVersionSchema,
  UpdateTemplateVersionInput,
} from "../src/schemas/template-version.ts";
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
    committed_content_hash: "0badc0de0badc0de",
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
    committed_content_hash: "0badc0de0badc0de",
    written_by: { uid: "u1000000000000000000", name: "Tester" },
    version: 0,
    created_at: mockTimestamp,
    updated_at: mockTimestamp,
  });
  if (!res.success) console.log(res.error.message);
  assertEquals(res.success, true);
});

// ── committed_content_hash is REQUIRED on a draft ───────────────────
//
// It was optional, so every reader had to decide what an ABSENT hash meant —
// and the two live readers disagreed. The manager's merge guard read absent as
// clean (publishing a never-committed draft's create-time seed over every
// save); abandon consulted nothing and destroyed 18 uncommitted edits
// (chicago-film-supplies/templates#79). Requiring it makes the absent case
// unrepresentable rather than a judgement each call site re-makes.

function draftDoc(over: Record<string, unknown> = {}) {
  return {
    uid: "tv100000000000000000",
    uid_template: "t1000000000000000000",
    status: "draft",
    content: { "templates/quote.eta": "x" },
    params: [],
    consumed_components: [],
    git_branch: "draft/quote/abc",
    base_sha: "deadbeef",
    base_seq: 0,
    committed_content_hash: "0badc0de0badc0de",
    written_by: { uid: "u1000000000000000000", name: "Tester" },
    version: 0,
    created_at: mockTimestamp,
    updated_at: mockTimestamp,
    ...over,
  };
}

Deno.test("TemplateVersionSchema rejects a draft with no committed_content_hash", () => {
  const res = TemplateVersionSchema.safeParse(draftDoc({ committed_content_hash: undefined }));
  assertEquals(res.success, false);
  if (!res.success) {
    const issue = res.error.issues.find((i) => i.path[0] === "committed_content_hash");
    assertEquals(issue?.message, 'draft version requires "committed_content_hash"');
  }
});

Deno.test("TemplateVersionSchema: a STALE hash on a draft is still legal — it is the dirty signal", () => {
  // The schema can only enforce presence. A hash that no longer matches the
  // content is exactly what "saved but not committed" looks like, so rejecting
  // it would make the state the guards exist to detect unrepresentable too.
  const res = TemplateVersionSchema.safeParse(
    draftDoc({ content: { "templates/quote.eta": "EDITED SINCE THE STAMP" } }),
  );
  assertEquals(res.success, true);
});

Deno.test("TemplateVersionSchema: archived keeps whatever it had, hash or not", () => {
  // An abandoned draft is frozen as-is and is never written again, so demanding
  // a field of it would strand the very docs abandon produces.
  const res = TemplateVersionSchema.safeParse(
    draftDoc({ status: "archived", committed_content_hash: undefined }),
  );
  assertEquals(res.success, true);
});
