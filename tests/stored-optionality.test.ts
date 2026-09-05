/**
 * `.nullable().optional()` on a STORED field — the inventory, pinned so it can
 * only shrink.
 *
 * ## The ruling
 *
 * Owner, 2026-09-05: **prefer `.nullable()` over `.optional()`** for a stored
 * field — present-and-null, never absent. Under `z.strictObject` those are
 * different accepted sets, and only the absent one yields `undefined`. That is
 * the state that breaks writers: an invoice legally missing `reference` made
 * `stageOrderInvoiceSync` hand `patch.reference = undefined` to api-cloudrun's
 * write boundary, which rejects a literal `undefined` at any depth and 400s the
 * whole ORDER update. `Invoice.reference` was converted in `94d7dd7`; core#83 is
 * the rest.
 *
 * ## Why this is a ratchet and not a sweep
 *
 * Each conversion is a storage TIGHTENING and runs `core/CLAUDE.md`
 * § *"Making a field REQUIRED"* — a both-environment census, a writer audit, the
 * interface `?`, and a fixture sweep. That is per-field work no test can do. What
 * a test CAN do is stop the population growing while the campaign runs, and give
 * it a denominator: **the map below only ever shrinks.** Deleting an entry is how
 * a conversion is recorded, and the stale arm makes deleting it mandatory.
 *
 * ## 🔴 Why it walks the REGISTRY rather than grepping the spelling
 *
 * A `grep -rn "\.nullable()\.optional()" src/schemas/` returns 178 declarations,
 * and **101 of them are out of scope**: input schemas (`Create*Input`,
 * `Update*Input`, and `order.ts`'s input twins `DestinationEndpoint` /
 * `ItemPrice` / `OrderItemLineInner`) plus four log records that are not Firestore
 * documents at all.
 *
 * That is not a tidiness point. **core#70 deliberately ADDS three
 * `.nullable().optional()` arms to `NamePartsFieldsPartial`** — on an update
 * input, where `null` is the "unset" verb and the value is never stored. A
 * spelling-scoped sweep would return 185 after it lands and would happily "fix"
 * the three arms that ARE the feature. Walking `schemas` — the Firestore registry
 * from `src/schemas/mod.ts` — excludes every input schema **by construction**, rather than by
 * a filter someone has to remember to keep applying.
 *
 * ## What the paths mean
 *
 * Resolved leaf paths, not declaration sites: a shared block (`Address`,
 * `DocSource`, `DocumentOrganizationSnapshot`) appears once per collection that
 * embeds it, because that is what actually reaches storage. `[]` marks an array
 * of maps — the marker matters, see `array-member-uncensusable` below.
 *
 * @see `api-cloudrun/scripts/audit-field-presence.ts` — the `orderBy` oracle
 * @see `tests/inert-defaults.test.ts` — the traversal this reuses
 */
import { assert, assertEquals } from "@std/assert";
import { z } from "zod";
import { schemas } from "../src/schemas/mod.ts";

/**
 * Why a field is still `.nullable().optional()`.
 *
 * A closed vocabulary on purpose: "still here" is a different fact from "cannot
 * be measured" is a different fact from "must not be touched", and a free-text
 * reason would let all three read the same.
 */
type Reason =
  /** Measurable with `orderBy`; awaiting the both-environment census. */
  | "pending-census"
  /** 🔴 Inside an array of maps — the `orderBy` oracle cannot reach it at all. */
  | "array-member-uncensusable"
  /** 🔴 Do not tighten: the field is queued for removal, not for narrowing. */
  | "crms-pending-removal"
  /** Deliberately in transit through an expand/migrate/contract. */
  | "mid-expand"
  /** A written refusal sits beside the declaration, with its corpus count. */
  | "refused:no-writer-yet";

const NULLABLE_OPTIONAL: ReadonlyMap<string, Reason> = new Map([
  // ── pending-census — measurable with `orderBy`, awaiting the both-environment
  //    census before any of them is tightened. The directly actionable set.
  ["bookings.destinations.delivery.address.address_coordinates", "pending-census"],
  ["bookings.destinations.delivery.address.user_coordinates", "pending-census"],
  ["cards.destination.address.address_coordinates", "pending-census"],
  ["cards.destination.address.user_coordinates", "pending-census"],
  ["credit-notes.external_notes", "pending-census"],
  ["credit-notes.internal_notes", "pending-census"],
  ["credit-notes.organization.billing_address", "pending-census"],
  ["credit-notes.organization.billing_address.address_coordinates", "pending-census"],
  ["credit-notes.organization.billing_address.user_coordinates", "pending-census"],
  ["destinations.address.address_coordinates", "pending-census"],
  ["destinations.address.user_coordinates", "pending-census"],
  ["invoices.external_notes", "pending-census"],
  ["invoices.internal_notes", "pending-census"],
  ["invoices.organization.billing_address", "pending-census"],
  ["invoices.organization.billing_address.address_coordinates", "pending-census"],
  ["invoices.organization.billing_address.user_coordinates", "pending-census"],
  ["invoices.tax_exempt", "pending-census"],
  ["invoices.uid_store", "pending-census"],
  ["location-types.dimensions", "pending-census"],
  ["orders.created_by", "pending-census"],
  ["orders.organization.billing_address", "pending-census"],
  ["orders.organization.billing_address.address_coordinates", "pending-census"],
  ["orders.organization.billing_address.user_coordinates", "pending-census"],
  ["orders.tax_exempt", "pending-census"],
  ["orders.uid_store", "pending-census"],
  ["orders.updated_by", "pending-census"],
  ["organizations.billing_address.address_coordinates", "pending-census"],
  ["organizations.billing_address.user_coordinates", "pending-census"],
  ["organizations.last_order", "pending-census"],
  ["products.price.base_percent", "pending-census"],
  ["products.price.replacement_cents", "pending-census"],
  ["products.uid_linked_rental", "pending-census"],
  ["products.uid_linked_replacement", "pending-census"],
  ["products.uid_tracking_category", "pending-census"],
  ["products.webshop.description", "pending-census"],
  ["products.xero_code", "pending-census"],
  ["recurrences.prototype.destination.address.address_coordinates", "pending-census"],
  ["recurrences.prototype.destination.address.user_coordinates", "pending-census"],
  ["stores.uid_destination", "pending-census"],
  ["taxes.jurisdiction", "pending-census"],
  ["taxes.xero_account_code", "pending-census"],
  ["taxes.xero_item_code", "pending-census"],
  ["taxes.xero_tax_type", "pending-census"],
  ["templates-versions.pr_number", "pending-census"],
  ["templates-versions.staging_sha", "pending-census"],
  ["transactions.xero_id", "pending-census"],
  ["users.deleted_at", "pending-census"],
  ["users.uid_contact", "pending-census"],
  ["webshop-products.price.replacement_cents", "pending-census"],
  ["webshop-products.shipping.air_un", "pending-census"],
  ["webshop-products.shipping.height", "pending-census"],
  ["webshop-products.shipping.length", "pending-census"],
  ["webshop-products.shipping.weight", "pending-census"],
  ["webshop-products.shipping.width", "pending-census"],
  ["webshop-products.webshop.description", "pending-census"],
  ["xero-sync.pushed_body_hash", "pending-census"],
  // ── array-member-uncensusable — 🔴 Firestore cannot `orderBy` a member of an
  //    array of maps, so the ONE key-presence oracle does not reach these. They
  //    need a paged instrument before they can even be measured, let alone
  //    tightened. (`sources[].label` is `DocSource.label`, also api-cloudrun#853.)
  ["cards.sources[].label", "array-member-uncensusable"],
  ["comments.sources[].label", "array-member-uncensusable"],
  ["credit-notes.items[].price.base_percent", "array-member-uncensusable"],
  ["credit-notes.sources[].label", "array-member-uncensusable"],
  ["fulfillments.destinations[].delivery.address.address_coordinates", "array-member-uncensusable"],
  ["fulfillments.destinations[].delivery.address.user_coordinates", "array-member-uncensusable"],
  ["fulfillments.destinations[].jurisdiction", "array-member-uncensusable"],
  ["invoices.destinations[].jurisdiction", "array-member-uncensusable"],
  ["invoices.items[].coa_revenue", "array-member-uncensusable"],
  ["invoices.items[].price.base_percent", "array-member-uncensusable"],
  ["invoices.items[].taxed_as", "array-member-uncensusable"],
  ["invoices.items[].tracking_category", "array-member-uncensusable"],
  ["invoices.items[].xero_id", "array-member-uncensusable"],
  ["invoices.items[].xero_tracking_option_id", "array-member-uncensusable"],
  ["orders.destinations[].jurisdiction", "array-member-uncensusable"],
  ["orders.items[].coa_revenue", "array-member-uncensusable"],
  ["orders.items[].inclusion_type", "array-member-uncensusable"],
  ["orders.items[].price.base_percent", "array-member-uncensusable"],
  ["orders.items[].price.replacement_cents", "array-member-uncensusable"],
  ["orders.items[].taxed_as", "array-member-uncensusable"],
  ["orders.items[].zero_priced", "array-member-uncensusable"],
  ["out-of-service.sources[].label", "array-member-uncensusable"],
  ["out-of-service.stores[].locations[].max", "array-member-uncensusable"],
  ["products.components[].price.base_percent", "array-member-uncensusable"],
  ["products.components[].price.replacement_cents", "array-member-uncensusable"],
  ["recurrences.prototype.sources[].label", "array-member-uncensusable"],
  ["threads.sources[].label", "array-member-uncensusable"],
  ["transactions.lines[].location.from.label", "array-member-uncensusable"],
  ["webshop-products.components[].price.replacement_cents", "array-member-uncensusable"],
  // ── crms-pending-removal — 🔴 do NOT tighten. api-cloudrun#556 defers removing
  //    the stored CRMS fields from `@cfs/core` as "a separate, later decision",
  //    and the purge starts from OPTIONAL. Requiring one now adds a loosening
  //    publish to its eventual removal — strictly negative work.
  ["bookings.crms_id", "crms-pending-removal"],
  ["bookings.crms_product_id", "crms-pending-removal"],
  ["credit-notes.organization.crms_id", "crms-pending-removal"],
  ["invoices.crms_id", "crms-pending-removal"],
  ["invoices.items[].crms_id", "crms-pending-removal"],
  ["invoices.items[].crms_opportunity_id", "crms-pending-removal"],
  ["invoices.organization.crms_id", "crms-pending-removal"],
  ["orders.items[].crms_id", "crms-pending-removal"],
  ["orders.organization.crms_id", "crms-pending-removal"],
  ["out-of-service.crms_id", "crms-pending-removal"],
  ["out-of-service.crms_stock_level_id", "crms-pending-removal"],
  ["out-of-service.transactions[].crms_id", "crms-pending-removal"],
  ["out-of-service.transactions[].crms_quarantine_id", "crms-pending-removal"],
  ["out-of-service.transactions[].crms_stock_level_id", "crms-pending-removal"],
  ["products.components[].crms_accessory_id", "crms-pending-removal"],
  ["products.crms_linked_rental_id", "crms-pending-removal"],
  ["products.crms_linked_replacement_id", "crms-pending-removal"],
  ["products.crms_linked_replacement_rate_id", "crms-pending-removal"],
  ["products.crms_rate_id", "crms-pending-removal"],
  // ── mid-expand — deliberately in transit. `DocumentOrganizationSnapshot`'s own
  //    docblock names the three-step dance it is in the first step of.
  ["credit-notes.organization.jurisdiction_claim", "mid-expand"],
  ["invoices.organization.jurisdiction_claim", "mid-expand"],
  ["orders.organization.jurisdiction_claim", "mid-expand"],
  ["organizations.jurisdiction_claim", "mid-expand"],
  // ── refused — a written refusal sits beside the declaration, with its corpus
  //    count. See `src/schemas/supplier.ts`.
  ["transactions.supplier", "refused:no-writer-yet"],
  // ── mid-expand: `NamePartsFields` (`src/schemas/common.ts`), widened 2026-09-05 ──────
  //
  // 🔴 These 30 are a DELIBERATE transit state, not new debt. The three optional
  //    name parts are going to bare `.nullable()` (core#83, the owner's ruling),
  //    and they cannot go there directly: `.optional()` accepts
  //    `string | undefined` and NOT `null`, so no writer could stamp one until
  //    this widening shipped. Order: widen → writers stamp `?? null` → backfill
  //    → contract.
  //
  //    30 resolved paths from THREE declarations — one shared block reaching ten
  //    stored surfaces, which is exactly why it is the highest-leverage
  //    conversion available and why the count looks larger than the edit.
  //
  // ⚠️ The contract step must SPLIT the block: `NamePartsFields` feeds 6 STORED
  //    (`z.strictObject`) and 6 INPUT (`z.object`) sites, and requiring the key
  //    on an input would 400 every create client that omits a middle name.
  //    Normalize at the writer, require at storage.
  ["cards.destination.contact.last_name", "mid-expand"],
  ["cards.destination.contact.middle_name", "mid-expand"],
  ["cards.destination.contact.pronunciation", "mid-expand"],
  ["contacts.last_name", "mid-expand"],
  ["contacts.middle_name", "mid-expand"],
  ["contacts.pronunciation", "mid-expand"],
  ["destinations.contacts[].last_name", "mid-expand"],
  ["destinations.contacts[].middle_name", "mid-expand"],
  ["destinations.contacts[].pronunciation", "mid-expand"],
  ["fulfillments.destinations[].delivery.contact.last_name", "mid-expand"],
  ["fulfillments.destinations[].delivery.contact.middle_name", "mid-expand"],
  ["fulfillments.destinations[].delivery.contact.pronunciation", "mid-expand"],
  ["invites.last_name", "mid-expand"],
  ["invites.middle_name", "mid-expand"],
  ["invites.pronunciation", "mid-expand"],
  ["invoices.destinations[].delivery.contact.last_name", "mid-expand"],
  ["invoices.destinations[].delivery.contact.middle_name", "mid-expand"],
  ["invoices.destinations[].delivery.contact.pronunciation", "mid-expand"],
  ["orders.destinations[].delivery.contact.last_name", "mid-expand"],
  ["orders.destinations[].delivery.contact.middle_name", "mid-expand"],
  ["orders.destinations[].delivery.contact.pronunciation", "mid-expand"],
  ["organizations.contacts[].last_name", "mid-expand"],
  ["organizations.contacts[].middle_name", "mid-expand"],
  ["organizations.contacts[].pronunciation", "mid-expand"],
  ["recurrences.prototype.destination.contact.last_name", "mid-expand"],
  ["recurrences.prototype.destination.contact.middle_name", "mid-expand"],
  ["recurrences.prototype.destination.contact.pronunciation", "mid-expand"],
  ["users.last_name", "mid-expand"],
  ["users.middle_name", "mid-expand"],
  ["users.pronunciation", "mid-expand"],
]);

// ── The walk ─────────────────────────────────────────────────────────

// deno-lint-ignore no-explicit-any
function defOf(node: any): any {
  return node?._zod?.def;
}

function isZodNode(value: unknown): boolean {
  // deno-lint-ignore no-explicit-any
  const v = value as any;
  return !!v && typeof v === "object" && !!v._zod?.def && typeof v.safeParse === "function";
}

/**
 * Every `Optional(Nullable(X))` under `root`, as a dotted path.
 *
 * Structural, and container-complete for every shape this package uses —
 * wrappers, objects, arrays, tuples, unions, records, maps, intersections, pipes
 * and `lazy`. ⚠️ **A ratchet with a hole reports CLEAN rather than smaller**, so
 * the companion test below plants the construct inside each container and fails
 * if the walk cannot see it.
 *
 * Checks BOTH nesting orders. `.nullable().optional()` is `Optional(Nullable(X))`
 * and is the 178-instance spelling; `.optional().nullable()` is
 * `Nullable(Optional(X))`, exists exactly once in the package, and accepts the
 * same three states. A walk that knew only one spelling would report the other as
 * clean.
 *
 * `seen` is keyed on node identity so a recursive schema terminates. `.meta()`
 * clones, so two annotated instances of one block are visited separately — which
 * is correct: they are different storage positions.
 */
// deno-lint-ignore no-explicit-any
function findNullableOptional(root: any, prefix: string, seen: Set<unknown>, out: string[]): void {
  if (!isZodNode(root) || seen.has(root)) return;
  seen.add(root);

  const def = defOf(root);
  const type: string = def.type;

  if (type === "optional" || type === "nullable") {
    const other = type === "optional" ? "nullable" : "optional";
    // Peel any value-carrying wrappers BETWEEN the two — `.nullable().default(x)
    // .optional()` still admits all three states.
    // deno-lint-ignore no-explicit-any
    let inner: any = def.innerType;
    while (isZodNode(inner)) {
      const t = defOf(inner).type;
      if (t === other) {
        out.push(prefix || "<root>");
        break;
      }
      if (t === "readonly" || t === "default" || t === "prefault" || t === "catch") {
        inner = defOf(inner).innerType;
      } else break;
    }
  }

  switch (type) {
    case "optional":
    case "nullable":
    case "default":
    case "prefault":
    case "readonly":
    case "nonoptional":
    case "catch":
    case "promise":
      findNullableOptional(def.innerType ?? def.in, prefix, seen, out);
      return;
    case "pipe":
      findNullableOptional(def.in, prefix, seen, out);
      findNullableOptional(def.out, prefix, seen, out);
      return;
    case "lazy":
      findNullableOptional(def.getter(), prefix, seen, out);
      return;
    case "object":
    case "interface":
      for (const [key, member] of Object.entries(def.shape ?? {})) {
        findNullableOptional(member, prefix ? `${prefix}.${key}` : key, seen, out);
      }
      return;
    case "array":
      findNullableOptional(def.element, `${prefix}[]`, seen, out);
      return;
    case "set":
      findNullableOptional(def.valueType, `${prefix}{set}`, seen, out);
      return;
    case "tuple":
      (def.items ?? []).forEach((item: unknown, i: number) =>
        findNullableOptional(item, `${prefix}[${i}]`, seen, out)
      );
      if (def.rest) findNullableOptional(def.rest, `${prefix}[...]`, seen, out);
      return;
    case "union":
      // Members are emitted at the SAME path — an items[] union arm is a storage
      // position of the array, not a distinct key.
      (def.options ?? []).forEach((opt: unknown) => findNullableOptional(opt, prefix, seen, out));
      return;
    case "intersection":
      findNullableOptional(def.left, prefix, seen, out);
      findNullableOptional(def.right, prefix, seen, out);
      return;
    case "record":
    case "map":
      findNullableOptional(def.valueType, `${prefix}.<key>`, seen, out);
      return;
    default:
      return;
  }
}

/**
 * Scan the Firestore registry, deduped by node identity.
 *
 * `schemas` double-keys singular AND plural onto the same instance
 * (`invoice` and `invoices`); last-key-wins yields the plural, which is the
 * collection name an operator would recognise and the one
 * `audit-field-presence.ts` takes.
 */
function scanRegistry(): string[] {
  const byInstance = new Map<z.ZodType, string>();
  for (const [key, schema] of Object.entries(schemas)) byInstance.set(schema as z.ZodType, key);

  const found = new Set<string>();
  for (const [schema, key] of byInstance) {
    const out: string[] = [];
    findNullableOptional(schema, "", new Set(), out);
    for (const path of out) found.add(`${key}.${path}`);
  }
  return [...found].sort();
}

// ── Non-vacuity, first ───────────────────────────────────────────────

Deno.test("stored optionality — the walk is not inert", () => {
  const registrySize = new Set(Object.values(schemas)).size;
  assert(
    registrySize > 50,
    `only ${registrySize} distinct schemas in the registry — the enumeration is inert ` +
      `and every arm below would pass over nothing`,
  );
  assert(
    NULLABLE_OPTIONAL.size > 0,
    "the catalogue is empty — if the campaign really finished, delete this file " +
      "rather than leaving a guard with nothing to guard",
  );
});

Deno.test("stored optionality — the walk sees the construct in every container", async (t) => {
  // Each plant is a shape the real schemas use. A traversal that stops reaching
  // one of these containers fails HERE rather than reporting the corpus clean.
  const plants: Record<string, z.ZodType> = {
    "bare member": z.strictObject({ a: z.string().nullable().optional() }),
    "reversed spelling": z.strictObject({ a: z.string().optional().nullable() }),
    "nested object": z.strictObject({ o: z.strictObject({ a: z.string().nullable().optional() }) }),
    "array element": z.strictObject({ xs: z.array(z.strictObject({ a: z.string().nullable().optional() })) }),
    "union arm": z.strictObject({
      u: z.union([
        z.strictObject({ k: z.literal("a") }),
        z.strictObject({ k: z.literal("b"), a: z.string().nullable().optional() }),
      ]),
    }),
    "record value": z.record(z.string(), z.strictObject({ a: z.string().nullable().optional() })),
    "tuple slot": z.tuple([z.strictObject({ a: z.string().nullable().optional() })]),
    "default between": z.strictObject({ a: z.string().nullable().default("x").optional() }),
    "lazy": z.strictObject({ a: z.lazy(() => z.string().nullable().optional()) }),
  };

  for (const [label, schema] of Object.entries(plants)) {
    await t.step(label, () => {
      const out: string[] = [];
      findNullableOptional(schema, "", new Set(), out);
      assert(out.length > 0, `the walk missed the planted construct: ${label}`);
    });
  }

  await t.step("and does NOT flag the two states we want", () => {
    const ok = z.strictObject({
      nullableOnly: z.string().nullable(),
      optionalOnly: z.string().optional(),
      required: z.string(),
    });
    const out: string[] = [];
    findNullableOptional(ok, "", new Set(), out);
    assertEquals(out, [], "a bare `.nullable()` or `.optional()` was flagged as the pair");
  });
});

// ── The ratchet ──────────────────────────────────────────────────────

Deno.test("stored optionality — every `.nullable().optional()` is catalogued", () => {
  const found = scanRegistry();
  const uncatalogued = found.filter((p) => !NULLABLE_OPTIONAL.has(p)).map((p) => `  + ${p}`);

  assertEquals(
    uncatalogued.join("\n"),
    "",
    "A new `.nullable().optional()` on a STORED field. Absent and " +
      "present-and-null are different accepted sets under `z.strictObject`, and " +
      "only absent yields `undefined` — the state that made an invoice's missing " +
      "`reference` 400 an unrelated ORDER update.\n\n" +
      "Prefer bare `.nullable()`: present, possibly null. If the field genuinely " +
      "needs all three states, catalogue it here with the reason.\n\n" +
      "⚠️ If you are looking at an INPUT schema, you are in the wrong place — " +
      "this walks the Firestore registry only, and an input may stay optional " +
      "(normalize at the writer, require at storage).\n" + uncatalogued.join("\n"),
  );
});

Deno.test("stored optionality — the catalogue only shrinks", () => {
  const found = new Set(scanRegistry());
  const stale = [...NULLABLE_OPTIONAL.keys()].filter((p) => !found.has(p)).map((p) => `  + ${p}`).sort();

  assertEquals(
    stale.join("\n"),
    "",
    "Catalogued as `.nullable().optional()`, but the walk no longer finds it — " +
      "so it was converted, moved or deleted. Delete the entry: this map is the " +
      "campaign's denominator (core#83), and an entry that suppresses nothing " +
      "makes the remaining work read as larger than it is.\n" + stale.join("\n"),
  );
});

Deno.test("stored optionality — the reasons that forbid work say so, and are not silently growing", () => {
  const byReason = new Map<Reason, string[]>();
  for (const [path, reason] of NULLABLE_OPTIONAL) {
    const list = byReason.get(reason) ?? [];
    list.push(path);
    byReason.set(reason, list);
  }

  // 🔴 An `[]` in the path means Firestore's ONLY key-presence oracle —
  // `orderBy(field)` — cannot address it, so the field cannot be measured, let
  // alone tightened. Mislabelling one `pending-census` sends a future session to
  // run a census that will silently return the whole-collection count and read
  // as 100%.
  const misfiled = [...NULLABLE_OPTIONAL]
    .filter(([p, r]) => p.includes("[]") && r === "pending-census")
    .map(([p]) => `  + ${p}`);
  assertEquals(
    misfiled.join("\n"),
    "",
    "An array-member path is catalogued `pending-census`, but `orderBy` cannot " +
      "address a member of an array of maps — a census on it does not fail, it " +
      "returns the collection count and reads as 100% present. Label it " +
      "`array-member-uncensusable`:\n" + misfiled.join("\n"),
  );

  // The reverse: a NON-array path labelled uncensusable is claiming an
  // impossibility that does not apply, which parks measurable work indefinitely.
  const overclaimed = [...NULLABLE_OPTIONAL]
    .filter(([p, r]) => !p.includes("[]") && r === "array-member-uncensusable")
    .map(([p]) => `  + ${p}`);
  assertEquals(
    overclaimed.join("\n"),
    "",
    "Labelled `array-member-uncensusable`, but the path crosses no array — " +
      "`orderBy` reaches it, so it is measurable and belongs in `pending-census`:\n" +
      overclaimed.join("\n"),
  );

  // Every `crms-pending-removal` entry must actually name a CRMS field. The
  // label licenses NOT doing the work, so it has to be checkable.
  const notCrms = (byReason.get("crms-pending-removal") ?? [])
    .filter((p) => !p.includes("crms"))
    .map((p) => `  + ${p}`);
  assertEquals(
    notCrms.join("\n"),
    "",
    "Labelled `crms-pending-removal` but the path names no CRMS field. That " +
      "label defers the work on api-cloudrun#556's authority; it cannot cover a " +
      "field that issue will not remove:\n" + notCrms.join("\n"),
  );
});
