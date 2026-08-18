/**
 * Recurrence propagation rules.
 *
 * A `recurrences/{uid}` document is a prototype-card + RRULE + horizon
 * configuration. The nightly materializer + scope-aware card edits fan out
 * between the recurrence and its materialized instance cards. This module
 * enumerates every inter-collection propagation the api-cloudrun services
 * must log on top of the existing `delete-card` cascade (thread + comments
 * of each deleted card — that's handled by `propagation/cards.ts` already).
 *
 * Each materialized card carries:
 * - `recurrence_parent_uid` → pointer to `recurrences/{uid}`
 * - `recurrence_index` → 0-based ordinal within the rule's sequence
 * - `recurrence_overrides: string[]` → field keys the user pinned on this
 *   instance (via `PATCH /cards/{uid}?recurrence_scope=this`). Prototype
 *   fan-out writes skip pinned fields.
 *
 * Recurrence-side deletes (`exception_dates`) + card-side overrides are the
 * two exception mechanisms that keep user edits stable across re-runs of
 * the materializer.
 */
import type {
  CollectionRule,
  EnforcementRef,
  PropagationModule,
  TransactionDefinition,
} from "./types.ts";

// ── What checks these rules ─────────────────────────────────────────
//
// One suite, one named test per rule, each asserting the CARD or the RECURRENCE
// on the other side of the fan-out. No corpus detector exists for any of them:
// a materializer that silently stopped writing, or a prototype fan-out that
// reached zero siblings, would be caught only by these tests.
//
// Two rules in this file are deliberately left UNLINKED because nothing
// exercises them: `update-recurrence:rematerialize-future` (the rule/date change
// path) and the `delete-card-scope-all` pair.

const RECURRENCE_CREATE_MATERIALIZES: EnforcementRef = {
  kind: "test",
  ref: "api-cloudrun/tests/integration/recurrences/recurrences.test.ts:118",
  clause:
    "the synchronous first horizon — a create materializes instance cards bounded by `horizon_days`. Runs in `deno task test` (pre-push), not the hermetic CI gate.",
  gates: true,
};

const HORIZON_MATERIALIZER: EnforcementRef = {
  kind: "test",
  ref: "api-cloudrun/tests/integration/recurrences/recurrences.test.ts:483",
  clause:
    "both halves of the nightly path — `materializeHorizonForRecurrence` advances `horizon_through` and writes the new cards, and the `POST /tasks/materialize-horizon` sweep covers every active recurrence (:547). The Cloud Scheduler wiring that invokes it is infrastructure, not covered here.",
  gates: true,
};

const PROTOTYPE_FANOUT: EnforcementRef = {
  kind: "test",
  ref: "api-cloudrun/tests/integration/recurrences/recurrences.test.ts:161",
  clause:
    "the fan-out AND its exception — prototype changes reach every existing instance card, skipping fields listed in that card's `recurrence_overrides[]`. A version bump on the parent bumps the instance cards and a stale version 409s (:617).",
  gates: true,
};

const RECURRENCE_DELETE_CASCADE: EnforcementRef = {
  kind: "test",
  ref: "api-cloudrun/tests/integration/recurrences/recurrences.test.ts:228",
  clause:
    "the cascade and its two guards — every instance card is deleted, a large horizon is batched with threads + comments gone (:750), the delete FAILS CLOSED with 403 CARD_LOCKED when an instance is locked (:697), and re-deleting 404s rather than half-running (:925)",
  gates: true,
};

const SCOPE_FOLLOWING_PATCH: EnforcementRef = {
  kind: "test",
  ref: "api-cloudrun/tests/integration/recurrences/recurrences.test.ts:275",
  clause:
    "the date-bounded fan-out — a scope=following PATCH reaches later siblings ONLY, not earlier ones. The per-sibling `recurrence_overrides` block is asserted on the scope=all path rather than this one.",
  gates: true,
};

const SCOPE_ALL_PATCH: EnforcementRef = {
  kind: "test",
  ref: "api-cloudrun/tests/integration/recurrences/recurrences.test.ts:330",
  clause:
    "both steps of scope=all in one test — the patch back-propagates to the parent recurrence's prototype AND cascades to every sibling",
  gates: true,
};

const SCOPE_THIS_DELETE: EnforcementRef = {
  kind: "test",
  ref: "api-cloudrun/tests/integration/recurrences/recurrences.test.ts:381",
  clause:
    "the exception-date append — deleting one card appends its Chicago calendar day to the parent's `exception_dates[]`, which is what stops the nightly materializer resurrecting it",
  gates: true,
};

const SCOPE_FOLLOWING_DELETE: EnforcementRef = {
  kind: "test",
  ref: "api-cloudrun/tests/integration/recurrences/recurrences.test.ts:431",
  clause:
    "the truncation and the teardown — `active_until` is cut to the day before the deleted card's start, and each deleted sibling's thread + comments go with it (:867)",
  gates: true,
};

// ── create-recurrence ───────────────────────────────────────────────

const createRecurrenceRules: CollectionRule[] = [
  {
    id: "create-recurrence:fan-out-cards",
    source: "recurrences",
    target: "cards",
    mode: "fan-out",
    invariant:
      "Creating a recurrence synchronously materializes the first horizon of instance cards (bounded by `horizon_days`, default 60) so the Dashboard surfaces upcoming instances immediately. Each card copies the prototype's fields + the rule-expanded `dates.start` (RRULE day at 9am Chicago) + the resolved `recurrence_parent_uid` + `recurrence_index`.",
    enforced_by: [RECURRENCE_CREATE_MATERIALIZES],
    transaction: "create-recurrence",
    fields: [
      { source: ["uid"], target: ["recurrence_parent_uid"] },
      { source: [], target: ["recurrence_index"], transform: "0-based index within the rule's expanded sequence" },
      { source: [], target: ["dates", "start"], transform: "RRULE-expanded calendar day, materialized at 09:00 America/Chicago" },
      { source: ["uid_list"], target: ["uid_list"] },
      { source: ["prototype", "subject"], target: ["subject"] },
      { source: ["prototype", "body"], target: ["body"] },
      { source: ["prototype", "body_text"], target: ["body_text"] },
      { source: ["prototype", "status"], target: ["status"] },
      { source: ["prototype", "destination"], target: ["destination"] },
      { source: ["prototype", "sources"], target: ["sources"] },
      { source: ["prototype", "attachments"], target: ["attachments"] },
      { source: ["prototype", "uid_assignees"], target: ["uid_assignees"] },
      { source: ["prototype", "locked"], target: ["locked"] },
      { source: [], target: ["recurrence_overrides"], transform: "[] — fresh instance" },
    ],
  },
];

const createRecurrenceTransaction: TransactionDefinition = {
  id: "create-recurrence",
  description:
    "Creates a recurrence and synchronously materializes the first horizon of instance cards so the Dashboard lists upcoming occurrences without waiting for the nightly job.",
  steps: [
    "create-recurrence:fan-out-cards",
    // Shared steps, declared in `cards.ts`: every minted card gets its thread
    // cowritten by the same helper `create-card` uses. Declaring them here is
    // what makes the write visible to the catalog — the class §3c calls "every
    // co-write helper shared between two transactions is declared on one and
    // undeclared on the other".
    "cowrite-thread:cards-to-thread",
    "cowrite-thread:thread-to-cards",
  ],
};

// ── materialize-horizon (cron-driven) ───────────────────────────────

const materializeHorizonRules: CollectionRule[] = [
  {
    id: "materialize-horizon:fan-out-cards",
    source: "recurrences",
    target: "cards",
    mode: "fan-out",
    invariant:
      "The nightly materializer advances `recurrence.horizon_through` to `today + (horizon_days ?? 60)` for every `status == 'active'` recurrence, writing one card per RRULE-expanded date that is (a) past `horizon_through`, (b) on or before the new horizon, (c) not in `exception_dates`, and (d) does not already have a sibling card at that (parent, date) pair. Runs @ 02:00 America/Chicago via Cloud Scheduler → Cloud Tasks → `POST /tasks/materialize-horizon`.",
    enforced_by: [HORIZON_MATERIALIZER],
    transaction: "materialize-horizon",
    trigger: "cron:nightly-02:00-america-chicago",
    fields: [
      { source: ["uid"], target: ["recurrence_parent_uid"] },
      { source: [], target: ["recurrence_index"], transform: "continues the index sequence past the previous horizon" },
      { source: [], target: ["dates", "start"], transform: "RRULE-expanded calendar day within the new horizon slice, materialized at 09:00 America/Chicago" },
      { source: ["prototype"], target: [], transform: "prototype fields fanned identically to create-recurrence:fan-out-cards" },
    ],
  },
];

const materializeHorizonTransaction: TransactionDefinition = {
  id: "materialize-horizon",
  description:
    "Nightly job that extends every active recurrence's materialization window, writing any new cards needed to fill the rolling horizon. Idempotent — re-running the same day is a no-op when the horizon is already covered.",
  steps: [
    "materialize-horizon:fan-out-cards",
    // Shared steps, declared in `cards.ts`: every minted card gets its thread
    // cowritten by the same helper `create-card` uses. Declaring them here is
    // what makes the write visible to the catalog — the class §3c calls "every
    // co-write helper shared between two transactions is declared on one and
    // undeclared on the other".
    "cowrite-thread:cards-to-thread",
    "cowrite-thread:thread-to-cards",
  ],
};

// ── update-recurrence ───────────────────────────────────────────────

const updateRecurrenceRules: CollectionRule[] = [
  {
    id: "update-recurrence:fan-out-prototype",
    source: "recurrences",
    target: "cards",
    mode: "fan-out",
    invariant:
      "When a recurrence's `prototype.*` fields change, every existing instance card in the series receives the new values — except for fields listed in that card's `recurrence_overrides[]`, which are pinned by the user and must not be overwritten.",
    enforced_by: [PROTOTYPE_FANOUT],
    transaction: "update-recurrence",
    trigger: "onUpdate:recurrences",
    fields: [
      { source: ["prototype"], target: [], transform: "per-field update of cards where recurrence_parent_uid == recurrence.uid AND field ∉ card.recurrence_overrides" },
    ],
  },
  {
    id: "update-recurrence:rematerialize-future",
    source: "recurrences",
    target: "cards",
    mode: "fan-out",
    invariant:
      "When a recurrence's `rule` or `active_from` / `active_until` changes, future instance cards (Chicago calendar day of dates.start >= today) are deleted and re-materialized against the new rule. Past instances are preserved — history is not rewritten. Overridden cards are skipped to respect user edits.",
    transaction: "update-recurrence",
    trigger: "onUpdate:recurrences",
    fields: [
      { source: ["rule"], target: [], transform: "delete cards where Chicago calendar day of dates.start >= today AND recurrence_overrides is empty, then RRULE-expand the new rule across [today, horizon_through]" },
    ],
  },
];

const updateRecurrenceTransaction: TransactionDefinition = {
  id: "update-recurrence",
  description:
    "Applies prototype-field edits and/or rule changes to a recurrence, fanning the non-overridden updates out to instance cards. Rule changes re-materialize future instances; prototype changes patch them in place.",
  steps: [
    "update-recurrence:fan-out-prototype",
    "update-recurrence:rematerialize-future",
    // Rematerialize MINTS cards as well as reaping them, so this transaction is
    // the one that needs both pairs.
    "cowrite-thread:cards-to-thread",
    "cowrite-thread:thread-to-cards",
    // Shared steps, declared in `cards.ts`: this path routes through
    // `cascadeDeleteCards`, which unlinks each card from its thread and deletes
    // the thread's comments. Declared on `delete-card` and — until 2026-08-17 —
    // undeclared on every other caller of that helper.
    "delete-card:cascade-thread",
    "delete-card:cascade-comments",
  ],
};

// ── delete-recurrence ───────────────────────────────────────────────

const deleteRecurrenceRules: CollectionRule[] = [
  {
    id: "delete-recurrence:fan-out-cards",
    source: "recurrences",
    target: "cards",
    mode: "fan-out",
    invariant:
      "Deleting a recurrence cascades to every instance card in the series, tearing down each card's linked thread(s) + comments as part of the same delete. This rule describes only the recurrence → cards fan-out; the thread/comment teardown is modeled by `delete-card:cascade-thread` + `delete-card:cascade-comments` in propagation/cards.ts.",
    enforced_by: [RECURRENCE_DELETE_CASCADE],
    transaction: "delete-recurrence",
    trigger: "onDelete:recurrences",
    fields: [
      { source: ["uid"], target: ["recurrence_parent_uid"], transform: "delete all cards where recurrence_parent_uid == recurrence.uid" },
    ],
  },
];

const deleteRecurrenceTransaction: TransactionDefinition = {
  id: "delete-recurrence",
  description:
    "Deletes a recurrence and every instance card it produced, tearing down each card's thread + comments as part of the delete.",
  steps: [
    "delete-recurrence:fan-out-cards",
    // Shared steps, declared in `cards.ts`: this path routes through
    // `cascadeDeleteCards`, which unlinks each card from its thread and deletes
    // the thread's comments. Declared on `delete-card` and — until 2026-08-17 —
    // undeclared on every other caller of that helper.
    "delete-card:cascade-thread",
    "delete-card:cascade-comments",
  ],
};

// ── update-card scope=following ─────────────────────────────────────

const updateCardScopeFollowingRules: CollectionRule[] = [
  {
    id: "update-card-scope-following:cascade-future-siblings",
    source: "cards",
    target: "cards",
    mode: "fan-out",
    invariant:
      "`PATCH /cards/{uid}?recurrence_scope=following` applies the edit to the target card plus every sibling card in the same series (recurrence_parent_uid matches) with `dates.start >= target.dates.start` (instant-level comparison). Siblings' own `recurrence_overrides` still block per-field updates.",
    enforced_by: [SCOPE_FOLLOWING_PATCH],
    transaction: "update-card-scope-following",
    fields: [
      { source: [], target: [], transform: "for each patched field: update siblings where recurrence_parent_uid == source.recurrence_parent_uid AND dates.start >= source.dates.start AND field ∉ sibling.recurrence_overrides" },
    ],
  },
];

const updateCardScopeFollowingTransaction: TransactionDefinition = {
  id: "update-card-scope-following",
  description:
    "Applies an instance-card edit to the edited card and every later sibling in the same recurrence series, respecting per-sibling field overrides.",
  steps: ["update-card-scope-following:cascade-future-siblings"],
};

// ── update-card scope=all ───────────────────────────────────────────

const updateCardScopeAllRules: CollectionRule[] = [
  {
    id: "update-card-scope-all:update-recurrence-prototype",
    source: "cards",
    target: "recurrences",
    mode: "derive",
    invariant:
      "`PATCH /cards/{uid}?recurrence_scope=all` back-propagates the patched fields to the parent recurrence's prototype so that future materializations and newly-created siblings inherit the edit.",
    enforced_by: [SCOPE_ALL_PATCH],
    transaction: "update-card-scope-all",
    fields: [
      { source: [], target: ["prototype"], transform: "merge patched fields into recurrences/{card.recurrence_parent_uid}.prototype" },
    ],
  },
  {
    id: "update-card-scope-all:cascade-siblings",
    source: "cards",
    target: "cards",
    mode: "fan-out",
    invariant:
      "After updating the parent prototype, every sibling card in the series (regardless of date) receives the patched fields — except where a sibling's `recurrence_overrides` pins that field.",
    enforced_by: [SCOPE_ALL_PATCH],
    transaction: "update-card-scope-all",
    fields: [
      { source: [], target: [], transform: "for each patched field: update siblings where recurrence_parent_uid matches AND field ∉ sibling.recurrence_overrides" },
    ],
  },
];

const updateCardScopeAllTransaction: TransactionDefinition = {
  id: "update-card-scope-all",
  description:
    "Applies an instance-card edit to every card in the recurrence series and back-propagates the change to the parent prototype so future instances inherit it.",
  steps: [
    "update-card-scope-all:update-recurrence-prototype",
    "update-card-scope-all:cascade-siblings",
  ],
};

// ── delete-card scope=this ──────────────────────────────────────────

const deleteCardScopeThisRules: CollectionRule[] = [
  {
    id: "delete-card-scope-this:append-exception-date",
    source: "cards",
    target: "recurrences",
    mode: "derive",
    invariant:
      "`DELETE /cards/{uid}?recurrence_scope=this` deletes the single card and appends the Chicago calendar day of its `dates.start` to the parent recurrence's `exception_dates[]` (YYYY-MM-DD strings) so the nightly materializer never resurrects that occurrence.",
    enforced_by: [SCOPE_THIS_DELETE],
    transaction: "delete-card-scope-this",
    fields: [
      { source: ["dates", "start"], target: ["exception_dates"], transform: "append Chicago-tz YYYY-MM-DD of card.dates.start to recurrences/{card.recurrence_parent_uid}.exception_dates" },
    ],
  },
];

const deleteCardScopeThisTransaction: TransactionDefinition = {
  id: "delete-card-scope-this",
  description:
    "Deletes a single instance card from a recurrence series and records the date as an exception so future materializations skip it. The card's own thread + comments cascade fires via the existing delete-card rules.",
  steps: ["delete-card-scope-this:append-exception-date"],
};

// ── delete-card scope=following ─────────────────────────────────────

const deleteCardScopeFollowingRules: CollectionRule[] = [
  {
    id: "delete-card-scope-following:cascade-future-siblings",
    source: "cards",
    target: "cards",
    mode: "fan-out",
    invariant:
      "`DELETE /cards/{uid}?recurrence_scope=following` deletes the target card plus every sibling with `dates.start >= target.dates.start` (instant-level comparison). Each deleted card's thread + comments are torn down as part of the delete.",
    enforced_by: [SCOPE_FOLLOWING_DELETE],
    transaction: "delete-card-scope-following",
    fields: [
      { source: ["uid"], target: [], transform: "delete cards where recurrence_parent_uid == source.recurrence_parent_uid AND dates.start >= source.dates.start" },
    ],
  },
  {
    id: "delete-card-scope-following:truncate-recurrence",
    source: "cards",
    target: "recurrences",
    mode: "derive",
    invariant:
      "After deleting the tail of a series, the parent recurrence's `active_until` is truncated to the Chicago calendar day before the deleted card's dates.start so the nightly materializer cannot re-extend the series past that point.",
    enforced_by: [SCOPE_FOLLOWING_DELETE],
    transaction: "delete-card-scope-following",
    fields: [
      { source: ["dates", "start"], target: ["active_until"], transform: "set recurrences/{source.recurrence_parent_uid}.active_until = (Chicago-tz YYYY-MM-DD of source.dates.start) - 1 day" },
    ],
  },
];

const deleteCardScopeFollowingTransaction: TransactionDefinition = {
  id: "delete-card-scope-following",
  description:
    "Deletes an instance card and every later sibling in the series, then truncates the parent recurrence so no future materialization rebuilds the deleted tail.",
  steps: [
    "delete-card-scope-following:cascade-future-siblings",
    "delete-card-scope-following:truncate-recurrence",
    // Shared steps, declared in `cards.ts`: this path routes through
    // `cascadeDeleteCards`, which unlinks each card from its thread and deletes
    // the thread's comments. Declared on `delete-card` and — until 2026-08-17 —
    // undeclared on every other caller of that helper.
    "delete-card:cascade-thread",
    "delete-card:cascade-comments",
  ],
};

// ── delete-card scope=all ───────────────────────────────────────────

const deleteCardScopeAllRules: CollectionRule[] = [
  {
    id: "delete-card-scope-all:cascade-siblings",
    source: "cards",
    target: "cards",
    mode: "fan-out",
    invariant:
      "`DELETE /cards/{uid}?recurrence_scope=all` deletes every instance card in the series. Each deleted card's thread + comments are torn down as part of the delete.",
    transaction: "delete-card-scope-all",
    fields: [
      { source: ["uid"], target: [], transform: "delete all cards where recurrence_parent_uid == source.recurrence_parent_uid" },
    ],
  },
  {
    id: "delete-card-scope-all:delete-recurrence",
    source: "cards",
    target: "recurrences",
    mode: "fan-out",
    invariant:
      "After deleting every sibling, the parent recurrence itself is deleted so the series is fully removed.",
    transaction: "delete-card-scope-all",
    fields: [
      { source: ["recurrence_parent_uid"], target: ["uid"], transform: "delete recurrences/{source.recurrence_parent_uid}" },
    ],
  },
];

const deleteCardScopeAllTransaction: TransactionDefinition = {
  id: "delete-card-scope-all",
  description:
    "Deletes every instance card in a recurrence series and the parent recurrence itself. Equivalent to deleting the recurrence, just initiated from an instance card.",
  steps: [
    "delete-card-scope-all:cascade-siblings",
    "delete-card-scope-all:delete-recurrence",
  ],
};
// ── Module ──────────────────────────────────────────────────────────
/** Everything `recurrences.ts` contributes to the propagation catalog. */
export const recurrences: PropagationModule = {
  rules: [
    ...createRecurrenceRules,
    ...materializeHorizonRules,
    ...updateRecurrenceRules,
    ...deleteRecurrenceRules,
    ...updateCardScopeFollowingRules,
    ...updateCardScopeAllRules,
    ...deleteCardScopeThisRules,
    ...deleteCardScopeFollowingRules,
    ...deleteCardScopeAllRules,
  ],
  transactions: [
    createRecurrenceTransaction,
    materializeHorizonTransaction,
    updateRecurrenceTransaction,
    deleteRecurrenceTransaction,
    updateCardScopeFollowingTransaction,
    updateCardScopeAllTransaction,
    deleteCardScopeThisTransaction,
    deleteCardScopeFollowingTransaction,
    deleteCardScopeAllTransaction,
  ],
};
