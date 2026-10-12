/**
 * The kit ratio rule (core#131): `componentQuantityAt`, `kitCutQuantities`,
 * `rescaleKitSubtree` (moved from manager `utils/kitQuantity.ts`, manager#639
 * item 4) and `isDirectComponent`.
 *
 * Every hand-written expectation is worked from the ratios in the comment beside
 * it — never computed by the helper under test. The sweeps are seeded so a
 * failure names a reproducible draw.
 */
import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  componentQuantities,
  componentQuantityAt,
  isDirectComponent,
  kitCutQuantities,
  rescaleKitSubtree,
} from "../src/utils/order-lines.ts";

/** Deterministic PRNG (the `tests/purchases.test.ts` one). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Row = { uid: string; type: string; path: string[]; quantity?: number; quantity_per_parent?: number | null };

const dest = (uid: string): Row => ({ uid, type: "destination", path: [uid] });
const group = (uid: string, d: string): Row => ({ uid, type: "group", path: [d, uid] });
const line = (path: string[], quantity: number, quantity_per_parent?: number | null): Row => ({
  uid: path.at(-1)!,
  type: "rental",
  path,
  quantity,
  ...(quantity_per_parent !== undefined ? { quantity_per_parent } : {}),
});

const qtys = (rows: Row[]) => rows.map((r) => r.quantity);
const cut = (rows: Row[], kitIndex: number, k: number) => {
  const m = kitCutQuantities(rows, kitIndex, k);
  return rows.map((_, i) => m.get(i));
};

// ── componentQuantityAt ──────────────────────────────────────────

const SWEEP = 200_000;

Deno.test("componentQuantityAt: matches exact integer ceil over 200k random 4 dp ratios", () => {
  const rand = mulberry32(131);
  for (let i = 0; i < SWEEP; i++) {
    const m = Math.floor(rand() * 50_001); // ratio = m / 1e4, 0 … 5
    const p = Math.floor(rand() * 1_001);
    const expected = Number((BigInt(m) * BigInt(p) + 9_999n) / 10_000n);
    const got = componentQuantityAt(m / 10_000, p);
    if (got !== expected) throw new Error(`draw ${i}: ratio ${m / 10_000} × ${p} → ${got}, expected ${expected}`);
  }
});

Deno.test("componentQuantityAt: …and the float form `Math.ceil(r × p)` DOES disagree", () => {
  // The companion: an oracle that agrees with the implementation proves nothing
  // unless the naive form is shown to fail on the same draw.
  assertEquals(Math.ceil(0.07 * 100), 8);
  assertEquals(componentQuantityAt(0.07, 100), 7);
  const rand = mulberry32(131);
  let disagreements = 0;
  for (let i = 0; i < SWEEP; i++) {
    const m = Math.floor(rand() * 50_001);
    const p = Math.floor(rand() * 1_001);
    const expected = Number((BigInt(m) * BigInt(p) + 9_999n) / 10_000n);
    if (Math.ceil((m / 10_000) * p) !== expected) disagreements++;
  }
  assert(disagreements > 0, "the float form never disagreed — the sweep cannot tell the two apart");
});

Deno.test("componentQuantityAt: owner's worked ratios", () => {
  // 2 mirrors per case → case is 0.5 on the mirror: 1→1, 2→1, 3→2.
  assertEquals([1, 2, 3].map((n) => componentQuantityAt(0.5, n)), [1, 1, 2]);
  // 0 = optional: always 0.
  assertEquals(componentQuantityAt(0, 9), 0);
  // 1.01 is the fence-post rule: n sections need n + 1 posts, for n ≤ 100.
  assertEquals([1, 6, 100].map((n) => componentQuantityAt(1.01, n)), [2, 7, 101]);
});

Deno.test("componentQuantityAt: refuses a negative ratio and a non-integer parent", () => {
  assertThrows(() => componentQuantityAt(-0.5, 2), RangeError);
  assertThrows(() => componentQuantityAt(Number.NaN, 2), RangeError);
  assertThrows(() => componentQuantityAt(0.5, 1.5), RangeError);
  assertThrows(() => componentQuantityAt(0.5, -1), RangeError);
});

Deno.test("componentQuantities: expands through componentQuantityAt (0.07 × 100 is 7, not 8)", () => {
  const out = componentQuantities("K", [{ uid: "C", type: "rental", path: ["K"], quantity: 0.07, inclusion_type: "default" }], 100);
  assertEquals(out.map((o) => o.quantity), [7]);
});

// ── isDirectComponent ────────────────────────────────────────────

Deno.test("isDirectComponent: a path of length ≤ 1 is a direct child, whatever it names", () => {
  assertEquals(isDirectComponent({ path: ["ROOT"] }), true);
  assertEquals(isDirectComponent({ path: ["SELF"] }), true); // the live prod self-naming row
  assertEquals(isDirectComponent({ path: [] }), true);
  assertEquals(isDirectComponent({}), true);
  assertEquals(isDirectComponent({ path: ["ROOT", "SUB"] }), false);
});

// ── kitCutQuantities ─────────────────────────────────────────────

Deno.test("kitCutQuantities: a stamped packing ratio moves its container with the FIRST cut", () => {
  // Kit of 5, mirrors 1 per kit (5), cases 0.5 per mirror (3).
  // Cut 2 of 5: mirrors ceil(1 × 2) = 2, cases min(3, ceil(0.5 × 2)) = 1.
  // Cut 3 of 5: mirrors 3, cases ceil(1.5) = 2. The remainder of a 3-cut keeps
  // 2 mirrors and 1 case — whole; of a 1-cut, 4 mirrors and 2 cases — whole.
  const items = [dest("D"), line(["D", "K"], 5), line(["D", "K", "M"], 5, 1), line(["D", "K", "M", "C"], 3, 0.5)];
  assertEquals(cut(items, 1, 2), [undefined, 2, 2, 1]);
  assertEquals(cut(items, 1, 3), [undefined, 3, 3, 2]);
  assertEquals(cut(items, 1, 1), [undefined, 1, 1, 1]);
});

Deno.test("kitCutQuantities: a hand-edited line moves proportionally, rounded up", () => {
  // Stamp 2 says 10 at K = 5; the operator typed 7. Cut 2 of 5 → ceil(7 × 2 / 5) = 3.
  const items = [dest("D"), line(["D", "K"], 5), line(["D", "K", "B"], 7, 2)];
  assertEquals(cut(items, 1, 2), [undefined, 2, 3]);
});

Deno.test("kitCutQuantities: a pre-stamp line (no key, or null) moves proportionally", () => {
  // 1 case for 5 mirrors read by proportion: ceil(1 × 2 / 5) = 1; 4 cables: ceil(8 / 5) = 2.
  const items = [dest("D"), line(["D", "K"], 5), line(["D", "K", "C"], 1), line(["D", "K", "X"], 4, null)];
  assertEquals(cut(items, 1, 2), [undefined, 2, 1, 2]);
});

Deno.test("kitCutQuantities: a raised optional (stamp 0) moves proportionally", () => {
  // Stamp 0 says 0; the operator raised it to 5. Cut 3 of 5 → ceil(5 × 3 / 5) = 3.
  const items = [dest("D"), line(["D", "K"], 5), line(["D", "K", "O"], 5, 0)];
  assertEquals(cut(items, 1, 3), [undefined, 3, 3]);
});

Deno.test("kitCutQuantities: a full cut moves every line in full, hand edits included", () => {
  // B is hand-edited ABOVE its ratio (stamp 1 says 5, it holds 9). Proportional
  // would give 9 too, but a stamped-match child under it must also move whole.
  const items = [dest("D"), line(["D", "K"], 5), line(["D", "K", "B"], 9, 1), line(["D", "K", "B", "C"], 2, 0.25)];
  assertEquals(cut(items, 1, 5), [undefined, 5, 9, 2]);
});

Deno.test("kitCutQuantities: cascades — a sub-kit's moved count is its children's k", () => {
  // K 4 → S stamp 0.5 (2) → T stamp 3 (6). Cut 3 of 4: S = ceil(1.5) = 2 = all
  // of S, so T moves in full (6). Cut 1 of 4: S = 1, T = ceil(3 × 1) = 3.
  const items = [dest("D"), line(["D", "K"], 4), line(["D", "K", "S"], 2, 0.5), line(["D", "K", "S", "T"], 6, 3)];
  assertEquals(cut(items, 1, 3), [undefined, 3, 2, 6]);
  assertEquals(cut(items, 1, 1), [undefined, 1, 1, 3]);
});

Deno.test("kitCutQuantities: covers the kit's subtree only — not the next sibling's", () => {
  const items = [dest("D"), group("G", "D"), line(["D", "G", "K"], 2), line(["D", "G", "K", "B"], 2, 1), line(["D", "G", "Z"], 2), line(["D", "G", "Z", "B"], 2, 1)];
  assertEquals(cut(items, 2, 1), [undefined, undefined, 1, 1, undefined, undefined]);
});

Deno.test("kitCutQuantities: refuses a divider, an out-of-range or fractional k, and an orphaned row", () => {
  const items = [dest("D"), line(["D", "K"], 2), line(["D", "K", "B"], 2, 1)];
  assertThrows(() => kitCutQuantities(items, 0, 1), RangeError);
  assertThrows(() => kitCutQuantities(items, 1, 3), RangeError);
  assertThrows(() => kitCutQuantities(items, 1, -1), RangeError);
  assertThrows(() => kitCutQuantities(items, 1, 0.5), RangeError);
  const orphan = [dest("D"), line(["D", "K"], 2), line(["D", "K", "MISSING", "B"], 2, 1)];
  assertThrows(() => kitCutQuantities(orphan, 1, 1), Error, "no parent row");
});

/** A random kit: up to 3 levels, mixed stamped / hand-edited / pre-stamp / optional lines. */
function randomKit(rand: () => number): Row[] {
  const RATIOS = [0, 0.04, 0.125, 0.25, 0.5, 1, 1.01, 2, 3];
  const n = 1 + Math.floor(rand() * 12);
  const rows: Row[] = [dest("D"), line(["D", "K"], n)];
  let uid = 0;
  const grow = (parentPath: string[], parentQty: number, depth: number) => {
    const children = depth >= 3 ? 0 : Math.floor(rand() * 4);
    for (let c = 0; c < children; c++) {
      const path = [...parentPath, `c${uid++}`];
      const r = rand() < 0.8 ? RATIOS[Math.floor(rand() * RATIOS.length)] : Math.floor(rand() * 50_000) / 10_000;
      const kind = rand();
      let q: number;
      let stamp: number | null | undefined = r;
      if (kind < 0.6) q = componentQuantityAt(r, parentQty); // follows its stamp
      else if (kind < 0.8) q = Math.floor(rand() * 20); // hand edit
      else if (kind < 0.9) [q, stamp] = [Math.floor(rand() * 20), null];
      else [q, stamp] = [Math.floor(rand() * 20), undefined]; // pre-stamp: no key
      rows.push(line(path, q, stamp));
      grow(path, q, depth + 1);
    }
  };
  grow(["D", "K"], n, 0);
  return rows;
}

Deno.test("kitCutQuantities: sweep — moved ≤ q, a full cut moves q, moved is monotone in k, two cuts summing to n move q", () => {
  const rand = mulberry32(2026_10_11);
  for (let draw = 0; draw < 3_000; draw++) {
    const items = randomKit(rand);
    const n = items[1].quantity!;
    let prev: Map<number, number> | null = null;
    for (let k = 0; k <= n; k++) {
      const moved = kitCutQuantities(items, 1, k);
      for (const [i, m] of moved) {
        const q = items[i].quantity!;
        if (m > q || m < 0) throw new Error(`draw ${draw}, k ${k}: items[${i}] moved ${m} of ${q}`);
        if (k === n && m !== q) throw new Error(`draw ${draw}: full cut moved ${m} of ${q} at items[${i}]`);
        if (prev && m < prev.get(i)!) throw new Error(`draw ${draw}: items[${i}] moved ${m} at k ${k}, ${prev.get(i)} at k ${k - 1}`);
      }
      prev = moved;

      // The remainder document, cut by the rest: every line's two moves add up to q.
      const remainder = items.map((row, i) => (moved.has(i) ? { ...row, quantity: row.quantity! - moved.get(i)! } : row));
      const rest = kitCutQuantities(remainder, 1, n - k);
      for (const [i, m] of moved) {
        if (m + rest.get(i)! !== items[i].quantity) {
          throw new Error(`draw ${draw}, k ${k}: items[${i}] moved ${m} + ${rest.get(i)} ≠ ${items[i].quantity}`);
        }
      }
    }
  }
});

// ── rescaleKitSubtree (moved from manager; reads the stamp since Phase 3) ──

Deno.test("rescaleKitSubtree: scales by the stamped ratio, not proportionally", () => {
  // ratio 0.5: at A=1 the child is ceil(0.5) = 1; at A=3 it is ceil(1.5) = 2.
  const items = [dest("D"), line(["D", "A"], 1, null), line(["D", "A", "B"], 1, 0.5)];
  assertEquals(qtys(rescaleKitSubtree(items, 1, 3)), [undefined, 3, 2]);
});

Deno.test("rescaleKitSubtree: keeps a hand-edited child", () => {
  // ratio 2 at A=1 is 2; the line says 5, so it is a hand edit.
  const items = [dest("D"), line(["D", "A"], 1, null), line(["D", "A", "B"], 5, 2)];
  assertEquals(qtys(rescaleKitSubtree(items, 1, 2)), [undefined, 2, 5]);
});

Deno.test("rescaleKitSubtree: scales each level off its direct parent", () => {
  // A(1) → B ratio 2 → C ratio 3: B = 2, C = 6. A → 2: B = 4, C = 12.
  const items = [dest("D"), line(["D", "A"], 1, null), line(["D", "A", "B"], 2, 2), line(["D", "A", "B", "C"], 6, 3)];
  assertEquals(qtys(rescaleKitSubtree(items, 1, 2)), [undefined, 2, 4, 12]);
});

Deno.test("rescaleKitSubtree: rescales only below an edited sub-kit", () => {
  // B 2 → 3 under ratio-3 C: C 6 → 9. A is above the edit and stays.
  const items = [dest("D"), line(["D", "A"], 1, null), line(["D", "A", "B"], 2, 2), line(["D", "A", "B", "C"], 6, 3)];
  assertEquals(qtys(rescaleKitSubtree(items, 2, 3)), [undefined, 1, 3, 9]);
});

Deno.test("rescaleKitSubtree: leaves a grandchild alone when its parent was an override that stayed put", () => {
  // B is 7 (ratio 2 says 2), so B keeps 7, and C's parent did not move.
  const items = [dest("D"), line(["D", "A"], 1, null), line(["D", "A", "B"], 7, 2), line(["D", "A", "B", "C"], 6, 3)];
  assertEquals(qtys(rescaleKitSubtree(items, 1, 2)), [undefined, 2, 7, 6]);
});

Deno.test("rescaleKitSubtree: keeps a pre-stamp child (null or absent), and a zero-ratio one at zero", () => {
  // X null, Y absent: no ratio, no catalog fallback. B ratio 0 stays 0 at any A.
  const items = [
    dest("D"),
    line(["D", "A"], 1, null),
    line(["D", "A", "X"], 1, null),
    line(["D", "A", "Y"], 1),
    line(["D", "A", "B"], 0, 0),
  ];
  assertEquals(qtys(rescaleKitSubtree(items, 1, 3)), [undefined, 3, 1, 1, 0]);
});

Deno.test("rescaleKitSubtree: a raised optional (ratio 0, quantity > 0) is a hand edit", () => {
  // ceil(0 × 1) = 0, the line says 2: it keeps 2.
  const items = [dest("D"), line(["D", "A"], 1, null), line(["D", "A", "B"], 2, 0)];
  assertEquals(qtys(rescaleKitSubtree(items, 1, 4)), [undefined, 4, 2]);
});

Deno.test("rescaleKitSubtree: changes nothing when the quantity is unchanged", () => {
  const items = [dest("D"), line(["D", "A"], 2, null), line(["D", "A", "B"], 9, 2)];
  const out = rescaleKitSubtree(items, 1, 2);
  assertEquals(qtys(out), [undefined, 2, 9]);
  assert(out[2] === items[2]);
});

Deno.test("rescaleKitSubtree: the same uid under two sub-kits follows each one's own stamp", () => {
  // X under B (ratio 1) and under C (ratio 4). A 1 → 2: X|B 1 → 2, X|C 4 → 8.
  const items = [
    dest("D"),
    line(["D", "A"], 1, null),
    line(["D", "A", "B"], 1, 1),
    line(["D", "A", "B", "X"], 1, 1),
    line(["D", "A", "C"], 1, 1),
    line(["D", "A", "C", "X"], 4, 4),
  ];
  assertEquals(qtys(rescaleKitSubtree(items, 1, 2)), [undefined, 2, 2, 2, 2, 8]);
});

Deno.test("rescaleKitSubtree: rounds at the 1e4 scale — 0.07 × 100 is 7, not 8", () => {
  // A 1 → 100: ceil(0.07) = 1 → exactly 7 (the float form reads 7.000000000000001 and ceils to 8).
  const items = [dest("D"), line(["D", "A"], 1, null), line(["D", "A", "B"], 1, 0.07)];
  assertEquals(qtys(rescaleKitSubtree(items, 1, 100)), [undefined, 100, 7]);
});

Deno.test("rescaleKitSubtree: does not touch the next sibling's subtree", () => {
  const items = [
    dest("D"),
    line(["D", "A"], 1, null),
    line(["D", "A", "B"], 2, 2),
    line(["D", "Z"], 1, null),
    line(["D", "Z", "B"], 2, 2),
  ];
  assertEquals(qtys(rescaleKitSubtree(items, 1, 2)), [undefined, 2, 4, 1, 2]);
});
