#!/usr/bin/env -S deno run --allow-net=registry.npmjs.org --allow-read --allow-write

/**
 * Generates `src/utils/_lucide-icons.data.ts` — the committed lucide catalogue
 * behind `it.icons` in templates.
 *
 * Run: deno task generate-lucide-icons
 *
 * ## Why the data is committed rather than depended on
 *
 * `core` is a published JSR library consumed by three repos (two Deno, one
 * Vite). An `npm:lucide-static` **runtime** dependency would propagate into all
 * three installs to deliver what is, in the end, a static table — and reading
 * `icons/*.svg` off disk from inside a published library does not work at all.
 *
 * Generating also makes a lucide upgrade a **reviewable diff**, which is the
 * part that matters operationally: a changed glyph moves pixels, and pixels go
 * through the golden visual-diff gate. One line per icon is what makes that
 * diff readable.
 *
 * ## Why this fetches a tarball instead of importing the package
 *
 * The generator needs two things: `icon-nodes.json` (the 1,767 canonical icons)
 * and the **filenames** under `icons/` (2,025 — the extra 258 are aliases). Both
 * are reachable by `import`, but neither usefully:
 *
 *   - `import * as all from "npm:lucide-static"` yields 2,022 PascalCase export
 *     names, and recovering a kebab name from PascalCase is lossy on digits
 *     (`Grid2X2` → `grid2x2` or `grid2-x2`? both appear in the real set). Every
 *     derivation rule tried mis-classified ~90 icons.
 *   - `import.meta.resolve("npm:…")` returns the bare specifier, not a file URL,
 *     so the package directory cannot be located and read.
 *
 * Fetching the registry tarball sidesteps the whole question — the filenames are
 * read as filenames — and has the better side effect that **`lucide-static` is
 * never a dependency of this package at all**, dev or otherwise. The version and
 * its published shasum are pinned here, in one visible place, and the shasum is
 * verified before anything is parsed.
 *
 * ## To take a lucide upgrade
 *
 * Bump `LUCIDE_VERSION` + `LUCIDE_SHASUM` below (the shasum is
 * `.dist.shasum` from `https://registry.npmjs.org/lucide-static/<version>`),
 * re-run, and read the diff.
 */
import { UntarStream } from "@std/tar/untar-stream";

/** Pinned deliberately — see the module docstring. Bump both together. */
const LUCIDE_VERSION = "1.31.0";
/** `.dist.shasum` (SHA-1) as published for {@link LUCIDE_VERSION}. */
const LUCIDE_SHASUM = "09791f011a10888f0f4a1402a121103913cf0d1d";

const TARBALL =
  `https://registry.npmjs.org/lucide-static/-/lucide-static-${LUCIDE_VERSION}.tgz`;

/** One SVG child element as lucide ships it: `["path", { d: "…" }]`. */
type IconNode = [string, Record<string, string>];

// ── Fetch + verify ───────────────────────────────────────────────────

async function sha1Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", bytes as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Download the pinned tarball and return `package/`-relative path → contents.
 *
 * The shasum check is the supply-chain gate: this script writes a file that is
 * committed and then rendered into customer-facing PDFs, so "the registry served
 * me something" is not a good enough provenance claim.
 */
async function fetchPackageFiles(): Promise<Map<string, string>> {
  console.log(`Fetching ${TARBALL}`);
  const res = await fetch(TARBALL);
  if (!res.ok) throw new Error(`GET ${TARBALL} → HTTP ${res.status}`);
  const gz = new Uint8Array(await res.arrayBuffer());

  const actual = await sha1Hex(gz);
  if (actual !== LUCIDE_SHASUM) {
    throw new Error(
      `shasum mismatch for lucide-static@${LUCIDE_VERSION}\n` +
        `  expected ${LUCIDE_SHASUM}\n  actual   ${actual}\n` +
        `Refusing to generate from an unverified tarball.`,
    );
  }
  console.log(`  ${gz.length.toLocaleString("en-US")} bytes, shasum OK`);

  const files = new Map<string, string>();
  const stream = new Blob([gz as BlobPart]).stream()
    .pipeThrough(new DecompressionStream("gzip"))
    .pipeThrough(new UntarStream());

  for await (const entry of stream) {
    // Only the two things we need; everything else (fonts, dist, sprite) is
    // drained without being buffered.
    const wanted = entry.path === "package/icon-nodes.json" ||
      (entry.path.startsWith("package/icons/") && entry.path.endsWith(".svg"));
    if (!entry.readable) continue;
    if (!wanted) {
      await entry.readable.cancel();
      continue;
    }
    files.set(entry.path, await new Response(entry.readable).text());
  }
  return files;
}

// ── Render ───────────────────────────────────────────────────────────

/**
 * Render lucide's node array to the inner markup we store.
 *
 * Attribute order follows the source array, so the output is a deterministic
 * function of the input — re-running without a version bump must produce a
 * byte-identical file, or the diff stops meaning "lucide changed".
 */
function renderNodes(children: IconNode[]): string {
  return children
    .map(([tag, attrs]) => {
      const rendered = Object.entries(attrs)
        .map(([k, v]) => `${k}="${v}"`)
        .join(" ");
      return `<${tag} ${rendered}/>`;
    })
    .join("");
}

/** Strip lucide's `<svg …>` wrapper and normalise whitespace to one line. */
function innerMarkup(svg: string): string {
  return svg
    .replace(/^[\s\S]*?<svg[\s\S]*?>/, "")
    .replace(/<\/svg>[\s\S]*$/, "")
    .replace(/\s*\n\s*/g, " ")
    .replace(/\s+\/>/g, "/>")
    .replace(/>\s+</g, "><")
    .trim();
}

// ── Main ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const files = await fetchPackageFiles();

  const nodesJson = files.get("package/icon-nodes.json");
  if (!nodesJson) throw new Error("package/icon-nodes.json missing from the tarball");
  const nodes = JSON.parse(nodesJson) as Record<string, IconNode[]>;

  // Canonical set: every icon with an entry in icon-nodes.json.
  const canonical = new Map<string, string>();
  for (const [name, children] of Object.entries(nodes)) {
    canonical.set(name, renderNodes(children));
  }

  // Aliases: an `icons/<name>.svg` with no icon-nodes entry. Resolved by
  // matching inner markup against a canonical icon — lucide generates an alias
  // file from the canonical's nodes, so the match is exact, not fuzzy. Anything
  // that does not match exactly one canonical is a hard error rather than a
  // dropped entry: a silently missing alias is a template that throws at render.
  const byMarkup = new Map<string, string[]>();
  for (const [name, markup] of canonical) {
    const list = byMarkup.get(markup);
    if (list) list.push(name);
    else byMarkup.set(markup, [name]);
  }

  const aliases = new Map<string, string>();
  const unresolved: string[] = [];
  const ambiguous: string[] = [];

  for (const [path, text] of files) {
    if (path === "package/icon-nodes.json") continue;
    const name = path.slice("package/icons/".length, -".svg".length);
    if (canonical.has(name)) continue;
    const hits = byMarkup.get(innerMarkup(text));
    if (!hits) unresolved.push(name);
    else if (hits.length > 1) ambiguous.push(`${name} → ${hits.join(" | ")}`);
    else aliases.set(name, hits[0]);
  }

  if (unresolved.length || ambiguous.length) {
    throw new Error(
      `Alias resolution failed for lucide-static@${LUCIDE_VERSION}:\n` +
        (unresolved.length ? `  unresolved: ${unresolved.join(", ")}\n` : "") +
        (ambiguous.length ? `  ambiguous:\n    ${ambiguous.join("\n    ")}\n` : "") +
        `The alias derivation assumes an alias file's markup is byte-identical to ` +
        `its canonical's. If lucide changed that, fix this script rather than ` +
        `dropping the aliases.`,
    );
  }

  // Sorted so the file is a stable, reviewable diff across regenerations.
  const iconLines = [...canonical.keys()].sort()
    .map((name) => `${name}\t${canonical.get(name)}`);

  // A backtick or `${` in the data would break the template literal. Lucide's
  // markup is path data and numeric attributes, so this is zero today — assert
  // rather than escape, so if it ever stops being true this fails loudly at
  // generation instead of emitting a broken module.
  const hazard = iconLines.find((l) => l.includes("`") || l.includes("${"));
  if (hazard) {
    throw new Error(
      `Icon markup contains a template-literal metacharacter and would not ` +
        `round-trip: ${hazard.slice(0, 120)}`,
    );
  }

  const aliasLines = [...aliases.keys()].sort()
    .map((from) => `  ${JSON.stringify(from)}: ${JSON.stringify(aliases.get(from))},`);

  const output = `// AUTO-GENERATED by scripts/generate-lucide-icons.ts — do not edit manually.
//
// Source: lucide-static@${LUCIDE_VERSION} (ISC) — https://lucide.dev/license
// Regenerate with: deno task generate-lucide-icons
//
// Lucide is licensed ISC. Copyright (c) for portions of Lucide are held by
// Cole Bemis 2013-2022 as part of Feather (MIT). All other copyright (c) for
// Lucide are held by Lucide Contributors 2022.

/**
 * Every lucide icon, packed as \`name\\tinner-markup\`, one per line.
 *
 * Packed rather than emitted as an object literal so the module costs a single
 * string literal at parse time; \`icons.ts\` splits it into a \`Map\` on first use,
 * so a process that never renders a template pays nothing. One line per icon is
 * what keeps a lucide upgrade reviewable.
 */
export const LUCIDE_ICON_DATA: string = \`${iconLines.join("\n")}\`;

/**
 * Deprecated/alternate name → canonical name.
 *
 * Lucide renames icons and keeps the old name working; these are those old
 * names, so a template author reaching for a name they remember gets the icon
 * rather than a throw.
 */
export const LUCIDE_ICON_ALIASES: Record<string, string> = {
${aliasLines.join("\n")}
};
`;

  const outPath = new URL("../src/utils/_lucide-icons.data.ts", import.meta.url);
  await Deno.writeTextFile(outPath, output);

  const bytes = new TextEncoder().encode(output).length;
  console.log(
    `Wrote ${outPath.pathname}\n` +
      `  ${canonical.size.toLocaleString("en-US")} icons, ${aliases.size} aliases, ` +
      `${(bytes / 1024).toFixed(0)} KB`,
  );
}

await main();
