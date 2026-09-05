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
  name: z.string().max(200).meta({ pii: "mask" }).default(""),
  path: z.array(ItemUid).default([]),
  // 🔴 **There is no `uid_delivery`/`uid_collection` here, and re-adding either
  // re-opens api-cloudrun#662/#663/#664.** They were a SECOND copy of the pair's
  // own `delivery.uid`/`collection.uid` — a join by VALUE across two arrays,
  // where every one of those three defects is one copy moving without the other.
  // A section's endpoint is reached through the PAIR its `uid` names
  // (`destinations[i].uid === this divider's uid`), which is the only copy.
  // Removed in three steps 2026-08-25: writers stopped, both corpora purged
  // (2,981 prod documents / 2,980 dev, 0 failed), then this arm tightened.
  description: z.string().meta({ pii: "none" }).default(""),
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
  path: z.array(ItemUid).default([]),
  description: z.string().meta({ pii: "none" }).default(""),
});
