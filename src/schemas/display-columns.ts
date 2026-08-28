/**
 * Table columns, **declared** rather than generated.
 *
 * Before this module the manager built its column universe by enumerating a
 * schema — ~375 columns across 14 live table surfaces, none of them chosen by
 * anyone. Because the universe was generated, every column also needed a
 * *generated heading* (structural regexes over the dotted path) and a
 * *generated renderer choice* (substring tests on the same path). Both are
 * string heuristics over schema-derived names, so both drifted on every rename:
 * the cents migration turned "Total" into **"Totals - Total Cents"**, `date_fs`
 * degenerated to the heading **"Fs"**, and `key.includes("cost")` routed a 4dp
 * rate through a 2dp money formatter and printed $0.0639/unit as **`$0.00`**.
 *
 * So the schema now says which fields are columns and what they are called, and
 * this module reads that. `column: true` is **opt-in**: a new field cannot
 * silently surface a broken column, and a rename carries its annotation with it.
 *
 * Two consumers, one annotation: the manager's `TypesenseTable` (search-index
 * rows) and its `FirestoreTable` (document rows). Typesense *mirrors* Firestore
 * — every indexed field is derived from a Firestore field by api-cloudrun's
 * `typesenseTranslate` — so both families resolve to the same Zod paths, and
 * nothing here touches a Typesense field definition (which would change the
 * collection's schema hash and force a full reindex on every heading edit).
 *
 * @module
 */
import type { z } from "zod";
import { collectDisplayColumns, getServerSortableColumns, isDateLikeNode } from "./zod-walk.ts";
import type { TypesenseCollectionConfig } from "./typesense/types.ts";

interface NodeInternals {
  _zod: { def: { type: string; format?: string; shape?: Record<string, z.ZodType>; in?: z.ZodType } };
}

/** Follow `def.in` to the input side of a `.transform()` pipe. */
function unwrapPipes(node: z.ZodType): NodeInternals {
  let n = node as unknown as NodeInternals;
  while (n._zod.def.type === "pipe" && n._zod.def.in) {
    n = n._zod.def.in as unknown as NodeInternals;
  }
  return n;
}

/**
 * How a cell should render a column's value, derived from the annotated node's
 * *type* rather than from its name.
 *
 * The predecessor guessed from the path — `includes("email")`, `includes("phone")`,
 * `includes("address")` — which is why `z.email()` fields never got a `mailto:`
 * (in Zod 4 `z.email() instanceof z.ZodString` is **false**, so the walker that
 * fed the picker never even offered them) and why a column named `city` under an
 * `address` parent rendered the whole multi-line block.
 *
 * `plain` is the honest default: money and rate formatting is decided by the
 * cell from the storage convention (`*_cents`) and the `unit` annotation, both
 * of which are value-level facts a column kind cannot carry.
 */
export type CellKind =
  | "link"
  | "email"
  | "phone"
  | "date"
  | "address"
  | "name"
  | "bool"
  | "enum"
  | "plain";

/** A column offered to a table surface. */
export interface DisplayTableColumn {
  /** The path **as the row carries it** — the Typesense field name for an index
   *  row, the Firestore document path for a document row. See {@link FS_MIRROR_SUFFIX}. */
  key: string;
  /** Composed heading. */
  label: string;
  /** Can this column drive a sort at all (Typesense `sort: true` / any Firestore field)? */
  sortable: boolean;
  /** Present when clicking the column can drive a server-side Firestore
   *  `orderBy`; names the field to order by (often an `_fs` mirror). */
  serverSort?: { field: string };
  /** How to render it. */
  cell: CellKind;
  /** The annotation's own meta — carries `unit`, `linkTo`, … */
  meta: Record<string, unknown>;
}

/**
 * A **Firestore-timestamp mirror** is the same column as the field it mirrors.
 *
 * `dates.start_fs` is `dates.start` in `Timestamp` form: one value, two
 * encodings, written by the same writer. Typesense indexes the mirror because
 * it sorts and range-filters on `int64` — `cards` says so in its own config
 * comment, and deliberately does not index the ISO string at all — while a
 * Firestore surface reads the ISO field. So the same logical column arrives
 * under two names depending on the table family, and the annotation lives on
 * the **ISO field only**; annotating both would mint two columns with one
 * heading.
 *
 * The pairing is **declared, not spelled**: `.meta({ serverSortVia })` already
 * names the stored field a display field is ordered by, and that field is
 * exactly the mirror. Inverting that map is why `cards:date_fs` resolves to
 * `dates.start` — a suffix rule could not, because the two names do not
 * correspond.
 */
function mirrorSources(schema: z.ZodType): Map<string, string> {
  const out = new Map<string, string>();
  for (const [display, stored] of Object.entries(getServerSortableColumns(schema))) {
    if (stored !== display) out.set(stored, display);
  }
  return out;
}

/**
 * Typesense fields **computed at index time**, which therefore have no Firestore
 * field to hang a label on.
 *
 * Keyed `"<alias>:<field>"`, exactly like `DERIVED_FIELDS` in
 * `tests/typesenseFieldCoverage.test.ts` — and pinned against the real configs
 * by `tests/display-columns.test.ts`, so an entry naming a field the collection
 * does not declare fails rather than sitting here as a column that renders
 * nothing.
 *
 * The root `dates.*` envelope is here because **Typesense cannot sort or filter
 * on a value inside an array**: orders and fulfillments stopped persisting a
 * top-level `dates`, and `deriveOrderDateEnvelope` synthesizes a flat min/max
 * across `destinations[]` purely so the index has something to order by.
 * `deliveries` / `pickups` / `has_conflicts` are `postProcess` predicates over
 * the same array.
 *
 * **`_str` mirrors never appear here.** They are search mirrors that let a
 * number be *found* as text — `facet: false, sort: false` by construction — not
 * display columns. Under an opt-in model they are excluded by simply never
 * being annotated, so no suffix rule is needed anywhere.
 */
export const TYPESENSE_ROLLUP_COLUMNS: Record<
  string,
  Record<string, { label: string; cell: CellKind }>
> = {
  orders: {
    deliveries: { label: "Deliveries", cell: "bool" },
    pickups: { label: "Pickups", cell: "bool" },
    "dates.delivery_start_fs": { label: "Delivery Start", cell: "date" },
    "dates.delivery_end_fs": { label: "Delivery End", cell: "date" },
    "dates.collection_start_fs": { label: "Collection Start", cell: "date" },
    "dates.collection_end_fs": { label: "Collection End", cell: "date" },
    "dates.charge_start_fs": { label: "Charge Start", cell: "date" },
    "dates.charge_end_fs": { label: "Charge End", cell: "date" },
    "dates.days_active": { label: "Days Active", cell: "plain" },
    "dates.days_charged": { label: "Days Charged", cell: "plain" },
  },
  // The THIRD key. `level` has no Firestore field to hang a label on — it is
  // `ORG_LEVELS[path.length - 1]`, derived at index time because Typesense
  // cannot facet on an array's length and there is no stored `level` to
  // annotate. See `schemas/typesense/organizations.ts`.
  organizations: {
    level: { label: "Level", cell: "plain" },
  },
  fulfillments: {
    deliveries: { label: "Deliveries", cell: "bool" },
    pickups: { label: "Pickups", cell: "bool" },
    has_conflicts: { label: "Conflicts", cell: "bool" },
    "dates.delivery_start_fs": { label: "Delivery Start", cell: "date" },
    "dates.delivery_end_fs": { label: "Delivery End", cell: "date" },
    "dates.collection_start_fs": { label: "Collection Start", cell: "date" },
    "dates.collection_end_fs": { label: "Collection End", cell: "date" },
    "dates.charge_start_fs": { label: "Charge Start", cell: "date" },
    "dates.charge_end_fs": { label: "Charge End", cell: "date" },
  },
};

/** Object shapes the renderer treats as a whole rather than field by field. */
const ADDRESS_MARKERS = ["full", "postcode", "city"] as const;

function shapeOf(node: z.ZodType): Record<string, z.ZodType> | null {
  return unwrapPipes(node)._zod.def.shape ?? null;
}

/**
 * Which cell renders this column, from the annotated node's type.
 *
 * Object-valued columns are classified by **shape**, not by name: an address is
 * an object carrying `full` + `postcode` + `city`, a person is an object
 * carrying `first_name` or `name`. Shape survives a rename of the key; the
 * `includes("address")` test it replaces did not, and could not tell
 * `address.city` from `address.full`.
 *
 * An explicit `.meta({ cell })` wins, and exists for exactly one case: a phone
 * number is a `z.string()` with a regex, indistinguishable from any other string
 * to Zod. It is declared **once, on the shared `Phone` schema**, not per column
 * — which is the difference between a declaration and the `includes("phone")`
 * test it replaces.
 */
function cellKindFor(node: z.ZodType, meta: Record<string, unknown>): CellKind {
  if (typeof meta.cell === "string") return meta.cell as CellKind;
  if (typeof meta.linkTo === "string") return "link";
  // Through the pipe: a Chicago-canonicalized datetime is a `ZodPipe` whose
  // input side holds the real type, and `isDateLikeNode` is the one reader that
  // already knows that (plus the `FirestoreTimestamp` custom type).
  if (isDateLikeNode(node)) return "date";
  const def = unwrapPipes(node)._zod.def;
  if (def.format === "email") return "email";
  if (def.type === "boolean") return "bool";
  if (def.type === "enum") return "enum";
  if (def.type === "object") {
    const shape = shapeOf(node);
    if (shape) {
      if (ADDRESS_MARKERS.every((k) => k in shape)) return "address";
      if ("first_name" in shape || "name" in shape) return "name";
    }
  }
  return "plain";
}

/**
 * Columns for a Firestore document surface — every annotated path, as stored.
 *
 * `serverSort` comes from the schema's existing `.meta({ serverSortVia })`
 * annotations, so a column is clickable-to-sort exactly when a composite index
 * backs it.
 */
export function buildFirestoreColumns(schema: z.ZodType): DisplayTableColumn[] {
  const { columns } = collectDisplayColumns(schema);
  const sortMap = getServerSortableColumns(schema);
  return columns.map((col) => {
    const field = sortMap[col.path];
    return {
      key: col.path,
      label: col.label,
      sortable: true,
      ...(field ? { serverSort: { field } } : {}),
      cell: cellKindFor(col.node, col.meta),
      meta: col.meta,
    };
  });
}

/**
 * Columns for a Typesense surface — the annotated set **intersected with what
 * the collection actually indexes**, plus its computed rollups.
 *
 * The intersection is the point: annotating a field says "this is displayable",
 * not "every index carries it". `invoices` indexes a fraction of an Invoice, and
 * offering the rest would produce columns that are empty in every row.
 */
export function buildTypesenseColumns(
  schema: z.ZodType,
  config: TypesenseCollectionConfig,
): DisplayTableColumn[] {
  const declared = new Map(
    collectDisplayColumns(schema).columns.map((c) => [c.path, c] as const),
  );
  const mirrors = mirrorSources(schema);
  const rollups = TYPESENSE_ROLLUP_COLUMNS[config.alias] ?? {};
  const out: DisplayTableColumn[] = [];

  for (const field of config.schema.fields) {
    const rollup = rollups[field.name];
    if (rollup) {
      out.push({
        key: field.name,
        label: rollup.label,
        sortable: field.sort === true,
        cell: rollup.cell,
        meta: {},
      });
      continue;
    }
    const mirrored = mirrors.get(field.name);
    const col = declared.get(field.name) ?? (mirrored ? declared.get(mirrored) : undefined);
    if (!col) continue;
    out.push({
      key: field.name,
      label: col.label,
      sortable: field.sort === true,
      cell: cellKindFor(col.node, col.meta),
      meta: col.meta,
    });
  }
  return out;
}
