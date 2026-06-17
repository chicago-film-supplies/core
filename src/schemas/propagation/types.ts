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
