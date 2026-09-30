/**
 * No breakdown is summed key by key anywhere in `src/`.
 *
 * A sum spelled `b.returned + b.lost + b.damaged` compiles through the arrival
 * of a new breakdown key and silently stops counting it. When `cleaning` and
 * `maintenance` became booking buckets (api-cloudrun custody-actions P2b,
 * 2026-09-30) that pattern accounted for most of the inventory's SILENT rows:
 * `deriveCustodyStatus` and the end-card status never reaching `complete`,
 * `calculateBookingBreakdown`'s carry folding cleaning back into `returned`,
 * `hasCustodyHistory` reading a cleaning-only booking as deletable.
 *
 * The one adder is `sumBreakdownKeys` (`utils/bookings.ts`), which takes the
 * KEYS as data. This scan refuses the other spelling, with no allowlist: the
 * helper itself is written as a loop, so nothing in `src/` needs one.
 *
 * ## What it does NOT catch
 *
 * A sum split across lines, or one built from destructured locals under other
 * names. It catches the shape every measured instance had; the key-list
 * helpers are what make a new key reach the rest.
 */
import { assert, assertEquals } from "@std/assert";

const SRC_DIR = new URL("../src/", import.meta.url);

const KEY = "(?:quoted|reserved|prepped|out|returned|lost|damaged|cleaning|maintenance)";
/** `x.key + y.key` (a member sum), or `key + key` (destructured locals). */
const NAMED_SUM_RE = new RegExp(
  `(?:\\.${KEY}\\b\\s*\\+\\s*[\\w.\\])]*\\.${KEY}\\b)|(?:(?<![\\w.])${KEY}\\s*\\+\\s*${KEY}\\b)`,
);
const COMMENT_LINE_RE = /^\s*(?:\/\/|\*|\/\*)/;

/** Drop string literals so a propagation rule's PROSE about a sum is not one. */
function stripStrings(line: string): string {
  return line.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g, '""');
}

/** Whether one source line sums breakdown keys by name. */
export function namesABreakdownSum(line: string): boolean {
  if (COMMENT_LINE_RE.test(line)) return false;
  return NAMED_SUM_RE.test(stripStrings(line));
}

async function* walk(dir: URL): AsyncGenerator<URL> {
  for await (const entry of Deno.readDir(dir)) {
    const url = new URL(entry.name + (entry.isDirectory ? "/" : ""), dir);
    if (entry.isDirectory) yield* walk(url);
    else if (entry.name.endsWith(".ts") && !entry.name.includes(".generated.")) yield url;
  }
}

Deno.test("the detector fires on each spelling it claims, and not on prose", () => {
  // Planted, so a regex that stops matching fails here rather than reporting a clean tree.
  assert(namesABreakdownSum("  const terminal = breakdown.returned + breakdown.lost + breakdown.damaged;"));
  assert(namesABreakdownSum("preDelivery += b.breakdown.quoted + b.breakdown.reserved;"));
  assert(namesABreakdownSum("  return prepped + out + returned + lost + damaged > 0;"));
  assert(namesABreakdownSum("  const carry = prev.prepped + prev.out;"));
  assert(!namesABreakdownSum(" * `returned + lost + damaged` in a docblock"));
  assert(!namesABreakdownSum('  invariant: "reserved + prepped, PLUS out unless a sale",'));
  assert(!namesABreakdownSum("  const delta = next.out - prev.out;"));
  assert(!namesABreakdownSum("  total += breakdownQuantity(b, key);"));
});

Deno.test("no breakdown is summed key by key in src/", async () => {
  const hits: string[] = [];
  let files = 0;
  for await (const url of walk(SRC_DIR)) {
    files++;
    const lines = (await Deno.readTextFile(url)).split("\n");
    lines.forEach((line, i) => {
      if (namesABreakdownSum(line)) {
        hits.push(`${url.pathname.split("/src/")[1]}:${i + 1}: ${line.trim()}`);
      }
    });
  }
  assert(files > 50, `walked only ${files} files — the walk stopped reaching src/`);
  assertEquals(hits, [], "sum through sumBreakdownKeys (utils/bookings.ts), naming the keys as data");
});
