/**
 * Thread document schema — Firestore collection: threads
 *
 * A thread is a conversation attached to one or more source docs (orders,
 * invoices, contacts, organizations, cards, products, transactions, roles).
 * Each source doc gets a default thread cowritten on creation; some threads
 * (e.g. an event card's) carry multiple sources so they surface on every
 * linked doc's detail view.
 *
 * The polymorphic `{collection, uid}` source reference lives in `schemas/common.ts`
 * as `DocSource` — also used by Comment and Card.
 *
 * Access is purely RBAC-driven — no per-thread ACLs. Threads are deleted
 * only as a side effect of the last source doc being deleted (cascade wiring
 * lives on each entity's delete path, not here).
 */
import { z } from "zod";
import { ThreadId } from "./_uid.ts";
import {
  ActorRef,
  type ActorRefType,
  DocSource,
  type DocSourceType,
  FirestoreTimestamp,
  type FirestoreTimestampType,
  TimestampFields,
} from "./common.ts";

// ── Firestore document ──────────────────────────────────────────────

/** Thread Firestore document shape. */
export interface Thread {
  uid: string;
  sources: DocSourceType[];
  title: string | null;
  last_message_at: FirestoreTimestampType | null;
  last_message_preview: string;
  comment_count: number;
  version: number;
  created_by: ActorRefType;
  updated_by: ActorRefType;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}

/** Zod schema for a thread Firestore document. */
export const ThreadSchema: z.ZodType<Thread> = z.strictObject({
  uid: ThreadId,
  sources: z.array(DocSource).min(1),
  title: z.string().max(200).meta({ pii: "mask" }).nullable().meta({ column: true, label: "Title" }),
  last_message_at: FirestoreTimestamp.nullable().meta({ column: true, label: "Last Activity" }),
  last_message_preview: z.string().max(280).meta({ pii: "mask", column: true, label: "Last Message" }).default(""),
  // Required (no `.default(0)`): the `threads` Typesense config declares it so.
  // That config is `enabled: false` today — the parity gate deliberately walks
  // disabled collections too, so provisioning `threads` later cannot silently
  // reintroduce the bug. All three create paths (`threadsCoWrite`, `cards`,
  // `publishFromMerge`) already supply it; the increments go through `patch`.
  comment_count: z.int().min(0).meta({ column: true, label: "Comments" }),
  version: z.int().min(0).default(0),
  created_by: ActorRef.meta({ column: true, label: "Created By" }),
  updated_by: ActorRef.meta({ column: true, label: "Updated By" }),
  ...TimestampFields,
}).meta({
  title: "Thread",
  collection: "threads",
  displayDefaults: {
    columns: ["sources.collection", "title", "last_message_at", "comment_count"],
    filters: {},
    sort: { column: "last_message_at", direction: "desc" },
  },
});

// ── Input schemas ───────────────────────────────────────────────────

/** Input for PATCH /threads/:uid — rename only. */
export interface UpdateThreadInputType {
  title: string | null;
  version: number;
}

/** Zod schema for updating a thread. */
export const UpdateThreadInput: z.ZodType<UpdateThreadInputType> = z.object({
  title: z.string().max(200).meta({ pii: "mask" }).nullable(),
  version: z.int().min(0),
});
