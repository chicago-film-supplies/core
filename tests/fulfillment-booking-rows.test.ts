/**
 * `fulfillmentOnlyBookingRows` / `withFulfillmentOnlyRows` (api-cloudrun#1188).
 *
 * The rows are plain literals — the helper reads only `type`, `path`, `quantity`,
 * `quantity_ordered` and `substituted_for`, and a schema-seeded fixture could not
 * fail a selection rule anyway.
 */
import { assertEquals, assertStrictEquals } from "@std/assert";
import { fulfillmentOnlyBookingRows, withFulfillmentOnlyRows } from "../src/utils/fulfillment-booking-rows.ts";
import { groupByDestination } from "../src/utils/orders.ts";
import { collectSubstitutionAnchors } from "../src/utils/substitutions.ts";

interface Row {
  uid: string;
  type: string;
  path: string[];
  quantity?: number;
  quantity_ordered?: number | null;
  substituted_for?: { path: string[]; quantity: number }[];
}

const D1 = "dest-1";
const D2 = "dest-2";
const G = "group-1";
const div = (uid: string, type: string, path: string[]): Row => ({ uid, type, path });
const row = (uid: string, path: string[], quantity: number, quantity_ordered: number | null, extra: Partial<Row> = {}): Row => ({
  uid, type: "rental", path, quantity, quantity_ordered, ...extra,
});

/** Two legs, one line each — what the order projects. */
const orderRows = (): Row[] => [
  div(D1, "destination", [D1]),
  row("light", [D1, "light"], 2, 2),
  div(D2, "destination", [D2]),
  row("stand", [D2, "stand"], 1, 1),
];
const noAnchors = collectSubstitutionAnchors([]);
const paths = (rows: Row[]) => rows.map((r) => r.path.join("/"));

Deno.test("fulfillmentOnlyBookingRows: a picker addition is selected, at the paths the projection lacks", () => {
  const added = row("tripod", [D1, "tripod"], 1, null);
  const rows = fulfillmentOnlyBookingRows(orderRows().map((r) => r.path), [...orderRows(), added], noAnchors);
  assertEquals(rows, [added]);
});

Deno.test("withFulfillmentOnlyRows: a row added to the FIRST leg lands under it, not at the tail", () => {
  const added = row("tripod", [D1, "tripod"], 1, null);
  // The fulfillment stores it right after the Light, as `rebuildFulfillmentItems` places it.
  const stored = [orderRows()[0], orderRows()[1], added, orderRows()[2], orderRows()[3]];
  const items = withFulfillmentOnlyRows(orderRows(), stored, noAnchors);
  assertEquals(paths(items), [D1, `${D1}/light`, `${D1}/tripod`, D2, `${D2}/stand`]);
  // The consumer's own question: which leg does the booking projection put it on?
  const groups = groupByDestination(items as never, []);
  assertEquals(groups.map((g) => [g.uid, g.packing_list_delivery.map((i) => i.uid)]), [
    [D1, ["light", "tripod"]],
    [D2, ["stand"]],
  ]);
});

Deno.test("fulfillmentOnlyBookingRows: a KEPT row (quantity_ordered 0) is excluded — its booking is custody history's", () => {
  const kept = row("gone", [D1, "gone"], 3, 0);
  assertEquals(fulfillmentOnlyBookingRows(orderRows().map((r) => r.path), [...orderRows(), kept], noAnchors), []);
});

Deno.test("fulfillmentOnlyBookingRows: a substitute and its component are not counted a second time", () => {
  const y = row("monopod", [D1, "monopod"], 2, null, { substituted_for: [{ path: [D1, "light"], quantity: 2 }] });
  const component = row("foot", [D1, "monopod", "foot"], 2, null);
  const anchors = collectSubstitutionAnchors([y, component]);
  assertEquals(anchors.length, 1);
  assertEquals(fulfillmentOnlyBookingRows(orderRows().map((r) => r.path), [...orderRows(), y, component], anchors), []);
  // Without the anchors only the `substituted_for` entry protects the root — the component would be taken.
  assertEquals(fulfillmentOnlyBookingRows(orderRows().map((r) => r.path), [...orderRows(), y, component], noAnchors), [component]);
});

Deno.test("fulfillmentOnlyBookingRows: a row the projection already carries (an exchange leg) is not added again", () => {
  const leg = [div("leg", "destination", ["leg"]), row("loaner", ["leg", "loaner"], 1, null)];
  const carried = [...orderRows(), ...leg].map((r) => r.path);
  assertEquals(fulfillmentOnlyBookingRows(carried, [...orderRows(), ...leg], noAnchors), []);
});

Deno.test("withFulfillmentOnlyRows: an invoice-only row the picker lowered to 0 books at its ORDERED quantity", () => {
  // Projected from an invoice at 3, then the picker handed out none of it.
  const lowered = row("tripod", [D1, "tripod"], 0, 3);
  const items = withFulfillmentOnlyRows(orderRows(), [...orderRows(), lowered], noAnchors);
  assertEquals(items.find((i) => i.uid === "tripod")?.quantity, 3);
  // The stored row is not mutated — the override rule reads its 0 later.
  assertEquals(lowered.quantity, 0);
});

Deno.test("fulfillmentOnlyBookingRows: a picker addition left at 0 asks for nothing and is excluded", () => {
  assertEquals(fulfillmentOnlyBookingRows(orderRows().map((r) => r.path), [...orderRows(), row("tripod", [D1, "tripod"], 0, null)], noAnchors), []);
});

Deno.test("withFulfillmentOnlyRows: a divider only the fulfillment has is emitted just before the row beneath it", () => {
  const group = div(G, "group", [D1, G]);
  const added = row("tripod", [D1, G, "tripod"], 1, null);
  const stored = [orderRows()[0], orderRows()[1], group, added, orderRows()[2], orderRows()[3]];
  assertEquals(paths(withFulfillmentOnlyRows(orderRows(), stored, noAnchors)), [
    D1, `${D1}/light`, `${D1}/${G}`, `${D1}/${G}/tripod`, D2, `${D2}/stand`,
  ]);
  // …and a fulfillment-only divider with nothing under it is NOT carried.
  assertEquals(withFulfillmentOnlyRows(orderRows(), [...orderRows(), group], noAnchors).length, 4);
});

Deno.test("withFulfillmentOnlyRows: with nothing to add it returns the caller's array itself", () => {
  const items = orderRows();
  assertStrictEquals(withFulfillmentOnlyRows(items, [...orderRows()], noAnchors), items);
});
