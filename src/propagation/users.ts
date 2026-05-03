/**
 * User propagation rules — create, update, and delete transactions.
 *
 * Traced from: api-cloudrun/src/services/users.ts
 */
import type { CollectionRule, TransactionDefinition } from "./types.ts";

// ── create-user ───────────────────────────────────────────────────

export const createUserRules: CollectionRule[] = [
  {
    id: "create-user:link-to-contact",
    source: "users",
    target: "contacts",
    mode: "co-write",
    invariant: "A new user with an email matching an existing contact links bidirectionally",
    transaction: "create-user",
    fields: [
      { source: ["uid"], target: ["uid_user"] },
    ],
  },
];

export const createUserTransaction: TransactionDefinition = {
  id: "create-user",
  description: "Creates a user; if email matches an existing contact, links bidirectionally.",
  steps: ["create-user:link-to-contact"],
};

// ── update-user ───────────────────────────────────────────────────

export const updateUserRules: CollectionRule[] = [
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
    invariant: "A user's display name stays in sync with every doc's created_by/updated_by/deleted_by.name (across every collection carrying an ActorRef) so activity feeds, threads, and comments never render a stale name",
    transaction: "update-user",
    trigger: "first_name/middle_name/last_name/pronunciation change on a user — rewrite actor.name wherever actor.uid matches",
    fields: [
      { source: ["first_name", "middle_name", "last_name", "pronunciation"], target: ["created_by", "name"], transform: "ActorRef.name — [first, middle, last].filter(Boolean).join(\" \") with \" (pronunciation)\" appended when pronunciation is set" },
      { source: ["first_name", "middle_name", "last_name", "pronunciation"], target: ["updated_by", "name"], transform: "same formula as created_by.name" },
      { source: ["first_name", "middle_name", "last_name", "pronunciation"], target: ["deleted_by", "name"], transform: "same formula as created_by.name; only where deleted_by is non-null" },
      { source: ["first_name", "middle_name", "last_name", "pronunciation"], target: ["pdf_versions", "created_by", "name"], transform: "invoices-only — rewrite the name on matching pdf_versions[].created_by entries" },
      { source: ["first_name", "middle_name", "last_name", "pronunciation"], target: ["reactions", "name"], transform: "comments-only — rewrite the name on every reactions[emoji][uid] entry where uid matches the renamed user" },
    ],
  },
];

export const updateUserTransaction: TransactionDefinition = {
  id: "update-user",
  description: "Updates a user with name cascade to a linked contact (if any) and fan-out to ActorRef names on every doc carrying created_by/updated_by/deleted_by.",
  steps: ["update-user:name-to-contact", "update-user:name-to-actor-refs"],
};

// ── delete-user ───────────────────────────────────────────────────

export const deleteUserRules: CollectionRule[] = [
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

export const deleteUserTransaction: TransactionDefinition = {
  id: "delete-user",
  description: "Soft-deletes a user and clears the linked contact's uid_user back-reference.",
  steps: ["delete-user:unlink-contact"],
};
