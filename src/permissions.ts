/**
 * RBAC permission catalog.
 *
 * The canonical list of permission strings that roles can grant and API routes
 * can require. Role documents in Firestore reference these strings; the API
 * uses the `Permission` union to type-check route-level declarations so that
 * a permission string that isn't in this list fails the build.
 */

/** The full catalog of permissions. Adding a new route? Add its permission here first. */
export const PERMISSIONS = [
  "orders.create",
  "orders.read",
  "orders.update",
  "orders.delete",
  "orders.search",
  "orders.checkout",
  "orders.return",

  "products.create",
  "products.read",
  "products.update",
  "products.delete",
  "products.search",

  "webshopProducts.read",
  "webshopProducts.search",

  "contacts.create",
  "contacts.read",
  "contacts.update",
  "contacts.delete",
  "contacts.search",

  "organizations.create",
  "organizations.read",
  "organizations.update",
  "organizations.delete",
  "organizations.search",

  "transactions.create",
  "transactions.read",
  "transactions.update",
  "transactions.delete",

  "invoices.create",
  "invoices.read",
  "invoices.update",
  "invoices.delete",
  "invoices.search",

  "quotes.create",
  "quotes.read",
  "quotes.update",
  "quotes.delete",

  "locations.create",
  "locations.read",
  "locations.update",
  "locations.delete",
  "locations.search",

  "locationTypes.create",
  "locationTypes.read",
  "locationTypes.update",
  "locationTypes.delete",

  "stores.create",
  "stores.read",
  "stores.update",
  "stores.delete",
  "stores.search",

  "taxes.create",
  "taxes.read",
  "taxes.update",
  "taxes.delete",

  "tags.create",
  "tags.read",
  "tags.update",
  "tags.delete",
  "tags.search",

  "trackingCategories.create",
  "trackingCategories.read",
  "trackingCategories.update",
  "trackingCategories.delete",
  "trackingCategories.search",

  "holidays.create",
  "holidays.read",
  "holidays.update",
  "holidays.delete",

  "templates.create",
  "templates.read",
  "templates.update",
  "templates.delete",
  "templates.search",

  "lists.create",
  "lists.read",
  "lists.update",
  "lists.delete",

  "cards.create",
  "cards.read",
  "cards.update",
  "cards.delete",
  "cards.search",

  "recurrences.create",
  "recurrences.read",
  "recurrences.update",
  "recurrences.delete",

  "bookings.read",
  "bookings.update",
  "chartOfAccounts.read",
  "chartOfAccounts.search",
  "dateHelpers.read",
  "destinations.read",
  "destinations.search",
  "ledgers.read",
  "fulfillment.read",
  "fulfillment.search",
  "outOfService.create",
  "outOfService.read",
  "outOfService.update",
  "outOfService.delete",
  "outOfService.search",
  "stockSummaries.read",
  "typesenseSync.read",

  "users.read",
  "users.update",
  "users.delete",
  "users.invite",
  "users.search",
  "users.assignRoles",

  "roles.read",
  "roles.edit",

  "threads.create",
  "threads.read",
  "threads.update",
  "threads.search",

  "comments.create",
  "comments.read",
  "comments.update",
  "comments.delete",
  "comments.moderate",
  "comments.search",
  "comments.react",

  "uploads.sign",

  "admin.reindex",
  "admin.validate",
  "admin.sync",
  "admin.previewRole",
] as const;

/** Union type of every permission string in the catalog. */
export type Permission = typeof PERMISSIONS[number];

/** HTTP methods accepted by the runtime route manifest. */
export type RouteMethod = "get" | "post" | "put" | "delete" | "patch";

/** A single entry in the runtime route manifest — one per protected route. */
export interface RouteManifestEntry {
  method: RouteMethod;
  path: string;
  permission: Permission;
  operationId?: string;
}

/** Runtime route manifest — emitted by api-cloudrun at GET /permissions/manifest. */
export interface RouteManifest {
  version: string;
  permissions: readonly Permission[];
  routes: RouteManifestEntry[];
}
