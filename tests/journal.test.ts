/**
 * The journal fold (`utils/journal.ts`). The custody-replay cases are carried
 * over verbatim from api-cloudrun's custodyReplay unit test, which tested the
 * same functions before they moved to core (stock campaign P1; the api copy
 * and its test were deleted in P3).
 *
 * Pure — no Firestore, no app boot. These assert the DESIGN's claims rather than
 * the code's behaviour: that the two writer normalizations net out, that the
 * planning keys are excluded on purpose, and that each of the "correctly silent"
 * cases is distinguished from a real divergence. An audit that cannot tell those
 * apart is worse than none, because it trains you to ignore it.
 */
import { assertEquals } from "@std/assert";
import {
  classifyReplay,
  type CustodyEvent,
  custodyByBooking,
  custodyByGrain,
  foldJournal,
  journalOrder,
  type JournalMovement,
  orphanedCustody,
  replayCustody,
  unitsByBooking,
} from "../src/utils/journal.ts";
import { type BookingBreakdown, type BookingBreakdownKeyType, CUSTODY_HISTORY_KEYS } from "../src/schemas/mod.ts";

const FULFILLMENT_KEYS = CUSTODY_HISTORY_KEYS;

function breakdown(over: Partial<BookingBreakdown> = {}): BookingBreakdown {
  return { quoted: 0, reserved: 0, prepped: 0, out: 0, returned: 0, lost: 0, damaged: 0, cleaning: 0, maintenance: 0, ...over };
}

/** Each `ev` lands one minute after the last, so a log reads in the order written. */
let clock = Date.parse("2026-09-01T09:00:00.000-05:00");

function ev(
  from: BookingBreakdownKeyType | null,
  to: BookingBreakdownKeyType | null,
  quantity: number,
  date: string = new Date((clock += 60_000)).toISOString(),
): CustodyEvent {
  return { custody: { from, to }, quantity, date };
}

/**
 * The ordinary case: the booking's product is one the order names, so an empty
 * log means the booking predates the writers.
 */
const PRODUCT = "prod-ordinary";
const ON_ORDER: ReadonlySet<string> = new Set([PRODUCT, "prod-some-other-line"]);

/**
 * A substitution's replacement Y. The order deliberately still names X, so Y's
 * product is absent from `order.items[]` — that absence IS the discriminator.
 */
const REPLACEMENT = "prod-substituted-in";

Deno.test("custodyReplay - the seven fulfillment keys are the ones the order path cannot originate", () => {
  // Not an arbitrary list. `calculateBookingBreakdown` carries exactly these
  // forward verbatim and re-derives only `quoted`/`reserved`, which is what
  // makes the identity exact. If that function ever originates one of these,
  // this audit silently starts lying.
  // `cleaning`/`maintenance` joined with custody-actions P2b: a mark or a flag
  // is their only origin, exactly as for `damaged`.
  assertEquals([...FULFILLMENT_KEYS], ["prepped", "out", "returned", "lost", "damaged", "cleaning", "maintenance"]);
});

Deno.test("custodyReplay - a full prep → check out → return cycle reproduces the breakdown", () => {
  const events = [
    ev("reserved", "prepped", 3),
    ev("prepped", "out", 3),
    ev("out", "returned", 3),
  ];
  const net = replayCustody(events);
  assertEquals(net.prepped, 0);
  assertEquals(net.out, 0);
  assertEquals(net.returned, 3);

  const { verdict } = classifyReplay(
    { type: "rental", breakdown: breakdown({ returned: 3 }), uid_product: PRODUCT },
    events,
    ON_ORDER,
  );
  assertEquals(verdict, "ok");
});

Deno.test("custodyReplay - an un-prepped check-out nets to zero prepped, not to a phantom", () => {
  // The writer normalizes `reserved → out` into `prep` + `check_out` so neither
  // type occurs twice in one session (they would collide on the derived doc id).
  // The intermediate state must never appear in the fold.
  const events = [ev("reserved", "prepped", 2), ev("prepped", "out", 2)];
  assertEquals(replayCustody(events).prepped, 0);
  assertEquals(replayCustody(events).out, 2);
  assertEquals(
    classifyReplay({ type: "rental", breakdown: breakdown({ out: 2 }), uid_product: PRODUCT }, events, ON_ORDER).verdict,
    "ok",
  );
});

Deno.test("custodyReplay - a reversal nets itself out with no special case", () => {
  const events = [ev("prepped", "out", 4), ev("out", "prepped", 4)];
  assertEquals(replayCustody(events).out, 0);
  assertEquals(replayCustody(events).prepped, 0);
});

Deno.test("custodyReplay - a partial return leaves the remainder out", () => {
  // The leading `prep` is not optional padding: `deriveCustodyTransitions` always
  // emits one for units entering `prepped`, so a log that jumps straight to
  // `check_out` describes a booking that cannot exist. Omitting it here drove
  // `prepped` to -5 and the fold correctly refused to call it `ok`.
  const events = [
    ev("reserved", "prepped", 5),
    ev("prepped", "out", 5),
    ev("out", "returned", 2),
    ev("out", "damaged", 1),
  ];
  const net = replayCustody(events);
  assertEquals(net.out, 2);
  assertEquals(net.returned, 2);
  assertEquals(net.damaged, 1);
  assertEquals(
    classifyReplay(
      { type: "rental", breakdown: breakdown({ reserved: 0, out: 2, returned: 2, damaged: 1 }), uid_product: PRODUCT },
      events,
      ON_ORDER,
    ).verdict,
    "ok",
  );
});

Deno.test("custodyReplay - quoted and reserved are NOT compared, by design", () => {
  // A booking sitting entirely at `reserved` has no events and must still be
  // `ok`: the order path put it there and no physical event occurred. Comparing
  // the planning keys would make every un-fulfilled booking a false positive —
  // the failure mode that makes an audit worthless.
  const { verdict, deltas } = classifyReplay(
    { type: "rental", breakdown: breakdown({ reserved: 6 }), uid_product: PRODUCT },
    [],
    ON_ORDER,
  );
  assertEquals(verdict, "ok");
  assertEquals(Object.keys(deltas), []);
});

Deno.test("custodyReplay - a booking whose log is missing an event DIVERGES", () => {
  // Three units were prepped and all three went out, but the log recorded a
  // check-out of only 2. This is the bug report the audit exists to produce —
  // and note it is NOT `partial_history`: nothing folds negative, so the gap is
  // in the middle of the log, not off its front.
  const events = [ev("reserved", "prepped", 3), ev("prepped", "out", 2)];
  const { verdict, deltas } = classifyReplay(
    { type: "rental", breakdown: breakdown({ out: 3 }), uid_product: PRODUCT },
    events,
    ON_ORDER,
  );
  assertEquals(verdict, "diverged");
  assertEquals(deltas.out, { stored: 3, replayed: 2 });
  assertEquals(deltas.prepped, { stored: 0, replayed: 1 });
});

Deno.test("custodyReplay - stored fulfillment state with NO events is history, not a bug", () => {
  // Pre-cutover. Distinct from the case above — that one has a log which fails
  // to reproduce the booking; this one has no log at all because there was none
  // when it was fulfilled.
  const { verdict, deltas } = classifyReplay(
    { type: "rental", breakdown: breakdown({ returned: 4 }), uid_product: PRODUCT },
    [],
    ON_ORDER,
  );
  assertEquals(verdict, "no_events");
  assertEquals(deltas.returned, { stored: 4, replayed: 0 });
});

Deno.test("custodyReplay - a sale's loss in transit emits nothing and is not a divergence", () => {
  // Ownership dropped at the sale, so placing the units at an out-of-service
  // record would drive `quantity_in_service` negative and wedge a legitimate
  // edit shut. The booking records it; there is no inventory event.
  //
  // The signature is PAIRED, and the obvious predicate ("every disagreeing key
  // is lost/damaged") is dead code: the booking moved the unit OUT of `out`, so
  // the log is also long on `out` by exactly the same amount. 5 sold, 2 returned,
  // 1 damaged in transit — the log knows the first two legs and neither of the
  // third, so it reads out=3/damaged=0 against a stored out=2/damaged=1.
  const events = [ev("reserved", "prepped", 5), ev("prepped", "out", 5), ev("out", "returned", 2)];
  const { verdict, deltas } = classifyReplay(
    { type: "sale", breakdown: breakdown({ out: 2, returned: 2, damaged: 1 }), uid_product: PRODUCT },
    events,
    ON_ORDER,
  );
  assertEquals(verdict, "sale_untracked_loss");
  assertEquals(deltas.out, { stored: 2, replayed: 3 });
  assertEquals(deltas.damaged, { stored: 1, replayed: 0 });
});

Deno.test("custodyReplay - a sale whose out is wrong by MORE than its loss still diverges", () => {
  // The exemption requires the two sides to balance. Here the log is long on
  // `out` by 2 while only 1 unit is unaccounted as damaged, so a real error is
  // hiding behind a legitimate silent transition — and must not ride it.
  const events = [ev("reserved", "prepped", 5), ev("prepped", "out", 5), ev("out", "returned", 2)];
  const { verdict } = classifyReplay(
    { type: "sale", breakdown: breakdown({ out: 1, returned: 2, damaged: 1 }), uid_product: PRODUCT },
    events,
    ON_ORDER,
  );
  assertEquals(verdict, "diverged");
});

Deno.test("custodyReplay - a sale diverging on a NON-loss key is still a divergence", () => {
  // The sale exemption is scoped to `lost`/`damaged`. A wrong `out` is a real
  // bug on a sale exactly as it is on a rental, and must not ride the exemption.
  const events = [ev("reserved", "prepped", 5), ev("prepped", "out", 5)];
  const { verdict } = classifyReplay(
    { type: "sale", breakdown: breakdown({ out: 3, damaged: 1 }), uid_product: PRODUCT },
    events,
    ON_ORDER,
  );
  assertEquals(verdict, "diverged");
});

Deno.test("custodyReplay - a NEGATIVE fold is partial history, not a writer bug", () => {
  // A booking prepped before the writers landed and checked out after: the log
  // holds the `check_out` but not the `prep`, so `prepped` folds to -2. That is
  // structurally impossible for a complete log — every unit leaving a key must
  // first have entered it — which localizes the gap to the log's FRONT rather
  // than leaving it ambiguous. Expected during the cutover; a bug report after
  // the migration.
  const events = [ev("prepped", "out", 2)];
  const { verdict, deltas } = classifyReplay(
    { type: "rental", breakdown: breakdown({ out: 2 }), uid_product: PRODUCT },
    events,
    ON_ORDER,
  );
  assertEquals(verdict, "partial_history");
  assertEquals(deltas.prepped, { stored: 0, replayed: -2 });
});

Deno.test("custodyReplay - service and surcharge bookings hold no stock", () => {
  for (const type of ["service", "surcharge"] as const) {
    assertEquals(
      classifyReplay({ type, breakdown: breakdown({ out: 2 }), uid_product: PRODUCT }, [], ON_ORDER).verdict,
      "service_surcharge",
    );
  }
});

Deno.test("custodyReplay - a substitution's replacement is its OWN bucket, not no_events", () => {
  // api-cloudrun#887. A fulfillment substitution releases X's booking and
  // commits Y's, and Y seeds its breakdown from X so custody the picker
  // established survives the swap (#882). Y therefore carries real `prepped`/
  // `out` units against an empty log — structurally identical to a pre-cutover
  // booking, and the two must not share a count: one shrinks to zero and the
  // other grows with picker activity, so a single number cannot be read at all.
  const { verdict, deltas } = classifyReplay(
    { type: "rental", breakdown: breakdown({ out: 3 }), uid_product: REPLACEMENT },
    [],
    ON_ORDER,
  );
  assertEquals(verdict, "substitution_seeded");
  assertEquals(deltas.out, { stored: 3, replayed: 0 });
});

Deno.test("custodyReplay - the discriminator is the PRODUCT, not the empty log", () => {
  // Both arms have no events and the same stored breakdown. The ONLY difference
  // is whether the order names the product — which is what makes this a real
  // split rather than a relabelling. Asserted as a pair, because an arm that
  // agrees with itself would pass if the branch were dropped entirely.
  const stored = breakdown({ prepped: 2, out: 5 });
  assertEquals(
    classifyReplay({ type: "rental", breakdown: stored, uid_product: PRODUCT }, [], ON_ORDER).verdict,
    "no_events",
  );
  assertEquals(
    classifyReplay({ type: "rental", breakdown: stored, uid_product: REPLACEMENT }, [], ON_ORDER)
      .verdict,
    "substitution_seeded",
  );
});

Deno.test("custodyReplay - a replacement whose log DOES fail to reproduce it still diverges", () => {
  // The new bucket is reached only through the empty-log arm. A replacement
  // booking that later acquires events and then disagrees with them is a bug
  // report exactly as any other booking would be — the substitution licence
  // covers the seeding, not everything that happens afterwards.
  const events = [ev("reserved", "prepped", 3), ev("prepped", "out", 2)];
  const { verdict } = classifyReplay(
    { type: "rental", breakdown: breakdown({ out: 3 }), uid_product: REPLACEMENT },
    events,
    ON_ORDER,
  );
  assertEquals(verdict, "diverged");
});

Deno.test("custodyReplay - a booking that reproduces exactly is ok whatever its product", () => {
  // The product test sits BELOW the delta check, so a replacement whose seeded
  // breakdown happens to be all-zero on the fulfillment keys is `ok` and never
  // enters either silent bucket. Guards against moving the branch up, which
  // would inflate `substitution_seeded` with every un-fulfilled replacement.
  const { verdict } = classifyReplay(
    { type: "rental", breakdown: breakdown({ reserved: 4 }), uid_product: REPLACEMENT },
    [],
    ON_ORDER,
  );
  assertEquals(verdict, "ok");
});

Deno.test("custodyReplay - an EMPTY product set is not a safe stand-in for an absent order", () => {
  // ⚠️ The reason `orderProducts` is required and non-nullable. An empty prefix
  // matches nothing, so passing `new Set()` for "I could not read the order"
  // files EVERY pre-cutover booking as a substitution — silently re-creating the
  // conflation this split removed, in the direction that hides the historical
  // count rather than inflating it.
  //
  // This asserts the hazard rather than a guard: the function cannot detect the
  // caller's mistake, so `scripts/audit-custody-replay.ts` counts unresolvable
  // bookings separately and exits non-zero instead of calling in.
  const { verdict } = classifyReplay(
    { type: "rental", breakdown: breakdown({ returned: 4 }), uid_product: PRODUCT },
    [],
    new Set(),
  );
  assertEquals(verdict, "substitution_seeded");
});

// ── A missing front that a later undo cancels (order #1021, found in custody-actions P0) ──

Deno.test("custodyReplay - an event and its own undo with no front is partial_history, not diverged", () => {
  // Units went out before the journal existed (no check_out), then a check-in and
  // its undo were written. The final net is 0 everywhere, so the final-net test
  // alone filed this `diverged`; the prefix after the check-in holds out = -1.
  const events = [
    ev("out", "returned", 1, "2026-09-29T10:00:00.000-05:00"),
    ev("returned", "out", 1, "2026-09-29T10:05:00.000-05:00"),
  ];
  const r = classifyReplay({ type: "rental", breakdown: breakdown({ out: 1 }), uid_product: PRODUCT }, events, ON_ORDER);
  assertEquals(r.verdict, "partial_history");
});

Deno.test("custodyReplay - the prefix walk is by TIME, not by the order the caller read them", () => {
  // Same log as above handed over newest-first: out → returned is still the first
  // instant, so the verdict must not depend on read order.
  const events = [
    ev("returned", "out", 1, "2026-09-29T10:05:00.000-05:00"),
    ev("out", "returned", 1, "2026-09-29T10:00:00.000-05:00"),
  ];
  const r = classifyReplay({ type: "rental", breakdown: breakdown({ out: 1 }), uid_product: PRODUCT }, events, ON_ORDER);
  assertEquals(r.verdict, "partial_history");
});

Deno.test("custodyReplay - one instant folds as one step: check_out before prep in read order is not a gap", () => {
  // An un-prepped check-out writes prep + check_out in one session, one instant.
  // Read check_out first and a per-event walk would see prepped = -2; the whole
  // instant folds first, so a complete log with a real divergence stays diverged.
  const t = "2026-09-29T11:00:00.000-05:00";
  const events = [ev("prepped", "out", 2, t), ev("reserved", "prepped", 2, t)];
  const r = classifyReplay({ type: "rental", breakdown: breakdown({ out: 3 }), uid_product: PRODUCT }, events, ON_ORDER);
  assertEquals(r.verdict, "diverged");
});

// ── journalOrder and the projections (stock campaign P1) ─────────────

const mv = (over: Partial<JournalMovement> & Pick<JournalMovement, "date" | "number">): JournalMovement => ({
  uid: `m${over.number}`,
  uid_booking: "o:p:d",
  custody: null,
  quantity: 1,
  units: [],
  ...over,
});

Deno.test("journalOrder: the instant first, parsed — not the text — then the number", () => {
  // 01:30 CDT is 06:30Z; 01:10 CST (after the fall-back) is 07:10Z. As text the CST one sorts first.
  const cdt = mv({ date: "2026-11-01T01:30:00.000-05:00", number: 9 });
  const cst = mv({ date: "2026-11-01T01:10:00.000-06:00", number: 1 });
  assertEquals([cst, cdt].sort(journalOrder).map((m) => m.number), [9, 1]);
  // One instant: the number decides, which is what takes a rebook_out before its rebook_in.
  const t = "2026-10-08T10:00:00.000-05:00";
  assertEquals([mv({ date: t, number: 5 }), mv({ date: t, number: 4 })].sort(journalOrder).map((m) => m.number), [4, 5]);
});

Deno.test("foldJournal: per booking, per grain, orphaned, and units — one ordered pass", () => {
  const t = (minute: number) => `2026-10-08T10:${String(minute).padStart(2, "0")}:00.000-05:00`;
  const A = "ord:prod:leg";
  const A2 = "ord:prod:leg:sig1";
  const GONE = "ord:prod:leg:sig2";
  const journal = [
    mv({ date: t(3), number: 3, uid_booking: A, custody: { from: "out", to: "returned" }, units: [{ number: 7 }] }),
    mv({ date: t(1), number: 1, uid_booking: A, custody: { from: "reserved", to: "prepped" }, units: [{ number: 7 }] }),
    mv({ date: t(2), number: 2, uid_booking: A, custody: { from: "prepped", to: "out" }, units: [{ number: 7 }] }),
    // A carry moved one returned unit off a deleted id onto A2.
    mv({ date: t(4), number: 4, uid_booking: GONE, custody: { from: null, to: "returned" } }),
    mv({ date: t(5), number: 5, uid_booking: GONE, custody: { from: "returned", to: null } }),
    mv({ date: t(5), number: 6, uid_booking: A2, custody: { from: null, to: "returned" } }),
  ];
  const [byBooking, byGrain, orphans, units] = foldJournal(journal, [
    custodyByBooking(),
    custodyByGrain(),
    orphanedCustody(new Set([A, A2])),
    unitsByBooking(t(2)),
  ] as const);
  assertEquals(byBooking.get(A)!.returned, 1);
  assertEquals(byBooking.get(A)!.prepped, 0);
  assertEquals(byGrain.get("ord:prod:leg")!.returned, 2, "the grain pools every signature");
  assertEquals(orphans.get(GONE)!.returned, 0, "a carried-away id nets to zero");
  assertEquals(orphans.has(A), false);
  // Units folded from t(2): the prep at t(1) is before the cutoff, so 7 starts in no set.
  assertEquals([...(units.get(A)!.returned ?? [])], [7]);
  assertEquals([...(units.get(A)!.out ?? [])], []);
});
