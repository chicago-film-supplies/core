/**
 * Every organization snapshot shares ONE instance of `uid` and `path`.
 *
 * `OrgSnapshotCore` (`schemas/common.ts`) declares the two keys every snapshot
 * carries: the document snapshot on orders, invoices and credit notes,
 * plus the fulfillment, card, booking and out-of-service ones. Until it existed
 * each re-declared the pair, and the document snapshot declared its own `path`,
 * a node structurally identical to `OrderDerivedOrgPath` and unrelated to it in
 * `z.globalRegistry`. "The fulfillment's organization is a subset of the
 * order's" held only because two literals happened to agree.
 *
 * 🔴 **Instance identity, not structural equality, and a spread does not retire
 * it.** `{ ...OrgSnapshotCore, path: z.array(OrgPathNode) }` compiles and the
 * later key silently wins, carrying none of the base's `.meta()` (`column`,
 * `label`, the `pii` on `OrgPathNode.name` reached through it). Only `===` sees
 * that, which is the `tests/item-shape-parity.test.ts` argument one level up.
 *
 * Reached through the PUBLIC collection schemas, so what is checked is what a
 * consumer parses with.
 */
import { assert, assertEquals } from "@std/assert";
import { z } from "zod";
import { OrgPathNode, OrgSnapshotCore } from "../src/schemas/common.ts";
import { schemas } from "../src/schemas/mod.ts";

const SNAPSHOT_HOLDERS = [
  "orders",
  "invoices",
  "credit-notes",
  "fulfillments",
  "cards",
  "bookings",
  "out-of-service",
] as const;

/** Peel optional / nullable / default / pipe wrappers down to the object node. */
// deno-lint-ignore no-explicit-any
function objectShape(node: any, where: string): Record<string, unknown> {
  let n = node;
  for (let i = 0; i < 10 && n._zod.def.type !== "object"; i++) {
    n = n._zod.def.innerType ?? n._zod.def.in ?? n._zod.def.schema;
    assert(n !== undefined, `${where}: no object under the wrappers`);
  }
  assertEquals(n._zod.def.type, "object", `${where}: not an object`);
  return n._zod.def.shape;
}

/** The two shared keys a snapshot shape does NOT take from `OrgSnapshotCore`. */
function shadowed(shape: Record<string, unknown>): string[] {
  return (["uid", "path"] as const).filter((k) => shape[k] !== OrgSnapshotCore[k]);
}

Deno.test("org snapshot parity: every holder's organization takes uid and path from OrgSnapshotCore", () => {
  const checked: string[] = [];
  for (const collection of SNAPSHOT_HOLDERS) {
    // deno-lint-ignore no-explicit-any
    const root = (schemas as Record<string, any>)[collection];
    assert(root !== undefined, `${collection} is not in the schemas registry`);
    const org = objectShape(root, collection).organization;
    assert(org !== undefined, `${collection} carries no organization`);
    assertEquals(shadowed(objectShape(org, `${collection}.organization`)), [], `${collection}.organization re-declares`);
    checked.push(collection);
  }
  // Not vacuous: a renamed collection would otherwise drop out of the loop silently.
  assertEquals(checked, [...SNAPSHOT_HOLDERS]);
});

Deno.test("org snapshot parity: the predicate catches a holder that shadows a shared key", () => {
  // The negative control. A structurally identical re-declaration is exactly
  // what `DocumentOrganizationSnapshot.path` was, and it must read as shadowed.
  const shadowing = z.strictObject({ ...OrgSnapshotCore, path: z.array(OrgPathNode).min(1).max(3) });
  assertEquals(shadowed(objectShape(shadowing, "planted")), ["path"]);
  const spreadOnly = z.strictObject({ ...OrgSnapshotCore, crms_id: z.int().nullable() });
  assertEquals(shadowed(objectShape(spreadOnly, "planted")), []);
});
