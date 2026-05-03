/**
 * PII classification enforcement test.
 *
 * Walks document and input schemas, asserts that fields matching sensitive
 * key patterns always carry a `.meta({ pii })` annotation.
 */
import { assertEquals } from "@std/assert";
import type { z } from "zod";

import { getNodeMeta, unwrapZod } from "../src/zod-walk.ts";
import { ContactSchema, CreateContactInput, UpdateContactInput } from "../src/contact.ts";
import {
  OrganizationSchema,
  CreateOrganizationInput,
  UpdateOrganizationInput,
  NewContactInput,
} from "../src/organization.ts";
import {
  OrderSchema,
  CreateOrderInput,
  UpdateOrderInput,
} from "../src/order.ts";
import { InvoiceSchema } from "../src/invoice.ts";
import { BookingSchema } from "../src/booking.ts";
import { UserSchema } from "../src/user.ts";
import { LoginInput, RegisterInput, ResetPasswordInput, EmailInput } from "../src/auth.ts";
import { LogRecordSchema } from "../src/log.ts";

// ── Sensitive field patterns ─────────────────────────────────────────

/** Fields that MUST have a `pii` meta value when they appear at any depth. */
const SENSITIVE_EXACT = new Set([
  "email",
  "emails",
  "password",
  "password_hash",
  "token",
  "user_id",
  "phones",
  "billing_address",
  "address",
  "external_notes",
  "internal_notes",
]);

/** Field names that require `pii` when they appear in contact/org/user-adjacent schemas. */
const SENSITIVE_NAME_FIELD = "name";

// ── Helpers ──────────────────────────────────────────────────────────

type WrapperDef = { type: string; innerType?: z.ZodType; element?: z.ZodType };

/**
 * True when the schema (or any wrapper in its chain) carries a `pii` meta
 * value. `.meta()` registers on the specific instance it's called on, so
 * `z.email().meta({ pii: "mask" }).nullable()` stores the meta on the email
 * node — we must check at every wrapper level, not just the leaf.
 */
function hasPii(schema: z.ZodType): boolean {
  let n: z.ZodType = schema;
  while (true) {
    if (getNodeMeta(n)?.pii) return true;
    const def = (n as unknown as { _zod: { def: WrapperDef } })._zod.def;
    if (
      (def.type === "optional" || def.type === "default" || def.type === "nullable") &&
      def.innerType
    ) {
      n = def.innerType;
      continue;
    }
    if (def.type === "array" && def.element) return hasPii(def.element);
    return false;
  }
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
