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
 * The ONE module permitted to import currency.js, and what it does with it.
 *
 * **This set held four entries until Phase 11, and losing three of them is the
 * migration succeeding rather than the ratchet weakening.** `utils/orders.ts`,
 * `utils/invoices.ts` and `utils/taxes.ts` were all *summing only* — closed
 * operations, exact, and exactly the shape a dollar-float representation
 * forces. With money stored as integer cents, addition is closed by
 * construction: `a + b` over two exact cent counts has nothing for a decimal
 * type to protect, and routing integers through one would only re-introduce the
 * float it was guarding. They did not need converting; they needed deleting.
 */
const CURRENCY_FILES = new Set<string>([
  // PERMANENT, and the only entry. `parseMoney` / `parseRate` wrap currency.js
  // rather than reimplementing it, and that asymmetry with `distributeCents`
  // (which IS reimplemented) is a decision, not an inconsistency: distributing
  // in integers is ~5 lines that outsource no subtlety, while parsing
  // outsources a great deal — separator, symbol, sign and epsilon handling is
  // precisely the hand-rolled-money-code class this campaign exists to delete.
  //
  // Note the parse direction survives the migration untouched: an external
  // string ("$1,234.56", a CRMS rate) is still text, and turning text into a
  // number is the same problem whatever the number is denominated in.
  "src/utils/money.ts",
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
 * `.multiply` was allowed where the multiplicand was an integer, keyed
 * `file:line` so moving the call re-opened the question.
 *
 * **The catalogue is now empty, and the arm that read it is gone with it.** Its
 * one entry was `calculateReplacementTotals`'s `replacement × quantity`, which
 * no longer goes through currency.js at all: `replacement_cents × quantity` is
 * integer arithmetic and the function applies it as `× qty ÷ QTY_SCALE` like
 * every other factor in the module.
 *
 * Retiring the entry and the assertion together is deliberate. The plan for
 * this phase flagged that the `file:line` key would shift the moment anything
 * above line 1180 moved — which is *before* the multiply itself disappeared —
 * so a half-done retirement would have failed for a reason that had nothing to
 * do with the multiply, and the obvious fix would have been to re-key the entry
 * and carry a dead exemption forward. There is no reachable currency.js
 * multiply left in core; `HARD_BANNED_RE` below is what still runs.
 */

Deno.test("moneyArithmeticCoverage — no divide or distribute anywhere in core", async () => {
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
 * **EMPTY, and it stays empty.** Both entries retired in Phase 11 together with
 * the epsilons they described:
 *
 * - `src/schemas/invoice.ts` — `amount_paid + amount_credited + amount_due ===
 *   total` "within half a cent". All four operands are `z.int()` counts of
 *   cents now, so the comparison is exact and a half-cent gap is not a
 *   representable state.
 * - `src/schemas/credit-note.ts` — `remaining_credit` exhaustion and its upper
 *   bound. An earlier version of that entry claimed it was convertible ahead of
 *   Phase 11, on the reasoning that credit notes were "already cents-denominated
 *   in the settlements journal". The journal was; the credit-note DOCUMENT was
 *   not, and `CreditNoteDocTotals` said so in as many words. It is now, so both
 *   comparisons are integer.
 *
 * Deleting the entries in the same commit as the epsilons is what the stale-entry
 * assertion below exists to force: an allowlist entry that outlives its subject
 * is a standing exemption nobody is watching.
 */
const FLOAT_EPSILON_ALLOWED = new Map<string, string>([]);

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

  // Ratchet A's floor is **1, not 4**, and the three it lost are gone for good.
  // Before Phase 11 four modules imported currency.js; three of them only
  // summed money, which is closed in integer cents, so they retired natively
  // with the storage change. `utils/money.ts` is the permanent one, so 1 is the
  // floor a working scan must still reach — a 0 means the walker or the regex
  // broke, not that the last importer left.
  const importers = new Set((await grep(CURRENCY_IMPORT_RE)).map((h) => h.file)).size;
  assertEquals(
    importers >= 1,
    true,
    `Ratchet A found ${importers} currency.js importers and there must be at least one ` +
      `(utils/money.ts, permanently — parseMoney/parseRate wrap the library rather than ` +
      `reimplementing it). Zero means the scan is inert, not that the import is gone.`,
  );
  // ⚠️ **Ratchet B's multiply floor is DELETED, not lowered**, and it had to go
  // in the same commit as the arm it guarded. `INTEGER_MULTIPLY_ALLOWED` held
  // exactly one entry — `calculateReplacementTotals`'s `replacement × quantity`
  // — and that multiply no longer exists in any form: the function works in
  // integer cents and applies the quantity as `× qty ÷ QTY_SCALE`. A floor
  // asserting "at least one currency.js multiply exists" would now be asserting
  // that the migration had NOT happened.
  assertEquals(
    (await grep(/\.multiply\(/)).length,
    0,
    "A currency.js multiply reappeared in core. Multiplying money by an integer is closed " +
      "and was legitimate while money was a dollar float, but with integer cents there is " +
      "nothing left for currency.js to do that plain integer arithmetic does not do exactly. " +
      "If a real need returns, restore INTEGER_MULTIPLY_ALLOWED and its assertion together " +
      "with a why-comment naming the multiplicand — do not simply delete this line.",
  );

  assertEquals(HARD_BANNED_RE.test("currency(a).divide(b)"), true, "HARD_BANNED_RE stopped matching");
  assertEquals(HARD_BANNED_RE.test("currency(a).multiply(3)"), false, "HARD_BANNED_RE over-matches");
  assertEquals(LOCAL_REDEF_RE.test("const toCents = (d: number) => 0;"), true, "LOCAL_REDEF_RE stopped matching");
  assertEquals(LOCAL_REDEF_RE.test('import { toCents } from "./money.ts";'), false, "LOCAL_REDEF_RE flags an import");
  assertEquals(FLOAT_EPSILON_RE.test("Math.abs(x) <= 0.005"), true, "FLOAT_EPSILON_RE stopped matching");
  assertEquals(FLOAT_EPSILON_RE.test("const x = 10.01;"), false, "FLOAT_EPSILON_RE matches a decimal tail");
});
