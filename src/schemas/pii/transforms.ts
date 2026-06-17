/**
 * Pure leaf transforms for the PII classifications `"mask"` and `"redact"`.
 *
 * **Synchronous and browser-safe by design** — these can be invoked from
 * manager (browser) for pre-scrub of client logs without dragging in any
 * Node-only API. The `hash` transform (deterministic HMAC-SHA256) lives in
 * a separate `./hash-node.ts` module because it requires `node:crypto`
 * which Vite cannot bundle for the browser.
 *
 * The structured logger composes these via `createLoggerStrategy` in
 * `./walker.ts`, which accepts the hash function as an optional parameter
 * — when absent (browser, or server with no `LOG_HMAC_KEY`), `hash`-tagged
 * fields fail-closed to `redact()`.
 *
 * No env reads, no I/O — pure given inputs.
 */

const REDACTED = "[REDACTED]";

/**
 * Partial-reveal mask. Shape-preserving so masked values stay debuggable
 * (you can tell two masked emails differ) without exposing PII.
 *
 * - **Emails** (contain a single `@` mid-string): keep first char of local
 *   part, mask the rest, keep the full domain.
 *   `alice@example.com` → `a****@example.com`
 * - **Other strings** of length ≥ 4: keep first and last char, mask between.
 *   `abcdefg` → `a*****g`
 * - **Short strings** (length < 4): fully redact — masking would leak too
 *   much of a 2–3 char value.
 *   `ab` → `[REDACTED]`
 */
export function mask(value: string): string {
  const atIdx = value.indexOf("@");
  if (atIdx > 0 && atIdx < value.length - 1 && value.indexOf("@", atIdx + 1) === -1) {
    const local = value.slice(0, atIdx);
    const domain = value.slice(atIdx);
    return local[0] + "*".repeat(Math.max(local.length - 1, 1)) + domain;
  }
  if (value.length < 4) return REDACTED;
  return value[0] + "*".repeat(value.length - 2) + value[value.length - 1];
}

/** Full redaction. Returns the literal string `[REDACTED]`. */
export function redact(): string {
  return REDACTED;
}
