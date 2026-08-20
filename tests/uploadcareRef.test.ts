/**
 * Uploadcare CDN-reference enforcement test — the authoring lint.
 *
 * Walks every document/input schema and asserts that a field which *looks* like
 * it holds an Uploadcare CDN file id is declared with `uploadcareRef()` (or is
 * explicitly exempt). Five assertions, in the `pii.test.ts` idiom.
 *
 * **Scope check before you debug a failure here.** This is developer feedback,
 * not the thing that keeps CDN files alive. The orphan sweep protects files by
 * harvesting every RFC-4122-shaped string value out of every Firestore document
 * (`api-cloudrun/src/lib/uploadcareReferenceMap.ts`) — schema-independent, so it
 * cannot drift and needs no annotation. A failure here means the *lint* is out
 * of date, which is an ergonomics bug. It is not a data-loss bug.
 */
import { assert, assertEquals } from "@std/assert";
import type { z } from "zod";

import { schemas } from "../src/schemas/mod.ts";
import { collectLeafPaths, type LeafPath } from "../src/schemas/zod-walk.ts";
import {
  isUploadcareCandidate,
  UPLOADCARE_CANDIDATE_EXEMPTIONS,
} from "../src/schemas/uploadcare/dictionary.ts";
import {
  UPLOADCARE_COLLECTION_KEYS,
  UPLOADCARE_REF_META,
  uploadcareRefPaths,
  uploadcareSelectFields,
} from "../src/schemas/uploadcare/mod.ts";

// ── Corpus ───────────────────────────────────────────────────────────

/**
 * Every distinct schema in the `schemas` record, keyed by its collection name.
 *
 * The record deliberately maps a singular *and* a plural key to the same
 * instance (`"card"` and `"cards"` are the same node), always singular-first, so
 * **last-key-wins** yields the plural/collection form the exemption keys and the
 * sweep both speak. A reorder that flipped this would break the exemption keys —
 * which assertion 2 catches loudly, and the pinned-keys check below catches for
 * the seven that matter.
 */
function lintCorpus(): Map<string, z.ZodType> {
  const byInstance = new Map<z.ZodType, string>();
  for (const [key, schema] of Object.entries(schemas)) byInstance.set(schema, key);
  return new Map([...byInstance].map(([schema, key]) => [key, schema]));
}

interface CorpusLeaf extends LeafPath {
  /** `<collection>::<leaf path>` — the key used by the exemption map. */
  key: string;
}

function collectCorpus(): { leaves: CorpusLeaf[]; unhandled: string[] } {
  const leaves: CorpusLeaf[] = [];
  const unhandled: string[] = [];
  for (const [collection, schema] of lintCorpus()) {
    const result = collectLeafPaths(schema);
    for (const u of result.unhandled) {
      unhandled.push(`${collection}::${u.path || "<root>"} (${u.type})`);
    }
    for (const leaf of result.leaves) {
      leaves.push({ ...leaf, key: `${collection}::${leaf.path}` });
    }
  }
  return { leaves, unhandled };
}

const isAnnotated = (leaf: LeafPath) => leaf.meta[UPLOADCARE_REF_META] === true;

/**
 * The eleven CDN reference leaves, as of 2026-07-26.
 *
 * Deliberately does NOT include `invoices::uploadcare_files[].uuid` or its
 * `quotes` twin. Those are real CDN ids, but they are a transient producer work
 * list: annotating them would pull them into the hand-written extractors, the
 * `.select()` projections and api-cloudrun's `EXPECTED_REF_PATHS` snapshot, and
 * so into the `refCounts` scan-anomaly canary — which must count only stable
 * references. They are exempted by name in `UPLOADCARE_CANDIDATE_EXEMPTIONS`
 * instead, and the sweep's value harvest protects them regardless.
 */
const EXPECTED_REF_PATHS: Record<string, string[]> = {
  "quotes": ["uploadcare_uuid"],
  "invoices": ["pdf_versions[].uploadcare_uuid", "uploadcare_uuid"],
  "products": ["images[].uuid", "images[].uuid_cutout", "query_by_images[]"],
  "cards": ["attachments[].uid"],
  "recurrences": ["prototype.attachments[].uid"],
  "templates-versions": [
    "golden_results[].image_uuids.baseline",
    "golden_results[].image_uuids.candidate",
    "golden_results[].image_uuids.diff",
  ],
  "documents": ["uuid"],
};

// ── Assertions ───────────────────────────────────────────────────────

Deno.test("5. collectLeafPaths interprets every node in the corpus", () => {
  // Fail-closed check, and a precondition for all four assertions below: an
  // unhandled container silently vanishes its subtree, so a field the walker
  // can't interpret would be invisible to the lint rather than flagged by it.
  const { unhandled } = collectCorpus();
  assertEquals(
    unhandled,
    [],
    `collectLeafPaths could not interpret these nodes — teach it the type (or, if it is a\n` +
      `container, descend it) before trusting any assertion below:\n` +
      unhandled.map((u) => `  ${u}`).join("\n"),
  );
});

Deno.test("1. CDN-ref candidates are declared with uploadcareRef()", () => {
  const violations = collectCorpus().leaves
    .filter(isUploadcareCandidate)
    .filter((leaf) => !isAnnotated(leaf))
    .filter((leaf) => !UPLOADCARE_CANDIDATE_EXEMPTIONS.has(leaf.key))
    .map((leaf) => leaf.key);

  assertEquals(
    violations,
    [],
    `These fields look like Uploadcare CDN refs but aren't declared as such.\n` +
      `Wrap the LEAF in uploadcareRef() (for an array, wrap the element), or — if it\n` +
      `isn't a CDN id — add it to UPLOADCARE_CANDIDATE_EXEMPTIONS with a reason:\n` +
      violations.map((v) => `  ${v}`).join("\n"),
  );
});

Deno.test("2. every exemption still resolves to a live candidate", () => {
  const candidates = new Set(
    collectCorpus().leaves.filter(isUploadcareCandidate).map((leaf) => leaf.key),
  );
  const stale = [...UPLOADCARE_CANDIDATE_EXEMPTIONS.keys()].filter((k) => !candidates.has(k));

  assertEquals(
    stale,
    [],
    `These exemptions no longer match any candidate field — the field was renamed,\n` +
      `removed, or retyped. Delete the entry:\n` + stale.map((s) => `  ${s}`).join("\n"),
  );
});

Deno.test("3. every uploadcareRef() leaf is one the dictionary can see", () => {
  // The dictionary is what tells a developer "you added a CDN field". If someone
  // annotates a field it can't recognise (say `signature`), the annotation works
  // but the lint has a blind spot for the NEXT such field — so widen the
  // dictionary, or accept the blind spot knowingly and exempt this assertion.
  const invisible = collectCorpus().leaves
    .filter(isAnnotated)
    .filter((leaf) => !isUploadcareCandidate(leaf))
    .map((leaf) => leaf.key);

  assertEquals(
    invisible,
    [],
    `These fields are declared uploadcareRef() but the name dictionary would not have\n` +
      `flagged them — widen MEDIA_CONTAINER_RE (mind the false positives it invites):\n` +
      invisible.map((v) => `  ${v}`).join("\n"),
  );
});

Deno.test("4. uploadcareRefPaths() matches the known ref set", () => {
  // The only assertion that catches the ref set NARROWING: drop an annotation and
  // assertions 1-3 all still pass (the field just becomes an un-exempt candidate…
  // which 1 does catch — but a field the dictionary can't see, like a hypothetical
  // `signature`, would vanish silently). This snapshot is the backstop.
  assertEquals(uploadcareRefPaths(), EXPECTED_REF_PATHS);
});

Deno.test("uploadcare collection keys resolve, and select fields are non-vacuous", () => {
  const corpusKeys = new Set(lintCorpus().keys());
  for (const key of UPLOADCARE_COLLECTION_KEYS) {
    assert(
      corpusKeys.has(key),
      `"${key}" is pinned in UPLOADCARE_COLLECTION_KEYS but is not the winning key for its\n` +
        `schema in the \`schemas\` record — the singular/plural alias order changed.`,
    );
    assert(
      uploadcareSelectFields(key).length > 0,
      `uploadcareSelectFields("${key}") is empty — a .select() projection built from it\n` +
        `would read no CDN refs at all and silently zero the sweep's canary.`,
    );
  }
});
