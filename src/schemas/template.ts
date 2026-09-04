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
import { TemplateParamSchema, type TemplateParam } from "./template-version.ts";
import {
  ActorRef,
  type ActorRefType,
  FirestoreTimestamp,
  type FirestoreTimestampType,
  TimestampFields,
} from "./common.ts";

/** Collections that can serve as data sources for templates. */
/**
 * ⚠️ **`fulfillments` is a source but NOT a target.** A packing list is rendered
 * FROM a fulfillment and produced INTO `packing_lists`; nothing produces a
 * fulfillment document from a template. The two lists are deliberately not the
 * same set.
 *
 * 🔴 **`movement-sessions` is NOT a Firestore collection, and the field is
 * still called `collection_source`.** A receipt renders the fold of
 * `transactions where uuid_session == …` — one operator action — and nothing is
 * stored at that path (`schemas/movement-session.ts`, api-cloudrun#700). A
 * template source needs a *schema*, which it has
 * ({@link TEMPLATE_COLLECTION_SCHEMAS}); only fixture CAPTURE needs a document,
 * and that path branches. The field keeps its name deliberately: renaming it is
 * a STORED change across every `templates` document, every
 * `templates/<git_path>.meta.json` sidecar and the manager, which buys nothing
 * this docstring does not.
 *
 * 🔴 **`pick-sheets` is the SECOND source with no Firestore collection**, and it
 * is the first whose document spans MANY stored documents rather than folding
 * one. A multi-order packing list renders every open line at one destination or
 * with one organization, across orders (`schemas/pick-sheet.ts`), built by
 * api-cloudrun's `services/pickSheets.ts`. Same test as `movement-sessions`
 * above: a source needs a *schema*, not a path.
 *
 * ⚠️ **A `PickSheet` is PAGED and a printed document must not be.** `orders` is
 * one page; `order_count` and `quantity` describe the whole scope. The caller
 * that assembles the `doc` must walk every page before rendering — a short
 * document is indistinguishable from a small one once a template is running.
 * See `core/src/utils/pickSheets.ts`.
 */
export const TEMPLATE_SOURCE_COLLECTIONS = [
  "orders",
  "invoices",
  "fulfillments",
  "movement-sessions",
  "pick-sheets",
] as const;
/** Firestore collection that provides data to a template. */
export type TemplateSourceCollectionType = typeof TEMPLATE_SOURCE_COLLECTIONS[number];

/**
 * Collections that templates can produce documents for.
 *
 * `packing_lists` and `receipts` have no schema and no stored rows — a template
 * produces them, nothing computes over them, so {@link TEMPLATE_COLLECTION_SCHEMAS}
 * omits both and the generated field reference is `Partial` to match.
 */
export const TEMPLATE_TARGET_COLLECTIONS = [
  "quotes",
  "packing_lists",
  "invoices",
  "receipts",
] as const;
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
 * direction. ⚠️ **`params` makes a MISSING entry meaningful** in a way a
 * missing `description` never was: no entry means the fixture renders at the
 * family's declared defaults, which is a rendering rather than an absence.
 *
 * ⚠️ **`params` is here rather than in the golden's FILENAME, and the rule
 * behind that generalises** (api-cloudrun#608): a golden's filename may encode
 * only what is DERIVABLE from the family's own declaration — the render frame,
 * say, which the sidecar's `render` block already states. *Which* param states
 * are worth freezing is a CHOICE, and every other coverage choice already lives
 * in this manifest, because a fixture set is exactly a coverage argument.
 * Encoding it in the filename would break the one-golden-per-fixture parity
 * `lint-fixtures.ts` check 4 asserts, and would still need a second
 * declaration saying which states to gate — 2^N is not the answer.
 */
export interface FixtureMeta {
  /** Filename slug — the join key to `fixtures/<git_path>/<slug>.json`. */
  slug: string;
  /** Operator-facing label shown in the editor's fixture picker. */
  label: string;
  /** Why this fixture exists — what it covers that no other fixture does. */
  description: string;
  /**
   * The render-param state this fixture is rendered — and golden-gated — at.
   *
   * Absent means the family's declared defaults, which is what every fixture
   * did before this existed. Present, it is passed to `resolveRenderParams` as
   * the *provided* map, so it is validated strictly: a key the family does not
   * declare, or a non-boolean value, throws rather than being ignored.
   *
   * This is the ONLY way a non-default param state gets a golden. Without it a
   * param that selects half a document — the packing list's delivery/collection
   * leg — has that half ungated for the life of the family, and no threshold or
   * re-bless reaches it.
   */
  params?: Record<string, boolean>;
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
  // Optional and additive, which is what makes the rollout readers-first: every
  // stored family's `fixtures[]` predates this and stays valid. The reverse
  // order would not work — `TemplateSchema` is strict like all of them, so a
  // sidecar carrying this field fails the family write outright until every
  // reader is on a version that declares it (api-cloudrun#443's failure class).
  params: z.record(z.string(), z.boolean()).optional(),
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
  /**
   * Render params declared by the family's ACTIVE published version, projected
   * from the git sidecar. A COPY — the version doc is authoritative and
   * `renderDocument` resolves against it — carried here so a client that
   * already holds the family can offer a param picker with no extra read.
   * `publishFromMerge` writes family and version from one resolved value, so
   * `family.params === activeVersion.params` holds by construction.
   *
   * ⚠️ This is the DECLARATION (an array of `{key, type, label?, default?}`).
   * The value map a document records — `Quote.params`, `Invoice.pdf_params`,
   * `pdf_versions[].params` — is a `Record<string, boolean>`. Different things,
   * different shapes.
   */
  params: TemplateParam[];
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
  // Required and no `.default([])`: `publishFromMerge` is the sole writer and
  // stamps it from the same resolved value it puts on the version doc.
  params: z.array(TemplateParamSchema),
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
