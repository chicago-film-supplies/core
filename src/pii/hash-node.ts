/**
 * Deterministic HMAC-SHA256 pseudonymization. **Server-only** — imports
 * `node:crypto`, which Vite cannot resolve for browser bundles. Kept in a
 * separate module so the browser-safe `./mod.ts` surface (consumed by
 * manager for client-log pre-scrub) does not transitively pull this in.
 *
 * Sync by design: invoked from the structured logger's `emit()` which must
 * stay synchronous to avoid rippling through hundreds of `log.*` call sites
 * in api-cloudrun. The Web Crypto `subtle.sign` API is async-only and
 * therefore unusable here.
 *
 * **NOT anonymization under GDPR** (Recital 26 + Art 4(5)) — the controller
 * retains the key, so re-identification is reasonably possible. This is
 * pseudonymization: it constrains the blast radius of a log leak and
 * preserves cross-record correlation without exposing raw values.
 *
 * Rotation policy: a stable per-environment key is fine. Rotation breaks
 * historical correlation by design — only do it as a deliberate
 * break-glass response to suspected key compromise.
 */

import { createHmac } from "node:crypto";

/**
 * Compute `HMAC-SHA256(value, key)` and return the first 16 hex chars of
 * the digest — collision-resistant enough for log correlation, short enough
 * to keep records compact.
 *
 * Callers should stringify non-string values before invoking. An empty
 * string is hashed normally (no special case), so two empty values
 * correlate; ensure the caller has skipped null/undefined.
 *
 * @param value Raw string to pseudonymize.
 * @param key   HMAC secret. Must be stable across instances for correlation.
 */
export function nodeHash(value: string, key: string): string {
  return createHmac("sha256", key).update(value).digest("hex").slice(0, 16);
}
