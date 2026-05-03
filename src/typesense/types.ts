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
});

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
