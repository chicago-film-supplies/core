/**
 * The pick sheet's schema and the one rule that lives with it.
 *
 * The gate is the interesting half. `customer_collecting` and
 * `customer_returning` are independent flags on the destination pair, and the
 * defect this predicate replaces was an `||` over the two — so the table below
 * enumerates all four combinations against all three gates rather than probing
 * the cases that happen to occur in the corpus.
 */
import { assert, assertEquals } from "@std/assert";
import {
  PICK_SHEET_GATES,
  type PickSheet,
  type PickSheetGatePair,
  type PickSheetGateType,
  pickSheetGateAdmits,
  PickSheetSchema,
} from "../src/schemas/pick-sheet.ts";

function pair(collecting: boolean, returning: boolean): PickSheetGatePair {
  return { customer_collecting: collecting, customer_returning: returning };
}

// ── The gate ────────────────────────────────────────────────────────

Deno.test("gate: `all` admits every combination of the two flags", () => {
  for (const c of [false, true]) {
    for (const r of [false, true]) {
      assert(pickSheetGateAdmits(pair(c, r), "all"), `all rejected (${c}, ${r})`);
    }
  }
});

Deno.test("gate: `crew` reads the DELIVERY flag alone", () => {
  // We deliver — crew work at the address — regardless of who returns it.
  assert(pickSheetGateAdmits(pair(false, false), "crew"));
  assert(pickSheetGateAdmits(pair(false, true), "crew"));
  // The customer collects: there is no crew job at this leg's delivery endpoint,
  // which by then is our own store.
  assertEquals(pickSheetGateAdmits(pair(true, false), "crew"), false);
  assertEquals(pickSheetGateAdmits(pair(true, true), "crew"), false);
});

Deno.test("gate: `counter` admits a leg with counter work in EITHER direction", () => {
  assertEquals(pickSheetGateAdmits(pair(false, false), "counter"), false);
  assert(pickSheetGateAdmits(pair(false, true), "counter"));
  assert(pickSheetGateAdmits(pair(true, false), "counter"));
  assert(pickSheetGateAdmits(pair(true, true), "counter"));
});

/**
 * 🔴 The regression this predicate exists to stop, named so it cannot be
 * "simplified" back.
 *
 * A leg we DELIVER and the customer RETURNS has a real delivery endpoint — a
 * film set — and belongs on the crew sheet. Under `customer_collecting ||
 * customer_returning` as a single "customer handles it" boolean, it was
 * suppressed, and a crew standing at that address was told nothing was out
 * there.
 */
Deno.test("gate: a delivered-and-customer-returned leg is CREW work, not suppressed", () => {
  const delivered = pair(false, true);
  assert(pickSheetGateAdmits(delivered, "crew"), "the || defect, reintroduced");
  assert(pickSheetGateAdmits(delivered, "counter"), "and it has counter work too");
});

/**
 * ⭐ The two working gates OVERLAP by design. A partition would have to pick one
 * side of a leg we deliver and the customer returns, and be wrong for the other.
 */
Deno.test("gate: `crew` and `counter` overlap rather than partition", () => {
  const combos = [pair(false, false), pair(false, true), pair(true, false), pair(true, true)];
  const both = combos.filter((p) => pickSheetGateAdmits(p, "crew") && pickSheetGateAdmits(p, "counter"));
  const neither = combos.filter((p) => !pickSheetGateAdmits(p, "crew") && !pickSheetGateAdmits(p, "counter"));
  assertEquals(both.length, 1, "exactly the delivered/customer-returned leg is on both sheets");
  assertEquals(both[0], pair(false, true));
  assertEquals(neither.length, 0, "no leg falls off both sheets");
});

Deno.test("gate: the vocabulary is closed and every member is decidable", () => {
  assertEquals([...PICK_SHEET_GATES], ["all", "crew", "counter"]);
  for (const gate of PICK_SHEET_GATES) {
    assertEquals(typeof pickSheetGateAdmits(pair(false, false), gate), "boolean");
  }
  // The enum and the predicate's parameter type cannot drift: this only
  // compiles while every member is accepted.
  const _exhaustive: PickSheetGateType[] = [...PICK_SHEET_GATES];
  assertEquals(_exhaustive.length, 3);
});

// ── The document ────────────────────────────────────────────────────

/** The smallest sheet that is a valid answer: a scope, a gate, and nothing out. */
function emptySheet(): unknown {
  return {
    scope: { kind: "destination", uid: "aaaaaaaaaaaaaaaaaaaa", name: "Stage 4", uids: ["aaaaaaaaaaaaaaaaaaaa"] },
    gate: "crew",
    orders: [],
    order_count: 0,
    destination_count: 0,
    quantity: 0,
    organizations: [],
    missing_order_uids: [],
    next_cursor: null,
    notice: null,
  };
}

Deno.test("schema: an empty sheet is a valid answer, not an error", () => {
  const parsed = PickSheetSchema.parse(emptySheet()) as PickSheet;
  assertEquals(parsed.orders, []);
  assertEquals(parsed.next_cursor, null);
});

Deno.test("schema: `next_cursor` and `notice` are required keys, so absence is stated", () => {
  const withoutCursor = emptySheet() as Record<string, unknown>;
  delete withoutCursor.next_cursor;
  assertEquals(PickSheetSchema.safeParse(withoutCursor).success, false);
});

Deno.test("schema: `missing_order_uids` survives a round trip — it is a finding, not a display detail", () => {
  const sheet = emptySheet() as Record<string, unknown>;
  sheet.missing_order_uids = ["bbbbbbbbbbbbbbbbbbbb"];
  const parsed = PickSheetSchema.parse(sheet) as PickSheet;
  assertEquals(parsed.missing_order_uids, ["bbbbbbbbbbbbbbbbbbbb"]);
});

Deno.test("schema: an unknown top-level key is refused", () => {
  const sheet = emptySheet() as Record<string, unknown>;
  sheet.sections = [];
  assertEquals(PickSheetSchema.safeParse(sheet).success, false);
});

Deno.test("schema: the gate is the closed vocabulary, not a free string", () => {
  const sheet = emptySheet() as Record<string, unknown>;
  sheet.gate = "outbound";
  assertEquals(PickSheetSchema.safeParse(sheet).success, false);
});
