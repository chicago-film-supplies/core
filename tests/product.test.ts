import { assertEquals } from "@std/assert";
import { CreateProductInput, deriveProductImageUuids, ProductSchema } from "../src/schemas/product.ts";
import { getInitialValues } from "../src/schemas/initial.ts";
import { mockTimestamp } from "./helpers/timestamp.ts";

const base = getInitialValues(ProductSchema);
const actor = { uid: "testuser100000000000", name: "Test User" };
const validProduct = {
  ...base,
  uid: "testproduct100000000",
  name: "Canon C300",
  active: true,
  crms_id: 100,
  price: { ...(base.price as Record<string, unknown>), base: 500, replacement: 5000, taxes: [{ uid: "testchirentaltax0000", name: "Chicago Rental Tax", rate: 15, type: "percent" }], discountable: true },
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

Deno.test("ProductSchema validates with components", () => {
  const doc = {
    ...validProduct,
    components: [
      {
        uid: "testcomp100000000000",
        path: ["testproduct100000000"],
        name: "Battery",
        type: "rental",
        stock_method: "bulk",
        crms_id: 200,
        quantity: 2,
        price: {
          base: 0,
          replacement: 100,
          taxes: [{ uid: "testtaxnone000000000", name: "No Tax", rate: 0, type: "percent" }],
          formula: "fixed",
          discountable: false,
        },
      },
    ],
  };
  assertEquals(ProductSchema.safeParse(doc).success, true);
});

Deno.test("ProductSchema rejects rental without price.replacement", () => {
  const doc = {
    ...validProduct,
    price: { ...(validProduct.price as Record<string, unknown>), replacement: undefined },
  };
  assertEquals(ProductSchema.safeParse(doc).success, false);
});

Deno.test("ProductSchema accepts rental with stock_method none and no price.replacement", () => {
  const doc = {
    ...validProduct,
    stock_method: "none",
    price: { ...(validProduct.price as Record<string, unknown>), replacement: undefined },
  };
  assertEquals(ProductSchema.safeParse(doc).success, true);
});

Deno.test("ProductSchema rejects rental component without price.replacement", () => {
  const doc = {
    ...validProduct,
    components: [
      {
        uid: "testcomp100000000000",
        path: ["testproduct100000000"],
        name: "Battery",
        type: "rental",
        stock_method: "bulk",
        crms_id: 200,
        quantity: 2,
        price: { base: 0, taxes: [], formula: "fixed", discountable: false },
      },
    ],
  };
  assertEquals(ProductSchema.safeParse(doc).success, false);
});

Deno.test("ProductSchema accepts rental component with stock_method none and no price.replacement", () => {
  const doc = {
    ...validProduct,
    components: [
      {
        uid: "testcomp100000000000",
        path: ["testproduct100000000"],
        name: "Service Fee",
        type: "rental",
        stock_method: "none",
        crms_id: 200,
        quantity: 1,
        price: { base: 0, taxes: [], formula: "fixed", discountable: false },
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
    base: 500,
    replacement: 5000,
    taxes: [],
    formula: "five_day_week" as const,
    discountable: true,
  },
  webshop: { available: false },
};

Deno.test("CreateProductInput requires price.replacement for rental products", () => {
  const input = { ...validCreateInput, price: { ...validCreateInput.price, replacement: undefined } };
  assertEquals(CreateProductInput.safeParse(input).success, false);
  assertEquals(CreateProductInput.safeParse(validCreateInput).success, true);
  assertEquals(CreateProductInput.safeParse({ ...input, type: "sale" }).success, true);
  assertEquals(CreateProductInput.safeParse({ ...input, stock_method: "none" }).success, true);
});

Deno.test("CreateProductInput requires price.replacement for rental components", () => {
  const rentalComponent = {
    uid: "testcomp100000000000",
    path: ["testproduct100000000"],
    name: "Battery",
    type: "rental" as const,
    stock_method: "bulk" as const,
    crms_id: 200,
    quantity: 2,
    price: {
      base: 0,
      taxes: [],
      formula: "fixed" as const,
      discountable: false,
    },
  };
  assertEquals(CreateProductInput.safeParse({ ...validCreateInput, components: [rentalComponent] }).success, false);
  assertEquals(
    CreateProductInput.safeParse({
      ...validCreateInput,
      components: [{ ...rentalComponent, price: { ...rentalComponent.price, replacement: 100 } }],
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
  // originals in array order, then every non-null cutout
  const derived = [IMG_A, IMG_B, IMG_A_CUT];

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
    ProductSchema.safeParse({ ...validProduct, images, query_by_images: [IMG_B, IMG_A_CUT, IMG_A] })
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

Deno.test("deriveProductImageUuids: originals first, then non-null cutouts", () => {
  assertEquals(deriveProductImageUuids(undefined), []);
  assertEquals(deriveProductImageUuids([]), []);
  assertEquals(deriveProductImageUuids([imageRow(IMG_A)]), [IMG_A]);
  assertEquals(
    deriveProductImageUuids([imageRow(IMG_A, IMG_A_CUT), imageRow(IMG_B)]),
    [IMG_A, IMG_B, IMG_A_CUT],
  );
});
