/**
 * Byte-for-byte pins on every movement type that existed BEFORE the stock
 * campaign's `undoes` change (P1, api-cloudrun#1240).
 *
 * `tests/fixtures/movement-contract-pins.json` was captured from the code as it
 * stood before the change: every field of `MOVEMENT_CONTRACTS[t]` plus its
 * multiplier and `hasCosts`, and `xeroPostingFor` over every (type, product
 * type, cost, held delta) combination. Deriving the undo contracts by mirroring,
 * and teaching `xeroPostingFor` about typed reversals, must leave every one of
 * those answers unchanged — a Xero posting that moves is a live-ledger change
 * with no dev tenant.
 *
 * The fixture is the oracle and is never regenerated to make this pass. A type
 * added later is simply absent from it; a type REMOVED fails the coverage arm.
 */
import { assert, assertEquals } from "@std/assert";
import { getTransactionMultiplier, hasCosts, MOVEMENT_CONTRACTS, MOVEMENT_TYPES } from "../src/schemas/mod.ts";
import { xeroPostingFor } from "../src/utils/movements.ts";

const pins = JSON.parse(
  Deno.readTextFileSync(new URL("./fixtures/movement-contract-pins.json", import.meta.url)),
) as { contracts: Record<string, unknown>; xero: Record<string, unknown> };

const strip = (v: unknown) => JSON.parse(JSON.stringify(v));

Deno.test("pins: every pre-campaign movement type still exists", () => {
  const types = Object.keys(pins.contracts);
  assertEquals(types.length, 32, "the fixture is the full pre-campaign vocabulary");
  for (const t of types) assert((MOVEMENT_TYPES as readonly string[]).includes(t), `${t} was removed`);
});

/**
 * Contract changes made DELIBERATELY after the fixture was captured, each by an
 * owner ruling. The fixture stays the oracle for everything else: a ruled change
 * is stated here with its reason, never regenerated into the fixture, so a
 * change nobody ruled on still fails.
 */
const RULED_CHANGES: Record<string, { fields: Record<string, unknown>; why: string }> = {
  prep: {
    fields: { places: { from: ["locations"], to: ["locations"] } },
    why: "api-cloudrun#1302 ruling 1: prep moves units shelf → a staging location",
  },
  unprep: {
    fields: { places: { from: ["locations"], to: ["locations"] } },
    why: "api-cloudrun#1302: the mirror of prep, staging → shelf",
  },
  transfer: {
    fields: { booking: "optional" },
    why: "api-cloudrun#1302 ruling 9: a restage is a transfer naming its booking",
  },
};

Deno.test("pins: every pre-campaign contract is unchanged, field for field, except the ruled changes", () => {
  for (const [t, pinned] of Object.entries(pins.contracts)) {
    const type = t as (typeof MOVEMENT_TYPES)[number];
    const { undoes: _undoes, ...rest } = MOVEMENT_CONTRACTS[type];
    const ruled = RULED_CHANGES[t];
    assertEquals(
      strip({ ...rest, multiplier: getTransactionMultiplier(type), hasCosts: hasCosts(type) }),
      ruled ? { ...(pinned as Record<string, unknown>), ...ruled.fields } : pinned,
      ruled ? `${t} (ruled: ${ruled.why})` : t,
    );
  }
});

/**
 * Types whose `xeroPostingFor` answers changed DELIBERATELY after the fixture was
 * captured, by an owner ruling. Every input of a ruled type must differ from the
 * fixture — all of a reclass's moved off `manual` — and its new answers are
 * pinned by its own tests.
 */
const RULED_XERO: Record<string, { why: string }> = {
  reclass_out: { why: "api-cloudrun#1068, owner ruling 2026-10-13: each reclass half posts on its own account" },
  reclass_in: { why: "api-cloudrun#1068, owner ruling 2026-10-13: each reclass half posts on its own account" },
};

/**
 * Single INPUTS whose answer changed by a ruling narrower than a whole type.
 * Unlike {@link RULED_XERO}, each matched input is pinned to its exact NEW answer
 * here, and the number of matched inputs is asserted, so the ruling can neither
 * spread to a neighbouring row nor match nothing.
 */
const RULED_XERO_INPUTS: {
  matches: (t: string, p: string, c: number | null, d: number | null) => boolean;
  expected: unknown;
  count: number;
  why: string;
}[] = [{
  // The reversal of a rental increase through 2510 — a no-refund `sale_return`
  // (cost null or 0) included — posts its forward's mirror.
  matches: (t, p, c, d) =>
    p === "rental" && d === -1 &&
    (["find", "make", "adjustment_increase"].includes(t) || (t === "sale_return" && !c)),
  expected: { kind: "bill", asset_account: 1999, offset_account: 2510, direction: -1, zero_total: true },
  count: 3 * 4 + 2,
  why: "api-cloudrun#1317: a reversed rental increase posts DR 2510 / CR 1999",
}];

Deno.test("pins: every ruled change still differs from the fixture (no dead entry)", () => {
  for (const [t, ruled] of Object.entries(RULED_CHANGES)) {
    const pinned = pins.contracts[t] as Record<string, unknown> | undefined;
    assert(pinned, `${t} is not a pre-campaign type`);
    for (const [field, value] of Object.entries(ruled.fields)) {
      assert(JSON.stringify(pinned[field]) !== JSON.stringify(value), `${t}.${field} already matched the fixture`);
    }
  }
});

Deno.test("pins: xeroPostingFor answers every pre-campaign input exactly as before", () => {
  let checked = 0;
  const inputHits = new Map<(typeof RULED_XERO_INPUTS)[number], number>();
  for (const [key, pinned] of Object.entries(pins.xero)) {
    const [t, p, c, d] = key.split("|");
    const num = (s: string) => (s === "null" ? null : Number(s));
    let out: unknown;
    try {
      out = xeroPostingFor(t as never, p as never, num(c), num(d));
    } catch (e) {
      out = { threw: (e as Error).message };
    }
    const ruled = RULED_XERO[t];
    const ruledInput = RULED_XERO_INPUTS.find((r) => r.matches(t, p, num(c), num(d)));
    if (ruledInput) {
      assert(JSON.stringify(strip(pinned)) !== JSON.stringify(ruledInput.expected), `${key} already matched`);
      assertEquals(strip(out), ruledInput.expected, `${key} (ruled: ${ruledInput.why})`);
      inputHits.set(ruledInput, (inputHits.get(ruledInput) ?? 0) + 1);
    } else if (ruled) {
      // A ruled type is pinned by its own tests (`tests/xero-posting.test.ts`);
      // here it must merely have MOVED, so the fixture's old answer cannot
      // come back unnoticed.
      assert(JSON.stringify(strip(out)) !== JSON.stringify(pinned), `${key} (ruled: ${ruled.why})`);
    } else {
      assertEquals(strip(out), pinned, key);
    }
    checked++;
  }
  assertEquals(checked, 32 * 64, "4 product types × 4 costs × 4 deltas per type");
  for (const r of RULED_XERO_INPUTS) assertEquals(inputHits.get(r) ?? 0, r.count, r.why);
});
