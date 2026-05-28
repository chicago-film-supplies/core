/**
 * PII classification vocabulary.
 *
 * Applied via `.meta({ pii: "..." })` on any Zod field; the schema-driven
 * walker in `./walker.ts` reads these tags and dispatches to the matching
 * leaf transform.
 *
 * - `"none"`   — safe field, no processing
 * - `"mask"`   — partial reveal (`alice@x.com` → `a****@x.com`, last-4 for opaque strings)
 * - `"hash"`   — deterministic HMAC-SHA256 prefix (server-side only; needs a key)
 * - `"redact"` — full removal → `"[REDACTED]"`
 */
export type PiiClassification = "none" | "mask" | "hash" | "redact";
