/**
 * Serialized-unit SCHEMAS (api-cloudrun serial-tracking P2): the unit and
 * roster documents, the unit sets on bookings and out-of-service records, and
 * the inputs that name units. One negative case per refine, each built from a
 * minimal valid document and breaking exactly one thing, so a refine deleted
 * later turns its case red rather than leaving it failing for some other
 * reason.
 */
import { assert, assertEquals } from "@std/assert";
import {
  BookingAction,
  BookingSchema,
  CreateOutOfServiceInput,
  CreateTransactionInput,
  CreateUnitsInput,
  MovementAllocationInput,
  OutOfServiceSchema,
  StoreTransferLineInput,
  UnitRosterEntry,
  UnitRosterSchema,
  UnitSchema,
  UnitSet,
  UpdateOutOfServiceInput,
  UpdateUnitInput,
} from "../src/schemas/mod.ts";
import { getTestDoc, type TestDocOptionsWithNow } from "../src/schemas/testing.ts";
import { mockTimestamp } from "./helpers/timestamp.ts";
import { fid } from "./helpers/ids.ts";

const P1 = fid("product1");
const L1 = fid("location1");
const L2 = fid("location2");
const OOS1 = fid("record1");

const NOW: TestDocOptionsWithNow = { now: mockTimestamp };
const UUID = "0b6c5f3e-7a2d-4c1e-9f8a-3d2b1c0e9f8a";
const ACTOR = { uid: "u1", name: "Op" };

function issues(result: { success: boolean; error?: { issues: { message: string; path: PropertyKey[] }[] } }) {
  return result.success ? [] : result.error!.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
}

function assertRefused(result: Parameters<typeof issues>[0], needle: string) {
  const found = issues(result);
  assert(!result.success, `expected a refusal mentioning "${needle}"`);
  assert(found.some((m) => m.includes(needle)), `expected "${needle}" in ${JSON.stringify(found)}`);
}

// ── UnitSet ──────────────────────────────────────────────────────────

Deno.test("UnitSet: ascending and unique, refused rather than normalized", () => {
  assert(UnitSet.safeParse([]).success);
  assert(UnitSet.safeParse([1001, 1002, 1045]).success);
  assertRefused(UnitSet.safeParse([1002, 1001]), "ascending");
  assertRefused(UnitSet.safeParse([1001, 1001]), "named twice");
  assert(!UnitSet.safeParse([0]).success, "0 is not a unit number");
  assert(!UnitSet.safeParse([1.5]).success, "a unit number is an integer");
});

// ── Unit ─────────────────────────────────────────────────────────────

function activeUnit() {
  return {
    uid: "unit-1001",
    uid_product: "0q6NhsjASVnRH5PqKLKP",
    number: 1001,
    serial_number: "SN-A",
    serial_history: [{
      serial_number: "SN-A",
      start: "2026-10-03T09:00:00.000-05:00",
      end: null as string | null,
      reason: "initial",
      uid_movement: null,
      notes: "",
      changed_by: ACTOR,
    }],
    status: "active",
    version: 0,
    created_by: ACTOR,
    updated_by: ACTOR,
    created_at: mockTimestamp,
    updated_at: mockTimestamp,
  };
}

Deno.test("Unit: a minimal active unit parses, and getTestDoc builds one with no override", () => {
  assertEquals(issues(UnitSchema.safeParse(activeUnit())), []);
  assert(UnitSchema.safeParse(getTestDoc(UnitSchema, {}, NOW)).success);
});

Deno.test("Unit: at most one serial history entry is open", () => {
  const u = activeUnit();
  u.serial_history.push({ ...u.serial_history[0], serial_number: "SN-B" });
  assertRefused(UnitSchema.safeParse(u), "at most one current serial");
});

Deno.test("Unit: serial_number is the open entry's serial", () => {
  assertRefused(UnitSchema.safeParse({ ...activeUnit(), serial_number: "SN-Z" }), "open history entry's serial");
});

Deno.test("Unit: a vacant number carries no serial and no open entry", () => {
  assertRefused(UnitSchema.safeParse({ ...activeUnit(), status: "vacant" }), "carries no serial");
  const closed = activeUnit();
  closed.serial_history[0].end = "2026-10-04T09:00:00.000-05:00";
  assertEquals(issues(UnitSchema.safeParse({ ...closed, serial_number: null, status: "vacant" })), []);
});

Deno.test("Unit: the id is unit-{number} with no zero and no leading zero", () => {
  assert(!UnitSchema.safeParse({ ...activeUnit(), uid: "unit-0" }).success);
  assert(!UnitSchema.safeParse({ ...activeUnit(), uid: "unit-01001" }).success);
});

Deno.test("CreateUnitsInput: count and explicit arms, neither carries a serial", () => {
  assert(CreateUnitsInput.safeParse({ mode: "count", count: 10, uuid_session: UUID }).success);
  assert(CreateUnitsInput.safeParse({ mode: "explicit", numbers: [1001, 1002], uuid_session: UUID }).success);
  assert(!CreateUnitsInput.safeParse({ mode: "count", count: 401, uuid_session: UUID }).success, "count is capped");
  assertRefused(CreateUnitsInput.safeParse({ mode: "explicit", numbers: [], uuid_session: UUID }), "at least one");
  assertRefused(CreateUnitsInput.safeParse({ mode: "explicit", numbers: [1002, 1001], uuid_session: UUID }), "ascending");
  const parsed = CreateUnitsInput.parse({ mode: "count", count: 1, uuid_session: UUID, serial_number: "X" });
  assert(!("serial_number" in parsed), "an input strips a serial rather than carrying it");
});

Deno.test("UpdateUnitInput: must change something; may only retire", () => {
  assertRefused(UpdateUnitInput.safeParse({ version: 0 }), "send a serial change");
  assert(UpdateUnitInput.safeParse({ version: 0, status: "retired" }).success);
  assert(!UpdateUnitInput.safeParse({ version: 0, status: "active" }).success);
  assert(
    UpdateUnitInput.safeParse({ version: 0, serial: { serial_number: "SN", reason: "replaced", notes: "" } }).success,
  );
});

// ── UnitRoster ───────────────────────────────────────────────────────

Deno.test("UnitRosterEntry: a flagged shelf unit names its record, an unflagged one names none", () => {
  const shelf = { state: "shelf", uid_location: L1, flag: null, uid_out_of_service: null };
  assert(UnitRosterEntry.safeParse(shelf).success);
  assertRefused(UnitRosterEntry.safeParse({ ...shelf, flag: "damaged" }), "names the record");
  assertRefused(UnitRosterEntry.safeParse({ ...shelf, uid_out_of_service: OOS1 }), "names the record");
  assert(UnitRosterEntry.safeParse({ ...shelf, flag: "damaged", uid_out_of_service: OOS1 }).success);
});

Deno.test("UnitRosterEntry: a loss record's MovementId-shaped id is accepted as away", () => {
  assert(UnitRosterEntry.safeParse({
    state: "away",
    uid_out_of_service: `${UUID}|mark_lost|0q6NhsjASVnRH5PqKLKP`,
  }).success);
});

Deno.test("UnitRoster: keys are unit numbers; an empty roster is valid", () => {
  const roster = { uid: P1, uid_product: P1, units: {}, created_at: mockTimestamp, updated_at: mockTimestamp };
  assert(UnitRosterSchema.safeParse(roster).success);
  assert(!UnitRosterSchema.safeParse({ ...roster, units: { "01001": { state: "unattributed_out" } } }).success);
  assert(UnitRosterSchema.safeParse({ ...roster, units: { "1001": { state: "unattributed_out" } } }).success);
});

// ── Booking ──────────────────────────────────────────────────────────

const EMPTY_SETS = { cleaning: [], damaged: [], lost: [], maintenance: [], out: [], prepped: [], returned: [] };

function booking(units: unknown, breakdown: Record<string, number> = {}) {
  const base = getTestDoc(BookingSchema, {}, NOW) as unknown as Record<string, unknown>;
  return {
    ...base,
    breakdown: { ...(base.breakdown as Record<string, number>), ...breakdown },
    units,
  };
}

Deno.test("Booking.units: absent, null and empty sets all parse", () => {
  const base = getTestDoc(BookingSchema, {}, NOW);
  assert(BookingSchema.safeParse(base).success);
  assert(BookingSchema.safeParse(booking(null)).success);
  assert(BookingSchema.safeParse(booking(EMPTY_SETS)).success);
});

Deno.test("Booking.units: a bucket names at most as many units as it holds", () => {
  assert(BookingSchema.safeParse(booking({ ...EMPTY_SETS, out: [1001] }, { out: 2 })).success, "fewer = untracked");
  assertRefused(BookingSchema.safeParse(booking({ ...EMPTY_SETS, out: [1001, 1002] }, { out: 1 })), "names 2 units but holds 1");
});

Deno.test("Booking.units: a unit is in one bucket at a time", () => {
  assertRefused(
    BookingSchema.safeParse(booking({ ...EMPTY_SETS, out: [1001], returned: [1001] }, { out: 1, returned: 1 })),
    "is in both",
  );
});

Deno.test("Booking.units: quoted and reserved hold no named units", () => {
  assert(!BookingSchema.safeParse(booking({ ...EMPTY_SETS, reserved: [1001] }, { reserved: 1 })).success);
});

// ── BookingAction ────────────────────────────────────────────────────

Deno.test("BookingAction: units, when named, are exactly `quantity` and canonical", () => {
  assert(BookingAction.safeParse({ rule: "prep", quantity: 2, units: [1001, 1002] }).success);
  assert(BookingAction.safeParse({ rule: "prep", quantity: 2 }).success, "a bulk action names none");
  assertRefused(BookingAction.safeParse({ rule: "prep", quantity: 3, units: [1001, 1002] }), "exactly `quantity`");
  assertRefused(BookingAction.safeParse({ rule: "prep", quantity: 2, units: [1002, 1001] }), "ascending");
});

// ── Out-of-service ───────────────────────────────────────────────────

const EMPTY_OOS = { away: [], flagged: [], returned_to_service: [], written_off: [] };

function record(units: unknown, breakdown: Record<string, number>) {
  const base = getTestDoc(OutOfServiceSchema, {}, NOW) as unknown as Record<string, unknown>;
  return { ...base, quantity: 5, breakdown: { ...(base.breakdown as Record<string, number>), ...breakdown }, units };
}

Deno.test("OutOfService.units: ≤ per bucket, and disjoint", () => {
  assert(OutOfServiceSchema.safeParse(record(null, {})).success);
  assert(OutOfServiceSchema.safeParse(record({ ...EMPTY_OOS, flagged: [1001] }, { flagged: 2 })).success);
  assertRefused(
    OutOfServiceSchema.safeParse(record({ ...EMPTY_OOS, away: [1001, 1002] }, { away: 1 })),
    "names 2 units but holds 1",
  );
  assertRefused(
    OutOfServiceSchema.safeParse(record({ ...EMPTY_OOS, away: [1001], written_off: [1001] }, { away: 1, written_off: 1 })),
    "is in both",
  );
});

Deno.test("CreateOutOfServiceInput: units ≤ quantity, and allocations partition them", () => {
  const base = { uid_product: P1, reason: "damaged", quantity: 2, dates: {}, uuid_session: UUID };
  assert(CreateOutOfServiceInput.safeParse({ ...base, units: [1001, 1002] }).success);
  assertRefused(CreateOutOfServiceInput.safeParse({ ...base, units: [1001, 1002, 1003] }), "names 3 units");
  const alloc = (uid_location: string, units: number[]) => ({ uid_location, quantity: units.length, units });
  assert(CreateOutOfServiceInput.safeParse({
    ...base,
    units: [1001, 1002],
    allocations: [alloc(L1, [1002]), alloc(L2, [1001])],
  }).success);
  assertRefused(
    CreateOutOfServiceInput.safeParse({ ...base, units: [1001, 1002], allocations: [alloc(L1, [1001]), alloc(L2, [1003])] }),
    "exactly the input's units",
  );
  assertRefused(
    CreateOutOfServiceInput.safeParse({
      ...base,
      units: [1001, 1002],
      allocations: [alloc(L1, [1001]), { uid_location: L2, quantity: 1 }],
    }),
    "every allocation must",
  );
});

Deno.test("UpdateOutOfServiceInput: units travel with the breakdown they name", () => {
  const base = { uuid_session: UUID, version: 0 };
  const breakdown = { flagged: 1, away: 0, written_off: 1, returned_to_service: 0 };
  assert(UpdateOutOfServiceInput.safeParse({ ...base, breakdown, units: { ...EMPTY_OOS, written_off: [1001] } }).success);
  assertRefused(UpdateOutOfServiceInput.safeParse({ ...base, units: EMPTY_OOS }), "sent with the breakdown");
  assertRefused(
    UpdateOutOfServiceInput.safeParse({ ...base, breakdown, units: { ...EMPTY_OOS, away: [1001] } }),
    "names 1 units but holds 0",
  );
});

// ── Ownership and transfer inputs ────────────────────────────────────

const txBase = {
  uid_product: P1,
  quantity: 2,
  total_cost_cents: 0,
  date: "2026-10-03T09:00:00.000-05:00",
  reference: "",
  uuid_session: UUID,
};

Deno.test("CreateTransactionInput: units are `quantity`, ascending, each once", () => {
  assert(CreateTransactionInput.safeParse({ ...txBase, type: "find", units: [{ number: 1001 }, { number: 1002 }] }).success);
  assertRefused(CreateTransactionInput.safeParse({ ...txBase, type: "find", units: [{ number: 1001 }] }), "exactly `quantity`");
  assertRefused(
    CreateTransactionInput.safeParse({ ...txBase, type: "find", units: [{ number: 1002 }, { number: 1001 }] }),
    "ascending",
  );
});

Deno.test("CreateTransactionInput: a serial only on a unit coming IN", () => {
  const withSerial = [{ number: 1001, serial_number: "SN-A" }, { number: 1002 }];
  assert(CreateTransactionInput.safeParse({ ...txBase, type: "find", units: withSerial }).success);
  assertRefused(
    CreateTransactionInput.safeParse({ ...txBase, type: "adjustment_decrease", units: withSerial }),
    "names units by number only",
  );
});

Deno.test("CreateTransactionInput: allocations' units partition the input's", () => {
  const units = [{ number: 1001 }, { number: 1002 }];
  assert(CreateTransactionInput.safeParse({
    ...txBase,
    type: "find",
    units,
    allocations: [{ uid_location: L1, quantity: 2, units: [1001, 1002] }],
  }).success);
  assertRefused(
    CreateTransactionInput.safeParse({
      ...txBase,
      type: "find",
      allocations: [{ uid_location: L1, quantity: 2, units: [1001, 1002] }],
    }),
    "must list them too",
  );
});

Deno.test("MovementAllocationInput / StoreTransferLineInput: units are exactly `quantity`", () => {
  assertRefused(MovementAllocationInput.safeParse({ uid_location: L1, quantity: 2, units: [1001] }), "exactly `quantity`");
  const line = { from: L1, to: L2, quantity: 2, oos: null };
  assert(StoreTransferLineInput.safeParse({ ...line, units: [1001, 1002] }).success);
  assertRefused(StoreTransferLineInput.safeParse({ ...line, units: [1001] }), "exactly `quantity`");
});
