/**
 * Which fields does a downstream document SHARE with its order, and how does each
 * one propagate?
 *
 * The order → invoice / fulfillment sync is moving to one per-field rule
 * (api-cloudrun#890, api-cloudrun#989):
 *
 * ```
 * downstream' = isEqual(downstream, prevOrder) ? nextOrder : downstream
 * ```
 *
 * followed by re-running the derivations on the downstream document. Applying that
 * rule needs to know, for every field, which of four structural cases it is in.
 * This module answers that from the two Zod schemas, so there is no hand-maintained
 * field list to drift (see the plan's "Is a hand-maintained field list a
 * mistake?").
 *
 * | kind | what it is | how the merge treats it |
 * |---|---|---|
 * | `propagated` | a value both documents carry with the same meaning | the three-way rule |
 * | `derived` | written by a derivation (`priceDocument`, `getDuration`, the `_fs` mirrors) | skipped, then recomputed |
 * | `homonym` | same key, different meaning (`status`, `xero_id`, …) | skipped |
 * | `atom` | a snapshot of another document (an object carrying its own `uid`) | the three-way rule, on the WHOLE object |
 *
 * Plus two structural containers the merge descends rather than compares:
 *
 * - **rows** — an array whose element carries a `uid` (`items[]`, `destinations[]`).
 *   Rows are matched by identity first. `uid` and `path` inside a row are its
 *   IDENTITY, not values, so they are not reported.
 * - **value objects** — an object with no `uid` (`dates`, `price`, `discount`).
 *   Recursed into, leaf by leaf.
 *
 * A key present on only one schema is not reported at all. "Not in the order
 * schema" IS the definition of downstream-only.
 *
 * ## Where the kinds come from
 *
 * `derived` and `homonym` are DECLARED on the schema field, as
 * `.meta({ derived: true })` and `.meta({ propagate: false })`. A tag on either
 * schema counts. `atom` and the containers are read from the shape.
 *
 * ⚠️ **`propagate: false` has the unsafe default** — an untagged new homonym is
 * reported `propagated`. The guard is the snapshot of this function's output in
 * `tests/shared-fields.test.ts`: a new shared key at any level fails it until
 * someone looks.
 *
 * ## It fails closed
 *
 * A node type the walker does not recognise is reported in `unhandled` rather than
 * guessed at. Callers assert it is empty.
 *
 * @module
 */
import type { z } from "zod";
import { FulfillmentSchema, OrderSchema } from "../schemas/mod.ts";
import { readMetaThroughWrappers } from "../schemas/zod-walk.ts";

/** How one shared field propagates — see the module docs. */
export type SharedFieldKind = "propagated" | "derived" | "homonym" | "atom";

/** One shared field. */
export interface SharedField {
  /** Dotted path with `[]` crossing a row array: `items[].price.discount.rate`. */
  path: string;
  kind: SharedFieldKind;
}

/** Result of {@link classifySharedFields}. */
export interface SharedFieldClassification {
  /** Every shared field, in schema declaration order (source schema's order). */
  fields: SharedField[];
  /**
   * Row arrays, which the merge matches by identity and then descends into.
   * Reported so a caller can assert it knows how to match each one.
   */
  rows: string[];
  /** Nodes the walker refused to interpret. MUST be empty for the rest to be sound. */
  unhandled: Array<{ path: string; type: string }>;
}

/** The meta key that marks a field as written by a derivation. */
export const DERIVED_META_KEY = "derived";
/** The meta key that marks a homonym: `.meta({ propagate: false })`. */
export const PROPAGATE_META_KEY = "propagate";

/** Keys that identify a row rather than describing it. */
const ROW_IDENTITY_KEYS: ReadonlySet<string> = new Set(["uid", "path"]);

interface Def {
  type: string;
  innerType?: z.ZodType;
  element?: z.ZodType;
  shape?: Record<string, z.ZodType>;
  options?: z.ZodType[];
  in?: z.ZodType;
}
const defOf = (node: z.ZodType): Def => (node as unknown as { _zod: { def: Def } })._zod.def;

/** Wrappers that do not change a node's shape. Matches `zod-walk.ts`. */
const WRAPPERS: ReadonlySet<string> = new Set([
  "optional",
  "default",
  "nullable",
  "prefault",
  "catch",
  "readonly",
  "nonoptional",
]);

/** Scalar node types — compared as values. */
const SCALARS: ReadonlySet<string> = new Set([
  "string",
  "number",
  "int",
  "boolean",
  "enum",
  "literal",
  "template_literal",
  "custom",
  "unknown",
  "any",
  "null",
  "date",
  "bigint",
]);

/**
 * What a node IS once wrappers are stripped. A union of objects merges its
 * members' shapes (a key present on any member counts), because the items array
 * is a union over line and divider types and the merge works per key.
 *
 * A `pipe` is a scalar here: every pipe in core is a transform over a string
 * (`chicagoInstant()` and friends), and its input side is what is stored.
 */
type Resolved =
  | { kind: "scalar" }
  | { kind: "object"; shape: Map<string, z.ZodType[]> }
  | { kind: "array"; element: z.ZodType[] }
  | { kind: "unhandled"; type: string };

function resolve(nodes: readonly z.ZodType[]): Resolved {
  const flat: z.ZodType[] = [];
  const stack = [...nodes];
  while (stack.length) {
    const n = stack.pop()!;
    const def = defOf(n);
    if (WRAPPERS.has(def.type) && def.innerType) stack.push(def.innerType);
    else if (def.type === "union" && def.options) stack.push(...def.options);
    else flat.push(n);
  }

  const types = new Set(flat.map((n) => defOf(n).type));
  // `null` inside a union is how `nullable` is sometimes spelled; it adds no shape.
  types.delete("null");
  const members = flat.filter((n) => defOf(n).type !== "null");

  if (types.size === 0) return { kind: "scalar" };
  if ([...types].every((t) => SCALARS.has(t) || t === "pipe")) return { kind: "scalar" };
  if (types.size === 1 && types.has("object")) {
    const shape = new Map<string, z.ZodType[]>();
    for (const m of members) {
      for (const [k, v] of Object.entries(defOf(m).shape ?? {})) {
        const list = shape.get(k) ?? [];
        list.push(v);
        shape.set(k, list);
      }
    }
    return { kind: "object", shape };
  }
  if (types.size === 1 && types.has("array")) {
    return { kind: "array", element: members.map((m) => defOf(m).element!).filter(Boolean) };
  }
  return { kind: "unhandled", type: [...types].sort().join("|") };
}

const metaOf = (nodes: readonly z.ZodType[], key: string): unknown => {
  for (const n of nodes) {
    const v = readMetaThroughWrappers<unknown>(n, key);
    if (v !== undefined) return v;
  }
  return undefined;
};

/**
 * Classify every field `source` (the order) shares with `downstream` (an invoice
 * or a fulfillment). See the module docs for the kinds.
 *
 * Pure and deterministic, and cheap enough to call per sync, but callers should
 * compute it once per schema pair.
 */
export function classifySharedFields(
  source: z.ZodType,
  downstream: z.ZodType,
): SharedFieldClassification {
  const fields: SharedField[] = [];
  const rows: string[] = [];
  const unhandled: Array<{ path: string; type: string }> = [];

  const join = (base: string, key: string) => (base ? `${base}.${key}` : key);

  /** Walk two object shapes at one path. `inRow` drops the row identity keys. */
  function walkObject(
    a: Map<string, z.ZodType[]>,
    b: Map<string, z.ZodType[]>,
    base: string,
    inRow: boolean,
  ): void {
    for (const [key, aNodes] of a) {
      const bNodes = b.get(key);
      if (!bNodes) continue;
      if (inRow && ROW_IDENTITY_KEYS.has(key)) continue;
      walkField([...aNodes], [...bNodes], join(base, key));
    }
  }

  function walkField(aNodes: z.ZodType[], bNodes: z.ZodType[], path: string): void {
    const both = [...aNodes, ...bNodes];
    if (metaOf(both, PROPAGATE_META_KEY) === false) {
      fields.push({ path, kind: "homonym" });
      return;
    }
    if (metaOf(both, DERIVED_META_KEY) === true) {
      fields.push({ path, kind: "derived" });
      return;
    }

    const ra = resolve(aNodes);
    const rb = resolve(bNodes);
    if (ra.kind === "unhandled" || rb.kind === "unhandled") {
      unhandled.push({ path, type: ra.kind === "unhandled" ? ra.type : (rb as { type: string }).type });
      return;
    }
    if (ra.kind === "scalar" && rb.kind === "scalar") {
      fields.push({ path, kind: "propagated" });
      return;
    }
    if (ra.kind === "object" && rb.kind === "object") {
      // A snapshot of another document is taken whole: leaf by leaf would build
      // a chimera — another org's uid beside this org's tax axes.
      if (ra.shape.has("uid") && rb.shape.has("uid")) {
        fields.push({ path, kind: "atom" });
        return;
      }
      walkObject(ra.shape, rb.shape, path, false);
      return;
    }
    if (ra.kind === "array" && rb.kind === "array") {
      const ea = resolve(ra.element);
      const eb = resolve(rb.element);
      if (ea.kind === "object" && eb.kind === "object" && ea.shape.has("uid") && eb.shape.has("uid")) {
        rows.push(`${path}[]`);
        walkObject(ea.shape, eb.shape, `${path}[]`, true);
        return;
      }
      if (ea.kind === "scalar" && eb.kind === "scalar") {
        // An array of scalars (`path`, a tag list) is one value.
        fields.push({ path, kind: "propagated" });
        return;
      }
      unhandled.push({ path: `${path}[]`, type: `array of ${ea.kind}/${eb.kind}` });
      return;
    }
    unhandled.push({ path, type: `${ra.kind} vs ${rb.kind}` });
  }

  const ra = resolve([source]);
  const rb = resolve([downstream]);
  if (ra.kind !== "object" || rb.kind !== "object") {
    unhandled.push({ path: "", type: `${ra.kind} vs ${rb.kind}` });
  } else {
    walkObject(ra.shape, rb.shape, "", false);
  }
  return { fields, rows, unhandled };
}

/**
 * The fields of one row (or of the document itself), relative to it.
 *
 * `fieldsUnder(c, "items[]")` gives `name`, `price.base_cents`, … — the unit
 * {@link mergeSharedFields} merges one matched row with. `fieldsUnder(c, "")`
 * gives the document-level fields and excludes everything inside a row, because
 * rows are matched by identity before their fields are merged.
 */
export function fieldsUnder(c: SharedFieldClassification, row: string): SharedField[] {
  if (row === "") {
    return c.fields.filter((f) => !f.path.includes("[]"));
  }
  const prefix = `${row}.`;
  return c.fields
    .filter((f) => f.path.startsWith(prefix) && !f.path.slice(prefix.length).includes("[]"))
    .map((f) => ({ path: f.path.slice(prefix.length), kind: f.kind }));
}

// ── The three-way merge ─────────────────────────────────────────────────────

/** Result of {@link mergeSharedFields}. */
export interface SharedFieldMerge<T> {
  /** The downstream value with every propagating field resolved. */
  merged: T;
  /**
   * Fields where the downstream value differed from the PREVIOUS source value, so
   * it was kept. These are the overrides the manager shows as a diff. Sorted.
   */
  overridden: string[];
}

/** Absent ≡ null, recursively — two values that say the same thing compare equal. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || value === undefined) return null;
  if (typeof value !== "object") return value;
  // A Firestore Timestamp (or anything with its own representation) compares by
  // its seconds/nanoseconds, which Object.keys reaches, so no special case.
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const v = (value as Record<string, unknown>)[key];
    if (v === null || v === undefined) continue;
    out[key] = canonical(v);
  }
  return out;
}

/** Do two values state the same thing? Absent and `null` are the same statement. */
export function sameSharedValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Apply the three-way rule to every propagating field of ONE matched row or
 * document:
 *
 * ```
 * merged.F = sameSharedValue(downstream.F, prev.F) ? next.F : downstream.F
 * ```
 *
 * 🔴 **All three arguments must already be in the DOWNSTREAM document's shape.**
 * Project the order's previous and next row first (`projectOrderItemToInvoiceItem`,
 * `toInvoiceDestinationPair`). Comparing an order-shaped row against an
 * invoice-shaped one is how every paired line once read as out of sync on
 * `stock_method` alone (core#52): a key one shape carries and the other never can
 * is not an override.
 *
 * What it does NOT touch, by construction:
 * - `derived` fields — left as `downstream` has them. The caller re-runs the
 *   derivation afterwards (`priceDocument`, the day count), which is what stops an
 *   invoice's own tax context reading as an override (G2).
 * - `homonym` fields, and every key the classification does not name (the
 *   downstream document's own fields: `xero_id`, `quantity_order`, …).
 *
 * `atom` fields (another document's snapshot) are taken or kept WHOLE.
 *
 * ⚠️ **A null parent collapses its children into one unit.** If a value object
 * (`price.discount`) is `null` or absent on any of the three sides, its fields
 * cannot be merged one by one — there is nothing to write a `rate` into — so the
 * rule runs once on the whole object instead. An operator who removed a discount
 * the order still has keeps `null`; an order that removes one reaches an
 * unedited row.
 *
 * Pure: returns a new value, never mutates its arguments.
 */
export function mergeSharedFields<T>(
  fields: readonly SharedField[],
  prev: T,
  next: T,
  downstream: T,
): SharedFieldMerge<T> {
  const merged = copyPlain(downstream) as Record<string, unknown>;
  const overridden = new Set<string>();
  const done = new Set<string>();

  const at = (root: unknown, segs: readonly string[]): unknown => {
    let v: unknown = root;
    for (const s of segs) {
      if (!isPlainObject(v)) return undefined;
      v = v[s];
    }
    return v;
  };

  for (const field of fields) {
    if (field.kind === "derived" || field.kind === "homonym") continue;
    const segs = field.path.split(".");

    // Collapse to the shallowest ancestor that is not an object on some side.
    let unit = segs.length;
    for (let i = 1; i < segs.length; i++) {
      const parent = segs.slice(0, i);
      if (
        !isPlainObject(at(prev, parent)) || !isPlainObject(at(next, parent)) ||
        !isPlainObject(at(downstream, parent))
      ) {
        unit = i;
        break;
      }
    }
    const unitSegs = segs.slice(0, unit);
    const unitPath = unitSegs.join(".");
    if (done.has(unitPath)) continue;
    done.add(unitPath);

    const d = at(downstream, unitSegs);
    if (!sameSharedValue(d, at(prev, unitSegs))) {
      overridden.add(unitPath);
      continue;
    }
    const n = at(next, unitSegs);
    // Already says the same thing: keep the downstream's own spelling. Writing
    // `null` over an absent key changes nothing it states and widens the stored
    // key set — which, on an invoice line, is what re-pushes it to Xero.
    if (sameSharedValue(d, n)) continue;
    // The parent exists on all three sides (that is what the collapse ensured),
    // so it exists on `merged`, which is a copy of `downstream`.
    const parent = unitSegs.slice(0, -1).reduce<Record<string, unknown>>(
      (o, s) => o[s] as Record<string, unknown>,
      merged,
    );
    const key = unitSegs[unitSegs.length - 1];
    if (n === undefined) delete parent[key];
    else parent[key] = copyPlain(n);
  }

  return { merged: merged as T, overridden: [...overridden].sort() };
}

// ── The order → fulfillment schema pair (api-cloudrun#989) ──────────────────

/**
 * The fields an order shares with its fulfillment, split by the unit the merge
 * runs on. Read from the two schemas by {@link classifySharedFields}, so there
 * is no field list here to drift.
 *
 * The invoice sibling is `orderInvoiceSharedFields` in `utils/invoices.ts`.
 * This one lives here rather than in a `utils/fulfillments.ts` sibling because
 * that module is the template-helper namespace for `it.fulfillments` — every
 * export in it becomes a helper a template can call, and a schema-pair
 * classifier is a write-path concern with no document to render.
 */
export interface OrderFulfillmentSharedFields {
  /** One `items[]` row, paths relative to the row. */
  line: readonly SharedField[];
  /** One `destinations[]` pair, paths relative to the pair. */
  pair: readonly SharedField[];
  /** The document itself, every row excluded. */
  doc: readonly SharedField[];
}

let orderFulfillmentSharedFieldsMemo: OrderFulfillmentSharedFields | undefined;

/**
 * {@link OrderFulfillmentSharedFields}, classified once per process.
 *
 * ⭐ **Simpler than the invoice pair, and the schema is why.**
 * `Fulfillment.destinations` is `z.array(DocDestination)` — the ORDER's own pair
 * schema — so all three arguments to {@link mergeSharedFields} are already in
 * the downstream shape and there is no `toInvoiceDestinationPair` analogue to
 * write, and no `uid_order` to key on. Pairs match on `pair.uid` alone.
 *
 * ⚠️ **`number` and `status` classify as `homonym` and the merge therefore skips
 * them, which is correct and is NOT the whole story.** On a fulfillment both are
 * genuine copies of the order's — the uid IS the order's uid, the number IS the
 * order's number, and `FulfillmentSchema` reuses `ORDER_STATUSES` for exactly
 * that reason. They stay on the caller's unconditional-copy list; the tag says
 * "not a propagated VALUE", not "leave it stale".
 *
 * @throws Error when the classification reports a node it could not interpret —
 *   the merge would otherwise silently skip that field.
 */
export function orderFulfillmentSharedFields(): OrderFulfillmentSharedFields {
  if (orderFulfillmentSharedFieldsMemo) return orderFulfillmentSharedFieldsMemo;
  const c = classifySharedFields(OrderSchema, FulfillmentSchema);
  if (c.unhandled.length > 0) {
    throw new Error(`order → fulfillment shared fields unclassified: ${JSON.stringify(c.unhandled)}`);
  }
  orderFulfillmentSharedFieldsMemo = {
    line: fieldsUnder(c, "items[]"),
    pair: fieldsUnder(c, "destinations[]"),
    doc: fieldsUnder(c, ""),
  };
  return orderFulfillmentSharedFieldsMemo;
}

/**
 * Deep copy that keeps class instances (a Firestore `Timestamp`) by reference.
 *
 * ⚠️ Not `structuredClone`: it drops the prototype, so a `Timestamp` becomes a
 * plain `{ _seconds, _nanoseconds }` map and is written back to Firestore as one.
 * Only plain objects and arrays are copied; everything else is shared, which is
 * safe because nothing here mutates a leaf.
 */
function copyPlain(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(copyPlain);
  if (value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = copyPlain(v);
    return out;
  }
  return value;
}
