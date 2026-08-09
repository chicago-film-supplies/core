/**
 * Role document schema — Firestore collection: roles
 *
 * Roles are composable bundles of permission strings. Each user document
 * carries a `roles` array of role names; the API resolves names to
 * permissions at session time and encodes them on the custom claims.
 */
import { z } from "zod";
import { type FirestoreTimestampType, TimestampFields } from "./common.ts";
import { ThreadId } from "./_uid.ts";

/** A role document in Firestore. */
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
 * `permissionCache` (api-cloudrun `src/lib/permissionCache.ts`) parses each role
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
 * deploy that changes this file.** `scripts/seed-rbac.ts` (dry-run default,
 * `--write`) is the migrator; `scripts/audit-env-definitions.ts` diffs live
 * `roles/*.permissions` against `scripts/rbacRoles.ts` per environment.
 *
 * The api side no longer conflates *absent* with *unreadable*: a parse failure
 * throws and surfaces as **503 `ROLE_CONFIG_UNREADABLE`**, which is still
 * fail-closed (it grants nothing) but trips 5xx alerting and stops reading as a
 * user-level permissions problem. `RbacRoleSchemaInvalid` (severity `critical`,
 * `infra/observability/vmalert/rules-vlogs.yml`) fires on the log line.
 */
/** Zod schema for Role. */
export const RoleSchema: z.ZodType<Role> = z.strictObject({
  name: z.string().regex(/^[a-z][a-z0-9_-]*$/, "Must be lowercase alphanumerics, hyphens, or underscores").min(1).max(64).meta({ pii: "none", column: true, label: "Name" }),
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
