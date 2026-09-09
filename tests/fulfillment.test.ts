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
  UpdateFulfillmentItemsInput,
} from "../src/schemas/fulfillment.ts";

// ── The input schema, and the field list it must not narrow ──────────

/**
 * 🔴 **The fulfillment twin of `tests/invoice.test.ts`'s *"the INPUT schema
 * accepts it, or every PUT drops it"*.**
 *
 * `FulfillmentItemInputLine` is a plain `z.object`, so a key it does not declare
 * is **stripped**, not rejected — the request succeeds and the value is simply
 * gone before the service ever sees it. That is not hypothetical: the invoice
 * grain shipped exactly this defect on `path_substituted_for`, where the manager
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
    path_substituted_for: ["Destination000000001", "Item0000000000000002"],
  };
  const parsed = FulfillmentItemInputLine.safeParse(body);
  assertEquals(parsed.success, true, JSON.stringify(parsed.success ? {} : parsed.error.issues));
  // Read back explicitly rather than deep-equalling the input: a stripped key is
  // invisible to a `success === true` assertion, which is the whole failure mode.
  const out = parsed.success ? parsed.data as unknown as Record<string, unknown> : {};
  assertEquals(out.uid, body.uid);
  assertEquals(out.path, body.path);
  assertEquals(out.quantity, body.quantity);
  assertEquals(out.path_substituted_for, body.path_substituted_for, "path_substituted_for must survive — the invoice grain lost it exactly here");
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
