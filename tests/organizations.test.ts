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
  tax_profile: "tax_frankfort",
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

Deno.test("buildOrganizationSnapshot carries tax_profile — the field #486 was missing", () => {
  assertEquals(buildOrganizationSnapshot(ORG).tax_profile, "tax_frankfort");
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
  assertEquals(snapshot.tax_profile, "tax_frankfort");
});

Deno.test("the shared snapshot admits both a present and an absent billing_address", () => {
  // Order had it `.optional()`, invoice + credit note required with an explicit
  // stored `null`. Merging to either side alone makes existing documents of the
  // other unwritable, so both must parse.
  const base = { uid: ORG_ID, name: "A", xero_id: null };
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
  const base = { uid: ORG_ID, xero_id: null };
  assertEquals(DocumentOrganizationSnapshot.safeParse({ ...base, name: "" }).success, false);
  assertEquals(
    DocumentOrganizationSnapshot.safeParse({ ...base, name: "x".repeat(101) }).success,
    false,
  );
});

Deno.test("the shared snapshot tolerates an ABSENT tax_profile for the backfill window", () => {
  // Optional by necessity, not preference: the old and new schemas have disjoint
  // accepted sets (both are `z.strictObject` and every write validates the full
  // document), so there is no deploy order in which a required field avoids a
  // window of failing order writes. The follow-up publish drops the `.optional()`.
  const parsed = DocumentOrganizationSnapshot.parse({
    uid: ORG_ID,
    name: "A",
    xero_id: null,
  });
  assertEquals((parsed as { tax_profile?: string }).tax_profile, undefined);
});
