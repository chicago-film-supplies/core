/**
 * HolidayDates document schema — Firestore collection: holiday-dates
 */
import { z } from "zod";
import { FirestoreId } from "./_uid.ts";
import { FirestoreTimestamp, type FirestoreTimestampType } from "./common.ts";

/** Full Firestore document for a single holiday date entry. */
export interface HolidayDates {
  uid: string;
  uid_holiday: string;
  date: string;
  date_fs: FirestoreTimestampType;
  name: string;
  type: "fixed" | "variable";
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}

/** Zod schema for HolidayDates. */
export const HolidayDatesSchema: z.ZodType<HolidayDates> = z.strictObject({
  uid: FirestoreId,
  uid_holiday: FirestoreId,
  date: z.iso.date().meta({ column: true, label: "Date" }),
  date_fs: FirestoreTimestamp,
  name: z.string().min(1).max(100).meta({ column: true, label: "Name" }),
  type: z.enum(["fixed", "variable"]),
  created_at: FirestoreTimestamp,
  updated_at: FirestoreTimestamp,
}).meta({
  title: "Holiday Dates",
  collection: "holiday-dates",
  displayDefaults: {
    columns: ["name", "date"],
    filters: {},
    sort: { column: "date", direction: "asc" },
  },
});
