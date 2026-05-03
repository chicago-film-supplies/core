/**
 * Schema factories that accept any valid ISO datetime string and
 * canonicalize the parsed output to Chicago offset form
 * (`YYYY-MM-DDTHH:MM:SS.sss±HH:MM`). Used in every schema file where
 * `z.iso.datetime({ offset: true })` was previously used.
 *
 * The runtime transforms are duplicated from `@cfs/utilities/dates`
 * (`toChicagoInstant` / `toChicagoStartOfDay`) to avoid a cross-package
 * runtime dependency. They MUST produce identical output — the parity
 * test in `tests/_datetime.test.ts` enforces this against the
 * utilities-next fixtures.
 *
 * @module
 */

import { z } from "zod";
import { parseISO, startOfDay } from "date-fns";
import { tz } from "@date-fns/tz";

/**
 * Canonicalize any valid ISO datetime string to Chicago offset form,
 * preserving the instant. Idempotent.
 */
export function toChicagoInstant(input: string): string {
  return parseISO(input, { in: tz("America/Chicago") }).toISOString();
}

/**
 * Canonicalize to Chicago local midnight for the calendar date containing
 * the input instant. Idempotent.
 */
export function toChicagoStartOfDay(input: string): string {
  return startOfDay(parseISO(input, { in: tz("America/Chicago") }))
    .toISOString();
}

/**
 * Factory for "true instant" datetime fields (transaction.date,
 * tax.valid_from, order.dates.*, etc.). Input must be a valid ISO
 * datetime string with an offset; output is Chicago offset form.
 */
export const chicagoInstant = (): z.ZodType<string, string> =>
  z.iso.datetime({ offset: true }).transform(toChicagoInstant);

/**
 * Factory for "calendar date" datetime fields (invoice.date,
 * invoice.due_date, payments[].date). Input must be a valid ISO
 * datetime string with an offset; output is Chicago local midnight
 * in offset form.
 */
export const chicagoStartOfDay = (): z.ZodType<string, string> =>
  z.iso.datetime({ offset: true }).transform(toChicagoStartOfDay);
