/**
 * Money-arithmetic coverage — core's arm of the cross-repo money ratchet.
 *
 * api-cloudrun (`tests/unit/moneyArithmeticCoverage.test.ts`), manager
 * (`src/utils/__tests__/moneyArithmetic.test.ts`) and templates
 * (`.github/workflows/money-lint.yml`) hold the others. This one is different
 * in a way worth stating up front: **core is where the money arithmetic
 * legitimately lives.** The other arms can say "no money math here, import it
 * from core"; core cannot say that about itself.
 *
 * So this arm guards the two things that still mean something here.
 *
 * ## 1. The doctrine's actual line: closure, not a taboo on currency.js
 *
 * Money arithmetic is **closed or it is not**:
 *
 * - **Closed** — add, subtract, and **multiply by an INTEGER**. The result is
 *   representable at the storage quantum, so no rounding decision exists and
 *   any correctly-quantized type is exact. Measured: 0 disagreements over
 *   200,000 random 2dp pairs against an exact BigInt reference.
 * - **Not closed** — divide, or multiply by a fraction. A rounding decision is
 *   *mandatory*, and currency.js supplies one silently by quantizing every
 *   intermediate at its `precision`.
 *
 * The narrowing matters and is not pedantry. A blanket "never multiply money"
 * would forbid `calculateReplacementTotals`'s `replacement × quantity`, which
 * is exact — `quantity` is `z.int()` — and would add ceremony for nothing. So
 * `.divide` and `.distribute` are banned outright, while `.multiply` is
 * catalogued per site with the argument that makes it integral.
 *
 * ## 2. One implementation per operation, INSIDE the package that exports them
 *
 * `utils/money.ts` is the home. A second `toCents` in `utils/orders.ts` would
 * be the same local-copy defect the other repos are ratcheted against, except
 * closer to the source and therefore worse: consumers would inherit a
 * divergence they cannot see.
 *
 * ## What this does NOT catch
 *
 * Operation order inside an expression naming no banned token. That is what the
 * property sweeps are for — `orders.test.ts` (300k lines), `movements.test.ts`
 * (200k draws), each with a fail-closed companion asserting a deliberately
 * wrong implementation *disagrees*. This ratchet keeps the inventory honest so
 * those sweeps stay pointed at everything that moves money.
 */
import { assertEquals } from "@std/assert";

const SRC_DIR = new URL("../src/", import.meta.url);

/** A token inside a comment is prose about money, not arithmetic on it. */
const COMMENT_LINE_RE = /^\s*(?:\/\/|\*|\/\*)/;

interface Hit {
  file: string;
  line: number;
  text: string;
}

async function* walk(
  dirUrl: URL,
  prefix = "",
): AsyncGenerator<{ relPath: string; content: string }> {
  for await (const entry of Deno.readDir(dirUrl)) {
    const relPath = prefix + entry.name;
    if (entry.isDirectory) {
      yield* walk(new URL(entry.name + "/", dirUrl), relPath + "/");
    } else if (entry.isFile && entry.name.endsWith(".ts")) {
      yield { relPath, content: await Deno.readTextFile(new URL(entry.name, dirUrl)) };
    }
  }
}

async function grep(re: RegExp): Promise<Hit[]> {
  const hits: Hit[] = [];
  for await (const { relPath, content } of walk(SRC_DIR)) {
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (COMMENT_LINE_RE.test(lines[i])) continue;
      if (!re.test(lines[i])) continue;
      hits.push({ file: `src/${relPath}`, line: i + 1, text: lines[i].trim() });
    }
  }
  return hits;
}

const show = (hits: Hit[]) =>
  hits.map((h) => `  + ${h.file}:${h.line}  ${h.text.slice(0, 110)}`).sort().join("\n");

// ── Ratchet A: who holds currency.js ─────────────────────────────────

const CURRENCY_IMPORT_RE = /from\s+"currency\.js"/;

/**
 * The four modules permitted to import currency.js, and what each does with it.
 *
 * Three of them are **summing only** — closed operations, exact today, and they
 * retire *natively* when money is stored as integer cents, because addition is
 * closed in cents by construction. They are not technical debt; they are the
 * shape a dollar-float representation forces.
 *
 * `utils/money.ts` is the one permanent entry, and deliberately so.
 */
const CURRENCY_FILES = new Set<string>([
  // PERMANENT. `parseMoney` / `parseRate` wrap currency.js rather than
  // reimplementing it, and that asymmetry with `distributeCents` (which IS
  // reimplemented) is a decision, not an inconsistency: distributing in
  // integers is ~5 lines that outsource no subtlety, while parsing outsources a
  // great deal — separator, symbol, sign and epsilon handling is precisely the
  // hand-rolled-money-code class this campaign exists to delete. This is the
  // one place currency.js survives after the cents migration.
  "src/utils/money.ts",
  // Summing line subtotals, discounts, taxes and fees into order totals — plus
  // the one catalogued integer multiply (Ratchet B).
  "src/utils/orders.ts",
  // Summing invoice totals.
  "src/utils/invoices.ts",
  // Summing tax amounts.
  "src/utils/taxes.ts",
]);

Deno.test("moneyArithmeticCoverage — every currency.js importer in core is catalogued", async () => {
  const found = [...new Set((await grep(CURRENCY_IMPORT_RE)).map((h) => h.file))].sort();
  const added = found.filter((f) => !CURRENCY_FILES.has(f));
  const stale = [...CURRENCY_FILES].filter((f) => !found.includes(f)).sort();

  assertEquals(
    added,
    [],
    "New currency.js importer in core. It is exact for CLOSED operations (add, subtract, " +
      "multiply by an integer) and silently supplies a rounding policy for open ones. If " +
      "this module only sums money, catalogue it here with that note; if it divides or " +
      "scales by a fraction, use toCentsBig + roundDivHalfUp from utils/money.ts:\n" +
      added.map((f) => `  + ${f}`).join("\n"),
  );
  assertEquals(
    stale,
    [],
    "Catalogued module(s) no longer import currency.js — remove the stale entries. An " +
      "allowlist entry that outlives its subject is a standing exemption nobody is watching, " +
      "and it is invisible precisely because this test stays green:\n" +
      stale.map((f) => `  - ${f}`).join("\n"),
  );
});

// ── Ratchet B: closure ───────────────────────────────────────────────

/**
 * `.divide` and `.distribute` force a rounding decision (and `.distribute` a
 * *residual* decision as well). Both have integer-cents replacements in
 * `utils/money.ts` — `roundDivHalfUp`, `roundDivHalfAwayFromZero`,
 * `distributeCents`. There is **no allowlist**: zero sites, permanently.
 */
const HARD_BANNED_RE = /\.(?:divide|distribute)\(/;

/**
 * `.multiply` is allowed **only** where the multiplicand is an integer, and
 * each site names the reason. `file:line` keys, so moving the call re-opens the
 * question rather than inheriting the exemption.
 */
const INTEGER_MULTIPLY_ALLOWED = new Map<string, string>([
  [
    "src/utils/orders.ts:1180",
    "calculateReplacementTotals: `replacement × quantity`. `LineItem.quantity` is " +
    "`z.int().optional()`, so the multiplicand is a whole unit count and the product is " +
    "representable at the cent — closed, and exact. This is the site that makes a blanket " +
    "multiply ban wrong. " +
    "The `.optional()` used to be a real hole rather than a footnote: `isPreTaxItem` " +
    "asserted `quantity: number` without checking it, so an absent quantity reached this " +
    "multiply and `currency(NaN).value` returned **null, not NaN** — a replacement total of " +
    "`null` with `tax: 0` beside it, which reads as an answer. Closed in core#49 by checking " +
    "`quantity` in the predicate (and in `isPreTaxPricingItem`, which guards the subtotal " +
    "path). Measured first: 0 quantity-less pre_tax lines across 18,492 in prod.",
  ],
]);

Deno.test("moneyArithmeticCoverage — no divide or distribute, and every multiply is by an integer", async () => {
  const banned = await grep(HARD_BANNED_RE);
  assertEquals(
    show(banned),
    "",
    "currency.js divide/distribute in core. These force a rounding decision nothing states " +
      "and nothing checks — measured against an exact BigInt reference over 200,000 lines, " +
      "the precomputed-factor form was wrong 199,998 times (worst $32,031.20) and " +
      "divide-first 185,372. Use roundDivHalfUp / roundDivHalfAwayFromZero / distributeCents " +
      "from utils/money.ts, with the divide LAST, and ship a property sweep plus a " +
      "fail-closed companion:\n" + show(banned),
  );

  const multiplies = await grep(/\.multiply\(/);
  const uncatalogued = multiplies.filter(
    (h) => !INTEGER_MULTIPLY_ALLOWED.has(`${h.file}:${h.line}`),
  );
  assertEquals(
    show(uncatalogued),
    "",
    "Un-catalogued currency.js multiply. Multiplying money by an INTEGER is closed and " +
      "exact, so this is a catalogue rather than a ban — but the entry has to say WHY the " +
      "multiplicand is integral. Multiplying by a fraction is not closed and belongs in " +
      "integer cents:\n" + show(uncatalogued),
  );

  const staleMultiply = [...INTEGER_MULTIPLY_ALLOWED.keys()]
    .filter((k) => !multiplies.some((h) => `${h.file}:${h.line}` === k)).sort();
  assertEquals(
    staleMultiply,
    [],
    "Catalogued multiply site(s) no longer exist at that line. The key is `file:line` on " +
      "purpose — moving the call should re-open the question, not carry the exemption " +
      "along:\n" + staleMultiply.map((k) => `  - ${k}`).join("\n"),
  );
});

// ── Ratchet C: one implementation per operation ──────────────────────

const MONEY_EXPORTS = [
  "toCents",
  "fromCents",
  "toCentsBig",
  "fromCentsBig",
  "roundDivHalfUp",
  "roundDivHalfAwayFromZero",
  "perUnitCostAt4dp",
  "parseMoney",
  "parseRate",
  "distributeCents",
  "formatCents",
] as const;

/** Matches a *definition*, never an import — `import { toCents }` does not trip it. */
const LOCAL_REDEF_RE = new RegExp(
  `(?:const|let|function)\\s+(?:${MONEY_EXPORTS.join("|")})\\b`,
);

Deno.test("moneyArithmeticCoverage — utils/money.ts is the only definition of each helper", async () => {
  const offenders = (await grep(LOCAL_REDEF_RE)).filter((h) => h.file !== "src/utils/money.ts");
  assertEquals(
    show(offenders),
    "",
    "A money helper defined outside utils/money.ts. A second copy inside the package that " +
      "EXPORTS these is worse than one in a consumer: every consumer inherits a divergence " +
      "it cannot see:\n" + show(offenders),
  );
});

// ── Ratchet D: float epsilons on money comparisons ───────────────────

const FLOAT_EPSILON_RE = /(?<![.\d])0\.0(?:05|1)(?![\d])/;

/**
 * Schema refinements still comparing money with a float epsilon, and what
 * retires each.
 *
 * `0.005` is neither half a cent nor a cent — it is a threshold chosen so float
 * noise on 2dp values lands under it, which is a property of the *encoding*,
 * not of the ledger. api-cloudrun's arm has an EMPTY allowlist here because
 * `src/lib/moneyCompare.ts` took every site; core's three are still open, and
 * they are listed rather than quietly excluded so the gap is visible.
 *
 * They are not converted in the same change for a stated reason: a refinement
 * is validation *behaviour*, so touching one cuts a new `@cfs/core` beta and
 * forces a lockstep bump of all three consumers. On 2dp values the integer form
 * is equivalent, so this is scheduling, not disagreement — see the money
 * campaign's Phase 11, which removes the question entirely by making a third
 * decimal unrepresentable.
 */
const FLOAT_EPSILON_ALLOWED = new Map<string, string>([
  [
    "src/schemas/invoice.ts",
    "amount_paid + amount_credited + amount_due === total, within half a cent. Retires with " +
    "cents-denominated totals (campaign Phase 11) — `z.int()` fields compare exactly.",
  ],
  [
    "src/schemas/credit-note.ts",
    "`remaining_credit` exhaustion and its upper bound. NOTE: credit notes are ALREADY " +
    "cents-denominated in the settlements journal, so this one is convertible today and is " +
    "the first that should go.",
  ],
]);

Deno.test("moneyArithmeticCoverage — float money epsilons are catalogued, and the list only shrinks", async () => {
  const hits = await grep(FLOAT_EPSILON_RE);
  const offenders = hits.filter((h) => !FLOAT_EPSILON_ALLOWED.has(h.file));
  assertEquals(
    show(offenders),
    "",
    "New float epsilon on a money comparison. Compare in integer cents against a whole " +
      "number of cents — that is the unit the question is asked in:\n" + show(offenders),
  );

  const stale = [...FLOAT_EPSILON_ALLOWED.keys()].filter((f) => !hits.some((h) => h.file === f)).sort();
  assertEquals(
    stale,
    [],
    "A catalogued float-epsilon file no longer holds one — delete the entry so the ratchet " +
      "keeps what the cleanup won:\n" + stale.map((f) => `  - ${f}`).join("\n"),
  );
});

// ── Non-vacuity ──────────────────────────────────────────────────────

Deno.test("moneyArithmeticCoverage — the scans bite (non-vacuity)", async () => {
  // Without this, a broken walker or a regex edited into inertness would leave
  // every assertion above passing over an EMPTY set — a green ratchet guarding
  // nothing, which is exactly how the item-paths guard certified 79
  // provably-wrong items. An allowlist cannot catch it: an inert regex simply
  // finds zero and reports success.
  const files: string[] = [];
  for await (const { relPath } of walk(SRC_DIR)) files.push(relPath);
  assertEquals(files.length > 100, true, `The src/ walker found only ${files.length} files.`);

  const importers = new Set((await grep(CURRENCY_IMPORT_RE)).map((h) => h.file)).size;
  assertEquals(
    importers >= 4,
    true,
    `Ratchet A found ${importers} currency.js importers. If it is genuinely gone from core, ` +
      `delete Ratchet A rather than leaving it green over nothing.`,
  );
  assertEquals(
    (await grep(/\.multiply\(/)).length >= 1,
    true,
    "Ratchet B's multiply catalogue is measuring an empty set — the scan is broken, or the " +
      "last integer multiply went away and INTEGER_MULTIPLY_ALLOWED should be deleted.",
  );

  assertEquals(HARD_BANNED_RE.test("currency(a).divide(b)"), true, "HARD_BANNED_RE stopped matching");
  assertEquals(HARD_BANNED_RE.test("currency(a).multiply(3)"), false, "HARD_BANNED_RE over-matches");
  assertEquals(LOCAL_REDEF_RE.test("const toCents = (d: number) => 0;"), true, "LOCAL_REDEF_RE stopped matching");
  assertEquals(LOCAL_REDEF_RE.test('import { toCents } from "./money.ts";'), false, "LOCAL_REDEF_RE flags an import");
  assertEquals(FLOAT_EPSILON_RE.test("Math.abs(x) <= 0.005"), true, "FLOAT_EPSILON_RE stopped matching");
  assertEquals(FLOAT_EPSILON_RE.test("const x = 10.01;"), false, "FLOAT_EPSILON_RE matches a decimal tail");
});
