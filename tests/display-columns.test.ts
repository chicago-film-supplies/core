/**
 * Declared display columns — **is every column someone chose, and does it have
 * a name?**
 *
 * Before `column: true`, a walker enumerated ~375 columns across the manager's
 * 14 live table surfaces and a set of structural regexes generated a heading for
 * each. Nobody had chosen either. Both were string functions over schema-derived
 * paths, so both drifted on every rename: the cents migration produced the
 * heading **"Totals - Total Cents"**, `date_fs` degenerated to **"Fs"**, and a
 * `key.includes("cost")` renderer test printed a 4dp rate of $0.0639/unit as
 * **`$0.00`**.
 *
 * The four arms here are what makes "declared" mean something:
 *
 * | arm | catches |
 * |---|---|
 * | **T8** every default column is declared | the column a table opens with renders nothing |
 * | **T9** every column has a unique, non-empty heading | two columns under one name; a column under none |
 * | **T10** the rollup table names real fields, and nothing is unlabelled | a computed Typesense field with no Firestore field to hang a label on |
 * | **T11** every Typesense column is a declared *field* | a column for a field the index does not carry |
 *
 * T11 is deliberately the narrow arm: the general property — every declared
 * *field* resolves against the storage schema — already ships in
 * `typesenseFieldCoverage.test.ts` and would be red before this file ran. What
 * is added here is the column-specific containment.
 *
 * Each arm has a **fail-closed companion**: an assertion that a set is empty is
 * exactly what a checker that has quietly stopped checking also produces, so
 * each is re-run against a deliberately-broken input and asserted to report it.
 */
import { assertEquals } from "@std/assert";
import { z } from "zod";

import {
  firestoreDisplayDefaults,
  getFirestoreColumns,
  getTypesenseColumns,
  schemas,
  TYPESENSE_ROLLUP_COLUMNS,
} from "../src/schemas/mod.ts";
import { buildTypesenseColumns } from "../src/schemas/display-columns.ts";
import { typesenseSchemas } from "../src/schemas/typesense/mod.ts";
import { collectDisplayColumns } from "../src/schemas/zod-walk.ts";

/** One `[key[], schema]` per unique schema — the record aliases most of them. */
function uniqueSchemas(): Array<[string[], z.ZodType]> {
  const map = new Map<z.ZodType, string[]>();
  for (const [key, schema] of Object.entries(schemas)) {
    const hit = map.get(schema);
    if (hit) hit.push(key);
    else map.set(schema, [key]);
  }
  return [...map.entries()].map(([schema, keys]) => [keys, schema]);
}

// ── Arm 0: the walk must be complete, or every arm below is unsound ──

Deno.test("display columns: every schema walks with no unhandled node", () => {
  // `collectDisplayColumns` fails closed for the same reason `collectLeafPaths`
  // does: a node type it cannot interpret would take its whole subtree with it,
  // and every column under that subtree would vanish from the picker with
  // nothing to notice. So it reports rather than skips, and that report is
  // checked first — the arms below are walking its output.
  const broken: string[] = [];
  for (const [keys, schema] of uniqueSchemas()) {
    for (const u of collectDisplayColumns(schema).unhandled) {
      broken.push(`${keys[0]}: ${u.path} [${u.type}]`);
    }
  }
  assertEquals(broken.sort(), [], `collectDisplayColumns could not interpret:\n${broken.join("\n")}`);
});

// ── T8: every default column is a declared column ────────────────────

Deno.test("T8: every Typesense displayDefaults column is a declared column", () => {
  // The arm `display-defaults.test.ts` never had. It checked that a default
  // column *resolves in the Zod schema* — true of `cards.uid_list`, which is a
  // real `ListId` field and an opaque id no table can render — and said nothing
  // about whether anything had declared it displayable. Three defaults were
  // stranded that way.
  const undeclared: string[] = [];
  for (const [alias, config] of Object.entries(typesenseSchemas)) {
    const declared = new Set(getTypesenseColumns(alias).map((c) => c.key));
    for (const col of config.displayDefaults.columns) {
      if (!declared.has(col)) undeclared.push(`${alias}: ${col}`);
    }
  }
  assertEquals(
    undeclared.sort(),
    [],
    "These Typesense collections open with a column nothing declares, so the " +
      "table renders a blank column under a generated heading. Annotate the " +
      "backing Zod field `.meta({ column: true, label })`, add the field to " +
      "TYPESENSE_ROLLUP_COLUMNS if it is computed at index time, or change the " +
      "default:\n" + undeclared.join("\n"),
  );
});

Deno.test("T8: every Firestore displayDefaults column is a declared column", () => {
  const undeclared: string[] = [];
  for (const [collection, defaults] of Object.entries(firestoreDisplayDefaults)) {
    const declared = new Set(getFirestoreColumns(collection).map((c) => c.key));
    for (const col of defaults.columns) {
      if (!declared.has(col)) undeclared.push(`${collection}: ${col}`);
    }
  }
  assertEquals(
    undeclared.sort(),
    [],
    "These Firestore collections open with an undeclared column:\n" + undeclared.join("\n"),
  );
});

// ── T9: every column has a heading, and headings are unique ──────────

Deno.test("T9: every declared column composes a non-empty label", () => {
  // A composed label is the `label` of every key traversed, so a `column: true`
  // whose whole path is unlabelled composes to `""` — a blank table heading.
  // That is the failure mode of annotating a SHARED building block (`UidNameRef.name`
  // carries `column` and no label on purpose) and forgetting to name it at one
  // of its use sites.
  const unlabelled: string[] = [];
  for (const [keys, schema] of uniqueSchemas()) {
    for (const col of collectDisplayColumns(schema).columns) {
      if (!col.label) unlabelled.push(`${keys[0]}: ${col.path}`);
    }
  }
  assertEquals(
    unlabelled.sort(),
    [],
    "These columns compose an empty heading. The label comes from the keys " +
      "traversed, so name the key that holds the shared schema (e.g. " +
      "`tags: z.array(UidNameRef).meta({ label: \"Tags\" })`):\n" + unlabelled.join("\n"),
  );
});

Deno.test("T9: no two columns on one surface share a heading", () => {
  // Checked PER SURFACE, which is the granularity at which it is a defect: two
  // columns collide only if the same picker offers both. Today's generated
  // labels collide freely — `humanize` gave `totals.taxes.name` and
  // `items.price.taxes.name` the single heading "Taxes", and both destinations'
  // contacts the single heading "Contact".
  const collisions: string[] = [];
  const surfaces: Array<[string, Array<{ key: string; label: string }>]> = [
    ...Object.keys(typesenseSchemas).map(
      (alias) => [`typesense:${alias}`, getTypesenseColumns(alias)] as [string, Array<{ key: string; label: string }>],
    ),
    ...Object.keys(firestoreDisplayDefaults).map(
      (c) => [`firestore:${c}`, getFirestoreColumns(c)] as [string, Array<{ key: string; label: string }>],
    ),
  ];
  for (const [surface, columns] of surfaces) {
    const byLabel = new Map<string, string[]>();
    for (const col of columns) byLabel.set(col.label, [...(byLabel.get(col.label) ?? []), col.key]);
    for (const [label, keys] of byLabel) {
      if (keys.length > 1) collisions.push(`${surface}: "${label}" → ${keys.join(", ")}`);
    }
  }
  assertEquals(
    collisions.sort(),
    [],
    "Two columns on one surface would render under the same heading:\n" + collisions.join("\n"),
  );
});

Deno.test("T9: no heading is a raw field name", () => {
  // The tell that a heading was generated rather than chosen. Every one of these
  // suffixes shipped as a live column heading: "Totals - Total Cents", "Start
  // Fs", and a bare "Fs" where `date_fs` matched a `date_*` rule and had its
  // prefix stripped. A `_cents` field is money and its heading is the noun; an
  // `_fs` field is a timestamp mirror and is not a column at all.
  const raw: string[] = [];
  for (const [keys, schema] of uniqueSchemas()) {
    for (const col of collectDisplayColumns(schema).columns) {
      if (/\b(Cents|Fs|At|Uid|Str)$/.test(col.label)) raw.push(`${keys[0]}: ${col.path} → "${col.label}"`);
    }
  }
  assertEquals(raw.sort(), [], "These headings read like field names:\n" + raw.join("\n"));
});

// ── T10: the rollup table ────────────────────────────────────────────

Deno.test("T10: every rollup key names a field its collection declares", () => {
  // The rollup table is hand-keyed, which is the one thing about it that can
  // rot: an entry naming a field the collection does not declare is a label for
  // a column that will never be offered, and it is invisible because the
  // derivation simply never looks it up.
  const dangling: string[] = [];
  for (const [alias, entries] of Object.entries(TYPESENSE_ROLLUP_COLUMNS)) {
    const config = typesenseSchemas[alias as keyof typeof typesenseSchemas];
    if (!config) {
      dangling.push(`${alias}: not a Typesense collection`);
      continue;
    }
    const declared = new Set(config.schema.fields.map((f) => f.name));
    for (const field of Object.keys(entries)) {
      if (!declared.has(field)) dangling.push(`${alias}:${field}`);
    }
  }
  assertEquals(dangling.sort(), [], "Stale rollup entries:\n" + dangling.join("\n"));
});

Deno.test("T10: no rollup shadows a column the schema already declares", () => {
  // A rollup exists because the field is computed at index time and no Firestore
  // field carries its label. If the schema declares one anyway, two sources
  // disagree about the heading and the rollup silently wins.
  const shadowed: string[] = [];
  for (const [alias, entries] of Object.entries(TYPESENSE_ROLLUP_COLUMNS)) {
    const config = typesenseSchemas[alias as keyof typeof typesenseSchemas];
    const schema = config ? schemas[config.firestoreCollection] : undefined;
    if (!schema) continue;
    const declared = new Set(collectDisplayColumns(schema).columns.map((c) => c.path));
    for (const field of Object.keys(entries)) {
      if (declared.has(field)) shadowed.push(`${alias}:${field}`);
    }
  }
  assertEquals(shadowed.sort(), [], "Rollups shadowing a declared column:\n" + shadowed.join("\n"));
});

Deno.test("T10: every rollup label is non-empty and not a raw field name", () => {
  const bad = Object.entries(TYPESENSE_ROLLUP_COLUMNS)
    .flatMap(([alias, entries]) =>
      Object.entries(entries)
        .filter(([, v]) => !v.label || /\b(Cents|Fs|At|Uid|Str)$/.test(v.label))
        .map(([field, v]) => `${alias}:${field} → "${v.label}"`)
    )
    .sort();
  assertEquals(bad, [], `Rollup headings that read like field names:\n${bad.join("\n")}`);
});

// ── T11: no column for a field the index does not carry ──────────────

Deno.test("T11: every Typesense column names a field the collection declares", () => {
  // NARROW ON PURPOSE. The general property — every declared *field* resolves
  // against the storage schema, and none is stripped on the way to the index —
  // is `typesenseFieldCoverage.test.ts`, and it would be red before this ran.
  // What is left is containment in the other direction: the derivation may only
  // offer columns the index actually carries, so annotating a Firestore field
  // cannot invent a column for a collection that does not index it.
  const invented: string[] = [];
  for (const [alias, config] of Object.entries(typesenseSchemas)) {
    const declared = new Set(config.schema.fields.map((f) => f.name));
    for (const col of getTypesenseColumns(alias)) {
      if (!declared.has(col.key)) invented.push(`${alias}: ${col.key}`);
    }
  }
  assertEquals(invented.sort(), [], "Columns for unindexed fields:\n" + invented.join("\n"));
});

// ── Fail-closed companions ───────────────────────────────────────────

Deno.test("companion: an unlabelled column is reported, not composed from its path", () => {
  // The whole design rests on labels being DECLARED. If a future edit added a
  // "fall back to startCase(path)" convenience, T9 would pass forever and the
  // generated-heading class would be back with nothing to catch it.
  const anonymous = z.strictObject({
    total_cents: z.int().meta({ column: true }),
  });
  const [col] = collectDisplayColumns(anonymous).columns;
  assertEquals(col.path, "total_cents");
  assertEquals(col.label, "", "an un-labelled column must compose to an empty heading, not a guess");
});

Deno.test("companion: T8 reports a default column nothing declares", () => {
  const declared = new Set(getTypesenseColumns("orders").map((c) => c.key));
  // The exact shape of the three stranded defaults: a real, resolvable field
  // that carries no `column: true`.
  assertEquals(declared.has("items.path"), false);
  assertEquals(declared.has("uid"), false);
});

Deno.test("companion: T10 reports a rollup naming a field the collection lacks", () => {
  const config = typesenseSchemas.orders;
  const declared = new Set(config.schema.fields.map((f) => f.name));
  assertEquals(declared.has("dates.delivery_start_fs"), true, "the real rollup must be declared");
  assertEquals(declared.has("dates.invented_fs"), false, "…and an invented one must not");
});

Deno.test("companion: T11 reports a column the index does not carry", () => {
  // `orders` annotates `totals.replacement_total_cents` and its Typesense config
  // does not declare it — the derivation must drop it rather than offer a column
  // that is empty in every row. That is the containment T11 asserts, run here
  // against the one field that exercises it.
  const schema = schemas.orders;
  const annotated = new Set(collectDisplayColumns(schema).columns.map((c) => c.path));
  assertEquals(annotated.has("totals.replacement_total_cents"), true);
  const offered = new Set(buildTypesenseColumns(schema, typesenseSchemas.orders).map((c) => c.key));
  assertEquals(
    offered.has("totals.replacement_total_cents"),
    false,
    "an annotated field the index does not carry must not become a column",
  );
});

Deno.test("companion: a shared schema annotated once yields two headings", () => {
  // The mechanic the whole label design rests on — `.meta()` CLONES, so two keys
  // holding one schema instance carry different labels and the base stays
  // unannotated. If that ever stopped being true, `destinations[].delivery` and
  // `destinations[].collection` would silently share one heading.
  const orders = getTypesenseColumns("orders");
  const label = (key: string) => orders.find((c) => c.key === key)?.label;
  assertEquals(label("destinations.delivery.address.full"), "Delivery Address");
  assertEquals(label("destinations.collection.address.full"), "Collection Address");
  // …and the shared node itself is still clean: a third site with no leg label
  // reads the bare noun.
  assertEquals(
    getFirestoreColumns("destinations").find((c) => c.key === "address.full")?.label,
    "Address",
  );
});

Deno.test("companion: an `_fs` mirror takes its heading from the field it mirrors", () => {
  // `cards:date_fs` is `dates.start` under the Timestamp encoding, and the two
  // names do not correspond — only `serverSortVia` pairs them. A reader that
  // lost that pairing would drop the column entirely (invisible), so assert the
  // heading rather than mere presence.
  const cards = getTypesenseColumns("cards");
  const dateColumn = cards.find((c) => c.key === "date_fs");
  assertEquals(dateColumn?.label, "Date");
  assertEquals(dateColumn?.cell, "date", "the mirror must render as a date, not a raw epoch");
});

Deno.test("companion: the renderer kind is derived from the type, not the key", () => {
  // T12's core claim, asserted where the derivation lives. Each of these was a
  // substring test on the column path until this landed, and the email one never
  // fired at all: in Zod 4 `z.email() instanceof z.ZodString` is FALSE, so the
  // walker that fed the picker never offered an email column to test.
  const contacts = getTypesenseColumns("contacts");
  const kind = (key: string) => contacts.find((c) => c.key === key)?.cell;
  assertEquals(kind("emails"), "email");
  assertEquals(kind("phones"), "phone");
  assertEquals(kind("name"), "link");

  const orders = getTypesenseColumns("orders");
  const orderKind = (key: string) => orders.find((c) => c.key === key)?.cell;
  assertEquals(orderKind("destinations.delivery.address.full"), "plain");
  assertEquals(orderKind("destinations.delivery.contact"), "name");
  assertEquals(orderKind("items.zero_priced"), "bool");
  assertEquals(orderKind("items.type"), "enum");
  assertEquals(orderKind("created_at"), "date");

  // An address leaf is NOT the address cell: `CellAddress` renders the whole
  // multi-line block, so routing `address.city` there printed the entire address
  // in a column headed "City".
  assertEquals(orderKind("destinations.delivery.address.city"), "plain");
});

Deno.test("companion: a 4dp rate names its unit rather than asserting rate-ness", () => {
  // `money: boolean` shipped every money mirror 100× because a boolean carries
  // no unit. `unit` must not repeat that: it names the unit.
  const unitCost = getFirestoreColumns("transactions").find((c) => c.key === "cost.unit_cost");
  assertEquals(unitCost?.label, "Unit Cost");
  assertEquals(unitCost?.meta.unit, "usd");
  // Its neighbour is cents and carries no unit key — the two sit adjacent in the
  // same object, which is exactly how the beta.117 regression happened.
  assertEquals(
    getFirestoreColumns("transactions").find((c) => c.key === "cost.amount_cents")?.meta.unit,
    undefined,
  );
});

Deno.test("companion: getServerSortableColumns reads a tag on either side of a wrapper", () => {
  // `.meta()` registers on the instance it is called on, so the two authoring
  // orders land the tag on different nodes. Both are in these schemas today, and
  // the pairing above is built on this reader — an unwrap-then-read version saw
  // only one and dropped `invoices:due_date_fs` silently.
  const invoices = getTypesenseColumns("invoices");
  assertEquals(invoices.find((c) => c.key === "date_fs")?.label, "Date");
  assertEquals(invoices.find((c) => c.key === "due_date_fs")?.label, "Due Date");
});

Deno.test("companion: collectDisplayColumns still fails closed on an unknown node", () => {
  // `unhandled` is what arm 0 asserts is empty; prove it can still be non-empty.
  const withTuple = z.strictObject({ pair: z.tuple([z.string(), z.string()]) });
  assertEquals(collectDisplayColumns(withTuple).unhandled.length, 1);
  assertEquals(collectDisplayColumns(withTuple).unhandled[0].path, "pair");
});

Deno.test("companion: an unknown collection offers nothing rather than throwing", () => {
  assertEquals(getTypesenseColumns("not-a-collection"), []);
  assertEquals(getFirestoreColumns("not-a-collection"), []);
});
