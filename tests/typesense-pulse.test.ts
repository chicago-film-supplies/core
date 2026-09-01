/**
 * The Typesense sync pulse — **can the writer and the reader disagree about the
 * key?**
 *
 * The pulse's whole failure mode is silence. A key the writer mints and the
 * reader does not recognise produces no error, no empty state and no red test:
 * the table simply stops refreshing, and the only symptom is stale data that
 * looks like data. So the arms here are about the round trip and the shard
 * range, not about the token.
 */
import { assertEquals, assertNotEquals } from "@std/assert";

import {
  PULSE_COLLECTION,
  PULSE_TOKEN_FIELD,
  pulseCollectionForAlias,
  pulseCollectionOf,
  pulseDocId,
  pulseDocIdForDocument,
  pulseShardIds,
  pulseShardsFor,
  typesenseSchemas,
} from "../src/schemas/typesense/mod.ts";

// ── The round trip: mint then parse, for every collection ────────────

Deno.test("pulse: every minted id parses back to the collection that minted it", () => {
  // The one property that makes the two sides safe. Run over every registered
  // config rather than a sample, because a collection name containing the
  // separator would break exactly one collection and nothing else.
  const broken: string[] = [];
  for (const config of Object.values(typesenseSchemas)) {
    for (const shard of [0, 1, 7, 42]) {
      const id = pulseDocId(config.firestoreCollection, shard);
      const back = pulseCollectionOf(id);
      if (back !== config.firestoreCollection) broken.push(`${id} → ${back}`);
    }
  }
  assertEquals(broken.sort(), [], `Pulse ids that do not round-trip:\n${broken.join("\n")}`);
});

Deno.test("pulse: an alias resolves to the key the writer would use", () => {
  // The §1f hole, stated as a test rather than as an assumption. Today every
  // alias equals its `firestoreCollection`, so this passes trivially — and that
  // is the point: it will keep passing when one of them diverges, because the
  // client asks instead of assuming.
  const broken: string[] = [];
  for (const [alias, config] of Object.entries(typesenseSchemas)) {
    const key = pulseCollectionForAlias(alias);
    if (key !== config.firestoreCollection) broken.push(`${alias} → ${key}`);
  }
  assertEquals(broken.sort(), [], `Aliases resolving to the wrong pulse key:\n${broken.join("\n")}`);
});

Deno.test("pulse: an unknown alias yields null rather than a key nothing writes", () => {
  assertEquals(pulseCollectionForAlias("not-a-collection"), null);
});

// ── Shards: declared, in range, and uniform at zero ──────────────────

Deno.test("pulse: every registered collection declares a shard count", () => {
  // Lazily-created pulse docs are the silent half of this design: a collection
  // with no declaration reads as `undefined` on the client, its
  // changed-after-mount guard never fires, and its tables never auto-refresh.
  // The runtime half is api-cloudrun's provisioning; this is the static half.
  const undeclared = Object.values(typesenseSchemas)
    .filter((c) => c.pulseShards === undefined)
    .map((c) => c.alias)
    .sort();
  assertEquals(
    undeclared,
    [],
    "These collections declare no `pulseShards`, so nothing chose their pulse " +
      "cardinality:\n" + undeclared.join("\n"),
  );
});

Deno.test("pulse: shard ids are contiguous from 0 and match the declared count", () => {
  for (const config of Object.values(typesenseSchemas)) {
    const ids = pulseShardIds(config.firestoreCollection);
    assertEquals(ids.length, pulseShardsFor(config.firestoreCollection), config.alias);
    assertEquals(
      ids,
      ids.map((_, i) => pulseDocId(config.firestoreCollection, i)),
      `${config.alias}: shard ids must be 0..n-1`,
    );
  }
});

Deno.test("pulse: shard 0 is spelled with its suffix, so the reader needs no special case", () => {
  // A single-shard collection is the one that would tempt a bare
  // `{collection}` id, and it is exactly the case where the client's suffix
  // strip would then have to branch.
  assertEquals(pulseDocId("products", 0), "products~0");
  assertEquals(pulseShardIds("products"), ["products~0"]);
  assertEquals(pulseCollectionOf("products~0"), "products");
});

// ── Selection: in range, deterministic, and spread ───────────────────

Deno.test("pulse: a document always selects a shard the collection actually has", () => {
  // The reason the writer's door mints rather than returning an index: an
  // out-of-range shard writes a document nothing provisions, nothing reaps and
  // no audit expects.
  const legal = new Set(pulseShardIds("bookings"));
  const out: string[] = [];
  for (let i = 0; i < 5_000; i++) {
    const id = pulseDocIdForDocument("bookings", `booking-${i}`);
    if (!legal.has(id)) out.push(id);
  }
  assertEquals(out.slice(0, 5), [], "Selected a shard outside the declared range");
});

Deno.test("pulse: selection is deterministic — the same document lands on the same shard", () => {
  // Not a nicety: if two processes disagreed about a document's shard, a burst
  // would spread across more documents than are provisioned.
  for (const docId of ["a", "9Z1RR8GFL41dduPgnVOM", "", "a~b", "unicode-é"]) {
    assertEquals(
      pulseDocIdForDocument("bookings", docId),
      pulseDocIdForDocument("bookings", docId),
      `unstable for ${JSON.stringify(docId)}`,
    );
  }
});

Deno.test("pulse: selection actually spreads — every bookings shard is reachable", () => {
  // The arm that would catch a hash returning a constant, which every other arm
  // here would pass. `>>> 0` sitting in the wrong place is enough to do it.
  const hit = new Set<string>();
  for (let i = 0; i < 5_000; i++) hit.add(pulseDocIdForDocument("bookings", `booking-${i}`));
  assertEquals(hit.size, pulseShardsFor("bookings"), `Only reached ${hit.size} shard(s)`);
});

Deno.test("pulse: a single-shard collection needs no hash and lands on 0", () => {
  assertEquals(pulseDocIdForDocument("products", "anything"), "products~0");
});

// ── Degradation, not collision ───────────────────────────────────────

Deno.test("pulse: an id with no separator degrades to itself, not to an empty key", () => {
  // A malformed id that parsed to `""` would pool every malformed id under one
  // key, so one stray document would tick a collection nobody wrote to.
  assertEquals(pulseCollectionOf("typesense"), "typesense");
  assertNotEquals(pulseCollectionOf("typesense"), "");
});

Deno.test("pulse: the shard suffix is taken from the LAST separator", () => {
  // Defensive rather than live — no CFS collection contains `~`. It costs one
  // `lastIndexOf` and removes the question.
  assertEquals(pulseCollectionOf("odd~name~3"), "odd~name");
});

// ── The two names infrastructure has to spell identically ────────────

Deno.test("pulse: the collection and token field are named, not spelled", () => {
  // These two strings appear in Terraform (the index exemption), firestore.rules,
  // readableCollections and devReplicaRules' SKIP_COLLECTIONS. A typo in the
  // exemption is invisible: the write succeeds and the 500 writes/s ceiling
  // silently stays.
  assertEquals(PULSE_COLLECTION, "typesense-pulse");
  assertEquals(PULSE_TOKEN_FIELD, "t");
});
