/**
 * Type definitions for Typesense collection schemas.
 */
import { z } from "zod";

const TYPESENSE_FIELD_TYPES = [
  "string", "string[]",
  "int32", "int32[]",
  "int64", "int64[]",
  "float", "float[]",
  "bool", "bool[]",
  "object", "object[]",
  "geopoint", "geopoint[]",
] as const;

/** Field type in a Typesense collection schema. */
export type TypesenseFieldType = typeof TYPESENSE_FIELD_TYPES[number];

/** Zod schema for TypesenseFieldType. */
export const TypesenseFieldTypeEnum: z.ZodType<TypesenseFieldType> =
  z.enum(TYPESENSE_FIELD_TYPES);

/** A single field definition in a Typesense collection schema. */
export interface TypesenseField {
  name: string;
  type: TypesenseFieldType;
  sort?: boolean;
  stem?: boolean;
  facet?: boolean;
  index?: boolean;
  optional?: boolean;
  /**
   * This numeric field carries **money as an integer count of cents**, so its
   * `_str` search mirror must be rendered rather than stringified.
   *
   * `addStringMirrors` writes `String(value)`, which is right for an identifier
   * and catastrophic for cents: a `$1,500.00` total is stored as the int64
   * `150000` and would mirror as `"150000"` — an operator searching `1500.00`
   * matches nothing, and typo tolerance offers unrelated numbers instead. Even
   * before the cents migration this was wrong in a subtler way: the float
   * `1500` mirrored as `"1500"`, the query `1500.00` tokenized to `1500` + `00`,
   * and the index handed back **$15,000 and $10,000** — measured against the
   * live index 2026-08-01.
   *
   * ⚠️ **The contract INVERTED with Phase 11 and this is the load-bearing
   * sentence.** The mirror renderer used to take dollars and format them;
   * `moneyMirrorString` now takes **cents** and formats them, with no
   * `toCents` step. A surviving dollars-taking copy of that expression renders
   * every money mirror 100× while the index imports perfectly cleanly and
   * nothing errors — which is why the expression was hoisted into exactly one
   * file (`src/lib/moneyMirrorString.ts` in api-cloudrun) and pinned there by
   * Ratchet G before this flag's meaning changed.
   *
   * A money mirror renders at 2dp, the precision money is denominated in.
   * **4dp would be worse, not merely redundant**: `"1500.0000"` tokenizes to
   * `1500` + `0000`, and matching `00` against `0000` costs two edits, exactly
   * the default `num_typos` boundary.
   *
   * **Not for rates.** `Discount.rate`, `TaxRef.rate`, `cost.unit_cost` and
   * `average_unit_cost` are `float` and sit right beside the `int64` amounts,
   * but a rate is not money — it holds 4dp to match Xero's `DiscountRate`, and
   * nobody searches for one. Marking a rate here would coarsen it in the mirror
   * and buy nothing; worse, a rate is NOT in cents, so the renderer would
   * divide it by 100.
   *
   * The numeric field still owns every facet, sort and range filter; the mirror
   * is purely a `query_by` text target and is always `facet: false, sort: false`
   * — faceting formatted text buckets by string, and range-filtering it compares
   * lexically.
   */
  money?: boolean;
}

/** Zod schema for TypesenseField. */
export const TypesenseFieldSchema: z.ZodType<TypesenseField> = z.strictObject({
  name: z.string(),
  type: TypesenseFieldTypeEnum,
  sort: z.boolean().optional(),
  stem: z.boolean().optional(),
  facet: z.boolean().optional(),
  index: z.boolean().optional(),
  optional: z.boolean().optional(),
  money: z.boolean().optional(),
});

/**
 * Field keys that are **CFS annotations, not Typesense field properties**, and
 * must be stripped before the schema reaches the collections API.
 *
 * `sort`, `stem`, `facet`, `index` and `optional` are all real Typesense
 * properties and pass through. `money` is not — it instructs *our* `_str` mirror
 * builder and means nothing to the search engine.
 */
const CFS_ONLY_FIELD_KEYS = ["money"] as const;

/**
 * Prefix marking a **Firestore reverse-index mirror** — a denormalized flat
 * array (`query_by_sources`, `query_by_components`, …) that exists purely so
 * Firestore can `array-contains` a value it cannot reach inside an object array.
 *
 * Typesense CAN query inside a nested array, so the mirror is redundant there
 * and is deleted from every document on the way to the index.
 */
export const QUERY_BY_PREFIX = "query_by_";

/**
 * Is this document key / declared field name removed before it reaches the
 * index?
 *
 * **This is the single source of truth for that rule**, imported by BOTH sides:
 * api-cloudrun's `deleteQueryByFields` (`lib/typesenseTranslate.ts`), which
 * performs the strip, and `tests/typesenseFieldCoverage.test.ts`, which fails
 * when a collection declares a field the strip would remove. A restated copy in
 * either place is a rule that can drift into blessing exactly the declarations
 * it exists to forbid — and it did: six `query_by_*` fields were declared across
 * five collections, four of them `facet: true`, and none ever held a value.
 *
 * **Top-level keys only, matching the strip.** `deleteQueryByFields` iterates
 * `Object.keys(doc)`, so a nested `sources.query_by_x` survives; a predicate
 * that tested the whole dotted name would be stricter than the code it stands
 * in for and would reject a legal declaration.
 */
export function isStrippedAtIndexTime(fieldName: string): boolean {
  return fieldName.split(".")[0].startsWith(QUERY_BY_PREFIX);
}

/**
 * The wire form of a collection schema — what actually gets POSTed to
 * `collections`.
 *
 * A CFS annotation left on a field would be sent to Typesense as if it were a
 * field property. Call this at the one place the create-collection body is
 * built; everywhere else wants the annotated schema.
 *
 * **Deliberately not used for the reindex schema hash.** The hash covers the
 * full annotated schema, so adding or removing a `money` marker changes it and
 * forces a reindex — which is exactly right, because the marker changes what
 * every `_str` mirror in that collection contains. A hash over the wire form
 * would call the change a no-op and leave a stale index that no dollar-amount
 * query could reach.
 */
export function toWireSchema(schema: TypesenseSchema): TypesenseSchema {
  return {
    ...schema,
    fields: schema.fields.map((field) => {
      const wire: Record<string, unknown> = { ...field };
      for (const key of CFS_ONLY_FIELD_KEYS) delete wire[key];
      return wire as unknown as TypesenseField;
    }),
  };
}

/** The schema portion passed to the Typesense collections API. */
export interface TypesenseSchema {
  name: string;
  enable_nested_fields?: boolean;
  token_separators?: string[];
  fields: TypesenseField[];
  default_sorting_field?: string;
}

/** Zod schema for TypesenseSchema. */
export const TypesenseSchemaSchema: z.ZodType<TypesenseSchema> = z.strictObject({
  name: z.string(),
  enable_nested_fields: z.boolean().optional(),
  token_separators: z.array(z.string()).optional(),
  fields: z.array(TypesenseFieldSchema),
  default_sorting_field: z.string().optional(),
});

/** A multi-way synonym where all terms are interchangeable. */
export interface TypesenseMultiWaySynonym {
  id: string;
  synonyms: string[];
}

/** A one-way synonym where a root term expands to alternatives. */
export interface TypesenseOneWaySynonym {
  id: string;
  root: string;
  synonyms: string[];
}

/** A synonym rule for a Typesense collection. */
export type TypesenseSynonym = TypesenseMultiWaySynonym | TypesenseOneWaySynonym;

/** Zod schema for TypesenseMultiWaySynonym. */
export const TypesenseMultiWaySynonymSchema: z.ZodType<TypesenseMultiWaySynonym> = z.strictObject({
  id: z.string(),
  synonyms: z.array(z.string()).min(2),
});

/** Zod schema for TypesenseOneWaySynonym. */
export const TypesenseOneWaySynonymSchema: z.ZodType<TypesenseOneWaySynonym> = z.strictObject({
  id: z.string(),
  root: z.string(),
  synonyms: z.array(z.string()).min(1),
});

/** Zod schema for TypesenseSynonym. */
export const TypesenseSynonymSchema: z.ZodType<TypesenseSynonym> = z.union([
  TypesenseOneWaySynonymSchema,
  TypesenseMultiWaySynonymSchema,
]);

/**
 * Describes how a client should enumerate the keys a groupBy axis produces.
 *
 * - `enum` — keys come from the Zod enum at `field` (e.g. card status).
 * - `collectionFeed` — keys come from a live Firestore collection (e.g. one
 *   section per list); `collection` names the source.
 * - `dateBucket` — keys are computed client-side from the row's date value;
 *   no separate per-key query.
 *
 * A single "None" / ungrouped axis is represented with `field: null` and no
 * `kind` — the axis lists which *groupings are available*, and "no grouping"
 * is always one of them.
 */
export interface GroupByAxis {
  /** Firestore field the per-key query filters on. `null` for the ungrouped axis. */
  field: string | null;
  /** User-facing label for the picker. */
  label: string;
  /** How the client should enumerate keys. Omitted for the ungrouped axis. */
  kind?: "enum" | "collectionFeed" | "dateBucket";
  /** Source Firestore collection when `kind === "collectionFeed"`. */
  collection?: string;
}

/** Zod schema for GroupByAxis. */
export const GroupByAxisSchema: z.ZodType<GroupByAxis> = z.strictObject({
  field: z.string().nullable(),
  label: z.string(),
  kind: z.enum(["enum", "collectionFeed", "dateBucket"]).optional(),
  collection: z.string().optional(),
});

/** Display defaults for a Typesense collection in the UI. */
export interface TypesenseDisplayDefaults {
  columns: string[];
  filters: Record<string, (string | boolean)[]>;
  sort: { column: string | null; direction: "asc" | "desc" };
  group: string | null;
  facet: string[];
  /** Available groupBy axes the UI can offer for this collection. */
  groupBy?: GroupByAxis[];
}

/** Zod schema for TypesenseDisplayDefaults. */
export const TypesenseDisplayDefaultsSchema: z.ZodType<TypesenseDisplayDefaults> = z.strictObject({
  columns: z.array(z.string()),
  filters: z.record(z.string(), z.array(z.union([z.string(), z.boolean()]))),
  sort: z.strictObject({
    column: z.string().nullable(),
    direction: z.enum(["asc", "desc"]),
  }),
  group: z.string().nullable(),
  facet: z.array(z.string()),
  groupBy: z.array(GroupByAxisSchema).optional(),
});

/** Full collection config with alias, version, and Firestore mapping. */
export interface TypesenseCollectionConfig {
  alias: string;
  version: number;
  firestoreCollection: string;
  collectionName: string;
  schema: TypesenseSchema;
  synonyms: TypesenseSynonym[];
  displayDefaults: TypesenseDisplayDefaults;
  /** Whether this collection is actively synced to Typesense. Defaults to true. */
  enabled?: boolean;
}

/** Zod schema for TypesenseCollectionConfig. */
export const TypesenseCollectionConfigSchema: z.ZodType<TypesenseCollectionConfig> = z.strictObject({
  alias: z.string(),
  version: z.number(),
  firestoreCollection: z.string(),
  collectionName: z.string(),
  schema: TypesenseSchemaSchema,
  synonyms: z.array(TypesenseSynonymSchema),
  displayDefaults: TypesenseDisplayDefaultsSchema,
  enabled: z.boolean().optional(),
});

/**
 * Generate Typesense field definitions for a nested address object.
 *
 * Coordinates use the `geopoint` type with `[latitude, longitude]` order.
 * The API translates Firestore `{latitude, longitude}` objects into this format.
 */
export function typesenseAddressFields(
  prefix: string,
  opts: { array?: boolean; sortFull?: boolean; parentOptional?: boolean } = {},
): TypesenseField[] {
  const t = (base: string): TypesenseFieldType =>
    (opts.array ? `${base}[]` : base) as TypesenseFieldType;
  const parentOptional = opts.parentOptional ?? true;

  return [
    { name: prefix, type: t("object"), ...(parentOptional && { optional: true }) },
    { name: `${prefix}.full`, type: t("string"), stem: true, optional: true, ...(opts.sortFull && { sort: true }) },
    { name: `${prefix}.name`, type: t("string"), stem: true, optional: true },
    { name: `${prefix}.city`, type: t("string"), facet: true, optional: true },
    { name: `${prefix}.region`, type: t("string"), facet: true, optional: true },
    { name: `${prefix}.street`, type: t("string"), stem: true, optional: true },
    { name: `${prefix}.street2`, type: t("string"), stem: true, optional: true },
    { name: `${prefix}.postcode`, type: t("string"), optional: true },
    { name: `${prefix}.country_name`, type: t("string"), facet: true, optional: true },
    { name: `${prefix}.mapbox_id`, type: t("string"), index: false, optional: true },
    { name: `${prefix}.address_coordinates`, type: t("geopoint"), optional: true },
    { name: `${prefix}.user_coordinates`, type: t("geopoint"), optional: true },
  ];
}
