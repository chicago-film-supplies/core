/**
 * Tax document schema — Firestore collection: taxes
 *
 * Tax definitions used for computing item-level and order-level tax amounts.
 * Tax data is denormalized onto order items at order time.
 */
import { z } from "zod";
import { FirestoreId } from "./_uid.ts";
import { chicagoInstant } from "./_datetime.ts";
import {
  ActorRef,
  type ActorRefType,
  FirestoreTimestamp,
  type FirestoreTimestampType,
  RATE_UNIT_META,
  RateTypeEnum,
  type RateType,
} from "./common.ts";

/** A tax definition used for computing item-level and order-level tax amounts. */
export interface Tax {
  uid: string;
  name: string;
  rate: number;
  type: RateType;
  active: boolean;
  crms_id: number | null;
  valid_from: string;
  valid_from_fs: FirestoreTimestampType;
  valid_to: string | null;
  valid_to_fs: FirestoreTimestampType | null;
  version: number;
  created_by: ActorRefType;
  updated_by: ActorRefType;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}

/** Zod schema for Tax. */
export const TaxSchema: z.ZodType<Tax> = z.strictObject({
  uid: FirestoreId,
  name: z.string().min(1).max(100).meta({ column: true, label: "Name" }),
  rate: z.number().meta({ column: true, label: "Rate", ...RATE_UNIT_META }),
  type: RateTypeEnum.meta({ column: true, label: "Type" }),
  active: z.boolean().default(true).meta({ column: true, label: "Active" }),
  crms_id: z.int().nullable().default(null),
  valid_from: chicagoInstant(),
  valid_from_fs: FirestoreTimestamp,
  valid_to: chicagoInstant().nullable().default(null),
  valid_to_fs: FirestoreTimestamp.nullable().default(null),
  version: z.int().min(0).default(0),
  created_by: ActorRef.meta({ column: true, label: "Created By" }),
  updated_by: ActorRef.meta({ column: true, label: "Updated By" }),
  created_at: FirestoreTimestamp.meta({ column: true, label: "Created" }),
  updated_at: FirestoreTimestamp.meta({ column: true, label: "Updated" }),
}).meta({
  title: "Tax",
  collection: "taxes",
  displayDefaults: {
    columns: ["name", "rate", "type", "active"],
    filters: {},
    sort: { column: "name", direction: "asc" },
  },
});

/** Input for creating a new tax definition. */
export interface CreateTaxInputType {
  name: string;
  rate: number;
  type: RateType;
  active?: boolean;
  valid_from: string;
  valid_to?: string | null;
}

/** Zod schema for CreateTaxInput. */
export const CreateTaxInput: z.ZodType<CreateTaxInputType> = z.object({
  name: z.string().min(1).max(100),
  rate: z.number(),
  type: RateTypeEnum,
  active: z.boolean().optional(),
  valid_from: chicagoInstant(),
  valid_to: chicagoInstant().nullable().optional(),
});

/** Input for updating an existing tax definition. */
export interface UpdateTaxInputType {
  uid: string;
  name?: string;
  rate?: number;
  type?: RateType;
  active?: boolean;
  valid_from?: string;
  valid_to?: string | null;
  version: number;
}

/** Zod schema for UpdateTaxInput. */
export const UpdateTaxInput: z.ZodType<UpdateTaxInputType> = z.object({
  uid: FirestoreId,
  name: z.string().min(1).max(100).optional(),
  rate: z.number().optional(),
  type: RateTypeEnum.optional(),
  active: z.boolean().optional(),
  valid_from: chicagoInstant().optional(),
  valid_to: chicagoInstant().nullable().optional(),
  version: z.int().min(0),
});

/**
 * Input for superseding a tax — closing the incumbent's window and opening its
 * successor's, in one write (api-cloudrun#495).
 *
 * ## Why this is not two calls
 *
 * A rate change is retroactive by nature, so the correct model is a new
 * *version* rather than an edit — but the sanctioned way to reach it was
 * `POST /taxes` followed by `PUT /taxes/{old}`, and **between those two calls
 * both versions are open-ended**. {@link findTaxAt} does not pick one when two
 * same-name docs bracket an instant, it THROWS `Tax catalog drift` — on the
 * pricing path, for every order and invoice write touching that name. So the
 * documented workflow had a window in which pricing was down, and the operator
 * getting the order wrong was the only thing standing between the catalog and
 * that throw. One transaction makes the overlap unrepresentable instead.
 *
 * ## What is deliberately absent
 *
 * - **No `name`.** A supersede is by construction the next version of the same
 *   tax, and `findTaxAt` matches by name — so a caller-supplied name would let
 *   one call close this series and open a different one, which is two edits
 *   wearing one verb.
 * - **No way to deactivate the incumbent.** A closed version must stay in the
 *   catalog: `getTaxDocs()` reads the collection unfiltered and `findTaxAt`
 *   resolves *historical* instants off it, so retiring the incumbent would
 *   re-price every past document that names it. It is also what keeps a
 *   consumer holding a pinned uid working — manager pins `RENTAL_TAX_UID` as a
 *   constant and `getDefaultTaxesForType` returns `[]` on a miss, so a
 *   deactivated incumbent creates every new rental line **untaxed, silently**.
 *   The line still prices correctly because the order writers re-resolve by
 *   name at `asOf` (`resolveTaxRefsAt`); that resolution is the reason this
 *   endpoint is safe to ship before manager stops pinning uids.
 *
 * `valid_from` is one field doing two jobs — the successor's start AND the
 * incumbent's `valid_to` — because they are the same instant by definition.
 * Two fields would be two chances to disagree.
 */
export interface SupersedeTaxInputType {
  /** The incumbent being closed. The successor is minted with a fresh id. */
  uid: string;
  /** OCC on the INCUMBENT — the successor does not exist yet. */
  version: number;
  /** The successor's start, and the instant the incumbent's window closes. */
  valid_from: string;
  /** The successor's rate. */
  rate: number;
  /** Defaults to the incumbent's. */
  type?: RateType;
  /** The successor's own end. Open-ended unless a third version is planned. */
  valid_to?: string | null;
}

/** Zod schema for SupersedeTaxInput. */
export const SupersedeTaxInput: z.ZodType<SupersedeTaxInputType> = z.object({
  uid: FirestoreId,
  version: z.int().min(0),
  valid_from: chicagoInstant(),
  rate: z.number(),
  type: RateTypeEnum.optional(),
  valid_to: chicagoInstant().nullable().optional(),
});
