/**
 * List document schema — Firestore collection: lists
 *
 * A list is a user-visible bucket of cards (Field service, In-store, To do,
 * Purchases, custom). Shared across the org — not per-user. Lists are
 * reorderable via a fractional `position` (float); cards within a list carry
 * their own `uid_list` pointer + `position`.
 *
 * Lists are small (tens, not thousands) and rarely change, so they're not
 * synced to Typesense — the manager loads them once into a store.
 */
import { z } from "zod";
import {
  ActorRef,
  type ActorRefType,
  type FirestoreTimestampType,
  TimestampFields,
} from "./common.ts";

// ── Lock keys ───────────────────────────────────────────────────────

const LIST_LOCK_KEYS = [
  "list",
  "create_card",
  "update_card",
  "delete_card",
] as const;
/**
 * Enum of lockable list surfaces. Mirrors the `CardLockKey` shape: presence in
 * `List.locked[]` blocks the corresponding action. Defaults to `[]`.
 *
 * - `"list"` — sentinel: blocks DELETE of this list doc
 * - `"create_card"` — blocks `POST /cards` with `uid_list` = this list
 * - `"update_card"` — blocks `PATCH /cards/:uid` for cards on this list
 * - `"delete_card"` — blocks `DELETE /cards/:uid` for cards on this list
 *
 * Used by system-managed lists (e.g. `field-service`, `in-store`) whose cards
 * are fanned out from order events and shouldn't be created or deleted by
 * users — the API still updates them, and users can still edit non-locked
 * fields per `Card.locked[]`.
 */
export type ListLockKey = typeof LIST_LOCK_KEYS[number];
/** Zod schema for ListLockKey. */
export const ListLockKeyEnum: z.ZodType<ListLockKey> = z.enum(LIST_LOCK_KEYS);

// ── Firestore document ──────────────────────────────────────────────

/** List Firestore document shape. */
export interface List {
  uid: string;
  name: string;
  description: string;
  icon: string | null;
  color: string | null;
  position: number;
  locked: ListLockKey[];
  version: number;
  created_by: ActorRefType;
  updated_by: ActorRefType;
  created_at?: FirestoreTimestampType;
  updated_at?: FirestoreTimestampType;
}

/** Zod schema for a list Firestore document. */
export const ListSchema: z.ZodType<List> = z.strictObject({
  uid: z.string(),
  name: z.string().min(1).max(80).meta({ pii: "none" }),
  description: z.string().max(500).meta({ pii: "none" }).default(""),
  icon: z.string().max(64).nullable(),
  color: z.string().max(16).nullable(),
  position: z.number(),
  locked: z.array(ListLockKeyEnum).default([]),
  version: z.int().min(0).default(0),
  created_by: ActorRef,
  updated_by: ActorRef,
  ...TimestampFields,
}).meta({
  title: "List",
  collection: "lists",
  displayDefaults: {
    columns: ["name", "description", "position"],
    filters: {},
    sort: { column: "position", direction: "asc" },
  },
});

// ── Input schemas ───────────────────────────────────────────────────

/** Input for POST /lists. */
export interface CreateListInputType {
  name: string;
  description?: string;
  icon?: string | null;
  color?: string | null;
  position?: number;
  locked?: ListLockKey[];
}

/** Zod schema for creating a list. */
export const CreateListInput: z.ZodType<CreateListInputType> = z.object({
  name: z.string().min(1).max(80).meta({ pii: "none" }),
  description: z.string().max(500).meta({ pii: "none" }).optional(),
  icon: z.string().max(64).nullable().optional(),
  color: z.string().max(16).nullable().optional(),
  position: z.number().optional(),
  locked: z.array(ListLockKeyEnum).optional(),
});

/** Input for PATCH /lists/:uid — all fields optional except version. */
export interface UpdateListInputType {
  name?: string;
  description?: string;
  icon?: string | null;
  color?: string | null;
  position?: number;
  locked?: ListLockKey[];
  version: number;
}

/** Zod schema for updating a list. */
export const UpdateListInput: z.ZodType<UpdateListInputType> = z.object({
  name: z.string().min(1).max(80).meta({ pii: "none" }).optional(),
  description: z.string().max(500).meta({ pii: "none" }).optional(),
  icon: z.string().max(64).nullable().optional(),
  color: z.string().max(16).nullable().optional(),
  position: z.number().optional(),
  locked: z.array(ListLockKeyEnum).optional(),
  version: z.int().min(0),
});
