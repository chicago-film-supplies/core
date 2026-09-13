/**
 * `.default(x)` on a STORED field — the inventory, pinned so it can only shrink.
 *
 * ## The defect
 *
 * **A `.default()` on a stored collection schema never materializes in
 * Firestore.** `validateBeforeWrite` validates and then discards `result.data`,
 * persisting the RAW document (`api-cloudrun/src/lib/validate.ts`). So the
 * default has exactly one live effect: **it lets a writer OMIT the field and
 * still pass validation.** The document is stored without the key, and every
 * reader downstream sees `undefined` where the type says otherwise.
 *
 * That is the opposite of what a storage schema is for, and it is invisible to
 * the compiler — an interface can declare a field non-optional while the Zod
 * schema defaults it, so `deno check` is green on every writer that omits it.
 *
 * Owner ruling, 2026-09-09: *"we dont use default, you can remove it, confirm
 * the writers are compliant."*
 *
 * ## Why this is a ratchet and not a sweep
 *
 * Each removal is a storage TIGHTENING and runs `core/CLAUDE.md`
 * § *"Making a field REQUIRED"* — a both-environment census, a writer audit, the
 * interface `?`, and a fixture sweep. `OrderDocDates` is the worked example: 14
 * defaults, one publish, three consumer pin bumps, three repaired fixtures and a
 * 3,049-pair corpus census, for ONE field group. That is per-field work no test
 * can do. What a test CAN do is stop the population growing while the campaign
 * runs, and give it a denominator: **the map below only ever shrinks.**
 *
 * ## 🔴 Why it walks the REGISTRY rather than grepping the spelling
 *
 * Walking `schemas` — the Firestore registry from `src/schemas/mod.ts` — excludes
 * every INPUT schema **by construction**, rather than by a filter someone has to
 * remember to keep applying. On an input schema a `.default()` is often correct:
 * the value is normalized at the writer and required at storage.
 *
 * ⭐ That distinction is not academic. Sweeping the `OrderDocDates` removal
 * across api-cloudrun turned up 33 incomplete destination-pair `dates` literals,
 * and **22 of them were `OrderDates` INPUT payloads that were CORRECT** — the
 * input schema is six nullable ISO keys where the stored one is fourteen, so
 * *missing exactly the derived fields is the signature of an input payload, not
 * of a defect*. A spelling-scoped sweep would have "fixed" all 22 into breakage.
 *
 * ## The two maps
 *
 * - {@link SENTINEL_DEFAULTS} — **legitimate, and not debt.** The writer sends a
 *   FieldValue sentinel, which `validateBeforeWrite` STRIPS before parsing
 *   (`isFieldValueSentinel`), so the field is genuinely absent at validation
 *   time and the schema must tolerate that. Each entry names the write site.
 * - {@link INERT_DEFAULTS} — everything else. core#95's campaign backlog.
 *
 * ⚠️ **An entry in the second map is a claim that nobody has looked yet**, not a
 * claim that the default is wrong. Moving one to the first map with a write site
 * is a finding; deleting it is a removal. Both are progress; leaving it is not.
 *
 * @see `tests/inert-defaults.test.ts` — the `.default(x).optional()` shape, and the traversal this reuses
 * @see `tests/stored-optionality.test.ts` — the same ratchet one axis over
 * @see `core/.claude/plans/stored-schema-defaults.md` — the worked example
 */
import { assert, assertEquals } from "@std/assert";
import { z } from "zod";
import { schemas } from "../src/schemas/mod.ts";

/**
 * Stored defaults that are CORRECT, because the field is written with a
 * FieldValue sentinel that `validateBeforeWrite` strips before parsing — so the
 * key really is absent at validation time.
 *
 * ⚠️ A `.optional()` would express this too, and arguably better. These are
 * listed as legitimate rather than as debt because the default is doing real
 * work here: it names the value a fresh document starts at.
 */
const SENTINEL_DEFAULTS: ReadonlyMap<string, string> = new Map([
  ["bookings.version", "written as `FieldValue.increment(1)`"],
  ["cards.recurrence_overrides", "written as `FieldValue.arrayUnion` — api-cloudrun/src/services/cardsRecurrence.ts:98"],
  ["cards.version", "written as `FieldValue.increment(1)`"],
  ["chart-of-accounts.version", "written as `FieldValue.increment(1)`"],
  ["comments.version", "written as `FieldValue.increment(1)`"],
  ["contacts.version", "written as `FieldValue.increment(1)`"],
  ["credit-notes.version", "written as `FieldValue.increment(1)`"],
  ["department-types.version", "written as `FieldValue.increment(1)`"],
  ["destinations.version", "written as `FieldValue.increment(1)`"],
  ["fulfillments.version", "written as `FieldValue.increment(1)`"],
  ["holiday-definitions.version", "written as `FieldValue.increment(1)`"],
  ["invoices.version", "written as `FieldValue.increment(1)`"],
  ["lists.version", "written as `FieldValue.increment(1)`"],
  ["location-types.version", "written as `FieldValue.increment(1)`"],
  ["locations.version", "written as `FieldValue.increment(1)`"],
  ["orders.version", "written as `FieldValue.increment(1)`"],
  ["organizations.version", "written as `FieldValue.increment(1)`"],
  ["out-of-service.version", "written as `FieldValue.increment(1)`"],
  ["products.tags", "written as `FieldValue.arrayUnion`/`arrayRemove` — api-cloudrun/src/services/tags.ts:140,151"],
  ["products.version", "written as `FieldValue.increment(1)`"],
  ["recurrences.exception_dates", "written as `FieldValue.arrayUnion` — api-cloudrun/src/services/cardsRecurrence.ts:373"],
  ["recurrences.version", "written as `FieldValue.increment(1)`"],
  ["settlements.version", "written as `FieldValue.increment(1)`"],
  ["stores.version", "written as `FieldValue.increment(1)`"],
  ["suppliers.version", "written as `FieldValue.increment(1)`"],
  ["tags.version", "written as `FieldValue.increment(1)`"],
  ["taxes.version", "written as `FieldValue.increment(1)`"],
  ["templates-versions.version", "written as `FieldValue.increment(1)`"],
  ["threads.version", "written as `FieldValue.increment(1)`"],
  ["tracking-categories.version", "written as `FieldValue.increment(1)`"],
  ["transactions.version", "written as `FieldValue.increment(1)`"],
  ["users.version", "written as `FieldValue.increment(1)`"],
]);

/**
 * Stored defaults with no sentinel behind them — the campaign backlog (core#95).
 *
 * Each is inert: it cannot put a value in Firestore, and its only effect is to
 * let a writer omit the key. **This set only ever shrinks.**
 */
const INERT_DEFAULTS: ReadonlySet<string> = new Set([
  "bookings.query_by_uid_store",
  "bookings.stores",
  "bookings.stores[].locations",
  "cards.attachments[].locked",
  "cards.dates.end",
  "cards.dates.start",
  "comments.reactions",
  "contacts.organizations",
  "contacts.query_by_organizations",
  "credit-notes.items",
  "credit-notes.items[].tracking_category",
  "credit-notes.items[].uid_invoice_item",
  "credit-notes.items[].xero_id",
  "credit-notes.items[].xero_tracking_option_id",
  "credit-notes.remaining_credit_cents",
  "credit-notes.xero_credit_note_id",
  "fulfillments.items",
  "fulfillments.items[]|0.path",
  "fulfillments.items[]|1.path",
  "fulfillments.items[]|2.path",
  "holiday-definitions.active",
  "holiday-snapshot.materialized_dates",
  "inventory-ledgers.store_breakdown",
  "inventory-ledgers.store_breakdown[].locations",
  "invites.roles",
  "invites.used",
  "invoices.items",
  "invoices.items[]|0.path",
  "invoices.items[]|1.path",
  "invoices.items[]|2.path",
  "invoices.items[]|3.path",
  "invoices.number_orders",
  "invoices.pdf_generated_at",
  "invoices.uploadcare_uuid",
  "lists.description",
  "lists.locked",
  "location-types.active",
  "location-types.product_capacities",
  "locations.product_capacities",
  "locations.products",
  "orders.invoices",
  "orders.items",
  "orders.items[]|0.path",
  "orders.items[]|1.path",
  "orders.items[]|2.path",
  "orders.query_by_invoices",
  "orders.xero_id",
  "organizations.contacts[].roles",
  "out-of-service.stores",
  "out-of-service.stores[].locations",
  "products.component_of[].price.taxes",
  "products.components[].price.taxes",
  "recurrences.prototype.attachments[].locked",
  "roles.permissions",
  "stock.unavailable",
  "stores.default_location",
  "taxes.crms_id",
  "threads.last_message_preview",
  "transactions.cost.unit_costs_cents",
  "transactions.lines",
  "transactions.serialized_details.asset_tags",
  "transactions.serialized_details.serial_numbers",
]);

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
 * Every `.default()`/`.prefault()` under `root`, as a dotted path.
 *
 * Traverses wrappers, objects, arrays, tuples, unions, records, maps, sets,
 * intersections, pipes and `lazy` — deliberately every container this package
 * uses, because **a ratchet with a hole reports CLEAN rather than smaller.**
 * The companion test below plants the construct in each and fails if the walk
 * cannot see it.
 *
 * 🔴 **`stack` holds the nodes on the CURRENT path, and that is the whole point
 * — it breaks cycles without hiding re-embeddings.** A `Set` held for the whole
 * walk terminates too, and it silently catalogues a shared block ONCE however
 * many storage positions embed it. This walk did that until 2026-09-10 and
 * under-reported by **47 paths**: {@link Address} is one module-level object
 * reached from FIFTEEN positions and only nine were ever enumerated, so
 * `orders.destinations[].delivery.address.*` and every `collection` leg were
 * invisible to the ratchet whose job is to bound the campaign.
 *
 * ⚠️ **The reasoning that produced the hole was a true premise carried one level
 * too far**, and the sibling walks stated it outright: *".meta() clones, so two
 * annotated instances of one block are visited separately — they are different
 * storage positions."* Both halves are true. `.meta()` does clone, so
 * `delivery: X.meta(…)` and `collection: X.meta(…)` are distinct nodes and the
 * walk does enter both legs — but the clone is **shallow**, so
 * `shape(delivery).address === shape(collection).address`, and the dedupe bit at
 * the first shared node INSIDE the legs. "Different storage positions" was the
 * right principle; an identity set honours it only at the depth the annotation
 * sits at.
 */
// deno-lint-ignore no-explicit-any
function findDefaults(root: any, prefix: string, stack: Set<unknown>, out: string[]): void {
  if (!isZodNode(root) || stack.has(root)) return;
  stack.add(root);
  try {
    walkInto(root, prefix, stack, out);
  } finally {
    stack.delete(root);
  }
}

/**
 * The body of {@link findDefaults}. Never call it directly — the cycle guard
 * lives in the wrapper, so that no `return` inside the switch can skip the
 * paired `stack.delete`.
 */
// deno-lint-ignore no-explicit-any
function walkInto(root: any, prefix: string, stack: Set<unknown>, out: string[]): void {
  const def = defOf(root);
  const type: string = def.type;

  if (type === "default" || type === "prefault") out.push(prefix || "<root>");

  switch (type) {
    case "optional":
    case "nullable":
    case "default":
    case "prefault":
    case "readonly":
    case "nonoptional":
    case "catch":
    case "promise":
      findDefaults(def.innerType ?? def.in, prefix, stack, out);
      return;
    case "pipe":
      findDefaults(def.in, prefix, stack, out);
      findDefaults(def.out, prefix, stack, out);
      return;
    case "lazy":
      findDefaults(def.getter(), prefix, stack, out);
      return;
    case "object":
    case "interface":
      for (const [key, member] of Object.entries(def.shape ?? {})) {
        findDefaults(member, prefix ? `${prefix}.${key}` : key, stack, out);
      }
      return;
    case "array":
      findDefaults(def.element, `${prefix}[]`, stack, out);
      return;
    case "set":
      findDefaults(def.valueType, `${prefix}{set}`, stack, out);
      return;
    case "tuple":
      (def.items ?? []).forEach((item: unknown, i: number) => findDefaults(item, `${prefix}[${i}]`, stack, out));
      if (def.rest) findDefaults(def.rest, `${prefix}[...]`, stack, out);
      return;
    case "union":
      (def.options ?? []).forEach((opt: unknown, i: number) => findDefaults(opt, `${prefix}|${i}`, stack, out));
      return;
    case "intersection":
      findDefaults(def.left, prefix, stack, out);
      findDefaults(def.right, prefix, stack, out);
      return;
    case "record":
    case "map":
      findDefaults(def.valueType, `${prefix}.<key>`, stack, out);
      return;
    default:
      return;
  }
}

/**
 * Scan the Firestore registry, deduped by node identity.
 *
 * `schemas` double-keys singular AND plural onto the same instance (`invoice`
 * and `invoices`); last-key-wins yields the plural, which is the collection name
 * an operator would recognise.
 */
function scanRegistry(): string[] {
  const byInstance = new Map<z.ZodType, string>();
  for (const [key, schema] of Object.entries(schemas)) byInstance.set(schema as z.ZodType, key);

  const found = new Set<string>();
  for (const [schema, key] of byInstance) {
    const out: string[] = [];
    findDefaults(schema, "", new Set(), out);
    for (const path of out) found.add(`${key}.${path}`);
  }
  return [...found].sort();
}

// ── Non-vacuity, first ───────────────────────────────────────────────

Deno.test("stored defaults — the walk is not inert", async (t) => {
  await t.step("the registry is populated", () => {
    const registrySize = new Set(Object.values(schemas)).size;
    assert(
      registrySize > 50,
      `only ${registrySize} distinct schemas in the registry — the enumeration is inert ` +
        `and every arm below would pass over nothing`,
    );
  });

  await t.step("the catalogue is not empty", () => {
    assert(
      INERT_DEFAULTS.size > 0 || SENTINEL_DEFAULTS.size > 0,
      "both catalogues are empty — if the campaign really finished, delete this file " +
        "rather than leaving a guard with nothing to guard",
    );
  });

  await t.step("the two maps are disjoint", () => {
    const both = [...SENTINEL_DEFAULTS.keys()].filter((p) => INERT_DEFAULTS.has(p));
    assertEquals(both, [], "a path is catalogued as BOTH sentinel-legitimate and inert debt");
  });

  await t.step("every sentinel carve-out states a write site", () => {
    const thin = [...SENTINEL_DEFAULTS.entries()]
      .filter(([, reason]) => reason.trim().length < 20)
      .map(([path]) => path);
    assertEquals(
      thin,
      [],
      "a sentinel exemption with no stated reason is indistinguishable from an " +
        "unreviewed default that someone wanted to stop failing",
    );
  });
});

Deno.test("stored defaults — the walk sees the construct in every container", async (t) => {
  // Each plant is a shape the real schemas use. A traversal that stops reaching
  // one of these containers fails HERE rather than reporting the corpus clean.
  const plants: Record<string, z.ZodType> = {
    "bare member": z.strictObject({ a: z.string().default("") }),
    "nested object": z.strictObject({ o: z.strictObject({ a: z.array(z.string()).default([]) }) }),
    "array element": z.strictObject({ xs: z.array(z.strictObject({ a: z.string().default("x") })) }),
    "union arm": z.strictObject({
      u: z.union([
        z.strictObject({ k: z.literal("a") }),
        z.strictObject({ k: z.literal("b"), a: z.string().default("") }),
      ]),
    }),
    "record value": z.record(z.string(), z.strictObject({ a: z.string().default("") })),
    "tuple slot": z.tuple([z.strictObject({ a: z.string().default("") })]),
    "nullable outside": z.strictObject({ a: z.string().default("x").nullable() }),
    "prefault spelling": z.strictObject({ a: z.string().prefault("") }),
    "lazy": z.strictObject({ a: z.lazy(() => z.string().default("")) }),
  };

  for (const [label, schema] of Object.entries(plants)) {
    await t.step(label, () => {
      const out: string[] = [];
      findDefaults(schema, "", new Set(), out);
      assert(out.length > 0, `the walk missed the planted construct: ${label}`);
    });
  }

  await t.step("and does NOT flag a field that merely may be absent or null", () => {
    const ok = z.strictObject({
      optionalOnly: z.string().optional(),
      nullableOnly: z.string().nullable(),
      required: z.string(),
    });
    const out: string[] = [];
    findDefaults(ok, "", new Set(), out);
    assertEquals(out, [], "a bare `.optional()` or `.nullable()` was flagged as a default");
  });
});

// ── The property the whole campaign rests on ─────────────────────────

Deno.test("stored defaults — a default's only effect is to let the key be ABSENT", () => {
  const schema = z.strictObject({ a: z.string().default("seeded"), b: z.string() });

  // It does NOT reject the absent key — which is the whole defect. Under a
  // storage schema that reads as "every document has `a`", and no document does.
  const parsed = schema.parse({ b: "x" }) as { a: string; b: string };
  assertEquals(parsed.a, "seeded");

  // And the value it produces lives only in `result.data`, which
  // `validateBeforeWrite` discards — so Firestore receives the raw input,
  // without the key. This is that write modelled in one line.
  const raw: Record<string, unknown> = { b: "x" };
  schema.parse(raw);
  assertEquals(
    Object.hasOwn(raw, "a"),
    false,
    "parsing did not add the key to the input object — which is exactly why a " +
      "`.default()` cannot seed a stored document",
  );
});

// ── The ratchet ──────────────────────────────────────────────────────

Deno.test("stored defaults — every `.default()` on a stored field is catalogued", () => {
  const found = scanRegistry();
  const uncatalogued = found
    .filter((p) => !INERT_DEFAULTS.has(p) && !SENTINEL_DEFAULTS.has(p))
    .map((p) => `  + ${p}`);

  assertEquals(
    uncatalogued.join("\n"),
    "",
    "A new `.default()` on a STORED field. It cannot put this value in " +
      "Firestore — `validateBeforeWrite` discards `result.data` and writes the " +
      "raw document — so its only effect is to let a writer omit the key.\n\n" +
      "If every document must carry the field, declare it REQUIRED and census " +
      "the corpus first (a default does not backfill). If it may genuinely be " +
      "absent, use bare `.nullable()` — see tests/stored-optionality.test.ts. " +
      "If a FieldValue sentinel is stripped before validation, add it to " +
      "SENTINEL_DEFAULTS with its write site.\n\n" +
      "⚠️ If you are looking at an INPUT schema, you are in the wrong place — " +
      "this walks the Firestore registry only, and a default on an input is " +
      "often correct.\n" + uncatalogued.join("\n"),
  );
});

Deno.test("stored defaults — the catalogue only shrinks", () => {
  const found = new Set(scanRegistry());
  const stale = [...INERT_DEFAULTS, ...SENTINEL_DEFAULTS.keys()]
    .filter((p) => !found.has(p))
    .map((p) => `  + ${p}`)
    .sort();

  assertEquals(
    stale.join("\n"),
    "",
    "Catalogued as carrying a `.default()`, but the walk no longer finds it — " +
      "so it was removed, moved or renamed. Delete the entry: this catalogue is " +
      "the campaign's denominator, and a stale line inflates the work left.\n" +
      stale.join("\n"),
  );
});
