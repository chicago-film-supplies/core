/**
 * User document schema — Firestore collection: users
 */
import { z } from "zod";
import { FirestoreId } from "./_uid.ts";
import {
  Email,
  FirestoreTimestamp,
  type FirestoreTimestampType,
  NameField,
  type NameParts,
  NamePartsFields,
  NamePartsFieldsPartial,
  type PartialNameParts,
  TimestampFields,
} from "./common.ts";

// ── Preference sub-schemas ──────────────────────────────────────────

/** Sort configuration for a display preference (column + direction). */
export interface DisplaySort {
  column: string | null;
  direction: "asc" | "desc";
}

const DisplaySortSchema: z.ZodType<DisplaySort> = z.strictObject({
  column: z.string().nullable(),
  direction: z.enum(["asc", "desc"]),
});

/** User display preferences for a Firestore-backed collection view. */
export interface FirestoreDisplayPrefs {
  columns: string[];
  filters: Record<string, (string | boolean)[]>;
  sort: DisplaySort;
}

export const FirestoreDisplayPrefsSchema: z.ZodType<FirestoreDisplayPrefs> = z.strictObject({
  columns: z.array(z.string()),
  filters: z.record(z.string(), z.array(z.union([z.string(), z.boolean()]))),
  sort: DisplaySortSchema,
});

/**
 * User display preferences for a Typesense-backed collection view.
 *
 * `group` and `facet` were removed here alongside
 * {@linkcode TypesenseDisplayDefaults} — both were written on every save and
 * read by nothing. This object is **strict**, so a blob still carrying them
 * fails to parse; the write path does not validate (`updateUser` merges and
 * `transaction.set`s), so nothing breaks at runtime, but
 * `api-cloudrun/scripts/audit-schema-validation.ts --only=users` will report it. Both
 * environments held `{}` when this landed, so there was nothing to migrate.
 */
export interface TypesenseDisplayPrefs {
  columns: string[];
  filters: Record<string, (string | boolean)[]>;
  sort: DisplaySort;
}

export const TypesenseDisplayPrefsSchema: z.ZodType<TypesenseDisplayPrefs> = z.strictObject({
  columns: z.array(z.string()),
  filters: z.record(z.string(), z.array(z.union([z.string(), z.boolean()]))),
  sort: DisplaySortSchema,
});

/**
 * Full user document schema (Firestore document shape).
 */
export interface User extends NameParts {
  uid: string;
  email: string;
  name: string;
  password_hash: string;
  email_verified: boolean;
  uid_contact?: string | null;
  roles?: string[];
  token_version?: number;
  version: number;
  prefs_firestore: Record<string, FirestoreDisplayPrefs>;
  prefs_typesense: Record<string, TypesenseDisplayPrefs>;
  deleted_at?: FirestoreTimestampType | null;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}

/** Zod schema for a full user Firestore document. */
export const UserSchema: z.ZodType<User> = z.strictObject({
  uid: FirestoreId,
  email: Email.meta({ column: true, label: "Email" }),
  ...NamePartsFields,
  name: NameField.meta({ column: true, label: "Name" }),
  password_hash: z.string().min(1).meta({ pii: "redact" }),
  // Required (no `.default(false)`): the Typesense config declares it so, and a
  // `.default()` never materializes on a write — see the note in `product.ts`.
  email_verified: z.boolean(),
  uid_contact: FirestoreId.nullable().optional(),
  roles: z.array(z.string()).optional().meta({ column: true, label: "Roles" }),
  token_version: z.int().min(0).optional(),
  version: z.int().min(0).default(0),
  prefs_firestore: z.record(z.string(), FirestoreDisplayPrefsSchema),
  prefs_typesense: z.record(z.string(), TypesenseDisplayPrefsSchema),
  deleted_at: FirestoreTimestamp.nullable().optional(),
  ...TimestampFields,
}).meta({
  title: "User",
  collection: "users",
  displayDefaults: {
    columns: ["email", "name", "roles"],
    filters: {},
    sort: { column: "name", direction: "asc" },
  },
});

// ── Input schemas ───────────────────────────────────────────────────

/** Payload for creating a user — used internally by the accept-invite flow. */
export interface CreateUserInputType extends NameParts {
  email: string;
  password: string;
  roles?: string[];
  uid_contact?: string | null;
}

/** Input schema for creating a user (internal — not exposed as a public route). */
export const CreateUserInput: z.ZodType<CreateUserInputType> = z.object({
  email: Email,
  ...NamePartsFields,
  password: z.string().min(8).max(128).meta({ pii: "redact" }),
  roles: z.array(z.string()).optional(),
  uid_contact: FirestoreId.nullable().optional(),
});

/** Payload for PUT /users/:uid — full-doc replace; server-managed fields excluded. */
export interface UpdateUserInputType extends PartialNameParts {
  email?: string;
  uid_contact?: string | null;
  version: number;
  prefs_firestore?: Record<string, FirestoreDisplayPrefs>;
  prefs_typesense?: Record<string, TypesenseDisplayPrefs>;
}

/** Input schema for updating a user. */
export const UpdateUserInput: z.ZodType<UpdateUserInputType> = z.object({
  email: Email.optional(),
  ...NamePartsFieldsPartial,
  uid_contact: FirestoreId.nullable().optional(),
  version: z.int().min(0),
  prefs_firestore: z.record(z.string(), FirestoreDisplayPrefsSchema).optional(),
  prefs_typesense: z.record(z.string(), TypesenseDisplayPrefsSchema).optional(),
});
