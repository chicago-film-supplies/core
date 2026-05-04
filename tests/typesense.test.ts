import { assertEquals } from "@std/assert";
import {
  bookings,
  cards,
  chartOfAccounts,
  comments,
  contacts,
  destinations,
  invoices,
  locations,
  orders,
  fulfillments,
  organizations,
  outOfService,
  products,
  stores,
  tags,
  templates,
  threads,
  trackingCategories,
  typesenseSchemas,
  type TypesenseAlias,
  users,
  webshopProducts,
} from "../src/typesense/mod.ts";

const allConfigs = [
  bookings,
  cards,
  chartOfAccounts,
  comments,
  contacts,
  destinations,
  invoices,
  locations,
  orders,
  fulfillments,
  organizations,
  outOfService,
  products,
  stores,
  tags,
  templates,
  threads,
  trackingCategories,
  users,
  webshopProducts,
];

Deno.test("all configs have required properties", () => {
  for (const config of allConfigs) {
    assertEquals(typeof config.alias, "string");
    assertEquals(typeof config.version, "number");
    assertEquals(typeof config.firestoreCollection, "string");
    assertEquals(typeof config.collectionName, "string");
    assertEquals(config.collectionName, `${config.alias}_v${config.version}`);
    assertEquals(Array.isArray(config.schema.fields), true);
    assertEquals(config.schema.fields.length > 0, true);
  }
});

Deno.test("typesenseSchemas contains all aliases", () => {
  for (const config of allConfigs) {
    assertEquals(typesenseSchemas[config.alias as TypesenseAlias], config);
  }
  assertEquals(Object.keys(typesenseSchemas).length, allConfigs.length);
});

Deno.test("schema.name matches collectionName", () => {
  for (const config of allConfigs) {
    assertEquals(config.schema.name, config.collectionName);
  }
});

Deno.test("every config has displayDefaults with non-empty columns", () => {
  for (const config of allConfigs) {
    assertEquals(
      config.displayDefaults !== undefined,
      true,
      `${config.alias}: missing displayDefaults`,
    );
    assertEquals(
      config.displayDefaults.columns.length > 0,
      true,
      `${config.alias}: displayDefaults.columns is empty`,
    );
  }
});

Deno.test("displayDefaults.columns reference valid field names", () => {
  for (const config of allConfigs) {
    const fieldNames = new Set(config.schema.fields.map((f) => f.name));
    for (const col of config.displayDefaults.columns) {
      assertEquals(
        fieldNames.has(col),
        true,
        `${config.alias}: displayDefaults column "${col}" not found in schema fields`,
      );
    }
  }
});

Deno.test("displayDefaults.sort.column is null or a valid field name", () => {
  for (const config of allConfigs) {
    const { column } = config.displayDefaults.sort;
    if (column !== null) {
      const fieldNames = new Set(config.schema.fields.map((f) => f.name));
      assertEquals(
        fieldNames.has(column),
        true,
        `${config.alias}: sort column "${column}" not found in schema fields`,
      );
    }
  }
});

Deno.test("displayDefaults.group is null for all configs", () => {
  for (const config of allConfigs) {
    assertEquals(
      config.displayDefaults.group,
      null,
      `${config.alias}: group should be null`,
    );
  }
});

Deno.test("displayDefaults.facet entries reference fields with facet: true", () => {
  for (const config of allConfigs) {
    const facetFields = new Set(
      config.schema.fields.filter((f) => f.facet === true).map((f) => f.name),
    );
    for (const f of config.displayDefaults.facet) {
      assertEquals(
        facetFields.has(f),
        true,
        `${config.alias}: facet entry "${f}" is not a faceted field`,
      );
    }
  }
});

Deno.test("enable_nested_fields is true when schema has object or object[] fields", () => {
  for (const config of allConfigs) {
    const hasObjectFields = config.schema.fields.some((f) =>
      f.type === "object" || f.type === "object[]"
    );
    if (hasObjectFields) {
      assertEquals(
        config.schema.enable_nested_fields,
        true,
        `${config.alias}: has object/object[] fields but enable_nested_fields is not true`,
      );
    }
  }
});

Deno.test("each field has a name and valid type", () => {
  const validTypes = new Set([
    "string", "string[]",
    "int32", "int32[]",
    "int64", "int64[]",
    "float", "float[]",
    "bool", "bool[]",
    "object", "object[]",
    "geopoint", "geopoint[]",
  ]);
  for (const config of allConfigs) {
    for (const field of config.schema.fields) {
      assertEquals(typeof field.name, "string", `${config.alias}: field missing name`);
      assertEquals(validTypes.has(field.type), true, `${config.alias}.${field.name}: invalid type "${field.type}"`);
    }
  }
});
