/**
 * Tests for the extracted fixture lint (templates#195 Phase 3).
 *
 * ⭐ **Every check is asserted to FAIL on a document that should fail it, not
 * only to pass on a clean one.** A lint that cannot go red is not coverage, and
 * a fold this defensive — every sidecar field read through a structural
 * accessor that treats a wrong type as absent — has a real path to silently
 * checking nothing. The `examines what it claims` test at the bottom is the
 * guard against exactly that: it asserts the TALLIES, which is what makes a
 * vacuous run announce itself.
 */
import { assert, assertEquals } from "@std/assert";
import {
  type LintFamily,
  lintFixture,
  lintFixtureSet,
  type LintSidecar,
  MIN_DESCRIPTION,
  stringLeaves,
} from "../src/utils/template-lint.ts";

// ── Fixtures for the fixture lint ───────────────────────────────────

/** A description long enough to satisfy check 3, so other checks are what fails. */
const GOOD_DESCRIPTION =
  "Covers the multi-destination path with two delivery windows, which no other fixture renders.";

function sidecar(over: Partial<LintSidecar> = {}): LintSidecar {
  return {
    collection_source: "orders",
    params: [],
    fixtures: [],
    ...over,
  };
}

/** A minimal document that is NOT a valid order — used where schema failure is the point. */
const NOT_AN_ORDER = { nonsense: true };

function family(over: Partial<LintFamily> = {}): LintFamily {
  return {
    gitPath: "quote",
    sidecar: sidecar(),
    fixtures: [],
    goldens: [],
    ...over,
  };
}

const checksIn = (findings: { check: string }[]) => new Set(findings.map((f) => f.check));

// ── Check 1: schema ─────────────────────────────────────────────────

Deno.test("check 1 — a fixture that does not satisfy its source schema is a finding", () => {
  const findings = lintFixture({
    gitPath: "quote",
    sidecar: sidecar(),
    fixture: { slug: "bad", ok: true, doc: NOT_AN_ORDER },
  });
  assert(checksIn(findings).has("schema"), "expected a schema finding");
});

Deno.test("check 1 — an unresolvable collection_source is a finding, not a crash", () => {
  // The original shape read the schema map directly, got `undefined`, and threw
  // a bare TypeError on `.safeParse`. Guarded before use.
  const findings = lintFixture({
    gitPath: "quote",
    sidecar: sidecar({ collection_source: "not-a-collection" }),
    fixture: { slug: "x", ok: true, doc: {} },
  });
  assert(
    findings.some((f) => f.check === "schema" && f.message.includes("TEMPLATE_COLLECTION_SCHEMAS")),
    "expected an unmapped-collection finding",
  );
});

Deno.test("check 1 — a missing collection_source is a finding", () => {
  const findings = lintFixture({
    gitPath: "quote",
    sidecar: sidecar({ collection_source: undefined }),
    fixture: { slug: "x", ok: true, doc: {} },
  });
  assert(findings.some((f) => f.message.includes("collection_source")));
});

Deno.test("check 1 — `movement-sessions` RESOLVES, and that is the api-cloudrun#700 regression", () => {
  // 🔴 The whole point of `templateSchemaFor` over the Firestore collection
  // registry. A template source names a document SHAPE and need not be a
  // collection: `movement-sessions` is a fold that is stored nowhere, and an
  // `isCollectionName` guard failed CLOSED on the receipt family's very first
  // fixture — a source the API's own write path validates fine.
  //
  // Asserted by the ABSENCE of an unmapped-collection finding: the empty doc
  // still fails the schema, which is a different check and is expected.
  const findings = lintFixture({
    gitPath: "receipt",
    sidecar: sidecar({ collection_source: "movement-sessions" }),
    fixture: { slug: "x", ok: true, doc: {} },
  });
  assert(
    !findings.some((f) => f.message.includes("has no schema")),
    "movement-sessions must resolve a schema — this is the #700 failure",
  );
});

Deno.test("check 1 — unparseable JSON is a finding, and stops that fixture", () => {
  const findings = lintFixture({
    gitPath: "quote",
    sidecar: sidecar(),
    fixture: { slug: "broken", ok: false, parseError: "Unexpected token }" },
  });
  assertEquals(findings.length, 1);
  assertEquals(findings[0].check, "json");
});

// ── Check 2: PII ────────────────────────────────────────────────────

Deno.test("check 2 — a customer email is a finding; a CFS one is not", () => {
  const withCustomer = lintFixture({
    gitPath: "quote",
    sidecar: sidecar(),
    fixture: { slug: "x", ok: true, doc: { contact: { email: "jane@example.com" } } },
  });
  assert(checksIn(withCustomer).has("pii"), "a non-CFS email must be a finding");

  const withOurs = lintFixture({
    gitPath: "quote",
    sidecar: sidecar(),
    fixture: { slug: "x", ok: true, doc: { contact: { email: "ops@chicagofilmsupplies.com" } } },
  });
  assert(!checksIn(withOurs).has("pii"), "our own domain is not customer PII");
});

Deno.test("check 2 — the 555-01xx fiction block is allowed, a real number is not", () => {
  const fiction = lintFixture({
    gitPath: "quote",
    sidecar: sidecar(),
    fixture: { slug: "x", ok: true, doc: { phone: "(312) 555-0142" } },
  });
  assert(!checksIn(fiction).has("pii"), "the NANP fiction block belongs in a fixture");

  const real = lintFixture({
    gitPath: "quote",
    sidecar: sidecar(),
    fixture: { slug: "x", ok: true, doc: { phone: "(312) 664-1234" } },
  });
  assert(checksIn(real).has("pii"), "a real-looking number must be a finding");
});

Deno.test("check 2 — a ten-digit epoch is NOT a phone number", () => {
  // ⚠️ The reason the scan walks string LEAVES rather than raw text: every
  // Firestore `_seconds` epoch is exactly ten digits and `\b\d{10}\b` bites on
  // it. A numeric leaf is not a string and is never scanned.
  const findings = lintFixture({
    gitPath: "quote",
    sidecar: sidecar(),
    fixture: { slug: "x", ok: true, doc: { created_at: { _seconds: 1756944000, _nanoseconds: 0 } } },
  });
  assert(!checksIn(findings).has("pii"), "an epoch must not read as a phone number");
});

Deno.test("check 2 — a uuid is not a phone number", () => {
  const findings = lintFixture({
    gitPath: "quote",
    sidecar: sidecar(),
    fixture: { slug: "x", ok: true, doc: { uid: "1e3f5a7c-9b2d-4e6f-8a1c-3d5b7f9e2a4c" } },
  });
  assert(!checksIn(findings).has("pii"));
});

Deno.test("check 2 — PII is scanned even when the schema check already failed", () => {
  // A schema failure and a PII leak are independent. Returning early on the
  // first hides the second behind it — worst in exactly the case where both are
  // likely, a hand-pasted document.
  const findings = lintFixture({
    gitPath: "quote",
    sidecar: sidecar(),
    fixture: { slug: "x", ok: true, doc: { nonsense: true, email: "jane@example.com" } },
  });
  const checks = checksIn(findings);
  assert(checks.has("schema"), "expected the schema finding");
  assert(checks.has("pii"), "expected the PII finding ALONGSIDE it");
});

// ── Check 5a: undeclared param key ──────────────────────────────────

Deno.test("check 5a — a param key the family does not declare is a finding", () => {
  const findings = lintFixture({
    gitPath: "quote",
    sidecar: sidecar({
      params: [{ key: "hide_zero_priced_components", type: "boolean", default: false }],
      fixtures: [{ slug: "x", description: GOOD_DESCRIPTION, params: { typo_key: true } }],
    }),
    fixture: { slug: "x", ok: true, doc: NOT_AN_ORDER },
  });
  assert(checksIn(findings).has("param-declared"));
});

Deno.test("check 5a — a declared key is not a finding, and is NOT graduation-scoped", () => {
  // Unscoped on purpose: an undeclared key is a typo, and `resolveRenderParams`
  // throws on one, taking the family's whole visual-diff run with it. So it must
  // fire on a family with no goldens at all.
  const declared = lintFixture({
    gitPath: "quote",
    sidecar: sidecar({
      params: [{ key: "hide_zero_priced_components", type: "boolean" }],
      fixtures: [{ slug: "x", description: GOOD_DESCRIPTION, params: { hide_zero_priced_components: true } }],
    }),
    fixture: { slug: "x", ok: true, doc: NOT_AN_ORDER },
  });
  assert(!checksIn(declared).has("param-declared"));

  const ungraduated = lintFixtureSet({
    families: [family({
      sidecar: sidecar({
        params: [],
        fixtures: [{ slug: "x", description: GOOD_DESCRIPTION, params: { anything: true } }],
      }),
      fixtures: [{ slug: "x", ok: true, doc: NOT_AN_ORDER }],
      goldens: [], // no baseline anywhere — NOT graduated
    })],
  });
  assert(
    checksIn(ungraduated.findings).has("param-declared"),
    "5a must fire on an ungraduated family",
  );
});

// ── Check 3: the coverage argument ──────────────────────────────────

Deno.test("check 3 — a missing or placeholder description is a finding", () => {
  const missing = lintFixtureSet({
    families: [family({
      sidecar: sidecar({ fixtures: [{ slug: "x" }] }),
      fixtures: [{ slug: "x", ok: true, doc: NOT_AN_ORDER }],
    })],
  });
  assert(checksIn(missing.findings).has("description"));

  const tooShort = lintFixtureSet({
    families: [family({
      sidecar: sidecar({ fixtures: [{ slug: "x", description: "covers stuff" }] }),
      fixtures: [{ slug: "x", ok: true, doc: NOT_AN_ORDER }],
    })],
  });
  assert(checksIn(tooShort.findings).has("description"));
  assert(GOOD_DESCRIPTION.length >= MIN_DESCRIPTION, "the good description must clear the bar");
});

// ── Check: sidecar <-> file drift, BOTH directions ──────────────────

Deno.test("drift — an entry with no file, and a file with no entry, are both findings", () => {
  const entryNoFile = lintFixtureSet({
    families: [family({
      sidecar: sidecar({ fixtures: [{ slug: "ghost", description: GOOD_DESCRIPTION }] }),
      fixtures: [],
    })],
  });
  assert(
    entryNoFile.findings.some((f) => f.check === "drift" && f.message.includes("does not exist")),
  );

  const fileNoEntry = lintFixtureSet({
    families: [family({
      sidecar: sidecar({ fixtures: [] }),
      fixtures: [{ slug: "orphan", ok: true, doc: NOT_AN_ORDER }],
    })],
  });
  assert(
    fileNoEntry.findings.some((f) => f.check === "drift" && f.message.includes("not listed")),
  );
});

// ── Check 4: golden parity ──────────────────────────────────────────

Deno.test("check 4 — on a GRADUATED family, a fixture with no baseline is a finding", () => {
  const report = lintFixtureSet({
    families: [family({
      sidecar: sidecar({
        fixtures: [
          { slug: "covered", description: GOOD_DESCRIPTION },
          { slug: "ungated", description: GOOD_DESCRIPTION },
        ],
      }),
      fixtures: [
        { slug: "covered", ok: true, doc: NOT_AN_ORDER },
        { slug: "ungated", ok: true, doc: NOT_AN_ORDER },
      ],
      goldens: [{ branch: "main", slugs: ["covered"] }],
    })],
  });
  assert(
    report.findings.some((f) => f.check === "golden-parity" && f.message.includes("missing")),
  );
});

Deno.test("check 4 — an orphaned baseline is a finding", () => {
  const report = lintFixtureSet({
    families: [family({
      sidecar: sidecar({ fixtures: [{ slug: "live", description: GOOD_DESCRIPTION }] }),
      fixtures: [{ slug: "live", ok: true, doc: NOT_AN_ORDER }],
      goldens: [{ branch: "main", slugs: ["live", "renamed-away"] }],
    })],
  });
  assert(
    report.findings.some((f) => f.check === "golden-parity" && f.message.includes("orphaned")),
  );
});

Deno.test("check 4 — an UNGRADUATED family is silent, and an empty tree is not a graduation", () => {
  // This is what keeps the empty `goldens/sandbox/` quiet (templates#118)
  // without the check knowing anything about which branch is which.
  const report = lintFixtureSet({
    families: [family({
      sidecar: sidecar({ fixtures: [{ slug: "x", description: GOOD_DESCRIPTION }] }),
      fixtures: [{ slug: "x", ok: true, doc: NOT_AN_ORDER }],
      goldens: [{ branch: "sandbox", slugs: [] }],
    })],
  });
  assert(!checksIn(report.findings).has("golden-parity"));
  assertEquals(report.tally.goldenTrees, [], "an empty tree must not count as compared");
});

// ── Check 4b: the render-frame goldens ──────────────────────────────
//
// ⭐ **The load-bearing test is the SILENCE one**, not the two findings. Every
// registered family declares a `render.footer` and none had a baseline for it
// when this arm shipped, so a rule keyed on the declaration would have reddened
// `templates-lint` — required on `main` — for every family at once. The
// no-baselines case is the assertion that it did not.

/** A family whose sidecar declares the shared footer frame. */
function footerFamily(over: Partial<LintFamily> = {}): LintFamily {
  return family({
    sidecar: sidecar({
      fixtures: [{ slug: "live", description: GOOD_DESCRIPTION }],
      render: { footer: "partials/shared/footer.eta" },
    }),
    fixtures: [{ slug: "live", ok: true, doc: NOT_AN_ORDER }],
    ...over,
  });
}

Deno.test("check 4b — a declared frame with NO baseline anywhere is silent", () => {
  const report = lintFixtureSet({
    families: [footerFamily({ goldens: [{ branch: "main", slugs: ["live"] }] })],
  });
  assertEquals(
    report.findings.filter((f) => f.check === "golden-parity"),
    [],
    "a family that has graduated its FIXTURES but not its FRAMES must stay quiet",
  );
});

Deno.test("check 4b — a frame baseline is NOT read as an orphaned fixture", () => {
  // The partition. Without it `_footer` falls through to the fixture arm, which
  // has no fixture file of that name to match it against — there is none, and
  // the reserved-slug arm below is what keeps it that way.
  const report = lintFixtureSet({
    families: [footerFamily({
      goldens: [{ branch: "main", slugs: ["live", "_footer"] }],
    })],
  });
  assertEquals(report.findings.filter((f) => f.check === "golden-parity"), []);
});

Deno.test("check 4b — once a frame baseline exists, a MISSING one is a finding", () => {
  const report = lintFixtureSet({
    families: [footerFamily({
      sidecar: sidecar({
        fixtures: [{ slug: "live", description: GOOD_DESCRIPTION }],
        render: { footer: "partials/shared/footer.eta", header: "partials/quote/header.eta" },
      }),
      goldens: [{ branch: "main", slugs: ["live", "_footer"] }],
    })],
  });
  const missing = report.findings.filter((f) =>
    f.check === "golden-parity" && f.message.includes("missing")
  );
  assertEquals(missing.length, 1);
  assertEquals(missing[0].file, "goldens/main/quote/_header.png");
});

Deno.test("check 4b — a baseline for a frame the sidecar no longer declares is orphaned", () => {
  const report = lintFixtureSet({
    families: [family({
      sidecar: sidecar({ fixtures: [{ slug: "live", description: GOOD_DESCRIPTION }] }),
      fixtures: [{ slug: "live", ok: true, doc: NOT_AN_ORDER }],
      goldens: [{ branch: "main", slugs: ["live", "_footer"] }],
    })],
  });
  const orphaned = report.findings.filter((f) =>
    f.check === "golden-parity" && f.message.includes("orphaned")
  );
  assertEquals(orphaned.length, 1);
  assertEquals(orphaned[0].file, "goldens/main/quote/_footer.png");
});

Deno.test("check 4b — the frame guard is PER TREE, like the fixture arms", () => {
  // `main` blessed, `sandbox` mid-bless. Saying "missing" on `sandbox` would be
  // reporting the press that is in flight.
  const report = lintFixtureSet({
    families: [footerFamily({
      goldens: [
        { branch: "main", slugs: ["live", "_footer"] },
        { branch: "sandbox", slugs: ["live"] },
      ],
    })],
  });
  assertEquals(report.findings.filter((f) => f.check === "golden-parity"), []);
});

Deno.test("check 4b — an EMPTY frame key is not a declaration", () => {
  // `extractRenderConfig` resolves the key out of the content map, so a blank
  // one can never produce a frame. Asking for its baseline would be asking for
  // a golden of something that does not render.
  const report = lintFixtureSet({
    families: [footerFamily({
      sidecar: sidecar({
        fixtures: [{ slug: "live", description: GOOD_DESCRIPTION }],
        render: { footer: "" },
      }),
      goldens: [{ branch: "main", slugs: ["live", "_footer"] }],
    })],
  });
  const orphaned = report.findings.filter((f) => f.check === "golden-parity");
  assertEquals(orphaned.length, 1);
  assert(orphaned[0].message.includes("orphaned"));
});

Deno.test("check 4b — a fixture may not take a frame's reserved slug", () => {
  const report = lintFixtureSet({
    families: [family({
      sidecar: sidecar({
        fixtures: [{ slug: "_footer", description: GOOD_DESCRIPTION }],
        render: { footer: "partials/shared/footer.eta" },
      }),
      fixtures: [{ slug: "_footer", ok: true, doc: NOT_AN_ORDER }],
    })],
  });
  assert(
    report.findings.some((f) =>
      f.check === "golden-parity" && f.message.includes("reserved golden slug")
    ),
  );
});

// ── Check 5b: param coverage ────────────────────────────────────────

Deno.test("check 5b — a declared boolean param with only one state rendered is a finding", () => {
  const report = lintFixtureSet({
    families: [family({
      sidecar: sidecar({
        params: [{ key: "hide_zero_priced_components", type: "boolean", default: false }],
        fixtures: [{ slug: "x", description: GOOD_DESCRIPTION }],
      }),
      fixtures: [{ slug: "x", ok: true, doc: NOT_AN_ORDER }],
      goldens: [{ branch: "main", slugs: ["x"] }],
    })],
  });
  assert(
    report.findings.some((f) => f.check === "param-coverage" && f.message.includes("true")),
    "the un-rendered `true` state must be reported",
  );
});

Deno.test("check 5b — both states rendered clears it", () => {
  const report = lintFixtureSet({
    families: [family({
      sidecar: sidecar({
        params: [{ key: "hide_zero_priced_components", type: "boolean", default: false }],
        fixtures: [
          { slug: "shown", description: GOOD_DESCRIPTION },
          { slug: "hidden", description: GOOD_DESCRIPTION, params: { hide_zero_priced_components: true } },
        ],
      }),
      fixtures: [
        { slug: "shown", ok: true, doc: NOT_AN_ORDER },
        { slug: "hidden", ok: true, doc: NOT_AN_ORDER },
      ],
      goldens: [{ branch: "main", slugs: ["shown", "hidden"] }],
    })],
  });
  assert(!checksIn(report.findings).has("param-coverage"));
});

Deno.test("check 5b — graduation-scoped: an ungraduated family is not asked", () => {
  const report = lintFixtureSet({
    families: [family({
      sidecar: sidecar({
        params: [{ key: "hide_zero_priced_components", type: "boolean", default: false }],
        fixtures: [{ slug: "x", description: GOOD_DESCRIPTION }],
      }),
      fixtures: [{ slug: "x", ok: true, doc: NOT_AN_ORDER }],
      goldens: [],
    })],
  });
  assert(!checksIn(report.findings).has("param-coverage"));
  assertEquals(report.tally.paramStates, 0, "and the tally must say it asked nothing");
});

// ── The packing-list case the plan doc singled out ──────────────────

Deno.test("a registered family with NO fixtures is reported as ungated, and is NOT a finding", () => {
  // 🔴 `packing-list` registered 2026-09-05 with zero fixtures and zero goldens
  // while the lint's success line read "23 fixture(s) across 2 family(ies)" —
  // four families existing and one of them rendering in production ungated.
  // The disk script derived families from `fixtures/` directories, so it could
  // not express this state at all. Taking the family list as a SEPARATE input
  // is what makes it expressible.
  const report = lintFixtureSet({
    families: [
      family({ gitPath: "quote", fixtures: [], goldens: [] }),
      family({ gitPath: "packing-list", fixtures: [], goldens: [] }),
    ],
  });
  assertEquals(report.ungatedFamilies.sort(), ["packing-list", "quote"]);
  assertEquals(report.findings.length, 0, "a family mid-build must not be a finding");
  assertEquals(report.tally.families, 2, "but it must be COUNTED");
});

Deno.test("a fixtures directory with no family sidecar IS a finding", () => {
  const report = lintFixtureSet({ families: [family({ sidecar: null })] });
  assert(checksIn(report.findings).has("sidecar"));
});

// ── Check 2b's partition — the half a `severity` assertion cannot see ──

Deno.test("check 2b — an unmasked leaf BLOCKS, and never lands in advisories", () => {
  // 🔴 This is the flip (2026-09-06), asserted where it is actually consumed.
  // `lintFixture` returning `severity: undefined` is necessary and not
  // sufficient: what CI and the manager read is the PARTITION `lintFixtureSet`
  // performs, and a re-added `"advisory"` argument would move a real leak into
  // an array `api-cloudrun`'s `familyLintOutcome` drops entirely — green
  // everywhere, reported nowhere. `subject` is `pii: "mask"` and routes to
  // `text`, whose only fake is the self-announcing filler, so a real sentence
  // there cannot have been masked.
  const report = lintFixtureSet({
    families: [
      family({
        sidecar: sidecar({ fixtures: [{ slug: "leaky", description: GOOD_DESCRIPTION }] }),
        fixtures: [{ slug: "leaky", ok: true, doc: { subject: "Riverwalk Summer Series" } }],
      }),
    ],
  });
  assert(checksIn(report.findings).has("pii-mask"), "expected a BLOCKING pii-mask finding");
  assertEquals(report.advisories, [], "nothing produces an advisory since the flip");
  assertEquals(report.tally.maskLeaves.notMasked, 1);
});

Deno.test("check 2b — a leaf drawn from the vocabularies clears it", () => {
  // The other direction, so the test above cannot pass by the check being
  // unconditional. The filler is what `fakeForMask` mints for the `text`
  // category, and it is accepted for every category by design.
  const report = lintFixtureSet({
    families: [
      family({
        sidecar: sidecar({ fixtures: [{ slug: "clean", description: GOOD_DESCRIPTION }] }),
        fixtures: [{ slug: "clean", ok: true, doc: { subject: "Sample text for subject" } }],
      }),
    ],
  });
  assert(!checksIn(report.findings).has("pii-mask"), "a filler is a valid mask");
  assertEquals(report.tally.maskLeaves.notMasked, 0);
  assertEquals(report.tally.maskLeaves.masked, 1, "and it was actually EXAMINED");
});

// ── The tallies, which are what make a vacuous run visible ──────────

Deno.test("the report EXAMINES what it claims to examine", () => {
  // ⭐ Check 6 was retired cleanly only because it printed the number it had
  // compared, so the run after the fixtures were stripped read `0`. A check
  // that cannot fail is not coverage, and this test is what stops the fold
  // reporting a confident pass over nothing.
  const report = lintFixtureSet({
    families: [
      family({
        gitPath: "quote",
        sidecar: sidecar({
          params: [{ key: "hide_zero_priced_components", type: "boolean", default: false }],
          fixtures: [
            { slug: "a", description: GOOD_DESCRIPTION },
            { slug: "b", description: GOOD_DESCRIPTION, params: { hide_zero_priced_components: true } },
          ],
        }),
        fixtures: [
          { slug: "a", ok: true, doc: NOT_AN_ORDER },
          { slug: "b", ok: true, doc: NOT_AN_ORDER },
        ],
        goldens: [{ branch: "main", slugs: ["a", "b"] }],
      }),
      family({ gitPath: "packing-list", sidecar: sidecar(), fixtures: [], goldens: [] }),
    ],
  });
  assertEquals(report.tally.families, 2);
  assertEquals(report.tally.fixtures, 2);
  assertEquals(report.tally.descriptions, 2);
  assertEquals(report.tally.goldenTrees, ["main/quote"]);
  assertEquals(report.tally.paramStates, 2, "one boolean param, asked at both states");
});

Deno.test("an empty family list examines nothing, and says so rather than passing", () => {
  const report = lintFixtureSet({ families: [] });
  assertEquals(report.findings.length, 0);
  assertEquals(report.tally.families, 0);
  assertEquals(report.tally.fixtures, 0);
  assertEquals(report.tally.goldenTrees, []);
});

// ── Structural robustness ───────────────────────────────────────────

Deno.test("a wrong-typed sidecar field is treated as absent, never thrown on", () => {
  // The sidecar arrives as `unknown`-shaped data read from a JSON file or a
  // draft content map. A wrong type is the lint's problem to survive, not to
  // crash on — check 1 is what reports the document being wrong.
  const report = lintFixtureSet({
    families: [family({
      sidecar: {
        collection_source: 42,
        params: "not an array",
        fixtures: [null, { slug: 7 }, { slug: "real", description: GOOD_DESCRIPTION }],
      } as unknown as LintSidecar,
      fixtures: [{ slug: "real", ok: true, doc: NOT_AN_ORDER }],
    })],
  });
  assert(report.findings.some((f) => f.message.includes("collection_source")));
  assertEquals(report.tally.descriptions, 1, "only the one well-formed entry counts");
});

Deno.test("stringLeaves reaches into arrays and nested objects, and yields paths", () => {
  const leaves = [...stringLeaves({ a: ["x", { b: "y" }], c: 1, d: null })];
  assertEquals(leaves, [["a[0]", "x"], ["a[1].b", "y"]]);
});
