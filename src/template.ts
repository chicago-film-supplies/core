/**
 * Template document schema — Firestore collection: templates
 *
 * Eta HTML templates for generating PDFs (quotes, packing lists, invoices, etc.).
 * Versioning uses a flat collection with uid_template grouping versions.
 *
 * v1:  { uid: "abc123", uid_template: "abc123", version: 1, ... }
 * v2:  { uid: "def456", uid_template: "abc123", version: 2, ... }
 */
import { z } from "zod";
import { FirestoreTimestamp, type FirestoreTimestampType } from "./common.ts";

/** Collections that can serve as data sources for templates. */
export const TEMPLATE_SOURCE_COLLECTIONS = ["orders", "invoices"] as const;
/** Firestore collection that provides data to a template. */
export type TemplateSourceCollectionType = typeof TEMPLATE_SOURCE_COLLECTIONS[number];

/** Collections that templates can produce documents for. */
const TEMPLATE_TARGET_COLLECTIONS = ["quotes", "packing_lists", "invoices"] as const;
/** Firestore collection that a template produces documents for. */
export type TemplateTargetCollectionType = typeof TEMPLATE_TARGET_COLLECTIONS[number];

const TEMPLATE_SCOPES = ["single", "multiple"] as const;
/** Whether a template targets a single document or multiple. */
export type TemplateScopeType = typeof TEMPLATE_SCOPES[number];

/** An Eta HTML template used for generating PDFs. */
export interface Template {
  uid: string;
  uid_template: string;
  name: string;
  collection_source: TemplateSourceCollectionType;
  collection_target: TemplateTargetCollectionType;
  scope: TemplateScopeType;
  version: number;
  source: string;
  source_header?: string;
  source_footer?: string;
  margin_top?: number;
  margin_bottom?: number;
  margin_left?: number;
  margin_right?: number;
  base_font_size?: number;
  source_filename: string;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}

/** Zod schema for Template. */
export const TemplateSchema: z.ZodType<Template> = z.strictObject({
  uid: z.string(),
  uid_template: z.string(),
  name: z.string(),
  collection_source: z.enum(TEMPLATE_SOURCE_COLLECTIONS),
  collection_target: z.enum(TEMPLATE_TARGET_COLLECTIONS),
  scope: z.enum(TEMPLATE_SCOPES),
  version: z.int().min(0),
  source: z.string(),
  source_header: z.string().optional(),
  source_footer: z.string().optional(),
  margin_top: z.number().min(0).max(5).optional(),
  margin_bottom: z.number().min(0).max(5).optional(),
  margin_left: z.number().min(0).max(5).optional(),
  margin_right: z.number().min(0).max(5).optional(),
  base_font_size: z.number().min(1).max(100).optional(),
  source_filename: z.string(),
  created_at: FirestoreTimestamp,
  updated_at: FirestoreTimestamp,
}).meta({
  title: "Template",
  collection: "templates",
  displayDefaults: {
    columns: ["name", "collection_source", "collection_target", "scope"],
    filters: {},
    sort: { column: "name", direction: "asc" },
  },
});

/** Input for creating a new template (v1). */
export interface TemplateInputType {
  name: string;
  collection_source: TemplateSourceCollectionType;
  collection_target: TemplateTargetCollectionType;
  scope: TemplateScopeType;
}

/** Zod schema for TemplateInput. */
export const TemplateInputSchema: z.ZodType<TemplateInputType> = z.object({
  name: z.string().min(1).max(200),
  collection_source: z.enum(TEMPLATE_SOURCE_COLLECTIONS),
  collection_target: z.enum(TEMPLATE_TARGET_COLLECTIONS),
  scope: z.enum(TEMPLATE_SCOPES),
});

/** Input for updating an existing template version. */
export interface TemplateUpdateInputType {
  name?: string;
  source?: string;
  source_header?: string;
  source_footer?: string;
  margin_top?: number;
  margin_bottom?: number;
  margin_left?: number;
  margin_right?: number;
  base_font_size?: number;
  source_filename?: string;
}

/** Zod schema for TemplateUpdateInput. */
export const TemplateUpdateInputSchema: z.ZodType<TemplateUpdateInputType> = z.object({
  name: z.string().min(1).max(200).optional(),
  source: z.string().optional(),
  source_header: z.string().optional(),
  source_footer: z.string().optional(),
  margin_top: z.number().min(0).max(5).optional(),
  margin_bottom: z.number().min(0).max(5).optional(),
  margin_left: z.number().min(0).max(5).optional(),
  margin_right: z.number().min(0).max(5).optional(),
  base_font_size: z.number().min(1).max(100).optional(),
  source_filename: z.string().max(500).optional(),
});

/** Context object passed to Eta templates at render time. */
export interface TemplateContext {
  doc: Record<string, unknown>;
  version?: number | null;
  logo?: string;
}
