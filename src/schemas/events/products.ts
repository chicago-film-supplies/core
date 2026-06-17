/**
 * Product aggregate events.
 *
 * Covers: products, webshop-products, inventory-ledgers.
 */
import type { EventEnvelope } from "./common.ts";
import type { Product } from "../product.ts";
import type { WebshopProduct } from "../webshop-product.ts";
import type { InventoryLedger } from "../inventory-ledger.ts";

// ── Product events ─────────────────────────────────────────────────

export type ProductCreated = EventEnvelope<Product> & { event: "product.created" };
export type ProductUpdated = EventEnvelope<Product> & { event: "product.updated" };

// ── Webshop product events ─────────────────────────────────────────

export type WebshopProductUpdated = EventEnvelope<WebshopProduct> & { event: "webshop_product.updated" };

// ── Inventory ledger events ────────────────────────────────────────

export type InventoryLedgerRecalculated = EventEnvelope<InventoryLedger> & { event: "inventory_ledger.recalculated" };
