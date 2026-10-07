/**
 * Serialized units, applied: the range text operators type, the canonical
 * set every wire carries, the picker's suggestion, and the ONE fold that turns
 * movements into a product's roster.
 *
 * ```ts
 * import { formatUnitRanges, parseUnitRanges, suggestUnits } from "@cfs/core/utils/units";
 * ```
 *
 * Everything here is pure and platform-free. The manager's picker and the
 * api's validation read the same parser; the api's ledger writer and the
 * `audit-unit-replay` script run the same {@link foldRosterUnits}.
 *
 * @module
 */
import {
  type DocSourceType,
  MAX_UNITS_PER_ROSTER,
  type Movement,
  OOS_FLAG_REASONS,
  type OOSFlagReasonType,
  type UnitRosterEntryType,
} from "../schemas/mod.ts";

// ── Canonical sets ───────────────────────────────────────────────────

/**
 * The one client-side canonicalizer: ascending, each number once.
 *
 * The wire REFUSES a set in any other order (`UnitSet`), so a client that
 * accumulates picks in click order runs them through this before sending.
 */
export function normalizeUnitSet(numbers: Iterable<number>): number[] {
  return [...new Set(numbers)].sort((a, b) => a - b);
}

/** One inclusive run of consecutive unit numbers. */
export interface UnitRange {
  start: number;
  end: number;
}

/** The fewest inclusive runs covering `numbers`, ascending. */
export function toUnitRanges(numbers: Iterable<number>): UnitRange[] {
  const ranges: UnitRange[] = [];
  for (const n of normalizeUnitSet(numbers)) {
    const last = ranges[ranges.length - 1];
    if (last !== undefined && n === last.end + 1) last.end = n;
    else ranges.push({ start: n, end: n });
  }
  return ranges;
}

/** Options for {@link formatUnitRanges}. */
export interface FormatUnitRangesOptions {
  /** Between two runs. Default `", "`. */
  separator?: string;
  /** Inside a run. Default an en dash, `"–"`. */
  dash?: string;
}

/**
 * Unit numbers as the fewest runs a reader can scan: `"1001–1040, 1045"`.
 * The form printed on packing lists and invoices, which customers read
 * (owner, 2026-09-21). An empty set is `""`.
 */
export function formatUnitRanges(numbers: Iterable<number>, opts: FormatUnitRangesOptions = {}): string {
  const separator = opts.separator ?? ", ";
  const dash = opts.dash ?? "–";
  return toUnitRanges(numbers)
    .map((r) => r.start === r.end ? String(r.start) : `${r.start}${dash}${r.end}`)
    .join(separator);
}

// ── Parsing ──────────────────────────────────────────────────────────

/** Why one piece of range text was refused. */
export type UnitRangeErrorKind =
  /** Not a number or a `start–end` run. Leading zeros and `0` count. */
  | "syntax"
  /** A run whose end is below its start: `1040–1001`. */
  | "reversed"
  /** A number named twice, by two pieces or within one. */
  | "overlap"
  /** More units than `max`. */
  | "too_many";

/** One refused piece of range text. */
export interface UnitRangeError {
  kind: UnitRangeErrorKind;
  /** The piece as typed (for `too_many`, the whole text). */
  token: string;
}

/** Options for {@link parseUnitRanges}. */
export interface ParseUnitRangesOptions {
  /** The most units the text may name. Default `MAX_UNITS_PER_ROSTER`. */
  max?: number;
}

/** The outcome of {@link parseUnitRanges}. */
export type ParseUnitRangesResult =
  | { ok: true; numbers: number[] }
  | { ok: false; errors: UnitRangeError[] };

const NUMBER = "[1-9][0-9]*";
const PIECE = new RegExp(`^(${NUMBER})(?:\\s*(?:-|–|—)\\s*(${NUMBER}))?$`);

/**
 * Parse what an operator types — `"1001-1040, 1045 1050–1052"` — into a
 * canonical set.
 *
 * Pieces are separated by commas, semicolons or whitespace; a run is
 * `start-end` with a hyphen, en dash or em dash, spaces allowed around it. A
 * piece that is not a number or a run, a reversed run, a number named twice,
 * and more than `max` units are each REFUSED, never repaired: the picker shows
 * the error beside the text rather than guessing what was meant. Every error is
 * reported, not just the first.
 */
export function parseUnitRanges(text: string, opts: ParseUnitRangesOptions = {}): ParseUnitRangesResult {
  const max = opts.max ?? MAX_UNITS_PER_ROSTER;
  // Normalize the spaces a run may carry so the run survives the split.
  const pieces = text.replace(/\s*([-–—])\s*/g, "$1").split(/[\s,;]+/).filter((p) => p.length > 0);
  const errors: UnitRangeError[] = [];
  const seen = new Set<number>();
  let total = 0;
  for (const token of pieces) {
    const m = PIECE.exec(token);
    if (m === null) {
      errors.push({ kind: "syntax", token });
      continue;
    }
    const start = Number(m[1]);
    const end = m[2] === undefined ? start : Number(m[2]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
      errors.push({ kind: "syntax", token });
      continue;
    }
    if (end < start) {
      errors.push({ kind: "reversed", token });
      continue;
    }
    total += end - start + 1;
    if (total > max) {
      // Stop materializing: a typo like `1001-9999999` must not allocate millions.
      errors.push({ kind: "too_many", token: text });
      break;
    }
    let overlapped = false;
    for (let n = start; n <= end; n++) {
      if (seen.has(n)) overlapped = true;
      seen.add(n);
    }
    if (overlapped) errors.push({ kind: "overlap", token });
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, numbers: normalizeUnitSet(seen) };
}

// ── Suggestion ───────────────────────────────────────────────────────

/**
 * The units a picker pre-fills when `count` are needed from `available`, or
 * `null` when there are not enough.
 *
 * Ranges are the operator's main gesture (owner, 2026-09-21), so the
 * suggestion is the FEWEST runs: a single run long enough wins, the lowest such
 * run first. Failing that, the `k` longest runs for the smallest `k` that
 * covers `count` (longer first, then lower start), filled in ascending order and
 * trimmed at the high end. Deterministic for a given input, so two clients
 * suggest the same units.
 *
 * `available` is whatever the caller may offer — unflagged shelf units for a
 * prep — and need not be sorted.
 */
export function suggestUnits(available: Iterable<number>, count: number): number[] | null {
  if (count < 0 || !Number.isInteger(count)) return null;
  if (count === 0) return [];
  const runs = toUnitRanges(available);
  const size = (r: UnitRange) => r.end - r.start + 1;
  const total = runs.reduce((sum, r) => sum + size(r), 0);
  if (total < count) return null;

  const single = runs.find((r) => size(r) >= count);
  if (single !== undefined) return Array.from({ length: count }, (_, i) => single.start + i);

  const byLength = [...runs].sort((a, b) => size(b) - size(a) || a.start - b.start);
  const chosen: UnitRange[] = [];
  let covered = 0;
  for (const r of byLength) {
    if (covered >= count) break;
    chosen.push(r);
    covered += size(r);
  }
  chosen.sort((a, b) => a.start - b.start);
  const picked: number[] = [];
  for (const r of chosen) for (let n = r.start; n <= r.end; n++) picked.push(n);
  return picked.slice(0, count);
}

// ── The roster fold ──────────────────────────────────────────────────

/** A roster's `units` map: unit number (as a key) → where it is. */
export type RosterUnits = Record<string, UnitRosterEntryType>;

/** The movement fields the fold reads. */
export type RosterMovement = Pick<
  Movement,
  "uid" | "type" | "uid_booking" | "custody" | "service" | "lines" | "units" | "sources"
>;

/**
 * A movement that does not fit the roster it is folded into: a unit that is
 * not where the movement says it came from. On the write path that is a
 * refusal (map it to a 409 or 400); in `audit-unit-replay` it is a finding.
 */
export class RosterFoldError extends Error {
  /** The unit the movement could not move, when there is one. */
  readonly unit: number | null;
  constructor(message: string, unit: number | null = null) {
    super(message);
    this.name = "RosterFoldError";
    this.unit = unit;
  }
}

const FLAG_REASONS: ReadonlySet<string> = new Set(OOS_FLAG_REASONS);

function asFlag(reason: string | null | undefined): OOSFlagReasonType | null {
  return reason != null && FLAG_REASONS.has(reason) ? reason as OOSFlagReasonType : null;
}

/**
 * The flag a unit carries on a shelf at one side of the movement. The
 * `service` axis says it where it is set; a movement older than that axis (or
 * one whose contract forbids it, `mark_damaged`) carries it on `custody`.
 */
function shelfFlag(m: RosterMovement, side: "from" | "to"): OOSFlagReasonType | null {
  return asFlag(m.service?.[side]) ?? (m.service === null ? asFlag(m.custody?.[side]) : null);
}

function describe(entry: UnitRosterEntryType | undefined): string {
  if (entry === undefined) return "not on the roster";
  switch (entry.state) {
    case "shelf":
      return entry.flag === null ? `on shelf ${entry.uid_location}` : `flagged ${entry.flag} on shelf ${entry.uid_location}`;
    case "prepped":
      return `prepped on ${entry.uid_booking}`;
    case "out":
      return `out on ${entry.uid_booking}`;
    case "away":
      return `away at ${entry.uid_out_of_service}`;
    case "unattributed_out":
      return "out on an unrecorded booking";
  }
}

/** Refuse unless `entry` is where a line's `from` side says the unit was. */
function checkSource(m: RosterMovement, n: number, entry: UnitRosterEntryType | undefined, from: DocSourceType | null) {
  const refuse = () => {
    const where = from === null ? "outside CFS" : `${from.collection}/${from.uid}`;
    return new RosterFoldError(
      `"${m.type}" moves unit ${n} from ${where}, but the unit is ${describe(entry)}`,
      n,
    );
  };
  if (from === null) {
    if (entry !== undefined) throw refuse();
    return;
  }
  if (entry === undefined) throw refuse();
  switch (from.collection) {
    case "bookings":
      if (entry.state === "unattributed_out") return;
      if (entry.state === "out" && entry.uid_booking === from.uid) return;
      throw refuse();
    case "out-of-service":
      if (entry.state === "away" && entry.uid_out_of_service === from.uid) return;
      throw refuse();
    case "locations":
      if (
        entry.state === "prepped" && m.custody?.from === "prepped" &&
        entry.uid_booking === m.uid_booking && entry.uid_location === from.uid
      ) return;
      if (entry.state === "shelf" && entry.uid_location === from.uid && entry.flag === shelfFlag(m, "from")) return;
      throw refuse();
    default:
      throw refuse();
  }
}

function oosSource(m: RosterMovement): string | null {
  return m.sources.find((s) => s.collection === "out-of-service")?.uid ?? null;
}

/** Where a line's `to` side puts a unit, or `undefined` when it leaves the roster. */
function destination(
  m: RosterMovement,
  n: number,
  entry: UnitRosterEntryType | undefined,
  to: DocSourceType | null,
): UnitRosterEntryType | undefined {
  if (to === null) return undefined;
  switch (to.collection) {
    case "bookings":
      return { state: "out", uid_booking: to.uid };
    case "out-of-service":
      return { state: "away", uid_out_of_service: to.uid };
    case "locations": {
      if (m.custody?.to === "prepped") {
        if (m.uid_booking === null) throw new RosterFoldError(`"${m.type}" preps unit ${n} onto no booking`, n);
        return { state: "prepped", uid_booking: m.uid_booking, uid_location: to.uid };
      }
      const flag = shelfFlag(m, "to");
      if (flag === null) return { state: "shelf", uid_location: to.uid, flag: null, uid_out_of_service: null };
      const record = oosSource(m) ?? (entry?.state === "shelf" && entry.flag === flag ? entry.uid_out_of_service : null);
      if (record === null) {
        throw new RosterFoldError(`"${m.type}" flags unit ${n} ${flag} but names no out-of-service record`, n);
      }
      return { state: "shelf", uid_location: to.uid, flag, uid_out_of_service: record };
    }
    default:
      throw new RosterFoldError(`"${m.type}" moves unit ${n} to ${to.collection}, which is not a place`, n);
  }
}

/**
 * The rebook pair: a unit that stays at the customer moves from booking A's
 * `out` to booking B's. `rebook_out` (subject A) only CHECKS that each named
 * unit is `out` on A, and changes nothing. `rebook_in` (subject B) re-points
 * each unit from A — the one `bookings` entry in its `sources[]` — to B.
 *
 * So the pair folds in ONE order, A's half first: the other way round,
 * `rebook_out` finds the unit already on B and refuses. That is deliberate, as
 * a half applied alone is then detectable: a `rebook_in` naming a unit not on
 * its counterpart, or a `rebook_out` whose units were moved by something else.
 */
function foldRebook(next: RosterUnits, m: RosterMovement, once: (n: number) => void): RosterUnits {
  if (m.uid_booking === null) throw new RosterFoldError(`"${m.type}" names units but no booking`);
  let from = m.uid_booking;
  if (m.type === "rebook_in") {
    const counterparts = m.sources.filter((s) => s.collection === "bookings" && s.uid !== m.uid_booking);
    if (counterparts.length !== 1) {
      throw new RosterFoldError(`"rebook_in" must name exactly one counterpart booking in sources[], found ${counterparts.length}`);
    }
    from = counterparts[0].uid;
  }
  for (const { number: n } of m.units) {
    once(n);
    const entry = next[String(n)];
    if (entry?.state !== "out" || entry.uid_booking !== from) {
      throw new RosterFoldError(`"${m.type}" rebooks unit ${n} off ${from}, but the unit is ${describe(entry)}`, n);
    }
    if (m.type === "rebook_in") next[String(n)] = { state: "out", uid_booking: m.uid_booking };
  }
  return next;
}

/**
 * Fold one movement's units into a product's roster, returning the NEW map
 * (the input is not mutated, so a rejected group member's fold rolls back by
 * dropping the result).
 *
 * The one author of roster state: api-cloudrun's ledger writer runs it for
 * every movement it applies, and `audit-unit-replay` runs it over the whole
 * journal and diffs against the stored roster
 * (`api-cloudrun/.claude/plans/serial-tracking.md` D5). A movement naming no
 * units leaves the roster untouched.
 *
 * Driven by each line's places, so it needs no knowledge of the movement type
 * and a reversal (lines negated, type kept) folds correctly:
 *
 * | line `to`             | the unit becomes                                       |
 * |-----------------------|--------------------------------------------------------|
 * | `null` (outside)      | removed — the number is no longer active               |
 * | `bookings/B`          | `out` on B                                             |
 * | `out-of-service/R`    | `away` at R                                            |
 * | `locations/L`         | `prepped` on the booking if custody lands in `prepped`; else `shelf` at L, flagged by the arrival's flag and the record in `sources[]` |
 *
 * `prep` and `unprep` move nothing physically and have no lines: a prep turns
 * an unflagged shelf unit `prepped` where it stands, and an unprep puts it
 * back. `rebook_out` / `rebook_in` have no lines either: the unit stays at the
 * customer and moves from one booking to another (see `foldRebook`).
 *
 * Every unit must be where the line's `from` side says — absent for a unit
 * coming in, `out` on the booking (or `unattributed_out`) for one coming back,
 * on the shelf with the expected flag, and so on. Anything else throws
 * {@link RosterFoldError}.
 */
export function foldRosterUnits(roster: RosterUnits, m: RosterMovement): RosterUnits {
  if (m.units.length === 0) return roster;
  const next: RosterUnits = { ...roster };
  const moved = new Set<number>();
  const once = (n: number) => {
    if (moved.has(n)) throw new RosterFoldError(`"${m.type}" moves unit ${n} twice`, n);
    moved.add(n);
  };

  if (m.lines.length === 0 && (m.type === "rebook_out" || m.type === "rebook_in")) {
    return foldRebook(next, m, once);
  }

  if (m.lines.length === 0) {
    const preps = m.custody?.to === "prepped" && m.custody.from === "reserved";
    const unpreps = m.custody?.from === "prepped" && m.custody.to === "reserved";
    if (!preps && !unpreps) {
      throw new RosterFoldError(`"${m.type}" names units but moves nothing physically`);
    }
    for (const { number: n } of m.units) {
      once(n);
      const entry = next[String(n)];
      if (preps) {
        if (entry?.state !== "shelf" || entry.flag !== null || m.uid_booking === null) {
          throw new RosterFoldError(`"${m.type}" preps unit ${n}, but the unit is ${describe(entry)}`, n);
        }
        next[String(n)] = { state: "prepped", uid_booking: m.uid_booking, uid_location: entry.uid_location };
      } else {
        if (entry?.state !== "prepped" || entry.uid_booking !== m.uid_booking) {
          throw new RosterFoldError(`"${m.type}" unpreps unit ${n}, but the unit is ${describe(entry)}`, n);
        }
        next[String(n)] = { state: "shelf", uid_location: entry.uid_location, flag: null, uid_out_of_service: null };
      }
    }
    return next;
  }

  for (const line of m.lines) {
    const units = line.units ?? [];
    if (units.length !== line.quantity) {
      throw new RosterFoldError(`"${m.type}" names units, so each line names exactly its quantity`);
    }
    for (const n of units) {
      once(n);
      const entry = next[String(n)];
      checkSource(m, n, entry, line.location.from);
      const dest = destination(m, n, entry, line.location.to);
      if (dest === undefined) delete next[String(n)];
      else next[String(n)] = dest;
    }
  }
  const named = new Set(m.units.map((u) => u.number));
  if (named.size !== moved.size || [...moved].some((n) => !named.has(n))) {
    throw new RosterFoldError(`"${m.type}"'s lines must move exactly the units it names`);
  }
  return next;
}
