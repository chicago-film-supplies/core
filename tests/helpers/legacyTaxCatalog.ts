/**
 * **The retired `taxes` → class-catalog migration, kept as a TEST fixture builder.**
 *
 * It ran once, in both environments, as api-cloudrun#993 Step 3 (the backfill),
 * and the legacy `taxes` collection is deleted. Nothing in `src/` calls it; it
 * lives here because tests still describe their catalogs as readable
 * `(jurisdiction, item_types, window)` rows and let this build the codes, rates
 * and classes the rule prices on. Moved out of `src/utils/tax-classes.ts` at the
 * contract step so the published package no longer carries it.
 */
import type {
  ActorRefType,
  FirestoreTimestampType,
  JurisdictionType,
  PreTaxItemType,
  ProductTypeType,
  RateType,
  TaxClass,
  TaxCode,
  TaxJurisdictionType,
  TaxRate,
  XeroTaxComponentType,
} from "../../src/schemas/mod.ts";
import type { TaxCatalog } from "../../src/utils/tax-classes.ts";
import type { Tax } from "../../src/utils/orders.ts";

/**
 * A fixture row in the retired `taxes` shape: a pricing `Tax` plus the
 * `item_types` membership the migration derives classes from. `Tax` itself no
 * longer declares `item_types` — nothing in `src/` reads it.
 */
export type LegacyTax = Tax & { item_types?: PreTaxItemType[] };

// ── migrateLegacyTaxCatalog ──────────────────────────────────────────────

/** What a migration mints and stamps. Core cannot mint a Firestore id, so the caller does. */
export interface LegacyTaxMigrationContext {
  actor: ActorRefType;
  now: FirestoreTimestampType;
  /** A fresh document id for a code or class that does not exist yet. */
  mintUid: () => string;
}

/** The catalog the legacy `taxes` collection maps to, plus what did not map. */
export interface LegacyTaxMigration extends TaxCatalog {
  codes: TaxCode[];
  rates: TaxRate[];
  classes: TaxClass[];
  /** Legacy rows with no code to belong to — today only "No Tax" (`jurisdiction: null`). */
  skipped: Array<{ uid: string; name: string; reason: string }>;
}

/**
 * One document of the retired `taxes` collection, as the migration read it.
 *
 * Kept local rather than as a schema: the collection is gone (api-cloudrun#993),
 * and this shape now exists only so a test can build a catalog from the prod rows
 * it was migrated from.
 */
export interface LegacyTaxRow {
  uid: string;
  name: string;
  rate: number;
  type: RateType;
  jurisdiction?: JurisdictionType | null;
  item_types: PreTaxItemType[];
  applied_from: string;
  applied_from_fs: FirestoreTimestampType;
  applied_to: string | null;
  applied_to_fs: FirestoreTimestampType | null;
  effective_from: string | null;
  xero_tax_type?: string | null;
  xero_account_code?: number | null;
  xero_item_code?: string | null;
  xero_components: XeroTaxComponentType[];
}

/** The class names the migration owns, and the legacy item type each is derived from. */
export const MIGRATED_TAX_CLASSES = {
  rental: "Rental",
  sale: "Sale",
  replacement: "Replacement",
  bottled: "Sale – Bottled Water",
  none: "Non-Taxable",
} as const;

/**
 * **`taxes` → `taxes-codes` × `taxes-rates` × `taxes-classes`** — the one mapping
 * the backfill and the parity test share (api-cloudrun#993), so what the test
 * proves prices identically is what the backfill writes.
 *
 * - **Codes** group legacy rows by `name`. A group whose rows disagree on
 *   `jurisdiction`, `type`, `xero_account_code` or `xero_item_code` THROWS: those
 *   are properties of the code, and picking one would silently re-home a rate.
 * - **Rates** keep the legacy uid, so every stored `price.taxes[].uid` still names
 *   its rate. Window, `effective_from` and the Xero binding are copied as stored.
 * - **Classes** derive from `item_types`: Rental, Sale and Replacement list every
 *   code with a version listing that type. "Sale – Bottled Water" is Sale plus the
 *   one explicit-only code (every version `item_types: []`), which the legacy rule
 *   reached by uid ref; more than one explicit-only code THROWS, because which
 *   products carry which ref is not in the catalog. Non-Taxable is `[]`.
 * - **"No Tax" is skipped**, not migrated — no code can carry `jurisdiction: null`,
 *   and Non-Taxable states the same fact.
 *
 * ## Idempotent against `existing`
 *
 * A code or class is matched to an existing document BY NAME and keeps its uid,
 * version and stamps; a rate by uid. So re-running over an unchanged `taxes`
 * collection returns documents deep-equal to `existing`, and the caller writes
 * only what differs. A class whose code SET is unchanged keeps its stored order.
 *
 * ⚠️ **Re-running REPLACES migrated class membership from `item_types`.** That is
 * right only while `taxes` is the source of truth — before the reader switch,
 * when nothing else can edit a class. After it, do not run this.
 */
export function migrateLegacyTaxCatalog(
  legacy: readonly LegacyTaxRow[],
  existing: TaxCatalog,
  ctx: LegacyTaxMigrationContext,
): LegacyTaxMigration {
  const stamps = { version: 0, created_by: ctx.actor, updated_by: ctx.actor, created_at: ctx.now, updated_at: ctx.now };
  const identity = <T extends { uid: string; version: number; created_by: ActorRefType; updated_by: ActorRefType; created_at: FirestoreTimestampType; updated_at: FirestoreTimestampType }>(
    prior: T | undefined,
  ) =>
    prior
      ? { uid: prior.uid, version: prior.version, created_by: prior.created_by, updated_by: prior.updated_by, created_at: prior.created_at, updated_at: prior.updated_at }
      : { uid: ctx.mintUid(), ...stamps };

  const skipped: LegacyTaxMigration["skipped"] = [];
  const migrated = [...legacy]
    .filter((t) => {
      if (t.jurisdiction == null || t.jurisdiction === "no_nexus") {
        skipped.push({ uid: t.uid, name: t.name, reason: "no jurisdiction — the Non-Taxable class states this" });
        return false;
      }
      return true;
    })
    .sort((a, b) => a.name.localeCompare(b.name) || Date.parse(a.applied_from) - Date.parse(b.applied_from));

  // ── codes ──
  const groups = new Map<string, LegacyTaxRow[]>();
  for (const t of migrated) groups.set(t.name, [...(groups.get(t.name) ?? []), t]);

  const codes: TaxCode[] = [];
  const codeUidByName = new Map<string, string>();
  for (const [name, rows] of groups) {
    const first = rows[0];
    for (const key of ["jurisdiction", "type", "xero_account_code", "xero_item_code"] as const) {
      const values = new Set(rows.map((r) => r[key] ?? null));
      if (values.size > 1) {
        throw new Error(
          `migrateLegacyTaxCatalog: the versions of "${name}" disagree on ${key} (${[...values].join(", ")}) — ` +
            `a code carries one, so fix the taxes documents before migrating.`,
        );
      }
    }
    const prior = existing.codes.find((c) => c.name === name);
    const code: TaxCode = {
      ...identity(prior),
      name,
      jurisdiction: first.jurisdiction as TaxJurisdictionType,
      type: first.type,
      xero_account_code: first.xero_account_code ?? null,
      xero_item_code: first.xero_item_code ?? null,
      active: prior?.active ?? true,
    };
    codes.push(code);
    codeUidByName.set(name, code.uid);
  }

  // ── rates ──
  const rates: TaxRate[] = migrated.map((t) => {
    const prior = existing.rates.find((r) => r.uid === t.uid);
    return {
      ...identity(prior),
      uid: t.uid,
      uid_tax_code: codeUidByName.get(t.name)!,
      rate: t.rate,
      type: t.type,
      applied_from: t.applied_from,
      applied_from_fs: t.applied_from_fs,
      applied_to: t.applied_to,
      applied_to_fs: t.applied_to_fs,
      effective_from: t.effective_from,
      xero_tax_type: t.xero_tax_type ?? null,
      xero_components: t.xero_components,
    };
  });

  // ── classes ──
  const listing = (key: string) => [...new Set(migrated.filter((t) => t.item_types.includes(key as never)).map((t) => codeUidByName.get(t.name)!))];
  const explicitOnly = [...groups].filter(([, rows]) => rows.every((r) => r.item_types.length === 0)).map(([name]) => codeUidByName.get(name)!);
  if (explicitOnly.length > 1) {
    throw new Error(
      `migrateLegacyTaxCatalog: ${explicitOnly.length} explicit-only codes. Only the bottle levy has a known class ` +
        `("${MIGRATED_TAX_CLASSES.bottled}"); name a class for the others before migrating.`,
    );
  }

  const planned: Array<[name: string, codes: string[], defaults: ProductTypeType[]]> = [
    [MIGRATED_TAX_CLASSES.rental, listing("rental"), ["rental"]],
    [MIGRATED_TAX_CLASSES.sale, listing("sale"), ["sale"]],
    ...(explicitOnly.length === 1
      ? [[MIGRATED_TAX_CLASSES.bottled, [...listing("sale"), explicitOnly[0]], []] as [string, string[], ProductTypeType[]]]
      : []),
    [MIGRATED_TAX_CLASSES.replacement, listing("replacement"), ["replacement"]],
    [MIGRATED_TAX_CLASSES.none, [], ["service", "surcharge", "transaction_fee"]],
  ];

  const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x));
  const classes: TaxClass[] = planned.map(([name, uid_tax_codes, is_default_for]) => {
    const prior = existing.classes.find((c) => c.name === name);
    return {
      ...identity(prior),
      name,
      description: prior?.description ?? null,
      uid_tax_codes: prior && sameSet(prior.uid_tax_codes, uid_tax_codes) ? [...prior.uid_tax_codes] : uid_tax_codes,
      is_default_for: prior && sameSet(prior.is_default_for, is_default_for) ? [...prior.is_default_for] : is_default_for,
      active: prior?.active ?? true,
    };
  });

  return { codes, rates, classes, skipped };
}
