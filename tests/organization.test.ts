import { assertEquals } from "@std/assert";
import {
  CreateOrganizationInput,
  OrganizationSchema,
  UpdateOrganizationInput,
} from "../src/schemas/organization.ts";
import { mockTimestamp } from "./helpers/timestamp.ts";

const ts = { created_at: mockTimestamp, updated_at: mockTimestamp };

const validAddress = {
  city: "Chicago",
  country_name: "US",
  full: "123 Main St, Chicago, IL",
  name: "HQ",
  postcode: "60601",
  region: "IL",
  street: "123 Main St",
};

const actor = { uid: "testuser100000000000", name: "Test User" };

/**
 * A MINIMAL VALID organization document, so every negative case below fails for
 * exactly the reason it names.
 *
 * ⚠️ Introduced when `uid_thread` became required (2026-08-23). The
 * "rejects additional properties" case below is the one that shows why: it
 * already omitted `emails`, `phones`, `contacts`, `query_by_contacts` and both
 * timestamps, so it rejected whether or not the extra key was there — the same
 * defect this file's `tax_profile` test had already been corrected for, still
 * live one test lower down.
 */
const validOrganization = (overrides: Record<string, unknown> = {}) => ({
  uid: "testorg1000000000000",
  // ⚠️ **No `name` scalar, and the four tree fields stated.** The scalar was
  // removed and `path` made required (api-cloudrun#709), so this is what a
  // minimal valid organization now IS — a fixture carrying the old shape would
  // fail every arm below for the wrong reason.
  path: [{ uid: "testorg1000000000000", name: "Acme", derived: false }],
  query_by_path: ["testorg1000000000000"],
  derived_from: null,
  uid_department_type: null,
  crms_id: 1,
  xero_id: null as string | null,
  emails: [] as string[],
  phones: [] as string[],
  billing_address: null as Record<string, unknown> | null,
  contacts: [] as Array<Record<string, unknown>>,
  query_by_contacts: [] as string[],
  uid_thread: "testthread0000000000",
  created_by: actor,
  updated_by: actor,
  ...ts,
  ...overrides,
});

Deno.test("OrganizationSchema validates a complete document", () => {
  const doc = validOrganization({
    // The name is the path node's, not a scalar override.
    path: [{ uid: "testorg1000000000000", name: "Acme Corp", derived: false }],
    crms_id: 100,
    xero_id: "00000000-0000-4000-8000-000000000001",
    emails: ["info@acme.com"],
    phones: ["1234567890"],
    billing_address: validAddress,
    contacts: [{ uid: "testc100000000000000", first_name: "John", name: "John", roles: ["admin"] }],
    query_by_contacts: ["testc100000000000000"],
  });
  assertEquals(OrganizationSchema.safeParse(doc).success, true);
});

Deno.test("OrganizationSchema rejects missing required fields", () => {
  assertEquals(OrganizationSchema.safeParse({ uid: "testorg1000000000000" }).success, false);
});

Deno.test("OrganizationSchema requires uid_thread — every organization is born with a thread", () => {
  // 291/291 prod and 313/313 dev carry the key (2026-08-23, `orderBy`
  // key-presence), and dev's 22 native extras carrying it is what makes this a
  // fact about `createOrganization` rather than about the CRMS ingest.
  const { uid_thread: _omitted, ...withoutThread } = validOrganization();
  assertEquals(OrganizationSchema.safeParse(withoutThread).success, false);
});

Deno.test("OrganizationSchema accepts null billing_address", () => {
  // `contacts` lost its `.default()` — the Typesense config declares it
  // required and a default never reaches the stored doc. See
  // `tests/typesense-parity.test.ts`.
  assertEquals(OrganizationSchema.safeParse(validOrganization({ billing_address: null })).success, true);
});

Deno.test("OrganizationSchema rejects ANY tax_profile — the field is gone (#596 item 3)", () => {
  // Was "rejects invalid tax_profile", asserting the member was validated.
  // The key itself no longer exists, so a VALID old member is refused exactly
  // like an invalid one — and asserting the valid one is what distinguishes
  // "the field was deleted" from "the field is still validated".
  // ⚠️ **A COMPLETE document, and that is the correction.** The arm this
  // replaces asserted only `success === false` against a fixture missing
  // `emails`, `phones`, `contacts`, `query_by_contacts` and the timestamps — so
  // it rejected whether or not `tax_profile` was there, and would have passed
  // against a schema that never validated the field at all. A one-sided
  // rejection assertion needs its positive half or it proves nothing.
  assertEquals(OrganizationSchema.safeParse(validOrganization()).success, true, "…without it, this parses");
  for (const value of ["tax_applied", "invalid"]) {
    assertEquals(
      OrganizationSchema.safeParse(validOrganization({ tax_profile: value })).success,
      false,
      `a stored ${value} is refused as an unknown key`,
    );
  }
});

Deno.test("OrganizationSchema rejects additional properties", () => {
  assertEquals(OrganizationSchema.safeParse(validOrganization({ bogus: true })).success, false);
});

Deno.test("CreateOrganizationInput accepts valid input", () => {
  const input = {
    uid: "testorg1000000000000",
    name: "Acme",
    billing_address: validAddress,
  };
  assertEquals(CreateOrganizationInput.safeParse(input).success, true);
});

Deno.test("UpdateOrganizationInput accepts partial update", () => {
  const input = { name: "New Name", version: 1 };
  assertEquals(UpdateOrganizationInput.safeParse(input).success, true);
});

// ─── The tree: the four invariants that read ONE document ───────────────────
//
// 🔴 **Asserted DIRECTLY, and that is the point.** The rest of the tree guard is
// a fixed-point check — "`path` equals what the recompute produces" — which is
// defined in terms of the normalizer and can therefore only ever agree with it.
// Exactly that shape certified 79 provably-wrong item paths as clean,
// corpus-wide, for as long as `computeInvoiceItemPaths` had a hole in it.
//
// Each case plants ONE violation into an otherwise valid document, so none can
// pass because of a second, unrelated failure.

const ROOT_ID = "aaaaaaaaaaaaaaaaaaaa";
const PROJECT_ID = "bbbbbbbbbbbbbbbbbbbb";
const TYPE_ID = "dddddddddddddddddddd";
const SELF_ID = "testorg1000000000000";

const treeRoot = { uid: ROOT_ID, name: "Netflix Productions, LLC", derived: false };
const treeProject = { uid: PROJECT_ID, name: "Saturn Return", derived: false };
const treeSelf = { uid: SELF_ID, name: "Locations", derived: false };

/** A valid DEPARTMENT node, so each negative below differs from it by one field. */
const validTreeOrganization = (overrides: Record<string, unknown> = {}) =>
  validOrganization({
    path: [treeRoot, treeProject, treeSelf],
    query_by_path: [ROOT_ID, PROJECT_ID, SELF_ID],
    derived_from: null,
    uid_department_type: TYPE_ID,
    ...overrides,
  });

// The two levels that MAY state a billing address, so invariants 10 and 11 have
// controls at the levels they must not reach. ⚠️ Each leaf carries SELF_ID
// rather than its own constant — `path` is self-inclusive (invariant 1), so a
// borrowed leaf uid fails on 1 and the control would pass for the wrong reason.
const namedProject = (overrides: Record<string, unknown> = {}) =>
  validOrganization({
    path: [treeRoot, { ...treeProject, uid: SELF_ID }],
    query_by_path: [ROOT_ID, SELF_ID],
    derived_from: null,
    uid_department_type: null,
    ...overrides,
  });

const namedRoot = (overrides: Record<string, unknown> = {}) =>
  validOrganization({
    path: [{ ...treeRoot, uid: SELF_ID }],
    query_by_path: [SELF_ID],
    derived_from: null,
    uid_department_type: null,
    ...overrides,
  });

Deno.test("OrganizationSchema accepts a complete department node", () => {
  const result = OrganizationSchema.safeParse(validTreeOrganization());
  assertEquals(result.success, true, JSON.stringify(result.error?.issues));
});

Deno.test("tree invariant 1 — path is SELF-INCLUSIVE, and nothing else defends that", () => {
  // `assertValidForWrite` / `assertValidPatch` read `doc.uid` and compare it to
  // `ref.id`; neither can see `path.at(-1).uid`. So `path` carries a second copy
  // of the document's own id that only this refinement guards.
  const doc = validTreeOrganization({ path: [treeRoot, treeProject, { ...treeSelf, uid: PROJECT_ID }] });
  assertEquals(OrganizationSchema.safeParse(doc).success, false);
});

Deno.test("tree invariant 2 — a root is always operator-named, so a composed name can never be empty", () => {
  const doc = validTreeOrganization({ path: [{ ...treeRoot, derived: true }, treeProject, treeSelf] });
  assertEquals(OrganizationSchema.safeParse(doc).success, false);
});

Deno.test("tree invariant 3 — derived_from and the leaf's own `derived` are ONE fact in two places", () => {
  // A derived leaf with no provenance…
  assertEquals(
    OrganizationSchema.safeParse(validTreeOrganization({
      path: [treeRoot, treeProject, { ...treeSelf, name: "(default)", derived: true }],
      uid_department_type: null,
    })).success,
    false,
  );
  // …and provenance on an operator-named leaf.
  assertEquals(
    OrganizationSchema.safeParse(validTreeOrganization({
      derived_from: { source_uid: ROOT_ID, reason: "minted-department" },
    })).success,
    false,
  );
});

Deno.test("tree invariant 10 — a DERIVED placeholder states no billing address", () => {
  // api-cloudrun#777: organization states, project overrides, department
  // inherits. A `(default)` node is CFS-native structure nobody authored, so an
  // address on it is an answer no operator chose.
  const derivedProject = { uid: SELF_ID, name: "(default)", derived: true };
  const placeholder = (overrides: Record<string, unknown> = {}) =>
    validOrganization({
      path: [treeRoot, derivedProject],
      query_by_path: [ROOT_ID, SELF_ID],
      derived_from: { source_uid: ROOT_ID, reason: "minted-project" },
      uid_department_type: null,
      ...overrides,
    });

  // The positive: this is exactly what `createOrganization` mints today, and it
  // must keep parsing — a guard that also rejects the live writer is a rollback.
  assertEquals(
    OrganizationSchema.safeParse(placeholder()).success,
    true,
    JSON.stringify(OrganizationSchema.safeParse(placeholder()).error?.issues),
  );

  // The negative, which is what `updateOrganization` would otherwise accept.
  assertEquals(
    OrganizationSchema.safeParse(placeholder({
      billing_address: { full: "5808 W Sunset Blvd, Los Angeles, CA, 90028, United States" },
    })).success,
    false,
  );

  // ⚠️ The control that stops this over-reaching, and it MOVED with invariant 11
  // (api-cloudrun#799 Tier 3b). It used to be a DEPARTMENT — `validTreeOrganization`
  // — which is now refused at depth 3 regardless of `derived`. A PROJECT is the
  // right control: it is the level that may still override, so this is the case
  // that proves 10 and 11 together have not swallowed the rule they enforce.
  assertEquals(
    OrganizationSchema.safeParse(namedProject({
      billing_address: { full: "2558 W 16th St, Chicago, IL, 60608, United States" },
    })).success,
    true,
  );
});

/**
 * The document is refused, AND the reason is `billing_address`.
 *
 * 🔴 A bare `success === false` is satisfied by any failure at all, so it cannot
 * tell an arm that fired from an arm whose fixture drifted onto a different
 * invariant. Naming the issue path is what makes each negative here reachable
 * only through the arm it is written for.
 */
function assertBillingIssue(doc: Record<string, unknown>) {
  const result = OrganizationSchema.safeParse(doc);
  assertEquals(result.success, false, "expected the document to be refused");
  const paths = result.error?.issues.map((i) => i.path.join(".")) ?? [];
  assertEquals(
    paths.includes("billing_address"),
    true,
    `expected a billing_address issue, got [${paths.join(", ")}]`,
  );
}

Deno.test("tree invariant 11 — a DEPARTMENT inherits its billing address, it never states one", () => {
  // 🔴 The CONTRACT half of api-cloudrun#777, landing after the corpus half
  // (29 prod departments cleared 2026-09-04) and after manager stopped offering
  // the editor. Until it existed the corpus was clean and nothing kept it clean:
  // the manager gate read `derived`, and depth is not in `derived`.
  const stated = { full: "5808 W Sunset Blvd, Los Angeles, CA, 90028, United States" };

  // The positive: a department stating nothing is what all 29 prod departments
  // are now, and it must keep parsing.
  assertEquals(
    OrganizationSchema.safeParse(validTreeOrganization()).success,
    true,
    JSON.stringify(OrganizationSchema.safeParse(validTreeOrganization()).error?.issues),
  );

  // The negative — the shape `updateOrganization` accepted until this landed.
  //
  // ⭐ **Asserted on the ISSUE PATH, not on `success`.** A document differing
  // from the valid one by a single field can only fail for one reason, but
  // `success === false` cannot say which — and every negative in this file is
  // one edit away from failing on invariant 1 instead and passing for it.
  assertBillingIssue(validTreeOrganization({ billing_address: stated }));

  // ⚠️ **Depth, NOT the department type.** A derived department carries no
  // `uid_department_type` (invariant 8), so an arm keyed on the catalog
  // reference would let a minted one hold an address — the exact gap that made
  // `derived` alone the wrong gate in the manager.
  assertBillingIssue(
    validOrganization({
      path: [treeRoot, treeProject, { ...treeSelf, name: "(default)", derived: true }],
      query_by_path: [ROOT_ID, PROJECT_ID, SELF_ID],
      derived_from: { source_uid: ROOT_ID, reason: "minted-department" },
      uid_department_type: null,
      billing_address: stated,
    }));

  // ⚠️ And the ROOT keeps its own — the level that always states one. An arm
  // that fired here would take every customer's bill-to block with it.
  assertEquals(
    OrganizationSchema.safeParse(namedRoot({ billing_address: stated })).success,
    true,
    JSON.stringify(OrganizationSchema.safeParse(namedRoot({ billing_address: stated })).error?.issues),
  );
  assertEquals(
    OrganizationSchema.safeParse(namedProject({ billing_address: stated })).success,
    true,
  );
});

Deno.test("tree invariant 4 — query_by_path IS path.map(n => n.uid), order included", () => {
  assertEquals(
    OrganizationSchema.safeParse(validTreeOrganization({ query_by_path: [ROOT_ID, PROJECT_ID] })).success,
    false,
    "a short mirror",
  );
  assertEquals(
    OrganizationSchema.safeParse(validTreeOrganization({ query_by_path: [SELF_ID, PROJECT_ID, ROOT_ID] })).success,
    false,
    "the right uids in the wrong order — this is what makes it a MIRROR rather than a set",
  );
});

Deno.test("tree — uid_department_type is set on exactly the TYPED departments", () => {
  assertEquals(
    OrganizationSchema.safeParse(validTreeOrganization({ path: [treeRoot, { ...treeSelf, name: "Saturn Return" }], query_by_path: [ROOT_ID, SELF_ID] })).success,
    false,
    "a PROJECT may not name a department-type entry",
  );
  assertEquals(
    OrganizationSchema.safeParse(validTreeOrganization({
      path: [treeRoot, treeProject, { ...treeSelf, name: "(default)", derived: true }],
      derived_from: { source_uid: ROOT_ID, reason: "minted-department" },
    })).success,
    false,
    "a DERIVED department has no catalog entry — a minted `(default)` needs no row, which falls out of the model rather than needing a special case",
  );
});

Deno.test("tree — the depth cap is a SCHEMA constraint, not only a writer one", () => {
  const doc = validTreeOrganization({
    path: [treeRoot, treeProject, { uid: "eeeeeeeeeeeeeeeeeeee", name: "S2", derived: false }, treeSelf],
    query_by_path: [ROOT_ID, PROJECT_ID, "eeeeeeeeeeeeeeeeeeee", SELF_ID],
  });
  assertEquals(OrganizationSchema.safeParse(doc).success, false);
});

Deno.test("tree — crms_id is nullable, because a NON-LEAF node has no CRMS counterpart", () => {
  // `null` is a real answer here — "this node is not a leaf" — not "unknown".
  // ⚠️ It is only meaningful because the minting writer stamps an explicit
  // `null`: `orders.crms_id` reads identically and is REQUIRED, because
  // `createOrder` writes one. Same census, opposite verdicts.
  assertEquals(OrganizationSchema.safeParse(validOrganization({ crms_id: null })).success, true);
  assertEquals(OrganizationSchema.safeParse(validOrganization({ crms_id: undefined })).success, false, "nullable, never optional");
});

Deno.test("tree — an un-backfilled organization still parses, through the expand third", () => {
  // Every arm of the refinement is guarded on `path` being present; that guard
  // comes out in the same commit as the optionality.
  assertEquals(OrganizationSchema.safeParse(validOrganization()).success, true);
});

Deno.test("CreateOrganizationInput carries uid_parent — the server derives path from the RESOLVED parent", () => {
  assertEquals(
    CreateOrganizationInput.safeParse({ uid: "testorg1000000000000", name: "Locations", uid_parent: PROJECT_ID, uid_department_type: TYPE_ID, billing_address: validAddress }).success,
    true,
  );
});

Deno.test("UpdateOrganizationInput distinguishes ABSENT from an explicit null uid_parent", () => {
  // Absent means "leave the parent alone"; `null` means "promote to a root".
  // Collapsing them is core#70's *"an optional value can be set but never
  // unset"* surface, which this model stays off.
  const absent = UpdateOrganizationInput.safeParse({ name: "New Name", version: 1 });
  assertEquals(absent.success, true);
  assertEquals("uid_parent" in (absent.data ?? {}), false);

  const explicitNull = UpdateOrganizationInput.safeParse({ uid_parent: null, version: 1 });
  assertEquals(explicitNull.success, true);
  assertEquals(explicitNull.data?.uid_parent, null);
});
