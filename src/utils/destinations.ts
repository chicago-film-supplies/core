/**
 * Destination tree helpers — the property → unit hierarchy.
 *
 * @module
 */

import {
  DESTINATION_LEVELS,
  type Destination,
  type DestinationLevelType,
  type DestinationPathNodeType,
} from "../schemas/destination.ts";
import type { AddressType, JurisdictionType } from "../schemas/common.ts";

/**
 * The level a node sits at, read off `path` — never stored, so it cannot drift.
 *
 * ⚠️ **THROWS on an absent or out-of-range path rather than returning `null`.**
 * The same ruling {@link orgLevel} carries: a `| null` return keeps callers
 * writing dead branches and keeps *"is this a unit?"* spelled four ways. A
 * caller holding RAW Firestore data — an audit, a Typesense translate, a
 * document written before the backfill — must ask about `path` itself first.
 */
export function destinationLevel(node: Pick<Destination, "path">): DestinationLevelType {
  const depth = node.path?.length;
  if (depth === undefined || depth < 1 || depth > DESTINATION_LEVELS.length) {
    throw new Error(
      `destination path depth ${depth ?? "(no path)"} is outside the ${DESTINATION_LEVELS.length}-level tree ` +
        `(${DESTINATION_LEVELS.join(" → ")}) — check \`path\` before asking for a level. Through the expand ` +
        `third of the rollout \`path\` is optional, so an un-backfilled document reaches here legitimately.`,
    );
  }
  return DESTINATION_LEVELS[depth - 1];
}

/**
 * Is this node a PROPERTY — the top of its tree, depth 1?
 *
 * ⚠️ **True of a flat singleton too, and that is the point.** A path is
 * self-inclusive, so a destination with no units has `path = [itself]` and is a
 * property of one. The owner's rule 3: a property node is created when a SECOND
 * unit needs one, never in anticipation.
 */
export function isDestinationProperty(node: Pick<Destination, "path">): boolean {
  return destinationLevel(node) === "property";
}

/** Is this node a UNIT — the deepest level, the one whose name IS `address.street2`? */
export function isDestinationUnit(node: Pick<Destination, "path">): boolean {
  return destinationLevel(node) === "unit";
}

/** The property this node belongs to — `path[0].uid`, which is the node itself when it is a property. */
export function destinationPropertyUid(node: Pick<Destination, "path">): string {
  destinationLevel(node);
  return node.path![0].uid;
}

/**
 * This node's parent — `path.at(-2).uid`, or `null` when this node IS a property.
 *
 * `null` has exactly ONE meaning here: a property. A node with no `path` throws
 * from {@link destinationLevel} rather than reading as a root.
 */
export function destinationParentUid(node: Pick<Destination, "path">): string | null {
  const path = node.path!;
  destinationLevel(node);
  return path.length < 2 ? null : path[path.length - 2].uid;
}

/**
 * This node's OWN name — the unit designator for a unit, the place name for a
 * property. Empty only on a property identified by its street address alone.
 */
export function destinationOwnName(node: Pick<Destination, "path">): string {
  destinationLevel(node);
  const path = node.path!;
  return path[path.length - 1].name;
}

/**
 * **The ONE author of `path`, `query_by_path` and `address.street2`.** No writer
 * builds any of the three by hand — the rule `computeItemPaths` carries for
 * `items[].path` and `computeOrganizationNode` for the org tree.
 *
 * 🔴 **`street2` is returned from HERE, and that is what makes it derived.** It
 * was empty on all 322 documents while ≥14 carried unit text inside `street`:
 * the problem was a missing concept, not a missing field. Authoring it beside
 * the node that means it is what stops a hand-typed line 2 from becoming a
 * second, unauthored answer to *"which unit"*.
 *
 * Throws rather than returning a partial result, because every caller is a write
 * path and a silently-wrong `path` addresses the wrong subtree.
 *
 * @param node   this document's own uid, and its OWN name — the unit designator
 *               when it is being hung under a parent, the place name when it is
 *               a property.
 * @param parent the RESOLVED parent document, or `null` for a property. Never a
 *               chain the client sent.
 */
export function computeDestinationNode(
  node: { uid: string; name: string },
  parent: Pick<Destination, "uid" | "path" | "address"> | null,
): { path: DestinationPathNodeType[]; query_by_path: string[]; street2: string | undefined } {
  if (parent !== null && (parent.path === undefined || parent.path.length === 0)) {
    throw new Error(
      `destination ${parent.uid} has no path — it cannot be a parent until it is backfilled`,
    );
  }
  const path: DestinationPathNodeType[] = [
    ...(parent?.path ?? []),
    { uid: node.uid, name: node.name },
  ];
  if (path.length > DESTINATION_LEVELS.length) {
    throw new Error(
      `the destination tree is ${DESTINATION_LEVELS.length} levels (${DESTINATION_LEVELS.join(" → ")}); ` +
        `hanging ${node.uid} under ${parent?.uid} would make it ${path.length}. A property is one STREET ` +
        `ADDRESS — a second address held as a unit would overwrite the address a driver is sent to, so a ` +
        `brand over several lots is several properties, not a third level.`,
    );
  }
  if (path.some((n, i) => path.findIndex((m) => m.uid === n.uid) !== i)) {
    throw new Error(
      `destination ${node.uid} would appear twice in its own path — a node cannot be its own ancestor`,
    );
  }
  const isUnit = path.length === DESTINATION_LEVELS.length;
  if (isUnit && node.name.trim() === "") {
    throw new Error(
      `destination ${node.uid} is being hung under ${parent?.uid} as a unit, but its name is empty — ` +
        `a unit's name IS address.street2, and an empty line 2 is not a unit`,
    );
  }
  // 🔴 The place name is denormalized ONCE, at `path[0]`, and mirrors
  // `address.name` on root and unit alike — which is what keeps the denorm
  // checkable from one document. A unit therefore takes its PROPERTY's place
  // name, not its own former `address.name` (a tenancy, on 6 of the 12
  // Cinespace rows, which goes stale the moment the production wraps).
  if (parent !== null) path[0] = { ...path[0], name: parent.address?.name ?? "" };
  return {
    path,
    query_by_path: path.map((n) => n.uid),
    street2: isUnit ? node.name : undefined,
  };
}

/**
 * Apply {@link computeDestinationNode}'s `street2` to an address, so a writer
 * cannot apply the path and forget line 2.
 *
 * ⚠️ **DELETES the key rather than writing `""`** when the node is a property.
 * `street2` is `.optional()`, and invariant 3 reads an empty string as a
 * violation rather than as an absence — the two are the same fact and only one
 * of them is representable.
 */
export function applyDestinationStreet2(
  address: AddressType,
  street2: string | undefined,
): AddressType {
  const next = { ...address };
  if (street2 === undefined) delete next.street2;
  else next.street2 = street2;
  return next;
}

/**
 * The jurisdiction SEED for this node — its own when it states one, otherwise
 * its property's. `null` when nothing on the chain states one, which is every
 * document in the corpus today.
 *
 * 🔴 **A seed for the PICKER, never a rung in `resolveJurisdiction`.** See
 * {@link Destination.jurisdiction} and api-cloudrun#591. This function exists so
 * the authoring surface has ONE spelling of the walk; it is deliberately not
 * called from `utils/taxes.ts`, and a call site there is the defect, not the
 * feature.
 *
 * ⚠️ **A missing or tombstoned property states nothing rather than throwing**,
 * exactly as `resolveTaxAxes` swallows a dangling ancestor: a deleted property
 * must not take down every write in its subtree.
 */
export function resolveDestinationJurisdictionSeed(
  node: Pick<Destination, "uid" | "path" | "jurisdiction">,
  property: Pick<Destination, "uid" | "jurisdiction"> | null,
): JurisdictionType | null {
  if (node.jurisdiction != null) return node.jurisdiction;
  if (property === null || property.uid === node.uid) return null;
  return property.jurisdiction ?? null;
}
