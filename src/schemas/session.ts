/**
 * Session document schema — Firestore collection: sessions
 *
 * Copenhagen Book guidelines:
 * - Session IDs: 20 random bytes, hex-encoded (40 chars)
 * - Absolute expiry: 30 days with sliding window extension at 15 days
 * - TTL policy on expiresAt for automatic Firestore cleanup
 */
import { z } from "zod";
import { FirestoreTimestamp, type FirestoreTimestampType } from "./common.ts";
import { RoleId } from "./_uid.ts";

/**
 * Full session document schema (Firestore document shape).
 * Note: expiresAt kept in camelCase for Firestore TTL policy.
 */
export interface Session {
  /**
   * Firestore document id — which for this collection is **the session token
   * itself**, 40 hex chars. Renamed from `id` in core#58; see
   * `core/CLAUDE.md` § *UID property naming*.
   *
   * 🔴 **Renaming this field is not a cosmetic change, and the reason is that
   * api-cloudrun does not parse on read.** `getSession` returns
   * `snap.data() as Session` — a bare cast — so a document written before the
   * rename yields `session.uid === undefined` and three things break rather
   * than fail closed: the cookie is rewritten as `session=undefined` (logging
   * the user out), the sliding-window extension calls `.doc(undefined)` and
   * throws, and the rate limiter collapses every authenticated user into one
   * shared `auth:session:undefined` bucket.
   *
   * The 30-day TTL is therefore **not** a safe migration window. The
   * `sessions` collection must be PURGED as part of the deploy that ships this.
   * ⚠️ `deleteAllUserSessions` is per-user (`where("user_id","==",…)`), not
   * global — do not assume a ready-made global purge exists.
   *
   * ⚠️ This collection is in Class A *and* Class B of the census: the doc id is
   * a credential, which normally argues against copying it into the body at
   * all. It is copied here because readers already depend on it, and that
   * inconsistency is acknowledged rather than resolved — see the CLAUDE.md
   * section.
   */
  uid: string;
  user_id: string;
  anonymous: boolean;
  expiresAt: FirestoreTimestampType;
  created_at: number;
  user_agent: string;
  /**
   * Name of the role the caller is currently previewing the app as.
   * When set, /auth/me resolves permissions, custom-token claims, and
   * scoped Typesense keys against this role instead of the user's
   * real role assignments. Subset enforcement (target ⊆ caller real)
   * happens in POST /auth/preview-role and is re-validated by /auth/me.
   */
  preview_role?: string;
}

/** Zod schema for Session. */
export const SessionSchema: z.ZodType<Session> = z.strictObject({
  uid: z.string().length(40),
  // Internal Firestore uid, not customer data — same call as `log/base.ts`.
  user_id: z.string().meta({ pii: "none" }),
  anonymous: z.boolean(),
  expiresAt: FirestoreTimestamp,
  created_at: z.number(),
  user_agent: z.string(),
  // Same shape as `roles.name`, and it must STAY the same: this is matched
  // against a role id to resolve preview permissions. It carried its own
  // regex until core#59.
  preview_role: RoleId.optional(),
}).meta({ title: "Session", collection: "sessions" });
