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
const BOOKING = "testordr100000000000:testitem10000000000x:9c2f4a10-6b3d-4e57-8a91-0d5e7c3b2f48";
const LOC_A = "testloc1000000000000";
const LOC_B = "testloc2000000000000";
const OOS = "testoos10000000000000".slice(0, 20);

const at = (uid: string) => ({ collection: "locations" as const, uid });
const atBooking = { collection: "bookings" as const, uid: BOOKING };
const atOos = { collection: "out-of-service" as const, uid: OOS };

const SUPPLIER = "testsupp100000000000";
const base = getInitialValues(MovementSchema) as Record<string, unknown>;

/** A schema-valid movement of `type`, with every axis filled per its contract. */
function movement(type: MovementTypeType, over: Record<string, unknown> = {}) {
  const contract = MOVEMENT_CONTRACTS[type];
  const booking = contract.booking === "forbidden" ? null : BOOKING;
  const custodyNeeded = contract.custody === "required" ||
    (contract.custody === "with_booking" && booking !== null);

  // Pick a custody pair whose implied places match the contract's line places.
  // TOTAL over `MOVEMENT_TYPES`, deliberately — it was `Partial` with a `?? null`
  // fallback, so adding a custody-bearing type left the fixture silently
  // custody-less and the failure arrived as an assertion about the SCHEMA
  // ("unprep requires a custody transition") rather than about the missing
  // fixture. A total record makes the next one a compile error at this
  // declaration. The `forbidden` types carry an explicit null for the same
  // reason: so "no custody" is stated rather than defaulted.
  const custodyFor: Record<MovementTypeType, { from: string | null; to: string | null } | null> = {
    prep: { from: "reserved", to: "prepped" },
    check_out: { from: "prepped", to: "out" },
    check_in: { from: "out", to: "returned" },
    mark_damaged: { from: "out", to: "damaged" },
    mark_lost: { from: "out", to: "lost" },
    // Each the mirror of its forward twin above.
    unprep: { from: "prepped", to: "reserved" },
    check_out_undo: { from: "out", to: "prepped" },
    check_in_undo: { from: "returned", to: "out" },
    mark_lost_undo: { from: "lost", to: "out" },
    mark_damaged_undo: { from: "damaged", to: "out" },
    sale: { from: "prepped", to: "out" },
    sale_return: { from: "out", to: "returned" },
    opening_balance: null,
    purchase: null,
    find: null,
    make: null,
    adjustment_increase: null,
    adjustment_decrease: null,
    trade_in: null,
    write_off: null,
    reclass_out: null,
    reclass_in: null,
    transfer: null,
    return_to_service: null,
    // `with_booking`: the fixture attaches a booking, so it names the one
    // custody change a flag can carry — a damaged return found on the shelf.
    flag: { from: "returned", to: "damaged" },
    send_away: null,
  };

  // TOTAL for the same reason as `custodyFor`. `null` on every type whose
  // contract makes the axis optional or forbidden, so "no service change" is
  // stated rather than defaulted.
  const serviceFor: Record<MovementTypeType, { from: string | null; to: string | null } | null> = {
    prep: null,
    check_out: null,
    check_in: null,
    mark_damaged: null,
    mark_lost: null,
    unprep: null,
    check_out_undo: null,
    check_in_undo: null,
    mark_lost_undo: null,
    mark_damaged_undo: null,
    sale: null,
    sale_return: null,
    opening_balance: null,
    purchase: null,
    find: null,
    make: null,
    adjustment_increase: null,
    adjustment_decrease: null,
    trade_in: null,
    write_off: null,
    reclass_out: null,
    reclass_in: null,
    transfer: null,
    return_to_service: null,
    flag: { from: null, to: "damaged" },
    send_away: { from: null, to: "lost" },
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
    custody: custodyNeeded ? custodyFor[type] : null,
    service: serviceFor[type],
    cost: contract.cost === "required" ? { amount_cents: -40000, unit_cost: 200, unit_costs_cents: [200, 200] } : null,
    // ⚠️ A `purchase` MUST carry one — `base` comes from `getInitialValues`,
    // which resolves a nullable to `null`, and a stored purchase with an
    // explicit `null` supplier is exactly what the schema now refuses. This is
    // the documented "a form seed may not parse" contract biting a fixture.
    supplier: type === "purchase" ? { uid: SUPPLIER, name: "Test Supplier" } : null,
    lines,
    date: "2026-03-01T00:00:00Z",
    date_fs: mockTimestamp,
    reference: "test",
    uuid_session: SESSION,
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

Deno.test("a stored purchase with an explicit null supplier is REFUSED", () => {
  const result = MovementSchema.safeParse({ ...movement("purchase"), supplier: null });
  assertEquals(result.success, false);
  assertEquals(
    result.success ? [] : result.error.issues.map((i) => i.path.join(".")),
    ["supplier"],
  );
});

Deno.test("...but a stored purchase with NO supplier KEY is accepted — the historical corpus", () => {
  // 🔴 The load-bearing arm. Measured 2026-08-31: of 76 prod / 111 dev
  // `purchase` movements, exactly ONE in each carries a `supplier` key at all.
  // A rule written as `== null` or `"supplier" in doc` reads all 75 remaining
  // prod documents as violations — and it is REACHABLE, not theoretical:
  // `reverseTransaction` copies the original's supplier onto a new movement of
  // the same type, so reversing any historical purchase would throw, and
  // reversal is the journal's only correction path.
  //
  // Both wrong predicates were written before this arm existed, and this is
  // what caught them.
  const { supplier: _absent, ...noKey } = movement("purchase");
  assertEquals(MovementSchema.safeParse(noKey).success, true);
});

Deno.test("...and a non-purchase with a null supplier is accepted — the fail-closed companion", () => {
  // Without this, the rule passes just as well written as "supplier must never
  // be null", which would refuse every `find`, `write_off` and custody step —
  // all of which `movementScaffold` stamps `supplier: null` on by design.
  for (const type of ["find", "write_off", "check_out", "transfer"] as const) {
    assertEquals(
      MovementSchema.safeParse({ ...movement(type), supplier: null }).success,
      true,
      `${type} carries no payable, so a null supplier is its normal state`,
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
      uuid_session: REVERSAL_SESSION,
      reverses: forward.uid,
      lines: (forward.lines as Array<{ quantity: number; location: { from: unknown; to: unknown } }>)
        .map((l) => ({ quantity: l.quantity, location: { from: l.location.to, to: l.location.from } })),
      custody: forward.custody
        ? { from: (forward.custody as { to: unknown }).to, to: (forward.custody as { from: unknown }).from }
        : null,
      // Swapped end for end, exactly as custody is: the reversal's lines leave
      // where the original's landed, so each side's reason travels with them.
      service: forward.service ? { from: forward.service.to, to: forward.service.from } : null,
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
    uuid_session: REVERSAL_SESSION,
    reverses: forward.uid,
    lines: [{ quantity: 2, location: { from: atBooking, to: null } }],
  });
  assertEquals(MovementSchema.safeParse(bogus).success, false);
});

Deno.test("a mark undo's contract is its forward twin's, swapped end for end (api-cloudrun#1094)", () => {
  // Mirrored EXACTLY, including `mark_lost`'s widened origin: a loss may come
  // off the booking OR a shelf (api-cloudrun#1118), so its undo must be able to
  // put the unit back at either. A narrower undo would cost a second publish.
  for (const [undo, forward] of [["mark_lost_undo", "mark_lost"], ["mark_damaged_undo", "mark_damaged"]] as const) {
    const f = MOVEMENT_CONTRACTS[forward];
    const u = MOVEMENT_CONTRACTS[undo];
    assertEquals(u.places, { from: f.places!.to, to: f.places!.from }, `${undo} places`);
    assertEquals(
      { custody: u.custody, cost: u.cost, booking: u.booking },
      { custody: f.custody, cost: f.cost, booking: f.booking },
      `${undo} axes`,
    );
  }
});

Deno.test("mark_lost_undo may return a shelf-sourced loss to its shelf (`lost → returned`)", () => {
  const doc = movement("mark_lost_undo", {
    custody: { from: "lost", to: "returned" },
    lines: [{ quantity: 2, location: { from: atOos, to: at(LOC_A) } }],
  });
  const result = MovementSchema.safeParse(doc);
  assertEquals(result.success, true, result.success ? "" : JSON.stringify(result.error.issues));
});

Deno.test("a mark undo may not name the wrong kind of place", () => {
  // `damaged` is a STATE on a shelf, so its undo draws from `locations` — a line
  // drawing it from the record is the `lost` shape, and is refused.
  const bogusDamaged = movement("mark_damaged_undo", {
    lines: [{ quantity: 2, location: { from: atOos, to: atBooking } }],
  });
  assertEquals(MovementSchema.safeParse(bogusDamaged).success, false);
  // And a lost unit found again never left ownership, so it cannot re-enter it.
  const bogusLost = movement("mark_lost_undo", {
    custody: { from: "lost", to: null },
    lines: [{ quantity: 2, location: { from: null, to: at(LOC_A) } }],
  });
  assertEquals(MovementSchema.safeParse(bogusLost).success, false);
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
    const stray = { cost: { amount_cents: -40000, unit_cost: 200, unit_costs_cents: [200, 200] } };
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
  const doc = movement("sale_return", { cost: { amount_cents: 0, unit_cost: 0, unit_costs_cents: [] } });
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
  // The corpus is re-keyed by the migration rather than carried: uuid_session is
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

Deno.test("uuid_session must be a uuid", () => {
  assertEquals(
    MovementSchema.safeParse(movement("check_out", { uuid_session: "session-1" })).success,
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
  for (
    const type of [
      "prep",
      "check_out",
      "check_in",
      "mark_damaged",
      "mark_lost",
      "mark_lost_undo",
      "mark_damaged_undo",
      "transfer",
    ] as const
  ) {
    assertEquals(getTransactionMultiplier(type), 0, `${type} should return 0`);
  }
});

Deno.test("getDisplayTransactionTypes hides booking-scoped and transfer types", () => {
  const shown = getDisplayTransactionTypes();
  for (
    const hidden of [
      "prep",
      "check_out",
      "check_in",
      "mark_damaged",
      "mark_lost",
      "mark_lost_undo",
      "mark_damaged_undo",
      "transfer",
      "opening_balance",
    ]
  ) {
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

/**
 * The invariant the sibling tests above could not see (core#41).
 *
 * They enumerate which types must be hidden — a list that stays green while the
 * picker offers something the API refuses, because "is `sale_return` hidden?"
 * was never one of the questions asked. The relationship that actually matters
 * is **⊆**: every type the manager renders must be one `CreateTransactionInput`
 * accepts. Asserted by running the real schema rather than by comparing against
 * a second copy of the list, so it cannot drift into a restatement.
 *
 * `sale_return` was the live instance: it has no *required* booking, so it
 * passed the old `MOVEMENT_CONTRACTS`-derived filter and reached the picker,
 * while `MANUAL_MOVEMENT_TYPES` refused it — an operator picking it got a 400.
 */
// ── input schemas ───────────────────────────────────────────────────

// ⚠️ Carries a `supplier` because its type is `purchase`, and a purchase
// without one is now REJECTED. Every test below spreads this, so leaving it out
// would turn each of them into "fails for SOME reason" — the exact shape that
// lets a constraint be deleted with the suite still green.
const validCreateInput = {
  uid_product: PRODUCT,
  type: "purchase",
  quantity: 10,
  total_cost_cents: 250000,
  date: "2026-03-01T00:00:00Z",
  reference: "PO-001",
  uuid_session: SESSION,
  supplier: { uid: SUPPLIER },
};

Deno.test("every displayed transaction type is one CreateTransactionInput accepts", () => {
  for (const type of getDisplayTransactionTypes()) {
    const parsed = CreateTransactionInput.safeParse({ ...validCreateInput, type });
    assertEquals(
      parsed.success,
      true,
      `the picker offers "${type}" but CreateTransactionInput rejects it — an operator ` +
        `choosing it gets a 400. Either add it to MANUAL_MOVEMENT_TYPES or stop displaying it.`,
    );
  }
});

/** The same relation for the first-transaction subset. */
Deno.test("every increaseOnly transaction type is one CreateTransactionInput accepts", () => {
  for (const type of getDisplayTransactionTypes(true)) {
    const parsed = CreateTransactionInput.safeParse({ ...validCreateInput, type });
    assertEquals(parsed.success, true, `increaseOnly offers "${type}" but the input rejects it`);
  }
});

/**
 * The deliberate asymmetry, pinned so it is not "tidied" into symmetry.
 * `opening_balance` is ACCEPTED by the input and hidden from the picker, because
 * it is minted at product creation rather than keyed. Hiding an accepted type
 * costs nothing; offering a rejected one is a dead end in the UI.
 */
Deno.test("opening_balance is accepted by the input but deliberately not displayed", () => {
  assertEquals(
    CreateTransactionInput.safeParse({ ...validCreateInput, type: "opening_balance" }).success,
    true,
  );
  assertEquals(getDisplayTransactionTypes().includes("opening_balance"), false);
});


Deno.test("CreateTransactionInput REJECTS a purchase with no supplier", () => {
  // A purchase's offset is real Accounts Payable and the document total IS the
  // payable, so the bill must name somebody. The only other candidate is the
  // adjustment placeholder, which is the defect the movement-bill channel exists
  // to retire. Prod #1161 is the worked example: a real $2.00 purchase that
  // silently posted nothing because it named no supplier.
  const { supplier: _dropped, ...noSupplier } = validCreateInput;
  const parsed = CreateTransactionInput.safeParse(noSupplier);
  assertEquals(parsed.success, false);
  // Pathed at the FIELD, so the manager renders it on the picker rather than as
  // a form-level message the operator has to map back themselves.
  assertEquals(parsed.error?.issues.some((i) => i.path.join(".") === "supplier"), true);

  // An explicit null is the same answer as absent — the manager's "clear
  // supplier" button sets null, and it must not be a way past the rule.
  assertEquals(
    CreateTransactionInput.safeParse({ ...validCreateInput, supplier: null }).success,
    false,
  );
});

Deno.test("...and a NON-purchase with no supplier is still accepted — the fail-closed companion", () => {
  // Without this the refine above passes just as well when written as "a
  // supplier is always required", which would reject every `find`, `write_off`
  // and `adjustment_*` the picker offers. It is the arm that says the rule is
  // about PURCHASES rather than about the field being mandatory.
  const { supplier: _dropped, ...noSupplier } = validCreateInput;
  for (const type of ["find", "make", "adjustment_increase", "write_off"]) {
    assertEquals(
      CreateTransactionInput.safeParse({ ...noSupplier, type }).success,
      true,
      `${type} carries no payable, so it needs no supplier`,
    );
  }
});

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
  const { uuid_session: _drop, ...noSession } = validCreateInput;
  assertEquals(CreateTransactionInput.safeParse(noSession).success, false);

  // The document id is derived (`{uuid_session}|{type}|{subject}`), which is what
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
  for (const balance of [{ quantity: 5 }, { type: "sale" }, { total_cost_cents: 1000 }, { date: "2026-03-01T00:00:00Z" }]) {
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
    uuid_session: SESSION,
    from: [{ uid_location: LOC_A, quantity: 4 }],
    to: [{ uid_location: LOC_B, quantity: 4 }],
  };
  assertEquals(CreateStoreTransferInput.safeParse(input).success, true);
  assertEquals(CreateStoreTransferInput.safeParse({ ...input, to: [] }).success, false);
  // No total_cost: a transfer nets to zero on ownership.
  const costed = CreateStoreTransferInput.safeParse({ ...input, total_cost_cents: 10000 });
  assertEquals(
    Object.keys(costed.success ? costed.data : {}).includes("total_cost"),
    false,
  );
});

/**
 * core#45 — the scalar quantity must equal Σ allocations at the DOOR.
 *
 * `CreateProductInput` has carried the identical rule since #168. This boundary
 * did not, so a mismatched payload validated field-by-field, reached write time,
 * and was caught by `checkMovementContract` balance rule 1 — where
 * `assertValidForWrite` throws a bare `Error` and the client gets an opaque
 * **500** instead of a 400 naming the field.
 *
 * Until this landed the CLIENT was the only real guard: the manager gates its
 * Create button on `Σ allocations === quantity`, which is a UI courtesy rather
 * than a contract, and anything reaching the route by another path had none.
 */
Deno.test("CreateTransactionInput rejects quantity ≠ Σ allocations", () => {
  const result = CreateTransactionInput.safeParse({
    ...validCreateInput,
    quantity: 10,
    allocations: [{ uid_location: LOC_A, quantity: 4 }, { uid_location: LOC_B, quantity: 3 }],
  });
  assertEquals(result.success, false, "7 allocated against a quantity of 10 must not validate");
  if (!result.success) {
    assertEquals(result.error.issues[0].path, ["quantity"], "the issue must name the field");
  }
});

Deno.test("CreateTransactionInput accepts quantity === Σ allocations", () => {
  assertEquals(
    CreateTransactionInput.safeParse({
      ...validCreateInput,
      quantity: 7,
      allocations: [{ uid_location: LOC_A, quantity: 4 }, { uid_location: LOC_B, quantity: 3 }],
    }).success,
    true,
  );
});

/**
 * Absent allocations is NOT a violation — it means "the server allocates",
 * which is the documented default and the reason the field is optional. A
 * refine that forgot this would break every create that omits them.
 */
Deno.test("CreateTransactionInput still accepts no allocations at all", () => {
  const { allocations: _drop, ...noAllocs } = { ...validCreateInput, allocations: undefined };
  assertEquals(CreateTransactionInput.safeParse(noAllocs).success, true);
});

// ── rule 4: the service axis ────────────────────────────────────────

Deno.test("rule 4: a type that forbids the axis refuses one", () => {
  const bad = movement("transfer", {
    lines: [{ quantity: 2, location: { from: at(LOC_A), to: at(LOC_B) } }],
    service: { from: null, to: "damaged" },
  });
  assertEquals(MovementSchema.safeParse(bad).success, false);
});

Deno.test("rule 4: flag and send_away require the axis", () => {
  assertEquals(MovementSchema.safeParse(movement("flag", { service: null })).success, false);
  assertEquals(MovementSchema.safeParse(movement("send_away", { service: null })).success, false);
});

Deno.test("rule 4: lost is a PLACE, never a flag on a shelf", () => {
  const bad = movement("flag", { service: { from: null, to: "lost" } });
  assertEquals(MovementSchema.safeParse(bad).success, false);
});

Deno.test("rule 4: a flag that keeps its reason must move", () => {
  const same = movement("flag", {
    uid_booking: null,
    uid: `${SESSION}|flag|${PRODUCT}`,
    custody: null,
    service: { from: "damaged", to: "damaged" },
  });
  assertEquals(MovementSchema.safeParse(same).success, false, "same shelf, same reason: no event");
  const moved = { ...same, lines: [{ quantity: 2, location: { from: at(LOC_A), to: at(LOC_B) } }] };
  assertEquals(MovementSchema.safeParse(moved).success, true, "moving flagged units is an event");
});

Deno.test("rule 4: send_away must name the reason at the record", () => {
  const bad = movement("send_away", { service: { from: "damaged", to: null } });
  assertEquals(MovementSchema.safeParse(bad).success, false);
});

Deno.test("rule 4: a write-off may not leave units out of service", () => {
  const bad = movement("write_off", {
    lines: [{ quantity: 2, location: { from: atOos, to: null } }],
    service: { from: "lost", to: "lost" },
  });
  assertEquals(MovementSchema.safeParse(bad).success, false);
  const good = { ...bad, service: { from: "lost", to: null } };
  assertEquals(MovementSchema.safeParse(good).success, true);
});

Deno.test("rule 4: an axis must name the reason at a record endpoint", () => {
  // return_to_service off a record with an axis that forgot the record side.
  const bad = movement("return_to_service", { service: { from: null, to: null } });
  assertEquals(MovementSchema.safeParse(bad).success, false, "an all-null axis is refused outright");
  const missing = movement("write_off", {
    lines: [{ quantity: 2, location: { from: atOos, to: null } }],
    service: { from: null, to: null },
  });
  assertEquals(MovementSchema.safeParse(missing).success, false);
});

Deno.test("rule 4: a stored movement with no service key still parses", () => {
  const legacy = movement("transfer", { lines: [{ quantity: 2, location: { from: at(LOC_A), to: at(LOC_B) } }] });
  delete (legacy as Record<string, unknown>).service;
  assertEquals(MovementSchema.safeParse(legacy).success, true);
});
