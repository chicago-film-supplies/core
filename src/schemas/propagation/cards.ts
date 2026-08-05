/**
 * Cards propagation rules.
 *
 * Every card creation cowrites a default thread (same pattern as orders,
 * invoices, contacts, etc. — see `propagation/threads.ts`). Card delete
 * cascades the default thread + its comments atomically with the card delete.
 *
 * Cards can also carry multi-source thread sources (e.g. an event card that
 * also references its parent order). The cowrite helper takes the card's
 * `sources[]` as-is plus the card itself; both wires are described below.
 */
import type { CollectionRule, EnforcementRef, TransactionDefinition } from "./types.ts";

/**
 * The delete cascade is asserted from both ends, which matters because the
 * interesting case is the thread that must SURVIVE: a card that was one of
 * several `sources[]` gets a narrow patch, not a delete, and its comment
 * counters must come through untouched.
 */
const CARD_DELETE_CASCADE: EnforcementRef = {
  kind: "test",
  ref: "api-cloudrun/tests/integration/recurrences/recurrences.test.ts:750",
  clause:
    "the teardown and its complement — a large-horizon recurrence delete removes cards, threads AND comments in batches; a scope=following card delete tears down the deleted siblings' threads + comments (:867); and a thread that survives with other sources keeps its comment counters through the narrow `sources[]` patch (:803). Runs in `deno task test` (pre-push), not the hermetic CI gate.",
  gates: true,
};

/**
 * The FORWARD half — that nothing is left pointing at a deleted thread — is the
 * corpus detector's, not a test's.
 */
const NO_DANGLING_THREAD_POINTER: EnforcementRef = {
  kind: "audit",
  ref: "api-cloudrun/scripts/audit-default-threads.ts",
  clause:
    "the corpus half — property 1 (FORWARD) catches a parent still pointing at a thread the cascade removed, and property 3 (MIRROR) catches a comment whose `uid_thread` resolves to nothing. It does NOT verify that an empty-`sources[]` thread was deleted; that direction is the test above.",
  gates: true,
};

// ── create-card ─────────────────────────────────────────────────────

export const createCardRules: CollectionRule[] = [
  {
    id: "cowrite-thread:cards-to-thread",
    source: "cards",
    target: "threads",
    mode: "co-write",
    invariant:
      "Every card cowrites a default thread on creation so the detail surface's Notes tab always has a target. The cowritten thread carries the card itself plus any extra `sources[]` from the create input (e.g. an event card references its parent order), so the thread surfaces on all linked detail views.",
    transaction: "create-card",
    enforced_by: [
      {
        kind: "audit",
        ref: "api-cloudrun/scripts/audit-default-threads.ts",
        clause: "property 1 (FORWARD) — the card's uid_thread resolves to a thread whose sources[] names it",
        gates: true,
      },
      {
        kind: "audit",
        ref: "api-cloudrun/scripts/audit-default-threads.ts",
        clause:
          "property 4 (RESOLVE) — the EXTRA sources[] entries also name live docs; property 2 keys on sources[0] and cannot see them",
        gates: true,
      },
      {
        kind: "zod",
        ref: "core/src/schemas/card.ts:210",
        clause: "`uid_thread` is required, so a card with no pointer at all cannot be written",
        gates: true,
      },
    ],
    fields: [
      { source: ["uid"], target: ["sources", "uid"], transform: `sources[0] — the card itself` },
      { source: [], target: ["sources", "collection"], transform: `sources[0].collection — literal "cards"` },
      { source: ["sources"], target: ["sources"], transform: "extra sources appended (e.g. [{collection:'orders', uid}])" },
      { source: [], target: ["created_by"], transform: "ActorRef of acting user from session" },
      { source: [], target: ["title"], transform: "null — default thread" },
      { source: [], target: ["comment_count"], transform: "0" },
    ],
  },
  {
    id: "cowrite-thread:thread-to-cards",
    source: "threads",
    target: "cards",
    mode: "embed",
    invariant:
      "The cowritten thread's uid is embedded on the card as `uid_thread` so the detail view can resolve its default thread without a query.",
    transaction: "create-card",
    enforced_by: [{
      kind: "audit",
      ref: "api-cloudrun/scripts/audit-default-threads.ts",
      clause: "property 2 (REVERSE) — the thread's sources[0] card points back at it via uid_thread",
      gates: true,
    }],
    fields: [
      { source: ["uid"], target: ["uid_thread"] },
    ],
  },
];

export const createCardTransaction: TransactionDefinition = {
  id: "create-card",
  description:
    "Creates a card and cowrites its default thread so the card's Notes tab can accept comments immediately. Extra polymorphic sources (e.g. parent order) flow through to the thread so it surfaces on every linked detail view.",
  steps: [
    "cowrite-thread:cards-to-thread",
    "cowrite-thread:thread-to-cards",
  ],
};

// ── delete-card cascade ─────────────────────────────────────────────

export const deleteCardRules: CollectionRule[] = [
  {
    id: "delete-card:cascade-thread",
    source: "cards",
    target: "threads",
    mode: "fan-out",
    invariant:
      "Deleting a card removes the card's entry from every linked thread's `sources[]`. If a thread ends up with an empty `sources[]`, the thread is hard-deleted and its comments cascade.",
    enforced_by: [CARD_DELETE_CASCADE, NO_DANGLING_THREAD_POINTER],
    transaction: "delete-card",
    trigger: "onDelete:cards",
    fields: [
      { source: ["uid"], target: ["sources"], transform: "remove {collection:'cards', uid} from thread.sources[]" },
    ],
  },
  {
    id: "delete-card:cascade-comments",
    source: "cards",
    target: "comments",
    mode: "fan-out",
    invariant:
      "When the cascade above hard-deletes a thread (empty sources[]), all comments on that thread are also hard-deleted. No soft delete here — the source card and thread are already gone.",
    enforced_by: [CARD_DELETE_CASCADE],
    transaction: "delete-card",
    trigger: "onDelete:cards",
    fields: [
      { source: ["uid_thread"], target: ["uid_thread"], transform: "delete comments where uid_thread == deletedThread.uid" },
    ],
  },
];

export const deleteCardTransaction: TransactionDefinition = {
  id: "delete-card",
  description:
    "Deletes a card and cascades its thread + comments. The card's presence is removed from every thread that referenced it; threads left without any sources are hard-deleted along with all their comments.",
  steps: [
    "delete-card:cascade-thread",
    "delete-card:cascade-comments",
  ],
};

// ── Flat exports ────────────────────────────────────────────────────

/** All card-related propagation rules. */
export const cardRules: CollectionRule[] = [
  ...createCardRules,
  ...deleteCardRules,
];
