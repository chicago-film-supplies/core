/**
 * Destination document schema — Firestore collection: destinations
 */
import { z } from "zod";
import { FirestoreId } from "./_uid.ts";
import {
  Address,
  type AddressType,
  type FirestoreTimestampType,
  JurisdictionEnum,
  type JurisdictionType,
  NameField,
  type NameParts,
  NamePartsFields,
  TimestampFields,
} from "./common.ts";

/**
 * The two levels of the destination tree — `DESTINATION_LEVELS[path.length - 1]`.
 *
 * ⚠️ **A PROPERTY is one STREET ADDRESS, not a brand.** `.max(2)` is what makes
 * a "Cinespace" umbrella over three lots unrepresentable, and that is the
 * owner's rule 1 rather than a budget: a second street address held as a unit
 * would overwrite the address a driver is actually sent to. The three lots are
 * three properties. See `api-cloudrun/.claude/data/destination-tree/properties.yaml`.
 */
export const DESTINATION_LEVELS = ["property", "unit"] as const;

/** The level a destination node sits at, read off `path.length`. */
export type DestinationLevelType = typeof DESTINATION_LEVELS[number];

/**
 * One node of a destination's ancestor chain — `{uid, name}`, and deliberately
 * NOT {@link OrgPathNodeType}.
 *
 * Three differences, each load-bearing:
 *
 * 1. **No `derived`.** Nothing mints a destination node as a placeholder; the
 *    one document this campaign creates is minted by the operator-authored
 *    migration, from a YAML the owner ruled. A flag with one constant value is
 *    a field that will be read as meaning something.
 * 2. **`name` may be EMPTY on a property**, where `OrgPathNode.name` is
 *    `.min(1)`. A property is identified by its STREET ADDRESS, and one of the
 *    three in the corpus (`211 E Chicago Ave`) has no place name at all — the
 *    owner's words were *"the building is 211 E Chicago"*. The non-empty
 *    requirement therefore lands on the UNIT leaf alone, where it is real:
 *    a unit's name IS `address.street2`, and an empty line 2 is not a unit.
 * 3. **`path[0].name` mirrors `address.name` on EVERY node of a property**, root
 *    and unit alike, so the denorm is checkable from ONE document rather than
 *    by a fan-out. That is the whole reason the migration rewrites a unit's
 *    `address.name` to the place name: the unit designator moves to `street2`
 *    and the place name is what is left.
 */
export interface DestinationPathNodeType {
  uid: string;
  name: string;
}

/** Zod schema for one node of a destination's ancestor chain. */
export const DestinationPathNode: z.ZodType<DestinationPathNodeType> = z.strictObject({
  uid: FirestoreId,
  name: z.string().max(100).meta({ pii: "mask" }),
});

/**
 * Contact reference embedded in a destination document.
 *
 * Mirrors the split-name shape used in `organizations.contacts[]` so that the
 * Typesense `destinations_v5` collection can index the same `first_name /
 * middle_name / last_name / pronunciation` fields without an adapter. `name`
 * is the server-derived display string (see `deriveName` in common.ts).
 */
export interface DestinationContactRefType extends NameParts {
  uid: string;
  name: string;
}

/** Zod schema for a contact reference embedded in a destination. */
export const DestinationContactRef: z.ZodType<DestinationContactRefType> = z.strictObject({
  uid: FirestoreId,
  ...NamePartsFields,
  name: NameField,
});

/** Full Firestore document for a destination (a physical address used in orders). */
export interface Destination {
  uid: string;
  address: AddressType | null;
  mapbox_ids: string[];
  /**
   * This node's SELF-INCLUSIVE ancestor chain — `[property, unit]` for a unit,
   * `[itself]` for everything else.
   *
   * 🔴 **ONE author: {@link computeDestinationNode} in `utils/destinations.ts`.**
   * The same rule `computeItemPaths` carries for `items[].path` and
   * `computeOrganizationNode` for the org tree, and for the same reason — a
   * chain the client sends can name a parent that is itself a unit, or a parent
   * that does not exist. The server derives it from the RESOLVED parent or not
   * at all.
   *
   * ✅ **REQUIRED since the contract third of the rollout.** It was
   * `.optional()` through the expand — storage carried the key on 0 of 258 prod
   * / 259 dev documents when it shipped (2026-09-19), so under `z.strictObject`
   * the reader had to deploy before the backfill could write one. The backfill
   * then ran in both corpora and the census came back **258/258 prod and
   * 259/259 dev** (2026-09-20), which is what made this tighten safe.
   * `findOrCreateDestination` authors `path` at create time, so the corpus
   * cannot re-diverge.
   */
  path: DestinationPathNodeType[];
  /**
   * Flat mirror of `path.map(n => n.uid)` — **FIRESTORE-ONLY**, for the single
   * thing Firestore cannot do natively: `array-contains` compares WHOLE
   * elements, so it cannot match a uid nested inside an array of objects.
   * `where("query_by_path", "array-contains", uid)` is what answers *"every
   * unit of this property"* in one query.
   *
   * ⚠️ **Typesense needs no such field** — `enable_nested_fields` indexes
   * `path.uid` natively. This is a limitation of the other store, not a shape
   * the index wants, which is why the org tree's mirror has the same asymmetry.
   *
   * 🔴 It is also what `getOpenBookingsAtDestination` must use rather than an
   * `in` over a property's units: Firestore caps a disjunction at 30 and a
   * property has no bound on its unit count.
   */
  query_by_path: string[];
  /**
   * The tax jurisdiction this PROPERTY asserts, `null` when the address derives
   * it correctly — which is both properties in the corpus today.
   *
   * 🔴 **An AUTHORING-TIME SEED for the picker, and never a rung in
   * `resolveJurisdiction`.** api-cloudrun#591 deleted the destination-master
   * jurisdiction level because *"a destination is keyed by address and reused
   * across orders and years, so a stamped jurisdiction goes wrong
   * prospectively"*. That objection is about a value READ AT PRICING TIME for an
   * existing order; the tax ladder reads `order.destinations[i].jurisdiction` —
   * a snapshot frozen on the order's own pair — and this field feeds
   * `deriveJurisdiction` a better default when a pair is first authored.
   * Verified against `utils/taxes.ts`: `resolveJurisdiction` has exactly three
   * rungs and no destination-master rung. **Adding a fourth re-opens #591.**
   *
   * ⚠️ **Stated on the PROPERTY, absent on the UNIT** — the direct analogue of
   * organization invariant 12. No property straddles a municipal boundary
   * (owner, 2026-09-19), so "a stage states its own jurisdiction" is made
   * unrepresentable rather than policed.
   *
   * 🔴 **So this one field stays `.optional()` while `path` and
   * `query_by_path` tighten, and that is a RULING rather than a leftover**
   * (owner, 2026-09-20). Census at the tighten: the key was absent on exactly
   * the 13 units and present on all 245 prod / 246 dev non-units — the split is
   * clean and it is AUTHORED, `migrate-destination-tree.ts` deleting the key on
   * a unit rather than writing `null` there. Requiring it would either make
   * every unit document unparseable under `z.strictObject` or force a
   * present-and-null on a level that asserts nothing, so the general
   * prefer-`.nullable()` ruling (`tests/stored-optionality.test.ts`) does not
   * reach here: **absence is the meaning.** Invariant 6 below still refuses a
   * unit that states one.
   */
  jurisdiction?: JurisdictionType | null;
  contacts?: DestinationContactRefType[];
  version: number;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}

/**
 * The FIVE tree invariants that read **ONE document and nothing else**.
 *
 * 🔴 **Asserted DIRECTLY, not through a fixed-point check.** *"`path` equals
 * what {@link computeDestinationNode} would produce"* is defined in terms of the
 * author and can therefore only ever agree with it — the shape that certified
 * 79 provably-wrong item paths as clean, corpus-wide. The cross-document half
 * (a unit's `path.slice(0, -1)` equalling its property's `path`) is the audit's,
 * because it needs a second document; everything below needs none.
 *
 * ⚠️ **Every arm was once guarded on `path` being present, and that guard came
 * out WITH the optionality, in the same commit** — left in afterwards it makes
 * every invariant inert on exactly the documents a backfill missed, which is
 * the only population they were ever needed for.
 */
function checkDestinationNode(doc: Destination, ctx: z.RefinementCtx): void {
  const path = doc.path;

  const leaf = path[path.length - 1];
  const isUnit = path.length === DESTINATION_LEVELS.length;

  // 1. self-inclusive: the last node IS this document. `assertValidForWrite`
  //    compares `doc.uid` to `ref.id` and nothing checks `path.at(-1).uid`, so
  //    this second copy of the id is defended here or nowhere.
  if (leaf !== undefined && leaf.uid !== doc.uid) {
    ctx.addIssue({
      code: "custom",
      path: ["path", path.length - 1, "uid"],
      message: `path is self-inclusive: path.at(-1).uid must equal uid (${doc.uid}), got ${leaf.uid}`,
    });
  }

  // 2. the Firestore-only flat mirror is exactly the uids of `path`.
  const expected = path.map((n) => n.uid);
  const actual = doc.query_by_path;
  if (actual.length !== expected.length || actual.some((u, i) => u !== expected[i])) {
    ctx.addIssue({
      code: "custom",
      path: ["query_by_path"],
      message: `query_by_path must equal path.map(n => n.uid) — expected [${expected.join(", ")}], got [${actual.join(", ")}]`,
    });
  }

  // 3. `address.street2` IS the unit node's name, and exists on nothing else.
  //
  //    🔴 This is what makes `street2` DERIVED rather than a second field an
  //    operator can type. It was empty on all 322 documents while ≥14 carried
  //    unit text inside `street` — the problem was a missing CONCEPT, not a
  //    missing field, and a hand-written `street2` on a 2-level destination
  //    would be a second, unauthored answer to "which unit".
  const street2 = doc.address?.street2;
  if (doc.address != null) {
    if (isUnit && street2 !== leaf.name) {
      ctx.addIssue({
        code: "custom",
        path: ["address", "street2"],
        message: `address.street2 is DERIVED from the unit node — expected "${leaf.name}", got ${street2 === undefined ? "(absent)" : `"${street2}"`}. Author it through computeDestinationNode.`,
      });
    }
    if (!isUnit && street2 !== undefined && street2 !== "") {
      ctx.addIssue({
        code: "custom",
        path: ["address", "street2"],
        message: `a ${DESTINATION_LEVELS[path.length - 1]} has no line 2 — address.street2 is "${street2}" but this node has no unit above it. Re-parent it under a property instead.`,
      });
    }
  }

  // 4. a UNIT's own name is non-empty, because it IS line 2. A property's may be
  //    empty: `211 E Chicago Ave` is identified by its street address alone.
  if (isUnit && leaf !== undefined && leaf.name.trim() === "") {
    ctx.addIssue({
      code: "custom",
      path: ["path", path.length - 1, "name"],
      message: "a unit's name IS address.street2, so it cannot be empty — an empty line 2 is not a unit",
    });
  }

  // 5. the place name is denormalized ONCE per node, at `path[0]`, and mirrors
  //    `address.name` on root and unit alike. That symmetry is what keeps the
  //    denorm checkable from one document; a property rename rewrites both
  //    fields on the whole subtree in one pass.
  if (doc.address != null && path.length > 0 && path[0].name !== doc.address.name) {
    ctx.addIssue({
      code: "custom",
      path: ["path", 0, "name"],
      message: `path[0].name denormalizes the PROPERTY's place name and must equal address.name ("${doc.address.name}"), got "${path[0].name}"`,
    });
  }

  // 6. the jurisdiction seed is stated on the PROPERTY and absent on the UNIT —
  //    organization invariant 12, one level shallower. No property straddles a
  //    municipal boundary, so a unit asserting its own is unrepresentable
  //    rather than policed.
  if (isUnit && doc.jurisdiction != null) {
    ctx.addIssue({
      code: "custom",
      path: ["jurisdiction"],
      message: `a unit inherits its property's jurisdiction and states none of its own — got "${doc.jurisdiction}". State it on ${path[0].uid}.`,
    });
  }
}

/** Zod schema for Destination. */
export const DestinationSchema: z.ZodType<Destination> = z.strictObject({
  uid: FirestoreId,
  address: Address,
  // Required (no `.default([])`): the Typesense config declares it so, and a
  // `.default()` never materializes on a write — see the note in `product.ts`.
  mapbox_ids: z.array(z.string()),
  // ── The tree ────────────────────────────────────────────────────────────
  //
  // ✅ **The expand/migrate/contract is COMPLETE for `path` and
  // `query_by_path`.** Under `z.strictObject` there was no safe direction: the
  // reader deployed (`beta.510`), the backfill wrote both corpora, and the
  // optionality comes off here against a measured 258/258 prod, 259/259 dev.
  // ⚠️ **`jurisdiction` does NOT come with them** — its absence on a unit is
  // the meaning, not a gap. See the field docs on {@link Destination}.
  //
  // ⭐ **A `query_by_path` here is sound where the three deleted `query_by_*`
  // mirrors were not** (api-cloudrun#650). Those mirrored `organizations[]`,
  // which means *"the org that FIRST CREATED this address"* — all three match
  // branches of `findOrCreateDestination` return the found uid and write
  // nothing back — and *a mirror cannot be more correct than the array it
  // mirrors*. `path` is SERVER-AUTHORED by a single function, so mirroring it
  // is mirroring a fact rather than an accident. `organizations.query_by_path`
  // is the working precedent.
  path: z.array(DestinationPathNode).min(1).max(DESTINATION_LEVELS.length).meta({
    column: true,
    label: "Property",
  }),
  query_by_path: z.array(z.string()),
  jurisdiction: JurisdictionEnum.nullable().optional().meta({ label: "Jurisdiction" }),
  // `contacts`: declared ahead of use. 192 of 458 prod destinations carried the
  // key, none with an element (2026-08-23) — the feature has not shipped.
  // Deliberately carries no issue; this line is the record.
  // CLAUDE.md § "Is a field dead?".
  //
  // 🔴 **`organizations` and `products` were DELETED here** — the last two steps
  // of the four-step removal (api-cloudrun#654, api-cloudrun#782 population A2).
  // The writers stopped first (`findOrCreateDestination` stopped writing
  // `organizations` in `v0.285.0`, verified deployed as revision
  // `api-cloudrun-00424-x4j`), storage then emptied, and on 2026-09-19 the KEY
  // was absent — not merely empty — on **0 of 258 prod and 0 of 259 dev**
  // documents, which is what makes a `z.strictObject` drop safe to read.
  // ⚠️ `contacts` did NOT go with them: 126 documents in each env still carry
  // the key.
  contacts: z.array(DestinationContactRef).optional(),
  version: z.int().min(0).default(0),
  ...TimestampFields,
}).superRefine(checkDestinationNode).meta({
  title: "Destination",
  collection: "destinations",
  displayDefaults: {
    columns: ["address.full", "address.city", "address.region"],
    filters: {},
    sort: { column: null, direction: "desc" },
  },
});
