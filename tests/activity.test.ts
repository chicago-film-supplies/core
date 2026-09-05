/**
 * The activity feed's collection → permission map, and the `in` array derived
 * from it.
 *
 * ⭐ **This file exists because the failure it guards is SILENT.** A feed row is
 * stamped with `read_permission` by the writer and fetched by a client sending
 * `where("read_permission", "in", …)`. If those two ever name different
 * permissions for one collection, the row is written, stored, gated correctly,
 * and **never asked for** — no error, no empty state, nothing red, and the row
 * visible in the Firestore console the whole time. The one owner in
 * `schemas/activity.ts` is what makes that unrepresentable; these are the
 * assertions that keep the owner itself honest.
 */
import { assertEquals, assertNotEquals } from "@std/assert";
import {
  ACTIVITY_FEED_PERMISSIONS,
  ACTIVITY_READ_PERMISSION_BY_COLLECTION,
  activityFeedPermissionsFor,
  ActivitySubjectCollectionEnum,
  PERMISSIONS,
  type Permission,
  schemas,
} from "../src/schemas/mod.ts";

/** The feed's own vocabulary, read off the enum rather than restated here. */
const FEED_COLLECTIONS = (ActivitySubjectCollectionEnum as unknown as {
  options: readonly string[];
}).options;

Deno.test("the permission map is TOTAL over the feed's collections", () => {
  // Totality is the whole safety property: a collection with no entry would
  // mean a row written with no `read_permission`, which `manager/firestore.rules`
  // denies to everyone. `Record<ActivitySubjectCollection, Permission>` gets this
  // at compile time — this arm is what catches it at RUNTIME for a consumer that
  // reached the map through an erased type (the npm `.d.ts`, a JSON round-trip).
  const missing = FEED_COLLECTIONS.filter(
    (c) => !(c in ACTIVITY_READ_PERMISSION_BY_COLLECTION),
  );
  assertEquals(missing, [], `feed collections with no permission: ${missing.join(", ")}`);

  // …and the other direction, so a collection deleted from the enum cannot
  // leave a dead entry behind that a later reader takes for live vocabulary.
  const extra = Object.keys(ACTIVITY_READ_PERMISSION_BY_COLLECTION).filter(
    (c) => !FEED_COLLECTIONS.includes(c),
  );
  assertEquals(extra, [], `mapped collections not in the feed: ${extra.join(", ")}`);

  // Fail-closed companion. Both arms above pass over an EMPTY corpus exactly as
  // they pass over a correct one, so a walk that stopped reaching the map reads
  // identically to a total map. Plant the hole and assert each arm sees it.
  const holed: Record<string, Permission> = { ...ACTIVITY_READ_PERMISSION_BY_COLLECTION };
  delete holed["orders"];
  holed["not-a-feed-collection"] = "orders.read";
  assertEquals(FEED_COLLECTIONS.filter((c) => !(c in holed)), ["orders"]);
  assertEquals(Object.keys(holed).filter((c) => !FEED_COLLECTIONS.includes(c)), [
    "not-a-feed-collection",
  ]);
});

Deno.test("every mapped permission is a real catalog member", () => {
  // The two the naive kebab→camel rule invents — `holidayDefinitions.read` and
  // `templateComponents.read` — are caught precisely here: they are not in
  // `PERMISSIONS`, so a client deriving the list that way asks for values that
  // do not exist and silently loses two collections.
  const catalog = new Set<string>(PERMISSIONS);
  const bogus = Object.entries(ACTIVITY_READ_PERMISSION_BY_COLLECTION)
    .filter(([, p]) => !catalog.has(p))
    .map(([c, p]) => `${c} → ${p}`);
  assertEquals(bogus, [], `not in PERMISSIONS: ${bogus.join(", ")}`);

  // Fail-closed companion, planted with the exact two values the naive rule
  // invents — this arm has never gone red in anger, so nothing else separates
  // "the map is clean" from "the catalog lookup stopped working".
  const invented = ["holidayDefinitions.read", "templateComponents.read"];
  assertEquals(invented.filter((p) => !catalog.has(p)), invented);
});

Deno.test("every mapped collection is a known collection", () => {
  // A typo guard, not a coupling — `schemas` double-keys singular and plural, so
  // it is the canonical collection namespace.
  const unknown = Object.keys(ACTIVITY_READ_PERMISSION_BY_COLLECTION).filter(
    (c) => !(c in schemas),
  );
  assertEquals(unknown, [], `not keys of the \`schemas\` record: ${unknown.join(", ")}`);
});

Deno.test("the derivation is NOT the kebab→camel rule — two collections prove it", () => {
  // Planted both ways. Without this, "the map is just the collection name
  // camel-cased" is a reading nothing contradicts, and the next person to need
  // this list in a third place derives it instead of importing it.
  assertEquals(ACTIVITY_READ_PERMISSION_BY_COLLECTION["holiday-definitions"], "holidays.read");
  assertEquals(ACTIVITY_READ_PERMISSION_BY_COLLECTION["template-components"], "templates.read");

  const kebabToCamel = (c: string) =>
    `${c.replace(/-([a-z])/g, (_, ch: string) => ch.toUpperCase())}.read`;
  assertNotEquals(
    kebabToCamel("holiday-definitions"),
    ACTIVITY_READ_PERMISSION_BY_COLLECTION["holiday-definitions"],
  );
  assertNotEquals(
    kebabToCamel("template-components"),
    ACTIVITY_READ_PERMISSION_BY_COLLECTION["template-components"],
  );
});

Deno.test("the feed stamps 22 DISTINCT permissions, 8 under Firestore's `in` cap of 30", () => {
  // 🔴 The number is asserted, not commented, because it is what has to stay
  // under the cap — and the cap binds on the ADMIN first, so the feed breaks for
  // the most privileged user. `manager/firestore.rules` gates **34 distinct
  // permissions** across 42 collection rules (measured 2026-09-05, not 32 as
  // this comment previously said); only the feed's narrower scope keeps this
  // under 30, and every new actor-carrying collection spends one of the 8 spare.
  //
  // ⚠️ That 34 is NOT asserted here, deliberately — it lives in another repo, so
  // a ratchet on it from `core` would go red on a `manager` edit with no way to
  // fix it from this side. It is a measured aside; the ASSERTED number is the
  // feed's own 22 below.
  //
  // 23 collections, 22 permissions: `templates` and `template-components` both
  // map to `templates.read`.
  assertEquals(FEED_COLLECTIONS.length, 23, "feed collections");
  assertEquals(ACTIVITY_FEED_PERMISSIONS.length, 22, "distinct feed permissions");
  assertEquals(
    ACTIVITY_FEED_PERMISSIONS.length <= 30,
    true,
    "over Firestore's `in` cap — the feed is now broken for admins",
  );

  // Derived, so it cannot disagree with the map; deduped, so an `in` array never
  // carries a repeat.
  assertEquals(
    new Set(ACTIVITY_FEED_PERMISSIONS).size,
    ACTIVITY_FEED_PERMISSIONS.length,
    "duplicates in the `in` array",
  );
  assertEquals(
    new Set(ACTIVITY_FEED_PERMISSIONS),
    new Set(Object.values(ACTIVITY_READ_PERMISSION_BY_COLLECTION)),
  );
});

Deno.test("activityFeedPermissionsFor returns the exact INTERSECTION", () => {
  // 🔴 Over-asking by one unheld value denies the WHOLE page — rules are not
  // filters — so the returned array must never contain something the holder
  // lacks. That is the arm that matters; the rest is shape.
  const held: Permission[] = ["orders.read", "invoices.read", "products.read"];
  assertEquals(new Set(activityFeedPermissionsFor(held)), new Set(held));

  // A permission held but OUTSIDE the feed is dropped — asking for it would be
  // the over-ask that denies the page.
  const withOutsider = activityFeedPermissionsFor([...held, "users.assignRoles"]);
  assertEquals(new Set(withOutsider), new Set(held));

  // A holder of NONE gets an empty array, which the caller must read as "render
  // the empty state" — the SDK refuses an empty `in`, so issuing the query is
  // the bug this return value exists to make visible.
  assertEquals(activityFeedPermissionsFor([]), []);
  assertEquals(activityFeedPermissionsFor(["users.assignRoles"]), []);

  // An admin holding everything gets exactly the feed's universe back, in the
  // map's own order — the case the `in` cap binds on.
  assertEquals(activityFeedPermissionsFor(PERMISSIONS), [...ACTIVITY_FEED_PERMISSIONS]);

  // A Set is accepted as-is (the manager holds `user().permissions` as one) and
  // agrees with the array form.
  assertEquals(activityFeedPermissionsFor(new Set(held)), activityFeedPermissionsFor(held));
});
