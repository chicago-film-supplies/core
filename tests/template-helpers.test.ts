/**
 * Tests for the generated template helper catalogue + the render-context
 * descriptor that decides which of its namespaces a template can call.
 *
 * The lockstep block is the important one: it is what stops the editor's helper
 * panel drifting out of sync with the real `@cfs/core/utils` exports — every
 * emitted name must be a real export, and every export must be either emitted or
 * explicitly denylisted. It previously lived in the manager (against a
 * hand-authored list); now the catalogue is generated, so the guard lives here
 * next to the generator.
 *
 * ⚠️ **The staleness check is NOT here — it is `deno task check:generated`.**
 * `generate-template-helpers.ts` shells out to `deno doc`, so re-rendering it
 * needs `--allow-run`, and `deno task test` deliberately runs without it: a
 * spawned child carries its own permissions, so a test that spawned the
 * generator would rewrite `src/` on every green run no matter what the test
 * process was allowed to do.
 *
 * The lockstep block below still covers **membership** drift without any
 * regeneration: an added export fails "every export is emitted or explicitly
 * denylisted", a removed one fails "every emitted helper is a real export". So
 * what the task alone catches is the narrower class the byte-compare sees and
 * the name comparison cannot — a changed **signature, JSDoc summary or return
 * type** on a helper whose name did not move.
 */
import { assert, assertEquals, assertExists, assertGreater } from "@std/assert";

import * as stockUtils from "../src/utils/stock.ts";
import * as allocationUtils from "../src/utils/allocation.ts";
import * as bookingUtils from "../src/utils/bookings.ts";
import * as cardUtils from "../src/utils/cards.ts";
import * as contactNameUtils from "../src/utils/contact-name.ts";
import * as dateUtils from "../src/utils/dates.ts";
import * as iconUtils from "../src/utils/icons.ts";
import * as invoiceUtils from "../src/utils/invoices.ts";
import * as fulfillmentUtils from "../src/utils/fulfillments.ts";
import * as locationUtils from "../src/utils/locations.ts";
import * as moneyUtils from "../src/utils/money.ts";
import * as movementUtils from "../src/utils/movements.ts";
import * as orderLineUtils from "../src/utils/order-lines.ts";
import * as orderUtils from "../src/utils/orders.ts";
import * as organizationUtils from "../src/utils/organizations.ts";
import * as productUtils from "../src/utils/products.ts";
import * as pickSheetUtils from "../src/utils/pickSheets.ts";
import * as sessionUtils from "../src/utils/sessions.ts";
import * as taxUtils from "../src/utils/taxes.ts";
import * as templateUtils from "../src/utils/templates.ts";
import * as citationUtils from "../src/utils/citations.ts";
import * as templateLintUtils from "../src/utils/template-lint.ts";

import { templateHelpers } from "../src/schemas/template-helpers.generated.ts";
import {
  ALWAYS_ON_UTIL_NAMESPACES,
  availableUtilNamespaces,
  TEMPLATE_COLLECTION_UTILS,
} from "../src/schemas/template-context.ts";
import type { TemplateCollectionType } from "../src/schemas/template-context.ts";
import { TEMPLATE_HELPER_DENYLIST } from "../scripts/template-helper-denylist.ts";

/** Every `./utils/*` entrypoint, keyed by the namespace the generator emits. */
// ⚠️ **EVERY injectable namespace, including the ones that emit nothing.**
// `allocation`, `movements` and `order-lines` emit zero helpers (every export is
// denylisted), and their absence here once meant the drift guard skipped them
// entirely — a new export in any of them was neither emitted nor denylisted nor
// reported, and the denylist staleness guard was blind to the ~14 entries filed
// under them. Deliberately NOT stated as a count: the previous wording said
// SIXTEEN while the map held eighteen, because a hand-maintained number drifts
// every time a namespace is added or removed. The guard below is what enforces
// completeness against `deno.json`; this comment must not restate it.
const UTIL_MODULES: Record<string, Record<string, unknown>> = {
  allocation: allocationUtils,
  bookings: bookingUtils,
  cards: cardUtils,
  "contact-name": contactNameUtils,
  dates: dateUtils,
  icons: iconUtils,
  fulfillments: fulfillmentUtils,
  invoices: invoiceUtils,
  locations: locationUtils,
  money: moneyUtils,
  movements: movementUtils,
  "order-lines": orderLineUtils,
  pickSheets: pickSheetUtils,
  orders: orderUtils,
  organizations: organizationUtils,
  products: productUtils,
  sessions: sessionUtils,
  taxes: taxUtils,
  templates: templateUtils,
  stock: stockUtils,
  // ⚠️ **Not injectable, and the only entry here that is not.**
  // `utils/citations.ts` is tooling — the doc-citation audit's rules — and no
  // template can reach it (it is in neither `TEMPLATE_COLLECTION_UTILS` nor
  // `ALWAYS_ON_UTIL_NAMESPACES`). It is listed because this map's job is to
  // cover every `./utils/*` entrypoint, so the drift guard sees a new export
  // in it; without the entry, its five exports were emitted straight into the
  // editor's helper panel with nothing objecting.
  citations: citationUtils,
  // Same exception as `citations`, and the denylist comment predicted this
  // exact arrival: "the next tooling-only util will leak the same way".
  // `utils/template-lint.ts` is the fixture lint's rule set — CI and API
  // tooling, reachable by no template — and it is listed here only so the drift
  // guard sees its exports rather than the generator emitting them into the
  // editor's helper panel.
  "template-lint": templateLintUtils,
};

/**
 * Runtime *callable helper* exports of a module (skips types/constants).
 *
 * Classes are excluded: `typeof MyClass === "function"` in JS, but a class is not
 * something a template calls as `it.ns.fn(...)` — and `deno doc` types it as
 * `kind: "class"`, so the generator does not emit it either (e.g.
 * `utils/templates.ts`'s `RenderParamError`). Counting it here would report a
 * phantom drift.
 */
function fnExports(mod: Record<string, unknown>): string[] {
  return Object.keys(mod).filter((k) => {
    const value = mod[k];
    if (typeof value !== "function") return false;
    return !/^class[\s{]/.test(Function.prototype.toString.call(value));
  });
}

/**
 * Count the args written in an emitted expr, e.g.
 * `it.orders.getGroupTotals(items, index, taxes)` → 3.
 */
function exprArgCount(expr: string): number {
  const open = expr.indexOf("(");
  const close = expr.lastIndexOf(")");
  if (open < 0 || close <= open) return 0;
  const inner = expr.slice(open + 1, close).trim();
  return inner === "" ? 0 : inner.split(",").map((s) => s.trim()).filter(Boolean).length;
}

// ── Lockstep with the real exports ──────────────────────────────────

Deno.test("UTIL_MODULES covers every ./utils/* entrypoint in deno.json", async () => {
  // ⚠️ **The comment on UTIL_MODULES claimed "the guard below is what enforces
  // completeness against `deno.json`" and there was no such guard** — a
  // gate-claim naming a check nothing runs, which is the defect class
  // `CLAUDE.md` § Commands calls out on its own `lint` line.
  //
  // It cost something. `./utils/citations` was added to `deno.json` without an
  // entry here, so the drift guard and the denylist-staleness guard both
  // skipped the namespace entirely while the generator happily emitted its
  // exports into the template editor's helper panel.
  const denoJson = JSON.parse(await Deno.readTextFile(new URL("../deno.json", import.meta.url)));
  const entrypoints = Object.keys(denoJson.exports)
    .filter((e) => e.startsWith("./utils/"))
    .map((e) => e.slice("./utils/".length))
    .sort();
  assertEquals(
    entrypoints.filter((ns) => !(ns in UTIL_MODULES)),
    [],
    "a `./utils/*` entrypoint with no UTIL_MODULES entry — every guard in this " +
      "file iterates that map, so the namespace is silently unchecked.",
  );
});

Deno.test("every emitted helper is a real export (no stale entries)", () => {
  for (const [namespace, mod] of Object.entries(UTIL_MODULES)) {
    const exports = fnExports(mod);
    const emitted = templateHelpers[namespace] ?? [];
    const missing = emitted.map((h) => h.name).filter((n) => !exports.includes(n));
    assertEquals(missing, [], `emitted it.${namespace}.* not exported by @cfs/core/utils/${namespace}`);
  }
});

/**
 * Is `name` deliberately hidden from `it.<namespace>`?
 *
 * Mirrors the generator's **cross-namespace union**: a symbol is hidden if it is
 * denylisted under this namespace, OR if it is a re-export of a symbol
 * denylisted under a namespace it actually originates in. `utils/invoices.ts`
 * re-exports six order write-path helpers that are denylisted under `orders` —
 * without the union they would read as unaccounted-for here (and would leak into
 * the panel in the generator).
 */
function isDenied(namespace: string, name: string): boolean {
  if (TEMPLATE_HELPER_DENYLIST[namespace]?.includes(name)) return true;

  return Object.entries(TEMPLATE_HELPER_DENYLIST).some(([origin, denied]) =>
    origin !== namespace &&
    denied.includes(name) &&
    typeof UTIL_MODULES[origin]?.[name] === "function"
  );
}

Deno.test("every export is emitted or explicitly denylisted (no silent drift)", () => {
  for (const [namespace, mod] of Object.entries(UTIL_MODULES)) {
    const emitted = new Set((templateHelpers[namespace] ?? []).map((h) => h.name));

    const unaccounted = fnExports(mod).filter((n) => !emitted.has(n) && !isDenied(namespace, n));
    assertEquals(
      unaccounted,
      [],
      `new it.${namespace}.* exports — they are neither emitted nor denylisted. ` +
        `Re-run \`deno task generate-template-helpers\`, or hide them in ` +
        `scripts/template-helper-denylist.ts with a reason.`,
    );
  }
});

Deno.test("every denylist entry names a symbol that still exists", () => {
  // ⚠️ **The direction the drift test above cannot see.** It walks real exports
  // and asks whether each is accounted for; a denylist entry naming a function
  // that no longer exists accounts for nothing and is invisible to it.
  //
  // That is not hypothetical. `recomputePaymentTotals` sat in the `invoices`
  // denylist for months after the function was deleted, and nothing said so —
  // the entries are plain strings, so a rename or a deletion leaves a dead one
  // behind with no compile error and no failing test. Phase 11 renamed three
  // more in one commit (`computeItemTaxAmount`, `calculateTransactionFeeAmount`,
  // `getXeroUnitAmount`), which would have rotted the same way.
  //
  // A name may live in a namespace it does not originate in — `isDenied`
  // deliberately honours a cross-namespace entry for a re-export — so an entry
  // is valid if it resolves as a function under ANY injectable namespace.
  const everyExport = new Set(
    Object.values(UTIL_MODULES).flatMap((mod) => fnExports(mod)),
  );
  for (const [namespace, denied] of Object.entries(TEMPLATE_HELPER_DENYLIST)) {
    const dead = denied.filter((n) => !everyExport.has(n));
    assertEquals(
      dead,
      [],
      `it.${namespace}.* denylist names ${dead.length} symbol(s) that no longer exist: ` +
        `${dead.join(", ")}. A dead entry silences the drift guard for a name nothing ` +
        `exports — delete it, or fix the spelling if the function was renamed.`,
    );
  }
});

Deno.test("denylisted names are never emitted", () => {
  for (const [namespace, denied] of Object.entries(TEMPLATE_HELPER_DENYLIST)) {
    const emitted = new Set((templateHelpers[namespace] ?? []).map((h) => h.name));
    const overlap = denied.filter((n) => emitted.has(n));
    assertEquals(overlap, [], `it.${namespace}.* listed as both emitted and denylisted`);
  }
});

Deno.test("emitted expr lists at least the function's required args", () => {
  for (const [namespace, mod] of Object.entries(UTIL_MODULES)) {
    const fns = mod as Record<string, (...a: unknown[]) => unknown>;
    const offenders = (templateHelpers[namespace] ?? [])
      .filter((h) => typeof fns[h.name] === "function")
      .map((h) => ({ name: h.name, emitted: exprArgCount(h.expr), required: fns[h.name].length }))
      .filter((x) => x.emitted < x.required);
    assertEquals(offenders, [], `it.${namespace}.* expr lists fewer args than the function requires`);
  }
});

// ── Cross-namespace union (the 6 re-exported order write-path helpers) ──

/**
 * `utils/invoices.ts` re-exports 14 functions from `utils/orders.ts`. Six are
 * order write-path machinery denylisted under `orders`; they must not surface
 * under `it.invoices` just because they are re-exported there. The other eight
 * are render-useful and must survive — a blanket "drop all re-exports" filter
 * would have taken them too.
 */
const ORDER_WRITE_PATH_REEXPORTS = [
  "computeItemPaths",
  "validateItemPaths",
  "validateItemUniqueness",
  "getStructuralUids",
  "getParentProductUid",
  "getItemSubtreeRange",
];

const RENDER_USEFUL_REEXPORTS = [
  "calculateItemDiscountCents",
  "calculateItemPrice",
  "calculateItemSubtotal",
  "calculateItemTax",
  "calculateItemTotalCents",
  "isPriceableItem",
  "isPreTaxItem",
  "isTransactionFeeItem",
];

Deno.test("invoices: order write-path re-exports are suppressed", () => {
  const emitted = new Set((templateHelpers["invoices"] ?? []).map((h) => h.name));
  const exports = new Set(fnExports(invoiceUtils));

  for (const name of ORDER_WRITE_PATH_REEXPORTS) {
    assert(exports.has(name), `precondition: ${name} really is re-exported by utils/invoices`);
    assert(!emitted.has(name), `${name} leaked into it.invoices — cross-namespace union is not applied`);
  }
});

Deno.test("invoices: render-useful re-exports survive the union", () => {
  const emitted = new Set((templateHelpers["invoices"] ?? []).map((h) => h.name));
  for (const name of RENDER_USEFUL_REEXPORTS) {
    assert(emitted.has(name), `${name} was dropped from it.invoices — the union is over-broad`);
  }
});

// ── Descriptor sanity ───────────────────────────────────────────────

Deno.test("every injectable namespace resolves to a real, non-empty catalogue", () => {
  const injectable = [
    ...ALWAYS_ON_UTIL_NAMESPACES,
    ...Object.values(TEMPLATE_COLLECTION_UTILS).filter((ns): ns is string => !!ns),
  ];

  for (const namespace of injectable) {
    assertExists(UTIL_MODULES[namespace], `${namespace} is injectable but has no @cfs/core/utils entrypoint`);
    const entries = templateHelpers[namespace];
    assertExists(entries, `${namespace} is injectable but absent from the generated catalogue`);
    assertGreater(entries.length, 0, `${namespace} resolves to an empty helper list`);
  }
});

Deno.test("every emitted entry carries a description and a return type", () => {
  for (const namespace of Object.keys(templateHelpers)) {
    for (const entry of templateHelpers[namespace]) {
      assertGreater(entry.desc.length, 0, `it.${namespace}.${entry.name} has no description`);
      assertGreater(entry.returns.length, 0, `it.${namespace}.${entry.name} has no return type`);
      assert(
        entry.expr.startsWith(`it.${namespace}.${entry.name}(`),
        `it.${namespace}.${entry.name} has a malformed expr: ${entry.expr}`,
      );
    }
  }
});

// ── Resolver ────────────────────────────────────────────────────────

Deno.test("availableUtilNamespaces resolves the union of source + target", () => {
  // The live quote template.
  assertEquals(availableUtilNamespaces(["orders"], ["quotes"]), ["dates", "money", "icons", "organizations", "orders"]);
  // packing_lists contributes no namespace.
  assertEquals(availableUtilNamespaces(["orders"], ["packing_lists"]), ["dates", "money", "icons", "organizations", "orders"]);
  // The only combination where the target arm widens the union.
  assertEquals(
    availableUtilNamespaces(["orders"], ["invoices"]),
    ["dates", "money", "icons", "organizations", "orders", "invoices"],
  );
  // Source and target agreeing must not duplicate.
  assertEquals(availableUtilNamespaces(["invoices"], ["invoices"]), ["dates", "money", "icons", "organizations", "invoices"]);
  // The packing list: rendered FROM a fulfillment, produced INTO packing_lists.
  // `packing_lists` contributes nothing, so the whole document surface is
  // `it.fulfillments` — and there is deliberately no `it.orders`, because the
  // document being rendered is not an order.
  assertEquals(
    availableUtilNamespaces(["fulfillments"], ["packing_lists"]),
    ["dates", "money", "icons", "organizations", "fulfillments"],
  );
  // Always-on survives an empty collection set — `money` because every document
  // a template renders carries money, `icons` because a glyph is not a property
  // of the source collection (and a footer partial can have no other kind), and
  // `organizations` because every document names a customer and the one place
  // that name is rendered is a partial shared across every collection.
  assertEquals(availableUtilNamespaces([], []), ["dates", "money", "icons", "organizations"]);
});

Deno.test("availableUtilNamespaces takes lists (forward-compatible with multi-collection)", () => {
  assertEquals(
    availableUtilNamespaces(["orders", "invoices"], ["quotes", "packing_lists"]),
    ["dates", "money", "icons", "organizations", "orders", "invoices"],
  );
});

// ── The shared document sub-interface ───────────────────────────────
//
// A template partial shared between the quote and the invoice cannot NAME a
// util namespace: `availableUtilNamespaces` resolves `it.orders` for one family
// and `it.invoices` for the other, so `it.orders.orderHasTax(…)` in shared
// markup throws for every invoice. The templates repo passes the family's
// namespace object in as a prop (`u`) and calls `u.orderHasTax(…)` instead —
// which is sound only while both namespaces really do export the same names
// with the same arities.
//
// That is a claim about two modules, so it is asserted here rather than left to
// the re-export line in `utils/invoices.ts` to imply. Dropping one of these
// re-exports would otherwise be a silent 500 in a shared partial, on the invoice
// only, at render time — and the golden gate would not see it until an invoice
// family with a golden existed.

/**
 * Helpers a shared template partial may call through a family-supplied `u`.
 *
 * Adding to this list is a real decision: it must hold for EVERY family whose
 * namespace can be passed as `u`, which today means orders and invoices.
 */
const SHARED_DOC_HELPERS = [
  "getDestinationsLegend",
  "isSameAsDeliveryDates",
  "orderHasDiscount",
  "orderHasRentals",
  "orderHasTax",
] as const;

Deno.test("the shared sub-interface is exported by EVERY document namespace", () => {
  for (const name of SHARED_DOC_HELPERS) {
    for (
      const [ns, mod] of [
        ["orders", orderUtils],
        ["invoices", invoiceUtils],
        ["fulfillments", fulfillmentUtils],
      ] as const
    ) {
      const fn = (mod as Record<string, unknown>)[name];
      assertExists(fn, `it.${ns}.${name} is missing — a shared partial calling u.${name}() throws for that family`);
      assertEquals(
        typeof fn,
        "function",
        `it.${ns}.${name} is not callable`,
      );
    }
  }
});

Deno.test("the document namespaces agree on IDENTITY, not just on the name", () => {
  // A name check alone stays green against a re-export that resolves to a
  // different function — which is exactly what a hand-written invoice-side
  // reimplementation would be. `src/utils/invoices.ts` re-exports the orders binding, so
  // identity is the strongest available assertion and the cheapest to keep.
  for (const name of SHARED_DOC_HELPERS) {
    const o = (orderUtils as Record<string, unknown>)[name];
    for (const [ns, mod] of [["invoices", invoiceUtils], ["fulfillments", fulfillmentUtils]] as const) {
      assertEquals(
        (mod as Record<string, unknown>)[name],
        o,
        `it.${ns}.${name} is not the same function as it.orders.${name} — ` +
          `a shared partial would behave differently per family`,
      );
    }
  }
});

Deno.test("every shared helper is reachable from a real family's resolved namespaces", () => {
  // The property that actually matters at render time: for each family, the
  // namespace list its collections resolve to must contain a namespace that
  // carries the whole shared set. Asserting the modules alone would stay green
  // if a family stopped resolving to either of them.
  const families: Array<[string, TemplateCollectionType[], TemplateCollectionType[]]> = [
    ["quote", ["orders"], ["quotes"]],
    ["invoice", ["invoices"], ["invoices"]],
    // A packing list renders from what was PICKED — see TEMPLATE_COLLECTION_UTILS.
    ["packing-list", ["fulfillments"], ["packing_lists"]],
  ];
  const byNamespace: Record<string, unknown> = {
    orders: orderUtils,
    invoices: invoiceUtils,
    fulfillments: fulfillmentUtils,
  };

  for (const [family, sources, targets] of families) {
    const resolved = availableUtilNamespaces(sources, targets);
    const carrier = resolved.find((ns) =>
      ns in byNamespace &&
      SHARED_DOC_HELPERS.every((h) => typeof (byNamespace[ns] as Record<string, unknown>)[h] === "function")
    );
    assertExists(
      carrier,
      `the ${family} family resolves to [${resolved.join(", ")}], none of which carries the shared sub-interface`,
    );
  }
});

// ── Staleness ───────────────────────────────────────────────────────
//
// The byte-compare against a fresh render lives in `deno task check:generated`,
// not here — see the module doc for why it cannot run under this suite's
// permissions. The lockstep test above is the in-suite arm.
