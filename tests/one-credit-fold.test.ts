/**
 * The one credit fold (ruling 84, beta B) — seeded property sweeps, each with a
 * companion asserted to DISAGREE (`cfs-money`'s sweep discipline): an oracle
 * that only ever agrees with the implementation proves nothing.
 *
 * - **AR units**: {@link invoicedByPath} over random orders, invoices and
 *   credit notes ≡ an independent per-path sum (billed − reversed, unfloored).
 *   Companion: the retired per-row clamp (`min(reversed, billed)`) disagrees
 *   exactly on over-credits (R2).
 * - **AP money**: a credit of a substitute root splits its own amount into
 *   stand-in and own shares that sum to it EXACTLY, and each stand-in share
 *   differs from the bill's share of the same units by at most one cent.
 *
 * @module
 */
import { assert, assertEquals } from "@std/assert";
import { buildOrderScopedItems, type InvoiceItem } from "../src/utils/invoices.ts";
import type { LineItem } from "../src/utils/orders.ts";
import { type AccountedCreditNote, type AccountedInvoice, invoicedByPath } from "../src/utils/quantityAccounting.ts";
import { purchaseCreditBilling } from "../src/utils/purchase-documents.ts";
import { lineUnitsCents, statedLine } from "../src/utils/price-formulas.ts";
import { sliceSubstitutedFor } from "../src/utils/substitutions.ts";
import type { PurchaseDocumentRow } from "../src/schemas/mod.ts";
import { FIVE_DAY_WEEK, fdwCounts } from "./helpers/formulas.ts";

/** Seeded LCG — deterministic, never `Math.random()`. */
function lcg(seed: number): () => number {
  let s = seed;
  return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
}
const int = (rand: () => number, n: number) => Math.floor(rand() * n);

const O = "order-1";
const D = "dest-1";
const G = "group-1";

function line(uid: string, quantity: number): LineItem {
  return {
    uid, type: "rental", name: uid, description: "", quantity, path: [D, G, uid],
    stock_method: "reserve", zero_priced: false, uid_tax_class: "TaxC1assDefau1tAAAAA",
    price: {
      price_formula: { uid: FIVE_DAY_WEEK.uid, name: FIVE_DAY_WEEK.name, basis: "time" },
      rates: [{ rate_key: "week", amount_cents: 1000 }],
      counts: fdwCounts(5),
      subtotal_cents: 0, subtotal_discounted_cents: 0, discount: null, taxes: [], total_cents: 0, replacement_cents: 1000,
    },
  } as unknown as LineItem;
}
const DIVIDERS = [
  { uid: D, type: "destination", name: "Venue", description: "", path: [D] },
  { uid: G, type: "group", name: "Grip", description: "", path: [D, G] },
] as unknown as LineItem[];

function invoice(uid: string, lines: LineItem[], status: AccountedInvoice["status"]): AccountedInvoice {
  const divider = { uid: O, type: "order", name: "Order", description: "", path: [O] } as unknown as InvoiceItem;
  return { uid, status, items: [divider, ...(buildOrderScopedItems([...DIVIDERS, ...lines], O) as unknown as InvoiceItem[])] };
}

Deno.test("one credit fold sweep: AR units ≡ billed − reversed per path, unfloored; the retired clamp disagrees on over-credits", () => {
  const rand = lcg(84);
  let cases = 0, overCredited = 0, clampDisagrees = 0, nonReversing = 0;
  for (let draw = 0; draw < 2_000; draw++) {
    const products = Array.from({ length: 1 + int(rand, 3) }, (_, i) => `p${i}`);
    const order = [...DIVIDERS, ...products.map((p) => line(p, 1 + int(rand, 6)))];
    const invoices: AccountedInvoice[] = [];
    const notes: AccountedCreditNote[] = [];
    /** path → per-row [billed, reversed] on live invoices, issued/applied reversing lines only. */
    const rows = new Map<string, Array<[number, number]>>();
    for (let i = 0; i < 1 + int(rand, 3); i++) {
      const status = (["issued", "issued", "draft", "void"] as const)[int(rand, 4)];
      const billed = products.map((p) => [p, int(rand, 7)] as const).filter(([, q]) => q > 0);
      if (billed.length === 0) continue;
      const inv = invoice(`inv${i}`, billed.map(([p, q]) => line(p, q)), status);
      invoices.push(inv);
      const noteStatus = (["issued", "applied", "draft", "void"] as const)[int(rand, 4)];
      const items = billed.map(([p, q]) => {
        const reverses = rand() < 0.8;
        if (!reverses) nonReversing++;
        return { quantity: int(rand, q + 4), path_invoice_item: [O, D, G, p], reverses_billing: reverses };
      });
      notes.push({ uid: `cn${i}`, status: noteStatus, sources: [{ collection: "invoices", uid: inv.uid }], items });
      if (status === "void") continue;
      for (const [j, [p, q]] of billed.entries()) {
        const live = noteStatus === "issued" || noteStatus === "applied";
        const reversed = live && items[j].reverses_billing ? items[j].quantity : 0;
        const k = `${D}/${G}/${p}`;
        rows.set(k, [...(rows.get(k) ?? []), [q, reversed]]);
        if (reversed > q) overCredited++;
      }
    }
    const fold = invoicedByPath(O, order, invoices, notes);
    for (const [k, perRow] of rows) {
      cases++;
      const oracle = perRow.reduce((t, [b, r]) => t + b - r, 0);
      assertEquals(fold.byPath.get(k)?.quantity ?? 0, oracle, `draw ${draw} at ${k}`);
      const clamped = perRow.reduce((t, [b, r]) => t + b - Math.min(r, b), 0);
      if (clamped !== oracle) clampDisagrees++;
    }
    assertEquals(fold.credits_unkeyed, []);
  }
  // The domain was exercised, on every arm.
  assert(cases > 2_000 && overCredited > 0 && nonReversing > 0, JSON.stringify({ cases, overCredited, nonReversing }));
  // Companion: the clamp it replaced disagrees exactly where a row is over-credited.
  assert(clampDisagrees > 0, "the retired clamp must disagree somewhere, or this corpus does not discriminate R2");
  console.log(`AR sweep: ${cases} paths, ${overCredited} over-credited rows, clamp disagreed on ${clampDisagrees}`);
});

Deno.test("one credit fold sweep: AP — a substitute root credit's shares sum to its amount EXACTLY, each within 1¢ of the bill's", () => {
  const rand = lcg(1475);
  const PU = "testpurch10000000000";
  let cases = 0, worst = 0, off = 0;
  for (let draw = 0; draw < 20_000; draw++) {
    const Q = 1 + int(rand, 12); // the bill line Y's units
    const A = int(rand, 500_000); // its amount, cents
    const s = 1 + int(rand, Q); // units standing in for X (the first s)
    const c = int(rand, Q); // units of Y already credited
    const n = 1 + int(rand, Q - c); // this credit's units
    const amount = lineUnitsCents(statedLine(A, Q), c, c + n); // first-come, as billLineCreditMoney prices it
    const slice = sliceSubstitutedFor([{ path: [D, "x"], quantity: s }], c, c + n);
    const row = {
      type: "sale", uid: "y", path: [PU, D, "y"], quantity: n, amount_cents: amount,
      price: { counts: [], stated_cents: amount }, reverses_billing: true, ...(slice.length ? { substituted_for: slice } : {}),
    } as unknown as PurchaseDocumentRow;
    const purchaseItems = [{ type: "sale", path: [D, "x"], quantity: Q }, { type: "sale", path: [D, "y"], quantity: Q }];
    const folded = purchaseCreditBilling([row], PU, purchaseItems);
    const total = [...folded.values()].reduce((t, b) => t + b.amount_cents, 0);
    assertEquals(total, amount, `draw ${draw}: the parts sum to the credit's amount exactly`);
    const e = slice[0]?.quantity ?? 0;
    if (e === 0) continue;
    cases++;
    // The bill's own share of those same units: (c, c + e] of Y's amount.
    const billShare = lineUnitsCents(statedLine(A, Q), c, c + e);
    const diff = Math.abs((folded.get(`${D}/x`)?.amount_cents ?? 0) - billShare);
    worst = Math.max(worst, diff);
    if (diff > 0) off++;
  }
  assert(cases > 5_000, `stand-in cases exercised: ${cases}`);
  assert(worst <= 1, `a stand-in share is at most 1¢ from the bill's (worst ${worst})`);
  console.log(`AP sweep: ${cases} stand-in credits, ${off} a cent off the bill's share, worst ${worst}¢`);
});
