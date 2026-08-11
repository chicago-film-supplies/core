import { assertEquals } from "@std/assert";
import { getInitialValues } from "../src/schemas/initial.ts";
import { CreateOrderInput, Discount, DiscountInput, DocDestination, isLineItem, OrderDocDates, OrderDocItem, type OrderDocItemType, OrderDocItemPrice, OrderItem, OrderSchema, UpdateOrderInput } from "../src/schemas/order.ts";
import { mockTimestamp } from "./helpers/timestamp.ts";

// `uid_thread` is a branded `ThreadId`; the schema walk seeds string leaves as
// `""`, which it rejects. Supply a real id, as every prod doc carries one.
const orderBase = { ...getInitialValues(OrderSchema), uid_thread: "testthread0000000001" } as Record<string, unknown>;
const totalsBase = orderBase.totals as Record<string, unknown>;
const datesBase = getInitialValues(OrderDocDates) as Record<string, unknown>;
const destBase = getInitialValues(DocDestination) as Record<string, unknown>;
const priceBase = getInitialValues(OrderDocItemPrice) as Record<string, unknown>;

/**
 * A minimal VALID stored line item, for the `OrderSchema` / `OrderDocItem` cases
 * below. Each case overrides exactly the field it is about, so the ONLY invalid
 * thing in the payload is the thing under test.
 *
 * That property used to be implicit and W5 broke it: making `price` and
 * `stock_method` required turned every negative fixture that omitted them into a
 * test passing for the wrong reason — "rejects a float `chargeable_days`" would
 * have gone green on a missing `stock_method` and never reached the price at all.
 *
 * `stock_method: "none"` is the default because it is the one value that needs no
 * `price.replacement`, which keeps a case about anything else minimal.
 */
const docLine = (over: Record<string, unknown> = {}) => ({
  uid: "testprod100000000000",
  type: "rental",
  name: "Camera",
  stock_method: "none",
  price: priceBase,
  ...over,
});

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
          base_cents: 10000,
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
    // Required since api-cloudrun#489 — a stored snapshot always carries the
    // customer's profile, so a fixture without one is not a document any writer
    // can produce.
    tax_profile: "tax_applied",
  },
  destinations: [validDocDestination],
  totals: {
    ...totalsBase,
    subtotal_cents: 10000,
    subtotal_discounted_cents: 10000,
    total_cents: 10000,
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
          base_cents: 10000,
          replacement_cents: 500000,
          chargeable_days: 5,
          subtotal_cents: 20000,
          subtotal_discounted_cents: 20000,
          taxes: [{
            uid: "testchirentaltax0000",
            name: "Chicago Rental Tax",
            rate: 15,
            type: "percent",
            amount_cents: 3000,
          }],
          total_cents: 23000,
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
    base_cents: 10000,
    subtotal_cents: 10000,
    subtotal_discounted_cents: 10000,
    taxes: [{ uid: "testfrankforttax0000", name: "Frankfort Sales Tax", rate: 8, type: "percent", amount_cents: 800 }],
    taxes_base: [{ uid: "testchisalestax00000", name: "Chicago Sales Tax", rate: 10.25, type: "percent" }],
    total_cents: 10800,
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
    taxes_base: [{ uid: "testchisalestax00000", name: "Chicago Sales Tax", rate: 10.25, type: "percent", amount_cents: 1000 }],
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
    totals: { discount_amount_cents: 0, subtotal_cents: 0, subtotal_discounted_cents: 0, taxes: [], transaction_fees: [], total_cents: 0, extra: 1 },
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
    const doc = { ...minimalDoc, items: [docLine({ type, name: "Thing" })] };
    assertEquals(OrderSchema.safeParse(doc).success, true, `type "${type}" should be valid`);
  }
});

Deno.test("OrderSchema requires price and stock_method on a stored line item", () => {
  // W5. Both were `.optional()` while no writer had ever omitted either —
  // 0 of 9,303 prod line items were missing one — so three call sites
  // downstream were compensating for a shape that does not exist.
  for (const field of ["price", "stock_method"]) {
    const item = docLine();
    delete (item as Record<string, unknown>)[field];
    const r = OrderSchema.safeParse({ ...minimalDoc, items: [item] });
    assertEquals(r.success, false, `omitting "${field}" should be rejected`);
    assertEquals(r.error?.issues[0].path, ["items", 0, field]);
  }
});

Deno.test("OrderSchema rejects rental without price.replacement_cents", () => {
  const doc = { ...minimalDoc, items: [docLine({ stock_method: "bulk" })] };
  assertEquals(OrderSchema.safeParse(doc).success, false);
});

Deno.test("OrderSchema rejects rental with null price.replacement_cents", () => {
  const doc = {
    ...minimalDoc,
    items: [docLine({ stock_method: "bulk", price: { ...priceBase, replacement_cents: null } })],
  };
  assertEquals(OrderSchema.safeParse(doc).success, false);
});

Deno.test("OrderSchema accepts rental with stock_method none and no price.replacement_cents", () => {
  const doc = { ...minimalDoc, items: [docLine({ name: "Service Fee" })] };
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
    items: [docLine({
      price: {
        ...priceBase,
        base_cents: 10000,
        chargeable_days: 3.5,
        subtotal_cents: 10000,
        subtotal_discounted_cents: 10000,
        total_cents: 10000,
      },
    })],
  };
  assertEquals(OrderSchema.safeParse(doc).success, false);
});

Deno.test("OrderSchema rejects invalid price formula", () => {
  const doc = {
    ...minimalDoc,
    items: [docLine({
      price: {
        ...priceBase,
        base_cents: 10000,
        formula: "daily",
        subtotal_cents: 10000,
        subtotal_discounted_cents: 10000,
        total_cents: 10000,
      },
    })],
  };
  assertEquals(OrderSchema.safeParse(doc).success, false);
});

Deno.test("OrderSchema rejects invalid discount type", () => {
  const doc = {
    ...minimalDoc,
    items: [docLine({
      price: {
        ...priceBase,
        base_cents: 10000,
        formula: "fixed",
        subtotal_cents: 10000,
        subtotal_discounted_cents: 9000,
        discount: { rate: 10, type: "invalid", amount_cents: 1000 },
        total_cents: 9000,
      },
    })],
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
    items: [docLine({
      price: {
        ...priceBase,
        base_cents: 10000,
        formula: "fixed",
        subtotal_cents: 10000,
        subtotal_discounted_cents: 10000,
        total_cents: 10000,
        extra: true,
      },
    })],
  };
  assertEquals(OrderSchema.safeParse(doc).success, false);
});

Deno.test("OrderSchema rejects float quantity on line items", () => {
  const doc = {
    ...minimalDoc,
    items: [docLine({ quantity: 1.5 })],
  };
  assertEquals(OrderSchema.safeParse(doc).success, false);
});

Deno.test("OrderSchema rejects negative quantity on line items", () => {
  const doc = {
    ...minimalDoc,
    items: [docLine({ quantity: -1 })],
  };
  assertEquals(OrderSchema.safeParse(doc).success, false);
});

Deno.test("OrderSchema accepts valid inclusion_type values", () => {
  for (const val of ["default", "mandatory", "optional", null]) {
    const doc = {
      ...minimalDoc,
      items: [docLine({ inclusion_type: val })],
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

// ── Discount rate bounds ──────────────────────────────────────────
//
// `rate` means two different things depending on `type`, so a single
// `.min(0).max(100)` would be wrong. For `percent` it is a percentage and must
// sit in [0, 100] — Xero's `DiscountRate` rejects anything else, and
// `calculateItemSubtotal` would otherwise drive `subtotal_discounted` above the
// subtotal or below zero. For `flat` it is dollars per unit per pricing factor
// (`rate × quantity × pricingFactor === amount`), so it is unbounded above.

Deno.test("Discount: percent rate must be within [0, 100]", () => {
  assertEquals(Discount.safeParse({ type: "percent", rate: 0, amount_cents: 0 }).success, true);
  assertEquals(Discount.safeParse({ type: "percent", rate: 50, amount_cents: 1000 }).success, true);
  assertEquals(Discount.safeParse({ type: "percent", rate: 100, amount_cents: 1000 }).success, true);
  assertEquals(Discount.safeParse({ type: "percent", rate: 100.01, amount_cents: 1000 }).success, false);
  assertEquals(Discount.safeParse({ type: "percent", rate: -0.01, amount_cents: 1000 }).success, false);
});

Deno.test("Discount: flat rate is per-unit dollars — unbounded above, never negative", () => {
  // A $150/unit discount on a $200/unit line is legal; capping at 100 would ban it.
  assertEquals(Discount.safeParse({ type: "flat", rate: 150, amount_cents: 30000 }).success, true);
  assertEquals(Discount.safeParse({ type: "flat", rate: 0, amount_cents: 0 }).success, true);
  assertEquals(Discount.safeParse({ type: "flat", rate: -1, amount_cents: 0 }).success, false);
});

Deno.test("Discount: computed amount is never negative", () => {
  assertEquals(Discount.safeParse({ type: "percent", rate: 10, amount_cents: -100 }).success, false);
});

Deno.test("DiscountInput: same rate bounds as the stored discount", () => {
  assertEquals(DiscountInput.safeParse({ type: "percent", rate: 100 }).success, true);
  assertEquals(DiscountInput.safeParse({ type: "percent", rate: 101 }).success, false);
  assertEquals(DiscountInput.safeParse({ type: "percent", rate: -1 }).success, false);
  assertEquals(DiscountInput.safeParse({ type: "flat", rate: 150 }).success, true);
  assertEquals(DiscountInput.safeParse({ type: "flat", rate: -1 }).success, false);
});

Deno.test("Discount: the rate error names the field, not the object", () => {
  const r = Discount.safeParse({ type: "percent", rate: 120, amount_cents: 1000 });
  assertEquals(r.success, false);
  if (!r.success) assertEquals(r.error.issues[0].path, ["rate"]);
});

// ── transaction_fee: one claimant, one price shape ───────────────────

const feeLine = {
  uid: "77LKBYcC09u1PZFhxmDJ",
  type: "transaction_fee",
  name: "Credit Card Processing Fee",
  description: "",
  quantity: 1,
  path: ["77LKBYcC09u1PZFhxmDJ"],
  // A fee holds no stock, and W5 requires every line type to say so rather than
  // exempting the fee with a contract axis. `"none"` is the honest value.
  stock_method: "none",
  // A `percent_of_total` fee carries its rate in `base_percent` (a 4dp
  // percentage), never in `base_cents` — D1's split, enforced by
  // `checkPriceBaseUnit`. 3% here, not $3.00.
  price: { ...priceBase, base_cents: 0, base_percent: 3, formula: "percent_of_total" },
};

Deno.test("OrderDocItem: a transaction_fee is an ordinary line item", () => {
  const r = OrderDocItem.safeParse(feeLine);
  assertEquals(r.success, true, JSON.stringify(r.error?.issues));
});

Deno.test("OrderDocItem: the old PriceModifier fee price is now unrepresentable", () => {
  // The shape `OrderDocTransactionFeeItem` used to accept. It parsed before
  // because a second arm claimed the same discriminator; `isLineItem` then
  // handed callers a `price` with no `taxes`, and `xeroQuotes` read
  // `price.taxes[0]` off it. There is one claimant now, so this is a 400.
  const r = OrderDocItem.safeParse({
    ...feeLine,
    price: { uid: "77LKBYcC09u1PZFhxmDJ", name: "Card Fee", rate: 3, type: "percent", amount_cents: 0 },
  });
  assertEquals(r.success, false);
});

Deno.test("OrderDocItem: a wrong field lands on the field, not the whole item", () => {
  // The reason to discriminate at all: an undiscriminated union reports
  // `items.N: Invalid input` because every arm failed. A DU picks the arm off
  // `type` first, so the issue names the field the author actually got wrong.
  const r = OrderDocItem.safeParse({ ...feeLine, price: { ...priceBase, base_cents: "three" } });
  assertEquals(r.success, false);
  if (!r.success) assertEquals(r.error.issues[0].path, ["price", "base_cents"]);
});

Deno.test("OrderDocItem: a divider carrying a price is rejected on the divider arm", () => {
  const r = OrderDocItem.safeParse({
    uid: "3f1e2d4c-5b6a-4789-8c9d-0e1f2a3b4c5d",
    type: "group",
    name: "Lighting",
    description: "",
    path: ["3f1e2d4c-5b6a-4789-8c9d-0e1f2a3b4c5d"],
    price: priceBase,
  });
  assertEquals(r.success, false);
  if (!r.success) assertEquals(r.error.issues[0].code, "unrecognized_keys");
});

Deno.test("OrderDocItem: an unknown type reports at `type`, not as a whole-item failure", () => {
  const r = OrderDocItem.safeParse({ ...feeLine, type: "gratuity" });
  assertEquals(r.success, false);
  if (!r.success) assertEquals(r.error.issues[0].path, ["type"]);
});

Deno.test("OrderDocLineItem: the rental replacement refine still fires inside the union", () => {
  // `.refine()` on a DU arm survives — and reports at its declared path rather
  // than collapsing to the union root.
  const r = OrderDocItem.safeParse({
    ...feeLine,
    type: "rental",
    stock_method: "bulk",
    price: { ...priceBase, base_cents: 1000, formula: "fixed" },
  });
  assertEquals(r.success, false);
  if (!r.success) assertEquals(r.error.issues[0].path, ["price", "replacement_cents"]);
});

Deno.test("isLineItem narrows a transaction_fee to the one line-item shape", () => {
  const item = OrderDocItem.parse(feeLine) as OrderDocItemType;
  assertEquals(isLineItem(item), true);
  // Sound now: the narrowed type really does carry an OrderDocItemPrice, so
  // reading `price.taxes` cannot hit a PriceModifier that never had one.
  if (isLineItem(item)) assertEquals(item.price?.taxes, []);
});

// ── ITEM_CONTRACTS at the schema boundary ────────────────────────

Deno.test("percent_of_total is inexpressible on a non-fee line", () => {
  // It used to be merely THROWN ON, at runtime, inside `perUnitSubtotal` —
  // reachable only once the totals pass ran. The contract makes it unwritable.
  const bad = OrderDocItem.safeParse(
    docLine({
      type: "sale",
      name: "Gel Pack",
      // `base_percent` supplied so this fixture is wrong in exactly ONE way.
      // Without it `checkPriceBaseUnit` also fires and issues[0] becomes
      // ["price","base_percent"] — a true issue, but not the one under test.
      price: { ...priceBase, base_cents: 0, base_percent: 3, formula: "percent_of_total" },
    }),
  );
  assertEquals(bad.success, false);
  assertEquals(bad.error?.issues[0].path, ["price", "formula"]);

  // The fee is the one type priced from the document total.
  assertEquals(
    OrderDocItem.safeParse(docLine({
      uid: "testfee1000000000000",
      type: "transaction_fee",
      name: "Card Fee",
      price: { ...priceBase, base_cents: 0, base_percent: 3, formula: "percent_of_total" },
    })).success,
    true,
  );
  // ...and a flat-amount fee stays legal: the converse is deliberately not asserted.
  assertEquals(
    OrderDocItem.safeParse(docLine({
      uid: "testfee1000000000000",
      type: "transaction_fee",
      name: "Card Fee",
      price: { ...priceBase, formula: "fixed" },
    })).success,
    true,
  );
});

Deno.test("a transaction_fee cannot carry price.replacement_cents", () => {
  const bad = OrderDocItem.safeParse(docLine({
    uid: "testfee1000000000000",
    type: "transaction_fee",
    name: "Card Fee",
    price: { ...priceBase, replacement_cents: 10000 },
  }));
  assertEquals(bad.success, false);
  assertEquals(bad.error?.issues[0].path, ["price", "replacement_cents"]);
});

Deno.test("the contract check still reports at its declared path inside the union", () => {
  // `.superRefine` replaced a hand-written `.refine`; a DU arm's check must
  // still emit at ["price","replacement_cents"] rather than at the union root.
  const bad = OrderDocItem.safeParse({
    uid: "testprod100000000000",
    type: "rental",
    name: "Camera",
    stock_method: "bulk",
    price: { ...priceBase, replacement_cents: null },
  });
  assertEquals(bad.success, false);
  assertEquals(bad.error?.issues[0].path, ["price", "replacement_cents"]);

  // Unchanged escape hatch: a rental holding no stock needs no replacement value.
  assertEquals(
    OrderDocItem.safeParse({
      uid: "testprod100000000000",
      type: "rental",
      name: "Camera",
      stock_method: "none",
      price: { ...priceBase, replacement_cents: null },
    }).success,
    true,
  );
});

// ── OrderItem (input) — the discriminated boundary ────────────────

Deno.test("OrderItem: a divider cannot carry a price or a quantity", () => {
  // The flat input schema accepted every line field on every type, so this
  // payload parsed and only failed at `validateBeforeWrite`, as an
  // `unrecognized_keys` complaint about the STORED shape.
  const bad = OrderItem.safeParse({
    uid: "dest1000000000000000",
    type: "destination",
    name: "Chicago",
    path: [],
    quantity: 3,
    price: { base_cents: 10000 },
  });
  assertEquals(bad.success, false);
  assertEquals(bad.error?.issues[0].code, "unrecognized_keys");

  const badGroup = OrderItem.safeParse({
    uid: "group100000000000000",
    type: "group",
    name: "Lighting",
    path: ["dest1000000000000000"],
    stock_method: "bulk",
  });
  assertEquals(badGroup.success, false);
});

Deno.test("OrderItem: a line item still ships back with its stored extras", () => {
  // The line arm is deliberately NOT strict — the manager PUTs `items` whole
  // from a store holding stored doc items, so a line arrives carrying computed
  // price fields, `crms_id` and `taxes_base`. Those are stripped, as they always
  // were; tightening this arm would 400 every such client.
  const ok = OrderItem.safeParse({
    uid: "testitem100000000000",
    type: "rental",
    name: "Camera",
    quantity: 2,
    path: ["dest1000000000000000"],
    price: { base_cents: 10000, subtotal_cents: 20000, total_cents: 22000, taxes: [{ uid: "tax10000000000000000" }] },
    crms_id: 4021,
    taxes_base: [{ uid: "tax10000000000000000", name: "Chicago", rate: 9, type: "percent" }],
  });
  assertEquals(ok.success, true);
  const parsed = ok.data as { crms_id?: unknown; taxes_base?: unknown };
  assertEquals(parsed.crms_id, undefined);
  assertEquals(parsed.taxes_base, undefined);
});

Deno.test("OrderItem: percent_of_total is inexpressible on an input line too", () => {
  const bad = OrderItem.safeParse({
    uid: "testitem100000000000",
    type: "rental",
    name: "Camera",
    path: [],
    price: { base_percent: 3, formula: "percent_of_total" },
  });
  assertEquals(bad.success, false);
  assertEquals(bad.error?.issues[0].path, ["price", "formula"]);

  assertEquals(
    OrderItem.safeParse({
      uid: "testfee1000000000000",
      type: "transaction_fee",
      name: "Card Fee",
      path: [],
      price: { base_percent: 3, formula: "percent_of_total" },
    }).success,
    true,
  );
});

Deno.test("OrderItem: the input does NOT enforce the replacement axis", () => {
  // Deliberate: `required_when_stocked` keys on `stock_method`, which the server
  // reads off the product, not off the payload. Enforcing it here would reject a
  // legal rental line for an unstocked product. Storage still enforces it.
  assertEquals(
    OrderItem.safeParse({
      uid: "testitem100000000000",
      type: "rental",
      name: "Camera",
      path: [],
      price: { base_cents: 10000 },
    }).success,
    true,
  );
});

Deno.test("OrderItem: a bad discriminator reports at ['type']", () => {
  const bad = OrderItem.safeParse({ uid: "testitem100000000000", type: "nonsense", path: [] });
  assertEquals(bad.success, false);
  assertEquals(bad.error?.issues[0].path, ["type"]);
});
