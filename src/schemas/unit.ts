/**
 * Serialized units — the primitives a unit number and its serial are checked
 * against wherever they appear.
 *
 * Today this module holds only the two scalars that movements already carry
 * (`MovementUnit` in `src/schemas/transaction.ts`). The `units` document, its
 * roster and their inputs land here next
 * (`api-cloudrun/.claude/plans/serial-tracking.md` § *Schemas (core)*, phase P2). The
 * dependency runs one way: `src/schemas/transaction.ts` imports from here, never the
 * reverse, so the unit document can later name movements without a cycle.
 *
 * The id, `UnitId` (`unit-{number}`), lives with every other id shape in
 * `_uid.ts`.
 *
 * @module
 */

import { z } from "zod";

/**
 * A unit's number: the asset tag the operator reads off the unit, and the
 * unit's identity (owner ruling 2026-09-21). Globally unique across products.
 */
export const UnitNumber: z.ZodType<number> = z.int().min(1);

/**
 * A manufacturer serial. A changeable ATTRIBUTE of a unit number, never its
 * identity: a replaced radio keeps its number and takes a new serial.
 */
export const SerialNumber: z.ZodType<string> = z.string().min(1).max(100);
