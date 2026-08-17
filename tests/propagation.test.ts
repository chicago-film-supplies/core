import { assertEquals, assertNotEquals } from "@std/assert";
import {
  aggregates,
  rules,
  transactions,
} from "../src/schemas/propagation/mod.ts";
import { schemas } from "../src/schemas/mod.ts";

// ── Rule integrity ───────────────────────────────────────────────

Deno.test("all rule IDs are unique", () => {
  const ids = rules.map((r) => r.id);
  const unique = new Set(ids);
  assertEquals(ids.length, unique.size, `Duplicate rule IDs: ${ids.filter((id, i) => ids.indexOf(id) !== i)}`);
});

Deno.test("every propagation source file is registered in mod.ts", async () => {
  // The ONE check the one-module-per-file convention still needs. mod.ts's
  // import block and its MODULES array already prove each other at compile /
  // lint time; what neither can see is a file on disk that nothing imports.
  //
  // A filename comparison against the directory listing — deliberately NO
  // dynamic import and no execution, because this module is consumed by a
  // browser and over https: from JSR, where neither is available.
  const src = await Deno.readTextFile(
    new URL("../src/schemas/propagation/mod.ts", import.meta.url),
  );
  // Not modules: the type declarations, the id unions, the aggregate literal,
  // and the barrel itself.
  //
  // ⚠️ `stock.ts` used to be exempted here on the grounds that it "declares no
  // rules of its own", and that stopped being true when Tier 1 item 3 collapsed
  // the seven `stockRules()` copies into one module. The exemption survived the
  // collapse and left a real hole — dropping `stock.ts` from mod.ts's imports
  // would have gone unnoticed by the one check that exists to see exactly that.
  const NOT_MODULES = new Set(["mod.ts", "types.ts", "ids.ts", "aggregates.ts"]);
  const dir = new URL("../src/schemas/propagation/", import.meta.url);
  const missing: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    if (!entry.isFile || !entry.name.endsWith(".ts")) continue;
    if (NOT_MODULES.has(entry.name)) continue;
    if (!src.includes(`"./${entry.name}"`)) missing.push(entry.name);
  }
  assertEquals(
    missing,
    [],
    `Propagation files on disk that mod.ts never imports: ${missing.join(", ")}`,
  );
});

// ── The id unions ────────────────────────────────────────────────
//
// `ids.ts` declares `RuleId` and `TransactionId` as hand-written string-literal
// unions, because JSR's `no-slow-types` forces `rules`/`transactions` to be
// annotated `CollectionRule[]`/`TransactionDefinition[]` and that erases every
// literal id at the publish boundary (see that file for the full account).
//
// ⚠️ **A declaration needs a population assertion beside it.** The compiler
// covers one direction only — a rule declared under an id the union does not
// carry is a compile error. NOTHING compile-time can see the other direction: a
// member of the union that no rule declares. These two tests are that half, and
// they read `ids.ts`'s own source rather than its type, because a type cannot be
// enumerated at runtime.

/** Pull the quoted members of one `export type X = | "a" | "b";` union. */
async function unionMembers(name: string): Promise<string[]> {
  const src = await Deno.readTextFile(
    new URL("../src/schemas/propagation/ids.ts", import.meta.url),
  );
  const start = src.indexOf(`export type ${name} =`);
  assertNotEquals(start, -1, `ids.ts declares no union named ${name}`);
  const end = src.indexOf(";", start);
  assertNotEquals(end, -1, `the ${name} union is not terminated`);
  const body = src.slice(start, end);
  const members = [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  // Non-vacuity: a regex that stops matching reads exactly like a clean corpus.
  assertNotEquals(members.length, 0, `extracted zero members from ${name}`);
  return members;
}

Deno.test("RuleId names exactly the rules the catalog declares", async () => {
  // ⚠️ Widened to `string` deliberately. Comparing `Set<RuleId>` against the
  // parsed source would type the oracle by the very union under test, and the
  // compiler would then reject the only values that could ever fail it.
  const declared = new Set<string>(rules.map((r) => r.id));
  const union = new Set(await unionMembers("RuleId"));
  assertEquals(
    [...union].filter((id) => !declared.has(id)),
    [],
    "ids.ts carries a RuleId that no rule declares",
  );
  assertEquals(
    [...declared].filter((id) => !union.has(id)),
    [],
    "a rule is declared under an id ids.ts does not carry",
  );
});

Deno.test("TransactionId names exactly the transactions the catalog declares", async () => {
  const declared = new Set<string>(transactions.map((t) => t.id));
  const union = new Set(await unionMembers("TransactionId"));
  assertEquals(
    [...union].filter((id) => !declared.has(id)),
    [],
    "ids.ts carries a TransactionId that no transaction declares",
  );
  assertEquals(
    [...declared].filter((id) => !union.has(id)),
    [],
    "a transaction is declared under an id ids.ts does not carry",
  );
});

Deno.test("the rule and transaction id namespaces are disjoint", () => {
  // `ids.ts` states this, and callers rely on it: `logPropagation` and
  // `logTransactionPropagation` take different id namespaces, and an id that is
  // both would resolve in either function by accident rather than by intent.
  const txIds = new Set(transactions.map((t) => t.id as string));
  const both = rules.map((r) => r.id as string).filter((id) => txIds.has(id));
  assertEquals(both, [], `ids used as BOTH a rule and a transaction: ${both.join(", ")}`);
});

Deno.test("every rule has at least one field mapping", () => {
  for (const rule of rules) {
    assertNotEquals(rule.fields.length, 0, `Rule ${rule.id} has no field mappings`);
  }
});

// ── Transaction integrity ────────────────────────────────────────

Deno.test("all transaction IDs are unique", () => {
  const ids = transactions.map((t) => t.id);
  const unique = new Set(ids);
  assertEquals(ids.length, unique.size);
});


Deno.test("every transaction step references an existing rule", () => {
  const ruleIds = new Set(rules.map((r) => r.id));
  for (const txn of transactions) {
    for (const step of txn.steps) {
      assertEquals(ruleIds.has(step), true, `Transaction ${txn.id} references unknown rule: ${step}`);
    }
  }
});

// ── Aggregate integrity ──────────────────────────────────────────

Deno.test("all aggregate IDs are unique", () => {
  const ids = aggregates.map((a) => a.id);
  const unique = new Set(ids);
  assertEquals(ids.length, unique.size);
});

Deno.test("aggregate root collections exist in schemas (when set)", () => {
  for (const agg of aggregates) {
    if (agg.root) {
      assertEquals(agg.root in schemas, true, `Aggregate ${agg.id} root "${agg.root}" not found in schemas`);
    }
  }
});

Deno.test("aggregate member collections exist in schemas", () => {
  for (const agg of aggregates) {
    for (const member of agg.members) {
      assertEquals(member in schemas, true, `Aggregate ${agg.id} member "${member}" not found in schemas`);
    }
  }
});

// ── enforced_by integrity ────────────────────────────────────────
//
// `enforced_by` is a CLAIM about what checks a rule's `invariant`, and it is
// rendered into `/openapi.json` for API consumers. A wrong entry converts an
// honest "unverified" into a false "verified" and publishes it, which is worse
// than the absent field it replaced. These are the properties that can be
// checked without leaving this package.

Deno.test("enforced_by only appears on rules that state an invariant", () => {
  for (const rule of rules) {
    if (!rule.enforced_by) continue;
    assertNotEquals(
      rule.invariant,
      undefined,
      `Rule ${rule.id} names its enforcement but states no invariant — ` +
        `there is nothing for the pointer to be enforcing.`,
    );
  }
});

Deno.test("every enforced_by ref is a repo-relative path", () => {
  // A bare filename cannot be resolved from another repo, and this field is
  // read by humans in four of them.
  //
  // Three suffix forms are legal, and they are not equally good:
  //   - `::<anchor>`  — the TARGET form. A test or symbol name, which survives
  //                     insertions above it. Prefer this.
  //   - `:<N>`        — legacy. A line number rots on any edit to the file, and
  //                     a resolve-only check can only notice when the shift
  //                     happens to land on whitespace; ~9% of them were already
  //                     pointing at blank lines when this was measured.
  //   - none          — path-only. Weakest, but honest: it claims existence and
  //                     nothing more.
  const shape =
    /^[a-z0-9-]+\/[A-Za-z0-9_./-]+\.(ts|tsx|json|ya?ml)(:\d+(-\d+)?|::.+)?$/;
  for (const rule of rules) {
    for (const ref of rule.enforced_by ?? []) {
      assertEquals(
        shape.test(ref.ref),
        true,
        `Rule ${rule.id}: enforced_by ref "${ref.ref}" is not a repo-relative path ` +
          `(expected e.g. "api-cloudrun/scripts/audit-x.ts:42").`,
      );
    }
  }
});

Deno.test("a non-gating enforced_by entry must say why it does not gate", () => {
  // `gates: false` means the pointer CANNOT fail today — a vacuous corpus, an
  // audit that always exits 0, a writer-path test with no corpus detector.
  // Recording that without saying which is how a known-inert pointer reads as a
  // deliberate one six months later.
  for (const rule of rules) {
    for (const ref of rule.enforced_by ?? []) {
      if (ref.gates) continue;
      assertNotEquals(
        ref.clause,
        undefined,
        `Rule ${rule.id}: enforced_by "${ref.ref}" is marked gates:false with no clause. ` +
          `A pointer that cannot fail must record why, or it reads as verification.`,
      );
    }
  }
});

Deno.test("no rule lists the same (ref, clause) pair twice", () => {
  // Two entries sharing a `ref` are legitimate — one audit can cover two
  // distinct clauses — so the identity is the pair, not the path.
  for (const rule of rules) {
    const seen = new Set<string>();
    for (const ref of rule.enforced_by ?? []) {
      const key = `${ref.ref}|${ref.clause ?? ""}`;
      assertEquals(
        seen.has(key),
        false,
        `Rule ${rule.id} lists ${ref.ref} twice for the same clause.`,
      );
      seen.add(key);
    }
  }
});

Deno.test("the enforced_by field is actually populated (non-vacuity)", () => {
  // Every assertion above is vacuously true over an empty field. This one fails
  // if the triage is reverted or the field is dropped, so the four guards above
  // cannot silently stop testing anything.
  const withEnforcement = rules.filter((r) => (r.enforced_by?.length ?? 0) > 0);
  assertEquals(
    withEnforcement.length > 0,
    true,
    "No rule carries enforced_by — the guards above are testing nothing.",
  );
});

Deno.test("every enforced_by ref into core/ resolves", async () => {
  // The mirror of api-cloudrun's `enforcedByCoverage.test.ts`, and the split is
  // forced rather than chosen: 169 of the catalog's 196 `enforced_by`
  // occurrences name an `api-cloudrun/` path, which this repo's CI has no
  // checkout of and physically cannot resolve. So each repo checks the refs
  // whose target it can actually see, and neither can check the other's.
  //
  // ⚠️ **Resolving is not supporting.** This proves the target exists, never
  // that it still backs the clause citing it — a 13-ref sample found 2 pointing
  // at the wrong assertion while resolving perfectly. A green here is a floor.
  const ours = [
    ...new Set(rules.flatMap((r) => (r.enforced_by ?? []).map((e) => e.ref))),
  ].filter((ref) => ref.split("::")[0].split(":")[0].startsWith("core/"));

  const broken: string[] = [];
  for (const ref of ours) {
    const [pathPart, anchor] = ref.split("::");
    const m = pathPart.match(/^(.*):(\d+)(?:-\d+)?$/);
    const path = m ? m[1] : pathPart;
    let text: string;
    try {
      text = await Deno.readTextFile(
        new URL("../" + path.slice("core/".length), import.meta.url),
      );
    } catch {
      broken.push(`MISSING FILE   ${ref}`);
      continue;
    }
    if (anchor !== undefined) {
      // A named anchor survives insertions — which is why it is the target form.
      if (!text.includes(anchor)) broken.push(`ANCHOR ABSENT  ${ref}`);
    } else if (m) {
      // Legacy `:N`, deliberately weak: it only catches a shift that happens to
      // land on whitespace. A migration aid, not the guard.
      const lines = text.split("\n");
      const n = Number(m[2]);
      if (n > lines.length) broken.push(`PAST EOF       ${ref}`);
      else if (lines[n - 1].trim() === "") broken.push(`BLANK LINE     ${ref}`);
    }
  }

  assertEquals(broken, [], "core-targeting enforced_by refs that do not resolve:\n" + broken.join("\n"));
  assertEquals(ours.length > 10, true, `only ${ours.length} core-targeting refs found — expected >10 (20 at the time of writing); this guard has stopped asking its question`);
});
