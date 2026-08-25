import { assertEquals, assertThrows } from "@std/assert";
import { getInitialValues, OrderDocLineItem } from "../src/schemas/mod.ts";
import {
  assertCoaTaxMapCoversCore,
  assignLineTaxes,
  deriveOrderTaxAsOf,
  destinationsForItems,
  type DocumentTaxContext,
  findTaxAt,
  materializeDocumentTax,
  resolveLineTax,
  type TaxDestination,
} from "../src/utils/taxes.ts";
import type { LineItem, Tax } from "../src/utils/orders.ts";

const lineItemBase = getInitialValues(OrderDocLineItem) as Record<string, unknown>;
const priceBase = lineItemBase.price as Record<string, unknown>;

// The catalog the rule resolves against: a `(jurisdiction, item_types, window)`
// triple per version, mirroring prod's shape. Other `Tax` fields are omitted
// deliberately, to exercise the widened optional type.
//
// ⚠️ Under Rantoul and Frankfort there is NO rental/sales split — one tax
// covers every taxed type — while Chicago splits rental from sale. That
// asymmetry is the model, not a fixture convenience.
const CATALOG: Tax[] = [
  {
    uid: "frankfort-tax",
    name: "Frankfort Sales Tax",
    rate: 8,
    type: "percent",
    jurisdiction: "frankfort",
    item_types: ["rental", "sale", "replacement"],
    applied_from: "2026-01-01T00:00:00.000-06:00",
    applied_to: null,
  },
  {
    uid: "rantoul-tax",
    name: "Rantoul Sales Tax",
    rate: 9,
    type: "percent",
    jurisdiction: "rantoul",
    item_types: ["rental", "sale", "replacement"],
    applied_from: "2026-01-01T00:00:00.000-06:00",
    applied_to: null,
  },
  {
    uid: "chi-rental-tax",
    name: "Chicago Rental Tax",
    rate: 15,
    type: "percent",
    jurisdiction: "chicago",
    item_types: ["rental"],
    applied_from: "2026-01-01T00:00:00.000-06:00",
    applied_to: null,
  },
  {
    uid: "chi-sales-tax",
    name: "Chicago Sales Tax",
    rate: 10.5,
    type: "percent",
    jurisdiction: "chicago",
    item_types: ["sale", "replacement"],
    applied_from: "2020-01-01T00:00:00.000-06:00",
    applied_to: null,
  },
  // The explicit-only class: reachable by uid alone, matched by no
  // (jurisdiction, type) pair, and $0.05 per unit rather than a percentage.
  {
    uid: "bottle-tax",
    name: "Water Bottle Tax",
    rate: 0.05,
    type: "flat",
    jurisdiction: null,
    item_types: [],
    applied_from: "2026-01-01T00:00:00.000-06:00",
    applied_to: null,
  },
];

const AS_OF = "2026-07-02T00:00:00.000-05:00";

function makeItem(
  overrides: Partial<LineItem> = {},
  priceOverrides: Record<string, unknown> = {},
): LineItem {
  return {
    ...lineItemBase,
    name: "Test Item",
    type: "rental",
    quantity: 1,
    ...overrides,
    price: {
      ...priceBase,
      base_cents: 10000,
      chargeable_days: 5,
      subtotal_cents: 10000,
      subtotal_discounted_cents: 10000,
      total_cents: 11500,
      taxes: [{
        uid: "chi-rental-tax",
        name: "Chicago Rental Tax",
        rate: 15,
        type: "percent",
        amount_cents: 1500,
      }],
      ...priceOverrides,
    },
  } as LineItem;
}

// ── findTaxAt ────────────────────────────────────────────────────

Deno.test("findTaxAt resolves by name within the validity window", () => {
  const tax = findTaxAt(CATALOG, "Frankfort Sales Tax", AS_OF);
  assertEquals(tax?.uid, "frankfort-tax");
});

Deno.test("findTaxAt returns null when asOf precedes applied_from", () => {
  assertEquals(findTaxAt(CATALOG, "Frankfort Sales Tax", "2025-06-01T00:00:00.000-05:00"), null);
});

Deno.test("findTaxAt treats null applied_to as open-ended", () => {
  const tax = findTaxAt(CATALOG, "Frankfort Sales Tax", "2030-01-01T00:00:00.000-06:00");
  assertEquals(tax?.uid, "frankfort-tax");
});

Deno.test("findTaxAt throws on catalog drift (two same-name docs bracket asOf)", () => {
  const drifted: Tax[] = [
    ...CATALOG,
    { uid: "frankfort-dupe", name: "Frankfort Sales Tax", rate: 8, type: "percent", applied_from: "2026-01-01T00:00:00.000-06:00", applied_to: null },
  ];
  assertThrows(() => findTaxAt(drifted, "Frankfort Sales Tax", AS_OF), Error, "drift");
});

// ── The pricing rule: item TYPE × JURISDICTION, per LINE ─────────
//
// These replace ~40 arms that tested the `tax_profile` machinery
// (api-cloudrun#409 Phase 2). Every property those arms encoded is re-asserted
// here against the rule that replaced them — exemption's stickiness, the
// replacement carve-out, the COA gate, the reprice, the shape-agnostic price
// rebuild — plus the three the profile shape could not express at all: a mixed
// document, a line-level `taxed_as`, and a frozen rate version.

// LineItem.price is a union (priceable vs transaction-fee); narrow for asserts.
const px = (it: LineItem) =>
  it.price as {
    taxes: Array<{ uid: string; name: string; rate: number; type: string; amount_cents: number }>;
    taxes_base?: Array<{ uid: string; name: string; rate: number; type: string }>;
    total_cents: number;
  };

/** Full price surface, for asserting what survived the rebuild. */
const pxFull = (it: LineItem) => it.price as unknown as Record<string, unknown>;

/** A document destination delivering to `city`, `region`. */
/**
 * ⚠ `uid` is the PAIR's identity — its destination divider's uid, and the only
 * key `destinationsForItems` joins on. `delivery_uid` is the separate
 * `destinations/{uid}` address-book row. Every fixture below keeps the two
 * spelled differently ("d1" vs "dest-chi") on purpose: they were one value
 * until api-cloudrun#663, so a fixture that reuses one for both passes under
 * either join and cannot see the re-key at all.
 */
const at = (
  city: string | undefined,
  region = "IL",
  extra: Partial<TaxDestination> & { uid?: string; delivery_uid?: string } = {},
): TaxDestination => ({
  uid: extra.uid ?? null,
  jurisdiction: extra.jurisdiction,
  delivery: {
    uid: extra.delivery_uid ?? null,
    address: city === undefined ? null : { city, region },
  },
});

/** The context, with everything defaulted to "an ordinary Chicago document". */
const ctx = (overrides: Partial<DocumentTaxContext> = {}): DocumentTaxContext => ({
  destinations: [at("Chicago")],
  origin: "chicago",
  exempt: false,
  taxes: CATALOG,
  asOf: AS_OF,
  ...overrides,
});

Deno.test("the rule: a Chicago rental resolves Chicago Rental Tax and prices it", () => {
  const items = [makeItem()];
  materializeDocumentTax(items, ctx());
  assertEquals(px(items[0]).taxes.map((t) => t.uid), ["chi-rental-tax"]);
  assertEquals(px(items[0]).total_cents, 11500);
});

Deno.test("the rule: a Frankfort destination taxes the SAME line at 8%", () => {
  const items = [makeItem()];
  materializeDocumentTax(items, ctx({ destinations: [at("Frankfort")] }));
  assertEquals(px(items[0]).taxes.map((t) => t.uid), ["frankfort-tax"]);
  assertEquals(px(items[0]).taxes[0].amount_cents, 800);
  assertEquals(px(items[0]).total_cents, 10800);
});

Deno.test("🔴 a MIXED document prices each destination's lines differently", () => {
  // The headline defect of the shape this replaced: `tax_profile` was ONE value
  // per document, so an order delivering to Chicago and Frankfort could only be
  // billed at one of them. Nothing about the old shape could express this.
  const items = [
    { ...makeItem(), uid: "d1", type: "destination", path: ["d1"] },
    { ...makeItem(), uid: "l1", path: ["d1", "l1"] },
    { ...makeItem(), uid: "d2", type: "destination", path: ["d2"] },
    { ...makeItem(), uid: "l2", path: ["d2", "l2"] },
  ] as LineItem[];

  materializeDocumentTax(items, ctx({
    destinations: [
      at("Chicago", "IL", { uid: "d1", delivery_uid: "dest-chi" }),
      at("Frankfort", "IL", { uid: "d2", delivery_uid: "dest-frk" }),
    ],
  }));

  assertEquals(px(items[1]).taxes.map((t) => t.uid), ["chi-rental-tax"]);
  assertEquals(px(items[3]).taxes.map((t) => t.uid), ["frankfort-tax"]);
});

Deno.test("🔴 …and a MIXED Illinois/out-of-state document taxes only the Illinois lines", () => {
  // Same defect, the other direction. `isEntirelyOutOfIllinois` was
  // all-or-nothing by construction, so a mixed order taxed its California
  // lines — under-collecting was avoided by over-collecting.
  const items = [
    { ...makeItem(), uid: "d1", type: "destination", path: ["d1"] },
    { ...makeItem(), uid: "l1", path: ["d1", "l1"] },
    { ...makeItem(), uid: "d2", type: "destination", path: ["d2"] },
    { ...makeItem(), uid: "l2", path: ["d2", "l2"] },
  ] as LineItem[];

  materializeDocumentTax(items, ctx({
    destinations: [
      at("Chicago", "IL", { uid: "d1", delivery_uid: "dest-chi" }),
      at("Los Angeles", "CA", { uid: "d2", delivery_uid: "dest-ca" }),
    ],
  }));

  assertEquals(px(items[1]).taxes.map((t) => t.uid), ["chi-rental-tax"]);
  assertEquals(px(items[3]).taxes, []);
  assertEquals(px(items[3]).total_cents, 10000);
});

Deno.test("the rule: an entirely out-of-state document is untaxed, via no_nexus", () => {
  const items = [makeItem()];
  materializeDocumentTax(items, ctx({ destinations: [at("St. Louis", "MO")] }));
  assertEquals(px(items[0]).taxes, []);
  // …and it is a JURISDICTION, not an exemption: the line records what it
  // would have paid nowhere, so `taxes_base` is empty too.
  assertEquals(px(items[0]).taxes_base, []);
});

Deno.test("the rule: an unresolvable region keeps the tax (origin sourcing)", () => {
  const items = [makeItem()];
  materializeDocumentTax(items, ctx({ destinations: [at("Somewhere", "Freedonia")] }));
  assertEquals(px(items[0]).taxes.map((t) => t.uid), ["chi-rental-tax"]);
});

// ── Exemption ────────────────────────────────────────────────────

Deno.test("exemption empties taxes and sets total to subtotal_discounted", () => {
  const items = [makeItem()];
  materializeDocumentTax(items, ctx({ exempt: true }));
  assertEquals(px(items[0]).taxes, []);
  assertEquals(px(items[0]).total_cents, 10000);
});

Deno.test("🔴 an exempt line still records WHICH tax it was exempt from", () => {
  // `taxes_base` keeps its name and takes the meaning it always described. A
  // document that carries no record of the tax it did not charge cannot be
  // audited against Xero, and #2197 is the live cost of the alternative: 25
  // lines whose jurisdiction is now unrecoverable from the document.
  const items = [makeItem()];
  materializeDocumentTax(items, ctx({ destinations: [at("Frankfort")], exempt: true }));
  assertEquals(px(items[0]).taxes, []);
  assertEquals(px(items[0]).taxes_base?.map((t) => t.uid), ["frankfort-tax"]);
});

Deno.test("exemption beats a jurisdiction, whichever level supplied it", () => {
  for (const destinations of [[at("Frankfort")], [at("Chicago", "IL", { jurisdiction: "rantoul" })]]) {
    const items = [makeItem()];
    materializeDocumentTax(items, ctx({ destinations, exempt: true }));
    assertEquals(px(items[0]).taxes, []);
  }
});

// ── The replacement rule ─────────────────────────────────────────

Deno.test("🔴 a REPLACEMENT sources to the ORIGIN, not to its destination", () => {
  // Every replacement is a sale in which CFS is the END USER — the customer
  // buys the item *for CFS* — so the situs is CFS's own location. Corroborated
  // by the live Xero ledger: invoice 2348, a Frankfort customer, bills its
  // replacement at TAX001 Chicago Sales Tax.
  const items = [makeItem({ type: "replacement" }, { taxes: [] })];
  materializeDocumentTax(items, ctx({ destinations: [at("Frankfort")] }));
  assertEquals(px(items[0]).taxes.map((t) => t.uid), ["chi-sales-tax"]);
});

Deno.test("…and no level reaches it — not the document's own entry, not the claim", () => {
  for (const overrides of [
    { destinations: [at("Chicago", "IL", { jurisdiction: "rantoul" })] },
    { organizationClaim: "rantoul" as const },
  ]) {
    const items = [makeItem({ type: "replacement" }, { taxes: [] })];
    materializeDocumentTax(items, ctx(overrides));
    assertEquals(px(items[0]).taxes.map((t) => t.uid), ["chi-sales-tax"]);
  }
});

Deno.test("…but a NON-replacement line on the same document DOES take the override", () => {
  const items = [makeItem({ type: "sale" }, { taxes: [] })];
  materializeDocumentTax(items, ctx({ organizationClaim: "rantoul" }));
  assertEquals(px(items[0]).taxes.map((t) => t.uid), ["rantoul-tax"]);
});

Deno.test("…and EXEMPTION still applies to a replacement — a different axis", () => {
  // Exemption is a property of the CUSTOMER and zeroes tax whatever the
  // jurisdiction. Xero agrees: every untaxed replacement line in the corpus
  // belongs to a tax-exempt customer.
  const items = [makeItem({ type: "replacement" }, { taxes: [] })];
  materializeDocumentTax(items, ctx({ exempt: true }));
  assertEquals(px(items[0]).taxes, []);
});

Deno.test("🔴 an out-of-state REPLACEMENT is taxed, where the old rule exempted it", () => {
  // The one place the retired `isEntirelyOutOfIllinois` and this rule genuinely
  // disagree. Measured 2026-08-20 at 8 lines corpus-wide, none repriceable,
  // $0.00 either way — which is why it was decided here rather than deferred.
  const items = [makeItem({ type: "replacement" }, { taxes: [] })];
  materializeDocumentTax(items, ctx({ destinations: [at("St. Louis", "MO")] }));
  assertEquals(px(items[0]).taxes.map((t) => t.uid), ["chi-sales-tax"]);
});

// ── The key: `taxed_as ?? type` ──────────────────────────────────

Deno.test("taxed_as overrides the line's own type for tax, and only for tax", () => {
  const items = [makeItem({ type: "sale", taxed_as: "rental" }, { taxes: [] })];
  materializeDocumentTax(items, ctx());
  assertEquals(px(items[0]).taxes.map((t) => t.uid), ["chi-rental-tax"]);
  assertEquals(items[0].type, "sale");
});

Deno.test('taxed_as: "none" is untaxed outright, with no branch of its own', () => {
  // It needs none: no tax lists "none" in `item_types`, so the ordinary lookup
  // answers null. That is the same mechanism that keeps `service` untaxed.
  const items = [makeItem({ type: "rental", taxed_as: "none" })];
  materializeDocumentTax(items, ctx());
  assertEquals(px(items[0]).taxes, []);
});

Deno.test("a type no tax lists is untaxed — service and surcharge, by the rule", () => {
  for (const type of ["service", "surcharge"] as const) {
    const items = [makeItem({ type }, { taxes: [] })];
    materializeDocumentTax(items, ctx());
    assertEquals(px(items[0]).taxes, [], type);
  }
});

// ── 🔴 The revenue ACCOUNT is not a tax determinant ──────────────
//
// Owner, 2026-08-20: *"an item's tax is item type × jurisdiction, it has
// nothing to do with coa, coa is not a determining factor for tax."* The gate
// that stood here is deleted, and these assert the deletion — a removed gate is
// only provably removed by a test that fails if it comes back.

Deno.test("🔴 the revenue COA does not change what a line is taxed", () => {
  // 4700 Transaction Fee is the account the retired gate refused; 4000 is one it
  // allowed; absent is the `custom-`-line shape. One answer, three accounts,
  // under every jurisdiction.
  for (const destinations of [[at("Chicago")], [at("Frankfort")], [at("Rantoul")]]) {
    const answers = ([4000, 4700, undefined] as const).map((coa_revenue) => {
      const items = [makeItem({ coa_revenue })];
      materializeDocumentTax(items, ctx({ destinations }));
      return px(items[0]).taxes.map((t) => t.uid);
    });
    assertEquals(answers[0].length, 1);
    assertEquals(answers[1], answers[0]);
    assertEquals(answers[2], answers[0]);
  }
});

Deno.test("an ABSENT coa_revenue is not a special case any more", () => {
  // It used to be load-bearing: order lines carry no `coa_revenue` at all — it
  // lives on the product — so "unknown means taxable" was what kept the gate
  // from zeroing the tax on the entire order corpus. With no gate, `null` and
  // absent are simply not consulted.
  const noCoa = [makeItem()];
  assertEquals(noCoa[0].coa_revenue ?? null, null);
  materializeDocumentTax(noCoa, ctx());
  assertEquals(px(noCoa[0]).taxes.length, 1);
});

// ── Explicit-only refs ───────────────────────────────────────────

Deno.test("🔴 an explicit-only tax ref on the line SURVIVES the rebuild", () => {
  // `Water Bottle Tax` is the `jurisdiction: null` class — reachable by uid
  // alone and invisible to `findTaxFor` by construction. It rides a line
  // because the PRODUCT carries the ref, so rebuilding from the rule alone
  // would silently drop a real charge.
  const items = [makeItem({}, {
    taxes: [
      { uid: "chi-rental-tax", name: "Chicago Rental Tax", rate: 15, type: "percent", amount_cents: 1500 },
      { uid: "bottle-tax", name: "Water Bottle Tax", rate: 0.05, type: "flat", amount_cents: 5 },
    ],
  })];
  materializeDocumentTax(items, ctx({ destinations: [at("Frankfort")] }));
  assertEquals(px(items[0]).taxes.map((t) => t.uid), ["frankfort-tax", "bottle-tax"]);
});

Deno.test("🔴 a SCOPED explicit-only tax applies only in its own jurisdiction", () => {
  // "5¢ per bottle SOLD IN CHICAGO" — the levy is carried by the product, not
  // found by the rule, so the scope is the only thing that can stop it being
  // charged on a case delivered to Frankfort.
  const scoped: Tax[] = CATALOG.map((t) =>
    t.uid === "bottle-tax" ? { ...t, jurisdiction: "chicago" as const } : t
  );
  const bottleRef = [{
    uid: "bottle-tax",
    name: "Water Bottle Tax",
    rate: 0.05,
    type: "flat" as const,
    amount_cents: 0,
  }];

  const chicago = [makeItem({ type: "sale", quantity: 24 }, { taxes: bottleRef })];
  materializeDocumentTax(chicago, ctx({ taxes: scoped }));
  assertEquals(px(chicago[0]).taxes.map((t) => t.uid), ["chi-sales-tax", "bottle-tax"]);
  // 24 units × $0.05 — a flat tax reads the QUANTITY, never the subtotal.
  assertEquals(px(chicago[0]).taxes[1].amount_cents, 120);

  const frankfort = [makeItem({ type: "sale", quantity: 24 }, { taxes: bottleRef })];
  materializeDocumentTax(frankfort, ctx({ taxes: scoped, destinations: [at("Frankfort")] }));
  assertEquals(
    px(frankfort[0]).taxes.map((t) => t.uid),
    ["frankfort-tax"],
    "Chicago's levy must not follow the case out of Chicago",
  );
});

Deno.test("…and an UNSCOPED explicit-only tax still applies everywhere", () => {
  // `No Tax` and any future unscoped member: `jurisdiction: null` means "no
  // scope", not "no jurisdiction matches".
  const items = [makeItem({ type: "sale", quantity: 10 }, {
    taxes: [{ uid: "bottle-tax", name: "Water Bottle Tax", rate: 0.05, type: "flat", amount_cents: 0 }],
  })];
  materializeDocumentTax(items, ctx({ destinations: [at("Frankfort")] }));
  assertEquals(px(items[0]).taxes.map((t) => t.uid), ["frankfort-tax", "bottle-tax"]);
});

Deno.test("🔴 taxes STACK on one line — a percent and a flat, priced independently", () => {
  // The engine has always summed every ref; what changed is that the rule now
  // AUTHORS more than one. A $100 case of water in Chicago owes 10.5% sales tax
  // on the price AND 5¢ per bottle on the count, and the two are computed from
  // different inputs — `subtotal_discounted_cents` vs `quantity`.
  const scoped: Tax[] = CATALOG.map((t) =>
    t.uid === "bottle-tax" ? { ...t, jurisdiction: "chicago" as const } : t
  );
  // $100/unit × 24 = $2,400 — `materializeDocumentTax` REPRICES, so the
  // subtotal is recomputed from the line rather than taken from the fixture.
  const items = [makeItem({ type: "sale", quantity: 24 }, {
    taxes: [{ uid: "bottle-tax", name: "Water Bottle Tax", rate: 0.05, type: "flat", amount_cents: 0 }],
  })];
  materializeDocumentTax(items, ctx({ taxes: scoped }));
  assertEquals(pxFull(items[0]).subtotal_discounted_cents, 240_000);
  const [sales, bottle] = px(items[0]).taxes;
  assertEquals(sales.uid, "chi-sales-tax");
  assertEquals(sales.amount_cents, 25_200, "10.5% of the $2,400 subtotal");
  assertEquals(bottle.uid, "bottle-tax");
  assertEquals(bottle.amount_cents, 120, "24 bottles × 5¢ — the QUANTITY, not the price");
  assertEquals(px(items[0]).total_cents, 240_000 + 25_200 + 120);
});

Deno.test("…and a ZERO-PRICED line still owes the flat tax", () => {
  // The shape the bottled-water restructure produces: the priced CASE line
  // carries sales tax, its zero-priced BOTTLE child carries the levy. A flat
  // tax reads the quantity, so a $0 line is not a $0 levy.
  const scoped: Tax[] = CATALOG.map((t) =>
    t.uid === "bottle-tax" ? { ...t, jurisdiction: "chicago" as const } : t
  );
  const items = [makeItem({ type: "sale", quantity: 24, zero_priced: true }, {
    base_cents: 0,
    subtotal_cents: 0,
    subtotal_discounted_cents: 0,
    taxes: [{ uid: "bottle-tax", name: "Water Bottle Tax", rate: 0.05, type: "flat", amount_cents: 0 }],
  })];
  materializeDocumentTax(items, ctx({ taxes: scoped }));
  const bottle = px(items[0]).taxes.find((t) => t.uid === "bottle-tax");
  assertEquals(bottle?.amount_cents, 120);
  assertEquals(px(items[0]).total_cents, 120);
});

Deno.test("…and an exempt document drops it too — a tax is a tax", () => {
  const items = [makeItem({}, {
    taxes: [{ uid: "bottle-tax", name: "Water Bottle Tax", rate: 0.05, type: "flat", amount_cents: 5 }],
  })];
  materializeDocumentTax(items, ctx({ exempt: true }));
  assertEquals(px(items[0]).taxes, []);
});

Deno.test("a ref naming a uid the catalog does not hold is DROPPED, not carried", () => {
  // Unlike `resolveTaxRefsAt`, which moves a line between VERSIONS and must not
  // decide taxability. This function IS the taxability decision, and a tax the
  // catalog cannot answer for is not the answer.
  const items = [makeItem({}, {
    taxes: [{ uid: "ghost-tax", name: "Ghost", rate: 5, type: "percent", amount_cents: 500 }],
  })];
  materializeDocumentTax(items, ctx());
  assertEquals(px(items[0]).taxes.map((t) => t.uid), ["chi-rental-tax"]);
});

// ── Reaching the destination ─────────────────────────────────────

Deno.test("destinationsForItems: the join is the divider uid, and pair ORDER is irrelevant", () => {
  const items = [
    { ...makeItem(), uid: "d1", type: "destination", path: ["d1"] },
    { ...makeItem(), uid: "l1", path: ["d1", "l1"] },
    { ...makeItem(), uid: "d2", type: "destination", path: ["d2"] },
    { ...makeItem(), uid: "l2", path: ["d2", "l2"] },
  ] as LineItem[];
  // Stored in the OPPOSITE order to the dividers — the state the deleted
  // divider-index rung got silently wrong.
  const destinations = [
    at("Rantoul", "IL", { uid: "d2", delivery_uid: "dest-rnt" }),
    at("Frankfort", "IL", { uid: "d1", delivery_uid: "dest-frk" }),
  ];
  const resolved = destinationsForItems(items, destinations);
  assertEquals(resolved[1], destinations[1]);
  assertEquals(resolved[3], destinations[0]);
});

Deno.test("destinationsForItems: two sections sharing ONE address stay distinct", () => {
  // `findOrCreateDestination` is a global address-book dedupe, so a
  // repeat-location order legitimately gives two pairs one `delivery.uid`.
  // Under the endpoint join both lines resolved to whichever pair came first,
  // and a per-destination jurisdiction on the second was unreachable.
  const items = [
    { ...makeItem(), uid: "d1", type: "destination", path: ["d1"] },
    { ...makeItem(), uid: "l1", path: ["d1", "l1"] },
    { ...makeItem(), uid: "d2", type: "destination", path: ["d2"] },
    { ...makeItem(), uid: "l2", path: ["d2", "l2"] },
  ] as LineItem[];
  const destinations = [
    at("Chicago", "IL", { uid: "d1", delivery_uid: "shared" }),
    at("Chicago", "IL", { uid: "d2", delivery_uid: "shared", jurisdiction: "frankfort" }),
  ];
  const resolved = destinationsForItems(items, destinations);
  assertEquals(resolved[1], destinations[0]);
  assertEquals(resolved[3], destinations[1]);
  assertEquals(resolved[3]?.jurisdiction, "frankfort");
});

Deno.test("destinationsForItems: a divider naming NO pair does NOT fall back to its index", () => {
  // 🔴 The deleted rung. Two pairs, one divider that matches neither: the
  // ordinal answer would be `destinations[0]` — a real jurisdiction, silently
  // attached to lines nothing says belong to it. `null` (source to the origin)
  // is the honest answer, and Phase 4 refuses the document at write.
  const items = [
    { ...makeItem(), uid: "orphan", type: "destination", path: ["orphan"] },
    { ...makeItem(), uid: "l1", path: ["orphan", "l1"] },
  ] as LineItem[];
  const destinations = [
    at("Frankfort", "IL", { uid: "d1", delivery_uid: "dest-frk" }),
    at("Rantoul", "IL", { uid: "d2", delivery_uid: "dest-rnt" }),
  ];
  assertEquals(destinationsForItems(items, destinations)[1], null);
});

Deno.test("destinationsForItems: a divider-less items array takes the single entry", () => {
  const items = [makeItem({ uid: "l1", path: ["l1"] })];
  const destinations = [at("Rantoul")];
  assertEquals(destinationsForItems(items, destinations)[0], destinations[0]);
});

Deno.test("destinationsForItems: NO destinations resolves null — and sources to the origin", () => {
  // A defined answer, not a failure: 31 prod invoices have no destinations at
  // all, because they have no source order.
  const items = [makeItem({ uid: "l1", path: ["l1"] })];
  assertEquals(destinationsForItems(items, [])[0], null);

  materializeDocumentTax(items, ctx({ destinations: [] }));
  assertEquals(px(items[0]).taxes.map((t) => t.uid), ["chi-rental-tax"]);
});

Deno.test("destinationsForItems: the walk is DEPTH-agnostic — invoices nest one level deeper", () => {
  // An order's hierarchy is [destination, group]; an invoice's is
  // [order, destination, group]. Anything keyed on a depth would find the
  // destination on one document and the ORDER divider on the other.
  const items = [
    { ...makeItem(), uid: "o1", type: "order", path: ["o1"] },
    { ...makeItem(), uid: "d1", type: "destination", path: ["o1", "d1"] },
    { ...makeItem(), uid: "g1", type: "group", path: ["o1", "d1", "g1"] },
    { ...makeItem(), uid: "l1", path: ["o1", "d1", "g1", "l1"] },
  ] as LineItem[];
  const destinations = [at("Frankfort", "IL", { uid: "d1", delivery_uid: "dest-frk" })];
  assertEquals(destinationsForItems(items, destinations)[3], destinations[0]);
});

// ── The three levels, through the rule ───────────────────────────

Deno.test("precedence: the document's entry beats the claim beats the derivation", () => {
  const items = [makeItem({ type: "sale" }, { taxes: [] })];
  materializeDocumentTax(items, ctx({
    destinations: [at("Chicago", "IL", { jurisdiction: "frankfort" })],
    organizationClaim: "rantoul",
  }));
  assertEquals(px(items[0]).taxes.map((t) => t.uid), ["frankfort-tax"]);

  const claimed = [makeItem({ type: "sale" }, { taxes: [] })];
  materializeDocumentTax(claimed, ctx({ organizationClaim: "rantoul" }));
  assertEquals(px(claimed[0]).taxes.map((t) => t.uid), ["rantoul-tax"]);

  const derived = [makeItem({ type: "sale" }, { taxes: [] })];
  materializeDocumentTax(derived, ctx({ destinations: [at("Rantoul")] }));
  assertEquals(px(derived[0]).taxes.map((t) => t.uid), ["rantoul-tax"]);
});

Deno.test("🔴 resolveLineTax: `tax` is exemption-applied, `base` is not", () => {
  // The two fields exist because one of them will be read carelessly. `tax` is
  // the answer a caller wants; `base` is the annotation that lets an exempt
  // document say which tax it was exempt from.
  const item = makeItem();
  const taxed = resolveLineTax(item, at("Chicago"), ctx());
  assertEquals(taxed.tax?.uid, "chi-rental-tax");
  assertEquals(taxed.base?.uid, "chi-rental-tax");

  const exempt = resolveLineTax(item, at("Chicago"), ctx({ exempt: true }));
  assertEquals(exempt.tax, null);
  assertEquals(exempt.base?.uid, "chi-rental-tax", "the base survives exemption");

  // ⚠️ The third case here used to be a non-revenue account — "not taxABLE,
  // which is a different fact from exempt, so both are null". That gate is gone
  // (see the COA block above), and the fact it expressed now travels on
  // `taxed_as`, which IS a tax-rule axis: no tax lists the key `"none"`, so
  // nothing is found and there is nothing to be exempt from.
  const untaxable = resolveLineTax(makeItem({ taxed_as: "none" }), at("Chicago"), ctx());
  assertEquals(untaxable.tax, null);
  assertEquals(untaxable.base, null);
});

Deno.test("resolveLineTax reports the LEVEL that answered, for the order form", () => {
  const item = makeItem({ type: "sale" });
  assertEquals(
    resolveLineTax(item, at("Chicago", "IL", { jurisdiction: "frankfort" }), ctx()).level,
    "document",
  );
  assertEquals(
    resolveLineTax(item, at("Chicago"), ctx({ organizationClaim: "rantoul" })).level,
    "organization",
  );
  assertEquals(resolveLineTax(item, at("Chicago"), ctx()).level, "derived");
  assertEquals(
    resolveLineTax(makeItem({ type: "replacement" }), at("Frankfort"), ctx()).level,
    "origin",
  );
});

// ── The rate VERSION is a separate question ──────────────────────

Deno.test("🔴 a frozen document keeps the rate VERSION it already stores", () => {
  // The rule picks a TAX; `frozenVersions` picks which version of it. A
  // completed order re-priced on a later CRMS event must keep the rate it was
  // billed at — and `applied_from` alone does not give that, because it is set
  // to the CUTOVER, which precedes a future delivery date.
  const versioned: Tax[] = [
    ...CATALOG,
    {
      uid: "chi-rental-tax-old",
      name: "Chicago Rental Tax",
      rate: 11,
      type: "percent",
      jurisdiction: "chicago",
      item_types: ["rental"],
      applied_from: "2025-01-01T00:00:00.000-06:00",
      applied_to: "2026-01-01T00:00:00.000-06:00",
    },
  ];
  const items = [makeItem()];
  materializeDocumentTax(items, ctx({
    taxes: versioned,
    frozenVersions: new Map([["Chicago Rental Tax", "chi-rental-tax-old"]]),
  }));
  assertEquals(px(items[0]).taxes.map((t) => t.uid), ["chi-rental-tax-old"]);
  assertEquals(px(items[0]).taxes[0].rate, 11);
});

Deno.test("…and a frozen NAME the document never carried resolves at asOf", () => {
  // Freezing cannot mean "keep a version that does not exist". This is the
  // jurisdiction-correction case: the rule moves the line to a tax the frozen
  // map has no entry for.
  const items = [makeItem({ type: "sale" }, { taxes: [] })];
  materializeDocumentTax(items, ctx({
    frozenVersions: new Map([["Chicago Rental Tax", "chi-rental-tax"]]),
  }));
  assertEquals(px(items[0]).taxes.map((t) => t.uid), ["chi-sales-tax"]);
});

// ── assign vs materialize ────────────────────────────────────────

Deno.test("assignLineTaxes rewrites the tax WITHOUT repricing the subtotal", () => {
  // The half the CRMS invoice webhook needs: its subtotals are
  // `charge_total`-authoritative, and a reprice would recompute them from
  // `base_cents × quantity × days_factor` and under-bill by 28.6% on a real
  // line (api-cloudrun#236).
  const items = [makeItem({}, { subtotal_discounted_cents: 5000, subtotal_cents: 5000 })];
  assignLineTaxes(items, ctx({ destinations: [at("Frankfort")] }));
  assertEquals(pxFull(items[0]).subtotal_discounted_cents, 5000);
  assertEquals(px(items[0]).taxes[0].amount_cents, 400);
  assertEquals(px(items[0]).total_cents, 5400);
});

Deno.test("materializeDocumentTax REPRICES — the subtotal is recomputed from the line", () => {
  const items = [makeItem({}, { subtotal_discounted_cents: 5000, subtotal_cents: 5000 })];
  materializeDocumentTax(items, ctx());
  assertEquals(pxFull(items[0]).subtotal_discounted_cents, 10000);
  assertEquals(px(items[0]).total_cents, 11500);
});

Deno.test("materialize: preserves every price key it does not compute", () => {
  const items = [makeItem({}, { replacement_cents: 250000, base_percent: null, chargeable_days: 3 })];
  materializeDocumentTax(items, ctx());
  assertEquals(pxFull(items[0]).replacement_cents, 250000);
  assertEquals(pxFull(items[0]).chargeable_days, 3);
});

Deno.test("materialize: never writes an `undefined` price key (Firestore rejects one)", () => {
  const items = [makeItem()];
  materializeDocumentTax(items, ctx());
  for (const [key, value] of Object.entries(pxFull(items[0]))) {
    assertEquals(value === undefined, false, `price.${key} is undefined`);
  }
});

Deno.test("materialize: skips non-priceable items instead of throwing on them", () => {
  const divider = { ...makeItem(), uid: "g1", type: "group", path: ["g1"] } as LineItem;
  const before = JSON.stringify(divider);
  const items = [divider, makeItem()];
  materializeDocumentTax(items, ctx());
  assertEquals(JSON.stringify(items[0]), before);
});

// ── The ORDER-side composition (api-cloudrun#4.10) ───────────────
//
// `materializeOrderTax` and `deriveOrderTaxAsOf` moved here from
// `api-cloudrun/src/lib/orderTaxPricing.ts`, because the manager had written a
// second copy of both in `src/utils/documentTax.ts` — carrying a comment saying
// the two must stay byte-for-byte identical, which is a wish rather than a
// mechanism. These arms are what makes it a mechanism.

/**
 * A destination delivering to `region`, starting `delivery_start`.
 *
 * Distinct from the `dest` above, which carries only an address: these arms
 * need the DATE half too, because the order-side composition reads both.
 */
const orderDest = (region: string | undefined, delivery_start: string | null = null) => ({
  dates: { delivery_start },
  delivery: { address: region === undefined ? null : { region } },
});

const NOW = "2026-07-02T12:00:00.000Z";

Deno.test("deriveOrderTaxAsOf: the EARLIEST delivery start wins", () => {
  // Earliest, not first: an order's destinations are in operator order, and the
  // tax point is the first time anything ships.
  assertEquals(
    deriveOrderTaxAsOf([orderDest("IL", "2026-03-04T09:00:00.000-06:00"), orderDest("IL", "2026-01-05T09:00:00.000-06:00")], NOW),
    "2026-01-05T09:00:00.000-06:00",
  );
});

Deno.test("deriveOrderTaxAsOf: earliest is by INSTANT, not by string order", () => {
  // ⚠️ The form this replaced sorted the ISO TEXT. For canonical Chicago values
  // that is accidentally correct — canonicalization makes the wall clock
  // monotonic with the instant, DST switch included — so the arm above passes
  // either way and proves nothing about the ordering rule.
  //
  // A MIXED set is what separates them, and the manager can hold one: it calls
  // this against an in-memory order where a date picker may supply a raw `Z`
  // value not yet through `toChicagoInstant`. Here `08:00-05:00` is 13:00Z and
  // sorts FIRST as text while being an hour later than `12:00Z`.
  assertEquals(
    deriveOrderTaxAsOf(
      [orderDest("IL", "2026-06-01T08:00:00.000-05:00"), orderDest("IL", "2026-06-01T12:00:00.000Z")],
      NOW,
    ),
    "2026-06-01T12:00:00.000Z",
  );
});

Deno.test("deriveOrderTaxAsOf: canonical Chicago values across a DST switch are unaffected", () => {
  // The companion, and the reason the fix is a correctness tidy rather than an
  // incident: every STORED business datetime is canonical, so no persisted order
  // could have been ordered wrongly. 01:30 CST is 07:30Z; 03:00 CDT is 08:00Z.
  assertEquals(
    deriveOrderTaxAsOf(
      [orderDest("IL", "2026-03-08T03:00:00.000-05:00"), orderDest("IL", "2026-03-08T01:30:00.000-06:00")],
      NOW,
    ),
    "2026-03-08T01:30:00.000-06:00",
  );
});

Deno.test("deriveOrderTaxAsOf: falls back to the INJECTED now, never an ambient clock", () => {
  // The injection is what lets this live in core at all: api-cloudrun passes
  // `Timestamp.now().toDate().toISOString()` and the manager passes
  // `new Date().toISOString()`, both UTC-Z, so the fallback resolves the same
  // Tax doc on either side.
  assertEquals(deriveOrderTaxAsOf([], NOW), NOW);
  assertEquals(deriveOrderTaxAsOf(undefined, NOW), NOW);
  assertEquals(deriveOrderTaxAsOf([orderDest("IL", null), null, undefined], NOW), NOW);
});

// ── TAXABLE_COA_TO_TAX_NAME — the historical oracle ──────────────
//
// ⚠️ Not a rule any WRITER consults. The live default is
// `findTaxFor(catalog, jurisdiction, taxed_as ?? type, asOf)`; this table
// survives for the two restatement tools that reconstruct what a historical
// line carried, where a COA key is the correct oracle. Its type-keyed
// companion (`defaultTaxNameForLine` / `DEFAULT_TAX_NAME_BY_TYPE`) was DELETED
// rather than kept — a second encoding of a rule that already exists.

Deno.test("assertCoaTaxMapCoversCore: the name map covers every taxable COA", () => {
  // Fails CLOSED. A taxable COA with no entry would be silently left untaxed,
  // which is a money defect that looks like a clean run.
  assertCoaTaxMapCoversCore();
});

// ── 🔴 An UNREVIEWED cell prices forward and reports it ──────────
//
// A closed window makes `findTaxFor` return null, and null already means "this
// line is untaxed" — so left alone, an expired Chicago Rental Tax would
// silently zero-rate 70% of all tax CFS has ever collected.
//
// 🔴 An earlier revision fixed that by THROWING, and it was wrong. A document
// resolves the catalog at its own instant, and for an ORDER that instant is the
// earliest DELIVERY START — a date in the future. So a finite `applied_to` was
// not a review deadline, it was a ceiling on forward booking: 1 of 81 live prod
// orders became unwritable the moment one was set (measured 2026-08-23).
//
// The rule is now: price on the most recent version at or before `asOf`, and
// SAY SO. Same money an open-ended window would have produced, plus a signal.
//
// ⚠️ And an unreviewed rate is NOT a known-wrong one (owner): what lapsed is
// the confirmation, not the number. Most renewals change nothing — which is
// precisely why refusing was disproportionate.

/** `CATALOG` with Chicago Rental Tax unreviewed since 2026-06-01, no successor. */
const LAPSED: Tax[] = CATALOG.map((t) =>
  t.uid === "chi-rental-tax" ? { ...t, applied_to: "2026-06-01T00:00:00.000-05:00" } : t
);

Deno.test("🔴 an unreviewed cell PRICES on its most recent version — never at zero", () => {
  const items = [makeItem()];
  const warnings = assignLineTaxes(items, ctx({ taxes: LAPSED }));

  // The money is what the open-ended window would have produced.
  assertEquals(px(items[0]).taxes.map((t) => t.uid), ["chi-rental-tax"]);
  assertEquals(px(items[0]).taxes[0].rate, 15);
  assertEquals(px(items[0]).total_cents, 11500);

  // …and the fact that its review has lapsed travels with it.
  assertEquals(warnings.length, 1);
  assertEquals(warnings[0].jurisdiction, "chicago");
  assertEquals(warnings[0].item_type, "rental");
  assertEquals(warnings[0].tax_name, "Chicago Rental Tax");
  assertEquals(warnings[0].rate, 15);
  assertEquals(warnings[0].expired_at, "2026-06-01T00:00:00.000-05:00");
  assertEquals(warnings[0].as_of, AS_OF);
});

Deno.test("🔴 a healthy catalog reports NOTHING — the empty array is the signal", () => {
  // The half that makes the warning mean something: if this ever returns a
  // warning for a live cell, every document in the corpus reads as stale and
  // the surface stops being read.
  assertEquals(assignLineTaxes([makeItem()], ctx()), []);
  assertEquals(materializeDocumentTax([makeItem()], ctx()), []);
});

Deno.test("materializeDocumentTax passes the warnings straight through", () => {
  const warnings = materializeDocumentTax([makeItem()], ctx({ taxes: LAPSED }));
  assertEquals(warnings.length, 1);
  assertEquals(warnings[0].tax_uid, "chi-rental-tax");
});

Deno.test("🔴 warnings are deduped by CELL, not emitted per line", () => {
  // A 61-product order resolving one unreviewed cell must produce one warning. Per
  // line, the surface would be unreadable on exactly the documents that matter.
  const items = [makeItem(), makeItem(), makeItem(), makeItem()];
  assertEquals(assignLineTaxes(items, ctx({ taxes: LAPSED })).length, 1);
  // …and every line still priced.
  for (const item of items) assertEquals(px(item).taxes[0].rate, 15);
});

Deno.test("🔴 a cell nothing ever taxed prices at zero and warns NOT AT ALL", () => {
  // The distinction the whole design turns on. No tax lists `service`, so there
  // is no closed version to fall forward onto — `taxes: []` is the right answer
  // and a warning here would be a false alarm on every service line in the
  // corpus.
  const items = [makeItem({ type: "service" }, { taxes: [] })];
  assertEquals(assignLineTaxes(items, ctx({ taxes: LAPSED })), []);
  assertEquals(px(items[0]).taxes, []);
  assertEquals(px(items[0]).total_cents, 10000);
});

Deno.test("🔴 an order delivering PAST the expiry still prices — the outage case", () => {
  // The regression that killed the throw. `deriveOrderTaxAsOf` resolves an
  // order at its earliest delivery start, so a 2027 booking asks the catalog
  // about 2027; with Chicago Rental lapsed in 2026 that used to be a 400.
  const items = [makeItem()];
  const warnings = assignLineTaxes(
    items,
    ctx({ taxes: LAPSED, asOf: "2027-03-01T09:00:00.000-06:00" }),
  );
  assertEquals(px(items[0]).taxes[0].rate, 15, "priced, not refused");
  assertEquals(warnings.length, 1);
  assertEquals(warnings[0].as_of, "2027-03-01T09:00:00.000-06:00");
});

Deno.test("🔴 an INTERIOR gap falls back to the version that ran up to it", () => {
  // "Most recent" means most recently CLOSED, not newest document. Reaching
  // forward across a gap would apply a rate that had not taken effect yet.
  const gapped: Tax[] = [
    ...CATALOG.filter((t) => t.uid !== "chi-rental-tax"),
    { ...CATALOG.find((t) => t.uid === "chi-rental-tax")!, uid: "rental-old", rate: 11, applied_from: "2020-01-01T00:00:00.000-06:00", applied_to: "2026-01-01T00:00:00.000-06:00" },
    { ...CATALOG.find((t) => t.uid === "chi-rental-tax")!, uid: "rental-new", rate: 15, applied_from: "2027-01-01T00:00:00.000-06:00", applied_to: null },
  ];
  const items = [makeItem()];
  const warnings = assignLineTaxes(items, ctx({ taxes: gapped }));
  assertEquals(px(items[0]).taxes[0].uid, "rental-old", "the rate in force BEFORE the gap");
  assertEquals(px(items[0]).taxes[0].rate, 11);
  assertEquals(warnings[0].tax_uid, "rental-old");
});

Deno.test("a date BEFORE the first version is untaxed, not unreviewed", () => {
  // Nothing has closed before it, so there is nothing to fall forward from —
  // CFS simply was not collecting yet.
  const items = [makeItem({ type: "sale" }, { taxes: [] })];
  const warnings = assignLineTaxes(
    items,
    ctx({ destinations: [at("Frankfort")], asOf: "2025-06-01T12:00:00.000-05:00" }),
  );
  assertEquals(px(items[0]).taxes, []);
  assertEquals(warnings, []);
});

Deno.test("🔴 a FROZEN document keeps its stored version and warns NOT AT ALL", () => {
  // The freeze outranks the fall-forward: what a completed order already stores
  // beats what the catalog would infer for it, and there is nothing for an
  // operator to act on.
  const items = [makeItem()];
  const warnings = assignLineTaxes(items, ctx({
    taxes: LAPSED,
    frozenVersions: new Map([["Chicago Rental Tax", "chi-rental-tax"]]),
  }));
  assertEquals(px(items[0]).taxes.map((t) => t.uid), ["chi-rental-tax"]);
  assertEquals(warnings, []);
});

Deno.test("an EXEMPT document prices at $0 and still warns", () => {
  // The money is right either way, but `taxes_base` records which tax the
  // customer was exempt FROM — and that annotation comes from a version nobody
  // has re-confirmed. What needs attention is the catalogue, not the document.
  const items = [makeItem()];
  const warnings = assignLineTaxes(items, ctx({ taxes: LAPSED, exempt: true }));
  assertEquals(px(items[0]).taxes, []);
  assertEquals(px(items[0]).taxes_base?.[0].uid, "chi-rental-tax");
  assertEquals(warnings.length, 1);
});

Deno.test("resolveLineTax reports the state, and `expired` now carries a TAX", () => {
  const expired = resolveLineTax(makeItem(), at("Chicago"), ctx({ taxes: LAPSED }));
  assertEquals(expired.state, "expired");
  assertEquals(expired.tax?.uid, "chi-rental-tax", "expired no longer means unpriced");
  assertEquals(expired.key, "rental");

  const taxed = resolveLineTax(makeItem(), at("Chicago"), ctx());
  assertEquals(taxed.state, "taxed");

  const untaxed = resolveLineTax(makeItem({ taxed_as: "none" }), at("Chicago"), ctx({ taxes: LAPSED }));
  assertEquals(untaxed.state, "untaxed");
  assertEquals(untaxed.tax, null);
  assertEquals(untaxed.key, "none", "the key is the OVERRIDE when one is set");
});
