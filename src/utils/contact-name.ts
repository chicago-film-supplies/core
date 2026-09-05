/**
 * Contact name helpers — the split rule and its inverse, in one module.
 *
 * ```ts
 * import { deriveName, splitFullName } from "@cfs/core/utils/contact-name";
 *
 * deriveName({ first_name: "Alex", last_name: "Hughes" }); // "Alex Hughes"
 * deriveName({ first_name: "Alex", pronunciation: "al-ix" }); // "Alex (al-ix)"
 *
 * splitFullName("Jane Smith"); // { first_name: "Jane", last_name: "Smith" }
 * ```
 *
 * `deriveName` is re-exported from `@cfs/core/schemas`, where it lives beside
 * the name-part field definitions it joins. `splitFullName` is implemented
 * here: it parses free text, which is not a schema concern.
 *
 * Stored documents (Contact, User, Invite, embedded contact refs) carry a
 * denormalized `name` field populated by the server via `deriveName`. Use
 * `entity.name` directly when the doc has been read back; only call
 * `deriveName` for in-flight objects whose `name` hasn't been server-derived
 * yet (e.g. manager-side optimistic state before the API responds).
 *
 * @module
 */

export { deriveName } from "../schemas/mod.ts";

/**
 * The parts {@link splitFullName} recovers from a free-text name.
 *
 * `pronunciation` is deliberately absent: it is never recoverable from a
 * display string, so a caller seeding a create input leaves it unset (or
 * `null`, which is what {@link https://jsr.io/@cfs/core | NamePartsFieldsInput}
 * stores).
 */
export interface SplitName {
  first_name: string;
  middle_name?: string;
  last_name?: string;
}

/**
 * Parse a free-text "full name" into `first_name` / `middle_name` /
 * `last_name`.
 *
 * The canonical arity rule — this function is the ONE author of it, and its
 * inverse is `deriveName`:
 *
 * | tokens | result |
 * |---|---|
 * | 0 (empty / whitespace / nullish) | `{ first_name: "" }` |
 * | 1 | `{ first_name }` |
 * | 2 | `{ first_name, last_name }` |
 * | 3 | `{ first_name, middle_name, last_name }` |
 * | 4+ | `{ first_name: <the whole trimmed string> }` |
 *
 * ⚠️ **4+ is deliberately NOT a round-trip.** A two-word surname ("Ana Maria
 * de la Cruz") is likelier than a three-name-plus-suffix parse, so the whole
 * string goes to `first_name` and the operator corrects it in the split-name
 * editor. `deriveName(splitFullName(s)) === s` holds for the 1-, 2- and
 * 3-token cases and is asserted NOT to hold here — see
 * `tests/contact-name.test.ts`, which exists to stop someone "repairing" this
 * branch into a guess.
 *
 * ⚠️ **Empty input returns `{ first_name: "" }`, which no create input
 * accepts** — `NamePartsFieldsInput.first_name` is `min(1)`. That is
 * deliberate: the caller's schema should reject an empty name rather than have
 * this function invent a placeholder. (The api-cloudrun copy this was promoted
 * from returned `{ first_name: "-" }`, a CRMS-webhook artefact — that webhook
 * had to mint a contact from whatever it was sent, and it is being deleted
 * with api-cloudrun#556.)
 */
export function splitFullName(name: string | null | undefined): SplitName {
  const trimmed = (name ?? "").trim();
  if (trimmed === "") return { first_name: "" };
  const tokens = trimmed.split(/\s+/);
  if (tokens.length === 1) return { first_name: tokens[0] };
  if (tokens.length === 2) return { first_name: tokens[0], last_name: tokens[1] };
  if (tokens.length === 3) {
    return { first_name: tokens[0], middle_name: tokens[1], last_name: tokens[2] };
  }
  return { first_name: trimmed };
}
