/**
 * PII classification enforcement test.
 *
 * Walks document and input schemas, asserts that fields matching sensitive
 * key patterns always carry a `.meta({ pii })` annotation.
 */
import { assertEquals } from "@std/assert";
import type { z } from "zod";

import { unwrapNonArray, unwrapZod } from "../src/schemas/zod-walk.ts";
import { readPiiTag } from "../src/schemas/pii/walker.ts";
import { ContactSchema, CreateContactInput, UpdateContactInput } from "../src/schemas/contact.ts";
import {
  OrganizationSchema,
  CreateOrganizationInput,
  UpdateOrganizationInput,
  NewContactInput,
} from "../src/schemas/organization.ts";
import {
  OrderSchema,
  CreateOrderInput,
  UpdateOrderInput,
} from "../src/schemas/order.ts";
import { InvoiceSchema } from "../src/schemas/invoice.ts";
import { BookingSchema } from "../src/schemas/booking.ts";
import { UserSchema } from "../src/schemas/user.ts";
import { LoginInput, RegisterInput, ResetPasswordInput, EmailInput } from "../src/schemas/auth.ts";
import { LogRecordSchema } from "../src/schemas/log/mod.ts";
import { SENSITIVE_EXACT, SENSITIVE_NAME_FIELD } from "../src/schemas/pii/dictionary.ts";

// The sensitive-field dictionary lives in `src/pii/dictionary.ts` (promoted
// from this file 2026-05-27 so the runtime PII scrubber and this test
// agree on the canonical set). Test logic is unchanged.

// ── Helpers ──────────────────────────────────────────────────────────

type WrapperDef = { type: string; innerType?: z.ZodType; element?: z.ZodType };

/**
 * True when the schema (or any wrapper in its chain) carries a `pii` meta
 * value. `.meta()` registers on the specific instance it's called on, so
 * `z.email().meta({ pii: "mask" }).nullable()` stores the meta on the email
 * node — we must check at every wrapper level, not just the leaf.
 *
 * Delegates to `readPiiTag`, the SAME reader the runtime walker uses. This used
 * to be a private wrapper-chain walk here while the walker unwrapped first and
 * read only the final node — so this test stayed green on `Address`'s
 * `.nullable().meta({pii:"mask"})` while `applyPii` never saw the tag at all.
 * One reader, or the guard does not guard.
 */
function hasPii(schema: z.ZodType): boolean {
  if (readPiiTag(schema) !== undefined) return true;
  // `readPiiTag` stops at a ZodArray (an array's element tag is read separately
  // by the walker); an array field like `z.array(Phone).optional()` is tagged on
  // its element, so unwrap to the array node and recurse into it.
  const def = (unwrapNonArray(schema) as unknown as { _zod: { def: WrapperDef } })._zod.def;
  if (def.type === "array" && def.element) return hasPii(def.element);
  return false;
}

function getShape(schema: z.ZodType): Record<string, z.ZodType> | null {
  const unwrapped = unwrapZod(schema);
  const def = (unwrapped as unknown as { _zod: { def: { shape?: Record<string, z.ZodType> } } })._zod.def;
  return def.shape ?? null;
}

// ── Collect violations ───────────────────────────────────────────────

interface Violation {
  schema: string;
  field: string;
}

function checkSchema(
  schemaName: string,
  schema: z.ZodType,
  nameIsSensitive: boolean,
): Violation[] {
  const violations: Violation[] = [];
  const shape = getShape(schema);
  if (!shape) return violations;

  for (const [key, fieldSchema] of Object.entries(shape)) {
    const isSensitive =
      SENSITIVE_EXACT.has(key) ||
      (key === SENSITIVE_NAME_FIELD && nameIsSensitive);

    if (isSensitive && !hasPii(fieldSchema)) {
      violations.push({ schema: schemaName, field: key });
    }

    // Recurse into nested objects (denormalized org, destinations, etc.)
    // Don't flag `name` inside nested objects — those are typically labels
    // (e.g. address.name), not person/org names.
    const innerShape = getShape(unwrapZod(fieldSchema));
    if (innerShape) {
      for (const [nestedKey, nestedSchema] of Object.entries(innerShape)) {
        if (!SENSITIVE_EXACT.has(nestedKey)) continue;
        if (!hasPii(nestedSchema)) {
          violations.push({ schema: schemaName, field: `${key}.${nestedKey}` });
        }
      }
    }
  }

  return violations;
}

// ── Tests ────────────────────────────────────────────────────────────

const ALL_SCHEMAS: [string, z.ZodType, boolean][] = [
  // [name, schema, whether `name` field is PII-sensitive]
  ["ContactSchema", ContactSchema, true],
  ["CreateContactInput", CreateContactInput, true],
  ["UpdateContactInput", UpdateContactInput, true],
  ["OrganizationSchema", OrganizationSchema, true],
  ["CreateOrganizationInput", CreateOrganizationInput, true],
  ["UpdateOrganizationInput", UpdateOrganizationInput, true],
  ["NewContactInput", NewContactInput, true],
  ["OrderSchema", OrderSchema, false],
  ["CreateOrderInput", CreateOrderInput, false],
  ["UpdateOrderInput", UpdateOrderInput, false],
  ["InvoiceSchema", InvoiceSchema, false],
  ["BookingSchema", BookingSchema, false],
  ["UserSchema", UserSchema, false],
  ["LoginInput", LoginInput, false],
  ["RegisterInput", RegisterInput, false],
  ["ResetPasswordInput", ResetPasswordInput, false],
  ["EmailInput", EmailInput, false],
  ["LogRecordSchema", LogRecordSchema, false],
];

Deno.test("sensitive fields have PII meta annotations", () => {
  const allViolations: Violation[] = [];

  for (const [name, schema, nameIsSensitive] of ALL_SCHEMAS) {
    allViolations.push(...checkSchema(name, schema, nameIsSensitive));
  }

  assertEquals(
    allViolations,
    [],
    `Fields missing pii meta:\n${allViolations.map((v) => `  ${v.schema}.${v.field}`).join("\n")}`,
  );
});
