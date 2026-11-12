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
 * ## Two ladders, and a movement's TYPE says which (7a, C10)
 *
 * An outbound booking (an order's, `bookings`) and an inbound one (a
 * purchase's, `bookings-inbound`) keep different breakdowns, and five key
 * spellings (`quoted`, `lost`, `damaged`, the two transit keys) are shared
 * between them with a different place on each. So a custody pair cannot be
 * folded until its LADDER is known, and the ladder is the movement type's
 * `MovementContract.booking_ladder` ({@link movementLadder}) — never the key,
 * never the booking id (the two collections share one id grammar).
 *
 * Every custody projection therefore takes the ladder it folds and SKIPS every
 * movement of the other one: {@link custodyByBooking}, {@link custodyByGrain},
 * {@link orphanedCustody}, {@link unitsByBooking} and {@link replayCustody}.
 * A caller wanting both runs two projections in one {@link foldJournal} pass.
 * The inbound identity is the outbound one over `INBOUND_HISTORY_KEYS`, judged
 * by {@link classifyInboundReplay}.
 *
 * Lifted from api-cloudrun's custodyReplay module (`replayCustody`,
 * `classifyReplay`; deleted there in stock campaign P3), unchanged in behaviour. How the audit judges each verdict
 * (the cutover instant, `booking.created_at`) stays in the audit.
 *
 * @module
 */
import {
  type BookingBreakdown,
  type BookingLadderType,
  type ComponentTypeType,
  CUSTODY_HISTORY_KEYS,
  INBOUND_HISTORY_KEYS,
  type InboundBreakdown,
  MOVEMENT_CONTRACTS,
  type MovementCustodyType,
  type MovementTypeType,
  ownsKey,
} from "../schemas/mod.ts";
import type { FirestoreTimestampType, FirestoreTimestampValue } from "../schemas/common.ts";
import { breakdownQuantity } from "./bookings.ts";
import { parseBookingId } from "./booking-id.ts";
import { foldRosterUnits, RosterFoldError, type RosterMovement, type RosterUnits } from "./units.ts";

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

// ── The two ladders ──────────────────────────────────────────────────

/**
 * A custody-history key of one ladder: what that ladder's replay identity
 * covers. The plan keys are not members — they move with the source document's
 * status, a planning act with no event.
 */
export type LadderHistoryKeyType<L extends BookingLadderType> = L extends "inbound"
  ? typeof INBOUND_HISTORY_KEYS[number]
  : typeof CUSTODY_HISTORY_KEYS[number];

/** Net units per custody-history key of one ladder, all keys stated. */
export type LadderNet<L extends BookingLadderType> = Record<LadderHistoryKeyType<L>, number>;

/** Net units per OUTBOUND custody-history key (`CUSTODY_HISTORY_KEYS`). */
export type CustodyNet = LadderNet<"outbound">;

/** Net units per INBOUND custody-history key (`INBOUND_HISTORY_KEYS`). */
export type InboundCustodyNet = LadderNet<"inbound">;

const HISTORY_KEYS: Readonly<Record<BookingLadderType, readonly string[]>> = {
  outbound: CUSTODY_HISTORY_KEYS,
  inbound: INBOUND_HISTORY_KEYS,
};

const HISTORY_SETS: Readonly<Record<BookingLadderType, ReadonlySet<string>>> = {
  outbound: new Set(CUSTODY_HISTORY_KEYS),
  inbound: new Set(INBOUND_HISTORY_KEYS),
};

/** One ladder's custody-history keys, in its own order. */
export function ladderHistoryKeys<L extends BookingLadderType>(ladder: L): readonly LadderHistoryKeyType<L>[] {
  return HISTORY_KEYS[ladder] as readonly LadderHistoryKeyType<L>[];
}

/**
 * The ladder a movement type's custody pair is on — its contract's
 * `booking_ladder` — or `null` for a type that names no booking. The ONLY way a
 * fold learns the ladder: a key cannot say (five spellings are shared) and a
 * booking id cannot either (one grammar, two collections).
 */
export function movementLadder(type: MovementTypeType): BookingLadderType | null {
  return MOVEMENT_CONTRACTS[type].booking_ladder;
}

function emptyNet<L extends BookingLadderType>(ladder: L): LadderNet<L> {
  const net: Record<string, number> = {};
  for (const k of HISTORY_KEYS[ladder]) net[k] = 0;
  return net as LadderNet<L>;
}

/**
 * Add one custody pair to a net of `ladder`. A key outside that ladder's
 * history (a plan key) contributes nothing on its end. The caller has already
 * established the pair IS of this ladder.
 */
function addCustody(
  net: Record<string, number>,
  ladder: BookingLadderType,
  m: { custody: MovementCustodyType | null; quantity: number },
): void {
  if (!m.custody) return;
  const history = HISTORY_SETS[ladder];
  if (m.custody.to !== null && history.has(m.custody.to)) net[m.custody.to] += m.quantity;
  if (m.custody.from !== null && history.has(m.custody.from)) net[m.custody.from] -= m.quantity;
}

// ── The fold ─────────────────────────────────────────────────────────

/** A movement as the projections read it. */
export interface JournalMovement extends JournalOrdered {
  uid: string;
  /** Its type, which decides the LADDER its custody is on ({@link movementLadder}). */
  type: MovementTypeType;
  uid_booking: string | null;
  /** On either ladder; which one is the type's, never the keys'. */
  custody: MovementCustodyType | null;
  quantity: number;
  /** The units it names, on a serialized product. */
  units: ReadonlyArray<{ number: number }>;
}

/**
 * One thing a journal fold accumulates. `M` is the movement shape it reads:
 * {@link JournalMovement} by default, wider for a projection that needs more of
 * the movement (as {@link unitOutSpells} does).
 */
export interface JournalProjection<S, M extends JournalMovement = JournalMovement> {
  init(): S;
  step(state: S, movement: M): void;
}

/** The states a list of projections produce, in the same order. */
export type ProjectionStates<P extends readonly JournalProjection<unknown, never>[]> = {
  // deno-lint-ignore no-explicit-any
  [K in keyof P]: P[K] extends JournalProjection<infer S, any> ? S : never;
};

/**
 * Fold `movements` once, in {@link journalOrder}, through every projection,
 * and return each projection's state. The input is not mutated or assumed
 * sorted.
 */
export function foldJournal<
  M extends JournalMovement,
  P extends readonly JournalProjection<unknown, M>[],
>(
  movements: readonly M[],
  projections: P,
): ProjectionStates<P> {
  const ordered = [...movements].sort(journalOrder);
  const states = projections.map((p) => p.init());
  for (const m of ordered) projections.forEach((p, i) => p.step(states[i], m));
  return states as ProjectionStates<P>;
}

/** Whether a movement carries custody for a booking on `ladder`. */
function onLadder(m: JournalMovement, ladder: BookingLadderType): m is JournalMovement & { uid_booking: string } {
  return m.uid_booking !== null && m.custody !== null && movementLadder(m.type) === ladder;
}

/** Net custody per booking id on one ladder — the replay of every booking of it at once. */
export function custodyByBooking<L extends BookingLadderType>(
  ladder: L,
): JournalProjection<Map<string, LadderNet<L>>> {
  return {
    init: () => new Map(),
    step(state, m) {
      if (!onLadder(m, ladder)) return;
      const net = state.get(m.uid_booking) ?? emptyNet(ladder);
      addCustody(net, ladder, m);
      state.set(m.uid_booking, net);
    },
  };
}

/**
 * Net custody per GRAIN of one ladder — `(source, product, leg)`, every
 * component signature pooled. A grain carry or a re-key moves custody between
 * the bookings of one grain, so a booking can diverge while its grain
 * conserves. The ladder is part of the grain's identity: an inbound and an
 * outbound grain are never pooled, because each projection folds one ladder.
 */
export function custodyByGrain<L extends BookingLadderType>(
  ladder: L,
): JournalProjection<Map<string, LadderNet<L>>> {
  return {
    init: () => new Map(),
    step(state, m) {
      if (!onLadder(m, ladder)) return;
      const p = parseBookingId(m.uid_booking);
      const grain = p === null ? m.uid_booking : `${p.orderUid}:${p.itemUid}:${p.destUid}`;
      const net = state.get(grain) ?? emptyNet(ladder);
      addCustody(net, ladder, m);
      state.set(grain, net);
    },
  };
}

/**
 * Net custody on one ladder's movements whose booking no longer exists: per
 * booking id, the net its movements leave. A grain carry or a deleted plan-only
 * booking nets to zero or below; a positive bucket is custody nothing holds any
 * more.
 *
 * @param existing the booking ids of THIS ladder's collection — an outbound
 *   movement is never judged against `bookings-inbound`, nor the reverse.
 */
export function orphanedCustody<L extends BookingLadderType>(
  ladder: L,
  existing: ReadonlySet<string>,
): JournalProjection<Map<string, LadderNet<L>>> {
  return {
    init: () => new Map(),
    step(state, m) {
      if (!onLadder(m, ladder) || existing.has(m.uid_booking)) return;
      const net = state.get(m.uid_booking) ?? emptyNet(ladder);
      addCustody(net, ladder, m);
      state.set(m.uid_booking, net);
    },
  };
}

/** Each booking's named units per history key of one ladder, as the journal leaves them. */
export type UnitSetsByKey<L extends BookingLadderType = "outbound"> = Partial<
  Record<LadderHistoryKeyType<L>, Set<number>>
>;

/**
 * Which units each booking of one ladder holds per history key, folded over
 * the WHOLE journal from empty sets. A unit leaves `custody.from`'s set and
 * joins `custody.to`'s.
 *
 * ⚠️ **There is no era cut, and none should come back** (api-cloudrun#1253). A
 * roster interval is journaled (`enroll` / `unenroll`), and numbers are never
 * reused, so a movement naming unit N can only mean that one unit, in whichever
 * interval it was written. An earlier `since` cut the fold by business `date`,
 * which disagreed with the unit replay's `created_at` cut and was then left with
 * nothing to cut at all. If a caller ever needs one interval, derive it from that
 * interval's `enroll`, never from a date.
 */
export function unitsByBooking<L extends BookingLadderType>(
  ladder: L,
): JournalProjection<Map<string, UnitSetsByKey<L>>> {
  const history = HISTORY_SETS[ladder];
  return {
    init: () => new Map(),
    step(state, m) {
      if (!onLadder(m, ladder) || m.units.length === 0) return;
      const sets: Partial<Record<string, Set<number>>> = state.get(m.uid_booking) ?? {};
      const { from, to } = m.custody!;
      for (const { number: n } of m.units) {
        if (from !== null && history.has(from)) sets[from]?.delete(n);
        if (to !== null && history.has(to)) (sets[to] ??= new Set()).add(n);
      }
      state.set(m.uid_booking, sets as UnitSetsByKey<L>);
    },
  };
}

// ── Unit time out ────────────────────────────────────────────────────

/** A movement as {@link unitOutSpells} reads it: the journal fields plus the roster fold's. */
export type UnitJournalMovement = JournalMovement & RosterMovement;

/** One spell a unit spent OUT on one booking. */
export interface UnitOutSpell {
  uid_booking: string;
  /** The `date` of the movement that put it out there. */
  start: string;
  /** The `date` of the movement that took it off that booking; `null` while it is still out. */
  end: string | null;
}

/** A movement the roster fold refused, and why. */
export interface UnitOutFinding {
  uid_movement: string;
  message: string;
  unit: number | null;
}

/** {@link unitOutSpells}' state. */
export interface UnitOutSpells {
  /** Per unit number, its spells out, in journal order. */
  spells: Map<number, UnitOutSpell[]>;
  /** The roster as the fold leaves it. */
  roster: RosterUnits;
  /**
   * Movements the fold refused. Each is skipped — the roster is left as it was
   * — so every spell after a finding on the same unit is approximate, and a
   * caller reporting spells must report these beside them.
   */
  findings: UnitOutFinding[];
}

/**
 * When each unit was physically OUT on a booking — the unit activity report's
 * "days out" (`api-cloudrun/.claude/plans/serialized-subrent.md` § 8).
 *
 * 🔴 **It runs the ROSTER FOLD, not a line rule of its own.** A rule reading
 * lines `to: bookings/B` would miscount three cases `foldRosterUnits` already
 * handles: a lineless `rebook_out`/`rebook_in` pair moves an out unit between
 * bookings with no line at all; an `enroll`'s in-place line `to: bookings/B`
 * seeds a unit `unattributed_out`, which is out on no RECORDED booking and so
 * opens no spell here; and a lineless customer-side step changes nothing. A
 * spell opens when a movement leaves a unit `out` on B and it was not before,
 * and closes when one leaves it anywhere else.
 *
 * ⚠️ **Feed it every movement of the product, not one unit's.** The fold checks
 * every unit a movement names against where the roster has it, so a movement
 * naming units 3001 and 3002, folded without 3002's earlier history, is a
 * finding. A movement names one product's units only, so the union of
 * `query_by_unit_number` over all of a product's units is complete.
 *
 * Folded in {@link journalOrder} by {@link foldJournal} — a business-date
 * question. The live roster was applied in record order, so a backdated
 * movement can be a finding here while the stored roster is fine; that is what
 * `findings` is for.
 */
export function unitOutSpells(): JournalProjection<UnitOutSpells, UnitJournalMovement> {
  return {
    init: () => ({ spells: new Map(), roster: {}, findings: [] }),
    step(state, m) {
      if (m.units.length === 0) return;
      let next: RosterUnits;
      try {
        next = foldRosterUnits(state.roster, m);
      } catch (e) {
        if (!(e instanceof RosterFoldError)) throw e;
        state.findings.push({ uid_movement: m.uid, message: e.message, unit: e.unit });
        return;
      }
      for (const { number: n } of m.units) {
        const before = state.roster[String(n)];
        const after = next[String(n)];
        const was = before?.state === "out" ? before.uid_booking : null;
        const now = after?.state === "out" ? after.uid_booking : null;
        if (was === now) continue;
        const spells = state.spells.get(n) ?? [];
        if (was !== null) {
          const open = spells.findLast((s) => s.uid_booking === was && s.end === null);
          if (open !== undefined) open.end = m.date;
        }
        if (now !== null) spells.push({ uid_booking: now, start: m.date, end: null });
        state.spells.set(n, spells);
      }
      state.roster = next;
    },
  };
}

// ── The custody replay, judged ───────────────────────────────────────

/**
 * One event's custody transition and when it happened: the parts of a movement
 * the replay reads. The replay is handed ONE booking's events, so they are all
 * on that booking's ladder, and the caller names it.
 */
export interface CustodyEvent {
  custody: MovementCustodyType | null;
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
 * Net units the events place in each custody-history key of `ladder`. A
 * `reverses` reversal carries its custody swapped and nets itself out; a
 * planning key on one end contributes only through the other.
 *
 * ⚠️ **Pass one booking's events**, which are on one ladder by construction.
 * The replay cannot check it — a shared spelling (`lost`, `damaged`) folds into
 * whichever ladder is named — so a caller holding a mixed journal partitions it
 * by {@link movementLadder} first, as the projections do.
 */
export function replayCustody<L extends BookingLadderType>(
  events: readonly CustodyEvent[],
  ladder: L,
): LadderNet<L> {
  const net = emptyNet(ladder);
  for (const e of events) addCustody(net, ladder, e);
  return net;
}

/**
 * Whether some prefix of the log, in time order, drives a key negative — a log
 * missing events from its front. Events sharing one instant fold as ONE step
 * first, so no within-instant order can fake a negative.
 *
 * ⭐ **Exported as the lower bound on a BACKDATED custody step** (ruling 76):
 * the replay identity is a sum and order-free, so this is its one
 * order-dependent check, and the api refuses a step whose `date` makes the
 * booking's journal plus the new step fail it — a step dated before the step
 * that filled its source bucket. Pass the booking's events WITH the new one.
 */
export function firstNegativePrefix(events: readonly CustodyEvent[], ladder: BookingLadderType): boolean {
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
    const net: Record<string, number> = replayCustody(running, ladder);
    if (HISTORY_KEYS[ladder].some((k) => net[k] < 0)) return true;
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
  const net = replayCustody(events, "outbound");
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
  if (firstNegativePrefix(events, "outbound")) return { verdict: "partial_history", deltas };
  if (!ownsKey(booking.type, "out") && isUntrackedSaleLoss(deltas)) return { verdict: "sale_untracked_loss", deltas };
  return { verdict: "diverged", deltas };
}

/**
 * How an INBOUND booking's events compare with its stored breakdown: the four
 * verdicts an inbound booking can hold. The outbound-only ones have no inbound
 * meaning — every inbound type is `sale | rental` (no service arm), a
 * substitution never seeds an inbound booking, and an inbound loss has always
 * been a movement (`return_to_supplier`, 0b).
 */
export type InboundReplayVerdict = Extract<ReplayVerdict, "ok" | "no_events" | "partial_history" | "diverged">;

/**
 * Judge one INBOUND booking's events against its stored breakdown — the
 * outbound identity over `INBOUND_HISTORY_KEYS` (7a, C10).
 *
 * - `no_events` — no events and real stored keys: custody the journal never
 *   recorded. Before the inbound cutover that is a booking the backfill (C12)
 *   did not reach; after it, a writer that bypassed the lever.
 * - `partial_history` — some prefix of the log, by time, goes negative.
 * - `diverged` — anything else that disagrees.
 *
 * ⚠️ **A backfilled booking reads `ok` by construction**, because the backfill
 * mints the booking from the buckets and then writes the movements that reach
 * it. `ok` there verifies nothing (0b ruling 4); only a booking minted after
 * the cutover is evidence about the writers. That judgement is the caller's:
 * the cutover instant is per project and lives in api-cloudrun.
 *
 * @param events this booking's events, all on the inbound ladder
 */
export function classifyInboundReplay(
  booking: { breakdown: InboundBreakdown },
  events: readonly CustodyEvent[],
): { verdict: InboundReplayVerdict; deltas: ReplayDeltas } {
  const net = replayCustody(events, "inbound");
  const deltas: ReplayDeltas = {};
  for (const key of INBOUND_HISTORY_KEYS) {
    if (net[key] !== booking.breakdown[key]) deltas[key] = { stored: booking.breakdown[key], replayed: net[key] };
  }
  if (Object.keys(deltas).length === 0) return { verdict: "ok", deltas };
  if (events.length === 0) return { verdict: "no_events", deltas };
  if (firstNegativePrefix(events, "inbound")) return { verdict: "partial_history", deltas };
  return { verdict: "diverged", deltas };
}
