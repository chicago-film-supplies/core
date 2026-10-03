/**
 * Serialized-unit propagation rules — the roster fold, the unit lifecycle, and
 * the two unit-admin routes.
 *
 * Four places hold unit state, each with one job
 * (`api-cloudrun/.claude/plans/serial-tracking.md` § *Architecture*):
 * `transactions.units` are the facts, `bookings.units` and
 * `out-of-service.units` say which units sit in each of their buckets,
 * `unit-rosters/{P}` says where each unit is right now, and `units/{unit-N}`
 * holds the serial and whether the number is in use. These rules are the edges
 * between them.
 *
 * ⚠️ **The roster has ONE fold author and ONE lifecycle author**, exactly as the
 * ledger does. Every movement that names units reaches the roster through the
 * ledger writer's fold (`units:transactions-to-roster`); seeding and deleting a
 * roster belongs to the product lifecycle writer (`units:product-to-roster`), and
 * no other writer touches it.
 *
 * ⚠️ **No `enforced_by` yet, on purpose.** An entry may only name a check that
 * has been opened and read, and the audits that will check these edges
 * (`audit-units`, `audit-unit-replay`) are api-cloudrun P3 work.
 *
 * Traced from: the plan above; api-cloudrun has no unit writer yet.
 */
import type { CollectionRule, PropagationModule, TransactionDefinition } from "./types.ts";

// ── Shared edges, fired by many transactions ────────────────────────
//
// Declared once with the `units:` prefix and no `transaction` field, the
// `stock:` pattern: each firing transaction lists them in its own `steps`.

const sharedRules: CollectionRule[] = [
  {
    id: "units:transactions-to-roster",
    source: "transactions",
    target: "unit-rosters",
    mode: "co-write",
    invariant:
      "A serialized product's roster is the fold of every movement that names its units, and nothing else writes it. The ledger writer (`commitLedgerMovements`) reads `unit-rosters/{P}` once per group where the ledger's stock_method is `serialized`, folds each member's `units` / `lines[].units` with `foldRosterUnits` (@cfs/core/utils/units), and writes it once under its `updateTime` precondition, with its own dirty set: a lineless prep or unprep leaves the LEDGER clean and must still move the roster. A unit that is not where a line's `from` side says refuses the movement. The roster's keys are the product's active numbers exactly, so on a seeded product count(keys) === inventory-ledgers quantity_held.",
    fields: [
      {
        source: ["units"],
        target: ["units"],
        transform:
          "lineless prep / unprep: an unflagged shelf unit becomes `prepped` on the booking where it stands, and back",
      },
      {
        source: ["lines", "units"],
        target: ["units"],
        transform:
          "per line, by its `to` place: outside → removed; bookings/B → `out` on B; out-of-service/R → `away` at R; locations/L → `prepped` when custody lands in prepped, else `shelf` at L carrying the arrival's flag and the record in `sources[]`",
      },
    ],
  },
  {
    id: "units:transactions-to-units",
    source: "transactions",
    target: "units",
    mode: "co-write",
    invariant:
      "An OWNERSHIP movement on a seeded serialized product moves its units' status in the same commit (owner, 2026-10-03). An in-type (purchase, find, make, adjustment_increase, sale_return) activates a vacant number or mints a fresh one; a replacement keeps the number and opens a `replaced` history entry. An out-type (sale, trade_in, adjustment_decrease, write_off) leaves every named number `vacant` and closes its open serial entry — never `retired`, which only an operator sets. A reversal reverses the unit effect, refused when the number has since been reused. Custody movements never touch `units`.",
    fields: [
      {
        source: ["units"],
        target: ["status"],
        transform: "`active` on the way in, `vacant` on the way out",
      },
      {
        source: ["units", "serial_number"],
        target: ["serial_history"],
        transform:
          "in: opens an entry naming this movement in `uid_movement`; out: closes the open entry (`end` = the movement's date)",
      },
      {
        source: ["units", "serial_number"],
        target: ["serial_number"],
        transform: "the open entry's serial, or null once vacant",
      },
    ],
  },
  {
    id: "units:product-to-roster",
    source: "products",
    target: "unit-rosters",
    mode: "co-write",
    invariant:
      "The roster's LIFECYCLE, written only by the product writer (the exempt ledger-lifecycle writer). A product created `serialized`, or converted to it, gets a roster in the same chain; a product converted away from `serialized` has its roster deleted. On a conversion each live booking's `out` units are seeded `unattributed_out`, each open record's flagged and away units `shelf`+flag and `away`, and the rest `shelf` at the default location — including the units of every `prepped` count, which stay untracked on their booking (owner, 2026-10-03).",
    fields: [
      {
        source: ["uid"],
        target: ["uid"],
        transform: "the roster's doc id IS the product uid",
      },
      { source: ["uid"], target: ["uid_product"] },
      {
        source: ["stock_method"],
        target: ["units"],
        transform: "seeded on → serialized, deleted on serialized →",
      },
    ],
  },
  {
    id: "units:product-to-units",
    source: "products",
    target: "units",
    mode: "co-write",
    invariant:
      "Becoming `serialized` creates one `active` unit per held unit, numbered from the product's block — the one writer allowed to create units active, standing in for an `opening_balance`. Leaving it retires every active unit (vacant, then retired). Each step is keyed by the derived unit id, so a re-sent PUT skips what already exists.",
    fields: [
      { source: ["uid"], target: ["uid_product"] },
      {
        source: ["stock_method"],
        target: ["status"],
        transform: "`active` on → serialized; `retired` on serialized →",
      },
    ],
  },
  {
    id: "units:product-to-bookings",
    source: "products",
    target: "bookings",
    mode: "co-write",
    invariant:
      "Seeding stamps `units` with empty sets on every live booking of the product, and leaving `serialized` sets it to `null` on all of them. The stamp is also the seed's serialization point: a lineless prep writes no ledger, so the ledger precondition cannot protect a prep racing the seed — but it writes the booking, so a racing chunk's booking precondition fails and it re-reads a seeded roster.",
    fields: [
      {
        source: ["stock_method"],
        target: ["units"],
        transform: "empty sets on → serialized, null on serialized →",
      },
    ],
  },
];

// ── create-units ────────────────────────────────────────────────────

const createUnitsRule: CollectionRule = {
  id: "create-units:product-to-units",
  source: "products",
  target: "units",
  mode: "co-write",
  transaction: "create-units",
  invariant:
    "Mints VACANT numbers for a product: `count` mode assigns max+1… from the product's block (one completeness-requiring read of the highest number, no counter — a counter would be a second copy of the highest number and env-local while `units` mirrors prod → dev); `explicit` mode takes the numbers given. `tx.create()` on `unit-{n}` refuses a number already taken, since numbers are globally unique. A created number carries no serial: a serial arrives with activation.",
  fields: [
    { source: ["uid"], target: ["uid_product"] },
    {
      source: [],
      target: ["number"],
      transform: "the next numbers in the product's block, or the input's",
    },
    { source: [], target: ["status"], transform: '"vacant"' },
    { source: [], target: ["serial_history"], transform: "[]" },
  ],
};

const createUnitsTransaction: TransactionDefinition = {
  id: "create-units",
  description:
    "POST /products/{uid}/units — mints vacant unit numbers for a serialized product, under `units.create`. A count-mode retry carrying the same uuid_session replays rather than minting a second run. Touches neither the roster nor the ledger: a vacant number is owned by nobody until an ownership movement activates it.",
  steps: ["create-units:product-to-units"],
};

const updateUnitTransaction: TransactionDefinition = {
  id: "update-unit",
  description:
    "PUT /units/{uid} — records, remaps or clears a unit's serial, or retires a vacant number, under `units.update`. Deliberately cascades NOWHERE: a serial remap does not rewrite past movements, whose `units[].serial_number` is a snapshot of the serial in hand when they moved, and retiring touches no roster because a vacant number is not on one.",
  steps: [],
};

// ── Module ──────────────────────────────────────────────────────────
/** Everything `propagation/units.ts` contributes to the propagation catalog. */
export const units: PropagationModule = {
  rules: [...sharedRules, createUnitsRule],
  transactions: [createUnitsTransaction, updateUnitTransaction],
};
