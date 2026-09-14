/**
 * **The legacy `(taxed_as ?? type) × jurisdiction` rule, frozen as a TEST ORACLE.**
 *
 * This is the pricing tail of `src/utils/taxes.ts` exactly as it stood before the
 * class reader switch (api-cloudrun#993), with its exports renamed `legacy*` and
 * its context taking the legacy `taxes: Tax[]`. It prices nothing in `src/`.
 *
 * It exists so `tests/tax-classes.test.ts`'s parity sweep compares the NEW
 * `assignLineTaxes` against the rule it replaced — rather than against the
 * class resolver it is built from, which would agree by construction.
 * Delete it with the parity sweep at the contract step.
 */
import type { JurisdictionType, PreTaxItemType } from "../../src/schemas/mod.ts";
import {
  calculateItemPrice,
  computeItemTaxAmountCents,
  isPreTaxItem,
  type LineItem,
  type PriceModifier,
  type Tax,
} from "../../src/utils/orders.ts";
import {
  type DocumentTaxContext,
  destinationsForItems,
  findTaxFor,
  type JurisdictionLevel,
  resolveJurisdiction,
  taxAppliedWindow,
  type TaxCellState,
  taxCellState,
  type TaxDestination,
  type UnreviewedTaxWarning,
} from "../../src/utils/taxes.ts";

/** The pre-switch context: `taxes` where the new one has `catalog`. */
export type LegacyTaxContext = Omit<DocumentTaxContext, "catalog"> & { taxes: Tax[] };

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


/** The tax one line resolves to, and the jurisdiction that decided it. */
export interface LegacyLineTaxResolution {
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
   * Whether exemption applies to THIS line — `ctx.exempt`, except `false` on a
   * `replacement`, where CFS is the buyer and the customer's exemption cannot
   * reach (owner, 2026-09-13; core#109). Returned so {@link assignLineTaxes}
   * reads the same answer rather than re-deriving it from `ctx.exempt`.
   */
  exempt: boolean;
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
 * 🔴 **For the same reason, EXEMPTION does not reach a replacement either**
 * (owner, 2026-09-13; core#109). Exemption is a fact about the customer as
 * buyer, and on a replacement the buyer is CFS. An earlier revision zeroed it
 * ("a different axis"), which billed every exempt customer's L&D line untaxed.
 * Measured before the change: 0 live exempt documents carried a replacement
 * line, so no live money moved; 11 settled invoices did and stay frozen.
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
export function legacyResolveLineTax(
  item: LineItem,
  destination: TaxDestination | null,
  ctx: LegacyTaxContext,
): LegacyLineTaxResolution {
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
  // The replacement rule's second half — CFS is the buyer, so the customer's
  // exemption does not apply.
  const exempt = key === "replacement" ? false : ctx.exempt;
  const resolved = findTaxFor(ctx.taxes, jurisdiction, key, ctx.asOf);
  if (resolved) {
    const base = atStoredVersion(resolved, ctx);
    return { jurisdiction, level, key, state: "taxed", exempt, tax: exempt ? null : base, base };
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
      return { jurisdiction, level, key, state: "taxed", exempt, tax: exempt ? null : frozen, base: frozen };
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
      return { jurisdiction, level, key, state, exempt, tax: exempt ? null : stale, base: stale };
    }
  }
  return { jurisdiction, level, key, state, exempt, tax: null, base: null };
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
  ctx: LegacyTaxContext,
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
function atStoredVersion(tax: Tax, ctx: LegacyTaxContext): Tax {
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
export function legacyAssignLineTaxes(items: LineItem[], ctx: LegacyTaxContext): UnreviewedTaxWarning[] {
  const byUid = new Map(ctx.taxes.map((t) => [t.uid, t]));
  const destinations = destinationsForItems(items, ctx.destinations);
  const stale = new Map<string, UnreviewedTaxWarning>();

  items.forEach((item, index) => {
    if (!isPreTaxItem(item)) return;
    const subtotalDiscountedCents = item.price.subtotal_discounted_cents ?? 0;
    const { tax, base, jurisdiction, key, state, exempt } = legacyResolveLineTax(item, destinations[index], ctx);

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
    const applied = exempt ? [] : [...(tax ? [tax] : []), ...explicitOnly];
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
export function legacyMaterializeDocumentTax(
  items: LineItem[],
  ctx: LegacyTaxContext,
): UnreviewedTaxWarning[] {
  const stale = legacyAssignLineTaxes(items, ctx);

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
