/**
 * User propagation rules — create, update, and delete transactions.
 *
 * Traced from: api-cloudrun/src/services/users.ts
 */
import type {
  CollectionRule,
  EnforcementRef,
  PropagationModule,
  TransactionDefinition,
} from "./types.ts";

// ── What checks these rules ─────────────────────────────────────────

/**
 * The ActorRef fan-out is the one rule here with a corpus detector, and it is
 * the campaign's model for what a detector should look like: two INDEPENDENT
 * assertions rather than one fixed point, and a target set DERIVED from the
 * schema registry rather than listed — so it covers the two ActorRefs the
 * rule's own wording misses (`templates-versions.commit_meta.author` and
 * `.written_by`). Until this campaign the rule had no production call site at
 * all while being published at `/docs` as a guarantee.
 */
const ACTOR_REF_NAMES: EnforcementRef = {
  kind: "audit",
  ref: "api-cloudrun/scripts/audit-actor-ref-names.ts",
  clause:
    "both assertions — `name_stale` (an ActorRef whose uid names a real user carries a different name) and, checked first, `source_stale` (`users/{uid}.name` disagreeing with `deriveName(parts)`, which no cascade would fix and which makes every name_stale count untrustworthy). Actor uids naming no user (`crms-bot`, historical emails) are counted, not failed.",
  gates: true,
};

const USER_LINKED_TO_CONTACT_AT_REGISTER: EnforcementRef = {
  kind: "test",
  ref: "api-cloudrun/tests/integration/auth/auth.test.ts:1100",
  clause:
    "the register path — a new user whose email matches an existing contact links to it. The reverse direction (a CONTACT created against an existing user) is asserted nowhere. Runs in `deno task test` (pre-push), not the hermetic CI gate.",
  gates: true,
};

// ── create-user ───────────────────────────────────────────────────

const createUserRules: CollectionRule[] = [
  {
    id: "create-user:link-to-contact",
    source: "users",
    target: "contacts",
    mode: "co-write",
    invariant: "A new user with an email matching an existing contact links bidirectionally",
    enforced_by: [USER_LINKED_TO_CONTACT_AT_REGISTER],
    transaction: "create-user",
    fields: [
      { source: ["uid"], target: ["uid_user"] },
    ],
  },
];

const createUserTransaction: TransactionDefinition = {
  id: "create-user",
  description: "Creates a user; if email matches an existing contact, links bidirectionally.",
  steps: ["create-user:link-to-contact"],
};

// ── update-user ───────────────────────────────────────────────────

const updateUserRules: CollectionRule[] = [
  {
    id: "update-user:name-to-contact",
    source: "users",
    target: "contacts",
    mode: "fan-out",
    invariant: "A user's name stays in sync with its linked contact's name",
    transaction: "update-user",
    trigger: "first_name/middle_name/last_name/pronunciation change on a user with uid_contact set",
    fields: [
      { source: ["first_name"], target: ["first_name"] },
      { source: ["middle_name"], target: ["middle_name"] },
      { source: ["last_name"], target: ["last_name"] },
      { source: ["pronunciation"], target: ["pronunciation"] },
    ],
  },
  {
    id: "update-user:name-to-actor-refs",
    source: "users",
    target: "*",
    mode: "fan-out",
    // The wording used to enumerate created_by/updated_by/deleted_by, which was
    // NARROWER than the code it describes. `api-cloudrun/src/lib/actorRefPaths.ts`
    // discovers targets by walking the schema registry for nodes IDENTICAL to
    // `ActorRef` — node identity, not a name pattern — so a new ActorRef-shaped
    // field is cascaded the day it is added, under any name, with no edit here.
    // Three names in the invariant invited the reader to assume the opposite,
    // and to "complete" the list by hand when a fourth appeared. core#46.
    invariant: "A user's display name stays in sync with EVERY ActorRef-shaped field on every document, whatever it is called — the target set is derived by walking the schema registry for nodes identical to ActorRef, not from a list of field names — so activity feeds, threads, and comments never render a stale name",
    enforced_by: [ACTOR_REF_NAMES],
    transaction: "update-user",
    trigger: "first_name/middle_name/last_name/pronunciation change on a user — rewrite actor.name wherever actor.uid matches, at every discovered ActorRef path",
    fields: [
      // Illustrative, NOT exhaustive: these are the ActorRef nodes present at the
      // time of writing. The two entries below them are the genuine exceptions —
      // shapes the registry walk cannot reach on its own.
      //
      // ⚠️ **`source: []` is the declared spelling of "computed", and it is the
      // honest one here.** Every entry carried
      // `["first_name","middle_name","last_name","pronunciation"]` — a LIST of
      // four siblings in a slot that means a PATH, so it resolved against
      // nothing (#568). The value is not copied from any one of them; it is
      // COMPOSED from all four by the formula below, which is what `source: []`
      // plus a transform already exists to say. The four field names are not
      // lost: `trigger` above names them, and so does the formula.
      { source: [], target: ["created_by", "name"], transform: "ActorRef.name — [first_name, middle_name, last_name].filter(Boolean).join(\" \") with \" (pronunciation)\" appended when pronunciation is set. One example of the derived set, not a declaration of it" },
      { source: [], target: ["updated_by", "name"], transform: "same formula as created_by.name" },
      { source: [], target: ["deleted_by", "name"], transform: "same formula as created_by.name; only where deleted_by is non-null" },
      { source: [], target: ["pdf_versions", "created_by", "name"], transform: "invoices-only — rewrite the name on matching pdf_versions[].created_by entries" },
      { source: [], target: ["reactions", "name"], transform: "comments-only — rewrite the name on every reactions[emoji][uid] entry where uid matches the renamed user" },
    ],
  },
];

const updateUserTransaction: TransactionDefinition = {
  id: "update-user",
  description: "Updates a user with name cascade to a linked contact (if any) and fan-out to ActorRef names on every doc carrying created_by/updated_by/deleted_by.",
  steps: ["update-user:name-to-contact", "update-user:name-to-actor-refs"],
};

// ── delete-user ───────────────────────────────────────────────────

const deleteUserRules: CollectionRule[] = [
  {
    id: "delete-user:unlink-contact",
    source: "users",
    target: "contacts",
    mode: "co-write",
    invariant: "Soft-deleting a user clears the contact back-reference",
    transaction: "delete-user",
    fields: [
      { source: [], target: ["uid_user"], transform: "clear" },
    ],
  },
];

const deleteUserTransaction: TransactionDefinition = {
  id: "delete-user",
  description: "Soft-deletes a user and clears the linked contact's uid_user back-reference.",
  steps: ["delete-user:unlink-contact"],
};

// ── Module ──────────────────────────────────────────────────────────
/** Everything `users.ts` contributes to the propagation catalog. */
export const users: PropagationModule = {
  rules: [
    ...createUserRules,
    ...updateUserRules,
    ...deleteUserRules,
  ],
  transactions: [
    createUserTransaction,
    updateUserTransaction,
    deleteUserTransaction,
  ],
};
