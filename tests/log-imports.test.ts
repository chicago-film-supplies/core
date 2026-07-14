/**
 * Structural invariant: no log record schema may reach `common.ts`.
 *
 * `createLoggerStrategy` descends into a `pii`-tagged container rather than
 * replacing it, so that a masked `Address` keeps its `city` / `region` /
 * `country_name` opt-outs. The cost of that choice is that an OBJECT-shaped
 * scalar under a tag — a `Date`, a Firestore `Timestamp` — passes through raw.
 *
 * Nothing in the type system stops someone embedding an `Address`, a
 * `Coordinates`, or a `FirestoreTimestamp` in a log record and reintroducing
 * exactly the leak the fail-closed scalar rule just removed. This test does.
 *
 * It is defence in depth, NOT what makes the logger safe: a non-string scalar
 * under a tag is redacted regardless of which file its schema came from, and a
 * log arm could always write `z.number().meta({pii:"mask"})` inline without
 * importing anything. What this pins is the *shape* of a log record — flat,
 * string-leaved, no borrowed domain fragments — and the docstring in
 * `pii/walker.ts` that says so.
 */
import { assertEquals } from "@std/assert";

const SCHEMAS_DIR = new URL("../src/schemas/", import.meta.url);
const LOG_DIR = new URL("log/", SCHEMAS_DIR);
const FORBIDDEN = new URL("common.ts", SCHEMAS_DIR).href;

/** Path relative to `src/schemas/`, for a readable failure message. */
function label(href: string): string {
  return href.startsWith(SCHEMAS_DIR.href) ? href.slice(SCHEMAS_DIR.href.length) : href;
}

/**
 * Every relative specifier a module pulls in **as a value**.
 *
 * `import type` / `export type` edges are deliberately NOT followed, and the
 * distinction is the whole precision of this test. The hazard is a log record
 * whose schema *embeds an object-shaped Zod fragment* — an `Address`, a
 * `Coordinates`, a `FirestoreTimestamp` — because `createLoggerStrategy` hands
 * a container to the walker rather than redacting it, so an object-shaped scalar
 * under a `pii` tag survives. Embedding a fragment means referencing the Zod
 * schema *object*, which is a runtime value. A type-only import cannot do it: it
 * is erased, and a bare TypeScript type can only annotate leaves that some other
 * value-level schema already declares.
 *
 * This is not hypothetical. `log/xero-event.ts:14` does
 * `import type { XeroThrottleResetsAtSource } from "../xero-budget.ts"`, and
 * `xero-budget.ts` imports `FirestoreTimestamp` from `common.ts` — so a
 * value-blind walk reports `log/xero-event.ts → xero-budget.ts → common.ts` and
 * fails. Its leaves are nonetheless all bare strings and numbers, because the
 * type is erased. Following value edges only reports it correctly as clean, and
 * would still catch the real thing (`import { Address }`).
 *
 * Both `import … from` and `export … from` are matched: a re-export cannot embed
 * a fragment either, but leaving it unmatched would be a hole in a test whose
 * only job is to have none.
 */
function valueSpecifiers(source: string): string[] {
  const out: string[] = [];
  // `import … from "./x.ts"` / `export … from "./x.ts"`, skipping `import type`
  // and `export type`. A mixed `import { type A, B }` still imports B as a
  // value, so only a leading `type` keyword disqualifies the statement.
  const re = /\b(import|export)\s+(type\s+)?([\s\S]*?)\bfrom\s*["']([^"']+)["']/g;
  for (const m of source.matchAll(re)) {
    const isTypeOnly = m[2] !== undefined;
    const spec = m[4];
    if (isTypeOnly) continue;
    if (spec.startsWith(".")) out.push(spec);
  }
  // Bare side-effect import: `import "./x.ts";` — always a value edge.
  for (const m of source.matchAll(/\bimport\s*["'](\.[^"']+)["']/g)) out.push(m[1]);
  return out;
}

Deno.test("no schema under log/ transitively imports common.ts as a value", async () => {
  const queue: string[] = [];
  for await (const entry of Deno.readDir(LOG_DIR)) {
    if (entry.isFile && entry.name.endsWith(".ts")) {
      queue.push(new URL(entry.name, LOG_DIR).href);
    }
  }
  // An empty queue would make this test vacuously green — the exact failure mode
  // it exists to prevent.
  if (queue.length === 0) throw new Error(`No log schemas found under ${LOG_DIR.href}`);
  const roots = queue.length;

  const visited = new Set<string>();
  /** module → the import chain that reached it, so a failure names the edge. */
  const via = new Map<string, string[]>();
  for (const root of queue) via.set(root, [label(root)]);
  const offenders: string[] = [];

  while (queue.length > 0) {
    const href = queue.shift()!;
    if (visited.has(href)) continue;
    visited.add(href);

    const chain = via.get(href) ?? [label(href)];

    if (href === FORBIDDEN) {
      offenders.push(chain.join(" → "));
      continue;
    }

    let source: string;
    try {
      source = await Deno.readTextFile(new URL(href));
    } catch {
      continue; // unresolvable / not a local module
    }

    for (const spec of valueSpecifiers(source)) {
      const next = new URL(spec, href).href;
      if (!via.has(next)) via.set(next, [...chain, label(next)]);
      if (!visited.has(next)) queue.push(next);
    }
  }

  assertEquals(
    offenders,
    [],
    "A log schema reaches common.ts. Log records must stay flat and string-leaved — an " +
      "object-shaped scalar (Address, Coordinates, FirestoreTimestamp) under a pii tag passes " +
      `through createLoggerStrategy unscrubbed. Import chain(s):\n  ${offenders.join("\n  ")}`,
  );

  // Sanity: the walk actually walked, and it walked past the roots.
  if (visited.size <= roots) {
    throw new Error(
      `Import walk visited ${visited.size} modules from ${roots} roots — it is not following edges`,
    );
  }
});
