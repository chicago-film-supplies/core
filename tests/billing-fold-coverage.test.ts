/**
 * Billing-fold coverage — the ratchets of one-document-model 6e-0b2 (F6, F9).
 *
 * The fold (`billedByPath`) and the per-line account (`accountInitiator`) in
 * `utils/quantityAccounting.ts` are the ONE answer to "what is billed at this
 * initiator path", on both sides, and `utils/documentDiff.ts` RENDERS that
 * answer rather than deciding it again. Each arm below pins one way that could
 * silently stop being true while every test still passes:
 *
 * 1. **The deleted names stay deleted.** Each was a second author of a fact the
 *    account now states once (`invoicedByPath`, `invoiceOnlyLines`,
 *    `accountLine`, `remainingForOrder`, `purchaseLineBilledNet`, the exported
 *    `extensionGroups`). Re-adding one beside the account re-opens two answers
 *    to one question. api-cloudrun's Ratchet J and manager's line-money arm
 *    carry the same list for their own trees.
 * 2. **No side comparison in the fold or the diff** (ruling 84). Everything
 *    that differs between receivable and payable is DATA in a per-side table
 *    (`BILLING_FOLD`, `DIFF_SIDES`); an `if (side === …)` is a branch the
 *    tables cannot see, and is how the two sides drifted apart before.
 * 3. **One builder of a `quantity` entry** — `entryOf` in `utils/documentDiff.ts`.
 *    Three builders existed before F9; a second one is a second reading of the
 *    account.
 * 4. **The diff imports no billing arithmetic.** `extensionGroups`,
 *    `lineCustodyAt`, `billedOutOfService` and `sliceStoredMoney` are the
 *    account's inputs or its internals; the renderer naming one means it is
 *    computing a figure the account should have stated.
 *
 * Comment lines are skipped: prose about a deleted name is history, not a caller.
 */
import { assertEquals } from "@std/assert";

const SRC_DIR = new URL("../src/", import.meta.url);
const COMMENT_LINE_RE = /^\s*(?:\/\/|\*|\/\*)/;

interface Hit {
  file: string;
  line: number;
  text: string;
}

async function* walk(dirUrl: URL, prefix = ""): AsyncGenerator<{ relPath: string; content: string }> {
  for await (const entry of Deno.readDir(dirUrl)) {
    const relPath = prefix + entry.name;
    if (entry.isDirectory) yield* walk(new URL(entry.name + "/", dirUrl), relPath + "/");
    else if (entry.isFile && entry.name.endsWith(".ts")) {
      yield { relPath, content: await Deno.readTextFile(new URL(entry.name, dirUrl)) };
    }
  }
}

/** Every non-comment line matching `re` in `content`. */
function grepContent(file: string, content: string, re: RegExp): Hit[] {
  const hits: Hit[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (COMMENT_LINE_RE.test(lines[i]) || !re.test(lines[i])) continue;
    hits.push({ file, line: i + 1, text: lines[i].trim() });
  }
  return hits;
}

async function grepSrc(re: RegExp): Promise<Hit[]> {
  const hits: Hit[] = [];
  for await (const { relPath, content } of walk(SRC_DIR)) hits.push(...grepContent(`src/${relPath}`, content, re));
  return hits;
}

const readSrc = (rel: string) => Deno.readTextFile(new URL(rel, SRC_DIR));

const show = (hits: Hit[]) => hits.map((h) => `  + ${h.file}:${h.line}  ${h.text.slice(0, 110)}`).sort().join("\n");

// ── 1. The deleted names ──────────────────────────────────────────────

/** Deleted in 6e-0b2 beta F step 2c. Step 5 adds the payable writer's names when F5 deletes them. */
export const DELETED_FOLD_NAMES_RE =
  /\b(?:invoicedByPath|InvoicedByPath|InvoicedAtPath|InvoicedRow|TimeCredit|invoiceOnlyLines|InvoiceOnlyLines|InvoiceOnlySkip|accountLine|OrderLineAccount|extensionGroups|remainingForOrder|RemainingLine|RemainingForOrder|purchaseLineBilledNet|PurchaseLineBilledNet|purchaseLineBilledCounts|remainingTimeCounts|RemainingTimeCountsArgs|purchaseDocumentBilling|purchaseCreditBilling|foldPurchaseDocument|PurchaseLineBilling|purchaseDocumentsBefore)\b/;

Deno.test("billingFoldCoverage — the deleted fold names stay deleted in src/", async () => {
  const back = await grepSrc(DELETED_FOLD_NAMES_RE);
  assertEquals(
    show(back),
    "",
    "A name the one billing fold replaced is back. What is billed at a path is `billedByPath`; " +
      "everything a caller decides about a line is `accountInitiator`'s `LineAccount`; the remainder, the " +
      "offer and coverage read `accountBilling`:\n",
  );
});

// ── 2. No side comparison in the fold or the diff ─────────────────────

/** A comparison against the side, by variable or by literal. */
export const SIDE_COMPARISON_RE =
  /\bside\s*[!=]==?|[!=]==?\s*"(?:receivable|payable)"|"(?:receivable|payable)"\s*[!=]==?/;

const SIDE_FREE_FILES = ["utils/quantityAccounting.ts", "utils/documentDiff.ts"];

Deno.test("billingFoldCoverage — the fold and the diff never compare the side", async () => {
  const hits: Hit[] = [];
  for (const rel of SIDE_FREE_FILES) hits.push(...grepContent(`src/${rel}`, await readSrc(rel), SIDE_COMPARISON_RE));
  assertEquals(
    show(hits),
    "",
    "A side comparison in the fold or the diff (ruling 84). A difference between the sides is an entry " +
      "in `BILLING_FOLD` / `DIFF_SIDES`, read through the table, never an `if`:\n",
  );
});

// ── 3. One builder of a `quantity` entry ──────────────────────────────

/** An object literal building a quantity entry (the type member ends in `;`, a literal in `,`). */
export const QUANTITY_LITERAL_RE = /\bkind:\s*"quantity"\s*,/;

/** The 1-based line span of the top-level function `name` in `content`, or null. */
function functionSpan(content: string, name: string): { start: number; end: number } | null {
  const lines = content.split("\n");
  const start = lines.findIndex((l) => new RegExp(`^(?:export\\s+)?function\\s+${name}\\s*\\(`).test(l));
  if (start < 0) return null;
  const end = lines.findIndex((l, i) => i > start && /^\}/.test(l));
  return end < 0 ? null : { start: start + 1, end: end + 1 };
}

Deno.test("billingFoldCoverage — a quantity entry is built only in documentDiff's entryOf", async () => {
  const hits = await grepSrc(QUANTITY_LITERAL_RE);
  const span = functionSpan(await readSrc("utils/documentDiff.ts"), "entryOf");
  assertEquals(span !== null, true, "`entryOf` is gone from utils/documentDiff.ts, so this arm checks nothing: re-point it.");
  const outside = hits.filter((h) => !(h.file === "src/utils/documentDiff.ts" && h.line > span!.start && h.line < span!.end));
  assertEquals(
    show(outside),
    "",
    "A `quantity` entry is built outside `entryOf` (F9). Render it from the account through `entryOf`, " +
      "adding a `QuantityRow` arm if it is a new kind of row:\n",
  );
  assertEquals(hits.length, 1, `expected exactly one quantity literal (in entryOf), found:\n${show(hits)}`);
});

// ── 4. The diff imports no billing arithmetic ─────────────────────────

export const DIFF_FORBIDDEN_RE = /\b(?:extensionGroups|groupExtensions|lineCustodyAt|billedOutOfService|sliceStoredMoney)\b/;

Deno.test("billingFoldCoverage — documentDiff names none of the account's inputs or internals", async () => {
  const hits = grepContent("src/utils/documentDiff.ts", await readSrc("utils/documentDiff.ts"), DIFF_FORBIDDEN_RE);
  assertEquals(
    show(hits),
    "",
    "utils/documentDiff.ts computes a billing figure itself. The account states it (`LineAccount`, " +
      "`CustodyOnlyAccount`, `OutOfServiceInput`); the custody and out-of-service inputs are built in " +
      "utils/quantityAccounting.ts:\n",
  );
});

// ── 5. The diff compares no document KIND (F10) ───────────────────────

/** A comparison of a document kind against a literal: `.kind === "invoice"`, either way round. */
export const KIND_COMPARISON_RE =
  /\bkind\s*[!=]==?\s*"(?:order|fulfillment|invoice|purchase|bill)"|"(?:order|fulfillment|invoice|purchase|bill)"\s*[!=]==?\s*[\w.]*\bkind\b/;

/**
 * The one named exception, until ruling 34 gives both credit documents one
 * shape: `fileCredits` files AR credit notes and reads the viewed kind.
 */
const KIND_ALLOWED_IN = ["fileCredits"];

Deno.test("billingFoldCoverage — documentDiff compares roles, never a document kind (F10)", async () => {
  const dd = await readSrc("utils/documentDiff.ts");
  const spans = KIND_ALLOWED_IN.map((name) => {
    const span = functionSpan(dd, name);
    assertEquals(span !== null, true, `\`${name}\` is gone from utils/documentDiff.ts: drop it from KIND_ALLOWED_IN.`);
    return span!;
  });
  const hits = grepContent("src/utils/documentDiff.ts", dd, KIND_COMPARISON_RE);
  const outside = hits.filter((h) => !spans.some((s) => h.line > s.start && h.line < s.end));
  assertEquals(
    show(outside),
    "",
    "utils/documentDiff.ts branches on a document KIND (ruling 33). A comparison reads the ROLE " +
      "(`isBilling` / `isInitiator` / `isCustody`) and a per-side difference is an entry in `DIFF_SIDES`:\n",
  );
  // Each allowlisted function still holds a kind test, or its entry is stale.
  for (const s of spans) assertEquals(hits.some((h) => h.line > s.start && h.line < s.end), true, "an allowlisted function no longer compares a kind: drop it");
});

// ── Non-vacuity: every scan reaches something and every regex bites ──

Deno.test("billingFoldCoverage — the scans bite (non-vacuity)", async () => {
  assertEquals(DELETED_FOLD_NAMES_RE.test("const f = invoicedByPath(order, invoices);"), true, "deleted-name RE stopped matching");
  assertEquals(DELETED_FOLD_NAMES_RE.test("purchaseLineBilledNet({ bills })"), true, "deleted-name RE lost the AP names");
  assertEquals(DELETED_FOLD_NAMES_RE.test("const a = accountInitiator(side, o, fold);"), false, "deleted-name RE over-matches the account");
  assertEquals(DELETED_FOLD_NAMES_RE.test("fold.byPath.get(k)?.time_credits"), false, "deleted-name RE over-matches a field");

  assertEquals(SIDE_COMPARISON_RE.test('if (side === "payable") return 0;'), true, "side RE misses the variable form");
  assertEquals(SIDE_COMPARISON_RE.test('const ap = a.side !== "receivable";'), true, "side RE misses a property compare");
  assertEquals(SIDE_COMPARISON_RE.test('const t = "payable" === s;'), true, "side RE misses a reversed literal compare");
  assertEquals(SIDE_COMPARISON_RE.test("BILLING_FOLD[side].pointerKey"), false, "side RE flags a table read");

  assertEquals(QUANTITY_LITERAL_RE.test('    kind: "quantity",'), true, "quantity RE stopped matching a literal");
  assertEquals(QUANTITY_LITERAL_RE.test('  kind: "quantity";'), false, "quantity RE matches the type member");

  assertEquals(DIFF_FORBIDDEN_RE.test('import { lineCustodyAt } from "./bookings-inbound.ts";'), true, "diff RE stopped matching");

  assertEquals(KIND_COMPARISON_RE.test('if (viewed.kind === "purchase" || viewed.kind === "bill") return x;'), true, "kind RE missed the F10 branch");
  assertEquals(KIND_COMPARISON_RE.test('const v = "invoice" !== source.kind;'), true, "kind RE missed a reversed compare");
  assertEquals(KIND_COMPARISON_RE.test('.filter((it) => it.type === "order")'), false, "kind RE flags an ITEM type");
  assertEquals(KIND_COMPARISON_RE.test('kinds: { initiator: "order", billing: "invoice" },'), false, "kind RE flags the DIFF_SIDES table");

  // The scans reach the files they claim to read.
  const qa = await readSrc("utils/quantityAccounting.ts");
  const dd = await readSrc("utils/documentDiff.ts");
  assertEquals(/export function billedByPath[<(]/.test(qa), true, "the fold moved: re-point SIDE_FREE_FILES");
  assertEquals(/export function computeDocumentDiffs\(/.test(dd), true, "the diff moved: re-point SIDE_FREE_FILES");
  assertEquals((await grepSrc(/\baccountInitiator\b/)).length >= 2, true, "the src/ walk reached nothing");
});
