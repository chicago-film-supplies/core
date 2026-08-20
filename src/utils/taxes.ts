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
 * The APPLIED window of a tax version, dual-reading the old field names.
 *
 * ⚠️ **`applied_from ?? valid_from`, and the `??` is load-bearing.**
 * api-cloudrun#409 renames the pair, and deploy and document-migration cannot
 * be simultaneous. Reading only the new name against a document still holding
 * only the old one yields a MISSING bound — which every bracket check below
 * treats as OPEN, so every version brackets every instant and {@link findTaxAt}
 * throws `Tax catalog drift`. That throw is on the pricing path, and out of a
 * CRMS Cloud Task handler it retries forever. Phase 2 deletes the fallback and
 * the old fields together.
 *
 * Note the ASYMMETRY: `applied_to` is legitimately `null` (open-ended), so it
 * falls back only when *absent*, never when explicitly null. `applied_from` has
 * no meaningful null.
 */
export function taxAppliedWindow(tax: Tax): { from: string | null; to: string | null } {
  return {
    from: tax.applied_from ?? tax.valid_from ?? null,
    to: tax.applied_to !== undefined ? tax.applied_to : (tax.valid_to ?? null),
  };
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
 * @see {@link taxAppliedWindow} for the Phase-1 dual-read and why a missing
 * bound is dangerous rather than merely permissive.
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
 * ## Conservative in the same two directions as {@link isEntirelyOutOfIllinois}
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
 * Pure and db-free, like {@link isEntirelyOutOfIllinois}, so the manager
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
 * document sourced outside Illinois?"* ({@link isEntirelyOutOfIllinois}) and
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
  /** Level 1 — the document's own answer for this destination. */
  jurisdiction?: JurisdictionType | null;
  delivery?: {
    /** The `destinations/{uid}` this entry ships to — the key a divider names. */
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
 * Then the divider names its endpoint (`uid_delivery`) and the entry answers
 * for it (`delivery.uid`) — the same key the CRMS carry-forwards use, and
 * deliberately not the array index, which moves when CRMS reorders.
 *
 * ## Three fallbacks, each measured rather than assumed
 *
 * Measured over the whole prod corpus (18,958 priceable lines,
 * `scripts/audit-tax-key.ts`, 2026-08-20):
 *
 * | rung | lines | when it fires |
 * |---|---|---|
 * | `uid_delivery` ↔ `delivery.uid` | 18,755 | the ordinary case |
 * | divider index among dividers | 198 | a divider naming no endpoint |
 * | the single entry | 5 | a divider-less items array |
 * | `null` — no destinations at all | 88 | 31 CRMS invoices with no source order |
 *
 * `null` is a DEFINED answer, not a failure: a document with no destination
 * sources entirely to the origin. Nothing in the corpus reaches a fifth case,
 * which is why there is no guessing rung.
 */
export function destinationsForItems(
  items: readonly LineItem[],
  destinations: ReadonlyArray<TaxDestination | null | undefined>,
): Array<TaxDestination | null> {
  const byPath = new Map<string, LineItem>();
  for (const item of items) {
    if (item.path?.length) byPath.set(item.path.join("/"), item);
  }
  const dividers = items.filter((i) => i.type === "destination");

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

    if (divider) {
      if (divider.uid_delivery) {
        const byUid = destinations.find((d) => d?.delivery?.uid === divider.uid_delivery);
        if (byUid) return byUid;
      }
      const index = dividers.indexOf(divider);
      if (index >= 0 && index < destinations.length) return destinations[index] ?? null;
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
   * The tax this line's `(jurisdiction, type)` pair resolves to at
   * `ctx.asOf`, **before exemption**. `null` means no tax covers the pair —
   * which is how `service`, `surcharge` and an out-of-nexus destination stay
   * untaxed without a second rule naming any of them.
   */
  tax: Tax | null;
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
 * ## Two rules sit in front of the lookup, and both are ORDER-dependent
 *
 * 1. **A non-revenue account is not taxable under any jurisdiction.** The gate
 *    is {@link isTaxableCoa}, and it is kept in Phase 2 rather than deleted:
 *    the argument for deleting it is that `item_types` already excludes every
 *    non-revenue line TYPE, and `scripts/audit-tax-key.ts` §2 measures whether
 *    that holds. On 2026-08-20 it did not — five priced
 *    `sale`/`rental`/`replacement` lines sit at accounts 2210 and 4800 — so the
 *    gate is still load-bearing. #409 is the measured cost of getting this
 *    wrong: 19 invoices and $2,741.78 of phantom receivable when CFS taxed
 *    lines it told Xero were `NONE`.
 *
 * 2. **A `replacement` sources to the ORIGIN**, skipping levels 1 and 2
 *    entirely. Every replacement is a sale in which **CFS is the end user** —
 *    the customer buys the item *for CFS*, to replace gear CFS owns — so the
 *    situs is CFS's own location and no document- or organization-level
 *    jurisdiction reaches it (owner, 2026-08-20). The live Xero ledger has
 *    been doing this all along: invoice 2348 (a Frankfort customer) bills its
 *    replacement at TAX001 Chicago Sales Tax.
 *
 * ⚠️ **Exemption is NOT applied here** — it belongs to
 * {@link assignLineTaxes}, which needs this answer twice: zeroed into
 * `price.taxes`, and un-zeroed into `price.taxes_base`, so an exempt document
 * still records which tax it was exempt FROM.
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

  // 1. A non-revenue account is untaxable whatever the jurisdiction. The
  //    resolved jurisdiction is still reported: it is what the manager renders
  //    beside the line, and it is true of the line whether or not tax is due.
  const jurisdictionOf = (): { jurisdiction: JurisdictionType; level: JurisdictionLevel | "origin" } => {
    // 2. The replacement rule — levels 1 and 2 do not apply to it.
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
  if (item.coa_revenue != null && !isTaxableCoa(item.coa_revenue)) {
    return { jurisdiction, level, tax: null };
  }

  const resolved = findTaxFor(ctx.taxes, jurisdiction, key, ctx.asOf);
  return { jurisdiction, level, tax: resolved ? atStoredVersion(resolved, ctx) : null };
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
 * `Water Bottle Tax` and `No Tax` are the `jurisdiction: null` class:
 * reachable by uid alone and invisible to {@link findTaxFor} by construction.
 * They ride a line because the PRODUCT carries the ref, so rebuilding the array
 * from the rule alone would silently drop a real charge. Preserved deliberately
 * rather than by accident — prod carries zero such lines today
 * (`scripts/audit-tax-key.ts` §3), which is exactly why this would have gone
 * unnoticed.
 *
 * ⚠️ A ref naming a uid the catalog does not hold is **dropped**, unlike
 * `resolveTaxRefsAt`'s deliberate passthrough. That function moves a line
 * between versions of a tax and must not decide taxability; this one IS the
 * taxability decision, and a tax the catalog cannot answer for is not the
 * answer.
 */
export function assignLineTaxes(items: LineItem[], ctx: DocumentTaxContext): void {
  const byUid = new Map(ctx.taxes.map((t) => [t.uid, t]));
  const destinations = destinationsForItems(items, ctx.destinations);

  items.forEach((item, index) => {
    if (!isPreTaxItem(item)) return;
    const subtotalDiscountedCents = item.price.subtotal_discounted_cents ?? 0;
    const { tax } = resolveLineTax(item, destinations[index], ctx);

    item.price.taxes_base = tax
      ? [{ uid: tax.uid, name: tax.name, rate: tax.rate, type: tax.type }]
      : [];

    const explicitOnly = (item.price.taxes ?? []).filter((modifier) => {
      const doc = byUid.get(modifier.uid);
      return doc !== undefined && doc.jurisdiction == null;
    }).map((modifier) => byUid.get(modifier.uid)!);

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
 */
export function materializeDocumentTax(items: LineItem[], ctx: DocumentTaxContext): void {
  assignLineTaxes(items, ctx);

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
}
