/**
 * Movement schema — the per-kind contract is the thing under test.
 *
 * The contract is what makes a missing axis a validation error rather than a
 * silent zero, so every assertion here comes in pairs: the axis missing when it
 * is required, and the axis present when it is forbidden. A one-sided test would
 * pass against a schema that simply accepted everything.
 */
import { assertEquals } from "@std/assert";
import { getInitialValues } from "../src/schemas/initial.ts";
import {
  CreateStoreTransferInput,
  CreateTransactionInput,
  CUSTODY_PLACE_KINDS,
  getDisplayTransactionTypes,
  getTransactionMultiplier,
  hasCosts,
  MOVEMENT_CONTRACTS,
  MOVEMENT_TYPES,
  MovementSchema,
  type MovementTypeType,
  UpdateTransactionInput,
} from "../src/schemas/transaction.ts";
import { BOOKING_BREAKDOWN_KEYS } from "../src/schemas/booking.ts";
import { mockTimestamp } from "./helpers/timestamp.ts";

const SESSION = "0199a1f2-3b4c-7d8e-9f01-234567890abc";
/** A reversal is a NEW session against the SAME subject — that is the whole id difference. */
const REVERSAL_SESSION = "0199a1f2-3b4c-7d8e-9f01-234567890abd";
const PRODUCT = "testprod100000000000";
const BOOKING = "testordr100000000000:testitem10000000000x:testdest100000000000";
const LOC_A = "testloc1000000000000";
const LOC_B = "testloc2000000000000";
const OOS = "testoos10000000000000".slice(0, 20);

const at = (uid: string) => ({ collection: "locations" as const, uid });
const atBooking = { collection: "bookings" as const, uid: BOOKING };
const atOos = { collection: "out-of-service" as const, uid: OOS };

const base = getInitialValues(MovementSchema) as Record<string, unknown>;

/** A schema-valid movement of `type`, with every axis filled per its contract. */
function movement(type: MovementTypeType, over: Record<string, unknown> = {}) {
  const contract = MOVEMENT_CONTRACTS[type];
  const booking = contract.booking === "forbidden" ? null : BOOKING;
  const custodyNeeded = contract.custody === "required" ||
    (contract.custody === "with_booking" && booking !== null);

  // Pick a custody pair whose implied places match the contract's line places.
  const custodyFor: Partial<Record<MovementTypeType, { from: string | null; to: string | null }>> = {
    prep: { from: "reserved", to: "prepped" },
    check_out: { from: "prepped", to: "out" },
    check_in: { from: "out", to: "returned" },
    mark_damaged: { from: "out", to: "damaged" },
    mark_lost: { from: "out", to: "lost" },
    sale: { from: "prepped", to: "out" },
    sale_return: { from: "out", to: "returned" },
  };

  let lines: unknown[] = [];
  if (contract.places) {
    const place = (kinds: readonly string[]) =>
      kinds[0] === "locations"
        ? at(LOC_A)
        : kinds[0] === "bookings"
        ? atBooking
        : kinds[0] === "out-of-service"
        ? atOos
        : null;
    lines = [{
      quantity: 2,
      location: { from: place(contract.places.from), to: place(contract.places.to) },
    }];
  }

  return {
    ...base,
    uid: `${SESSION}|${type}|${booking ?? PRODUCT}`,
    number: 1,
    uid_product: PRODUCT,
    uid_booking: booking,
    type,
    quantity: 2,
    custody: custodyNeeded ? custodyFor[type] ?? null : null,
    cost: contract.cost === "required" ? { amount: -400, unit_cost: 200, unit_costs: [200, 200] } : null,
    lines,
    date: "2026-03-01T00:00:00Z",
    date_fs: mockTimestamp,
    reference: "test",
    uid_session: SESSION,
    reverses: null,
    serialized_details: null,
    created_by: { uid: "test-bot", name: "Test Bot" },
    updated_by: { uid: "test-bot", name: "Test Bot" },
    created_at: mockTimestamp,
    updated_at: mockTimestamp,
    ...over,
  };
}

// ── the contract holds for every type ───────────────────────────────

Deno.test("every movement type has a contract entry", () => {
  const missing = MOVEMENT_TYPES.filter((t) => !(t in MOVEMENT_CONTRACTS));
  assertEquals(missing, [], `no MOVEMENT_CONTRACTS entry: ${missing.join(", ")}`);
});

Deno.test("MovementSchema accepts a well-formed event of every type", () => {
  for (const type of MOVEMENT_TYPES) {
    const result = MovementSchema.safeParse(movement(type));
    assertEquals(
      result.success,
      true,
      `${type} should parse: ${result.success ? "" : JSON.stringify(result.error.issues)}`,
    );
  }
});

Deno.test("the reversal of every type is writable — its contract is mirrored", () => {
  // A reversal keeps the original's type and negates its lines, so a reversed
  // `sale` runs outside→locations against a table that says locations→outside.
  // Without the mirror, EVERY reversal of a one-directional type is unwritable
  // and the journal has no correction path at all.
  for (const type of MOVEMENT_TYPES) {
    const forward = movement(type);
    const reversal = movement(type, {
      uid: `${REVERSAL_SESSION}|${type}|${forward.uid_booking ?? PRODUCT}`,
      uid_session: REVERSAL_SESSION,
      reverses: forward.uid,
      lines: (forward.lines as Array<{ quantity: number; location: { from: unknown; to: unknown } }>)
        .map((l) => ({ quantity: l.quantity, location: { from: l.location.to, to: l.location.from } })),
      custody: forward.custody
        ? { from: (forward.custody as { to: unknown }).to, to: (forward.custody as { from: unknown }).from }
        : null,
    });
    const result = MovementSchema.safeParse(reversal);
    assertEquals(
      result.success,
      true,
      `reversing ${type} should parse: ${result.success ? "" : JSON.stringify(result.error.issues)}`,
    );
  }
});

Deno.test("a reversal still may not name the WRONG KIND of place", () => {
  // Mirroring is not an exemption. A reversed purchase moves locations→outside;
  // a line claiming it moves out of a BOOKING is still a contract violation.
  const forward = movement("purchase");
  const bogus = movement("purchase", {
    uid: `${REVERSAL_SESSION}|purchase|${PRODUCT}`,
    uid_session: REVERSAL_SESSION,
    reverses: forward.uid,
    lines: [{ quantity: 2, location: { from: atBooking, to: null } }],
  });
  assertEquals(MovementSchema.safeParse(bogus).success, false);
});

Deno.test("MovementSchema rejects an unknown type", () => {
  assertEquals(MovementSchema.safeParse(movement("purchase", { type: "teleport" })).success, false);
});

Deno.test("MovementSchema rejects additional properties", () => {
  assertEquals(MovementSchema.safeParse(movement("purchase", { bogus: true })).success, false);
});

// ── custody axis: missing AND stray both fail ───────────────────────

Deno.test("a type that requires custody rejects its absence", () => {
  for (const type of MOVEMENT_TYPES) {
    if (MOVEMENT_CONTRACTS[type].custody !== "required") continue;
    assertEquals(
      MovementSchema.safeParse(movement(type, { custody: null })).success,
      false,
      `${type} without custody should fail`,
    );
  }
});

Deno.test("a type that forbids custody rejects its presence", () => {
  for (const type of MOVEMENT_TYPES) {
    if (MOVEMENT_CONTRACTS[type].custody !== "forbidden") continue;
    const stray = { custody: { from: "prepped", to: "out" } };
    assertEquals(
      MovementSchema.safeParse(movement(type, stray)).success,
      false,
      `${type} with custody should fail`,
    );
  }
});

Deno.test("write_off carries no custody — the booking keeps `damaged` forever", () => {
  // Removing the key would break sum(breakdown) === quantity. A write-off
  // removes ownership, not history.
  assertEquals(MOVEMENT_CONTRACTS.write_off.custody, "forbidden");
  assertEquals(MovementSchema.safeParse(movement("write_off")).success, true);
  assertEquals(
    MovementSchema.safeParse(movement("write_off", { custody: { from: "damaged", to: null } }))
      .success,
    false,
  );
});

Deno.test("a sale requires custody when booking-scoped and forbids it when not", () => {
  const scoped = movement("sale");
  assertEquals(MovementSchema.safeParse(scoped).success, true);
  assertEquals(MovementSchema.safeParse({ ...scoped, custody: null }).success, false);

  // Off-the-shelf: no booking, so no custody — the 247 stored order-sourced rows
  // and the manual transaction form both need this to be legal.
  const offShelf = {
    ...scoped,
    uid: `${SESSION}|sale|${PRODUCT}`,
    uid_booking: null,
    custody: null,
    lines: [{ quantity: 2, location: { from: at(LOC_A), to: null } }],
  };
  assertEquals(MovementSchema.safeParse(offShelf).success, true);
  assertEquals(
    MovementSchema.safeParse({ ...offShelf, custody: { from: "prepped", to: "out" } }).success,
    false,
    "custody without a booking has no subject",
  );
});

Deno.test("a custody transition must name at least one side", () => {
  assertEquals(
    MovementSchema.safeParse(movement("check_out", { custody: { from: null, to: null } })).success,
    false,
  );
});

Deno.test("a one-sided custody transition is legal (order-edit case)", () => {
  // An order edit changes the booking's own quantity, moving units out of the
  // breakdown with no matching opposite key.
  const doc = movement("check_out", {
    custody: { from: "prepped", to: null },
    lines: [{ quantity: 2, location: { from: at(LOC_A), to: atBooking } }],
  });
  assertEquals(MovementSchema.safeParse(doc).success, true);
});

// ── cost axis ───────────────────────────────────────────────────────

Deno.test("a type that requires cost rejects its absence", () => {
  for (const type of MOVEMENT_TYPES) {
    if (!hasCosts(type)) continue;
    assertEquals(
      MovementSchema.safeParse(movement(type, { cost: null })).success,
      false,
      `${type} without cost should fail`,
    );
  }
});

Deno.test("a type that forbids cost rejects its presence", () => {
  for (const type of MOVEMENT_TYPES) {
    if (hasCosts(type)) continue;
    const stray = { cost: { amount: -400, unit_cost: 200, unit_costs: [200, 200] } };
    assertEquals(
      MovementSchema.safeParse(movement(type, stray)).success,
      false,
      `${type} with cost should fail`,
    );
  }
});

Deno.test("a transfer has no cost object to mis-gate (#286)", () => {
  // #286 was a costed transfer corrupting the basis. Under the contract the
  // corruption is not a bug to gate — it is unwritable.
  assertEquals(MOVEMENT_CONTRACTS.transfer.cost, "forbidden");
  assertEquals(hasCosts("transfer"), false);
  assertEquals(getTransactionMultiplier("transfer"), 0);
});

Deno.test("a no-refund sale_return is cost 0, not cost absent — the zero is the decision", () => {
  const doc = movement("sale_return", { cost: { amount: 0, unit_cost: 0, unit_costs: [] } });
  assertEquals(MovementSchema.safeParse(doc).success, true);
  assertEquals(MovementSchema.safeParse(movement("sale_return", { cost: null })).success, false);
});

// ── lines ───────────────────────────────────────────────────────────

Deno.test("prep moves nothing physically — lines must be empty", () => {
  assertEquals(MOVEMENT_CONTRACTS.prep.places, null);
  assertEquals(MovementSchema.safeParse(movement("prep")).success, true);
  const stray = movement("prep", {
    lines: [{ quantity: 2, location: { from: at(LOC_A), to: at(LOC_B) } }],
  });
  assertEquals(MovementSchema.safeParse(stray).success, false);
});

Deno.test("a type that moves units rejects an empty lines array", () => {
  for (const type of MOVEMENT_TYPES) {
    if (MOVEMENT_CONTRACTS[type].places === null) continue;
    assertEquals(
      MovementSchema.safeParse(movement(type, { lines: [] })).success,
      false,
      `${type} with no lines should fail`,
    );
  }
});

Deno.test("balance rule 1: lines sum to the event quantity", () => {
  const ok = movement("check_out", {
    quantity: 3,
    lines: [
      { quantity: 2, location: { from: at(LOC_A), to: atBooking } },
      { quantity: 1, location: { from: at(LOC_B), to: atBooking } },
    ],
  });
  assertEquals(MovementSchema.safeParse(ok).success, true, "split pick across two shelves");

  const short = { ...ok, quantity: 5 };
  assertEquals(MovementSchema.safeParse(short).success, false);
});

Deno.test("a duplicate location across two lines is legal (#287 dissolves)", () => {
  // Under the old nested stores[]/locations[] shape a repeated uid_location was
  // silently SUMMED into the ledger while location staging collapsed to one
  // last-write-wins doc. Under lines[] it is just two rows.
  const doc = movement("check_out", {
    quantity: 3,
    lines: [
      { quantity: 2, location: { from: at(LOC_A), to: atBooking } },
      { quantity: 1, location: { from: at(LOC_A), to: atBooking } },
    ],
  });
  assertEquals(MovementSchema.safeParse(doc).success, true);
});

Deno.test("a line must move from somewhere, to somewhere, or both", () => {
  const doc = movement("check_out", {
    lines: [{ quantity: 2, location: { from: null, to: null } }],
  });
  assertEquals(MovementSchema.safeParse(doc).success, false);
});

Deno.test("balance rule 2: a line's place must be the kind the type implies", () => {
  // check_out is locations → bookings. A line landing at another location is a
  // transfer, not a checkout.
  const wrongTo = movement("check_out", {
    custody: { from: "prepped", to: null },
    lines: [{ quantity: 2, location: { from: at(LOC_A), to: at(LOC_B) } }],
  });
  assertEquals(MovementSchema.safeParse(wrongTo).success, false);

  const wrongFrom = movement("check_out", {
    lines: [{ quantity: 2, location: { from: atOos, to: atBooking } }],
  });
  assertEquals(MovementSchema.safeParse(wrongFrom).success, false);
});

Deno.test("a DocSource that is not a place is rejected on a line", () => {
  const doc = movement("check_out", {
    lines: [{
      quantity: 2,
      location: { from: { collection: "orders", uid: "testordr100000000000" }, to: atBooking },
    }],
  });
  assertEquals(MovementSchema.safeParse(doc).success, false);
});

Deno.test("balance rule 3: custody and placement must agree on the kind of place", () => {
  // custody.to "returned" implies a locations doc; the line says the booking.
  const doc = movement("check_in", {
    lines: [{ quantity: 2, location: { from: atBooking, to: atBooking } }],
  });
  assertEquals(MovementSchema.safeParse(doc).success, false);
});

Deno.test("a sale drops ownership one-sidedly — that is what drops quantity_held", () => {
  assertEquals(MOVEMENT_CONTRACTS.sale.places?.to, ["outside"]);
  assertEquals(getTransactionMultiplier("sale"), -1);
  const doc = movement("sale");
  assertEquals(MovementSchema.safeParse(doc).success, true);
  assertEquals(doc.lines.length, 1);
});

Deno.test("CUSTODY_PLACE_KINDS covers every breakdown key", () => {
  const missing = BOOKING_BREAKDOWN_KEYS.filter((k) => !(k in CUSTODY_PLACE_KINDS));
  assertEquals(missing, [], `no CUSTODY_PLACE_KINDS entry: ${missing.join(", ")}`);
});

Deno.test("`out` is the one custody key whose place depends on the booking type", () => {
  // A rental's units sit at the booking; a sale's left ownership at the sale.
  assertEquals([...CUSTODY_PLACE_KINDS.out].sort(), ["bookings", "outside"]);
});

// ── booking subject ─────────────────────────────────────────────────

Deno.test("a booking-scoped type requires uid_booking", () => {
  for (const type of MOVEMENT_TYPES) {
    if (MOVEMENT_CONTRACTS[type].booking !== "required") continue;
    assertEquals(
      MovementSchema.safeParse(movement(type, { uid_booking: null })).success,
      false,
      `${type} without uid_booking should fail`,
    );
  }
});

Deno.test("an ownership-only type forbids uid_booking", () => {
  for (const type of MOVEMENT_TYPES) {
    if (MOVEMENT_CONTRACTS[type].booking !== "forbidden") continue;
    assertEquals(
      MovementSchema.safeParse(movement(type, { uid_booking: BOOKING })).success,
      false,
      `${type} with uid_booking should fail`,
    );
  }
});

// ── identity ────────────────────────────────────────────────────────

Deno.test("uid is the derived composite — there is no auto-id alternative", () => {
  assertEquals(MovementSchema.safeParse(movement("check_out")).success, true);
  // The corpus is re-keyed by the migration rather than carried: uid_session is
  // required on every movement anyway, so a historical row gets a session and
  // therefore a derived id too.
  const autoId = movement("purchase", { uid: "legacytxn00000000000" });
  assertEquals(MovementSchema.safeParse(autoId).success, false);
});

Deno.test("uid rejects a malformed derived id", () => {
  for (
    const bad of [
      `${SESSION}|check_out`, // missing subject
      `${SESSION}|check_out|${PRODUCT}|extra`, // the arity trap
      `not-a-uuid|check_out|${PRODUCT}`,
      `${SESSION}|Check_Out|${PRODUCT}`,
    ]
  ) {
    assertEquals(
      MovementSchema.safeParse(movement("check_out", { uid: bad })).success,
      false,
      `${bad} should be rejected`,
    );
  }
});

Deno.test("uid_session must be a uuid", () => {
  assertEquals(
    MovementSchema.safeParse(movement("check_out", { uid_session: "session-1" })).success,
    false,
  );
});

// ── multiplier + display ────────────────────────────────────────────

Deno.test("getTransactionMultiplier is total — it never throws", () => {
  for (const type of MOVEMENT_TYPES) {
    const m = getTransactionMultiplier(type);
    assertEquals([1, -1, 0].includes(m), true, `${type} returned ${m}`);
  }
});

Deno.test("getTransactionMultiplier returns 1 for types that add owned stock", () => {
  for (const type of ["purchase", "make", "find", "opening_balance", "adjustment_increase"] as const) {
    assertEquals(getTransactionMultiplier(type), 1, `${type} should return 1`);
  }
});

Deno.test("getTransactionMultiplier returns -1 for types that remove owned stock", () => {
  for (const type of ["sale", "trade_in", "write_off", "adjustment_decrease"] as const) {
    assertEquals(getTransactionMultiplier(type), -1, `${type} should return -1`);
  }
});

Deno.test("getTransactionMultiplier returns 0 for movements that do not change ownership", () => {
  for (const type of ["prep", "check_out", "check_in", "mark_damaged", "mark_lost", "transfer"] as const) {
    assertEquals(getTransactionMultiplier(type), 0, `${type} should return 0`);
  }
});

Deno.test("getDisplayTransactionTypes hides booking-scoped and transfer types", () => {
  const shown = getDisplayTransactionTypes();
  for (const hidden of ["prep", "check_out", "check_in", "mark_damaged", "mark_lost", "transfer", "opening_balance"]) {
    assertEquals(shown.includes(hidden as MovementTypeType), false, `${hidden} should be hidden`);
  }
  assertEquals(shown.includes("purchase"), true);
  assertEquals(shown.includes("sale"), true);
});

Deno.test("getDisplayTransactionTypes(true) offers only stock-adding types", () => {
  for (const t of getDisplayTransactionTypes(true)) {
    assertEquals(getTransactionMultiplier(t), 1, `${t} should add stock`);
  }
});

// ── input schemas ───────────────────────────────────────────────────

const validCreateInput = {
  uid_product: PRODUCT,
  type: "purchase",
  quantity: 10,
  total_cost: 2500,
  date: "2026-03-01T00:00:00Z",
  reference: "PO-001",
  uid_session: SESSION,
};

Deno.test("CreateTransactionInput accepts an event with no allocations (server allocates)", () => {
  assertEquals(CreateTransactionInput.safeParse(validCreateInput).success, true);
});

Deno.test("CreateTransactionInput accepts an explicit multi-location allocation", () => {
  const input = {
    ...validCreateInput,
    allocations: [{ uid_location: LOC_A, quantity: 6 }, { uid_location: LOC_B, quantity: 4 }],
  };
  assertEquals(CreateTransactionInput.safeParse(input).success, true);
});

Deno.test("CreateTransactionInput repeats a location freely — it is two rows, not a duplicate", () => {
  const input = {
    ...validCreateInput,
    allocations: [{ uid_location: LOC_A, quantity: 6 }, { uid_location: LOC_A, quantity: 4 }],
  };
  assertEquals(CreateTransactionInput.safeParse(input).success, true);
});

Deno.test("CreateTransactionInput requires a session and never honours a client uid", () => {
  const { uid_session: _drop, ...noSession } = validCreateInput;
  assertEquals(CreateTransactionInput.safeParse(noSession).success, false);

  // The document id is derived (`{uid_session}|{type}|{subject}`), which is what
  // makes a retried create idempotent. A client-supplied `uid` is stripped by the
  // non-strict input object rather than 400'd — what matters is that it cannot
  // reach the writer and displace the derived id.
  const parsed = CreateTransactionInput.safeParse({
    ...validCreateInput,
    uid: "testtxn1000000000000",
  });
  assertEquals(parsed.success, true);
  assertEquals(Object.keys(parsed.success ? parsed.data : {}).includes("uid"), false);
});

Deno.test("CreateTransactionInput rejects booking-scoped types — the picker writes those", () => {
  for (const type of ["check_out", "check_in", "prep", "mark_damaged", "mark_lost", "transfer"]) {
    assertEquals(
      CreateTransactionInput.safeParse({ ...validCreateInput, type }).success,
      false,
      `${type} should not be operator-keyable`,
    );
  }
});

Deno.test("UpdateTransactionInput carries no balance-affecting field", () => {
  assertEquals(UpdateTransactionInput.safeParse({ reference: "note", version: 3 }).success, true);
  for (const balance of [{ quantity: 5 }, { type: "sale" }, { total_cost: 10 }, { date: "2026-03-01T00:00:00Z" }]) {
    const result = UpdateTransactionInput.safeParse({ reference: "note", version: 3, ...balance });
    assertEquals(result.success, true, "unknown keys are stripped, not accepted");
    assertEquals(
      Object.keys(result.success ? result.data : {}).sort(),
      ["reference", "version"],
      `${JSON.stringify(balance)} must not survive parsing`,
    );
  }
});

Deno.test("CreateStoreTransferInput is one event with both sides", () => {
  const input = {
    uid_product: PRODUCT,
    quantity: 4,
    date: "2026-03-01T00:00:00Z",
    reference: "move",
    uid_session: SESSION,
    from: [{ uid_location: LOC_A, quantity: 4 }],
    to: [{ uid_location: LOC_B, quantity: 4 }],
  };
  assertEquals(CreateStoreTransferInput.safeParse(input).success, true);
  assertEquals(CreateStoreTransferInput.safeParse({ ...input, to: [] }).success, false);
  // No total_cost: a transfer nets to zero on ownership.
  const costed = CreateStoreTransferInput.safeParse({ ...input, total_cost: 100 });
  assertEquals(
    Object.keys(costed.success ? costed.data : {}).includes("total_cost"),
    false,
  );
});
