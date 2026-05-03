/**
 * Domain events — typed envelopes wrapping full Firestore documents.
 *
 * Each event is an EventEnvelope<T> where T is the unchanged document type.
 * Events are grouped by aggregate root.
 */
export type { EventEnvelope } from "./common.ts";

// ── Order aggregate ─────────────────────────────────────────────────

export type {
  OrderCreated,
  OrderUpdated,
  OrderStatusChanged,
  OrderCanceled,
  BookingCreated,
  BookingUpdated,
  BookingStatusChanged,
  StockSummaryRecalculated,
  PublicStockSummaryRecalculated,
  QuoteCreated,
  QuoteRestored,
  QuoteDeleted,
} from "./orders.ts";

// ── Product aggregate ───────────────────────────────────────────────

export type {
  ProductCreated,
  ProductUpdated,
  WebshopProductUpdated,
  InventoryLedgerRecalculated,
} from "./products.ts";

// ── Invoice aggregate ───────────────────────────────────────────────

export type {
  InvoiceCreated,
  InvoiceIssued,
  InvoicePaymentReceived,
  InvoiceUpdated,
  InvoiceVoided,
} from "./invoices.ts";

// ── Organization aggregate ──────────────────────────────────────────

export type {
  OrganizationCreated,
  OrganizationUpdated,
} from "./organizations.ts";

// ── Contact aggregate ───────────────────────────────────────────────

export type {
  ContactCreated,
  ContactUpdated,
} from "./contacts.ts";

// ── Store aggregate ─────────────────────────────────────────────────

export type {
  StoreCreated,
  StoreUpdated,
  LocationCreated,
  LocationUpdated,
  LocationTypeCreated,
  LocationTypeUpdated,
} from "./stores.ts";

// ── Transaction aggregate ───────────────────────────────────────────

export type {
  TransactionCreated,
  TransactionUpdated,
  OutOfServiceRecordCreated,
  OutOfServiceRecordUpdated,
} from "./transactions.ts";

// ── Threads aggregate ───────────────────────────────────────────────

export type {
  ThreadCreated,
  ThreadUpdated,
  CommentCreated,
  CommentUpdated,
  CommentDeleted,
} from "./threads.ts";

// ── Cards aggregate ─────────────────────────────────────────────────

export type {
  CardCreated,
  CardUpdated,
  CardDeleted,
  ListCreated,
  ListUpdated,
  ListDeleted,
} from "./cards.ts";

// ── Recurrences aggregate ───────────────────────────────────────────

export type {
  RecurrenceCreated,
  RecurrenceUpdated,
  RecurrenceDeleted,
  HorizonMaterialized,
  HorizonMaterializedData,
} from "./recurrences.ts";

// ── Reference data ──────────────────────────────────────────────────

export type {
  TagCreated,
  TagUpdated,
  TagDeleted,
  TrackingCategoryCreated,
  TrackingCategoryUpdated,
  TemplateCreated,
  TemplateUpdated,
  HolidayDatesAdded,
  HolidayDatesDeleted,
  ChartOfAccountsUpdated,
} from "./reference-data.ts";
