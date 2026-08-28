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
  name: "Acme",
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
    name: "Acme Corp",
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
    query_by_organizations: [ROOT_ID, PROJECT_ID, SELF_ID],
    derived_from: null,
    uid_department_type: TYPE_ID,
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

Deno.test("tree invariant 4 — query_by_organizations IS path.map(n => n.uid), order included", () => {
  assertEquals(
    OrganizationSchema.safeParse(validTreeOrganization({ query_by_organizations: [ROOT_ID, PROJECT_ID] })).success,
    false,
    "a short mirror",
  );
  assertEquals(
    OrganizationSchema.safeParse(validTreeOrganization({ query_by_organizations: [SELF_ID, PROJECT_ID, ROOT_ID] })).success,
    false,
    "the right uids in the wrong order — this is what makes it a MIRROR rather than a set",
  );
});

Deno.test("tree — uid_department_type is set on exactly the TYPED departments", () => {
  assertEquals(
    OrganizationSchema.safeParse(validTreeOrganization({ path: [treeRoot, { ...treeSelf, name: "Saturn Return" }], query_by_organizations: [ROOT_ID, SELF_ID] })).success,
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
    query_by_organizations: [ROOT_ID, PROJECT_ID, "eeeeeeeeeeeeeeeeeeee", SELF_ID],
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
