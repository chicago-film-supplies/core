import { assertEquals } from "@std/assert";
import {
  CreateDepartmentTypeInput,
  DepartmentTypeSchema,
  foldDepartmentTypeName,
  UpdateDepartmentTypeInput,
} from "../src/schemas/department-type.ts";
import { mockTimestamp } from "./helpers/timestamp.ts";

const actor = { uid: "testuser100000000000", name: "Test User" };

/**
 * A MINIMAL VALID department type, so every negative case below fails for
 * exactly the reason it names — the discipline `tests/organization.test.ts`
 * records two of its own siblings having lacked.
 */
const validDepartmentType = (overrides: Record<string, unknown> = {}) => ({
  uid: "testdept100000000000",
  name: "Locations",
  name_key: "locations",
  active: true,
  created_by: actor,
  updated_by: actor,
  created_at: mockTimestamp,
  updated_at: mockTimestamp,
  ...overrides,
});

Deno.test("DepartmentTypeSchema validates a complete document", () => {
  assertEquals(DepartmentTypeSchema.safeParse(validDepartmentType()).success, true);
});

Deno.test("DepartmentTypeSchema requires `active` — a `.default()` never materializes on a write", () => {
  // `validateBeforeWrite` writes the RAW document and discards `result.data`, so
  // `location-type.ts`'s `.default(true)` leaves the stored key simply absent.
  // `organization.ts` records the identical trap on `tax_exempt`.
  const { active: _omitted, ...withoutActive } = validDepartmentType();
  assertEquals(DepartmentTypeSchema.safeParse(withoutActive).success, false);
});

Deno.test("DepartmentTypeSchema rejects an empty name — the vocabulary's whole job is a real term", () => {
  assertEquals(DepartmentTypeSchema.safeParse(validDepartmentType({ name: "" })).success, false);
});

Deno.test("DepartmentTypeSchema requires an ActorRef pair — not inlined, not omitted", () => {
  // `location-types` is the only member of this family with no actor, and that
  // is why it is not the template.
  const { created_by: _a, ...noCreatedBy } = validDepartmentType();
  assertEquals(DepartmentTypeSchema.safeParse(noCreatedBy).success, false);
  const { updated_by: _b, ...noUpdatedBy } = validDepartmentType();
  assertEquals(DepartmentTypeSchema.safeParse(noUpdatedBy).success, false);
});

Deno.test("DepartmentTypeSchema rejects additional properties", () => {
  // Deliberately no `count`, no `crms_id` and no `xero_id`. Removing a field
  // from a `z.strictObject` later is writer-stop → corpus-strip → schema-pin,
  // across two repos, in that order; adding one is a single commit.
  for (const key of ["count", "crms_id", "xero_id"]) {
    assertEquals(
      DepartmentTypeSchema.safeParse(validDepartmentType({ [key]: 1 })).success,
      false,
      `a stored ${key} is refused as an unknown key`,
    );
  }
});

Deno.test("CreateDepartmentTypeInput takes a name and nothing else", () => {
  assertEquals(CreateDepartmentTypeInput.safeParse({ name: "Set Dec" }).success, true);
  assertEquals(CreateDepartmentTypeInput.safeParse({ name: "" }).success, false);
});

Deno.test("UpdateDepartmentTypeInput is how a type is DEACTIVATED — there is no delete route", () => {
  assertEquals(UpdateDepartmentTypeInput.safeParse({ uid: "testdept100000000000", active: false, version: 3 }).success, true);
  assertEquals(UpdateDepartmentTypeInput.safeParse({ uid: "testdept100000000000", name: "Transportation", version: 3 }).success, true);
  assertEquals(UpdateDepartmentTypeInput.safeParse({ uid: "testdept100000000000" }).success, false, "`version` is required — optimistic concurrency, as everywhere else");
});

Deno.test("foldDepartmentTypeName trims and lower-cases — how a duplicate actually presents", () => {
  assertEquals(foldDepartmentTypeName("  Transportation "), "transportation");
  assertEquals(foldDepartmentTypeName("Set Dec"), foldDepartmentTypeName("set dec"));
});

Deno.test("DepartmentTypeSchema requires name_key — the guard's equality query cannot see a document without it", () => {
  const { name_key: _omitted, ...withoutKey } = validDepartmentType();
  const result = DepartmentTypeSchema.safeParse(withoutKey);
  assertEquals(result.success, false);
  assertEquals(result.error?.issues.map((i) => i.path.join(".")), ["name_key"]);
});

Deno.test("DepartmentTypeSchema refuses a name_key that disagrees with name — a stale key is a lock on the wrong entry", () => {
  const result = DepartmentTypeSchema.safeParse(validDepartmentType({ name: "Office", name_key: "locations" }));
  assertEquals(result.success, false);
  assertEquals(result.error?.issues.map((i) => i.path.join(".")), ["name_key"]);
});
