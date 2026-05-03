# Note: `linkTo` meta migration for manager TableCell

**From:** manager (2026-04-21, commit `a3ef4e9`)
**Ask:** progressively annotate displayable fields with `z.meta({ linkTo })` so the manager's `TableCell` can retire a pile of legacy `columnKey` regex heuristics.

## Context

The manager app just unified its two cell dispatchers (`CollectionCell` for Typesense, `FirestoreCollectionCell` for Firestore) into one component at `src/components/TableCell.tsx`. The new dispatcher resolves "should this cell render as a router link?" in this order:

1. **Meta-first:** `getFieldMeta(collection, columnKey).linkTo` — preferred path.
2. **Legacy fallback:** a hard-coded allow-list (`name`, `number`, `subject`, `reference`, `organization.name`, `organizations.name`, `components.name`, `component_of.name`) + a contact-name regex (`/^contacts?\.(first_name|middle_name|last_name|pronunciation)$/`).

The fallback exists because most collection fields aren't yet annotated with `linkTo`. Every field that gets an explicit `linkTo` annotation is one fewer path relying on fragile string matching — and, over time, lets us delete the legacy branch entirely.

One example already exists: `src/booking.ts:123`

```ts
number: z.int().meta({ label: "Order #", linkTo: "orderDetail" }),
```

That's the template. The rest of this note enumerates which fields still need the annotation.

## Valid `linkTo` values

From `manager/src/components/collection-cells/CellRouterLink.tsx:routePath`:

- `productDetail`
- `orderDetail`
- `invoiceDetail`
- `contactDetail`
- `organizationDetail`
- `templateDetail`

Anything else won't route and should not be set.

## Fields to annotate

Grouped by schema file. Annotations can be added incrementally — the manager's fallback keeps un-annotated fields working until they're migrated.

Annotations can coexist with existing `pii` meta; e.g. `.meta({ pii: "mask", linkTo: "contactDetail" })` or chained `.meta({ pii: "mask" }).meta({ linkTo: "contactDetail" })`.

### Self-link fields (the entity's own identifier column)

Each of these is the row's "headline" field — clicking it opens the row's own detail page.

| File | Field path | `linkTo` |
|---|---|---|
| `src/product.ts` | `ProductSchema.name` | `productDetail` |
| `src/order.ts` | `OrderSchema.number` | `orderDetail` |
| `src/invoice.ts` | `InvoiceSchema.number` | `invoiceDetail` |
| `src/invoice.ts` | `InvoiceSchema.reference` | `invoiceDetail` |
| `src/template.ts` | `TemplateSchema.subject` | `templateDetail` |
| `src/contact.ts` | `ContactSchema.first_name` / `middle_name` / `last_name` / `pronunciation` | `contactDetail` |
| `src/organization.ts` | `OrganizationSchema.name` | `organizationDetail` |

Note: the name fragments in `common.ts` (`NameFields`) are reused. If it's feasible to annotate them there and have it propagate, great — otherwise annotating per-collection is fine.

### Cross-entity reference fields (nested objects that link to *another* entity)

These appear on a host collection but point at a different entity's detail page. Annotate the leaf inside the nested sub-schema.

| Host | Field path | `linkTo` |
|---|---|---|
| `order` | `organization.name` | `organizationDetail` |
| `order` | `contacts[].first_name` / `middle_name` / `last_name` / `pronunciation` | `contactDetail` |
| `invoice` | `organization.name` | `organizationDetail` |
| `invoice` | `contacts[].first_name` / `middle_name` / `last_name` / `pronunciation` | `contactDetail` |
| `product` | `components[].name` | `productDetail` |
| `product` | `component_of[].name` | `productDetail` |

The Typesense flattener turns array paths like `contacts[].first_name` into columnKey `contacts.first_name` at display time; the manager resolves meta by walking the source Zod schema using that dotted path, so annotating the leaf field of the nested schema works transparently.

## Out of scope (shape-based, no meta needed)

The manager's `TableCell` still detects these at runtime from the value shape, not from schema meta — don't add meta for them:

- Email columns → `CellExternalLink` with `mailto:` (detected by `columnKey.includes("email")`).
- Phone columns → `CellExternalLink` with `sms:` (detected by `columnKey.includes("phone")`).
- Firestore Timestamps → `CellDate` (detected by `.toMillis()` on the value).
- `_fs` / `_at` suffix numeric fields → `CellDate`.
- Address/location columns → `CellAddress` (detected by `columnKey.includes("address"|"location")`).
- Booleans → "Yes"/"No" (detected by `typeof === "boolean"`).

If we later want to add a declarative `kind` (e.g. `meta({ kind: "email" | "phone" | "date" | "address" })` to replace these heuristics too, that's a separate, lower-priority migration — flag it separately when the time comes.

## When done

Once the majority of the table above is annotated, ping the manager side and the legacy `routerLinkColumnKeys` / `contactNameRe` fallback in `manager/src/components/TableCell.tsx` can be deleted.
