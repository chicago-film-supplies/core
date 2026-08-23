/**
 * Propagation type definitions.
 *
 * No triggers, no Cloud Functions, no writes.
 * The API imports these types when building Eventarc triggers.
 * The doc generator walks rules built from these types to produce Mermaid diagrams.
 */

import type { RuleId, TransactionId } from "./ids.ts";
import type { CollectionName } from "../mod.ts";

/**
 * Where a propagation edge starts or ends.
 *
 * ⚠️ **Typed against core's OWN collection registry, not a list repeated here.**
 * `CollectionName` is `keyof CollectionDocs`, the same union `schemas` and
 * `DocFor<C>` are keyed by — so a rule naming a collection that does not exist
 * is a compile error, and it cannot drift, because there is no second copy to
 * drift from. Measured before typing (2026-08-17, corpus of 156): every rule
 * already conformed, so this was a pure tightening with zero catalog edits. The
 * corpus has grown since — that figure dates the MEASUREMENT and is not a live
 * count.
 *
 * Two non-collection endpoints occur and both are real:
 * - `"*"` — every collection (`update-user`'s ActorRef fan-out).
 * - `"orders/documents"` — the only subcollection endpoint in the corpus.
 *
 * ⚠️ **The type is looser than it looks, and the gap is closed by a test rather
 * than by narrowing.** `CollectionDocs` carries a singular alias beside every
 * plural (`booking` as well as `bookings`), so `source: "booking"` type-checks
 * while every real endpoint is plural. Narrowing here would mean writing the
 * plural list a second time — the defect this whole campaign deletes — so
 * `tests/propagation.test.ts` asserts it instead, deriving "is a singular alias"
 * as "appending an s yields another CollectionName". Purging the singular half
 * of the registry is the real fix and is a separate breaking change; `schemas/mod.ts`
 * records it at {@link CollectionDocs}.
 *
 * ⚠️ **The import is `import type` and must stay that way.** It is erased at
 * emit, so `@cfs/core/schemas/propagation` pulls no runtime code out of
 * `schemas/mod.ts` — which is what makes the subpath worth having at all. **That subpath
 * now exists and the barrel no longer re-exports the three values** (Tier 1
 * item 4, landed 2026-08-18), so a value import here would drag the whole schema
 * barrel back into every consumer of the catalog and undo it.
 */
export type PropagationEndpoint = CollectionName | "*" | "orders/documents";

// ── Propagation modes ───────────────────────────────────────────────

/**
 * How a field value moves from one document to another.
 *
 * ⚠️ **ONE declaration, and this is it.** `log/propagation.ts` used to declare
 * the same five members independently as `PROPAGATION_MODES`, so the catalog's
 * vocabulary and the log record's enum agreed only by coincidence — nothing
 * would have failed if a sixth mode had been added to one of them (Tier 1 item
 * 9). The log module now imports this array for its Zod enum.
 *
 * **The catalog owns it because the catalog DEFINES it**; a log record reports a
 * mode, it does not decide what modes exist. Ownership direction matters here
 * even though either direction removes the duplication — the wrong one leaves
 * the next reader looking for the vocabulary in the wrong module.
 *
 * ⚠️ **Plain `as const`, no spread — deliberately.** §5's measured guardrail is
 * that JSR's declaration emitter truncates `[...X, "y"] as const` (core#43) and
 * emits a non-spread one verbatim; `ITEM_TYPES` publishes all nine members. This
 * has no spread, and it is the same shape as `propagation/stock.ts`'s `STOCK_STEPS`, the
 * already-sanctioned value export from this directory.
 */
export const PROPAGATION_MODES = [
  "embed", // copied at creation, target owns it
  "fan-out", // source changes propagate to targets via events
  "co-write", // written atomically in same transaction
  "derive", // computed from other fields (can be same doc)
  "reference", // just a UID, resolved at read time
] as const;

/** How a field value moves from one document to another. */
export type PropagationMode = typeof PROPAGATION_MODES[number];

// ── Field mapping ───────────────────────────────────────────────────

/** Path segments into a document — e.g. ["organization", "uid"]. Empty = computed/metadata. */
export type FieldPath = string[];

/** Describes how a single field moves from source to target. */
export interface FieldMapping {
  /** Field path on the source document — e.g. ["price", "base"]. Empty array for computed/metadata sources. */
  source: FieldPath;
  /** Field path on the target document. Empty array for computed/metadata targets. */
  target: FieldPath;
  /** Human-readable description if not a direct copy (e.g. "subset(uid, name)") */
  transform?: string;
}

// ── Enforcement reference ───────────────────────────────────────────

/**
 * What actually checks a rule's `invariant`.
 *
 * A bare path is not enough, and that is a measured conclusion rather than a
 * design preference. A script-by-script read of the api-cloudrun audit corpus
 * found **3 outright false pointers** (a filename that looks like it owns a rule
 * while the script never reads the source collection at all), **2 that check
 * only a fixed point**, ~6 that cover one clause of a six-clause string, and
 * **3 pointing at scripts that never exit non-zero**. Every one of those would
 * have published a guarantee as verified.
 *
 * So a pointer carries two qualifiers: WHICH clause it covers, and whether it
 * can actually fail. An `enforced_by` entry is a claim, and `clause` + `gates`
 * are what make the claim falsifiable.
 *
 * **Never widen `ref` into a union of known script names, and never derive one
 * from an `as const` array.** JSR's syntactic declaration emitter mis-emits
 * those — core#43 published `declare const ITEM_TYPES: readonly ["order"]` for a
 * nine-member `as const`, causing 57 downstream type errors in manager. The gate
 * is now `deno task check:declarations`, which asks the general question ("can
 * this be emitted without inference?") rather than banning one spelling; the
 * regex test it replaced saw only the *spread* form, so the non-spread `as
 * const` of core#44 passed it and still emitted wrong. A hand-written interface
 * over plain `string` is the JSR-safe shape either way.
 */
export interface EnforcementRef {
  /** How the check works. `construction` = the shape makes violation unrepresentable. */
  kind: "audit" | "zod" | "assertion" | "test" | "construction";
  /**
   * Repo-relative path, optionally `::<anchor>` where it pins a specific check.
   *
   * ⚠️ **A `:<line>` suffix is BANNED, and the ban is the finding.** A line
   * number rots on any edit above it, and a resolve-only gate notices that only
   * when the shift happens to land on whitespace — so a rotted ref reads as a
   * pass. Measured while converting the last 105 of them (2026-08-18): 11 of the
   * first 33 read were pointing at the WRONG assertion while resolving cleanly,
   * including four clauses about contacts and invoices whose line sat one step
   * above, in the orders step. `tests/propagation.test.ts` rejects the form.
   *
   * An anchor is a literal that must OCCUR in the file — a `Deno.test` name, a
   * `t.step` name, an exported symbol, a finding code, a section header. Prefer
   * whatever a reader would grep for. Path-only stays legal and is the honest
   * choice for a ref whose clause covers a whole file.
   */
  ref: string;
  /**
   * WHICH clause of the invariant this covers. Most invariant strings assert
   * several things and are only partly enforced; omitting this turns "one of six
   * clauses is checked" into "verified".
   */
  clause?: string;
  /**
   * Does it fail the build or exit non-zero? A pointer at something that always
   * passes is a false guarantee, not a weak one. Three audit scripts in the
   * corpus never exit non-zero, and one exits 0 by default against a standing
   * baseline of 39 known-non-reconciling documents.
   */
  gates: boolean;
}

// ── Collection rule ─────────────────────────────────────────────────

/** One edge in the propagation graph — describes data flow between two collections. */
export interface CollectionRule {
  /**
   * Stable identifier (e.g. "create-order:org-to-order").
   *
   * Typed, so a rule declared under an id `propagation/ids.ts` does not carry is a compile
   * error rather than something a regex over `src/` might notice. Adding a rule
   * means adding its id there too — see that file for why the union cannot be
   * derived from this array.
   */
  id: RuleId;
  /** Source collection */
  source: PropagationEndpoint;
  /** Target collection (can equal source for intra-document derive) */
  target: PropagationEndpoint;
  /** How the data propagates */
  mode: PropagationMode;
  /** Why this rule exists — the business reason (most valuable field for docs) */
  invariant?: string;
  /**
   * What checks the `invariant` above. Absent means **nothing is known to** —
   * which is deliberately different from "nothing does", and is the honest
   * default for a rule whose enforcement has not been opened and read.
   *
   * An entry may only be added after opening the target and confirming it checks
   * the stated property against an INDEPENDENT source. "The filename looks
   * right" is disqualifying on its own: `audit-name-forms.ts` reads as though it
   * owns the contact-name cascades and instead compares the embedded ref against
   * its own fields, so a rename reaching zero targets passes it.
   */
  enforced_by?: EnforcementRef[];
  /** TransactionDefinition ID — groups co-writes and embeds into atomic operations */
  transaction?: TransactionId;
  /** What triggers this rule (for fan-out), e.g. "onUpdate:products" */
  trigger?: string;
  /** Field-level mappings — what data actually moves */
  fields: FieldMapping[];
}

// ── Transaction definition ──────────────────────────────────────────

/** Groups CollectionRules into a named atomic operation. */
export interface TransactionDefinition {
  /** Stable identifier (e.g. "create-order") */
  id: TransactionId;
  /** What this transaction does */
  description: string;
  /**
   * Ordered CollectionRule IDs — the sequence of operations.
   *
   * Typed at {@link RuleId}, so a step naming an id no rule declares is a
   * compile error. ⚠️ That is weaker than *"this transaction declares this
   * rule"* — a step naming a real rule belonging to a different transaction
   * still compiles, and catching THAT needs the per-transaction step unions
   * (campaign §6 step 3). The runtime arm in `tests/propagation.test.ts` is what
   * covers the gap between this file's union and the catalog.
   */
  steps: RuleId[];
}

// ── Module ──────────────────────────────────────────────────────────

/**
 * Everything one propagation source file contributes to the catalog.
 *
 * ⚠️ **Each file in this directory exports exactly ONE of these, and nothing
 * else.** That is the whole convention, and it exists to make a class of drift
 * unrepresentable rather than to police it: `propagation/mod.ts` used to re-export 141
 * individual symbols by hand and `schemas/mod.ts` re-exported 81 of them, so
 * **60 had silently drifted out of the barrel with nothing noticing.** A list
 * that has to be maintained in four places is the defect; deriving a better
 * list would have kept it.
 *
 * Consequences worth stating, because they are the point rather than side
 * effects:
 *
 * - A file has ONE `rules` array, so **exporting both a member array and an
 *   in-file aggregator of it is unrepresentable.** The four aggregators that
 *   used to do this (`cardRules`, `templateRules`, `recurrenceRules`,
 *   `threadCowriteRules`) are gone, and the "array in neither test mirror"
 *   category ceased to exist rather than gaining a guard.
 * - `propagation/mod.ts`'s import block and its `MODULES` array check each other for free:
 *   a name in `MODULES` but not imported is a compile error, and an import not
 *   in `MODULES` is a `deno lint` error. Only the directory listing itself
 *   needs a test.
 *
 * ⚠️ **Do NOT reach for a runtime glob (`Deno.readDir`) in `propagation/mod.ts` to close
 * that last gap** — this module is imported by the browser via manager and
 * over `https:` from JSR, where there is no directory to read and no `Deno`.
 * `src/` is platform-free by deliberate policy.
 */
export interface PropagationModule {
  /** Every CollectionRule declared in this file. */
  rules: CollectionRule[];
  /** Every TransactionDefinition declared in this file. May be empty. */
  transactions: TransactionDefinition[];
}

// ── Aggregate definition ────────────────────────────────────────────

/** DDD aggregate boundary — groups collections under one consistency root. */
export interface AggregateDefinition {
  /** Stable identifier (e.g. "order") */
  id: string;
  /** Root collection — the authoritative entry point (e.g. "orders") */
  root: string;
  /** Collections within this aggregate boundary */
  members: string[];
  /** What this aggregate represents */
  description: string;
}
