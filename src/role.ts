/**
 * Role document schema — Firestore collection: roles
 *
 * Roles are composable bundles of permission strings. Each user document
 * carries a `roles` array of role names; the API resolves names to
 * permissions at session time and encodes them on the custom claims.
 */
import { z } from "zod";
import { type FirestoreTimestampType, TimestampFields } from "./common.ts";

/** A role document in Firestore. */
export interface Role {
  name: string;
  label: string;
  permissions: string[];
  description?: string;
  defaultThreadId?: string;
  created_at?: FirestoreTimestampType;
  updated_at?: FirestoreTimestampType;
}

// The 64-char name cap keeps customClaims.roles[] under Firebase's 1000-byte
// token limit. Raising it forces a claim-size review.
/** Zod schema for Role. */
export const RoleSchema: z.ZodType<Role> = z.strictObject({
  name: z.string().regex(/^[a-z][a-z0-9_-]*$/, "Must be lowercase alphanumerics, hyphens, or underscores").min(1).max(64).meta({ pii: "none" }),
  label: z.string().min(1).max(128).meta({ pii: "none" }),
  permissions: z.array(z.string()).default([]),
  description: z.string().max(500).optional(),
  defaultThreadId: z.string().optional(),
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
