/**
 * The `(jurisdiction × item type)` tax rule — `findTaxFor`, `deriveJurisdiction`
 * and the `applied_*` window (api-cloudrun#409).
 */
import { assertEquals, assertThrows } from "@std/assert";
import {
  deriveJurisdiction,
  findTaxAt,
  findTaxFor,
  isTaxLive,
  resolveJurisdiction,
  taxAppliedWindow,
  taxCellState,
} from "../src/utils/taxes.ts";
import type { Tax } from "../src/utils/orders.ts";

/**
 * The catalog as the contracted schema requires it: `applied_*` populated,
 * `item_types` set from the RULE rather than from the corpus (there are no
 * taxed services, and prod's are frozen mistakes).
 */
const CATALOG: Tax[] = [
  {
    uid: "chi-rental-v3",
    name: "Chicago Rental Tax",
    rate: 15,
    type: "percent",
    jurisdiction: "chicago",
    item_types: ["rental"],
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

// ── The applied window ───────────────────────────────────────────

Deno.test("taxAppliedWindow reads applied_* and nothing else", () => {
  assertEquals(
    taxAppliedWindow({
      uid: "x",
      name: "X",
      rate: 1,
      type: "percent",
      applied_from: "2025-01-01T00:00:00.000-06:00",
      applied_to: "2026-01-01T00:00:00.000-06:00",
    }),
    { from: "2025-01-01T00:00:00.000-06:00", to: "2026-01-01T00:00:00.000-06:00" },
  );
});

Deno.test("taxAppliedWindow: applied_to null is OPEN-ENDED", () => {
  assertEquals(
    taxAppliedWindow({
      uid: "x",
      name: "X",
      rate: 1,
      type: "percent",
      applied_from: "2025-01-01T00:00:00.000-06:00",
      applied_to: null,
    }).to,
    null,
  );
});

Deno.test("🔴 a MISSING bound reads as OPEN, which is why the schema requires it", () => {
  // The property the required-ness protects, asserted directly rather than
  // inferred from the field being required. A version with no bounds brackets
  // every instant, so both Chicago Rental versions match one instant and
  // `findTaxAt` throws `Tax catalog drift` — on the pricing path, out of a
  // CRMS task handler, retrying forever.
  //
  // `TaxSchema` cannot produce this shape any more; the structural `Tax` in
  // `utils/orders.ts` still can, and a caller assembling a catalog by hand is
  // exactly who needs to know what it costs.
  const unbounded: Tax[] = CATALOG.map(({ applied_from: _f, applied_to: _t, ...rest }) => rest);
  assertThrows(
    () => findTaxAt(unbounded, "Chicago Rental Tax", NOW),
    Error,
    "drift",
  );

  // The same catalog WITH its bounds resolves to exactly one version.
  assertEquals(findTaxAt(CATALOG, "Chicago Rental Tax", NOW)?.uid, "chi-rental-v3");
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

// ── The lifecycle: isTaxLive, and the THIRD state ────────────────
//
// `active` was a stored boolean nothing read. These arms are what replaced it:
// liveness is one clause over the window that actually prices, and an expired
// cell is distinguishable from a never-taxed one — which is the entire safety
// property of the expiry design (api-cloudrun#613/#618).

Deno.test("isTaxLive: the derived `active` is exactly the applied window", () => {
  const v3 = CATALOG.find((t) => t.uid === "chi-rental-v3")!;
  const v2 = CATALOG.find((t) => t.uid === "chi-rental-v2")!;

  assertEquals(isTaxLive(v3, NOW), true);
  assertEquals(isTaxLive(v2, NOW), false, "superseded — its window closed");
  // Half-open `[from, to)`: the successor owns the boundary instant, not both.
  assertEquals(isTaxLive(v2, "2026-01-01T00:00:00.000-06:00"), false);
  assertEquals(isTaxLive(v3, "2026-01-01T00:00:00.000-06:00"), true);
  // And it is a claim about an INSTANT, so a past date makes the old one live.
  assertEquals(isTaxLive(v2, "2025-06-01T12:00:00.000-05:00"), true);
});

Deno.test("🔴 taxCellState: a lapsed cell is `expired`, a never-taxed one is `untaxed`", () => {
  // The distinction that decides whether the pricing engine refuses. Getting it
  // wrong in either direction is fatal: `untaxed` where `expired` is true
  // silently zero-rates 70% of the tax CFS collects; `expired` where `untaxed`
  // is true refuses every service line in the corpus.
  const lapsed = CATALOG.map((t) =>
    t.uid === "chi-rental-v3"
      ? { ...t, applied_to: "2026-08-01T00:00:00.000-05:00" }
      : t
  );

  assertEquals(taxCellState(CATALOG, "chicago", "rental", NOW), "taxed");
  assertEquals(taxCellState(lapsed, "chicago", "rental", NOW), "expired");

  // No tax has EVER listed these types, so there is no lapsed version to find.
  for (const type of ["service", "surcharge"]) {
    assertEquals(taxCellState(CATALOG, "chicago", type, NOW), "untaxed", type);
    assertEquals(taxCellState(lapsed, "chicago", type, NOW), "untaxed", type);
  }
});

Deno.test("taxCellState: a supersede is `taxed` — the successor is what makes it so", () => {
  // v2 closed on 2026-01-01 and v3 opened on it. The cell never lapsed, so the
  // closed window of v2 must not read as an expiry.
  assertEquals(taxCellState(CATALOG, "chicago", "rental", NOW), "taxed");
  // …and at an instant inside v2's own window, v2 answers.
  assertEquals(taxCellState(CATALOG, "chicago", "rental", "2025-06-01T12:00:00.000-05:00"), "taxed");
});

Deno.test("taxCellState: before the first version is `untaxed`, not `expired`", () => {
  // Frankfort's earliest doc opens 2026-01-01. A 2025 order predates the
  // registration entirely — nothing lapsed, CFS simply was not collecting yet.
  assertEquals(taxCellState(CATALOG, "frankfort", "rental", "2025-06-01T12:00:00.000-05:00"), "untaxed");
});

Deno.test("taxCellState: no_nexus is `untaxed` — a decision, never a lapse", () => {
  // A null jurisdiction short-circuits before the catalog is consulted, so
  // there is no window to have closed.
  assertEquals(taxCellState(CATALOG, null, "rental", NOW), "untaxed");
  assertEquals(taxCellState(CATALOG, "no_nexus", "rental", NOW), "untaxed");
});

Deno.test("taxCellState: the explicit-only class is `untaxed` at every instant", () => {
  // `Water Bottle Tax` and `No Tax` carry `jurisdiction: null` + `item_types: []`
  // and are reached by uid alone, so a window on them is inert — which is why
  // the migration leaves their `applied_to` open-ended.
  const expiredBottle = CATALOG.map((t) =>
    t.uid === "bottle" ? { ...t, applied_to: "2026-01-01T00:00:00.000-06:00" } : t
  );
  assertEquals(taxCellState(expiredBottle, "chicago", "rental", NOW), "taxed");
  assertEquals(taxCellState(expiredBottle, "chicago", "sale", NOW), "taxed");
});
