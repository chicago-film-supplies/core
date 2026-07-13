/**
 * commit-msg gate — reject a message release-please cannot parse.
 *
 * release-please v17 runs every commit through `@conventional-commits/parser`
 * (the same version this script pins). On a parse error it logs
 * `commit could not be parsed: <sha> <subject>` and then **silently drops the
 * commit** from CHANGELOG.md and the GitHub release. Nothing fails; the release
 * still cuts; the change just isn't in the notes.
 *
 * That is not hypothetical: `4615887b` — the #280 whole-collection-locations
 * fix, the most consequential commit in v0.109.0 — vanished from those notes.
 *
 * The parser is a PEG grammar over the Conventional Commits spec, and it is far
 * stricter than the familiar `type(scope): subject` regex. The construct that
 * bit us was **nested parentheses attached to a word** in the body:
 *
 *     `transaction.get(db.collection("locations"))`   ← does NOT parse
 *     `transaction.get (db.collection("locations"))`  ← parses
 *     `transaction.get(dbCollection)`                 ← parses
 *
 * Rather than blocklist that one shape, this hook runs the real parser, so any
 * construct release-please would choke on is caught at commit time instead of
 * at release time.
 */
import { parser } from "@conventional-commits/parser";

/** Messages git generates or that release-please intentionally ignores. */
const EXEMPT = /^(Merge |Revert |fixup!|squash!|amend!)/;

/** Everything below git's scissors line is commentary, not the message. */
const SCISSORS = /^# -+ >8 -+$/m;

/** Strip git's comment lines + scissors block, exactly as git itself does. */
function cleanMessage(raw: string): string {
  const body = raw.split(SCISSORS)[0];
  return body
    .split("\n")
    .filter((line) => !line.startsWith("#"))
    .join("\n")
    .trim();
}

function main(): number {
  const path = Deno.args[0];
  if (!path) {
    console.error("check-commit-msg: expected a commit-message file path");
    return 2;
  }

  const message = cleanMessage(Deno.readTextFileSync(path));
  if (!message) return 0; // empty message — git aborts on its own
  if (EXEMPT.test(message)) return 0;

  try {
    parser(message);
    return 0;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`
✗ release-please cannot parse this commit message.

  It would be SILENTLY DROPPED from CHANGELOG.md and the GitHub release —
  the release still cuts, the change just never appears in the notes.

  Parser error:
${reason.split("\n").map((l) => "    " + l).join("\n")}

  Most common cause: nested parentheses attached to a word, e.g.
      transaction.get(db.collection("locations"))
  Add a space before the outer paren, or drop the inner call:
      transaction.get (db.collection("locations"))
      transaction.get(...) over the whole collection

  Fix the message, or bypass with --no-verify and accept the missing note.
`);
    return 1;
  }
}

if (import.meta.main) Deno.exit(main());
