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
  TemplateSchema,
  TrackingCategorySchema,
  TransactionSchema,
  UserSchema,
  DestinationEndpoint,
  OrderItem,
  OrderDocDestinationItem,
  getInitialValues,
} from "../src/mod.ts";

Deno.test("getInitialValues — produces object for every collection schema", () => {
  const schemas = [
    ContactSchema, OrganizationSchema, DestinationSchema, LocationSchema,
    OrderSchema, ProductSchema, TagSchema, TaxSchema, TemplateSchema,
    TrackingCategorySchema, TransactionSchema, UserSchema,
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

  const txResult = getInitialValues(TransactionSchema);
  assertEquals(txResult.type, "opening_balance");

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
  assertEquals(result.scope, "single");
});

Deno.test("getInitialValues — product price has correct structure", () => {
  const result = getInitialValues(ProductSchema);
  const price = result.price as Record<string, unknown>;
  assertEquals(price.base, 0);
  assertEquals(price.formula, "five_day_week");
  assertEquals(price.taxes, []);
  assertEquals(price.discountable, true);
  // COA revenue codes are numeric — JS sorts object keys numerically, so first is 2210
  assertEquals(price.coa_revenue, 2210);
});

Deno.test("getInitialValues — order item input schema works", () => {
  const result = getInitialValues(OrderItem);
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
