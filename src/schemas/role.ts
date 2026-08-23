/**
 * Role document schema — Firestore collection: roles
 *
 * Roles are composable bundles of permission strings. Each user document
 * carries a `roles` array of role names; the API resolves names to
 * permissions at session time and encodes them on the custom claims.
 */
import { z } from "zod";
import { type FirestoreTimestampType, TimestampFields } from "./common.ts";
import { RoleId, ThreadId } from "./_uid.ts";

/** A role document in Firestore. */
/**
 * The PUBLIC projection of a {@link Role} — what `GET /admin/roles` returns and
 * what the manager's roles table renders.
 *
 * ⚠️ **Deliberately its own type, not a re-export of `Role`.** It drops
 * `uid_thread` and both timestamps, which are storage concerns no client needs;
 * re-exporting `Role` would make widening the document a wire change.
 *
 * It exists because api-cloudrun's `RoleSummary` and manager's `RoleRow` were
 * declared separately and verified field-for-field identical (core#59) — two
 * copies of one wire contract, agreeing only by luck. `name` keeps its name:
 * that IS the wire field, and the `roles.name`-not-`uid` carve-out is declared
 * in `core/CLAUDE.md` § *UID property naming*.
 */
export interface RoleSummary {
  name: string;
  label: string;
  permissions: string[];
  description?: string;
}

/** Zod schema for {@link RoleSummary}. */
export const RoleSummarySchema: z.ZodType<RoleSummary> = z.object({
  name: RoleId,
  label: z.string(),
  permissions: z.array(z.string()),
  description: z.string().optional(),
});

export interface Role {
  name: string;
  label: string;
  permissions: string[];
  description?: string;
  uid_thread?: string;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}

// The 64-char name cap keeps customClaims.roles[] under Firebase's 1000-byte
// token limit. Raising it forces a claim-size review.

/**
 * ⚠️ **A change to this schema is a FULL-API OUTAGE until every stored
 * `roles/{name}` document has been migrated** (api-cloudrun#443). Read this
 * before editing anything below.
 *
 * `permissionCache` (api-cloudrun `api-cloudrun/src/lib/permissionCache.ts`) parses each role
 * document on the way to resolving a session's permissions, and
 * `requirePermission` is mounted globally on the authenticated band. So a role
 * document this schema rejects resolves to **zero permissions** — for every
 * holder of that role, **including `admin`** — and every authenticated route
 * answers 403. The cache holds the failure for its 60s TTL, so the outage
 * survives a redeploy.
 *
 * Three properties make this sharper than it first looks:
 *
 * 1. **`z.strictObject` means even a purely ADDITIVE stored field does it.** A
 *    field written to `roles/{name}` before the schema knows about it is an
 *    unrecognized key, which is a parse failure, not a tolerated extra.
 * 2. **A rename or a tightening does it too**, so "just loosen the schema" is
 *    not the fix. Every schema in this package is `z.strictObject` (40 files);
 *    loosening this one would be inconsistent AND would not remove the class.
 * 3. **It presents as a permissions misconfiguration, not as an outage.** The
 *    symptom is 403 `PERMISSION_DENIED`, which reads as "this user's roles are
 *    wrong" and sends the operator to the role editor — which is itself behind
 *    the same 403.
 *
 * **So: migrate the stored role documents FIRST, in the same sitting as the
 * deploy that changes this file.** `api-cloudrun/scripts/seed-rbac.ts` (dry-run default,
 * `--write`) is the migrator; `api-cloudrun/scripts/audit-env-definitions.ts` diffs live
 * `roles/*.permissions` against `api-cloudrun/scripts/rbacRoles.ts` per environment.
 *
 * The api side no longer conflates *absent* with *unreadable*: a parse failure
 * throws and surfaces as **503 `ROLE_CONFIG_UNREADABLE`**, which is still
 * fail-closed (it grants nothing) but trips 5xx alerting and stops reading as a
 * user-level permissions problem. `RbacRoleSchemaInvalid` (severity `critical`,
 * `infra/observability/vmalert/rules-vlogs.yml`) fires on the log line.
 */
/** Zod schema for Role. */
export const RoleSchema: z.ZodType<Role> = z.strictObject({
  // The doc id, deliberately named `name` rather than `uid` — a declared
  // carve-out from the uid convention, because security rules can only `get()`
  // by path. `RoleId` is the ONE definition of this shape (core#59); it used to
  // be spelled here, in `session.ts`, and five more times across two repos.
  name: RoleId.meta({ pii: "none", column: true, label: "Name" }),
  label: z.string().min(1).max(128).meta({ pii: "none", column: true, label: "Label" }),
  permissions: z.array(z.string()).default([]).meta({ column: true, label: "Permissions" }),
  description: z.string().max(500).optional().meta({ column: true, label: "Description" }),
  uid_thread: ThreadId.optional(),
  ...TimestampFields,
}).meta({
  title: "Role",
  collection: "roles",
  displayDefaults: {
    columns: ["name", "label", "description", "permissions"],
    filters: {},
    sort: { column: "name", direction: "asc" },
  },
});
