/**
 * Organization helpers.
 *
 * @module
 */

import {
  type AddressType,
  type FirestoreTimestampType,
  type DocumentOrganizationSnapshotType,
  type JurisdictionType,
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

/**
 * The level a node sits at, read off `path` — never stored, so it cannot drift.
 *
 * ⚠️ **THROWS on a path outside `[1, ORG_LEVELS.length]` rather than returning
 * `null`.** `path` has been `.min(1).max(3)` and required since
 * `@cfs/core@10.0.0-beta.305`, so a pathless or over-deep organization is
 * unwritable and every `=== null` test on this was a dead branch — while the
 * `| null` return kept callers writing them, and kept the question *"is this a
 * department?"* spelled four different ways across three repos. The throw is
 * what makes the narrowed type honest: a caller holding RAW Firestore data
 * rather than a parsed document (an audit, a Typesense translate) must ask
 * about `path` itself before asking this.
 */
export function orgLevel(node: Pick<Organization, "path">): OrgLevel {
  const depth = node.path?.length;
  if (depth === undefined || depth < 1 || depth > ORG_LEVELS.length) {
    throw new Error(
      `organization path depth ${depth ?? "(no path)"} is outside the ${ORG_LEVELS.length}-level tree ` +
        `(${ORG_LEVELS.join(" → ")}) — \`path\` is required and bounded, so this document did not come ` +
        `through OrganizationSchema. Check \`path\` before asking for a level.`,
    );
  }
  return ORG_LEVELS[depth - 1];
}

/** Is this node a ROOT — the top of its tree, depth 1? */
export function isOrgRoot(node: Pick<Organization, "path">): boolean {
  return orgLevel(node) === "organization";
}

/**
 * Is this node a DEPARTMENT — the deepest level, the one that states neither a
 * billing address nor a tax axis and therefore inherits both?
 *
 * ⭐ **The one spelling.** `path.length === 3`, `path?.length === ORG_LEVELS.length`
 * and `orgLevel(n) === "department"` were all in live use; the literal `3` was
 * sixty lines above two invariants using `ORG_LEVELS.length`, inside one file.
 */
export function isOrgDepartment(node: Pick<Organization, "path">): boolean {
  return orgLevel(node) === "department";
}

/** The root of this node's tree — `path[0].uid`. */
export function orgRootUid(node: Pick<Organization, "path">): string {
  return node.path[0].uid;
}

/**
 * This node's parent — `path.at(-2).uid`, or `null` when this node IS a root.
 *
 * ⚠️ **`null` now has exactly ONE meaning: a root.** It used to have two — a
 * root, and a node with no `path` yet — and the second is gone with the
 * pathless document (see {@link orgLevel}). A caller may read `null` as
 * *"nothing above this"* without a second check.
 */
export function orgParentUid(node: Pick<Organization, "path">): string | null {
  const path = node.path;
  return path.length < 2 ? null : path[path.length - 2].uid;
}

/** This node's OWN name — one segment, not the composed label. */
export function orgOwnName(node: Pick<Organization, "path">): string {
  const path = node.path;
  return path[path.length - 1].name;
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
 * **The ONE author of `path` and `query_by_path`.** No writer builds
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
): { path: OrgPathNodeType[]; query_by_path: string[] } {
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
  return { path, query_by_path: path.map((n) => n.uid) };
}

/**
 * The THREE tree invariants that need MORE than one document — 5, 6 and 6b.
 *
 * 🔴 **The one-document invariants are NOT here, deliberately** — 1, 2, 3, 4,
 * the one-document half of 8, and 10, 11, 12 live on `OrganizationSchema` as a
 * `superRefine`, because they read one document and nothing else, and that
 * independence is what keeps this function honest. (7, the depth bound, is
 * enforced where `path` is BUILT — {@link computeOrganizationNode} throws — so
 * there is nothing left for a validator to re-check.)
 * Invariant 5 is a fixed-point check — *"my path is my parent's path plus me"* —
 * defined in terms of {@link computeOrganizationNode} and therefore only ever
 * able to agree with it. It is safe **because** eight properties that hold
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
 * The facts an ancestor contributes to a resolution — everything
 * {@link resolveBillingAddress} and {@link resolveTaxAxes} read off a node that
 * is not the leaf.
 */
export interface OrgAncestorFacts {
  billing_address: AddressType | null;
  jurisdiction_claim: JurisdictionType | null;
  tax_exempt: boolean;
}

/**
 * Every uid in `node.path.slice(0, -1)`, and what each of them states.
 *
 * 🔴 **The KEY SET is the invariant, and it is DERIVABLE** — which is what lets
 * a resolution check its own argument instead of trusting the caller. A node's
 * required ancestors are exactly `path.slice(0, -1)`, and every function here
 * already holds `path`. There were five hand-rolled spellings of this read
 * across three repos, each with its own projection and its own answer to the
 * question below.
 *
 * **A uid maps to `null` when the caller LOOKED and the document is gone.** That
 * tombstone is the whole point of the type:
 *
 * - **missing key** ⇒ the caller never loaded it ⇒ {@link assertOrgAncestorsComplete}
 *   throws, naming the uids. A caller that forgets an ancestor gets a runtime
 *   failure at its own call site rather than a wrong snapshot in Firestore.
 * - **`null` value** ⇒ a dangling reference ⇒ swallowed, exactly as before. A
 *   deleted ancestor must not take down every order write in the subtree;
 *   `api-cloudrun/scripts/repair-dangling-organization-refs.ts` is where that
 *   finding belongs. ⚠️ The consequence is unchanged and deliberate: **a
 *   dangling reference to an exempt root reads as NOT exempt.**
 *
 * ⚠️ **The resolvers below treat the two identically — both state nothing.** The
 * distinction is enforced ABOVE them, in {@link buildOrganizationSnapshot},
 * because that is where a wrong answer becomes a stored document. A caller that
 * legitimately holds a partial map (`resolveSubtreeTaxAxes` in api-cloudrun,
 * whose map is built one straggler at a time) goes to a resolver directly and is
 * unaffected.
 *
 * `F` narrows to the facts a given resolver reads, so a caller need only project
 * what that walk consults; the un-narrowed form is what the builder requires.
 */
export type OrgAncestors<F = OrgAncestorFacts> = ReadonlyMap<string, F | null>;

/**
 * Refuse an `ancestors` map that is missing a node the chain names.
 *
 * ⭐ **A root asserts nothing** — its `path.slice(0, -1)` is empty, so the
 * depth-1 case is correct by construction rather than by a caller remembering to
 * pass `new Map()`.
 */
export function assertOrgAncestorsComplete(
  node: Pick<Organization, "uid" | "path">,
  ancestors: ReadonlyMap<string, unknown>,
): void {
  const required = node.path.slice(0, -1).map((n) => n.uid);
  const missing = required.filter((uid) => !ancestors.has(uid));
  if (missing.length > 0) {
    throw new Error(
      `organization ${node.uid} has ${required.length} ancestor(s) in its path and ${missing.length} ` +
        `were not supplied: ${missing.join(", ")}. Read them (a tombstone \`null\` for one that no ` +
        `longer exists) before resolving — an absent key is a caller that did not look, which would ` +
        `silently freeze an un-inherited billing address or tax axis onto the document.`,
    );
  }
}

/**
 * Build the denormalized organization snapshot an order, invoice or credit note
 * embeds, with the billing address and the two tax axes **RESOLVED** up the
 * chain.
 *
 * 🔴 **The one builder, and the only one — there is no longer a function that
 * returns an UNRESOLVED snapshot.** A department states neither a billing
 * address nor a tax axis (`OrganizationSchema` invariants 10–12), so a builder
 * that froze the addressed node's own fields wrote `null` / `false` onto every
 * department document. That used to be a grep with an allowlist in
 * api-cloudrun's test suite; it is now unrepresentable.
 *
 * ⚠️ **This pins WHERE the snapshot is built, not WHAT it holds.** api-cloudrun's
 * writer-parity test is the value assertion beside it: two orders with the same
 * commercial facts, created through different paths, must produce byte-identical
 * `organization` blocks.
 *
 * `overrides` is spread LAST, so an explicit override still wins — the CRMS
 * webhooks pass `{ crms_id }` because the member id comes from the payload
 * rather than from the organization document.
 *
 * `|| null` rather than `?? null` on `crms_id` and `xero_id` is deliberate: a
 * `crms_id` of `0` is not a CRMS id.
 *
 * ⚠️ **The axes are written UNCONDITIONALLY, never omitted on absence.** `null` /
 * `false` is the real answer for a customer who asserts nothing, and omitting
 * would leave a reader unable to tell that apart from a snapshot no writer has
 * touched.
 *
 * The migration history this docblock used to narrate — the four-literal
 * unification, `tax_profile`'s retirement, the `name` removal, the `path`
 * addition and its pathless-documents post-mortem — is in the
 * `organization-tree` skill. Four of the six described fields this function does
 * not write.
 */
export function buildOrganizationSnapshot(
  org: Pick<
    Organization,
    | "uid"
    | "path"
    | "crms_id"
    | "jurisdiction_claim"
    | "tax_exempt"
    | "xero_id"
    | "billing_address"
  >,
  ancestors: OrgAncestors,
  overrides: Partial<DocumentOrganizationSnapshotType> = {},
): DocumentOrganizationSnapshotType {
  assertOrgAncestorsComplete(org, ancestors);
  const { address } = resolveBillingAddress(org, ancestors);
  const axes = resolveTaxAxes(org, ancestors);
  return {
    uid: org.uid,
    // ⭐ **The FROZEN chain, and the only thing this builder writes about who
    // the customer is.** The composed label was this same fact flattened to
    // text, which cannot be grouped on, joined on or parsed back — readers run
    // `composeOrgName(path)` instead. See
    // {@link DocumentOrganizationSnapshotType.path}.
    path: org.path,
    crms_id: org.crms_id || null,
    jurisdiction_claim: axes.jurisdiction_claim,
    tax_exempt: axes.tax_exempt,
    xero_id: org.xero_id || null,
    billing_address: address,
    ...overrides,
  };
}

/** What {@link resolveBillingAddress} answers. */
export interface ResolvedBillingAddress {
  /** The address to bill to — `null` when no node in the chain states one. */
  address: AddressType | null;
  /**
   * The uid of the node that STATED it, `null` when nothing did.
   *
   * ⭐ Returned so a caller can say WHERE the answer came from. The manager
   * renders it as *"Inherited from &lt;name&gt;"*, and the order page's
   * billing editor targets this node rather than the one the document names —
   * without it, an operator editing an inherited address would silently create
   * an override at the wrong level, which is the mistake the whole rule exists
   * to prevent.
   */
  uid_source: string | null;
}

/**
 * The billing address a document addressed to `node` should freeze.
 *
 * **The rule (api-cloudrun#777): an organization states a billing address, a
 * project may override it, a department inherits.** `null` on a node means
 * *"not set — ask my parent"*, so this walks the chain LEAF-FIRST and returns
 * the nearest node that states one.
 *
 * 🔴 **Nearest-first is what makes an override an override.** Root-first would
 * make the organization's address win over the project's, which inverts the
 * rule — and the corpus proves it matters: `20th Television` states its
 * Burbank corporate address while its production bills at Cinespace Chicago.
 *
 * ⭐ **A derived `(default)` placeholder needs no special case here.** Invariant
 * 10 in `OrganizationSchema` makes its `billing_address` unstorable, so the walk
 * passes through it to the root by construction rather than by a filter that
 * could drift from the schema. That is the whole return on stating the
 * invariant rather than policing it.
 *
 * ⚠️ **A missing or tombstoned ancestor states nothing rather than throwing** —
 * see {@link OrgAncestors} for why the walk swallows both and where the
 * difference IS enforced. A chain naming a node that no longer exists is a
 * dangling reference, and `repair-dangling-organization-refs.ts`'s finding
 * rather than this function's; an exception here would take down every order
 * write for the whole subtree instead of filing one report.
 *
 * ⚠️ **Reads `node.path`, never a re-fetched chain.** `path` is self-inclusive
 * and is the authority on ancestry (invariants 1 and 5), so the caller only has
 * to supply the ANCESTOR documents — at most two point-gets, and usually one,
 * because a department that inherits stops at its project.
 */
export function resolveBillingAddress(
  node: Pick<Organization, "uid" | "path" | "billing_address">,
  ancestors: OrgAncestors<Pick<OrgAncestorFacts, "billing_address">>,
): ResolvedBillingAddress {
  const path = node.path;
  for (let i = path.length - 1; i >= 0; i--) {
    const uid = path[i].uid;
    // The leaf is the node itself — reading it from `ancestors` would make the
    // caller supply the document it already holds, and a caller that forgot
    // would silently inherit past a node that states its own address.
    const stated = uid === node.uid ? node.billing_address : ancestors.get(uid)?.billing_address;
    if (stated != null) return { address: stated, uid_source: uid };
  }
  return { address: null, uid_source: null };
}

/** What {@link resolveTaxAxes} answers. */
export interface ResolvedTaxAxes {
  /** The nearest stated claim on the chain, `null` when no node states one. */
  jurisdiction_claim: JurisdictionType | null;
  /** The uid of the node that stated {@link jurisdiction_claim}, `null` when nothing did. */
  uid_claim_source: string | null;
  /** `true` when ANY node on the chain is exempt. */
  tax_exempt: boolean;
  /**
   * The uid of the TOPMOST exempt node, `null` when nothing is exempt.
   *
   * ⚠️ **Topmost, not nearest — the opposite of the claim, on purpose.** An
   * exemption cannot be removed from below, so the node that matters to a
   * caller is the highest one stating it: that is the only node where clearing
   * the flag could change the answer. A project stating `true` under an exempt
   * organization reports the ORGANIZATION, which is what lets the manager
   * render the project's own checkbox as locked rather than as an editable
   * control whose edit would change nothing.
   */
  uid_exempt_source: string | null;
}

/**
 * The two tax AXES a document addressed to `node` should freeze.
 *
 * **The rule mirrors {@link resolveBillingAddress} for the claim, and is sticky
 * for the exemption.** An organization states a `jurisdiction_claim`, a project
 * may override it, a department never states one — so the claim is the nearest
 * non-null value walking LEAF-FIRST. `tax_exempt` is `true` when ANY node on the
 * chain is `true`: exemption is a legal fact about the buyer, and the existing
 * document rule (`org.tax_exempt || doc.tax_exempt === true`) is already sticky
 * in exactly this direction, so a project may add one and never remove one.
 *
 * ⭐ **A derived `(default)` placeholder and a department need no special case.**
 * `OrganizationSchema`'s invariant 12 makes both axes unstorable on them, so the
 * walk passes through by construction — the same return `resolveBillingAddress`
 * gets from invariants 10 and 11.
 *
 * ⚠️ **A missing or tombstoned ancestor states nothing rather than throwing**,
 * for the same reason as the billing walk ({@link OrgAncestors}). That does mean
 * a dangling reference to an exempt root reads as NOT exempt — a missing
 * ancestor is reported, not guessed.
 *
 * ⚠️ **Reads the leaf from `node`, never from `ancestors`**, and reads ancestry
 * from `node.path`, never a re-fetched chain.
 */
export function resolveTaxAxes(
  node: Pick<Organization, "uid" | "path" | "jurisdiction_claim" | "tax_exempt">,
  ancestors: OrgAncestors<Pick<OrgAncestorFacts, "jurisdiction_claim" | "tax_exempt">>,
): ResolvedTaxAxes {
  const path = node.path;
  let jurisdiction_claim: JurisdictionType | null = null;
  let uid_claim_source: string | null = null;
  let uid_exempt_source: string | null = null;
  for (let i = path.length - 1; i >= 0; i--) {
    const uid = path[i].uid;
    const stated = uid === node.uid ? node : ancestors.get(uid);
    // `== null` catches BOTH a tombstone (looked, gone) and an absent key. They
    // state nothing alike here; the distinction is the builder's — see
    // {@link OrgAncestors}.
    if (stated == null) continue;
    if (uid_claim_source === null && stated.jurisdiction_claim != null) {
      jurisdiction_claim = stated.jurisdiction_claim;
      uid_claim_source = uid;
    }
    // Overwritten on every exempt node, so the walk ends holding the topmost.
    if (stated.tax_exempt === true) uid_exempt_source = uid;
  }
  return { jurisdiction_claim, uid_claim_source, tax_exempt: uid_exempt_source !== null, uid_exempt_source };
}

/**
 * How long a node may go without meaningful activity before it is DORMANT
 * (api-cloudrun#979) — the one definition search sorting, muted row rendering
 * and tests all read.
 *
 * ⚠️ **Dormant reorders and mutes; it never hides.** A last-year project back
 * for reshoots must stay findable and pickable on the spot.
 */
export const ORGANIZATION_DORMANT_AFTER_DAYS = 60;

const DAY_MS = 86_400_000;

/**
 * The epoch-ms instant before which a node's `activity_at` makes it dormant —
 * what the manager's Typesense `_eval(activity_at:>=<cutoff>)` sort compares
 * against, built once per search.
 */
export function organizationDormantCutoffMs(nowMs: number): number {
  return nowMs - ORGANIZATION_DORMANT_AFTER_DAYS * DAY_MS;
}

/**
 * A node's `activity_at` as epoch-ms, from either shape a reader holds: the
 * stored Firestore `Timestamp` or a Typesense hit's `int64`. `null` when absent
 * (a projection that did not select it) or unreadable — never guessed.
 */
export function organizationActivityMs(
  node: { activity_at?: FirestoreTimestampType | number | null },
): number | null {
  const v = node.activity_at;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (v && typeof (v as { toMillis?: unknown }).toMillis === "function") {
    return (v as { toMillis(): number }).toMillis();
  }
  if (v && typeof (v as { seconds?: unknown }).seconds === "number") {
    const t = v as { seconds: number; nanoseconds?: number };
    return t.seconds * 1000 + Math.floor((t.nanoseconds ?? 0) / 1e6);
  }
  return null;
}

/**
 * Whether a node is dormant at `nowMs`: its last activity is strictly older
 * than {@link ORGANIZATION_DORMANT_AFTER_DAYS}. Exactly at the cutoff is still
 * active, matching the search sort's `>=`.
 *
 * ⚠️ **An UNREADABLE value is not dormant.** The key is required on the stored
 * document, but a reader can still hold a projection without it, and muting a
 * live customer on a missing value is the wrong direction to fail.
 */
export function isOrganizationDormant(
  node: { activity_at?: FirestoreTimestampType | number | null },
  nowMs: number,
): boolean {
  const ms = organizationActivityMs(node);
  return ms !== null && ms < organizationDormantCutoffMs(nowMs);
}
