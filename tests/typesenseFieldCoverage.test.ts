/**
 * Typesense field coverage — **can a declared field ever hold a value?**
 *
 * The Firestore side of this question has had an answer since 2026-08-03:
 * `api-cloudrun/tests/unit/firestoreIndexCoverage.test.ts`, the *spec ⊆ schema*
 * side of the index triangle in that repo's CLAUDE.md. It landed finding **44 of
 * 210** index declarations dead. Typesense had no equivalent, and the same class
 * was sitting in these configs for five months:
 *
 * | declaration | landed | dead because |
 * |---|---|---|
 * | `orders:items.total_price_cents` | 2026-03-13 | the order item's field is `price.total_cents`; `total_price` is the **bookings** name. The correct `items.price.*` block landed five days later BESIDE it, and nobody removed the first. Renamed `→ _cents` and marked `money: true` by later sweeps, which made a field nothing writes look deliberately curated. |
 * | six `query_by_*` across five collections | 2026-03→ | deleted from every document by `deleteQueryByFields` — see arm 2. Four carried `facet: true`. |
 * | `cards:date`, `cards:date_epoch`, `cards:destination.coordinates` | 2025-12 | written against a `Card` shape that never existed (`dates.start`/`date_fs`, geopoint nested under `destination.address`). `date_epoch` was `null` on all 1,097 prod cards; the map view's geopoint was never there at all. |
 *
 * **None of them failed anything.** A declared field that no document populates
 * is byte-identical to an absent one in a search response — which is how
 * `search_orders` over 977 orders returned zero `items.total_price_cents` for
 * five months without a single error. That is the whole reason this is a static
 * ratchet and not a probe: emptiness is not observable from outside.
 *
 * ## What each arm can and cannot see
 *
 * The two arms catch disjoint classes, and either alone is a false sense of
 * coverage. `items.total_price_cents` resolves to nothing in Zod but is not
 * stripped; the six `query_by_*` resolve in Zod **perfectly well** (they are
 * real stored Firestore fields, with real composite indexes) and are invisible
 * to arm 1 entirely.
 *
 * ## It tests resolvability, not population
 *
 * Deliberately. `cards.uid_assignees` is `[]` on all 1,097 prod cards purely
 * because card assignment ships with the manager launch — empty today, live
 * tomorrow, and no static check should have an opinion about that. Resolvability
 * is the stronger and more honest question: every document schema here is a
 * `z.strictObject`, so a path that does not resolve cannot be written *by any
 * future document*, not merely by today's.
 *
 * ## Where it lives, and what runs it
 *
 * In `core`, because core owns both sides it compares — the Typesense configs
 * and the Zod document schemas. Run by **`deno task test`**; core has no
 * `gate.sh`, so api-cloudrun's "check it is in `gate.sh`, not merely in
 * `tests/unit/`" rule does not transfer here.
 */
import { assertEquals } from "@std/assert";
import type { z } from "zod";

import { schemas } from "../src/schemas/mod.ts";
import { typesenseSchemas } from "../src/schemas/typesense/mod.ts";
import { isStrippedAtIndexTime } from "../src/schemas/typesense/types.ts";
import type { TypesenseField } from "../src/schemas/typesense/types.ts";
import { collectLeafPaths } from "../src/schemas/zod-walk.ts";

/**
 * Fields **computed at index time**, keyed `"<alias>:<field>"` with the
 * producing code as the value. An entry cannot exist without naming what writes
 * it — "derived" with no producer is how a dead field gets waved through, and a
 * dead field is precisely what this test exists to find.
 *
 * `_str` mirrors are NOT listed here: they are covered by a rule instead (see
 * {@link isStringMirrorOf}), because `addStringMirrors` produces one for *every*
 * numeric field mechanically, so a table would need an entry per numeric field
 * and would go stale the first time anyone added one.
 */
const DERIVED_FIELDS: Record<string, string> = {
  // ── deriveOrderDateEnvelope (@cfs/core/utils/orders), applied in
  //    api-cloudrun's `translateForTypesense` before `translateObject`.
  //    Orders and fulfillments stopped persisting a top-level `dates`; the flat
  //    envelope is synthesized from per-destination dates because Typesense
  //    cannot sort on a value inside an array.
  "orders:dates": "deriveOrderDateEnvelope — synthesized, never stored",
  "orders:dates.delivery_start_fs": "deriveOrderDateEnvelope — envelope min over destinations[]",
  "orders:dates.delivery_end_fs": "deriveOrderDateEnvelope — envelope max over destinations[]",
  "orders:dates.collection_start_fs": "deriveOrderDateEnvelope — envelope min over destinations[]",
  "orders:dates.collection_end_fs": "deriveOrderDateEnvelope — envelope max over destinations[]",
  "orders:dates.charge_start_fs": "deriveOrderDateEnvelope — envelope min over destinations[]",
  "orders:dates.charge_end_fs": "deriveOrderDateEnvelope — envelope max over destinations[]",
  "orders:dates.days_active": "deriveOrderDateEnvelope — spanned days across the envelope",
  "orders:dates.days_charged": "deriveOrderDateEnvelope — chargeable days across the envelope",
  "fulfillments:dates": "deriveOrderDateEnvelope — same as orders:dates",
  "fulfillments:dates.delivery_start_fs": "deriveOrderDateEnvelope — same as orders",
  "fulfillments:dates.delivery_end_fs": "deriveOrderDateEnvelope — same as orders",
  "fulfillments:dates.collection_start_fs": "deriveOrderDateEnvelope — same as orders",
  "fulfillments:dates.collection_end_fs": "deriveOrderDateEnvelope — same as orders",
  "fulfillments:dates.charge_start_fs": "deriveOrderDateEnvelope — same as orders",
  "fulfillments:dates.charge_end_fs": "deriveOrderDateEnvelope — same as orders",

  // ── postProcess (api-cloudrun lib/typesenseTranslate.ts)
  "orders:deliveries": "postProcess — any destination pair with customer_collecting !== true",
  "orders:pickups": "postProcess — any destination pair with customer_returning !== true",
  "fulfillments:deliveries": "postProcess — same rule as orders:deliveries",
  "fulfillments:pickups": "postProcess — same rule as orders:pickups",

  // ── coerceArrayFields (api-cloudrun lib/typesenseTranslate.ts), deliberately
  //    computed BEFORE stripUndeclaredFields drops items[].quantity_order.
  "fulfillments:has_conflicts":
    "coerceArrayFields — any item whose picker quantity diverges from the order's projection",
};

const NUMERIC_TYPES: ReadonlySet<string> = new Set([
  "int32",
  "int32[]",
  "int64",
  "int64[]",
  "float",
  "float[]",
]);

/**
 * Is `name` the `_str` search mirror of a declared numeric field?
 *
 * `addStringMirrors` writes `<name>_str` for every numeric field in the config,
 * and `postProcess` does the same by hand for `invoices.number_orders_str`
 * (whose source is `int64[]`, which the generic pass skips). Either way the
 * mirror is produced at index time and has no storage counterpart.
 *
 * The rule is tight in the direction that matters: it requires the SOURCE to be
 * a declared numeric field, so a `foo_str` with no `foo` — or with a `foo` that
 * is a string — is still reported.
 */
function isStringMirrorOf(name: string, declared: Map<string, TypesenseField>): boolean {
  if (!name.endsWith("_str")) return false;
  const source = declared.get(name.slice(0, -"_str".length));
  return source !== undefined && NUMERIC_TYPES.has(source.type);
}

/**
 * Every path a document of `storage` can carry, as Typesense would name it.
 *
 * ⚠️ **Crossing arrays and unions is what makes this test usable rather than
 * noise.** Typesense flattens `items[].price.total_cents` to the dotted name
 * `items.price.total_cents`, and a resolver that stopped at the first array —
 * or took only the first arm of a discriminated union — would report the
 * overwhelming majority of these configs as unresolvable and be switched off
 * within a day. `collectLeafPaths` walks arrays (`path[]`), records
 * (`path.<key>`) and every union member at the same path; normalizing away its
 * container markers yields exactly the Typesense spelling.
 *
 * Interior nodes are included alongside leaves: a config legitimately declares
 * `{ name: "items", type: "object[]" }` and `{ name: "items.price", … }` as
 * container entries, and neither is a scalar leaf.
 */
function indexablePaths(storage: z.ZodType): { paths: Set<string>; unhandled: string[] } {
  const { leaves, unhandled } = collectLeafPaths(storage);
  const paths = new Set<string>();
  for (const leaf of leaves) {
    const segments = leaf.path.replaceAll("[]", "").replaceAll(".<key>", "").split(".");
    for (let i = 1; i <= segments.length; i++) {
      paths.add(segments.slice(0, i).join("."));
    }
  }
  return { paths, unhandled: unhandled.map((u) => `${u.path} [${u.type}]`) };
}

/**
 * Declared fields of `fields` that no document of `storage` can populate.
 *
 * Takes its inputs explicitly so the fail-closed companions below can run it
 * against a deliberately-wrong field list and assert it *reports* — an oracle
 * that has quietly drifted into agreeing with everything passes forever.
 */
function unresolvedFields(storage: z.ZodType, fields: TypesenseField[]): string[] {
  const { paths } = indexablePaths(storage);
  const declared = new Map(fields.map((f) => [f.name, f]));
  return fields
    .map((f) => f.name)
    .filter((name) => !paths.has(name) && !isStringMirrorOf(name, declared));
}

/** The storage schema backing a collection config, or a hard failure. */
function storageFor(alias: string): z.ZodType {
  const config = typesenseSchemas[alias as keyof typeof typesenseSchemas];
  const storage = schemas[config.firestoreCollection];
  if (!storage) {
    throw new Error(
      `${alias}: no storage schema registered for firestoreCollection ` +
        `"${config.firestoreCollection}" — this test would be silently blind for it`,
    );
  }
  return storage;
}

// ── Arm 0: the walk must be complete, or arm 1 is unsound ────────────

Deno.test("typesense coverage: every storage schema walks with no unhandled node", () => {
  // `collectLeafPaths` fails closed — a node type it does not recognise is
  // pushed to `unhandled` rather than emitted as a leaf, because emitting it
  // would silently swallow its whole subtree and make every path under it look
  // unresolvable. A non-empty `unhandled` means arm 1's verdicts are not
  // trustworthy, so it is checked first and separately.
  const broken: string[] = [];
  for (const alias of Object.keys(typesenseSchemas)) {
    const { unhandled } = indexablePaths(storageFor(alias));
    for (const u of unhandled) broken.push(`${alias}: ${u}`);
  }
  assertEquals(
    broken,
    [],
    "collectLeafPaths could not interpret these nodes, so the resolvability arm " +
      "below is walking an incomplete path set:\n" + broken.join("\n"),
  );
});

// ── Arm 1: resolvability ────────────────────────────────────────────

Deno.test("typesense coverage: every declared field resolves against the storage schema", () => {
  const dead: string[] = [];
  for (const [alias, config] of Object.entries(typesenseSchemas)) {
    for (const name of unresolvedFields(storageFor(alias), config.schema.fields)) {
      const key = `${alias}:${name}`;
      if (!(key in DERIVED_FIELDS)) dead.push(key);
    }
  }

  assertEquals(
    dead.sort(),
    [],
    "These fields are declared in a Typesense collection config but no path in " +
      "the backing Zod document schema can produce them, so they are indexed " +
      "empty forever — indistinguishable from absent in every search response.\n\n" +
      "Fix by pointing the declaration at the real stored path, or delete it. " +
      "If it is genuinely computed at index time, add it to DERIVED_FIELDS " +
      "naming the function that writes it.\n\n" + dead.join("\n"),
  );
});

Deno.test("typesense coverage: no stale DERIVED_FIELDS entry", () => {
  const live = new Set<string>();
  for (const [alias, config] of Object.entries(typesenseSchemas)) {
    for (const name of unresolvedFields(storageFor(alias), config.schema.fields)) {
      live.add(`${alias}:${name}`);
    }
  }
  const stale = Object.keys(DERIVED_FIELDS).filter((k) => !live.has(k)).sort();

  assertEquals(
    stale,
    [],
    "These DERIVED_FIELDS entries no longer describe a field that needs one — " +
      "either the field is gone, or it now resolves against the storage schema. " +
      "Delete them; an exemption that outlives its reason reads as a decision " +
      "when it is a leftover.\n" + stale.join("\n"),
  );
});

Deno.test("typesense coverage: every DERIVED_FIELDS entry names its producer", () => {
  const unexplained = Object.entries(DERIVED_FIELDS)
    .filter(([, reason]) => reason.trim().length < 20)
    .map(([key]) => key)
    .sort();

  assertEquals(
    unexplained,
    [],
    `These DERIVED_FIELDS entries have no usable reason:\n${unexplained.join("\n")}`,
  );
});

// ── Arm 2: not stripped on the way to the index ─────────────────────

Deno.test("typesense coverage: no declared field is deleted at index time", () => {
  // Invisible to arm 1 by construction: `query_by_*` fields are real stored
  // Firestore reverse-index arrays and resolve in Zod perfectly well. They are
  // dead in Typesense for a completely different reason — `deleteQueryByFields`
  // removes them from every document AFTER `stripUndeclaredFields` has kept
  // them. The predicate is imported rather than restated so the strip and this
  // assertion cannot drift apart.
  const stripped: string[] = [];
  for (const [alias, config] of Object.entries(typesenseSchemas)) {
    for (const field of config.schema.fields) {
      if (isStrippedAtIndexTime(field.name)) stripped.push(`${alias}:${field.name}`);
    }
  }

  assertEquals(
    stripped.sort(),
    [],
    "These fields are declared in a Typesense collection config and then " +
      "unconditionally deleted from every document by `deleteQueryByFields` " +
      "(api-cloudrun `lib/typesenseTranslate.ts`). The strip is correct — a " +
      "Firestore reverse-index mirror is redundant in an engine that can query " +
      "inside a nested array — so the DECLARATION is the defect. Delete it, and " +
      "declare the nested sub-fields you actually want to query.\n\n" +
      stripped.join("\n"),
  );
});

// ── Arm 3: display defaults name declared fields ────────────────────

Deno.test("typesense coverage: every displayDefaults reference names a declared field", () => {
  // Green the day it landed, unlike the two arms above, and kept because it
  // closes the hole those two OPEN: deleting a dead field is exactly the moment
  // a column, facet or sort still naming it becomes a reference to nothing.
  // `cards.displayDefaults.columns` held `"date"` — pointing at a field that had
  // never held a value — right up to the commit that removed it.
  const dangling: string[] = [];
  for (const [alias, config] of Object.entries(typesenseSchemas)) {
    const declared = new Set(config.schema.fields.map((f) => f.name));
    const d = config.displayDefaults;
    const refs: Array<[string, string]> = [
      ...d.columns.map((c) => ["columns", c] as [string, string]),
      ...d.facet.map((c) => ["facet", c] as [string, string]),
      ...Object.keys(d.filters).map((c) => ["filters", c] as [string, string]),
      ...(d.sort.column ? [["sort.column", d.sort.column] as [string, string]] : []),
      ...(d.group ? [["group", d.group] as [string, string]] : []),
      ...(d.groupBy ?? []).flatMap((g) =>
        g.field ? [["groupBy", g.field] as [string, string]] : []
      ),
    ];
    for (const [where, ref] of refs) {
      if (!declared.has(ref)) dangling.push(`${alias}.displayDefaults.${where}: ${ref}`);
    }
  }

  assertEquals(
    dangling.sort(),
    [],
    "These display defaults name a field the collection does not declare, so " +
      "the column renders nothing / the facet returns nothing / the sort is " +
      "rejected by Typesense:\n" + dangling.join("\n"),
  );
});

// ── Fail-closed companions ──────────────────────────────────────────
//
// Both arms are assertions that a set is EMPTY, and an empty set is what a
// checker that has quietly stopped checking also produces. These run each arm
// against the exact declarations that motivated it and assert it reports them —
// so a refactor that makes the resolver accept everything fails here rather than
// passing forever.

Deno.test("typesense coverage companion: the resolver reports the real historical dead fields", () => {
  const cases: Array<[string, TypesenseField]> = [
    // The five-month-old duplicate: the order item's field is `price.total_cents`.
    ["orders", { name: "items.total_price_cents", type: "int64[]", optional: true, money: true }],
    // `Card` has `dates.start`/`date_fs`, never a flat `date`.
    ["cards", { name: "date", type: "string", facet: true, optional: true }],
    // The geopoint lives at `destination.address.address_coordinates`.
    ["cards", { name: "destination.coordinates", type: "geopoint", optional: true }],
    // A `_str` mirror whose source is a string, not a number — the mirror rule
    // must not blanket-exempt every `*_str` name.
    ["orders", { name: "subject_str", type: "string", optional: true }],
  ];

  for (const [alias, field] of cases) {
    const config = typesenseSchemas[alias as keyof typeof typesenseSchemas];
    const withBad = [...config.schema.fields, field];
    assertEquals(
      unresolvedFields(storageFor(alias), withBad).includes(field.name),
      true,
      `the resolver accepted ${alias}:${field.name}, which no ${alias} document ` +
        `can carry — it has stopped being able to fail`,
    );
  }
});

Deno.test("typesense coverage companion: the strip rule reports a query_by_* field, and only top-level", () => {
  // The six that were live until 2026-08-09.
  for (
    const name of [
      "query_by_dates",
      "query_by_sources",
      "query_by_components",
      "query_by_component_of",
    ]
  ) {
    assertEquals(isStrippedAtIndexTime(name), true, `${name} must be reported as stripped`);
  }
  // …and not one segment further. `deleteQueryByFields` iterates top-level keys
  // only, so a predicate that matched the whole dotted name would reject a
  // declaration the code would have kept.
  assertEquals(isStrippedAtIndexTime("sources.query_by_uid"), false);
  assertEquals(isStrippedAtIndexTime("items.price.total_cents"), false);
});
