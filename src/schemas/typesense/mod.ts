/**
 * Typesense collection schemas for CFS.
 *
 * These are configuration objects (not Zod schemas) describing
 * the shape of each Typesense collection for the Collections API.
 */
export type {
  GroupByAxis,
  TypesenseCollectionConfig,
  TypesenseDisplayDefaults,
  TypesenseField,
  TypesenseFieldType,
  TypesenseMultiWaySynonym,
  TypesenseOneWaySynonym,
  TypesenseSchema,
  TypesenseSynonym,
} from "./types.ts";

export {
  GroupByAxisSchema,
  isStrippedAtIndexTime,
  QUERY_BY_PREFIX,
  TypesenseFieldTypeEnum,
  TypesenseFieldSchema,
  TypesenseSchemaSchema,
  TypesenseDisplayDefaultsSchema,
  TypesenseCollectionConfigSchema,
  TypesenseMultiWaySynonymSchema,
  TypesenseOneWaySynonymSchema,
  TypesenseSynonymSchema,
  typesenseAddressFields,
  toWireSchema,
} from "./types.ts";

export type {
  TypesenseAddressFields,
  BookingDocument,
  ChartOfAccountsDocument,
  CommentDocument,
  ContactDocument,
  DestinationDocument,
  FulfillmentDocument,
  InvoiceDocument,
  CreditNoteDocument,
  LocationDocument,
  OrderDocument,
  OrganizationDocument,
  OutOfServiceDocument,
  ProductDocument,
  ProductDocumentComponent,
  StoreDocument,
  TagDocument,
  TemplateComponentDocument,
  TemplateDocument,
  TrackingCategoryDocument,
  UserDocument,
  WebshopProductDocument,
  WebshopProductDocumentComponent,
  TypesenseDocument,
  TypesenseDocumentMap,
} from "./documents.ts";

export { bookings } from "./bookings.ts";
export { cards } from "./cards.ts";
export { chartOfAccounts } from "./chart-of-accounts.ts";
export { comments } from "./comments.ts";
export { contacts } from "./contacts.ts";
export { destinations } from "./destinations.ts";
export { invoices } from "./invoices.ts";
export { creditNotes } from "./credit-notes.ts";
export { locations } from "./locations.ts";
export { orders } from "./orders.ts";
export { fulfillments } from "./fulfillments.ts";
export { organizations } from "./organizations.ts";
export { outOfService } from "./out-of-service.ts";
export { products } from "./products.ts";
export { stores } from "./stores.ts";
export { tags } from "./tags.ts";
export { trackingCategories } from "./tracking-categories.ts";
export { templates } from "./templates.ts";
export { templateComponents } from "./template-components.ts";
export { threads } from "./threads.ts";
export { users } from "./users.ts";
export { webshopProducts } from "./webshop-products.ts";

import type { Permission } from "../permissions.ts";
import type { TypesenseCollectionConfig } from "./types.ts";
import { bookings } from "./bookings.ts";
import { cards } from "./cards.ts";
import { chartOfAccounts } from "./chart-of-accounts.ts";
import { comments } from "./comments.ts";
import { contacts } from "./contacts.ts";
import { destinations } from "./destinations.ts";
import { invoices } from "./invoices.ts";
import { creditNotes } from "./credit-notes.ts";
import { locations } from "./locations.ts";
import { orders } from "./orders.ts";
import { fulfillments } from "./fulfillments.ts";
import { organizations } from "./organizations.ts";
import { outOfService } from "./out-of-service.ts";
import { products } from "./products.ts";
import { stores } from "./stores.ts";
import { tags } from "./tags.ts";
import { trackingCategories } from "./tracking-categories.ts";
import { templates } from "./templates.ts";
import { templateComponents } from "./template-components.ts";
import { threads } from "./threads.ts";
import { users } from "./users.ts";
import { webshopProducts } from "./webshop-products.ts";

const allSchemas: TypesenseCollectionConfig[] = [
  bookings,
  cards,
  chartOfAccounts,
  comments,
  contacts,
  destinations,
  invoices,
  creditNotes,
  locations,
  orders,
  fulfillments,
  organizations,
  outOfService,
  products,
  stores,
  tags,
  templates,
  templateComponents,
  threads,
  trackingCategories,
  users,
  webshopProducts,
];

/** Union of all Typesense collection alias names. */
export type TypesenseAlias =
  | "bookings"
  | "cards"
  | "chart-of-accounts"
  | "comments"
  | "contacts"
  | "destinations"
  | "invoices"
  | "credit-notes"
  | "locations"
  | "orders"
  | "fulfillments"
  | "organizations"
  | "out-of-service"
  | "products"
  | "stores"
  | "tags"
  | "templates"
  | "template-components"
  | "threads"
  | "tracking-categories"
  | "users"
  | "webshop-products";

/** All Typesense collection configs keyed by alias. */
export const typesenseSchemas: Record<TypesenseAlias, TypesenseCollectionConfig> =
  Object.fromEntries(allSchemas.map((s) => [s.alias, s])) as Record<TypesenseAlias, TypesenseCollectionConfig>;

/** Firestore collection names that are actively synced to Typesense (enabled !== false). */
export const typesenseEnabledCollections: Set<string> = new Set(
  allSchemas
    .filter((s) => s.enabled !== false && s.firestoreCollection !== "")
    .map((s) => s.firestoreCollection),
);

/**
 * Maps each Typesense alias to its `.search` RBAC permission.
 *
 * Used by the drift-guard test (every enabled alias must map to a cataloged
 * permission) and by the api-cloudrun scoped-key minter (resolve which parent
 * key to derive a user's scoped key from per granted `.search` permission).
 *
 * Disabled aliases (`enabled: false`, e.g. `bookings`) are omitted — no search
 * UI surface is expected for them until they are provisioned in Typesense.
 */
/**
 * Look up the default sorting field for a Typesense collection. Returns
 * `null` when the alias is unknown or the config does not declare one.
 */
export function getDefaultSortingField(alias: string): string | null {
  const config = typesenseSchemas[alias as TypesenseAlias];
  return config?.schema.default_sorting_field ?? null;
}

/**
 * Default sort direction for a Typesense collection's default sorting field.
 * Numeric types (`int32`, `int64`, `float`) sort descending (recent/large
 * first); everything else sorts ascending. Returns `null` when the collection
 * has no default sorting field.
 */
export function getDefaultSortDirection(alias: string): "asc" | "desc" | null {
  const config = typesenseSchemas[alias as TypesenseAlias];
  const sortField = config?.schema.default_sorting_field;
  if (!sortField) return null;
  const field = config.schema.fields.find((f) => f.name === sortField);
  if (!field) return null;
  if (field.type === "int32" || field.type === "int64" || field.type === "float") {
    return "desc";
  }
  return "asc";
}

/**
 * Resolve a Firestore collection name (singular or plural) to its Typesense
 * alias. Returns `null` when no matching Typesense collection exists.
 */
export function getSearchAlias(collection: string): string | null {
  const direct = typesenseSchemas[collection as TypesenseAlias];
  if (direct) return direct.alias;
  const match = allSchemas.find((s) => s.firestoreCollection === collection);
  return match?.alias ?? null;
}

export const SEARCH_PERMISSION_BY_ALIAS: Partial<Record<TypesenseAlias, Permission>> = {
  "cards": "cards.search",
  "chart-of-accounts": "chartOfAccounts.search",
  "comments": "comments.search",
  "contacts": "contacts.search",
  "destinations": "destinations.search",
  "invoices": "invoices.search",
  "credit-notes": "creditNotes.search",
  "locations": "locations.search",
  "orders": "orders.search",
  "fulfillments": "fulfillment.search",
  "organizations": "organizations.search",
  "out-of-service": "outOfService.search",
  "products": "products.search",
  "stores": "stores.search",
  "tags": "tags.search",
  "templates": "templates.search",
  // Components route through the template system — reuse templates.search rather
  // than minting a new RBAC verb (components are not a separate permission scope).
  "template-components": "templates.search",
  "threads": "threads.search",
  "tracking-categories": "trackingCategories.search",
  "users": "users.search",
  "webshop-products": "webshopProducts.search",
};
