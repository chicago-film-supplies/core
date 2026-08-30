/**
 * QuoteSchema — the collection had no schema test until the documents-menu
 * campaign gave it a field worth pinning.
 *
 * `params` records the render params the stored PDF was ACTUALLY rendered at:
 * the map `resolveRenderParams` returned inside `renderDocument`, handed back by
 * it rather than re-derived by the caller. It is REQUIRED with no `.default()`,
 * because a default never materializes on a write (`validateBeforeWrite`
 * discards `result.data` and the caller writes its own raw object), so a default
 * would only license a future writer to forget the stamp. `{}` is the legitimate
 * "nothing was recorded" value — every quote written before the field existed,
 * backfilled to it.
 */
import { assertEquals } from "@std/assert";
import { QuoteSchema } from "../src/schemas/quote.ts";
import { mockTimestamp } from "./helpers/timestamp.ts";

function baseQuote(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    uid: "testorder10000000000:draft",
    uid_order: "testorder10000000000",
    order_number: 1000,
    version: null,
    is_draft: true,
    uploadcare_uuid: "11111111-2222-4333-8444-555555555555",
    params: {},
    deleted_at: null,
    expires_at: null,
    created_at: mockTimestamp,
    updated_at: mockTimestamp,
    ...extra,
  };
}

Deno.test("QuoteSchema validates a complete document", () => {
  assertEquals(QuoteSchema.safeParse(baseQuote()).success, true);
});

Deno.test("QuoteSchema accepts a recorded non-default param", () => {
  const res = QuoteSchema.safeParse(baseQuote({ params: { hide_zero_priced_components: true } }));
  assertEquals(res.success, true);
});

Deno.test("QuoteSchema rejects a document with no params key", () => {
  // The assertion the required decision rests on. A `.default({})` here would
  // pass this document and write it without the key.
  const doc = baseQuote();
  delete doc.params;
  assertEquals(QuoteSchema.safeParse(doc).success, false);
});

Deno.test("QuoteSchema rejects a non-boolean param value", () => {
  assertEquals(
    QuoteSchema.safeParse(baseQuote({ params: { hide_zero_priced_components: "true" } })).success,
    false,
  );
});

Deno.test("QuoteSchema rejects an undeclared sibling field", () => {
  // Pins `strictObject` — without it the params stamp could land under a
  // misspelled key and store silently.
  assertEquals(QuoteSchema.safeParse(baseQuote({ render_params: {} })).success, false);
});

Deno.test("QuoteSchema accepts a saved version row", () => {
  const res = QuoteSchema.safeParse(baseQuote({
    uid: "testorder10000000000:v3",
    version: 3,
    is_draft: false,
    params: { hide_zero_priced_components: false },
  }));
  assertEquals(res.success, true);
});
