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
 * Organization reference embedded in a contact document.
 */
export interface ContactOrganizationType {
  uid: string;
  name: string;
}

/** Zod schema for an organization reference embedded in a contact. */
export const ContactOrganization: z.ZodType<ContactOrganizationType> = z.strictObject({
  uid: FirestoreId,
  name: z.string().min(1, "Organization name is required").max(100).meta({ pii: "mask", column: true, linkTo: "organizationDetail" }),
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
  uid_thread?: string;
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
  crms_id: z.number().optional(),
  // Required (no `.default([])`): the Typesense config declares them so, and a
  // `.default()` never materializes on a write — see the note in `product.ts`.
  emails: z.array(Email).meta({ column: true, label: "Emails" }),
  phones: z.array(Phone).meta({ column: true, label: "Phones" }),
  organizations: z.array(ContactOrganization).default([]).meta({ label: "Organizations" }),
  query_by_organizations: z.array(z.string()).default([]),
  uid_user: FirestoreId.optional(),
  uid_thread: ThreadId.optional(),
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
