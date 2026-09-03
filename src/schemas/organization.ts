/**
 * Organization document schema — Firestore collection: organizations
 */
import { z } from "zod";
import { chicagoStartOfDay } from "./_datetime.ts";
import { FirestoreId, ThreadId } from "./_uid.ts";
import {
  ActorRef,
  type ActorRefType,
  Address,
  type AddressType,
  Email,
  FirestoreTimestamp,
  type FirestoreTimestampType,
  JurisdictionEnum,
  type JurisdictionType,
  NameField,
  type NameParts,
  NamePartsFields,
  OrgPathNode,
  type OrgPathNodeType,
  Phone,
  TimestampFields,
} from "./common.ts";

/**
 * Contact reference embedded in an organization document.
 * `name` is the server-derived display string (see `deriveName` in common.ts).
 */
export interface OrganizationContactType extends NameParts {
  uid: string;
  name: string;
  roles: string[];
}

/** Zod schema for a contact reference embedded in an organization. */
export const OrganizationContact: z.ZodType<OrganizationContactType> = z.strictObject({
  uid: FirestoreId,
  ...NamePartsFields,
  name: NameField,
  roles: z.array(z.string()).default([]).meta({ column: true, label: "Roles" }),
});

/**
 * The three levels of the organization tree, root first.
 *
 * ⚠️ **`as const` on a tuple is the core#43 construct** — its declaration is not
 * syntactically derivable, so `deno task check:declarations` needs the type
 * written out or JSR publishes a wrong `.d.ts`. Hence the explicit annotation
 * rather than a bare `as const`.
 *
 * ⚠️ **There is no stored `level` field, and there must not be.** The level is
 * `ORG_LEVELS[path.length - 1]` — read off `path`, so the entire class of
 * "`level` says department but the node sits at depth 2" is unrepresentable
 * rather than policed. Same for root, parent and the composed display name.
 */
export const ORG_LEVELS: readonly ["organization", "project", "department"] = [
  "organization",
  "project",
  "department",
] as const;

/** One level of the organization tree. */
export type OrgLevel = typeof ORG_LEVELS[number];

/**
 * Full organization document schema (Firestore document shape).
 */
export interface Organization {
  uid: string;
  /**
   * Self-inclusive ancestor chain, root first: `[org, project, department]`.
   * `path.at(-1).uid === uid`.
   *
   * **THE structural fact.** Level, root, parent and the composed display name
   * are all READ OFF IT (`orgLevel` / `orgRootUid` / `orgParentUid` /
   * `composeOrgName` in `@cfs/core/utils/organizations`), so none of them can
   * drift from it — there is no `level`, `uid_parent` or `uid_root` to disagree.
   *
   * Same name, same shape and same recurrence as `order.items[].path`
   * (`core/src/utils/order-lines.ts` documents self-inclusive):
   *
   *     path = [...parent.path, { uid, name, derived }]
   *
   * ⚠️ **`path`, not `uid_path` or `uid_tree`.** `core/CLAUDE.md` § *UID
   * property naming* reserves `uid_{descriptor}` for a SCALAR reference to one
   * other document, and `_uid.ts` puts array-element ids in a deliberately
   * separate concern — its shape table already reads *"`ItemUid` …
   * `path[]` segments"*, so `path` is this codebase's established name for a
   * self-inclusive ancestor chain of ids.
   *
   * ⚠️ **No `.default([])`.** `item.path` carries one and it never
   * materializes: `validateBeforeWrite` writes the RAW document and discards
   * `result.data`. Construct this completely.
   *
   * `.optional()` for one release cycle — the expand third of the additive
   * rollout. It becomes required once the corpus is backfilled.
   */
  path: OrgPathNodeType[];
  /**
   * Flat mirror of `path.map(n => n.uid)` — **FIRESTORE-ONLY, for exactly one
   * reader.**
   *
   * Firestore's `array-contains` compares whole elements, so it cannot match a
   * uid inside an array of objects; this is what makes
   * `where("query_by_path", "array-contains", uid)` answer "every
   * descendant of X". ⚠️ **Typesense needs no mirror at all** —
   * `enable_nested_fields` is on, so it indexes `path.uid` natively and
   * `filter_by: path.uid:=X` answers the same question. Every *read* surface
   * uses Typesense; the mirror exists for the rename cascade's `scanCascadeIds`,
   * which is a write path and therefore cannot depend on a rebuildable,
   * eventually-consistent projection.
   *
   * 🔴 **`query_by_path`, NOT `query_by_organizations` — and the departure from
   * the `query_by_<collection>` convention is deliberate.** On every other
   * collection that name means *"the organizations this document is attached
   * to"*; here it would mean *"my ancestors, including me"*. Two meanings under
   * one name in one codebase is a reader trap, and it is also literally
   * unguardable: an arm of api-cloudrun's org-tree ratchet asserting that
   * nothing hand-builds this array could not tell an org node's chain from the
   * five legitimate `contacts.query_by_organizations` writers — which sit in the
   * same two files it has to walk.
   *
   * So this one names the QUESTION — *"whose path am I in?"* — rather than a
   * target collection it does not really point at. The convention still holds
   * wherever the field really is a list of foreign uids
   * (`contacts.query_by_organizations`, `organizations.query_by_contacts`).
   */
  query_by_path: string[];
  /**
   * Provenance for an AUTO-MINTED node, so a later realignment can find the
   * population when someone names the real production. `null` on an
   * operator-named node.
   *
   * ⚠️ Distinct from `path[i].derived`, which is the ANCESTORS' state
   * denormalized so a leaf renders its own label with no fan-out. Two facts, not
   * two spellings — and they overlap in exactly one place, which the tree
   * validator pins: `derived_from === null ⟺ path.at(-1).derived === false`.
   */
  derived_from: { source_uid: string; reason: "minted-root" | "minted-project" | "minted-department" } | null;
  /**
   * The `department-types` catalog entry this DEPARTMENT node is named from —
   * `null` on an organization or project node, and on a *derived* department.
   *
   * 🔴 **Stored as a REF, not just a matching name.** Storing only the name
   * means a catalog rename cannot find its population — the same *"pair on what
   * the field is a fact about"* rule that governs every carry-forward in this
   * codebase. `path.at(-1).name` stays a denorm of the catalog entry's name and
   * a rename cascades to it (bounded: a department is a LEAF, so its name
   * appears in no other node's `path`).
   */
  uid_department_type: string | null;
  /**
   * Project-level facts — the production's shoot window.
   *
   * ⚠️ **NOT nullable on the outer object.** `null` and
   * `{ start: null, wrap: null }` would be two spellings of one fact, which is
   * the defect `core/CLAUDE.md` names under *"Required, not merely
   * non-optional"*. Precedent: `CardDatesType`, `OOSDates`, `booking.dates`.
   *
   * ACTIVE/DORMANT stays DERIVED from this window — no stored status.
   */
  dates?: { start: string | null; wrap: string | null };
  /**
   * 🔴 **Nullable because a non-leaf node has no CRMS counterpart, which is a
   * real answer rather than "unknown".** `createOrganization` POSTs a live CRMS
   * member to obtain this, and a minted root or project must not create one.
   *
   * ⚠️ **`null` here is only meaningful because the minting writer stamps an
   * explicit `null`.** `orders.crms_id` reads identically and is REQUIRED,
   * because `createOrder` writes an explicit `null` — *same census, opposite
   * verdicts, and only the writer distinguishes them* (`core/CLAUDE.md`).
   */
  crms_id: number | null;
  xero_id: string | null;
  /**
   * This customer's standing jurisdiction claim — **level 2** of the
   * three-level precedence in `resolveJurisdiction` (`@cfs/core/utils/taxes`),
   * below the document's own `destinations[i].jurisdiction` and above the
   * derivation.
   *
   * ⚠️ **A standing CLAIM, not a hint.** There used to be a destination-master
   * level between this and the derivation; ranked above this it cancelled it on
   * all 8 repriceable jurisdiction-bearing orders, and ranked below it did
   * nothing, because nothing ever wrote it. It is gone. The escape hatch is
   * level 1 — a
   * Rantoul-claim organization taking a one-off Chicago delivery edits **that
   * destination's** entry on the document, so the document is never re-welded
   * to one jurisdiction the way `tax_profile` welds it. The order form must
   * still show WHICH level supplied each destination's answer.
   *
   * ⚠️ **The name is not `default_`.** "Default" reads as a fallback and this
   * is the top of the stored chain; the rename is what stops the next reader
   * re-deriving the precedence from the field name.
   *
   * `null`/absent asserts nothing and asks the next level. It does **not** mean
   * "no jurisdiction" — that answer is the `no_nexus` value, authorable here
   * like any other ({@link JurisdictionType}).
   *
   * ⚠️ **Load-bearing for the entire current corpus, not a tail case.** All 993
   * prod orders are CRMS-originated and the CRMS path does not seed level 1, so
   * level 1 is empty on every document that exists today and this level is what
   * answers for Kenwood, Waterloo West and Simeon. Phase 2 cannot delete
   * `tax_profile` before the CRMS cutover unless this stays.
   *
   * Optional through api-cloudrun#409 Phase 1.
   */
  jurisdiction_claim?: JurisdictionType | null;
  /**
   * Whether this customer is tax-exempt — a property of the CUSTOMER, which is
   * the half `tax_profile` welded to jurisdiction and could not separate.
   *
   * ⚠️ **Exemption is STICKY from either side**: the rule is
   * `org.tax_exempt || doc.tax_exempt === true`, never `doc ?? org`. A `false`
   * on a document must not un-exempt an exempt customer — that is a legal fact
   * about the buyer, not a per-order preference.
   *
   * ⚠️ **No `.default(false)`.** `organization.ts` deleted exactly that, on
   * exactly this shape, because the Typesense config declares the field
   * required and a `.default()` never materializes under `validateBeforeWrite`.
   *
   * Optional through api-cloudrun#409 Phase 1.
   */
  tax_exempt?: boolean;
  description?: string;
  emails: string[];
  phones: string[];
  billing_address: AddressType | null;
  contacts: OrganizationContactType[];
  query_by_contacts: string[];
  last_order?: FirestoreTimestampType | null;
  /**
   * Required. `createOrganization` stamps `threadDoc.uid` in the same
   * transaction that writes the organization. **291 of 291 prod and 313 of 313
   * dev organizations carry the key** (2026-08-23, `orderBy` key-presence) —
   * and dev's 22 native extras carrying it is what makes this a fact about the
   * writer rather than about the CRMS ingest.
   */
  uid_thread: string;
  version: number;
  created_by: ActorRefType;
  updated_by: ActorRefType;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}

/**
 * The four invariants that read **ONE document and nothing else**.
 *
 * 🔴 **Their independence is the whole point.** The rest of the tree guard is a
 * fixed-point check — *"`path` equals what the recompute produces"* — which is
 * defined in terms of the normalizer and can therefore only ever agree with it.
 * When `computeInvoiceItemPaths` returned its input unchanged on a divider-less
 * invoice, exactly that shape of guard certified **79 provably-wrong items as
 * clean, corpus-wide**. So these four are asserted DIRECTLY, and the
 * parent-chain recurrence is safe *because* they stand beside it.
 *
 * 🔴 **Invariant 1 is invisible to the existing drift guard, and that is why it
 * is here rather than in api-cloudrun.** `assertValidForWrite` /
 * `assertValidPatch` read `doc.uid` and compare it to `ref.id`; nothing checks
 * `path.at(-1).uid`. So `path` carries a SECOND copy of the document's own id
 * that only this refinement defends.
 *
 * ⚠️ Every arm is guarded on `path` being present, because `path` is
 * `.optional()` through the expand third of the rollout. That guard comes out
 * with the optionality.
 */
function checkOrganizationNode(doc: Organization, ctx: z.RefinementCtx): void {
  const path = doc.path;
  if (path === undefined) return;

  // 1. self-inclusive: the last node IS this document.
  if (path.length > 0 && path[path.length - 1].uid !== doc.uid) {
    ctx.addIssue({
      code: "custom",
      path: ["path", path.length - 1, "uid"],
      message: `path is self-inclusive: path.at(-1).uid must equal uid (${doc.uid}), got ${path[path.length - 1].uid}`,
    });
  }

  // 2. a root is always operator-named, so `composeOrgName` can never return "".
  if (path.length > 0 && path[0].derived) {
    ctx.addIssue({
      code: "custom",
      path: ["path", 0, "derived"],
      message: "the root node is always operator-named — path[0].derived must be false, or a composed name could be empty",
    });
  }

  // 3. `derived_from` and the leaf's own `derived` are two facts, and this is
  //    the one place they overlap.
  if (doc.derived_from !== undefined && path.length > 0) {
    const leafDerived = path[path.length - 1].derived;
    if ((doc.derived_from === null) !== (leafDerived === false)) {
      ctx.addIssue({
        code: "custom",
        path: ["derived_from"],
        message: `derived_from === null must agree with path.at(-1).derived === false (derived_from is ${doc.derived_from === null ? "null" : "set"}, leaf derived is ${leafDerived})`,
      });
    }
  }

  // 4. the Firestore-only flat mirror is exactly the uids of `path`.
  if (doc.query_by_path !== undefined) {
    const expected = path.map((n) => n.uid);
    const actual = doc.query_by_path;
    if (actual.length !== expected.length || expected.some((uid, i) => actual[i] !== uid)) {
      ctx.addIssue({
        code: "custom",
        path: ["query_by_path"],
        message: `query_by_path must equal path.map(n => n.uid) — expected [${expected.join(", ")}], got [${actual.join(", ")}]`,
      });
    }
  }

  // 8 (the half that is a one-document check). A typed department names a
  //   catalog entry; nothing else may.
  if (doc.uid_department_type !== undefined && path.length > 0) {
    const isTypedDepartment = path.length === 3 && !path[path.length - 1].derived;
    if ((doc.uid_department_type !== null) !== isTypedDepartment) {
      ctx.addIssue({
        code: "custom",
        path: ["uid_department_type"],
        message: `uid_department_type is set on exactly the TYPED departments (path.length === 3 and not derived) — this node is depth ${path.length}${path.length > 0 && path[path.length - 1].derived ? " and derived" : ""}`,
      });
    }
  }

  // 10. a derived placeholder states no billing address.
  //
  //     🔴 **The one-document half of api-cloudrun#777's rule** — organization
  //     states, project overrides, department inherits. A `(default)` node is
  //     CFS-native structure that no operator created, so an address on it is an
  //     answer nobody chose, and the resolver that rule calls for is meant to
  //     walk straight past it to the root.
  //
  //     ⚠️ **`createOrganization` already writes `billing_address: null` on every
  //     node it mints, and that is NOT the same statement.** The mint is not the
  //     only writer: `updateOrganization` accepts a `billing_address` for any
  //     uid, and manager's `OrganizationDetail` renders its Billing section with
  //     no level and no `derived` gate — only `OrgTree`'s list filter keeps an
  //     operator off a placeholder, which makes it authorable by URL. A writer
  //     that happens not to do the wrong thing is not an invariant.
  //
  //     ⚠️ Numbered 10 because 9 is the corpus-only shared-`xero_id` arm in
  //     `api-cloudrun/scripts/audit-organization-tree.ts` — a different
  //     namespace, but the same table in the `organization-tree` skill.
  if (doc.billing_address != null && path.length > 0 && path[path.length - 1].derived) {
    ctx.addIssue({
      code: "custom",
      path: ["billing_address"],
      message: "a derived placeholder states no business fact — billing_address must be null when path.at(-1).derived is true",
    });
  }
}

/** Zod schema for a full organization Firestore document. */
export const OrganizationSchema: z.ZodType<Organization> = z.strictObject({
  uid: FirestoreId,
  // ⚠️ `column: true` WITHOUT a `label`, so each node's heading composes from
  // the key that holds it — see `core/CLAUDE.md` § *Display columns*. It is not
  // in `displayDefaults.columns` yet: the scalar `name` is still the sort field
  // and the first column, and T10 forbids a rollup shadowing a declared column,
  // so the swap lands in the same commit as the `name` removal.
  path: z.array(OrgPathNode).min(1).max(3).meta({ column: true, label: "Tree" }),
  query_by_path: z.array(z.string()),
  derived_from: z.strictObject({
    source_uid: FirestoreId,
    reason: z.enum(["minted-root", "minted-project", "minted-department"]),
  }).nullable(),
  uid_department_type: FirestoreId.nullable(),
  dates: z.strictObject({
    start: chicagoStartOfDay().nullable().meta({ column: true, label: "Start" }),
    wrap: chicagoStartOfDay().nullable().meta({ column: true, label: "Wrap" }),
  }).optional().meta({ label: "Dates" }),
  crms_id: z.int().nullable(),
  xero_id: z.uuid().nullable(),
  // ⚠️ The "Required (no `.default(\"tax_applied\")`) … TAX_PROFILES[0]" note
  // that stood here described `tax_profile` and outlived it, sitting above a
  // field it does not describe. `TAX_PROFILES` is gone too.
  // `tax_profile` was DELETED here — api-cloudrun#596 item 3's contract third,
  // applied to prod (2,317 documents) and dev on 2026-08-22. The three steps
  // were forced, not ceremonial: every write validates the FULL document and
  // this is a `z.strictObject`, so a schema that has dropped the key REJECTS
  // every stored document still carrying it. Optional → empty storage → delete.
  jurisdiction_claim: JurisdictionEnum.nullable().optional().meta({
    column: true,
    label: "Jurisdiction Claim",
  }),
  tax_exempt: z.boolean().optional().meta({ column: true, label: "Tax Exempt" }),
  description: z.string().optional().meta({ column: true, label: "Description" }),
  emails: z.array(Email).default([]).meta({ column: true, label: "Emails" }),
  phones: z.array(Phone).default([]).meta({ column: true, label: "Phones" }),
  billing_address: Address.meta({ label: "Billing" }),
  // The whole contact is the column — the Typesense config indexes the nested
  // object, and `TableCell` joins the name parts.
  contacts: z.array(OrganizationContact).meta({ column: true, label: "Contacts" }),
  query_by_contacts: z.array(z.string()).default([]),
  last_order: FirestoreTimestamp.nullable().optional().meta({ column: true, label: "Last Order" }),
  uid_thread: ThreadId,
  version: z.int().min(0).default(0),
  created_by: ActorRef.meta({ column: true, label: "Created By" }),
  updated_by: ActorRef.meta({ column: true, label: "Updated By" }),
  ...TimestampFields,
}).superRefine(checkOrganizationNode).meta({
  title: "Organization",
  collection: "organizations",
  displayDefaults: {
    // ⚠️ **`name` is gone from the Firestore document**, so the FIRESTORE-side
    // table leads with the tree and sorts on nothing. The composed label lives
    // only on the Typesense side, where `TYPESENSE_ROLLUP_COLUMNS.organizations`
    // declares it — a Firestore reader holds `path` and composes for itself.
    columns: ["path", "contacts", "emails", "phones"],
    filters: {},
    sort: { column: null, direction: "asc" },
  },
});

/**
 * New contact data submitted inline when creating/updating an organization.
 */
export interface NewContactInputType extends NameParts {
  uid: string;
  emails?: string[];
  phones?: string[];
}

/** Zod schema for new contact data submitted inline with an organization. */
export const NewContactInput: z.ZodType<NewContactInputType> = z.object({
  uid: FirestoreId,
  ...NamePartsFields,
  emails: z.array(Email).optional(),
  phones: z.array(Phone).optional(),
});

/**
 * Input schema for POST /organizations.
 * crms_id and xero_id are obtained from external APIs — not in input.
 */
export interface CreateOrganizationInputType {
  uid: string;
  /**
   * The node's OWN name — one segment, not the composed display string.
   * `composeOrgName(path)` is what renders the full label, and nothing anywhere
   * splits a string to recover the hierarchy.
   */
  name: string;
  /**
   * The parent to hang this node under, or `null`/absent for a root.
   *
   * ⚠️ **The server derives `path` from the RESOLVED parent, never from a chain
   * the client sends** — the same one-author rule `computeItemPaths` enforces on
   * `items[].path`, so a client that skips, misnames or over-claims an
   * intermediate cannot survive a write.
   */
  uid_parent?: string | null;
  /**
   * The `department-types` entry a DEPARTMENT node names itself from. Required
   * by the tree validator on a typed department and refused elsewhere; the
   * server denormalizes its name into `path.at(-1).name`.
   */
  uid_department_type?: string | null;
  dates?: { start: string | null; wrap: string | null };
  /**
   * The two tax AXES a client states — the customer's standing jurisdiction
   * claim (level 2) and whether they are exempt.
   *
   * ⚠️ **`tax_profile` was REQUIRED here and is gone** (api-cloudrun#596 item
   * 2). The document still carries one because it is deleted a step later; the
   * server derives it from these two, which is the only way an axis-speaking
   * client can leave a coherent value in a field it no longer knows about.
   */
  jurisdiction_claim?: JurisdictionType | null;
  tax_exempt?: boolean;
  billing_address: AddressType | null;
  contacts?: OrganizationContactType[];
  newContacts?: NewContactInputType[] | null;
  emails?: string[];
  phones?: string[];
}

/** Input schema for creating an organization. */
export const CreateOrganizationInput: z.ZodType<CreateOrganizationInputType> = z.object({
  uid: FirestoreId,
  name: z.string().min(1, "Organization name is required").max(100).meta({ pii: "mask" }),
  uid_parent: FirestoreId.nullable().optional(),
  uid_department_type: FirestoreId.nullable().optional(),
  dates: z.object({
    start: chicagoStartOfDay().nullable(),
    wrap: chicagoStartOfDay().nullable(),
  }).optional(),
  jurisdiction_claim: JurisdictionEnum.nullable().optional(),
  tax_exempt: z.boolean().optional(),
  billing_address: Address,
  contacts: z.array(OrganizationContact).optional(),
  newContacts: z.array(NewContactInput).nullable().optional(),
  emails: z.array(Email).optional(),
  phones: z.array(Phone).optional(),
});

/**
 * Input schema for PUT /organizations/:uid — partial update.
 */
export interface UpdateOrganizationInputType {
  uid?: string;
  /** The node's OWN name — one segment. See {@link CreateOrganizationInputType}. */
  name?: string;
  /**
   * Re-parent this node, rewriting its whole subtree's `path`.
   *
   * ⚠️ **Absent and explicit `null` are DIFFERENT here**, which is why this is
   * not simply `?: string`. Absent means *leave the parent alone*; `null` means
   * *promote this node to a root*. That is the same split
   * `updateInvoice`'s destination-jurisdiction edit uses (api-cloudrun#630), and
   * it is what keeps this off core#70's *"an optional value can be set but never
   * unset"* surface.
   *
   * 🔴 **A re-parent gets its OWN propagation transaction id**, never a borrowed
   * `update-organization`: it fires a different rule set (the subtree rewrite
   * plus every name/snapshot rule, once per descendant), so `rules_expected`
   * genuinely differs — and a borrowed transaction id turns the drift warning
   * off silently.
   */
  uid_parent?: string | null;
  uid_department_type?: string | null;
  dates?: { start: string | null; wrap: string | null };
  /** The AXES — see {@link CreateOrganizationInputType}. */
  jurisdiction_claim?: JurisdictionType | null;
  tax_exempt?: boolean;
  description?: string;
  billing_address?: AddressType | null;
  contacts?: OrganizationContactType[];
  newContacts?: NewContactInputType[] | null;
  emails?: string[];
  phones?: string[];
  version: number;
}

/** Input schema for updating an organization. */
export const UpdateOrganizationInput: z.ZodType<UpdateOrganizationInputType> = z.object({
  uid: FirestoreId.optional(),
  name: z.string().min(1, "Organization name is required").max(100).meta({ pii: "mask" }).optional(),
  uid_parent: FirestoreId.nullable().optional(),
  uid_department_type: FirestoreId.nullable().optional(),
  dates: z.object({
    start: chicagoStartOfDay().nullable(),
    wrap: chicagoStartOfDay().nullable(),
  }).optional(),
  jurisdiction_claim: JurisdictionEnum.nullable().optional(),
  tax_exempt: z.boolean().optional(),
  description: z.string().optional(),
  billing_address: Address.optional(),
  contacts: z.array(OrganizationContact).optional(),
  newContacts: z.array(NewContactInput).nullable().optional(),
  emails: z.array(Email).optional(),
  phones: z.array(Phone).optional(),
  version: z.int().min(0),
});
