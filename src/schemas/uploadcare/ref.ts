/**
 * `uploadcareRef()` — the self-declaring annotation for a field that holds an
 * Uploadcare CDN file id.
 *
 * Deliberately a **wrapper, not a branded type**: the nine ref sites disagree on
 * validation on purpose (`card.ts` is `z.uuid()`; `order-document.ts` is a plain
 * `z.string().min(1)` so a non-UUID CDN id can never block a regen write). The
 * wrapper preserves each site's own validation and centralises the meta key, so
 * there is one declaration instead of nine hand-written `.meta()` calls.
 *
 * **This is an authoring lint, not the safety net.** The orphan sweep protects
 * files by harvesting every RFC-4122-shaped string value out of every document
 * (`api-cloudrun/src/services/uploadcareReferenceMap.ts`), which is schema-independent
 * and therefore cannot drift. What this annotation buys is a compile-/test-time
 * nudge — `core/tests/uploadcareRef.test.ts` fails when a field that *looks* like
 * a CDN ref isn't declared as one, and `uploadcareRefPaths()` gives the sweep's
 * canary the per-collection attribution it needs. A stale annotation is an
 * ergonomics bug, not a data-loss bug.
 *
 * Leaf module by design — imports nothing but `zod`, so the document schemas can
 * import it without a cycle through the `mod.ts` barrel.
 */
import type { z } from "zod";

/** The `.meta()` key `uploadcareRef()` sets. Read by the walker + the lint. */
export const UPLOADCARE_REF_META = "uploadcareRef";

/**
 * Mark a schema node as holding an Uploadcare CDN file id.
 *
 * Wrap the **leaf**, not its container: `z.array(uploadcareRef(z.string()))`,
 * never `uploadcareRef(z.array(z.string()))`. `collectLeafPaths` merges meta
 * down a node's own wrapper chain (`.optional()`, `.nullable()`, …) but not
 * across a container boundary, so an annotation on the array node would be
 * invisible to `uploadcareRefPaths()`. The lint catches that: the element leaf
 * stays an unwrapped candidate and assertion 1 fails.
 */
export const uploadcareRef = <T extends z.ZodType>(schema: T): T =>
  schema.meta({ [UPLOADCARE_REF_META]: true }) as T;
