import { assertEquals } from "@std/assert";
import {
  bookings,
  cards,
  chartOfAccounts,
  comments,
  contacts,
  creditNotes,
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
  templateComponents,
  threads,
  toWireSchema,
  trackingCategories,
  typesenseSchemas,
  type TypesenseAlias,
  users,
  webshopProducts,
} from "../src/schemas/typesense/mod.ts";

const allConfigs = [
  bookings,
  cards,
  chartOfAccounts,
  comments,
  contacts,
  creditNotes,
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
  templateComponents,
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

// ── The `money` marker ──────────────────────────────────────────────
//
// `addStringMirrors` renders a marked field's `_str` companion at 2dp instead of
// `String(value)`. Probed against the live index 2026-08-01, the unrendered form
// mirrors a $1,500 total as `"1500"` — one token — so the query `1500.00`
// (tokenized `1500` + `00`) misses every actual $1,500 invoice and typo
// tolerance returns $15,000 and $10,000 instead.
//
// The classification is pinned here rather than left to 34 scattered flags,
// because the failure mode is silent in both directions: an unmarked amount
// breaks its search, and a marked rate is coarsened for nothing.

Deno.test("the money marker names exactly the amount fields — pinned, not scattered", () => {
  const marked = allConfigs.flatMap((c) =>
    c.schema.fields.filter((f) => f.money).map((f) => `${c.alias}:${f.name}`)
  ).sort();

  assertEquals(marked, [
    "bookings:total_price",
    "bookings:unit_price",
    "credit-notes:remaining_credit",
    "credit-notes:totals.total",
    "invoices:totals.amount_credited",
    "invoices:totals.amount_due",
    "invoices:totals.amount_paid",
    "invoices:totals.total",
    "orders:items.price.base",
    "orders:items.price.discount.amount",
    "orders:items.price.replacement",
    "orders:items.price.subtotal",
    "orders:items.price.subtotal_discounted",
    "orders:items.price.taxes.amount",
    "orders:items.price.total",
    "orders:items.total_price",
    "orders:totals.discount_amount",
    "orders:totals.subtotal",
    "orders:totals.subtotal_discounted",
    "orders:totals.taxes.amount",
    "orders:totals.total",
    "orders:totals.transaction_fees.amount",
    "products:component_of.price.base",
    "products:component_of.price.replacement",
    "products:components.price.base",
    "products:components.price.replacement",
    "products:price.base",
    "products:price.replacement",
    "webshop-products:component_of.price.base",
    "webshop-products:component_of.price.replacement",
    "webshop-products:components.price.base",
    "webshop-products:components.price.replacement",
    "webshop-products:price.base",
    "webshop-products:price.replacement",
  ]);
});

Deno.test("no rate is marked money — the discriminated-rate trap, as a test", () => {
  // `Discount.rate` is a percentage on one arm and dollars-per-unit on the
  // other, and every `*.rate` holds 4dp to match Xero's `DiscountRate`. They sit
  // directly beside the amounts they apply to, which is exactly why a sweep
  // that says "migrate the money fields" keeps catching them.
  for (const config of allConfigs) {
    for (const field of config.schema.fields) {
      if (!field.money) continue;
      assertEquals(
        field.name.endsWith(".rate") || field.name === "rate",
        false,
        `${config.alias}.${field.name}: a rate is not money`,
      );
    }
  }
});

Deno.test("every money marker sits on a numeric field, and no _str mirror carries one", () => {
  // The marker instructs the mirror BUILDER, so it belongs on the numeric source
  // field. On a `_str` field it would be inert and read as if it did something.
  const numeric = new Set(["int32", "int32[]", "int64", "int64[]", "float", "float[]"]);
  for (const config of allConfigs) {
    for (const field of config.schema.fields) {
      if (!field.money) continue;
      assertEquals(numeric.has(field.type), true, `${config.alias}.${field.name}: money on a non-numeric field`);
      assertEquals(field.name.endsWith("_str"), false, `${config.alias}.${field.name}: money on a mirror`);
    }
  }
});

Deno.test("every declared money _str mirror has a money-marked source", () => {
  // The direction that actually breaks search today: a `_str` field whose
  // numeric source is unmarked keeps getting `String(value)` and stays
  // unsearchable. Catches a mirror added later without its marker.
  const MONEY_MIRROR_ROOTS = ["total", "amount_paid", "amount_credited", "amount_due", "remaining_credit"];
  for (const config of allConfigs) {
    const byName = new Map(config.schema.fields.map((f) => [f.name, f]));
    for (const field of config.schema.fields) {
      if (!field.name.endsWith("_str")) continue;
      const source = field.name.slice(0, -"_str".length);
      const leaf = source.split(".").at(-1)!;
      if (!MONEY_MIRROR_ROOTS.includes(leaf)) continue;
      const sourceField = byName.get(source);
      assertEquals(sourceField !== undefined, true, `${config.alias}: ${field.name} has no source field ${source}`);
      assertEquals(sourceField?.money, true, `${config.alias}.${source}: has a money mirror but is not marked money`);
    }
  }
});

Deno.test("toWireSchema strips the CFS annotation, so nothing unknown reaches Typesense", () => {
  // `reindexTypesense.ts` POSTs `{ ...config.schema, name }` verbatim to the
  // collections API. A CFS-only key left on a field is sent as if it were a
  // Typesense field property.
  for (const config of allConfigs) {
    const wire = toWireSchema(config.schema);
    for (const field of wire.fields) {
      assertEquals(
        "money" in field,
        false,
        `${config.alias}.${field.name}: money survived into the wire schema`,
      );
    }
    // Everything else is untouched — same fields, same order, same real
    // Typesense properties.
    assertEquals(wire.fields.length, config.schema.fields.length);
    assertEquals(wire.fields.map((f) => f.name), config.schema.fields.map((f) => f.name));
    assertEquals(wire.name, config.schema.name);
    assertEquals(wire.default_sorting_field, config.schema.default_sorting_field);
    for (const [i, field] of wire.fields.entries()) {
      const source = config.schema.fields[i];
      assertEquals(field.type, source.type);
      assertEquals(field.sort, source.sort);
      assertEquals(field.stem, source.stem);
      assertEquals(field.facet, source.facet);
      assertEquals(field.index, source.index);
      assertEquals(field.optional, source.optional);
    }
  }
});

Deno.test("toWireSchema does not mutate its input — the annotation survives for the mirror builder", () => {
  const invoicesConfig = allConfigs.find((c) => c.alias === "invoices")!;
  const before = invoicesConfig.schema.fields.filter((f) => f.money).length;
  toWireSchema(invoicesConfig.schema);
  assertEquals(invoicesConfig.schema.fields.filter((f) => f.money).length, before);
  assertEquals(before, 4);
});
