import { assertEquals } from "@std/assert";
import { getInitialValues } from "../src/schemas/initial.ts";
import { CreateOrderInput, DocDestination, OrderDocDates, OrderDocItemPrice, OrderSchema, UpdateOrderInput } from "../src/schemas/order.ts";
import { mockTimestamp } from "./helpers/timestamp.ts";

const orderBase = getInitialValues(OrderSchema) as Record<string, unknown>;
const totalsBase = orderBase.totals as Record<string, unknown>;
const datesBase = getInitialValues(OrderDocDates) as Record<string, unknown>;
const destBase = getInitialValues(DocDestination) as Record<string, unknown>;
const priceBase = getInitialValues(OrderDocItemPrice) as Record<string, unknown>;

const validDates = {
  delivery_start: "2026-03-01T00:00:00Z",
  delivery_end: "2026-03-01T00:00:00Z",
  collection_start: "2026-03-10T00:00:00Z",
  collection_end: "2026-03-10T00:00:00Z",
  charge_start: "2026-03-01T00:00:00Z",
  charge_end: "2026-03-10T00:00:00Z",
};

const validDocDates = {
  ...datesBase,
  delivery_start: "2026-03-01T00:00:00Z",
  delivery_start_fs: mockTimestamp,
  delivery_end: "2026-03-01T00:00:00Z",
  delivery_end_fs: mockTimestamp,
  collection_start: "2026-03-10T00:00:00Z",
  collection_start_fs: mockTimestamp,
  collection_end: "2026-03-10T00:00:00Z",
  collection_end_fs: mockTimestamp,
  charge_start: "2026-03-01T00:00:00Z",
  charge_start_fs: mockTimestamp,
  charge_end: "2026-03-10T00:00:00Z",
  charge_end_fs: mockTimestamp,
};

// Each destination now owns its own full date range (delivery/collection +
// optional charge override). There is no order-level `dates` anymore.
const validDestination = {
  dates: validDates,
  delivery: { uid: "testdest100000000000" },
  collection: { uid: "testdest200000000000" },
};

const validDocDestination = {
  ...destBase,
  dates: validDocDates,
};

// ── CreateOrderInput ─────────────────────────────────────────────

Deno.test("CreateOrderInput validates a complete input", () => {
  const input = {
    uid: "testorder10000000000",
    organization: { uid: "testorg1000000000000" },
    status: "draft",
    tax_profile: "tax_applied",
    destinations: [validDestination],
    items: [
      { uid: "dest1000000000000000", type: "destination", name: "Chicago", path: [] },
      { uid: "testitem100000000000", type: "rental", name: "Camera", quantity: 2, path: ["dest1000000000000000"] },
    ],
    subject: "Film shoot",
  };
  assertEquals(CreateOrderInput.safeParse(input).success, true);
});

Deno.test("CreateOrderInput rejects empty destinations", () => {
  const input = {
    uid: "testorder10000000000",
    organization: { uid: "testorg1000000000000" },
    status: "draft",
    tax_profile: "tax_applied",
    destinations: [],
  };
  assertEquals(CreateOrderInput.safeParse(input).success, false);
});

Deno.test("CreateOrderInput rejects invalid status", () => {
  const input = {
    uid: "testorder10000000000",
    organization: { uid: "testorg1000000000000" },
    status: "invalid",
    tax_profile: "tax_applied",
    destinations: [validDestination],
  };
  assertEquals(CreateOrderInput.safeParse(input).success, false);
});

Deno.test("CreateOrderInput rejects invalid tax_profile", () => {
  const input = {
    uid: "testorder10000000000",
    organization: { uid: "testorg1000000000000" },
    status: "draft",
    tax_profile: "invalid",
    destinations: [validDestination],
  };
  assertEquals(CreateOrderInput.safeParse(input).success, false);
});

Deno.test("CreateOrderInput strips extra properties on destination dates", () => {
  const input = {
    uid: "testorder10000000000",
    organization: { uid: "testorg1000000000000" },
    status: "draft",
    tax_profile: "tax_applied",
    destinations: [{ ...validDestination, dates: { ...validDates, extra_field: "nope" } }],
  };
  const result = CreateOrderInput.safeParse(input);
  assertEquals(result.success, true);
  if (result.success) {
    assertEquals("extra_field" in result.data.destinations[0].dates, false);
  }
});

Deno.test("CreateOrderInput strips extra properties on destination endpoint", () => {
  const input = {
    uid: "testorder10000000000",
    organization: { uid: "testorg1000000000000" },
    status: "draft",
    tax_profile: "tax_applied",
    destinations: [{
      dates: validDates,
      delivery: { uid: "testdest100000000000", bonus: true },
      collection: { uid: "testdest200000000000" },
    }],
  };
  const result = CreateOrderInput.safeParse(input);
  assertEquals(result.success, true);
  if (result.success) {
    assertEquals("bonus" in result.data.destinations[0].delivery!, false);
  }
});

Deno.test("CreateOrderInput accepts destination with null contact", () => {
  const input = {
    uid: "testorder10000000000",
    organization: { uid: "testorg1000000000000" },
    status: "draft",
    tax_profile: "tax_applied",
    destinations: [{
      dates: validDates,
      delivery: { uid: "testdest100000000000", contact: null },
      collection: { uid: "testdest200000000000" },
    }],
  };
  assertEquals(CreateOrderInput.safeParse(input).success, true);
});

Deno.test("CreateOrderInput accepts destination with complete contact", () => {
  const input = {
    uid: "testorder10000000000",
    organization: { uid: "testorg1000000000000" },
    status: "draft",
    tax_profile: "tax_applied",
    destinations: [{
      dates: validDates,
      delivery: { uid: "testdest100000000000", contact: { uid: "testcontact100000000", first_name: "Jane", last_name: "Doe", name: "Jane Doe", phones: ["312-555-0100"] } },
      collection: { uid: "testdest200000000000" },
    }],
  };
  assertEquals(CreateOrderInput.safeParse(input).success, true);
});

Deno.test("CreateOrderInput rejects destination contact missing first_name", () => {
  const input = {
    uid: "testorder10000000000",
    organization: { uid: "testorg1000000000000" },
    status: "draft",
    tax_profile: "tax_applied",
    destinations: [{
      dates: validDates,
      delivery: { uid: "testdest100000000000", contact: { uid: "testcontact100000000" } },
      collection: { uid: "testdest200000000000" },
    }],
  };
  assertEquals(CreateOrderInput.safeParse(input).success, false);
});

Deno.test("CreateOrderInput rejects destination contact missing uid", () => {
  const input = {
    uid: "testorder10000000000",
    organization: { uid: "testorg1000000000000" },
    status: "draft",
    tax_profile: "tax_applied",
    destinations: [{
      dates: validDates,
      delivery: { uid: "testdest100000000000", contact: { name: "Jane" } },
      collection: { uid: "testdest200000000000" },
    }],
  };
  assertEquals(CreateOrderInput.safeParse(input).success, false);
});

Deno.test("CreateOrderInput accepts per-pair customer_collecting/returning", () => {
  const input = {
    uid: "testorder10000000000",
    organization: { uid: "testorg1000000000000" },
    status: "draft",
    tax_profile: "tax_applied",
    destinations: [
      { ...validDestination, customer_collecting: true, customer_returning: false },
      { ...validDestination, customer_collecting: false, customer_returning: true },
    ],
  };
  assertEquals(CreateOrderInput.safeParse(input).success, true);
});

Deno.test("DocDestination defaults customer_collecting/returning to false", () => {
  const result = DocDestination.safeParse({
    dates: validDocDates,
    delivery: { uid: null, address: null, instructions: null, contact: null },
    collection: { uid: null, address: null, instructions: null, contact: null },
  });
  assertEquals(result.success, true);
  if (result.success) {
    assertEquals(result.data.customer_collecting, false);
    assertEquals(result.data.customer_returning, false);
  }
});

Deno.test("CreateOrderInput rejects invalid item inclusion_type", () => {
  const input = {
    uid: "testorder10000000000",
    organization: { uid: "testorg1000000000000" },
    status: "draft",
    tax_profile: "tax_applied",
    destinations: [validDestination],
    items: [
      { uid: "dest1000000000000000", type: "destination", name: "Chicago", path: [] },
      { uid: "testitem100000000000", type: "rental", path: ["dest1000000000000000"], inclusion_type: "invalid" },
    ],
  };
  assertEquals(CreateOrderInput.safeParse(input).success, false);
});

Deno.test("CreateOrderInput accepts null inclusion_type", () => {
  const input = {
    uid: "testorder10000000000",
    organization: { uid: "testorg1000000000000" },
    status: "draft",
    tax_profile: "tax_applied",
    destinations: [validDestination],
    items: [
      { uid: "dest1000000000000000", type: "destination", name: "Chicago", path: [] },
      { uid: "testitem100000000000", type: "rental", path: ["dest1000000000000000"], inclusion_type: null },
    ],
  };
  assertEquals(CreateOrderInput.safeParse(input).success, true);
});

Deno.test("CreateOrderInput rejects invalid item price formula", () => {
  const input = {
    uid: "testorder10000000000",
    organization: { uid: "testorg1000000000000" },
    status: "draft",
    tax_profile: "tax_applied",
    destinations: [validDestination],
    items: [
      { uid: "dest1000000000000000", type: "destination", name: "Chicago", path: [] },
      { uid: "testitem100000000000", type: "rental", path: ["dest1000000000000000"], price: { formula: "daily" } },
    ],
  };
  assertEquals(CreateOrderInput.safeParse(input).success, false);
});

Deno.test("CreateOrderInput rejects invalid item discount type", () => {
  const input = {
    uid: "testorder10000000000",
    organization: { uid: "testorg1000000000000" },
    status: "draft",
    tax_profile: "tax_applied",
    destinations: [validDestination],
    items: [
      { uid: "dest1000000000000000", type: "destination", name: "Chicago", path: [] },
      { uid: "testitem100000000000", type: "rental", path: ["dest1000000000000000"], price: { discount: { rate: 10, type: "invalid" } } },
    ],
  };
  assertEquals(CreateOrderInput.safeParse(input).success, false);
});

Deno.test("CreateOrderInput accepts item with discount and taxes", () => {
  const input = {
    uid: "testorder10000000000",
    organization: { uid: "testorg1000000000000" },
    status: "draft",
    tax_profile: "tax_applied",
    destinations: [validDestination],
    items: [
      { uid: "dest1000000000000000", type: "destination", name: "Chicago", path: [] },
      {
        uid: "testitem100000000000",
        type: "rental",
        path: ["dest1000000000000000"],
        price: {
          base: 100,
          discount: { rate: 20, type: "percent" },
          taxes: [{ uid: "testchirentaltax0000" }],
        },
      },
    ],
  };
  assertEquals(CreateOrderInput.safeParse(input).success, true);
});

Deno.test("CreateOrderInput accepts item with null discount", () => {
  const input = {
    uid: "testorder10000000000",
    organization: { uid: "testorg1000000000000" },
    status: "draft",
    tax_profile: "tax_applied",
    destinations: [validDestination],
    items: [
      { uid: "dest1000000000000000", type: "destination", name: "Chicago", path: [] },
      { uid: "testitem100000000000", type: "rental", path: ["dest1000000000000000"], price: { discount: null } },
    ],
  };
  assertEquals(CreateOrderInput.safeParse(input).success, true);
});

Deno.test("CreateOrderInput rejects float quantity on items", () => {
  const input = {
    uid: "testorder10000000000",
    organization: { uid: "testorg1000000000000" },
    status: "draft",
    tax_profile: "tax_applied",
    destinations: [validDestination],
    items: [
      { uid: "dest1000000000000000", type: "destination", name: "Chicago", path: [] },
      { uid: "testitem100000000000", type: "rental", path: ["dest1000000000000000"], quantity: 1.5 },
    ],
  };
  assertEquals(CreateOrderInput.safeParse(input).success, false);
});

Deno.test("CreateOrderInput rejects items not starting with destination", () => {
  const input = {
    uid: "testorder10000000000",
    organization: { uid: "testorg1000000000000" },
    status: "draft",
    tax_profile: "tax_applied",
    destinations: [validDestination],
    items: [{ uid: "testitem100000000000", type: "rental", path: [], name: "Camera" }],
  };
  assertEquals(CreateOrderInput.safeParse(input).success, false);
});

Deno.test("CreateOrderInput accepts empty items array", () => {
  const input = {
    uid: "testorder10000000000",
    organization: { uid: "testorg1000000000000" },
    status: "draft",
    tax_profile: "tax_applied",
    destinations: [validDestination],
    items: [],
  };
  assertEquals(CreateOrderInput.safeParse(input).success, true);
});

Deno.test("CreateOrderInput rejects items without type", () => {
  const input = {
    uid: "testorder10000000000",
    organization: { uid: "testorg1000000000000" },
    status: "draft",
    tax_profile: "tax_applied",
    destinations: [validDestination],
    items: [{ uid: "testitem100000000000", path: [], name: "Camera" }],
  };
  assertEquals(CreateOrderInput.safeParse(input).success, false);
});

Deno.test("CreateOrderInput rejects items without path", () => {
  const input = {
    uid: "testorder10000000000",
    organization: { uid: "testorg1000000000000" },
    status: "draft",
    tax_profile: "tax_applied",
    destinations: [validDestination],
    items: [{ uid: "dest1000000000000000", type: "destination", name: "Chicago" }],
  };
  assertEquals(CreateOrderInput.safeParse(input).success, false);
});

// ── UpdateOrderInput ─────────────────────────────────────────────

Deno.test("UpdateOrderInput accepts partial update", () => {
  const input = { status: "active", version: 1 };
  assertEquals(UpdateOrderInput.safeParse(input).success, true);
});

Deno.test("UpdateOrderInput rejects missing version", () => {
  assertEquals(UpdateOrderInput.safeParse({}).success, false);
});

// ── OrderSchema (document) ───────────────────────────────────────

const minimalDoc = {
  ...orderBase,
  uid: "testorder10000000000",
  number: 1001,
  status: "draft",
  organization: {
    uid: null,
    name: "Test Acme Corp",
    xero_id: null,
  },
  destinations: [validDocDestination],
  totals: {
    ...totalsBase,
    subtotal: 100,
    subtotal_discounted: 100,
    total: 100,
  },
  created_at: mockTimestamp,
  updated_at: mockTimestamp,
};

Deno.test("OrderSchema validates a minimal document", () => {
  assertEquals(OrderSchema.safeParse(minimalDoc).success, true);
});

Deno.test("OrderSchema validates a complete document", () => {
  const doc = {
    ...minimalDoc,
    tax_profile: "tax_applied",
    items: [
      {
        uid: "550e8400-e29b-41d4-a716-446655440000",
        type: "destination",
        name: "Test Chicago Office",
        path: [],
        uid_delivery: "testdest100000000000",
        uid_collection: "testdest200000000000",
      },
      {
        uid: "550e8400-e29b-41d4-a716-446655440001",
        type: "group",
        name: "Test Lighting",
        path: ["550e8400-e29b-41d4-a716-446655440000"],
      },
      {
        uid: "testprod100000000000",
        type: "rental",
        name: "Camera",
        path: ["550e8400-e29b-41d4-a716-446655440000", "550e8400-e29b-41d4-a716-446655440001"],
        quantity: 2,
        price: {
          ...priceBase,
          base: 100,
          replacement: 5000,
          chargeable_days: 5,
          subtotal: 200,
          subtotal_discounted: 200,
          taxes: [{
            uid: "testchirentaltax0000",
            name: "Chicago Rental Tax",
            rate: 15,
            type: "percent",
            amount: 30,
          }],
          total: 230,
        },
        stock_method: "bulk",
      },
    ],
    query_by_items: ["testprod100000000000"],
    query_by_contacts: ["testcontact100000000"],
    crms_id: 12345,
    crms_status: "active",
    subject: "Film shoot",
    reference: "PO-123",
  };
  assertEquals(OrderSchema.safeParse(doc).success, true);
});

Deno.test("OrderDocItemPrice round-trips an optional taxes_base snapshot", () => {
  const parsed = OrderDocItemPrice.parse({
    ...priceBase,
    base: 100,
    subtotal: 100,
    subtotal_discounted: 100,
    taxes: [{ uid: "testfrankforttax0000", name: "Frankfort Sales Tax", rate: 8, type: "percent", amount: 8 }],
    taxes_base: [{ uid: "testchisalestax00000", name: "Chicago Sales Tax", rate: 10.25, type: "percent" }],
    total: 108,
  });
  assertEquals(parsed.taxes_base?.length, 1);
  assertEquals(parsed.taxes_base?.[0].uid, "testchisalestax00000");
  // taxes_base is amount-less (TaxRef) — the charged tax stays on `taxes`.
  assertEquals("amount" in (parsed.taxes_base![0] as unknown as Record<string, unknown>), false);
});

Deno.test("OrderDocItemPrice accepts a price without taxes_base (optional, back-compat)", () => {
  // A pre-`taxes_base` doc omits the key entirely — it must still validate and
  // leave taxes_base undefined (no default injected).
  const { taxes_base: _omit, ...withoutBase } = priceBase as Record<string, unknown>;
  const parsed = OrderDocItemPrice.parse(withoutBase);
  assertEquals(parsed.taxes_base, undefined);
});

Deno.test("OrderDocItemPrice rejects an amount on a taxes_base entry (strict TaxRef)", () => {
  const result = OrderDocItemPrice.safeParse({
    ...priceBase,
    taxes_base: [{ uid: "testchisalestax00000", name: "Chicago Sales Tax", rate: 10.25, type: "percent", amount: 10 }],
  });
  assertEquals(result.success, false);
});

Deno.test("OrderSchema rejects non-integer number", () => {
  const doc = { ...minimalDoc, number: 1.5 };
  assertEquals(OrderSchema.safeParse(doc).success, false);
});

Deno.test("OrderSchema rejects additional properties", () => {
  const doc = { ...minimalDoc, bonus_field: true };
  assertEquals(OrderSchema.safeParse(doc).success, false);
});

Deno.test("OrderSchema rejects additional properties on organization", () => {
  const doc = {
    ...minimalDoc,
    organization: { uid: null, name: "Acme", extra: true },
  };
  assertEquals(OrderSchema.safeParse(doc).success, false);
});

Deno.test("OrderSchema rejects additional properties on totals", () => {
  const doc = {
    ...minimalDoc,
    totals: { discount_amount: 0, subtotal: 0, subtotal_discounted: 0, taxes: [], transaction_fees: [], total: 0, extra: 1 },
  };
  assertEquals(OrderSchema.safeParse(doc).success, false);
});

Deno.test("OrderSchema rejects additional properties on destination dates", () => {
  const doc = {
    ...minimalDoc,
    destinations: [{ ...validDocDestination, dates: { ...validDocDates, extra: "nope" } }],
  };
  assertEquals(OrderSchema.safeParse(doc).success, false);
});

Deno.test("OrderSchema rejects missing organization name", () => {
  const doc = {
    ...minimalDoc,
    organization: { uid: null },
  };
  assertEquals(OrderSchema.safeParse(doc).success, false);
});

Deno.test("OrderSchema rejects destination item with non-uuid uid", () => {
  const doc = {
    ...minimalDoc,
    items: [{
      uid: "not-a-uuid",
      type: "destination",
      name: "Test",
      path: [],
      uid_delivery: null,
      uid_collection: null,
    }],
  };
  assertEquals(OrderSchema.safeParse(doc).success, false);
});

Deno.test("OrderSchema rejects group item with non-uuid uid", () => {
  const doc = {
    ...minimalDoc,
    items: [{
      uid: "not-a-uuid",
      type: "group",
      name: "Test Group",
      path: [],
    }],
  };
  assertEquals(OrderSchema.safeParse(doc).success, false);
});

Deno.test("OrderSchema rejects line item with invalid type", () => {
  const doc = {
    ...minimalDoc,
    items: [{ uid: "testprod100000000000", type: "invalid", name: "Thing" }],
  };
  assertEquals(OrderSchema.safeParse(doc).success, false);
});

Deno.test("OrderSchema accepts all doc line item types", () => {
  for (const type of ["rental", "replacement", "sale", "service", "surcharge"]) {
    const doc = {
      ...minimalDoc,
      items: [{
        uid: "testprod100000000000",
        type,
        name: "Thing",
        ...(type === "rental" ? { price: { ...priceBase, replacement: 100 } } : {}),
      }],
    };
    assertEquals(OrderSchema.safeParse(doc).success, true, `type "${type}" should be valid`);
  }
});

Deno.test("OrderSchema rejects rental without price.replacement", () => {
  const doc = {
    ...minimalDoc,
    items: [{ uid: "testprod100000000000", type: "rental", name: "Camera" }],
  };
  assertEquals(OrderSchema.safeParse(doc).success, false);
});

Deno.test("OrderSchema rejects rental with null price.replacement", () => {
  const doc = {
    ...minimalDoc,
    items: [{
      uid: "testprod100000000000",
      type: "rental",
      name: "Camera",
      price: { ...priceBase, replacement: null },
    }],
  };
  assertEquals(OrderSchema.safeParse(doc).success, false);
});

Deno.test("OrderSchema accepts rental with stock_method none and no price.replacement", () => {
  const doc = {
    ...minimalDoc,
    items: [{
      uid: "testprod100000000000",
      type: "rental",
      name: "Service Fee",
      stock_method: "none",
    }],
  };
  assertEquals(OrderSchema.safeParse(doc).success, true);
});

Deno.test("OrderSchema rejects custom line item type", () => {
  const doc = {
    ...minimalDoc,
    items: [{ uid: "testprod100000000000", type: "custom", name: "Thing" }],
  };
  assertEquals(OrderSchema.safeParse(doc).success, false);
});

Deno.test("OrderSchema rejects float chargeable_days in price", () => {
  const doc = {
    ...minimalDoc,
    items: [{
      uid: "testprod100000000000",
      type: "rental",
      name: "Camera",
      price: {
        ...priceBase,
        base: 100,
        chargeable_days: 3.5,
        subtotal: 100,
        subtotal_discounted: 100,
        total: 100,
      },
    }],
  };
  assertEquals(OrderSchema.safeParse(doc).success, false);
});

Deno.test("OrderSchema rejects invalid price formula", () => {
  const doc = {
    ...minimalDoc,
    items: [{
      uid: "testprod100000000000",
      type: "rental",
      name: "Camera",
      price: {
        ...priceBase,
        base: 100,
        formula: "daily",
        subtotal: 100,
        subtotal_discounted: 100,
        total: 100,
      },
    }],
  };
  assertEquals(OrderSchema.safeParse(doc).success, false);
});

Deno.test("OrderSchema rejects invalid discount type", () => {
  const doc = {
    ...minimalDoc,
    items: [{
      uid: "testprod100000000000",
      type: "rental",
      name: "Camera",
      price: {
        ...priceBase,
        base: 100,
        formula: "fixed",
        subtotal: 100,
        subtotal_discounted: 90,
        discount: { rate: 10, type: "invalid", amount: 10 },
        total: 90,
      },
    }],
  };
  assertEquals(OrderSchema.safeParse(doc).success, false);
});

Deno.test("OrderSchema validates destination with contact", () => {
  const doc = {
    ...minimalDoc,
    destinations: [{
      dates: validDocDates,
      delivery: {
        uid: "testdest100000000000",
        address: {
          city: "Chicago",
          country_name: "US",
          full: "123 Main St, Chicago, IL",
          name: "Office",
          postcode: "60601",
          region: "IL",
          street: "123 Main St",
        },
        instructions: "Ring bell",
        contact: {
          uid: "testcontact100000000",
          first_name: "John",
          last_name: "Doe",
          name: "John Doe",
          phones: ["1234567890"],
        },
      },
      collection: {
        uid: null,
        address: null,
        instructions: null,
        contact: null,
      },
    }],
  };
  assertEquals(OrderSchema.safeParse(doc).success, true);
});

Deno.test("OrderSchema rejects doc destination contact missing name", () => {
  const doc = {
    ...minimalDoc,
    destinations: [{
      dates: validDocDates,
      delivery: {
        uid: "testdest100000000000",
        address: null,
        instructions: null,
        contact: { uid: "testcontact100000000" },
      },
      collection: {
        uid: null,
        address: null,
        instructions: null,
        contact: null,
      },
    }],
  };
  assertEquals(OrderSchema.safeParse(doc).success, false);
});

Deno.test("OrderSchema rejects doc destination contact with short phone", () => {
  const doc = {
    ...minimalDoc,
    destinations: [{
      dates: validDocDates,
      delivery: {
        uid: "testdest100000000000",
        address: null,
        instructions: null,
        contact: {
          uid: "testcontact100000000",
          name: "John Doe",
          phones: ["123"],
        },
      },
      collection: {
        uid: null,
        address: null,
        instructions: null,
        contact: null,
      },
    }],
  };
  assertEquals(OrderSchema.safeParse(doc).success, false);
});

Deno.test("OrderSchema rejects reference over 255 chars", () => {
  const doc = { ...minimalDoc, reference: "x".repeat(256) };
  assertEquals(OrderSchema.safeParse(doc).success, false);
});

Deno.test("OrderSchema rejects empty destinations array", () => {
  const doc = { ...minimalDoc, destinations: [] };
  assertEquals(OrderSchema.safeParse(doc).success, false);
});

Deno.test("OrderSchema rejects extra properties on line item price", () => {
  const doc = {
    ...minimalDoc,
    items: [{
      uid: "testprod100000000000",
      type: "rental",
      name: "Camera",
      price: {
        ...priceBase,
        base: 100,
        formula: "fixed",
        subtotal: 100,
        subtotal_discounted: 100,
        total: 100,
        extra: true,
      },
    }],
  };
  assertEquals(OrderSchema.safeParse(doc).success, false);
});

Deno.test("OrderSchema rejects float quantity on line items", () => {
  const doc = {
    ...minimalDoc,
    items: [{ uid: "testprod100000000000", type: "rental", name: "Camera", quantity: 1.5 }],
  };
  assertEquals(OrderSchema.safeParse(doc).success, false);
});

Deno.test("OrderSchema rejects negative quantity on line items", () => {
  const doc = {
    ...minimalDoc,
    items: [{ uid: "testprod100000000000", type: "rental", name: "Camera", quantity: -1 }],
  };
  assertEquals(OrderSchema.safeParse(doc).success, false);
});

Deno.test("OrderSchema accepts valid inclusion_type values", () => {
  for (const val of ["default", "mandatory", "optional", null]) {
    const doc = {
      ...minimalDoc,
      items: [{
        uid: "testprod100000000000",
        type: "rental",
        name: "Camera",
        price: { ...priceBase, replacement: 100 },
        inclusion_type: val,
      }],
    };
    assertEquals(OrderSchema.safeParse(doc).success, true, `inclusion_type "${val}" should be valid`);
  }
});

// ── Status transition helpers ────────────────────────────────────

import {
  getOrderStatusTransitions,
  isValidOrderStatusTransition,
  ORDER_USER_STATUSES,
  ORDER_COMPUTED_STATUSES,
} from "../src/schemas/order.ts";

Deno.test("getOrderStatusTransitions returns the other user statuses for a user status", () => {
  assertEquals(getOrderStatusTransitions("draft"), ["quoted", "reserved", "canceled"]);
  assertEquals(getOrderStatusTransitions("quoted"), ["draft", "reserved", "canceled"]);
  assertEquals(getOrderStatusTransitions("reserved"), ["draft", "quoted", "canceled"]);
  assertEquals(getOrderStatusTransitions("canceled"), ["draft", "quoted", "reserved"]);
});

Deno.test("getOrderStatusTransitions returns [] for computed statuses", () => {
  for (const s of ORDER_COMPUTED_STATUSES) {
    assertEquals(getOrderStatusTransitions(s), [], `expected no manual transitions out of "${s}"`);
  }
});

Deno.test("isValidOrderStatusTransition accepts no-op writes", () => {
  for (const s of [...ORDER_USER_STATUSES, ...ORDER_COMPUTED_STATUSES]) {
    assertEquals(isValidOrderStatusTransition(s, s, "manual"), true, `same-status no-op for "${s}"`);
  }
});

Deno.test("isValidOrderStatusTransition rejects manual writes into computed statuses", () => {
  assertEquals(isValidOrderStatusTransition("reserved", "active", "manual"), false);
  assertEquals(isValidOrderStatusTransition("draft", "active", "manual"), false);
  assertEquals(isValidOrderStatusTransition("quoted", "complete", "manual"), false);
});

Deno.test("isValidOrderStatusTransition rejects manual writes out of computed statuses", () => {
  assertEquals(isValidOrderStatusTransition("active", "reserved", "manual"), false);
  assertEquals(isValidOrderStatusTransition("complete", "draft", "manual"), false);
  assertEquals(isValidOrderStatusTransition("complete", "canceled", "manual"), false);
});

Deno.test("isValidOrderStatusTransition allows propagation writes into computed statuses", () => {
  assertEquals(isValidOrderStatusTransition("reserved", "active", "propagation"), true);
  assertEquals(isValidOrderStatusTransition("active", "complete", "propagation"), true);
  assertEquals(isValidOrderStatusTransition("reserved", "complete", "propagation"), true);
});

Deno.test("isValidOrderStatusTransition allows manual transitions between user statuses", () => {
  assertEquals(isValidOrderStatusTransition("draft", "quoted", "manual"), true);
  assertEquals(isValidOrderStatusTransition("quoted", "reserved", "manual"), true);
  assertEquals(isValidOrderStatusTransition("reserved", "canceled", "manual"), true);
});
