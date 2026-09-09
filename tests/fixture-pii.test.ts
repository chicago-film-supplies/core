/**
 * The fixture-PII router, the fakes, and the ORACLE that judges them.
 *
 * ⚠️ **The round-trip arm below is a FIXED-POINT check and cannot stand alone.**
 * "Every value `fakeForMask` produces, `maskVerdict` accepts" is satisfied by an
 * oracle and a masker that are wrong in the same way — it is the exact shape
 * that once certified 79 provably-wrong items as clean. So it is paired with
 * arms fed values the masker never produced: real venue names, real addresses,
 * real operator free text, and the two synthetic fixtures' own strings. Those
 * are what make a passing round trip mean anything.
 */
import { assert, assertEquals } from "@std/assert";
import { z } from "zod";
import {
  allocateOrganizationFakes,
  categoryForField,
  collectMaskedLeaves,
  FAKE_FIRST_NAMES,
  FAKE_LAST_NAMES,
  FAKE_ORGANIZATIONS,
  FAKE_PLACES,
  fakeForMask,
  type MaskCategory,
  maskVerdict,
  normalizeFieldPath,
} from "../src/utils/fixture-pii.ts";

/** A stand-in for the service's HMAC. Hex, which is all `fakeForMask` assumes. */
function seedOf(fieldPath: string, value: string, n = 0): string {
  let h = 0x811c9dc5 ^ n;
  for (const s of `${fieldPath}::${value}`) {
    h = Math.imul(h ^ s.codePointAt(0)!, 0x01000193) >>> 0;
  }
  let out = "";
  for (let i = 0; i < 8; i++) {
    h = Math.imul(h ^ (h >>> 15), 0x2545f491) >>> 0;
    out += h.toString(16).padStart(8, "0");
  }
  return out;
}
const seedFor = (p: string, v: string) => seedOf(p, v);
const mask = (path: string, value: string, n = 0) =>
  fakeForMask(value, path, seedOf(path, value, n), seedFor);

/** One representative field path per category, so an arm can name a category
 *  and get a path that really routes to it. Asserted below, not assumed. */
const PATH_FOR: Record<MaskCategory, string> = {
  email: "contact.email",
  phone: "contact.phone",
  postcode: "address.postcode",
  street: "address.street",
  street2: "address.street2",
  address_full: "address.full",
  person: "contact.name",
  given_name: "contact.first_name",
  family_name: "contact.last_name",
  place: "address.name",
  organization: "organization.name",
  opaque: "address.mapbox_id",
  text: "subject",
};

Deno.test("every category has a path that really routes to it", () => {
  for (const [category, path] of Object.entries(PATH_FOR)) {
    assertEquals(categoryForField(path), category, `${path} does not route to ${category}`);
  }
});

// ── The round trip (fixed point — see the header) ───────────────────

Deno.test("round trip: no fakeForMask output is ever judged not-masked", () => {
  // Real-ish sources, so the shape-preserving categories get real shapes.
  const sources = [
    "alice@example.com",
    "+1 (312) 555-0199",
    "60608",
    "M5V 3A8",
    "2621 W 15th Pl",
    "Suite 1900",
    "2621 W 15th Pl, Chicago, IL 60608, United States",
    "Dana Ruiz",
    "Dana",
    "Ruiz",
    "Navy Pier",
    "Lakeshore Stage Company",
    "poi.9223372036854775807",
    "10 Cases Water",
  ];
  let checked = 0;
  for (const path of Object.values(PATH_FOR)) {
    for (const source of sources) {
      for (let n = 0; n < 25; n++) {
        const out = mask(path, source, n);
        const verdict = maskVerdict(out, path);
        assert(
          verdict !== "not-masked",
          `${path} masked ${JSON.stringify(source)} to ${JSON.stringify(out)}, ` +
            `which the oracle calls not-masked — the two have drifted`,
        );
        checked++;
      }
    }
  }
  // A vacuous sweep looks exactly like a passing one.
  assertEquals(checked, Object.values(PATH_FOR).length * sources.length * 25);
});

Deno.test("round trip: a fake never returns its own source", () => {
  for (const [category, path] of Object.entries(PATH_FOR)) {
    for (const source of ["60608", "M5V 3A8", "Dana Ruiz", "Navy Pier", "poi.42"]) {
      for (let n = 0; n < 10; n++) {
        assert(
          mask(path, source, n) !== source,
          `${category} handed back its own source ${JSON.stringify(source)}`,
        );
      }
    }
  }
});

// ── The negative arms — real values the masker never produced ───────

Deno.test("real customer values are judged not-masked", () => {
  // Every one of these is a string measured in the committed fixture corpus on
  // 2026-09-06, at the path it is paired with. This arm is the whole point of
  // the guard: these are what A0 must find.
  const real: Array<[string, string]> = [
    ["address.name", "Navy Pier"],
    ["address.name", "Westside Warehouse"],
    ["address.name", "North Production Lot Stage 12"],
    ["destinations.name", "Lincoln Park"],
    ["organization.name", "Lakeshore Stage Company"],
    ["organizations.name", "Forest Glen"],
    ["address.street", "600 E Grand Ave"],
    ["address.full", "2621 W 15th Pl, Chicago, IL, United States"],
    ["contact.name", "Dana Ruiz"],
    ["contact.name", "Marcus Webb"],
    ["contact.first_name", "Dana"],
    ["contact.last_name", "Webb"],
    ["address.street2", "Suite 1900"],
    ["subject", "10 Cases Water"],
    ["subject", "Riverwalk Summer Series — lighting + tables"],
    ["notes", "2 A Frames, 2 Shotbags"],
    ["delivery.instructions", "Dock 3, east service road."],
    ["contact.email", "dana@lakeshorestage.com"],
    ["contact.phone", "(312) 867-5309"],
  ];
  for (const [path, value] of real) {
    assertEquals(
      maskVerdict(value, path),
      "not-masked",
      `${path} = ${JSON.stringify(value)} was NOT flagged`,
    );
  }
});

Deno.test("an old-masker fake in the WRONG category is still flagged", () => {
  // api-cloudrun#837: the pre-fix router chose a category from the value's
  // shape, so an organization masked to a person and a `subject` masked to a
  // street. Those values are not leaks, but they are not what this field's
  // masker produces either — and the repair is the same (re-capture), so the
  // guard is right to flag them rather than to special-case them.
  assertEquals(maskVerdict("Casey M Carmichael", "organization.name"), "not-masked");
  assertEquals(maskVerdict("1019 Aspen Dr", "subject"), "not-masked");
  assertEquals(maskVerdict("Morgan M Owen", "scope.name"), "not-masked");
});

// ── The three-valued half ───────────────────────────────────────────

Deno.test("shape-preserving categories are unverifiable, in BOTH directions", () => {
  // Neither a real value nor a fake one can be told apart — that is what
  // api-cloudrun#627 asked for, so the oracle must not claim either verdict.
  for (const real of ["60608", "M5V 3A8", "SW1A 1AA", "1010"]) {
    assertEquals(maskVerdict(real, "address.postcode"), "unverifiable");
    assertEquals(maskVerdict(mask("address.postcode", real), "address.postcode"), "unverifiable");
  }
  for (const real of ["poi.9223372036854775807", "address.abc123"]) {
    assertEquals(maskVerdict(real, "address.mapbox_id"), "unverifiable");
    assertEquals(maskVerdict(mask("address.mapbox_id", real), "address.mapbox_id"), "unverifiable");
  }
});

Deno.test("street2 is unverifiable on a MATCH and decisive on a miss", () => {
  // `Suite 210` is both a plausible fake and a plausible real value, so a match
  // proves nothing. A miss still does: every masked street2 matches by
  // construction.
  assertEquals(maskVerdict("Suite 210", "address.street2"), "unverifiable");
  assertEquals(maskVerdict("Stage 137", "address.street2"), "unverifiable");
  for (const miss of ["2nd Floor", "Center Building Mezzanine", "Suite 1900", "Ste 4"]) {
    assertEquals(maskVerdict(miss, "address.street2"), "not-masked", miss);
  }
});

// ── The filler ──────────────────────────────────────────────────────

Deno.test("the filler is accepted for EVERY category", () => {
  for (const path of Object.values(PATH_FOR)) {
    for (
      const filler of [
        "Sample text for name..............",
        "Sample text for instructions",
        "Sample text",
        "Sample",
      ]
    ) {
      assertEquals(
        maskVerdict(filler, path),
        "masked",
        `${path} rejected the filler ${JSON.stringify(filler)}`,
      );
    }
  }
});

Deno.test("a filler truncated by the pre-#837 masker is still accepted", () => {
  // Measured in `invoice/billing-foreign-country`: `notes` holds
  // `Sample text for ext`, which is `external_notes` truncated — from before
  // core renamed the field to `notes`. Matching the LIVE leaf name would report
  // a leak on the strength of a rename.
  assertEquals(maskVerdict("Sample text for ext", "notes"), "masked");
  assertEquals(maskVerdict("Sample text for ex", "notes"), "masked");
  assertEquals(maskVerdict("Sample t", "subject"), "masked");
  assertEquals(maskVerdict("Sample te", "address.name"), "masked");
});

Deno.test("a real value that merely starts with Sample is NOT the filler", () => {
  for (const real of ["Sample Kit", "Samples of the rig", "Sample Room B", "Sampling Station"]) {
    assertEquals(maskVerdict(real, "address.name"), "not-masked", real);
  }
});

Deno.test("an empty or whitespace-only value is masked (nothing to leak)", () => {
  for (const path of Object.values(PATH_FOR)) {
    assertEquals(maskVerdict("", path), "masked");
    assertEquals(maskVerdict("   ", path), "masked");
  }
});

// ── The vocabularies ────────────────────────────────────────────────

Deno.test("no place or organization fake can be read as a person's name", () => {
  // A two-word compound (`Northgate Hall`) is shaped exactly like `First Last`,
  // which is the confusion the category split exists to remove. Asserted over
  // the WHOLE vocabulary rather than over a sampled seed: a vocabulary is small
  // and enumerable, and a spot check on one entry would pass.
  const personShaped = /^[A-Z][a-z]+ [A-Z][a-z]+$/;
  for (const entry of [...FAKE_PLACES, ...FAKE_ORGANIZATIONS]) {
    assert(!personShaped.test(entry), `${entry} reads as a person's name`);
    assert(entry.trim().split(/\s+/).length >= 3, `${entry} is under the three-token floor`);
  }
  assertEquals(FAKE_PLACES.length, 16);
  // A FLOOR rather than an equality, and the asymmetry with FAKE_PLACES above is
  // deliberate. `allocateOrganizationFakes` assigns a DISTINCT fake per
  // organization in one document and THROWS on exhaustion, so this number is the
  // largest document a capture can sanitize — it is capacity, not style.
  // `fixtures/aging-report/all-accounts.json` carries 18 distinct organization
  // uids, so a cut below that is a capture OUTAGE. core#91 grew it 16 -> 40.
  assert(
    FAKE_ORGANIZATIONS.length >= 40,
    `FAKE_ORGANIZATIONS holds ${FAKE_ORGANIZATIONS.length}. The injective ` +
      `allocator needs one entry per distinct organization in a document; the ` +
      `largest committed fixture carries 18. The floor is 40 (2.2x headroom).`,
  );
});

Deno.test("no first name is also a last name", () => {
  // `fakePerson` composes one of each; an overlap would make a two-token fake
  // ambiguous to `isMaskedPerson`'s positional check.
  const last = new Set(FAKE_LAST_NAMES);
  for (const first of FAKE_FIRST_NAMES) assert(!last.has(first), `${first} is in both lists`);
});

// ── Path normalization ──────────────────────────────────────────────

Deno.test("array markers and indices normalize to the same route", () => {
  const expected = ["destinations", "delivery", "address", "postcode"];
  for (
    const spelling of [
      "destinations[].delivery.address.postcode",
      "destinations[0].delivery.address.postcode",
      "destinations.0.delivery.address.postcode",
      "destinations.delivery.address.postcode",
    ]
  ) {
    assertEquals(normalizeFieldPath(spelling), expected, spelling);
  }
});

// ── The scope: a discriminated union resolves per ROW ───────────────

Deno.test("collectMaskedLeaves resolves a union against the row, not the path", () => {
  // 🔴 This is the 292-false-finding defect. A static `collectLeafPaths` walk
  // emits every union member at the SAME path, so a path whose divider arm is
  // `pii: "mask"` scopes in the PRODUCT arm too — and every product name on a
  // packing list gets judged against the venue vocabulary.
  const Divider = z.strictObject({
    type: z.literal("divider"),
    name: z.string().meta({ pii: "mask" }),
  });
  const Product = z.strictObject({
    type: z.literal("product"),
    name: z.string().meta({ pii: "none" }),
  });
  const Doc = z.strictObject({
    items: z.array(z.discriminatedUnion("type", [Divider, Product])),
  });

  const leaves = collectMaskedLeaves(
    {
      items: [
        { type: "divider", name: "Navy Pier" },
        { type: "product", name: "Driving Sign Kit" },
      ],
    },
    Doc,
  );

  assertEquals(leaves.map((l) => l.value), ["Navy Pier"]);
  assert(
    !leaves.some((l) => l.value === "Driving Sign Kit"),
    "the product arm was scoped in — the union was not resolved per row",
  );
});

Deno.test("collectMaskedLeaves reports only string leaves", () => {
  const Doc = z.strictObject({
    coords: z.strictObject({ latitude: z.number(), longitude: z.number() })
      .meta({ pii: "mask" }),
    label: z.string().meta({ pii: "mask" }),
  });
  const leaves = collectMaskedLeaves({ coords: { latitude: 41.9, longitude: -87.6 }, label: "x" }, Doc);
  assertEquals(leaves.map((l) => l.fieldPath), ["label"]);
});

// ── The lint arm survives a document that fails the SCHEMA check ────

Deno.test("a malformed fixture does not crash the mask arm", async () => {
  // ⚠️ Check 2 runs whether or not check 1 passed, deliberately — a schema
  // failure and a PII leak are independent, and returning early on the first
  // hides the second in exactly the case where both are likeliest (a
  // hand-pasted document). So the mask arm is fed garbage by design, and a
  // guard that THROWS there takes the whole lint down and is worse than none.
  const { lintFixture } = await import("../src/utils/template-lint.ts");
  const sidecar = { collection_source: "orders", params: [], fixtures: [] };
  const malformed: unknown[] = [
    {},
    { organization: null, destinations: null, items: null },
    { organization: "a string", destinations: 42, items: "nope" },
    { organization: [1, 2, 3] },
    { items: [{ type: "nonexistent", name: "X" }] },
    { items: [{ name: "X" }] },
    { destinations: [{ delivery: null }, null] },
    { subject: 12345 },
    { items: ["a", "b"] },
  ];
  for (const doc of malformed) {
    const findings = lintFixture({
      gitPath: "quote",
      sidecar,
      fixture: { slug: "t", ok: true, doc },
    });
    // It must not throw, and it must not invent a mask finding out of garbage.
    assertEquals(
      findings.filter((f) => f.check === "pii-mask").length,
      0,
      `malformed doc produced a mask finding: ${JSON.stringify(doc)}`,
    );
  }
  // …and the arm is NOT simply inert on a well-formed-enough document.
  const real = lintFixture({
    gitPath: "quote",
    sidecar,
    fixture: { slug: "t", ok: true, doc: { subject: "Riverwalk Summer Series" } },
  });
  assertEquals(real.filter((f) => f.check === "pii-mask").length, 1);
  // 🔴 BLOCKING, not advisory — flipped 2026-09-06 once `templates` reached 0
  // `not-masked` leaves. Asserted rather than left implicit because `severity`
  // is what the manager renders on, and an accidental re-add would make a real
  // leak display as a notice.
  assertEquals(real.find((f) => f.check === "pii-mask")?.severity, undefined);
});

// ── core#91: identity, not location ─────────────────────────────────────────
//
// Each arm below fails on the PRE-core#91 masker, which is what makes them a
// regression guard rather than a restatement. The mechanism they exercise is
// `maskIdentity`: a fake is drawn on WHAT the value is, never on WHERE it sits.

Deno.test("identity: one organization uid draws ONE name at every path", () => {
  // The reported defect. `organizations[].organization_path[].name` and
  // `rows[].organization_path[].name` are different paths holding one customer,
  // and an aging report's whole job is that the summary reconciles against the
  // detail beneath it.
  const siblings = { uid: "gql6Tjro2tSVrgP5NKOH", name: "Vermillion Pictures" };
  const draw = (path: string) =>
    fakeForMask("Vermillion Pictures", path, seedFor(path, "Vermillion Pictures"), seedFor, {
      siblings,
    });

  assertEquals(draw("organizations.organization_path.name"), draw("rows.organization_path.name"));
  assertEquals(draw("organizations.organization_path.name"), draw("organization.name"));
});

Deno.test("identity: two organizations sharing a real name draw TWO names", () => {
  // The constraint pulling against the arm above, and the reason an
  // organization is identified by uid rather than by value: 24 of the 29 prod
  // department nodes are called `Locations`, `Office` or `Transpo`.
  const draw = (uid: string) =>
    fakeForMask("Office", "organizations.name", seedFor("organizations.name", "Office"), seedFor, {
      siblings: { uid, name: "Office" },
    });

  assert(draw("ORG_A") !== draw("ORG_B"), "two organizations collapsed to one fake name");
});

Deno.test("identity: one address at two paths draws ONE street", () => {
  // 23 of 26 same-uid destination leg pairs in the committed corpus masked to
  // two different streets, because `delivery.…` and `collection.…` are two
  // paths. An address is identified by its own value: two identical address
  // strings ARE one address.
  const value = "2621 W 15th Pl";
  const draw = (path: string) => fakeForMask(value, path, seedFor(path, value), seedFor);

  assertEquals(draw("delivery.address.street"), draw("collection.address.street"));

  // And two DIFFERENT addresses must still differ, or the arm above would be
  // satisfied by a constant.
  const other = "914 N Ashland Ave";
  assert(
    draw("delivery.address.street") !==
      fakeForMask(other, "delivery.address.street", seedFor("delivery.address.street", other), seedFor),
  );
});

Deno.test("discriminant: scope.name routes on its sibling kind", () => {
  assertEquals(categoryForField("scope.name", { kind: "organization" }), "organization");
  // Holds `destination.address.full` VERBATIM — routing it as an organization
  // is the `Oak Brook Mall` -> `Jordan B Holloway` failure, one field over.
  assertEquals(categoryForField("scope.name", { kind: "destination" }), "address_full");
  // By category an organization, but `scope.uid` is the ORDER's id, so there is
  // no identity to seed on and the filler is the honest answer.
  assertEquals(categoryForField("scope.name", { kind: "order" }), "text");
});

Deno.test("discriminant: an absent or unrecognised kind still falls to text", () => {
  // The safe direction, preserved. A caller predating core#91 passes no
  // siblings at all and must get exactly what it got before.
  assertEquals(categoryForField("scope.name"), "text");
  assertEquals(categoryForField("scope.name", {}), "text");
  assertEquals(categoryForField("scope.name", { kind: "something_new" }), "text");
  assertEquals(categoryForField("scope.name", { kind: 7 }), "text");
  assertEquals(categoryForField("scope.name", { kind: null }), "text");
});

Deno.test("allocator: distinct organizations get DISTINCT names", () => {
  // Identity seeding alone leaves ~3.8 expected collisions at 18-into-40.
  const uids = Array.from({ length: 18 }, (_, i) => `ORG_${i}`);
  const allocation = allocateOrganizationFakes(uids, seedFor);

  assertEquals(allocation.size, 18);
  assertEquals(new Set(allocation.values()).size, 18, "two organizations share one fake name");
  for (const name of allocation.values()) assert(FAKE_ORGANIZATIONS.includes(name));
});

Deno.test("allocator: the assignment is a function of the SET, not of document order", () => {
  // Ordered by identity seed rather than by document order, so re-ordering a
  // document reshuffles nothing and a re-capture does not churn every golden.
  const uids = Array.from({ length: 12 }, (_, i) => `ORG_${i}`);
  const forward = allocateOrganizationFakes(uids, seedFor);
  const reversed = allocateOrganizationFakes([...uids].reverse(), seedFor);

  for (const uid of uids) assertEquals(forward.get(uid), reversed.get(uid));
});

Deno.test("allocator: exhaustion THROWS rather than wrapping", () => {
  // A wrapped allocation is precisely the defect the allocator removes, and a
  // silent collision in a committed fixture is not recoverable the way a failed
  // capture is.
  const tooMany = Array.from({ length: FAKE_ORGANIZATIONS.length + 1 }, (_, i) => `ORG_${i}`);
  let threw = "";
  try {
    allocateOrganizationFakes(tooMany, seedFor);
  } catch (e) {
    threw = (e as Error).message;
  }
  assert(threw.includes("An injective"), `expected an exhaustion throw, got: ${threw || "<none>"}`);
  // The message must name the remedy AND its constraint — appending in the
  // wrong place re-seeds every entry after it.
  assert(threw.includes("END only"), "the throw does not name the append-at-the-end constraint");
});

Deno.test("re-running the masker is byte-stable", () => {
  // What keeps a re-capture from churning every golden.
  const siblings = { uid: "ORG_X", name: "Something Real Ltd" };
  const ctx = { siblings, organizationFakes: allocateOrganizationFakes(["ORG_X"], seedFor) };
  const once = fakeForMask(
    "Something Real Ltd",
    "organizations.name",
    seedFor("organizations.name", "Something Real Ltd"),
    seedFor,
    ctx,
  );
  const twice = fakeForMask(
    "Something Real Ltd",
    "organizations.name",
    seedFor("organizations.name", "Something Real Ltd"),
    seedFor,
    ctx,
  );
  assertEquals(once, twice);
  assertEquals(maskVerdict(once, "organizations.name", siblings), "masked");
});
