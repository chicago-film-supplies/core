import { assertEquals } from "@std/assert";

/** A real 20-char Firestore id — `FirestoreId` rejects anything else, and a
 * fixture that fails on the uid makes a "rejects a bad name" test pass for the
 * wrong reason. */
const ORG_ID = "x0fdH2hFqKY9HsOsEmi4";
import { buildOrganizationSnapshot } from "../src/utils/organizations.ts";
import { DocumentOrganizationSnapshot, type Organization } from "../src/schemas/mod.ts";

const ORG = {
  uid: ORG_ID,
  name: "Kenwood TV Productions Inc",
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
  assertEquals(snapshot.name, ORG.name);
  assertEquals(snapshot.jurisdiction_claim, "frankfort");
});

Deno.test("the shared snapshot admits both a present and an absent billing_address", () => {
  // Order had it `.optional()`, invoice + credit note required with an explicit
  // stored `null`. Merging to either side alone makes existing documents of the
  // other unwritable, so both must parse.
  const base = { uid: ORG_ID, name: "A", xero_id: null, tax_profile: "tax_applied" };
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
  const base = { uid: ORG_ID, xero_id: null, tax_profile: "tax_applied" as const };
  assertEquals(DocumentOrganizationSnapshot.safeParse({ ...base, name: "" }).success, false);
  assertEquals(
    DocumentOrganizationSnapshot.safeParse({ ...base, name: "x".repeat(101) }).success,
    false,
  );
});

Deno.test("the shared snapshot ADMITS an absent tax_profile again — api-cloudrun#596 item 3", () => {
  // 🔴 **This assertion is #489's inverted a second time, and the symmetry is
  // the lesson.** #489 made the field required (the contract third of
  // expand/migrate/contract) and its predecessor asserted the opposite; the
  // field is now LEAVING, so it goes optional for one release cycle for exactly
  // the same reason it had to be optional to arrive. Both schema versions are
  // `z.strictObject` and every write validates the full document, so the two
  // accepted sets are disjoint in whichever direction the field is moving: a
  // required field refuses documents that lack it, and a DELETED field refuses
  // documents that still carry it.
  //
  // The order is therefore fixed and not a preference — optional here, storage
  // emptied by `scripts/migrate-drop-tax-profile.ts`, then the key deleted.
  // ⚠️ The middle step cannot start until PROD runs this schema: prod validates
  // the full document on every write, so emptying storage first would refuse
  // every order write, the CRMS opportunity webhook included, whose failures
  // are silent drops.
  const parsed = DocumentOrganizationSnapshot.safeParse({
    uid: ORG_ID,
    name: "A",
    xero_id: null,
  });
  assertEquals(parsed.success, true);

  // The discriminating half, kept from the assertion this replaces: a document
  // that still CARRIES a profile parses too. Without it this arm would also
  // pass against a schema that had already deleted the key — which is the one
  // state that must not be reachable until storage is empty.
  assertEquals(
    DocumentOrganizationSnapshot.safeParse({
      uid: ORG_ID,
      name: "A",
      xero_id: null,
      tax_profile: "tax_exempt",
    }).success,
    true,
  );

  // …and the key is still TYPED while it exists — an expand that also stopped
  // validating the member would let a writer put anything there on the way out.
  assertEquals(
    DocumentOrganizationSnapshot.safeParse({
      uid: ORG_ID,
      name: "A",
      xero_id: null,
      tax_profile: "tax_narnia",
    }).success,
    false,
  );
});
