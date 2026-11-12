/**
 * Every `BOOKING_CORE` field (`schemas/booking.ts`) is the SAME INSTANCE on each
 * booking schema — the fourth member of the family `tests/totals-parity.test.ts`
 * documents, and for the same reason: a re-declared twin carries none of the
 * base's `.meta()` (the registry is keyed on the instance), so its headings
 * vanish while a structural comparison stays green.
 *
 * The outbound `BookingSchema` is the only grain until the 7a contract beta adds
 * `InboundBookingSchema`; add it to `GRAINS` then.
 */
import { assertEquals } from "@std/assert";
import { BOOKING_CORE } from "../src/schemas/booking.ts";
import { BookingSchema } from "../src/schemas/mod.ts";

// deno-lint-ignore no-explicit-any
function shapeOf(schema: unknown, label: string): Record<string, any> {
  // deno-lint-ignore no-explicit-any
  const def = (schema as any)?._zod?.def;
  assertEquals(def?.type, "object", `${label}: not an object schema`);
  return def.shape;
}

const GRAINS = [["BookingSchema", BookingSchema]] as const;

Deno.test("booking core parity: every BOOKING_CORE field is the SAME INSTANCE on every grain", () => {
  const wrong: string[] = [];
  for (const [label, schema] of GRAINS) {
    const shape = shapeOf(schema, label);
    for (const [key, node] of Object.entries(BOOKING_CORE)) {
      if (shape[key] !== node) wrong.push(`${label}.${key}`);
    }
  }
  assertEquals(wrong, [], "re-declared instead of referenced from BOOKING_CORE");
});

Deno.test("booking core parity is self-verifying: a re-declared twin is caught", () => {
  const twin = { ...shapeOf(BookingSchema, "BookingSchema"), quantity: BOOKING_CORE.quantity.meta({}) };
  assertEquals(twin.quantity === BOOKING_CORE.quantity, false);
});
