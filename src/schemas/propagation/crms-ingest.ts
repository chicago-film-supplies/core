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
 * ## ✅ The two invoice steps are now DECLARED — api-cloudrun#501 is closed
 *
 * `crms-opportunity-order` used to declare neither
 * `update-order:items-to-invoices` nor `update-order:status-to-invoices`,
 * because it fired neither: an order edited through CRMS did not reach its
 * invoices while the same edit through the native PUT did. The steps went in
 * when the sync did, exactly as this comment previously promised.
 *
 * Why that gap was worth closing rather than documenting: measured 2026-08-12
 * against prod, `crms-opportunity-order` ran **1,480** times over 114 orders in
 * 90 days while `update-order` ran **4** times corpus-wide, and **27 of 27**
 * sync-eligible order↔invoice pairs sit on a CRMS-written order. The propagating
 * surface was very nearly the only one that never propagated.
 *
 * ⚠️ **A declared-but-never-fired step does NOT report drift on every run, and
 * the previous revision of this comment said it did.** `logTransactionPropagation`
 * warns only on `rules_fired.length === 0 && rules_expected > 0`, and this
 * transaction always fires at least three. What declaring early would really
 * have broken is the STATIC guard — `propagationCoverage`'s per-transaction arm
 * requires every declared step to appear as a literal in the file that logs the
 * transaction, so the declaration would have failed the build, not the logs.
 * Same conclusion, different mechanism; the distinction matters because it is
 * the one that tells you where to look when it goes red.
 *
 * ⚠️ Both steps are CONDITIONAL at the call site, and that is not drift: the
 * item sync needs a linked non-terminal invoice carrying this order's divider,
 * and the cancel arm needs a transition INTO `canceled`. `rules_fired` reports
 * per run which of them moved, exactly as the `cowrite-thread:*` create-arm
 * steps already do.
 */
import { STOCK_STEPS } from "./stock.ts";
import type { PropagationModule, TransactionDefinition } from "./types.ts";

// ── crms-opportunity-order ──────────────────────────────────────────

/**
 * The CRMS opportunity → CFS order reconcile (`webhooks/opportunity.ts`),
 * reached from the webhook's debounced `/tasks/reconcile-opportunity`.
 *
 * An UPSERT, which is why it declares the `update-order:*` derivations AND the
 * `cowrite-thread:*` steps that only a create fires: one transaction covers
 * both arms, and `rules_fired` reports per run which of them actually did.
 */
const crmsOpportunityOrderTransaction: TransactionDefinition = {
  id: "crms-opportunity-order",
  description:
    "Rebuilds a CFS order from a CRMS opportunity — org snapshot, server-derived totals and query arrays, one booking per consolidated product per destination with store allocation drawn from the inventory ledger, the event-card projection with its per-card threads, and the sanitized fulfillment view. Cowrites the order's default thread on the create arm. Selectively syncs the rebuilt items, destinations, subject, reference and organization onto every linked non-terminal invoice, and strips this order's scope from them on a cancel — the same two edges the native PUT drives. Stock summaries are rebuilt post-commit via the coalesced `/tasks/rebuild-stock`, as on the native order path.",
  steps: [
    "update-order:org-to-order",
    "update-order:order-self-derive",
    "update-order:order-to-bookings",
    "update-order:ledger-to-bookings",
    ...STOCK_STEPS,
    "update-order:order-to-cards",
    "update-order:order-to-fulfillment",
    // api-cloudrun#501. Conditional, like the two create-arm thread cowrites
    // below: the item sync needs a linked non-terminal invoice holding this
    // order's divider, and the cancel arm needs a transition INTO `canceled`.
    "update-order:items-to-invoices",
    "update-order:status-to-invoices",
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
const crmsInvoiceUpsertTransaction: TransactionDefinition = {
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
 * ## ⚠️ `tax-axes-to-orders` is declared as of api-cloudrun#528, and the
 *    defect it closed was TWO-SIDED
 *
 * This comment previously recorded the step as deliberately absent, because
 * *"this path copies the org snapshot and re-prices nothing"*. That was true,
 * and it was the defect rather than the design — read against its twin:
 *
 * | document | native `updateOrganization` | CRMS member webhook (before #528) |
 * |---|---|---|
 * | order   | writes the snapshot **and reprices** | wrote **nothing** |
 * | invoice | writes **nothing**, deliberately     | wrote the snapshot |
 *
 * i.e. the two writers were exact inverses of each other, and #528 named only
 * the invoice half. Both halves are now the native path's rule: an org's tax
 * AXES change reprices its live **un-invoiced orders** and touches no
 * invoice on either path. An invoice is a billing document whose taxes were
 * agreed at issue — several are in Xero — and `resyncInvoice` is its deliberate
 * repair path, exactly as `POST /orders/{uid}/tax-resync` is an invoiced
 * order's. `applyOrgToOrder` now delegates to the same
 * `applyOrgTaxToOrder` the native path uses, so there is one implementation of
 * the reprice and the two cannot drift.
 *
 * ⚠️ **Inert on the corpus when it landed, and that is a fact worth keeping**:
 * prod measured 0 of 987 orders and 0 of 1,010 invoices disagreeing with their
 * org's current profile (2026-08-16). Each writer covered only one side, so
 * zero drift on *both* sides is evidence the trigger has never fired — not
 * evidence the cascades were keeping up.
 */
const crmsMemberOrganizationTransaction: TransactionDefinition = {
  id: "crms-member-organization",
  description:
    "Creates or updates a CFS organization from a CRMS member — geocoded billing address, emails/phones, tax axes derived from the CRMS sales-tax class, and the full child-contact set with bidirectional back-references maintained in both directions. Fans the org's name and billing address out to its live orders and invoices, reprices the live un-invoiced orders when either tax axis moves, and cowrites a default thread for the organization and for every contact it mints.",
  steps: [
    "create-org:org-to-contacts",
    "update-org:contacts-change",
    "update-org:name-to-contacts",
    "update-org:name-to-orders",
    "update-org:billing-to-orders",
    "update-org:tax-axes-to-orders",
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
 * ## ⚠️ The three `update-contact` steps are declared as of api-cloudrun#531 —
 *    #501's shape is now closed everywhere
 *
 * `update-contact` declares `name-to-orders`, `phones-to-orders` and
 * `name-to-user`, and this path fired **none** of them: a contact renamed
 * **through CRMS** reached neither the destination legs of its live orders nor
 * its linked user, while the same rename through `PUT /contacts/{uid}` did.
 * Both writers now go through `api-cloudrun/src/lib/contactDenorms.ts`, so there is one
 * implementation of each denorm rather than two that can drift.
 *
 * ⚠️ **All three legs measured VACUOUS when this landed, in BOTH envs** — 0 of
 * 165 prod contacts carry a `uid_user`, and 0 of 1,974 stored destination legs
 * carry a contact (2026-08-16). So this is a forward fix with no repair, and
 * the reason for the zero is the reason it does not stay zero: every prod order
 * is CRMS-authored and CRMS states no destination contact, while `createUser`
 * links a user to an email-matching contact automatically. Both populations
 * become live the moment the manager mints orders and users — which is the
 * CRMS-overlap window, i.e. exactly the window this path is still running in.
 *
 * ⚠️ **Correcting this comment's own earlier reasoning:** it said declaring
 * early would produce "a permanent drift warning". It would not —
 * `logTransactionPropagation` warns only when `rules_fired` is EMPTY, and this
 * transaction always fires several. The real cost is that
 * `propagationCoverage`'s per-transaction arm requires each declared step to
 * appear as a literal in the file that logs the transaction, so an early
 * declaration fails the BUILD. Same instruction, different mechanism — and the
 * mechanism is what tells you where to look when it goes red.
 */
const crmsMemberContactTransaction: TransactionDefinition = {
  id: "crms-member-contact",
  description:
    "Creates or updates a CFS contact from a CRMS member — split name, emails/phones, and membership of every parent organization CRMS names, with each org's contacts[] and query_by_contacts back-reference maintained on join and on leave. A rename also reaches the destination legs of the contact's live orders and its linked user; a phone change reaches the same order legs. Cowrites a default thread on the create arm. An unresolvable parent org is a hard failure rather than a silent unlink.",
  steps: [
    "create-contact:contact-to-orgs",
    "update-contact:name-to-orgs",
    "update-contact:orgs-change",
    "update-contact:name-to-orders",
    "update-contact:phones-to-orders",
    "update-contact:name-to-user",
    "cowrite-thread:contacts-to-thread",
    "cowrite-thread:thread-to-contacts",
  ],
};

// ── Module ──────────────────────────────────────────────────────────
/** Everything `crms-ingest.ts` contributes to the propagation catalog. */
export const crmsIngest: PropagationModule = {
  rules: [],
  transactions: [
    crmsInvoiceUpsertTransaction,
    crmsOpportunityOrderTransaction,
    crmsMemberOrganizationTransaction,
    crmsMemberContactTransaction,
  ],
};
