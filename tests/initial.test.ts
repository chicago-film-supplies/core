import { assertEquals, assertThrows } from "@std/assert";
import {
  ContactSchema,
  OrganizationSchema,
  DestinationSchema,
  LocationSchema,
  OrderSchema,
  ProductSchema,
  TagSchema,
  TaxSchema,
  StoreSchema,
  TemplateSchema,
  TrackingCategorySchema,
  MovementSchema,
  UserSchema,
  WebshopProductSchema,
  DestinationEndpoint,
  OrderItem,
  type OrderItemLineType,
  OrderDocDestinationItem,
  getInitialValues,
} from "../src/schemas/mod.ts";

Deno.test("getInitialValues — produces object for every collection schema", () => {
  const schemas = [
    ContactSchema, OrganizationSchema, DestinationSchema, LocationSchema,
    OrderSchema, ProductSchema, TagSchema, TaxSchema, TemplateSchema,
    TrackingCategorySchema, MovementSchema, UserSchema,
  ];
  for (const schema of schemas) {
    const result = getInitialValues(schema);
    assertEquals(typeof result, "object");
    assertEquals(result !== null, true);
    assertEquals(Array.isArray(result), false);
  }
});

Deno.test("getInitialValues — produces object for sub-schemas", () => {
  for (const schema of [DestinationEndpoint, OrderItem, OrderDocDestinationItem]) {
    const result = getInitialValues(schema);
    assertEquals(typeof result, "object");
    assertEquals(result !== null, true);
  }
});

Deno.test("getInitialValues — strings default to empty string", () => {
  const result = getInitialValues(ContactSchema);
  assertEquals(result.first_name, "");
  assertEquals(result.uid, "");
});

Deno.test("getInitialValues — arrays default to empty array", () => {
  const result = getInitialValues(ContactSchema);
  assertEquals(result.emails, []);
  assertEquals(result.phones, []);
  assertEquals(result.organizations, []);
});

Deno.test("getInitialValues — numbers default to zero", () => {
  const result = getInitialValues(ContactSchema);
  assertEquals(result.version, 0);
});

Deno.test("getInitialValues — nullable fields default to null", () => {
  const result = getInitialValues(OrganizationSchema);
  assertEquals(result.billing_address, null);
});

Deno.test("getInitialValues — enum fields use first value", () => {
  const result = getInitialValues(OrganizationSchema);
  assertEquals(result.tax_profile, "tax_applied");

  // First member of MOVEMENT_TYPES, which now leads with the custody-bearing
  // fulfillment events. Forms pick their options from
  // getDisplayTransactionTypes(), not from this synthesized default.
  const txResult = getInitialValues(MovementSchema);
  assertEquals(txResult.type, "prep");

  const taxResult = getInitialValues(TaxSchema);
  assertEquals(taxResult.type, "percent");
});

Deno.test("getInitialValues — defaults are used when present", () => {
  const result = getInitialValues(TaxSchema);
  assertEquals(result.active, true);
  assertEquals(result.crms_id, null);
  assertEquals(result.valid_from, "1970-01-01T00:00:00Z");
});

Deno.test("getInitialValues — custom types (FirestoreTimestamp) are omitted", () => {
  const result = getInitialValues(ContactSchema);
  assertEquals("created_at" in result, false);
  assertEquals("updated_at" in result, false);
});

Deno.test("getInitialValues — nested objects are recursed", () => {
  const result = getInitialValues(OrderSchema);
  assertEquals(typeof result.organization, "object");
  const org = result.organization as Record<string, unknown>;
  assertEquals(org.name, "");
  assertEquals(org.uid, null);
});

Deno.test("getInitialValues — records default to empty object", () => {
  const result = getInitialValues(ProductSchema);
  assertEquals(result.alternates, []);

  const userResult = getInitialValues(UserSchema);
  assertEquals(userResult.prefs_firestore, {});
  assertEquals(userResult.prefs_typesense, {});
});

Deno.test("getInitialValues — template enums use first value", () => {
  const result = getInitialValues(TemplateSchema);
  assertEquals(result.collection_source, "orders");
  assertEquals(result.collection_target, "quotes");
});

Deno.test("getInitialValues — product price has correct structure", () => {
  // No cast: the return is typed now, so `price` is `ProductPrice | undefined`
  // and `?.` is the honest read — the partial genuinely may not carry it.
  const price = getInitialValues(ProductSchema).price;
  assertEquals(price?.base, 0);
  assertEquals(price?.formula, "five_day_week");
  assertEquals(price?.taxes, []);
  assertEquals(price?.discountable, true);
  // COA revenue codes are numeric — JS sorts object keys numerically, so first is 2210
  assertEquals(price?.coa_revenue, 2210);
});

Deno.test("getInitialValues — order item input schema works", () => {
  // `OrderItem` is a discriminated union and the walk collapses it to its FIRST
  // resolvable arm — the line arm, whose position is load-bearing and documented
  // at its declaration. The type system cannot know which arm the walk picked, so
  // naming it here is the honest form; that erasure is precisely what the
  // `Partial<z.output<S>>` return type now surfaces instead of hiding behind
  // `Record<string, unknown>`.
  const result = getInitialValues(OrderItem) as Partial<OrderItemLineType>;
  assertEquals(result.uid, "");
  assertEquals(result.type, "rental");
  assertEquals(result.stock_method, "bulk");
  assertEquals(result.quantity, 0);
});

Deno.test("getInitialValues — throws for non-object schema", async () => {
  const { z } = await import("zod");
  assertThrows(() => getInitialValues(z.string()), Error, "getInitialValues requires an object schema");
  assertThrows(() => getInitialValues(z.array(z.string())), Error, "getInitialValues requires an object schema");
});

Deno.test("getInitialValues — literal fields use the literal value", () => {
  const result = getInitialValues(OrderDocDestinationItem);
  assertEquals(result.type, "destination");
});

Deno.test("getInitialValues — .meta({ initial }) wins over the type-derived zero", async () => {
  const { z } = await import("zod");
  const result = getInitialValues(z.object({
    annotated: z.boolean().meta({ initial: true }),
    bare: z.boolean(),
    str: z.string().meta({ initial: "hello" }),
    num: z.number().meta({ initial: 42 }),
    arr: z.array(z.string()).meta({ initial: ["a"] }),
  }));
  assertEquals(result.annotated, true);
  assertEquals(result.bare, false);
  assertEquals(result.str, "hello");
  assertEquals(result.num, 42);
  assertEquals(result.arr, ["a"]);
});

Deno.test("getInitialValues — .meta({ initial }) is found through wrappers", async () => {
  const { z } = await import("zod");
  const result = getInitialValues(z.object({
    // Annotation on the leaf, wrapper above it — resolveField recurses into
    // `.optional()`'s innerType, so the leaf tag is still reached.
    opt: z.boolean().meta({ initial: true }).optional(),
    // Annotation on the wrapper itself.
    onWrapper: z.boolean().optional().meta({ initial: true }),
  }));
  assertEquals(result.opt, true);
  assertEquals(result.onWrapper, true);
});

Deno.test("getInitialValues — .meta() without `initial` leaves resolution unchanged", async () => {
  const { z } = await import("zod");
  const result = getInitialValues(z.object({
    tagged: z.string().meta({ pii: "mask" }),
    both: z.boolean().meta({ pii: "none", initial: true }),
  }));
  assertEquals(result.tagged, "");
  assertEquals(result.both, true);
});

Deno.test("getInitialValues — the five boolean fields that lost .default(true) still seed true", () => {
  // The regression this annotation exists to prevent: dropping `.default(true)`
  // for Typesense parity must not flip a create form to `false`.
  const product = getInitialValues(ProductSchema);
  assertEquals(product.active, true);
  assertEquals(product.eligible_delivery, true);
  assertEquals(product.eligible_in_store_pickup, true);

  const store = getInitialValues(StoreSchema);
  assertEquals(store.active, true);

  const webshop = getInitialValues(WebshopProductSchema);
  assertEquals(webshop.active, true);
});

Deno.test("getInitialValues — fields whose dropped default equalled the type-zero are unchanged", () => {
  const product = getInitialValues(ProductSchema);
  assertEquals(product.component_only, false);
  assertEquals(product.eligible_shipping_ground, false);
  assertEquals(product.eligible_shipping_air, false);

  const contact = getInitialValues(ContactSchema);
  assertEquals(contact.emails, []);
  assertEquals(contact.phones, []);

  // Enum: TAX_PROFILES[0] is "tax_applied", the value the dropped default held.
  const org = getInitialValues(OrganizationSchema);
  assertEquals(org.tax_profile, "tax_applied");
  const order = getInitialValues(OrderSchema);
  assertEquals(order.tax_profile, "tax_applied");
});
