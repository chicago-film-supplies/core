/**
 * The ratchet for § *Document vs input schemas* in `CLAUDE.md`: an INPUT schema
 * strips unknown keys rather than refusing them, nested objects included.
 *
 * 🔴 **The rule was written down and not enforced, and a breach of it is a 400
 * on a round-trip.** `UpdateProductInput.components[]` reused the storage
 * `z.strictObject`, so a product the API wrote could not be PUT back — the
 * server-derived `price_overridden` was refused on echo (api-cloudrun#879), and
 * manager carried a client-side strip to get around it.
 *
 * The products nodes are converted. Everything else is FROZEN rather than
 * converted: {@link FROZEN} is today's set of strict nodes reachable from an
 * `*Input` export, pinned EXACTLY, so this fails on an addition (a new breach)
 * and on a removal (a conversion — delete the entry). ⚠️ **The list is debt,
 * not license.** Five order/invoice divider arms are strict on purpose and
 * pinned by API tests; the rest await one conversion campaign, each node
 * needing a stripping twin because most are shared with stored schemas.
 *
 * Paths are counted per PATH, not per node: a shared `Address` reached through
 * six keys is six entries, because each is a separate place a client can send
 * an unknown key. A union member is named by its discriminator value where it
 * has one — `items[](type=group)` — otherwise by its index, `(#0)`.
 */
import { assertEquals } from "@std/assert";
import { z } from "zod";
import * as mod from "../src/schemas/mod.ts";

// deno-lint-ignore no-explicit-any
const defOf = (n: any) => n._zod.def;
// deno-lint-ignore no-explicit-any
const isZodNode = (n: any): boolean => n?._zod?.def !== undefined;

/** A union member's label: `(<discriminator>=<value>)` when it has one, else `(#<index>)`. */
// deno-lint-ignore no-explicit-any
function unionLabel(unionDef: any, option: any, i: number): string {
  const key: string | undefined = unionDef.discriminator;
  const member = key && isZodNode(option) ? defOf(option).shape?.[key] : undefined;
  const values: unknown[] | undefined = member?._zod?.values ? [...member._zod.values] : undefined;
  return values?.length === 1 ? `(${key}=${String(values[0])})` : `(#${i})`;
}

// deno-lint-ignore no-explicit-any
function walk(node: any, path: string, stack: Set<unknown>, out: string[]): void {
  if (!isZodNode(node) || stack.has(node)) return;
  stack.add(node);
  try {
    const def = defOf(node);
    switch (def.type) {
      case "optional":
      case "nullable":
      case "default":
      case "prefault":
      case "readonly":
      case "nonoptional":
      case "catch":
      case "promise":
        walk(def.innerType, path, stack, out);
        return;
      case "pipe":
        // `.in` only — the input side is what a client's payload meets.
        walk(def.in, path, stack, out);
        return;
      case "lazy":
        walk(def.getter(), path, stack, out);
        return;
      case "object":
        if (isZodNode(def.catchall) && defOf(def.catchall).type === "never") out.push(path || "<root>");
        for (const [key, member] of Object.entries(def.shape ?? {})) {
          walk(member, path ? `${path}.${key}` : key, stack, out);
        }
        return;
      case "array":
        walk(def.element, `${path}[]`, stack, out);
        return;
      case "tuple":
        (def.items ?? []).forEach((item: unknown, i: number) => walk(item, `${path}[${i}]`, stack, out));
        if (def.rest) walk(def.rest, `${path}[...]`, stack, out);
        return;
      case "union":
        (def.options ?? []).forEach((opt: unknown, i: number) =>
          walk(opt, `${path}${unionLabel(def, opt, i)}`, stack, out)
        );
        return;
      case "intersection":
        walk(def.left, path, stack, out);
        walk(def.right, path, stack, out);
        return;
      case "record":
      case "map":
        walk(def.valueType, `${path}{}`, stack, out);
        return;
      case "set":
        walk(def.valueType, `${path}{set}`, stack, out);
        return;
      default:
        return;
    }
  } finally {
    stack.delete(node);
  }
}

/** Every `<input> <path>` at which an `*Input` export of `exports` holds a strict object. */
function inputStrictPaths(exports: Record<string, unknown>): { inputs: string[]; paths: Set<string> } {
  const inputs: string[] = [];
  const paths = new Set<string>();
  for (const [name, value] of Object.entries(exports)) {
    if (!name.endsWith("Input") || !isZodNode(value)) continue;
    inputs.push(name);
    const out: string[] = [];
    walk(value, "", new Set(), out);
    for (const p of out) paths.add(`${name} ${p}`);
  }
  return { inputs, paths };
}

function diff(found: Set<string>): { added: string[]; removed: string[] } {
  return {
    added: [...found].filter((p) => !FROZEN.has(p)).sort(),
    removed: [...FROZEN].filter((p) => !found.has(p)).sort(),
  };
}

/**
 * Strict nodes reachable from an `*Input` export, as of 2026-10-25 — 138 paths
 * across 25 inputs, after products' 12 were converted (api-cloudrun#879).
 *
 * ⚠️ **Do not add to this list to make a red run green.** A new entry means a
 * new input reuses a storage `z.strictObject`; give it a stripping twin instead
 * (`.strip()` on the object, which keeps its checks — never
 * `z.object(X.shape)`, which drops them — and re-apply any object-level
 * `.meta()`, e.g. `Address`'s `pii: "mask"`). Nested strict children need
 * their own `.strip()`.
 *
 * Open rulings the conversion campaign must settle rather than sweep:
 * - the order/invoice divider arms (`items[](type=…)`) are strict ON PURPOSE —
 *   a divider carrying line fields is refused, and API tests pin the 400;
 * - the out-of-service destination arm and the store-transfer `oos` block are
 *   each pinned by a single test, so whether strictness there is a ruling or an
 *   accident is unrecorded.
 */
const FROZEN: ReadonlySet<string> = new Set([
  "CreateCardInput attachments[]",
  "CreateCardInput dates",
  "CreateCardInput destination",
  "CreateCardInput destination.address",
  "CreateCardInput destination.address.address_coordinates",
  "CreateCardInput destination.address.user_coordinates",
  "CreateCardInput destination.contact",
  "CreateCardInput organization",
  "CreateCardInput organization.path[]",
  "CreateCardInput sources[]",
  "CreateContactInput organizations[]",
  "CreateInvoiceInput destinations[]",
  "CreateInvoiceInput destinations[].collection",
  "CreateInvoiceInput destinations[].collection.address",
  "CreateInvoiceInput destinations[].collection.address.address_coordinates",
  "CreateInvoiceInput destinations[].collection.address.user_coordinates",
  "CreateInvoiceInput destinations[].collection.contact",
  "CreateInvoiceInput destinations[].dates",
  "CreateInvoiceInput destinations[].dates.charge_windows[]",
  "CreateInvoiceInput destinations[].delivery",
  "CreateInvoiceInput destinations[].delivery.address",
  "CreateInvoiceInput destinations[].delivery.address.address_coordinates",
  "CreateInvoiceInput destinations[].delivery.address.user_coordinates",
  "CreateInvoiceInput destinations[].delivery.contact",
  "CreateInvoiceInput destinations[].exchange",
  "CreateInvoiceInput items[](#0).substituted_for[]",
  "CreateInvoiceInput items[](type=destination)",
  "CreateInvoiceInput items[](type=group)",
  "CreateInvoiceInput items[](type=order)",
  "CreateOrderInput destinations[].collection.address",
  "CreateOrderInput destinations[].collection.address.address_coordinates",
  "CreateOrderInput destinations[].collection.address.user_coordinates",
  "CreateOrderInput destinations[].delivery.address",
  "CreateOrderInput destinations[].delivery.address.address_coordinates",
  "CreateOrderInput destinations[].delivery.address.user_coordinates",
  "CreateOrderInput destinations[].exchange",
  "CreateOrderInput items[](#0).exchanged_for[]",
  "CreateOrderInput items[](type=destination)",
  "CreateOrderInput items[](type=group)",
  "CreateOrganizationInput billing_address",
  "CreateOrganizationInput billing_address.address_coordinates",
  "CreateOrganizationInput billing_address.user_coordinates",
  "CreateOrganizationInput contacts[]",
  "CreateOutOfServiceInput destination(kind=address)",
  "CreateOutOfServiceInput destination(kind=address).address",
  "CreateOutOfServiceInput destination(kind=address).address.address_coordinates",
  "CreateOutOfServiceInput destination(kind=address).address.user_coordinates",
  "CreateOutOfServiceInput destination(kind=uid)",
  "CreateOutOfServiceInput sources[]",
  "CreatePurchaseBillInput (mode=push).direct_lines[]",
  "CreatePurchaseCreditInput (mode=push).direct_lines[]",
  "CreateRecurrenceInput prototype.attachments[]",
  "CreateRecurrenceInput prototype.destination",
  "CreateRecurrenceInput prototype.destination.address",
  "CreateRecurrenceInput prototype.destination.address.address_coordinates",
  "CreateRecurrenceInput prototype.destination.address.user_coordinates",
  "CreateRecurrenceInput prototype.destination.contact",
  "CreateRecurrenceInput prototype.sources[]",
  "CreateRecurrenceInput rule",
  "CreateStoreTransferInput lines[]",
  "CreateStoreTransferInput lines[].oos",
  "CreateTaxCodeInput first_rate.xero_components[]",
  "CreateTaxRateInput xero_components[]",
  "ExtendRentalInput collection.address",
  "ExtendRentalInput collection.address.address_coordinates",
  "ExtendRentalInput collection.address.user_coordinates",
  "OOSDestinationInput (kind=address)",
  "OOSDestinationInput (kind=address).address",
  "OOSDestinationInput (kind=address).address.address_coordinates",
  "OOSDestinationInput (kind=address).address.user_coordinates",
  "OOSDestinationInput (kind=uid)",
  "StoreTransferLineInput <root>",
  "StoreTransferLineInput oos",
  "UpdateCardInput attachments[]",
  "UpdateCardInput dates",
  "UpdateCardInput destination",
  "UpdateCardInput destination.address",
  "UpdateCardInput destination.address.address_coordinates",
  "UpdateCardInput destination.address.user_coordinates",
  "UpdateCardInput destination.contact",
  "UpdateCardInput organization",
  "UpdateCardInput organization.path[]",
  "UpdateCardInput sources[]",
  "UpdateContactInput organizations[]",
  "UpdateFulfillmentItemsInput lineItems[].exchanged_for[]",
  "UpdateFulfillmentItemsInput lineItems[].substituted_for[]",
  "UpdateInvoiceInput destinations[]",
  "UpdateInvoiceInput destinations[].collection",
  "UpdateInvoiceInput destinations[].collection.address",
  "UpdateInvoiceInput destinations[].collection.address.address_coordinates",
  "UpdateInvoiceInput destinations[].collection.address.user_coordinates",
  "UpdateInvoiceInput destinations[].collection.contact",
  "UpdateInvoiceInput destinations[].dates",
  "UpdateInvoiceInput destinations[].dates.charge_windows[]",
  "UpdateInvoiceInput destinations[].delivery",
  "UpdateInvoiceInput destinations[].delivery.address",
  "UpdateInvoiceInput destinations[].delivery.address.address_coordinates",
  "UpdateInvoiceInput destinations[].delivery.address.user_coordinates",
  "UpdateInvoiceInput destinations[].delivery.contact",
  "UpdateInvoiceInput destinations[].exchange",
  "UpdateInvoiceInput items[](#0).substituted_for[]",
  "UpdateInvoiceInput items[](type=destination)",
  "UpdateInvoiceInput items[](type=group)",
  "UpdateInvoiceInput items[](type=order)",
  "UpdateOrderInput destinations[].collection.address",
  "UpdateOrderInput destinations[].collection.address.address_coordinates",
  "UpdateOrderInput destinations[].collection.address.user_coordinates",
  "UpdateOrderInput destinations[].delivery.address",
  "UpdateOrderInput destinations[].delivery.address.address_coordinates",
  "UpdateOrderInput destinations[].delivery.address.user_coordinates",
  "UpdateOrderInput destinations[].exchange",
  "UpdateOrderInput items[](#0).exchanged_for[]",
  "UpdateOrderInput items[](type=destination)",
  "UpdateOrderInput items[](type=group)",
  "UpdateOrganizationInput billing_address",
  "UpdateOrganizationInput billing_address.address_coordinates",
  "UpdateOrganizationInput billing_address.user_coordinates",
  "UpdateOrganizationInput contacts[]",
  "UpdateOutOfServiceInput breakdown",
  "UpdateOutOfServiceInput destination(kind=address)",
  "UpdateOutOfServiceInput destination(kind=address).address",
  "UpdateOutOfServiceInput destination(kind=address).address.address_coordinates",
  "UpdateOutOfServiceInput destination(kind=address).address.user_coordinates",
  "UpdateOutOfServiceInput destination(kind=uid)",
  "UpdateOutOfServiceInput units",
  "UpdateRecurrenceInput prototype.attachments[]",
  "UpdateRecurrenceInput prototype.destination",
  "UpdateRecurrenceInput prototype.destination.address",
  "UpdateRecurrenceInput prototype.destination.address.address_coordinates",
  "UpdateRecurrenceInput prototype.destination.address.user_coordinates",
  "UpdateRecurrenceInput prototype.destination.contact",
  "UpdateRecurrenceInput prototype.sources[]",
  "UpdateRecurrenceInput rule",
  "UpdateTemplateVersionInput params[]",
  "UpdateUserInput prefs_firestore{}",
  "UpdateUserInput prefs_firestore{}.sort",
  "UpdateUserInput prefs_typesense{}",
  "UpdateUserInput prefs_typesense{}.sort",
]);

Deno.test("the strict nodes reachable from an *Input export are exactly the frozen list", () => {
  const { inputs, paths } = inputStrictPaths(mod);
  // Denominator: a walk that stopped reaching the barrel would report "clean".
  assertEquals(inputs.length >= 90, true, `only ${inputs.length} *Input exports walked`);
  assertEquals(inputs.includes("UpdateProductInput") && inputs.includes("CreateProductInput"), true);

  const { added, removed } = diff(paths);
  assertEquals(
    added,
    [],
    "NEW strict node(s) inside an input schema — give the node a stripping twin " +
      "(see FROZEN's docstring), do not add it to the list:\n  " + added.join("\n  "),
  );
  assertEquals(
    removed,
    [],
    "Frozen entr(ies) no longer strict — a conversion landed, so DELETE them from FROZEN:\n  " +
      removed.join("\n  "),
  );
});

Deno.test("plant: the products input regressed to the storage node is caught, naming the path", () => {
  // `ComponentSchema` is the storage `z.strictObject` the input reused before
  // api-cloudrun#879 — exactly the regression this ratchet exists for.
  const regressed = {
    ...mod,
    UpdateProductInput: z.object({ uid: z.string(), components: z.array(mod.ComponentSchema).optional() }),
  };
  const { added } = diff(inputStrictPaths(regressed).paths);
  assertEquals(added, ["UpdateProductInput components[]", "UpdateProductInput components[].price"]);
});

Deno.test("plant: a new input with a strict node is caught, through every wrapper the walker claims", () => {
  const strict = () => z.strictObject({ a: z.string() });
  const PlantedInput = z.object({
    optional: strict().optional(),
    nullable: strict().nullable(),
    defaulted: strict().default({ a: "" }),
    prefaulted: strict().prefault({ a: "" }),
    readonly: strict().readonly(),
    caught: strict().catch({ a: "" }),
    piped: strict().pipe(z.transform((v) => v)),
    lazy: z.lazy(() => strict()),
    union: z.union([z.string(), strict()]),
    discriminated: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("a") }),
      z.strictObject({ kind: z.literal("b") }),
    ]),
    intersection: z.intersection(z.object({}), strict()),
    record: z.record(z.string(), strict()),
    tuple: z.tuple([z.string()], strict()),
    array: z.array(strict()),
  });
  const { added, removed } = diff(inputStrictPaths({ ...mod, PlantedInput }).paths);
  assertEquals(removed, []);
  assertEquals(added, [
    "PlantedInput array[]",
    "PlantedInput caught",
    "PlantedInput defaulted",
    "PlantedInput discriminated(kind=b)",
    "PlantedInput intersection",
    "PlantedInput lazy",
    "PlantedInput nullable",
    "PlantedInput optional",
    "PlantedInput piped",
    "PlantedInput prefaulted",
    "PlantedInput readonly",
    "PlantedInput record{}",
    "PlantedInput tuple[...]",
    "PlantedInput union(#1)",
  ]);
});
