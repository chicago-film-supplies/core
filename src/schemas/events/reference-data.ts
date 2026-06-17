/**
 * Reference data events.
 *
 * Covers: tags, tracking-categories, templates, holiday-dates, chart-of-accounts.
 * These are low-velocity collections that change infrequently.
 */
import type { EventEnvelope } from "./common.ts";
import type { Tag } from "../tag.ts";
import type { TrackingCategory } from "../tracking-category.ts";
import type { Template } from "../template.ts";
import type { HolidayDates } from "../holiday-dates.ts";
import type { ChartOfAccounts } from "../chart-of-accounts.ts";

// ── Tag events ─────────────────────────────────────────────────────

export type TagCreated = EventEnvelope<Tag> & { event: "tag.created" };
export type TagUpdated = EventEnvelope<Tag> & { event: "tag.updated" };
export type TagDeleted = EventEnvelope<Tag> & { event: "tag.deleted" };

// ── Tracking category events ───────────────────────────────────────

export type TrackingCategoryCreated = EventEnvelope<TrackingCategory> & { event: "tracking_category.created" };
export type TrackingCategoryUpdated = EventEnvelope<TrackingCategory> & { event: "tracking_category.updated" };

// ── Template events ────────────────────────────────────────────────

export type TemplateCreated = EventEnvelope<Template> & { event: "template.created" };
export type TemplateUpdated = EventEnvelope<Template> & { event: "template.updated" };

// ── Holiday dates events ───────────────────────────────────────────

export type HolidayDatesAdded = EventEnvelope<HolidayDates> & { event: "holiday_dates.added" };
export type HolidayDatesDeleted = EventEnvelope<HolidayDates> & { event: "holiday_dates.deleted" };

// ── Chart of accounts events ───────────────────────────────────────

export type ChartOfAccountsUpdated = EventEnvelope<ChartOfAccounts> & { event: "chart_of_accounts.updated" };
