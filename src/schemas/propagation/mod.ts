/**
 * Propagation rules — documents how data flows between Firestore collections.
 *
 * The catalog is assembled from one `PropagationModule` per source file. Adding
 * a rule means editing exactly one file; nothing here has to be told about it.
 *
 * ⚠️ **This file used to re-export 141 symbols by hand, and `schemas/mod.ts`
 * re-exported 81 of them — so 60 had silently drifted out of the barrel with
 * nothing noticing.** The whole outside world reads three values (`rules`,
 * `transactions`, `aggregates`), which is why the fix was to delete the thing
 * that required a list rather than to derive a better list.
 *
 * The import block below and `MODULES` check each other for free: a name in
 * `MODULES` that is not imported is a compile error, and an import that is not
 * in `MODULES` is a `deno lint` error. Only the directory listing itself needs
 * a test — `tests/propagation.test.ts` compares this file's source against
 * `Deno.readDir`, with no dynamic import and no execution.
 *
 * ⚠️ **A runtime glob here would be fatal, not merely inelegant** — manager
 * pulls this into a browser and JSR serves it over `https:`, and neither has a
 * directory to read or a `Deno` global. See `propagation/types.ts`'s `PropagationModule`.
 */

import type {
  CollectionRule,
  PropagationModule,
  TransactionDefinition,
} from "./types.ts";

import { orders } from "./orders.ts";
import { outOfService } from "./out-of-service.ts";
// Aliased: this file exports a `transactions` array of its own, below.
import { transactions as transactionsModule } from "./transactions.ts";
import { storeTransfers } from "./store-transfers.ts";
import { products } from "./products.ts";
import { organizations } from "./organizations.ts";
import { contacts } from "./contacts.ts";
import { users } from "./users.ts";
import { invoices } from "./invoices.ts";
import { settlements } from "./settlements.ts";
import { creditNotes } from "./credit-notes.ts";
import { fulfillments } from "./fulfillments.ts";
import { taxes } from "./taxes.ts";
import { referenceData } from "./reference-data.ts";
import { stores } from "./stores.ts";
import { locations } from "./locations.ts";
import { threads } from "./threads.ts";
import { cards } from "./cards.ts";
import { templates } from "./templates.ts";
import { recurrences } from "./recurrences.ts";
import { uploadcare } from "./uploadcare.ts";
import { crmsIngest } from "./crms-ingest.ts";
import { stock } from "./stock.ts";

// ── Types ────────────────────────────────────────────────────────────

export type {
  AggregateDefinition,
  CollectionRule,
  FieldMapping,
  FieldPath,
  PropagationMode,
  PropagationModule,
  TransactionDefinition,
} from "./types.ts";

/**
 * The two id namespaces. Consumers write these ids far more often than they
 * construct a rule — `rules_fired`, `logPropagation`, `getPropagationMarkdown` —
 * so they are part of the public surface, not an implementation detail.
 */
export type { RuleId, TransactionId } from "./ids.ts";

// ── Aggregates ───────────────────────────────────────────────────────

export { aggregates } from "./aggregates.ts";

// ── The catalog ──────────────────────────────────────────────────────

/**
 * Every propagation source file, in declaration order.
 *
 * `propagation/stock.ts` declares the four stock edges once and exports `STOCK_STEPS`, the
 * shared step tuple its seven firing transactions reference. It is the only
 * file that exports anything besides its module, and that is deliberate — see
 * its own docstring.
 */
const MODULES: readonly PropagationModule[] = [
  orders,
  outOfService,
  transactionsModule,
  storeTransfers,
  products,
  organizations,
  contacts,
  users,
  invoices,
  settlements,
  creditNotes,
  fulfillments,
  taxes,
  referenceData,
  stores,
  locations,
  threads,
  cards,
  templates,
  recurrences,
  uploadcare,
  crmsIngest,
  stock,
];

/** Every transaction across every module. */
export const transactions: TransactionDefinition[] = MODULES.flatMap((m) =>
  m.transactions
);

/** All propagation rules across all transactions and cascades. */
export const rules: CollectionRule[] = MODULES.flatMap((m) => m.rules);
