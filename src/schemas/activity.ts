/**
 * Activity feed row — Firestore collection: `activities`.
 *
 * One document per **operator action**, not per document write. A single
 * `create-order` writes an order, N bookings, M event cards, a fulfillment and
 * (1+M) threads inside one transaction; the feed shows that as one row that
 * expands to its field-level changes. Captured from the Eventarc triggers that
 * already fire (`api-cloudrun/src/routes/eventarc.ts`), so nothing is added
 * inside any transaction and no write is slowed.
 *
 * Read by manager's `/activity` for non-technical staff: *"doc A was changed to
 * X from Y by actor at time"*. A daily activity log, not engineering telemetry
 * — VictoriaLogs was ruled out as the datasource because no server-side
 * mutation carries an actor (`LogContext.user_id` is declared and never
 * populated — api-cloudrun#816), there is no before/after, and its 90-day
 * retention with `-delete.enable` means a DSAR erasure would retroactively
 * delete feed rows.
 *
 * ## The fold key, and why it is a plain string
 *
 * `correlation` is `Movement.uuid_session` where one exists, and otherwise the
 * Firestore **commit timestamp** — which is exact rather than heuristic:
 * measured on dev 2026-09-04, a 3-document transaction stamps all three
 * `1788572290.032558000` while three separate commits land 66-83 ms apart.
 * `api-cloudrun/tests/integration/eventarc/commitTime.test.ts` keeps that true.
 *
 * ⚠️ **A DELETE has no commit timestamp on the wire.** Eventarc sends no
 * after-snapshot for one, and `oldValue.update_time` is the time of whatever
 * edit last touched the document — so a capture path that fell back to it would
 * correlate a deletion with an unrelated earlier action and, under the
 * deterministic row id, merge into that action's row. The decoder names the two
 * times separately (`commitTime` / `priorCommitTime`) precisely so that is not
 * reachable by accident.
 *
 * ## Retention is a FIELD, not just a policy
 *
 * `expires_at` exists because Firestore's TTL deletes a document when a named
 * timestamp field passes — `local.firestore_ttls` in
 * `api-cloudrun/infra/firestore.tf` maps a collection to that field name. A TTL
 * registered against a field no document carries is **silently inert**: nothing
 * errors, nothing logs, and the collection grows forever. Same shape as
 * `uploadcare-worklist`, which is the structural precedent for this whole
 * document (`created_at` + `expires_at`, no `updated_at`).
 *
 * Horizon is 400 days, set by the writer. It must outlive the 90-day
 * VictoriaLogs retention that `request_id` drills into, so a row can outlive
 * its own log trail — that is expected, and a dead `request_id` is a dead link,
 * not a corruption.
 *
 * ## `at` and `created_at` are different questions
 *
 * `at` is when the change happened (the commit being described); `created_at`
 * is when this row was written. They differ by Eventarc delivery lag, and
 * keeping them distinct is what makes that lag observable rather than folded
 * away. Sorting is on `at`.
 */
import { z } from "zod";
import {
  ActorRef,
  type ActorRefType,
  AnyUid,
  FirestoreTimestamp,
  type FirestoreTimestampType,
} from "./common.ts";
import { chicagoInstant } from "./_datetime.ts";
import { PERMISSIONS, type Permission } from "./permissions.ts";

/**
 * Collections a feed row can point at.
 *
 * Measured 2026-09-04: exactly the collections whose schema declares an
 * `updated_by` actor, which is the capture filter itself — a collection with no
 * actor is derived, not authored, and has nobody to attribute a change to.
 * Counted from declarations rather than a `grep`, because `order.ts` matched the
 * string in a comment explaining the field's absence for as long as it was
 * absent.
 *
 * ⚠️ **Deliberately NOT `CollectionName`.** That union is derived from the
 * schema registry this file is part of, so using it would be circular — but the
 * cycle has a known workaround (`import type` plus `z.custom`, as
 * `propagation/types.ts` does) and **over-admission does not**. The registry
 * carries `counters`, `sessions`, `rate-limits`, `cache-geocodes` and ~40 more
 * that have no actor and can never be a feed subject; `CollectionName` would
 * type-check every one of them, and buy no runtime validation, which is the
 * whole point of the field. Same reasoning `uploadcare-worklist.ts` records for
 * its own pinned list.
 *
 * ⚠️ **And deliberately NOT `CFS_SOURCE_COLLECTIONS`.** Measured against this
 * list: it would DROP 10 of these (`chart-of-accounts`, `comments`,
 * `department-types`, `holiday-definitions`, `lists`, `recurrences`, `tags`,
 * `taxes`, `threads`, `tracking-categories`) and admit 4 that carry no actor
 * (`bookings`, `locations`, `roles`, `templates-versions`). Widening it to fit
 * is not local — `Thread`, `Comment`, `Card`, `Recurrence`, `Transaction` and
 * `OutOfService` all consume it, so widening would let a comment point at a tax
 * rate. **A scoped view must not widen the vocabulary it borrows.**
 */
const ACTIVITY_SUBJECT_COLLECTIONS = [
  "cards",
  "chart-of-accounts",
  "comments",
  "contacts",
  "credit-notes",
  "department-types",
  "holiday-definitions",
  "invoices",
  "lists",
  "orders",
  "organizations",
  "out-of-service",
  "products",
  "recurrences",
  "settlements",
  "suppliers",
  "tags",
  "taxes",
  "template-components",
  "templates",
  "threads",
  "tracking-categories",
  "transactions",
] as const;
/** A collection an {@link ActivitySubjectType} can name. */
export type ActivitySubjectCollection = typeof ACTIVITY_SUBJECT_COLLECTIONS[number];
/** Zod schema for {@link ActivitySubjectCollection}. */
export const ActivitySubjectCollectionEnum: z.ZodType<ActivitySubjectCollection> = z.enum(
  ACTIVITY_SUBJECT_COLLECTIONS,
);

const ACTIVITY_OPERATIONS = ["created", "updated", "deleted"] as const;
/** What happened to the subject document. */
export type ActivityOperation = typeof ACTIVITY_OPERATIONS[number];
/** Zod schema for {@link ActivityOperation}. */
export const ActivityOperationEnum: z.ZodType<ActivityOperation> = z.enum(ACTIVITY_OPERATIONS);

/**
 * What kind of actor did it.
 *
 * Integrations and scripts are captured rather than filtered at write time —
 * "who changed this" is often exactly the question when an integration did —
 * but the page filters them out by default. Deriving this at READ time from the
 * uid's shape would mean every reader re-implementing the bot-slug convention,
 * so the writer decides it once.
 */
const ACTOR_KINDS = ["user", "integration", "script"] as const;
/** Whether the actor is a person, a named integration, or a migration/seed script. */
export type ActorKind = typeof ACTOR_KINDS[number];
/** Zod schema for {@link ActorKind}. */
export const ActorKindEnum: z.ZodType<ActorKind> = z.enum(ACTOR_KINDS);

/** The document a feed row is about. */
export interface ActivitySubjectType {
  collection: ActivitySubjectCollection;
  uid: string;
  /**
   * Human label — "Order #1042" — resolved at WRITE time.
   *
   * ⚠️ Not a join key, and not resolvable at read time on purpose. `manager`
   * `11690b5` fixed a listener-per-row leak where a tile fetched its own source
   * document and `getCard`'s cache-hit path started an `onSnapshot` per visible
   * row, on documents the page query already streamed. A feed row referencing a
   * subject document is structurally identical, so the label is denormalized
   * here and the row renders from itself — the same reason `MovementTimeline`
   * receives `sources[]` already labelled.
   */
  label: string;
}

/** Zod schema for {@link ActivitySubjectType}. */
export const ActivitySubject: z.ZodType<ActivitySubjectType> = z.strictObject({
  collection: ActivitySubjectCollectionEnum.meta({ column: true, label: "Collection" }),
  // Polymorphic across composite-keyed collections too (`transactions` ids are
  // `{uuid_session}|{type}|{subject}`, bookings are composite), so AnyUid rather
  // than FirestoreId.
  uid: AnyUid,
  label: z.string().max(200).meta({ column: true, label: "Subject" }),
});

/** One field-level change inside an activity row. */
export interface ActivityChangeType {
  path: string;
  label: string;
  before: string | null;
  after: string | null;
}

/**
 * Zod schema for {@link ActivityChangeType}.
 *
 * `before`/`after` are RENDERED strings, not the raw values. Three reasons, and
 * the third is the one that decides it: a Firestore document cannot hold
 * arbitrary union-typed values without a schema per field; the feed's audience
 * is non-technical, so a rendered value is what they need anyway; and a value
 * passed through `applyPii` (a field tagged `pii: "mask"` is masked here as it
 * is in the logs) is a string by the time masking is done. `null` is "absent",
 * distinct from the string `"null"`.
 */
export const ActivityChange: z.ZodType<ActivityChangeType> = z.strictObject({
  // Dotted, and array-crossing segments keep their index — `items.3.price` — so
  // a reader can point at the row that changed.
  path: z.string().min(1).max(300),
  // From the source field's own `.meta({ label })`, so the wording tracks the
  // schema rather than a hand-maintained map that rots. A path whose field
  // carries no label does not become a row at all (capture filter 2).
  label: z.string().max(200),
  before: z.string().max(500).nullable(),
  after: z.string().max(500).nullable(),
});

/** One operator action, as shown in manager's `/activity`. */
export interface Activity {
  uid: string;
  at: string;
  at_fs: FirestoreTimestampType;
  actor: ActorRefType;
  actor_kind: ActorKind;
  subject: ActivitySubjectType;
  operation: ActivityOperation;
  correlation: string;
  read_permission: Permission;
  request_id: string | null;
  changes: ActivityChangeType[];
  created_at: FirestoreTimestampType;
  expires_at: FirestoreTimestampType;
}

/** Zod schema for the full activity Firestore document. */
export const ActivitySchema: z.ZodType<Activity> = z.strictObject({
  uid: z.string().min(1),
  /**
   * When the change happened.
   *
   * ⚠️ **The `at` / `at_fs` pairing is not decoration.** A Chicago-offset ISO
   * string sorts wall-clock before offset, which inverts the autumn fall-back
   * hour — `manager` `11690b5` fixed exactly that after a sort chain emitted the
   * same instant twice, the second copy as a string. `serverSortVia` is the
   * declaration `getServerSortableColumns` (`zod-walk.ts`) reads to route the
   * sort to the Timestamp companion, so declaring it here is what stops the
   * feed — a list whose ONLY ordering is time — recreating that trap.
   */
  at: chicagoInstant().meta({ serverSortVia: "at_fs", column: true, label: "When" }),
  at_fs: FirestoreTimestamp,
  /**
   * ⚠️ **Top-level, never inside an array.** `actorRefPaths.ts` derives every
   * `ActorRef` site by walking the Zod registry, and an actor nested in an array
   * makes `requiresScan()` true — degrading the user-rename cascade from a
   * targeted update to a full-collection read-modify-write, on what will be the
   * largest collection in the system.
   */
  actor: ActorRef.meta({ column: true, label: "Who" }),
  actor_kind: ActorKindEnum.meta({ column: true, label: "Actor Kind" }),
  subject: ActivitySubject,
  operation: ActivityOperationEnum.meta({ column: true, label: "Operation" }),
  /**
   * `Movement.uuid_session`, or the Firestore commit timestamp as epoch
   * micros — see this file's header for why a delete cannot supply one.
   *
   * A string rather than a number because the two sources are not the same
   * kind of value and must never be compared as one; the reader folds on
   * `(actor.uid, correlation)` equality only.
   */
  correlation: z.string().min(1).max(200),
  /**
   * The permission that gates the SOURCE document, mirrored onto the row.
   *
   * A flat `activities.read` would let someone holding `orders.read` but not
   * `invoices.read` read invoice contents off the feed, because a Firestore
   * rules read grant is whole-document — rules cannot project
   * (api-cloudrun#698). Measured on the emulator 2026-09-04 against the real
   * `manager/firestore.rules`: `hasPermission(resource.data.read_permission)`
   * costs exactly what a literal `hasPermission("orders.read")` costs, because
   * `resource.data` is the already-fetched document and not a `get()`.
   *
   * ⚠️ The client MUST constrain its query to the intersection of feed
   * permissions and permissions the user holds — rules are not filters, and
   * over-asking by a single unheld value denies the whole page. That `in`
   * constraint caps at 30 values against this feed's 23 collections, and the
   * cap binds on the ADMIN first.
   *
   * `z.enum(PERMISSIONS)` is a true runtime enum here: `PERMISSIONS` is a real
   * array, unlike `CollectionName`.
   */
  read_permission: z.enum(PERMISSIONS).meta({ label: "Read Permission" }),
  /** Drill-down into VictoriaLogs. Null when the write had no request context. */
  request_id: z.string().max(200).nullable(),
  /**
   * ⚠️ **Capped.** The writer merges repeat deliveries with
   * `FieldValue.arrayUnion`, which grows without bound — a bulk operation would
   * otherwise mint one enormous document, and Firestore's 1 MiB limit is a hard
   * write failure rather than a truncation. The cap is what makes the
   * idempotent merge safe; the row records that it was truncated rather than
   * silently showing a partial list.
   */
  changes: z.array(ActivityChange).max(50),
  created_at: FirestoreTimestamp.meta({ column: true, label: "Recorded" }),
  expires_at: FirestoreTimestamp,
}).meta({
  title: "Activity",
  collection: "activities",
  displayDefaults: {
    columns: ["at", "actor", "operation", "subject.label"],
    // `actor_kind` because the ask is explicit that integrations are captured
    // but filtered out by default — the page opens on people. Empty selection
    // means "no filter applied"; the manager store narrows it.
    filters: { actor_kind: [], "subject.collection": [] },
    sort: { column: "at", direction: "desc" },
  },
});
