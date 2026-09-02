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
 * ⭐ **The three-step removal is COMPLETE.** A `z.strictObject` makes *field
 * required* and *field deleted* disjoint accepted sets, so neither single-step
 * ordering works: delete-first leaves every unpurged document unwritable,
 * purge-first leaves every purged document unwritable by the build still
 * deployed. The sequence run was **optional → stop the writer → empty storage →
 * delete**: `beta.310` made it optional, api-cloudrun `e2081775` stopped every
 * writer and shipped as `v0.211.0`, and the corpus was emptied on 2026-09-02 —
 * **684 prod edges and 685 dev, 0 carrying a name in either.** This is the
 * fourth step.
 *
 * ⚠️ **The index does NOT lose the column, and that is measured rather than
 * hoped.** `contacts_v8` still declares `organizations.name`; api-cloudrun's
 * `translateForTypesense` composes it at index time from the live organization
 * (`api-cloudrun/src/lib/organizationNames.ts`). With storage emptied, a prod search by
 * `organizations.name` for *"Netflix"* still returns 7 contacts carrying
 * "Netflix Productions, LLC / Saturn Return / Office". **A derived value is fine
 * to DELIVER — the defect is storing it next to its input.**
 */
export interface ContactOrganizationType {
  uid: string;
}

/** Zod schema for an organization reference embedded in a contact. */
export const ContactOrganization: z.ZodType<ContactOrganizationType> = z.strictObject({
  uid: FirestoreId,
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
    // ⚠️ **`organizations.name` LEFT this list, and it had to.** It was a
    // declared column only because `ContactOrganization.name` carried
    // `column: true`; with the field gone there is no storage leaf to annotate,
    // and display-columns **T8** refuses a `displayDefaults` key that names no
    // declared column. The TYPESENSE surface keeps it — as a
    // `TYPESENSE_ROLLUP_COLUMNS` entry, which is where a field computed at index
    // time belongs — and that is the surface the manager's contacts table
    // actually uses (`CollectionPage` renders a `TypesenseTable`). So no visible
    // column is lost.
    columns: ["name", "emails", "phones"],
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
