import { assertEquals } from "@std/assert";
import { CreateProductInput, ProductSchema } from "../src/product.ts";
import { getInitialValues } from "../src/initial.ts";

const base = getInitialValues(ProductSchema);
const actor = { uid: "test-user-1", name: "Test User" };
const validProduct = {
  ...base,
  uid: "test-product-1",
  name: "Canon C300",
  active: true,
  crms_id: 100,
  price: { ...(base.price as Record<string, unknown>), base: 500, replacement: 5000, taxes: [{ uid: "test-chi-rental-tax", name: "Chicago Rental Tax", rate: 15, type: "percent" }], discountable: true },
  tags: [{ uid: "test-t1", name: "Camera" }],
  webshop: { available: true },
  created_by: actor,
  updated_by: actor,
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
        uid: "test-comp-1",
        path: ["test-product-1"],
        name: "Battery",
        type: "rental",
        stock_method: "bulk",
        crms_id: 200,
        quantity: 2,
        price: {
          base: 0,
          replacement: 100,
          taxes: [{ uid: "test-tax-none", name: "No Tax", rate: 0, type: "percent" }],
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
        uid: "test-comp-1",
        path: ["test-product-1"],
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
        uid: "test-comp-1",
        path: ["test-product-1"],
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
  assertEquals(ProductSchema.safeParse({ uid: "test-product-1", name: "Test" }).success, false);
});

Deno.test("ProductSchema rejects additional properties", () => {
  const doc = { ...validProduct, bogus: true };
  assertEquals(ProductSchema.safeParse(doc).success, false);
});

const validCreateInput = {
  uid: "test-product-1",
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
    uid: "test-comp-1",
    path: ["test-product-1"],
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
