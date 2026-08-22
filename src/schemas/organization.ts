/**
 * Organization document schema — Firestore collection: organizations
 */
import { z } from "zod";
import { FirestoreId, ThreadId } from "./_uid.ts";
import {
  ActorRef,
  type ActorRefType,
  Address,
  type AddressType,
  Email,
  FirestoreTimestamp,
  type FirestoreTimestampType,
  JurisdictionEnum,
  type JurisdictionType,
  NameField,
  type NameParts,
  NamePartsFields,
  Phone,
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
  uid: FirestoreId,
  ...NamePartsFields,
  name: NameField,
  roles: z.array(z.string()).default([]).meta({ column: true, label: "Roles" }),
});

/**
 * Full organization document schema (Firestore document shape).
 */
export interface Organization {
  uid: string;
  name: string;
  crms_id: number;
  xero_id: string | null;
  /**
   * This customer's standing jurisdiction claim — **level 2** of the
   * three-level precedence in `resolveJurisdiction` (`@cfs/core/utils/taxes`),
   * below the document's own `destinations[i].jurisdiction` and above the
   * derivation.
   *
   * ⚠️ **A standing CLAIM, not a hint.** There used to be a destination-master
   * level between this and the derivation; ranked above this it cancelled it on
   * all 8 repriceable jurisdiction-bearing orders, and ranked below it did
   * nothing, because nothing ever wrote it. It is gone. The escape hatch is
   * level 1 — a
   * Rantoul-claim organization taking a one-off Chicago delivery edits **that
   * destination's** entry on the document, so the document is never re-welded
   * to one jurisdiction the way `tax_profile` welds it. The order form must
   * still show WHICH level supplied each destination's answer.
   *
   * ⚠️ **The name is not `default_`.** "Default" reads as a fallback and this
   * is the top of the stored chain; the rename is what stops the next reader
   * re-deriving the precedence from the field name.
   *
   * `null`/absent asserts nothing and asks the next level. It does **not** mean
   * "no jurisdiction" — that answer is the `no_nexus` value, authorable here
   * like any other ({@link JurisdictionType}).
   *
   * ⚠️ **Load-bearing for the entire current corpus, not a tail case.** All 993
   * prod orders are CRMS-originated and the CRMS path does not seed level 1, so
   * level 1 is empty on every document that exists today and this level is what
   * answers for Kenwood, Waterloo West and Simeon. Phase 2 cannot delete
   * `tax_profile` before the CRMS cutover unless this stays.
   *
   * Optional through api-cloudrun#409 Phase 1.
   */
  jurisdiction_claim?: JurisdictionType | null;
  /**
   * Whether this customer is tax-exempt — a property of the CUSTOMER, which is
   * the half `tax_profile` welded to jurisdiction and could not separate.
   *
   * ⚠️ **Exemption is STICKY from either side**: the rule is
   * `org.tax_exempt || doc.tax_exempt === true`, never `doc ?? org`. A `false`
   * on a document must not un-exempt an exempt customer — that is a legal fact
   * about the buyer, not a per-order preference.
   *
   * ⚠️ **No `.default(false)`.** `organization.ts` deleted exactly that, on
   * exactly this shape, because the Typesense config declares the field
   * required and a `.default()` never materializes under `validateBeforeWrite`.
   *
   * Optional through api-cloudrun#409 Phase 1.
   */
  tax_exempt?: boolean;
  description?: string;
  emails: string[];
  phones: string[];
  billing_address: AddressType | null;
  contacts: OrganizationContactType[];
  query_by_contacts: string[];
  last_order?: FirestoreTimestampType | null;
  uid_thread?: string;
  version: number;
  created_by: ActorRefType;
  updated_by: ActorRefType;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}

/** Zod schema for a full organization Firestore document. */
export const OrganizationSchema: z.ZodType<Organization> = z.strictObject({
  uid: FirestoreId,
  name: z.string().min(1, "Organization name is required").max(100).meta({ pii: "mask", column: true, label: "Name", linkTo: "organizationDetail" }),
  crms_id: z.int(),
  xero_id: z.uuid().nullable(),
  // Required (no `.default("tax_applied")`): the Typesense config declares it
  // so, and a `.default()` never materializes on a write — see the note in
  // `product.ts`. TAX_PROFILES[0] is "tax_applied", so the enum's
  // type-derived seed already equals the dropped default.
  // `tax_profile` was DELETED here — api-cloudrun#596 item 3's contract third,
  // applied to prod (2,317 documents) and dev on 2026-08-22. The three steps
  // were forced, not ceremonial: every write validates the FULL document and
  // this is a `z.strictObject`, so a schema that has dropped the key REJECTS
  // every stored document still carrying it. Optional → empty storage → delete.
  jurisdiction_claim: JurisdictionEnum.nullable().optional().meta({
    column: true,
    label: "Jurisdiction Claim",
  }),
  tax_exempt: z.boolean().optional().meta({ column: true, label: "Tax Exempt" }),
  description: z.string().default("").optional().meta({ column: true, label: "Description" }),
  emails: z.array(Email).default([]).meta({ column: true, label: "Emails" }),
  phones: z.array(Phone).default([]).meta({ column: true, label: "Phones" }),
  billing_address: Address.meta({ label: "Billing" }),
  // The whole contact is the column — the Typesense config indexes the nested
  // object, and `TableCell` joins the name parts.
  contacts: z.array(OrganizationContact).meta({ column: true, label: "Contacts" }),
  query_by_contacts: z.array(z.string()).default([]),
  last_order: FirestoreTimestamp.nullable().optional().meta({ column: true, label: "Last Order" }),
  uid_thread: ThreadId.optional(),
  version: z.int().min(0).default(0),
  created_by: ActorRef.meta({ column: true, label: "Created By" }),
  updated_by: ActorRef.meta({ column: true, label: "Updated By" }),
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
  uid: FirestoreId,
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
  /**
   * The two tax AXES a client states — the customer's standing jurisdiction
   * claim (level 2) and whether they are exempt.
   *
   * ⚠️ **`tax_profile` was REQUIRED here and is gone** (api-cloudrun#596 item
   * 2). The document still carries one because it is deleted a step later; the
   * server derives it from these two, which is the only way an axis-speaking
   * client can leave a coherent value in a field it no longer knows about.
   */
  jurisdiction_claim?: JurisdictionType | null;
  tax_exempt?: boolean;
  billing_address: AddressType | null;
  contacts?: OrganizationContactType[];
  newContacts?: NewContactInputType[] | null;
  emails?: string[];
  phones?: string[];
}

/** Input schema for creating an organization. */
export const CreateOrganizationInput: z.ZodType<CreateOrganizationInputType> = z.object({
  uid: FirestoreId,
  name: z.string().min(1, "Organization name is required").max(100).meta({ pii: "mask" }),
  jurisdiction_claim: JurisdictionEnum.nullable().optional(),
  tax_exempt: z.boolean().optional(),
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
  /** The AXES — see {@link CreateOrganizationInputType}. */
  jurisdiction_claim?: JurisdictionType | null;
  tax_exempt?: boolean;
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
  uid: FirestoreId.optional(),
  name: z.string().min(1, "Organization name is required").max(100).meta({ pii: "mask" }).optional(),
  jurisdiction_claim: JurisdictionEnum.nullable().optional(),
  tax_exempt: z.boolean().optional(),
  description: z.string().optional(),
  billing_address: Address.optional(),
  contacts: z.array(OrganizationContact).optional(),
  newContacts: z.array(NewContactInput).nullable().optional(),
  emails: z.array(Email).optional(),
  phones: z.array(Phone).optional(),
  version: z.int().min(0),
});
