/**
 * Shared tax helpers for CFS applications — the single home for doc-level
 * `tax_profile` override logic + as-of Tax-catalog resolution, so the API
 * (orders + invoice webhook) and the manager (optimistic recompute) share one
 * implementation.
 *
 * Depends one-way on `./orders.ts` (base pricing module) — no cycle.
 *
 * @module
 */

import { compareAsc, parseISO } from "date-fns";
import { DEFAULT_TAX_PROFILE, type TaxProfileType, toUsStateCode } from "../schemas/mod.ts";
import {
  calculateItemPrice,
  computeItemTaxAmountCents,
  isPreTaxItem,
  isTaxableCoa,
  type LineItem,
  type PriceModifier,
  type Tax,
  TAXABLE_REVENUE_COAS,
} from "./orders.ts";

// Re-export the pure per-item tax formula so consumers can import everything
// tax-related from `@cfs/core/utils/taxes` (it lives in orders.ts to avoid a
// taxes ↔ orders import cycle).
export { computeItemTaxAmountCents, type Tax };

// The line-taxability rule lives in `orders.ts` for the same reason
// `computeItemTaxAmountCents` does — `taxes.ts` depends one-way on `orders.ts`, and
// the pricing engine there needs the gate. Re-exported so consumers can import
// everything tax-related from `@cfs/core/utils/taxes`.
export { isTaxableCoa, TAXABLE_REVENUE_COAS };

/**
 * **Which tax a newly authored line carries, keyed on `coa_revenue`** — the
 * DEFAULT, as against `TAXABLE_REVENUE_COAS` above, which is the PERMISSIVE
 * rule. The two answer different questions: *may* a line here carry tax, and
 * *what does a new line here get*.
 *
 * Measured over the whole prod corpus, restricted to `tax_applied` invoices,
 * every taxed line agrees:
 *
 * | coa | tax carried | lines | exceptions |
 * |---|---|---|---|
 * | 4000 | Chicago Rental Tax | 6,289 | 0 |
 * | 4200 | Chicago Sales Tax  |   518 | 0 |
 * | 4210 | Chicago Sales Tax  |   218 | 0 |
 *
 * ⚠️ **`type` explicitly does NOT decide it, and that is measured in BOTH
 * directions** (re-measured over orders *and* invoices, 2026-08-16 — see
 * manager#297):
 *
 * - a taxable COA carries its tax on types the type-keyed map calls untaxed —
 *   coa 4000 on **36** `service` lines, 4200 on **24**, 4210 on **4**;
 * - and a NON-taxable COA stays untaxed on types the type-keyed map would tax —
 *   **105** `sale` lines at coa 4700, all carrying no tax.
 *
 * That second direction is the larger population and the one nobody had looked
 * at. It is also the harmless one: `materializeDocumentTax` clears
 * `price.taxes` outright when `isTaxableCoa` is false, so a client that seeds a
 * tax there is corrected on save. **The first direction is NOT corrected** —
 * the gate passes and the materializer then prices whatever refs the line
 * carries, which is none. A client keyed on `type` alone therefore drops tax
 * silently on exactly the pairings this table exists to describe.
 *
 * The **rate** is not here: it comes from the date-bracketed catalog via
 * {@link findTaxAt} at the document's own date.
 *
 * ⚠️ **A line with NO `coa_revenue` is not covered by this table** — custom
 * lines (`buildCustomOrderLine` / `buildCustomInvoiceLine`) construct no such
 * field, so a type-keyed fallback is still required and is not a redundant
 * second encoding. Prod carries **99** such lines. That is the whole reason
 * this is a default table rather than the only key.
 *
 * ⚠️ **This lives in core because it has TWO consumers.** It was
 * `api-cloudrun/src/lib/taxByCoa.ts`, unreachable from the manager, which is
 * why the manager grew a type-keyed twin answering the same question. Moving it
 * rather than copying it is the point — an earlier revision of its docblock
 * records a *third* encoding (`chart-of-accounts.default_tax_profile`) that was
 * deleted for having one writer and zero readers.
 */
export const TAXABLE_COA_TO_TAX_NAME: Readonly<Record<number, string | null>> = {
  4000: "Chicago Rental Tax",
  4140: null,
  4200: "Chicago Sales Tax",
  4210: "Chicago Sales Tax",
};

/**
 * Fail closed if the taxable-COA set has grown past {@link TAXABLE_COA_TO_TAX_NAME}.
 *
 * A taxable COA with no entry there would be silently left **untaxed**, which is
 * a money defect that looks like a clean run. Throws rather than exits so a
 * script, a test and a client can all call it.
 */
export function assertCoaTaxMapCoversCore(): void {
  const declared = Object.keys(TAXABLE_COA_TO_TAX_NAME).map(Number).sort();
  const expected = [...TAXABLE_REVENUE_COAS].sort();
  if (JSON.stringify(declared) !== JSON.stringify(expected)) {
    throw new Error(
      `TAXABLE_COA_TO_TAX_NAME [${declared}] no longer covers TAXABLE_REVENUE_COAS ` +
        `[${expected}]. A taxable COA with no tax name would be silently left ` +
        `untaxed — add the mapping (and re-measure the corpus) first.`,
    );
  }
}

/**
 * **The one default-tax rule**: the tax NAME a newly authored line should
 * carry, given its account and its type.
 *
 * `coa_revenue` decides wherever the line has one — that is the measured key
 * (see {@link TAXABLE_COA_TO_TAX_NAME}). `type` is the fallback for a line that
 * carries no account at all, which is every custom line.
 *
 * Returns `null` for "untaxed", which is a real answer rather than a miss: a
 * non-taxable COA, a taxable COA with no tax in practice (4140), and the
 * `service` / `surcharge` types under the fallback are all deliberately untaxed.
 */
export function defaultTaxNameForLine(
  coaRevenue: number | null | undefined,
  type: string,
): string | null {
  if (coaRevenue != null) {
    return Object.hasOwn(TAXABLE_COA_TO_TAX_NAME, coaRevenue)
      ? TAXABLE_COA_TO_TAX_NAME[coaRevenue]
      : null;
  }
  return DEFAULT_TAX_NAME_BY_TYPE[type] ?? null;
}

/**
 * The type-keyed fallback, for lines with no `coa_revenue`.
 *
 * ⚠️ **Not a second encoding of the table above** — it answers the case that
 * table cannot: a custom line has no account. A type absent here is untaxed by
 * design (`service`, `surcharge`), not a miss.
 */
const DEFAULT_TAX_NAME_BY_TYPE: Readonly<Record<string, string>> = {
  rental: "Chicago Rental Tax",
  sale: "Chicago Sales Tax",
  replacement: "Chicago Sales Tax",
};

/**
 * Pick the Tax whose `[valid_from, valid_to)` bracket contains `asOf`, matched
 * by exact `name`. Returns null when nothing matches (e.g. `asOf` before any
 * historical doc). Throws on catalog drift (two same-name docs bracket the same
 * instant). A missing `valid_from` is treated as an open start; missing/null
 * `valid_to` as an open end.
 *
 * Comparison is by instant (ms since epoch), so Chicago-offset strings with
 * heterogeneous DST (-05:00 vs -06:00) compare correctly.
 */
export function findTaxAt(
  taxes: Tax[],
  name: string,
  asOf: string,
): Tax | null {
  const t = new Date(asOf).getTime();
  const matches = taxes.filter((tax) => {
    if (tax.name !== name) return false;
    if (tax.valid_from != null && t < new Date(tax.valid_from).getTime()) {
      return false;
    }
    if (tax.valid_to != null && t >= new Date(tax.valid_to).getTime()) {
      return false;
    }
    return true;
  });
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    const detail = matches
      .map((m) => `${m.uid}@[${m.valid_from ?? "-∞"},${m.valid_to ?? "∞"})`)
      .join(", ");
    throw new Error(
      `Tax catalog drift: multiple "${name}" docs bracket ${asOf}: ${detail}`,
    );
  }
  return matches[0];
}

/**
 * Doc-level location tax profiles → the Tax doc `name` they resolve to (by
 * `findTaxAt`, as-of date). `tax_applied` (no override) and `tax_exempt`
 * (handled separately) are absent.
 *
 * **A profile added here needs a `taxes/` document with that exact name, or
 * `findTaxAt` returns `null` and the override silently does nothing.** That is
 * the failure mode `tax_paxton` was added to fix rather than to repeat: prod
 * #1978 was delivered to Paxton, Illinois, Xero taxed it `TAX005` at the 6.25%
 * IL-state rate, and CFS had no Paxton profile at all — so it fell back to
 * Rantoul's 9% and disagreed with Xero by $4.89 on top of the service-line tax
 * it should not have charged.
 */
export const TAX_PROFILE_OVERRIDE_NAME: Partial<Record<TaxProfileType, string>> =
  {
    tax_rantoul: "Rantoul Sales Tax",
    tax_frankfort: "Frankfort Sales Tax",
    tax_paxton: "Paxton Sales Tax",
  };

/**
 * Resolve the effective doc-level override from the org + doc `tax_profile`
 * pair, as-of `asOf`.
 *
 * **Two questions, in order — not a scan.**
 *
 * 1. Is either side `tax_exempt`? Then exempt. Exemption is sticky from either
 *    direction because it is a legal fact about the customer, not a preference
 *    about where the work happened; no prod order or invoice overrides *away*
 *    from an exempt org.
 * 2. Otherwise the document's profile if it has one, else the org's — a plain
 *    `??`, so a `null` doc profile means INHERIT and any non-null value means
 *    the document is deliberately overriding.
 *
 * ⚠️ **What this replaced could not express "plain Chicago".** It scanned
 * `[docProfile, orgProfile]` and took the first that named a *location* tax, so
 * a doc-level `"tax_applied"` — the operator saying "this one is ordinary" —
 * matched no name, fell through, and picked up the org's location profile
 * anyway. That is live: prod invoice #2348 is issued and in Xero with
 * `tax_profile: "tax_applied"`, taxed **Frankfort 8%**, while its own
 * `taxes_base` records Chicago Sales 10.25%. Making `Order.tax_profile`
 * nullable is what gives "inherit" its own representation and frees
 * `"tax_applied"` to mean what it says.
 *
 * `orgProfile` accepts `undefined` for the duration of the
 * `organization.tax_profile` backfill — see `DocumentOrganizationSnapshot`.
 * It resolves to {@link DEFAULT_TAX_PROFILE}, which is the pre-#486 behaviour
 * and therefore not a regression; `audit-order-tax-profile.ts` is what says
 * when the window has closed.
 *
 * @returns `"exempt"` (→ empty taxes) | a resolved `Tax` | `null` (no override).
 */
export function getEffectiveProfileTax(
  orgProfile: TaxProfileType | undefined,
  docProfile: TaxProfileType | null,
  taxCatalog: Tax[],
  asOf: string,
): Tax | "exempt" | null {
  const effective = resolveEffectiveProfile(orgProfile, docProfile);
  if (effective === "tax_exempt") return "exempt";
  const name = TAX_PROFILE_OVERRIDE_NAME[effective];
  return name ? findTaxAt(taxCatalog, name, asOf) : null;
}

/**
 * The **one precedence rule**, as a profile rather than as a resolved Tax:
 * exemption from either side wins, then the document's profile, then the
 * organization's.
 *
 * Extracted because two consumers need the same answer in different currencies
 * and had grown two rules. {@link getEffectiveProfileTax} answers *"which Tax
 * document prices this line?"*; `resolveXeroTaxType` (api-cloudrun
 * `src/lib/xeroTax.ts`) answers *"which Xero `TaxType` does the line carry?"* —
 * and it did so with its own `taxProfiles.includes("tax_frankfort")` scan over
 * `[org, doc]`. Under the `??` precedence those two disagree exactly where it
 * costs money: a document-level `"tax_applied"` under a Frankfort organization
 * now prices Chicago in CFS while the scan still stamps Xero `TAX007`. CFS has
 * paid for that class of divergence once already — 19 invoices and $2,741.78 of
 * phantom receivable when this function's taxable-COA set was a second copy
 * (api-cloudrun#409).
 *
 * So the Xero side resolves the profile through *this* and passes the single
 * answer, rather than restating the precedence over an array.
 */
export function resolveEffectiveProfile(
  orgProfile: TaxProfileType | undefined,
  docProfile: TaxProfileType | null,
): TaxProfileType {
  const org = orgProfile ?? DEFAULT_TAX_PROFILE;
  if (org === "tax_exempt" || docProfile === "tax_exempt") return "tax_exempt";
  return docProfile ?? org;
}

/**
 * Materialize a doc-level `tax_profile` override onto each priceable item's
 * `price.taxes` (single mode — mutates in place):
 * - `tax_exempt` → `taxes = []`, `total_cents = subtotal_discounted_cents`.
 * - `tax_rantoul` / `tax_frankfort` → `taxes = [<resolved tax>]` with amount
 *   computed from the item's **existing** `subtotal_discounted_cents` + `total_cents`
 *   refreshed. (Orders re-run `calculateItemPrice` after, which recomputes both
 *   from the rewritten uid; the CRMS invoice webhook keeps the amounts computed
 *   here on its `charge_total`-authoritative subtotal.)
 * - `tax_applied` / no active override doc → item left untouched.
 *
 * Non-priceable items (destination/group/transaction_fee) are skipped.
 */
export function overrideItemTaxesForProfile(
  items: LineItem[],
  orgProfile: TaxProfileType | undefined,
  docProfile: TaxProfileType | null,
  taxCatalog: Tax[],
  asOf: string,
): void {
  const effective = getEffectiveProfileTax(
    orgProfile,
    docProfile,
    taxCatalog,
    asOf,
  );
  if (effective === null) return;

  for (const item of items) {
    if (!isPreTaxItem(item)) continue;
    const subtotalDiscountedCents = item.price.subtotal_discounted_cents ?? 0;

    // A non-revenue line is not taxable under ANY profile. Without this clause
    // the location overrides re-taxed exactly the lines the Xero push then
    // strips to `TaxType: "NONE"` — a clean A/B in prod: #1647 (`tax_applied`)
    // held Delivery with `taxes: []`, while #2051 (`tax_rantoul`) had the same
    // product at the same COA carrying a 9% tax. Same rule as
    // `calculateItemTax`, so the profile path cannot reintroduce what the base
    // path now removes.
    if (!isTaxableCoa(item.coa_revenue)) {
      item.price.taxes = [];
      item.price.total_cents = subtotalDiscountedCents;
      continue;
    }

    if (effective === "exempt") {
      item.price.taxes = [];
      item.price.total_cents = subtotalDiscountedCents;
      continue;
    }

    const amountCents = computeItemTaxAmountCents(
      effective,
      subtotalDiscountedCents,
      item.quantity,
    );
    const modifier: PriceModifier = {
      uid: effective.uid,
      name: effective.name,
      rate: effective.rate,
      type: effective.type,
      amount_cents: amountCents,
    };
    item.price.taxes = [modifier];
    item.price.total_cents = subtotalDiscountedCents + amountCents;
  }
}

/**
 * **The one tax materializer.** Apply a document's `tax_profile` as a doc-level
 * override, then reprice every priceable line from its (rewritten) tax uid.
 * Mutates `items` in place; callers run `calculateOrderTotals` /
 * `calculateInvoiceTotals` afterwards.
 *
 * This is {@link overrideItemTaxesForProfile} **plus the reprice** — the pair
 * every write path that owns its own line prices needs, and the pair only the
 * order path had. `api-cloudrun`'s `repriceOrderItemsForProfile` was this
 * function for orders only; native `POST/PUT /invoices` called neither half, so
 * a `tax_exempt` invoice stored the profile, sent Xero `TaxType: NONE`, and kept
 * CFS items and totals fully taxed.
 *
 * Three consumers, one implementation: api-cloudrun's order write paths,
 * api-cloudrun's `createInvoice`/`updateInvoice`, and the manager's optimistic
 * recompute. The manager consumer is the reason this lives in `core` rather than
 * in `api-cloudrun/src/lib/` — a client-side reimplementation would recreate, on
 * the client, exactly the order/invoice divergence this function exists to
 * close.
 *
 * ⚠️ **The CRMS invoice webhook must keep calling the bare
 * {@link overrideItemTaxesForProfile}, not this.** Its subtotals are
 * `charge_total`-authoritative (api-cloudrun#236) — a reprice would recompute
 * them from `base_cents × quantity × days_factor` and under-bill, which
 * `crms.test.ts` pins at 28.6% on a real line.
 *
 * **`orgProfile` is a real parameter, not a constant.** The order path hardcoded
 * `"tax_applied"` here, so an org-level `tax_exempt` was honored on that
 * customer's invoices and silently ignored on their orders. Precedence is
 * {@link getEffectiveProfileTax}'s: `tax_exempt` from either side wins, then the
 * doc's location profile, then the org's.
 *
 * **Pure** — `asOf` is injected rather than defaulted to now, so this stays free
 * of an ambient clock (the workspace date rules ban `new Date()` for business
 * datetimes, and a defaulted `now` is how that ban gets bypassed). Callers
 * derive it: the order paths from the earliest destination delivery start, the
 * invoice paths from `invoice.date`.
 *
 * @param items Document items, mutated in place. Non-priceable members
 *   (destination/group/transaction_fee) are skipped by both halves.
 * @param orgProfile The customer organization's `tax_profile`.
 * @param docProfile The document's own `tax_profile`, which takes precedence.
 * @param taxCatalog The `taxes` collection, for name+date resolution.
 * @param asOf Instant to resolve the tax catalog at.
 */
export function materializeDocumentTax(
  items: LineItem[],
  orgProfile: TaxProfileType | undefined,
  docProfile: TaxProfileType | null,
  taxCatalog: Tax[],
  asOf: string,
): void {
  overrideItemTaxesForProfile(items, orgProfile, docProfile, taxCatalog, asOf);

  for (const item of items) {
    if (!isPreTaxItem(item)) continue;
    const computed = calculateItemPrice(item, taxCatalog);
    // A SPREAD, not a field-by-field rebuild. The order-side original listed
    // every key it meant to keep, which made preservation opt-in: `taxes_base`
    // had to be re-added later as a conditional spread once the rebuild was
    // found to be dropping it, and `base_percent` is still missing from that
    // list. It is inert there only because `isPreTaxItem` rejects the
    // `percent_of_total` lines that carry it — an accident, not a design.
    //
    // Spreading also makes this function shape-agnostic, which is what lets one
    // implementation serve both documents: an order price carries
    // `replacement_cents`, a strict-schema key the invoice rejects, and it is
    // not named here. Since api-cloudrun#480 dropped `discount_percent` the
    // asymmetry runs one way only — but the spread is what keeps that a fact
    // about today's schemas rather than a precondition of this function.
    item.price = {
      ...item.price,
      subtotal_cents: computed.subtotal_cents,
      subtotal_discounted_cents: computed.subtotal_discounted_cents,
      discount: computed.discount,
      taxes: computed.taxes,
      total_cents: computed.total_cents,
    };
  }
}

// ── Out-of-state sourcing ────────────────────────────────────────

/**
 * The one destination shape the order-side tax rules read.
 *
 * Two fields, for the two questions: `delivery.address.region` answers *"is this
 * document sourced outside Illinois?"* ({@link isEntirelyOutOfIllinois}) and
 * `dates.delivery_start` answers *"as of when do its taxes resolve?"*
 * ({@link deriveOrderTaxAsOf}). Both optional, because a caller mid-edit may
 * have neither.
 */
export interface TaxSourcingDestination {
  dates?: { delivery_start?: string | null } | null;
  delivery?: { address?: { region?: string } | null } | null;
}

/**
 * Does **every** destination on this document deliver outside Illinois?
 *
 * The one automatic exception to "everything sources to the store address".
 * CFS is registered to collect in exactly three jurisdictions — Chicago,
 * Frankfort and Rantoul — and collects no sales tax outside Illinois, so an
 * order delivered entirely out of state carries none. Everything else,
 * including the dozen Illinois suburbs a Chicago production films in on three
 * days' notice, sources to Chicago and is overridden by hand when a customer
 * asks; deriving forty jurisdictions from an address is explicitly not wanted
 * (api-cloudrun#237, closed won't-do).
 *
 * **Conservative in two directions, deliberately:**
 *
 * - `every`, not `some` — a mixed Illinois/out-of-state order keeps its tax
 *   rather than being wholly exempted. Under-collecting is the expensive error.
 * - An **unresolvable** region keeps the tax. {@link toUsStateCode} returns
 *   `null` for unknown, never for "not Illinois", and this reads it that way.
 *   That distinction is not academic: 18 of the 48 non-`"IL"` prod destinations
 *   are Illinois spelled `"Illinois"`, 13 of them in Chicago, so a bare
 *   `region !== "IL"` here would have stopped collecting tax CFS owes on all 18.
 *
 * A document with no destinations is not out of state.
 *
 * Lives in core rather than in api-cloudrun because the manager's optimistic
 * recompute has to reach the same answer — a client-side reimplementation would
 * put the divergence back on the client, which is the whole reason
 * {@link materializeDocumentTax} lives here too.
 */
export function isEntirelyOutOfIllinois(
  destinations: ReadonlyArray<TaxSourcingDestination | null | undefined> | undefined,
): boolean {
  const codes = (destinations ?? []).map((d) => toUsStateCode(d?.delivery?.address?.region));
  if (codes.length === 0) return false;
  return codes.every((code) => code !== null && code !== "IL");
}

// ── The ORDER-side composition ──────────────────────────────────

/**
 * As-of instant for resolving an order's taxes: the earliest destination
 * delivery start, falling back to `now`.
 *
 * **`now` is injected, and that is the whole reason this can live in `core`.**
 * The two callers reach for different clocks — api-cloudrun's
 * `Timestamp.now().toDate().toISOString()`, the manager's
 * `new Date().toISOString()` — and both produce the same UTC-Z form, so the
 * fallback resolves identically on either side.
 *
 * ⚠️ **Not the banned business-date anti-pattern.** `asOf` is a resolution
 * instant handed to {@link findTaxAt}, never written to a document. Emitting
 * Chicago offset form here would make the server and the client resolve
 * differently for an instant near midnight, which is the failure this note
 * exists to prevent.
 *
 * ⚠️ **"Earliest" is by INSTANT, and a `.sort()` over the strings is not that.**
 * The form this replaced sorted the ISO text. For CANONICAL Chicago values that
 * happens to be correct — canonicalization makes the wall-clock text monotonic
 * with the instant, including across a DST switch, because everything before it
 * reads `≤ 01:59:59.999-06:00` and everything after reads `≥ 03:00:00.000-05:00`
 * (measured; the earlier draft of this note claimed a DST inversion and was
 * wrong). It breaks on a MIXED set: `2026-06-01T08:00:00.000-05:00` sorts before
 * `2026-06-01T12:00:00.000Z` while being an hour LATER.
 *
 * That is reachable, and specifically on the client: the manager calls this
 * against an in-memory, mid-edit order, where a date picker can supply a raw
 * `Z` value that has not been through `toChicagoInstant` yet. Stored documents
 * are all canonical, so no persisted order was ever affected.
 */
export function deriveOrderTaxAsOf(
  destinations: ReadonlyArray<TaxSourcingDestination | null | undefined> | undefined,
  now: string,
): string {
  const starts = (destinations ?? [])
    .map((d) => d?.dates?.delivery_start)
    .filter((s): s is string => typeof s === "string");
  if (starts.length === 0) return now;
  // Earliest by INSTANT — `compareAsc` over parsed dates, not `.sort()` over the
  // strings. See the ⚠️ in the docblock for why the text order is not the
  // instant order. The original string is returned rather than a re-serialized
  // one, so the value handed to `findTaxAt` is still what the document says.
  return starts.reduce((earliest, s) =>
    compareAsc(parseISO(s), parseISO(earliest)) < 0 ? s : earliest
  );
}

/**
 * **The one order-side tax materializer.** Resolve an order's effective tax from
 * its organization snapshot, its own `tax_profile` and its destinations, then
 * reprice every billable line. Mutates `items` in place; callers run
 * `calculateOrderTotals` after.
 *
 * This is {@link materializeDocumentTax} plus the two things that are true of an
 * ORDER and not of an invoice — the as-of instant is the delivery date rather
 * than `invoice.date`, and an out-of-state delivery is exempt.
 *
 * ⚠️ **It lives here because it is POLICY, and policy written twice drifts.**
 * It began as `api-cloudrun/src/lib/orderTaxPricing.ts`, and the manager then
 * wrote a second copy in `src/utils/documentTax.ts` — carrying a comment saying
 * the two must stay byte-for-byte identical, which is a wish, not a mechanism.
 * The arithmetic was already shared; this is the ~10 lines around it.
 *
 * Three things it centralizes across the order write paths:
 *
 * 1. **The organization's profile is passed for real.** Its predecessor
 *    hardcoded `"tax_applied"` in that position because an order's snapshot had
 *    no `tax_profile` to pass (api-cloudrun#486). A tax-exempt customer's
 *    invoices went untaxed and their orders went taxed, and what covered the gap
 *    was CRMS stamping the order's profile from the opportunity header — i.e.
 *    the system being retired.
 * 2. **`docProfile: null` means INHERIT**, and is the safe default: an order
 *    that says nothing cannot tax an exempt customer. A non-null value is a
 *    deliberate override, and an explicit `"tax_applied"` beats an org-level
 *    location profile rather than losing to it.
 * 3. **The out-of-state rule**, applied as an exemption in the DOC position so
 *    it composes with the precedence rule instead of shadowing it — a Frankfort
 *    customer's Missouri delivery is still untaxed.
 *
 * ⚠️ Deriving that rule from the destination address does **not** generalize to
 * jurisdiction: CFS is registered in exactly three, a Chicago production films
 * in a dozen Illinois suburbs on short notice, and picking a jurisdiction per
 * suburb is explicitly not wanted (api-cloudrun#237, won't-do). Out-of-state is
 * a REGISTRATION boundary, not a sourcing model.
 *
 * ⚠️ The CRMS **invoice** webhook must keep calling the bare
 * {@link overrideItemTaxesForProfile} — its subtotals are
 * `charge_total`-authoritative and a reprice would under-bill
 * (api-cloudrun#236). This is the order path only.
 */
export function materializeOrderTax(
  items: LineItem[],
  orgProfile: TaxProfileType | undefined,
  docProfile: TaxProfileType | null,
  destinations: ReadonlyArray<TaxSourcingDestination | null | undefined> | undefined,
  taxCatalog: Tax[],
  now: string,
): void {
  // Out of state → exempt, expressed in the doc position. `getEffectiveProfileTax`
  // makes exemption sticky from either side, so this cannot be silently
  // outranked by an org-level location profile.
  const effectiveDocProfile: TaxProfileType | null = isEntirelyOutOfIllinois(destinations)
    ? "tax_exempt"
    : docProfile;

  materializeDocumentTax(
    items,
    orgProfile,
    effectiveDocProfile,
    taxCatalog,
    deriveOrderTaxAsOf(destinations, now),
  );
}
