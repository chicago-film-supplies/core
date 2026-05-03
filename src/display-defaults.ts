/**
 * Display defaults for Firestore and Typesense collections.
 *
 * `firestoreDisplayDefaults` is defined in mod.ts (not here) because it reads
 * from the `schemas` record via Zod's .meta() registry. Defining it here would
 * create a circular dependency: mod.ts re-exports from this file, so `schemas`
 * would not be initialized yet at import time. Typesense defaults don't have
 * this problem — they read from ./typesense/mod.ts which has no cycle with mod.ts.
 */
import { typesenseSchemas, type TypesenseAlias, type TypesenseDisplayDefaults } from "./typesense/mod.ts";
import type { GroupByAxis } from "./typesense/types.ts";

/** Display defaults for a Firestore collection in the UI. */
export interface FirestoreDisplayDefaults {
  columns: string[];
  filters: Record<string, (string | boolean)[]>;
  sort: { column: string | null; direction: "asc" | "desc" };
  /** Available groupBy axes the UI can offer for this collection. */
  groupBy?: GroupByAxis[];
}

/** Display defaults for every Typesense collection, derived from collection config. */
export const typesenseDisplayDefaults: Record<string, TypesenseDisplayDefaults> =
  Object.fromEntries(
    Object.entries(typesenseSchemas).map(([alias, config]) => [alias, config.displayDefaults])
  );

/** Get the display defaults for a Typesense collection by alias. */
export function getTypesenseDisplayDefaults(alias: string): TypesenseDisplayDefaults | undefined {
  if (alias in typesenseSchemas) {
    return typesenseSchemas[alias as TypesenseAlias].displayDefaults;
  }
  return undefined;
}
