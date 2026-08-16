/**
 * CRMS ingest transactions — the two webhook paths that write CFS documents on
 * behalf of Current RMS.
 *
 * They declare **no new rules**. Each one performs propagation that is already
 * described by an existing rule, so it reuses those ids rather than minting a
 * parallel `crms-*:` vocabulary — the same choice `bulk-checkout-order` makes
 * when it reuses `update-booking:*`. A second id for one edge would be a second
 * place to keep the description current.
 *
 * ## Why they need declaring at all
 *
 * Both ran green while being unobservable, in **opposite** directions:
 *
 * - `crms-invoice-upsert` **borrowed** `create-invoice` / `update-invoice`. A
 *   borrowed transaction id turns the drift check off silently — the check is
 *   `rules_fired.length === 0 && rules_expected > 0`, so borrowing an id whose
 *   own steps are satisfied elsewhere in the corpus can never fire it. This is
 *   the same shape as the six settlement writers `./settlements.ts` was written
 *   to remediate; this one was not on that list.
 * - `crms-opportunity-order` had **no** propagation identity: the id was
 *   undeclared here and `webhooks/opportunity.ts` imported neither logger, so
 *   its cascade — five collections — emitted nothing to check against.
 *
 * ## ⚠️ What `crms-opportunity-order` does NOT declare, and why that is a fact
 *    rather than an omission
 *
 * `update-order` declares `update-order:items-to-invoices` and
 * `update-order:status-to-invoices`. This transaction declares neither, because
 * it fires neither: an order edited through CRMS does not propagate to its
 * invoices, while the same edit through the native PUT does. That is
 * **api-cloudrun#501**, and it is a live gap, not a design choice.
 *
 * Declaring the two steps here to make the gap visible would be the wrong
 * encoding — a declared-but-never-fired step reports drift on every single run,
 * which is a permanent warning rather than a finding. The steps go in when the
 * sync does. Measured 2026-08-12 against prod: `crms-opportunity-order` ran
 * **1,480** times over 114 orders in 90 days while `update-order` ran **4**
 * times corpus-wide, and **27 of 27** sync-eligible order↔invoice pairs sit on
 * a CRMS-written order — so this is not the minority path, it is very nearly
 * the only one.
 */
import { stockSteps } from "./stock.ts";
import type { TransactionDefinition } from "./types.ts";

// ── crms-opportunity-order ──────────────────────────────────────────

/**
 * The CRMS opportunity → CFS order reconcile (`webhooks/opportunity.ts`),
 * reached from the webhook's debounced `/tasks/reconcile-opportunity`.
 *
 * An UPSERT, which is why it declares the `update-order:*` derivations AND the
 * `cowrite-thread:*` steps that only a create fires: one transaction covers
 * both arms, and `rules_fired` reports per run which of them actually did.
 */
export const crmsOpportunityOrderTransaction: TransactionDefinition = {
  id: "crms-opportunity-order",
  description:
    "Rebuilds a CFS order from a CRMS opportunity — org snapshot, server-derived totals and query arrays, one booking per consolidated product per destination with store allocation drawn from the inventory ledger, the event-card projection with its per-card threads, and the sanitized fulfillment view. Cowrites the order's default thread on the create arm. Stock summaries are rebuilt post-commit via the coalesced `/tasks/rebuild-stock`, as on the native order path. Does NOT sync to linked invoices — see api-cloudrun#501.",
  steps: [
    "update-order:org-to-order",
    "update-order:order-self-derive",
    "update-order:order-to-bookings",
    "update-order:ledger-to-bookings",
    ...stockSteps("update-order"),
    "update-order:order-to-cards",
    "update-order:order-to-fulfillment",
    "cowrite-thread:orders-to-thread",
    "cowrite-thread:thread-to-orders",
    "cowrite-thread:cards-to-thread",
    "cowrite-thread:thread-to-cards",
  ],
};

// ── crms-invoice-upsert ─────────────────────────────────────────────

/**
 * The CRMS invoice → CFS invoice upsert (`webhooks/invoice.ts`).
 *
 * Both mirror arms are declared because the transaction is genuinely both: a
 * first delivery ADDS the ref to the order (`create-invoice:invoice-to-orders`,
 * which owns `query_by_invoices` too), and every later one CONVERGES it
 * (`update-invoice:status-to-orders`) or strips it on an unlink.
 *
 * The two `void-invoice-from-crms:*` steps are the same two acts
 * `applyInvoiceVoid` performs — retract every live settlement, append one void
 * row for `total_cents` — reached here from the `status === "void"` arm of a
 * resync rather than from the status-40 webhook that owns that transaction id.
 * One void, one pair of rules, two entry points.
 */
export const crmsInvoiceUpsertTransaction: TransactionDefinition = {
  id: "crms-invoice-upsert",
  description:
    "Creates or rebuilds a CFS invoice from a CRMS invoice — items resolved against the product catalog, day factors recovered from the linked order, and the order's `invoices[]` mirror added, converged or unlinked. Cowrites the invoice's default thread on the create arm, and re-derives the void settlement row when the CRMS document is void.",
  steps: [
    "create-invoice:invoice-to-orders",
    "update-invoice:status-to-orders",
    "cowrite-thread:invoices-to-thread",
    "cowrite-thread:thread-to-invoices",
    "void-invoice-from-crms:reap-settlements",
    "void-invoice-from-crms:append-void-settlement",
  ],
};

// ── crms-member-organization ────────────────────────────────────────

/**
 * The CRMS member (`membership_type: "Organisation"`) → CFS organization upsert
 * (`services/webhooks/member.ts`). Declared for api-cloudrun#503B: it writes
 * **five** collections — organizations, contacts, invoices, orders, threads —
 * and emitted no propagation record at all, which made the widest cascade in
 * the CRMS ingest surface the least observable one.
 *
 * Like its two siblings above it mints **no new rule ids**: every edge it
 * drives is already described by `create-organization` / `update-organization`
 * or by the shared thread cowrite. It is an UPSERT, so both arms are declared
 * and `rules_fired` reports per run which of them actually moved.
 *
 * ## ⚠️ Two steps `update-organization` declares are ABSENT, and both are facts
 *
 * - **`update-org:tax-profile-to-orders`.** That rule's fields include
 *   re-materializing every line's taxes; this path copies the org snapshot and
 *   re-prices nothing. Declaring it would report drift on every run.
 * - **`update-org:name-to-orders` / `billing-to-orders` ARE declared** — those
 *   two are pure snapshot copies and `applyOrgToOrder` performs exactly them.
 *
 * ## ⚠️ And one edge this path drives has NO rule on either side
 *
 * `applyOrgToInvoice` writes `invoice.organization.tax_profile`, while the
 * native `updateOrganization` deliberately refuses to (its comment: an invoice
 * is a billing document whose taxes were agreed at issue). So the two writers
 * disagree about whether that field may move on an issued invoice, and no rule
 * describes the CRMS one — which means it cannot be declared here without
 * inventing a vocabulary for behaviour that may itself be the defect. Left
 * undeclared and filed rather than papered over.
 */
export const crmsMemberOrganizationTransaction: TransactionDefinition = {
  id: "crms-member-organization",
  description:
    "Creates or updates a CFS organization from a CRMS member — geocoded billing address, emails/phones, tax profile derived from the CRMS sales-tax class, and the full child-contact set with bidirectional back-references maintained in both directions. Fans the org's name and billing address out to its live orders and invoices, and cowrites a default thread for the organization and for every contact it mints.",
  steps: [
    "create-org:org-to-contacts",
    "update-org:contacts-change",
    "update-org:name-to-contacts",
    "update-org:name-to-orders",
    "update-org:billing-to-orders",
    "update-org:name-to-invoices",
    "update-org:billing-to-invoices",
    "cowrite-thread:organizations-to-thread",
    "cowrite-thread:thread-to-organizations",
    "cowrite-thread:contacts-to-thread",
    "cowrite-thread:thread-to-contacts",
  ],
};

// ── crms-member-contact ─────────────────────────────────────────────

/**
 * The CRMS member (`membership_type: "Contact"`) → CFS contact upsert, the
 * sibling of the above. Three collections — contacts, organizations, threads.
 *
 * ## ⚠️ Three `update-contact` steps are ABSENT, and that is api-cloudrun#501's
 *    shape in a second place
 *
 * `update-contact` declares `name-to-orders`, `phones-to-orders` and
 * `name-to-user`. This path fires none of them: a contact renamed **through
 * CRMS** does not reach the destination legs of its live orders, nor its linked
 * user, while the same rename through `PUT /contacts/{uid}` does. Two of those
 * three are measured vacuous corpus-wide anyway (every stored destination leg
 * carries `contact: null`), but `update-contact:name-to-user` is not — a CRMS
 * rename of a contact linked to a user leaves the user's name stale.
 *
 * Declared-but-never-fired would be a permanent drift warning rather than a
 * finding, so the steps go in when the sync does — the same call
 * `crms-opportunity-order` makes above for #501.
 */
export const crmsMemberContactTransaction: TransactionDefinition = {
  id: "crms-member-contact",
  description:
    "Creates or updates a CFS contact from a CRMS member — split name, emails/phones, and membership of every parent organization CRMS names, with each org's contacts[] and query_by_contacts back-reference maintained on join and on leave. Cowrites a default thread on the create arm. An unresolvable parent org is a hard failure rather than a silent unlink.",
  steps: [
    "create-contact:contact-to-orgs",
    "update-contact:name-to-orgs",
    "update-contact:orgs-change",
    "cowrite-thread:contacts-to-thread",
    "cowrite-thread:thread-to-contacts",
  ],
};
