/**
 * The inbound booking ladder's declarations (`schemas/_inbound-breakdown.ts`)
 * and the movement contract's `booking_ladder` — one-document-model 7a, C1 and
 * the additive half of C2.
 */
import { assert, assertEquals } from "@std/assert";
import {
  BOOKING_BREAKDOWN_KEYS,
  CUSTODY_PLACE_KINDS,
  emptyInboundBreakdown,
  INBOUND_BOOKING_TYPES,
  INBOUND_BREAKDOWN_KEYS,
  INBOUND_BREAKDOWN_LABELS,
  INBOUND_CUSTODY_PLACE_KINDS,
  INBOUND_HISTORY_KEYS,
  INBOUND_LADDER_MOVEMENT_TYPES,
  INBOUND_PLAN_KEYS,
  INBOUND_STAGE_TWINS,
  INBOUND_UNIT_BUCKETS,
  InboundBreakdownSchema,
  inboundOwnsKey,
  isInboundLive,
  isInboundTerminal,
  MOVEMENT_CONTRACTS,
  MOVEMENT_TYPES,
  MOVEMENT_UNDOES,
  UNDO_MOVEMENT_TYPES,
} from "../src/schemas/mod.ts";
import type { InboundBookingTypeType, InboundBreakdownKeyType } from "../src/schemas/mod.ts";

Deno.test("inbound labels are UNIQUE (display rule T9: one heading per key)", () => {
  const labels = Object.values(INBOUND_BREAKDOWN_LABELS);
  assertEquals(new Set(labels).size, labels.length, `duplicate label in ${labels.join(", ")}`);
  assertEquals(new Set(Object.keys(INBOUND_BREAKDOWN_LABELS)), new Set(INBOUND_BREAKDOWN_KEYS));
});

Deno.test("plan and history partition the keys, in ladder order", () => {
  assertEquals([...INBOUND_PLAN_KEYS, ...INBOUND_HISTORY_KEYS], [...INBOUND_BREAKDOWN_KEYS]);
});

Deno.test("the unit buckets are the history keys, alphabetized", () => {
  assertEquals([...INBOUND_UNIT_BUCKETS], [...INBOUND_HISTORY_KEYS].sort());
});

Deno.test("the empty breakdown parses and has every key at zero", () => {
  const empty = emptyInboundBreakdown();
  assertEquals(InboundBreakdownSchema.safeParse(empty).success, true);
  for (const k of INBOUND_BREAKDOWN_KEYS) assertEquals(empty[k], 0, k);
  // strict: an outbound-only key is refused, so a booking cannot carry the wrong ladder
  assertEquals(InboundBreakdownSchema.safeParse({ ...empty, prepped: 0 }).success, false);
});

/** The C1 tables, restated as data so a predicate edit is a visible diff here. */
const EXPECTED: Record<InboundBookingTypeType, {
  owns: InboundBreakdownKeyType[];
  terminal: InboundBreakdownKeyType[];
  live: InboundBreakdownKeyType[];
}> = {
  sale: {
    owns: ["received", "stocked", "damaged"],
    terminal: ["stocked", "damaged"],
    live: ["transit_inbound", "received"],
  },
  rental: {
    owns: [],
    terminal: ["sent_back", "lost", "damaged"],
    live: ["transit_inbound", "received", "stocked", "transit_outbound"],
  },
};

Deno.test("per-type predicates match the 7a C1 tables", () => {
  for (const type of INBOUND_BOOKING_TYPES) {
    const e = EXPECTED[type];
    assertEquals(INBOUND_BREAKDOWN_KEYS.filter((k) => inboundOwnsKey(type, k)), e.owns, `${type} owns`);
    assertEquals(INBOUND_BREAKDOWN_KEYS.filter((k) => isInboundTerminal(type, k)), e.terminal, `${type} terminal`);
    assertEquals(INBOUND_BREAKDOWN_KEYS.filter((k) => isInboundLive(type, k)), e.live, `${type} live`);
  }
});

Deno.test("a key is never both live and terminal, and the plan keys are neither", () => {
  for (const type of INBOUND_BOOKING_TYPES) {
    for (const k of INBOUND_BREAKDOWN_KEYS) {
      assert(!(isInboundLive(type, k) && isInboundTerminal(type, k)), `${type}.${k}`);
    }
    for (const k of INBOUND_PLAN_KEYS) {
      assert(!isInboundLive(type, k) && !isInboundTerminal(type, k) && !inboundOwnsKey(type, k), `${type}.${k}`);
    }
  }
});

Deno.test("every stage twin is an outbound key or null (transit, until Phase 9)", () => {
  const outbound = new Set<string>(BOOKING_BREAKDOWN_KEYS);
  for (const k of INBOUND_BREAKDOWN_KEYS) {
    const twin = INBOUND_STAGE_TWINS[k];
    if (twin === null) assert(k.startsWith("transit_"), `${k} has no twin but is not a transit key`);
    else assert(outbound.has(twin), `${k} → ${twin}`);
  }
});

Deno.test("the inbound place table is total, and owned keys are places CFS holds", () => {
  for (const k of INBOUND_BREAKDOWN_KEYS) {
    const kinds = INBOUND_CUSTODY_PLACE_KINDS[k];
    assert(kinds.length > 0, k);
    // A key a Buy owns is somewhere in CFS (a shelf); the plan keys are outside.
    if (inboundOwnsKey("sale", k)) assert(kinds.includes("locations"), `${k} is owned but placed nowhere in CFS`);
  }
  for (const k of INBOUND_PLAN_KEYS) assertEquals([...INBOUND_CUSTODY_PLACE_KINDS[k]], ["outside"], k);
  // ⚠️ The shared spellings mean different places on the two ladders — the reason
  // for a second table. If this ever reads equal, the second table is dead weight.
  assert(
    JSON.stringify(INBOUND_CUSTODY_PLACE_KINDS.lost) !== JSON.stringify(CUSTODY_PLACE_KINDS.lost),
    "inbound lost and outbound lost now name the same place",
  );
});

Deno.test("booking_ladder is null EXACTLY when the booking axis is forbidden", () => {
  for (const type of MOVEMENT_TYPES) {
    const c = MOVEMENT_CONTRACTS[type];
    assertEquals(c.booking_ladder === null, c.booking === "forbidden", type);
  }
});

Deno.test("an undo's ladder is its forward's", () => {
  for (const undo of UNDO_MOVEMENT_TYPES) {
    assertEquals(MOVEMENT_CONTRACTS[undo].booking_ladder, MOVEMENT_CONTRACTS[MOVEMENT_UNDOES[undo]].booking_ladder, undo);
  }
});

Deno.test("the inbound ladder list names booking-bearing types only", () => {
  for (const type of INBOUND_LADDER_MOVEMENT_TYPES) {
    assertEquals(MOVEMENT_CONTRACTS[type].booking_ladder, "inbound", type);
  }
});
