/**
 * HolidayDefinition document schema — Firestore collection: holiday-definitions
 *
 * One document per holiday *rule* (e.g. "Christmas Day" / "3rd Monday in
 * January"). Replaces the legacy embedded `config/{singleton}.holidays[]`
 * array. Date *instances* derived from each rule live in the top-level
 * `holiday-dates` collection (see `holiday-dates.ts`).
 *
 * The **document** is a flat object (not a discriminated union) so it works
 * with the generic collection tooling — `validatedSet`/`validateBeforeWrite`
 * resolve it by collection name, and the display-defaults / manager column
 * walkers assume a `ZodObject` shape. The fixed/variable XOR is enforced at
 * the API boundary instead, via the discriminated-union *input* schemas below
 * (which are never column-walked). The server derives `js_month`,
 * `display_day`, and `display_suffix` from the input on write.
 */
import { z } from "zod";
import {
  ActorRef,
  type ActorRefType,
  type FirestoreTimestampType,
  TimestampFields,
} from "./common.ts";
import { FirestoreId } from "./_uid.ts";

/** Holiday rule discriminator. */
export type HolidayType = "fixed" | "variable";

/**
 * A holiday definition document in Firestore (collection: holiday-definitions).
 *
 * `type: "fixed"` rules carry `date` (day-of-month); `type: "variable"` rules
 * carry `day`/`display_day`/`week`/`display_suffix` (e.g. "3rd Monday"). The
 * variant fields are optional on the document because both shapes share one
 * collection; the input schemas guarantee the correct set per type.
 */
export interface HolidayDefinition {
  uid: string;
  type: HolidayType;
  name: string;
  /** Human month, 1-12. */
  display_month: number;
  /** JS `Date` month, 0-11 (`display_month - 1`). */
  js_month: number;
  /** Day-of-month, 1-31. Present when `type === "fixed"`. */
  date?: number;
  /** JS `getDay()` weekday, "0".."6". Present when `type === "variable"`. */
  day?: string;
  /** Weekday display name, e.g. "Monday". Present when `type === "variable"`. */
  display_day?: string;
  /** Ordinal week, "1".."4" | "last". Present when `type === "variable"`. */
  week?: string;
  /** Ordinal suffix, e.g. "rd". Present when `type === "variable"`. */
  display_suffix?: string;
  /** Soft-delete flag — a deactivated rule keeps its record but stops generating future instances. */
  active: boolean;
  /** Optimistic-lock version, bumped on every edit. */
  version: number;
  created_by: ActorRefType;
  updated_by: ActorRefType;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}

/** Zod schema for HolidayDefinition. */
export const HolidayDefinitionSchema: z.ZodType<HolidayDefinition> = z.strictObject({
  uid: FirestoreId,
  type: z.enum(["fixed", "variable"]),
  name: z.string().min(1).max(100),
  display_month: z.int().min(1).max(12),
  js_month: z.int().min(0).max(11),
  date: z.int().min(1).max(31).optional(),
  day: z.string().min(1).max(2).optional(),
  display_day: z.string().min(1).max(10).optional(),
  week: z.string().min(1).max(4).optional(),
  display_suffix: z.string().min(1).max(2).optional(),
  active: z.boolean().default(true),
  version: z.int().min(0).default(0),
  created_by: ActorRef,
  updated_by: ActorRef,
  ...TimestampFields,
}).meta({
  title: "Holiday Definition",
  collection: "holiday-definitions",
  displayDefaults: {
    columns: ["name", "type", "display_month"],
    filters: {},
    sort: { column: "display_month", direction: "asc" },
  },
});

// ── Input schemas (discriminated union, API boundary) ────────────────

/** Ordinal-week selector for a variable holiday — string or numeric form. */
export type HolidayWeekInputType = "1" | "2" | "3" | "4" | "last" | 1 | 2 | 3 | 4;
const HolidayWeekInput = z.union([
  z.literal("1"),
  z.literal("2"),
  z.literal("3"),
  z.literal("4"),
  z.literal("last"),
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
]);

/** Input type for creating a fixed-date holiday. */
export interface CreateFixedHolidayInputType {
  uid?: string;
  type: "fixed";
  name: string;
  /** Human month, 1-12. */
  month: number;
  /** Day-of-month, 1-31. */
  date: number;
}
/** Input type for creating a variable-date holiday. */
export interface CreateVariableHolidayInputType {
  uid?: string;
  type: "variable";
  name: string;
  /** Human month, 1-12. */
  month: number;
  /** JS `getDay()` weekday, 0-6. */
  day: number;
  /** Ordinal week within the month. */
  week: HolidayWeekInputType;
}
/** Input type for creating a holiday definition. */
export type CreateHolidayDefinitionInputType =
  | CreateFixedHolidayInputType
  | CreateVariableHolidayInputType;

/** Input schema for creating a holiday definition. */
export const CreateHolidayDefinitionInput: z.ZodType<CreateHolidayDefinitionInputType> = z
  .discriminatedUnion("type", [
    z.object({
      uid: FirestoreId.optional(),
      type: z.literal("fixed"),
      name: z.string().min(1).max(100),
      month: z.int().min(1).max(12),
      date: z.int().min(1).max(31),
    }),
    z.object({
      uid: FirestoreId.optional(),
      type: z.literal("variable"),
      name: z.string().min(1).max(100),
      month: z.int().min(1).max(12),
      day: z.int().min(0).max(6),
      week: HolidayWeekInput,
    }),
  ]);

/** Input type for updating a fixed-date holiday (full rule replacement). */
export interface UpdateFixedHolidayInputType {
  uid: string;
  version: number;
  type: "fixed";
  name: string;
  month: number;
  date: number;
}
/** Input type for updating a variable-date holiday (full rule replacement). */
export interface UpdateVariableHolidayInputType {
  uid: string;
  version: number;
  type: "variable";
  name: string;
  month: number;
  day: number;
  week: HolidayWeekInputType;
}
/** Input type for updating a holiday definition. Carries `version` for the optimistic-lock check. */
export type UpdateHolidayDefinitionInputType =
  | UpdateFixedHolidayInputType
  | UpdateVariableHolidayInputType;

/** Input schema for updating a holiday definition (in-place edit, version-checked). */
export const UpdateHolidayDefinitionInput: z.ZodType<UpdateHolidayDefinitionInputType> = z
  .discriminatedUnion("type", [
    z.object({
      uid: FirestoreId,
      version: z.int().min(0),
      type: z.literal("fixed"),
      name: z.string().min(1).max(100),
      month: z.int().min(1).max(12),
      date: z.int().min(1).max(31),
    }),
    z.object({
      uid: FirestoreId,
      version: z.int().min(0),
      type: z.literal("variable"),
      name: z.string().min(1).max(100),
      month: z.int().min(1).max(12),
      day: z.int().min(0).max(6),
      week: HolidayWeekInput,
    }),
  ]);
