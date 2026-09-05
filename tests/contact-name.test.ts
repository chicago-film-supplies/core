import { assertEquals } from "@std/assert";
import { deriveName, splitFullName } from "../src/utils/contact-name.ts";

Deno.test("splitFullName: the arity rule, one case per branch", async (t) => {
  const cases: Array<[string, string | null | undefined, ReturnType<typeof splitFullName>]> = [
    ["1 token → first only", "Cher", { first_name: "Cher" }],
    ["2 tokens → first + last", "Jane Smith", { first_name: "Jane", last_name: "Smith" }],
    [
      "3 tokens → first + middle + last",
      "John Quincy Doe",
      { first_name: "John", middle_name: "Quincy", last_name: "Doe" },
    ],
    [
      "4+ tokens → the whole trimmed string as first_name",
      "Ana Maria de la Cruz",
      { first_name: "Ana Maria de la Cruz" },
    ],
    ["empty → an empty first_name", "", { first_name: "" }],
    ["whitespace only → an empty first_name", "   \t ", { first_name: "" }],
    ["null → an empty first_name", null, { first_name: "" }],
    ["undefined → an empty first_name", undefined, { first_name: "" }],
  ];
  for (const [label, input, expected] of cases) {
    await t.step(label, () => assertEquals(splitFullName(input), expected));
  }
});

Deno.test("splitFullName collapses surrounding and interior whitespace", async (t) => {
  // The tokens are what carry across, never the spacing — so a name pasted out
  // of a spreadsheet does not store a leading space in `first_name` or a
  // double-spaced `name` once `deriveName` joins it back.
  await t.step("leading and trailing", () => {
    assertEquals(splitFullName("  Jane Smith  "), { first_name: "Jane", last_name: "Smith" });
  });
  await t.step("interior runs, including a tab and a newline", () => {
    assertEquals(splitFullName("John \t Quincy\nDoe"), {
      first_name: "John",
      middle_name: "Quincy",
      last_name: "Doe",
    });
  });
  await t.step("the 4+ branch keeps single spaces, having trimmed the ends", () => {
    assertEquals(splitFullName("  Ana   Maria de la Cruz "), {
      first_name: "Ana   Maria de la Cruz",
    });
  });
});

Deno.test("splitFullName returns no key at all for a part it did not find", async (t) => {
  // Not `undefined`, not `null` — absent. `SplitName` is a seed for a CREATE
  // INPUT, whose three optional parts are `.nullable().optional()`, so the
  // caller decides between omitting the key and sending an explicit `null`.
  // Emitting `undefined` here would make `"middle_name" in parts` true and
  // quietly defeat that choice.
  await t.step("2 tokens: no middle_name key", () => {
    assertEquals("middle_name" in splitFullName("Jane Smith"), false);
  });
  await t.step("1 token: no middle_name or last_name key", () => {
    const parts = splitFullName("Cher");
    assertEquals("middle_name" in parts, false);
    assertEquals("last_name" in parts, false);
  });
});

Deno.test("deriveName joins what splitFullName split — 1, 2 and 3 tokens round-trip", async (t) => {
  for (const name of ["Cher", "Jane Smith", "John Quincy Doe"]) {
    await t.step(name, () => assertEquals(deriveName(splitFullName(name)), name));
  }
});

Deno.test("deriveName(splitFullName(s)) is NOT a round-trip at 4+ tokens", () => {
  // 🔴 This assertion exists to STOP someone "repairing" the 4+ branch. It is a
  // deliberate loss: a two-word surname is likelier than a three-name-plus-suffix
  // parse, so the whole string goes to `first_name` and the operator corrects it
  // in the split-name editor. The join still reproduces the display string —
  // that is why the defect is invisible from `name` alone and has to be asserted
  // on the PARTS.
  const parts = splitFullName("Ana Maria de la Cruz");
  assertEquals(deriveName(parts), "Ana Maria de la Cruz");
  assertEquals(parts.last_name, undefined);
  assertEquals(parts.first_name, "Ana Maria de la Cruz");
});

Deno.test("splitFullName recovers no pronunciation, so deriveName re-adds none", () => {
  // `deriveName` appends ` (pronunciation)`, and that suffix is NOT parsed back
  // out: a display string that carries one round-trips into a 4+ token name
  // rather than into a `pronunciation`. Pinned so nobody adds a paren-parsing
  // branch on the strength of the inverse's name.
  const displayed = deriveName({ first_name: "Alex", pronunciation: "al-ix" });
  assertEquals(displayed, "Alex (al-ix)");
  assertEquals(splitFullName(displayed), { first_name: "Alex", last_name: "(al-ix)" });
  assertEquals("pronunciation" in splitFullName(displayed), false);
});

Deno.test("deriveName drops missing parts rather than padding", async (t) => {
  // The join half had no test of its own before this file. Its contract is that
  // an absent or null part contributes NOTHING — not an empty token, which
  // would double a space and put a value in storage that `NameField`'s
  // `min(1)` cannot distinguish from a real one.
  const cases: Array<[string, Parameters<typeof deriveName>[0], string]> = [
    ["first only", { first_name: "Cher" }, "Cher"],
    ["nulls contribute nothing", {
      first_name: "Jane",
      middle_name: null,
      last_name: "Smith",
      pronunciation: null,
    }, "Jane Smith"],
    ["a middle with no last", { first_name: "John", middle_name: "Quincy" }, "John Quincy"],
    ["a last with no middle", { first_name: "Jane", last_name: "Smith" }, "Jane Smith"],
    ["pronunciation is parenthesized last", {
      first_name: "John",
      middle_name: "Quincy",
      last_name: "Doe",
      pronunciation: "JON QUIN-see DOH",
    }, "John Quincy Doe (JON QUIN-see DOH)"],
  ];
  for (const [label, parts, expected] of cases) {
    await t.step(label, () => assertEquals(deriveName(parts), expected));
  }
});
