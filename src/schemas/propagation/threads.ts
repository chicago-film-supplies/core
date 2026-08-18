/**
 * Threads & comments propagation rules.
 *
 * On every create-<X> transaction we cowrite a default `threads` doc for the
 * parent and embed the thread's `uid` back onto the parent as `uid_thread`.
 * Event cards (see propagation/cards.ts) get two sources (the card + its parent order) so the
 * thread surfaces on both detail pages.
 *
 * Comments derive thread counters (`comment_count`, `last_message_at`,
 * `last_message_preview`) and embed the parent thread's `sources` so comments
 * can be queried by source doc without a thread join.
 *
 * **Delete cascade — deferred.** Few delete endpoints exist today. When a
 * delete path is built for any of the 9 source entities, that PR owns wiring
 * the thread cascade (remove the source from `thread.sources[]`; if empty,
 * hard-delete thread + comments). Transactional with the parent delete.
 */
import type {
  CollectionRule,
  EnforcementRef,
  PropagationModule,
  TransactionDefinition,
} from "./types.ts";
import type { TransactionId } from "./ids.ts";

// ── Cowrite helper ──────────────────────────────────────────────────

/**
 * The eight source entities that get a default thread cowritten here.
 *
 * ⚠️ **Enumerated, not `string`, and that is what makes the factory safe.** The
 * two ids it mints are template literals over this union, so TypeScript expands
 * them to the sixteen concrete ids and checks each against `RuleId` — add a
 * ninth entity without declaring its two ids in `ids.ts` and the factory stops
 * compiling. With `collection: string` the composed id widened to `string` and
 * nothing downstream could see it. `cards` is deliberately absent: its two
 * cowrite rules are declared literally in `cards.ts`, because a rule id is owned
 * by the file that declares it.
 */
type ThreadSourceCollection =
  | "orders"
  | "invoices"
  | "contacts"
  | "organizations"
  | "products"
  | "out-of-service"
  | "credit-notes"
  | "roles";

interface ThreadCowriteConfig {
  /** Plural Firestore collection name of the source doc. */
  collection: ThreadSourceCollection;
  /** Transaction id in which the cowrite fires. */
  transaction: TransactionId;
  /**
   * The source document's identity field, when it is not `uid`.
   *
   * ⚠️ **This exists for exactly one entity, and that is the finding rather than
   * the exception.** Every carrier here keys on `uid` except `roles`, whose id IS
   * its `name` (`roles/{name}` = `{ name, label, permissions[] }` — `Role` has no
   * `uid` field at all). So the factory minted `source: ["uid"]` for one of its
   * eight instantiations against a document that cannot supply it, and the path
   * resolved against nothing until the field-path ratchet found it
   * (api-cloudrun#568).
   *
   * ⭐ The general shape is worth keeping: a factory whose form is right for its
   * population MINUS ONE MEMBER. §1 item 5's convention says a rule factory is
   * file-local and its ids are owned here — it says nothing about a member that
   * does not fit, and the honest fix is a named per-entity override rather than
   * either forking the factory or letting one instantiation stay wrong.
   */
  idField?: "uid" | "name";
}

/**
 * All 18 cowrite rules share one detector, so the pointer lives here rather than
 * being repeated per entity — one edit site, 18 rules (9 entities × 2 directions).
 * ⚠️ Said 14 until 2026-08-17. Do not write structural counts into prose without
 * a way to fail — this file carried two wrong ones at once.
 *
 * `uid_thread` is `.optional()` on every carrier schema, so
 * `validateBeforeWrite` cannot see a doc that simply lacks one and a corpus walk
 * is the ONLY enforcement available. That is why `kind: "audit"` here is not a
 * weaker choice than `"zod"` — it is the only one on offer.
 */
const THREAD_FORWARD: EnforcementRef = {
  kind: "audit",
  ref: "api-cloudrun/scripts/audit-default-threads.ts",
  clause:
    "property 1 (FORWARD) — the parent's pointer resolves to a thread whose sources[] names it",
  gates: true,
};

const THREAD_REVERSE: EnforcementRef = {
  kind: "audit",
  ref: "api-cloudrun/scripts/audit-default-threads.ts",
  clause:
    "property 2 (REVERSE) — the thread's sources[0] parent points back at it",
  gates: true,
};

/** Build the cowrite-thread + back-embed rules for one source entity. */
function cowriteRulesFor(
  { collection, transaction, idField = "uid" }: ThreadCowriteConfig,
): CollectionRule[] {
  return [
    {
      id: `cowrite-thread:${collection}-to-thread`,
      source: collection,
      target: "threads",
      mode: "co-write",
      invariant:
        `Every ${collection} doc gets a default thread cowritten on creation so the manager's Notes tab always has a target`,
      transaction,
      enforced_by: [THREAD_FORWARD],
      fields: [
        { source: [idField], target: ["sources", "uid"] },
        {
          source: [],
          target: ["sources", "collection"],
          transform: `literal "${collection}"`,
        },
        {
          source: [],
          target: ["created_by"],
          transform: "ActorRef of acting user from session ({uid, name})",
        },
        { source: [], target: ["title"], transform: "null — default thread" },
        { source: [], target: ["comment_count"], transform: "0" },
      ],
    },
    {
      id: `cowrite-thread:thread-to-${collection}`,
      source: "threads",
      target: collection,
      mode: "embed",
      invariant:
        `The cowritten thread's uid is embedded on the parent ${collection} doc so the detail view can resolve its default thread without a query`,
      transaction,
      enforced_by: [THREAD_REVERSE],
      fields: [
        { source: ["uid"], target: ["uid_thread"] },
      ],
    },
  ];
}

// ── Per-entity rules ────────────────────────────────────────────────

const threadOrderRules: CollectionRule[] = cowriteRulesFor({
  collection: "orders",
  transaction: "create-order",
});

const threadInvoiceRules: CollectionRule[] = cowriteRulesFor({
  collection: "invoices",
  transaction: "create-invoice",
});

const threadContactRules: CollectionRule[] = cowriteRulesFor({
  collection: "contacts",
  transaction: "create-contact",
});

const threadOrganizationRules: CollectionRule[] = cowriteRulesFor({
  collection: "organizations",
  transaction: "create-organization",
});

const threadProductRules: CollectionRule[] = cowriteRulesFor({
  collection: "products",
  transaction: "create-product",
});

// No `threadTransactionRules`, deliberately. Movements do NOT cowrite a thread.
// Measured before removing it: 900 of 917 stored transactions carried an
// auto-cowritten thread and ZERO of those threads held a comment (there are no
// comments in prod at all), so it was minting an artifact rather than a
// capability — and a 135-line checkout would have minted 135 extra thread docs
// against the per-commit write budget that is already the binding constraint
// (api-cloudrun#391). A movement is an event: its narrative belongs on the order
// or the OOS record it references through `sources[]`, both of which do have a
// thread.

const threadOutOfServiceRules: CollectionRule[] = cowriteRulesFor({
  collection: "out-of-service",
  transaction: "create-out-of-service-record",
});

/**
 * Credit notes DO cowrite a thread, unlike movements.
 *
 * The distinction is the one drawn above: a movement is an event whose
 * narrative belongs on the order or OOS record it references, whereas a credit
 * note is a *document* an operator issues, disputes and explains. It is also the
 * one place the corpus already demanded it — the four historic Xero miscodings
 * (CN-1007, CN-1010/1011/1012) each carry a comment recording why CFS stores a
 * different posting account than Xero does, and that comment has nowhere else to
 * live.
 */
const threadCreditNoteRules: CollectionRule[] = cowriteRulesFor({
  collection: "credit-notes",
  transaction: "create-credit-note",
});

// ── Role transaction (new — role creation is promoted to a transaction) ─

const threadRoleRules: CollectionRule[] = cowriteRulesFor({
  collection: "roles",
  transaction: "create-role",
  // A role's document id IS its name; `Role` carries no `uid`.
  idField: "name",
});

/**
 * `create-role` is a new named transaction introduced with Threads Phase 1 —
 * role creation was a direct `ref.set(role)` before, promoted to a Firestore
 * transaction so the cowrite of the default thread happens atomically.
 */
const createRoleTransaction: TransactionDefinition = {
  id: "create-role",
  description:
    "Creates a role document and cowrites its default thread so the role detail view can start accepting comments immediately.",
  steps: [
    "cowrite-thread:roles-to-thread",
    "cowrite-thread:thread-to-roles",
  ],
};

// ── create-comment transaction ──────────────────────────────────────

const createCommentRules: CollectionRule[] = [
  {
    id: "create-comment:thread-to-comment",
    source: "threads",
    target: "comments",
    mode: "embed",
    invariant:
      "Comments carry a denormalized copy of the parent thread's sources so they can be queried by source doc without a thread join (for Typesense and direct Firestore queries)",
    transaction: "create-comment",
    enforced_by: [{
      kind: "audit",
      ref: "api-cloudrun/scripts/audit-default-threads.ts",
      clause:
        "property 3 (MIRROR) — the comment's denormalized sources[] still equals its thread's, and its uid_thread resolves",
      gates: true,
    }],
    fields: [
      {
        source: ["sources"],
        target: ["sources"],
        transform: "full copy of thread.sources[] — {collection, uid} entries",
      },
    ],
  },
  {
    id: "create-comment:comment-to-thread",
    source: "comments",
    target: "threads",
    mode: "derive",
    invariant:
      "Every comment write bumps the parent thread's comment_count (soft-deletes excluded) and refreshes last_message_at and last_message_preview so the thread list renders without a per-thread subquery",
    transaction: "create-comment",
    fields: [
      {
        source: [],
        target: ["comment_count"],
        transform: "FieldValue.increment(1) — undone by soft delete",
      },
      { source: ["created_at"], target: ["last_message_at"] },
      {
        source: ["body_text"],
        target: ["last_message_preview"],
        transform: "truncate to 280 chars",
      },
    ],
  },
];

const createCommentTransaction: TransactionDefinition = {
  id: "create-comment",
  description:
    "Creates a comment attached to a thread, embedding the thread's sources on the comment and deriving the parent thread's counter and preview fields.",
  steps: [
    "create-comment:thread-to-comment",
    "create-comment:comment-to-thread",
  ],
};

// ── delete-comment transaction ──────────────────────────────────────

/**
 * The soft-delete half of the counter above, declared for api-cloudrun#503B.
 *
 * ⚠️ **The asymmetry is what made this invisible.** `create-comment` writes two
 * collections, declares two rules and logs them; `delete-comment` writes the
 * same two and declared nothing — so the increment was observable and the
 * decrement was not, and a thread whose `comment_count` had drifted low left no
 * record naming the write that did it. The two are one invariant read in
 * opposite directions, which is why this is a rule of its own rather than a
 * second `trigger` on `create-comment:comment-to-thread`: a rule's `source` and
 * `target` describe an edge, and only its own `fields` can say the count went
 * DOWN.
 *
 * **No `last_message_*` refresh, deliberately.** Deleting the newest comment
 * leaves the thread's preview naming a comment that is now soft-deleted. That
 * is pre-existing behaviour and is NOT declared here — declaring a field this
 * transaction does not write would report drift on every run, the encoding
 * `crms-ingest.ts` refuses for api-cloudrun#501. Recovering the preview needs a
 * query for the newest live comment, which is a range read this transaction
 * does not take.
 */
const deleteCommentRules: CollectionRule[] = [
  {
    id: "delete-comment:comment-to-thread",
    source: "comments",
    target: "threads",
    mode: "derive",
    invariant:
      "A soft-deleted comment is not counted: `thread.comment_count` is decremented so it keeps equalling the number of live comments the thread list would render",
    transaction: "delete-comment",
    trigger:
      "first soft delete only — `deleteComment` returns early on an already-deleted comment, so a repeated DELETE cannot double-decrement",
    fields: [
      {
        source: [],
        target: ["comment_count"],
        transform:
          "FieldValue.increment(-1) — the undo of create-comment:comment-to-thread",
      },
    ],
  },
];

const deleteCommentTransaction: TransactionDefinition = {
  id: "delete-comment",
  description:
    "Soft-deletes a comment (stamping deleted_at/deleted_by rather than removing it) and decrements the parent thread's live-comment count.",
  steps: [
    "delete-comment:comment-to-thread",
  ],
};

// ── Module ──────────────────────────────────────────────────────────
/** Everything `threads.ts` contributes to the propagation catalog. */
export const threads: PropagationModule = {
  rules: [
    ...threadOrderRules,
    ...threadInvoiceRules,
    ...threadContactRules,
    ...threadOrganizationRules,
    ...threadProductRules,
    ...threadRoleRules,
    ...threadOutOfServiceRules,
    ...threadCreditNoteRules,
    ...createCommentRules,
    ...deleteCommentRules,
  ],
  transactions: [
    createRoleTransaction,
    createCommentTransaction,
    deleteCommentTransaction,
  ],
};
