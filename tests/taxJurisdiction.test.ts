/**
 * The tax rule's jurisdiction half — `deriveJurisdiction` and `resolveJurisdiction`
 * (api-cloudrun#409). The name-keyed `findTaxAt` / `taxAppliedWindow` are deleted
 * (2026-09-15); rate windows are read off `taxes-rates` by the class resolver. The legacy
 * `(taxed_as ?? type) × jurisdiction` lookup and its cell states are retired
 * with the `taxes` collection (api-cloudrun#993).
 */
import { assertEquals } from "@std/assert";
import { JURISDICTIONS } from "../src/schemas/common.ts";
import {
  COLLECTING_JURISDICTIONS,
  deriveJurisdiction,
  resolveJurisdiction,
} from "../src/utils/taxes.ts";


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
      address: CHICAGO_ADDRESS,
      origin: "chicago",
    }),
    { jurisdiction: "rantoul", level: "document" },
  );
});

Deno.test("resolveJurisdiction: the ORGANIZATION claim outranks the derivation", () => {
  assertEquals(
    resolveJurisdiction({
      organization: "frankfort",
      address: CHICAGO_ADDRESS,
      origin: "chicago",
    }),
    { jurisdiction: "frankfort", level: "organization" },
  );
});

Deno.test("resolveJurisdiction: THREE levels — there is no destination-master rung", () => {
  // api-cloudrun#591. `destinations/{uid}.jurisdiction` is deleted, not merely
  // demoted: 1 of 459 documents carried one (the CFS warehouse), and that value
  // was really the store's ORIGIN, which now lives on `Store.jurisdiction`.
  // Ranked above the claim it cancelled it on all 8 repriceable
  // jurisdiction-bearing orders; ranked below it did nothing, because nothing
  // wrote it. A shared address contributes to the answer only through the
  // derivation.
  assertEquals(
    Object.keys(
      { documentDestination: null, organization: null, address: null, origin: "chicago" } satisfies
        Parameters<typeof resolveJurisdiction>[0],
    ).includes("destination"),
    false,
  );
  assertEquals(
    resolveJurisdiction({ organization: null, address: CHICAGO_ADDRESS, origin: "rantoul" }),
    { jurisdiction: "chicago", level: "derived" },
    "a collecting city still beats the origin — that is case 2, not a master",
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

Deno.test("resolveJurisdiction is TOTAL — every input resolves to a jurisdiction", () => {
  // Level 4 always answers, so no caller ever has to handle "no answer".
  const resolved = resolveJurisdiction({ address: null, origin: "chicago" });
  assertEquals(resolved, { jurisdiction: "chicago", level: "derived" });
});

// ── COLLECTING_JURISDICTIONS — the exported registration set (api-cloudrun#845) ──
//
// It is derived from the city table, so the two cannot drift by construction.
// What these pin is the SEMANTIC every consumer relies on: membership means
// "an address in this town destination-sources to it", and non-membership means
// "origin-sources to the store". api-cloudrun's IL rate watch reads exactly that.

Deno.test("COLLECTING_JURISDICTIONS: each member destination-sources to itself", () => {
  for (const j of COLLECTING_JURISDICTIONS) {
    // `no_nexus` as the origin is the one member that is never a collecting
    // city, so a town falling through to origin sourcing cannot answer with
    // the jurisdiction under test.
    assertEquals(deriveJurisdiction({ city: j.toUpperCase(), region: "IL" }, "no_nexus"), j);
  }
});

Deno.test("COLLECTING_JURISDICTIONS: a NON-member origin-sources instead", () => {
  const closed = JURISDICTIONS.filter((j) => j !== "no_nexus" && !COLLECTING_JURISDICTIONS.includes(j));
  assertEquals(closed, ["paxton"], "registration closed 2026-08-24; see api-cloudrun 2abb0025");
  for (const j of closed) {
    assertEquals(deriveJurisdiction({ city: j.toUpperCase(), region: "IL" }, "chicago"), "chicago");
  }
});

Deno.test("COLLECTING_JURISDICTIONS: no_nexus is NOT a registration", () => {
  // It is a selectable ANSWER (manager's picker offers it) and never a place
  // CFS collects in. Including it here would make an out-of-state delivery
  // read as a registration.
  assertEquals(COLLECTING_JURISDICTIONS.includes("no_nexus"), false);
});

Deno.test("COLLECTING_JURISDICTIONS: it is a SUBSET of the storage vocabulary", () => {
  // JURISDICTIONS is what a stored document may name — closed registrations
  // included, because `calculateItemTax` throws on a tax uid it cannot resolve.
  for (const j of COLLECTING_JURISDICTIONS) assertEquals(JURISDICTIONS.includes(j), true);
});
