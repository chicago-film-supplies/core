/**
 * Typesense field coverage — **three questions about a declared field.**
 *
 * | question | arm |
 * |---|---|
 * | can it ever hold a value? | resolvability + not-stripped-at-index-time |
 * | is it referenced by something that renders? | displayDefaults |
 * | can the value it holds be one Typesense refuses? | integer parity + its inverse |
 *
 * The arms are named by their question rather than numbered, because the file
 * has outgrown two of them and an index is a name that goes stale the moment
 * one is added in the middle.
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
 * | six `query_by_*` across five collections | 2026-03→ | deleted from every document by `deleteQueryByFields` — see the strip arm. Four carried `facet: true`. |
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
 * The arms catch disjoint classes, and any one alone is a false sense of
 * coverage. `items.total_price_cents` resolves to nothing in Zod but is not
 * stripped; the six `query_by_*` resolve in Zod **perfectly well** (they are
 * real stored Firestore fields, with real composite indexes) and are invisible
 * to the resolvability arm entirely. And a field can resolve, survive the strip,
 * be referenced by a live column — and still take the collection offline,
 * because the leaf it resolves to is a `z.number()` under an `int64`
 * declaration. That is the integer-parity arm, and it is the only one whose
 * failure mode is collection-wide rather than field-wide.
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
import { assert, assertEquals } from "@std/assert";
import { z } from "zod";

import { FIRESTORE_TIMESTAMP_META, FirestoreTimestamp } from "../src/schemas/common.ts";
import { InvoiceSchema } from "../src/schemas/invoice.ts";
import { schemaFor } from "../src/schemas/mod.ts";
import { typesenseSchemas } from "../src/schemas/typesense/mod.ts";
import { isStrippedAtIndexTime } from "../src/schemas/typesense/types.ts";
import type { TypesenseField } from "../src/schemas/typesense/types.ts";
import { collectLeafPaths, getNodeMeta, isIntegerSafeLeaf } from "../src/schemas/zod-walk.ts";

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
  // ── composeOrgName(path), applied in api-cloudrun's `translateForTypesense`
  //    on the SOURCE document, before `stripUndeclaredFields`.
  //
  // 🔴 **The placement is load-bearing and is why this entry names it.** The
  // Typesense config declares `path`, `path.uid` and `path.name` but never
  // `path.derived`, so a producer running after the strip sees a path with the
  // flag gone — and `composeOrgName` filters with `!n.derived`, where
  // `!undefined` is TRUE. Every minted `(default)` segment then survives into
  // the label. Populated by `api-cloudrun/tests/unit/typesenseOrgLevel.test.ts`,
  // which plants a derived segment precisely to catch that.
  "organizations:name": "composeOrgName(path) — the stored scalar was removed (api-cloudrun#709)",
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

  // ── orgLevel (@cfs/core/utils/organizations), applied in api-cloudrun's
  //    `translateForTypesense` before `translateObject`.
  //    Typesense cannot facet on an ARRAY'S LENGTH, and the level is
  //    `ORG_LEVELS[path.length - 1]`. There is no stored `level` and there must
  //    not be — it could then disagree with `path`, which is the whole class the
  //    tree makes unrepresentable.
  //    ⚠️ The derivation FUNCTION is core's; only its application is api's.
  //    That is deliberate and it is the shape core#69 is about — the projection
  //    is declared here and transformed there, so neither repo can derive it
  //    alone.
  "organizations:level": "orgLevel (@cfs/core/utils/organizations) — ORG_LEVELS[path.length - 1], applied in api-cloudrun's translateForTypesense",

  // ── coerceArrayFields (api-cloudrun lib/typesenseTranslate.ts), deliberately
  //    computed BEFORE stripUndeclaredFields drops the fields they read.
  //
  // 🔴 **All five of these read a destination or item field the config does NOT
  // declare, and the placement is the whole correctness of them.**
  // `stripUndeclaredFields` deletes every undeclared key, and `postProcess` runs
  // AFTER it — so a producer there reads `undefined`.
  //
  // ⚠️ `deliveries` and `pickups` used to run in `postProcess` and this table
  // said so. `destinations[].customer_collecting` / `customer_returning` are not
  // declared on `orders` or `fulfillments`, so both predicates read `undefined`,
  // `undefined !== true` is TRUE, and **every document with at least one
  // destination indexed `deliveries: true, pickups: true`** — two constant-true
  // facets per collection, offered to operators as filters. Measured on prod
  // 2026-08-29 before the repair: 1,000 of 1,000 orders and 1,000 of 1,000
  // fulfillments indexed `true` on both, against a truth of 644 documents
  // carrying at least one wrong value (621 `deliveries`, 641 `pickups`).
  // The value assertion that would have caught it is
  // `api-cloudrun/tests/unit/typesenseDestinationDerived.test.ts`, which plants
  // a customer-collect leg — the same shape as `typesenseOrgLevel.test.ts`.
  "orders:deliveries": "coerceArrayFields — any destination pair with customer_collecting !== true",
  "orders:pickups": "coerceArrayFields — any destination pair with customer_returning !== true",
  "fulfillments:deliveries": "coerceArrayFields — same rule as orders:deliveries",
  "fulfillments:pickups": "coerceArrayFields — same rule as orders:pickups",
  "fulfillments:has_conflicts":
    "coerceArrayFields — any item whose picker quantity diverges from the order's projection",
  "fulfillments:destinations.pick_bucket":
    "coerceArrayFields — per leg, `customer_collecting ? \"customer-collect\" : delivery.uid`",
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
  // `firestoreCollection` is a `CollectionName` — the lookup cannot miss.
  const storage = schemaFor(config.firestoreCollection);
  if (!storage) {
    throw new Error(
      `${alias}: no storage schema registered for firestoreCollection ` +
        `"${config.firestoreCollection}" — this test would be silently blind for it`,
    );
  }
  return storage;
}

// ── The walk must be complete, or every arm below is unsound ────────

Deno.test("typesense coverage: every storage schema walks with no unhandled node", () => {
  // `collectLeafPaths` fails closed — a node type it does not recognise is
  // pushed to `unhandled` rather than emitted as a leaf, because emitting it
  // would silently swallow its whole subtree and make every path under it look
  // unresolvable. A non-empty `unhandled` means every verdict below is not
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

// ── Resolvability: can a declared field ever hold a value? ──────────

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

// ── Not stripped on the way to the index ────────────────────────────

Deno.test("typesense coverage: no declared field is deleted at index time", () => {
  // Invisible to the resolvability arm by construction: `query_by_*` fields are real stored
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

// ── Display defaults name declared fields ───────────────────────────

Deno.test("typesense coverage: every displayDefaults reference names a declared field", () => {
  // Green the day it landed, unlike the two arms above, and kept because it
  // closes the hole the two above OPEN: deleting a dead field is exactly the moment
  // a column, facet or sort still naming it becomes a reference to nothing.
  // `cards.displayDefaults.columns` held `"date"` — pointing at a field that had
  // never held a value — right up to the commit that removed it.
  const dangling: string[] = [];
  for (const [alias, config] of Object.entries(typesenseSchemas)) {
    const declared = new Set(config.schema.fields.map((f) => f.name));
    const d = config.displayDefaults;
    // `facet` and `group` were checked here too, until both keys were deleted as
    // write-only (core#50). Worth knowing why this arm did not catch them: it
    // asks whether a reference names a DECLARED FIELD, and `cards.facet`'s
    // `uid_list` named a real one. A reference can be perfectly resolvable and
    // still render nothing, if the thing holding it has no reader.
    const refs: Array<[string, string]> = [
      ...d.columns.map((c) => ["columns", c] as [string, string]),
      ...Object.keys(d.filters).map((c) => ["filters", c] as [string, string]),
      ...(d.sort.column ? [["sort.column", d.sort.column] as [string, string]] : []),
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
// Every arm here asserts that a set is EMPTY, and an empty set is what a
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

// ── Integer parity: can the value it holds be one Typesense refuses? ─
//
// A different question from arms 1–3, on the same subject. Those ask whether a
// declared field can ever hold a value; this asks whether the value it holds can
// be one Typesense will refuse.
//
// The asymmetry is what makes it worth its own arm. A `string` declaration
// backed by a loose schema indexes whatever it is given. An `int32`/`int64`
// declaration backed by a `z.number()` is a promise the schema does not keep,
// and breaking it fails the import for the WHOLE collection rather than for the
// offending document — while the previous index keeps answering queries, so
// nothing looks wrong. Dev's `orders` alias sat on the pre-cents schema for
// three days that way (api-cloudrun#460), and both prod collections before it
// (#451), each time over a handful of `1249.2`-shaped values.
//
// It is deliberately a check on the DECLARATION, not on the corpus. The corpus
// was measured separately and found clean in both environments
// (api-cloudrun `api-cloudrun/scripts/audit-typesense-int-fields.ts`, 18k documents each);
// that proves today, this proves every future document.

/** Typesense field types that promise an integer. */
const INT_TYPES: ReadonlySet<string> = new Set(["int32", "int32[]", "int64", "int64[]"]);

/** Typesense field types that permit a fraction. */
const FLOAT_TYPES: ReadonlySet<string> = new Set(["float", "float[]"]);

/**
 * The storage leaves a Typesense field name resolves to, in the same spelling
 * the resolvability arm uses — container markers stripped.
 */
function leavesFor(storage: z.ZodType, fieldName: string) {
  return collectLeafPaths(storage).leaves.filter(
    (leaf) => leaf.path.replaceAll("[]", "").replaceAll(".<key>", "") === fieldName,
  );
}

/**
 * A leaf exempt from the integer rule.
 *
 * **One structural rule, and no named entries.** `FirestoreTimestamp` is a
 * `z.custom`, so it is not integer-safe by inspection — but every one of these
 * reaches the index as `Timestamp.toMillis()`, which is whole by construction.
 * There are 73 such declarations, and listing them would be a table nobody could
 * keep true.
 *
 * Keyed on the `firestoreTimestamp` meta marker rather than on a `*_fs` name
 * suffix, for two measured reasons: the marker survives a `.meta()` clone (the
 * whole reason it exists — annotating `created_at` with a display label produces
 * a different instance of the same type), and `organizations:last_order` /
 * `out-of-service:canceled_at` are timestamps whose NAMES a suffix rule would
 * miss entirely.
 */
function isTimestampBacked(leaf: { meta: Record<string, unknown> }): boolean {
  return leaf.meta[FIRESTORE_TIMESTAMP_META] === true;
}

/**
 * Declarations of `fields` whose backing storage can hold a non-integer.
 *
 * ⚠️ **ALL leaves must be safe, not ANY**, and this is the single most
 * load-bearing line in the arm. `tags:count` resolved to TWO leaves — a
 * `z.record(…FieldValue…)` and a `z.number()` — and under an ANY rule,
 * tightening the number arm alone would have gone green while the record arm
 * still admitted a map into an `int32` field that is also the collection's
 * `default_sorting_field`. ANY is the natural "make it green" refactor, and it
 * is the `Tag.count` hole exactly.
 *
 * Takes its inputs explicitly, like `unresolvedFields`, so the companions can
 * run it against deliberately-wrong declarations and assert it reports.
 */
function fractionalRiskFields(storage: z.ZodType, fields: TypesenseField[]): string[] {
  const risky: string[] = [];
  for (const field of fields) {
    if (!INT_TYPES.has(field.type)) continue;
    const leaves = leavesFor(storage, field.name);
    if (leaves.length === 0) continue; // the resolvability arm's question, not this one
    const unsafe = leaves.filter((leaf) =>
      !isTimestampBacked(leaf) && !isIntegerSafeLeaf(leaf.node)
    );
    if (unsafe.length > 0) risky.push(field.name);
  }
  return risky;
}

Deno.test("typesense integer parity: every int declaration is backed by an integer-safe leaf", () => {
  const risky: string[] = [];
  for (const [alias, config] of Object.entries(typesenseSchemas)) {
    for (const name of fractionalRiskFields(storageFor(alias), config.schema.fields)) {
      risky.push(`${alias}:${name}`);
    }
  }

  assertEquals(
    risky.sort(),
    [],
    "These fields are declared int32/int64 in a Typesense collection config, " +
      "but the backing Zod schema would accept a fractional value at them. One " +
      "such value does not fail its own write — it fails the next rebuild of " +
      "the ENTIRE collection, while the stale index keeps serving.\n\n" +
      "Fix by tightening the storage leaf to `z.int()` (it infers `number`, so " +
      "no interface moves), not by widening the declaration to `float` — that " +
      "flips the default sort direction and sorts numbers lexically.\n\n" +
      risky.join("\n"),
  );
});

// ── The inverse: a rate is a float ──────────────────────────────────

Deno.test("typesense integer parity: no rate-family field is declared as an integer", () => {
  // This rule lived only in a docblock on `TypesenseField.money`, and it is what
  // stops someone running arm 4 backwards. A rate is NOT money and NOT a count:
  // it holds 4dp to match Xero's `DiscountRate`, so declaring one `int32` would
  // quantize every discount to whole percent — the beta.117 defect, where a
  // 100-unit $6.39 purchase reported $0.06/unit.
  //
  // ⚠️ `crms_rate_id` and `crms_linked_replacement_rate_id` contain "rate" and
  // are record IDs. They are integers, correctly, and are excluded by name here
  // — which is the honest cost of a name-based rule and the reason arm 4 is
  // structural instead.
  const misdeclared: string[] = [];
  for (const [alias, config] of Object.entries(typesenseSchemas)) {
    for (const field of config.schema.fields) {
      const last = field.name.split(".").at(-1) ?? "";
      const isRate = (last === "rate" || last.endsWith("_rate") || last.endsWith("_cost")) &&
        !last.endsWith("_rate_id") && !last.endsWith("_id");
      if (!isRate) continue;
      if (INT_TYPES.has(field.type)) misdeclared.push(`${alias}:${field.name} (${field.type})`);
    }
  }

  assertEquals(
    misdeclared.sort(),
    [],
    "A rate carries 4 decimal places to match Xero's DiscountRate and is not " +
      "money and not a count. Declaring one as an integer coarsens every value " +
      "it holds:\n" + misdeclared.join("\n"),
  );
});

// ── Fail-closed companions for the two integer arms ─────────────────

Deno.test("typesense integer parity companion: the predicate reads BOTH Zod 4 spellings", () => {
  // `z.int()` puts the format on the def; `z.number().int()` puts it in a
  // `checks[]` entry and leaves `def.format` undefined. Both spellings are live
  // in `src/schemas/`, so reading only the first lands the arm RED on correct
  // fields — and a red arm on correct fields acquires an allowlist, which is
  // what the arm exists to replace.
  assertEquals(isIntegerSafeLeaf(z.int()), true, "z.int()");
  assertEquals(isIntegerSafeLeaf(z.number().int()), true, "z.number().int()");
  assertEquals(isIntegerSafeLeaf(z.int32()), true, "z.int32()");
  assertEquals(isIntegerSafeLeaf(z.int().min(0)), true, "z.int().min(0)");

  // Negative control — the whole point is that these are distinguishable.
  assertEquals(isIntegerSafeLeaf(z.number()), false, "z.number()");
  assertEquals(isIntegerSafeLeaf(z.number().min(0)), false, "z.number().min(0)");
  assertEquals(isIntegerSafeLeaf(z.string()), false, "z.string()");
  assertEquals(isIntegerSafeLeaf(z.boolean()), false, "z.boolean()");

  // Integral in effect, not declared so. `multipleOf` takes an argument nothing
  // constrains, and accepting it gives this predicate an opinion about
  // arithmetic rather than about a declaration.
  assertEquals(isIntegerSafeLeaf(z.number().multipleOf(1)), false, "z.number().multipleOf(1)");
});

Deno.test("typesense integer parity companion: a numeric literal is integer-safe, a fractional one is not", () => {
  // `COARevenueEnum` is a union of numeric literals, which `collectLeafPaths`
  // emits as one leaf per member. Four of the int declarations in these configs
  // are backed that way, and retyping them to `z.int()` to satisfy the arm would
  // DELETE the enum — narrowing the check into a worse schema.
  assertEquals(isIntegerSafeLeaf(z.literal(4000)), true);
  assertEquals(isIntegerSafeLeaf(z.literal(1.5)), false);
  assertEquals(isIntegerSafeLeaf(z.literal("4000")), false);
  assertEquals(isIntegerSafeLeaf(z.literal([1, 2])), true);
  assertEquals(isIntegerSafeLeaf(z.literal([1, 2.5])), false);
});

Deno.test("typesense integer parity companion: FirestoreTimestamp is exempt by META, not by name", () => {
  // The exemption has to survive a `.meta()` clone, because annotating a
  // timestamp with a display label produces a different instance of the same
  // type — and `organizations:last_order` / `out-of-service:canceled_at` are
  // timestamps whose names a `*_fs` suffix rule would miss entirely.
  assertEquals(isIntegerSafeLeaf(FirestoreTimestamp), false, "not a number, correctly");
  const annotated = FirestoreTimestamp.meta({ column: true, label: "Created" });
  assertEquals(
    (getNodeMeta(annotated) ?? {})[FIRESTORE_TIMESTAMP_META],
    true,
    "the marker must survive .meta() — otherwise 73 declarations go red",
  );
});

Deno.test("typesense integer parity companion: ALL leaves must be safe, not ANY", () => {
  // The `Tag.count` shape, reconstructed: a union of a record and a number.
  // Tightening only the number arm is the natural "make it green" move, and
  // under an ANY rule it goes green while the record arm still admits a map.
  const twoArmed = z.strictObject({
    count: z.union([z.record(z.string(), z.custom<unknown>()), z.number()]),
  });
  const halfFixed = z.strictObject({
    count: z.union([z.record(z.string(), z.custom<unknown>()), z.int()]),
  });
  const field: TypesenseField[] = [{ name: "count", type: "int32" }];

  assertEquals(fractionalRiskFields(twoArmed, field), ["count"], "both arms unsafe");
  assertEquals(
    fractionalRiskFields(halfFixed, field),
    ["count"],
    "ONE arm tightened is not a fix — under ANY this would report clean, which " +
      "is exactly how the Tag.count record arm would have survived",
  );
  assertEquals(
    fractionalRiskFields(z.strictObject({ count: z.int() }), field),
    [],
    "and a genuinely fixed schema must report nothing, or the arm reports everything",
  );
});

Deno.test("typesense integer parity companion: the arm reports a real schema loosened back", () => {
  // The mutation companion. Loosening a field on the REAL `InvoiceSchema` must
  // be reported — an arm built on a resolver that has drifted into agreeing with
  // everything passes forever, and an empty failure list is what both look like.
  //
  // `.safeExtend`, not `.extend`: Zod 4 refuses `.extend` on a refined object,
  // and `InvoiceSchema` carries the settlement-identity refine.
  const loosened = (InvoiceSchema as unknown as {
    safeExtend: (shape: Record<string, z.ZodType>) => z.ZodType;
  }).safeExtend({ number: z.number() });

  const invoiceFields = typesenseSchemas.invoices.schema.fields;
  assertEquals(
    fractionalRiskFields(loosened, invoiceFields).includes("number"),
    true,
    "putting `number: z.number()` back on the real InvoiceSchema was NOT reported — " +
      "the arm has stopped being able to fail",
  );
  assertEquals(
    fractionalRiskFields(storageFor("invoices"), invoiceFields).includes("number"),
    false,
    "…and the unmodified schema must not be reported, or the above proves nothing",
  );
});

Deno.test("typesense integer parity companion: the inverse arm reports an integer-declared rate", () => {
  const misdeclared = [
    { name: "discount.rate", type: "int32" },
    { name: "cost.unit_cost", type: "int64" },
  ] as TypesenseField[];
  for (const field of misdeclared) {
    const last = field.name.split(".").at(-1)!;
    const isRate = (last === "rate" || last.endsWith("_rate") || last.endsWith("_cost")) &&
      !last.endsWith("_rate_id") && !last.endsWith("_id");
    assertEquals(isRate && INT_TYPES.has(field.type), true, `${field.name} must be reported`);
  }
  // …and the two record ids that contain "rate" must NOT be.
  for (const name of ["crms_rate_id", "crms_linked_replacement_rate_id"]) {
    const last = name.split(".").at(-1)!;
    const isRate = (last === "rate" || last.endsWith("_rate") || last.endsWith("_cost")) &&
      !last.endsWith("_rate_id") && !last.endsWith("_id");
    assertEquals(isRate, false, `${name} is a record id, not a rate`);
  }
});

Deno.test("typesense integer parity: the census, so an inert walker cannot report success", () => {
  // A correct predicate and a resolver that reaches nothing produce the SAME
  // empty failure list. This counts what each branch actually saw. The numbers
  // are a floor plus an exact split, not a pin on a remembered total: a new
  // collection or a new field should not fail this, but a walk that collapses
  // to zero must.
  let intDeclared = 0, timestampBacked = 0, indexDerived = 0, schemaBacked = 0;
  let floatDeclared = 0;

  for (const [alias, config] of Object.entries(typesenseSchemas)) {
    const storage = storageFor(alias);
    for (const field of config.schema.fields) {
      if (FLOAT_TYPES.has(field.type)) floatDeclared += 1;
      if (!INT_TYPES.has(field.type)) continue;
      intDeclared += 1;
      const leaves = leavesFor(storage, field.name);
      if (leaves.length === 0) indexDerived += 1;
      else if (leaves.every(isTimestampBacked)) timestampBacked += 1;
      else schemaBacked += 1;
    }
  }

  assertEquals(
    intDeclared,
    timestampBacked + indexDerived + schemaBacked,
    "every int declaration must land in exactly one bucket",
  );
  // The floor. `>= `, not `===`: growth is expected, collapse is the failure.
  assertEquals(intDeclared >= 190, true, `only ${intDeclared} int declarations seen — the walk went inert`);
  assertEquals(
    timestampBacked >= 70,
    true,
    `only ${timestampBacked} timestamp-backed — the meta exemption stopped matching, ` +
      `which would make the arm above red on 73 correct fields`,
  );
  assertEquals(
    schemaBacked >= 100,
    true,
    `only ${schemaBacked} schema-backed leaves reached — the resolver is not crossing ` +
      `arrays or unions, and the arm above is checking almost nothing`,
  );
  assertEquals(
    indexDerived > 0 && indexDerived < 30,
    true,
    `${indexDerived} index-derived declarations — the resolvability arm owns these, and a jump means ` +
      `the resolver stopped resolving`,
  );
  assertEquals(floatDeclared > 0, true, "no float declarations seen at all");
});


// ── document parity: the THIRD declaration ──────────────────────────
//
// ⭐ **This file's other arms all compare CONFIG ↔ STORAGE SCHEMA. Nothing
// compared either against `typesense/documents.ts`, and that is a third
// declaration of the same fact.** The consequence was core#57: the cents
// migration renamed money fields to `_cents`, the storage schema and the config
// both moved, and the hand-written document types did not — so manager read
// `.amount`, type-checked, and got `undefined` forever.
//
// ⚠️ **The reason it survived is worth keeping.** The rename made every NAMED
// reader a compile error exactly as designed, and this file has no reader inside
// the package:
//
//     $ grep -rln "typesense/documents" tests/ src/     # (nothing)
//
// It is consumed only downstream, so `core` never type-checked it against
// anything. Its population of in-package readers was zero, and a population of
// zero is why nothing objected.
//
// ⚠️ **A full type-level derive was considered and REJECTED on a measurement.**
// Deriving `XDocument` from its config would need `as const` on a published
// export — but the configs are annotated `: TypesenseCollectionConfig` precisely
// because JSR's `no-slow-types` requires it, which erases every literal field
// name to `string`. That is the same wall that disqualified a path type for the
// propagation catalog's `fields[]`. Deriving from the STORAGE schema instead is
// only half available: the `_str` mirrors, `_fs` timestamps and computed rollups
// have no storage counterpart by design. So the CHECK is derived even though the
// type cannot be.

/**
 * Typesense's own document id — never a declared config field, since the indexer
 * sets it from the doc's uid. One named exemption rather than a set: a second
 * entry here would mean the mapping is wrong, not that a second such field exists.
 */
const TYPESENSE_DOC_ID = "id";

/** `OutOfServiceDocument` → `out-of-service`, `UserDocument` → `users`, … */
function aliasCandidatesFor(interfaceName: string): string[] {
  const base = interfaceName
    .replace(/Document$/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase();
  return [base, `${base}s`, base.replace(/y$/, "ies")];
}

Deno.test("typesense document parity: every hand-written document field is a declared config field", async () => {
  const source = await Deno.readTextFile(
    new URL("../src/schemas/typesense/documents.ts", import.meta.url),
  );
  const blocks = [...source.matchAll(/export interface (\w+Document)\b([\s\S]*?)\n}\n/g)];

  // Vacuity guards FIRST. If the block regex or the property regex stops
  // matching, every assertion below passes over an empty set and this arm reads
  // green while checking nothing — which is the exact defect it exists to catch.
  assertEquals(
    blocks.length >= 22,
    true,
    `only ${blocks.length} document interfaces matched — the block regex stopped reaching them`,
  );

  const offenders: string[] = [];
  const unmapped: string[] = [];
  let checkedProps = 0;

  for (const [, interfaceName, body] of blocks) {
    const alias = aliasCandidatesFor(interfaceName).find((a) => a in typesenseSchemas);
    if (!alias) {
      unmapped.push(`${interfaceName} → tried ${aliasCandidatesFor(interfaceName).join(", ")}`);
      continue;
    }
    const legalLeaves = new Set<string>();
    for (const field of typesenseSchemas[alias as keyof typeof typesenseSchemas].schema.fields) {
      for (const segment of field.name.split(".")) legalLeaves.add(segment);
    }
    // Property names anywhere in the interface, INCLUDING inside inline nested
    // object and array literals — `taxes?: Array<{ amount_cents?: number }>` has
    // to yield `amount_cents`, because that is where core#57's drift lived.
    for (const prop of new Set([...body.matchAll(/([A-Za-z_]\w*)\??:/g)].map((m) => m[1]))) {
      if (prop === TYPESENSE_DOC_ID) continue;
      checkedProps++;
      if (!legalLeaves.has(prop)) offenders.push(`${interfaceName}.${prop} (config: ${alias})`);
    }
  }

  // An interface nothing maps to is NOT benign — it is this arm silently
  // skipping the interface most likely to have drifted.
  assertEquals(unmapped, [], `document interfaces with no matching config:\n  ${unmapped.join("\n  ")}`);
  assertEquals(
    checkedProps > 400,
    true,
    `only ${checkedProps} properties checked — the property regex stopped reaching them`,
  );
  assertEquals(
    offenders,
    [],
    `Hand-written document fields that no config declares — a consumer reads these and gets undefined:\n  ` +
      offenders.join("\n  "),
  );
});

Deno.test("typesense document parity companion: the arm reports a field the config does not declare", () => {
  // Proves the check can fire on core#57's exact drift. Every money field on the
  // orders config is `amount_cents`, so the un-suffixed form must be absent —
  // if it ever becomes legal, the arm above stops being able to see that class.
  const legalLeaves = new Set<string>();
  for (const field of typesenseSchemas.orders.schema.fields) {
    for (const segment of field.name.split(".")) legalLeaves.add(segment);
  }
  assertEquals(legalLeaves.has("amount_cents"), true, "orders should declare amount_cents");
  assertEquals(
    legalLeaves.has("amount"),
    false,
    "orders must NOT declare a bare `amount` — if it does, core#57's drift is undetectable",
  );
});

/**
 * Read `TypesenseDocumentMap`'s keys out of the source. The interface is a TYPE
 * and is erased at runtime, so there is nothing to enumerate at import time —
 * the same reason the parity arm above reads source text.
 */
function documentMapKeys(source: string): string[] {
  const block = source.match(/export interface TypesenseDocumentMap \{([\s\S]*?)\n\}/);
  if (!block) return [];
  return [...block[1].matchAll(/^\s*"?([a-z][\w-]*)"?:/gm)].map((m) => m[1]);
}

/**
 * core#60 — `TypesenseDocumentMap` covered 20 of the 22 declared aliases, and
 * the two missing ones were `cards` and `threads`.
 *
 * `cards` is the one that cost something: `enabled: true`, live, 1,097 prod
 * documents, and **unreachable from manager's typed search surface**, because
 * every typed consumer there is generic over `keyof TypesenseDocumentMap`.
 *
 * ⚠️ **Assert ALL 22, not the live ones.** `enabled` defaults to on and
 * `bookings` is disabled *and* mapped, so this map is about TYPE REACHABILITY,
 * not liveness. Keying it on `enabled` would drop a type the moment someone
 * toggled a flag, which is a config change silently becoming a type change.
 */
Deno.test("every declared Typesense alias is reachable from TypesenseDocumentMap", async () => {
  const source = await Deno.readTextFile(
    new URL("../src/schemas/typesense/documents.ts", import.meta.url),
  );
  const mapped = documentMapKeys(source);

  // Vacuity guard first — an empty parse would make the comparison below pass
  // against an empty set. ⚠️ It deliberately asks only whether the parser
  // REACHED the block, not whether the map is complete: a count-based guard set
  // to the current size overlaps the equality assertion, and then a genuinely
  // missing alias trips the vacuity message ("the regex stopped reaching them")
  // instead of the one that names it. Measured — removing `cards` reported 21
  // keys and blamed the regex. Completeness is the next assertion's job, and it
  // prints the diff.
  assertEquals(
    mapped.length > 0,
    true,
    "no TypesenseDocumentMap keys parsed at all — the regex stopped reaching the block",
  );

  const declared = Object.keys(typesenseSchemas).sort();
  assertEquals(
    [...mapped].sort(),
    declared,
    "TypesenseDocumentMap must name exactly the declared alias set — " +
      "a config with no map entry is invisible to every typed search consumer",
  );
});

Deno.test("document-map companion: the parser finds real keys, and reports a missing one", () => {
  // Fail-closed. The arm above can only bite if `documentMapKeys` actually
  // parses — and a parser that silently returns [] is indistinguishable from a
  // map that happens to be complete.
  const complete = `export interface TypesenseDocumentMap {\n  bookings: BookingDocument;\n  "chart-of-accounts": ChartOfAccountsDocument;\n  cards: CardDocument;\n}`;
  assertEquals(documentMapKeys(complete), ["bookings", "chart-of-accounts", "cards"]);

  // The core#60 shape itself: a declared alias with no map entry.
  const missingCards = `export interface TypesenseDocumentMap {\n  bookings: BookingDocument;\n}`;
  assertEquals(documentMapKeys(missingCards).includes("cards"), false);

  // And a parse that stops reaching the block returns empty rather than lying.
  assertEquals(documentMapKeys("export interface SomethingElse {\n  a: B;\n}"), []);
});

// ── A non-optional declaration must be backed by a non-nullable leaf ────────
//
// 🔴 **Typesense answers `HTTP 400 — Field <x> has an incorrect type` for a
// `null` in a field the config declared required**, and the sync for that
// document fails permanently. It looks like nothing until a document without
// the value arrives.
//
// `organizations.billing_address` carried exactly this for the whole life of
// the collection: `Organization.billing_address` is `Address.nullable()`, the
// config said the object was required, and it never bit because all 292 real
// customer records happened to have an address. The org tree's 30 MINTED
// ancestors — a root has no billing address by construction — were the first
// documents to exercise it, and all 30 failed to index while every real
// organization synced fine.
//
// ⚠️ **That is a present-tense claim about the CORPUS standing in for a claim
// about the SCHEMA**, which is Ratchet H's lesson in `api-cloudrun/CLAUDE.md`,
// and it was reachable through the API the whole time: `CreateOrganizationInput`
// accepts a null `billing_address`.

/**
 * Declarations that are non-optional over an optional leaf and MUST stay that
 * way, with the reason. Both are `default_sorting_field`s, and Typesense
 * requires that field to be non-optional — so making them honest is not
 * available; the collection would fail to create.
 *
 * ⚠️ Each is therefore a live hazard, not a blessed pattern: the first tag
 * written without a `count` fails to index. The fix is to make `count` REQUIRED
 * on the storage schema (it is maintained by an incremental `± 1` in the
 * products writer and is present on every row today), not to widen this list.
 */
const NON_OPTIONAL_OVER_OPTIONAL_LEAF: Record<string, string> = {
  "tags:count": "`count` is this collection's default_sorting_field, which Typesense requires to be non-optional",
  "tracking-categories:count": "declared int32 for sorting alongside tags; same shape, same constraint",
};

Deno.test("typesense coverage: a non-optional declaration is backed by a non-nullable leaf", async () => {
  const { typesenseSchemas } = await import("../src/schemas/typesense/mod.ts");
  const { schemas } = await import("../src/schemas/mod.ts");
  const { resolveZodField } = await import("../src/schemas/zod-walk.ts");

  const offenders: string[] = [];
  let checked = 0;
  for (const [alias, cfg] of Object.entries(typesenseSchemas)) {
    const doc = (schemas as Record<string, unknown>)[cfg.firestoreCollection];
    if (!doc) continue;
    for (const f of cfg.schema.fields) {
      if (f.optional === true || f.name === "id") continue;
      const leaf = resolveZodField(doc as never, f.name, { unwrap: false });
      if (!leaf) continue; // a derived field — covered by DERIVED_FIELDS above
      checked++;
      // deno-lint-ignore no-explicit-any
      let n: any = leaf;
      const wrappers: string[] = [];
      while (n?._zod?.def) {
        wrappers.push(n._zod.def.type);
        n = n._zod.def.innerType;
      }
      if (!wrappers.some((w) => w === "nullable" || w === "optional")) continue;
      const key = `${alias}:${f.name}`;
      if (key in NON_OPTIONAL_OVER_OPTIONAL_LEAF) continue;
      offenders.push(`${key}  (leaf is ${wrappers.join(" > ")})`);
    }
  }

  // Non-vacuity: the walk must actually reach a meaningful number of
  // declarations, or a resolver change would make this pass over nothing.
  assert(checked > 100, `only ${checked} non-optional declarations resolved — the walk stopped reaching the configs`);

  assertEquals(
    offenders.sort(),
    [],
    "These Typesense fields are declared NON-OPTIONAL over a leaf the storage schema " +
      "allows to be null or absent. Typesense answers HTTP 400 for such a document and " +
      "its sync fails permanently — invisibly, until the first document without the " +
      "value arrives.\n\nFix by adding `optional: true` to the declaration, or by making " +
      "the storage field required.\n\n" + offenders.join("\n"),
  );
});

Deno.test("non-optional-over-nullable companion: the arm catches a real over-claim", () => {
  // The exact shape that broke `organizations.billing_address`: a required
  // object declaration over a `.nullable()` leaf. Planted structurally so the
  // arm cannot pass by failing to walk.
  const nullableLeaf = z.strictObject({ a: z.string() }).nullable();
  // deno-lint-ignore no-explicit-any
  let n: any = nullableLeaf;
  const wrappers: string[] = [];
  while (n?._zod?.def) {
    wrappers.push(n._zod.def.type);
    n = n._zod.def.innerType;
  }
  assert(wrappers.includes("nullable"), `the wrapper walk missed a .nullable(): got [${wrappers.join(", ")}]`);

  // …and a plain required leaf is NOT flagged.
  // deno-lint-ignore no-explicit-any
  let m: any = z.string();
  const plain: string[] = [];
  while (m?._zod?.def) {
    plain.push(m._zod.def.type);
    m = m._zod.def.innerType;
  }
  assertEquals(plain.some((w) => w === "nullable" || w === "optional"), false);
});
