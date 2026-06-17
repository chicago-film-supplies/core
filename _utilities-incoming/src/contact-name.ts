/**
 * Contact name helpers — re-exports the canonical `deriveName` from
 * `@cfs/schemas` so manager and other utilities consumers can import it
 * from a single, stable runtime location.
 *
 * ```ts
 * import { deriveName } from "@cfs/utilities/contact-name";
 *
 * deriveName({ first_name: "Alex", last_name: "Hughes" }); // "Alex Hughes"
 * deriveName({ first_name: "Alex", pronunciation: "al-ix" }); // "Alex (al-ix)"
 * ```
 *
 * Stored documents (Contact, User, Invite, embedded contact refs) carry a
 * denormalized `name` field populated by the server via this helper. Use
 * `entity.name` directly when the doc has been read back; only call
 * `deriveName` for in-flight objects whose `name` hasn't been server-derived
 * yet (e.g. manager-side optimistic state before the API responds).
 *
 * @module
 */

export { deriveName } from "@cfs/schemas";
