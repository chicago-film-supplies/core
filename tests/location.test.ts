import { assertEquals } from "@std/assert";
import { getInitialValues } from "../src/schemas/initial.ts";
import {
  CreateLocationInput,
  LocationSchema,
  SetLocationProductDefaultInput,
  UpdateLocationInput,
} from "../src/schemas/location.ts";
import { locationRole, type StoreBreakdownLocation, StoreBreakdownLocationSchema } from "../src/schemas/common.ts";
import { mockTimestamp } from "./helpers/timestamp.ts";

const locationBase = getInitialValues(LocationSchema) as Record<string, unknown>;

const validLocation = {
  ...locationBase,
  uid: "testloc1000000000000",
  uid_store: "teststore10000000000",
  name: "Aisle A",
  default: true,
  active: true,
  product_capacities: [{ uid: "testp100000000000000", max: 50, max_default: 40 }],
  query_by_product_capacities: ["testp100000000000000"],
  products: [{ uid: "testp100000000000000", name: "LED Panel", quantity: 10, default: true }],
  query_by_products: ["testp100000000000000"],
  created_at: mockTimestamp,
  updated_at: mockTimestamp,
};

Deno.test("LocationSchema validates a complete document", () => {
  assertEquals(LocationSchema.safeParse(validLocation).success, true);
});

// Was `LocationSchema defaults arrays when omitted`, asserting that all four of
// these could be dropped and still parse. That assertion was the DEFAULT'S OWN
// SPEC: `query_by_product_capacities` / `query_by_products` are derived denorms
// that `services/locations.ts` writes on every create, so the default never put
// a value anywhere — it only licensed a writer to omit one (core#95).
// Rewritten as its mirror rather than deleted, one dropped key at a time so each
// case names the constraint it tests instead of failing for some reason.
// `product_capacities` / `products` are deliberately NOT asserted either way:
// they are still catalogued backlog, and pinning their current defaults here
// would just recreate this test for the next batch to undo.
Deno.test("LocationSchema requires the query_by_* denorms", async (t) => {
  for (const key of ["query_by_product_capacities", "query_by_products"] as const) {
    await t.step(`rejects a document missing ${key}`, () => {
      const { [key]: _dropped, ...doc } = validLocation;
      assertEquals(LocationSchema.safeParse(doc).success, false);
    });
  }
});

Deno.test("default: retiring — a location without the store-pointer copy parses (api-cloudrun#1302 phase 5)", () => {
  const { default: _dropped, ...doc } = validLocation;
  assertEquals(LocationSchema.safeParse(doc).success, true);
  // Still a boolean while present: retiring is not loosening its type.
  assertEquals(LocationSchema.safeParse({ ...doc, default: "yes" }).success, false);
});

Deno.test("LocationSchema rejects missing uid_store", () => {
  const { uid_store: _, ...doc } = validLocation;
  assertEquals(LocationSchema.safeParse(doc).success, false);
});

Deno.test("LocationSchema accepts null max_default", () => {
  const doc = {
    ...validLocation,
    product_capacities: [{ uid: "testp100000000000000", max: 50, max_default: null }],
  };
  assertEquals(LocationSchema.safeParse(doc).success, true);
});

Deno.test("LocationSchema rejects additional properties", () => {
  const doc = { ...validLocation, bogus: true };
  assertEquals(LocationSchema.safeParse(doc).success, false);
});

// ── role (api-cloudrun#1302) ─────────────────────────────────────

Deno.test("role: required on the document — a location without one is refused, naming role", () => {
  // api-cloudrun#1302 phase 3: every stored location was backfilled first.
  const { role: _role, ...noRole } = validLocation as Record<string, unknown>;
  const parsed = LocationSchema.safeParse(noRole);
  assertEquals(parsed.success, false);
  assertEquals(parsed.error!.issues.map((i) => i.path.join(".")), ["role"]);
  // The helper still reads an absent role as storage, for the ledger's copy.
  assertEquals(locationRole({}), "storage");
});

Deno.test("role: staging and storage parse; anything else is refused", () => {
  assertEquals(locationRole(LocationSchema.parse({ ...validLocation, role: "staging" })), "staging");
  assertEquals(locationRole(LocationSchema.parse({ ...validLocation, role: "storage" })), "storage");
  assertEquals(LocationSchema.safeParse({ ...validLocation, role: "vehicle" }).success, false);
});

Deno.test("role: the ledger copy is optional too, and absent reads as storage", () => {
  const loc: StoreBreakdownLocation = {
    uid_location: "testloc1000000000000",
    name: "A",
    quantity: 1,
    default: false,
    max: null,
  };
  assertEquals(StoreBreakdownLocationSchema.safeParse(loc).success, true);
  assertEquals(locationRole(loc), "storage");
  assertEquals(StoreBreakdownLocationSchema.safeParse({ ...loc, role: "staging" }).success, true);
  assertEquals(StoreBreakdownLocationSchema.safeParse({ ...loc, role: "home" }).success, false);
});

Deno.test("role: the create and update inputs accept it optionally", () => {
  const create = { uid: "testloc1000000000000", uid_store: "teststore10000000000", name: "Staging - Van" };
  assertEquals(CreateLocationInput.safeParse(create).success, true);
  assertEquals(CreateLocationInput.parse({ ...create, role: "staging" }).role, "staging");
  assertEquals(CreateLocationInput.safeParse({ ...create, role: "van" }).success, false);
  assertEquals(UpdateLocationInput.parse({ uid: create.uid, role: "staging", version: 0 }).role, "staging");
});

Deno.test("SetLocationProductDefaultInput: set or clear one product's flag at one location", () => {
  const base = { uid: "testloc1000000000000", uid_product: "testp100000000000000", default: true, version: 3 };
  assertEquals(SetLocationProductDefaultInput.safeParse(base).success, true);
  assertEquals(SetLocationProductDefaultInput.safeParse({ ...base, default: false }).success, true);
  for (const key of ["uid", "uid_product", "default", "version"] as const) {
    const { [key]: _dropped, ...rest } = base;
    const parsed = SetLocationProductDefaultInput.safeParse(rest);
    assertEquals(parsed.success, false, key);
    assertEquals(parsed.error!.issues.map((i) => i.path.join(".")), [key]);
  }
});
