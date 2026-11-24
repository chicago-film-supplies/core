/**
 * The one line-edit module (one-document-model rulings 190–193, 195–197; spec S6
 * and S7, `api-cloudrun/.claude/plans/line-model-spec.md`). Expectations are
 * written out by hand; the two sweeps each carry a companion asserted to FAIL,
 * with a counter per arm (`cfs-money` § The sweep discipline).
 */
import { assert, assertEquals, assertNotEquals } from "@std/assert";
import type { z } from "zod";
import { fdwPrice } from "./helpers/formulas.ts";
import { payableLine } from "./helpers/payable.ts";
import {
  isLineItemType,
  UpdateInvoiceInput,
  UpdateOrderInput,
  UpdatePurchaseBillInput,
  UpdatePurchaseInput,
} from "../src/schemas/mod.ts";
import {
  applyLineEdit,
  diffItems,
  diffLine,
  LINE_EDIT_GRAINS,
  LINE_EDIT_REFUSALS,
  type LineEditContext,
  type LineEditGrain,
  lineEditKeys,
  type LineLike,
} from "../src/utils/line-edit.ts";
import { projectOrderItemToInvoiceItem } from "../src/utils/invoices.ts";
import { projectPurchaseLineToBillLine } from "../src/utils/purchase-documents.ts";
import { partOf } from "../src/utils/price-document.ts";
import { applyDiscountTerms } from "../src/schemas/_line-money.ts";
import type { LineItem } from "../src/utils/orders.ts";
import type { PurchaseItem } from "../src/schemas/mod.ts";

const D = "0b6c3a51-6c1a-4f0e-9a51-6f1f2b9d0a01";
const O = "orderUid00000000000a";
const P = "purchaseUid000000000";
const LIGHT = "prodLight00000000000";

const CTX: LineEditContext = {
  products: new Map([[LIGHT, { account: 4000, uid_tracking_category: "trackcat000000000001" }]]),
  default_account: 4800,
};

/** A receivable order line: a RATE line by default, STATED when `stated` is given. */
function orderLine(over: { quantity?: number; stated?: number; discount?: { rate: number; type: "percent" | "flat"; amount_cents: number } | null } = {}): LineLike {
  const quantity = over.quantity ?? 3;
  const discount = over.discount ?? null;
  const gross = over.stated ?? 1000 * quantity;
  return {
    uid: LIGHT, type: "rental", name: "Light", description: "", quantity, path: [D, LIGHT],
    stock_method: "bulk", zero_priced: false, uid_tax_class: "TaxC1assDefau1tAAAAA",
    coa_revenue: 4000, uid_tracking_category: null, crms_id: null,
    price: {
      ...fdwPrice(1000, 5),
      base_percent: null,
      replacement_cents: 1000,
      ...(over.stated !== undefined ? { stated_cents: over.stated } : {}),
      subtotal_cents: gross,
      subtotal_discounted_cents: gross - (discount?.amount_cents ?? 0),
      discount,
      taxes: [],
      taxes_base: [],
      total_cents: gross - (discount?.amount_cents ?? 0),
    },
  };
}
const invoiceLine = (over: Parameters<typeof orderLine>[0] = {}): LineLike =>
  projectOrderItemToInvoiceItem(orderLine(over) as unknown as LineItem, O) as unknown as LineLike;
const purchaseLine = (over: Record<string, unknown> = {}): LineLike =>
  payableLine("sale", { amount_cents: 3000, quantity: 3, ...over } as never) as unknown as LineLike;
const billLine = (): LineLike =>
  projectPurchaseLineToBillLine(purchaseLine() as unknown as PurchaseItem, { uid_purchase: P, quantity: 3, from: 0 }) as unknown as LineLike;

/** The update input's `items` element for a grain — what an echo is parsed through. */
function inputElement(grain: LineEditGrain): z.ZodType {
  const root = { order: UpdateOrderInput, invoice: UpdateInvoiceInput, purchase: UpdatePurchaseInput, bill: UpdatePurchaseBillInput }[grain];
  // deno-lint-ignore no-explicit-any
  const unwrap = (n: any): any => {
    while (n && !n._zod.def.shape && n._zod.def.type !== "array") n = n._zod.def.innerType ?? n._zod.def.in ?? n._zod.def.schema;
    return n;
  };
  const items = unwrap(unwrap(root)._zod.def.shape.items);
  return items._zod.def.element;
}
/** A stored row as a client echoes it: parsed through its grain's input, unknown keys stripped. */
const echo = (grain: LineEditGrain, row: LineLike) => inputElement(grain).parse(row) as LineLike;

// ── The key sets (C10, ruling 197) ─────────────────────────────────

Deno.test("lineEditKeys: read off the schemas, per input ARM — input keys in, derived money and identity out, units_from server-owned", () => {
  for (const grain of LINE_EDIT_GRAINS) {
    const { compared, serverOwned } = lineEditKeys(grain);
    const arms = Object.keys(compared);
    assert(arms.includes("rental") && arms.includes("sale"), `${grain}: the arm walk reached ${arms}`);
    for (const [type, keys] of Object.entries(compared).filter(([t]) => isLineItemType(t as never))) {
      assert(keys.length > 8, `${grain}/${type}: the input walk reached ${keys.length} keys`);
      for (const k of ["quantity", "type", "price.stated_cents", "price.discount.rate", "price.rates", "uid_tracking_category"]) {
        assert(keys.includes(k), `${grain}/${type} compares ${k}`);
      }
      for (const k of ["price.subtotal_cents", "price.total_cents", "price.taxes", "price.counts", "price.discount.amount_cents", "uid", "path"]) {
        assert(!keys.includes(k), `${grain}/${type} must not compare ${k}`);
      }
    }
    assertEquals(serverOwned, ["units_from"], `${grain}: the server-owned keys`);
  }
  assert(lineEditKeys("order").compared.rental.includes("coa_revenue"));
  assert(lineEditKeys("bill").compared.sale.includes("ledger_account"));
  // Per arm, and that is load-bearing: a Buy line's input takes no `name` (the
  // writer derives it), a service line's does.
  assert(!lineEditKeys("purchase").compared.sale.includes("name"));
  assert(lineEditKeys("purchase").compared.service.includes("name"));
});

// ── The echo invariant (S7, ruling 193) ────────────────────────────

const ECHO_ROWS: Record<LineEditGrain, () => LineLike[]> = {
  order: () => [
    orderLine(),
    orderLine({ stated: 2500, discount: { rate: 10, type: "percent", amount_cents: 250 } }),
    { ...orderLine(), uid_tax_class_override: "TaxC1assOverr1deAAAA" },
  ],
  invoice: () => [
    invoiceLine(),
    { ...invoiceLine({ stated: 2500, discount: { rate: 10, type: "percent", amount_cents: 250 } }), units_from: 1 },
  ],
  purchase: () => [purchaseLine(), purchaseLine({ uid_tax_class_override: null })],
  bill: () => [billLine()],
};

Deno.test("echo: sending a stored row straight back changes nothing and refuses nothing, every grain and kind (ruling 193)", () => {
  let stripped = 0;
  for (const grain of LINE_EDIT_GRAINS) {
    for (const stored of ECHO_ROWS[grain]()) {
      const echoed = echo(grain, stored);
      if (JSON.stringify(echoed) !== JSON.stringify(stored)) stripped++;
      assertEquals(diffLine(grain, stored, echoed).fields, [], `${grain}: an echo is no change`);
      const applied = applyLineEdit(grain, stored, diffLine(grain, stored, echoed), CTX);
      assert(applied.ok && applied.line === stored, `${grain}: an empty change returns the stored row itself`);
    }
  }
  // Non-vacuity: the echo really is a different object shape (the input strips
  // keys a client may not send), so "no change" is a comparison, not identity.
  assert(stripped > 0, "every echo was byte-identical: the property would pass without diffLine");
});

Deno.test("echo companion: the same rows with ONE real edit are a change — the property can fail", () => {
  for (const grain of LINE_EDIT_GRAINS) {
    for (const stored of ECHO_ROWS[grain]()) {
      const edited = { ...echo(grain, stored), quantity: (stored.quantity as number) + 1 };
      assertEquals(diffLine(grain, stored, edited).fields.map((f) => f.key), ["quantity"], grain);
    }
  }
  // And derived money a client sends (its optimistic recompute) is not one.
  const stored = orderLine();
  const optimistic = { ...stored, price: { ...(stored.price as object), subtotal_cents: 1, total_cents: 1, taxes: [{ uid: "x" }] } };
  assertEquals(diffLine("order", stored, optimistic).fields, []);
});

// ── applyLineEdit ──────────────────────────────────────────────────

/** Apply `submitted` over `stored` for `grain`, asserting it is accepted. */
function edit(grain: LineEditGrain, stored: LineLike, submitted: LineLike): LineLike {
  const r = applyLineEdit(grain, stored, diffLine(grain, stored, submitted), CTX);
  assert(r.ok, JSON.stringify(!r.ok && r.refusals));
  return r.line;
}
const priceOf = (row: LineLike) => row.price as Record<string, unknown> & { discount: { amount_cents: number } | null };

Deno.test("applyLineEdit: a STATED line's quantity edit keeps its total and restates its cents (D7), both sides", () => {
  const stored = orderLine({ stated: 1000, discount: { rate: 10, type: "percent", amount_cents: 100 } });
  const out = edit("order", stored, { ...echo("order", stored), quantity: 4 });
  assertEquals(priceOf(out).stated_cents, 1000, "stated means stated");
  assertEquals(priceOf(out).discount?.amount_cents, 100);
  // A flat discount is per unit, so its cents move with the quantity: $1 × 4.
  const flat = orderLine({ stated: 1000, discount: { rate: 1, type: "flat", amount_cents: 300 } });
  assertEquals(priceOf(edit("order", flat, { ...echo("order", flat), quantity: 4 })).discount?.amount_cents, 400);
  // Payable: the net is written back as amount_cents.
  const bought = purchaseLine();
  const bigger = edit("purchase", bought, { ...echo("purchase", bought), quantity: 5 });
  assertEquals(priceOf(bigger).stated_cents, 3000);
  assertEquals(bigger.amount_cents, 3000);
});

Deno.test("applyLineEdit: the kind switches — stating a total on a rate line, and clearing it back to its rates", () => {
  const rate = orderLine({ discount: { rate: 10, type: "percent", amount_cents: 300 } });
  const stated = edit("order", rate, { ...echo("order", rate), price: { ...priceOf(echo("order", rate)), stated_cents: 2000 } });
  assertEquals(priceOf(stated).stated_cents, 2000);
  assertEquals(priceOf(stated).discount?.amount_cents, 200, "the switch is a rate event on the new gross");
  const back = edit("order", stated, { ...echo("order", stated), price: { ...priceOf(echo("order", stated)), stated_cents: null } });
  assertEquals("stated_cents" in priceOf(back), false, "a rate line carries no gross key");
  assertEquals(priceOf(back).discount?.amount_cents, 300, "the formula's money: 3 × $10.00 at 10%");
});

Deno.test("applyLineEdit: refusals land on the row's field (rulings 195, 197; the uncounted row; no money input)", () => {
  const codes = (grain: LineEditGrain, stored: LineLike, submitted: LineLike) => {
    const r = applyLineEdit(grain, stored, diffLine(grain, stored, submitted), CTX);
    return r.ok ? [] : r.refusals.map((x) => `${x.code} ${x.path.join(".")}`);
  };
  // 195: a discount larger than the gross, on a stated line and on a rate line.
  const stated = orderLine({ stated: 1000 });
  assertEquals(codes("order", stated, { ...echo("order", stated), price: { ...priceOf(echo("order", stated)), discount: { rate: 5, type: "flat" } } }), [
    "discount_exceeds_gross price.discount.rate",
  ]);
  const rate = orderLine();
  assertEquals(codes("order", rate, { ...echo("order", rate), price: { ...priceOf(echo("order", rate)), discount: { rate: 50, type: "flat" } } }), [
    "discount_exceeds_gross price.discount.rate",
  ]);
  // 197: a server-owned key.
  const part = { ...invoiceLine(), units_from: 1 };
  assertEquals(codes("invoice", part, { ...echo("invoice", part), units_from: 2 }), ["server_owned units_from"]);
  // An uncounted payable kit header takes no account and no money.
  const header = purchaseLine({ ledger_account: null });
  assertEquals(codes("purchase", header, { ...echo("purchase", header), ledger_account: 1999 }), ["uncounted_row ledger_account"]);
  // A flat line cleared of its gross with no rates has no money input.
  const bought = purchaseLine();
  assertEquals(codes("purchase", bought, { ...echo("purchase", bought), price: { ...priceOf(echo("purchase", bought)), stated_cents: null } }), [
    "no_money_input price.stated_cents",
  ]);
  // The vocabulary is closed and every code above is in it.
  assertEquals([...LINE_EDIT_REFUSALS].sort(), ["discount_exceeds_gross", "no_money_input", "server_owned", "uncounted_row"]);
});

Deno.test("applyLineEdit: a cleared account resets to the product's, or the side's default without a product (ruling 196)", () => {
  const stored = { ...orderLine(), coa_revenue: 4140 };
  assertEquals(edit("order", stored, { ...echo("order", stored), coa_revenue: null }).coa_revenue, 4000);
  const custom = { ...orderLine(), uid: "custom-0b9e2f4a-0000-4000-8000-000000000009", coa_revenue: 4140 };
  assertEquals(edit("order", custom, { ...echo("order", custom), coa_revenue: null }).coa_revenue, 4800);
  const tracked = { ...orderLine(), uid_tracking_category: "trackcat000000000002" };
  assertEquals(edit("order", tracked, { ...echo("order", tracked), uid_tracking_category: null }).uid_tracking_category, "trackcat000000000001");
  // The bill's old "posts to an account, so it cannot clear one" refusal is gone.
  const bought = purchaseLine();
  assertEquals(edit("purchase", bought, { ...echo("purchase", bought), ledger_account: null }).ledger_account, 4800);
});

// ── diffItems (ruling 192) ─────────────────────────────────────────

Deno.test("diffItems: pairs through pairItemsAcrossRebuild — a line under a renamed group still pairs; adds and removals reported", () => {
  const G1 = "0b6c3a51-6c1a-4f0e-9a51-6f1f2b9d0a02";
  const G2 = "0b6c3a51-6c1a-4f0e-9a51-6f1f2b9d0a03";
  const row = (uid: string, path: string[]) => ({ ...orderLine(), uid, path }) as LineLike & { uid: string; path: string[]; type: string };
  const div = (uid: string, path: string[], type: string) => ({ uid, path, type, name: uid }) as LineLike & { uid: string; path: string[]; type: string };
  const stored = [div(D, [D], "destination"), div(G1, [D, G1], "group"), row(LIGHT, [D, G1, LIGHT]), row("prodGone000000000000", [D, G1, "prodGone000000000000"])];
  const submitted = [div(D, [D], "destination"), div(G2, [D, G2], "group"), { ...row(LIGHT, [D, G2, LIGHT]), quantity: 9 }, row("prodNew0000000000000", [D, G2, "prodNew0000000000000"])];
  const out = diffItems("order", stored, submitted);
  assertEquals(out.paired.map((p) => [p.stored.path.join("/"), p.change.fields.map((f) => f.key)]), [[`${D}/${G1}/${LIGHT}`, ["quantity"]]]);
  assertEquals(out.added.map((r) => r.uid), ["prodNew0000000000000"]);
  assertEquals(out.removed.map((r) => r.uid), ["prodGone000000000000"]);
});

// ── The property sweeps (step 1's proof) ───────────────────────────

/** A small deterministic PRNG, so a failure reproduces. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

Deno.test("sweep: parts cut by partOf sum EXACTLY to the line, both kinds × both sides' row shapes — and per-part rounding does not", () => {
  const r = rng(189);
  const wrong = { stated: 0, rate: 0 };
  const exercised = { stated: 0, rate: 0, receivable: 0, payable: 0 };
  for (let i = 0; i < 20_000; i++) {
    const q = 2 + Math.floor(r() * 10);
    const kind = r() < 0.5 ? "stated" as const : "rate" as const;
    const side = r() < 0.5 ? "receivable" as const : "payable" as const;
    const terms = r() < 0.7 ? { type: "percent" as const, rate: Math.round(r() * 3000) / 100 } : null;
    const gross = 1 + Math.floor(r() * 500_000);
    const rate = 1 + Math.floor(r() * 50_000);
    const priceBase = kind === "stated"
      ? { rates: [], counts: [], stated_cents: gross, discount: terms && applyDiscountTerms(gross, q, terms).discount }
      : { rates: [{ rate_key: "day", amount_cents: rate }], counts: [{ rate_key: "day", num: 1 + Math.floor(r() * 9), den: 1 + Math.floor(r() * 5) }], discount: terms && { ...terms, amount_cents: 0 } };
    const line = { quantity: q, ...(side === "payable" ? { amount_cents: 0 } : {}), price: priceBase };
    exercised[kind]++;
    exercised[side]++;
    const whole = partOf(line as never, 0, q);
    let gross_ = 0, cents = 0, net = 0, naive = 0;
    let at = 0;
    while (at < q) {
      const next = Math.min(q, at + 1 + Math.floor(r() * 3));
      const part = partOf(line as never, at, next);
      gross_ += part.stated_cents;
      cents += part.discount?.amount_cents ?? 0;
      net += part.amount_cents;
      // The wrong form: each part priced on its own, from 0, rounded on its own.
      naive += partOf(line as never, 0, next - at).amount_cents;
      at = next;
    }
    assertEquals([gross_, cents, net], [whole.stated_cents, whole.discount?.amount_cents ?? 0, whole.amount_cents]);
    if (naive !== whole.amount_cents) wrong[kind]++;
  }
  // Every arm reached, and the companion bites on EACH kind (reported per arm).
  for (const [arm, n] of Object.entries(exercised)) assert(n > 4000, `arm ${arm} exercised only ${n} times`);
  assert(wrong.stated > 0, "per-part rounding never disagreed on a STATED line: the corpus does not discriminate");
  assert(wrong.rate > 0, "per-part rounding never disagreed on a RATE line: the corpus does not discriminate");
});

Deno.test("sweep: a STATED line's quantity edit keeps its total, both sides — and re-deriving from a per-unit price does not", () => {
  const r = rng(1890);
  let wrong = 0;
  for (let i = 0; i < 5_000; i++) {
    const q = 1 + Math.floor(r() * 12);
    const q2 = 1 + Math.floor(r() * 12);
    const gross = 1 + Math.floor(r() * 200_000);
    const terms = r() < 0.5 ? { type: "percent" as const, rate: Math.round(r() * 3000) / 100 } : null;
    const grain: LineEditGrain = r() < 0.5 ? "order" : "purchase";
    const discount = terms && applyDiscountTerms(gross, q, terms).discount;
    const stored = grain === "order"
      ? orderLine({ quantity: q, stated: gross, discount })
      : purchaseLine({ quantity: q, amount_cents: gross - (discount?.amount_cents ?? 0), price: { ...priceOf(purchaseLine()), stated_cents: gross, discount } });
    const out = edit(grain, stored, { ...echo(grain, stored), quantity: q2 });
    assertEquals(priceOf(out).stated_cents, gross, "stated means stated");
    const expected = applyDiscountTerms(gross, q2, terms);
    assertEquals(priceOf(out).discount?.amount_cents ?? 0, expected.discount?.amount_cents ?? 0);
    if (grain === "purchase") assertEquals(out.amount_cents, expected.amount_cents);
    // The wrong form: the total re-derived from a per-unit price at the new count.
    if (q2 !== q && Math.round((gross * q2) / q) !== gross) wrong++;
  }
  assert(wrong > 0, "the per-unit re-derivation never disagreed: the corpus does not discriminate");
});

Deno.test("partOf reads a stated line's STORED cents, not a re-applied rate (D7) — a companion to the sweep above", () => {
  // 10% of $10.00 is 100¢, but the line stores 101¢: the parts slice 101.
  const line = { quantity: 3, price: { rates: [], counts: [], stated_cents: 1000, discount: { rate: 10, type: "percent" as const, amount_cents: 101 } } };
  assertEquals([0, 1, 2].map((k) => partOf(line as never, k, k + 1).discount?.amount_cents).reduce((a, b) => a! + b!, 0), 101);
  assertNotEquals(applyDiscountTerms(1000, 3, { rate: 10, type: "percent" }).discount?.amount_cents, 101);
});
