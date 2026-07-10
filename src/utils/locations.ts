/**
 * Location helpers — pure, dependency-free canonicalization shared by every
 * service that enforces "one active location name per store".
 *
 * @module
 */

/**
 * Canonical uniqueness key for a location name, scoped within its store.
 *
 * Location names are unique per active store, but operators type the same bin
 * many ways — "Shelf A", "shelf-a", "SHELF / A", "Shelf_A" all name the same
 * shelf. This folds those to one comparable key so the uniqueness checks on the
 * CRUD path (`createLocation` / `updateLocation`) and the inventory-transaction
 * path (`stageLocationUpdates`) agree. Two paths normalizing differently is the
 * exact bug this exists to prevent, so it MUST be the only normalizer any writer
 * or uniqueness query uses.
 *
 * The transform, in order:
 *  - NFKD-decompose and strip combining marks so diacritics fold ("Café" →
 *    "cafe").
 *  - collapse every run of non-alphanumerics — space, hyphen, slash, underscore,
 *    punctuation — to a single space (Unicode letters/numbers of any script are
 *    kept), then trim.
 *  - lowercase.
 *
 * Separators are interchangeable and insignificant, but a *missing* separator
 * stays significant: "Shelf A" and "Shelf-A" collide; "Shelfa" does not. The
 * stored value stays human-readable ("shelf a") so it reads cleanly in the
 * Firestore console and in "name already exists" error messages.
 *
 * Persisted on `Location.name_key`.
 */
export function normalizeLocationName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .toLowerCase();
}
