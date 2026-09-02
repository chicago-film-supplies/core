/**
 * Contact document schema — Firestore collection: contacts
 */
import { z } from "zod";
import { FirestoreId, ThreadId } from "./_uid.ts";
import {
  ActorRef,
  type ActorRefType,
  Email,
  type FirestoreTimestampType,
  NameField,
  type NameParts,
  NamePartsFields,
  NamePartsFieldsPartial,
  type PartialNameParts,
  Phone,
  TimestampFields,
} from "./common.ts";

/**
 * Organization reference embedded in a contact document — **the uid alone**.
 *
 * 🔴 **`name` is OPTIONAL only for the length of the removal, and nothing may
 * read it.** Population A2 of `api-cloudrun/.claude/plans/org-name-is-derived.md`:
 * a contact's employer is a LIVE fact, not a frozen one, so unlike an order's
 * snapshot this edge stores no `path` either — the label is composed from the
 * organization the uid addresses, every time it is produced. That is what makes
 * staleness unrepresentable here rather than merely policed, and it is why
 * `update-org:name-to-contacts` is DELETED rather than relocated.
 *
 * ⭐ **Optional is the middle of a three-step removal, not the destination.**
 * A `z.strictObject` makes *field required* and *field deleted* disjoint
 * accepted sets, so neither single-step ordering works: delete-first leaves
 * every unpurged document unwritable, purge-first leaves every purged document
 * unwritable by the build still deployed. The sequence is
 * **optional → stop the writer → empty storage → delete**, and the writer stops
 * in THIS publish (see `~/cfs/CLAUDE.md` § *Cross-repo publish/deploy order*).
 *
 * ⚠️ **The index does NOT lose the column.** `contacts_v8` still declares
 * `organizations.name`; api-cloudrun's `translateForTypesense` composes it at
 * index time from the live organization. A derived value is fine to DELIVER —
 * the defect is storing it next to its input.
 */
export interface ContactOrganizationType {
  uid: string;
  /** @deprecated Being removed — see the type docstring. Compose instead. */
  name?: string;
}

/** Zod schema for an organization reference embedded in a contact. */
export const ContactOrganization: z.ZodType<ContactOrganizationType> = z.strictObject({
  uid: FirestoreId,
  // ⚠️ Keeps `column: true` through the window: the Typesense column it
  // annotates survives the removal, because the INDEX keeps composing a name.
  name: z.string().min(1, "Organization name is required").max(100).optional().meta({ pii: "mask", column: true, linkTo: "organizationDetail" }),
});

/**
 * Full contact document schema (Firestore document shape).
 */
export interface Contact extends NameParts {
  uid: string;
  name: string;
  crms_id?: number;
  emails: string[];
  phones: string[];
  organizations: ContactOrganizationType[];
  query_by_organizations: string[];
  uid_user?: string;
  /**
   * Required. `createContact` (`api-cloudrun/src/services/contacts.ts`) stamps
   * `threadDoc.uid` in the same transaction that writes the contact.
   * **166 of 166 prod and 178 of 178 dev contacts carry the key** (measured
   * 2026-08-23 by `orderBy` key-presence; the dev figure is the load-bearing
   * one — its 12 dev-native contacts all carry it, so this is not an artefact
   * of the CRMS ingest).
   *
   * ⚠️ Contrast `crms_id` on this same document, which is 166/166 in prod and
   * **166 of 178 in dev** — those 12 dev-native contacts are exactly what keeps
   * that field optional.
   */
  uid_thread: string;
  version: number;
  created_by: ActorRefType;
  updated_by: ActorRefType;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}

/** Zod schema for a full contact Firestore document. */
export const ContactSchema: z.ZodType<Contact> = z.strictObject({
  uid: FirestoreId,
  ...NamePartsFields,
  // A clone, so the shared `NameField` stays unannotated: the contact's own
  // name is a column headed "Name", while the same schema under `created_by`
  // is not a column at all (the ActorRef object above it is).
  name: NameField.meta({ column: true, label: "Name", linkTo: "contactDetail" }),
  crms_id: z.int().optional(),
  // Required (no `.default([])`): the Typesense config declares them so, and a
  // `.default()` never materializes on a write — see the note in `product.ts`.
  emails: z.array(Email).meta({ column: true, label: "Emails" }),
  phones: z.array(Phone).meta({ column: true, label: "Phones" }),
  organizations: z.array(ContactOrganization).default([]).meta({ label: "Organizations" }),
  query_by_organizations: z.array(z.string()).default([]),
  // Declared ahead of use, and NOT dead. `api-cloudrun/src/services/contacts.ts`
  // writes it whenever a contact resolves to a user, and `src/schemas/propagation/users.ts`
  // carries both the set and the clear — but no contact has ever been linked:
  // 0 of 166 prod docs carry the KEY (2026-08-23). See CLAUDE.md § "Is a field
  // dead?" — absence here is a fact about the linking flow, not this field.
  uid_user: FirestoreId.optional(),
  uid_thread: ThreadId,
  version: z.int().min(0).default(0),
  created_by: ActorRef.meta({ column: true, label: "Created By" }),
  updated_by: ActorRef.meta({ column: true, label: "Updated By" }),
  ...TimestampFields,
}).meta({
  title: "Contact",
  collection: "contacts",
  displayDefaults: {
    columns: ["name", "emails", "phones", "organizations.name"],
    filters: {},
    sort: { column: "name", direction: "asc" },
  },
});

/**
 * Input schema for POST /contacts — what the endpoint accepts.
 */
export interface CreateContactInputType extends NameParts {
  uid: string;
  emails?: string[];
  phones?: string[];
  organizations?: ContactOrganizationType[];
}

/** Input schema for creating a contact. */
export const CreateContactInput: z.ZodType<CreateContactInputType> = z.object({
  uid: FirestoreId,
  ...NamePartsFields,
  emails: z.array(Email).optional(),
  phones: z.array(Phone).optional(),
  organizations: z.array(ContactOrganization).optional(),
});

/**
 * Input schema for PUT /contacts/:uid — partial update.
 */
export interface UpdateContactInputType extends PartialNameParts {
  uid?: string;
  emails?: string[];
  phones?: string[];
  organizations?: ContactOrganizationType[];
  version: number;
}

/** Input schema for updating a contact. */
export const UpdateContactInput: z.ZodType<UpdateContactInputType> = z.object({
  uid: FirestoreId.optional(),
  ...NamePartsFieldsPartial,
  emails: z.array(Email).optional(),
  phones: z.array(Phone).optional(),
  organizations: z.array(ContactOrganization).optional(),
  version: z.int().min(0),
});
