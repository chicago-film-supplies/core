/**
 * Template (git-canonical) propagation rules.
 *
 * Three transactions describe the data flow of the template lifecycle:
 *
 * - `create-template` — registering a family cowrites its default thread (so the
 *   per-family chat surface has a target) and embeds the thread uid back on the
 *   family. Same cowrite pattern as cards/orders (see `propagation/threads.ts`).
 * - `manage-draft` — creating/abandoning a draft version maintains the family's
 *   `draft_uids[]` rollup so the family doc reflects in-flight work without a
 *   per-family subquery.
 * - `publish-template` — a squash-merge flips the SAME version doc
 *   `draft → published` in place (content read from the merged git SHA, never
 *   the draft doc — red-team C1), stamps `sha`/`semver`/`seq` (seq from the
 *   `counters/templates-publish-seq` counter), and repoints the family's
 *   `uid_active` **only if the new seq beats the active version's seq** (S3
 *   monotonic). `publishFromMerge.ts` must call
 *   `logTransactionPropagation("publish-template", …)` once this lands.
 */
import type { CollectionRule, TransactionDefinition } from "./types.ts";

// ── create-template (family + default thread cowrite) ───────────────

export const createTemplateRules: CollectionRule[] = [
  {
    id: "create-template:thread",
    source: "templates",
    target: "threads",
    mode: "co-write",
    invariant:
      "Registering a template family cowrites a default thread keyed to the family uid so the family's chat/notes surface always has a target. The thread is excluded from git rebuilds (it is conversation state, not template content).",
    transaction: "create-template",
    fields: [
      { source: ["uid"], target: ["sources", "uid"], transform: "sources[0] — the family itself" },
      { source: [], target: ["sources", "collection"], transform: `literal "templates"` },
      { source: [], target: ["created_by"], transform: "ActorRef of acting user from session" },
      { source: [], target: ["title"], transform: "null — default thread" },
      { source: [], target: ["comment_count"], transform: "0" },
    ],
  },
  {
    id: "create-template:thread-to-family",
    source: "threads",
    target: "templates",
    mode: "embed",
    invariant:
      "The cowritten thread's uid is embedded on the family as `uid_thread` so the detail surface resolves its default thread without a query.",
    transaction: "create-template",
    fields: [
      { source: ["uid"], target: ["uid_thread"] },
    ],
  },
];

export const createTemplateTransaction: TransactionDefinition = {
  id: "create-template",
  description:
    "Registers a template family and cowrites its default thread so the family's chat surface can accept comments immediately.",
  steps: [
    "create-template:thread",
    "create-template:thread-to-family",
  ],
};

// ── manage-draft (draft_uids rollup) ────────────────────────────────

export const manageDraftRules: CollectionRule[] = [
  {
    id: "manage-draft:family-rollup",
    source: "templates-versions",
    target: "templates",
    mode: "derive",
    invariant:
      "Creating a draft version adds its uid to the family's `draft_uids[]`; abandoning (archive) removes it. Keeps the family doc's in-flight-work rollup current without a per-family subquery.",
    transaction: "manage-draft",
    fields: [
      { source: ["uid"], target: ["draft_uids"], transform: "arrayUnion on create / arrayRemove on archive" },
    ],
  },
];

export const manageDraftTransaction: TransactionDefinition = {
  id: "manage-draft",
  description:
    "Creates or abandons a draft template version, maintaining the family's draft_uids[] rollup atomically with the version write.",
  steps: [
    "manage-draft:family-rollup",
  ],
};

// ── publish-template (merge → published flip) ───────────────────────

export const publishTemplateRules: CollectionRule[] = [
  {
    id: "publish-template:seq",
    source: "counters",
    target: "templates-versions",
    mode: "co-write",
    invariant:
      "Each publish increments `counters/templates-publish-seq` and stamps the new value as the version's monotonic `seq`. Computed inside the publish transaction so concurrent merges get distinct, ordered seqs.",
    transaction: "publish-template",
    fields: [
      { source: ["count"], target: ["seq"], transform: "FieldValue.increment(1) → stamped as version.seq" },
    ],
  },
  {
    id: "publish-template:version-flip",
    source: "templates-versions",
    target: "templates-versions",
    mode: "derive",
    invariant:
      "A squash-merge flips the SAME version doc draft→published in place. `content` + `blob_refs` are read from the merged git SHA (never the draft doc — C1) and resolved OUTSIDE the transaction (B1); the txn body stamps `sha`/`semver`/`seq`/`commit_meta` and clears the draft branch fields. CAS on `version`.",
    transaction: "publish-template",
    fields: [
      { source: [], target: ["status"], transform: `draft → "published"` },
      { source: [], target: ["sha"], transform: "merged commit SHA (resolved outside txn)" },
      { source: [], target: ["semver"], transform: "deriveBump(commit_meta.type, breaking) applied to the family's last semver" },
      { source: [], target: ["commit_meta"], transform: "conventional-commit metadata from the merged PR" },
      { source: [], target: ["content"], transform: "full content map read from the merged SHA's blobs" },
    ],
  },
  {
    id: "publish-template:family-rollup",
    source: "templates-versions",
    target: "templates",
    mode: "derive",
    invariant:
      "On publish, the family repoints `uid_active` to the newly published version ONLY if its `seq` beats the current active version's seq (S3 monotonic — out-of-order webhook deliveries never regress active), increments `version_count`, sets `last_published_at`, and removes the version from `draft_uids[]`. CAS on the family `version`.",
    transaction: "publish-template",
    fields: [
      { source: ["uid"], target: ["uid_active"], transform: "repoint only if newSeq > active.seq" },
      { source: [], target: ["version_count"], transform: "FieldValue.increment(1)" },
      { source: [], target: ["last_published_at"], transform: "publish timestamp" },
      { source: ["uid"], target: ["draft_uids"], transform: "arrayRemove — no longer a draft" },
    ],
  },
];

export const publishTemplateTransaction: TransactionDefinition = {
  id: "publish-template",
  description:
    "Flips a merged draft version to published (content read from the merged git SHA, blobs resolved outside the txn), stamps sha/semver/seq, and repoints the family's uid_active monotonically by seq.",
  steps: [
    "publish-template:seq",
    "publish-template:version-flip",
    "publish-template:family-rollup",
  ],
};

// ── Flat exports ────────────────────────────────────────────────────

/** All template-related propagation rules. */
export const templateRules: CollectionRule[] = [
  ...createTemplateRules,
  ...manageDraftRules,
  ...publishTemplateRules,
];
