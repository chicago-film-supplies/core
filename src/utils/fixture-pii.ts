/**
 * Fixture PII — the routing table, the fake vocabularies, the fakes themselves,
 * and the ORACLE that decides whether a committed value came out of them.
 *
 * ## Why this is in `core` and not in the service that captures fixtures
 *
 * 🔴 **There are THREE write paths into a committed fixture and only two of them
 * pass through `api-cloudrun`.** `templates_set_fixture` and
 * `PUT /templates/{uid}/fixtures/{slug}` go through the service; a hand-authored
 * `git commit` into the `templates` repo reaches the file directly. A guard that
 * lives in the service cannot see the third, so it lives here, where
 * `templates/scripts/lint-fixtures.ts` reaches it in CI.
 *
 * ⭐ **One owner for the output shapes.** The oracle asks "could
 * {@link fakeForMask} have produced this value?", so it can only be right while
 * it and `fakeForMask` agree. Putting them in one module makes that agreement
 * structural rather than a thing to maintain — and retires
 * `templates/scripts/scan-fixture-history.ts`'s hand-copy of the same seven
 * shapes, which was a second implementation of one rule with no mechanism to
 * keep the copies together.
 *
 * ## What is NOT here, and why
 *
 * The salt, the HMAC and the `PiiStrategy` adapter stay in
 * `api-cloudrun/src/services/templates/fixturePiiStrategy.ts`. `FIXTURE_PII_SALT`
 * is a deployment secret, and a fixture's seeding must not become derivable from
 * a published package. So {@link fakeForMask} takes the seed it needs as an
 * argument, plus a {@link SeedFor} callback for the one case that has to seed a
 * second path ({@link fakeAddressFull}'s street segment) — the salt never
 * crosses into core, and core needs no crypto.
 *
 * ## The oracle is three-valued, and that is the whole design
 *
 * 🔴 **`masked` · `not-masked` · `unverifiable`.** After a fake is drawn from
 * its field's category, the categories split in two: some draw from a closed
 * vocabulary this repo owns, so "could the masker have produced this?" has an
 * answer; the shape-preserving ones (`postcode`, `opaque`) are
 * indistinguishable from a real value **by construction** — that is precisely
 * what api-cloudrun#627 asked for — so no oracle can settle them.
 *
 * ⭐ **The split falls the right way, and that is the argument for building this
 * at all: every IDENTIFYING category is decidable.** A name, a street line, a
 * venue, an organization, an email and a phone all come from a vocabulary
 * enumerated below. What cannot be decided is a postcode and a Mapbox id.
 *
 * ⚠️ **So a caller must report the `unverifiable` count, never just "no
 * findings".** A clean run over a document whose only masked leaves were
 * postcodes has checked nothing, and reads identically to one that checked 40
 * leaves. Same rule as `lintFixtureAtBranch`'s `{ran: false}` arm: *could not
 * run* is never *passed*.
 *
 * ## The vocabularies are a PUBLIC contract now
 *
 * ⚠️ **Editing an entry invalidates every fixture masked under the old one.** A
 * value drawn from the previous list reads `not-masked` to the oracle, so a
 * vocabulary edit is a corpus-wide re-capture, not a cosmetic change. Add
 * entries freely; change and remove them only with the re-capture in the same
 * PR.
 *
 * @module
 */

import type { z } from "zod";
import type { PiiClassification } from "../schemas/pii/classification.ts";
import { applyPii } from "../schemas/pii/walker.ts";

// ── The category vocabulary ─────────────────────────────────────────

/**
 * What a masked value is faked AS.
 *
 * `text` is the fallback and the only member that claims nothing — it renders
 * the self-announcing filler. Every other member asserts a category, so routing
 * a field to one is a claim about that field that must be true.
 */
export type MaskCategory =
  | "email"
  | "phone"
  | "postcode"
  | "street"
  | "street2"
  | "address_full"
  | "person"
  | "given_name"
  | "family_name"
  | "place"
  | "organization"
  | "opaque"
  | "text";

/**
 * Leaf field names whose category is the same wherever they appear.
 *
 * ⚠️ **`name` and `full` are deliberately ABSENT** — both are ambiguous by leaf
 * alone and are routed by their parent in {@link QUALIFIED_CATEGORY}. An
 * unqualified one therefore falls to `text`, which is the safe direction:
 * `scope.name` on a pick sheet is a street address for `kind: "destination"`
 * and an organization for `kind: "organization"` (see `PickSheetScopeSchema`),
 * so no single category is true of it and the filler is the honest answer.
 */
const LEAF_CATEGORY: Readonly<Record<string, MaskCategory>> = {
  email: "email",
  emails: "email",
  phone: "phone",
  phones: "phone",
  postcode: "postcode",
  street: "street",
  street2: "street2",
  mapbox_id: "opaque",
  first_name: "given_name",
  middle_name: "given_name",
  last_name: "family_name",
};

/**
 * `<parent>.<leaf>` for the two leaves whose category depends on where they sit.
 *
 * Every entry was measured, not guessed: `collectLeafPaths(schema, {inherit:
 * ["pii"]})` over all eight `TEMPLATE_COLLECTION_SCHEMAS` returns 35 distinct
 * `(parent, leaf)` pairs for `pii: "mask"` STRING leaves, and these are the
 * ones whose leaf is `name` or `full`.
 *
 * ⚠️ **Re-measure rather than incrementing these numbers.** They were "six" and
 * "32" until `statements` landed; a count in prose has no guard, and the census
 * that DOES fail lives in the other repo
 * (`api-cloudrun/tests/unit/fixturePiiStrategy.test.ts`), so `core`'s own suite
 * stays green while this sentence goes stale.
 *
 * ⭐ **`aging-reports` moved the SCHEMA count and not the PAIR count, and that is
 * the useful half of the re-measurement.** Its three masked string leaves are
 * `scope.name`, `rows[].organization_path[].name` and
 * `organizations[].organization_path[].name` — every one of them reusing a
 * `(parent, leaf)` pair `statements` had already introduced, so the map below
 * needed no entry and `templates`' `capture-floor.json` `min_core` needed no
 * bump. **A new source is not automatically a new mask**, and checking which of
 * the two a change is costs one walk.
 */
const QUALIFIED_CATEGORY: Readonly<Record<string, MaskCategory>> = {
  // A real person.
  "contact.name": "person",
  "created_by.name": "person",
  "updated_by.name": "person",
  // A customer organization, or a node of its ancestor tree.
  "organization.name": "organization",
  "organizations.name": "organization",
  "path.name": "organization",
  // ⭐ The SAME fact as `path.name`, under a different parent, because an
  // `OrgStatement` has no `organization` wrapper to nest the chain under — the
  // document's subject IS the customer, so `organization_path[]` sits at the
  // root (`schemas/reporting.ts`). The category is identical; only the qualifier
  // differs, which is exactly what this table is for.
  "organization_path.name": "organization",
  // A facility / venue / section label. `address.name` is the place the address
  // belongs to ("Cinespace Chicago — Stage 14"); `items.name` and `item.name`
  // are the DESTINATION divider arm, which core `652b1ba` re-tagged to `mask`
  // after finding customer data in 3 of 9 committed values (templates#203);
  // `destinations.name` is the pick sheet's copy of that same arm.
  "address.name": "place",
  "billing_address.name": "place",
  "items.name": "place",
  "item.name": "place",
  "destinations.name": "place",
  // The whole-address column.
  "address.full": "address_full",
  "billing_address.full": "address_full",
};

/**
 * Field path → segments, with array markers and indices dropped.
 *
 * The runtime walker reports an array's elements at the array's OWN path (see
 * `pii/walker.ts` — a reordered array must not reseed every element), so
 * `phones[]` arrives as `…contact.phones`. Tests and callers that write an
 * index anyway (`contact.phones.0`, `destinations[0].delivery.instructions`)
 * are normalized to the same thing, and so is `collectLeafPaths`'s static
 * `destinations[].delivery.address.postcode` — which is what lets a census
 * compare a static schema walk and a runtime walk directly.
 */
export function normalizeFieldPath(fieldPath: string): string[] {
  return fieldPath
    .split(".")
    .map((segment) => segment.replace(/\[[^\]]*\]$/, "").trim())
    .filter((segment) => segment !== "" && !/^\d+$/.test(segment));
}

/**
 * The category to fake a `mask`-tagged value as, from its field path alone.
 *
 * 🔴 **The value is never consulted.** That is the whole of api-cloudrun#837:
 * the pii walker routes by schema tag and this strategy used to route by
 * punctuation and token count, so `6 Walkies` in a `subject` masked to
 * `5365 Aspen Dr`. A field knows what it is; the string in it does not.
 *
 * Unrouted → `text`. Being incomplete is safe by construction here — the filler
 * announces itself as a placeholder, so a field nobody has classified reads as
 * obviously fake rather than as a confidently wrong address.
 */
export function categoryForField(fieldPath: string): MaskCategory {
  const segments = normalizeFieldPath(fieldPath);
  const leaf = segments.at(-1) ?? "";
  const parent = segments.at(-2) ?? "";
  return QUALIFIED_CATEGORY[`${parent}.${leaf}`] ?? LEAF_CATEGORY[leaf] ?? "text";
}

// ── The fake vocabularies ───────────────────────────────────────────

/** @see {@link MaskCategory} `given_name`, and the first token of `person`. */
export const FAKE_FIRST_NAMES: readonly string[] = [
  "Jordan", "Riley", "Casey", "Morgan", "Avery", "Quinn", "Reese", "Sage",
  "Rowan", "Drew", "Skyler", "Charlie", "Parker", "Hayden", "Logan", "Taylor",
];
/** @see {@link MaskCategory} `family_name`, and the last token of `person`. */
export const FAKE_LAST_NAMES: readonly string[] = [
  "Adler", "Bishop", "Carmichael", "Doyle", "Ellsworth", "Fairfax", "Glenn",
  "Holloway", "Ingram", "Jensen", "Knox", "Larkin", "Maddox", "Norris", "Owen",
  "Pierce",
];
/** The tail of a faked street line; the number in front is seeded. */
export const FAKE_STREETS: readonly string[] = [
  "Maple Ave", "Elm Ln", "Cedar Rd", "Oak St", "Birch Way", "Pine Ct",
  "Walnut Blvd", "Aspen Dr", "Sycamore Pl", "Cypress Ter", "Chestnut St",
  "Spruce Ln", "Magnolia Rd", "Willow Way", "Juniper Ct", "Linden Ave",
];
/**
 * Venue / facility labels — what `address.name` and the destination divider
 * hold, and what they were being masked into a person's name from.
 *
 * 🔴 **Every entry is THREE tokens or more, and that is load-bearing, not
 * style.** A two-word compound (`Northgate Hall`) is shaped exactly like
 * `First Last`, so a golden reviewer looking at a section heading cannot tell a
 * masked venue from a masked person — which is the confusion this whole change
 * removes. A three-token label matches neither person form (`First Last`,
 * `First M Last`). The suite asserts it rather than trusting the list.
 */
export const FAKE_PLACES: readonly string[] = [
  "Riverside Event Pavilion", "Harbor Point Depot", "Lakeside Annex Building",
  "Northgate Community Hall", "Eastbank Sound Studio", "Westline Production Stage",
  "Grandview Terrace Center", "Summit Field House", "Cedar Point Lodge",
  "Old Mill Armory", "Brookfield Commons Lot", "Sunset Park Arena",
  "Ironworks Loft Space", "Prairie Exhibition Hall", "Bayview Convention Center",
  "Highland Rail Depot",
];
/** Production-company-shaped names — an organization is a business, not a
 *  person. Same three-token floor, for the same reason. */
export const FAKE_ORGANIZATIONS: readonly string[] = [
  "Redbird Productions LLC", "Silverline Media Group", "Northgate Pictures LLC",
  "Harborlight Studios Inc", "Blue Chair Films LLC", "Ninth Street Media Group",
  "Wayfarer Productions LLC", "Sixpoint Pictures Inc", "Copperline Studios LLC",
  "Brightwater Films Inc", "Kestrel Media Group", "Longview Productions LLC",
  "Two Rivers Pictures", "Amberline Studios Inc", "Foxglove Films LLC",
  "Meridian Media Group",
];
/** Secondary address lines — "Suite 1900", "2nd Floor", "Stage 25" in prod. */
export const FAKE_UNIT_PREFIXES: readonly string[] = [
  "Suite", "Unit", "Floor", "Studio", "Bldg", "Rm", "Dock", "Stage",
];

/**
 * The domain a masked email is minted at.
 *
 * OUR OWN domain, not `@example.com`. The RFC-reserved documentation domain is
 * the standards-correct choice and `template-lint`'s check 2 rejects it,
 * correctly: an address at our own domain cannot be a customer's, so allowing
 * only that one keeps "every foreign domain is PII" true with no exceptions.
 */
export const MASKED_EMAIL_DOMAIN = "chicagofilmsupplies.com";

function pick<T>(items: readonly T[], seed: string, offset = 0): T {
  const n = parseInt(seed.slice(offset, offset + 8), 16);
  return items[n % items.length];
}

// ── Shape-preserving primitives ─────────────────────────────────────

const DIGITS = "0123456789";
const LOWER = "abcdefghijklmnopqrstuvwxyz";
const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** A seeded byte for position `i`. Deterministic, and defined past the seed's
 *  own length so a long value (a 60-char `mapbox_id`) still gets one per char. */
function seedByte(seed: string, i: number): number {
  const j = (i * 2) % (seed.length - 1);
  return (parseInt(seed.slice(j, j + 2), 16) + i * 31) % 256;
}

/**
 * Every alphanumeric character replaced by a seeded one of the SAME class,
 * separators left exactly where they are.
 *
 * 🔴 **This is api-cloudrun#627's fix and it is deliberately not a country
 * table.** The old postcode branch was guarded on `/^\d{5}(-\d{4})?$/`, so a
 * Canadian `M5V 3A8` matched nothing above or below it and fell through to the
 * generic filler — `Sample t` in the bill-to block of the one fixture whose
 * entire purpose is the foreign-address case. One shape rule covers CA
 * `A1A 1A1`, UK `SW1A 1AA`, NZ/AU `1010` and US ZIP+4 at once, and enumerating
 * countries would have to be maintained against the next one.
 *
 * ⚠️ **It is also why `postcode` and `opaque` are UNVERIFIABLE** — the output
 * is drawn from the same alphabet as the input, so nothing distinguishes a
 * masked value from a real one. See the module header.
 */
function shapePreserving(value: string, seed: string): string {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    const b = seedByte(seed, i);
    if (ch >= "0" && ch <= "9") out += DIGITS[b % 10];
    else if (ch >= "a" && ch <= "z") out += LOWER[b % 26];
    else if (ch >= "A" && ch <= "Z") out += UPPER[b % 26];
    else out += ch;
  }
  return out;
}

/**
 * Advance the last alphanumeric character one step within its own class.
 *
 * Reached only when a seeded fake collides with its own source — 1 in 10^4 for
 * the shortest real postcode, and it must not be the one case where the mask
 * returns the original. A value with no alphanumerics at all had nothing to
 * leak in the first place.
 */
function bumpLastAlnum(value: string): string {
  for (let i = value.length - 1; i >= 0; i--) {
    const ch = value[i];
    let next: string | undefined;
    if (ch >= "0" && ch <= "9") next = DIGITS[(DIGITS.indexOf(ch) + 1) % 10];
    else if (ch >= "a" && ch <= "z") next = LOWER[(LOWER.indexOf(ch) + 1) % 26];
    else if (ch >= "A" && ch <= "Z") next = UPPER[(UPPER.indexOf(ch) + 1) % 26];
    if (next !== undefined) return value.slice(0, i) + next + value.slice(i + 1);
  }
  return value;
}

/** {@link shapePreserving}, guaranteed to differ from its input. */
function shapePreservingDistinct(value: string, seed: string): string {
  const out = shapePreserving(value, seed);
  return out === value ? bumpLastAlnum(out) : out;
}

/** Digit runs re-seeded, letters and punctuation left alone. Used inside
 *  `address.full`'s tail, where the words are the coarse geography `Address`
 *  already publishes (`city`, `region`, `country_name` are all `pii: "none"`)
 *  and the digits are the postcode. */
function maskDigits(value: string, seed: string, offset: number): string {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    out += ch >= "0" && ch <= "9" ? DIGITS[seedByte(seed, i + offset) % 10] : ch;
  }
  return out;
}

// ── The per-category fakes ──────────────────────────────────────────

function fakeStreet(seed: string): string {
  const number = (parseInt(seed.slice(0, 4), 16) % 9000) + 100;
  return `${number} ${pick(FAKE_STREETS, seed, 4)}`;
}

function fakeUnit(seed: string): string {
  return `${pick(FAKE_UNIT_PREFIXES, seed, 12)} ${(parseInt(seed.slice(8, 12), 16) % 900) + 100}`;
}

/** A postcode of the source's own shape.
 *
 * A numeric code keeps a leading `6` so a US ZIP still reads as Midwest beside
 * the `region` the walker publishes unmasked — 974 of 994 prod orders are US.
 * A letter-led code (CA, UK) has no such convention and is fully seeded. The
 * prefix is applied BEFORE the distinctness check, or a fake differing from its
 * source only in the first digit would be handed straight back. */
function fakePostcode(value: string, seed: string): string {
  const raw = shapePreserving(value, seed);
  const out = /^\d/.test(value) ? `6${raw.slice(1)}` : raw;
  return out === value ? bumpLastAlnum(out) : out;
}

/** A person, with the source's token count preserved so a rendered column keeps
 *  its width — one token stays one, `First M Last` stays three. */
function fakePerson(value: string, seed: string): string {
  const first = pick(FAKE_FIRST_NAMES, seed);
  const last = pick(FAKE_LAST_NAMES, seed, 4);
  const tokens = value.trim().split(/\s+/).length;
  if (tokens <= 1) return first;
  if (tokens === 2) return `${first} ${last}`;
  return `${first} ${UPPER[parseInt(seed.slice(8, 10), 16) % 26]} ${last}`;
}

/** A segment of `address.full` that is coarse geography: letters and the
 *  punctuation a place name carries (`St. Louis`, `O'Hare`, `Winston-Salem`). */
const COARSE_SEGMENT = /^[A-Za-z][A-Za-z .'\-]*$/;

/**
 * Seed a second field path — the one thing {@link fakeForMask} cannot do
 * itself, because the salt stays in the service.
 *
 * @see {@link fakeAddressFull}, its only caller.
 */
export type SeedFor = (fieldPath: string, value: string) => string;

/**
 * The whole-address column, masked segment by segment.
 *
 * Measured over 200 prod `destinations` (2026-09-06): `full` is
 * `<street line>, <City>, <STATE>[ <postcode>], United States`, sometimes with
 * a unit segment after the street (`2558 W 16th St, Stage 25, Chicago, …`) and
 * occasionally with no street number at all (`Various, …`, `PO Box 5713, …`,
 * `West 21st Street, …`).
 *
 * So: **segment 0 is the address line and is always replaced**, whatever shape
 * it has — it is the identifying part and a place name sitting there is as
 * identifying as a street number. Later segments keep their words and lose
 * their digits, because those words are `city` / `region` / `country_name`,
 * which the same `Address` object publishes unmasked by explicit `pii: "none"`,
 * and the digits are the postcode.
 *
 * ⚠️ **What it does NOT mask: an alphabetic unit segment** — `Center Building
 * Mezzanine` passes through as coarse. 5 of the 200 carried one. Beside a
 * replaced street and a replaced postcode it locates nothing, and the
 * alternative is inferring a category from the value, which is the defect this
 * file exists to have removed.
 *
 * The whole column used to collapse to a bare street: `full` came out as
 * `172 Magnolia Rd` while `city` beside it still read `Chicago`.
 */
function fakeAddressFull(
  value: string,
  fieldPath: string,
  seed: string,
  seedFor: SeedFor,
): string {
  const segments = value.split(",").map((segment) => segment.trim());
  return segments
    .map((segment, i) => {
      if (segment === "") return segment;
      if (i === 0) {
        // Seeded as if it were the sibling `street`, so a `full` that opens with
        // exactly that value masks to the SAME street and the rendered address
        // block stays internally consistent. Nothing depends on the two
        // agreeing — where the values differ, so do the fakes.
        const siblingPath = `${fieldPath.slice(0, -"full".length)}street`;
        return fakeStreet(seedFor(siblingPath, segment));
      }
      return COARSE_SEGMENT.test(segment) ? segment : maskDigits(segment, seed, i * 7);
    })
    .join(", ");
}

/** The four self-announcing placeholder markers, longest first — the shapes
 *  {@link fakeText} steps down through, and what the oracle recognises. */
function textMarkers(leaf: string): string[] {
  return [`Sample text for ${leaf}`, `Sample ${leaf}`, "Sample text", "Sample"];
}

/**
 * The self-announcing placeholder — the fake for a field with no category.
 *
 * Kept at roughly the source's length so the rendered fixture does not reflow
 * column widths against its golden, but **never truncated below something that
 * still reads as a placeholder**. The one-line version of this sliced the label
 * to fit and produced `Sample te` for a 9-character `subject` and
 * `Sample text for ` for a 16-character one — which is the same complaint as
 * api-cloudrun#837 arriving by a different route, since `subject` is exactly
 * the short free-text field that made this the fallback.
 */
function fakeText(value: string, fieldPath: string): string {
  const target = textTarget(value);
  const leaf = normalizeFieldPath(fieldPath).at(-1) ?? "field";
  for (const marker of textMarkers(leaf)) {
    if (marker.length <= target) return marker.padEnd(target, ".");
  }
  // Unreachable: `target` floors at 8 and "Sample" is 6.
  return "Sample".slice(0, target);
}

/** The padded length {@link fakeText} aims for. Shared with the oracle so the
 *  two cannot drift on the one number that decides a dot count. */
function textTarget(value: string): number {
  return Math.max(8, Math.min(value.length, 80));
}

/**
 * Mask transform — dispatched on the FIELD's category, never on the value.
 *
 * `seed` is the caller's HMAC of (salt, fieldPath, value) as lowercase hex;
 * `seedFor` computes the same for another path. Both stay outside core so the
 * salt does. @see the module header.
 */
export function fakeForMask(
  value: string,
  fieldPath: string,
  seed: string,
  seedFor: SeedFor,
): string {
  switch (categoryForField(fieldPath)) {
    // Email — keep the @domain shape so address-validation in the template
    // renderer (if any) still parses.
    //
    // No fake first name in front of it — `dana_1a2b@chicagofilmsupplies.com`
    // reads as a real colleague. `masked_` says what it is. The `_<4hex>` stays:
    // two different source contacts must remain distinguishable, and the digest
    // is what keeps a re-capture byte-stable so goldens do not churn.
    case "email":
      return `masked_${seed.slice(0, 4)}@${MASKED_EMAIL_DOMAIN}`;
    // Phone — the digit shape roughly preserved so column widths don't reflow,
    // inside 555-0100..555-0199, the block NANP reserves for fiction. Only the
    // area code and the last two digits carry the seed; the `555 01` in the
    // middle is fixed, which is what makes the result unmistakably not a real
    // line. Deliberately NOT CFS's own 3128183008 — the lint allows it, but
    // printing our switchboard as the customer's contact is a different kind of
    // wrong.
    case "phone": {
      const digits = seed.replace(/[a-f]/g, "").padEnd(5, "0");
      return `(${digits.slice(0, 3)}) 555-01${digits.slice(3, 5)}`;
    }
    case "postcode":
      return fakePostcode(value, seed);
    case "street":
      return fakeStreet(seed);
    case "street2":
      return fakeUnit(seed);
    case "address_full":
      return fakeAddressFull(value, fieldPath, seed, seedFor);
    case "person":
      return fakePerson(value, seed);
    case "given_name":
      return pick(FAKE_FIRST_NAMES, seed);
    case "family_name":
      return pick(FAKE_LAST_NAMES, seed, 4);
    case "place":
      return pick(FAKE_PLACES, seed);
    case "organization":
      return pick(FAKE_ORGANIZATIONS, seed);
    case "opaque":
      return shapePreservingDistinct(value, seed);
    case "text":
      return fakeText(value, fieldPath);
  }
}

// ── The oracle ──────────────────────────────────────────────────────

/**
 * Whether a committed value could have come out of {@link fakeForMask}.
 *
 * - `masked` — it is drawn from a vocabulary or shape only the masker produces.
 * - `not-masked` — the masker CANNOT produce this value, so it was never masked.
 * - `unverifiable` — the category's fake is shape-preserving, so a real value
 *   and a fake one are indistinguishable. **Count these; never report them as
 *   passes.**
 */
export type MaskVerdict = "masked" | "not-masked" | "unverifiable";

/** Escape a vocabulary entry for use inside a built regex. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const MASKED_EMAIL_RE = new RegExp(
  `^masked_[0-9a-f]{4}@${escapeRe(MASKED_EMAIL_DOMAIN)}$`,
);
/** `(NNN) 555-01NN` — the fiction block, exactly as `fakeForMask` mints it. */
const MASKED_PHONE_RE = /^\(\d{3}\) 555-01\d{2}$/;
/** `fakeStreet`'s number is `(seed % 9000) + 100`, so 100..9099. */
const MASKED_STREET_RE = new RegExp(
  `^\\d{3,4} (?:${FAKE_STREETS.map(escapeRe).join("|")})$`,
);
/** `fakeUnit`'s number is `(seed % 900) + 100`, so 100..999. */
const MASKED_UNIT_RE = new RegExp(
  `^(?:${FAKE_UNIT_PREFIXES.map(escapeRe).join("|")}) \\d{3}$`,
);

/** `fakePerson`'s three arms: one token, `First Last`, `First M Last`. */
function isMaskedPerson(value: string): boolean {
  const tokens = value.trim().split(/\s+/);
  const first = new Set(FAKE_FIRST_NAMES);
  const last = new Set(FAKE_LAST_NAMES);
  if (tokens.length === 1) return first.has(tokens[0]);
  if (tokens.length === 2) return first.has(tokens[0]) && last.has(tokens[1]);
  if (tokens.length === 3) {
    return first.has(tokens[0]) && /^[A-Z]$/.test(tokens[1]) && last.has(tokens[2]);
  }
  return false;
}

/**
 * The self-announcing filler, in any of the forms this repo has ever minted.
 *
 * 🔴 **Accepted for EVERY category, not just `text`, and that is deliberate.**
 * The oracle's question is "is this a leak?", and the filler provably is not
 * one — it claims nothing and no customer value looks like it. A filler sitting
 * in a field that today routes to `organization` means the value was masked by
 * an OLDER build whose router sent it elsewhere. That is a **staleness**
 * question, and staleness has an owner already: `templates/capture-floor.json` and
 * `captureFloorVerdict`. Reporting it here instead would bury ~120 real
 * re-capture candidates under a class that is not a leak — measured over the
 * committed corpus, 2026-09-06.
 *
 * ⚠️ **Truncated forms are accepted too.** Before api-cloudrun#837's fix the
 * filler was sliced to fit its source's length, so the corpus carries
 * `Sample text for instructi` and `Sample t`. Those are placeholders by anyone's
 * reading; refusing them would report a leak where there is none.
 *
 * 🔴 **The embedded leaf token is matched as a GRAMMAR, never against the
 * field's current name** — because core renames fields and the filler keeps the
 * name it was minted under. Measured: `invoice/billing-foreign-country` carries
 * `Sample text for ext` in a field now called `notes`; it is `external_notes`
 * truncated, from before the rename. Checking the live leaf name would report a
 * leak on the strength of a field having been renamed.
 */
function isFiller(value: string): boolean {
  const bare = value.replace(/\.+$/, "");
  if (bare === "") return false;
  // Any truncation of the longest marker's fixed part: "S" … "Sample text for ".
  if ("Sample text for ".startsWith(bare)) return true;
  // The fixed part in full, plus a leaf token — whole or truncated. The token
  // charset is what a schema field name can be, which is what excludes a real
  // value like `Sample Kit` (capitalised) or `Sample of the rig` (spaced).
  for (const prefix of ["Sample text for ", "Sample "]) {
    if (bare.startsWith(prefix) && /^[a-z0-9_]*$/.test(bare.slice(prefix.length))) return true;
  }
  return false;
}

/**
 * The verdict for one `pii: "mask"` string leaf.
 *
 * ⚠️ **`fieldPath` decides the category, exactly as it does for the mask
 * itself** — pass the leaf's real path, not a guess. A path this module does
 * not route falls to `text`, whose fake is the self-announcing filler, so an
 * unrouted field holding a real value reads `not-masked`, which is right.
 */
export function maskVerdict(value: string, fieldPath: string): MaskVerdict {
  // The strategy returns an empty or whitespace-only string unchanged — there
  // was nothing to leak, so there is nothing to have masked. 97.8% of real
  // order items carry an empty `description`.
  if (value.trim() === "") return "masked";

  // The filler is a valid mask for any category — see {@link isFiller}.
  if (isFiller(value)) return "masked";

  switch (categoryForField(fieldPath)) {
    case "email":
      return MASKED_EMAIL_RE.test(value) ? "masked" : "not-masked";
    case "phone":
      return MASKED_PHONE_RE.test(value) ? "masked" : "not-masked";
    case "street":
      return MASKED_STREET_RE.test(value) ? "masked" : "not-masked";
    case "person":
      return isMaskedPerson(value) ? "masked" : "not-masked";
    case "given_name":
      return FAKE_FIRST_NAMES.includes(value) ? "masked" : "not-masked";
    case "family_name":
      return FAKE_LAST_NAMES.includes(value) ? "masked" : "not-masked";
    case "place":
      return FAKE_PLACES.includes(value) ? "masked" : "not-masked";
    case "organization":
      return FAKE_ORGANIZATIONS.includes(value) ? "masked" : "not-masked";
    // Every `text` mask IS the filler, which the arm above already accepted —
    // so reaching here means the value is not one.
    case "text":
      return "not-masked";

    // `address.full` — segment 0 is the address line and is ALWAYS replaced by
    // a `fakeStreet`, so it decides. The coarse tail is deliberately out of
    // scope: those words are `city` / `region` / `country_name`, which the same
    // `Address` publishes unmasked under an explicit `pii: "none"`, and its
    // digits are shape-preserved. A real `2621 W 15th Pl, Chicago, …` fails at
    // segment 0, which is the case that matters.
    case "address_full": {
      const first = value.split(",")[0]?.trim() ?? "";
      return MASKED_STREET_RE.test(first) ? "masked" : "not-masked";
    }

    // 🔴 **The honest middle.** `fakeUnit` mints `<prefix> <3 digits>`, and
    // `Suite 210` is both a plausible fake and a plausible real secondary
    // address line — so a MATCH proves nothing and must not be reported as
    // `masked`. A NON-match still decides: every masked `street2` matches by
    // construction, so `2nd Floor` or `Center Building Mezzanine` was never
    // masked.
    case "street2":
      return MASKED_UNIT_RE.test(value) ? "unverifiable" : "not-masked";

    // Shape-preserving by design (api-cloudrun#627): the output is drawn from
    // the input's own alphabet, so no oracle can separate a masked value from a
    // real one. Report the count; never call it a pass.
    case "postcode":
    case "opaque":
      return "unverifiable";
  }
}

// ── The scope ───────────────────────────────────────────────────────

/** One `pii: "mask"` string leaf, as the real walker offered it. */
export interface MaskedLeaf {
  /** The walker's own path — `destinations.0.delivery.address.postcode`. */
  fieldPath: string;
  value: string;
}

/**
 * Every `pii: "mask"` STRING leaf in one document, discovered by running the
 * REAL walker over it.
 *
 * ⭐ **The scope comes from `applyPii` itself, not from a static walk of the
 * schema, and that is a correctness requirement rather than a convenience.**
 * The oracle asks "would the masker have masked this leaf, and if so did it?",
 * so its scope has to be exactly the masker's — and only the masker can compute
 * that, because it depends on the VALUE.
 *
 * 🔴 **The case that forces it is a discriminated union, and it is not
 * hypothetical — it was measured at 292 false findings.** `FulfillmentItemType`
 * is a union whose destination-divider arm tags `name` as `pii: "mask"`
 * (templates#203) while its product arm tags the same `name` as `pii: "none"`.
 * A static `collectLeafPaths` walk emits every member at the SAME path, so
 * `…items[].item.name` reads as masked and every PRODUCT name on a packing list
 * (`Driving Sign Kit`, `Metro Rack (18" x 36")`) gets scoped in and judged
 * against the venue vocabulary. `applyPii` resolves the union against the row
 * in hand (`resolveUnionMember`), so a divider is checked and a product is not.
 *
 * ⚠️ **A schema-INVALID document is walked incompletely** — the walker only
 * descends keys the resolved shape declares, and an unresolvable union member
 * stops the descent. That is not a reason to prefer the static walk (which is
 * wrong in a way no count reveals); it is a reason to REPORT how many leaves
 * were examined, so a fixture that also fails the schema check does not read as
 * a clean PII pass. The caller owns that report.
 *
 * ⚠️ Non-string tagged leaves are excluded deliberately: the capture strategy
 * fails closed on a tagged non-string scalar (it throws), so one can never reach
 * a committed fixture, and the oracle has no fake shape to compare against.
 *
 * The walk is read-only — the strategy returns every value unchanged, which is
 * also how `applyPii` is told to keep descending into a container.
 */
export function collectMaskedLeaves(
  doc: object,
  schema: z.ZodType,
): MaskedLeaf[] {
  const out: MaskedLeaf[] = [];
  applyPii(doc, schema as z.ZodType<object>, {
    apply(value: unknown, classification: PiiClassification, fieldPath: string): unknown {
      if (classification === "mask" && typeof value === "string") {
        out.push({ fieldPath, value });
      }
      return value;
    },
  });
  return out;
}
