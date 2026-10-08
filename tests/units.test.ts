/**
 * Serialized-unit UTILS (api-cloudrun serial-tracking P2): the range text an
 * operator types, the picker's suggestion, the unit-set fold inside
 * `applyCustodyActions`, and the roster fold — checked against each other on
 * the same actions, since the booking's sets and the roster are two
 * projections of one sequence of custody steps and must never disagree.
 */
import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  type BookingActionType,
  type BookingBreakdown,
  type BookingUnitSetsType,
  MOVEMENT_CONTRACTS,
  type MovementLineType,
} from "../src/schemas/mod.ts";
import { applyCustodyActions, CustodyRefusal, type CustodyTransition } from "../src/utils/custody.ts";
import { untrackedUnitCount } from "../src/utils/bookings.ts";
import {
  foldRosterUnits,
  rosterUnitsForBucket,
  unflaggedShelfUnits,
  formatUnitRanges,
  normalizeUnitSet,
  parseUnitRanges,
  RosterFoldError,
  type RosterMovement,
  type RosterUnits,
  serialAt,
  suggestUnits,
  toUnitRanges,
} from "../src/utils/units.ts";
import { bookingId, fid, legUid } from "./helpers/ids.ts";

// ── parse / format ───────────────────────────────────────────────────

Deno.test("parseUnitRanges → formatUnitRanges round-trips to the fewest runs", () => {
  const parsed = parseUnitRanges("1003-1005, 1001 1002;1010 – 1011\n1045");
  assert(parsed.ok);
  assertEquals(parsed.numbers, [1001, 1002, 1003, 1004, 1005, 1010, 1011, 1045]);
  assertEquals(formatUnitRanges(parsed.numbers), "1001–1005, 1010–1011, 1045");
  const again = parseUnitRanges(formatUnitRanges(parsed.numbers));
  assert(again.ok);
  assertEquals(again.numbers, parsed.numbers);
});

Deno.test("parseUnitRanges: empty text is the empty set", () => {
  assertEquals(parseUnitRanges("  "), { ok: true, numbers: [] });
  assertEquals(formatUnitRanges([]), "");
});

Deno.test("parseUnitRanges refuses garbage, reversed runs, overlaps and too many — every error, not the first", () => {
  const r = parseUnitRanges("10x1, 1040-1001, 1001-1003, 1002, 0, 007");
  assert(!r.ok);
  assertEquals(r.errors.map((e) => `${e.kind}:${e.token}`), [
    "syntax:10x1",
    "reversed:1040-1001",
    "overlap:1002",
    "syntax:0",
    "syntax:007",
  ]);
  const big = parseUnitRanges("1001-9999999");
  assert(!big.ok);
  assertEquals(big.errors.map((e) => e.kind), ["too_many"]);
  const capped = parseUnitRanges("1-3, 10", { max: 3 });
  assert(!capped.ok);
  assertEquals(capped.errors.map((e) => e.kind), ["too_many"]);
});

Deno.test("toUnitRanges / normalizeUnitSet canonicalize any order", () => {
  assertEquals(normalizeUnitSet([5, 3, 4, 3, 1]), [1, 3, 4, 5]);
  assertEquals(toUnitRanges([5, 3, 4, 1]), [{ start: 1, end: 1 }, { start: 3, end: 5 }]);
  assertEquals(formatUnitRanges([1, 3, 4, 5], { dash: "-", separator: " / " }), "1 / 3-5");
});

// ── suggestUnits ─────────────────────────────────────────────────────

Deno.test("suggestUnits: a single run long enough wins, the lowest such run", () => {
  const avail = [1001, 1002, 1010, 1011, 1012, 1013, 1020, 1021, 1022, 1023];
  assertEquals(suggestUnits(avail, 2), [1001, 1002]);
  assertEquals(suggestUnits(avail, 3), [1010, 1011, 1012]);
  assertEquals(suggestUnits(avail, 4), [1010, 1011, 1012, 1013]);
});

Deno.test("suggestUnits: otherwise the fewest runs, longest first, trimmed at the high end", () => {
  const avail = [1001, 1002, 1010, 1011, 1012, 1020, 1021, 1022, 1030];
  // 3 + 3 covers 5 with two runs; 1010 and 1020 runs (length 3) beat 1001 (length 2).
  assertEquals(suggestUnits(avail, 5), [1010, 1011, 1012, 1020, 1021]);
  assertEquals(suggestUnits(avail, 9), [1001, 1002, 1010, 1011, 1012, 1020, 1021, 1022, 1030]);
});

Deno.test("suggestUnits: not enough is null; zero is empty; order of input is irrelevant", () => {
  assertEquals(suggestUnits([1, 2], 3), null);
  assertEquals(suggestUnits([1, 2], 0), []);
  assertEquals(suggestUnits([1013, 1010, 1012, 1011], 2), [1010, 1011]);
});

// ── the unit fold in applyCustodyActions ─────────────────────────────

function bd(partial: Partial<BookingBreakdown>): BookingBreakdown {
  return {
    quoted: 0, reserved: 0, prepped: 0, out: 0, returned: 0, lost: 0, damaged: 0, cleaning: 0, maintenance: 0,
    ...partial,
  };
}

function sets(partial: Partial<BookingUnitSetsType> = {}): BookingUnitSetsType {
  return { cleaning: [], damaged: [], lost: [], maintenance: [], out: [], prepped: [], returned: [], ...partial };
}

function tracked(breakdown: Partial<BookingBreakdown>, units: Partial<BookingUnitSetsType> = {}) {
  const b = bd(breakdown);
  const quantity = Object.values(b).reduce((s, n) => s + n, 0);
  return { type: "rental" as const, quantity, status: "reserved" as const, breakdown: b, units: sets(units) };
}

const act = (rule: BookingActionType["rule"], units?: number[], quantity = units?.length ?? 1): BookingActionType =>
  units === undefined ? { rule, quantity } : { rule, quantity, units };

Deno.test("units fold: each rung moves its named units between sets", () => {
  const r = applyCustodyActions(tracked({ reserved: 3 }), [
    act("prep", [1001, 1002, 1003]),
    act("check_out", [1001, 1003]),
  ]);
  assertEquals(r.units, sets({ prepped: [1002], out: [1001, 1003] }));
  assertEquals(r.transitions.map((t) => t.units), [[1001, 1002, 1003], [1001, 1003]]);
});

Deno.test("units fold: a mis-typed number is corrected by four actions in one save", () => {
  const before = tracked({ out: 1 }, { out: [1021] });
  before.breakdown.reserved = 0;
  const r = applyCustodyActions({ ...before, quantity: 1 }, [
    act("check_out_undo", [1021]),
    act("unprep", [1021]),
    act("prep", [1012]),
    act("check_out", [1012]),
  ]);
  assertEquals(r.breakdown, bd({ out: 1 }));
  assertEquals(r.units, sets({ out: [1012] }));
});

Deno.test("units fold: a booking that is not unit-tracked names no units, and is unchanged by the fold", () => {
  const bulk = { type: "rental" as const, quantity: 2, status: "reserved" as const, breakdown: bd({ reserved: 2 }) };
  assertEquals(applyCustodyActions(bulk, [act("prep", undefined, 2)]).units, null);
  assertThrows(() => applyCustodyActions(bulk, [act("prep", [1, 2])]), CustodyRefusal, "not unit-tracked");
  assertThrows(
    () => applyCustodyActions({ ...bulk, units: null }, [act("prep", [1, 2])]),
    CustodyRefusal,
    "not unit-tracked",
  );
});

Deno.test("units fold: a tracked booking's action must name its units", () => {
  assertThrows(
    () => applyCustodyActions(tracked({ reserved: 2 }), [act("prep", undefined, 2)]),
    CustodyRefusal,
    "must name the units",
  );
});

Deno.test("units fold: a unit not in the source set is refused, beyond the untracked count", () => {
  const b = tracked({ out: 2 }, { out: [1001, 1002] });
  assertThrows(() => applyCustodyActions(b, [act("check_in", [1003])]), CustodyRefusal, "has 0 untracked");
  assertThrows(() => applyCustodyActions(b, [act("check_in", [1001, 1001], 2)]), CustodyRefusal, "out of order or twice");
});

Deno.test("units fold: an untracked count (a conversion's) is drawn on by naming units the booking does not hold", () => {
  // 3 prepped, 1 named: 2 untracked prepped units physically on the shelf.
  const b = tracked({ prepped: 3 }, { prepped: [1001] });
  assertEquals(untrackedUnitCount(b, "prepped"), 2);
  const r = applyCustodyActions(b, [act("check_out", [1001, 1007, 1008])]);
  assertEquals(r.units, sets({ out: [1001, 1007, 1008] }));
  assertThrows(
    () => applyCustodyActions(b, [act("check_out", [1001, 1007, 1008, 1009], 4)]),
    CustodyRefusal,
    "holds 3",
  );
  assertThrows(() => applyCustodyActions(b, [act("check_out", [1006, 1007, 1008])]), CustodyRefusal, "has 2 untracked");
});

Deno.test("units fold: only an unprep of untracked prepped units may omit units", () => {
  const b = tracked({ prepped: 3 }, { prepped: [1001] });
  const r = applyCustodyActions(b, [act("unprep", undefined, 2)]);
  assertEquals(r.breakdown.prepped, 1);
  assertEquals(r.units, sets({ prepped: [1001] }));
  assertThrows(() => applyCustodyActions(b, [act("unprep", undefined, 3)]), CustodyRefusal, "only for untracked");
  assertThrows(
    () => applyCustodyActions(tracked({ out: 2 }), [act("check_in", undefined, 2)]),
    CustodyRefusal,
    "must name the units",
  );
});

Deno.test("units fold: a unit is in one of a booking's sets at a time, so a returned unit cannot be re-prepped onto it", () => {
  const b = tracked({ reserved: 1, returned: 1 }, { returned: [1001] });
  assertThrows(() => applyCustodyActions(b, [act("prep", [1001])]), CustodyRefusal, "holds it in returned");
  assertEquals(applyCustodyActions(b, [act("prep", [1002])]).units, sets({ prepped: [1002], returned: [1001] }));
});

// ── the roster fold, against the booking fold ────────────────────────

const PRODUCT = fid("walkie");
const SHELF = fid("shelf1");
const OTHER_SHELF = fid("shelf2");
const RECORD = fid("record1");
const BOOKING = bookingId(fid("order1"), PRODUCT, legUid("leg1"));
const SESSION = "0b6c5f3e-7a2d-4c1e-9f8a-3d2b1c0e9f8a";

const place = (collection: "locations" | "bookings" | "out-of-service", uid: string) => ({ collection, uid });

/**
 * The movement a transition records, as the api's booking writer shapes it:
 * places by the type's contract, one line, the record in `sources[]` for a flag.
 */
function movementFor(t: CustodyTransition, shelf = SHELF): RosterMovement {
  const contract = MOVEMENT_CONTRACTS[t.type];
  const side = (kinds: readonly string[], key: string) => {
    if (kinds.includes("bookings") && (key === "out" || !kinds.includes("locations"))) return place("bookings", BOOKING);
    if (kinds.includes("out-of-service") && key === "lost") return place("out-of-service", RECORD);
    if (kinds.includes("locations")) return place("locations", shelf);
    return null;
  };
  const lines: MovementLineType[] = contract.places === null ? [] : [{
    quantity: t.quantity,
    location: { from: side(contract.places.from, t.from), to: side(contract.places.to, t.to) },
    units: t.units,
  }];
  const flags = ["damaged", "cleaning", "maintenance"].includes(t.to);
  return {
    uid: `${SESSION}|${t.type}|${BOOKING}`,
    type: t.type,
    uid_booking: BOOKING,
    custody: { from: t.from, to: t.to },
    service: t.service,
    lines,
    units: t.units.map((n) => ({ uid_unit: `unit-${n}`, number: n, serial_number: null })),
    sources: flags ? [{ collection: "out-of-service", uid: RECORD }] : [],
  };
}

function shelfRoster(numbers: number[], shelf = SHELF): RosterUnits {
  return Object.fromEntries(numbers.map((n) => [
    String(n),
    { state: "shelf" as const, uid_location: shelf, flag: null, uid_out_of_service: null },
  ]));
}

/** The roster's view of ONE booking, as the booking's own sets spell it. */
function rosterSetsFor(roster: RosterUnits) {
  const prepped: number[] = [];
  const out: number[] = [];
  for (const [k, e] of Object.entries(roster)) {
    if (e.state === "prepped" && e.uid_booking === BOOKING) prepped.push(Number(k));
    if (e.state === "out" && e.uid_booking === BOOKING) out.push(Number(k));
  }
  return { prepped: normalizeUnitSet(prepped), out: normalizeUnitSet(out) };
}

Deno.test("foldRosterUnits agrees with applyCustodyActions on the same actions", () => {
  let booking = tracked({ reserved: 4 });
  let roster = shelfRoster([1001, 1002, 1003, 1004, 1005]);
  const saves: BookingActionType[][] = [
    [act("prep", [1001, 1002, 1003])],
    [act("check_out", [1001, 1002])],
    [act("check_in", [1001]), act("mark_damaged", [1002])],
    // A correction: 1003 was never the radio that left; 1005 was.
    [act("unprep", [1003]), act("prep", [1005]), act("check_out", [1005])],
    [act("prep", [1004])],
  ];
  for (const actions of saves) {
    const applied = applyCustodyActions(booking, actions);
    for (const t of applied.transitions) roster = foldRosterUnits(roster, movementFor(t));
    booking = { ...booking, breakdown: applied.breakdown, units: applied.units! };
    const view = rosterSetsFor(roster);
    assertEquals(view.prepped, booking.units.prepped);
    assertEquals(view.out, booking.units.out);
  }
  assertEquals(booking.units, sets({ prepped: [1004], out: [1005], returned: [1001], damaged: [1002] }));
  assertEquals(roster["1001"], { state: "shelf", uid_location: SHELF, flag: null, uid_out_of_service: null });
  assertEquals(roster["1002"], { state: "shelf", uid_location: SHELF, flag: "damaged", uid_out_of_service: RECORD });
  assertEquals(roster["1003"], { state: "shelf", uid_location: SHELF, flag: null, uid_out_of_service: null });
  assertEquals(Object.keys(roster).length, 5, "custody never adds or removes an active number");
});

Deno.test("foldRosterUnits: a lost unit stands away at its record, and its undo brings it back", () => {
  let roster: RosterUnits = { "1001": { state: "out", uid_booking: BOOKING } };
  const lost = applyCustodyActions(tracked({ out: 1 }, { out: [1001] }), [act("mark_lost", [1001])]);
  roster = foldRosterUnits(roster, movementFor(lost.transitions[0]));
  assertEquals(roster["1001"], { state: "away", uid_out_of_service: RECORD });
  const undo = applyCustodyActions(tracked({ lost: 1 }, { lost: [1001] }), [act("mark_lost_undo", [1001])]);
  roster = foldRosterUnits(roster, movementFor(undo.transitions[0]));
  assertEquals(roster["1001"], { state: "out", uid_booking: BOOKING });
});

Deno.test("foldRosterUnits refuses a unit that is not where the movement says", () => {
  const prep = applyCustodyActions(tracked({ reserved: 1 }), [act("prep", [1001])]).transitions[0];
  // Not on the roster at all.
  assertThrows(() => foldRosterUnits({}, movementFor(prep)), RosterFoldError, "not on the roster");
  // Flagged on its shelf: never offered for prep.
  const flagged: RosterUnits = {
    "1001": { state: "shelf", uid_location: SHELF, flag: "cleaning", uid_out_of_service: RECORD },
  };
  assertThrows(() => foldRosterUnits(flagged, movementFor(prep)), RosterFoldError, "flagged cleaning");
  // Out on another booking.
  const elsewhere: RosterUnits = { "1001": { state: "out", uid_booking: "someone-else" } };
  const checkIn = applyCustodyActions(tracked({ out: 1 }, { out: [1001] }), [act("check_in", [1001])]).transitions[0];
  assertThrows(() => foldRosterUnits(elsewhere, movementFor(checkIn)), RosterFoldError, "out on someone-else");
  // On a different shelf from the one the line leaves.
  const prepped = applyCustodyActions(tracked({ reserved: 1 }), [act("prep", [1001])]).transitions[0];
  const otherShelf = foldRosterUnits(shelfRoster([1001], OTHER_SHELF), movementFor(prepped, OTHER_SHELF));
  const checkOut = applyCustodyActions(tracked({ prepped: 1 }, { prepped: [1001] }), [act("check_out", [1001])])
    .transitions[0];
  assertThrows(() => foldRosterUnits(otherShelf, movementFor(checkOut, SHELF)), RosterFoldError, "prepped on");
});

Deno.test("foldRosterUnits: an unattributed_out unit (a conversion's) checks in from any booking", () => {
  const roster: RosterUnits = { "1001": { state: "unattributed_out" } };
  const checkIn = applyCustodyActions(tracked({ out: 1 }), [act("check_in", [1001])]).transitions[0];
  assertEquals(
    foldRosterUnits(roster, movementFor(checkIn))["1001"],
    { state: "shelf", uid_location: SHELF, flag: null, uid_out_of_service: null },
  );
});

// ── the rebook pair (rental extension) ──

const LEG_B = bookingId(fid("order1"), PRODUCT, legUid("leg2"));

/** A rebook half as the api's extension route shapes it: no lines, the counterpart in `sources[]`. */
function rebook(type: "rebook_out" | "rebook_in", numbers: number[], subject: string, counterpart: string): RosterMovement {
  return {
    uid: `${SESSION}|${type}|${subject}`,
    type,
    uid_booking: subject,
    custody: type === "rebook_out" ? { from: "out", to: null } : { from: null, to: "out" },
    service: null,
    lines: [],
    units: numbers.map((n) => ({ uid_unit: `unit-${n}`, number: n, serial_number: null })),
    sources: [{ collection: "bookings", uid: counterpart }],
  };
}

Deno.test("foldRosterUnits: a rebook pair re-points units that stay out from booking A to booking B", () => {
  const start: RosterUnits = {
    "1001": { state: "out", uid_booking: BOOKING },
    "1002": { state: "out", uid_booking: BOOKING },
    "1003": { state: "out", uid_booking: BOOKING },
  };
  const afterOut = foldRosterUnits(start, rebook("rebook_out", [1001, 1002], BOOKING, LEG_B));
  assertEquals(afterOut, start, "rebook_out only checks; the unit is still on A until B takes it");
  const afterIn = foldRosterUnits(afterOut, rebook("rebook_in", [1001, 1002], LEG_B, BOOKING));
  assertEquals(afterIn, {
    "1001": { state: "out", uid_booking: LEG_B },
    "1002": { state: "out", uid_booking: LEG_B },
    "1003": { state: "out", uid_booking: BOOKING },
  });
});

Deno.test("foldRosterUnits: the rebook pair folds A's half first, and refuses a unit not out on the booking it leaves", () => {
  const start: RosterUnits = { "1001": { state: "out", uid_booking: BOOKING } };
  // B's half first moves the unit, so A's half then finds it on B.
  const inFirst = foldRosterUnits(start, rebook("rebook_in", [1001], LEG_B, BOOKING));
  assertThrows(
    () => foldRosterUnits(inFirst, rebook("rebook_out", [1001], BOOKING, LEG_B)),
    RosterFoldError,
    `out on ${LEG_B}`,
  );
  // A returned unit is on a shelf, not out: neither half takes it.
  const shelf = shelfRoster([1001]);
  assertThrows(() => foldRosterUnits(shelf, rebook("rebook_out", [1001], BOOKING, LEG_B)), RosterFoldError, "on shelf");
  assertThrows(() => foldRosterUnits(shelf, rebook("rebook_in", [1001], LEG_B, BOOKING)), RosterFoldError, "on shelf");
});

Deno.test("foldRosterUnits: an unattributed_out unit (a conversion residue) rebooks onto B, as a check-in may take one off any booking", () => {
  const start: RosterUnits = { "1001": { state: "unattributed_out" }, "1002": { state: "out", uid_booking: BOOKING } };
  const afterOut = foldRosterUnits(start, rebook("rebook_out", [1001, 1002], BOOKING, LEG_B));
  assertEquals(afterOut, start, "rebook_out only checks");
  assertEquals(foldRosterUnits(afterOut, rebook("rebook_in", [1001, 1002], LEG_B, BOOKING)), {
    "1001": { state: "out", uid_booking: LEG_B },
    "1002": { state: "out", uid_booking: LEG_B },
  });
  // Still one order: B's half first writes the unit down on B, and A's half then refuses it.
  const inFirst = foldRosterUnits(start, rebook("rebook_in", [1001], LEG_B, BOOKING));
  assertThrows(() => foldRosterUnits(inFirst, rebook("rebook_out", [1001], BOOKING, LEG_B)), RosterFoldError, `out on ${LEG_B}`);
});

Deno.test("foldRosterUnits: rebook_in must name exactly one counterpart booking", () => {
  const start: RosterUnits = { "1001": { state: "out", uid_booking: BOOKING } };
  const none = { ...rebook("rebook_in", [1001], LEG_B, BOOKING), sources: [] };
  assertThrows(() => foldRosterUnits(start, none), RosterFoldError, "found 0");
  const self = { ...rebook("rebook_in", [1001], LEG_B, BOOKING), sources: [{ collection: "bookings" as const, uid: LEG_B }] };
  assertThrows(() => foldRosterUnits(start, self), RosterFoldError, "found 0");
});

function ownership(type: RosterMovement["type"], numbers: number[], from: string | null, to: string | null): RosterMovement {
  return {
    uid: `${SESSION}|${type}|${PRODUCT}`,
    type,
    uid_booking: null,
    custody: null,
    service: null,
    lines: [{
      quantity: numbers.length,
      location: { from: from === null ? null : place("locations", from), to: to === null ? null : place("locations", to) },
      units: numbers,
    }],
    units: numbers.map((n) => ({ uid_unit: `unit-${n}`, number: n, serial_number: null })),
    sources: [],
  };
}

Deno.test("foldRosterUnits: ownership in adds an active number, ownership out removes it", () => {
  let roster: RosterUnits = {};
  roster = foldRosterUnits(roster, ownership("purchase", [1001, 1002], null, SHELF));
  assertEquals(Object.keys(roster), ["1001", "1002"]);
  assertThrows(
    () => foldRosterUnits(roster, ownership("find", [1002], null, SHELF)),
    RosterFoldError,
    "from outside CFS",
  );
  roster = foldRosterUnits(roster, ownership("adjustment_decrease", [1001], SHELF, null));
  assertEquals(Object.keys(roster), ["1002"]);
  roster = foldRosterUnits(roster, ownership("transfer", [1002], SHELF, OTHER_SHELF));
  assertEquals(roster["1002"], { state: "shelf", uid_location: OTHER_SHELF, flag: null, uid_out_of_service: null });
});

Deno.test("foldRosterUnits: a movement naming no units leaves the roster untouched; a line naming the wrong count is refused", () => {
  const roster = shelfRoster([1001]);
  const none = { ...ownership("purchase", [], null, SHELF), lines: [] };
  assert(foldRosterUnits(roster, none) === roster);
  const bad = ownership("adjustment_decrease", [1001], SHELF, null);
  bad.lines[0] = { ...bad.lines[0], quantity: 2 };
  assertThrows(() => foldRosterUnits(roster, bad), RosterFoldError, "exactly its quantity");
});

Deno.test("foldRosterUnits does not mutate its input", () => {
  const roster = shelfRoster([1001]);
  const snapshot = structuredClone(roster);
  foldRosterUnits(roster, ownership("adjustment_decrease", [1001], SHELF, null));
  assertEquals(roster, snapshot);
});

// ── serialAt ─────────────────────────────────────────────────────────

type HistoryEntry = { serial_number: string; start: string; end: string | null; reason: "initial" | "replaced" | "corrected" };
function history(...entries: HistoryEntry[]) {
  return {
    serial_history: entries.map((e) => ({ ...e, uid_movement: null, notes: "", changed_by: { uid: "u1", name: "Op" } })),
  };
}
const LOSS = "2025-04-17T12:00:00.000-05:00";

Deno.test("serialAt: a serial recorded AFTER the loss is still that radio's", () => {
  // The walkie's serials were pasted 2026-10-07, after most of its losses.
  const unit = history({ serial_number: "902ZAE5968", start: "2026-10-07T09:00:00.000-05:00", end: null, reason: "initial" });
  assertEquals(serialAt(unit, LOSS), "902ZAE5968");
});

Deno.test("serialAt: a replacement after the loss does not rename the lost radio", () => {
  const unit = history(
    { serial_number: "902ZAE3358", start: "2024-01-05T09:00:00.000-06:00", end: "2025-10-16T16:00:00.000-05:00", reason: "initial" },
    { serial_number: "902EBQP559", start: "2025-10-16T16:00:00.000-05:00", end: null, reason: "replaced" },
  );
  assertEquals(serialAt(unit, LOSS), "902ZAE3358");
  assertEquals(serialAt(unit, "2025-11-01T09:00:00.000-05:00"), "902EBQP559");
  assertEquals(serialAt(unit, null), "902EBQP559");
});

Deno.test("serialAt: a correction after the loss fixes the same radio's serial", () => {
  const unit = history(
    { serial_number: "902ZAE59G8", start: "2024-01-05T09:00:00.000-06:00", end: "2026-10-07T09:00:00.000-05:00", reason: "initial" },
    { serial_number: "902ZAE5968", start: "2026-10-07T09:00:00.000-05:00", end: null, reason: "corrected" },
  );
  assertEquals(serialAt(unit, LOSS), "902ZAE5968");
});

Deno.test("serialAt: a written-off radio's closed entry still answers; no history answers null", () => {
  const unit = history(
    { serial_number: "902ZAE5968", start: "2024-01-05T09:00:00.000-06:00", end: "2026-01-02T09:00:00.000-06:00", reason: "initial" },
  );
  assertEquals(serialAt(unit, LOSS), "902ZAE5968");
  assertEquals(serialAt(history(), LOSS), null);
});

Deno.test("serialAt: a number first minted for a replacement after the instant held no radio then", () => {
  const unit = history({ serial_number: "902EBQP671", start: "2025-10-16T16:00:00.000-05:00", end: null, reason: "replaced" });
  assertEquals(serialAt(unit, LOSS), null);
});

Deno.test("foldRosterUnits: a sale's unit lost in transit names a unit off the roster and changes nothing (decision 5)", () => {
  const sale = { ...tracked({ out: 1 }, { out: [1001] }), type: "sale" as const };
  const lost = applyCustodyActions(sale, [act("mark_lost", [1001])]).transitions[0];
  assertEquals(lost.type, "sale_lost");
  // The sale removed 1001 from the roster; the loss leaves it removed.
  const roster: RosterUnits = { "1002": { state: "out", uid_booking: BOOKING } };
  assertEquals(foldRosterUnits(roster, movementFor(lost)), roster);
  // A unit still on the roster cannot be the customer's.
  assertThrows(
    () => foldRosterUnits({ "1001": { state: "out", uid_booking: BOOKING } }, movementFor(lost)),
    RosterFoldError,
    "roster still holds it",
  );
  // The rental's loss is NOT this arm: its unit is on the roster and moves.
  const rentalLost = applyCustodyActions(tracked({ out: 1 }, { out: [1001] }), [act("mark_lost", [1001])]).transitions[0];
  assertEquals(
    foldRosterUnits({ "1001": { state: "out", uid_booking: BOOKING } }, movementFor(rentalLost))["1001"],
    { state: "away", uid_out_of_service: RECORD },
  );
});

Deno.test("rosterUnitsForBucket: a loss bucket offers only the named records' units, a shelf bucket only unflagged units (G11 (g))", () => {
  const roster: RosterUnits = {
    "1": { state: "shelf", uid_location: SHELF, flag: null, uid_out_of_service: null },
    "2": { state: "shelf", uid_location: OTHER_SHELF, flag: null, uid_out_of_service: null },
    "3": { state: "shelf", uid_location: SHELF, flag: "damaged", uid_out_of_service: RECORD },
    "4": { state: "shelf", uid_location: SHELF, flag: "damaged", uid_out_of_service: "another" },
    "5": { state: "away", uid_out_of_service: RECORD },
    "6": { state: "away", uid_out_of_service: "another" },
    "7": { state: "unattributed_out" },
  };
  assertEquals(unflaggedShelfUnits(roster), [1, 2]);
  assertEquals(unflaggedShelfUnits(roster, SHELF), [1]);
  assertEquals(rosterUnitsForBucket(roster, "reserved"), [1, 2]);
  assertEquals(rosterUnitsForBucket(roster, "out"), [7]);
  const records = new Set([RECORD]);
  assertEquals(rosterUnitsForBucket(roster, "lost", { records }), [5], "another record's away unit is not offered");
  assertEquals(rosterUnitsForBucket(roster, "damaged", { records }), [3]);
  assertEquals(rosterUnitsForBucket(roster, "damaged", { records, location: OTHER_SHELF }), []);
  assertEquals(rosterUnitsForBucket(roster, "lost"), [], "no record named, nothing offered");
});
