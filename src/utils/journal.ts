/**
 * The movement journal, folded: the orders a fold may use, and the custody
 * replay as projections over it (stock campaign P1, api-cloudrun#1240).
 *
 * ```ts
 * import { foldJournal, journalOrder, custodyByBooking } from "@cfs/core/utils/journal";
 * ```
 *
 * ## Two orders, because two questions
 *
 * Three folds each ordered the journal their own way: the custody replay
 * grouped by `date` instant with no tiebreak; the ledger replay sorted `date_fs`
 * then `number`; and the unit replay sorted `created_at` then `number`. They
 * answer two different questions, so they need exactly two orders:
 *
 * - **What happened, in what order** — {@link journalOrder}: the movement's own
 *   `date` instant, then its `number`. Custody folds use it. A rebook pair is
 *   numbered `rebook_out` first precisely so that a fold takes it first.
 * - **What a writer applied, in what order** — {@link replayOrder}: what a
 *   replay must use to reproduce a stored ledger or roster, since basis and
 *   roster state depend on the order movements were applied, not the order
 *   they happened (api-cloudrun#1255). {@link recordOrder} is its live-writer
 *   half.
 *
 * ## The replay identity, and why it covers exactly the history keys
 *
 * `calculateBookingBreakdown` carries every custody-history key forward
 * verbatim and re-derives only the plan keys, so the order path never
 * ORIGINATES a unit in a history key; only the fulfillment ladder does, and it
 * writes a movement for every step. Hence
 *
 *     net[k] = Σ(movements with custody.to === k) − Σ(movements with custody.from === k)
 *     net[k] === booking.breakdown[k]        for k in CUSTODY_HISTORY_KEYS
 *
 * The plan keys move with an order's status, a planning act with no event, so
 * they are deliberately outside the identity. **The stored breakdown wins on
 * disagreement**: a divergence is a bug report about the journal, never a
 * licence to rewrite the booking.
 *
 * Lifted from api-cloudrun's custodyReplay module (`replayCustody`,
 * `classifyReplay`; deleted there in stock campaign P3), unchanged in behaviour. How the audit judges each verdict
 * (the cutover instant, `booking.created_at`) stays in the audit.
 *
 * @module
 */
import {
  type BookingBreakdown,
  type BookingBreakdownKeyType,
  type ComponentTypeType,
  CUSTODY_HISTORY_KEYS,
  ownsKey,
} from "../schemas/mod.ts";
import type { FirestoreTimestampType, FirestoreTimestampValue } from "../schemas/common.ts";
import { breakdownQuantity } from "./bookings.ts";
import { parseBookingId } from "./booking-id.ts";

// ── The one order ────────────────────────────────────────────────────

/** The fields {@link journalOrder} reads. */
export interface JournalOrdered {
  /** The movement's Chicago-offset instant. */
  date: string;
  /** Its document number: the tiebreak inside one instant. */
  number: number;
}

/**
 * The journal's order: `Date.parse(date)` ascending, then `number`.
 *
 * Instants are compared parsed, never as strings: Chicago-offset text does not
 * sort as time across a DST change. Within one instant the number decides,
 * which is what puts a rebook pair's `rebook_out` before its `rebook_in` and a
 * reconstructed ladder's legs in the order they happened.
 */
export function journalOrder(a: JournalOrdered, b: JournalOrdered): number {
  return Date.parse(a.date) - Date.parse(b.date) || a.number - b.number;
}

// ── The writer's order ───────────────────────────────────────────────

/**
 * The last `--write` run of the 2026-10 journal rebuild (api-cloudrun#1088).
 *
 * Measured on prod 2026-10-09. The rebuild wrote three times on 2026-10-03 —
 * 04:03:58.152Z (22,012 movements sharing that `created_at`), 06:09:44.184Z (43)
 * and 15:20:59.228Z (12) — and each run re-derived EVERY ledger by folding the
 * whole journal in business-date order. The first movement any live writer
 * recorded is 16:11:30.695Z. So a movement whose `created_at` is at or before
 * this instant reached its ledger through a business-order fold, and one after
 * it through the live writer, which applies movements as they arrive.
 *
 * ⚠️ Prod's instant. Dev's rebuild ran at 2026-10-02T20:32:30.134Z and dev also
 * holds prod rows mirrored in, so a dev replay under this cut is approximate —
 * dev is ephemeral and never the reference.
 */
export const REBUILD_AT_MS: number = Date.parse("2026-10-03T15:20:59.228Z");

/** The fields {@link recordOrder} and {@link replayOrder} read. */
export interface RecordOrdered {
  /** When the movement was recorded. A write sentinel is refused, never ordered. */
  created_at: FirestoreTimestampType;
  /** Its document number: the tiebreak inside one `created_at`. */
  number: number;
}

function createdMs(m: RecordOrdered): number {
  const c = m.created_at;
  if (typeof (c as FirestoreTimestampValue).toMillis !== "function") {
    throw new Error(
      `movement #${m.number}: created_at is not a stored Timestamp, so it has no order — ` +
        `a write sentinel reached a replay`,
    );
  }
  return (c as FirestoreTimestampValue).toMillis();
}

/**
 * Record order: `created_at`, then `number` — the order the live ledger writer
 * applied movements in (`commitLedgerMovements` folds a batch as it arrives).
 *
 * A backdated movement is recorded late, so it applies late: it moves basis
 * from the moment it is recorded, not from its business date.
 */
export function recordOrder(a: RecordOrdered, b: RecordOrdered): number {
  return createdMs(a) - createdMs(b) || a.number - b.number;
}

/** The fields {@link replayOrder} reads. */
export interface ReplayOrdered extends JournalOrdered, RecordOrdered {}

/**
 * The order the writers actually applied the journal in, which is what a replay
 * must use to reproduce a stored ledger or roster.
 *
 * Two eras, split at {@link REBUILD_AT_MS}:
 *
 * - **At or before it**, {@link journalOrder}: the rebuild folded the whole
 *   journal by business date. Record order is wrong here — the rebuild CARRIED
 *   older movements with their original `created_at`, so they would replay
 *   ahead of the supply that preceded them on the shelf and relieve $0
 *   (`costOfUnits` returns 0 when held is 0 or less).
 * - **After it**, {@link recordOrder}: the live writer applied on arrival.
 *   Business order is wrong here — a backdated purchase would move basis for
 *   every movement between its date and its recording.
 *
 * Every earlier-era movement precedes every later one.
 *
 * ⚠️ Inside the earlier era this approximates the rebuild rather than
 * reproducing it: the rebuild broke a same-instant tie by an internal rank and
 * a carried movement kept its old `number`, neither of which is stored.
 */
export function replayOrder(a: ReplayOrdered, b: ReplayOrdered): number {
  const aRebuilt = createdMs(a) <= REBUILD_AT_MS;
  const bRebuilt = createdMs(b) <= REBUILD_AT_MS;
  if (aRebuilt !== bRebuilt) return aRebuilt ? -1 : 1;
  return aRebuilt ? journalOrder(a, b) : recordOrder(a, b);
}

// ── The fold ─────────────────────────────────────────────────────────

/** A movement as the projections read it. */
export interface JournalMovement extends JournalOrdered {
  uid: string;
  uid_booking: string | null;
  custody: { from: BookingBreakdownKeyType | null; to: BookingBreakdownKeyType | null } | null;
  quantity: number;
  /** The units it names, on a serialized product. */
  units: ReadonlyArray<{ number: number }>;
}

/** One thing a journal fold accumulates. */
export interface JournalProjection<S> {
  init(): S;
  step(state: S, movement: JournalMovement): void;
}

/** The states a list of projections produce, in the same order. */
export type ProjectionStates<P extends readonly JournalProjection<unknown>[]> = {
  [K in keyof P]: P[K] extends JournalProjection<infer S> ? S : never;
};

/**
 * Fold `movements` once, in {@link journalOrder}, through every projection,
 * and return each projection's state. The input is not mutated or assumed
 * sorted.
 */
export function foldJournal<P extends readonly JournalProjection<unknown>[]>(
  movements: readonly JournalMovement[],
  projections: P,
): ProjectionStates<P> {
  const ordered = [...movements].sort(journalOrder);
  const states = projections.map((p) => p.init());
  for (const m of ordered) projections.forEach((p, i) => p.step(states[i], m));
  return states as ProjectionStates<P>;
}

/** Net units per custody-history key, all keys stated. */
export type CustodyNet = Record<BookingBreakdownKeyType, number>;

function emptyNet(): CustodyNet {
  const net = {} as CustodyNet;
  for (const k of CUSTODY_HISTORY_KEYS) net[k] = 0;
  return net;
}

const HISTORY: ReadonlySet<BookingBreakdownKeyType> = new Set(CUSTODY_HISTORY_KEYS);

/** Add one movement's custody pair to a net. A plan key on either end contributes nothing. */
function addCustody(net: CustodyNet, m: Pick<JournalMovement, "custody" | "quantity">): void {
  if (!m.custody) return;
  if (m.custody.to !== null && HISTORY.has(m.custody.to)) net[m.custody.to] += m.quantity;
  if (m.custody.from !== null && HISTORY.has(m.custody.from)) net[m.custody.from] -= m.quantity;
}

/** Net custody per booking id — the replay of every booking at once. */
export function custodyByBooking(): JournalProjection<Map<string, CustodyNet>> {
  return {
    init: () => new Map(),
    step(state, m) {
      if (m.uid_booking === null || !m.custody) return;
      const net = state.get(m.uid_booking) ?? emptyNet();
      addCustody(net, m);
      state.set(m.uid_booking, net);
    },
  };
}

/**
 * Net custody per GRAIN — `(order, product, leg)`, every component signature
 * pooled. A grain carry or a re-key moves custody between the bookings of one
 * grain, so a booking can diverge while its grain conserves.
 */
export function custodyByGrain(): JournalProjection<Map<string, CustodyNet>> {
  return {
    init: () => new Map(),
    step(state, m) {
      if (m.uid_booking === null || !m.custody) return;
      const p = parseBookingId(m.uid_booking);
      const grain = p === null ? m.uid_booking : `${p.orderUid}:${p.itemUid}:${p.destUid}`;
      const net = state.get(grain) ?? emptyNet();
      addCustody(net, m);
      state.set(grain, net);
    },
  };
}

/**
 * Net custody on movements whose booking no longer exists: per booking id, the
 * net its movements leave. A grain carry or a deleted plan-only booking nets to
 * zero or below; a positive bucket is custody nothing holds any more.
 */
export function orphanedCustody(existing: ReadonlySet<string>): JournalProjection<Map<string, CustodyNet>> {
  return {
    init: () => new Map(),
    step(state, m) {
      if (m.uid_booking === null || existing.has(m.uid_booking) || !m.custody) return;
      const net = state.get(m.uid_booking) ?? emptyNet();
      addCustody(net, m);
      state.set(m.uid_booking, net);
    },
  };
}

/** Each booking's named units per history key, as the journal leaves them. */
export type UnitSetsByKey = Partial<Record<BookingBreakdownKeyType, Set<number>>>;

/**
 * Which units each booking holds per history key, folded over the WHOLE journal
 * from empty sets. A unit leaves `custody.from`'s set and joins `custody.to`'s.
 *
 * ⚠️ **There is no era cut, and none should come back** (api-cloudrun#1253). A
 * roster interval is journaled (`enroll` / `unenroll`), and numbers are never
 * reused, so a movement naming unit N can only mean that one unit, in whichever
 * interval it was written. An earlier `since` cut the fold by business `date`,
 * which disagreed with the unit replay's `created_at` cut and was then left with
 * nothing to cut at all. If a caller ever needs one interval, derive it from that
 * interval's `enroll`, never from a date.
 */
export function unitsByBooking(): JournalProjection<Map<string, UnitSetsByKey>> {
  return {
    init: () => new Map(),
    step(state, m) {
      if (m.uid_booking === null || !m.custody || m.units.length === 0) return;
      const sets = state.get(m.uid_booking) ?? {};
      for (const { number: n } of m.units) {
        if (m.custody.from !== null && HISTORY.has(m.custody.from)) sets[m.custody.from]?.delete(n);
        if (m.custody.to !== null && HISTORY.has(m.custody.to)) (sets[m.custody.to] ??= new Set()).add(n);
      }
      state.set(m.uid_booking, sets);
    },
  };
}

// ── The custody replay, judged ───────────────────────────────────────

/** One event's custody transition and when it happened: the parts of a movement the replay reads. */
export interface CustodyEvent {
  custody: { from: BookingBreakdownKeyType | null; to: BookingBreakdownKeyType | null } | null;
  quantity: number;
  date: string;
}

/** How a booking's events compare with its stored breakdown. */
export type ReplayVerdict =
  | "ok"
  | "no_events"
  | "substitution_seeded"
  | "partial_history"
  | "sale_untracked_loss"
  | "service_surcharge"
  | "diverged";

/** Per-key disagreement, present only for the keys that differ. */
export type ReplayDeltas = Record<string, { stored: number; replayed: number }>;

/**
 * Net units the events place in each custody-history key. A `reverses`
 * reversal carries its custody swapped and nets itself out; a planning key on
 * one end contributes only through the other.
 */
export function replayCustody(events: readonly CustodyEvent[]): CustodyNet {
  const net = emptyNet();
  for (const e of events) addCustody(net, e);
  return net;
}

/**
 * Whether some prefix of the log, in time order, drives a key negative — a log
 * missing events from its front. Events sharing one instant fold as ONE step
 * first, so no within-instant order can fake a negative.
 */
function firstNegativePrefix(events: readonly CustodyEvent[]): boolean {
  const byInstant = new Map<number, CustodyEvent[]>();
  for (const e of events) {
    const t = Date.parse(e.date);
    const group = byInstant.get(t) ?? [];
    group.push(e);
    byInstant.set(t, group);
  }
  const running: CustodyEvent[] = [];
  for (const t of [...byInstant.keys()].sort((a, b) => a - b)) {
    running.push(...byInstant.get(t)!);
    const net = replayCustody(running);
    if (CUSTODY_HISTORY_KEYS.some((k) => net[k] < 0)) return true;
  }
  return false;
}

/**
 * A sale's pre-decision-5 untracked loss: the booking moved N units
 * `out → lost/damaged` and the writer emitted neither leg, so the log is short
 * on the loss keys by N and long on `out` by the same N, and nothing else
 * disagrees. Paired, so a sale whose `out` is wrong by any other amount still
 * diverges. Since decision 5 a sale's loss writes `sale_lost`/`sale_damaged`, so
 * a new instance is a finding.
 */
function isUntrackedSaleLoss(deltas: ReplayDeltas): boolean {
  if (Object.keys(deltas).some((k) => k !== "out" && k !== "lost" && k !== "damaged")) return false;
  const short = (["lost", "damaged"] as const).reduce(
    (n, k) => n + (deltas[k] ? deltas[k].stored - deltas[k].replayed : 0),
    0,
  );
  const long = deltas.out ? deltas.out.replayed - deltas.out.stored : 0;
  return short > 0 && short === long;
}

/**
 * Judge one booking's events against its stored breakdown.
 *
 * - `no_events` — no events, real stored keys, and the booking's product IS on
 *   its order: fulfilled before the writers existed.
 * - `substitution_seeded` — no events, and the product is NOT on its order: a
 *   substitution seeded it from another booking's custody.
 * - `partial_history` — some prefix of the log goes negative: events missing
 *   from its front, the cutover boundary.
 * - `sale_untracked_loss` — {@link isUntrackedSaleLoss}.
 * - `service_surcharge` — a type that holds no stock (`ownsKey` owns none of
 *   its departed keys and it takes no custody action).
 *
 * @param orderProducts every product uid on the booking's order, REQUIRED: an
 *   empty set is not a stand-in for an unresolved order, since it would read
 *   every `no_events` booking as a substitution (api-cloudrun#887).
 */
export function classifyReplay(
  booking: { type: ComponentTypeType; breakdown: BookingBreakdown; uid_product: string },
  events: readonly CustodyEvent[],
  orderProducts: ReadonlySet<string>,
): { verdict: ReplayVerdict; deltas: ReplayDeltas } {
  const net = replayCustody(events);
  const deltas: ReplayDeltas = {};
  for (const key of CUSTODY_HISTORY_KEYS) {
    const stored = breakdownQuantity(booking.breakdown, key);
    if (net[key] !== stored) deltas[key] = { stored, replayed: net[key] };
  }
  if (booking.type !== "rental" && booking.type !== "sale") return { verdict: "service_surcharge", deltas };
  if (Object.keys(deltas).length === 0) return { verdict: "ok", deltas };
  if (events.length === 0) {
    return { verdict: orderProducts.has(booking.uid_product) ? "no_events" : "substitution_seeded", deltas };
  }
  if (firstNegativePrefix(events)) return { verdict: "partial_history", deltas };
  if (!ownsKey(booking.type, "out") && isUntrackedSaleLoss(deltas)) return { verdict: "sale_untracked_loss", deltas };
  return { verdict: "diverged", deltas };
}
