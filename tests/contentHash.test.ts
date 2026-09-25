import { assert, assertEquals, assertNotEquals } from "@std/assert";
import {
  canonicalJson,
  documentSourceCanonical,
  documentSourceHash,
  hash48,
  INVOICE_SOURCE_HASH_EXCLUDED_FIELDS,
  isSourceHashStale,
  ORDER_SOURCE_HASH_EXCLUDED_FIELDS,
  PACKING_LIST_SOURCE_HASH_EXCLUDED_FIELDS,
  SOURCE_HASH_VERSION,
} from "../src/utils/contentHash.ts";

// ── hash48 / canonicalJson: moved verbatim from api-cloudrun, and BYTE-STABLE ──

Deno.test("hash48 - matches an independent FNV-1a/48 reference (constants computed outside this repo)", () => {
  // Persisted as Xero `pushed_hash` and used as a task-name suffix, so a change
  // to the algorithm re-pushes every document. These come from a separate
  // implementation, not from hash48 itself.
  assertEquals(hash48("abc"), "1r6cyziogb");
  assertEquals(hash48('{"a":1,"b":{"x":"ts:10.20"}}'), "9d18b5mbn");
});

Deno.test("hash48 - deterministic and collision-distinguishing", () => {
  assertEquals(hash48("abc"), hash48("abc"));
  assertNotEquals(hash48("abc"), hash48("abd"));
  assert(/^[0-9a-z]+$/.test(hash48("anything"))); // base36
});

Deno.test("canonicalJson - invariant to object key insertion order", () => {
  assertEquals(canonicalJson({ a: 1, b: 2 }), canonicalJson({ b: 2, a: 1 }));
  assertEquals(
    canonicalJson({ x: { p: 1, q: 2 }, y: 3 }),
    canonicalJson({ y: 3, x: { q: 2, p: 1 } }),
  );
});

Deno.test("canonicalJson - array order is significant", () => {
  assertNotEquals(canonicalJson([1, 2, 3]), canonicalJson([3, 2, 1]));
  assertEquals(
    canonicalJson([{ b: 1, a: 2 }]),
    canonicalJson([{ a: 2, b: 1 }]),
  );
});

Deno.test("canonicalJson - primitives, null, and toJSON objects (Timestamp-like)", () => {
  assertEquals(canonicalJson(null), "null");
  assertEquals(canonicalJson(5), "5");
  assertEquals(canonicalJson("s"), '"s"');
  const tsLike = { toJSON: () => ({ _seconds: 10, _nanoseconds: 20 }) };
  assertEquals(canonicalJson(tsLike), '{"_seconds":10,"_nanoseconds":20}');
});

Deno.test("canonicalJson - different content yields different strings (feeds the hash)", () => {
  assertNotEquals(
    hash48(canonicalJson({ total: 100 })),
    hash48(canonicalJson({ total: 200 })),
  );
});

// ── documentSourceHash ────────────────────────────────────────────────────────

/** Admin-SDK form: underscored own fields, public getters. */
class AdminTs {
  constructor(readonly _seconds: number, readonly _nanoseconds: number) {}
  get seconds(): number {
    return this._seconds;
  }
  get nanoseconds(): number {
    return this._nanoseconds;
  }
}

/** Web-SDK form: plain own `seconds` / `nanoseconds`. */
class WebTs {
  constructor(readonly seconds: number, readonly nanoseconds: number) {}
  toJSON(): { seconds: number; nanoseconds: number; type: string } {
    return { seconds: this.seconds, nanoseconds: this.nanoseconds, type: "timestamp" };
  }
}

Deno.test("documentSourceCanonical - hand-written expectation: excluded keys gone, timestamps one token, keys sorted", () => {
  const doc = {
    uid: "o1",
    version: 7,
    updated_at: new WebTs(1, 2),
    number: 1042,
    subject: "Shoot",
    delivery_start_fs: new WebTs(10, 20),
  };
  assertEquals(
    documentSourceCanonical("order", doc),
    '{"delivery_start_fs":"ts:10.20","number":1042,"subject":"Shoot"}',
  );
});

Deno.test("documentSourceHash - a Timestamp hashes the same in Admin-SDK, web-SDK and plain forms", () => {
  const base = { number: 1, subject: "S" };
  const admin = documentSourceHash("order", { ...base, delivery_start_fs: new AdminTs(10, 20) });
  const web = documentSourceHash("order", { ...base, delivery_start_fs: new WebTs(10, 20) });
  const plainPublic = documentSourceHash("order", { ...base, delivery_start_fs: { seconds: 10, nanoseconds: 20 } });
  const plainPrivate = documentSourceHash("order", {
    ...base,
    delivery_start_fs: { _seconds: 10, _nanoseconds: 20 },
  });
  const jsonWire = documentSourceHash("order", {
    ...base,
    delivery_start_fs: { seconds: 10, nanoseconds: 20, type: "timestamp" },
  });
  assertEquals(admin, web);
  assertEquals(admin, plainPublic);
  assertEquals(admin, plainPrivate);
  assertEquals(admin, jsonWire);
  // …and the instant still matters.
  assertNotEquals(
    admin,
    documentSourceHash("order", { ...base, delivery_start_fs: new AdminTs(10, 21) }),
  );
});

Deno.test("documentSourceHash - nested timestamps (items, destinations) normalize too", () => {
  const a = { destinations: [{ dates: { delivery_start_fs: new AdminTs(5, 6) } }] };
  const b = { destinations: [{ dates: { delivery_start_fs: new WebTs(5, 6) } }] };
  assertEquals(documentSourceHash("order", a), documentSourceHash("order", b));
});

Deno.test("documentSourceHash - an undefined member is absent, a null one is not", () => {
  assertEquals(
    documentSourceHash("order", { number: 1, reference: undefined }),
    documentSourceHash("order", { number: 1 }),
  );
  assertNotEquals(
    documentSourceHash("order", { number: 1, reference: null }),
    documentSourceHash("order", { number: 1 }),
  );
});

Deno.test("documentSourceHash - key order does not matter, array order does", () => {
  assertEquals(
    documentSourceHash("invoice", { a: 1, b: [1, 2] }),
    documentSourceHash("invoice", { b: [1, 2], a: 1 }),
  );
  assertNotEquals(
    documentSourceHash("invoice", { b: [1, 2] }),
    documentSourceHash("invoice", { b: [2, 1] }),
  );
});

Deno.test("documentSourceHash - a bookkeeping-only order write does not move the hash", () => {
  const before = { number: 1, subject: "S", version: 3, updated_at: new AdminTs(1, 1), bookings_breakdown: { a: 1 } };
  const after = { number: 1, subject: "S", version: 4, updated_at: new AdminTs(9, 9), bookings_breakdown: { a: 2 } };
  assertEquals(documentSourceHash("order", before), documentSourceHash("order", after));
});

Deno.test("documentSourceHash - a rendered order field moves the hash", () => {
  assertNotEquals(
    documentSourceHash("order", { number: 1, subject: "S" }),
    documentSourceHash("order", { number: 1, subject: "T" }),
  );
});

Deno.test("documentSourceHash - the PDF pipeline's own write-back never moves an invoice hash", () => {
  const rendered = { number: 9, subject: "S", totals: { total_cents: 100 } };
  const afterSave = {
    ...rendered,
    pdf_versions: [{ version: 1 }],
    xero_id: "x",
  };
  assertEquals(documentSourceHash("invoice", rendered), documentSourceHash("invoice", afterSave));
});

Deno.test("documentSourceHash - a settlement moves an invoice hash (the template prints amount paid)", () => {
  assertNotEquals(
    documentSourceHash("invoice", { totals: { amount_paid_cents: 0 } }),
    documentSourceHash("invoice", { totals: { amount_paid_cents: 500 } }),
  );
});

Deno.test("documentSourceHash - the two kinds exclude different keys", () => {
  // `pdf_versions` is noise on an invoice and content on nothing an order has;
  // `bookings_breakdown` is noise on an order and would be content on an invoice.
  assertEquals(
    documentSourceHash("invoice", { a: 1, bookings_breakdown: 1 }) ===
      documentSourceHash("invoice", { a: 1, bookings_breakdown: 2 }),
    false,
  );
  assertEquals(
    documentSourceHash("order", { a: 1, bookings_breakdown: 1 }),
    documentSourceHash("order", { a: 1, bookings_breakdown: 2 }),
  );
});

Deno.test("documentSourceHash - a booking progress write moves a PACKING LIST hash and not a quote hash", () => {
  // The pick sheet folds open bookings; `bookings_breakdown` is the order-side
  // record of that progress. A quote does not read it.
  const before = { number: 1, bookings_breakdown: { open: 3 } };
  const after = { number: 1, bookings_breakdown: { open: 2 } };
  assertNotEquals(documentSourceHash("packing-list", before), documentSourceHash("packing-list", after));
  assertEquals(documentSourceHash("order", before), documentSourceHash("order", after));
});

Deno.test("documentSourceHash - the packing list's exclusions are the order's minus exactly bookings_breakdown", () => {
  const expected = [...ORDER_SOURCE_HASH_EXCLUDED_FIELDS].filter((k) => k !== "bookings_breakdown").sort();
  assertEquals([...PACKING_LIST_SOURCE_HASH_EXCLUDED_FIELDS].sort(), expected);
  assertEquals(ORDER_SOURCE_HASH_EXCLUDED_FIELDS.has("bookings_breakdown"), true);
});

Deno.test("documentSourceHash - carries the version prefix", () => {
  assert(documentSourceHash("order", {}).startsWith(`${SOURCE_HASH_VERSION}:`));
});

Deno.test("exclusion sets - do not overlap the fields a template plainly needs", () => {
  for (
    const kind of [
      ORDER_SOURCE_HASH_EXCLUDED_FIELDS,
      PACKING_LIST_SOURCE_HASH_EXCLUDED_FIELDS,
      INVOICE_SOURCE_HASH_EXCLUDED_FIELDS,
    ]
  ) {
    for (const rendered of ["number", "status", "items", "destinations", "totals", "organization", "subject"]) {
      assertEquals(kind.has(rendered), false, `${rendered} is rendered and must stay in the hash`);
    }
  }
});

// ── isSourceHashStale ─────────────────────────────────────────────────────────

Deno.test("isSourceHashStale - unrecorded never flags", () => {
  assertEquals(isSourceHashStale(null, "1:abc"), false);
  assertEquals(isSourceHashStale(undefined, "1:abc"), false);
  assertEquals(isSourceHashStale("", "1:abc"), false);
});

Deno.test("isSourceHashStale - equal is fresh, different is stale", () => {
  assertEquals(isSourceHashStale("1:abc", "1:abc"), false);
  assertEquals(isSourceHashStale("1:abc", "1:abd"), true);
});

Deno.test("isSourceHashStale - a different hash VERSION is unknown, not stale", () => {
  assertEquals(isSourceHashStale("0:abc", "1:abd"), false);
  assertEquals(isSourceHashStale("2:abc", "1:abd"), false);
});
