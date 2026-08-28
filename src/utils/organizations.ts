/**
 * Organization helpers.
 *
 * @module
 */

import {
  type DocumentOrganizationSnapshotType,
  ORG_LEVELS,
  type OrgLevel,
  type OrgPathNodeType,
  type Organization,
} from "../schemas/mod.ts";

/**
 * The default separator between composed name segments.
 *
 * ⚠️ **This is the ONLY place a delimiter exists, and it is never stored.** The
 * v1 corpus proves a parse is hopeless — four conventions in live use, unstable
 * segment ORDER, a double space before one slash (`Leading Edge Media  / Queen`),
 * commas inside segments (`Twentieth Television: Insight, UKOP`), and production
 * titles that will contain colons. **Nothing anywhere splits a string to recover
 * the hierarchy**; `path` is the structure and this is a rendering choice.
 */
export const ORG_NAME_DELIMITER = " / ";

/**
 * Marks a segment this function dropped or shortened to fit a length budget.
 *
 * ⚠️ **Present deliberately, at a cost of one character.** A silent drop makes a
 * genuine two-level `Netflix / Locations` and an elided
 * `Netflix / <project> / Locations` indistinguishable — and the composed name's
 * whole job at the Xero boundary is to let an operator identify WHICH
 * department's receivable they are looking at.
 */
const ELISION = "…";

/** The level a node sits at, read off `path` — never stored, so it cannot drift. */
export function orgLevel(node: Pick<Organization, "path">): OrgLevel | null {
  const depth = node.path?.length;
  return depth === undefined || depth < 1 || depth > ORG_LEVELS.length ? null : ORG_LEVELS[depth - 1];
}

/** The root of this node's tree — `path[0].uid`. `null` before the backfill. */
export function orgRootUid(node: Pick<Organization, "path">): string | null {
  return node.path?.[0]?.uid ?? null;
}

/**
 * This node's parent — `path.at(-2).uid`.
 *
 * ⚠️ **`null` is TWO answers here and the caller must not conflate them**: a
 * root (a one-element `path`) and a node with no `path` yet. Check `orgLevel`
 * first when the difference matters.
 */
export function orgParentUid(node: Pick<Organization, "path">): string | null {
  const path = node.path;
  return path === undefined || path.length < 2 ? null : path[path.length - 2].uid;
}

/** This node's OWN name — one segment, not the composed label. */
export function orgOwnName(node: Pick<Organization, "path">): string | null {
  const path = node.path;
  return path === undefined || path.length === 0 ? null : path[path.length - 1].name;
}

/**
 * Render an organization node's display name from its `path`.
 *
 * Pure, no I/O — shared verbatim by the manager, the templates renderer and
 * api-cloudrun's Xero boundary, so the label a customer sees on an invoice and
 * the label the operator sees in the picker cannot drift.
 *
 * **Non-empty by construction.** A root is always operator-named (invariant 2,
 * enforced in `schemas/organization.ts`), so at least one segment always
 * survives the `derived` filter and this can never return `""` — which is what
 * satisfies the nine embedded snapshots' own `.min(1)` without a second check.
 *
 * ## When it does not fit
 *
 * ⚠️ **`maxLength` is a PARAMETER, never a constant baked in here.** Xero's
 * 50-character contact-name cap lives beside the other Xero-shaped concerns in
 * `api-cloudrun/src/lib/`. Core owns the algorithm; api owns the boundary
 * constant. Putting Xero's number in a package the manager and the templates
 * renderer also consume is the same mistake the line-price rule refuses.
 *
 * The order is **elide the middle, then shorten the ROOT — never the tail**:
 *
 * 1. Drop `derived` segments and join.
 * 2. Over budget with ≥3 segments: replace the middle with `…`.
 * 3. Still over: shorten the ROOT, keeping the leaf whole. The leaf is the
 *    identity — it is what maps to a Xero contact and therefore to a receivable
 *    — so truncating the tail is precisely the wrong end. That is what
 *    `trimXeroName` does today, and it is why this function exists.
 *
 * `Netflix Productions, LLC / Saturn Return / Locations` is **exactly 50**, so
 * this is live behaviour rather than a theoretical branch.
 */
export function composeOrgName(
  path: readonly OrgPathNodeType[],
  options: { delimiter?: string; maxLength?: number } = {},
): string {
  const { delimiter = ORG_NAME_DELIMITER, maxLength } = options;
  const named = path.filter((n) => !n.derived).map((n) => n.name);
  // A path with no operator-named node cannot occur under invariant 2, but a
  // caller may hand us a bare array — fall back to the whole chain rather than
  // returning "".
  const segments = named.length > 0 ? named : path.map((n) => n.name);
  if (segments.length === 0) return "";

  const full = segments.join(delimiter);
  if (maxLength === undefined || full.length <= maxLength) return full;

  let head = segments[0];
  const tail = segments.length > 1 ? segments[segments.length - 1] : null;

  if (segments.length >= 3) {
    const elided = [head, ELISION, tail].join(delimiter);
    if (elided.length <= maxLength) return elided;
  }

  if (tail === null) return head.slice(0, Math.max(0, maxLength - ELISION.length)) + ELISION;

  const suffix = delimiter + tail;
  const budget = maxLength - suffix.length - ELISION.length;
  if (budget < 1) {
    // The leaf alone does not fit. Keep as much of it as the budget allows —
    // there is nothing more identifying to preserve.
    return tail.slice(0, Math.max(0, maxLength - ELISION.length)) + ELISION;
  }
  head = head.slice(0, budget) + ELISION;
  return head + suffix;
}

/**
 * **The ONE author of `path` and `query_by_organizations`.** No writer builds
 * either by hand — the same rule `computeItemPaths` carries for `items[].path`,
 * and for the same reason: a chain the client sends can skip, misname or
 * over-claim an intermediate, so the server derives it from the RESOLVED parent
 * or not at all.
 *
 * Throws rather than returning a partial result, because every caller is a write
 * path and a silently-wrong `path` is a row identity that addresses the wrong
 * subtree.
 */
export function computeOrganizationNode(
  node: { uid: string; name: string; derived: boolean },
  parent: Pick<Organization, "uid" | "path"> | null,
): { path: OrgPathNodeType[]; query_by_organizations: string[] } {
  if (parent !== null && (parent.path === undefined || parent.path.length === 0)) {
    throw new Error(`organization ${parent.uid} has no path — it cannot be a parent until it is backfilled`);
  }
  const path: OrgPathNodeType[] = [
    ...(parent?.path ?? []),
    { uid: node.uid, name: node.name, derived: node.derived },
  ];
  if (path.length > ORG_LEVELS.length) {
    throw new Error(
      `the organization tree is ${ORG_LEVELS.length} levels (${ORG_LEVELS.join(" → ")}); ` +
        `hanging ${node.uid} under ${parent?.uid} would make it ${path.length}. ` +
        `A season is part of the PROJECT title, not a fourth level.`,
    );
  }
  if (path.some((n, i) => path.findIndex((m) => m.uid === n.uid) !== i)) {
    throw new Error(`organization ${node.uid} would appear twice in its own path — a node cannot be its own ancestor`);
  }
  return { path, query_by_organizations: path.map((n) => n.uid) };
}

/**
 * The tree invariants that need MORE than one document — 5 through 8.
 *
 * 🔴 **1 through 4 are NOT here, deliberately.** They live on
 * `OrganizationSchema` as a `superRefine`, because they read one document and
 * nothing else, and that independence is what keeps this function honest.
 * Invariant 5 is a fixed-point check — *"my path is my parent's path plus me"* —
 * defined in terms of {@link computeOrganizationNode} and therefore only ever
 * able to agree with it. It is safe **because** four properties that hold
 * independently of the walk stand beside it. A guard that can only consult its
 * own oracle is not a guard: that is exactly the shape that certified 79
 * provably-wrong item paths as clean, corpus-wide.
 *
 * Returns every violation rather than throwing on the first, so an audit reports
 * a whole document at once. An empty array means the node is well-formed.
 */
export function validateOrganizationTree(
  node: Pick<Organization, "uid" | "path" | "uid_department_type">,
  parent: Pick<Organization, "uid" | "path"> | null,
  siblings: readonly Pick<Organization, "uid" | "path" | "uid_department_type">[],
): string[] {
  const violations: string[] = [];
  const path = node.path;
  if (path === undefined || path.length === 0) return violations;

  // 5. `path.slice(0, -1)` equals the parent's `path`.
  const expectedAncestors = parent?.path ?? [];
  const actualAncestors = path.slice(0, -1);
  if (actualAncestors.length !== expectedAncestors.length) {
    violations.push(
      `path has ${actualAncestors.length} ancestor(s) but its parent ${parent?.uid ?? "(none — this is a root)"} has a path of ${expectedAncestors.length}`,
    );
  } else if (actualAncestors.some((n, i) => n.uid !== expectedAncestors[i].uid || n.name !== expectedAncestors[i].name || n.derived !== expectedAncestors[i].derived)) {
    violations.push(`path.slice(0, -1) does not match the parent ${parent?.uid}'s own path — the subtree rewrite did not reach this node`);
  }

  const own = path[path.length - 1];
  const isDepartment = path.length === ORG_LEVELS.length;

  // 6. Sibling name uniqueness among NON-derived siblings, case-folded and
  //    trimmed. Derived siblings are excluded because a minted `(default)` is
  //    not a name the operator chose and two of them under one parent is a
  //    transient state of the mint, not a collision.
  const fold = (s: string) => s.trim().toLocaleLowerCase();
  if (!own.derived) {
    const clash = siblings.find((sib) => {
      if (sib.uid === node.uid || sib.path === undefined || sib.path.length !== path.length) return false;
      const sibOwn = sib.path[sib.path.length - 1];
      return !sibOwn.derived && fold(sibOwn.name) === fold(own.name);
    });
    if (clash !== undefined) {
      violations.push(`a sibling (${clash.uid}) under the same parent is already named "${own.name}" (case-folded)`);
    }
  }

  // 6b. For DEPARTMENTS this strengthens to catalog-entry uniqueness — a plain
  //     equality check rather than a string compare, which is the whole point of
  //     giving the department level a vocabulary.
  if (isDepartment && node.uid_department_type != null) {
    const typeClash = siblings.find((sib) =>
      sib.uid !== node.uid &&
      sib.path?.length === path.length &&
      sib.uid_department_type === node.uid_department_type
    );
    if (typeClash !== undefined) {
      violations.push(`a sibling (${typeClash.uid}) under the same project already uses department type ${node.uid_department_type}`);
    }
  }

  return violations;
}

/**
 * Build the denormalized organization snapshot an order, invoice or credit note
 * embeds.
 *
 * **The one builder, because four hand-maintained literals is what api-cloudrun
 * #486 was.** `createOrder`, `updateOrder`'s organization branch, the CRMS
 * opportunity webhook and `createInvoice` each assembled this block by hand,
 * and the three order-side copies were one field short of the invoice's: they
 * carried no `tax_profile`. Nothing on the order write path could see a
 * tax-exempt customer, so `repriceOrderItemsForProfile` passed a hardcoded
 * `"tax_applied"` — the same customer's invoices went untaxed and their orders
 * went taxed, hidden only by CRMS stamping the profile from the opportunity
 * header.
 *
 * ⚠️ **This pins WHERE the snapshot is built, not WHAT it holds** — the
 * Ratchet-G lesson. api-cloudrun's writer-parity test is the value assertion
 * beside it: one order created natively and one through the CRMS opportunity
 * path, same commercial facts, must produce byte-identical `organization`
 * blocks.
 *
 * `|| null` rather than `?? null` on `crms_id` and `xero_id` is deliberate and
 * matches every call site it replaces — a `crms_id` of `0` is not a CRMS id.
 *
 * ## The tax axes, and why they are emitted UNCONDITIONALLY
 *
 * `jurisdiction_claim` and `tax_exempt` are the pair that retires
 * `tax_profile` (api-cloudrun#596 item 1). Carrying them HERE is what makes
 * every writer dual-write for free — the alternative was two more fields in
 * each hand-rolled literal, which is the failure mode this function exists to
 * end.
 *
 * ⚠️ **Always written, never omitted.** That signal has now done its job and
 * changed meaning: while `tax_profile` was still the fallback, an ABSENT axis
 * meant *"this snapshot predates the axes, read the enum"*. The whole corpus is
 * migrated and this builder no longer emits an enum for anything to fall back
 * to, so an absent axis is now simply a snapshot no writer has touched since —
 * and `null`/`false` remains the real answer. Omitting on absence would still
 * be wrong, for the surviving half of the reason: it would leave a reader
 * unable to distinguish it from a customer who asserts nothing.
 *
 * 🔴 **`tax_profile` is NOT emitted any more (api-cloudrun#596 item 3).** It is
 * `.optional()` on the snapshot for one release cycle — the expand third — and
 * this is the writer half of the same step: storage cannot be emptied while a
 * shared builder keeps refilling it. ⚠️ The credit-note idempotency hash reads
 * this block, and dropping the field from it moves NOTHING, because
 * `creditNoteContentHash` is never persisted — api-cloudrun recomputes it from
 * the stored document on both sides of every comparison, so both sides always
 * agree. That refutes what api-cloudrun#596 said was the blocker here.
 *
 * ⚠️ **`?? null` / `?? false` is lossless on the measured corpus, not a
 * flattening** — prod 2026-08-21: 291 organizations, and the 11 carrying
 * `tax_exempt: true` are exactly the 11 whose profile is `tax_exempt`, the 3
 * carrying a `jurisdiction_claim` are exactly the 3 with a location profile,
 * and the remaining 277 (`tax_applied`) carry neither. Absent on the
 * organization already means *asserts nothing*, so there is no third state to
 * destroy. See {@link DocumentOrganizationSnapshotType.jurisdiction_claim}.
 */
export function buildOrganizationSnapshot(
  org: Pick<
    Organization,
    | "uid"
    | "name"
    | "crms_id"
    | "jurisdiction_claim"
    | "tax_exempt"
    | "xero_id"
    | "billing_address"
  >,
  overrides: Partial<DocumentOrganizationSnapshotType> = {},
): DocumentOrganizationSnapshotType {
  return {
    uid: org.uid,
    name: org.name,
    crms_id: org.crms_id || null,
    jurisdiction_claim: org.jurisdiction_claim ?? null,
    tax_exempt: org.tax_exempt ?? false,
    xero_id: org.xero_id || null,
    billing_address: org.billing_address || null,
    ...overrides,
  };
}
