/**
 * Name dictionary for the Uploadcare authoring lint.
 *
 * Mirrors `pii/dictionary.ts` in spirit: a deliberately narrow heuristic whose
 * only job is to flag a string field that *looks* like it holds a CDN file id
 * but isn't declared with `uploadcareRef()`. It is **not** the safety net — the
 * sweep's value harvest is (see `ref.ts`) — so it is tuned to be quiet and
 * exact rather than exhaustive. Over-matching here costs a developer an
 * exemption entry; under-matching costs nothing at all, because the harvest
 * protects the file either way.
 *
 * Against core today it yields exactly 13 candidates: the 9 refs plus the 4
 * exemptions below, and zero Xero false positives.
 */
import type { LeafPath } from "../zod-walk.ts";

/**
 * Field/parent names that conventionally *contain* CDN files.
 *
 * **Do not widen this list.** Adding `icons?|logos?|…` makes `lists::icon`
 * (`list.ts`, a UI icon/colour pair) a candidate with no exemption, and the
 * lint fails on day one for a field that has nothing to do with the CDN. The
 * residual — a CDN field named `logo` or `signature` — is deliberately left to
 * the harvest, which does not care what a field is called.
 */
export const MEDIA_CONTAINER_RE =
  /^(attachments?|images?|files?|photos?|media|thumbnails?|documents?|pdfs?|assets?|uploads?)$/i;

/**
 * Strip `collectLeafPaths`' container markers — and the `query_by_` denorm
 * prefix — from one path segment, so an anchored name match can see the bare
 * noun.
 *
 * Load-bearing: the raw leaf segment of `products::images[].uuid` is the
 * literal `images[]`, which `/^images?$/i` does not match. Without the strip,
 * neither it nor `cards::attachments[].uid` is a candidate and the lint
 * silently passes on the two fields it most needs to see.
 *
 * `query_by_` gets the same treatment because a `query_by_X` field is by
 * convention a flat mirror of `X` and holds exactly the same values — so
 * `products::query_by_images[]` must be as visible to the dictionary as
 * `images[]` is, or assertion 3 fails the moment the mirror is annotated. This
 * is not a widening of `MEDIA_CONTAINER_RE`: it only maps `query_by_*` onto the
 * noun list that already exists. Of the 15 `query_by_*` fields in core today,
 * none of the other 14 strips to a media noun, so none becomes a candidate.
 */
function bareSegment(segment: string): string {
  return segment
    .replace(/\[\]$/, "")
    .replace(/^<key>$/, "")
    .replace(/^query_by_/, "");
}

/**
 * True when a leaf looks like it holds an Uploadcare CDN file id.
 *
 * The `type === "string"` gate is REQUIRED, not cosmetic: without it the
 * predicate also matches `attachments[].{type,size_bytes,locked}` and yields 19
 * candidates instead of 13.
 *
 * A `format === "uuid"` heuristic is unusable as an arm here — dozens of leaves
 * carry it, because `ItemUid` is a union containing `z.uuid()` and spreads
 * through orders / invoices / fulfillments / tags / stores, and every `xero_id`
 * is a `z.uuid()` too.
 */
export function isUploadcareCandidate(leaf: LeafPath): boolean {
  if (leaf.type !== "string") return false;

  const segments = leaf.path.split(".");
  if (segments.some((s) => /uuid/i.test(s))) return true;

  const leafSegment = bareSegment(segments[segments.length - 1] ?? "");
  const parentSegment = bareSegment(segments[segments.length - 2] ?? "");
  return MEDIA_CONTAINER_RE.test(leafSegment) ||
    MEDIA_CONTAINER_RE.test(parentSegment);
}

/**
 * Candidate leaves that are NOT CDN file ids. Keyed `<collection>::<leaf path>`.
 *
 * A stale entry here is an ergonomics bug, never a data-loss bug — the harvest
 * protects files regardless of what this map says. `uploadcareRef.test.ts`
 * asserts in both directions, so an exemption for a field that no longer exists
 * fails the build.
 */
export const UPLOADCARE_CANDIDATE_EXEMPTIONS: ReadonlyMap<string, string> = new Map([
  // `images` is the one field name in the repo where the PARENT segment makes
  // every string leaf under it a candidate. `alt` is the only such leaf that
  // isn't a CDN id; `width`/`height` are exempt automatically via the
  // `type === "string"` gate. Any future string field under `images[]` pays the
  // same one-line price.
  ["products::images[].alt", "operator-authored alt text, not a CDN file id"],
  ["cards::attachments[].filename", "attachment display name, not a CDN id"],
  ["cards::attachments[].mime_type", "attachment MIME type, not a CDN id"],
  [
    "recurrences::prototype.attachments[].filename",
    "same CardAttachment node as cards",
  ],
  [
    "recurrences::prototype.attachments[].mime_type",
    "same CardAttachment node as cards",
  ],
]);
