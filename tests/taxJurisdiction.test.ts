/**
 * The `(jurisdiction × item type)` tax rule — `findTaxFor`, `deriveJurisdiction`
 * and the Phase-1 `applied_* ?? valid_*` dual-read (api-cloudrun#409).
 *
 * Kept out of `taxes.test.ts` because that file is the *profile*-axis suite and
 * Phase 2 deletes most of it; these assertions outlive it.
 */
import { assertEquals, assertThrows } from "@std/assert";
import { deriveJurisdiction, findTaxAt, findTaxFor, resolveJurisdiction, taxAppliedWindow } from "../src/utils/taxes.ts";
import type { Tax } from "../src/utils/orders.ts";

/**
 * The catalog as the Phase-1′ migration leaves it: `applied_*` populated,
 * `valid_*` still present, `item_types` set from the RULE rather than from the
 * corpus (there are no taxed services, and prod's are frozen mistakes).
 */
const CATALOG: Tax[] = [
  {
    uid: "chi-rental-v3",
    name: "Chicago Rental Tax",
    rate: 15,
    type: "percent",
    jurisdiction: "chicago",
    item_types: ["rental"],
    valid_from: "2026-01-01T00:00:00.000-06:00",
    valid_to: null,
    applied_from: "2026-01-01T00:00:00.000-06:00",
    applied_to: null,
  },
  {
    uid: "chi-rental-v2",
    name: "Chicago Rental Tax",
    rate: 11,
    type: "percent",
    jurisdiction: "chicago",
    item_types: ["rental"],
    valid_from: "2025-01-01T00:00:00.000-06:00",
    valid_to: "2026-01-01T00:00:00.000-06:00",
    applied_from: "2025-01-01T00:00:00.000-06:00",
    applied_to: "2026-01-01T00:00:00.000-06:00",
  },
  {
    uid: "chi-sales",
    name: "Chicago Sales Tax",
    rate: 10.25,
    type: "percent",
    jurisdiction: "chicago",
    item_types: ["sale", "replacement"],
    valid_from: "2020-01-01T00:00:00.000-06:00",
    valid_to: null,
    applied_from: "2020-01-01T00:00:00.000-06:00",
    applied_to: null,
  },
  {
    // No rental-vs-sales split outside Chicago — one tax covers every taxed
    // type, which is what the old `overrideItemTaxesForProfile` did by hand.
    uid: "rantoul",
    name: "Rantoul Sales Tax",
    rate: 9,
    type: "percent",
    jurisdiction: "rantoul",
    item_types: ["rental", "sale", "replacement"],
    valid_from: "2026-01-01T00:00:00.000-06:00",
    valid_to: null,
    applied_from: "2026-01-01T00:00:00.000-06:00",
    applied_to: null,
  },
  {
    uid: "frankfort",
    name: "Frankfort Sales Tax",
    rate: 8,
    type: "percent",
    jurisdiction: "frankfort",
    item_types: ["rental", "sale", "replacement"],
    valid_from: "2026-01-01T00:00:00.000-06:00",
    valid_to: null,
    applied_from: "2026-01-01T00:00:00.000-06:00",
    applied_to: null,
  },
  {
    // The explicit-only class: reachable by uid, never by the rule.
    uid: "bottle",
    name: "Water Bottle Tax",
    rate: 0.05,
    type: "flat",
    jurisdiction: null,
    item_types: [],
    valid_from: "2026-03-27T00:00:00.000-05:00",
    valid_to: null,
    applied_from: "2026-03-27T00:00:00.000-05:00",
    applied_to: null,
  },
  {
    uid: "no-tax",
    name: "No Tax",
    rate: 0,
    type: "percent",
    jurisdiction: null,
    item_types: [],
    valid_from: "2026-03-27T00:00:00.000-05:00",
    valid_to: null,
    applied_from: "2026-03-27T00:00:00.000-05:00",
    applied_to: null,
  },
];

const NOW = "2026-08-18T12:00:00.000-05:00";

// ── findTaxFor: the jurisdiction × item-type grid ─────────────────

Deno.test("findTaxFor: Chicago splits rental from sale, and each resolves alone", () => {
  assertEquals(findTaxFor(CATALOG, "chicago", "rental", NOW)?.uid, "chi-rental-v3");
  assertEquals(findTaxFor(CATALOG, "chicago", "sale", NOW)?.uid, "chi-sales");
  assertEquals(findTaxFor(CATALOG, "chicago", "replacement", NOW)?.uid, "chi-sales");
});

Deno.test("findTaxFor: Rantoul and Frankfort have NO rental/sales split", () => {
  for (const type of ["rental", "sale", "replacement"]) {
    assertEquals(findTaxFor(CATALOG, "rantoul", type, NOW)?.uid, "rantoul", type);
    assertEquals(findTaxFor(CATALOG, "frankfort", type, NOW)?.uid, "frankfort", type);
  }
});

Deno.test("findTaxFor: a type no tax lists is untaxed — that is the WHOLE rule", () => {
  // No second gate names these. They are untaxed because no tax's `item_types`
  // mentions them, which is what makes the COA gate redundant.
  for (const jurisdiction of ["chicago", "rantoul", "frankfort"] as const) {
    assertEquals(findTaxFor(CATALOG, jurisdiction, "service", NOW), null, jurisdiction);
    assertEquals(findTaxFor(CATALOG, jurisdiction, "surcharge", NOW), null, jurisdiction);
    assertEquals(
      findTaxFor(CATALOG, jurisdiction, "transaction_fee", NOW),
      null,
      jurisdiction,
    );
  }
});

Deno.test("findTaxFor: a null jurisdiction ARGUMENT is no-nexus, not a wildcard", () => {
  // Out of state. Answered without consulting the catalog at all — so it cannot
  // accidentally match the explicit-only docs, which also carry `null`.
  assertEquals(findTaxFor(CATALOG, null, "rental", NOW), null);
  assertEquals(findTaxFor(CATALOG, null, "sale", NOW), null);
});

Deno.test("findTaxFor: the explicit-only class is SKIPPED, never matched", () => {
  // The live hazard: reading a `null` on the DOCUMENT as "applies everywhere"
  // would attach a $0.05/unit bottle tax to every line in the corpus.
  for (const jurisdiction of ["chicago", "rantoul", "frankfort", "paxton"] as const) {
    for (const type of ["rental", "sale", "replacement", "service"]) {
      const hit = findTaxFor(CATALOG, jurisdiction, type, NOW);
      assertEquals(hit?.uid === "bottle", false, `${jurisdiction}/${type} matched the bottle tax`);
      assertEquals(hit?.uid === "no-tax", false, `${jurisdiction}/${type} matched No Tax`);
    }
  }
});

Deno.test("findTaxFor: a jurisdiction with no catalog entry is untaxed, not a throw", () => {
  // `paxton` is a live enum member with its window closed; nothing covers it.
  assertEquals(findTaxFor(CATALOG, "paxton", "rental", NOW), null);
});

Deno.test("findTaxFor: resolves the version live at asOf, not the newest", () => {
  const mid2025 = "2025-06-01T00:00:00.000-05:00";
  assertEquals(findTaxFor(CATALOG, "chicago", "rental", mid2025)?.rate, 11);
  assertEquals(findTaxFor(CATALOG, "chicago", "rental", NOW)?.rate, 15);
});

Deno.test("findTaxFor: the window is half-open — the boundary instant is the SUCCESSOR's", () => {
  const boundary = "2026-01-01T00:00:00.000-06:00";
  const oneMsBefore = new Date(new Date(boundary).getTime() - 1).toISOString();
  assertEquals(findTaxFor(CATALOG, "chicago", "rental", boundary)?.rate, 15);
  assertEquals(findTaxFor(CATALOG, "chicago", "rental", oneMsBefore)?.rate, 11);
});

Deno.test("findTaxFor: Rantoul either side of its 2026-01-01 open", () => {
  assertEquals(findTaxFor(CATALOG, "rantoul", "rental", "2025-12-31T23:00:00.000-06:00"), null);
  assertEquals(
    findTaxFor(CATALOG, "rantoul", "rental", "2026-01-01T00:00:00.000-06:00")?.uid,
    "rantoul",
  );
});

Deno.test("findTaxFor: two taxes covering one (jurisdiction, type, instant) THROWS", () => {
  // No correct silent resolution exists — picking either bills a number nobody
  // chose. Same posture as `findTaxAt`'s same-name drift.
  const drifted: Tax[] = [
    ...CATALOG,
    {
      uid: "chi-rental-dup",
      name: "Chicago Rental Tax (duplicate)",
      rate: 12,
      type: "percent",
      jurisdiction: "chicago",
      item_types: ["rental"],
      applied_from: "2026-01-01T00:00:00.000-06:00",
      applied_to: null,
    },
  ];
  assertThrows(
    () => findTaxFor(drifted, "chicago", "rental", NOW),
    Error,
    "Tax catalog drift",
  );
});

Deno.test("findTaxFor: a tax with NO item_types matches nothing", () => {
  // The half-migrated shape. It must be inert rather than a wildcard.
  const halfMigrated: Tax[] = [{
    uid: "half",
    name: "Half Migrated",
    rate: 5,
    type: "percent",
    jurisdiction: "chicago",
    applied_from: "2020-01-01T00:00:00.000-06:00",
    applied_to: null,
  }];
  assertEquals(findTaxFor(halfMigrated, "chicago", "rental", NOW), null);
});

// ── The Phase-1 dual-read ────────────────────────────────────────

Deno.test("taxAppliedWindow: prefers applied_*, falls back to valid_*", () => {
  assertEquals(
    taxAppliedWindow({
      uid: "x",
      name: "X",
      rate: 1,
      type: "percent",
      valid_from: "2020-01-01T00:00:00.000-06:00",
      valid_to: "2021-01-01T00:00:00.000-06:00",
      applied_from: "2025-01-01T00:00:00.000-06:00",
      applied_to: "2026-01-01T00:00:00.000-06:00",
    }),
    { from: "2025-01-01T00:00:00.000-06:00", to: "2026-01-01T00:00:00.000-06:00" },
  );

  // An UNMIGRATED document — the whole reason the fallback exists.
  assertEquals(
    taxAppliedWindow({
      uid: "x",
      name: "X",
      rate: 1,
      type: "percent",
      valid_from: "2020-01-01T00:00:00.000-06:00",
      valid_to: "2021-01-01T00:00:00.000-06:00",
    }),
    { from: "2020-01-01T00:00:00.000-06:00", to: "2021-01-01T00:00:00.000-06:00" },
  );
});

Deno.test("taxAppliedWindow: an EXPLICIT applied_to: null is open-ended, not a fallback", () => {
  // The asymmetry. `null` is a real value on `applied_to` (open-ended), so it
  // must not fall through to a stale `valid_to` and re-close a window the
  // supersede deliberately opened.
  assertEquals(
    taxAppliedWindow({
      uid: "x",
      name: "X",
      rate: 1,
      type: "percent",
      valid_to: "2021-01-01T00:00:00.000-06:00",
      applied_from: "2025-01-01T00:00:00.000-06:00",
      applied_to: null,
    }).to,
    null,
  );
});

Deno.test("findTaxAt reads an UNMIGRATED catalog identically to a migrated one", () => {
  // This is the deploy-then-migrate window in one assertion. Without the
  // fallback the unmigrated arm has no bounds at all, so BOTH Chicago Rental
  // versions bracket every instant and it throws `Tax catalog drift` — on the
  // pricing path, out of a CRMS task handler, retrying forever.
  const unmigrated: Tax[] = CATALOG.map(({ applied_from: _f, applied_to: _t, ...rest }) => rest);
  for (const asOf of [NOW, "2025-06-01T00:00:00.000-05:00"]) {
    assertEquals(
      findTaxAt(unmigrated, "Chicago Rental Tax", asOf)?.uid,
      findTaxAt(CATALOG, "Chicago Rental Tax", asOf)?.uid,
      asOf,
    );
  }
});

// ── deriveJurisdiction: three cases, three legal reasons ─────────

const ORIGIN = "chicago" as const;

Deno.test("deriveJurisdiction: out of state is NEXUS — the no_nexus VALUE, not null", () => {
  // `null` would mean "I assert nothing, ask the next level", and this is the
  // last level — it has nobody to ask. Returning the value is what lets the
  // whole precedence be a plain `??` and what makes the answer authorable as
  // an override at any level above.
  assertEquals(
    deriveJurisdiction({ city: "Los Angeles", region: "CA" }, ORIGIN),
    "no_nexus",
  );
  assertEquals(deriveJurisdiction({ city: "Austin", region: "Texas" }, ORIGIN), "no_nexus");
});

Deno.test("deriveJurisdiction is TOTAL — no address resolves to null", () => {
  // Every path returns a jurisdiction: an unresolvable region falls to case 3,
  // and so does a missing city. A caller never has to decide what a null means.
  assertEquals(deriveJurisdiction(null, ORIGIN), ORIGIN);
  assertEquals(deriveJurisdiction(undefined, ORIGIN), ORIGIN);
  assertEquals(deriveJurisdiction({}, ORIGIN), ORIGIN);
  assertEquals(deriveJurisdiction({ city: "", region: "" }, ORIGIN), ORIGIN);
});

Deno.test("deriveJurisdiction: a collecting Illinois city is DESTINATION sourcing", () => {
  assertEquals(deriveJurisdiction({ city: "Chicago", region: "IL" }, ORIGIN), "chicago");
  assertEquals(deriveJurisdiction({ city: "Rantoul", region: "IL" }, ORIGIN), "rantoul");
  assertEquals(deriveJurisdiction({ city: "Frankfort", region: "IL" }, ORIGIN), "frankfort");
});

Deno.test("deriveJurisdiction: another Illinois municipality is ORIGIN sourcing, not untaxed", () => {
  // The case that looks like a default and is not. Merging it with the
  // out-of-state case above untaxes every non-Chicago Illinois delivery.
  assertEquals(deriveJurisdiction({ city: "Naperville", region: "IL" }, ORIGIN), "chicago");
  assertEquals(deriveJurisdiction({ city: "Evanston", region: "IL" }, "rantoul"), "rantoul");
});

Deno.test("deriveJurisdiction: the city matches EXACTLY, never by prefix", () => {
  // Distinct Illinois municipalities with their own rates. A `startsWith` bills
  // both at the collecting city's rate.
  assertEquals(deriveJurisdiction({ city: "Chicago Heights", region: "IL" }, "rantoul"), "rantoul");
  assertEquals(deriveJurisdiction({ city: "West Frankfort", region: "IL" }, "rantoul"), "rantoul");
  assertEquals(deriveJurisdiction({ city: "North Chicago", region: "IL" }, "rantoul"), "rantoul");
});

Deno.test("deriveJurisdiction: matching is case- and whitespace-insensitive", () => {
  assertEquals(deriveJurisdiction({ city: "  chicago ", region: "IL" }, "rantoul"), "chicago");
  assertEquals(deriveJurisdiction({ city: "CHICAGO", region: "IL" }, "rantoul"), "chicago");
});

Deno.test('deriveJurisdiction: "Illinois" spelled out resolves like "IL"', () => {
  // 18 of 48 non-"IL" prod destinations are Illinois spelled long, 13 in
  // Chicago. `usState()` canonicalizes; this pins that it reaches here.
  assertEquals(deriveJurisdiction({ city: "Chicago", region: "Illinois" }, "rantoul"), "chicago");
});

Deno.test("deriveJurisdiction: an UNRESOLVABLE region sources to origin, never to null", () => {
  // `toUsStateCode` returns null for UNKNOWN, never for "not Illinois".
  // Reading unknown as out-of-state under-collects, which is the expensive error.
  assertEquals(deriveJurisdiction({ city: "Chicago", region: "" }, ORIGIN), "chicago");
  assertEquals(deriveJurisdiction({ city: "Somewhere", region: "" }, ORIGIN), "chicago");
  assertEquals(deriveJurisdiction({ city: "Somewhere", region: "Xanadu" }, ORIGIN), "chicago");
  assertEquals(deriveJurisdiction(null, ORIGIN), "chicago");
  assertEquals(deriveJurisdiction(undefined, "rantoul"), "rantoul");
});

Deno.test("deriveJurisdiction: paxton is never DERIVED, though it stays a member", () => {
  // Closed, not erased: one prod order and one invoice embed the Paxton tax uid.
  assertEquals(deriveJurisdiction({ city: "Paxton", region: "IL" }, ORIGIN), "chicago");
});

Deno.test("deriveJurisdiction: origin is a PARAMETER — a second store changes every case-3 answer", () => {
  // Named rather than defaulted so this is visible. If CFS opened a Rantoul
  // store, every non-collecting Illinois delivery from it sources to Rantoul.
  const naperville = { city: "Naperville", region: "IL" };
  assertEquals(deriveJurisdiction(naperville, "chicago"), "chicago");
  assertEquals(deriveJurisdiction(naperville, "frankfort"), "frankfort");
  // ...but a collecting city still wins over the origin.
  assertEquals(deriveJurisdiction({ city: "Chicago", region: "IL" }, "frankfort"), "chicago");
  // ...and out-of-state still beats both.
  assertEquals(deriveJurisdiction({ city: "Reno", region: "NV" }, "frankfort"), "no_nexus");
});

// ── resolveJurisdiction: the four levels ─────────────────────────

const CHICAGO_ADDRESS = { city: "Chicago", region: "IL" };
const CALIFORNIA_ADDRESS = { city: "Los Angeles", region: "CA" };

Deno.test("resolveJurisdiction: the document's own entry wins over everything", () => {
  assertEquals(
    resolveJurisdiction({
      documentDestination: "rantoul",
      organization: "frankfort",
      destination: "chicago",
      address: CHICAGO_ADDRESS,
      origin: "chicago",
    }),
    { jurisdiction: "rantoul", level: "document" },
  );
});

Deno.test("resolveJurisdiction: the ORGANIZATION claim outranks the shared address master", () => {
  // The reversal measured on prod: 1 of 459 masters carries a jurisdiction (the
  // CFS warehouse) and ranking masters higher defeated the org claim on all 8
  // repriceable jurisdiction-bearing orders. An override a shared address can
  // beat is not an override.
  assertEquals(
    resolveJurisdiction({
      organization: "frankfort",
      destination: "chicago",
      address: CHICAGO_ADDRESS,
      origin: "chicago",
    }),
    { jurisdiction: "frankfort", level: "organization" },
  );
});

Deno.test("resolveJurisdiction: the master still beats the DERIVATION", () => {
  // The case the geocode warning is about — prod's own warehouse geocodes to
  // "Palos Township / 60480".
  assertEquals(
    resolveJurisdiction({ destination: "rantoul", address: CHICAGO_ADDRESS, origin: "chicago" }),
    { jurisdiction: "rantoul", level: "destination" },
  );
});

Deno.test("resolveJurisdiction: null and absent both mean ASK THE NEXT LEVEL", () => {
  // The whole reason `no_nexus` exists as a value: with `null` spelling both
  // "no jurisdiction" and "no opinion", a stored no-jurisdiction fell through
  // and an out-of-state delivery for a Frankfort-claim customer resolved
  // `frankfort` — over-collection on a customer CFS has no nexus with.
  const viaNull = resolveJurisdiction({
    documentDestination: null,
    organization: null,
    destination: null,
    address: CHICAGO_ADDRESS,
    origin: "chicago",
  });
  const viaAbsent = resolveJurisdiction({ address: CHICAGO_ADDRESS, origin: "chicago" });
  assertEquals(viaNull, { jurisdiction: "chicago", level: "derived" });
  assertEquals(viaAbsent, viaNull);
});

Deno.test("resolveJurisdiction: no_nexus is an ANSWER and STOPS the chain", () => {
  // Authored at level 1 over a Frankfort-claim customer: a genuine out-of-state
  // one-off. Under the old `null` spelling this was inexpressible.
  assertEquals(
    resolveJurisdiction({
      documentDestination: "no_nexus",
      organization: "frankfort",
      address: CHICAGO_ADDRESS,
      origin: "chicago",
    }),
    { jurisdiction: "no_nexus", level: "document" },
  );
  // And derived, for an address that is plainly out of state.
  assertEquals(
    resolveJurisdiction({ address: CALIFORNIA_ADDRESS, origin: "chicago" }),
    { jurisdiction: "no_nexus", level: "derived" },
  );
});

Deno.test("resolveJurisdiction: no_nexus resolves to NO TAX, and is not an exemption", () => {
  // The jurisdiction axis zeroes the tax by matching nothing in the catalog —
  // exemption is the separate customer axis, and the two must stay distinct.
  assertEquals(findTaxFor(CATALOG, "no_nexus", "rental", "2026-06-01T12:00:00.000-05:00"), null);
  assertEquals(findTaxFor(CATALOG, "no_nexus", "sale", "2026-06-01T12:00:00.000-05:00"), null);
});

Deno.test("resolveJurisdiction is TOTAL — every input resolves to a jurisdiction", () => {
  // Level 4 always answers, so no caller ever has to handle "no answer".
  const resolved = resolveJurisdiction({ address: null, origin: "chicago" });
  assertEquals(resolved, { jurisdiction: "chicago", level: "derived" });
});
