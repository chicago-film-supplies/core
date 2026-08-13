/**
 * Template family document schema — Firestore collection: templates
 *
 * **Git-canonical system.** A `templates` doc is a *thin family* record: it
 * carries identity + rollups but NO content and NO status. Content lives in
 * git (source of truth) and is projected into `templates-versions` docs (see
 * `template-version.ts`). The family doc is fully rebuildable from git — its
 * mutable display fields (`name`, `surfaces`, target/source) mirror the
 * version-controlled sidecar `*.meta.json` (renames are metadata-only PRs).
 *
 * Identity:
 * - `uid` — generated, stable doc id ([[feedback_generated_uids_everywhere]]).
 * - `git_path` — immutable slug `slugify(name)` frozen at create; the family's
 *   identity in git. Permanently reserved even after archive (S5).
 *
 * "Active" is a pointer (`uid_active` → the current published version), never a
 * status. Lifecycle mirrors git: a draft branch merges → the SAME version doc
 * flips `draft → published` in place; an abandoned draft becomes `archived`.
 */
import { z } from "zod";
import { FirestoreId } from "./_uid.ts";
import {
  ActorRef,
  type ActorRefType,
  FirestoreTimestamp,
  type FirestoreTimestampType,
  TimestampFields,
} from "./common.ts";

/** Collections that can serve as data sources for templates. */
export const TEMPLATE_SOURCE_COLLECTIONS = ["orders", "invoices"] as const;
/** Firestore collection that provides data to a template. */
export type TemplateSourceCollectionType = typeof TEMPLATE_SOURCE_COLLECTIONS[number];

/** Collections that templates can produce documents for. */
export const TEMPLATE_TARGET_COLLECTIONS = ["quotes", "packing_lists", "invoices"] as const;
/** Firestore collection that a template produces documents for. */
export type TemplateTargetCollectionType = typeof TEMPLATE_TARGET_COLLECTIONS[number];

/**
 * Client-agnostic detail surfaces where a template family is offered. NOT route
 * strings — clients map a surface to their own route (e.g. manager binds
 * `"order"` → `/orders/:id`). A packing list might surface on both `"order"`
 * and `"fulfillment"`; a quote only on `"order"`.
 */
export const TEMPLATE_SURFACES = ["order", "fulfillment", "invoice"] as const;
/** A single client-agnostic surface a template is offered on. */
export type TemplateSurfaceType = typeof TEMPLATE_SURFACES[number];

/** Component dependencies a template family overlays at render time. */
export interface TemplateDependsOn {
  /** Component family uids (template-components) whose active versions overlay this template. */
  components: string[];
}

/**
 * A fixture manifest entry for one git-canonical fixture
 * (`fixtures/<git_path>/<slug>.json`).
 *
 * **The manifest carries the fixture's REASON**; the label is the incidental
 * half. A fixture set is a coverage argument — each file exists to exercise
 * something the others do not — and that argument lives nowhere else: the
 * fixture file itself is a `z.strictObject` source document with no room for a
 * comment, so an undescribed fixture is one whose purpose is unrecoverable
 * without diffing it against every sibling. That is why `description` is
 * required rather than optional.
 *
 * Files remain authoritative for *discovery*: every reader globs the directory
 * and left-joins this manifest, so an orphaned entry (slug with no matching
 * file) is ignored at render/golden time and never breaks a render. The
 * `templates` repo's `lint-fixtures.ts` is what fails drift in either
 * direction.
 */
export interface FixtureMeta {
  /** Filename slug — the join key to `fixtures/<git_path>/<slug>.json`. */
  slug: string;
  /** Operator-facing label shown in the editor's fixture picker. */
  label: string;
  /** Why this fixture exists — what it covers that no other fixture does. */
  description: string;
}

/** Zod schema for a fixture manifest entry. */
export const FixtureMetaSchema: z.ZodType<FixtureMeta> = z.strictObject({
  slug: z.string().min(1).max(100),
  label: z.string().min(1).max(200),
  // Required, and `.min(1)` so an empty string cannot stand in for the reason.
  // `pii: "none"` is the explicit classification: this is prose about a
  // template's coverage, never customer data (the fixture *document* is where
  // PII would live, and that is sanitized on capture by `applyPii`).
  description: z.string().min(1).max(2000).meta({ pii: "none" }),
});

/** A thin template *family* document — identity + rollups, no content/status. */
export interface Template {
  uid: string;
  /** Immutable slug `slugify(name)`, frozen at create — the family's git identity. */
  git_path: string;
  /** Mutable display name (mirrors the sidecar `display_name`; rename = metadata PR). */
  name: string;
  collection_source: TemplateSourceCollectionType;
  collection_target: TemplateTargetCollectionType;
  surfaces: TemplateSurfaceType[];
  /** uid of the current published version, or null until the first merge. */
  uid_active: string | null;
  /** Rollup: semver of the active published version, or null until first publish.
   * Lets consumers show current→predicted without fetching the active version. */
  active_semver?: string | null;
  depends_on: TemplateDependsOn;
  /** Operator-managed fixture manifest, projected from the sidecar
   * `fixtures: [{slug, label, description}]`. Files in `fixtures/<git_path>/`
   * are authoritative for discovery — this list carries each fixture's reason
   * (see {@link FixtureMeta}). Defaults to `[]` for a never-captured family. */
  fixtures: FixtureMeta[];
  /** Rollup: uids of versions currently in `draft` status. */
  draft_uids: string[];
  /** Rollup: total versions ever published in this family. */
  version_count: number;
  /** Rollup: when the family last had a version published. */
  last_published_at: FirestoreTimestampType | null;
  /** uid of the family's default thread (cowritten on create). */
  uid_thread: string;
  /** Optimistic-concurrency token. */
  version: number;
  created_by: ActorRefType;
  updated_by: ActorRefType;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}

/** Zod schema for a Template family document. */
export const TemplateSchema: z.ZodType<Template> = z.strictObject({
  uid: FirestoreId,
  git_path: z.string().min(1).max(200).meta({ column: true, label: "Path" }),
  name: z.string().min(1).max(200).meta({ column: true, label: "Name", linkTo: "templateDetail" }),
  collection_source: z.enum(TEMPLATE_SOURCE_COLLECTIONS).meta({ column: true, label: "Source" }),
  collection_target: z.enum(TEMPLATE_TARGET_COLLECTIONS).meta({ column: true, label: "Target" }),
  surfaces: z.array(z.enum(TEMPLATE_SURFACES)).min(1).meta({ column: true, label: "Surfaces" }),
  uid_active: FirestoreId.nullable(),
  active_semver: z.string().nullable().default(null),
  depends_on: z.strictObject({
    components: z.array(z.string()).default([]),
  }),
  fixtures: z.array(FixtureMetaSchema).default([]),
  draft_uids: z.array(FirestoreId).default([]),
  // `version_count` and `version` are required (no `.default(0)`): the
  // Typesense config declares both so, and a `.default()` never materializes
  // on a write — see the note in `product.ts`.
  version_count: z.int().min(0).meta({ column: true, label: "Versions" }),
  last_published_at: FirestoreTimestamp.nullable().meta({ column: true, label: "Last Published" }),
  uid_thread: FirestoreId,
  version: z.int().min(0),
  created_by: ActorRef.meta({ column: true, label: "Created By" }),
  updated_by: ActorRef.meta({ column: true, label: "Updated By" }),
  ...TimestampFields,
}).meta({
  title: "Template",
  collection: "templates",
  displayDefaults: {
    columns: ["name", "collection_source", "collection_target", "surfaces"],
    filters: {},
    sort: { column: "name", direction: "asc" },
  },
});

/**
 * Input for registering a new template *family*. Content is not provided here —
 * registration creates the family doc + a git branch carrying the sidecar; the
 * server derives `git_path = slugify(name)` and freezes it.
 */
export interface TemplateInputType {
  name: string;
  collection_source: TemplateSourceCollectionType;
  collection_target: TemplateTargetCollectionType;
  surfaces: TemplateSurfaceType[];
  depends_on?: Partial<TemplateDependsOn>;
}

/** Zod schema for TemplateInput. */
export const TemplateInputSchema: z.ZodType<TemplateInputType> = z.object({
  name: z.string().min(1).max(200),
  collection_source: z.enum(TEMPLATE_SOURCE_COLLECTIONS),
  collection_target: z.enum(TEMPLATE_TARGET_COLLECTIONS),
  surfaces: z.array(z.enum(TEMPLATE_SURFACES)).min(1),
  depends_on: z.object({
    components: z.array(z.string()).optional(),
  }).optional(),
});

/** Context object passed to Eta templates at render time. */
export interface TemplateContext {
  doc: Record<string, unknown>;
  version?: number | null;
  logo?: string;
  /** Resolved render-time parameters (declared by the version, validated strict). */
  params?: Record<string, unknown>;
}
