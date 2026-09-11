import { assertEquals } from "@std/assert";
import { AuthoredComponentSchema, ComponentSchema, CreateProductInput, deriveProductImageUuids, ProductSchema, UpdateProductInput } from "../src/schemas/product.ts";
import { getInitialValues } from "../src/schemas/initial.ts";
import { mockTimestamp } from "./helpers/timestamp.ts";

// `uid_thread` is a branded `ThreadId`, and the schema walk seeds every string
// leaf as `""` — which `ThreadId` correctly rejects. An optional branded id has
// no meaningful zero value, so the fixture supplies a real one, as every prod
// doc does (2,970/2,970 carry a conforming id).
const base = { ...getInitialValues(ProductSchema), uid_thread: "testthread0000000001" };
const actor = { uid: "testuser100000000000", name: "Test User" };
const validProduct = {
  ...base,
  uid: "testproduct100000000",
  name: "Canon C300",
  active: true,
  crms_id: 100,
  price: { ...base.price, base_cents: 50000, replacement_cents: 500000, taxes: [{ uid: "testchirentaltax0000", name: "Chicago Rental Tax", rate: 15, type: "percent" }], discountable: true },
  tags: [{ uid: "testt100000000000000", name: "Camera" }],
  webshop: { available: true },
  created_by: actor,
  updated_by: actor,
  created_at: mockTimestamp,
  updated_at: mockTimestamp,
};

Deno.test("ProductSchema validates a complete document", () => {
  assertEquals(ProductSchema.safeParse(validProduct).success, true);
});

Deno.test("ProductSchema validates with shipping", () => {
  const doc = {
    ...validProduct,
    shipping: {
      weight: 5,
      height: 10,
      width: 15,
      length: 20,
      air_hazardous: false,
      air_un: null,
    },
  };
  assertEquals(ProductSchema.safeParse(doc).success, true);
});

Deno.test("shipping dimensions: `null` is 'not measured yet', distinct from 0 (core#51)", () => {
  const unmeasured = {
    ...validProduct,
    shipping: { weight: null, height: null, width: null, length: null, air_hazardous: false, air_un: null },
  };
  assertEquals(ProductSchema.safeParse(unmeasured).success, true);

  // Partially measured — weighed but not sized — is the case a block-level
  // `measured_at` could not have expressed, and is why the four are per-field.
  const partial = {
    ...validProduct,
    shipping: { weight: 5, height: null, width: null, length: null, air_hazardous: false, air_un: null },
  };
  assertEquals(ProductSchema.safeParse(partial).success, true);

  // 0 remains legal and now means exactly one thing: measured, and it is zero.
  const measuredZero = {
    ...validProduct,
    shipping: { weight: 0, height: 0, width: 0, length: 0, air_hazardous: false, air_un: null },
  };
  assertEquals(ProductSchema.safeParse(measuredZero).success, true);

  // The INPUT boundary accepts null too — without this the schema change buys
  // nothing going forward, because a client with no measurement has no way to
  // say so and `Number("")` is 0.
  const inputUnmeasured = {
    ...validCreateInput,
    shipping: { weight: null, height: null, width: null, length: null, air_hazardous: false, air_un: null },
  };
  assertEquals(CreateProductInput.safeParse(inputUnmeasured).success, true);
});

Deno.test("ProductSchema validates with components", () => {
  const doc = {
    ...validProduct,
    components: [
      {
        uid: "testcomp100000000000",
        path: ["testproduct100000000"],
        name: "Battery",
        type: "rental",
        inclusion_type: "default",
        zero_priced: false,
        price_overridden: [],
        stock_method: "bulk",
        crms_id: 200,
        quantity: 2,
        price: {
          base_cents: 0,
          replacement_cents: 10000,
          taxes: [{ uid: "testtaxnone000000000", name: "No Tax", rate: 0, type: "percent" }],
          formula: "fixed",
          discountable: false,
        },
      },
    ],
  };
  assertEquals(ProductSchema.safeParse(doc).success, true);
});

Deno.test("ProductSchema rejects rental without price.replacement_cents", () => {
  const doc = {
    ...validProduct,
    price: { ...(validProduct.price as Record<string, unknown>), replacement_cents: undefined },
  };
  assertEquals(ProductSchema.safeParse(doc).success, false);
});

Deno.test("ProductSchema accepts rental with stock_method none and no price.replacement_cents", () => {
  const doc = {
    ...validProduct,
    stock_method: "none",
    price: { ...(validProduct.price as Record<string, unknown>), replacement_cents: undefined },
  };
  assertEquals(ProductSchema.safeParse(doc).success, true);
});

Deno.test("ProductSchema rejects rental component without price.replacement_cents", () => {
  const doc = {
    ...validProduct,
    components: [
      {
        uid: "testcomp100000000000",
        path: ["testproduct100000000"],
        name: "Battery",
        type: "rental",
        inclusion_type: "default",
        zero_priced: false,
        price_overridden: [],
        stock_method: "bulk",
        crms_id: 200,
        quantity: 2,
        price: { base_cents: 0, taxes: [], formula: "fixed", discountable: false },
      },
    ],
  };
  assertEquals(ProductSchema.safeParse(doc).success, false);
});

Deno.test("ProductSchema accepts rental component with stock_method none and no price.replacement_cents", () => {
  const doc = {
    ...validProduct,
    components: [
      {
        uid: "testcomp100000000000",
        path: ["testproduct100000000"],
        name: "Service Fee",
        type: "rental",
        inclusion_type: "default",
        zero_priced: false,
        price_overridden: [],
        stock_method: "none",
        crms_id: 200,
        quantity: 1,
        price: { base_cents: 0, taxes: [], formula: "fixed", discountable: false },
      },
    ],
  };
  assertEquals(ProductSchema.safeParse(doc).success, true);
});

Deno.test("ProductSchema rejects invalid type", () => {
  const doc = { ...validProduct, type: "invalid" };
  assertEquals(ProductSchema.safeParse(doc).success, false);
});

Deno.test("ProductSchema rejects invalid stock_method", () => {
  const doc = { ...validProduct, stock_method: "invalid" };
  assertEquals(ProductSchema.safeParse(doc).success, false);
});

Deno.test("ProductSchema rejects missing required fields", () => {
  assertEquals(ProductSchema.safeParse({ uid: "testproduct100000000", name: "Test" }).success, false);
});

Deno.test("ProductSchema rejects additional properties", () => {
  const doc = { ...validProduct, bogus: true };
  assertEquals(ProductSchema.safeParse(doc).success, false);
});

Deno.test("ProductSchema uid_thread is a ThreadId, not a bare string", () => {
  // The field was `defaultThreadId: z.string().optional()` — any string at all,
  // including "". It is now `ThreadId`, the same validator `cards`/`comments`
  // already used, which admits a Firestore auto-id or an EventCardId composite.
  // Probed before tightening: 2,970/2,970 prod docs and 3,011/3,011 dev docs
  // across all eight carriers already conform, so this rejects nothing stored.
  const accepts = (v: unknown) => ProductSchema.safeParse({ ...validProduct, uid_thread: v }).success;

  assertEquals(accepts("testthread0000000001"), true); // Firestore auto-id
  assertEquals(accepts("testorder00000000001:testdest000000000001:start"), true); // EventCardId

  assertEquals(accepts(""), false); // the walk's zero value — the reason fixtures override it
  assertEquals(accepts("too-short"), false);
  assertEquals(accepts("testthread0000000001:bogus"), false); // half a composite
  assertEquals(accepts(42), false);

  // Still optional — absence is legal and is what makes the corpus audit the
  // only forward enforcement (see propagation/threads.ts).
  const { uid_thread: _omitted, ...withoutThread } = validProduct;
  assertEquals(ProductSchema.safeParse(withoutThread).success, true);
});

const validCreateInput = {
  uid: "testproduct100000000",
  name: "Canon C300",
  active: true,
  type: "rental" as const,
  stock_method: "serialized" as const,
  component_only: false,
  description: "",
  eligible_delivery: true,
  eligible_in_store_pickup: true,
  eligible_shipping_ground: false,
  eligible_shipping_air: false,
  price: {
    base_cents: 50000,
    replacement_cents: 500000,
    // Required on the create input as of Wave 5b — `4000` is what rentals
    // actually carry in prod. Stated in the shared fixture so the negative
    // cases below still fail for the reason each one names.
    coa_revenue: 4000 as const,
    taxes: [],
    formula: "five_day_week" as const,
    discountable: true,
  },
  webshop: { available: false },
};

Deno.test("CreateProductInput requires price.replacement_cents for rental products", () => {
  const input = { ...validCreateInput, price: { ...validCreateInput.price, replacement_cents: undefined } };
  assertEquals(CreateProductInput.safeParse(input).success, false);
  assertEquals(CreateProductInput.safeParse(validCreateInput).success, true);
  assertEquals(CreateProductInput.safeParse({ ...input, type: "sale" }).success, true);
  assertEquals(CreateProductInput.safeParse({ ...input, stock_method: "none" }).success, true);
});

Deno.test("CreateProductInput requires price.replacement_cents for rental components", () => {
  const rentalComponent = {
    uid: "testcomp100000000000",
    path: ["testproduct100000000"],
    name: "Battery",
    type: "rental" as const,
    inclusion_type: "default" as const,
    zero_priced: false,
    stock_method: "bulk" as const,
    crms_id: 200,
    quantity: 2,
    price: {
      base_cents: 0,
      taxes: [],
      formula: "fixed" as const,
      discountable: false,
    },
  };
  assertEquals(CreateProductInput.safeParse({ ...validCreateInput, components: [rentalComponent] }).success, false);
  assertEquals(
    CreateProductInput.safeParse({
      ...validCreateInput,
      components: [{ ...rentalComponent, price: { ...rentalComponent.price, replacement_cents: 10000 } }],
    }).success,
    true,
  );
  assertEquals(
    CreateProductInput.safeParse({ ...validCreateInput, components: [{ ...rentalComponent, type: "sale" }] }).success,
    true,
  );
  assertEquals(
    CreateProductInput.safeParse({ ...validCreateInput, component_of: [rentalComponent] }).success,
    false,
  );
  assertEquals(
    CreateProductInput.safeParse({
      ...validCreateInput,
      components: [{ ...rentalComponent, stock_method: "none" }],
    }).success,
    true,
  );
});

Deno.test("ProductSchema xero_code: optional, nullable, non-empty", () => {
  // Back-compat: existing docs have no xero_code at all.
  assertEquals(ProductSchema.safeParse(validProduct).success, true);
  // Explicit null (product never pushed to Xero).
  assertEquals(ProductSchema.safeParse({ ...validProduct, xero_code: null }).success, true);
  // A real Xero Item Code — strings, not numbers (e.g. "406 - A", "312-Archived").
  const parsed = ProductSchema.safeParse({ ...validProduct, xero_code: "406 - A" });
  assertEquals(parsed.success, true);
  if (parsed.success) assertEquals(parsed.data.xero_code, "406 - A");
  // Empty string is meaningless — reject rather than silently emit an empty ItemCode.
  assertEquals(ProductSchema.safeParse({ ...validProduct, xero_code: "" }).success, false);
  // Codes are strings; a number is a type error, not a coercion.
  assertEquals(ProductSchema.safeParse({ ...validProduct, xero_code: 406 }).success, false);
});

// ── images[] + the query_by_images denormalization invariant ─────────

const IMG_A = "11111111-1111-4111-8111-111111111111";
const IMG_A_CUT = "aaaaaaaa-1111-4111-8111-111111111111";
const IMG_B = "22222222-2222-4222-8222-222222222222";

const imageRow = (uuid: string, uuid_cutout: string | null = null) => ({
  uuid,
  uuid_cutout,
  alt: null,
  width: null,
  height: null,
});

Deno.test("ProductSchema images: back-compat — neither field is required", () => {
  // The ~531 existing product docs carry no images at all.
  assertEquals(ProductSchema.safeParse(validProduct).success, true);
});

Deno.test("ProductSchema images: an image row requires every field, nullable but present", () => {
  const withImages = {
    ...validProduct,
    images: [imageRow(IMG_A)],
    query_by_images: [IMG_A],
  };
  assertEquals(ProductSchema.safeParse(withImages).success, true);

  // `validateBeforeWrite` writes the RAW doc, so a schema `.default()` never
  // materializes — an omitted field would persist as absent. Reject it here.
  for (const drop of ["uuid_cutout", "alt", "width", "height"]) {
    const row: Record<string, unknown> = { ...imageRow(IMG_A) };
    delete row[drop];
    assertEquals(
      ProductSchema.safeParse({ ...withImages, images: [row] }).success,
      false,
      `omitting images[].${drop} must be rejected`,
    );
  }
});

Deno.test("ProductSchema query_by_images: must be exactly the derived set", () => {
  const images = [imageRow(IMG_A, IMG_A_CUT), imageRow(IMG_B)];
  // walks `images` in order: each row's uuid, then its cutout when set
  const derived = [IMG_A, IMG_A_CUT, IMG_B];

  assertEquals(
    ProductSchema.safeParse({ ...validProduct, images, query_by_images: derived }).success,
    true,
  );

  // The case the invariant exists for: a bg-remove write that sets uuid_cutout
  // and forgets to re-derive the mirror. The cutout would then be invisible to
  // the orphan sweep's reference map.
  assertEquals(
    ProductSchema.safeParse({ ...validProduct, images, query_by_images: [IMG_A, IMG_B] }).success,
    false,
    "a mirror missing a cutout uuid must be rejected",
  );

  // Extra uuid — a delete that dropped the row but not the mirror entry.
  assertEquals(
    ProductSchema.safeParse({
      ...validProduct,
      images: [imageRow(IMG_A)],
      query_by_images: [IMG_A, IMG_B],
    }).success,
    false,
    "a mirror holding a uuid no image row carries must be rejected",
  );

  // Same uuids, different order — ACCEPTED. The mirror is an `array-contains`
  // index and orders nothing; `images` is the sole authority on display order.
  // Constraining the order here would reject an equally correct writer and
  // imply the mirror meant something it doesn't.
  assertEquals(
    ProductSchema.safeParse({ ...validProduct, images, query_by_images: [IMG_B, IMG_A, IMG_A_CUT] })
      .success,
    true,
    "the mirror's order is not meaningful and must not be constrained",
  );

  // A duplicate is still rejected — length is compared, so it cannot hide
  // behind a matching set.
  assertEquals(
    ProductSchema.safeParse({
      ...validProduct,
      images,
      query_by_images: [IMG_A, IMG_A, IMG_B, IMG_A_CUT],
    }).success,
    false,
    "a duplicated uuid must be rejected",
  );

  // One side without the other is drift, not a half-doc: `validateBeforeWrite`
  // validates the MERGED document, so a legitimate write always carries both.
  assertEquals(
    ProductSchema.safeParse({ ...validProduct, images }).success,
    false,
    "images without a mirror must be rejected",
  );
  assertEquals(
    ProductSchema.safeParse({ ...validProduct, query_by_images: [IMG_A] }).success,
    false,
    "a mirror without images must be rejected",
  );
});

Deno.test("deriveProductImageUuids: follows images order, cutout beside its original", () => {
  assertEquals(deriveProductImageUuids(undefined), []);
  assertEquals(deriveProductImageUuids([]), []);
  assertEquals(deriveProductImageUuids([imageRow(IMG_A)]), [IMG_A]);
  // Row order preserved, and each cutout sits next to the original it came from
  // — so the mirror reads as the display array, even though nothing may rely on
  // that (the refinement compares it as a multiset).
  assertEquals(
    deriveProductImageUuids([imageRow(IMG_A, IMG_A_CUT), imageRow(IMG_B)]),
    [IMG_A, IMG_A_CUT, IMG_B],
  );
});

Deno.test("price.coa_revenue is REQUIRED on the document and on BOTH inputs", () => {
  // 568/568 in prod and dev carry the key (2026-08-23, `orderBy`
  // key-presence). Each arm drops exactly one field from an otherwise valid
  // value, so this asserts `coa_revenue` rather than "something is missing".
  const { coa_revenue: _a, ...priceWithoutCoa } = validProduct.price;
  assertEquals(ProductSchema.safeParse({ ...validProduct, price: priceWithoutCoa }).success, false);
  assertEquals(ProductSchema.safeParse(validProduct).success, true);

  const { coa_revenue: _b, ...createPriceWithoutCoa } = validCreateInput.price;
  assertEquals(CreateProductInput.safeParse({ ...validCreateInput, price: createPriceWithoutCoa }).success, false);
  assertEquals(CreateProductInput.safeParse(validCreateInput).success, true);

  // The UPDATE input is the one that mattered: `price` there is a WHOLE-OBJECT
  // replacement, so an update omitting `coa_revenue` used to erase the stored
  // account rather than leave it alone.
  const update = { uid: validProduct.uid, version: 0, price: validCreateInput.price };
  assertEquals(UpdateProductInput.safeParse(update).success, true);
  assertEquals(
    UpdateProductInput.safeParse({ ...update, price: createPriceWithoutCoa }).success,
    false,
  );

  // ⚠️ And it stays OPTIONAL on a component — `updateProduct` deletes it from
  // every webshop component copy, because the public catalogue carries no
  // ledger account.
  const component = {
    uid: "testcomp100000000000",
    path: ["testproduct100000000"],
    name: "Battery",
    type: "rental",
    stock_method: "bulk",
    crms_id: 200,
    quantity: 2,
    price: { base_cents: 0, replacement_cents: 10000, taxes: [], formula: "fixed", discountable: false },
  };
  assertEquals(ComponentSchema.safeParse(component).success, true);
});

Deno.test("components require inclusion_type, price_overridden and zero_priced; component_of requires none", () => {
  // The asymmetry is the point, and there are now THREE fields on the authored
  // side rather than two.
  //
  // `inclusion_type`: an `undefined` there is a silent fourth bucket both
  // expanders drop, so the component never reaches an order.
  //
  // `price_overridden` (api-cloudrun#862): only a parent authors an override,
  // so only the authored side can record one. On a back-reference the field
  // would be meaningless — nobody prices a parent from a child — and its
  // absence there is what makes a `component_of` price divergence
  // unambiguously a missed cascade, and therefore auditable.
  //
  // `zero_priced` (core#100 / manager#421 step 5): `buildOrderComponentLines`
  // writes `comp.zero_priced ?? null`, so one component authored without it puts
  // a `null` on every order line built from it and the array-level refinement
  // then refuses those documents. Requiring it here is what makes that
  // invariant true by construction rather than true until someone adds a
  // component. 175 of 175 prod entries already state it.
  //
  // `component_of` is the reciprocal back-reference: the parent authors the
  // relationship attributes, and 140 of 141 prod rows carry none of them, so
  // requiring either there would make 90 live products unwritable.
  const backRef = {
    uid: "testcomp100000000000",
    path: ["testproduct100000000"],
    name: "Battery",
    type: "rental",
    stock_method: "bulk",
    crms_id: 200,
    quantity: 2,
    price: { base_cents: 0, replacement_cents: 10000, taxes: [], formula: "fixed", discountable: false },
  };

  assertEquals(ComponentSchema.safeParse(backRef).success, true);
  assertEquals(AuthoredComponentSchema.safeParse(backRef).success, false);
  // Still false with any ONE missing — the fixture must supply all three, and
  // each is dropped in turn so a test that passes for the wrong reason cannot.
  assertEquals(
    AuthoredComponentSchema.safeParse({ ...backRef, price_overridden: [], zero_priced: false }).success,
    false,
  );
  assertEquals(
    AuthoredComponentSchema.safeParse({ ...backRef, inclusion_type: "default", zero_priced: false }).success,
    false,
  );
  assertEquals(
    AuthoredComponentSchema.safeParse({ ...backRef, inclusion_type: "default", price_overridden: [] }).success,
    false,
  );
  assertEquals(
    AuthoredComponentSchema.safeParse({
      ...backRef,
      inclusion_type: "default",
      price_overridden: [],
      zero_priced: false,
    }).success,
    true,
  );

  // And through the document: component_of takes the back-ref, components does not.
  assertEquals(ProductSchema.safeParse({ ...validProduct, component_of: [backRef] }).success, true);
  assertEquals(ProductSchema.safeParse({ ...validProduct, components: [backRef] }).success, false);

  // But the INPUT stays permissive: a client may omit inclusion_type and the
  // writer fills "default". Requiring it at the boundary would 400 any client
  // not rebuilt against this beta — manager is pinned several betas back on
  // purpose. Normalize at the writer, guard at storage.
  assertEquals(CreateProductInput.safeParse({ ...validCreateInput, components: [backRef] }).success, true);
});

// ── core#78: a component cannot be priced from a document total ─────
//
// `ComponentObject.price` declared the full `PriceFormulaEnum` and, unlike the
// product arm and the two line-price families, carried no `checkPriceBaseUnit`.
// So `percent_of_total` with a null `base_percent` — a percentage of nothing —
// PARSED. Only `manager`'s two component price selects prevented it, by
// hand-listing two of three members, and manager#378's sweep replacing
// hand-listed vocabularies with derivations from core duly swept that away.
// The prevention now lives here, in the package that owns the vocabulary.

const componentBase = {
  uid: "testcomp100000000000",
  path: ["testproduct100000000"],
  name: "Battery",
  type: "rental",
  stock_method: "bulk",
  crms_id: 200,
  quantity: 2,
  price: { base_cents: 0, replacement_cents: 10000, taxes: [], formula: "fixed", discountable: false },
};

Deno.test("a component may be priced five_day_week or fixed", () => {
  for (const formula of ["five_day_week", "fixed"]) {
    const component = { ...componentBase, price: { ...componentBase.price, formula } };
    assertEquals(ComponentSchema.safeParse(component).success, true, formula);
    assertEquals(
      AuthoredComponentSchema.safeParse({ ...component, inclusion_type: "default", price_overridden: [], zero_priced: false }).success,
      true,
      formula,
    );
  }
});

Deno.test("a component may NOT be priced percent_of_total — on either side", () => {
  // Both sides, because `AuthoredComponentSchema` extends `ComponentSchema` and
  // an extension is exactly where a narrowing can be widened back by accident.
  const component = { ...componentBase, price: { ...componentBase.price, formula: "percent_of_total" } };
  assertEquals(ComponentSchema.safeParse(component).success, false);
  assertEquals(
    AuthoredComponentSchema.safeParse({ ...component, inclusion_type: "default", price_overridden: [], zero_priced: false }).success,
    false,
  );
});

Deno.test("a component priced percent_of_total is rejected even WITH a base_percent", () => {
  // 🔴 The fail-closed arm. The defect core#78 names is the missing
  // `checkPriceBaseUnit`, so the obvious repair is to add the rate — and if the
  // narrowing were expressed as a refinement on the pair rather than on the
  // vocabulary, supplying `base_percent` would make this pass. A component can
  // never price from a document total no matter what rate accompanies it,
  // because `ComponentTypeEnum` excludes `transaction_fee`.
  const component = {
    ...componentBase,
    price: { ...componentBase.price, formula: "percent_of_total", base_percent: 4 },
  };
  assertEquals(ComponentSchema.safeParse(component).success, false);
});

Deno.test("the PRODUCT price keeps all three formulas — the narrowing is not over-applied", () => {
  // ⚠️ Without this the narrowing could be widened to the product arm and every
  // arm above would stay green, taking the live "Card Fee" product with it:
  // `transaction_fee`, `percent_of_total`, `base_percent: 4`, `base_cents: 0`.
  const feeProduct = {
    ...validProduct,
    type: "transaction_fee",
    price: { ...validProduct.price, base_cents: 0, base_percent: 4, formula: "percent_of_total" },
  };
  assertEquals(ProductSchema.safeParse(feeProduct).success, true);
});

Deno.test("a component may NOT carry a base_percent beside a two-member formula", () => {
  // 🔴 **This is the half of core#78 that was real, and the ONLY arm here that
  // fails against the pre-change schema.** Measured 2026-09-07 against the
  // unmodified package: `{ formula: "fixed", base_percent: 4 }` on a component
  // parsed cleanly, because `ComponentObject` carried no `checkPriceBaseUnit`
  // while the product arm and both line-price families did.
  //
  // ⚠️ The issue's headline half — `formula: "percent_of_total"` — was NEVER
  // representable: `checkItemContract` → `checkItemPriceFormula` has always
  // rejected it for any type whose contract is not `from_total`, and
  // `ComponentTypeEnum` excludes `transaction_fee`. The arms above therefore
  // pass with or without the enum narrowing; they pin the vocabulary, not a
  // hole. This one pins the hole.
  const component = {
    ...componentBase,
    price: { ...componentBase.price, base_cents: 5000, formula: "fixed", base_percent: 4 },
  };
  assertEquals(ComponentSchema.safeParse(component).success, false);
  assertEquals(
    AuthoredComponentSchema.safeParse({ ...component, inclusion_type: "default", price_overridden: [], zero_priced: false }).success,
    false,
  );
});

Deno.test("a component with a NULL base_percent still parses — the copy path", () => {
  // ⚠️ Fail-closed companion to the arm above. `createProduct` copies a product
  // price into `components[]` by SPREAD, so the key travels whether or not the
  // component can use it, and a `z.strictObject` refuses an undeclared key —
  // which is why `base_percent` is declared here at all. A refinement that
  // rejected the key's PRESENCE rather than a non-null VALUE would 400 every
  // product create. Measured: all `base_percent` in both environments are null.
  const component = {
    ...componentBase,
    price: { ...componentBase.price, base_cents: 5000, formula: "fixed", base_percent: null },
  };
  assertEquals(ComponentSchema.safeParse(component).success, true);
});

// ── core#95 batch 9 — the six ProductSchema paths, asserted directly ─────────
//
// 🔴 **These exist because `validProduct` CANNOT fail them.** It is built from
// `getInitialValues(ProductSchema)`, whose walk is TYPE-derived and therefore
// seeds every key whether the schema requires it or not — so the fixture is
// complete by construction and a required-key tightening is invisible to it.
// That is the mirror of the inverted test batch 2 undid: not a green that
// asserts the default's spec, but a green that cannot see the default at all.
// One dropped key per case, so each names the constraint it tests.
for (const path of ["alternates", "components", "component_of"] as const) {
  Deno.test(`ProductSchema requires ${path} (core#95 batch 9)`, () => {
    const { [path]: _omit, ...doc } = validProduct;
    const parsed = ProductSchema.safeParse(doc);
    assertEquals(parsed.success, false);
    if (!parsed.success) {
      assertEquals(parsed.error.issues.map((i) => i.path.join(".")), [path]);
    }
  });
}

for (const leaf of ["taxes", "discountable"] as const) {
  Deno.test(`ProductSchema requires price.${leaf} (core#95 batch 9)`, () => {
    const { [leaf]: _omit, ...price } = validProduct.price as Record<string, unknown>;
    const parsed = ProductSchema.safeParse({ ...validProduct, price });
    assertEquals(parsed.success, false);
    if (!parsed.success) {
      assertEquals(parsed.error.issues.map((i) => i.path.join(".")), [`price.${leaf}`]);
    }
  });
}

Deno.test("ProductSchema requires webshop.available (core#95 batch 9)", () => {
  const { available: _omit, ...webshop } = validProduct.webshop as Record<string, unknown>;
  const parsed = ProductSchema.safeParse({ ...validProduct, webshop });
  assertEquals(parsed.success, false);
  if (!parsed.success) {
    assertEquals(parsed.error.issues.map((i) => i.path.join(".")), ["webshop.available"]);
  }
});

// ⚠️ The MIRROR, and it is the half that keeps this batch honest: the same keys
// on `CreateProductInput` are DELIBERATELY still defaulted, because
// `ComponentObject` is one node shared with both input schemas and because the
// route validator returns `result.data` — so the input default is what actually
// puts these keys into storage. Sweeping them is a client-visible change, not a
// storage tightening. See `core/CLAUDE.md` § `.default()` and `.optional()`.
Deno.test("CreateProductInput still DEFAULTS the three array keys, and they MATERIALIZE (core#95 batch 9)", () => {
  // `validCreateInput` states none of the three — which is the point: the
  // stored document is 570/570 complete on all three in BOTH projects, and this
  // is where that comes from. `createProduct` spreads the route's
  // `c.req.valid("json")`, and `@hono/zod-validator` returns `result.data`.
  assertEquals("alternates" in validCreateInput, false);
  const parsed = CreateProductInput.safeParse(validCreateInput);
  assertEquals(parsed.success, true);
  if (parsed.success) {
    assertEquals(parsed.data.alternates, []);
    assertEquals(parsed.data.components, []);
    assertEquals(parsed.data.component_of, []);
  }
});
