/**
 * Collection → the Zod schema a template's `it.doc` is validated against.
 *
 * The companion of `TEMPLATE_COLLECTION_UTILS` (`schemas/template-context.ts`):
 * that map answers *which helpers does this collection get*, this one answers
 * *what shape is its document*. Both are keyed on the same
 * `TemplateCollectionType` and both are `Partial` — a collection need not have
 * either.
 *
 * ## Why this is not just `schemaFor(collection)`
 *
 * Because a template SOURCE is not always a Firestore collection.
 * `movement-sessions` is the fold of `transactions where uuid_session == …` —
 * the operator action a receipt is printed at — and no document is stored at
 * that path (api-cloudrun#700). Resolving sources through the Firestore
 * collection registry made "is a template source" and "is a collection" the
 * same question; they are not, and this map is where they stop being.
 *
 * Every entry that IS a collection names the same schema instance
 * `schemaFor` returns, asserted by identity in `tests/template-schemas.test.ts`
 * rather than trusted — a second table that merely *agrees* today is a table
 * that drifts.
 *
 * ## Absences are answers
 *
 * `packing_lists` and `receipts` are TARGETS with no schema, and templates
 * *produce* those rather than compute over them, so there is nothing to
 * validate and nothing to walk. The generated field reference
 * (`schemas/template-schema-fields.generated.ts`) is `Partial` for exactly this
 * reason, and its staleness test asserts `packing_lists` stays absent.
 *
 * ⚠️ **A source, unlike a target, must be present.** Fixture validation, fixture
 * PII sanitisation and the field reference panel all resolve through here, so a
 * source with no entry ships a family that can hold no fixture, therefore no
 * golden, therefore no gate. `tests/schema-fields.test.ts` refuses it.
 *
 * ## What a non-collection source is, and is NOT, swept by
 *
 * Several of this package's ratchets derive their corpus from the `schemas`
 * record, so a schema outside it is outside them. Stated rather than left to be
 * discovered, because an unnamed gap reads as covered:
 *
 * - **`tests/pii.test.ts` — COVERED, via a fourth arm added for exactly this.**
 *   A receipt is printed and handed to a customer and its fixtures are committed
 *   to git, so an untagged name or email is a permanent leak. Measured before
 *   the arm existed: a planted untagged `email` on `MovementSessionSchema`
 *   passed all nine assertions.
 * - **`tests/inert-defaults.test.ts` — COVERED already**, because it scans the
 *   `schemas/mod.ts` barrel rather than the registry.
 * - **`tests/uploadcareRef.test.ts` — NOT covered, and correctly so.** That lint
 *   exists so the CDN sweep can tell a live file reference from a dead one; a
 *   document that is never stored holds no reference the sweep could reach, so
 *   there is nothing for it to protect. The asymmetry with PII above is the
 *   point: a fixture leaks PII forever and cannot orphan a CDN file.
 * - **`typesense-parity` / `display-columns` / `display-defaults` / `testing` /
 *   `initial` — NOT covered, and inapplicable**: each answers a question about a
 *   Firestore collection (an index, a column set, a seeded test document).
 *
 * @module
 */
import type { z } from "zod";
import { FulfillmentSchema } from "./fulfillment.ts";
import { InvoiceSchema } from "./invoice.ts";
import { MovementSessionSchema } from "./movement-session.ts";
import { OrderSchema } from "./order.ts";
import { PickSheetSchema } from "./pick-sheet.ts";
import { QuoteSchema } from "./quote.ts";
import type { TemplateCollectionType } from "./template-context.ts";

/**
 * The document schema for each template source and target that has one.
 *
 * ⚠️ **Not derived from `schemas` by a filter.** A filter over the collection
 * registry is what this map replaces: it silently dropped any source the
 * registry did not know, which is the whole `movement-sessions` case, and it
 * dropped it in the direction that reports clean.
 */
export const TEMPLATE_COLLECTION_SCHEMAS: Partial<
  Record<TemplateCollectionType, z.ZodType>
> = {
  orders: OrderSchema,
  invoices: InvoiceSchema,
  fulfillments: FulfillmentSchema,
  quotes: QuoteSchema,
  // The two entries with no Firestore collection behind them. See the module doc.
  "movement-sessions": MovementSessionSchema,
  "pick-sheets": PickSheetSchema,
};

/**
 * The schema for a template collection, or `undefined` when it has none.
 *
 * A function rather than a bare map read so consumers that start from a runtime
 * string — a fixture's stored `collection_source`, an MCP argument — have one
 * door, and so the `Partial` index is narrowed in one place instead of at each
 * call site.
 */
export function templateSchemaFor(
  collection: string,
): z.ZodType | undefined {
  return TEMPLATE_COLLECTION_SCHEMAS[collection as TemplateCollectionType];
}
