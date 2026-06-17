/**
 * Template component family schema — Firestore collection: template-components
 *
 * A component doc is a *thin component family* (same shape philosophy as a
 * `templates` family: identity + rollups, no content/status). Each component
 * (e.g. a shared `base` layout, a `quote` stylesheet) is its own family. Its
 * versions live in the SHARED `templates-versions` collection (status-
 * discriminated), keyed by `uid_template` = this family's uid.
 *
 * Render = overlay(template content ∪ every depends_on component's active
 * version). The render lib branches on file extension (`.eta` layout vs `.css`
 * style) — no `kind` discriminator is stored; extension is authoritative.
 *
 * `git_path` is the immutable slug frozen at create and permanently reserved
 * (S5), exactly like a template family.
 */
import { z } from "zod";
import { FirestoreId } from "./_uid.ts";
import {
  ActorRef,
  type ActorRefType,
  FirestoreTimestamp,
  type FirestoreTimestampType,
  TimestampFields,
} from "./common.ts";

/** A thin template-component *family* document. */
export interface TemplateComponent {
  uid: string;
  /** Immutable slug `slugify(name)`, frozen at create — the family's git identity. */
  git_path: string;
  /** Mutable display name (mirrors the sidecar `display_name`). */
  name: string;
  /** uid of the current published version, or null until the first merge. */
  uid_active: string | null;
  /** Rollup: uids of versions currently in `draft` status. */
  draft_uids: string[];
  /** Rollup: total versions ever published in this family. */
  version_count: number;
  /** Rollup: when the family last had a version published. */
  last_published_at: FirestoreTimestampType | null;
  /** Optimistic-concurrency token. */
  version: number;
  created_by: ActorRefType;
  updated_by: ActorRefType;
  created_at?: FirestoreTimestampType;
  updated_at?: FirestoreTimestampType;
}

/** Zod schema for a TemplateComponent family document. */
export const TemplateComponentSchema: z.ZodType<TemplateComponent> = z.strictObject({
  uid: FirestoreId,
  git_path: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
  uid_active: FirestoreId.nullable(),
  draft_uids: z.array(FirestoreId).default([]),
  version_count: z.int().min(0).default(0),
  last_published_at: FirestoreTimestamp.nullable(),
  version: z.int().min(0).default(0),
  created_by: ActorRef,
  updated_by: ActorRef,
  ...TimestampFields,
}).meta({
  title: "Template Component",
  collection: "template-components",
  displayDefaults: {
    columns: ["name", "version_count"],
    filters: {},
    sort: { column: "name", direction: "asc" },
  },
});

/** Input for registering a new template-component family. */
export interface TemplateComponentInputType {
  name: string;
}

/** Zod schema for TemplateComponentInput. */
export const TemplateComponentInputSchema: z.ZodType<TemplateComponentInputType> = z.object({
  name: z.string().min(1).max(200),
});
