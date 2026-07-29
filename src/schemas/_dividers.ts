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
import { FirestoreId, ItemUid } from "./_uid.ts";

/** Destination divider in an order/invoice items array. */
export const DestinationDividerArm = z.strictObject({
  uid: z.uuid(),
  type: z.literal("destination"),
  // Operator-typed divider label — a VENUE, not a person: `Fillmore` (CFS's own
  // counter, 117/203 orders in the dev replica), `Cinespace`, `Museum of Science
  // & Industry`. 0 of 1,220 destination-divider names across orders and
  // fulfillments match a contacts-doc name. A label, so `none` — see
  // `OrderDocLineItem.name`.
  //
  // GIVE-BACK, stated plainly: ~10-13% of these are a street address an operator
  // typed as the label, and those now reach logs and newly captured fixtures
  // verbatim. The delivery address proper lives in `destinations[].address`,
  // which stays `mask`. The mask being removed here was also producing wrong
  // output — `fixturePiiStrategy.fakeForMask` shape-detects 2-3 alphabetic
  // tokens as a person, so `Oak Brook Mall` was captured as `Jordan B Holloway`.
  name: z.string().max(200).meta({ pii: "none" }).default(""),
  path: z.array(ItemUid).default([]),
  uid_delivery: FirestoreId.nullable().default(null),
  uid_collection: FirestoreId.nullable().default(null),
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
