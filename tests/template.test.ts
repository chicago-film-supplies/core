/**
 * Tests for the operator-managed `fixtures: FixtureMeta[]` manifest on
 * TemplateSchema. The manifest is projected from the family sidecar's
 * `fixtures` array; files in `fixtures/<git_path>/` remain authoritative for
 * discovery, so this list is where each fixture's REASON is recorded.
 *
 * `description` is required. The fixture file is a strict source document with
 * no room for a comment, so the manifest is the only place a fixture can say
 * what it covers that its siblings do not — an optional field there means the
 * coverage argument is optional, which is how a fixture set silently becomes a
 * pile of similar documents.
 */
import { assertEquals } from "@std/assert";
import { FixtureMetaSchema, TemplateSchema } from "../src/schemas/template.ts";
import { mockTimestamp } from "./helpers/timestamp.ts";

function baseFamily(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    uid: "t1000000000000000000",
    git_path: "quote",
    name: "Quote",
    collection_source: "orders",
    collection_target: "quotes",
    surfaces: ["order"],
    uid_active: null,
    depends_on: { components: [] },
    draft_uids: [],
    version_count: 0,
    last_published_at: null,
    uid_thread: "th100000000000000000",
    version: 0,
    created_by: { uid: "u1000000000000000000", name: "Tester" },
    updated_by: { uid: "u1000000000000000000", name: "Tester" },
    created_at: mockTimestamp,
    updated_at: mockTimestamp,
    ...extra,
  };
}

Deno.test("FixtureMetaSchema accepts a complete entry", () => {
  assertEquals(
    FixtureMetaSchema.safeParse({
      slug: "order-841",
      label: "Order 841 — multi-destination",
      description: "Three destinations, tax-exempt subgroup, six rentals.",
    }).success,
    true,
  );
});

Deno.test("FixtureMetaSchema rejects an entry with no description", () => {
  assertEquals(
    FixtureMetaSchema.safeParse({ slug: "order-841", label: "Order 841" }).success,
    false,
  );
});

Deno.test("FixtureMetaSchema rejects an empty description", () => {
  // An empty string would satisfy a bare `z.string()` and record no reason at
  // all — the exact hole `.min(1)` closes.
  assertEquals(
    FixtureMetaSchema.safeParse({ slug: "s", label: "l", description: "" }).success,
    false,
  );
});

Deno.test("FixtureMetaSchema rejects an empty slug", () => {
  assertEquals(
    FixtureMetaSchema.safeParse({ slug: "", label: "x", description: "why" }).success,
    false,
  );
});

Deno.test("FixtureMetaSchema rejects unknown keys", () => {
  assertEquals(
    FixtureMetaSchema.safeParse({ slug: "s", label: "l", description: "why", extra: 1 }).success,
    false,
  );
});

// ── `params` — the state a fixture is golden-gated at (api-cloudrun#608) ──

Deno.test("FixtureMetaSchema accepts an entry declaring a param state", () => {
  assertEquals(
    FixtureMetaSchema.safeParse({
      slug: "zero-priced-components-hidden",
      label: "Components hidden",
      description: "The hidden-and-rolled-up state of hide_zero_priced_components.",
      params: { hide_zero_priced_components: true },
    }).success,
    true,
  );
});

Deno.test("FixtureMetaSchema keeps `params` OPTIONAL — absent means the family's defaults", () => {
  // The rollout is readers-first and therefore additive: every stored
  // `fixtures[]` entry predates this field, and an absent one is not a gap —
  // it is the statement "this fixture renders at the declared defaults".
  const res = FixtureMetaSchema.safeParse({
    slug: "s",
    label: "l",
    description: "why this one and not its siblings",
  });
  assertEquals(res.success, true);
  if (res.success) assertEquals(res.data.params, undefined);
});

Deno.test("FixtureMetaSchema rejects a non-boolean param value", () => {
  // TEMPLATE_PARAM_TYPES is ["boolean"], and `resolveRenderParams` throws on a
  // non-boolean provided value — so accepting one here would only move the
  // failure from the sidecar to the render.
  assertEquals(
    FixtureMetaSchema.safeParse({
      slug: "s",
      label: "l",
      description: "why this one and not its siblings",
      params: { collection_leg: "true" },
    }).success,
    false,
  );
});

Deno.test("TemplateSchema defaults fixtures to []", () => {
  const res = TemplateSchema.safeParse(baseFamily());
  assertEquals(res.success, true);
  if (res.success) assertEquals(res.data.fixtures, []);
});

Deno.test("TemplateSchema accepts a family with multiple fixtures", () => {
  const res = TemplateSchema.safeParse(
    baseFamily({
      fixtures: [
        { slug: "order-841", label: "Order 841", description: "Single destination, rentals + tax." },
        { slug: "tax-exempt", label: "Tax-exempt customer", description: "The only tax_exempt profile." },
      ],
    }),
  );
  assertEquals(res.success, true);
  if (res.success) assertEquals(res.data.fixtures.length, 2);
});

Deno.test("TemplateSchema rejects a fixtures[] entry with no description", () => {
  // The family doc is the projection of the sidecar, so this is what stops an
  // undescribed sidecar entry from being published onto the family.
  const res = TemplateSchema.safeParse(
    baseFamily({
      fixtures: [
        { slug: "order-841", label: "Order 841", description: "Single destination, rentals + tax." },
        { slug: "tax-exempt", label: "Tax-exempt customer" },
      ],
    }),
  );
  assertEquals(res.success, false);
});
