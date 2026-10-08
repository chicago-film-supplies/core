/**
 * The custody ruleset (`schemas/custody.ts` + `utils/custody.ts`).
 *
 * Four questions, and each is asked of the WHOLE population rather than a
 * worked example, because the defect this module replaces was three copies of
 * one rule that each looked right on its own:
 *
 * 1. Does every row agree with `MOVEMENT_CONTRACTS`? (the table cannot name a
 *    movement whose places or axes contradict its custody pair)
 * 2. Does `decomposeCustodyDelta` reproduce the api's `deriveCustodyTransitions`
 *    over every reachable pair at quantity 4? (parity with the frozen oracle)
 * 3. Does `applyCustodyActions` land every matched decomposition exactly on its
 *    target? (the two functions agree with each other)
 * 4. Do the manager's 24 `bookingTransitions` cases still hold — with the one
 *    that the G1 ruling turns into a refusal?
 */
import { assert, assertEquals, assertThrows } from "@std/assert";
import { z } from "zod";
import {
  type Booking,
  type BookingBreakdown,
  type BookingBreakdownKeyType,
  BookingAction,
  BookingActions,
  BookingUpdate,
  BulkBookingUpdateInput,
  CUSTODY_PLACE_KINDS,
  CUSTODY_RULE_IDS,
  CUSTODY_RULES,
  type CustodyRuleId,
  custodyRule,
  isLossUndo,
  MOVEMENT_CONTRACTS,
  MOVEMENT_UNDOES,
  type MovementTypeType,
  BOOKING_BREAKDOWN_KEYS,
  BOOKING_PLAN_KEYS,
  BOOKING_UNIT_BUCKETS,
  CUSTODY_HISTORY_KEYS,
  markReasonOf,
  MOVEMENT_TYPES,
  OUT_OF_SERVICE_KEYS,
  OWNED_KEYS_BY_TYPE,
  ownsKey,
  OOS_BREAKDOWN_KEYS,
  type OOSBreakdown,
  type OOSReasonType,
  type OOSUnitsType,
  UpdateBookingInput,
} from "../src/schemas/mod.ts";
import {
  applyCustodyActions,
  canonicalLossUndos,
  canEditServiceBreakdown,
  CustodyRefusal,
  custodyActionsFor,
  custodyMovementTypes,
  custodyPlaces,
  isReleasingRewind,
  type LossRecordView,
  planReclassification,
  reclassifyRefusal,
  recordOwner,
  lossUndoRefusal,
  splitLeadingReleases,
  undoableFromRecords,
  custodyRuleForMovement,
  decomposeCustodyDelta,
  deriveCustodyStatus,
  expandCustodyOffer,
  extensionUndoRefusal,
  planCustodyTransfer,
  substitutionCapacity,
  getCustodyRulesMarkdown,
  serviceBreakdownViolation,
  serviceBucketBounds,
  serviceMovesFor,
  serviceUnitMovesFor,
} from "../src/utils/custody.ts";
import * as oracle from "./helpers/custody-oracle.ts";

/** Every key stated, as `applyCustodyActions` returns it. */
function bd(partial: Partial<BookingBreakdown>): BookingBreakdown {
  return {
    quoted: 0, reserved: 0, prepped: 0, out: 0, returned: 0, lost: 0, damaged: 0, cleaning: 0, maintenance: 0,
    ...partial,
  };
}

function booking(
  quantity: number,
  breakdown: Partial<BookingBreakdown>,
  status: Booking["status"] = "reserved",
  type: Booking["type"] = "rental",
) {
  return { type, quantity, status, breakdown: bd(breakdown) };
}

const shape = (ts: { type: string; from: string; to: string; quantity: number }[]) =>
  ts.map((t) => `${t.type}:${t.from}→${t.to}×${t.quantity}`);

/** Every breakdown over the six fulfillment keys summing to `q`. */
function statesAt(
  q: number,
  KEYS: readonly BookingBreakdownKeyType[] = ["reserved", "prepped", "out", "returned", "lost", "damaged"],
): BookingBreakdown[] {
  const states: BookingBreakdown[] = [];
  const walk = (i: number, left: number, acc: Partial<BookingBreakdown>) => {
    if (i === KEYS.length) {
      if (left === 0) states.push(bd(acc));
      return;
    }
    for (let n = 0; n <= left; n++) walk(i + 1, left - n, { ...acc, [KEYS[i]]: n });
  };
  walk(0, q, {});
  return states;
}

function replay(prev: BookingBreakdown, ts: { from: BookingBreakdownKeyType; to: BookingBreakdownKeyType; quantity: number }[]) {
  const out = { ...prev };
  for (const t of ts) {
    out[t.from] -= t.quantity;
    out[t.to] += t.quantity;
  }
  return out;
}

// ── 1. the table ─────────────────────────────────────────────────────

Deno.test("custody - CUSTODY_RULE_IDS and the table's ids are the same set, both ways", () => {
  const ids = CUSTODY_RULES.map((r) => r.id);
  assertEquals(new Set(ids).size, ids.length, "a rule id repeats");
  assertEquals([...ids].sort(), [...CUSTODY_RULE_IDS].sort());
  for (const id of CUSTODY_RULE_IDS) assertEquals(custodyRule(id).id, id);
});

Deno.test("custody - every inverse names a row that points back, with the custody pair swapped", () => {
  for (const r of CUSTODY_RULES) {
    if (r.inverse === null) continue;
    const inv = custodyRule(r.inverse);
    assertEquals(inv.inverse, r.id, `${r.id} ↔ ${inv.id}`);
    assertEquals([inv.from, inv.to], [r.to, r.from], `${r.id}'s inverse does not swap its custody pair`);
  }
});

Deno.test("custody - there is NO row from a pre-departure key into lost or damaged (gap G1)", () => {
  for (const r of CUSTODY_RULES) {
    if (r.to !== "lost" && r.to !== "damaged") continue;
    assert(!["quoted", "reserved", "prepped"].includes(r.from), `${r.id} reaches ${r.to} from ${r.from}`);
  }
});

Deno.test("custody - every row agrees with MOVEMENT_CONTRACTS", () => {
  const overlaps = (a: readonly string[], b: readonly string[]) => a.some((k) => b.includes(k));
  let checked = 0;
  for (const r of CUSTODY_RULES) {
    for (const [type, arm] of [["rental", r.rental], ["sale", r.sale]] as const) {
      if (!arm?.movement) continue;
      checked++;
      const c = MOVEMENT_CONTRACTS[arm.movement];
      const where = `${r.id} (${type}, ${arm.movement})`;
      const carriesCustody = r.from !== r.to;
      if (carriesCustody) {
        assert(c.custody !== "forbidden", `${where}: the contract forbids a custody pair`);
        assert(c.booking !== "forbidden", `${where}: the contract forbids a booking`);
      } else {
        assert(c.custody !== "required", `${where}: the contract requires a custody pair`);
        assert(c.booking !== "required", `${where}: the contract requires a booking`);
      }
      if (c.places === null && !ownsKey(type, r.from) && !ownsKey(type, r.to)) {
        // Both ends are the customer's (a sale's loss): nothing moves on a CFS shelf.
      } else if (c.places === null) {
        assertEquals([...CUSTODY_PLACE_KINDS[r.from]], ["locations"], `${where}: nothing moves, so from must be a shelf`);
        assertEquals([...CUSTODY_PLACE_KINDS[r.to]], ["locations"], `${where}: nothing moves, so to must be a shelf`);
      } else {
        assert(overlaps(CUSTODY_PLACE_KINDS[r.from], c.places.from), `${where}: ${r.from} is not a place the movement leaves`);
        assert(overlaps(CUSTODY_PLACE_KINDS[r.to], c.places.to), `${where}: ${r.to} is not a place the movement reaches`);
      }
      assertEquals(c.service === "required", r.service !== null, `${where}: the service axis disagrees`);
      if (r.service) assert(r.service.from !== r.service.to, `${where}: a flag must change the reason`);
    }
  }
  assert(checked >= 20, `only ${checked} arms checked — the walk stopped reaching the table`);
});

Deno.test("custody - ownership: a line that comes back owns every key, anything else never owns what left with the customer", () => {
  assertEquals(OWNED_KEYS_BY_TYPE.rental, [
    "quoted", "reserved", "prepped", "out", "returned", "lost", "damaged", "cleaning", "maintenance",
  ]);
  for (const t of ["sale", "service", "surcharge"] as const) {
    assertEquals(OWNED_KEYS_BY_TYPE[t], ["quoted", "reserved", "prepped", "returned"], t);
  }
  // The predicate and the table are one answer.
  for (const [t, keys] of Object.entries(OWNED_KEYS_BY_TYPE)) {
    for (const k of keys) assert(ownsKey(t, k), `${t}.${k}`);
  }
});

Deno.test("custody - a movement draws cost exactly when its custody pair crosses ownership, and moves nothing when both ends are unowned", () => {
  let crossing = 0;
  let checked = 0;
  for (const r of CUSTODY_RULES) {
    for (const [type, arm] of [["rental", r.rental], ["sale", r.sale]] as const) {
      if (!arm?.movement) continue;
      checked++;
      const c = MOVEMENT_CONTRACTS[arm.movement];
      const where = `${r.id} (${type}, ${arm.movement})`;
      const crosses = ownsKey(type, r.from) !== ownsKey(type, r.to);
      if (crosses) crossing++;
      assertEquals(c.cost === "required", crosses, `${where}: cost is required iff ownership changes hands`);
      if (!ownsKey(type, r.from) && !ownsKey(type, r.to)) {
        assertEquals(c.places, null, `${where}: units the customer owns are on no CFS shelf`);
      }
    }
  }
  // `sale` and `sale_return` are the two crossings today; zero means the walk stopped reaching them.
  assert(crossing >= 2, `only ${crossing} crossing arms — the cross-check is vacuous`);
  assert(checked >= 20, `only ${checked} arms checked`);
});

Deno.test("custody - the plan and history keys partition the breakdown, and the unit buckets are the history keys", () => {
  assertEquals([...BOOKING_PLAN_KEYS, ...CUSTODY_HISTORY_KEYS].sort(), [...BOOKING_BREAKDOWN_KEYS].sort());
  assertEquals([...CUSTODY_HISTORY_KEYS].sort(), [...BOOKING_UNIT_BUCKETS]);
});

Deno.test("custody - markReasonOf names every mark's reason and nothing else (G15)", () => {
  const named = Object.fromEntries(
    MOVEMENT_TYPES.filter((t) => markReasonOf(t) !== null).map((t) => [t, markReasonOf(t)]),
  );
  assertEquals(named, { mark_lost: "lost", mark_damaged: "damaged", mark_cleaning: "cleaning", mark_maintenance: "maintenance" });
  // Every out-of-service key has its mark.
  assertEquals(new Set(Object.values(named)), new Set(OUT_OF_SERVICE_KEYS));
});

Deno.test("custody - MOVEMENT_UNDOES agrees with the rule table's inverses, arm for arm", () => {
  // Every undo row's arm writes the undo of what its inverse's arm writes — the
  // movement pair and the rule pair cannot disagree. A `flag` undoes a `flag`
  // (its service axis swaps), so a same-type pair is skipped.
  let checked = 0;
  for (const r of CUSTODY_RULES) {
    if (r.direction !== "undo" || r.inverse === null) continue;
    const fwd = custodyRule(r.inverse);
    for (const type of ["rental", "sale"] as const) {
      const undo = (type === "rental" ? r.rental : r.sale)?.movement;
      const forward = (type === "rental" ? fwd.rental : fwd.sale)?.movement;
      if (!undo || !forward || undo === forward) continue;
      assertEquals((MOVEMENT_UNDOES as Record<string, string>)[undo], forward, `${r.id} (${type})`);
      checked++;
    }
  }
  // And every undo type is reached by some row: none is declared for nothing.
  const reached = new Set(
    CUSTODY_RULES.flatMap((r) => [r.rental?.movement, r.sale?.movement]).filter((m) => m != null),
  );
  for (const undo of Object.keys(MOVEMENT_UNDOES)) assert(reached.has(undo as MovementTypeType), `${undo} has no rule`);
  assertEquals(checked, 13);
});

Deno.test("custody - every inverse's places mirror its forward twin's", () => {
  let checked = 0;
  for (const r of CUSTODY_RULES) {
    if (r.inverse === null) continue;
    const fwd = r.rental?.movement ? MOVEMENT_CONTRACTS[r.rental.movement].places : undefined;
    const inv = custodyRule(r.inverse).rental?.movement;
    if (fwd === undefined || !inv) continue;
    const back = MOVEMENT_CONTRACTS[inv].places;
    if (fwd === null) {
      assertEquals(back, null, `${r.id}`);
    } else {
      assertEquals([...back!.from].sort(), [...fwd.to].sort(), `${r.id} → ${r.inverse}`);
      assertEquals([...back!.to].sort(), [...fwd.from].sort(), `${r.id} → ${r.inverse}`);
    }
    checked++;
  }
  assert(checked >= 14, `only ${checked} inverse pairs checked`);
});

Deno.test("custody - the type ↔ custody-pair binding the contracts lack (tests/transaction.test.ts custodyFor)", () => {
  // Every custody-bearing fixture pair in `tests/transaction.test.ts` is a row,
  // and the rows are the only pairs a type may carry.
  const fixture: Array<[MovementTypeType, BookingBreakdownKeyType, BookingBreakdownKeyType, "rental" | "sale"]> = [
    ["prep", "reserved", "prepped", "rental"],
    ["check_out", "prepped", "out", "rental"],
    ["check_in", "out", "returned", "rental"],
    ["mark_damaged", "out", "damaged", "rental"],
    ["mark_lost", "out", "lost", "rental"],
    ["unprep", "prepped", "reserved", "rental"],
    ["check_out_undo", "out", "prepped", "rental"],
    ["check_in_undo", "returned", "out", "rental"],
    ["mark_lost_undo", "lost", "out", "rental"],
    ["mark_damaged_undo", "damaged", "out", "rental"],
    ["sale", "prepped", "out", "sale"],
    ["sale_return", "out", "returned", "sale"],
  ];
  for (const [type, from, to, bt] of fixture) {
    assert(custodyRuleForMovement(type, { from, to }, null, bt), `${type} ${from}→${to} has no row`);
  }
  // A check_in carrying any other pair is not a row.
  assertEquals(custodyRuleForMovement("check_in", { from: "prepped", to: "returned" }, null, "rental"), null);
  // The flag rows are told apart by their service axis.
  assertEquals(custodyRuleForMovement("flag", { from: "returned", to: "damaged" }, { from: null, to: "damaged" }, "rental")?.id, "flag_damaged_returned");
  assertEquals(custodyRuleForMovement("flag", { from: "cleaning", to: "damaged" }, { from: "cleaning", to: "damaged" }, "rental")?.id, "reclassify_cleaning_to_damaged");
  assertEquals(custodyRuleForMovement("flag", { from: "damaged", to: "returned" }, { from: "damaged", to: null }, "rental")?.id, "flag_damaged_returned_undo");
  // R2's no-custody check-in flag was retired in P4 (none stored in either
  // project, 2026-09-30), so the shape now maps to nothing.
  assertEquals(custodyRuleForMovement("flag", null, { from: null, to: "maintenance" }, "rental"), null);
  // Every arm finds its own row.
  for (const r of CUSTODY_RULES) {
    for (const bt of ["rental", "sale"] as const) {
      const arm = bt === "rental" ? r.rental : r.sale;
      if (!arm?.movement) continue;
      const side = (x: "none" | "damaged" | "cleaning" | "maintenance"): OOSReasonType | null => x === "none" ? null : x;
      const svc = r.service === null ? null : { from: side(r.service.from), to: side(r.service.to) };
      assertEquals(custodyRuleForMovement(arm.movement, { from: r.from, to: r.to }, svc, bt)?.id, r.id, `${r.id} (${bt})`);
    }
  }
});

Deno.test("custody - the rung table names every rule", () => {
  const md = getCustodyRulesMarkdown();
  for (const r of CUSTODY_RULES) assert(md.includes(`\`${r.id}\``), r.id);
  assertEquals(md.trim().split("\n").length, CUSTODY_RULES.length + 2);
});

// ── 2. parity with the api's decomposer ─────────────────────────────

Deno.test("custody - PARITY: decomposeCustodyDelta ≡ deriveCustodyTransitions over every rental pair at quantity 4", () => {
  const states = statesAt(4);
  let checked = 0;
  let unmatched = 0;
  let twoOrigin = 0;
  for (const prev of states) {
    for (const next of states) {
      if (next.lost < prev.lost || next.damaged < prev.damaged) continue;
      checked++;
      const old = oracle.deriveCustodyTransitions(prev, next, "rental");
      const got = decomposeCustodyDelta(prev, next, "rental");
      const pair = `${JSON.stringify(prev)} → ${JSON.stringify(next)}`;
      assertEquals(shape(got.transitions), shape(old), pair);
      const exact = JSON.stringify(replay(prev, old)) === JSON.stringify(next);
      assertEquals(got.matched, exact, `matched disagrees with the oracle's replay: ${pair}`);
      // The api's sweep files the refused two-origin loss family apart from the
      // unmatched count; so does this one, so the two numbers mean the same.
      if (old.filter((t) => t.type === "mark_lost").length === 2) twoOrigin++;
      else if (!got.matched) unmatched++;
    }
  }
  // The populations the api's own sweep pins — so a filter that quietly
  // excluded everything cannot pass.
  assertEquals(checked, 7381);
  assertEquals(unmatched, 3189);
  assertEquals(twoOrigin, 111);
});

Deno.test("custody - PARITY: with canonical loss undos, over every loss-falling rental pair at quantity 4", () => {
  const states = statesAt(4);
  let checked = 0;
  let undershoot = 0;
  for (const prev of states) {
    for (const next of states) {
      if (next.lost >= prev.lost && next.damaged >= prev.damaged) continue;
      checked++;
      const old = oracle.deriveWithLossUndos(prev, next, "rental", oracle.canonicalLossUndos(prev, next));
      const got = decomposeCustodyDelta(prev, next, "rental", canonicalLossUndos(prev, next));
      const pair = `${JSON.stringify(prev)} → ${JSON.stringify(next)}`;
      assertEquals(shape(got.transitions), shape(old), pair);
      const landed = replay(prev, old);
      if (landed.lost !== next.lost || landed.damaged !== next.damaged) undershoot++;
      assertEquals(got.matched, JSON.stringify(landed) === JSON.stringify(next), pair);
    }
  }
  assertEquals(checked, 8495);
  assertEquals(undershoot, 1162);
});

Deno.test("custody - a sale decomposes exactly as a rental does, through its own arms, wherever it has one (decision 5)", () => {
  // The frozen api oracle refused every sale rewind; decision 5 made them typed
  // reversals. So the oracle for a sale is now the RENTAL decomposition: same
  // pairing, same steps, each step's movement read off the sale arm — and a
  // delta that needs a rule the sale lacks (a shelf loss, a flag) is unmatched.
  const states = statesAt(3);
  let same = 0;
  let refused = 0;
  for (const prev of states) {
    for (const next of states) {
      const rental = decomposeCustodyDelta(prev, next, "rental");
      const sale = decomposeCustodyDelta(prev, next, "sale");
      const pair = `${JSON.stringify(prev)} → ${JSON.stringify(next)}`;
      if (rental.steps.some((st) => custodyRule(st.rule).sale === null)) {
        assertEquals(sale.matched, false, pair);
        refused++;
        continue;
      }
      assertEquals(sale.steps, rental.steps, pair);
      assertEquals(sale.matched, rental.matched, pair);
      assertEquals(
        sale.transitions.map((t) => t.type),
        sale.steps.map((st) => custodyRule(st.rule).sale!.movement).filter((m) => m !== null),
        pair,
      );
      same++;
    }
  }
  assert(same > 1000 && refused > 100, `same ${same}, refused ${refused}`);
  // The rewinds and losses that wrote nothing before now write their movements.
  assertEquals(shape(decomposeCustodyDelta(bd({ out: 2 }), bd({ prepped: 2 }), "sale").transitions), ["sale_undo:out→prepped×2"]);
  assertEquals(shape(decomposeCustodyDelta(bd({ out: 2 }), bd({ out: 1, lost: 1 }), "sale").transitions), ["sale_lost:out→lost×1"]);
});

Deno.test("custody - a service or surcharge booking decomposes to nothing", () => {
  const got = decomposeCustodyDelta(bd({ reserved: 2 }), bd({ out: 2 }), "service");
  assertEquals(got, { matched: true, steps: [], transitions: [], residue: { falls: {}, rises: {} } });
});

Deno.test("custody - an unmatched delta reports its residue", () => {
  const got = decomposeCustodyDelta(bd({ prepped: 2 }), bd({ returned: 2 }), "rental");
  assertEquals(got.matched, false);
  assertEquals(got.residue, { falls: { prepped: 2 }, rises: { returned: 2 } });
  assertEquals(decomposeCustodyDelta(bd({ reserved: 1 }), bd({ lost: 1 }), "rental").residue, {
    falls: { reserved: 1 },
    rises: { lost: 1 },
  });
});

// ── 3. apply ≡ decompose ─────────────────────────────────────────────

Deno.test("custody - applying every matched decomposition lands exactly on next, with the same movements", () => {
  const states = statesAt(3);
  let applied = 0;
  let refusedTwoOrigin = 0;
  for (const type of ["rental", "sale"] as const) {
    for (const prev of states) {
      for (const next of states) {
        const undos = type === "rental" ? canonicalLossUndos(prev, next) : [];
        const d = decomposeCustodyDelta(prev, next, type, undos);
        if (!d.matched || d.steps.length === 0) continue;
        const b = booking(3, prev, "active", type);
        try {
          const r = applyCustodyActions(b, d.steps);
          assertEquals(r.breakdown, next, `${type} ${JSON.stringify(prev)} → ${JSON.stringify(next)}`);
          assertEquals(shape(r.transitions), shape(d.transitions));
          applied++;
        } catch (e) {
          // Two loss marks (or undos) of one type from two places are one
          // movement id twice: the wire refuses them, and so does apply.
          assert(e instanceof CustodyRefusal, String(e));
          assert(/same "(mark_lost|mark_lost_undo|flag)" movement/.test(e.message), e.message);
          refusedTwoOrigin++;
        }
      }
    }
  }
  assert(applied > 1000, `only ${applied} applied`);
  assert(refusedTwoOrigin > 0);
});

Deno.test("custody - apply refuses a short source bucket rather than clamping (the lost-update bug)", () => {
  const b = booking(3, { out: 1, returned: 2 }, "active");
  assertThrows(() => applyCustodyActions(b, [{ rule: "check_in", quantity: 2 }]), CustodyRefusal, "holds 1");
});

Deno.test("custody - apply refuses a sale's shelf loss and a pre-departure loss", () => {
  assertThrows(
    () => applyCustodyActions(booking(2, { returned: 2 }, "active", "sale"), [{ rule: "mark_lost_returned", quantity: 1 }]),
    CustodyRefusal,
    "cannot take",
  );
  assertThrows(
    () => applyCustodyActions(booking(2, { reserved: 2 }), [{ rule: "mark_lost", quantity: 1 }]),
    CustodyRefusal,
    "from out",
  );
});

Deno.test("custody - a sale's loss writes a custody-only movement, and its rewind a typed reversal (G6, decision 5)", () => {
  const r = applyCustodyActions(booking(2, { out: 2 }, "active", "sale"), [{ rule: "mark_lost", quantity: 1 }]);
  assertEquals(r.breakdown, bd({ out: 1, lost: 1 }));
  assertEquals(shape(r.transitions), ["sale_lost:out→lost×1"]);
  const back = applyCustodyActions(booking(2, { out: 2 }, "active", "sale"), [{ rule: "check_out_undo", quantity: 2 }]);
  assertEquals(shape(back.transitions), ["sale_undo:out→prepped×2"]);
  assertEquals(back.status, "prepped");
});

Deno.test("custody - every row moves units between two breakdown keys", () => {
  // R2's `flag_returned` was the one `from === to` row, and `custodyRuleForMovement`
  // no longer has a no-custody branch to match one.
  for (const r of CUSTODY_RULES) assert(r.from !== r.to, `${r.id}: from === to`);
});

Deno.test("custody - flag after return (G2): check in 3, flag 2 cleaning in the same save; the unflagged bound holds", () => {
  const b = booking(3, { out: 3 }, "active");
  const r = applyCustodyActions(b, [
    { rule: "check_in", quantity: 3 },
    { rule: "flag_cleaning_returned", quantity: 2 },
  ]);
  assertEquals(r.breakdown, bd({ returned: 1, cleaning: 2 }));
  assertEquals(r.status, "complete");
  assertEquals(r.transitions.map((t) => [t.type, t.service]), [
    ["check_in", null],
    ["flag", { from: null, to: "cleaning" }],
  ]);
  // Flagging already-returned units, net of those already flagged.
  const back = booking(3, { returned: 3 }, "complete");
  assertThrows(
    () => applyCustodyActions(back, [{ rule: "flag_maintenance_returned", quantity: 2 }], { unflaggedReturned: 1 }),
    CustodyRefusal,
    "only 1",
  );
  // Cleaning and maintenance in one save are two movement slots.
  const both = applyCustodyActions(back, [
    { rule: "flag_cleaning_returned", quantity: 1 },
    { rule: "flag_maintenance_returned", quantity: 1 },
  ]);
  assertEquals(both.transitions.length, 2);
});

Deno.test("custody - a loss undo after a forward step is refused", () => {
  const b = booking(3, { out: 1, lost: 2 }, "active");
  assertThrows(
    () => applyCustodyActions(b, [{ rule: "check_in", quantity: 1 }, { rule: "mark_lost_undo", quantity: 1 }]),
    CustodyRefusal,
    "before every forward",
  );
});

// ── 4. the manager's 24 cases (manager tests/utils/bookingTransitions.test.ts) ──

Deno.test("custody - manager cases: forward", async (t) => {
  await t.step("full prep → prepped", () => {
    const r = applyCustodyActions(booking(3, { reserved: 3 }), [{ rule: "prep", quantity: 3 }]);
    assertEquals([r.breakdown.reserved, r.breakdown.prepped, r.status], [0, 3, "prepped"]);
  });
  await t.step("partial prep → part-prepped", () => {
    const r = applyCustodyActions(booking(3, { reserved: 3 }), [{ rule: "prep", quantity: 2 }]);
    assertEquals([r.breakdown.reserved, r.breakdown.prepped, r.status], [1, 2, "part-prepped"]);
  });
  await t.step("full checkout → active", () => {
    const r = applyCustodyActions(booking(3, { prepped: 3 }, "prepped"), [{ rule: "check_out", quantity: 3 }]);
    assertEquals([r.breakdown.prepped, r.breakdown.out, r.status], [0, 3, "active"]);
  });
  await t.step("partial checkout → active", () => {
    const r = applyCustodyActions(booking(3, { prepped: 3 }, "prepped"), [{ rule: "check_out", quantity: 1 }]);
    assertEquals([r.breakdown.prepped, r.breakdown.out, r.status], [2, 1, "active"]);
  });
  await t.step("full return → complete", () => {
    const r = applyCustodyActions(booking(3, { out: 3 }, "active"), [{ rule: "check_in", quantity: 3 }]);
    assertEquals([r.breakdown.out, r.breakdown.returned, r.status], [0, 3, "complete"]);
  });
  await t.step("partial return keeps active", () => {
    const r = applyCustodyActions(booking(3, { out: 3 }, "active"), [{ rule: "check_in", quantity: 1 }]);
    assertEquals([r.breakdown.out, r.breakdown.returned, r.status], [2, 1, "active"]);
  });
  await t.step("Mark Lost splits into lost", () => {
    const r = applyCustodyActions(booking(3, { out: 3 }, "active"), [{ rule: "mark_lost", quantity: 1 }]);
    assertEquals([r.breakdown.out, r.breakdown.lost, r.breakdown.returned, r.status], [2, 1, 0, "active"]);
  });
  await t.step("Mark Damaged splits into damaged", () => {
    const r = applyCustodyActions(booking(3, { out: 3 }, "active"), [{ rule: "mark_damaged", quantity: 1 }]);
    assertEquals([r.breakdown.damaged, r.breakdown.out, r.status], [1, 2, "active"]);
  });
  await t.step("returned + lost + damaged counts toward complete", () => {
    const r = applyCustodyActions(booking(3, { out: 1, returned: 1, lost: 1 }, "active"), [{ rule: "mark_damaged", quantity: 1 }]);
    assertEquals([r.breakdown.damaged, r.status], [1, "complete"]);
  });
  await t.step("🔴 Mark Lost from reserved is now REFUSED (gap G1) — the manager moved reserved → lost", () => {
    assertThrows(() => applyCustodyActions(booking(3, { reserved: 3 }), [{ rule: "mark_lost", quantity: 1 }]), CustodyRefusal);
    assertEquals(
      custodyActionsFor(booking(3, { reserved: 3 }), { canPrepCheckout: true }).some((o) => o.rule === "mark_lost"),
      false,
    );
  });
  await t.step("Check Out from reserved is prep + check_out → active", () => {
    const b = booking(3, { reserved: 3 });
    const actions = expandCustodyOffer(b, { rule: "check_out" }, 3);
    assertEquals(actions, [{ rule: "prep", quantity: 3 }, { rule: "check_out", quantity: 3 }]);
    const r = applyCustodyActions(b, actions);
    assertEquals([r.breakdown.reserved, r.breakdown.out, r.status], [0, 3, "active"]);
  });
  await t.step("preserves the breakdown sum", () => {
    const r = applyCustodyActions(booking(5, { reserved: 5 }), [{ rule: "prep", quantity: 3 }]);
    assertEquals(Object.values(r.breakdown).reduce((a, b) => a + b, 0), 5);
  });
  await t.step("rejects qty larger than the source bucket", () => {
    assertThrows(
      () => applyCustodyActions(booking(3, { reserved: 1, prepped: 2 }), [{ rule: "prep", quantity: 2 }]),
      CustodyRefusal,
      "reserved, which holds 1",
    );
  });
  await t.step("rejects a zero quantity", () => {
    assertThrows(() => applyCustodyActions(booking(3, { reserved: 3 }), [{ rule: "prep", quantity: 0 }]), CustodyRefusal, "positive");
  });
});

Deno.test("custody - manager cases: regression", async (t) => {
  const run = (b: ReturnType<typeof booking>, rule: CustodyRuleId, q: number) => applyCustodyActions(b, [{ rule, quantity: q }]);
  await t.step("undo a full check-out → prepped", () => {
    const r = run(booking(3, { out: 3 }, "active"), "check_out_undo", 3);
    assertEquals([r.breakdown.out, r.breakdown.prepped, r.status], [0, 3, "prepped"]);
  });
  await t.step("undo a partial check-out stays active", () => {
    const r = run(booking(3, { out: 3 }, "active"), "check_out_undo", 1);
    assertEquals([r.breakdown.out, r.breakdown.prepped, r.status], [2, 1, "active"]);
  });
  await t.step("undo a full prep → reserved", () => {
    const r = run(booking(3, { prepped: 3 }, "prepped"), "unprep", 3);
    assertEquals([r.breakdown.prepped, r.breakdown.reserved, r.status], [0, 3, "reserved"]);
  });
  await t.step("undo a partial prep → part-prepped", () => {
    const r = run(booking(3, { prepped: 3 }, "prepped"), "unprep", 1);
    assertEquals([r.breakdown.prepped, r.breakdown.reserved, r.status], [2, 1, "part-prepped"]);
  });
  await t.step("undo a return → active", () => {
    const r = run(booking(3, { returned: 3 }, "complete"), "check_in_undo", 3);
    assertEquals([r.breakdown.returned, r.breakdown.out, r.status], [0, 3, "active"]);
  });
  await t.step("undo lost → active even with some still terminal", () => {
    const r = run(booking(3, { returned: 1, lost: 2 }, "complete"), "mark_lost_undo", 1);
    assertEquals([r.breakdown.lost, r.breakdown.out, r.status], [1, 1, "active"]);
  });
  await t.step("undo damaged → out", () => {
    const r = run(booking(3, { damaged: 3 }, "complete"), "mark_damaged_undo", 2);
    assertEquals([r.breakdown.damaged, r.breakdown.out, r.status], [1, 2, "active"]);
  });
  await t.step("preserves the breakdown sum", () => {
    const r = run(booking(5, { out: 5 }, "active"), "check_out_undo", 3);
    assertEquals(Object.values(r.breakdown).reduce((a, b) => a + b, 0), 5);
  });
  await t.step("rejects qty larger than the source bucket", () => {
    assertThrows(() => run(booking(3, { out: 1 }, "active"), "check_out_undo", 2), CustodyRefusal, "out, which holds 1");
  });
  await t.step("rejects a zero quantity", () => {
    assertThrows(() => run(booking(3, { out: 3 }, "active"), "check_out_undo", 0), CustodyRefusal, "positive");
  });
});

Deno.test("custody - ONE status rule: a mixed booking reads off its breakdown, not the action taken", () => {
  const status = (breakdown: Partial<BookingBreakdown>, quantity: number, type: Booking["type"] = "rental") =>
    deriveCustodyStatus({ type, quantity, breakdown: bd(breakdown) });
  // The manager's forward rule said part-prepped here; the breakdown says units are out.
  assertEquals(status({ reserved: 1, prepped: 1, out: 1 }, 3), "active");
  // Mixed plan keys read as the further one.
  assertEquals(status({ quoted: 1, reserved: 1 }, 2), "reserved");
  assertEquals(status({ quoted: 2 }, 2), "quoted");
  // Units back while others were never prepped: custody moved and is not settled.
  assertEquals(status({ returned: 2, reserved: 2 }, 4), "active");
  // Decision 9: a sale fully out is the customer's, so nothing is left to do.
  assertEquals(status({ out: 3 }, 3, "sale"), "complete");
  assertEquals(status({ out: 3 }, 3, "rental"), "active");
  assertEquals(status({ out: 2, reserved: 1 }, 3, "sale"), "active");
});

Deno.test("custody - deriveCustodyStatus is total over every breakdown at quantity 3, and agrees with a by-definition oracle", () => {
  const KEYS = ["quoted", "reserved", "prepped", "out", "returned", "lost", "damaged", "cleaning", "maintenance"] as const;
  let checked = 0;
  for (const type of ["rental", "sale"] as const) {
    for (const b of statesAt(3, KEYS)) {
      // The oracle states each row from its own definition, not through isBookingClosed.
      const work = b.quoted + b.reserved + b.prepped + (type === "rental" ? b.out : 0);
      const pastPrep = b.out + b.returned + b.lost + b.damaged + b.cleaning + b.maintenance;
      const expected = work === 0
        ? "complete"
        : pastPrep > 0
        ? "active"
        : b.prepped === 3
        ? "prepped"
        : b.prepped > 0
        ? "part-prepped"
        : b.reserved > 0
        ? "reserved"
        : "quoted";
      assertEquals(deriveCustodyStatus({ type, quantity: 3, breakdown: b }), expected, `${type} ${JSON.stringify(b)}`);
      checked++;
    }
  }
  assertEquals(checked, 2 * 165, "every 9-key breakdown summing to 3, per type");
});

// ── offers ───────────────────────────────────────────────────────────

Deno.test("custody - offers: returned units get Lost, Damaged, Cleaning and Maintenance (G5); natural first", () => {
  const offers = custodyActionsFor(booking(4, { out: 2, returned: 2 }, "active"), { canPrepCheckout: true, unflaggedReturned: 1 });
  assertEquals(offers[0].key, "check_in");
  assertEquals(offers[0].natural, true);
  const byKey = Object.fromEntries(offers.map((o) => [o.key, o.max]));
  assertEquals(byKey["mark_lost_returned"], 2);
  assertEquals(byKey["flag_damaged_returned"], 1);
  // P2b: the buckets' own rows.
  assertEquals(byKey["flag_cleaning_returned"], 1);
  assertEquals(byKey["flag_maintenance_returned"], 1);
  assertEquals(byKey["mark_cleaning"], 2);
  assertEquals(byKey["mark_maintenance"], 2);
  assertEquals(byKey["check_in_undo"], 2);
  assertEquals(offers.filter((o) => o.natural).length, 1);
  assertEquals(new Set(offers.map((o) => o.key)).size, offers.length, "an offer key repeats");
});

Deno.test("custody - offers: prep and check-out are gated on the fulfillment status; returns never are", () => {
  const b = booking(3, { reserved: 1, out: 2 }, "active");
  const closed = custodyActionsFor(b, { canPrepCheckout: false }).map((o) => o.key);
  assert(!closed.includes("prep") && !closed.includes("check_out"));
  assert(closed.includes("check_in"));
  const open = custodyActionsFor(b, { canPrepCheckout: true }).map((o) => o.key);
  assert(open.includes("prep") && open.includes("check_out"));
});

Deno.test("custody - offers: a sale offers its rewinds (decision 5), and its return is not the natural action", () => {
  const offers = custodyActionsFor(booking(2, { prepped: 1, out: 1 }, "active", "sale"), { canPrepCheckout: true });
  const keys = offers.map((o) => o.key);
  assert(keys.includes("check_out_undo"));
  assert(keys.includes("unprep"));
  assert(!keys.includes("flag_damaged_returned"));
  assertEquals(offers.find((o) => o.natural)?.key, "check_out");
  assertEquals(custodyActionsFor(booking(1, { out: 1 }, "active", "sale"), { canPrepCheckout: true }).some((o) => o.natural), false);
});

Deno.test("custody - offers: loss undos follow the context, and default to the out-origin reading", () => {
  const b = booking(3, { lost: 2, damaged: 1 }, "complete");
  const dflt = Object.fromEntries(custodyActionsFor(b, { canPrepCheckout: true }).map((o) => [o.key, o.max]));
  assertEquals([dflt["mark_lost_undo"], dflt["mark_damaged_undo"], dflt["mark_lost_returned_undo"]], [2, 1, undefined]);
  const split = Object.fromEntries(
    custodyActionsFor(b, { canPrepCheckout: true, undoable: { mark_lost_undo: 0, mark_lost_returned_undo: 1 } }).map((o) => [o.key, o.max]),
  );
  assertEquals([split["mark_lost_undo"], split["mark_lost_returned_undo"], split["mark_damaged_undo"]], [undefined, 1, undefined]);
});

Deno.test("custody - expandCustodyOffer draws already-prepped units first", () => {
  const b = booking(5, { reserved: 3, prepped: 2 });
  assertEquals(expandCustodyOffer(b, { rule: "check_out" }, 2), [{ rule: "check_out", quantity: 2 }]);
  assertEquals(expandCustodyOffer(b, { rule: "check_out" }, 4), [{ rule: "prep", quantity: 2 }, { rule: "check_out", quantity: 4 }]);
  assertEquals(expandCustodyOffer(b, { rule: "flag_cleaning_returned" }, 1), [{ rule: "flag_cleaning_returned", quantity: 1 }]);
});

Deno.test("custody - every offer, taken at its max, applies", () => {
  let applied = 0;
  for (const type of ["rental", "sale"] as const) {
    for (const s of statesAt(3)) {
      const b = booking(3, s, "active", type);
      for (const o of custodyActionsFor(b, { canPrepCheckout: true })) {
        applyCustodyActions(b, expandCustodyOffer(b, o, o.max));
        applied++;
      }
    }
  }
  assert(applied > 400, `only ${applied} offers applied`);
});

// ── the wire ─────────────────────────────────────────────────────────

Deno.test("custody - BookingAction: a known rule and a positive quantity; the R2 rules are gone", () => {
  assert(BookingAction.safeParse({ rule: "check_in", quantity: 1 }).success);
  for (const retired of ["flag_returned", "reclassify_damaged_to_flag", "reclassify_flag_to_damaged"]) {
    assert(!BookingAction.safeParse({ rule: retired, quantity: 1 }).success, retired);
  }
  assert(!BookingAction.safeParse({ rule: "check_in", quantity: 0 }).success);
  assert(!BookingAction.safeParse({ rule: "reserve", quantity: 1 }).success);
});

Deno.test("custody - BookingActions refuses one movement id twice and a loss undo after a forward step", () => {
  assert(!BookingActions.safeParse([{ rule: "mark_lost", quantity: 1 }, { rule: "mark_lost_returned", quantity: 1 }]).success);
  assert(!BookingActions.safeParse([
    { rule: "flag_cleaning_returned", quantity: 1 },
    { rule: "flag_cleaning_returned", quantity: 1 },
  ]).success);
  // A cleaning or maintenance flag is on its reason's own id, so it shares a
  // save with a damaged flag.
  assert(BookingActions.safeParse([
    { rule: "flag_cleaning_returned", quantity: 1 },
    { rule: "flag_damaged_returned", quantity: 1 },
  ]).success);
  assert(BookingActions.safeParse([
    { rule: "flag_cleaning_returned", quantity: 1 },
    { rule: "flag_maintenance_returned", quantity: 1 },
  ]).success);
  assert(!BookingActions.safeParse([
    { rule: "flag_damaged_returned_undo", quantity: 1 },
    { rule: "flag_damaged_returned", quantity: 1 },
  ]).success, "a damaged flag and its own clearing flag are one id");
  assert(!BookingActions.safeParse([{ rule: "check_in", quantity: 1 }, { rule: "mark_lost_undo", quantity: 1 }]).success);
  assert(BookingActions.safeParse([{ rule: "mark_lost_undo", quantity: 1 }, { rule: "check_in", quantity: 1 }]).success);
  assert(!BookingActions.safeParse([]).success);
});

Deno.test("custody P4 - the booking inputs are actions-only, and REFUSE the retired delta keys rather than strip them", () => {
  const uuid_session = crypto.randomUUID();
  const uid = `aaaaaaaaaaaaaaaaaaaa:bbbbbbbbbbbbbbbbbbbb:${crypto.randomUUID()}`;
  const actions = [{ rule: "check_out", quantity: 1 }];
  const retired: Record<string, unknown> = { status: "complete", breakdown: bd({ out: 1 }), return_flags: { cleaning: 1, maintenance: 0 } };
  const inputs: [string, z.ZodType, Record<string, unknown>][] = [
    ["UpdateBookingInput", UpdateBookingInput, { version: 1, uuid_session, actions }],
    ["BookingUpdate", BookingUpdate, { uid, version: 1, actions }],
  ];
  for (const [name, schema, valid] of inputs) {
    assert(schema.safeParse(valid).success, `${name}: the actions-only control parses`);
    const { actions: _a, ...noActions } = valid;
    const missing = schema.safeParse(noActions);
    assertEquals(missing.error?.issues.map((i) => i.path), [["actions"]], `${name}: actions are required`);
    // Each retired key alone, beside valid actions: a 400 naming exactly it. A
    // stripped key would parse, which is the silent no-op this exists to stop.
    for (const [key, value] of Object.entries(retired)) {
      const r = schema.safeParse({ ...valid, [key]: value });
      assertEquals(r.error?.issues.map((i) => i.path), [[key]], `${name}: "${key}" must be refused, by name`);
      assert(r.error!.issues[0].message.includes("retired"), `${name}: "${key}"'s message says why`);
    }
    // ...and the old delta body, with no actions at all, fails on both counts.
    assert(!schema.safeParse({ ...noActions, breakdown: retired.breakdown }).success, `${name}: a bare delta body`);
    // Any OTHER unknown key still strips, as an input schema's does.
    const extra = schema.safeParse({ ...valid, client_hint: "x" });
    assert(extra.success && !("client_hint" in (extra.data as object)), `${name}: an unrelated key strips`);
  }
  assert(BulkBookingUpdateInput.safeParse({ version: 1, uuid_session, updates: [{ uid, version: 1, actions }] }).success);
  assert(!BulkBookingUpdateInput.safeParse({ version: 1, uuid_session, updates: [{ uid, version: 1, actions, breakdown: retired.breakdown }] }).success);
});

Deno.test("custody P4 - every retired key states an OpenAPI `type`, or a consumer's generator throws for the whole document", () => {
  // zod-to-openapi has no mapping for `never` and raises UnknownZodTypeError on
  // any schema without a stated `type` — which took down api-cloudrun's whole
  // /openapi.json the moment it pinned beta.573. This asserts the declaration
  // the generator reads, since core carries no generator of its own.
  for (const [name, schema] of [["UpdateBookingInput", UpdateBookingInput], ["BookingUpdate", BookingUpdate]] as const) {
    // deno-lint-ignore no-explicit-any
    const shape = (schema as any)._zod.def.shape as Record<string, z.ZodType>;
    for (const key of ["status", "breakdown", "return_flags"]) {
      // deno-lint-ignore no-explicit-any
      const inner = (shape[key] as any)._zod.def.innerType as z.ZodType;
      // deno-lint-ignore no-explicit-any
      assertEquals((inner as any)._zod.def.type, "never", `${name}.${key} is still a never`);
      const meta = z.globalRegistry.get(inner) as { type?: string; not?: unknown } | undefined;
      assertEquals(meta?.type, "null", `${name}.${key} states a type`);
      assertEquals(meta?.not, {}, `${name}.${key} says nothing validates`);
    }
  }
});

// ── the record side ──────────────────────────────────────────────────

Deno.test("custody - PARITY: serviceMovesFor ≡ the api's planBucketMoves over every breakdown pair at quantity 3", () => {
  const q = 3;
  const oos: OOSBreakdown[] = [];
  for (let f = 0; f <= q; f++) {
    for (let a = 0; a <= q - f; a++) {
      for (let w = 0; w <= q - f - a; w++) {
        for (let r = 0; r <= q - f - a - w; r++) oos.push({ flagged: f, away: a, written_off: w, returned_to_service: r });
      }
    }
  }
  let ok = 0;
  let refused = 0;
  for (const reason of ["damaged", "cleaning", "maintenance", "lost"] as OOSReasonType[]) {
    for (const prev of oos) {
      for (const next of oos) {
        let want: unknown;
        let wantErr: string | null = null;
        try {
          want = oracle.planBucketMoves(prev, next, q, reason);
        } catch (e) {
          wantErr = (e as Error).message;
        }
        const got = serviceMovesFor({ quantity: q, reason, breakdown: prev }, next);
        if (wantErr === null) {
          assert(got.ok, `${reason} ${JSON.stringify(prev)} → ${JSON.stringify(next)}`);
          assertEquals(got.moves, want);
          ok++;
        } else {
          assert(!got.ok);
          assertEquals(got.internal, wantErr === "internal");
          refused++;
        }
      }
    }
  }
  assert(ok > 1000 && refused > 1000, `${ok} ok / ${refused} refused`);
});

Deno.test("custody - record bounds: returned-to-service never falls, lost never flags, closed only un-writes-off", () => {
  const open = { status: "active" as const, reason: "damaged" as const, quantity: 3, breakdown: { flagged: 1, away: 0, written_off: 0, returned_to_service: 1 } };
  assertEquals(serviceBucketBounds(open, "returned_to_service"), { min: 1, max: null });
  assertEquals(serviceBucketBounds({ ...open, reason: "lost" }, "flagged"), { min: 0, max: 0 });
  const closed = { ...open, status: "complete" as const, breakdown: { flagged: 0, away: 0, written_off: 2, returned_to_service: 1 } };
  assertEquals(serviceBucketBounds(closed, "written_off"), { min: 0, max: 2 });
  assertEquals(serviceBucketBounds(closed, "away"), { min: 0, max: null });
  assertEquals(canEditServiceBreakdown(closed), true);
  assertEquals(canEditServiceBreakdown({ ...closed, breakdown: { ...closed.breakdown, written_off: 0 } }), false);
  assertEquals(serviceBreakdownViolation(open, { ...open.breakdown, returned_to_service: 0, flagged: 2 }) !== null, true);
  assertEquals(serviceBreakdownViolation(open, { ...open.breakdown, away: 1 }), null);
  for (const key of OOS_BREAKDOWN_KEYS) assert(serviceBucketBounds(open, key).min >= 0);
});

Deno.test("custody - every core enforced_by ref names a file that contains its anchor", async () => {
  let checked = 0;
  for (const r of CUSTODY_RULES) {
    assert(r.enforced_by.length > 0, `${r.id} names nothing that enforces it`);
    for (const e of r.enforced_by) {
      assert(!/:\d+$/.test(e.ref), `${r.id}: a :line ref is banned (${e.ref})`);
      if (!e.ref.startsWith("core/")) continue;
      const [path, anchor] = e.ref.slice("core/".length).split("::");
      const text = await Deno.readTextFile(new URL(`../${path}`, import.meta.url));
      if (anchor) assert(text.includes(anchor), `${r.id}: "${anchor}" is not in ${path}`);
      checked++;
    }
  }
  assertEquals(checked, CUSTODY_RULES.length);
});

// ── 5. cleaning and maintenance as booking buckets (P2b) ─────────────

Deno.test("custody P2b - applying every matched decomposition over ALL nine keys lands on next", () => {
  const keys: BookingBreakdownKeyType[] = ["reserved", "prepped", "out", "returned", "lost", "damaged", "cleaning", "maintenance"];
  const states = statesAt(2, keys);
  let applied = 0;
  let newRules = 0;
  for (const prev of states) {
    for (const next of states) {
      const d = decomposeCustodyDelta(prev, next, "rental", canonicalLossUndos(prev, next));
      if (!d.matched || d.steps.length === 0) continue;
      try {
        const r = applyCustodyActions(booking(2, prev, "active"), d.steps);
        assertEquals(r.breakdown, next, `${JSON.stringify(prev)} → ${JSON.stringify(next)}`);
        assertEquals(shape(r.transitions), shape(d.transitions));
        applied++;
        if (d.steps.some((st) => /cleaning|maintenance/.test(st.rule))) newRules++;
      } catch (e) {
        assert(e instanceof CustodyRefusal, String(e));
        assert(/same "[a-z_]+" movement/.test(e.message), e.message);
      }
    }
  }
  assert(applied > 500, `only ${applied} applied`);
  // The sweep has to REACH the new rows, or a clean run says nothing about them.
  assert(newRules > 100, `only ${newRules} decompositions used a cleaning/maintenance rule`);
});

Deno.test("custody P2b - a dirty return is mark_cleaning, one movement, and the booking completes", () => {
  const r = applyCustodyActions(booking(3, { out: 3 }, "active"), [
    { rule: "check_in", quantity: 1 },
    { rule: "mark_cleaning", quantity: 1 },
    { rule: "mark_maintenance", quantity: 1 },
  ]);
  assertEquals(r.breakdown, bd({ returned: 1, cleaning: 1, maintenance: 1 }));
  assertEquals(r.status, "complete");
  assertEquals(r.transitions.map((t) => [t.type, t.from, t.to, t.service]), [
    ["check_in", "out", "returned", null],
    ["mark_cleaning", "out", "cleaning", null],
    ["mark_maintenance", "out", "maintenance", null],
  ]);
});

Deno.test("custody P2b - a sale refuses cleaning and maintenance (ruling 4)", () => {
  for (const rule of ["mark_cleaning", "mark_maintenance"] as const) {
    assertThrows(
      () => applyCustodyActions(booking(2, { out: 2 }, "active", "sale"), [{ rule, quantity: 1 }]),
      CustodyRefusal,
      "cannot take",
    );
  }
  assertEquals(decomposeCustodyDelta(bd({ out: 2 }), bd({ out: 1, cleaning: 1 }), "sale").matched, false);
});

Deno.test("custody P2b - a returned unit flagged in place moves the bucket, bounded by unflagged returns", () => {
  const r = applyCustodyActions(booking(3, { returned: 3 }, "complete"), [{ rule: "flag_cleaning_returned", quantity: 2 }]);
  assertEquals(r.breakdown, bd({ returned: 1, cleaning: 2 }));
  assertEquals(r.transitions[0].service, { from: null, to: "cleaning" });
  assertThrows(
    () => applyCustodyActions(booking(3, { returned: 3 }, "complete"), [{ rule: "flag_maintenance_returned", quantity: 2 }], { unflaggedReturned: 1 }),
    CustodyRefusal,
    "only 1",
  );
  // The bound follows `returned` down: units already flagged are not flaggable again.
  assertThrows(
    () =>
      applyCustodyActions(booking(3, { returned: 3 }, "complete"), [
        { rule: "flag_cleaning_returned", quantity: 2 },
        { rule: "flag_damaged_returned", quantity: 2 },
      ]),
    CustodyRefusal,
  );
});

Deno.test("custody P2b - a reclassification among the three reasons is a bucket move (G3)", () => {
  const r = applyCustodyActions(booking(2, { damaged: 2 }, "complete"), [{ rule: "reclassify_damaged_to_cleaning", quantity: 2 }]);
  assertEquals(r.breakdown, bd({ cleaning: 2 }));
  assertEquals(r.status, "complete");
  assertEquals(r.transitions[0].service, { from: "damaged", to: "cleaning" });
  const d = decomposeCustodyDelta(bd({ cleaning: 1, maintenance: 1 }), bd({ damaged: 1, cleaning: 1 }), "rental");
  assertEquals(d.steps, [{ rule: "reclassify_maintenance_to_damaged", quantity: 1 }]);
  // A reclassification is a record-page action, never a row offer.
  const offers = custodyActionsFor(booking(2, { damaged: 1, cleaning: 1 }, "complete"), { canPrepCheckout: true });
  assert(!offers.some((o) => o.rule.startsWith("reclassify_")));
});

Deno.test("custody P2b - the undos are loss undos, applied first, and read their origin", () => {
  for (const id of ["mark_cleaning_undo", "mark_maintenance_undo", "flag_cleaning_returned_undo", "flag_maintenance_returned_undo"] as const) {
    assert(isLossUndo(id), id);
  }
  assert(!isLossUndo("reclassify_cleaning_to_damaged"));
  const out = decomposeCustodyDelta(bd({ cleaning: 2 }), bd({ out: 2 }), "rental", canonicalLossUndos(bd({ cleaning: 2 }), bd({ out: 2 })));
  assertEquals(out.steps, [{ rule: "mark_cleaning_undo", quantity: 2 }]);
  const shelf = decomposeCustodyDelta(bd({ maintenance: 1 }), bd({ returned: 1 }), "rental", [
    { reason: "maintenance", origin: "returned", quantity: 1 },
  ]);
  assertEquals(shelf.steps, [{ rule: "flag_maintenance_returned_undo", quantity: 1 }]);
  // Absent a record, every cleaning unit reads as marked off `out`.
  const offers = Object.fromEntries(
    custodyActionsFor(booking(2, { cleaning: 1, maintenance: 1 }, "complete"), { canPrepCheckout: true }).map((o) => [o.key, o.max]),
  );
  assertEquals([offers["mark_cleaning_undo"], offers["mark_maintenance_undo"]], [1, 1]);
});

Deno.test("custody P2b - stored movements find their rows; the R2 no-custody flag still does", () => {
  assertEquals(custodyRuleForMovement("mark_cleaning", { from: "out", to: "cleaning" }, null, "rental")?.id, "mark_cleaning");
  assertEquals(custodyRuleForMovement("mark_maintenance_undo", { from: "maintenance", to: "out" }, null, "rental")?.id, "mark_maintenance_undo");
  assertEquals(
    custodyRuleForMovement("flag", { from: "returned", to: "cleaning" }, { from: null, to: "cleaning" }, "rental")?.id,
    "flag_cleaning_returned",
  );
  assertEquals(
    custodyRuleForMovement("flag", { from: "cleaning", to: "maintenance" }, { from: "cleaning", to: "maintenance" }, "rental")?.id,
    "reclassify_cleaning_to_maintenance",
  );
  assertEquals(custodyRuleForMovement("flag", null, { from: null, to: "cleaning" }, "rental"), null);
  // A custody pair and a service axis that disagree are no row.
  assertEquals(custodyRuleForMovement("flag", { from: "returned", to: "cleaning" }, { from: null, to: "maintenance" }, "rental"), null);
});


// ── the ladder's movements and where they put units ──────────────────

Deno.test("custody - custodyMovementTypes: the rental set is the api's LADDER_MOVEMENT_TYPES, the sale set its four", () => {
  // api-cloudrun src/lib/bookingMovements.ts LADDER_MOVEMENT_TYPES, frozen here as the oracle.
  assertEquals(new Set(custodyMovementTypes("rental")), new Set([
    "prep", "check_out", "check_in", "mark_damaged", "mark_lost", "unprep", "check_out_undo", "check_in_undo",
    "mark_lost_undo", "mark_damaged_undo", "mark_cleaning", "mark_cleaning_undo", "mark_maintenance",
    "mark_maintenance_undo", "flag",
  ]));
  assertEquals(custodyMovementTypes("sale"), [
    "prep", "unprep", "sale", "sale_undo", "sale_return", "sale_return_undo",
    "sale_lost", "sale_lost_undo", "sale_damaged", "sale_damaged_undo",
  ]);
  assertEquals(custodyMovementTypes("service"), []);
});

Deno.test("custody - custodyPlaces: out is a booking for a rental and outside for a sale; a flag stays in place", () => {
  assertEquals(custodyPlaces("check_out", { from: "prepped", to: "out" }), { from: "locations", to: "bookings" });
  assertEquals(custodyPlaces("sale", { from: "prepped", to: "out" }), { from: "locations", to: "outside" });
  assertEquals(custodyPlaces("mark_lost_undo", { from: "lost", to: "returned" }), { from: "out-of-service", to: "locations" });
  assertEquals(custodyPlaces("flag", { from: "returned", to: "damaged" }), { from: "locations", to: "locations" });
  assertEquals(custodyPlaces("prep", { from: "reserved", to: "prepped" }), null);
});

Deno.test("custody - isReleasingRewind: every rule arm, as the api's line-netting form measured it (2026-10-08)", () => {
  // The 32 pre-campaign arms were measured by running api-cloudrun's own
  // isReleasingRewind over them: 32 compared, 0 disagree. The six sale arms
  // added by decision 5 are read off their contracts: a sale_undo puts units
  // back on a shelf, a sale_return_undo takes them off, and the custody-only
  // loss undos move nothing.
  const releasing: Record<"rental" | "sale", Set<string>> = {
    rental: new Set([
      "unprep", "check_out_undo", "mark_lost_undo", "mark_lost_returned_undo",
      "flag_damaged_returned_undo", "flag_cleaning_returned_undo", "flag_maintenance_returned_undo",
    ]),
    sale: new Set(["unprep", "check_out_undo", "mark_lost_undo", "mark_damaged_undo"]),
  };
  let checked = 0;
  for (const r of CUSTODY_RULES) {
    for (const [type, arm] of [["rental", r.rental], ["sale", r.sale]] as const) {
      if (!arm?.movement) continue;
      assertEquals(
        isReleasingRewind({ rule: r.id, type: arm.movement, from: r.from, to: r.to, quantity: 2 }),
        releasing[type].has(r.id),
        `${r.id} (${arm.movement})`,
      );
      checked++;
    }
  }
  assertEquals(checked, 38);
});

Deno.test("custody - splitLeadingReleases stops at the first transition that is not a releasing rewind", () => {
  const t = (rule: CustodyRuleId) => {
    const r = custodyRule(rule);
    return { rule, type: r.rental!.movement!, from: r.from, to: r.to, quantity: 1 };
  };
  const { first, rest } = splitLeadingReleases([t("check_out_undo"), t("unprep"), t("prep"), t("unprep")]);
  assertEquals(first.map((x) => x.rule), ["check_out_undo", "unprep"]);
  assertEquals(rest.map((x) => x.rule), ["prep", "unprep"]);
});

// ── loss-undo eligibility ────────────────────────────────────────────

function lossView(over: {
  reason?: "lost" | "damaged" | "cleaning" | "maintenance";
  quantity?: number;
  markFrom?: "out" | "returned";
  markType?: MovementTypeType;
  markTo?: string;
  markQuantity?: number;
  booking?: string;
  written_off?: number;
  billed?: number | null;
  noMark?: boolean;
  toRecord?: boolean;
} = {}): LossRecordView {
  const reason = over.reason ?? "damaged";
  const quantity = over.quantity ?? 2;
  const from = over.markFrom ?? "out";
  return {
    record: {
      uid: "r1",
      number: 7,
      reason,
      quantity,
      breakdown: { flagged: quantity, away: 0, written_off: over.written_off ?? 0, returned_to_service: 0 },
      status: "active",
      canceled_at: null,
      query_by_sources: ["bookings:b1"],
    } as LossRecordView["record"],
    mark: over.noMark ? null : {
      type: over.markType ?? (reason === "lost" ? "mark_lost" : from === "returned" ? "flag" : `mark_${reason}` as MovementTypeType),
      uid_booking: over.booking ?? "b1",
      quantity: over.markQuantity ?? quantity,
      custody: { from, to: (over.markTo ?? reason) as BookingBreakdownKeyType },
      lines: [{
        quantity,
        location: {
          from: null,
          to: over.toRecord ? { collection: "out-of-service", uid: "r1" } : { collection: "locations", uid: "L1" },
        },
      }],
    } as LossRecordView["mark"],
    billed: over.billed === undefined ? 0 : over.billed,
  };
}

Deno.test("custody - lossUndoRefusal: one code per refusal, in the api's order, and null when consumable", () => {
  const code = (v: LossRecordView, reason: "lost" | "damaged" | "cleaning" | "maintenance" = "damaged") =>
    lossUndoRefusal(v, "b1", reason)?.code ?? null;
  assertEquals(code(lossView()), null);
  assertEquals(code(lossView({ markTo: "cleaning" })), "reclassified");
  assertEquals(code(lossView({ markType: "flag", markFrom: "returned", markTo: "cleaning" }), "damaged"), "reclassified");
  assertEquals(code(lossView({ noMark: true })), "no_mark");
  assertEquals(code(lossView({ toRecord: true })), "pre_journal_model");
  assertEquals(code(lossView({ written_off: 1 })), "resolved");
  assertEquals(code(lossView({ billed: 1 })), "billed");
  // Billing unknown (the warehouse role): not refused here, the server decides.
  assertEquals(code(lossView({ billed: null })), null);
  assertEquals(code(lossView({ quantity: 1, markQuantity: 2 })), "split_original");
  assertEquals(code(lossView({ quantity: 3, markQuantity: 2 })), "quantity_mismatch");
  assertEquals(lossUndoRefusal(lossView(), "b2", "damaged")?.code, "other_booking");
  // The api's sentence, verbatim, so the 400 wrapper passes it through.
  assertEquals(
    lossUndoRefusal(lossView({ billed: 2 }), "b1", "damaged")?.message,
    "Cannot undo out-of-service record #7: 2 unit(s) of it are billed on an invoice. " +
      "Credit the invoice, then return the units to service through the record (PUT /out-of-service-records/r1).",
  );
});

Deno.test("custody - undoableFromRecords: offers exactly what lossUndoRefusal lets through, by origin", () => {
  assertEquals(
    undoableFromRecords("b1", [
      lossView({ quantity: 2 }),
      { ...lossView({ quantity: 1, markFrom: "returned" }), record: { ...lossView().record, uid: "r2", quantity: 1 } },
      lossView({ billed: 1 }),
      lossView({ reason: "lost", quantity: 1 }),
    ]),
    { mark_damaged_undo: 2, flag_damaged_returned_undo: 1, mark_lost_undo: 1 },
  );
});

// ── reclassifying a record (gap G3 / G11 (b)) ────────────────────────

Deno.test("custody - planReclassification: the flagged units move, the rest split off, and every api refusal holds", () => {
  const record = (b: Partial<OOSBreakdown>, over: Partial<{ reason: OOSReasonType; status: string; quantity: number }> = {}) => ({
    number: 4,
    reason: over.reason ?? "damaged" as OOSReasonType,
    status: (over.status ?? "active") as "active",
    quantity: over.quantity ?? 3,
    breakdown: { flagged: 0, away: 0, written_off: 0, returned_to_service: 0, ...b },
    units: null,
  });
  const rental = { type: "rental" as const, name: "Light", breakdown: bd({ damaged: 3 }) };
  const ok = planReclassification({ record: record({ flagged: 2, away: 1 }), owner: "booking", booking: rental, to: "cleaning", uncounted: false });
  assertEquals(ok.ok && [ok.transition.rule, ok.transition.quantity, ok.split], ["reclassify_damaged_to_cleaning", 2, true]);
  const refused = (args: Parameters<typeof reclassifyRefusal>[0]) => reclassifyRefusal(args) ?? "";
  const base = { record: record({ flagged: 3 }), owner: "booking" as const, booking: rental, to: "cleaning" as OOSReasonType, uncounted: false };
  assertEquals(refused(base), "");
  assert(refused({ ...base, record: record({ flagged: 3 }, { status: "complete" }) }).includes("it is complete"));
  assert(refused({ ...base, to: "lost" }).includes("from damaged to lost"));
  assert(refused({ ...base, record: record({ away: 3 }, { reason: "lost" }) }).includes("from lost to cleaning"));
  assert(refused({ ...base, owner: "legacy" }).includes("no mark movement"));
  assert(refused({ ...base, booking: { ...rental, type: "sale" } }).includes("a sale booking takes no cleaning"));
  assert(refused({ ...base, record: record({ away: 3 }) }).includes("nothing to re-describe"));
  assert(refused({ ...base, booking: { ...rental, breakdown: bd({ damaged: 1 }) } }).includes("holds 1 damaged"));
  // Uncounted: the away units are relabelled whole, or not at all.
  const uncounted = planReclassification({ ...base, record: record({ away: 3 }), uncounted: true });
  assertEquals(uncounted.ok && [uncounted.transition.quantity, uncounted.split], [3, false]);
  assert(refused({ ...base, record: record({ away: 2, written_off: 1 }), uncounted: true }).includes("relabelled whole"));
  // A standalone record's edit needs no booking.
  assertEquals(refused({ ...base, owner: "standalone", booking: null }), "");
});

Deno.test("custody - recordOwner reads the mark", () => {
  const rec = { query_by_sources: ["bookings:b1"] };
  assertEquals(recordOwner(rec, { uid_booking: "b1", custody: { from: "out", to: "damaged" } }), { kind: "booking", uid_booking: "b1" });
  assertEquals(recordOwner(rec, null), { kind: "legacy" });
  assertEquals(recordOwner({ query_by_sources: [] }, null), { kind: "standalone" });
  assertEquals(recordOwner(rec, { uid_booking: null, custody: null }), { kind: "standalone" });
});

// ── serviceUnitMovesFor: api-cloudrun tests/unit/oosUnits.test.ts, carried over, plus the editor's checks ──

const ob = (over: Partial<OOSBreakdown>): OOSBreakdown => ({ flagged: 0, away: 0, written_off: 0, returned_to_service: 0, ...over });
const ou = (over: Partial<OOSUnitsType>): OOSUnitsType => ({ away: [], flagged: [], returned_to_service: [], written_off: [], ...over });
const unitPlan = (prevB: OOSBreakdown, prevU: OOSUnitsType, next: OOSBreakdown, nextU: OOSUnitsType, quantity: number, reason: OOSReasonType, shelf?: number[]) =>
  serviceUnitMovesFor({ quantity, reason, breakdown: prevB, units: prevU }, next, nextU, shelf ? { shelf } : {});
const refusedWith = (plan: ReturnType<typeof unitPlan>, text: string) => {
  assert(!plan.ok, "expected a refusal");
  assert(!plan.ok && plan.message.includes(text), !plan.ok ? plan.message : "");
};

Deno.test("serviceUnitMovesFor: each unit's own move, journaled in the table's order", () => {
  assertEquals(unitPlan(ob({ flagged: 3 }), ou({ flagged: [1, 2, 3] }), ob({ flagged: 1, away: 1, written_off: 1 }), ou({ flagged: [2], away: [3], written_off: [1] }), 3, "damaged"), {
    ok: true,
    moves: [
      { from: "flagged", to: "written_off", quantity: 1, units: [1] },
      { from: "flagged", to: "away", quantity: 1, units: [3] },
    ],
  });
  // A swap a count-only plan nets to nothing is two moves.
  assertEquals(unitPlan(ob({ flagged: 1, away: 1 }), ou({ flagged: [2], away: [1] }), ob({ flagged: 1, away: 1 }), ou({ flagged: [1], away: [2] }), 2, "damaged"), {
    ok: true,
    moves: [
      { from: "flagged", to: "away", quantity: 1, units: [2] },
      { from: "away", to: "flagged", quantity: 1, units: [1] },
    ],
  });
  assertEquals(unitPlan(ob({}), ou({}), ob({ flagged: 2 }), ou({ flagged: [7, 9] }), 2, "cleaning"), {
    ok: true,
    moves: [{ from: "unplaced", to: "flagged", quantity: 2, units: [7, 9] }],
  });
  assertEquals(unitPlan(ob({}), ou({}), ob({ returned_to_service: 2 }), ou({}), 2, "maintenance"), {
    ok: true,
    moves: [{ from: "unplaced", to: "returned_to_service", quantity: 2, units: [] }],
  });
  // A found unit is a written_off → X move, first (D8).
  assertEquals(unitPlan(ob({ written_off: 2 }), ou({ written_off: [1, 2] }), ob({ away: 1, returned_to_service: 1 }), ou({ away: [1], returned_to_service: [2] }), 2, "lost"), {
    ok: true,
    moves: [
      { from: "written_off", to: "away", quantity: 1, units: [1] },
      { from: "written_off", to: "returned_to_service", quantity: 1, units: [2] },
    ],
  });
});

Deno.test("serviceUnitMovesFor: every api refusal, and the editor's own (G11 (c))", () => {
  refusedWith(unitPlan(ob({ flagged: 2 }), ou({ flagged: [1, 2] }), ob({ returned_to_service: 2 }), ou({ flagged: [1, 2] }), 2, "damaged"), '"flagged → returned_to_service" must name the 2 unit(s)');
  refusedWith(unitPlan(ob({ flagged: 2 }), ou({ flagged: [1, 2] }), ob({ flagged: 2 }), ou({ flagged: [1] }), 2, "damaged"), "cannot leave this record's buckets");
  refusedWith(unitPlan(ob({ written_off: 1 }), ou({}), ob({ away: 1 }), ou({}), 1, "lost"), "written-off units back");
  // Out of returned_to_service: the manager offered it, the api refused it.
  refusedWith(unitPlan(ob({ returned_to_service: 1 }), ou({ returned_to_service: [1] }), ob({ flagged: 1 }), ou({ flagged: [1] }), 1, "damaged"), "cannot be taken back out");
  refusedWith(unitPlan(ob({ away: 1 }), ou({ away: [1] }), ob({ flagged: 1 }), ou({ flagged: [1] }), 1, "lost"), "lost unit");
  refusedWith(unitPlan(ob({ written_off: 1 }), ou({ written_off: [1] }), ob({}), ou({}), 1, "lost"), "cannot leave this record's buckets");
  // The editor's checks, now the api's too.
  refusedWith(unitPlan(ob({}), ou({}), ob({ flagged: 1, away: 1 }), ou({ flagged: [5], away: [5] }), 2, "damaged"), "in two of this record's buckets");
  refusedWith(unitPlan(ob({}), ou({}), ob({ flagged: 1 }), ou({ flagged: [5] }), 1, "damaged", [6]), "not on the unflagged shelf");
  // A unit new to the record when none is unplaced (an unnamed historic `away` count holds the rest).
  refusedWith(unitPlan(ob({ flagged: 1, away: 1 }), ou({ flagged: [5] }), ob({ flagged: 2 }), ou({ flagged: [5, 6] }), 2, "damaged"), "not yet in effect");
});

// ── extension undo (G11 (d)) ─────────────────────────────────────────

Deno.test("custody - extensionUndoRefusal: one rule for the route, the transaction and the manager's offer", () => {
  const A = "ord:prod:legA";
  const B = "ord:prod:legB";
  const bookingB = (over: Partial<{ breakdown: Partial<BookingBreakdown>; quantity_ordered: number; units: number[] | null }> = {}) => ({
    uid: B,
    name: "Light",
    breakdown: bd(over.breakdown ?? { out: 2 }),
    quantity_ordered: over.quantity_ordered ?? 2,
    units: over.units === undefined || over.units === null
      ? null
      : { cleaning: [], damaged: [], lost: [], maintenance: [], out: over.units, prepped: [], returned: [] },
  });
  const rebookIn = (units: number[] = []) => ({
    uid: "m1",
    type: "rebook_in" as const,
    uid_booking: B,
    sources: [{ collection: "bookings" as const, uid: A }],
    quantity: 2,
    units: units.map((n) => ({ uid_unit: `u${n}`, number: n, serial_number: null })),
  });
  const base = { pairUid: "legB", orderPairUids: ["legA", "legB"], bookings: [bookingB()], movements: [rebookIn()] };
  assertEquals(extensionUndoRefusal(base), { ok: true, pairFrom: "legA", units: 2 });
  const why = (args: Parameters<typeof extensionUndoRefusal>[0]) => {
    const r = extensionUndoRefusal(args);
    return r.ok ? "" : r.message;
  };
  assert(why({ ...base, bookings: [] }).includes("holds no units"));
  assert(why({ ...base, movements: [] }).includes("not made by an extension"));
  assert(why({ ...base, movements: [rebookIn(), { ...rebookIn(), uid: "m2", type: "check_in" as const }] }).includes("check in since"));
  assert(why({ ...base, bookings: [bookingB({ breakdown: { out: 1, returned: 1 } })] }).includes("have moved since"));
  assert(why({ ...base, bookings: [bookingB({ quantity_ordered: 1 })] }).includes("have moved since"));
  // Leg A gone from the order — the manager offered it.
  assert(why({ ...base, orderPairUids: ["legB"] }).includes("no longer on the order"));
  // Renamed units — the manager offered it.
  assertEquals(extensionUndoRefusal({ ...base, bookings: [bookingB({ units: [3, 4] })], movements: [rebookIn([3, 4])] }).ok, true);
  assert(why({ ...base, bookings: [bookingB({ units: [3, 5] })], movements: [rebookIn([3, 4])] }).includes("units changed"));
});

// ── custody transfer between bookings (decisions 1 and 11) ───────────

/**
 * api-cloudrun `buildCarryMovements`' output on three carry shapes, MEASURED by
 * running it (2026-10-08): `[type, booking, quantity, custody, counterpart]` in
 * order. The api mints each half's id from these, so matching them is what
 * keeps the grain carry's ids byte-identical once it adopts the planner.
 */
const API_CARRY = {"legacyShapeA": [["rebook_out", "o:p:l", 96, {"from": "returned", "to": null}, "o:p:l:s1"], ["rebook_in", "o:p:l:s1", 61, {"from": null, "to": "returned"}, "o:p:l"], ["rebook_in", "o:p:l:s2", 35, {"from": null, "to": "returned"}, "o:p:l"], ["rebook_out", "o:p:l", 4, {"from": "lost", "to": null}, "o:p:l:s1"], ["rebook_in", "o:p:l:s1", 3, {"from": null, "to": "lost"}, "o:p:l"], ["rebook_in", "o:p:l:s2", 1, {"from": null, "to": "lost"}, "o:p:l"]], "legacyShapeB": [["rebook_out", "o:p:l", 6, {"from": "returned", "to": null}, "o:p:l:s1"], ["rebook_in", "o:p:l:s1", 6, {"from": null, "to": "returned"}, "o:p:l"]], "twoGivers": [["rebook_out", "o:p:l", 2, {"from": "out", "to": null}, "o:p:l:s2"], ["rebook_out", "o:p:l:s1", 2, {"from": "out", "to": null}, "o:p:l:s2"], ["rebook_in", "o:p:l:s2", 4, {"from": null, "to": "out"}, "o:p:l"], ["rebook_out", "o:p:l", 2, {"from": "returned", "to": null}, "o:p:l:s2"], ["rebook_in", "o:p:l:s2", 2, {"from": null, "to": "returned"}, "o:p:l"]]} as Record<string, unknown[]>;

Deno.test("custody - planCustodyTransfer reproduces the api grain carry's halves, in order, on every measured shape", () => {
  const cases: Record<string, Parameters<typeof planCustodyTransfer>[0]["members"]> = {
    legacyShapeA: [
      { uid: "o:p:l", before: bd({ returned: 96, lost: 4 }), after: null },
      { uid: "o:p:l:s1", before: null, after: bd({ returned: 61, lost: 3 }) },
      { uid: "o:p:l:s2", before: null, after: bd({ returned: 35, lost: 1 }) },
    ],
    legacyShapeB: [
      { uid: "o:p:l", before: bd({ returned: 10 }), after: bd({ returned: 4 }) },
      { uid: "o:p:l:s1", before: null, after: bd({ returned: 6 }) },
    ],
    twoGivers: [
      { uid: "o:p:l", before: bd({ out: 3, returned: 2 }), after: bd({ out: 1 }) },
      { uid: "o:p:l:s1", before: bd({ out: 2 }), after: null },
      { uid: "o:p:l:s2", before: null, after: bd({ out: 4, returned: 2 }) },
    ],
  };
  for (const [name, members] of Object.entries(cases)) {
    const plan = planCustodyTransfer({ members, sameProduct: true });
    assert(plan.ok, name);
    const got = plan.ok
      ? plan.steps.flatMap((st) => st.halves.map((h) => [h.type, h.uid_booking, h.quantity, h.custody, h.counterpart]))
      : [];
    assertEquals(got, API_CARRY[name], name);
  }
});

Deno.test("custody - planCustodyTransfer: never creates custody; cross-product moves prepped only, bulk only", () => {
  const unbalanced = planCustodyTransfer({
    members: [{ uid: "a", before: bd({ returned: 2 }), after: bd({ returned: 1 }) }, { uid: "b", before: null, after: bd({ returned: 2 }) }],
    sameProduct: true,
  });
  assert(!unbalanced.ok && unbalanced.message.includes("cannot create or remove custody"));
  // A substitution after prep: X unpreps, Y preps (decision 1).
  const sub = planCustodyTransfer({
    members: [{ uid: "x", before: bd({ prepped: 2, reserved: 1 }), after: bd({ reserved: 3 }) }, { uid: "y", before: bd({ reserved: 2 }), after: bd({ prepped: 2 }) }],
    sameProduct: false,
  });
  assertEquals(sub.ok && sub.steps.flatMap((st) => st.halves.map((h) => [h.type, h.uid_booking, h.quantity])), [
    ["unprep", "x", 2],
    ["prep", "y", 2],
  ]);
  // After check-out it is refused.
  const late = planCustodyTransfer({
    members: [{ uid: "x", before: bd({ out: 2 }), after: null }, { uid: "y", before: null, after: bd({ out: 2 }) }],
    sameProduct: false,
  });
  assert(!late.ok && late.message.includes("Only prepped units move"));
  // A serialized substitution is refused.
  const sets = (prepped: number[]) => ({ cleaning: [], damaged: [], lost: [], maintenance: [], out: [], prepped, returned: [] });
  const serial = planCustodyTransfer({
    members: [
      { uid: "x", before: bd({ prepped: 1 }), after: bd({ reserved: 1 }), unitsBefore: sets([5]), unitsAfter: sets([]) },
      { uid: "y", before: bd({ reserved: 1 }), after: bd({ prepped: 1 }), unitsBefore: sets([]), unitsAfter: sets([5]) },
    ],
    sameProduct: false,
  });
  assert(!serial.ok && serial.message.includes("tracked by number"));
  // A same-product rebook of named units carries them, and mismatched units are refused.
  const ext = planCustodyTransfer({
    members: [
      { uid: "a", before: bd({ out: 2 }), after: bd({}), unitsBefore: { ...sets([]), out: [3, 4] }, unitsAfter: sets([]) },
      { uid: "b", before: null, after: bd({ out: 2 }), unitsBefore: null, unitsAfter: { ...sets([]), out: [3, 4] } },
    ],
    sameProduct: true,
  });
  assertEquals(ext.ok && ext.steps[0].halves.map((h) => h.units), [[3, 4], [3, 4]]);
});

Deno.test("custody - substitutionCapacity: prepped units move; anything past the prep shelf, or a tracked unit, refuses", () => {
  assertEquals(substitutionCapacity({ uid: "x", breakdown: bd({ prepped: 2, reserved: 1 }) }), { prepped: 2, refusal: null });
  assert(substitutionCapacity({ uid: "x", breakdown: bd({ out: 1, prepped: 1 }) }).refusal?.includes("past the prep shelf"));
  assert(substitutionCapacity({ uid: "x", breakdown: bd({ prepped: 1 }), units: { cleaning: [], damaged: [], lost: [], maintenance: [], out: [], prepped: [5], returned: [] } }).refusal?.includes("tracked by number"));
});
