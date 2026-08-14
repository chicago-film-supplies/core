/**
 * The two stock DOCUMENT schemas — `stock/{P}` and `stock-locks/{P}`.
 *
 * Named `stock-doc` rather than `stock` because `tests/stock.test.ts` is already
 * taken by `src/utils/stock.ts`. Every other pair in this repo separates by
 * plurality (`booking.test.ts` schema / `bookings.test.ts` utils), which the
 * stock module cannot do: both files are singular.
 *
 * Several tests here assert the *absence* of a field. That looks like testing
 * nothing — `z.strictObject` refuses any unknown key, so of course they fail —
 * but the point is not the mechanism, it is the decision: `version` and `type`
 * were deliberately dropped from the predecessor document, for reasons written
 * down in `src/schemas/stock.ts`, and a strict object gives no signal at all when
 * someone re-adds one. These make the re-add a red test with a message pointing
 * at the reasoning.
 */
import { assertEquals } from "@std/assert";
import { StockLockSchema, StockSchema } from "../src/schemas/stock.ts";
import { mockTimestamp } from "./helpers/timestamp.ts";

const PRODUCT = "testprod100000000000";

const validStock = {
  uid: PRODUCT,
  uid_product: PRODUCT,
  quantity_held: 20,
  unavailable: [
    {
      start: "2026-03-01T00:00:00.000-06:00",
      end: "2026-03-05T23:59:59.999-06:00",
      quantity: 5,
      kind: "booking",
    },
    {
      start: "2026-03-02T00:00:00.000-06:00",
      end: "2026-03-03T23:59:59.999-06:00",
      quantity: 2,
      kind: "oos",
    },
  ],
  claim_seq: 7,
  created_at: mockTimestamp,
  updated_at: mockTimestamp,
};

const validLock = {
  uid: PRODUCT,
  uid_product: PRODUCT,
  seq: 7,
  created_at: mockTimestamp,
  updated_at: mockTimestamp,
};

Deno.test("StockSchema validates a complete document", () => {
  assertEquals(StockSchema.safeParse(validStock).success, true);
});

Deno.test("StockSchema accepts an empty unavailable list", () => {
  assertEquals(StockSchema.safeParse({ ...validStock, unavailable: [] }).success, true);
});

Deno.test("StockSchema accepts open-ended bounds on either side", () => {
  // `end: null` is the pending-sale case and is the one that must not be
  // coerced; `start: null` is permitted by the Booking schema and means −∞,
  // which under-sells rather than over-sells.
  for (const bound of [{ end: null }, { start: null }, { start: null, end: null }]) {
    const doc = { ...validStock, unavailable: [{ ...validStock.unavailable[0], ...bound }] };
    assertEquals(StockSchema.safeParse(doc).success, true, JSON.stringify(bound));
  }
});

Deno.test("StockSchema rejects a zero-quantity entry — it discloses without affecting an answer", () => {
  for (const quantity of [0, -1]) {
    const doc = { ...validStock, unavailable: [{ ...validStock.unavailable[0], quantity }] };
    assertEquals(StockSchema.safeParse(doc).success, false, `quantity ${quantity}`);
  }
});

Deno.test("StockSchema rejects a fractional entry quantity but ALLOWS a fractional quantity_held", () => {
  // Not an inconsistency. An entry's quantity is a sum of `z.int()` breakdown
  // buckets, so `z.int()` is its real type; `quantity_held` is a copy of
  // `inventory-ledgers/{P}.quantity_held`, which is `z.number().min(0)` — and a
  // projection stricter than its source would refuse to store a value the source
  // permits, failing the rebuild rather than the write that created it.
  assertEquals(
    StockSchema.safeParse({
      ...validStock,
      unavailable: [{ ...validStock.unavailable[0], quantity: 1.5 }],
    }).success,
    false,
  );
  assertEquals(StockSchema.safeParse({ ...validStock, quantity_held: 1.5 }).success, true);
  assertEquals(StockSchema.safeParse({ ...validStock, quantity_held: -1 }).success, false);
});

Deno.test("StockSchema rejects an unknown unavailable kind", () => {
  const doc = { ...validStock, unavailable: [{ ...validStock.unavailable[0], kind: "transfer" }] };
  assertEquals(StockSchema.safeParse(doc).success, false);
});

Deno.test("StockSchema requires a bare date to carry an offset", () => {
  // `chicagoInstant()` rejects `YYYY-MM-DD`. A bare date has no instant, so an
  // interval built from one would silently mean UTC midnight — the wrong Chicago
  // day for six hours of every day.
  const doc = { ...validStock, unavailable: [{ ...validStock.unavailable[0], start: "2026-03-01" }] };
  assertEquals(StockSchema.safeParse(doc).success, false);
});

Deno.test("StockSchema requires claim_seq, and refuses a negative one", () => {
  const { claim_seq: _, ...withoutSeq } = validStock;
  assertEquals(StockSchema.safeParse(withoutSeq).success, false);
  assertEquals(StockSchema.safeParse({ ...validStock, claim_seq: -1 }).success, false);
  assertEquals(StockSchema.safeParse({ ...validStock, claim_seq: 0 }).success, true);
});

Deno.test("StockSchema carries NO version and NO type — both were dropped deliberately", () => {
  // `version`: nothing does optimistic concurrency against availability. The CAS
  // loop guarding a claim is entirely server-side, and the public gate's
  // staleness signal is its 409 carrying the real number.
  assertEquals(
    StockSchema.safeParse({ ...validStock, version: 0 }).success,
    false,
    "a version field is back — read the module header before adding one",
  );
  // `type`: its predecessor denormed the ledger's, and the only thing that ever
  // read it was the audit invariant checking it still matched the ledger.
  assertEquals(
    StockSchema.safeParse({ ...validStock, type: "rental" }).success,
    false,
    "a type field is back — it makes `type_stale` representable again",
  );
});

Deno.test("StockSchema rejects additional properties", () => {
  assertEquals(StockSchema.safeParse({ ...validStock, bogus: true }).success, false);
});

Deno.test("StockLockSchema validates a complete document, and holds nothing but the counter", () => {
  assertEquals(StockLockSchema.safeParse(validLock).success, true);
  assertEquals(StockLockSchema.safeParse({ ...validLock, seq: 0 }).success, true);
  assertEquals(StockLockSchema.safeParse({ ...validLock, seq: -1 }).success, false);
  assertEquals(StockLockSchema.safeParse({ ...validLock, seq: 1.5 }).success, false);
  // The token document is deliberately content-free: anything it carried would
  // be a second thing a claim writer has to keep correct under contention, and
  // the whole point is that the ONLY thing being contended is the counter.
  assertEquals(StockLockSchema.safeParse({ ...validLock, quantity_held: 5 }).success, false);
});

Deno.test("StockLockSchema requires uid and uid_product", () => {
  for (const key of ["uid", "uid_product"] as const) {
    const doc = { ...validLock };
    delete (doc as Record<string, unknown>)[key];
    assertEquals(StockLockSchema.safeParse(doc).success, false, key);
  }
});
