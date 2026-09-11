import { assertEquals } from "@std/assert";
import { WebshopProductSchema } from "../src/schemas/webshop-product.ts";
import { getInitialValues } from "../src/schemas/initial.ts";
import { mockTimestamp } from "./helpers/timestamp.ts";

const base = getInitialValues(WebshopProductSchema);
const validWebshopProduct = {
  ...base,
  uid: "testwp10000000000000",
  name: "Canon C300",
  active: true,
  price: { ...(base.price as Record<string, unknown>), base_cents: 50000, taxes: [{ uid: "testchirentaltax0000", name: "Chicago Rental Tax", rate: 15, type: "percent" }], discountable: true },
  webshop: { available: true, description: "Great camera" },
  created_at: mockTimestamp,
  updated_at: mockTimestamp,
};

Deno.test("WebshopProductSchema validates a complete document", () => {
  assertEquals(WebshopProductSchema.safeParse(validWebshopProduct).success, true);
});

Deno.test("WebshopProductSchema rejects replacement type", () => {
  const doc = { ...validWebshopProduct, type: "replacement" };
  assertEquals(WebshopProductSchema.safeParse(doc).success, false);
});

Deno.test("WebshopProductSchema accepts optional tags", () => {
  const doc = {
    ...validWebshopProduct,
    tags: [{ uid: "testt100000000000000", name: "Camera" }],
    query_by_tags: ["testt100000000000000"],
  };
  assertEquals(WebshopProductSchema.safeParse(doc).success, true);
});

Deno.test("WebshopProductSchema rejects missing required fields", () => {
  assertEquals(WebshopProductSchema.safeParse({ uid: "testwp10000000000000" }).success, false);
});

Deno.test("WebshopProductSchema rejects additional properties", () => {
  const doc = { ...validWebshopProduct, bogus: true };
  assertEquals(WebshopProductSchema.safeParse(doc).success, false);
});

// ── core#89: the webshop price formula is the COMPONENT subset ──────────────
//
// 🔴 **`percent_of_total` is not merely unreachable here, it is uninhabitable.**
// Neither webshop price arm declares `base_percent` at all, so the member named
// a formula whose rate the document is structurally incapable of carrying — and
// a webshop document mirrors a product confined to `WEBSHOP_PRODUCT_TYPES`,
// which excludes the one type (`transaction_fee`) that legitimately prices from
// a document total.
//
// ⚠️ Each case mutates EXACTLY ONE field of the valid fixture above, so it
// cannot degrade into "fails for some reason" — the file's existing
// `rejects replacement type` arm is the shape being mirrored.
//
// Corpus re-measured immediately before this landed (2026-09-07, prod
// `cfs-3100`): 244 webshop-products, **0** with `price.formula ==
// percent_of_total`, **0** with a type in `{replacement, transaction_fee}`, and
// **0** `percent_of_total` across every `components[]`/`component_of[]` entry of
// all 244 (paged to `next_cursor: null`, not sampled). Dev agrees on the
// top-level count.
Deno.test("WebshopProductSchema rejects percent_of_total on the product price", () => {
  const doc = {
    ...validWebshopProduct,
    price: { ...(validWebshopProduct.price as Record<string, unknown>), formula: "percent_of_total" },
  };
  assertEquals(WebshopProductSchema.safeParse(doc).success, false);
});

Deno.test("WebshopProductSchema rejects percent_of_total on a component's price", () => {
  const component = {
    uid: "testwpc00000000000000".slice(0, 20),
    path: [],
    name: "Battery",
    type: "rental",
    quantity: 1,
    price: { base_cents: 0, taxes: [], formula: "percent_of_total", discountable: false },
  };
  const doc = { ...validWebshopProduct, components: [component] };
  assertEquals(WebshopProductSchema.safeParse(doc).success, false);
});

// The fail-closed companion: both rejections above would also pass against a
// schema that rejected EVERY formula, or every component. A member the subset
// keeps has to still be accepted, or the narrowing is indistinguishable from a
// ban.
Deno.test("WebshopProductSchema still accepts a component priced five_day_week", () => {
  const component = {
    uid: "testwpc00000000000000".slice(0, 20),
    path: [],
    name: "Battery",
    type: "rental",
    quantity: 1,
    price: { base_cents: 0, taxes: [], formula: "five_day_week", discountable: false },
  };
  const doc = { ...validWebshopProduct, components: [component] };
  assertEquals(WebshopProductSchema.safeParse(doc).success, true);
});

// ── core#95 batch 9 — the seven WebshopProductSchema paths, asserted directly ──
//
// 🔴 Same reason as `product.test.ts`: `validWebshopProduct` spreads
// `getInitialValues(WebshopProductSchema)`, whose walk is TYPE-derived, so the
// fixture states every key whether the schema asks for it or not and is
// structurally incapable of failing a required-key tightening. The corpus
// reparse and these cases are the gate; the fixture is not.
for (const path of ["alternates", "components", "component_of"] as const) {
  Deno.test(`WebshopProductSchema requires ${path} (core#95 batch 9)`, () => {
    const { [path]: _omit, ...doc } = validWebshopProduct;
    const parsed = WebshopProductSchema.safeParse(doc);
    assertEquals(parsed.success, false);
    if (!parsed.success) {
      assertEquals(parsed.error.issues.map((i) => i.path.join(".")), [path]);
    }
  });
}

Deno.test("WebshopProductSchema requires price.taxes (core#95 batch 9)", () => {
  const { taxes: _omit, ...price } = validWebshopProduct.price as Record<string, unknown>;
  const parsed = WebshopProductSchema.safeParse({ ...validWebshopProduct, price });
  assertEquals(parsed.success, false);
  if (!parsed.success) {
    assertEquals(parsed.error.issues.map((i) => i.path.join(".")), ["price.taxes"]);
  }
});

Deno.test("WebshopProductSchema requires webshop.available (core#95 batch 9)", () => {
  const { available: _omit, ...webshop } = validWebshopProduct.webshop as Record<string, unknown>;
  const parsed = WebshopProductSchema.safeParse({ ...validWebshopProduct, webshop });
  assertEquals(parsed.success, false);
  if (!parsed.success) {
    assertEquals(parsed.error.issues.map((i) => i.path.join(".")), ["webshop.available"]);
  }
});

// ⭐ `components[]` and `component_of[]` are ONE node (`WebshopComponentSchema`)
// reached at two positions, so the requirement is asserted at both — a single
// declaration can still be unreached through one of its embeddings.
for (const arm of ["components", "component_of"] as const) {
  Deno.test(`WebshopProductSchema requires ${arm}[].price.taxes (core#95 batch 9)`, () => {
    const component = {
      uid: "testwpc000000000000a",
      path: [],
      name: "Battery",
      type: "rental",
      quantity: 1,
      price: { base_cents: 0, formula: "fixed", discountable: false },
    };
    const parsed = WebshopProductSchema.safeParse({ ...validWebshopProduct, [arm]: [component] });
    assertEquals(parsed.success, false);
    if (!parsed.success) {
      assertEquals(parsed.error.issues.map((i) => i.path.join(".")), [`${arm}.0.price.taxes`]);
    }
  });
}
