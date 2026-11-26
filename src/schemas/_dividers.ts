/**
 * Structural divider arms shared by the order and invoice item unions.
 *
 * INTERNAL — not an entrypoint in `deno.json`'s `exports` map, and deliberately
 * so. These consts carry **no type annotation**, because a
 * `z.discriminatedUnion` arm must expose `_zod.propValues` at the *type* level
 * and a `z.ZodType<T>` annotation erases it (`TS2322: Type 'PropValues |
 * undefined' is not assignable to type 'PropValues'`). JSR's no-slow-types rule
 * forbids an un-annotated symbol in the **public** API, so the un-annotated form
 * can only live in a module nothing re-exports.
 *
 * `order.ts` re-exports each of these under its annotated public name
 * (`OrderDocDestinationItem` / `OrderDocGroupItem`) — the annotation is what
 * consumers see; the raw const is what the unions are built from. `invoice.ts`
 * imports the raw consts for the same reason: its `InvoiceDocItem` union needs
 * the same two arms and cannot get them through the annotated re-export.
 *
 * @module
 */
import { z } from "zod";
import { ItemUid } from "./_uid.ts";
import { extendChecked } from "./_extend.ts";

/** Destination divider in an order/invoice items array. */
export const DestinationDividerArm = z.strictObject({
  uid: z.uuid(),
  type: z.literal("destination"),
  // 🔴 **`mask`, reversing the `none` ruling that stood here — on a MEASUREMENT.**
  // The previous ruling was defensible and its evidence was real: operator-typed
  // divider labels are usually venues (`Fillmore` — CFS's own counter, 117/203
  // orders in the dev replica — `Cinespace`, `Museum of Science & Industry`), and
  // **0 of 1,220 matched a contacts-doc name**.
  //
  // ⚠️ **But that oracle asked "is this a PERSON", and the hazard is broader.**
  // Measured 2026-09-05 over the 23 committed fixtures in the `templates` repo:
  // **3 of the 9 distinct destination-divider names are customer data** — one
  // ORGANIZATION name and two street addresses, sitting in git. An LLC is not a
  // person, so the original measurement was satisfied and the case was missed.
  // The owner confirmed the organization fall-through was not considered.
  //
  // ⭐ **The contrast is what scopes this to the DESTINATION divider alone.** The
  // same measurement over `GroupDividerArm.name` below returns **19 distinct
  // values and zero PII** — catalog section text. So this is a fact about where
  // an operator types a place, not about operator-typed labels in general, and a
  // blanket sweep would be wrong.
  //
  // ⚠️ Known give-back, accepted deliberately: a venue label is 2-3 alphabetic
  // tokens, which is exactly `fixturePiiStrategy.fakeForMask`'s person branch, so
  // `Oak Brook Mall` masks to `Jordan B Holloway`. That is a LEGIBILITY defect,
  // not a leak — the real value is removed either way — and it is tracked at
  // api-cloudrun#837. ⭐ It is NOT the "street address becomes a person" case that
  // was claimed while this was being decided: `fakeForMask` tests for a leading
  // digit FIRST, so an address masks to an address. Measured, not reasoned.
  //
  // **REQUIRED — the inert `.default("")` came off 2026-09-11 (core#95 batch 7).**
  // It never reached storage (`validateBeforeWrite` writes the raw document), so
  // it only ever let a partial divider PARSE. Gated by the corpus: `orders`
  // 1,021 / `invoices` 1,009 / `fulfillments` 1,021 destination dividers, **every
  // one stating a non-null name, in both projects**. ⚠️ `""` is still a legal
  // stored value — there is no `.min(1)` here, unlike `GroupDividerArm.name`
  // below — so this requires the KEY and says nothing about the VALUE.
  name: z.string().max(200).meta({ pii: "mask" }),
  // REQUIRED — the inert `.default([])` came off (core#95 batch 13). See
  // `_items.ts`'s `LineItemCore.path` for the row-identity rationale and the
  // corpus/writer evidence, which covers this arm too.
  path: z.array(ItemUid),
  // 🔴 **There is no `uid_delivery`/`uid_collection` here, and re-adding either
  // re-opens api-cloudrun#662/#663/#664.** They were a SECOND copy of the pair's
  // own `delivery.uid`/`collection.uid` — a join by VALUE across two arrays,
  // where every one of those three defects is one copy moving without the other.
  // A section's endpoint is reached through the PAIR its `uid` names
  // (`destinations[i].uid === this divider's uid`), which is the only copy.
  // Removed in three steps 2026-08-25: writers stopped, both corpora purged
  // (2,981 prod documents / 2,980 dev, 0 failed), then this arm tightened.
  description: z.string().meta({ pii: "none" }),
});

/**
 * **A BILLING document's destination divider**: the initiator's divider, plus the
 * one key only a billing document can carry. Declared once for both sides
 * (one-document-model 6e-0b2 F5, ruling 89): an invoice's rows and a bill's or
 * supplier credit's rows take this arm.
 *
 * `path_extension_for` marks a **date-extension section** (api-cloudrun#680 R1;
 * owner decisions 2026-09-13, extended to the payable side by ruling 89 —
 * "it's just another dates/destination pair with the extended time window"):
 *
 * - **Dates and destinations ride together**, so a second date range is a second
 *   destination section even at the same address. Its pair
 *   (`destinations[i].uid === this divider's uid`) states the billed window.
 * - **The link is by PATH**: the value is the INITIATOR-relative path of the
 *   initiator destination divider this section extends. Alignment and the one
 *   billing fold (`billedByPath`) read an extension section as that divider, so
 *   its lines bill the initiator's lines there.
 * - **The no-minimum rule is DERIVED from the section, never stored on the
 *   line**: `priceDocument` prices every line under an extension section at its
 *   own stated `counts`, the formula's minimum skipped.
 *
 * `null` on every divider that does not open a section (ruling 204, class C: a
 * POINTER path's empty value is `null`, never `[]`, and the key is required — a
 * submitted row states every key). A supplier credit admits the key through
 * the shared row union and no writer sets it there.
 */
export const DestinationSectionDividerArm = extendChecked(DestinationDividerArm, {
  path_extension_for: z.array(ItemUid).min(1).nullable(),
});

/** Group divider in an order/invoice items array. */
export const GroupDividerArm = z.strictObject({
  uid: z.uuid(),
  type: z.literal("group"),
  // Operator-typed section header, drawn from the catalog rather than the
  // customer: `Delivery` (68), `Hair & Makeup` (57), `Tables & Chairs` (50) in
  // the dev replica. 0 occurrences match a contact or organization name. A
  // label, so `none` — see `OrderDocLineItem.name`.
  name: z.string().min(1).max(100).meta({ pii: "none" }),
  // REQUIRED — see `DestinationDividerArm.path` above.
  path: z.array(ItemUid),
  description: z.string().meta({ pii: "none" }),
});

/**
 * **A credit's billing-document divider** (one-document-model ruling 107): the
 * CREDIT role's top level on both sides, declared once and joined to the AR
 * credit note's and the supplier credit's row unions — never an initiator's or a
 * billing document's.
 *
 * Its `uid` IS the billing document's Firestore id (an invoice's or a bill's),
 * as an invoice's `order` divider's is its order's. Under it sit that billing
 * document's own rows, copied with their paths one level deeper:
 * `[uid_billing, ...billing row path]`, the initiator divider included. So a
 * credit naming a deposit invoice and a final invoice that bill ONE order line
 * holds two rows that cannot collide (invariant 1), and the fold keys each to its
 * own billing document.
 *
 * Only a credit line that names its billing row (`uid_billing` +
 * `path_billing_item`) sits under one; an unpointed line (a goodwill, bad-debt,
 * pool or charge-only credit) sits outside every billing divider, under its
 * initiator divider or at the root.
 *
 * `name` is machine-generated (`Invoice #NNN` / `Bill #NNN`), as an order
 * divider's is, so `none`.
 */
export const BillingDividerArm = z.strictObject({
  uid: ItemUid,
  type: z.literal("billing"),
  name: z.string().max(200).meta({ pii: "none" }),
  path: z.array(ItemUid),
  description: z.string().meta({ pii: "none" }),
});

/**
 * An invoice's `order` divider — scopes a billing document's rows to a source
 * order, and on an AR credit note sits under the `billing` divider of the
 * invoice whose rows it credits (ruling 107). Its `uid` IS the order's
 * Firestore id. Moved here from `schemas/invoice.ts` so both unions share one
 * instance.
 */
export const OrderDividerArm = z.strictObject({
  // Option B: the order divider's identity IS the source order's Firestore doc-id
  // (order.uid), not a synthesized UUID — so this is z.string(), not z.uuid().
  uid: ItemUid,
  type: z.literal("order"),
  // Machine-generated, not operator-typed: 218/218 order dividers in the dev
  // replica are literally `Order #NNN`. See `OrderDocLineItem.name`.
  //
  // **REQUIRED — the inert `.default("")` came off 2026-09-11 (core#95 batch 7).**
  // 1,009 of 1,009 stored order dividers state it in both projects, and the sole
  // writer builds the literal `Order #NNN` above. ⚠️ A SEPARATE declaration from
  // `DestinationDividerArm.name`, which moved in the same batch — a field name is
  // not a node, and only reading both said the two agree.
  name: z.string().max(200).meta({ pii: "none" }),
  // REQUIRED — the inert `.default([])` came off (core#95 batch 13), same
  // rationale as `_items.ts`'s `LineItemCore.path`. `computeInvoiceItemPaths`
  // is the sole author of every order divider's path.
  path: z.array(ItemUid),
  description: z.string().meta({ pii: "none" }),
});
