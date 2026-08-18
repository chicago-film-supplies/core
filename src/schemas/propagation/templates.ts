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
import type {
  CollectionRule,
  EnforcementRef,
  PropagationModule,
  TransactionDefinition,
} from "./types.ts";

// ── What checks these rules ─────────────────────────────────────────
//
// The publish path is the best-covered surface in this file, and one clause is
// deliberately covered at the UNIT level instead: the S3 monotonic guard. Its
// own suite header explains why — `seq` is globally monotonic, so integration
// cannot construct the regression it defends against, and asserting on a
// constructed one would be asserting on a state the system cannot reach.

const FAMILY_REGISTER_COWRITES_THREAD: EnforcementRef = {
  kind: "test",
  ref:
    "api-cloudrun/tests/integration/templates/publish.test.ts::publishResolvedTemplates: register → family + version + thread",
  clause:
    "the cowrite at register — family + version + thread land together, and the dual-uniqueness 409s that guard the family are asserted on the draft path (`drafts.test.ts::POST /templates — register family + thread, dual-uniqueness 409s`). Runs in `deno task test` (pre-push), not the hermetic CI gate.",
  gates: true,
};

/**
 * The `uid_thread` back-embed is also unrepresentable-if-absent on the family:
 * the schema requires it, so a family written without one is a rejected write
 * rather than a family whose Notes tab silently has no target.
 */
const FAMILY_THREAD_POINTER_REQUIRED: EnforcementRef = {
  kind: "zod",
  ref: "core/src/schemas/template.ts::uid_thread: FirestoreId",
  clause:
    "the back-embed's presence — `uid_thread` is required on the family document, so a register that failed to cowrite the thread cannot produce a valid family. Says nothing about whether the uid RESOLVES.",
  gates: true,
};

const DRAFT_ROLLUP: EnforcementRef = {
  kind: "test",
  ref:
    "api-cloudrun/tests/integration/templates/drafts.test.ts::POST /templates-versions/{uid}/abandon — draft → archived, removed from draft_uids",
  clause:
    "both directions of `draft_uids[]` — abandoning archives the version AND removes it from the rollup, and a publish on a draft's branch flips the version in place and cleans the rollup (`publish.test.ts::publishResolvedTemplates: publish on a draft's branch flips it in place + cleans draft_uids`). The component family gets the same pair (`components.test.ts::abandon a COMPONENT draft → archived + dropped from the component family rollup`).",
  gates: true,
};

const PUBLISH_SEQ: EnforcementRef = {
  kind: "test",
  ref:
    "api-cloudrun/tests/integration/templates/publish.test.ts::publishResolvedTemplates: second publish advances version_count + seq + uid_active",
  clause:
    "the counter's forward motion and its self-heal — a second publish advances `version_count`, `seq` and `uid_active`, and a lagging counter is seeded from the max active seq rather than silently refusing the flip, in the sibling test `publishResolvedTemplates: seeds seq from max active seq when the counter lags (#191 §4 self-heal)`. Concurrency is not constructed here; the counter increment is inside the publish transaction.",
  gates: true,
};

const VERSION_FLIP: EnforcementRef = {
  kind: "test",
  ref:
    "api-cloudrun/tests/integration/templates/publish.test.ts::publishResolvedTemplates: publish on a draft's branch flips it in place + cleans draft_uids",
  clause:
    "the in-place flip and its idempotence — a publish on a draft's branch flips the SAME version doc draft→published, and sibling tests carry the rest — `publishResolvedTemplates: idempotent re-publish (same sha) is a noop`, `publishResolvedTemplates: metadata-only diff projects identity without a version bump`, and `publishResolvedTemplates: metadata-only redelivery is a no-op`.",
  gates: true,
};

/**
 * ⚠️ The S3 MONOTONIC clause — "repoints `uid_active` ONLY if its `seq` beats
 * the current active version's" — is asserted at the unit level, not here, and
 * that is the suite's stated reasoning rather than an omission: `seq` is
 * globally monotonic, so an out-of-order delivery cannot be constructed in
 * integration.
 */
const FAMILY_ROLLUP: EnforcementRef = {
  kind: "test",
  ref:
    "api-cloudrun/tests/integration/templates/publish.test.ts::publishResolvedTemplates: second publish advances version_count + seq + uid_active",
  clause:
    "the rollup's fields — `uid_active` repointed, `version_count` incremented, the version dropped from `draft_uids[]`, and the archive path nulling `uid_active` while archiving the active version, in the sibling test `publishResolvedTemplates: archive nulls uid_active + archives the active version`. The S3 monotonic COMPARISON is asserted at the unit level instead; the integration suite's own header records that it cannot construct a regression because `seq` is globally monotonic.",
  gates: true,
};

// ── create-template (family + default thread cowrite) ───────────────

const createTemplateRules: CollectionRule[] = [
  {
    id: "create-template:thread",
    source: "templates",
    target: "threads",
    mode: "co-write",
    invariant:
      "Registering a template family cowrites a default thread keyed to the family uid so the family's chat/notes surface always has a target. The thread is excluded from git rebuilds (it is conversation state, not template content).",
    enforced_by: [FAMILY_REGISTER_COWRITES_THREAD],
    transaction: "create-template",
    fields: [
      {
        source: ["uid"],
        target: ["sources", "uid"],
        transform: "sources[0] — the family itself",
      },
      {
        source: [],
        target: ["sources", "collection"],
        transform: `literal "templates"`,
      },
      {
        source: [],
        target: ["created_by"],
        transform: "ActorRef of acting user from session",
      },
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
    enforced_by: [
      FAMILY_THREAD_POINTER_REQUIRED,
      FAMILY_REGISTER_COWRITES_THREAD,
    ],
    transaction: "create-template",
    fields: [
      { source: ["uid"], target: ["uid_thread"] },
    ],
  },
];

const createTemplateTransaction: TransactionDefinition = {
  id: "create-template",
  description:
    "Registers a template family and cowrites its default thread so the family's chat surface can accept comments immediately.",
  steps: [
    "create-template:thread",
    "create-template:thread-to-family",
  ],
};

// ── manage-draft (draft_uids rollup) ────────────────────────────────

const manageDraftRules: CollectionRule[] = [
  {
    id: "manage-draft:family-rollup",
    source: "templates-versions",
    target: "templates",
    mode: "derive",
    invariant:
      "Creating a draft version adds its uid to the family's `draft_uids[]`; abandoning (archive) removes it. Keeps the family doc's in-flight-work rollup current without a per-family subquery.",
    enforced_by: [DRAFT_ROLLUP],
    transaction: "manage-draft",
    fields: [
      {
        source: ["uid"],
        target: ["draft_uids"],
        transform: "arrayUnion on create / arrayRemove on archive",
      },
    ],
  },
  {
    // ⚠️ A SECOND rule rather than a widened target, because `target` names ONE
    // collection. The writer resolves the owning family by kind and rolls up
    // into `templates` OR `template-components` — never both — so exactly one of
    // this pair fires per run. `DRAFT_ROLLUP`'s clause already named the
    // component half ("components.test.ts:189"); only the declaration was
    // missing, which is why the test could pass while the catalog was silent.
    id: "manage-draft:component-family-rollup",
    source: "templates-versions",
    target: "template-components",
    mode: "derive",
    invariant:
      "The same draft_uids[] rollup as `manage-draft:family-rollup`, for a version whose owning family is a COMPONENT family rather than a template family. Exactly one of the two fires per run, decided by the resolved family's kind.",
    enforced_by: [DRAFT_ROLLUP],
    transaction: "manage-draft",
    fields: [
      {
        source: ["uid"],
        target: ["draft_uids"],
        transform: "arrayUnion on create / arrayRemove on archive",
      },
    ],
  },
  {
    // Measured undeclared in prod 2026-08-17: `manage-draft` wrote `threads` 5
    // times in 30 days against a definition declaring only `templates`. The
    // record's own hand-written `target_counts` said `threads: 1` at the call
    // site — the gap was written down beside `rules_fired` and nothing compared
    // the two.
    id: "manage-draft:version-to-thread",
    source: "templates-versions",
    target: "threads",
    mode: "co-write",
    invariant:
      "Creating a draft TEMPLATE version cowrites a per-branch comment thread carrying TWO sources — the version first (primary/identity) and the owning family second — so one family-scoped feed surfaces every version's branch thread. Component versions get no thread: components are not a chat surface.",
    enforced_by: [DRAFT_ROLLUP],
    transaction: "manage-draft",
    fields: [
      {
        source: ["uid"],
        target: ["sources", "uid"],
        transform: "sources[0] — the draft version",
      },
      {
        source: [],
        target: ["sources", "collection"],
        transform:
          `literal "templates-versions", then the family as sources[1]`,
      },
      {
        source: [],
        target: ["created_by"],
        transform: "ActorRef of acting user from session",
      },
      { source: [], target: ["title"], transform: "null — default thread" },
      { source: [], target: ["comment_count"], transform: "0" },
    ],
  },
  {
    id: "manage-draft:thread-to-version",
    source: "threads",
    target: "templates-versions",
    mode: "embed",
    invariant:
      "The cowritten branch thread's uid is embedded on the draft version as `uid_thread` so the draft surface resolves its thread without a query. Optional on the schema, because a component version legitimately has none — so `validateBeforeWrite` cannot see a template version that lost its pointer.",
    enforced_by: [DRAFT_ROLLUP],
    transaction: "manage-draft",
    fields: [
      { source: ["uid"], target: ["uid_thread"] },
    ],
  },
];

const manageDraftTransaction: TransactionDefinition = {
  id: "manage-draft",
  description:
    "Creates or abandons a draft template version, maintaining the family's draft_uids[] rollup atomically with the version write.",
  steps: [
    "manage-draft:family-rollup",
    "manage-draft:component-family-rollup",
    "manage-draft:version-to-thread",
    "manage-draft:thread-to-version",
  ],
};

// ── publish-template (merge → published flip) ───────────────────────

const publishTemplateRules: CollectionRule[] = [
  {
    id: "publish-template:seq",
    source: "counters",
    target: "templates-versions",
    mode: "co-write",
    invariant:
      "Each publish increments `counters/templates-publish-seq` and stamps the new value as the version's monotonic `seq`. Computed inside the publish transaction so concurrent merges get distinct, ordered seqs.",
    enforced_by: [PUBLISH_SEQ],
    transaction: "publish-template",
    fields: [
      {
        source: ["count"],
        target: ["seq"],
        transform: "FieldValue.increment(1) → stamped as version.seq",
      },
    ],
  },
  {
    id: "publish-template:version-flip",
    source: "templates-versions",
    target: "templates-versions",
    mode: "derive",
    invariant:
      "A squash-merge flips the SAME version doc draft→published in place. `content` + `blob_refs` are read from the merged git SHA (never the draft doc — C1) and resolved OUTSIDE the transaction (B1); the txn body stamps `sha`/`semver`/`seq`/`commit_meta` and clears the draft branch fields. CAS on `version`.",
    enforced_by: [VERSION_FLIP],
    transaction: "publish-template",
    fields: [
      { source: [], target: ["status"], transform: `draft → "published"` },
      {
        source: [],
        target: ["sha"],
        transform: "merged commit SHA (resolved outside txn)",
      },
      {
        source: [],
        target: ["semver"],
        transform:
          "deriveBump(commit_meta.type, breaking) applied to the family's last semver",
      },
      {
        source: [],
        target: ["commit_meta"],
        transform: "conventional-commit metadata from the merged PR",
      },
      {
        source: [],
        target: ["content"],
        transform: "full content map read from the merged SHA's blobs",
      },
    ],
  },
  {
    id: "publish-template:family-rollup",
    source: "templates-versions",
    target: "templates",
    mode: "derive",
    invariant:
      "On publish, the family repoints `uid_active` to the newly published version ONLY if its `seq` beats the current active version's seq (S3 monotonic — out-of-order webhook deliveries never regress active), increments `version_count`, sets `last_published_at`, and removes the version from `draft_uids[]`. CAS on the family `version`.",
    enforced_by: [FAMILY_ROLLUP],
    transaction: "publish-template",
    fields: [
      {
        source: ["uid"],
        target: ["uid_active"],
        transform: "repoint only if newSeq > active.seq",
      },
      {
        source: [],
        target: ["version_count"],
        transform: "FieldValue.increment(1)",
      },
      {
        source: [],
        target: ["last_published_at"],
        transform: "publish timestamp",
      },
      {
        source: ["uid"],
        target: ["draft_uids"],
        transform: "arrayRemove — no longer a draft",
      },
    ],
  },
  {
    // The component-family twin of the rollup above — same reason as
    // `manage-draft:component-family-rollup`: `target` names one collection and
    // the writer picks by family kind. Measured in dev 2026-08-17,
    // `publish-template` wrote `template-components` 20 times in 30 days.
    id: "publish-template:component-family-rollup",
    source: "templates-versions",
    target: "template-components",
    mode: "derive",
    invariant:
      "The same monotonic-by-seq active repoint, version_count increment and draft_uids[] removal as `publish-template:family-rollup`, for a version owned by a COMPONENT family. Exactly one of the two fires per publish.",
    enforced_by: [FAMILY_ROLLUP],
    transaction: "publish-template",
    fields: [
      {
        source: ["uid"],
        target: ["uid_active"],
        transform: "repoint only if newSeq > active.seq",
      },
      {
        source: [],
        target: ["version_count"],
        transform: "FieldValue.increment(1)",
      },
      {
        source: [],
        target: ["last_published_at"],
        transform: "publish timestamp",
      },
      {
        source: ["uid"],
        target: ["draft_uids"],
        transform: "arrayRemove — no longer a draft",
      },
    ],
  },
];

const publishTemplateTransaction: TransactionDefinition = {
  id: "publish-template",
  description:
    "Flips a merged draft version to published (content read from the merged git SHA, blobs resolved outside the txn), stamps sha/semver/seq, and repoints the family's uid_active monotonically by seq.",
  steps: [
    "publish-template:seq",
    "publish-template:version-flip",
    "publish-template:family-rollup",
    "publish-template:component-family-rollup",
  ],
};
// ── Module ──────────────────────────────────────────────────────────
/** Everything `templates.ts` contributes to the propagation catalog. */
export const templates: PropagationModule = {
  rules: [
    ...createTemplateRules,
    ...manageDraftRules,
    ...publishTemplateRules,
  ],
  transactions: [
    createTemplateTransaction,
    manageDraftTransaction,
    publishTemplateTransaction,
  ],
};
