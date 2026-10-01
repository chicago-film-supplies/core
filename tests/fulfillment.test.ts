/**
 * `FulfillmentSchema`'s own test file — the sibling of `tests/order.test.ts` and
 * `tests/invoice.test.ts`, which is worth noting because it did not exist until
 * core#97. The grain had `tests/fulfillment-items.test.ts` (the array rebuild)
 * and `tests/fulfillment-stage.test.ts` (the picker stage fold), and no home for
 * a claim about the SCHEMA — which is the same asymmetry, one layer out, as the
 * missing input schema these first arms cover.
 */
import { assertEquals } from "@std/assert";
import {
  FulfillmentItemInputLine,
  FulfillmentSchema,
  UpdateFulfillmentItemsInput,
} from "../src/schemas/fulfillment.ts";
import { getTestDoc } from "../src/schemas/testing.ts";
import { mockTimestamp } from "./helpers/timestamp.ts";

// ── The input schema, and the field list it must not narrow ──────────

/**
 * 🔴 **The fulfillment twin of `tests/invoice.test.ts`'s *"the INPUT schema
 * accepts it, or every PUT drops it"*.**
 *
 * `FulfillmentItemInputLine` is a plain `z.object`, so a key it does not declare
 * is **stripped**, not rejected — the request succeeds and the value is simply
 * gone before the service ever sees it. That is not hypothetical: the invoice
 * grain shipped exactly this defect on the retired `path_substituted_for`, where the manager
 * wrote a substitution, the API answered 200, and the divergence record never
 * reached the stored document.
 *
 * ⚠️ **This asserts the CONTRACT, not the service.** Core cannot read
 * `api-cloudrun`, so the claim *"these four are what `updateFulfillmentItems`
 * reads"* is evidenced there, not here. What this file can hold is the half that
 * a core-side edit could break on its own: each authored field survives a parse,
 * and `quantity_ordered` is refused rather than silently dropped.
 */
Deno.test("FulfillmentItemInputLine carries every picker-authored field through a parse", () => {
  const body = {
    uid: "Item0000000000000001",
    path: ["Destination000000001", "Item0000000000000001"],
    quantity: 3,
    substituted_for: [{ path: ["Destination000000001", "Item0000000000000002"], quantity: 2 }],
  };
  const parsed = FulfillmentItemInputLine.safeParse(body);
  assertEquals(parsed.success, true, JSON.stringify(parsed.success ? {} : parsed.error.issues));
  // Read back explicitly rather than deep-equalling the input: a stripped key is
  // invisible to a `success === true` assertion, which is the whole failure mode.
  const out = parsed.success ? parsed.data as unknown as Record<string, unknown> : {};
  assertEquals(out.uid, body.uid);
  assertEquals(out.path, body.path);
  assertEquals(out.quantity, body.quantity);
  assertEquals(out.substituted_for, body.substituted_for, "substituted_for must survive — manager#414's merge is authored here");
});

Deno.test("FulfillmentItemInputLine refuses a substituted_for naming one X twice", () => {
  const path = ["Destination000000001", "Item0000000000000002"];
  const res = FulfillmentItemInputLine.safeParse({
    uid: "Item0000000000000001",
    path: ["Destination000000001", "Item0000000000000001"],
    quantity: 3,
    substituted_for: [{ path, quantity: 1 }, { path, quantity: 1 }],
  });
  assertEquals(res.success, false);
});

Deno.test("FulfillmentItemInputLine PRESERVES quantity_ordered so the service can refuse it", () => {
  // 🔴 This arm looks backwards and is not. `quantity_ordered` is the ORDER's
  // quantity for the row, stamped by the order sync, so a client structurally
  // cannot compute it, and `updateFulfillmentItems` answers 400 for
  // any body carrying it.
  //
  // ⚠️ **A `z.object` STRIPS an undeclared key, so omitting it here would delete
  // that 400** — the service would never see the field and would answer 200
  // while ignoring what the client asserted. The refusal lives in the service
  // (its message names the field and says why); this schema's job is only to
  // carry the key that far intact. `api-cloudrun` owns the arm that proves the
  // refusal still fires.
  const res = FulfillmentItemInputLine.safeParse({
    uid: "Item0000000000000001",
    path: ["Item0000000000000001"],
    quantity: 3,
    quantity_ordered: 5,
  });
  assertEquals(res.success, true);
  const out = res.success ? res.data as unknown as Record<string, unknown> : {};
  assertEquals(out.quantity_ordered, 5, "the key must survive the parse or the service's refusal becomes unreachable");
});

Deno.test("FulfillmentItemInputLine strips a server-owned descriptive field", () => {
  // The other half of the `z.object` choice, and the reason it is right: the
  // manager sends the whole stored line (minus `quantity_ordered`, which it
  // deletes), and every descriptive field on it is re-derived server-side. A
  // `z.strictObject` here would 400 that payload — which is what the DOCUMENT
  // schema standing in as the request contract used to do.
  const res = FulfillmentItemInputLine.safeParse({
    uid: "Item0000000000000001",
    path: ["Item0000000000000001"],
    quantity: 3,
    name: "Arri SkyPanel S60",
    type: "rental",
    description: "server-owned",
  });
  assertEquals(res.success, true, "a stored line minus quantity_ordered must still parse");
  const out = res.success ? res.data as unknown as Record<string, unknown> : {};
  assertEquals("name" in out, false, "a server-owned field must be stripped, not stored from the body");
});

Deno.test("UpdateFulfillmentItemsInput requires a version and defaults lineItems", () => {
  assertEquals(UpdateFulfillmentItemsInput.safeParse({ version: 0 }).success, true);
  assertEquals(UpdateFulfillmentItemsInput.safeParse({}).success, false, "version gates optimistic concurrency and cannot be omitted");
  assertEquals(UpdateFulfillmentItemsInput.safeParse({ version: 1.5 }).success, false);
});

// ── An exchange's replacement line, and what it may replace ───────────────

Deno.test("FulfillmentItemInputLine carries `exchanged_for` through a parse", () => {
  // Same claim as the `substituted_for` arm above, for the exchange's own field: a
  // plain `z.object` strips an undeclared key, so without this declaration the
  // request would succeed and the link to the damaged row would be gone.
  const parsed = FulfillmentItemInputLine.safeParse({
    uid: "Item0000000000000009",
    path: ["Destination000000002", "Item0000000000000009"],
    quantity: 1,
    exchanged_for: [{ path: ["Destination000000001", "Item0000000000000001"], quantity: 1, reason: "damaged" }],
  });
  assertEquals(parsed.success, true, JSON.stringify(parsed.success ? {} : parsed.error.issues));
  assertEquals(parsed.success && parsed.data.exchanged_for?.[0].quantity, 1);
});

const PARENT_LEG = "11111111-1111-4111-8111-111111111111";
const EXCHANGE_LEG = "22222222-2222-4222-8222-222222222222";
const X_ROW = "Item0000000000000001";
const Y_ROW = "Item0000000000000009";

/** A fulfillment with a parent leg, an exchange leg against it, and a row on each. */
function exchangeDoc(exchangedFor: unknown, opts: { markExchange?: boolean } = {}) {
  const base = getTestDoc(FulfillmentSchema, {
    uid: "testfulfillment00001",
    created_at: mockTimestamp,
    updated_at: mockTimestamp,
  }, { now: mockTimestamp });
  const pair = base.destinations[0] as unknown as Record<string, unknown>;
  // The rows are stated here — the minimum a `FulfillmentLineItem` needs to parse.
  // X is an order line; Y, the exchange unit, is on no order line (`null`).
  const line = { type: "rental", name: "Light", description: "", quantity: 2, zero_priced: null, quantity_ordered: 2 };
  return {
    ...base,
    destinations: [
      { ...pair, uid: PARENT_LEG },
      {
        ...pair,
        uid: EXCHANGE_LEG,
        ...(opts.markExchange === false ? {} : { exchange: { uid_pair: PARENT_LEG, disposition: "same_trip" } }),
      },
    ],
    items: [
      { uid: PARENT_LEG, type: "destination", name: "Set", description: "", path: [PARENT_LEG] },
      { ...line, uid: X_ROW, path: [PARENT_LEG, X_ROW] },
      { uid: EXCHANGE_LEG, type: "destination", name: "Exchange", description: "", path: [EXCHANGE_LEG] },
      { ...line, uid: Y_ROW, quantity: 1, quantity_ordered: null, path: [EXCHANGE_LEG, Y_ROW], exchanged_for: exchangedFor },
    ],
  };
}

Deno.test("FulfillmentSchema accepts `exchanged_for` naming a row on the leg the exchange is against", () => {
  const parsed = FulfillmentSchema.safeParse(exchangeDoc([{ path: [PARENT_LEG, X_ROW], quantity: 1, reason: "damaged" }]));
  assertEquals(parsed.success, true, JSON.stringify(parsed.success ? {} : parsed.error.issues));
});

Deno.test("FulfillmentSchema refuses `exchanged_for` on a row that is not under an exchange pair", () => {
  // 🔴 The field says "this row goes out against a damaged one", which is only
  // meaningful on an exchange's trip. Off an exchange it would be a free-form pointer.
  const parsed = FulfillmentSchema.safeParse(
    exchangeDoc([{ path: [PARENT_LEG, X_ROW], quantity: 1, reason: "damaged" }], { markExchange: false }),
  );
  assertEquals(parsed.success, false);
});

Deno.test("FulfillmentSchema refuses `exchanged_for` naming a row on some OTHER leg", () => {
  // The damaged units are on the leg being exchanged against, by definition —
  // otherwise the checkout rider marks units damaged on a trip that never
  // carried them.
  const parsed = FulfillmentSchema.safeParse(exchangeDoc([{ path: [EXCHANGE_LEG, Y_ROW], quantity: 1, reason: "damaged" }]));
  assertEquals(parsed.success, false);
});

// ── Flat chaining and the entry's reason (api-cloudrun#1116) ─────────

const EXCHANGE_LEG_2 = "33333333-3333-4333-8333-333333333333";
const Y2_ROW = "Item0000000000000010";

/** `exchangeDoc` plus a SECOND exchange leg on the same parent, whose row carries `exchanged_for`. */
function chainedExchangeDoc(exchangedFor: unknown, disposition = "same_trip") {
  const doc = exchangeDoc([{ path: [PARENT_LEG, X_ROW], quantity: 1, reason: "damaged" }]);
  const pair = doc.destinations[1] as Record<string, unknown>;
  const line = doc.items[3] as Record<string, unknown>;
  return {
    ...doc,
    destinations: [...doc.destinations, { ...pair, uid: EXCHANGE_LEG_2, exchange: { uid_pair: PARENT_LEG, disposition } }],
    items: [
      ...doc.items,
      { uid: EXCHANGE_LEG_2, type: "destination", name: "Exchange", description: "", path: [EXCHANGE_LEG_2] },
      { ...line, uid: Y2_ROW, path: [EXCHANGE_LEG_2, Y2_ROW], exchanged_for: exchangedFor },
    ],
  };
}

const issuesOf = (r: { success: boolean; error?: { issues: Array<{ path: PropertyKey[] }> } }) =>
  JSON.stringify(r.success ? {} : r.error?.issues);

Deno.test("⭐ FulfillmentSchema accepts an exchange naming a row on a SIBLING exchange leg of the same parent (flat chaining)", () => {
  const parsed = FulfillmentSchema.safeParse(chainedExchangeDoc([{ path: [EXCHANGE_LEG, Y_ROW], quantity: 1, reason: "cleaning" }]));
  assertEquals(parsed.success, true, issuesOf(parsed));
});

Deno.test("FulfillmentSchema refuses an exchange leg naming ANOTHER exchange as its parent — chaining is flat", () => {
  const doc = chainedExchangeDoc([{ path: [EXCHANGE_LEG, Y_ROW], quantity: 1, reason: "damaged" }]);
  (doc.destinations[2] as Record<string, unknown>).exchange = { uid_pair: EXCHANGE_LEG, disposition: "same_trip" };
  assertEquals(FulfillmentSchema.safeParse(doc).success, false);
});

Deno.test("FulfillmentSchema refuses an `exchanged_for` entry with no reason", () => {
  assertEquals(FulfillmentSchema.safeParse(exchangeDoc([{ path: [PARENT_LEG, X_ROW], quantity: 1 }])).success, false);
});

Deno.test("🔴 FulfillmentSchema refuses `lost` on a `same_trip` leg — a lost unit cannot come back on the trip", () => {
  const exchange = FulfillmentSchema.safeParse(chainedExchangeDoc([{ path: [PARENT_LEG, X_ROW], quantity: 1, reason: "lost" }]));
  assertEquals(exchange.success, false);
  assertEquals(exchange.error?.issues.some((i) => i.path.at(-1) === "reason"), true, issuesOf(exchange));
  const sendNow = FulfillmentSchema.safeParse(
    chainedExchangeDoc([{ path: [PARENT_LEG, X_ROW], quantity: 1, reason: "lost" }], "send_now"),
  );
  assertEquals(sendNow.success, true, issuesOf(sendNow));
});

Deno.test("FulfillmentSchema accepts one row under two reasons, and refuses one row under the same reason twice", () => {
  const two = chainedExchangeDoc([
    { path: [PARENT_LEG, X_ROW], quantity: 1, reason: "cleaning" },
    { path: [PARENT_LEG, X_ROW], quantity: 1, reason: "damaged" },
  ]);
  assertEquals(FulfillmentSchema.safeParse(two).success, true, issuesOf(FulfillmentSchema.safeParse(two)));
  const dup = chainedExchangeDoc([
    { path: [PARENT_LEG, X_ROW], quantity: 1, reason: "damaged" },
    { path: [PARENT_LEG, X_ROW], quantity: 1, reason: "damaged" },
  ]);
  assertEquals(FulfillmentSchema.safeParse(dup).success, false);
});

// ── S8c step 4: the old names are gone (api-cloudrun#1147) ────────────

const ENTRY = [{ path: [PARENT_LEG, X_ROW], quantity: 1, reason: "damaged" }];

Deno.test("S8c-5: FulfillmentSchema refuses the old names `replaces` and `quantity_order`", () => {
  // `z.strictObject`: an old-named key is an unknown key, so a writer that
  // regressed to it fails loudly rather than storing a field no reader reads.
  const withRow = (i: number, extra: Record<string, unknown>) => {
    const doc = exchangeDoc(undefined);
    return { ...doc, items: doc.items.map((it, j) => (j === i ? { ...it, ...extra } : it)) };
  };
  for (const [i, extra] of [[3, { replaces: ENTRY }], [1, { quantity_order: 2 }]] as const) {
    const parsed = FulfillmentSchema.safeParse(withRow(i, extra));
    assertEquals(parsed.success, false, `${Object.keys(extra)[0]} must be refused`);
  }
  // Mutation control: the same document under the new names parses.
  assertEquals(FulfillmentSchema.safeParse(withRow(3, { exchanged_for: ENTRY })).success, true);
});

Deno.test("S8c-5: a stored line's `quantity_ordered` is REQUIRED-NULLABLE — a number, or null for no order line", () => {
  const withX = (extra: Record<string, unknown>, drop = false) => {
    const doc = exchangeDoc(undefined);
    const items = doc.items.map((it, i) => {
      if (i !== 1) return it;
      const row: Record<string, unknown> = { ...it, ...extra };
      if (drop) delete row.quantity_ordered;
      return row;
    });
    return { ...doc, items };
  };
  assertEquals(FulfillmentSchema.safeParse(withX({ quantity_ordered: 0 })).success, true, "0 is a kept row");
  assertEquals(FulfillmentSchema.safeParse(withX({ quantity_ordered: null })).success, true, "null is a row the order never had");
  const absent = FulfillmentSchema.safeParse(withX({}, true));
  assertEquals(absent.success, false, "absent is no longer a way to say either");
  assertEquals(absent.error?.issues.some((i) => i.path.join(".") === "items.1.quantity_ordered"), true, issuesOf(absent));
  assertEquals(FulfillmentSchema.safeParse(withX({ quantity_ordered: -1 })).success, false);
  assertEquals(FulfillmentSchema.safeParse(withX({ quantity_ordered: 1.5 })).success, false);
});

Deno.test("S8c-5: FulfillmentItemInputLine carries `exchanged_for` and `quantity_ordered` through a parse", () => {
  const parsed = FulfillmentItemInputLine.safeParse({
    uid: Y_ROW,
    path: [EXCHANGE_LEG, Y_ROW],
    quantity: 1,
    exchanged_for: ENTRY,
    quantity_ordered: null,
  });
  assertEquals(parsed.success, true, issuesOf(parsed));
  assertEquals(parsed.success && parsed.data.exchanged_for?.[0].quantity, 1);
  assertEquals(parsed.success && "quantity_ordered" in parsed.data, true, "must survive so the service can refuse it");
});
