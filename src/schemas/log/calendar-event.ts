/**
 * Google Calendar sync archetype — emitted by `api-cloudrun/src/lib/calendar.ts` and
 * `api-cloudrun/src/services/calendarUpdate.ts`. Each event card maps to one event on
 * a shared CFS calendar, at an id derived from the card uid; these msgs cover the
 * sync lifecycle.
 *
 * **PII posture**: none. Card uids and calendar ids are opaque ids.
 */

import { z } from "zod";
import { baseLogFields, type LogLevelType } from "./base.ts";

/** Msg literals this archetype absorbs. */
export const CALENDAR_EVENT_MSGS = [
  "calendar_event_not_found",
  "calendar_missing_date",
  "calendar_not_configured",
  "calendar_not_found",
] as const;

/** Discriminated msg union for Calendar-archetype log records. */
export type CalendarEventMsg = (typeof CALENDAR_EVENT_MSGS)[number];

/** Structured log entry for any Google Calendar sync event. */
export interface CalendarEventLogRecord {
  level: LogLevelType;
  msg: CalendarEventMsg;
  ts: string;
  card_uid?: string;
  calendar_id?: string;
  request_id?: string;
  method?: string;
  path?: string;
  route?: string;
  user_id?: string;
  trace_id?: string;
  span_id?: string;
  [key: string]: unknown;
}

/** Zod schema for {@link CalendarEventLogRecord}. */
export const CalendarEventLogRecordSchema: z.ZodType<CalendarEventLogRecord> = z.object({
  ...baseLogFields,
  msg: z.enum(CALENDAR_EVENT_MSGS),
  card_uid: z.string().optional(),
  calendar_id: z.string().optional(),
}).passthrough().meta({ title: "CalendarEventLogRecord" });
