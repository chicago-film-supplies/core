/**
 * Organization helpers.
 *
 * @module
 */

import type {
  DocumentOrganizationSnapshotType,
  Organization,
} from "../schemas/mod.ts";

/**
 * Build the denormalized organization snapshot an order, invoice or credit note
 * embeds.
 *
 * **The one builder, because four hand-maintained literals is what api-cloudrun
 * #486 was.** `createOrder`, `updateOrder`'s organization branch, the CRMS
 * opportunity webhook and `createInvoice` each assembled this block by hand,
 * and the three order-side copies were one field short of the invoice's: they
 * carried no `tax_profile`. Nothing on the order write path could see a
 * tax-exempt customer, so `repriceOrderItemsForProfile` passed a hardcoded
 * `"tax_applied"` — the same customer's invoices went untaxed and their orders
 * went taxed, hidden only by CRMS stamping the profile from the opportunity
 * header.
 *
 * ⚠️ **This pins WHERE the snapshot is built, not WHAT it holds** — the
 * Ratchet-G lesson. api-cloudrun's writer-parity test is the value assertion
 * beside it: one order created natively and one through the CRMS opportunity
 * path, same commercial facts, must produce byte-identical `organization`
 * blocks.
 *
 * `|| null` rather than `?? null` on `crms_id` and `xero_id` is deliberate and
 * matches every call site it replaces — a `crms_id` of `0` is not a CRMS id.
 */
export function buildOrganizationSnapshot(
  org: Pick<
    Organization,
    "uid" | "name" | "crms_id" | "tax_profile" | "xero_id" | "billing_address"
  >,
  overrides: Partial<DocumentOrganizationSnapshotType> = {},
): DocumentOrganizationSnapshotType {
  return {
    uid: org.uid,
    name: org.name,
    crms_id: org.crms_id || null,
    tax_profile: org.tax_profile,
    xero_id: org.xero_id || null,
    billing_address: org.billing_address || null,
    ...overrides,
  };
}
