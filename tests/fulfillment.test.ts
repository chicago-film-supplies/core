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
 * and `quantity_order` is refused rather than silently dropped.
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

Deno.test("FulfillmentItemInputLine PRESERVES quantity_order so the service can refuse it", () => {
  // 🔴 This arm looks backwards and is not. `quantity_order` is the divergence
  // marker between the picker's count and the order's — `mergeLineItem` stamps
  // the ORDER's quantity onto it when the two disagree — so a client
  // structurally cannot compute it, and `updateFulfillmentItems` answers 400 for
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
    quantity_order: 5,
  });
  assertEquals(res.success, true);
  const out = res.success ? res.data as unknown as Record<string, unknown> : {};
  assertEquals(out.quantity_order, 5, "the key must survive the parse or the service's refusal becomes unreachable");
});

Deno.test("FulfillmentItemInputLine strips a server-owned descriptive field", () => {
  // The other half of the `z.object` choice, and the reason it is right: the
  // manager sends the whole stored line (minus `quantity_order`, which it
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
  assertEquals(res.success, true, "a stored line minus quantity_order must still parse");
  const out = res.success ? res.data as unknown as Record<string, unknown> : {};
  assertEquals("name" in out, false, "a server-owned field must be stripped, not stored from the body");
});

Deno.test("UpdateFulfillmentItemsInput requires a version and defaults lineItems", () => {
  assertEquals(UpdateFulfillmentItemsInput.safeParse({ version: 0 }).success, true);
  assertEquals(UpdateFulfillmentItemsInput.safeParse({}).success, false, "version gates optimistic concurrency and cannot be omitted");
  assertEquals(UpdateFulfillmentItemsInput.safeParse({ version: 1.5 }).success, false);
});

// ── A swap's replacement line, and what it may replace ───────────────

Deno.test("FulfillmentItemInputLine carries `replaces` through a parse", () => {
  // Same claim as the `substituted_for` arm above, for the swap's own field: a
  // plain `z.object` strips an undeclared key, so without this declaration the
  // request would succeed and the link to the damaged row would be gone.
  const parsed = FulfillmentItemInputLine.safeParse({
    uid: "Item0000000000000009",
    path: ["Destination000000002", "Item0000000000000009"],
    quantity: 1,
    replaces: [{ path: ["Destination000000001", "Item0000000000000001"], quantity: 1, reason: "damaged" }],
  });
  assertEquals(parsed.success, true, JSON.stringify(parsed.success ? {} : parsed.error.issues));
  assertEquals(parsed.success && parsed.data.replaces?.[0].quantity, 1);
});

const PARENT_LEG = "11111111-1111-4111-8111-111111111111";
const SWAP_LEG = "22222222-2222-4222-8222-222222222222";
const X_ROW = "Item0000000000000001";
const Y_ROW = "Item0000000000000009";

/** A fulfillment with a parent leg, a swap leg against it, and a row on each. */
function swapDoc(replaces: unknown, opts: { markExchange?: boolean } = {}) {
  const base = getTestDoc(FulfillmentSchema, {
    uid: "testfulfillment00001",
    created_at: mockTimestamp,
    updated_at: mockTimestamp,
  }, { now: mockTimestamp });
  const pair = base.destinations[0] as unknown as Record<string, unknown>;
  // `getTestDoc` builds an EMPTY items array (measured), so the rows are stated
  // here — the minimum a `FulfillmentLineItem` needs to parse.
  const line = { type: "rental", name: "Light", description: "", quantity: 2, zero_priced: null };
  return {
    ...base,
    destinations: [
      { ...pair, uid: PARENT_LEG },
      {
        ...pair,
        uid: SWAP_LEG,
        ...(opts.markExchange === false ? {} : { exchange: { uid_pair: PARENT_LEG, disposition: "exchange" } }),
      },
    ],
    items: [
      { uid: PARENT_LEG, type: "destination", name: "Set", description: "", path: [PARENT_LEG] },
      { ...line, uid: X_ROW, path: [PARENT_LEG, X_ROW] },
      { uid: SWAP_LEG, type: "destination", name: "Exchange", description: "", path: [SWAP_LEG] },
      { ...line, uid: Y_ROW, quantity: 1, path: [SWAP_LEG, Y_ROW], replaces },
    ],
  };
}

Deno.test("FulfillmentSchema accepts `replaces` naming a row on the leg the swap exchanges against", () => {
  const parsed = FulfillmentSchema.safeParse(swapDoc([{ path: [PARENT_LEG, X_ROW], quantity: 1, reason: "damaged" }]));
  assertEquals(parsed.success, true, JSON.stringify(parsed.success ? {} : parsed.error.issues));
});

Deno.test("FulfillmentSchema refuses `replaces` on a row that is not under an exchange pair", () => {
  // 🔴 The field says "this row goes out against a damaged one", which is only
  // meaningful on a swap's trip. Off a swap it would be a free-form pointer.
  const parsed = FulfillmentSchema.safeParse(
    swapDoc([{ path: [PARENT_LEG, X_ROW], quantity: 1, reason: "damaged" }], { markExchange: false }),
  );
  assertEquals(parsed.success, false);
});

Deno.test("FulfillmentSchema refuses `replaces` naming a row on some OTHER leg", () => {
  // The damaged units are on the leg being swapped against, by definition —
  // otherwise the checkout rider marks units damaged on a trip that never
  // carried them.
  const parsed = FulfillmentSchema.safeParse(swapDoc([{ path: [SWAP_LEG, Y_ROW], quantity: 1, reason: "damaged" }]));
  assertEquals(parsed.success, false);
});

// ── Flat chaining and the entry's reason (api-cloudrun#1116) ─────────

const SWAP_LEG_2 = "33333333-3333-4333-8333-333333333333";
const Y2_ROW = "Item0000000000000010";

/** `swapDoc` plus a SECOND swap leg on the same parent, whose row carries `replaces`. */
function chainedSwapDoc(replaces: unknown, disposition = "exchange") {
  const doc = swapDoc([{ path: [PARENT_LEG, X_ROW], quantity: 1, reason: "damaged" }]);
  const pair = doc.destinations[1] as Record<string, unknown>;
  const line = doc.items[3] as Record<string, unknown>;
  return {
    ...doc,
    destinations: [...doc.destinations, { ...pair, uid: SWAP_LEG_2, exchange: { uid_pair: PARENT_LEG, disposition } }],
    items: [
      ...doc.items,
      { uid: SWAP_LEG_2, type: "destination", name: "Exchange", description: "", path: [SWAP_LEG_2] },
      { ...line, uid: Y2_ROW, path: [SWAP_LEG_2, Y2_ROW], replaces },
    ],
  };
}

const issuesOf = (r: { success: boolean; error?: { issues: Array<{ path: PropertyKey[] }> } }) =>
  JSON.stringify(r.success ? {} : r.error?.issues);

Deno.test("⭐ FulfillmentSchema accepts a swap naming a row on a SIBLING swap leg of the same parent (flat chaining)", () => {
  const parsed = FulfillmentSchema.safeParse(chainedSwapDoc([{ path: [SWAP_LEG, Y_ROW], quantity: 1, reason: "cleaning" }]));
  assertEquals(parsed.success, true, issuesOf(parsed));
});

Deno.test("FulfillmentSchema refuses a swap leg naming ANOTHER swap as its parent — chaining is flat", () => {
  const doc = chainedSwapDoc([{ path: [SWAP_LEG, Y_ROW], quantity: 1, reason: "damaged" }]);
  (doc.destinations[2] as Record<string, unknown>).exchange = { uid_pair: SWAP_LEG, disposition: "exchange" };
  assertEquals(FulfillmentSchema.safeParse(doc).success, false);
});

Deno.test("FulfillmentSchema refuses a `replaces` entry with no reason", () => {
  assertEquals(FulfillmentSchema.safeParse(swapDoc([{ path: [PARENT_LEG, X_ROW], quantity: 1 }])).success, false);
});

Deno.test("🔴 FulfillmentSchema refuses `lost` on an `exchange` leg — a lost unit cannot come back on the trip", () => {
  const exchange = FulfillmentSchema.safeParse(chainedSwapDoc([{ path: [PARENT_LEG, X_ROW], quantity: 1, reason: "lost" }]));
  assertEquals(exchange.success, false);
  assertEquals(exchange.error?.issues.some((i) => i.path.at(-1) === "reason"), true, issuesOf(exchange));
  const sendNow = FulfillmentSchema.safeParse(
    chainedSwapDoc([{ path: [PARENT_LEG, X_ROW], quantity: 1, reason: "lost" }], "send_now"),
  );
  assertEquals(sendNow.success, true, issuesOf(sendNow));
});

Deno.test("FulfillmentSchema accepts one row under two reasons, and refuses one row under the same reason twice", () => {
  const two = chainedSwapDoc([
    { path: [PARENT_LEG, X_ROW], quantity: 1, reason: "cleaning" },
    { path: [PARENT_LEG, X_ROW], quantity: 1, reason: "damaged" },
  ]);
  assertEquals(FulfillmentSchema.safeParse(two).success, true, issuesOf(FulfillmentSchema.safeParse(two)));
  const dup = chainedSwapDoc([
    { path: [PARENT_LEG, X_ROW], quantity: 1, reason: "damaged" },
    { path: [PARENT_LEG, X_ROW], quantity: 1, reason: "damaged" },
  ]);
  assertEquals(FulfillmentSchema.safeParse(dup).success, false);
});
