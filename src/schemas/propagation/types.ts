/**
 * Propagation type definitions.
 *
 * No triggers, no Cloud Functions, no writes.
 * The API imports these types when building Eventarc triggers.
 * The doc generator walks rules built from these types to produce Mermaid diagrams.
 */

// ── Propagation modes ───────────────────────────────────────────────

/** How a field value moves from one document to another. */
export type PropagationMode =
  | "embed"       // copied at creation, target owns it
  | "fan-out"     // source changes propagate to targets via events
  | "co-write"    // written atomically in same transaction
  | "derive"      // computed from other fields (can be same doc)
  | "reference";  // just a UID, resolved at read time

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
 * nine-member `as const`, causing 57 downstream type errors in manager, and
 * `tests/jsr-emit-safety.test.ts` bans only the *spread* form, so a non-spread
 * `as const` would pass the gate and still emit wrong (core#44). A hand-written
 * interface over plain `string` is the JSR-safe shape.
 */
export interface EnforcementRef {
  /** How the check works. `construction` = the shape makes violation unrepresentable. */
  kind: "audit" | "zod" | "assertion" | "test" | "construction";
  /** Repo-relative path, with `:line` where it pins a specific check. */
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
  /** Stable identifier (e.g. "products-to-webshop-fan-out") */
  id: string;
  /** Source collection */
  source: string;
  /** Target collection (can equal source for intra-document derive) */
  target: string;
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
  transaction?: string;
  /** What triggers this rule (for fan-out), e.g. "onUpdate:products" */
  trigger?: string;
  /** Field-level mappings — what data actually moves */
  fields: FieldMapping[];
}

// ── Transaction definition ──────────────────────────────────────────

/** Groups CollectionRules into a named atomic operation. */
export interface TransactionDefinition {
  /** Stable identifier (e.g. "create-order") */
  id: string;
  /** What this transaction does */
  description: string;
  /** Ordered CollectionRule IDs — the sequence of operations */
  steps: string[];
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
