/**
 * Schema-derived **test fixtures** — the third seeding contract, beside
 * `getInitialValues` (form seed) and each consumer's own write boundary.
 *
 * ## Why this is not `getInitialValues`
 *
 * `getInitialValues` answers *"what should this form show before the user
 * types?"* and its return is honestly `Partial<T>`: it omits `z.custom` leaves,
 * collapses a union to its first arm, and walks **into** `.optional()` to
 * materialize the intermediate objects a `setStore("shipping.height", …)` call
 * needs to exist before the first keystroke. Every one of those is right for a
 * form and wrong for a fixture.
 *
 * A fixture wants the opposite: a **complete document that parses**, with
 * nothing present that the schema does not require. The two questions were
 * being answered by one function, so every fixture site in three repos carried
 * a repair on top of it — 27 `uid_thread: testFid()` patches, a
 * `delete productBase.transaction`, an empty-string filter, and ~73 casts that
 * each erased the type the helper was supposed to supply. The four independent
 * workarounds were all on **input** schemas, where `getInitialValues`' `""` is
 * not merely incomplete but *invalid* against `.min(1)` / `z.uuid()` /
 * `z.email()`.
 *
 * ## What it guarantees
 *
 * 1. **Complete** — the return is `z.output<S>`, not `Partial`, because the
 *    result is the output of a real `parse`. No cast at the call site.
 * 2. **Required-only** — an `.optional()` key is **omitted, not recursed into**,
 *    so `omit(doc, k)` is rejected by construction for every `k` the schema
 *    genuinely requires **on input**. ⚠️ Not literally every key: a `.default(x)`
 *    declaration is required in `z.output` and present in the built document,
 *    and the schema still accepts a document without it — the default
 *    re-materializes. Measured across the registry that is 465 of 595 top-level
 *    declarations covered, the other 130 being declarations the schemas
 *    themselves make droppable. {@link getFullTestDoc} is the opt-in for the
 *    other behaviour.
 * 3. **Every leaf parses against its own leaf schema** — generate-then-verify,
 *    with the leaf's own `safeParse` as the oracle (see {@link buildString}).
 * 4. **`z.array().min(n)` is honoured** — an array whose minimum is 1 gets one
 *    built element, not `[]`.
 * 5. **The whole document is parsed, and a failure throws naming every path.**
 *    Load-bearing, not defensive: 22 `superRefine` invariants across the
 *    registry are not derivable from structure, so this is what turns
 *    *"nine fixture sites found by grepping a field name"* into *"nine tests
 *    fail at construction naming `jurisdiction`."*
 *
 * ## 🔴 Timestamps are CALLER-INJECTED. This module does not fabricate them.
 *
 * `FirestoreTimestamp` (`schemas/common.ts`) is a `z.custom` that accepts any
 * `{ seconds, nanoseconds }`, so a fabricated plain object **parses**. It is
 * also, in Firestore, a **map** rather than a `Timestamp` — and api-cloudrun's
 * test harness identifies its own fixtures with `c instanceof Timestamp`
 * (`isEphemeralDoc`, `createdByThisRun`). A map-timestamped fixture is
 * therefore invisible to the ephemeral filter *and* leaks past cleanup, which
 * is the api-cloudrun#278 flake class, and any reader calling `.toMillis()`
 * throws. **A value that parses and is wrong is worse than no value.**
 *
 * So `options.now` carries the timestamp, is **not defaulted**, and is
 * **required at compile time** for any schema whose document carries
 * `created_at` / `updated_at` — see {@link TestDocOptionsArg}. That is the one
 * place a missing required field is a compile error rather than a runtime
 * throw. Nested `*_fs` timestamp leaves are filled from the same value.
 *
 * ⚠️ **And this module deliberately exports no `mockTimestamp` / `tsAt`
 * fabricator**, though core's and manager's suites could both legitimately use
 * one — neither writes to Firestore. Exporting it would put the hazard one
 * import away from the one repo that must not touch it, and *not* exporting it
 * is the reversible direction: api-cloudrun's write boundary can assert
 * `instanceof Timestamp` first, and this module can add the fabricator
 * afterwards without a breaking change. The reverse order cannot be undone.
 *
 * @module
 */

import { z } from "zod";
import { FIRESTORE_TIMESTAMP_META, type FirestoreTimestampValue } from "./common.ts";

// ── Zod 4 internals ──────────────────────────────────────────────────

/**
 * The `_zod.def` shape, narrowed to the keys this walker reads.
 *
 * Declared locally rather than imported from `zod-walk.ts` (which has its own
 * copy, un-exported) — the two readers want different keys, and a shared
 * "every key any walker might want" interface is how one walker silently starts
 * depending on a field the other maintains.
 */
interface ZodDef {
  type: string;
  innerType?: z.ZodType;
  element?: z.ZodType;
  shape?: Record<string, z.ZodType>;
  valueType?: z.ZodType;
  entries?: Record<string, string | number>;
  values?: readonly unknown[];
  format?: string;
  in?: z.ZodType;
  options?: z.ZodType[];
  parts?: readonly (string | number | boolean | z.ZodType)[];
  defaultValue?: unknown;
  checks?: readonly unknown[];
}

function def(node: z.ZodType): ZodDef {
  return (node as unknown as { _zod: { def: ZodDef } })._zod.def;
}

/**
 * A `.min()` / `.length()` style constraint, flattened.
 *
 * ⚠️ **The three value keys disagree, and guessing costs more time than the
 * design does.** Measured against Zod 4.3:
 *
 * | construct                              | `check`         | value key  |
 * |----------------------------------------|-----------------|------------|
 * | `z.number().min(n)` / `z.int().min(n)`  | `greater_than`  | `value`    |
 * | `z.string().length(n)`                  | `length_equals` | `length`   |
 * | `z.string().min(n)` / `z.array().min(n)`| `min_length`    | `minimum`  |
 */
interface FlatCheck {
  check?: string;
  value?: unknown;
  length?: number;
  minimum?: number;
  maximum?: number;
  inclusive?: boolean;
}

function checksOf(node: z.ZodType): FlatCheck[] {
  const out: FlatCheck[] = [];
  for (const c of def(node).checks ?? []) {
    const d = (c as { _zod?: { def?: FlatCheck } })._zod?.def;
    if (d) out.push(d);
  }
  return out;
}

function findCheck(node: z.ZodType, name: string): FlatCheck | undefined {
  return checksOf(node).find((c) => c.check === name);
}

// ── Public types ─────────────────────────────────────────────────────

/**
 * A recursively-optional view of `T`, for overrides.
 *
 * Arrays are **not** made partial: overrides replace an array wholesale rather
 * than merging element-wise, so a caller supplying one supplies whole elements.
 */
export type DeepPartial<T> = T extends readonly unknown[] ? T
  : T extends object ? { [K in keyof T]?: DeepPartial<T[K]> }
  : T;

/** Options accepted by every entry point in this module. */
export interface TestDocOptions {
  /**
   * The value written into every `FirestoreTimestamp` leaf.
   *
   * Typed `FirestoreTimestampValue` rather than the `FirestoreTimestampType`
   * union deliberately: the union's other arm is a write-time `FieldValue`
   * sentinel, which the runtime gate rejects, so accepting it here would only
   * move the failure later. The narrower type also demands `toMillis` /
   * `toDate`, which a bare `{ seconds, nanoseconds }` object literal does not
   * have — so the compile error arrives before the silent one. A mock that
   * *implements* those two methods still stores as a map, which is why the
   * prose in this module's header is not redundant with the type.
   */
  now?: FirestoreTimestampValue;
}

/** {@link TestDocOptions} with `now` promoted to required. */
export interface TestDocOptionsWithNow extends TestDocOptions {
  now: FirestoreTimestampValue;
}

/**
 * The trailing options argument, **required exactly when the document carries
 * `created_at` / `updated_at`** and optional otherwise.
 *
 * This is what makes `getTestDoc(OrderSchema, {})` a compile error and
 * `getTestDoc(CreateOrderInput, {})` legal: an input schema has no timestamp
 * fields, so the conditional collapses to the optional arm.
 *
 * The `[…] extends […]` brackets are not decoration — a bare
 * `Extract<…> extends never` on a naked type parameter distributes and yields
 * `never` for the empty case, which is neither arm.
 */
export type TestDocOptionsArg<T> = [Extract<keyof T, "created_at" | "updated_at">] extends [never]
  ? [options?: TestDocOptions]
  : [options: TestDocOptionsWithNow];

// ── The walk ─────────────────────────────────────────────────────────

/** Sentinel: this node contributes no key. */
const OMIT: unique symbol = Symbol("omit");

interface Ctx {
  /** Emit `.optional()` keys too ({@link getFullTestDoc}). */
  readonly full: boolean;
  readonly now: FirestoreTimestampValue | undefined;
  /** Set when a timestamp leaf was reached with no `options.now` to fill it. */
  wantedNow: boolean;
}

/**
 * String candidates, **swept in order against the leaf's own `safeParse`**.
 *
 * 🔴 **The sweep runs FIRST and introspection is the fallback — never the other
 * way round.** A version that read `def.format` first and only swept on a miss
 * silently stopped reaching the sweep for every `z.email()` / `z.uuid()` /
 * `z.iso.datetime()` leaf and the corpus pass rate fell from 50 to 31 *with no
 * error*, because introspection finding nothing is indistinguishable from a
 * leaf with no constraints. Asking the leaf what it accepts is reliable;
 * reading its internals is the guess.
 *
 * `""` leads because the contract is *minimal* valid — an unconstrained string
 * field has no more informative value, and anything else invents data.
 */
const STRING_CANDIDATES: readonly string[] = [
  "",
  "x",
  // 20 alphanumerics — `FirestoreId`, and every `uid_*` reference.
  "AAAAAAAAAAAAAAAAAAAA",
  "00000000-0000-4000-8000-000000000000",
  "test@example.com",
  "1970-01-01T00:00:00.000Z",
  "1970-01-01",
  "https://example.com",
  "1",
  "00:00",
];

const NUMBER_CANDIDATES: readonly number[] = [0, 1];

/** First candidate the node itself accepts, or `OMIT`. */
function sweep<T>(node: z.ZodType, candidates: readonly T[]): T | typeof OMIT {
  for (const c of candidates) if (node.safeParse(c).success) return c;
  return OMIT;
}

function buildString(node: z.ZodType): unknown {
  const swept = sweep(node, STRING_CANDIDATES);
  if (swept !== OMIT) return swept;

  // Fallback: synthesize from a length constraint the sweep could not satisfy.
  const exact = findCheck(node, "length_equals")?.length;
  const min = findCheck(node, "min_length")?.minimum;
  for (const n of [exact, min]) {
    if (typeof n === "number" && n > 0) {
      const padded = "a".repeat(n);
      if (node.safeParse(padded).success) return padded;
      const alnum = "A".repeat(n);
      if (node.safeParse(alnum).success) return alnum;
    }
  }
  return OMIT;
}

function buildNumber(node: z.ZodType): unknown {
  const swept = sweep(node, NUMBER_CANDIDATES);
  if (swept !== OMIT) return swept;

  const gt = findCheck(node, "greater_than");
  if (typeof gt?.value === "number") {
    const n = gt.inclusive === false ? gt.value + 1 : gt.value;
    if (node.safeParse(n).success) return n;
  }
  const lt = findCheck(node, "less_than");
  if (typeof lt?.value === "number") {
    const n = lt.inclusive === false ? lt.value - 1 : lt.value;
    if (node.safeParse(n).success) return n;
  }
  return OMIT;
}

/** How many elements an array node must carry to satisfy its own constraints. */
function arrayLength(node: z.ZodType): number {
  const exact = findCheck(node, "length_equals")?.length;
  if (typeof exact === "number") return exact;
  const min = findCheck(node, "min_length")?.minimum;
  return typeof min === "number" ? min : 0;
}

function isFirestoreTimestampNode(node: z.ZodType): boolean {
  const meta = z.globalRegistry.get(node) as Record<string, unknown> | undefined;
  return meta?.[FIRESTORE_TIMESTAMP_META] === true;
}

function build(node: z.ZodType, ctx: Ctx, depth: number): unknown {
  if (depth > 40) return OMIT;
  const d = def(node);

  switch (d.type) {
    // ── Wrappers ────────────────────────────────────────────────────
    case "optional":
      // The root fix. An optional key is omitted, not recursed into.
      return ctx.full && d.innerType ? build(d.innerType, ctx, depth + 1) : OMIT;

    case "default":
    case "prefault":
      // Omitted in BOTH modes on purpose: the final `parse` materializes the
      // declared default, so the output carries it either way and the input
      // stays minimal. (`.default(x).optional()` is `Optional(Default(x))` —
      // the outer `optional` above wins, and the key is genuinely absent.)
      return OMIT;

    case "nullable": {
      // Required-only wants the cheapest valid value; `full` wants the field
      // actually populated, which is the whole reason a caller reaches for it.
      if (ctx.full && d.innerType) {
        const inner = build(d.innerType, ctx, depth + 1);
        if (inner !== OMIT) return inner;
      }
      return null;
    }

    case "nonoptional":
    case "readonly":
    case "catch":
      return d.innerType ? build(d.innerType, ctx, depth + 1) : OMIT;

    case "pipe":
      // `.transform()` — build the INPUT side, because the parse we hand the
      // result to runs input → output. This is what lets `chicagoInstant()`
      // take an ISO datetime and canonicalize it itself.
      return d.in ? build(d.in, ctx, depth + 1) : OMIT;

    // ── Composites ──────────────────────────────────────────────────
    case "object": {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(d.shape ?? {})) {
        const v = build(child, ctx, depth + 1);
        if (v !== OMIT) out[key] = v;
      }
      return out;
    }

    case "array": {
      const n = arrayLength(node);
      if (n === 0 || !d.element) return [];
      const out: unknown[] = [];
      for (let i = 0; i < n; i++) {
        const v = build(d.element, ctx, depth + 1);
        if (v === OMIT) return [];
        out.push(v);
      }
      return out;
    }

    case "record":
      return {};

    case "union": {
      // First arm that accepts its own built value. Deliberately not a
      // caller-selectable arm — no call site across 200+ files wanted one.
      let fallback: unknown = OMIT;
      for (const arm of d.options ?? []) {
        const v = build(arm, ctx, depth + 1);
        if (v === OMIT) continue;
        if (arm.safeParse(v).success) return v;
        if (fallback === OMIT) fallback = v;
      }
      return fallback;
    }

    case "template_literal": {
      // Built structurally from its own parts, which is what makes the
      // composite ids (`BookingId`, `MovementId`, `QuoteId`, `EventCardId`)
      // reachable at all — no fixed candidate list can spell them.
      let s = "";
      for (const part of d.parts ?? []) {
        if (typeof part !== "object") {
          s += String(part);
          continue;
        }
        const v = build(part, ctx, depth + 1);
        if (v === OMIT) return OMIT;
        s += String(v);
      }
      return node.safeParse(s).success ? s : OMIT;
    }

    // ── Leaves ──────────────────────────────────────────────────────
    case "enum": {
      const values = Object.values(d.entries ?? {});
      return values.length > 0 ? values[0] : OMIT;
    }

    case "literal":
      return d.values && d.values.length > 0 ? d.values[0] : OMIT;

    case "string":
      return buildString(node);

    case "number":
      return buildNumber(node);

    case "boolean":
      return false;

    case "null":
      return null;

    case "any":
    case "unknown":
      return {};

    case "custom": {
      if (isFirestoreTimestampNode(node)) {
        if (ctx.now === undefined) {
          ctx.wantedNow = true;
          return OMIT;
        }
        return ctx.now;
      }
      // Any other `z.custom` — ask it what it accepts, same as a leaf.
      const s = sweep(node, STRING_CANDIDATES);
      if (s !== OMIT) return s;
      return sweep(node, NUMBER_CANDIDATES);
    }

    default:
      return OMIT;
  }
}

// ── Overrides ────────────────────────────────────────────────────────

/**
 * `Object.prototype`-or-nothing check.
 *
 * ⚠️ Load-bearing for timestamps: a real Firestore `Timestamp` is a class
 * instance, so it fails this and is replaced **wholesale** rather than being
 * merged key-by-key into a plain `{ seconds, nanoseconds }` — which would strip
 * its prototype and reintroduce the exact map-vs-Timestamp hazard this module's
 * header is about.
 */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * Objects merge key-wise; arrays and everything else replace wholesale.
 *
 * An explicit `undefined` **deletes** the key, which is how a caller asks for a
 * required field to be absent — the parse then rejects it, by design.
 */
function deepMerge(base: unknown, over: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(over)) return over;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) delete out[k];
    else if (k in out) out[k] = deepMerge(out[k], v);
    else out[k] = v;
  }
  return out;
}

// ── Enum-arm search ──────────────────────────────────────────────────

/**
 * On a whole-document parse failure, retry each member of each top-level enum
 * field.
 *
 * Still purely structural — no per-schema knowledge — and it halves the
 * override list the gate measured: `product` parses only as `type: "sale"`
 * (a `rental` obliges `price.replacement_cents` via `superRefine`) and
 * `templates-versions` only as `status: "archived"`.
 *
 * ⚠️ **So the default product fixture is a SALE.** A caller wanting a rental
 * must supply `price.replacement_cents` alongside it. Surprising if
 * undocumented; stated here and in `core/CLAUDE.md`.
 *
 * Only **one** field is re-chosen at a time, and never one the caller
 * overrode. A schema needing two simultaneous re-choices falls through to the
 * throw, which names the paths — the escape hatch is per-call overrides, not a
 * combinatorial search.
 */
function enumArmSearch<S extends z.ZodType>(
  schema: S,
  input: Record<string, unknown>,
  overridden: ReadonlySet<string>,
): z.ZodSafeParseResult<z.output<S>> | null {
  const shape = def(schema).shape;
  if (!shape) return null;

  for (const [key, child] of Object.entries(shape)) {
    if (overridden.has(key)) continue;
    let node: z.ZodType = child;
    let d = def(node);
    while (d.innerType && d.type !== "enum") {
      node = d.innerType;
      d = def(node);
    }
    if (d.type !== "enum") continue;

    const members = Object.values(d.entries ?? {});
    for (const m of members) {
      if (m === input[key]) continue;
      const attempt = schema.safeParse({ ...input, [key]: m });
      if (attempt.success) return attempt;
    }
  }
  return null;
}

// ── Errors ───────────────────────────────────────────────────────────

function formatFailure(error: z.ZodError, wantedNow: boolean, gaveNow: boolean): string {
  const lines = error.issues.map((i) => `  ${i.path.join(".") || "<root>"}: ${i.message}`);
  const hint = wantedNow && !gaveNow
    ? "\n\nThis schema has FirestoreTimestamp leaves and no `options.now` was " +
      "given. Pass a real Timestamp — this module deliberately does not " +
      "fabricate one; see its module docblock."
    : "\n\nSupply the failing paths as overrides. A cross-field `superRefine` " +
      "is not derivable from structure, which is why this throws rather than " +
      "returning something that only looks complete.";
  return `getTestDoc: the built document does not parse.\n${lines.join("\n")}${hint}`;
}

// ── Entry points ─────────────────────────────────────────────────────

function construct<S extends z.ZodType>(
  schema: S,
  overrides: unknown,
  options: TestDocOptions | undefined,
  full: boolean,
): z.output<S> {
  const ctx: Ctx = { full, now: options?.now, wantedNow: false };
  const built = build(schema, ctx, 0);
  if (!isPlainObject(built)) {
    throw new TypeError("getTestDoc requires an object schema");
  }

  const merged = deepMerge(built, isPlainObject(overrides) ? overrides : {});
  const result = schema.safeParse(merged);
  if (result.success) return result.data;

  const overridden = new Set(isPlainObject(overrides) ? Object.keys(overrides) : []);
  const rechosen = enumArmSearch(schema, merged as Record<string, unknown>, overridden);
  if (rechosen?.success) return rechosen.data;

  throw new Error(formatFailure(result.error, ctx.wantedNow, options?.now !== undefined));
}

/**
 * A minimal **complete, parsing** document for `schema`.
 *
 * Required keys only — an `.optional()` key is omitted rather than recursed
 * into, so the result is the smallest document the schema accepts and
 * `omit(result, k)` is rejected for every `k`.
 *
 * Overrides **deep-merge**: plain objects merge key-wise, arrays and class
 * instances replace wholesale, and an explicit `undefined` deletes the key.
 *
 * @throws if the built document does not parse — the message lists every
 * failing path. That is the contract, not a defect: it is what makes a new
 * required field, or a `superRefine` no structural walk can satisfy, fail at
 * construction naming itself.
 */
export function getTestDoc<S extends z.ZodType>(
  schema: S,
  overrides?: DeepPartial<z.output<S>>,
  ...options: TestDocOptionsArg<z.output<S>>
): z.output<S> {
  return construct(schema, overrides, (options as [TestDocOptions?])[0], false);
}

/**
 * {@link getTestDoc}, but `.optional()` keys are emitted too and `.nullable()`
 * fields carry a built value rather than `null`.
 *
 * A separate function rather than a flag on {@link getTestDoc}: the default has
 * to be the one that keeps negative tests honest, and a boolean parameter at
 * the call site is exactly as easy to pass as to forget.
 */
export function getFullTestDoc<S extends z.ZodType>(
  schema: S,
  overrides?: DeepPartial<z.output<S>>,
  ...options: TestDocOptionsArg<z.output<S>>
): z.output<S> {
  return construct(schema, overrides, (options as [TestDocOptions?])[0], true);
}

/**
 * A **deliberately incomplete** fixture: exactly the fields given, typed
 * against `schema`, with each one validated in place.
 *
 * For the stand-in that is short *on purpose* — a four-field `Product` handed
 * to a function that reads four fields, where a fuller fixture "would hide
 * which fields actually matter". Those sites reach for `as unknown as T` today;
 * this is the same fixture with the cast replaced by a checked binding, and no
 * extra lines.
 *
 * It does **not** run the schema's own walk. A partial document cannot be
 * parsed as a whole (that is what makes it partial), so what is checked is each
 * supplied leaf against the schema node at its path — a misspelt key or a value
 * of the wrong shape throws, a missing key does not.
 *
 * @throws if a supplied path names no field of `schema`, or its value is
 * rejected by that field's own schema.
 */
export function getTestDocPartial<S extends z.ZodType>(
  schema: S,
  fields: DeepPartial<z.output<S>>,
): Partial<z.output<S>> {
  if (!isPlainObject(fields)) throw new TypeError("getTestDocPartial requires an object");
  const problems: string[] = [];
  checkPartial(schema, fields, [], problems);
  if (problems.length > 0) {
    throw new Error(`getTestDocPartial: supplied fields do not fit the schema.\n${problems.join("\n")}`);
  }
  return fields as Partial<z.output<S>>;
}

/**
 * Validate supplied leaves against their own nodes, descending only where the
 * supplied value is itself a plain object AND the schema node is an object.
 *
 * Anything else — an array, a union arm, a `z.custom` — is checked whole by the
 * node's own `safeParse` rather than descended into, which keeps this honest
 * about what it can see instead of guessing.
 */
function checkPartial(
  node: z.ZodType,
  value: unknown,
  path: string[],
  problems: string[],
): void {
  let n: z.ZodType = node;
  let d = def(n);
  while (d.innerType && d.type !== "object") {
    n = d.innerType;
    d = def(n);
  }

  if (d.type === "object" && isPlainObject(value)) {
    const shape = d.shape ?? {};
    for (const [k, v] of Object.entries(value)) {
      const child = shape[k];
      if (!child) {
        problems.push(`  ${[...path, k].join(".")}: no such field`);
        continue;
      }
      checkPartial(child, v, [...path, k], problems);
    }
    return;
  }

  const r = n.safeParse(value);
  if (!r.success) {
    for (const i of r.error.issues) {
      problems.push(`  ${[...path, ...i.path.map(String)].join(".") || "<root>"}: ${i.message}`);
    }
  }
}
