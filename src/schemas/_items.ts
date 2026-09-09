/**
 * The line-item fields every grain shares, as ONE instance per field.
 *
 * `orders`, `invoices` and `fulfillments` are three grains of one document, and
 * their line-item schemas restated `uid`/`name`/`description`/`quantity`/`path`/
 * `zero_priced` independently. Three of those six had already drifted by
 * 2026-09-09 — the invoice's `name` was a bare `z.string()` where the other two
 * were `.min(1).max(100)`, and its `quantity` was `z.int()` with no `.min(0)` —
 * so an invoice line could store an empty name and a negative quantity that the
 * same line on the order it was billed from could not. Nothing detected it:
 * the vocabulary is shared (`ITEM_CONTRACTS`, `DOC_LINE_ITEM_TYPES`,
 * `_dividers.ts`), the SHAPES were not.
 *
 * INTERNAL — not an entrypoint in `deno.json`'s `exports` map. It is a shape
 * helper, not a public contract: consumers use the three grain schemas, and
 * exporting the parts they are assembled from would publish a second way to
 * spell a line item.
 *
 * ⚠️ **It sits beside `_dividers.ts` and is NOT the same case — the annotation
 * below is deliberate, and this header claimed the opposite until it was
 * measured.** `_dividers.ts` holds `z.discriminatedUnion` ARMS, which must stay
 * un-annotated because a `z.ZodType<T>` annotation erases the `_zod.propValues`
 * the union needs at the type level; it carries a `check-declarations`
 * exemption for exactly that. None of the fields here is a discriminator — each
 * grain inlines its own `type` enum — so nothing is erased, and the assumption
 * that the exemption transferred was wrong. Verified 2026-09-09 by annotating
 * and re-measuring: `deno check` clean, `getInitialValues` and all six column
 * surfaces byte-identical, `description`'s `.default("")` still materializing.
 * **So this file needs no exemption, and must not be given one** — an exemption
 * that silences a class nothing exhibits is the stale-entry failure
 * `check-declarations.ts` documents.
 *
 * ⭐ **Referenced per key, NOT spread.** `z.strictObject({ ...LineItemCore, … })`
 * is the shorter form and it was the original design; it is not used, because
 * the shape's key order becomes the schema's key order and `getFirestoreColumns`
 * walks the shape — so a spread silently reorders the operator's column picker
 * on all three surfaces. The six fields are not contiguous in any grain (`type`
 * sits second in all three, and `path`/`zero_priced` sit in three different
 * places), so there is no key order for this object that leaves all three grains
 * unchanged.
 *
 * ⚠️ **Per-key referencing gives up the one thing a spread buys — a new field
 * arriving on all three grains for free — so the guarantee is moved to a test
 * instead.** `tests/item-shape-parity.test.ts` asserts every key here appears in
 * all three grains carrying the *identical instance*. That is strictly stronger
 * than the spread it replaces: it also catches a grain SHADOWING a shared key
 * with its own declaration, which is precisely how `name` and `quantity`
 * drifted, and which a spread cannot see because the later key silently wins.
 *
 * 🔴 **Sharing the instance is what makes `.meta()` safe.** `z.globalRegistry` is
 * a WeakMap keyed on the schema instance, so a re-declaration carries none of
 * the base's annotations — and a dropped `pii` tag is invisible to
 * `tests/pii.test.ts` by construction (`_extend.ts:8-29`). A grain that
 * genuinely needs a different heading writes `LineItemCore.name.meta({ … })`,
 * which clones visibly at the call site.
 *
 * @module
 */
import { z } from "zod";
import { ItemUid } from "./_uid.ts";

/**
 * The six fields an order line, an invoice line and a fulfillment line all
 * carry, each declared exactly once.
 *
 * `type` is deliberately NOT here: the three vocabularies genuinely differ
 * (`DOC_LINE_ITEM_TYPES` for order and invoice, `FULFILLMENT_LINE_ITEM_TYPES`
 * for fulfillment, which has no fee arm), and each grain must inline its own
 * `z.enum(...)` anyway so `_zod.propValues` survives for `z.discriminatedUnion`
 * — see `_dividers.ts`.
 *
 * `price` is not here either, and for a different reason: a fulfillment line has
 * none at all. That absence is load-bearing rather than incidental — it is why
 * `assertArrayUniqueness` keeps orders and fulfillments in separate branches
 * (`api-cloudrun/src/lib/firestoreWrite.ts`), because `T[]` is invariant.
 */
export const LineItemCore: {
  uid: z.ZodType<string>;
  name: z.ZodString;
  description: z.ZodDefault<z.ZodString>;
  quantity: z.ZodDefault<z.ZodNumber>;
  path: z.ZodDefault<z.ZodArray<z.ZodType<string>>>;
  zero_priced: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
} = {
  uid: ItemUid,

  // CANONICAL RATIONALE for every item `name` in the package — the divider,
  // transaction-fee, invoice and fulfillment leaves all point back here (#40).
  //
  // Catalog product name ("Dewalt Work Light") — NOT customer data, so it
  // survives fixture sanitization verbatim, which is the whole point of drawing
  // fixture line items from real orders. Tagged explicitly rather than left
  // untagged so the decision is visible and the drift gate can see it. Custom
  // items put operator-typed text here, but it is equipment/service text by
  // convention.
  //
  // An item `name` is a LABEL — catalog text, a section header, a venue, a tax
  // name, `Order #NNN`. It is not a person or an organization, which is why
  // `order` / `invoice` / `fulfillment` are now listed in `NAME_SENSITIVE`
  // (`src/schemas/pii/dictionary.ts`) — being listed there forces every `name`
  // under them to state an answer instead of defaulting into one.
  //
  // ⚠️ **The bounds are the tightening.** The invoice carried a bare
  // `z.string()` here until 2026-09-09; adopting this instance is what gives it
  // the bounds the other two grains already had. Cleared to land by
  // `api-cloudrun/scripts/audit-document-grain-parity.ts`: 0 invoice lines are
  // empty or over 100 in either project, and 0 of the 154 line items across the
  // 23 committed `invoice`+`quote` fixtures in `templates` (7-46 chars).
  name: z.string().min(1).max(100).meta({ pii: "none", column: true }),

  // Line-item text, classified the same as `name` above: it carries equipment,
  // service and destination wording — a PO number, a product name — not customer
  // data. It previously masked on the theory that a custom item's description
  // paraphrases the customer; that is not what the field is used for in practice.
  //
  // Tagged explicitly rather than left untagged so the decision is visible and
  // the drift gate can see it, and so every `items[].description` in the package
  // (order, invoice, fulfillment, and their input schemas) states one answer.
  // Consequence: it survives fixture sanitization verbatim and appears raw in
  // logs — the same posture `name` has always had.
  description: z.string().meta({ pii: "none", column: true, label: "Description" }).default(""),

  // ⚠️ **`.min(0)` is the tightening.** The invoice declared `z.int()` with no
  // lower bound until 2026-09-09, so an invoice line could store a negative
  // quantity that the order line it was billed from could not. Cleared the same
  // way as `name` above: 0 negative quantities in either project, 0 across the
  // fixture corpus.
  //
  // ⭐ Spelled `z.number().int().min(0)` rather than `z.int().min(0)` because
  // that is what the order and fulfillment grains already carried, and the two
  // produce a different `_zod.def.type` — keeping the existing spelling is what
  // makes this a no-op for those two rather than a change nobody asked for.
  quantity: z.number().int().min(0).default(0).meta({ column: true, label: "Quantity" }),

  // 🔴 The row identity, and it has exactly ONE author — `computeItemPaths` in
  // `src/utils/orders.ts`. An item's `path` is `[...its resolved parent's path,
  // own uid]`, derived from the parent and never from the client's chain.
  // `item.uid` is NOT a row identity: it repeats within one document, in 18% of
  // prod orders, which is why `uid_parent: string` is unrepresentable and why
  // this field exists.
  path: z.array(ItemUid).default([]),

  // Mirrored across all three grains with the same display-column metadata
  // (`manager#421`), so the column renders identically wherever it appears.
  //
  // ⚠️ **`.nullable().optional()` is the CURRENT state, not the intended one.**
  // A component that states no answer here has its billing decided by a default:
  // `checkZeroPricedAmount` fires only on `=== true` and the zero-priced-first
  // sort groups only on `=== true`, so an absent value silently resolves to
  // *charged*. Making it required on components is a measured ~9,214-row
  // backfill across the three collections and is tracked as its own campaign —
  // deliberately NOT a rider on this module. Do not tighten it here without
  // that backfill.
  zero_priced: z.boolean().nullable().optional().meta({ column: true, label: "Zero Priced" }),
};
