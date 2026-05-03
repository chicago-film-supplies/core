/**
 * Organization document schema — Firestore collection: organizations
 */
import { z } from "zod";
import {
  ActorRef,
  type ActorRefType,
  Address,
  type AddressType,
  Email,
  FirestoreTimestamp,
  type FirestoreTimestampType,
  NameField,
  type NameParts,
  NamePartsFields,
  Phone,
  TaxProfileEnum,
  type TaxProfileType,
  TimestampFields,
} from "./common.ts";

/**
 * Contact reference embedded in an organization document.
 * `name` is the server-derived display string (see `deriveName` in common.ts).
 */
export interface OrganizationContactType extends NameParts {
  uid: string;
  name: string;
  roles: string[];
}

/** Zod schema for a contact reference embedded in an organization. */
export const OrganizationContact: z.ZodType<OrganizationContactType> = z.strictObject({
  uid: z.string(),
  ...NamePartsFields,
  name: NameField,
  roles: z.array(z.string()).default([]),
});

/**
 * Full organization document schema (Firestore document shape).
 */
export interface Organization {
  uid: string;
  name: string;
  crms_id: number;
  xero_id: string | null;
  tax_profile: TaxProfileType;
  description?: string;
  emails: string[];
  phones: string[];
  billing_address: AddressType | null;
  contacts: OrganizationContactType[];
  query_by_contacts: string[];
  last_order?: FirestoreTimestampType | null;
  defaultThreadId?: string;
  version: number;
  created_by: ActorRefType;
  updated_by: ActorRefType;
  created_at?: FirestoreTimestampType;
  updated_at?: FirestoreTimestampType;
}

/** Zod schema for a full organization Firestore document. */
export const OrganizationSchema: z.ZodType<Organization> = z.strictObject({
  uid: z.string(),
  name: z.string().min(1, "Organization name is required").max(100).meta({ pii: "mask" }),
  crms_id: z.number(),
  xero_id: z.string().nullable(),
  tax_profile: TaxProfileEnum.default("tax_applied"),
  description: z.string().default("").optional(),
  emails: z.array(Email).default([]),
  phones: z.array(Phone).default([]),
  billing_address: Address,
  contacts: z.array(OrganizationContact).default([]),
  query_by_contacts: z.array(z.string()).default([]),
  last_order: FirestoreTimestamp.nullable().optional(),
  defaultThreadId: z.string().optional(),
  version: z.int().min(0).default(0),
  created_by: ActorRef,
  updated_by: ActorRef,
  ...TimestampFields,
}).meta({
  title: "Organization",
  collection: "organizations",
  displayDefaults: {
    columns: ["name", "contacts", "emails", "phones"],
    filters: {},
    sort: { column: "name", direction: "asc" },
  },
});

/**
 * New contact data submitted inline when creating/updating an organization.
 */
export interface NewContactInputType extends NameParts {
  uid: string;
  emails?: string[];
  phones?: string[];
}

/** Zod schema for new contact data submitted inline with an organization. */
export const NewContactInput: z.ZodType<NewContactInputType> = z.object({
  uid: z.string(),
  ...NamePartsFields,
  emails: z.array(Email).optional(),
  phones: z.array(Phone).optional(),
});

/**
 * Input schema for POST /organizations.
 * crms_id and xero_id are obtained from external APIs — not in input.
 */
export interface CreateOrganizationInputType {
  uid: string;
  name: string;
  tax_profile: TaxProfileType;
  billing_address: AddressType | null;
  contacts?: OrganizationContactType[];
  newContacts?: NewContactInputType[] | null;
  emails?: string[];
  phones?: string[];
}

/** Input schema for creating an organization. */
export const CreateOrganizationInput: z.ZodType<CreateOrganizationInputType> = z.object({
  uid: z.string(),
  name: z.string().min(1, "Organization name is required").max(100).meta({ pii: "mask" }),
  tax_profile: TaxProfileEnum,
  billing_address: Address,
  contacts: z.array(OrganizationContact).optional(),
  newContacts: z.array(NewContactInput).nullable().optional(),
  emails: z.array(Email).optional(),
  phones: z.array(Phone).optional(),
});

/**
 * Input schema for PUT /organizations/:uid — partial update.
 */
export interface UpdateOrganizationInputType {
  uid?: string;
  name?: string;
  tax_profile?: TaxProfileType;
  description?: string;
  billing_address?: AddressType | null;
  contacts?: OrganizationContactType[];
  newContacts?: NewContactInputType[] | null;
  emails?: string[];
  phones?: string[];
  version: number;
}

/** Input schema for updating an organization. */
export const UpdateOrganizationInput: z.ZodType<UpdateOrganizationInputType> = z.object({
  uid: z.string().optional(),
  name: z.string().min(1, "Organization name is required").max(100).meta({ pii: "mask" }).optional(),
  tax_profile: TaxProfileEnum.optional(),
  description: z.string().optional(),
  billing_address: Address.optional(),
  contacts: z.array(OrganizationContact).optional(),
  newContacts: z.array(NewContactInput).nullable().optional(),
  emails: z.array(Email).optional(),
  phones: z.array(Phone).optional(),
  version: z.int().min(0),
});
