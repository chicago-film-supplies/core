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

Deno.test("GoldenDiffSchema — largest_blob accepts a measurement or absence — never an explicit null", () => {
  const base = {
    fixture: "order-841",
    verdict: "diff" as const,
    delta: 0.0004,
    image_uuids: {},
    sha: "deadbeef",
    checked_at: mockTimestamp,
  };
  // A measured blob is the shape half of a sub-threshold `diff` — the thing
  // that makes `verdict: "diff", delta: 0.0004` readable instead of looking
  // like noise.
  assertEquals(
    GoldenDiffSchema.safeParse({
      ...base,
      largest_blob: { pixels: 313, x: 40, y: 198, width: 220, height: 9 },
    }).success,
    true,
  );
  // Absence is the ONLY way to say "no blob" — the writer omits the key rather
  // than storing a null, so an explicit null is refused. Two states, not three:
  // "measured and found none" and "no run has written one" render identically
  // and a stale row is identified by its `sha`, so the third state would be an
  // exemption in `tests/stored-optionality.test.ts` that no consumer could use.
  assertEquals(GoldenDiffSchema.safeParse(base).success, true);
  assertEquals(GoldenDiffSchema.safeParse({ ...base, largest_blob: null }).success, false);
});

Deno.test("GoldenDiffSchema — largest_blob is strict, and a fractional pixel count is rejected", () => {
  const base = {
    fixture: "order-841",
    verdict: "diff" as const,
    delta: 0.0004,
    image_uuids: {},
    sha: "deadbeef",
    checked_at: mockTimestamp,
  };
  // The fail-closed companion. `pixels` is a COUNT — a float there would be a
  // measurement nothing produced, and the whole point of the field is that a
  // reviewer can act on the number.
  assertEquals(
    GoldenDiffSchema.safeParse({
      ...base,
      largest_blob: { pixels: 12.5, x: 0, y: 0, width: 1, height: 1 },
    }).success,
    false,
  );
  // Strict, like every other member of this document — an unknown key here
  // would be a second producer's field arriving unreviewed.
  assertEquals(
    GoldenDiffSchema.safeParse({
      ...base,
      largest_blob: { pixels: 1, x: 0, y: 0, width: 1, height: 1, area: 1 },
    }).success,
    false,
  );
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
