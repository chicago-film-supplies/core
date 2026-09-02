import { assertEquals, assertThrows } from "@std/assert";

/** A real 20-char Firestore id — `FirestoreId` rejects anything else, and a
 * fixture that fails on the uid makes a "rejects a bad name" test pass for the
 * wrong reason. */
const ORG_ID = "x0fdH2hFqKY9HsOsEmi4";
import {
  buildOrganizationSnapshot,
  composeOrgName,
  computeOrganizationNode,
  orgLevel,
  orgOwnName,
  orgParentUid,
  orgRootUid,
  validateOrganizationTree,
} from "../src/utils/organizations.ts";
import { DocumentOrganizationSnapshot, type Organization } from "../src/schemas/mod.ts";

const ORG_OWN_NAME = "Kenwood TV Productions Inc";
const ORG = {
  uid: ORG_ID,
  // ⚠️ **A `path`, and no `name` scalar** — the same lesson this fixture's own
  // note below records, applied to itself. The scalar was removed and `path`
  // made required (api-cloudrun#709), so an organization carrying the one and
  // not the other is no longer a document the corpus could hold.
  path: [{ uid: ORG_ID, name: ORG_OWN_NAME, derived: false }],
  query_by_path: [ORG_ID],
  derived_from: null,
  uid_department_type: null,
  crms_id: 4321,
  // 🔴 **The axes, not the enum — and the fixture had to move for the
  // assertions to mean anything.** It carried `tax_profile: "tax_frankfort"`
  // and neither axis, which was a plausible document while the enum was the
  // source of truth and is an IMPOSSIBLE one now. api-cloudrun's `seedOrg`
  // taught this exactly: an organization fixture that is not a plausible
  // document leaves the arm meant to catch a defect with nothing to fire on.
  jurisdiction_claim: "frankfort",
  tax_exempt: false,
  xero_id: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  billing_address: {
    city: "Frankfort",
    country_name: "United States",
    full: "19900 S Harlem Avenue, Frankfort, IL, 60423, United States",
    name: "",
    postcode: "60423",
    region: "IL",
    street: "19900 S Harlem Avenue",
  },
} as unknown as Organization;

Deno.test("buildOrganizationSnapshot carries the AXES, and no longer the enum", () => {
  // The assertion this replaces read `.tax_profile === "tax_frankfort"` — the
  // field #486 was missing from three of four hand-rolled literals. The axes
  // now carry that same fact and carry it BETTER: `tax_frankfort` welded a
  // jurisdiction to an exemption slot, and these two say each separately.
  const snapshot = buildOrganizationSnapshot(ORG);
  assertEquals(snapshot.jurisdiction_claim, "frankfort");
  assertEquals(snapshot.tax_exempt, false);
  // 🔴 The half that makes this a real assertion: the key is ABSENT, not
  // undefined-valued. Firestore stores a present-but-undefined key as null on
  // some paths and drops it on others, and `scripts/migrate-drop-tax-profile.ts`
  // would then be racing a writer that keeps putting it back.
  assertEquals("tax_profile" in snapshot, false);
});

Deno.test("buildOrganizationSnapshot FREEZES the chain, not just its composed text", () => {
  // 🔴 **The arm that was missing for the field's whole life.** `path` was
  // declared on the snapshot, argued for at length, and emitted by NOTHING —
  // its backfill ran and was deleted without the writer ever being opened, so
  // documents accrued pathless at ~5/day. Nothing failed, because nothing
  // asked.
  //
  // ⭐ Asserted DIRECTLY against the organization's own chain rather than
  // against `composeOrgName(snapshot.path)`, which would be a fixed point: it
  // is defined in terms of the same input and can only ever agree. The whole
  // point of storing the chain beside the text is that the text cannot be
  // grouped on, joined on, or parsed back — so the test has to read the
  // structure.
  const snapshot = buildOrganizationSnapshot(ORG);
  assertEquals(snapshot.path, ORG.path);
  assertEquals(snapshot.path?.at(-1)?.uid, ORG_ID);
  // ⭐ **And the composed scalar is NOT emitted — asserted positively, on the
  // KEY rather than the value.** This assertion used to read
  // `snapshot.name === composeOrgName(ORG.path)`; deleting it outright would
  // have rested the new behaviour on nothing, and a writer that "helpfully"
  // restored the line would pass. `in` rather than `=== undefined` because
  // Firestore treats an absent key and a present-but-undefined one differently
  // — and `validateBeforeWrite`'s `scanForUndefined` rejects the latter.
  assertEquals("name" in snapshot, false);
});

Deno.test("buildOrganizationSnapshot produces a snapshot the shared schema accepts", () => {
  // The union taken on `name` and `billing_address` has to admit what the
  // builder emits, or the three writers that call it fail `validateBeforeWrite`
  // at runtime rather than here.
  // Acceptance, not round-trip equality: `Address`'s `.default("")` fields
  // materialize on parse, and `validateBeforeWrite` discards the parsed output
  // anyway — so asserting the output equals the input would only be asserting
  // which keys carry a default.
  const snapshot = buildOrganizationSnapshot(ORG);
  assertEquals(DocumentOrganizationSnapshot.safeParse(snapshot).success, true);
});

Deno.test("buildOrganizationSnapshot: falsy crms_id/xero_id/billing_address become null", () => {
  const bare = buildOrganizationSnapshot({
    ...ORG,
    crms_id: 0,
    xero_id: "",
    billing_address: null,
  } as unknown as Organization);
  // `|| null`, matching every call site it replaces — a `crms_id` of 0 is not a
  // CRMS id, and Firestore stores an absent xero_id as null rather than "".
  assertEquals(bare.crms_id, null);
  assertEquals(bare.xero_id, null);
  assertEquals(bare.billing_address, null);
});

Deno.test("buildOrganizationSnapshot: overrides win, for the CRMS member_id case", () => {
  // The CRMS opportunity webhook stamps the snapshot's `crms_id` from the
  // opportunity payload's `member_id`, not from the org document — that is the
  // one field the four writers legitimately disagree on, so it is a parameter
  // rather than a reason to keep a fourth hand-written literal.
  const snapshot = buildOrganizationSnapshot(ORG, { crms_id: 9999 });
  assertEquals(snapshot.crms_id, 9999);
  // A depth-1 node composes to its own segment — which is the name the
  // OVERRIDES could still put back, so the assertion is that they did not.
  assertEquals(composeOrgName(snapshot.path), ORG_OWN_NAME);
  assertEquals("name" in snapshot, false);
  assertEquals(snapshot.jurisdiction_claim, "frankfort");
});

/**
 * A MINIMAL-VALID snapshot — every required field and nothing else.
 *
 * ⚠️ **Its existence is the point.** Each negative test below spreads it and
 * breaks exactly one thing, so the assertion stays about that thing. Built by
 * hand from the fixtures instead, a later tightening makes every one of them
 * fail for a second reason and pass **vacuously** — the test still reports
 * `success === false` while no longer testing its own subject. `path` became
 * required in core#77 and would have done exactly that to all three.
 */
const MINIMAL_SNAPSHOT = {
  uid: ORG_ID,
  name: "A",
  path: [{ uid: ORG_ID, name: "A", derived: false }],
  xero_id: null,
};

Deno.test("the shared snapshot admits both a present and an absent billing_address", () => {
  // Order had it `.optional()`, invoice + credit note required with an explicit
  // stored `null`. Merging to either side alone makes existing documents of the
  // other unwritable, so both must parse.
  const base = MINIMAL_SNAPSHOT;
  assertEquals(DocumentOrganizationSnapshot.safeParse(base).success, true);
  assertEquals(
    DocumentOrganizationSnapshot.safeParse({ ...base, billing_address: null }).success,
    true,
  );
});

Deno.test("the shared snapshot still rejects an out-of-bounds name", () => {
  // Order's `[1, 100]` bounds are kept. Not a tightening in practice —
  // `Organization.name` carries the same bounds and every snapshot is copied
  // from it — but the assertion is what says the merge took the bounded side.
  //
  // ⚠️ The bounds survive the field going `.optional()` deliberately: loosening
  // them in the same step would quietly re-admit the empty string on the
  // fossils still carrying one.
  const { name: _dropped, ...base } = MINIMAL_SNAPSHOT;
  assertEquals(DocumentOrganizationSnapshot.safeParse({ ...base, name: "" }).success, false);
  assertEquals(
    DocumentOrganizationSnapshot.safeParse({ ...base, name: "x".repeat(101) }).success,
    false,
  );
});

Deno.test("the shared snapshot admits an ABSENT name — the migrate third of its removal", () => {
  // 🔴 **Both single-step orderings break a live write path, which is why this
  // parses rather than being deleted outright.** Every order/invoice write
  // validates the FULL document and this is a `z.strictObject`, so `name`
  // required and `name` deleted have DISJOINT accepted sets: delete-then-purge
  // makes the 2,050 stored documents unwritable, purge-then-delete makes the
  // purged ones unwritable by the build still deployed. Optional → empty
  // storage → delete, the same three steps `tax_profile` and `path` each ran.
  //
  // ⭐ Paired with the arm above rather than replacing it: absent must parse
  // AND a present one must still be bounded, for as long as fossils exist.
  const { name: _dropped, ...withoutName } = MINIMAL_SNAPSHOT;
  assertEquals(DocumentOrganizationSnapshot.safeParse(withoutName).success, true);
  assertEquals(DocumentOrganizationSnapshot.safeParse(MINIMAL_SNAPSHOT).success, true);
});

Deno.test("the shared snapshot REFUSES a chain that ends somewhere else — api-cloudrun#775", () => {
  // The #1010 shape: `uid` names one organization, the frozen chain describes
  // another's tree. It parsed, wrote and audited clean for four days because
  // the two were independent fields and nothing compared them.
  //
  // ⭐ Direct, not a fixed point — the assertion consults `uid`, which
  // `composeOrgName(path)` cannot produce. Every other guard in this campaign
  // compares a stored value against something derived from `path` alone.
  const otherOrg = "cccccccccccccccccccc";
  assertEquals(
    DocumentOrganizationSnapshot.safeParse({
      ...MINIMAL_SNAPSHOT,
      path: [{ uid: otherOrg, name: "Someone Else", derived: false }],
    }).success,
    false,
  );
  // …and a DEEPER chain is judged on its leaf, not on membership: an ancestor
  // carrying the uid is not the same fact as the chain ending there.
  assertEquals(
    DocumentOrganizationSnapshot.safeParse({
      ...MINIMAL_SNAPSHOT,
      path: [
        { uid: ORG_ID, name: "A", derived: false },
        { uid: otherOrg, name: "Someone Else", derived: false },
      ],
    }).success,
    false,
  );
  // A snapshot naming NO organization is exempt — `uid` is `.nullable()`, so
  // there is no id for the leaf to equal. Dev holds 155 of these
  // (api-cloudrun#774); prod holds none.
  assertEquals(
    DocumentOrganizationSnapshot.safeParse({ ...MINIMAL_SNAPSHOT, uid: null }).success,
    true,
  );
});

Deno.test("the shared snapshot now REFUSES a tax_profile — api-cloudrun#596 item 3", () => {
  // 🔴 **This assertion has been inverted THREE times, and the sequence is the
  // whole expand/migrate/contract argument written as tests.**
  //
  //   before #489  — absent ADMITTED  (the field was arriving, optional)
  //   #489         — absent REFUSED   (contract: it became required)
  //   #596 expand  — absent ADMITTED  (it is leaving, optional again)
  //   #596 contract— present REFUSED  (this arm)
  //
  // Every one of those flips is forced by the same fact: this is a
  // `z.strictObject` and every write validates the FULL document, so two schema
  // versions have DISJOINT accepted sets whichever direction the field moves. A
  // required field refuses documents lacking it; a DELETED field refuses
  // documents still carrying it.
  //
  // ⚠️ Which is why the middle step was gated on PROD, not on this repo:
  // storage was emptied (2,317 documents, 2026-08-22) only once the deployed
  // API ran the optional schema. Reaching this state before that would have
  // refused every order write, the CRMS opportunity webhook included, whose
  // failures are silent drops.
  const clean = DocumentOrganizationSnapshot.safeParse(MINIMAL_SNAPSHOT);
  assertEquals(clean.success, true, "a snapshot without the field is the only shape now");

  // 🔴 The half that makes this the CONTRACT rather than a restatement: a
  // snapshot still carrying the key is REFUSED, and refused because the key is
  // unknown rather than because its value is wrong — so a valid old member is
  // rejected exactly like an invalid one.
  for (const value of ["tax_applied", "tax_frankfort", "tax_narnia"]) {
    assertEquals(
      // Spread from the minimal-valid base, so `tax_profile` is the ONE thing
      // wrong with this document — otherwise a later required field would make
      // the refusal true for a reason this test is not about.
      DocumentOrganizationSnapshot.safeParse({ ...MINIMAL_SNAPSHOT, tax_profile: value }).success,
      false,
      `a stored ${value} must be refused — that is what made the migration a precondition`,
    );
  }
});

Deno.test("the shared snapshot now REQUIRES path — core#77's contract third", () => {
  // 🔴 **The whole value of this change, stated as the one thing it makes
  // impossible.** `path` was declared, argued for at length, and emitted by
  // NOTHING for months without a single failure — because `.optional()` meant no
  // schema ever refused a document lacking it. api-cloudrun accrued pathless
  // orders and invoices at ~5/day on exactly that hole.
  //
  // ⚠️ The direction is the SAFE one and this is the fact that says so: adding a
  // requirement to a field every stored document already carries strands no
  // reader, so it needs none of the four-step ordering a REMOVAL does. The
  // precondition is a claim about the corpus — `missing: 0` on both
  // environments over 2,049 chains, 2026-09-01 — not about this repo.
  const { path: _dropped, ...pathless } = MINIMAL_SNAPSHOT;
  assertEquals(
    DocumentOrganizationSnapshot.safeParse(pathless).success,
    false,
    "a snapshot with no frozen chain must no longer parse",
  );
  assertEquals(DocumentOrganizationSnapshot.safeParse(MINIMAL_SNAPSHOT).success, true);

  // The bounds came with it and are not incidental: `.min(1)` is what makes
  // `composeOrgName` non-empty by construction, and `.max(3)` is ORG_LEVELS.
  assertEquals(
    DocumentOrganizationSnapshot.safeParse({ ...MINIMAL_SNAPSHOT, path: [] }).success,
    false,
    "an EMPTY chain is not a chain — it composes to no name at all",
  );
});

// ─── The tree ───────────────────────────────────────────────────────────────
//
// ⚠️ **Every negative case below plants ONE violation into an otherwise valid
// node.** A hand-spelled invalid fixture makes a test pass for the wrong reason
// — `tests/organization.test.ts` records two of this file's siblings already
// doing that — and here it is worse than usual: the four one-document
// invariants and the three context invariants can each mask another.

const ROOT_ID = "aaaaaaaaaaaaaaaaaaaa";
const PROJECT_ID = "bbbbbbbbbbbbbbbbbbbb";
const DEPT_ID = "cccccccccccccccccccc";
const TYPE_ID = "dddddddddddddddddddd";

const rootNode = { uid: ROOT_ID, name: "Netflix Productions, LLC", derived: false };
const projectNode = { uid: PROJECT_ID, name: "Saturn Return", derived: false };
const deptNode = { uid: DEPT_ID, name: "Locations", derived: false };

const rootDoc = { uid: ROOT_ID, path: [rootNode], uid_department_type: null };
const projectDoc = { uid: PROJECT_ID, path: [rootNode, projectNode], uid_department_type: null };
const deptDoc = { uid: DEPT_ID, path: [rootNode, projectNode, deptNode], uid_department_type: TYPE_ID };

Deno.test("computeOrganizationNode is the ONE author — path is [...parent.path, self]", () => {
  const root = computeOrganizationNode(rootNode, null);
  assertEquals(root.path, [rootNode]);
  assertEquals(root.query_by_path, [ROOT_ID]);

  const project = computeOrganizationNode(projectNode, { uid: ROOT_ID, path: root.path });
  assertEquals(project.path, [rootNode, projectNode]);
  assertEquals(project.query_by_path, [ROOT_ID, PROJECT_ID]);

  const dept = computeOrganizationNode(deptNode, { uid: PROJECT_ID, path: project.path });
  assertEquals(dept.path, [rootNode, projectNode, deptNode]);
  assertEquals(dept.query_by_path, [ROOT_ID, PROJECT_ID, DEPT_ID]);
});

Deno.test("computeOrganizationNode refuses a fourth level — a SEASON is part of the project title", () => {
  assertThrows(
    () => computeOrganizationNode({ uid: "eeeeeeeeeeeeeeeeeeee", name: "S2", derived: false }, { uid: DEPT_ID, path: deptDoc.path }),
    Error,
    "3 levels",
  );
});

Deno.test("computeOrganizationNode refuses a cycle — a node cannot be its own ancestor", () => {
  assertThrows(
    () => computeOrganizationNode(rootNode, { uid: PROJECT_ID, path: projectDoc.path }),
    Error,
    "its own path",
  );
});

Deno.test("computeOrganizationNode refuses an un-backfilled parent rather than minting a wrong path", () => {
  assertThrows(
    // See the cast note below — a pathless parent is unrepresentable in the
    // type but still refused at runtime, which is what this asserts.
    () => computeOrganizationNode(projectNode, { uid: ROOT_ID, path: undefined } as unknown as Pick<Organization, "uid" | "path">),
    Error,
    "has no path",
  );
});

Deno.test("the derivations are READ OFF path — there is no stored level, root or parent", () => {
  assertEquals(orgLevel(rootDoc), "organization");
  assertEquals(orgLevel(projectDoc), "project");
  assertEquals(orgLevel(deptDoc), "department");
// ⚠️ Cast: `path` is REQUIRED as of the `name` removal, so this state is
  // unrepresentable in the TYPE — but a Firestore document is not type-checked,
  // and these functions still defend against one that lacks it. The cast is what
  // keeps that runtime guard covered now that the compiler forbids the input.
  assertEquals(orgLevel({ path: undefined } as unknown as Pick<Organization, "path">), null);

  assertEquals(orgRootUid(deptDoc), ROOT_ID);
  assertEquals(orgParentUid(deptDoc), PROJECT_ID);
  assertEquals(orgParentUid(rootDoc), null, "a root's parent is null");
  assertEquals(orgOwnName(deptDoc), "Locations");
});

Deno.test("composeOrgName joins the operator-named segments and drops the derived ones", () => {
  assertEquals(composeOrgName(deptDoc.path), "Netflix Productions, LLC / Saturn Return / Locations");
  assertEquals(
    composeOrgName([rootNode, { uid: PROJECT_ID, name: "(default)", derived: true }, { uid: DEPT_ID, name: "(default)", derived: true }]),
    "Netflix Productions, LLC",
    "a fully-derived chain renders as its root alone",
  );
});

Deno.test("composeOrgName can never return an empty string — invariant 2 guarantees a named root", () => {
  // `path[0].derived === false` is asserted on the document, so at least one
  // segment always survives the filter. This is the property the nine embedded
  // snapshots' own `.min(1).max(100)` depends on.
  assertEquals(composeOrgName([rootNode]).length > 0, true);
  assertEquals(composeOrgName([{ ...rootNode, derived: true }]), "Netflix Productions, LLC", "even a hostile all-derived path falls back to the chain rather than to \"\"");
});

Deno.test("composeOrgName elides the MIDDLE before it shortens, and never truncates the tail", () => {
  // 50 is Xero's contact-name cap, passed in — core owns the algorithm, api owns
  // the constant.
  // ⚠️ **52, not the 50 the plan doc claimed.** The measurement matters in the
  // direction that makes the branch live rather than theoretical, so the
  // correction only strengthens it — but a figure quoted as "exactly at the cap"
  // is one edit from reading as "fits".
  const full = "Netflix Productions, LLC / Saturn Return / Locations";
  assertEquals(full.length, 52, "the live case is TWO characters over Xero's 50 — this is not a theoretical branch");

  const elided = composeOrgName(deptDoc.path, { maxLength: 50 });
  assertEquals(elided, "Netflix Productions, LLC / … / Locations");
  assertEquals(elided.length <= 50, true);
  assertEquals(elided.endsWith("Locations"), true, "the LEAF is the identity — it maps to a Xero contact and therefore to a receivable");
});

Deno.test("composeOrgName shortens the ROOT when eliding the middle is not enough", () => {
  const longRoot = { uid: ROOT_ID, name: "A Very Long Legal Entity Name That Will Not Fit Anywhere", derived: false };
  const out = composeOrgName([longRoot, projectNode, deptNode], { maxLength: 30 });
  assertEquals(out.length <= 30, true);
  assertEquals(out.endsWith("Locations"), true, "the leaf survives whole");
  assertEquals(out.includes("…"), true, "the elision is VISIBLE — a silent drop makes a real two-level path and an elided three-level one indistinguishable in Xero");
});

Deno.test("composeOrgName keeps the leaf when even the leaf alone is over budget", () => {
  const out = composeOrgName([rootNode, projectNode, { uid: DEPT_ID, name: "Transportation and Logistics", derived: false }], { maxLength: 12 });
  assertEquals(out.length <= 12, true);
  assertEquals(out.startsWith("Transport"), true, "there is nothing more identifying left to preserve");
});

Deno.test("validateOrganizationTree — invariant 5: the ancestors ARE the parent's path", () => {
  assertEquals(validateOrganizationTree(deptDoc, projectDoc, []), []);
  assertEquals(validateOrganizationTree(rootDoc, null, []), []);

  const stale = { ...deptDoc, path: [rootNode, { ...projectNode, name: "Saturn Return (old)" }, deptNode] };
  const violations = validateOrganizationTree(stale, projectDoc, []);
  assertEquals(violations.length, 1);
  assertEquals(violations[0].includes("did not reach this node"), true);

  const wrongDepth = validateOrganizationTree(deptDoc, rootDoc, []);
  assertEquals(wrongDepth.length, 1);
  assertEquals(wrongDepth[0].includes("ancestor"), true);
});

Deno.test("validateOrganizationTree — invariant 6: sibling names are unique, case-folded, among NON-derived siblings", () => {
  const sibling = { uid: "ffffffffffffffffffff", path: [rootNode, projectNode, { uid: "ffffffffffffffffffff", name: "  locations ", derived: false }], uid_department_type: null };
  const violations = validateOrganizationTree(deptDoc, projectDoc, [sibling]);
  assertEquals(violations.length, 1);
  assertEquals(violations[0].includes("already named"), true);

  const derivedSibling = { ...sibling, path: [rootNode, projectNode, { uid: "ffffffffffffffffffff", name: "Locations", derived: true }] };
  assertEquals(
    validateOrganizationTree(deptDoc, projectDoc, [derivedSibling]),
    [],
    "a MINTED sibling does not hold a name against an operator-named one — two `(default)` nodes under one parent is a transient state of the mint, not a collision",
  );
});

Deno.test("validateOrganizationTree — invariant 6b: department-type uniqueness is a plain EQUALITY check", () => {
  // This is what the vocabulary buys: comparing catalog uids rather than
  // case-folding two strings that may be `Transportation` and `Transpo`.
  const sibling = {
    uid: "ffffffffffffffffffff",
    path: [rootNode, projectNode, { uid: "ffffffffffffffffffff", name: "Transpo", derived: false }],
    uid_department_type: TYPE_ID,
  };
  const violations = validateOrganizationTree(deptDoc, projectDoc, [sibling]);
  assertEquals(violations.length, 1);
  assertEquals(violations[0].includes("department type"), true, "the NAMES differ and the guard still fires — which a string compare could not do");
});

Deno.test("validateOrganizationTree returns [] for an un-backfilled node rather than inventing findings", () => {
  assertEquals(validateOrganizationTree({ uid: ROOT_ID, path: undefined, uid_department_type: null } as unknown as Parameters<typeof validateOrganizationTree>[0], null, []), []);
});
