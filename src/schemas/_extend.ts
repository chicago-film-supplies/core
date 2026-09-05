/**
 * `.extend()` with the (base, derived) pair captured, so a dropped annotation
 * can be caught.
 *
 * ## The mechanism
 *
 * `z.globalRegistry` is a **WeakMap keyed on the schema instance**, and
 * `.meta()` clones. So a field re-declared inside `.extend()` is a *different
 * instance* and carries **none** of the base's annotations. Measured, not
 * reasoned — all four of these were probed against `zod@4.3.6`:
 *
 * | construct | result |
 * |---|---|
 * | a field NOT named in the extension | same instance, meta survives |
 * | a field re-declared in the extension | **new instance, meta GONE** |
 * | `.meta()` on the OBJECT itself | **GONE on the extended object** |
 * | `z.strictObject(...).extend(...)` | strictness preserved |
 *
 * The third row is not in core#82's write-up and is guarded here anyway: an
 * object-level tag is exactly how `Address`'s `pii: "mask"` is spelled, and
 * losing one is silent in the same way.
 *
 * ## Why the annotation matters more than the field
 *
 * `applyPii` is driven **entirely** by `.meta({ pii })` (`pii/walker.ts`), so
 * the channel that drops a `label` drops a mask. 🔴 **And a dropped tag is
 * invisible to `tests/pii.test.ts` by construction** — that test asserts what
 * the schema currently claims, and a field that never had a tag is
 * indistinguishable from one that lost it.
 *
 * `tests/pii.test.ts` does enforce `pii` **by field name** against
 * `pii/dictionary.ts`, which covers `email` / `filename` / `external_notes` and
 * friends. The residual hole is a **hand-tagged field whose name is
 * deliberately NOT in that dictionary** — `subject`, `reference`, `description`
 * and `label` are listed there as explicit exclusions, and `Invoice.subject`
 * carries `pii: "mask"` today. `label` and `column` have no dictionary at all.
 *
 * ## Why a helper rather than a hand-written pair table
 *
 * A table of `[base, derived]` pairs kept beside the source scan can be
 * satisfied with a **duplicate entry**: bump the count, repeat a pair you
 * already listed, and the new call site is never diffed. Capturing the pair by
 * the act of writing the code cannot be satisfied that way.
 *
 * This module is deliberately **not** on `deno.json`'s `exports` and **not**
 * re-exported from `mod.ts` — it is internal, so it never reaches the published
 * API surface (`API.json` is keyed by entrypoint).
 *
 * @see `tests/meta-preservation.test.ts` — the arms that read {@link EXTENSION_SITES}
 * @see `src/schemas/card.ts` — the docstring that used to assert this by hand
 */
import type { z } from "zod";

/** One `.extend()` call site, captured at construction. */
export interface ExtensionSite {
  /** The object `.extend()` was called on. */
  readonly base: z.ZodObject;
  /** The object it produced. */
  readonly derived: z.ZodObject;
  /** The keys the extension re-declared or added — the ones that lose meta. */
  readonly keys: readonly string[];
}

const sites: ExtensionSite[] = [];

/**
 * Every `.extend()` site in the package, in module-evaluation order.
 *
 * ⚠️ **Only populated for modules that have been IMPORTED.** A reader must
 * import `./mod.ts` first, and must assert the length against the source-scanned
 * call-site count — an empty registry is otherwise a silently vacuous pass.
 * `tests/meta-preservation.test.ts` does both.
 */
export const EXTENSION_SITES: readonly ExtensionSite[] = sites;

/**
 * `base.extend(shape)`, recording the pair so the annotation diff in
 * `tests/meta-preservation.test.ts` can see it.
 *
 * Behaviourally identical to `.extend()` — it does **not** copy the base's
 * `.meta()` forward. That is deliberate: inheriting silently would make the
 * variant's real annotation set invisible at the call site, and the fix for a
 * dropped tag is to **restate it**, which a reader can then see (as
 * `product.ts`'s `AuthoredComponentSchema` does).
 */
export function extendChecked<
  Shape extends z.core.$ZodLooseShape,
  Ext extends z.core.$ZodLooseShape,
>(
  base: z.ZodObject<Shape>,
  shape: Ext,
): z.ZodObject<z.core.util.Extend<Shape, Ext>> {
  const derived = base.extend(shape);
  sites.push({
    base: base as unknown as z.ZodObject,
    derived: derived as unknown as z.ZodObject,
    keys: Object.keys(shape),
  });
  return derived;
}
