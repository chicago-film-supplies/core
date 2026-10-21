/**
 * core#71 — the commit-msg surface check. The planted cases the issue lists run
 * inside the script on every commit (`selfTest`); this file asserts the same
 * verdicts from outside, plus the pieces the plants lean on, so a regression in
 * the gate fails the suite rather than silently passing every commit.
 */
import { assert, assertEquals } from "@std/assert";
import {
  apiSurface,
  checkSurface,
  diffSurface,
  EXEMPTION_FOOTER,
  releaseIntent,
  selfTest,
} from "../scripts/check-commit-msg.ts";

const api = (symbols: Record<string, unknown>[]) => ({
  entrypoints: [{ entrypoint: "@cfs/core/utils/x", moduleDoc: "Module doc.", symbols }],
});
const F = { kind: "function", name: "f", signature: "f(a: string): number", doc: "Old." };
const G = { kind: "function", name: "g", signature: "g(): void", doc: "" };

Deno.test("the in-script self-test passes every plant", () => {
  assertEquals(selfTest(), []);
});

Deno.test("an export added under refactor: is refused, naming the symbol", () => {
  const refusal = checkSurface("refactor(x): extract g", api([F]), api([F, G]));
  assert(refusal !== null);
  assert(refusal.includes("+ @cfs/core/utils/x function g"));
});

Deno.test("a docstring- or moduleDoc-only change under docs: passes", () => {
  const after = {
    entrypoints: [{
      entrypoint: "@cfs/core/utils/x",
      moduleDoc: "Rewritten.",
      symbols: [{ ...F, doc: "New.", paramTags: [{ name: "a", doc: "x" }], returnsTag: "n" }],
    }],
  };
  assertEquals(checkSurface("docs(x): explain f", api([F]), after), null);
});

Deno.test("a signature change passes under feat/fix/perf, `!`, BREAKING CHANGE or the footer", () => {
  const after = api([{ ...F, signature: "f(a: number): number" }]);
  for (
    const msg of [
      "feat(x): f",
      "fix: f",
      "perf(x): f",
      "refactor(x)!: f",
      "refactor(x): f\n\nBREAKING CHANGE: numeric",
      `refactor(x): f\n\n${EXEMPTION_FOOTER}: nothing consumes f`,
    ]
  ) {
    assertEquals(checkSurface(msg, api([F]), after), null, msg);
  }
  assert(checkSurface("chore(deps): f", api([F]), after) !== null);
  assert(checkSurface("test(x): f", api([F]), after) !== null);
  // An empty footer value is not a reason.
  assert(checkSurface(`refactor(x): f\n\n${EXEMPTION_FOOTER}: `, api([F]), after) !== null);
});

Deno.test("an unchanged surface passes whatever the type", () => {
  assertEquals(checkSurface("chore: nothing", api([F, G]), api([F, G])), null);
});

Deno.test("removal and change are both reported", () => {
  const d = diffSurface(
    apiSurface(api([F, G])),
    apiSurface(api([{ ...F, signature: "f(): number" }])),
  );
  assertEquals(d, { added: [], removed: ["@cfs/core/utils/x function g"], changed: ["@cfs/core/utils/x function f"] });
});

Deno.test("releaseIntent reads the header type, not a word in the body", () => {
  assertEquals(releaseIntent("docs: mention feat: in prose").releases, false);
  assertEquals(releaseIntent("feat(utils): x").type, "feat");
});
