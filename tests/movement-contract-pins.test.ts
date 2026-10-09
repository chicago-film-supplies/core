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

Deno.test("pins: every pre-campaign contract is unchanged, field for field", () => {
  for (const [t, pinned] of Object.entries(pins.contracts)) {
    const type = t as (typeof MOVEMENT_TYPES)[number];
    const { undoes: _undoes, ...rest } = MOVEMENT_CONTRACTS[type] as unknown as Record<string, unknown>;
    assertEquals(
      strip({ ...rest, multiplier: getTransactionMultiplier(type), hasCosts: hasCosts(type) }),
      pinned,
      t,
    );
  }
});

Deno.test("pins: xeroPostingFor answers every pre-campaign input exactly as before", () => {
  let checked = 0;
  for (const [key, pinned] of Object.entries(pins.xero)) {
    const [t, p, c, d] = key.split("|");
    const num = (s: string) => (s === "null" ? null : Number(s));
    let out: unknown;
    try {
      out = xeroPostingFor(t as never, p as never, num(c), num(d));
    } catch (e) {
      out = { threw: (e as Error).message };
    }
    assertEquals(strip(out), pinned, key);
    checked++;
  }
  assertEquals(checked, 32 * 64, "4 product types × 4 costs × 4 deltas per type");
});
