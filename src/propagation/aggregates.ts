/**
 * Aggregate definitions — DDD boundaries grouping collections under consistency roots.
 */
import type { AggregateDefinition } from "./types.ts";

export const aggregates: AggregateDefinition[] = [
  {
    id: "order",
    root: "orders",
    members: ["bookings", "stock-summaries", "public-stock-summaries", "quotes", "order-fulfillments", "out-of-service"],
    description: "Rental/sale order lifecycle — from quote through active rental to completion. Event cards (deliver/pick-up/in-store) live in the cards aggregate but are cowritten by create-order / update-order to project the schedule onto the Dashboard. OOS records born from update-booking carry both bookings: and orders: entries in their sources[] so they surface on both detail pages.",
  },
  {
    id: "product",
    root: "products",
    members: ["webshop-products", "inventory-ledgers"],
    description: "Product catalog and inventory state — the source of truth for what can be rented/sold",
  },
  {
    id: "organization",
    root: "organizations",
    members: [],
    description: "Customer/vendor organizations with billing, tax, and external system references",
  },
  {
    id: "contact",
    root: "contacts",
    members: [],
    description: "Individual people linked to organizations — delivery contacts, billing contacts",
  },
  {
    id: "invoice",
    root: "invoices",
    members: [],
    description: "Financial invoices generated from orders — syncs to Xero for accounting and payment tracking",
  },
  {
    id: "store",
    root: "stores",
    members: ["locations", "location-types"],
    description: "Physical storage locations and their capacity/layout configuration",
  },
  {
    id: "transaction",
    root: "transactions",
    members: ["out-of-service"],
    description: "Inventory movements (purchase, sale, adjustment, transfer) that modify ledger quantities",
  },
  {
    id: "reference-data",
    root: "",
    members: ["tags", "tracking-categories", "chart-of-accounts", "destinations", "templates", "holiday-dates"],
    description: "Shared lookup data referenced by other aggregates — low velocity, high fan-out on change",
  },
  {
    id: "threads",
    root: "threads",
    members: ["comments"],
    description: "Conversation primitive — every order, invoice, contact, organization, card, product, transaction, and role carries a default thread cowritten on creation. Comments (Tiptap JSON + plain-text mirror) belong to a thread; threads carry 1..N polymorphic source refs so one conversation can surface on multiple detail pages (e.g. an event card's thread surfaces on both the card and its parent order).",
  },
  {
    id: "cards",
    root: "cards",
    members: ["lists"],
    description: "Generalized work-item surface — event cards (deliver/pick-up/in-store) cowritten from orders, plus to-dos, shopping items, and calendar entries. Lists are routable buckets (Field service, In-store, To do, Purchases). Cards drive the Dashboard's list/agenda/kanban/calendar/map views.",
  },
  {
    id: "infrastructure",
    root: "",
    members: ["sessions", "email-verifications", "password-resets", "rate-limits", "typesense-config", "cache-geocodes", "webhook-events"],
    description: "System plumbing — auth, caching, search config",
  },
];
