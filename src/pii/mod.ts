/**
 * PII handling primitives — shared across the structured logger
 * (api-cloudrun) and the upcoming templates golden-diff fixture sanitizer.
 *
 * **Browser-safe surface.** This module deliberately does NOT export the
 * Node-only HMAC hash; consume `@cfs/schemas/pii/hash-node` separately on
 * the server when you need it. Manager (browser) pre-scrub can import
 * from here freely.
 *
 * What's here:
 *
 * - {@link PiiClassification} — the vocabulary (`"none" | "mask" | "hash" | "redact"`)
 * - {@link mask} / {@link redact} — pure browser-safe leaf transforms
 * - {@link applyPii} + {@link PiiStrategy} + {@link createLoggerStrategy} —
 *   schema-driven walker on top of `zod-walk`
 * - {@link RUNTIME_DENYLIST} — curated runtime key-name scrub set (NOT the
 *   same as the schema-enforcement dictionary; see `./runtime-denylist.ts`
 *   for why)
 * - {@link SAFE_PASSTHROUGH} — keys the runtime scrubber must never touch
 * - {@link SENSITIVE_EXACT} / {@link SENSITIVE_NAME_FIELD} — the
 *   schema-enforcement dictionary, imported by `tests/pii.test.ts`
 */

export type { PiiClassification } from "./classification.ts";
export { mask, redact } from "./transforms.ts";
export { applyPii, createLoggerStrategy, type PiiStrategy } from "./walker.ts";
export { RUNTIME_DENYLIST } from "./runtime-denylist.ts";
export { SAFE_PASSTHROUGH } from "./safe-passthrough.ts";
export { SENSITIVE_EXACT, SENSITIVE_NAME_FIELD } from "./dictionary.ts";
