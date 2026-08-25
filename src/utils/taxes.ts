/**
 * Shared tax rules for CFS applications — **the single home for the pricing
 * rule**, so the API (order + invoice write paths, the CRMS webhooks) and the
 * manager (optimistic recompute) reach the same answer.
 *
 * The rule is `(item type × jurisdiction)`, zeroed by exemption, resolved
 * **per line** through the destination it is billed under:
 *
 * ```
 * key          = item.taxed_as ?? item.type
 * jurisdiction = destinations[i].jurisdiction        ← WINS
 *                  ?? organization.jurisdiction_claim
 *                  ?? deriveJurisdiction(address, origin)   // TOTAL
 * tax          = findTaxFor(catalog, jurisdiction, key, asOf)
 * ```
 *
 * ⚠️ **This replaced a doc-level `tax_profile` enum** that welded exemption to
 * jurisdiction (api-cloudrun#409). That shape could not express a mixed
 * Chicago/Frankfort order at all, and made `isEntirelyOutOfIllinois` an
 * all-or-nothing document exemption — so a mixed Illinois/California order
 * taxed its California lines. Both are gone: the jurisdiction is per
 * destination, and "CFS collects nothing here" is the `no_nexus` VALUE rather
 * than a missing case.
 *
 * Depends one-way on `./orders.ts` (base pricing module) — no cycle.
 *
 * @module
 */

import { compareAsc, parseISO } from "date-fns";
import {
  type JurisdictionType,
  type PreTaxItemType,
  toUsStateCode,
} from "../schemas/mod.ts";
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

// The line-taxability rule lives in `utils/orders.ts` for the same reason
// `computeItemTaxAmountCents` does — `utils/taxes.ts` depends one-way on
// `utils/orders.ts`, and the pricing engine there needs the gate. Re-exported
// so consumers can import everything tax-related from `@cfs/core/utils/taxes`.
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
 * at. ⚠️ **Both directions are now moot as a CLIENT hazard**, and the reason is
 * worth keeping: `materializeDocumentTax` no longer reads a client's
 * `price.taxes` refs at all — `assignLineTaxes` rebuilds the array from
 * `(taxed_as ?? type, jurisdiction)`, so a client that seeds the wrong tax, or
 * none, is corrected on save either way. This table survives as the DEFAULT a
 * restatement tool needs when it is reconstructing what a historical line
 * carried, not as a rule any writer consults.
 *
 * The **rate** is not here: it comes from the date-bracketed catalog via
 * {@link findTaxAt} at the document's own date.
 *
 * ⚠️ **A line with NO `coa_revenue` is not covered by this table** — custom
 * lines (`buildCustomOrderLine` / `buildCustomInvoiceLine`) construct no such
 * field, and prod carries **99** of them. That gap is why this is a HISTORICAL
 * oracle and not a rule: it can only answer for the lines that carry an
 * account.
 *
 * ⚠️ **Its consumers are restatement tools, not writers.** The live default is
 * `findTaxFor(catalog, jurisdiction, taxed_as ?? type, asOf)` — the same
 * `(item type × jurisdiction)` rule everything else resolves by, which answers
 * for a custom line too. A companion type-keyed table (`defaultTaxNameForLine`
 * / `DEFAULT_TAX_NAME_BY_TYPE`) was DELETED rather than kept: it was a second
 * encoding of a rule that already exists, and an earlier revision of this
 * docblock records a *third* (`chart-of-accounts.default_tax_profile`) deleted
 * for having one writer and zero readers.
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
 * The APPLIED window of a tax version — the one place the bracket checks below
 * read the bounds from.
 *
 * ⚠️ **A missing bound is read as OPEN**, and that is dangerous rather than
 * merely permissive: an unbounded version brackets every instant, so two
 * versions of one name bracket the same instant and {@link findTaxAt} throws
 * `Tax catalog drift` — on the pricing path, out of a CRMS Cloud Task handler,
 * which retries forever. `TaxSchema` requires both bounds precisely so a stored
 * document cannot reach that state; the `| null` here covers the partial
 * literals the structural `Tax` admits.
 */
export function taxAppliedWindow(tax: Tax): { from: string | null; to: string | null } {
  return { from: tax.applied_from ?? null, to: tax.applied_to ?? null };
}

/**
 * Does this tax version's half-open applied window contain `asOf`?
 *
 * Comparison is by instant (ms since epoch), so Chicago-offset strings with
 * heterogeneous DST (-05:00 vs -06:00) compare correctly. Half-open
 * `[from, to)` is what makes a supersede's boundary unambiguous: the successor
 * opens at exactly the instant the incumbent closes, and neither the last
 * millisecond of one nor the first of the other is claimed twice.
 */
function windowContains(tax: Tax, t: number): boolean {
  const { from, to } = taxAppliedWindow(tax);
  if (from != null && t < new Date(from).getTime()) return false;
  if (to != null && t >= new Date(to).getTime()) return false;
  return true;
}

/**
 * **The derived `active`.** Is this version the one CFS collects at `asOf`?
 *
 * This replaced a STORED `active` boolean, and the reason is that nothing ever
 * read the stored one: `findTaxFor` and `findTaxAt` have always selected by
 * window alone, so a flag disagreeing with the window changed nothing about
 * what got billed and everything about what an operator believed. Two prod
 * documents sat `active: true` with a window that had already closed
 * (api-cloudrun#613). One clause, derived on demand, cannot drift from the
 * bound that actually prices.
 *
 * ⚠️ **"Live" is a claim about the WINDOW, not about reachability.** The
 * explicit-only class (`item_types: []`) is reached by uid and is never
 * window-checked by {@link assignLineTaxes}, so `isTaxLive` is not the
 * question to ask of `No Tax` or `Water Bottle Tax` — their windows stay
 * open-ended precisely because an expiry on them would be inert.
 */
export function isTaxLive(tax: Tax, asOf: string): boolean {
  return windowContains(tax, new Date(asOf).getTime());
}

/** `uid@[from,to)` for a drift message. */
function windowLabel(tax: Tax): string {
  const { from, to } = taxAppliedWindow(tax);
  return `${tax.uid}@[${from ?? "-∞"},${to ?? "∞"})`;
}

/**
 * Pick the Tax whose applied window contains `asOf`, matched by exact `name`.
 * Returns null when nothing matches (e.g. `asOf` before any historical doc).
 * Throws on catalog drift (two same-name docs bracket the same instant).
 *
 * @see {@link taxAppliedWindow} for why a missing bound is dangerous rather
 * than merely permissive.
 */
export function findTaxAt(
  taxes: Tax[],
  name: string,
  asOf: string,
): Tax | null {
  const t = new Date(asOf).getTime();
  const matches = taxes.filter((tax) => tax.name === name && windowContains(tax, t));
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    throw new Error(
      `Tax catalog drift: multiple "${name}" docs bracket ${asOf}: ` +
        matches.map(windowLabel).join(", "),
    );
  }
  return matches[0];
}

/**
 * **The tax rule: `(jurisdiction × item type)`, as of a date.**
 *
 * Pick the one Tax covering `itemType` in `jurisdiction` whose applied window
 * contains `asOf`. `null` means *this line is untaxed*, which is a real answer
 * rather than a miss — a line is untaxed **iff no tax in its jurisdiction lists
 * its type**.
 *
 * ⚠️ **`null` has a second cause, and this function cannot tell you which.** A
 * cell whose window has LAPSED also returns `null` here, and that is a
 * configuration failure rather than a rate of zero. {@link taxCellState}
 * separates the two; this function is deliberately left as the two-valued
 * lookup because its read-only consumers (`ilTaxRateCheck`, the audits) must
 * not throw.
 *
 * One mechanism, which is the point. What this replaces was two: a
 * `coa_revenue` permissive gate (`isTaxableCoa`) and a separate name-keyed
 * default table, each of which could say "taxable" while the other said
 * "untaxed". api-cloudrun#409 measured that drift at 19 invoices and $2,741.78
 * of phantom receivable — CFS taxing lines it told Xero were `TaxType: NONE`.
 *
 * ⚠️ **A `null` jurisdiction is NEVER a wildcard, on either side.**
 * - A `null` ARGUMENT means *no nexus* (delivered outside Illinois): nothing is
 *   collected, so the answer is `null` without consulting the catalog.
 * - A `null` on a tax DOCUMENT marks the **explicit-only** class — a tax
 *   reachable by uid alone, never by this rule. Prod has exactly two (`No Tax`
 *   and `Water Bottle Tax`), and treating either as matching every jurisdiction
 *   would apply a $0.05/unit bottle tax to every line in the corpus.
 *
 * Throws on catalog drift, for the same reason {@link findTaxAt} does: two
 * taxes covering one `(jurisdiction, type, instant)` is a configuration error
 * with no correct silent resolution, and picking either one bills a number
 * nobody chose.
 *
 * @param taxes The `taxes` collection, unfiltered — historical versions
 *   included, since the window is what selects among them.
 * @param jurisdiction Where the goods went, already resolved through the
 *   destination → organization → {@link deriveJurisdiction} precedence.
 * @param itemType The line's `taxed_as ?? type`. A type no tax lists is
 *   untaxed, which is how `service`, `surcharge` and `transaction_fee` stay
 *   untaxed without a second rule naming them.
 * @param asOf Instant to resolve the catalog at.
 */
export function findTaxFor(
  taxes: Tax[],
  jurisdiction: JurisdictionType | null,
  itemType: string,
  asOf: string,
): Tax | null {
  // No nexus — nothing is collected, and no catalog lookup can change that.
  if (jurisdiction === null) return null;

  const t = new Date(asOf).getTime();
  const matches = taxes.filter((tax) => {
    // Skips the explicit-only class by construction: `null !== jurisdiction`
    // for every real jurisdiction, so it can never read as a wildcard.
    if (tax.jurisdiction !== jurisdiction) return false;
    if (!tax.item_types?.includes(itemType as PreTaxItemType)) return false;
    return windowContains(tax, t);
  });

  if (matches.length === 0) return null;
  if (matches.length > 1) {
    throw new Error(
      `Tax catalog drift: multiple taxes cover (${jurisdiction}, ${itemType}) ` +
        `at ${asOf}: ${matches.map((m) => `${m.name} ${windowLabel(m)}`).join(", ")}`,
    );
  }
  return matches[0];
}

/**
 * What the catalog has to say about one `(jurisdiction × item type)` cell at an
 * instant. Three states, because two could not tell the two ways of getting
 * `null` out of {@link findTaxFor} apart.
 *
 * - `taxed` — a version brackets `asOf`.
 * - `untaxed` — **nothing has ever covered this cell**, so `null` is the rule's
 *   real answer: a `service` line, a `transaction_fee`, an out-of-nexus
 *   destination. `price.taxes: []` means exactly this, corpus-wide.
 * - `expired` — CFS **used to** collect here and the window lapsed with nothing
 *   replacing it. That is a configuration failure, not a rate of zero.
 */
export type TaxCellState = "taxed" | "untaxed" | "expired";

/**
 * **The third state.** Is this cell taxed, genuinely untaxed, or EXPIRED?
 *
 * A cell is `expired` iff no version brackets `asOf` **and** some version of
 * that cell closed before it. A deliberate deregistration is expressed as a
 * successor at 0% with an open window, never as a closed window with no
 * successor — so "the last thing we said about this cell was a rate, and it has
 * run out" is unambiguous.
 *
 * ⚠️ **`untaxed` is the answer that must NOT widen.** A Chicago `service` line
 * is `untaxed` and always has been: no tax has ever listed that type, so there
 * is no lapsed version to find. If this returned `expired` for it, every
 * service line in the corpus would be reported as pricing on a lapsed rate —
 * and, worse, would fall forward onto a tax that never covered it. That
 * distinction is the safety property the whole design turns on; see
 * {@link UnreviewedTaxWarning}.
 *
 * ⚠️ A `null` jurisdiction is `untaxed`, never `expired`: no-nexus means no
 * catalog lookup happens at all, which is a decision rather than a lapse.
 *
 * @param taxes The `taxes` collection, unfiltered — historical versions are
 *   what make the lapse visible.
 */
export function taxCellState(
  taxes: Tax[],
  jurisdiction: JurisdictionType | null,
  itemType: string,
  asOf: string,
): TaxCellState {
  if (jurisdiction === null) return "untaxed";

  const t = new Date(asOf).getTime();
  const cell = taxes.filter((tax) =>
    tax.jurisdiction === jurisdiction &&
    (tax.item_types?.includes(itemType as PreTaxItemType) ?? false)
  );

  if (cell.some((tax) => windowContains(tax, t))) return "taxed";
  return cell.some((tax) => {
    const { to } = taxAppliedWindow(tax);
    return to != null && new Date(to).getTime() <= t;
  })
    ? "expired"
    : "untaxed";
}

/**
 * **One line priced on a rate whose REVIEW has lapsed**, reported by
 * {@link assignLineTaxes}.
 *
 * ⚠️ **An unreviewed rate is not a known-wrong one** (owner, 2026-08-23):
 * *"an expired rate isn't known stale, it's unknown to be not stale — most
 * rates will be renewed without changing."* What ran out is the CONFIRMATION,
 * not the number. Chicago Rental Tax has been 15% since 2026-01-01 and will
 * most likely still be 15% after a review. So this is a prompt to look, not a
 * report of a defect, and everything downstream is levelled accordingly: a
 * `warn`, never an `error`; a notice in the UI, never a blocked save.
 *
 * ## Why a warning rather than a refusal
 *
 * An earlier revision THREW here, on the reasoning that a closed window makes
 * {@link findTaxFor} return `null`, `null` already means *"this line is
 * untaxed"*, and an unreviewed Chicago Rental Tax would therefore silently
 * zero-rate **70% of all tax CFS has ever collected**. The zero-rating problem
 * is real and this design still fixes it — by falling forward to the most
 * recent version rather than to nothing.
 *
 * 🔴 **The refusal was WRONG, and the reason is worth keeping**: a document
 * resolves the catalog at its own instant, and for an ORDER that instant is the
 * earliest delivery start — a date in the FUTURE
 * ({@link deriveOrderTaxAsOf}). So a finite `applied_to` was not a review
 * deadline, it was a hard ceiling on how far ahead CFS could take a booking:
 * setting one to 2026-12-01 immediately refused every order delivering after
 * that date. Measured on prod 2026-08-23, 1 of 81 live orders became unwritable
 * the moment the bound was set, and every new forward booking past it would
 * have 400'd.
 *
 * So the rule is: **price on the most recent version at or before `asOf`, and
 * say so.** That is the same money an open-ended window would have produced —
 * which is exactly why refusing was disproportionate — plus a signal that never
 * existed.
 */
export interface UnreviewedTaxWarning {
  /** The jurisdiction whose cell has lapsed. */
  jurisdiction: JurisdictionType;
  /** The line key that resolved it — `item.taxed_as ?? item.type`. */
  item_type: string;
  /** The version being used — the most recent one at or before `as_of`. */
  tax_uid: string;
  tax_name: string;
  rate: number;
  /** When that version's review window ran out. */
  expired_at: string;
  /** The instant the document resolves the catalog at. */
  as_of: string;
}

/**
 * The most recent version of a cell whose window CLOSED at or before `asOf` —
 * the fall-forward answer when nothing brackets it.
 *
 * ⚠️ **"Most recent" means most recently CLOSED, not the newest document.** A
 * document dated inside an interior gap gets the version that ran up TO the
 * gap, not the one that starts after it: the rate CFS was actually charging
 * immediately before that instant is the only defensible fallback, and
 * reaching forward past a gap would apply a rate that had not taken effect.
 *
 * Returns `null` when nothing has closed before `asOf` — i.e. the cell was
 * never taxed at that date, which is a real answer and not a lapse.
 */
function mostRecentClosedTax(
  taxes: Tax[],
  jurisdiction: JurisdictionType,
  itemType: string,
  asOf: string,
): Tax | null {
  const t = new Date(asOf).getTime();
  let best: Tax | null = null;
  let bestEnd = -Infinity;
  for (const tax of taxes) {
    if (tax.jurisdiction !== jurisdiction) continue;
    if (!(tax.item_types?.includes(itemType as PreTaxItemType) ?? false)) continue;
    const { to } = taxAppliedWindow(tax);
    if (to == null) continue;
    const end = new Date(to).getTime();
    if (end <= t && end > bestEnd) {
      best = tax;
      bestEnd = end;
    }
  }
  return best;
}

// ── Jurisdiction derivation ──────────────────────────────────────

/**
 * The Illinois municipalities CFS is **registered to collect in**, by
 * upper-cased city name.
 *
 * A jurisdiction is a registration, not a place — which is why this is a short
 * closed list and not a geography lookup. Deriving forty jurisdictions from an
 * address is explicitly unwanted (api-cloudrun#237, closed won't-do); an
 * Illinois address outside these sources to the store instead.
 *
 * ⚠️ **`paxton` is absent, deliberately.** CFS no longer delivers there, so it
 * must not be *derived* — but it stays a {@link JurisdictionType} member
 * because one prod order and one invoice embed the Paxton tax uid and
 * `calculateItemTax` throws `Unknown tax uid` on a missing one. Closed, not
 * erased.
 *
 * `no_nexus` is absent for a different reason: it is not a city CFS collects
 * in, it is the answer when the address is in no state CFS collects in at all
 * — case 1, decided by the region and never by this table.
 */
const COLLECTING_JURISDICTION_BY_CITY: Readonly<Record<string, JurisdictionType>> = {
  CHICAGO: "chicago",
  RANTOUL: "rantoul",
  FRANKFORT: "frankfort",
};

/**
 * **Where a delivery address sources to** — the bottom of the three-level
 * jurisdiction precedence ({@link resolveJurisdiction}), below the document's
 * own destination entry and the organization's `jurisdiction_claim`.
 *
 * ## Three cases, three DIFFERENT legal reasons
 *
 * | # | address | result | why |
 * |---|---|---|---|
 * | 1 | outside Illinois | `"no_nexus"` | **nexus** — no obligation in another state |
 * | 2 | an Illinois city CFS collects in | that jurisdiction | **destination sourcing** |
 * | 3 | any other Illinois municipality | `origin` | **origin sourcing** — the sale is deemed to occur at our selling location |
 *
 * ## TOTAL — it always answers, and that is what frees `null` upstream
 *
 * There is no address this returns `null` for: an unresolvable region falls to
 * case 3, and a missing city falls to case 3. Case 1 returns the `no_nexus`
 * **value** rather than `null` because `null` means *"I assert nothing, ask the
 * next level"* at every level of the chain, and this is the last level — it has
 * nobody to ask. See {@link JurisdictionType} for why the two were split.
 *
 * ⚠️ **Case 3 is a RULE, not a fallback, and cases 1 and 3 are not the same
 * thing.** Merging them — "we don't collect there, so no tax" — untaxes every
 * non-Chicago Illinois delivery, which is under-collection on a real
 * obligation. The asymmetry is why `origin` is a named required parameter
 * rather than a default: a reader has to see that a Naperville delivery is
 * taxed, and taxed at *our store's* rate.
 *
 * ## Conservative in the same two directions as `isEntirelyOutOfIllinois`
 *
 * An **unresolvable** region falls to case 3, not case 1. `toUsStateCode`
 * returns `null` for *unknown*, never for *not Illinois*, and 18 of the 48
 * non-`"IL"` prod destinations are Illinois spelled `"Illinois"` — 13 of them
 * in Chicago. Reading unknown as out-of-state would have stopped collecting tax
 * CFS owes on all 18. Under-collecting is the expensive error.
 *
 * ## Matching
 *
 * ⚠️ **The city is matched EXACTLY (trimmed, case-folded), never by prefix.**
 * *Chicago Heights* and *West Frankfort* are distinct Illinois municipalities
 * with their own rates; a `startsWith` would bill both at Chicago's.
 *
 * ⚠️ **`mapbox_id` is deliberately NOT the key**, though it is present on many
 * addresses. It identifies an *address*, not a municipality — there is no
 * city→id table to match against — and prod's geocodes are demonstrably wrong:
 * CFS's own warehouse at 3100 W Fillmore St resolves to "Palos Township /
 * 60480", and another destination sits at "Grant Park / 60612". Which is also
 * the reason this derivation is the LOWEST precedence level: it is a
 * convenience, and an explicit jurisdiction at any level above it outranks it.
 *
 * Pure and db-free, like its predecessor `isEntirelyOutOfIllinois`, so the manager
 * reaches the same answer as the API without a round trip.
 *
 * @param address The destination's delivery address.
 * @param origin The selling store's own jurisdiction, resolved by the caller
 *   through `Order.uid_store` → `Store.uid_destination` →
 *   `Destination.jurisdiction`. **Not a constant** — CFS sells from a store,
 *   and a second store in another jurisdiction changes the answer for every
 *   case-3 address without touching this function.
 */
export function deriveJurisdiction(
  address: { city?: string; region?: string } | null | undefined,
  origin: JurisdictionType,
): JurisdictionType {
  // 1. NEXUS. Only a POSITIVELY resolved non-Illinois state exits here; an
  //    unrecognized region is unknown, not out of state.
  const code = toUsStateCode(address?.region);
  if (code !== null && code !== "IL") return "no_nexus";

  // 2. DESTINATION SOURCING — an exact municipality CFS collects for.
  const city = (address?.city ?? "").trim().toUpperCase();
  if (Object.hasOwn(COLLECTING_JURISDICTION_BY_CITY, city)) {
    return COLLECTING_JURISDICTION_BY_CITY[city];
  }

  // 3. ORIGIN SOURCING — in Illinois, but not somewhere CFS collects, so the
  //    sale is deemed to occur at the selling location.
  return origin;
}

/** Which level of the precedence chain supplied a resolved jurisdiction. */
export type JurisdictionLevel = "document" | "organization" | "derived";

/**
 * The three levels, as named fields so no caller can get the ORDER wrong.
 *
 * Every level is `JurisdictionType | null | undefined`, and `null` and absent
 * mean the same thing at all of them: *"I assert nothing, ask the next level."*
 * The answer *"this sources somewhere CFS collects no tax"* is the `no_nexus`
 * value — see {@link JurisdictionType}.
 */
export interface JurisdictionLevels {
  /**
   * Level 1 — `order/invoice.destinations[i].jurisdiction`, the document's own
   * value. Seeded at create on the native path from the organization's claim
   * when that is not the origin, and operator-editable thereafter.
   *
   * ⚠️ **Read the document's own stored value here.** It is a snapshot: an
   * order records what it was billed, so it must not re-resolve out from under
   * a live document.
   */
  documentDestination?: JurisdictionType | null;
  /** Level 2 — `organizations/{uid}.jurisdiction_claim`, the customer's standing claim. */
  organization?: JurisdictionType | null;
  /** Level 3 input — the delivery address this destination ships to. */
  address?: { city?: string; region?: string } | null;
  /**
   * Level 3 input — `stores/{uid}.jurisdiction`, the selling store's own
   * origin. Required, and not a constant: a second store in another
   * jurisdiction changes every case-3 answer without touching this.
   *
   * ⚠️ **The ONE jurisdiction that is asserted rather than derived.** Making
   * the origin itself depend on an address means an edited city on our own
   * warehouse re-rates every non-collecting Illinois delivery.
   */
  origin: JurisdictionType;
}

/** A resolved jurisdiction and the level of the chain that supplied it. */
export interface ResolvedJurisdiction {
  jurisdiction: JurisdictionType;
  level: JurisdictionLevel;
}

/**
 * **Resolve which jurisdiction a destination's lines are taxed in.** The one
 * implementation of the precedence — per DESTINATION, never per document, which
 * is what lets one order carry two jurisdictions.
 *
 * ```
 * order/invoice.destinations[i].jurisdiction   the document's own value   ← WINS
 *   ?? organizations/{uid}.jurisdiction_claim    the customer's standing claim
 *   ?? deriveJurisdiction(address, origin)       total — always answers
 * ```
 *
 * **TOTAL: it always returns a jurisdiction**, because level 3 does. A caller
 * never has to decide what "no answer" means, and `findTaxFor` gets a value it
 * can look up — `no_nexus` simply matches no tax, which is the untaxed result
 * expressed as data rather than as a missing case.
 *
 * ## There is deliberately NO destination-master level
 *
 * `destinations/{uid}` carried a `jurisdiction` until api-cloudrun#591, ranked
 * between the claim and the derivation. It is gone, and its removal is the
 * point rather than a simplification:
 *
 * - **It was never authored.** 1 of 459 documents carried one — the CFS
 *   warehouse — and that one was really the store's ORIGIN wearing an address's
 *   clothes. It now lives on `Store.jurisdiction`, where it is a property of the
 *   selling business rather than of a street.
 * - **Ranked above the claim it cancelled it**, on all 8 repriceable
 *   jurisdiction-bearing orders (every one a `customer_collecting` order pointed
 *   at that warehouse). An override a shared address can beat is not an
 *   override.
 * - **Ranked below the claim it did nothing**, because nothing wrote it: there
 *   is no destinations write route, only `destinations.read`/`.search`.
 * - **Storing a DERIVED value there would have been worse than blank.** A
 *   destination is keyed by address and reused across orders and years, so a
 *   stamped jurisdiction goes wrong *prospectively* the day CFS registers
 *   somewhere new — every future delivery to that address sourcing at the old
 *   rate. Snapshot on the DOCUMENT, which records a transaction; derive on the
 *   MASTER, which is a long-lived reference.
 *
 * ## Returning the level is not a convenience
 *
 * The order form has to show which level supplied each answer
 * (chicago-film-supplies/manager#304), and a second implementation of the
 * precedence to compute that is exactly the drift this function exists to
 * prevent. One call answers both.
 */
export function resolveJurisdiction(levels: JurisdictionLevels): ResolvedJurisdiction {
  if (levels.documentDestination != null) {
    return { jurisdiction: levels.documentDestination, level: "document" };
  }
  if (levels.organization != null) {
    return { jurisdiction: levels.organization, level: "organization" };
  }
  return {
    jurisdiction: deriveJurisdiction(levels.address, levels.origin),
    level: "derived",
  };
}

// ── Destination shapes the order rules read ─────────────────────

/**
 * The one destination shape the order-side tax rules read.
 *
 * Two fields, for the two questions: `delivery.address.region` answers *"is this
 * document sourced outside Illinois?"* ({@link deriveJurisdiction}) and
 * `dates.delivery_start` answers *"as of when do its taxes resolve?"*
 * ({@link deriveOrderTaxAsOf}). Both optional, because a caller mid-edit may
 * have neither.
 */
export interface TaxSourcingDestination {
  dates?: { delivery_start?: string | null } | null;
  delivery?: { address?: { region?: string } | null } | null;
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

// ── The pricing rule: item TYPE × JURISDICTION, per LINE ─────────

/**
 * One `destinations[]` entry, as the tax rule reads it.
 *
 * Structural rather than `DocDestinationType`, for the same reason
 * {@link TaxSourcingDestination} is: the manager calls this against a
 * mid-edit order whose destinations are not yet valid documents, and an order
 * pair and an invoice pair are two hand-listed `strictObject`s that share no
 * schema.
 */
export interface TaxDestination {
  /**
   * **The pair's identity: its destination DIVIDER's uid**, and the only key
   * {@link destinationsForItems} joins on.
   *
   * ⚠️ Not a `destinations/{uid}` document id — that is `delivery.uid` below,
   * and the two answer different questions. This one says *which row of this
   * document*; that one says *which address in the shared address book*. They
   * were one field until api-cloudrun#662/#663/#664, and every one of those
   * incidents is the second job leaking into the first.
   *
   * Optional here and required on the stored schemas (`DocDestinationType`,
   * `InvoiceDocDestinationType`) for the reason the interface's own docblock
   * gives: the manager calls this against a mid-edit order whose destinations
   * are not yet valid documents.
   */
  uid?: string | null;
  /** Level 1 — the document's own answer for this destination. */
  jurisdiction?: JurisdictionType | null;
  delivery?: {
    /**
     * The `destinations/{uid}` this entry ships to — the shared address book
     * row. **Payload, not identity**; see {@link TaxDestination.uid}.
     */
    uid?: string | null;
    address?: { city?: string; region?: string } | null;
  } | null;
}

/**
 * Everything the per-line rule needs that is not the line itself.
 *
 * One object rather than seven positional arguments, because every field is a
 * property of the DOCUMENT and they are read together — and because a caller
 * that omits one gets a compile error naming it rather than a silently shifted
 * argument.
 */
export interface DocumentTaxContext {
  /**
   * The document's `destinations[]`, **in document order**. Order matters:
   * it is the fallback key when a divider names no `uid_delivery`.
   */
  destinations: ReadonlyArray<TaxDestination | null | undefined>;
  /** Level 2 — `organizations/{uid}.jurisdiction_claim`. */
  organizationClaim?: JurisdictionType | null;
  /**
   * Level 3 — `stores/{uid}.jurisdiction`, the selling store's own origin.
   * Asserted, never derived; see {@link JurisdictionLevels.origin}.
   */
  origin: JurisdictionType;
  /**
   * `org.tax_exempt || doc.tax_exempt === true`, **already folded by the
   * caller**.
   *
   * ⚠️ Sticky from either side, never `doc ?? org` — a `false` on the document
   * must not un-exempt an exempt customer. Folding it at the caller rather
   * than taking both halves here is what stops a second copy of that rule:
   * there is one boolean, and it is either true or the customer pays tax.
   */
  exempt: boolean;
  /** The `taxes` collection, unfiltered — historical versions included. */
  taxes: Tax[];
  /**
   * The instant the catalog resolves at: an order's earliest delivery start
   * ({@link deriveOrderTaxAsOf}), an invoice's own `date`.
   */
  asOf: string;
  /**
   * Frozen documents only: tax NAME → the version uid the stored document
   * already carries.
   *
   * ⚠️ **The rule picks a TAX; this picks which VERSION of it.** They are
   * separate questions and only the first one moved in api-cloudrun#409 Phase
   * 2. A completed order re-priced on a later CRMS event must keep the rate it
   * was billed at, and `applied_from` alone does not guarantee that — it is set
   * to the CUTOVER, which is before a future delivery date, so re-resolving an
   * order that delivers next month would hand it the new rate. Omit for a live
   * document, which resolves at `asOf` like everything else.
   */
  frozenVersions?: ReadonlyMap<string, string>;
}

/**
 * The `destinations[]` entry each item is billed under — **one array, parallel
 * to `items`**, so the caller walks the document once rather than per line.
 *
 * ## Reached by `path` ancestry, never by a fixed depth
 *
 * `item.path` is the row identity and its ancestors are addressable exactly
 * (`path.slice(0, k)`), which is what makes this level-agnostic: an order's
 * hierarchy is `[destination, group]` and an invoice's is
 * `[order, destination, group]`, so anything keyed on a depth would find the
 * destination on one document and the ORDER divider on the other.
 *
 * Then the divider IS the pair's identity: `pair.uid === divider.uid`, one
 * lookup, no second copy to disagree with. Deliberately not the array index,
 * which moves when CRMS reorders, and no longer the endpoint uid, which is a
 * `destinations/{uid}` document id and therefore *shared* by two pairs
 * delivering to one address (api-cloudrun#662/#663/#664).
 *
 * ## One join and one deduction — measured, not assumed
 *
 * Measured over the whole prod corpus (19,098 priceable lines,
 * `api-cloudrun/scripts/audit-tax-key.ts`, 2026-08-25; dev identical):
 *
 * | rung | lines | when it fires |
 * |---|---|---|
 * | `divider.uid` ↔ `pair.uid` | 19,008 | the ordinary case, and now the only join |
 * | the single entry | 2 | a divider-less items array |
 * | `null` — no destinations at all | 88 | 31 CRMS invoices with no source order |
 * | UNREACHABLE | 0 | — |
 *
 * `null` is a DEFINED answer, not a failure: a document with no destination
 * sources entirely to the origin.
 *
 * 🔴 **The divider-INDEX rung is deleted, and it must not come back.** It fired
 * on 198 lines when this table was first written and on **0** once the #662
 * repair landed, so it now costs nothing and only ever bought a guess: it is
 * the rung this function's own earlier comment called *"the tempting fix…
 * silently wrong the first time a multi-destination document drifted."* Under
 * the uid join a divider that names no pair is a **defect to report**, not a
 * position to guess from — Phase 4 of
 * `api-cloudrun/.claude/plans/destination-pair-identity.md` refuses it at
 * write.
 *
 * ⚠️ **The single-entry rung is KEPT, and it is a deduction rather than a
 * guess** — the same distinction `assignDestinationPairUids`' rung 2 draws.
 * With exactly one destination on the document there is no other answer to
 * pick, so nothing is being inferred from position.
 */
export function destinationsForItems(
  items: readonly LineItem[],
  destinations: ReadonlyArray<TaxDestination | null | undefined>,
): Array<TaxDestination | null> {
  const byPath = new Map<string, LineItem>();
  for (const item of items) {
    if (item.path?.length) byPath.set(item.path.join("/"), item);
  }

  return items.map((item) => {
    if (destinations.length === 0) return null;

    let divider: LineItem | undefined;
    const path = item.path ?? [];
    for (let k = path.length - 1; k >= 1; k--) {
      const ancestor = byPath.get(path.slice(0, k).join("/"));
      if (ancestor?.type === "destination") {
        divider = ancestor;
        break;
      }
    }

    if (divider?.uid) {
      const byUid = destinations.find((d) => d?.uid === divider.uid);
      if (byUid) return byUid;
    }

    return destinations.length === 1 ? destinations[0] ?? null : null;
  });
}

/**
 * **The jurisdiction each of a document's destinations resolves to**, with the
 * level that answered — one entry per `destinations[]` entry, in document
 * order.
 *
 * The order form renders exactly this (chicago-film-supplies/manager#304): a
 * jurisdiction per destination, and *which rung supplied it*, so an operator
 * can see that a value came from the customer's standing claim rather than
 * from the address. Exposed as a function rather than left to the caller
 * because a second implementation of the precedence — even a two-line one over
 * `resolveJurisdiction` — is the drift this module exists to prevent.
 *
 * ⚠️ **Per DESTINATION, not per line.** A `replacement` line ignores this and
 * sources to the origin ({@link resolveLineTax}), so a UI that labels lines
 * from these values alone will mislabel every replacement.
 */
export function destinationJurisdictions(ctx: DocumentTaxContext): ResolvedJurisdiction[] {
  return ctx.destinations.map((destination) =>
    resolveJurisdiction({
      documentDestination: destination?.jurisdiction,
      organization: ctx.organizationClaim,
      address: destination?.delivery?.address,
      origin: ctx.origin,
    })
  );
}

/** The tax one line resolves to, and the jurisdiction that decided it. */
export interface LineTaxResolution {
  jurisdiction: JurisdictionType;
  /** Which rung answered — `"origin"` is the replacement rule below. */
  level: JurisdictionLevel | "origin";
  /**
   * The axis the catalog was keyed on — `item.taxed_as ?? item.type`. Returned
   * rather than left to the caller because a caller that re-derives it is a
   * second copy of the rule, and the two would only ever disagree on the line
   * an operator deliberately overrode.
   */
  key: string;
  /**
   * What the catalog had to say about `(jurisdiction × key)` at `ctx.asOf` —
   * **after** the frozen-version fallback, so a frozen document that still
   * holds a version of a lapsed cell reads `taxed`.
   *
   * ⚠️ `expired` is what {@link assignLineTaxes} refuses on. This function
   * itself never throws: `api-cloudrun/scripts/audit-tax-key.ts` and the manager's
   * read-only surfaces call it to REPORT the state, and a reporter that dies
   * on the condition it reports is useless.
   */
  state: TaxCellState;
  /**
   * **The tax this line actually carries** — the jurisdiction's answer, zeroed
   * by exemption. `null` means untaxed, which is how `service`, `surcharge`, an
   * out-of-nexus destination and an exempt customer all stay untaxed without a
   * rule naming any of them.
   */
  tax: Tax | null;
  /**
   * The same answer **before exemption** — what `price.taxes_base` records, so
   * an exempt document still says which tax it was exempt FROM.
   *
   * ⚠️ Two fields rather than one, and the reason is a defect this shape
   * caused within an hour of existing: the first cut returned only the
   * pre-exemption tax and documented that callers must apply exemption
   * themselves. `api-cloudrun/scripts/audit-tax-key.ts` promptly did not, and reported 79
   * repriceable lines and $756.75 of movement that the writers would never
   * produce. A field a caller must remember to zero is a field that will be
   * read un-zeroed; `tax` is now the answer and `base` is the annotation.
   */
  base: Tax | null;
}

/**
 * **The pricing rule, for one line.** Tax liability is
 * `(item type × jurisdiction)`, resolved per line through its own destination.
 *
 * ```
 * key          = item.taxed_as ?? item.type
 * jurisdiction = resolveJurisdiction(document destination, org claim, address, origin)
 * tax          = findTaxFor(catalog, jurisdiction, key, asOf)
 * ```
 *
 * ## ONE rule sits in front of the lookup
 *
 * **A `replacement` sources to the ORIGIN**, skipping levels 1 and 2 entirely.
 * Every replacement is a sale in which **CFS is the end user** — the customer
 * buys the item *for CFS*, to replace gear CFS owns — so the situs is CFS's own
 * location and no document- or organization-level jurisdiction reaches it
 * (owner, 2026-08-20). The live Xero ledger has been doing this all along:
 * invoice 2348 (a Frankfort customer) bills its replacement at TAX001 Chicago
 * Sales Tax.
 *
 * ## 🔴 The revenue ACCOUNT is not one of the rules, and used to be
 *
 * Owner, 2026-08-20: *"an item's tax is item type × jurisdiction, it has
 * nothing to do with coa, coa is not a determining factor for tax."* So the
 * `isTaxableCoa` gate that stood here is **deleted**, not merely bypassed —
 * `TAXABLE_REVENUE_COAS` is now a statement about what CFS's Xero history
 * taxed, with no role in what a line is taxed today.
 *
 * ⚠️ **The gate had a twin at the Xero boundary, and the two only ever made
 * sense together.** `resolveXeroTaxType` refused a `TaxType` for the same
 * accounts, so removing one alone recreates api-cloudrun#409 exactly: CFS
 * computes a tax it then tells Xero not to charge, and the difference stands as
 * a phantom `amount_due` (19 invoices / $2,741.78 when it last happened). They
 * were removed in one commit.
 *
 * ⚠️ What made this safe was a per-LINE statement replacing a per-ACCOUNT one.
 * The class the gate was really covering was the CRMS bottled-water levy — a
 * tax billed as a line, where `isTaxableCoa(2210) === false` was the only thing
 * stopping sales tax being charged on a tax. That line now carries
 * `taxed_as: "none"`, which says it on the axis this rule actually reads.
 * Measured before the change (`api-cloudrun/scripts/audit-tax-key.ts` §2): 2 lines corpus-
 * wide sat at a non-revenue account, both `paid` and therefore frozen, so no
 * money moved.
 *
 * ⚠️ **Exemption zeroes `tax` and leaves `base`.** Both are returned because
 * {@link assignLineTaxes} needs the answer twice — zeroed into `price.taxes`,
 * un-zeroed into `price.taxes_base` — and because a caller reading a single
 * pre-exemption field will forget to zero it. `tax` is the answer.
 *
 * ⚠️ **`no_nexus` is a jurisdiction, not an exemption, and the difference is
 * visible exactly here.** Its lines resolve `tax: null` because no tax lists
 * that jurisdiction — but a `replacement` on an out-of-state destination still
 * sources to the origin and IS taxed, which the retired
 * `isEntirelyOutOfIllinois` (an all-or-nothing document-level exemption) could
 * not express. Measured at 8 lines corpus-wide, none repriceable, $0.00 either
 * way — the cheapest possible moment to have made the two rules disagree.
 */
export function resolveLineTax(
  item: LineItem,
  destination: TaxDestination | null,
  ctx: DocumentTaxContext,
): LineTaxResolution {
  const key = item.taxed_as ?? item.type;

  // The jurisdiction is resolved even when no tax comes of it: it is what the
  // manager renders beside the line, and it is true of the line whether or not
  // tax is due.
  const jurisdictionOf = (): { jurisdiction: JurisdictionType; level: JurisdictionLevel | "origin" } => {
    // The replacement rule — levels 1 and 2 do not apply to it.
    if (key === "replacement") return { jurisdiction: ctx.origin, level: "origin" };
    if (!destination) return { jurisdiction: ctx.origin, level: "derived" };
    return resolveJurisdiction({
      documentDestination: destination.jurisdiction,
      organization: ctx.organizationClaim,
      address: destination.delivery?.address,
      origin: ctx.origin,
    });
  };

  const { jurisdiction, level } = jurisdictionOf();
  const resolved = findTaxFor(ctx.taxes, jurisdiction, key, ctx.asOf);
  if (resolved) {
    const base = atStoredVersion(resolved, ctx);
    return { jurisdiction, level, key, state: "taxed", tax: ctx.exempt ? null : base, base };
  }

  // Nothing brackets `asOf`. Which of the two `null`s is it?
  const state = taxCellState(ctx.taxes, jurisdiction, key, ctx.asOf);
  if (state === "expired") {
    // A frozen document already decided this cell, and a lapse in the LIVE
    // catalog must not retroactively detax it. Same reasoning as
    // {@link atStoredVersion}, one rung earlier: there the stored version is
    // picked over today's, here it is picked over nothing at all. Checked
    // BEFORE the fall-forward, because what the document already stores beats
    // what the catalog would infer for it.
    const frozen = frozenTaxForCell(ctx, jurisdiction, key);
    if (frozen) {
      return { jurisdiction, level, key, state: "taxed", tax: ctx.exempt ? null : frozen, base: frozen };
    }
    // 🔴 **Fall forward, do not refuse.** The most recent version at or before
    // `asOf` is the rate CFS was last charging for this cell, and it is what an
    // open-ended window would have applied anyway — an unreviewed rate is
    // unverified, not known-wrong. `state` stays `expired` so
    // {@link assignLineTaxes} can report it: the line prices, and the fact that
    // its review has lapsed travels with it.
    const lapsed = mostRecentClosedTax(ctx.taxes, jurisdiction, key, ctx.asOf);
    if (lapsed) {
      const stale = atStoredVersion(lapsed, ctx);
      return { jurisdiction, level, key, state, tax: ctx.exempt ? null : stale, base: stale };
    }
  }
  return { jurisdiction, level, key, state, tax: null, base: null };
}

/**
 * The version of a lapsed cell a FROZEN document already carries, if exactly
 * one of its frozen versions covers that cell.
 *
 * ⚠️ **More than one match keeps today's answer (`null`), rather than picking.**
 * A document storing two taxes for one `(jurisdiction × item type)` pair is
 * document-level drift, not catalog drift, and the frozen path is the one place
 * that must never refuse — a completed order has to stay writable. Guessing
 * between two stored rates would bill a number nobody chose, which is exactly
 * what {@link findTaxFor}'s own drift throw exists to prevent.
 */
function frozenTaxForCell(
  ctx: DocumentTaxContext,
  jurisdiction: JurisdictionType,
  itemType: string,
): Tax | null {
  if (!ctx.frozenVersions) return null;
  const matches = [...ctx.frozenVersions.values()]
    .map((uid) => ctx.taxes.find((t) => t.uid === uid))
    .filter((t): t is Tax =>
      t !== undefined &&
      t.jurisdiction === jurisdiction &&
      (t.item_types?.includes(itemType as PreTaxItemType) ?? false)
    );
  return matches.length === 1 ? matches[0] : null;
}

/**
 * The version of `tax` this document should carry — today's, or the one a
 * frozen document already stores under that NAME.
 *
 * ⚠️ A frozen name the document has never carried resolves at `asOf` like any
 * other. That is the case where the rule moves a line to a DIFFERENT tax (a
 * jurisdiction correction on a completed order): there is no stored version of
 * a tax the document never had, and freezing cannot mean "keep a version that
 * does not exist".
 */
function atStoredVersion(tax: Tax, ctx: DocumentTaxContext): Tax {
  const frozenUid = ctx.frozenVersions?.get(tax.name);
  if (frozenUid == null) return tax;
  return ctx.taxes.find((t) => t.uid === frozenUid) ?? tax;
}

/**
 * **Write the rule's answer onto every priceable line** — `price.taxes`,
 * `price.taxes_base` and a refreshed `price.total_cents`. Mutates in place;
 * computes no subtotal.
 *
 * This is the half a `charge_total`-authoritative caller needs on its own: the
 * CRMS invoice webhook must call THIS and never
 * {@link materializeDocumentTax}, because a reprice would recompute its
 * subtotals from `base_cents × quantity × days_factor` and under-bill by a
 * measured 28.6% on a real line (api-cloudrun#236).
 *
 * ## `taxes` and `taxes_base` have ONE author, and that is the change
 *
 * `taxes_base` used to be the *product's* intrinsic tax, written at line-build
 * time so that reverting a `tax_profile` override could restore it. With the
 * jurisdiction rule there is nothing to revert TO — the rule is total and
 * re-derived on every write — so the field keeps its name and takes the
 * meaning it always described: **the tax this line would carry if the customer
 * were not exempt.** One function writes both, so they cannot drift, and an
 * exempt document still records which tax it was exempt from.
 *
 * ## An explicit-only ref on the line SURVIVES
 *
 * `Water Bottle Tax` and `No Tax` are the `item_types: []` class: reachable by
 * uid alone and invisible to {@link findTaxFor} by construction. A member may
 * carry a `jurisdiction` to SCOPE itself — the bottle tax is levied per bottle
 * sold in Chicago — and a ref whose scope does not match the line's resolved
 * jurisdiction is dropped.
 * They ride a line because the PRODUCT carries the ref, so rebuilding the array
 * from the rule alone would silently drop a real charge. Preserved deliberately
 * rather than by accident — prod carries zero such lines today
 * (`api-cloudrun/scripts/audit-tax-key.ts` §3), which is exactly why this would have gone
 * unnoticed.
 *
 * ⚠️ A ref naming a uid the catalog does not hold is **dropped**, unlike
 * `resolveTaxRefsAt`'s deliberate passthrough. That function moves a line
 * between versions of a tax and must not decide taxability; this one IS the
 * taxability decision, and a tax the catalog cannot answer for is not the
 * answer.
 *
 * ## It REPORTS an unreviewed rate — it does not refuse one
 *
 * @returns one {@link UnreviewedTaxWarning} per `(jurisdiction × item type)`
 * cell that priced on a version whose review window has run out, **deduped by
 * cell**: a 61-line order resolving one such cell yields one warning, not 61.
 * An empty array is the healthy answer.
 *
 * The line still prices — on the most recent version at or before `asOf`, the
 * same money an open-ended window would have produced. ⚠️ **An earlier revision
 * THREW here and it was wrong**: an order resolves the catalog at its earliest
 * DELIVERY START, so a finite `applied_to` refused every booking past that date
 * rather than scheduling a review. See {@link UnreviewedTaxWarning}.
 *
 * ⚠️ **The return value is the whole signal — dropping it makes the lapse
 * invisible again.** Every caller either surfaces it (the manager, from its own
 * recompute) or logs it (api-cloudrun's write paths).
 *
 * ⚠️ **A warning is emitted even when the document is EXEMPT.** The line prices
 * at $0 either way, but `taxes_base` records which tax it was exempt FROM, and
 * that annotation is being taken from a version nobody has re-confirmed. What
 * needs attention is the catalogue, not the document.
 *
 * A frozen document is unaffected and produces no warning:
 * {@link resolveLineTax} takes the version the document already stores first.
 */
export function assignLineTaxes(items: LineItem[], ctx: DocumentTaxContext): UnreviewedTaxWarning[] {
  const byUid = new Map(ctx.taxes.map((t) => [t.uid, t]));
  const destinations = destinationsForItems(items, ctx.destinations);
  const stale = new Map<string, UnreviewedTaxWarning>();

  items.forEach((item, index) => {
    if (!isPreTaxItem(item)) return;
    const subtotalDiscountedCents = item.price.subtotal_discounted_cents ?? 0;
    const { tax, base, jurisdiction, key, state } = resolveLineTax(item, destinations[index], ctx);

    // Priced on a version whose REVIEW window ran out. `base` is that version —
    // the fall-forward already happened in `resolveLineTax` — so the warning
    // names the rate actually being charged rather than re-deriving it here.
    if (state === "expired" && base) {
      const { to } = taxAppliedWindow(base);
      if (to != null) {
        stale.set(`${jurisdiction} ${key}`, {
          jurisdiction,
          item_type: key,
          tax_uid: base.uid,
          tax_name: base.name,
          rate: base.rate,
          expired_at: to,
          as_of: ctx.asOf,
        });
      }
    }

    item.price.taxes_base = base
      ? [{ uid: base.uid, name: base.name, rate: base.rate, type: base.type }]
      : [];

    // The explicit-only refs the line already carries, kept only where their
    // SCOPE matches. `jurisdiction == null` is unscoped (applies wherever the
    // line is); a scoped one applies only in its own jurisdiction.
    //
    // ⚠️ **The scope is what makes "5¢ per bottle sold in Chicago" expressible
    // at all.** Without it a case of water delivered to Frankfort carried
    // Chicago's levy, because an explicit-only ref was applied unconditionally
    // — and the tax cannot instead be made resolvable, since `(chicago, sale)`
    // is already Chicago Sales Tax's and `findTaxFor` THROWS on two taxes
    // covering one pair.
    const explicitOnly = (item.price.taxes ?? [])
      .map((modifier) => byUid.get(modifier.uid))
      .filter((doc): doc is Tax => doc !== undefined && doc.item_types?.length === 0)
      .filter((doc) => doc.jurisdiction == null || doc.jurisdiction === jurisdiction);

    // An exempt line drops the explicit-only refs too — a tax is a tax.
    const applied = ctx.exempt ? [] : [...(tax ? [tax] : []), ...explicitOnly];
    const modifiers: PriceModifier[] = applied.map((t) => ({
      uid: t.uid,
      name: t.name,
      rate: t.rate,
      type: t.type,
      amount_cents: computeItemTaxAmountCents(t, subtotalDiscountedCents, item.quantity),
    }));

    item.price.taxes = modifiers;
    item.price.total_cents = modifiers.reduce(
      (sum, m) => sum + m.amount_cents,
      subtotalDiscountedCents,
    );
  });

  return [...stale.values()];
}

/**
 * **The one tax materializer.** {@link assignLineTaxes} plus the reprice —
 * the pair every write path that owns its own line prices needs. Mutates
 * `items` in place; callers run `calculateOrderTotals` /
 * `calculateInvoiceTotals` afterwards.
 *
 * Three consumers, one implementation: api-cloudrun's order write paths, its
 * `createInvoice`/`updateInvoice`, and the manager's optimistic recompute. The
 * manager consumer is why this lives in `core` — a client-side
 * reimplementation would recreate, on the client, exactly the order/invoice
 * divergence this function exists to close.
 *
 * **Pure** — `asOf` is injected rather than defaulted to now, so this stays
 * free of an ambient clock (a defaulted `now` is how the workspace ban on
 * `new Date()` for business datetimes gets bypassed).
 *
 * @returns {@link assignLineTaxes}'s unreviewed-rate warnings, passed straight
 * through. Every consumer — both api-cloudrun write paths and the manager's
 * optimistic recompute — is responsible for surfacing or logging them; a
 * dropped return value makes the lapse invisible, which is the condition this
 * whole mechanism exists to end.
 */
export function materializeDocumentTax(
  items: LineItem[],
  ctx: DocumentTaxContext,
): UnreviewedTaxWarning[] {
  const stale = assignLineTaxes(items, ctx);

  for (const item of items) {
    if (!isPreTaxItem(item)) continue;
    const computed = calculateItemPrice(item, ctx.taxes);
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
    // not named here.
    item.price = {
      ...item.price,
      subtotal_cents: computed.subtotal_cents,
      subtotal_discounted_cents: computed.subtotal_discounted_cents,
      discount: computed.discount,
      taxes: computed.taxes,
      total_cents: computed.total_cents,
    };
  }

  return stale;
}
