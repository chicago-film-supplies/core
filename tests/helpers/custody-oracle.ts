/**
 * FROZEN copies of the api's pure custody functions, as the parity oracle for
 * `utils/custody.ts`.
 *
 * - `deriveCustodyTransitions`, `deriveWithLossUndos`, `canonicalLossUndos`:
 *   `api-cloudrun/src/lib/bookingMovements.ts` at api-cloudrun `0f3fc1a0`.
 * - `planBucketMoves`: `api-cloudrun/src/lib/serviceFlag.ts` at the same sha,
 *   its `ValidationError` replaced by a plain `Error`.
 *
 * ⚠️ **Do not edit these to make a test pass.** They are the behaviour core's
 * versions replace; the point of the sweep is that the two agree wherever the
 * plan says they must, and disagree only where an owner ruling says they do.
 * Delete this file when the api and manager copies are deleted (custody-actions
 * P2/P3).
 */
import type {
  BookingBreakdown,
  BookingBreakdownKeyType,
  ComponentTypeType,
  MovementTypeType,
  OOSBreakdown,
  OOSReasonType,
} from "../../src/schemas/mod.ts";

export interface OracleTransition {
  type: MovementTypeType;
  from: BookingBreakdownKeyType;
  to: BookingBreakdownKeyType;
  quantity: number;
}

function take(
  falls: Map<BookingBreakdownKeyType, number>,
  fallKey: BookingBreakdownKeyType,
  rises: Map<BookingBreakdownKeyType, number>,
  riseKey: BookingBreakdownKeyType,
): number {
  const taken = Math.min(falls.get(fallKey) ?? 0, rises.get(riseKey) ?? 0);
  if (taken > 0) {
    falls.set(fallKey, (falls.get(fallKey) ?? 0) - taken);
    rises.set(riseKey, (rises.get(riseKey) ?? 0) - taken);
  }
  return taken;
}

// The SEVEN keys, deliberately not `BOOKING_BREAKDOWN_KEYS`: this is the api's
// behaviour frozen before `cleaning`/`maintenance` existed, and the sweep only
// ever draws breakdowns over these seven.
const BREAKDOWN_KEYS = [
  "quoted",
  "reserved",
  "prepped",
  "out",
  "returned",
  "lost",
  "damaged",
] as const;

export function deriveCustodyTransitions(
  prev: BookingBreakdown,
  next: BookingBreakdown,
  bookingType: ComponentTypeType,
): OracleTransition[] {
  if (bookingType !== "rental" && bookingType !== "sale") return [];
  const isSale = bookingType === "sale";
  const falls = new Map<BookingBreakdownKeyType, number>();
  const rises = new Map<BookingBreakdownKeyType, number>();
  for (const key of BREAKDOWN_KEYS) {
    const delta = next[key] - prev[key];
    if (delta < 0) falls.set(key, -delta);
    else if (delta > 0) rises.set(key, delta);
  }
  const transitions: OracleTransition[] = [];
  const add = (type: MovementTypeType, from: BookingBreakdownKeyType, to: BookingBreakdownKeyType, quantity: number) => {
    if (quantity > 0) transitions.push({ type, from, to, quantity });
  };
  const unprepDirect = take(falls, "prepped", rises, "reserved");
  const prepDirect = take(falls, "reserved", rises, "prepped");
  const outFromPrepped = take(falls, "prepped", rises, "out");
  const outFromReserved = take(falls, "reserved", rises, "out");
  add("prep", "reserved", "prepped", prepDirect + outFromReserved);
  add(isSale ? "sale" : "check_out", "prepped", "out", outFromPrepped + outFromReserved);
  add(isSale ? "sale_return" : "check_in", "out", "returned", take(falls, "out", rises, "returned"));
  if (!isSale) {
    add("mark_damaged", "out", "damaged", take(falls, "out", rises, "damaged"));
    add("mark_lost", "out", "lost", take(falls, "out", rises, "lost"));
    add("mark_lost", "returned", "lost", take(falls, "returned", rises, "lost"));
    add("flag", "returned", "damaged", take(falls, "returned", rises, "damaged"));
  }
  if (isSale) {
    add("unprep", "prepped", "reserved", unprepDirect);
    return transitions;
  }
  const outFromReturned = take(falls, "returned", rises, "out");
  const preppedFromOut = take(falls, "out", rises, "prepped");
  const reservedFromOut = take(falls, "out", rises, "reserved");
  const preppedFromReturned = take(falls, "returned", rises, "prepped");
  const reservedFromReturned = take(falls, "returned", rises, "reserved");
  add("check_in_undo", "returned", "out", outFromReturned + preppedFromReturned + reservedFromReturned);
  add("check_out_undo", "out", "prepped", preppedFromOut + reservedFromOut + preppedFromReturned + reservedFromReturned);
  add("unprep", "prepped", "reserved", unprepDirect + reservedFromOut + reservedFromReturned);
  return transitions;
}

export interface OracleLossUndo {
  reason: "lost" | "damaged";
  origin: BookingBreakdownKeyType;
  quantity: number;
}

function undoType(reason: "lost" | "damaged", origin: BookingBreakdownKeyType): MovementTypeType {
  if (reason === "damaged" && origin === "returned") return "flag";
  return reason === "lost" ? "mark_lost_undo" : "mark_damaged_undo";
}

export function canonicalLossUndos(prev: BookingBreakdown, next: BookingBreakdown): OracleLossUndo[] {
  const undos: OracleLossUndo[] = [];
  for (const reason of ["lost", "damaged"] as const) {
    const fall = prev[reason] - next[reason];
    if (fall > 0) undos.push({ reason, origin: "out", quantity: fall });
  }
  return undos;
}

export function deriveWithLossUndos(
  prev: BookingBreakdown,
  next: BookingBreakdown,
  bookingType: ComponentTypeType,
  undos: readonly OracleLossUndo[],
): OracleTransition[] {
  if (bookingType !== "rental" || undos.length === 0) {
    return deriveCustodyTransitions(prev, next, bookingType);
  }
  const mid: BookingBreakdown = { ...prev };
  const grouped = new Map<string, OracleLossUndo>();
  for (const u of undos) {
    mid[u.reason] -= u.quantity;
    mid[u.origin] += u.quantity;
    const key = `${u.reason}|${u.origin}`;
    const g = grouped.get(key);
    if (g) g.quantity += u.quantity;
    else grouped.set(key, { ...u });
  }
  const undoTransitions: OracleTransition[] = [...grouped.values()]
    .filter((g) => g.quantity > 0)
    .map((g) => ({ type: undoType(g.reason, g.origin), from: g.reason, to: g.origin, quantity: g.quantity }));
  return [...undoTransitions, ...deriveCustodyTransitions(mid, next, bookingType)];
}

// ── the record side ──

type OOSPlace = "unplaced" | "flagged" | "away" | "written_off" | "returned_to_service";

export function planBucketMoves(
  prev: OOSBreakdown,
  next: OOSBreakdown,
  quantity: number,
  reason: OOSReasonType,
): { from: OOSPlace; to: OOSPlace; quantity: number }[] {
  const placed = (b: OOSBreakdown) => b.flagged + b.away + b.written_off + b.returned_to_service;
  const level = (b: OOSBreakdown): Record<OOSPlace, number> => ({
    unplaced: quantity - placed(b),
    flagged: b.flagged,
    away: b.away,
    written_off: b.written_off,
    returned_to_service: b.returned_to_service,
  });
  const before = level(prev);
  const after = level(next);
  if (after.unplaced < 0) throw new Error("over");
  if (after.returned_to_service < before.returned_to_service) throw new Error("rts");
  if (after.written_off < before.written_off) throw new Error("internal");
  if (after.unplaced > before.unplaced) throw new Error("unplace");
  if (reason === "lost" && after.flagged > 0) throw new Error("lostflag");
  const spare: Record<OOSPlace, number> = { unplaced: 0, flagged: 0, away: 0, written_off: 0, returned_to_service: 0 };
  const need: Record<OOSPlace, number> = { ...spare };
  for (const p of Object.keys(before) as OOSPlace[]) {
    const d = after[p] - before[p];
    if (d < 0) spare[p] = -d;
    if (d > 0) need[p] = d;
  }
  const PREFERENCE: ReadonlyArray<[OOSPlace, readonly OOSPlace[]]> = [
    ["written_off", ["away", "flagged", "unplaced"]],
    ["returned_to_service", ["away", "flagged", "unplaced"]],
    ["away", ["flagged", "unplaced"]],
    ["flagged", ["away", "unplaced"]],
  ];
  const moves: { from: OOSPlace; to: OOSPlace; quantity: number }[] = [];
  for (const [to, sources] of PREFERENCE) {
    for (const from of sources) {
      const q = Math.min(need[to], spare[from]);
      if (q <= 0) continue;
      moves.push({ from, to, quantity: q });
      need[to] -= q;
      spare[from] -= q;
    }
  }
  const stuck = (Object.keys(spare) as OOSPlace[]).filter((p) => spare[p] > 0);
  if (stuck.length > 0) throw new Error("stuck");
  return moves;
}
