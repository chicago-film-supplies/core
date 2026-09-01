/**
 * The Typesense **sync pulse** — the signal that tells a connected browser one
 * collection's index has moved, so its open tables re-search.
 *
 * ## Why it is its own collection, and its own shape
 *
 * The pulse used to be an `updates` counter incremented on
 * `typesense/{collection}` after every upsert and delete. Two things were wrong
 * with that, and both fail silently:
 *
 * 1. **It shared a document with reindex control state**, which a CAS
 *    transaction writes. A transaction's lock blocks non-transactional writes
 *    too, and `increment` is no escape — every Firestore write is internally a
 *    locking transaction. One checkout commits ~135 bookings in a single
 *    transaction, so ~135 writes land on one key.
 * 2. **A counter is monotonic, and Firestore auto-indexes every field.** A
 *    monotonically increasing indexed value is a moving index hotspot that
 *    sharding the *documents* does not fix.
 *
 * So a pulse is one document per shard in its own collection, carrying a
 * **random token** and nothing else. Non-monotonic, so the index has no hot
 * range; random, so a write can never be a no-op (a no-op write emits no
 * change event at all, and a swallowed pulse is a table that never refreshes).
 * `serverTimestamp` would be the worst available choice on both counts.
 *
 * ⚠️ The token field needs a **single-field index exemption**
 * (`api-cloudrun/infra/firestore.tf`). Writing it before the exemption exists is
 * the 500 writes/s cap this design exists to avoid.
 *
 * ## One key, two sides
 *
 * The writer holds a **Firestore collection name**; the manager holds a
 * **Typesense alias**. Those are two names for one thing that agree only
 * because all 23 configs currently set `alias === firestoreCollection`
 * (measured). If one ever diverged, the refresh would stop and nothing would go
 * red — so neither side spells the key itself. The writer mints through
 * {@link pulseDocIdForDocument}, the reader parses through
 * {@link pulseCollectionOf}, and a client holding an alias reaches the key half
 * through {@link pulseCollectionForAlias}.
 *
 * A test asserting `alias === firestoreCollection` would also close the hole and
 * is strictly worse: it forbids a divergence someone might one day want,
 * instead of making it harmless.
 *
 * @module
 */
import { typesenseSchemas } from "./mod.ts";
import type { TypesenseAlias } from "./mod.ts";
import type { TypesenseCollectionConfig } from "./types.ts";

/**
 * The Firestore collection the pulse documents live in.
 *
 * Named here so the writer, the manager's listener, `manager/firestore.rules`,
 * `readableCollections` and `devReplicaRules`' `SKIP_COLLECTIONS` all cite one
 * constant. 🔴 The dev-replica skip is not optional: prod's `mirror_top_level`
 * trigger matches `{collectionId}/{docId}` — *everything* — and mirroring a
 * pulse reproduces the 409 storm that put `typesense` on that list.
 */
export const PULSE_COLLECTION = "typesense-pulse";

/**
 * The one field a pulse document carries: a random token.
 *
 * Named rather than spelled at each site because the index exemption in
 * Terraform has to name the same field, and a typo there is invisible — the
 * write succeeds and the collection silently keeps its 500 writes/s ceiling.
 */
export const PULSE_TOKEN_FIELD = "t";

/**
 * Separates a pulse id's collection half from its shard index.
 *
 * `~` sorts after every alphanumeric, so it cannot be confused with a character
 * inside a collection name, and no CFS collection name contains it.
 */
const PULSE_SEPARATOR = "~";

/**
 * Firestore collection → its Typesense config.
 *
 * 🔴 **Built on first read, not at module scope.** `typesense/mod.ts` re-exports this
 * module, so the two form an import cycle and a top-level `new Map(...)` here
 * evaluates before `typesenseSchemas` is initialized — *"Cannot access
 * 'typesenseSchemas' before initialization"*, which takes down 34 test files at
 * import time rather than failing one assertion.
 *
 * Keyed on a bare `string`, not `CollectionName`: every caller reaches this
 * with an untrusted id (a pulse doc's own id, an alias off the wire), so
 * narrowing here would only move the cast to the callers. Unique by
 * construction — 23 configs, 23 distinct `firestoreCollection`s, measured.
 */
let configByFirestoreCollection: Map<string, TypesenseCollectionConfig> | null = null;

function configFor(firestoreCollection: string): TypesenseCollectionConfig | undefined {
  configByFirestoreCollection ??= new Map(
    Object.values(typesenseSchemas).map((c) => [c.firestoreCollection as string, c]),
  );
  return configByFirestoreCollection.get(firestoreCollection);
}

/**
 * How many pulse shards a collection writes to. `1` for anything unconfigured,
 * which is also the right answer for a collection that is not synced at all.
 *
 * ⚠️ **Raising this is safe; lowering it orphans documents.** Nothing reaps a
 * shard that falls out of range, and an orphan costs every connected client a
 * read on every connect. `api-cloudrun/scripts/audit-env-definitions.ts` is what catches it.
 */
export function pulseShardsFor(firestoreCollection: string): number {
  const n = configFor(firestoreCollection)?.pulseShards;
  return n && n > 0 ? n : 1;
}

/**
 * The pulse document id for an explicit shard.
 *
 * ⚠️ **Shard 0 is spelled `{collection}~0`, not `{collection}`.** Uniform ids
 * mean the reader's suffix strip has no special case, which is the kind of
 * branch that works until the first single-shard collection is read.
 */
export function pulseDocId(firestoreCollection: string, shard: number): string {
  return `${firestoreCollection}${PULSE_SEPARATOR}${shard}`;
}

/**
 * Every pulse document id a collection should have — what the hourly drift
 * check provisions, and what the live audit compares against.
 *
 * 🔴 **Create the absent ones; never `set` them all.** A blind write on an
 * hourly job ticks every connected client every hour and re-searches
 * everything, which is the failure this whole design is avoiding.
 */
export function pulseShardIds(firestoreCollection: string): string[] {
  const n = pulseShardsFor(firestoreCollection);
  return Array.from({ length: n }, (_, i) => pulseDocId(firestoreCollection, i));
}

/**
 * FNV-1a, 32-bit. Chosen because it is a handful of lines of explicit integer
 * arithmetic with no platform dependency: writer and any future re-writer must
 * land a given document on the same shard, and "whatever the runtime's string
 * hash does" is not a contract. `>>> 0` keeps it unsigned at every step.
 */
function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * The pulse document a given synced document's change should tick.
 *
 * This is the writer's door: it selects the shard *and* mints the id, so an
 * out-of-range shard is unrepresentable rather than something to remember.
 *
 * Which document lands on which shard does not matter — delivery is
 * at-least-once and unordered, and the reader counts ticks per collection
 * rather than per shard. Spreading writes is the entire job.
 */
export function pulseDocIdForDocument(firestoreCollection: string, docId: string): string {
  const shards = pulseShardsFor(firestoreCollection);
  return pulseDocId(firestoreCollection, shards === 1 ? 0 : fnv1a32(docId) % shards);
}

/**
 * The collection half of a pulse document id — the reader's door.
 *
 * Returns the whole id when it carries no separator, so an id minted by some
 * other writer degrades to "a collection nobody is listening for" rather than
 * to an empty key that would collide with every other malformed id.
 */
export function pulseCollectionOf(pulseId: string): string {
  const cut = pulseId.lastIndexOf(PULSE_SEPARATOR);
  return cut === -1 ? pulseId : pulseId.slice(0, cut);
}

/**
 * The pulse key for a Typesense **alias** — for a client that holds an alias
 * (because that is what it resolves a search client from) and needs the key the
 * writer used.
 *
 * `null` for an unknown alias, so a caller gets no tick rather than a tick
 * keyed on a string nothing writes.
 */
export function pulseCollectionForAlias(alias: string): string | null {
  return typesenseSchemas[alias as TypesenseAlias]?.firestoreCollection ?? null;
}
