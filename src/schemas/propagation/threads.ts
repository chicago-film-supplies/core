/**
 * Threads & comments propagation rules.
 *
 * On every create-<X> transaction we cowrite a default `threads` doc for the
 * parent and embed the thread's `uid` back onto the parent as `defaultThreadId`.
 * Event cards (see propagation/cards.ts) get two sources (the card + its parent order) so the
 * thread surfaces on both detail pages.
 *
 * Comments derive thread counters (`comment_count`, `last_message_at`,
 * `last_message_preview`) and embed the parent thread's `sources` so comments
 * can be queried by source doc without a thread join.
 *
 * **Delete cascade — deferred.** Few delete endpoints exist today. When a
 * delete path is built for any of the 8 source entities, that PR owns wiring
 * the thread cascade (remove the source from `thread.sources[]`; if empty,
 * hard-delete thread + comments). Transactional with the parent delete.
 */
import type { CollectionRule, TransactionDefinition } from "./types.ts";

// ── Cowrite helper ──────────────────────────────────────────────────

interface ThreadCowriteConfig {
  /** Plural Firestore collection name of the source doc. */
  collection: string;
  /** Transaction id in which the cowrite fires. */
  transaction: string;
}

/** Build the cowrite-thread + back-embed rules for one source entity. */
function cowriteRulesFor({ collection, transaction }: ThreadCowriteConfig): CollectionRule[] {
  return [
    {
      id: `cowrite-thread:${collection}-to-thread`,
      source: collection,
      target: "threads",
      mode: "co-write",
      invariant: `Every ${collection} doc gets a default thread cowritten on creation so the manager's Notes tab always has a target`,
      transaction,
      fields: [
        { source: ["uid"], target: ["sources", "uid"] },
        { source: [], target: ["sources", "collection"], transform: `literal "${collection}"` },
        { source: [], target: ["created_by"], transform: "ActorRef of acting user from session ({uid, name})" },
        { source: [], target: ["title"], transform: "null — default thread" },
        { source: [], target: ["comment_count"], transform: "0" },
      ],
    },
    {
      id: `cowrite-thread:thread-to-${collection}`,
      source: "threads",
      target: collection,
      mode: "embed",
      invariant: `The cowritten thread's uid is embedded on the parent ${collection} doc so the detail view can resolve its default thread without a query`,
      transaction,
      fields: [
        { source: ["uid"], target: ["defaultThreadId"] },
      ],
    },
  ];
}

// ── Per-entity rules ────────────────────────────────────────────────

export const threadOrderRules: CollectionRule[] = cowriteRulesFor({
  collection: "orders",
  transaction: "create-order",
});

export const threadInvoiceRules: CollectionRule[] = cowriteRulesFor({
  collection: "invoices",
  transaction: "create-invoice",
});

export const threadContactRules: CollectionRule[] = cowriteRulesFor({
  collection: "contacts",
  transaction: "create-contact",
});

export const threadOrganizationRules: CollectionRule[] = cowriteRulesFor({
  collection: "organizations",
  transaction: "create-organization",
});

export const threadProductRules: CollectionRule[] = cowriteRulesFor({
  collection: "products",
  transaction: "create-product",
});

export const threadTransactionRules: CollectionRule[] = cowriteRulesFor({
  collection: "transactions",
  transaction: "create-transaction",
});

export const threadOutOfServiceRules: CollectionRule[] = cowriteRulesFor({
  collection: "out-of-service",
  transaction: "create-out-of-service-record",
});

// ── Role transaction (new — role creation is promoted to a transaction) ─

export const threadRoleRules: CollectionRule[] = cowriteRulesFor({
  collection: "roles",
  transaction: "create-role",
});

/**
 * `create-role` is a new named transaction introduced with Threads Phase 1 —
 * role creation was a direct `ref.set(role)` before, promoted to a Firestore
 * transaction so the cowrite of the default thread happens atomically.
 */
export const createRoleTransaction: TransactionDefinition = {
  id: "create-role",
  description: "Creates a role document and cowrites its default thread so the role detail view can start accepting comments immediately.",
  steps: [
    "cowrite-thread:roles-to-thread",
    "cowrite-thread:thread-to-roles",
  ],
};

// ── Flat exports for propagation/mod.ts consolidation ──────────────

/** All create-<X> cowrite rules across every entity that gets a default thread. */
export const threadCowriteRules: CollectionRule[] = [
  ...threadOrderRules,
  ...threadInvoiceRules,
  ...threadContactRules,
  ...threadOrganizationRules,
  ...threadProductRules,
  ...threadTransactionRules,
  ...threadRoleRules,
  ...threadOutOfServiceRules,
];

// ── create-comment transaction ──────────────────────────────────────

export const createCommentRules: CollectionRule[] = [
  {
    id: "create-comment:thread-to-comment",
    source: "threads",
    target: "comments",
    mode: "embed",
    invariant: "Comments carry a denormalized copy of the parent thread's sources so they can be queried by source doc without a thread join (for Typesense and direct Firestore queries)",
    transaction: "create-comment",
    fields: [
      { source: ["sources"], target: ["sources"], transform: "full copy of thread.sources[] — {collection, uid} entries" },
    ],
  },
  {
    id: "create-comment:comment-to-thread",
    source: "comments",
    target: "threads",
    mode: "derive",
    invariant: "Every comment write bumps the parent thread's comment_count (soft-deletes excluded) and refreshes last_message_at and last_message_preview so the thread list renders without a per-thread subquery",
    transaction: "create-comment",
    fields: [
      { source: [], target: ["comment_count"], transform: "FieldValue.increment(1) — undone by soft delete" },
      { source: ["created_at"], target: ["last_message_at"] },
      { source: ["body_text"], target: ["last_message_preview"], transform: "truncate to 280 chars" },
    ],
  },
];

export const createCommentTransaction: TransactionDefinition = {
  id: "create-comment",
  description: "Creates a comment attached to a thread, embedding the thread's sources on the comment and deriving the parent thread's counter and preview fields.",
  steps: [
    "create-comment:thread-to-comment",
    "create-comment:comment-to-thread",
  ],
};
