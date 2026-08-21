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
 *
 * ## The tax axes, and why they are emitted UNCONDITIONALLY
 *
 * `jurisdiction_claim` and `tax_exempt` are the pair that retires
 * `tax_profile` (api-cloudrun#596 item 1). Carrying them HERE is what makes
 * every writer dual-write for free — the alternative was two more fields in
 * each hand-rolled literal, which is the failure mode this function exists to
 * end.
 *
 * ⚠️ **Always written, never omitted**, and that is what gives the reader a
 * usable signal: from this publish on, an ABSENT key means the snapshot
 * predates the axes and `tax_profile` must be read, while `null`/`false` is a
 * real answer. Omitting on absence would collapse the two and leave
 * `documentTaxContext` unable to tell a migrated snapshot from a stale one.
 *
 * ⚠️ **`?? null` / `?? false` is lossless on the measured corpus, not a
 * flattening** — prod 2026-08-21: 291 organizations, and the 11 carrying
 * `tax_exempt: true` are exactly the 11 whose profile is `tax_exempt`, the 3
 * carrying a `jurisdiction_claim` are exactly the 3 with a location profile,
 * and the remaining 277 (`tax_applied`) carry neither. Absent on the
 * organization already means *asserts nothing*, so there is no third state to
 * destroy. See {@link DocumentOrganizationSnapshotType.jurisdiction_claim}.
 */
export function buildOrganizationSnapshot(
  org: Pick<
    Organization,
    | "uid"
    | "name"
    | "crms_id"
    | "tax_profile"
    | "jurisdiction_claim"
    | "tax_exempt"
    | "xero_id"
    | "billing_address"
  >,
  overrides: Partial<DocumentOrganizationSnapshotType> = {},
): DocumentOrganizationSnapshotType {
  return {
    uid: org.uid,
    name: org.name,
    crms_id: org.crms_id || null,
    tax_profile: org.tax_profile,
    jurisdiction_claim: org.jurisdiction_claim ?? null,
    tax_exempt: org.tax_exempt ?? false,
    xero_id: org.xero_id || null,
    billing_address: org.billing_address || null,
    ...overrides,
  };
}
