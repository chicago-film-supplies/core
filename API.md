# `@cfs/core` API Reference

_Generated from source by `scripts/generate-api-docs.ts` — do not edit by hand. A structured companion is emitted alongside as `API.json`. Browsable version on [JSR](https://jsr.io/@cfs/core/doc/all_symbols)._

## `@cfs/core/schemas`

### `ACCEPTS_PAYMENT_STATUSES`

Statuses that still admit a further payment. Excludes `paid` deliberately.

```ts
const ACCEPTS_PAYMENT_STATUSES: readonly InvoiceStatusType[];
```

### `ALWAYS_ON_UTIL_NAMESPACES`

Utils namespaces injected for every template regardless of collection.

`money` is here rather than in {@link TEMPLATE_COLLECTION_UTILS} because every
document a template renders carries money — an order, an invoice and a quote
all need `it.money.formatCents`, so keying it to one collection would just
mean listing it under all of them.

It also closes a gap the generated helper catalogue had already opened:
`template-helpers.generated.ts` derives its namespaces from `src/utils/`, so
it has been advertising eleven `it.money.*` helpers to template authors while
the render path injected none of them. Documentation promising a global that
throws at render time is worse than no documentation.

✅ `it.currency` (raw currency.js) **is gone as of Phase 11 Phase E**, and
`it.money` is what replaced it. It survived this long because the natural
replacement takes **cents** while template documents held **dollars**, so
every one of the 19 call sites in `templates/quote.eta` would have read
`it.money.formatCents(it.money.toCents(x))` — worse than what it replaced.
Documents are cents-denominated now, `it.money.formatCents(doc.total_cents)`
is the natural form, and the trade flipped exactly as predicted.

```ts
const ALWAYS_ON_UTIL_NAMESPACES: readonly string[];
```

### `AcceptInviteInput`

Input schema for POST /auth/accept-invite.

```ts
const AcceptInviteInput: z.ZodType<AcceptInviteInputType>;
```

### `AcceptInviteInputType`

Input to POST /auth/accept-invite. Name fields override the invite's
captured values — each is optional; omitted means "keep the invite's value".

```ts
interface AcceptInviteInputType {
  token: string;
  password: string;
}
```

### `ActorRef`

Zod schema for an actor reference.

```ts
const ActorRef: z.ZodType<ActorRefType>;
```

### `ActorRefType`

Actor reference — embedded `{uid, name}` for `created_by` / `updated_by` /
`deleted_by` fields across document schemas. The `name` is denormalized at
write time by the server via `deriveName(parts)` (with `uid` as a fallback
when all parts are empty — see `buildActorRef` in api-cloudrun). Non-human
actors (e.g. integrations, scheduled jobs) use a synthetic uid such as
`"manager-bot"` with a matching display name. Name changes on the source
user fan out via the `update-user:name-to-actor-refs` propagation rule.

```ts
interface ActorRefType {
  uid: string;
  name: string;
}
```

### `Address`

Zod schema for Address, nullable.

The object carries the `pii: "mask"` tag and every leaf inherits it, so a
new field added here is masked by default — the safe direction. The three
coarse-geography leaves opt OUT explicitly: a city / state / country cannot
identify anyone on their own, they are what makes a sanitized fixture still
look like a plausible address, and faking them produces nonsense (the mask
transform reads `"United States"` as a person's name and `"IL"` as a city).
The identifying parts — `street`, `street2`, `full`, `name`, `postcode`, and
the two `Coordinates` — stay masked.

```ts
const Address: z.ZodType<AddressType | null>;
```

### `AddressType`

Address object — shared between organizations and order destinations.

```ts
interface AddressType {
  city: string;
  country_name: string;
  full: string;
  name: string;
  postcode: string;
  region: string;
  street: string;
  street2?: string;
  mapbox_id?: string;
  address_coordinates?: CoordinatesType | null;
  user_coordinates?: CoordinatesType | null;
}
```

### `AggregateDefinition`

DDD aggregate boundary — groups collections under one consistency root.

```ts
interface AggregateDefinition {
  id: string;
  root: string;
  members: string[];
  description: string;
}
```

### `AnyUid`

Any known CFS document-id shape — atomic Firestore id, divider/custom item
id, a composite (booking / event-card), or a lowercase-kebab slug (slug-keyed
collections such as `roles` and seeded `lists`). Use for polymorphic
references (`DocSource`, `UidNameRef`) that may point at any collection.
`ItemUid` already covers `FirestoreId | uuid | custom-`.

```ts
const AnyUid: z.ZodType<string>;
```

### `AuthoredComponentSchema`

Schema for an authored `components` entry — {@link ComponentSchema} with
`inclusion_type` required.

**Storage only.** `CreateProductInput` / `UpdateProductInput` deliberately keep
`ComponentSchema`, so a client may omit `inclusion_type` and the WRITER fills
`"default"` — the reading `crmsProduct.ts` and manager's new-component form
already take. Requiring it at the boundary instead would 400 any client that
has not been rebuilt, and manager is pinned several betas back on purpose
(manager#265). Normalize at the writer, guard at storage: no undefined can
reach a stored document either way, which is what the expanders need.

```ts
const AuthoredComponentSchema: z.ZodType<AuthoredProductComponent>;
```

### `AuthoredProductComponent`

A component product within a parent product — the entry in `components`.

Identical to {@link ProductComponent} except that `inclusion_type` is
**required**, and that difference is the point. Both expanders
(`buildOrderComponentLines` in manager, and the staged-add path) filter
`=== "mandatory" || === "default"`, so an `undefined` here is a silent fourth
bucket whose component is dropped from every order it should have joined.

The optionality it replaces existed to accommodate `component_of`, where the
field genuinely is not authored — and it leaked onto the authored side, where
it is a bug. Splitting the two is what lets this side be required. Prod
carries 0 undefined rows across 165 `components` entries on 63 products, so
this is hardening with a zero-row backfill; writers with no answer pass
`"default"`, the reading `crmsProduct.ts` and manager's new-component form
already take.

NOT expressed as `.default("default")`: `validateBeforeWrite` validates but
writes the RAW doc, so a schema default never materializes and the field would
still be written absent.

```ts
interface AuthoredProductComponent {
  inclusion_type: InclusionTypeType;
}
```

### `BOOKING_BREAKDOWN_KEYS`

All seven keys of the booking lifecycle breakdown, in lifecycle order (which
is NOT the schema's alphabetical field order — the UI reads left to right).

These live beside the schema rather than in `utils/bookings.ts` because
schema modules cannot import utils (the dependency runs strictly one way) and
the movement journal needs the key union to type a custody transition.
`utils/bookings.ts` re-exports all three, so existing importers are unaffected.

```ts
const BOOKING_BREAKDOWN_KEYS: "quoted" | "reserved" | "prepped" | "out" | "returned" | "lost" | "damaged"[];
```

### `BOOKING_BREAKDOWN_TERMINAL_KEYS`

Keys representing items that have reached a terminal state.

```ts
const BOOKING_BREAKDOWN_TERMINAL_KEYS: "returned" | "lost" | "damaged"[];
```

### `BOOKING_STATUSES`

```ts
const BOOKING_STATUSES: "draft" | "quoted" | "reserved" | "part-prepped" | "prepped" | "active" | "complete"[];
```

### `BaseLogFields`

TypeScript shape of {@link baseLogFields} — for use in archetype
interfaces that want to declare the envelope explicitly.

```ts
interface BaseLogFields {
  level: LogLevelType;
  ts: string;
  request_id?: string;
  method?: string;
  path?: string;
  route?: string;
  user_id?: string;
  subject?: string;
  trace_id?: string;
  span_id?: string;
  duration_ms?: number;
  dry_run?: boolean;
}
```

### `BlobRef`

A git blob reference recorded for a published version (path → blob sha).

```ts
interface BlobRef {
  path: string;
  sha: string;
}
```

### `BlobRefSchema`

Zod schema for a BlobRef.

```ts
const BlobRefSchema: z.ZodType<BlobRef>;
```

### `Booking`

Full Firestore document for a booking (a single product line within an order).

```ts
interface Booking {
  uid: string;
  uid_order: string;
  uid_product: string;
  name: string;
  number: number;
  type: ComponentTypeType;
  status: BookingStatusType;
  quantity: number;
  shortage: number;
  subject: string;
  unit_price_cents: number;
  total_price_cents: number;
  crms_id?: number | null;
  crms_product_id?: number | null;
  breakdown: BookingBreakdown;
  dates: typeLiteral;
  destinations: typeLiteral;
  organization: typeLiteral;
  stores: BookingStore[];
  query_by_uid_store: string[];
  query_by_uid_location: string[];
  uid_destination_delivery: string;
  uid_destination_collection: string;
  version: number;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}
```

### `BookingBreakdown`

Per-status quantity breakdown for a booking — also embedded in stock-summary entries.

```ts
interface BookingBreakdown {
  damaged: number;
  lost: number;
  out: number;
  prepped: number;
  quoted: number;
  reserved: number;
  returned: number;
}
```

### `BookingBreakdownKeyEnum`

Zod enum over the seven breakdown keys — the custody axis of a movement.

```ts
const BookingBreakdownKeyEnum: z.ZodType<BookingBreakdownKeyType>;
```

### `BookingBreakdownKeyType`

One key of the booking lifecycle breakdown.

```ts
type BookingBreakdownKeyType = indexedAccess;
```

### `BookingBreakdownSchema`

Zod schema for BookingBreakdown.

```ts
const BookingBreakdownSchema: z.ZodType<BookingBreakdown>;
```

### `BookingCreated`

```ts
type BookingCreated = EventEnvelope<Booking> & typeLiteral;
```

### `BookingDestinationRef`

A reference to a destination with its address, used in booking delivery/collection.

```ts
interface BookingDestinationRef {
  uid: string;
  address: AddressType | null;
}
```

### `BookingId`

`bookings.uid` — deterministic composite
`{uid_order}:{item uid}:{uid_destination}` (the middle segment is the order
item's uid, which for a custom product is `custom-{uuid}`).

```ts
const BookingId: z.ZodType<string>;
```

### `BookingSchema`

Zod schema for Booking.

```ts
const BookingSchema: z.ZodType<Booking>;
```

### `BookingStatusChanged`

```ts
type BookingStatusChanged = EventEnvelope<Booking> & typeLiteral;
```

### `BookingStatusType`

```ts
type BookingStatusType = indexedAccess;
```

### `BookingStore`

A store and its locations assigned to a booking.

```ts
interface BookingStore {
  uid_store: string;
  name: string;
  default: boolean;
  quantity: number;
  locations: BookingStoreLocation[];
}
```

### `BookingStoreLocation`

A specific location within a store allocated for a booking.

```ts
interface BookingStoreLocation {
  uid_location: string;
  name: string;
  quantity: number;
  default: boolean;
}
```

### `BookingUpdate`

```ts
const BookingUpdate: z.ZodType<BookingUpdateType>;
```

### `BookingUpdateType`

Per-row entry for the bulk fulfillment-bookings endpoint. Matches
`UpdateBookingInputType` field-for-field, plus the booking `uid` to address
the row (since the URL carries the fulfillment uid, not the booking uid).

```ts
interface BookingUpdateType {
  uid: string;
  status?: BookingStatusType;
  breakdown?: indexedAccess;
  version: number;
}
```

### `BookingUpdated`

```ts
type BookingUpdated = EventEnvelope<Booking> & typeLiteral;
```

### `BulkBookingUpdateInput`

```ts
const BulkBookingUpdateInput: z.ZodType<BulkBookingUpdateInputType>;
```

### `BulkBookingUpdateInputType`

Body of `PUT /fulfillments/{uid}/bookings` — applies N booking transitions
for one order in a single Firestore transaction.

Top-level `version` is the fulfillment doc version at read time. Currently
advisory: a stale value 409s. Per-row `version` carries each booking's
current version for optimistic concurrency.

No fixed cap on `updates.length`. Bound only by the real Firestore limits
(270s tx duration, 10 MiB request size). The bulk service rejects empty
arrays with 400.

```ts
interface BulkBookingUpdateInputType {
  version: number;
  updates: BookingUpdateType[];
  uid_session: string;
}
```

### `BulkBookingUpdateResponse`

```ts
const BulkBookingUpdateResponse: z.ZodType<BulkBookingUpdateResponseType>;
```

### `BulkBookingUpdateResponseType`

Successful response from `PUT /fulfillments/{uid}/bookings`. Per-row
`results` carry the post-write booking versions in input order.

```ts
interface BulkBookingUpdateResponseType {
  success: true;
  order_completed: boolean;
  oos_records_written: number;
  results: Array<typeLiteral>;
}
```

### `CFS_SOURCE_COLLECTIONS`

Collections that may legitimately appear as a {@link DocSourceType} `collection`.

This was `z.string().min(1)` — free text that reached a Firestore collection
name. `CreateCardInput.sources` comes straight off the POST body and
`createCard` copies it into the THREAD's `sources`, so
`POST /cards {sources:[{collection:"cards", uid:X}]}` wrote a thread claiming
a card as its own source, which `deleteCard` then unpicks by
`s.collection === "cards"`. Every consumer was re-deriving the same implicit
"it's one of the known CFS collections" contract; it is encoded once here.

Membership is the union of a read-only survey of every stored `DocSource` in
BOTH envs (threads, comments, cards, recurrences.prototype, out-of-service
`sources[]` + `transactions[].source` — dev and prod agreed on the same 12
values, no malformed entries) plus `template-components`, which has no stored
instance yet but is declared legitimate by `TEMPLATE_SOURCES` in `comment.ts`.

`transactions` is now a live-written source: the movement journal links a
reversal to the event it negates, and a component event to its parent, both
through `sources[]`. (It was historical-only when this list was surveyed —
898 instances, identical count in both envs.) Never narrow this past stored
data; survey first.

`locations` carries no `sources[]` of its own — it is here because a movement
line's `location.from` / `location.to` is a `DocSource` pointing at wherever
the units physically are: a `locations` doc (on a shelf), a `bookings` doc
(out on a job), or an `out-of-service` record. Widening is safe; the
`DocSource` shape is unchanged.

```ts
const CFS_SOURCE_COLLECTIONS: "bookings" | "cards" | "contacts" | "credit-notes" | "invoices" | "locations" | "orders" | "organizations" | "out-of-service" | "products" | "roles" | "settlements" | "template-components" | "templates" | "templates-versions" | "transactions"[];
```

### `COAClass`

Zod schema for COAClass.

```ts
const COAClass: z.ZodType<COAClassType>;
```

### `COAClassType`

Which side of a posting this account sits on.

```ts
type COAClassType = indexedAccess;
```

### `COACode`

Zod schema for COACode.

```ts
const COACode: z.ZodType<COACodeType>;
```

### `COACodeType`

A chart-of-accounts code.

No longer a closed union — see the module docstring. The catalog is the
`chart-of-accounts` collection, so an unknown code is caught by a lookup that
can actually be refreshed, not by a literal list that goes stale silently.

```ts
type COACodeType = number;
```

### `COARevenueEnum`

Zod schema for COARevenueType.

```ts
const COARevenueEnum: z.ZodType<COARevenueType>;
```

### `COARevenueType`

Allowed values for chart-of-accounts revenue code.

```ts
type COARevenueType = indexedAccess;
```

### `COAStatus`

Zod schema for COAStatus.

```ts
const COAStatus: z.ZodType<COAStatusType>;
```

### `COAStatusType`

Whether Xero still offers this account for new coding.

```ts
type COAStatusType = indexedAccess;
```

### `COAType`

Zod schema for COAType.

```ts
const COAType: z.ZodType<COATypeType>;
```

### `COATypeType`

Valid chart of accounts type values.

```ts
type COATypeType = indexedAccess;
```

### `COA_BAD_DEBT`

Xero's Bad Debt account. The one posting account a `reason` determines.

```ts
const COA_BAD_DEBT: 6900;
```

### `CREDIT_NOTE_REASONS`

Why this credit was issued — the `credit` arm of {@link SETTLEMENT_CONTRACTS},
**derived rather than re-listed**, so the document and the settlements it
spawns can never offer different reasons.

The reason lives on the *document* and is denormalized onto each settlement:
one credit note allocated across three invoices has one reason, and authoring
it three times invites three answers.

```ts
const CREDIT_NOTE_REASONS: readonly SettlementReasonType[];
```

### `CUSTODY_PLACE_KINDS`

**Location is a total function**: every owned unit is in exactly one kind of
place, determined by its custody key. Consumed by the balance checker (rule 2)
and by every writer, so the mapping exists once.

`out` is the one key whose place depends on the booking: a rental's units sit
at the booking until they come back, a sale's units left ownership at the
point of sale and are nowhere.

```ts
const CUSTODY_PLACE_KINDS: Readonly<Record<BookingBreakdownKeyType, readonly PlaceKindType[]>>;
```

### `CacheGeocodes`

Full Firestore document for a cached geocode result.

```ts
interface CacheGeocodes {
  query: string;
  coordinates: CoordinatesType | null;
  mapbox_id: string;
  address: CacheGeocodesAddress;
  created_at: FirestoreTimestampType;
  expiresAt: FirestoreTimestampType;
}
```

### `CacheGeocodesAddress`

Parsed address fields returned from a geocode lookup.

```ts
interface CacheGeocodesAddress {
  street?: string;
  city?: string;
  region?: string;
  postcode?: string;
  country_name?: string;
  full?: string;
  name?: string;
}
```

### `CacheGeocodesSchema`

Zod schema for CacheGeocodes.

Every field here except the timestamps describes ONE customer address, so the
whole document is PII and is tagged as such. It is the untagged twin of
`Address` (`common.ts`) — hand-rolled from the Mapbox response rather than
reusing the primitive — and it stayed untagged because `cache-geocodes` was
not in `tests/pii.test.ts`'s old hand-maintained schema list.

Tagged to match `Address` exactly: `mask` on the object so a new field is
masked by default, with the three coarse-geography leaves opting OUT (a city
/ state / country identifies no one alone, and the mask transform mangles
them). `query`, `coordinates` and `mapbox_id` are tagged individually because
they sit OUTSIDE the address object — and each one resolves to the same
street address on its own, so masking `address` while leaving them raw would
be theatre. Note `query`/`coordinates`/`mapbox_id` are invisible to the
name-dictionary in `pii/dictionary.ts`: no lint would have caught them.

```ts
const CacheGeocodesSchema: z.ZodType<CacheGeocodes>;
```

### `Card`

Card Firestore document shape.

```ts
interface Card {
  uid: string;
  uid_list: string;
  uid_thread: string;
  status: CardStatus;
  action: CardAction | null;
  position: number;
  subject: string;
  body: CommentBodyJson | null;
  body_text: string;
  dates: CardDatesType;
  all_day: boolean;
  date_fs: FirestoreTimestampType | null;
  destination: DocDestinationEndpointType | null;
  organization: CardOrganizationType | null;
  sources: DocSourceType[];
  attachments: CardAttachmentType[];
  uid_assignees: string[];
  locked: CardLockKey[];
  recurrence_parent_uid: string | null;
  recurrence_index: number | null;
  recurrence_overrides: string[];
  version: number;
  created_by: ActorRefType;
  updated_by: ActorRefType;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}
```

### `CardAction`

Denormalized "next action" for a card's primary button, computed server-side
on every booking write (alongside `status`). Surfaces on Dashboard/Calendar
surfaces where no bookings are loaded, so the button can show the *next* step
without a join.

A discriminated object (not a flat enum) so non-fulfillment sources can be
added as purely additive arms (e.g. `{ source: "out_of_service", value: … }`)
without a cross-repo field rename. `null` when nothing is actionable
(terminal status, or no pending step on this side).

```ts
type CardAction = typeLiteral;
```

### `CardActionSchema`

Zod schema for CardAction (discriminated on `source`; JSR no-slow-types-safe).

```ts
const CardActionSchema: z.ZodType<CardAction>;
```

### `CardAttachment`

Zod schema for a card attachment.

One node, seven consumers — `CardSchema`, `RecurrenceSchema`'s prototype, and
the create/update inputs of both all reference this same instance (no
`.extend()` / `.omit()` / `.pick()` anywhere in `src/schemas/`), and
`z.globalRegistry` is a WeakMap keyed on the instance. So the single
`uploadcareRef()` below annotates `uid` for every one of them.

```ts
const CardAttachment: z.ZodType<CardAttachmentType>;
```

### `CardAttachmentType`

A single attachment on a card (Uploadcare UUID + display metadata).

```ts
interface CardAttachmentType {
  uid: string;
  type: CardAttachmentTypeEnum;
  filename: string;
  mime_type: string;
  size_bytes: number;
  locked: boolean;
}
```

### `CardAttachmentTypeEnum`

Semantic discriminator for a card attachment. Server-derived attachments
(packing/quote/invoice) carry their domain meaning so the UI can render
them as labelled chips without sniffing MIME or filename. User uploads
default to `image` (when MIME starts with `image/`) or `file` otherwise.

```ts
type CardAttachmentTypeEnum = indexedAccess;
```

### `CardAttachmentTypeEnumSchema`

Zod schema for CardAttachmentTypeEnum.

```ts
const CardAttachmentTypeEnumSchema: z.ZodType<CardAttachmentTypeEnum>;
```

### `CardCreated`

```ts
type CardCreated = EventEnvelope<Card> & typeLiteral;
```

### `CardDates`

Zod schema for the card dates sub-object.

```ts
const CardDates: z.ZodType<CardDatesType>;
```

### `CardDatesType`

Card datetime range. `start` is the canonical occurrence instant — Chicago
offset form, idempotent through `chicagoInstant()`. `end` carries the
occurrence's wall-clock close (deliveries with start + end times); `null`
means single-instant or all-day. `start` is nullable so cards without a
date (generic to-dos, shopping items) stay valid.

```ts
interface CardDatesType {
  start: string | null;
  end: string | null;
}
```

### `CardDeleted`

```ts
type CardDeleted = EventEnvelope<Card> & typeLiteral;
```

### `CardFulfillmentAction`

The next fulfillment step a fulfillment-sourced card surfaces on its button.

```ts
type CardFulfillmentAction = indexedAccess;
```

### `CardFulfillmentActionEnum`

Zod schema for CardFulfillmentAction.

```ts
const CardFulfillmentActionEnum: z.ZodType<CardFulfillmentAction>;
```

### `CardId`

`cards.uid` — either a Firestore auto-id (kanban/to-do cards) or an
`EventCardId` composite (auto-generated order event cards).

```ts
const CardId: z.ZodType<string>;
```

### `CardLockKey`

Enum of lockable card surfaces.

- `"card"` — presence blocks DELETE (all other keys are field locks)
- `"status_auto"` — narrow override slot: server auto-computes `status`,
  but PATCH still accepts `status: "blocked"` (manual block) or a no-op of
  the current auto value. Distinct from `"status"`, which fully locks the
  field.
- Any other value — presence rejects PATCH of that specific field

Narrower than `(keyof Card)[]` because (a) most Card fields are
system-managed (uid, timestamps, actor refs) and nonsensical to lock, and
(b) we need a sentinel for "prevent delete" that doesn't collide with a
real field name.

```ts
type CardLockKey = indexedAccess;
```

### `CardLockKeyEnum`

Zod schema for CardLockKey.

```ts
const CardLockKeyEnum: z.ZodType<CardLockKey>;
```

### `CardOrganization`

Zod schema for CardOrganizationType.

```ts
const CardOrganization: z.ZodType<CardOrganizationType>;
```

### `CardOrganizationType`

Denormalized organization snapshot on order-derived event cards. Surfaces
"who is this card for?" on every card-rendering surface (list, kanban,
calendar, dashboard) without joining back to the order. `uid` is nullable
because some organizations exist without a CFS-side uid (legacy CRMS-only
customers).

```ts
interface CardOrganizationType {
  uid: string | null;
  name: string;
}
```

### `CardSchema`

Zod schema for a card Firestore document.

```ts
const CardSchema: z.ZodType<Card>;
```

### `CardStatus`

Allowed card statuses. Shared across field-service, to-do, shopping, calendar.

```ts
type CardStatus = indexedAccess;
```

### `CardStatusEnum`

Zod schema for CardStatus.

```ts
const CardStatusEnum: z.ZodType<CardStatus>;
```

### `CardUpdated`

```ts
type CardUpdated = EventEnvelope<Card> & typeLiteral;
```

### `CellKind`

How a cell should render a column's value, derived from the annotated node's
*type* rather than from its name.

The predecessor guessed from the path — `includes("email")`, `includes("phone")`,
`includes("address")` — which is why `z.email()` fields never got a `mailto:`
(in Zod 4 `z.email() instanceof z.ZodString` is **false**, so the walker that
fed the picker never even offered them) and why a column named `city` under an
`address` parent rendered the whole multi-line block.

`plain` is the honest default: money and rate formatting is decided by the
cell from the storage convention (`*_cents`) and the `unit` annotation, both
of which are value-level facts a column kind cannot carry.

```ts
type CellKind = "link" | "email" | "phone" | "date" | "address" | "name" | "bool" | "enum" | "plain";
```

### `CfsSourceCollectionEnum`

Zod schema for CfsSourceCollectionType.

```ts
const CfsSourceCollectionEnum: z.ZodType<CfsSourceCollectionType>;
```

### `CfsSourceCollectionType`

A collection name valid in a {@link DocSourceType}.

```ts
type CfsSourceCollectionType = indexedAccess;
```

### `ChartOfAccounts`

A chart of accounts document in Firestore.

```ts
interface ChartOfAccounts {
  uid: string;
  code: COACodeType;
  name: string;
  type: COATypeType;
  class: COAClassType;
  status: COAStatusType;
  xero_id: string | null;
  description?: string;
  version: number;
  created_by: ActorRefType;
  updated_by: ActorRefType;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}
```

### `ChartOfAccountsSchema`

Zod schema for ChartOfAccounts.

```ts
const ChartOfAccountsSchema: z.ZodType<ChartOfAccounts>;
```

### `ChartOfAccountsUpdated`

```ts
type ChartOfAccountsUpdated = EventEnvelope<ChartOfAccounts> & typeLiteral;
```

### `ClientAppType`

Identifier for a client application that emits logs.

```ts
type ClientAppType = indexedAccess;
```

### `ClientLogBatch`

A batch of client log entries submitted in a single request.

```ts
interface ClientLogBatch {
  logs: ClientLogEntry[];
}
```

### `ClientLogBatchSchema`

Zod schema for {@link ClientLogBatch}.

```ts
const ClientLogBatchSchema: z.ZodType<ClientLogBatch>;
```

### `ClientLogEntry`

A single log entry sent from a client application.

```ts
interface ClientLogEntry {
  level: LogLevelType;
  msg: string;
  ts: string;
  app: ClientAppType;
  page?: string;
  request_id?: string;
  data?: Record<string, unknown>;
}
```

### `ClientLogEntrySchema`

Zod schema for {@link ClientLogEntry}.

The `data` field is capped at 20 top-level keys + 4 KB stringified to
defend against runaway client-side payloads. Manager logs in practice
carry ≤5 keys and <500 bytes per entry, so this cap is far above the
legitimate ceiling.

```ts
const ClientLogEntrySchema: z.ZodType<ClientLogEntry>;
```

### `CollectDisplayColumnsResult`

Result of {@link collectDisplayColumns}. `unhandled` MUST be empty.

```ts
interface CollectDisplayColumnsResult {
  columns: DisplayColumn[];
  unhandled: Array<typeLiteral>;
}
```

### `CollectLeafPathsResult`

Result of {@link collectLeafPaths}. `unhandled` MUST be empty — see below.

```ts
interface CollectLeafPathsResult {
  leaves: LeafPath[];
  unhandled: Array<typeLiteral>;
}
```

### `CollectionRule`

One edge in the propagation graph — describes data flow between two collections.

```ts
interface CollectionRule {
  id: string;
  source: string;
  target: string;
  mode: PropagationMode;
  invariant?: string;
  enforced_by?: EnforcementRef[];
  transaction?: string;
  trigger?: string;
  fields: FieldMapping[];
}
```

### `Comment`

Comment Firestore document shape.

```ts
interface Comment {
  uid: string;
  uid_thread: string;
  sources: DocSourceType[];
  body: CommentBodyJson;
  body_text: string;
  reactions: Record<string, Record<string, ActorRefType>>;
  git?: CommentGitMirror;
  version: number;
  created_by: ActorRefType;
  deleted_at: FirestoreTimestampType | null;
  deleted_by: ActorRefType | null;
  updated_by: ActorRefType;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}
```

### `CommentBody`

Zod schema for the Tiptap JSON body.

```ts
const CommentBody: z.ZodType<CommentBodyJson>;
```

### `CommentBodyJson`

Tiptap JSON body payload. Stored as a loose record to keep the schema
forward-compatible with Tiptap's node spec. The composer owns shape
correctness; the `body_text` mirror is the authoritative plain-text form.

```ts
type CommentBodyJson = Record<string, unknown>;
```

### `CommentCreated`

```ts
type CommentCreated = EventEnvelope<Comment> & typeLiteral;
```

### `CommentDeleted`

```ts
type CommentDeleted = EventEnvelope<Comment> & typeLiteral;
```

### `CommentReactionInput`

Zod schema for a comment reaction add/remove.

```ts
const CommentReactionInput: z.ZodType<CommentReactionInputType>;
```

### `CommentReactionInputType`

Input for POST /comments/:uid/reactions.

```ts
interface CommentReactionInputType {
  emoji: string;
  action: ReactionActionType;
}
```

### `CommentSchema`

Zod schema for a comment Firestore document.

```ts
const CommentSchema: z.ZodType<Comment>;
```

### `CommentUpdated`

```ts
type CommentUpdated = EventEnvelope<Comment> & typeLiteral;
```

### `CommitMeta`

Conventional-commit metadata captured at release/publish time.

```ts
interface CommitMeta {
  author: ActorRefType;
  type: string;
  message: string;
  breaking: boolean;
}
```

### `CommitMetaSchema`

Zod schema for CommitMeta. `author` reuses the pii-annotated ActorRef.

```ts
const CommitMetaSchema: z.ZodType<CommitMeta>;
```

### `ComponentSchema`

Schema for a `component_of` back-reference. `inclusion_type` is optional here
because the parent authors it — see {@link ProductComponent}.

A catalog component is a line item in waiting: `COMPONENT_TYPES` is a subset
of `DOC_LINE_ITEM_TYPES` (pinned by a compile-time assertion in `common.ts`),
and every component that survives expansion becomes an order line of the same
`type`. So it answers to the same contract, and the rental ⇒
`price.replacement_cents` rule is stated once rather than a third time here.

```ts
const ComponentSchema: z.ZodType<ProductComponent>;
```

### `ComponentTypeEnum`

Zod schema for ComponentTypeType.

```ts
const ComponentTypeEnum: z.ZodType<ComponentTypeType>;
```

### `ComponentTypeType`

Allowed values for component type.

```ts
type ComponentTypeType = indexedAccess;
```

### `ConsolidatedItemType`

A consolidated line item — aggregated quantity and price for display.
Used by consolidateItems() in utilities and the manager app.

```ts
interface ConsolidatedItemType {
  uid: string;
  name: string;
  type: string;
  quantity: number;
  total_price_cents: number;
  unit_price_cents: number;
  stock_method: string;
}
```

### `Contact`

Full contact document schema (Firestore document shape).

```ts
interface Contact {
  uid: string;
  name: string;
  crms_id?: number;
  emails: string[];
  phones: string[];
  organizations: ContactOrganizationType[];
  query_by_organizations: string[];
  uid_user?: string;
  uid_thread?: string;
  version: number;
  created_by: ActorRefType;
  updated_by: ActorRefType;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}
```

### `ContactCreated`

```ts
type ContactCreated = EventEnvelope<Contact> & typeLiteral;
```

### `ContactOrganization`

Zod schema for an organization reference embedded in a contact.

```ts
const ContactOrganization: z.ZodType<ContactOrganizationType>;
```

### `ContactOrganizationType`

Organization reference embedded in a contact document.

```ts
interface ContactOrganizationType {
  uid: string;
  name: string;
}
```

### `ContactSchema`

Zod schema for a full contact Firestore document.

```ts
const ContactSchema: z.ZodType<Contact>;
```

### `ContactUpdated`

```ts
type ContactUpdated = EventEnvelope<Contact> & typeLiteral;
```

### `Coordinates`

Zod schema for coordinates (latitude/longitude), nullable.

```ts
const Coordinates: z.ZodType<CoordinatesType | null>;
```

### `CoordinatesType`

Coordinates object (latitude/longitude).

```ts
interface CoordinatesType {
  latitude: number;
  longitude: number;
}
```

### `Counter`

A counter document in the counters Firestore collection.

```ts
interface Counter {
  count: number;
  updated_at: FirestoreTimestampType;
}
```

### `CounterSchema`

Zod schema for a Counter document.

```ts
const CounterSchema: z.ZodType<Counter>;
```

### `CreateCardInput`

Zod schema for creating a card.

```ts
const CreateCardInput: z.ZodType<CreateCardInputType>;
```

### `CreateCardInputType`

Input for POST /cards.

```ts
interface CreateCardInputType {
  uid_list: string;
  subject: string;
  status?: CardStatus;
  position?: number;
  body?: CommentBodyJson | null;
  body_text?: string;
  dates?: CardDatesType;
  all_day?: boolean;
  destination?: DocDestinationEndpointType | null;
  organization?: CardOrganizationType | null;
  sources?: DocSourceType[];
  attachments?: CardAttachmentType[];
  uid_assignees?: string[];
  locked?: CardLockKey[];
}
```

### `CreateCommentInput`

Zod schema for creating a comment.

```ts
const CreateCommentInput: z.ZodType<CreateCommentInputType>;
```

### `CreateCommentInputType`

Input for POST /comments.

```ts
interface CreateCommentInputType {
  uid_thread: string;
  body: CommentBodyJson;
  body_text: string;
}
```

### `CreateContactInput`

Input schema for creating a contact.

```ts
const CreateContactInput: z.ZodType<CreateContactInputType>;
```

### `CreateContactInputType`

Input schema for POST /contacts — what the endpoint accepts.

```ts
interface CreateContactInputType {
  uid: string;
  emails?: string[];
  phones?: string[];
  organizations?: ContactOrganizationType[];
}
```

### `CreateFixedHolidayInputType`

Input type for creating a fixed-date holiday.

```ts
interface CreateFixedHolidayInputType {
  uid?: string;
  type: "fixed";
  name: string;
  month: number;
  date: number;
}
```

### `CreateHolidayDefinitionInput`

Input schema for creating a holiday definition.

```ts
const CreateHolidayDefinitionInput: z.ZodType<CreateHolidayDefinitionInputType>;
```

### `CreateHolidayDefinitionInputType`

Input type for creating a holiday definition.

```ts
type CreateHolidayDefinitionInputType = CreateFixedHolidayInputType | CreateVariableHolidayInputType;
```

### `CreateInviteInput`

Input schema for POST /admin/users/invite.

```ts
const CreateInviteInput: z.ZodType<CreateInviteInputType>;
```

### `CreateInviteInputType`

Input to POST /admin/users/invite.

```ts
interface CreateInviteInputType {
  email: string;
  roles: string[];
}
```

### `CreateInvoiceInput`

Input schema for creating an invoice.

```ts
const CreateInvoiceInput: z.ZodType<CreateInvoiceInputType>;
```

### `CreateInvoiceInputType`

Input schema for POST /invoices — create an invoice from orders.

```ts
interface CreateInvoiceInputType {
  uid: string;
  query_by_orders: string[];
  organization: typeLiteral;
  tax_profile: TaxProfileType;
  items?: InvoiceItemInputType[];
  destinations?: InvoiceDocDestinationType[];
  date?: string;
  due_date?: string;
  subject?: string;
  reference?: string | null;
  external_notes?: string;
  internal_notes?: string;
}
```

### `CreateListInput`

Zod schema for creating a list.

```ts
const CreateListInput: z.ZodType<CreateListInputType>;
```

### `CreateListInputType`

Input for POST /lists.

```ts
interface CreateListInputType {
  name: string;
  description?: string;
  icon?: string | null;
  color?: string | null;
  position?: number;
  locked?: ListLockKey[];
}
```

### `CreateLocationInput`

Input schema for creating a location.

```ts
const CreateLocationInput: z.ZodType<CreateLocationInputType>;
```

### `CreateLocationInputType`

Input type for creating a location.

```ts
interface CreateLocationInputType {
  uid: string;
  uid_store: string;
  name: string;
  uid_location_type?: string | null;
}
```

### `CreateLocationTypeInput`

Input schema for creating a location type.

```ts
const CreateLocationTypeInput: z.ZodType<CreateLocationTypeInputType>;
```

### `CreateLocationTypeInputType`

Input type for creating a location type.

```ts
interface CreateLocationTypeInputType {
  name: string;
  product_capacities?: Record<string, typeLiteral>;
  dimensions?: typeLiteral | null;
}
```

### `CreateOrderInput`

Input schema for creating an order.

```ts
const CreateOrderInput: z.ZodType<CreateOrderInputType>;
```

### `CreateOrderInputType`

Input schema for POST /orders — what the endpoint accepts.

```ts
interface CreateOrderInputType {
  uid: string;
  organization: typeLiteral;
  status: OrderStatusType;
  tax_profile: TaxProfileType;
  destinations: DestinationType[];
  items?: OrderItemType[];
  subject?: string;
  reference?: string | null;
}
```

### `CreateOrganizationInput`

Input schema for creating an organization.

```ts
const CreateOrganizationInput: z.ZodType<CreateOrganizationInputType>;
```

### `CreateOrganizationInputType`

Input schema for POST /organizations.
crms_id and xero_id are obtained from external APIs — not in input.

```ts
interface CreateOrganizationInputType {
  uid: string;
  name: string;
  tax_profile: TaxProfileType;
  billing_address: AddressType | null;
  contacts?: OrganizationContactType[];
  newContacts?: NewContactInputType[] | null;
  emails?: string[];
  phones?: string[];
}
```

### `CreateOutOfServiceInput`

Zod schema for CreateOutOfServiceInput.

```ts
const CreateOutOfServiceInput: z.ZodType<CreateOutOfServiceInputType>;
```

### `CreateOutOfServiceInputType`

Input for creating an out-of-service record.

```ts
interface CreateOutOfServiceInputType {
  uid_product: string;
  reason: OOSReasonType;
  quantity: number;
  dates: typeLiteral;
  sources?: DocSourceType[];
  stores?: OOSStore[];
  crms_id?: number | null;
  crms_stock_level_id?: number | null;
}
```

### `CreateProductInput`

Input schema for creating a product.

```ts
const CreateProductInput: z.ZodType<CreateProductInputType>;
```

### `CreateProductInputType`

Input type for creating a product.

```ts
interface CreateProductInputType {
  uid: string;
  name: string;
  active: boolean;
  type: ProductTypeType;
  stock_method: StockMethodType;
  component_only: boolean;
  description: string;
  eligible_delivery: boolean;
  eligible_in_store_pickup: boolean;
  eligible_shipping_ground: boolean;
  eligible_shipping_air: boolean;
  price: typeLiteral;
  shipping?: typeLiteral;
  alternates?: UidNameRefType[];
  components?: ProductComponent[];
  component_of?: ProductComponent[];
  tags?: UidNameRefType[];
  uid_tracking_category?: string | null;
  uid_linked_rental?: string | null;
  uid_linked_replacement?: string | null;
  webshop: typeLiteral;
  transaction?: typeLiteral;
}
```

### `CreateRecurrenceInput`

Zod schema for creating a recurrence.

```ts
const CreateRecurrenceInput: z.ZodType<CreateRecurrenceInputType>;
```

### `CreateRecurrenceInputType`

Input for POST /recurrences.

```ts
interface CreateRecurrenceInputType {
  uid_list: string;
  status?: RecurrenceStatus;
  rule: RecurrenceRuleType;
  active_from: string;
  active_until?: string | null;
  horizon_days?: number | null;
  prototype: typeLiteral;
}
```

### `CreateStoreInput`

Input schema for creating a store.

```ts
const CreateStoreInput: z.ZodType<CreateStoreInputType>;
```

### `CreateStoreInputType`

Input type for creating a store.

```ts
interface CreateStoreInputType {
  uid: string;
  name: string;
  crms_store_id: number;
  default?: boolean;
}
```

### `CreateStoreTransferInput`

Input schema for a store-to-store transfer.

One event, not the old `transfer_increase` + `transfer_decrease` pair:
`location: {from, to}` says what two documents used to. `total_cost` is gone —
a transfer nets to zero on ownership, so it has no cost object to mis-gate,
which is what made #286 possible.

```ts
const CreateStoreTransferInput: z.ZodType<CreateStoreTransferInputType>;
```

### `CreateStoreTransferInputType`

Input for creating a store-to-store transfer.

```ts
interface CreateStoreTransferInputType {
  uid_product: string;
  quantity: number;
  date: string;
  reference: string;
  uid_session: string;
  from: MovementAllocationInputType[];
  to: MovementAllocationInputType[];
  serialized_details?: typeLiteral | null;
}
```

### `CreateTagInput`

Input schema for creating a tag.

```ts
const CreateTagInput: z.ZodType<CreateTagInputType>;
```

### `CreateTagInputType`

Input type for creating a tag.

```ts
interface CreateTagInputType {
  uid?: string;
  name: string;
}
```

### `CreateTaxInput`

Zod schema for CreateTaxInput.

```ts
const CreateTaxInput: z.ZodType<CreateTaxInputType>;
```

### `CreateTaxInputType`

Input for creating a new tax definition.

```ts
interface CreateTaxInputType {
  name: string;
  rate: number;
  type: RateType;
  active?: boolean;
  valid_from: string;
  valid_to?: string | null;
}
```

### `CreateTrackingCategoryInput`

Input schema for creating a tracking category.

```ts
const CreateTrackingCategoryInput: z.ZodType<CreateTrackingCategoryInputType>;
```

### `CreateTrackingCategoryInputType`

Input type for creating a tracking category.

```ts
interface CreateTrackingCategoryInputType {
  uid: string;
  name: string;
  crms_product_group_id: number;
  crms_product_group_name: string;
}
```

### `CreateTransactionInput`

Input schema for creating a manual movement.

`uid` is gone: the document id is derived (`{uid_session}|{type}|{subject}`),
which is what makes a retried create idempotent instead of appending a second
event. `allocations` is optional — absent means the server allocates.

```ts
const CreateTransactionInput: z.ZodType<CreateTransactionInputType>;
```

### `CreateTransactionInputType`

Input for creating a manual movement.

```ts
interface CreateTransactionInputType {
  uid_product: string;
  type: indexedAccess;
  quantity: number;
  total_cost_cents: number;
  date: string;
  reference: string;
  uid_session: string;
  allocations?: MovementAllocationInputType[];
  serialized_details?: typeLiteral | null;
}
```

### `CreateUserInput`

Input schema for creating a user (internal — not exposed as a public route).

```ts
const CreateUserInput: z.ZodType<CreateUserInputType>;
```

### `CreateUserInputType`

Payload for creating a user — used internally by the accept-invite flow.

```ts
interface CreateUserInputType {
  email: string;
  password: string;
  roles?: string[];
  uid_contact?: string | null;
}
```

### `CreateVariableHolidayInputType`

Input type for creating a variable-date holiday.

```ts
interface CreateVariableHolidayInputType {
  uid?: string;
  type: "variable";
  name: string;
  month: number;
  day: number;
  week: HolidayWeekInputType;
}
```

### `CreditNote`

A credit note issued to an organization.

```ts
interface CreditNote {
  uid: string;
  number: number;
  status: CreditNoteStatusType;
  reason: SettlementReasonType;
  date: string;
  date_fs: FirestoreTimestampType;
  reference: string | null;
  external_notes?: string | null;
  internal_notes?: string | null;
  organization: typeLiteral;
  tax_profile: TaxProfileType;
  items: CreditNoteDocLineItem[];
  totals: CreditNoteDocTotals;
  remaining_credit_cents: number;
  sources: DocSourceType[];
  query_by_sources: string[];
  xero_credit_note_id: string | null;
  uid_thread?: string;
  version: number;
  created_by: ActorRefType;
  updated_by: ActorRefType;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}
```

### `CreditNoteDocItemPrice`

Pricing breakdown for a single credit-note line.

```ts
interface CreditNoteDocItemPrice {
  base_cents: number;
  base_percent?: number | null;
  chargeable_days: number | null;
  formula: PriceFormulaType;
  subtotal_cents: number;
  subtotal_discounted_cents: number;
  discount: DiscountType | null;
  taxes: PriceModifierType[];
  total_cents: number;
}
```

### `CreditNoteDocLineItem`

A credited line.

**`coa_revenue` is required, not optional.** A credit spanning lines with
different revenue accounts (#1689 hits 4000 and 4100; #1322 is all 4210)
cannot be posted correctly from a document-level amount, and apportioning it
afterwards is inferring cause from effect — the thing `transaction.ts` warns
against. This is also the gap Xero *has*: its allocation view carries
`LineItems: []`, and Odoo's users pay OCA for a module that adds line-level
provenance.

**No dividers.** A credit note has no destinations and bills no orders, so the
whole `ORDER_ITEM_LEVELS` / `INVOICE_ITEM_LEVELS` hierarchy — and the `path`
machinery that goes with it — has nothing to organize here. Lines are flat.

## `coa_revenue` and `coa_posting` are TWO facts, and a line has both

They are routinely different, and collapsing them loses real information.
Measured on the live tenant: CN-1009 writes off 35 lines whose products are
rentals — `product.price.coa_revenue` 4000 Rental Income — and every one of
them posts to **6900 Bad Debt**. Store only the posting account and the
revenue attribution that tracking-category rollups and the tax tables depend
on is gone; store only the revenue account and the write-off is invisible.

- **`coa_revenue`** — the revenue account of the *thing being credited*.
  Product-sourced, same vocabulary as the invoice line it mirrors, and the
  input to {@link isTaxableCoa}. Never the account the credit posts to.
- **`coa_posting`** — where this credit lands in the ledger. Any account in
  the `chart-of-accounts` catalog, including the expense range, which is
  exactly why it cannot be `COARevenueEnum`: that enum is shared with
  `Product.price.coa_revenue`, and widening it would make a catalog product
  whose revenue account is Bad Debt Expense representable.

```ts
interface CreditNoteDocLineItem {
  uid: string;
  type: DocLineItemTypeType;
  name: string;
  description: string;
  quantity: number;
  price: CreditNoteDocItemPrice;
  coa_revenue: COARevenueType | null;
  coa_posting: number;
  tracking_category: string | null;
  xero_id: string | null;
  xero_tracking_option_id: string | null;
  uid_invoice_item: string | null;
}
```

### `CreditNoteDocLineItem`

Zod schema for a credit-note line item.

```ts
const CreditNoteDocLineItem: z.ZodType<CreditNoteDocLineItem>;
```

### `CreditNoteDocLineItemType`

_(reference — see source)_

### `CreditNoteDocLineItemType`

_(reference — see source)_

### `CreditNoteDocTotals`

Credit-note totals.

Integer cents, matching `items[]` and matching the `settlements` journal the
allocations are drawn into. **This document used to be dollars end to end**
while the journal beside it was already cents — a split that was recorded as
an intentional boundary and was in fact just drift, and which meant the 2dp
census had never evaluated this corpus at all.

**No `transaction_fees`.** A card-processing fee is charged when money is
taken, not when it is given back; crediting one is an `order_adjustment` line,
not a fee row.

```ts
interface CreditNoteDocTotals {
  subtotal_cents: number;
  subtotal_discounted_cents: number;
  discount_amount_cents: number;
  taxes: PriceModifierType[];
  total_cents: number;
}
```

### `CreditNoteSchema`

Zod schema for a CreditNote.

```ts
const CreditNoteSchema: z.ZodType<CreditNote>;
```

### `CreditNoteStatusEnum`

Zod schema for CreditNoteStatusType.

```ts
const CreditNoteStatusEnum: z.ZodType<CreditNoteStatusType>;
```

### `CreditNoteStatusType`

Allowed credit-note statuses.

```ts
type CreditNoteStatusType = indexedAccess;
```

### `DOC_LINE_ITEM_TYPES`

Billable line item types stored in order/invoice documents (excludes destination/group dividers).

```ts
const DOC_LINE_ITEM_TYPES: "rental" | "replacement" | "sale" | "service" | "surcharge" | "transaction_fee"[];
```

### `DeleteTagInput`

Input schema for deleting a tag.

```ts
const DeleteTagInput: z.ZodType<DeleteTagInputType>;
```

### `DeleteTagInputType`

Input type for deleting a tag.

```ts
interface DeleteTagInputType {
  uid: string;
}
```

### `Destination`

Zod schema for a destination pair.

```ts
const Destination: z.ZodType<DestinationType>;
```

### `DestinationContact`

Zod schema for destination contact reference.

```ts
const DestinationContact: z.ZodType<DestinationContactType>;
```

### `DestinationContactRef`

Zod schema for a contact reference embedded in a destination.

```ts
const DestinationContactRef: z.ZodType<DestinationContactRefType>;
```

### `DestinationContactRefType`

Contact reference embedded in a destination document.

Mirrors the split-name shape used in `organizations.contacts[]` so that the
Typesense `destinations_v5` collection can index the same `first_name /
middle_name / last_name / pronunciation` fields without an adapter. `name`
is the server-derived display string (see `deriveName` in common.ts).

```ts
interface DestinationContactRefType {
  uid: string;
  name: string;
}
```

### `DestinationContactType`

Contact reference embedded in a destination endpoint.
When present (not null), uid and first_name are required. `name` is the
server-derived display string (see `deriveName` in common.ts) — populated
by api-cloudrun on every write so consumers don't re-derive client-side.

```ts
interface DestinationContactType {
  uid: string;
  name: string;
  phones?: string[];
}
```

### `DestinationDoc`

Full Firestore document for a destination (a physical address used in orders).

```ts
interface DestinationDoc {
  uid: string;
  address: AddressType | null;
  mapbox_ids: string[];
  organizations?: UidNameRefType[];
  query_by_organizations?: string[];
  products?: UidNameRefType[];
  query_by_products?: string[];
  contacts?: DestinationContactRefType[];
  query_by_contacts?: string[];
  version: number;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}
```

### `DestinationEndpoint`

Zod schema for a destination endpoint.

```ts
const DestinationEndpoint: z.ZodType<DestinationEndpointType>;
```

### `DestinationEndpointType`

A single destination endpoint (delivery or collection).

```ts
interface DestinationEndpointType {
  uid?: string | null;
  address?: AddressType | null;
  instructions?: string | null;
  contact?: DestinationContactType | null;
}
```

### `DestinationSchema`

Zod schema for Destination.

```ts
const DestinationSchema: z.ZodType<Destination>;
```

### `DestinationType`

A destination pair — delivery and collection endpoints.

`customer_collecting` is true when the customer picks up the items at our
warehouse for the delivery side of this pair. `customer_returning` is true
when the customer drops the items off at our warehouse for the collection
side. Both default to false (we deliver / we collect).

```ts
interface DestinationType {
  dates: OrderDatesType;
  delivery: DestinationEndpointType;
  collection: DestinationEndpointType;
  customer_collecting?: boolean;
  customer_returning?: boolean;
}
```

### `Discount`

Zod schema for an item discount.

```ts
const Discount: z.ZodType<DiscountType>;
```

### `DiscountInput`

Zod schema for a discount input (without computed amount).

```ts
const DiscountInput: z.ZodType<DiscountInputType>;
```

### `DiscountInputType`

Discount input — rate and type only. Amount is computed by calculateItemPrice.

```ts
interface DiscountInputType {
  rate: number;
  type: RateType;
}
```

### `DiscountType`

Discount applied to an item price. Nullable — null means no discount.
rate is per-unit for flat discounts (rate × quantity × days_factor = amount).

```ts
interface DiscountType {
  rate: number;
  type: RateType;
  amount_cents: number;
}
```

### `DisplayColumn`

A display column declared on a schema with `.meta({ column: true })`.

```ts
interface DisplayColumn {
  path: string;
  label: string;
  node: z.ZodType;
  type: string;
  format?: string;
  meta: Record<string, unknown>;
}
```

### `DisplaySort`

Sort configuration for a display preference (column + direction).

```ts
interface DisplaySort {
  column: string | null;
  direction: "asc" | "desc";
}
```

### `DisplayTableColumn`

A column offered to a table surface.

```ts
interface DisplayTableColumn {
  key: string;
  label: string;
  sortable: boolean;
  serverSort?: typeLiteral;
  cell: CellKind;
  meta: Record<string, unknown>;
}
```

### `DividerItemType`

The `kind: "divider"` members — the structural types that organize an array.

```ts
type DividerItemType = indexedAccess;
```

### `DmarcAggregateLogRecord`

Structured log entry for one record from a DMARC aggregate report.

```ts
interface DmarcAggregateLogRecord {
  level: LogLevelType;
  msg: "dmarc_aggregate_record";
  ts: string;
  source_ip: string;
  count: number;
  disposition: string;
  dkim_result: string;
  spf_result: string;
  dkim_aligned: boolean;
  spf_aligned: boolean;
  header_from: string;
  org_name: string;
  report_id: string;
  domain: string;
  date_range_begin: number;
  date_range_end: number;
  dmarc_pass: "true" | "false";
  request_id?: string;
  method?: string;
  path?: string;
  route?: string;
  user_id?: string;
  trace_id?: string;
  span_id?: string;
}
```

### `DmarcAggregateLogRecordSchema`

Zod schema for {@link DmarcAggregateLogRecord}.

```ts
const DmarcAggregateLogRecordSchema: z.ZodType<DmarcAggregateLogRecord>;
```

### `DocDestination`

Zod schema for a document-level destination pair.

```ts
const DocDestination: z.ZodType<DocDestinationType>;
```

### `DocDestinationContact`

Zod schema for destination contact reference (document version).

```ts
const DocDestinationContact: z.ZodType<DocDestinationContactType>;
```

### `DocDestinationContactType`

Contact reference in a destination endpoint (document schema — uid & first_name required).

```ts
interface DocDestinationContactType {
  uid: string;
  name: string;
  phones?: string[];
}
```

### `DocDestinationEndpoint`

Zod schema for a destination endpoint (document version).

```ts
const DocDestinationEndpoint: z.ZodType<DocDestinationEndpointType>;
```

### `DocDestinationEndpointType`

Destination endpoint in the full document (uid is nullable, contact uses doc version).

```ts
interface DocDestinationEndpointType {
  uid: string | null;
  address: AddressType | null;
  instructions: string | null;
  contact: DocDestinationContactType | null;
}
```

### `DocDestinationType`

Document-level destination pair. See `DestinationType` for flag semantics.

```ts
interface DocDestinationType {
  dates: OrderDocDatesType;
  delivery: DocDestinationEndpointType;
  collection: DocDestinationEndpointType;
  customer_collecting: boolean;
  customer_returning: boolean;
}
```

### `DocItemTypeEnum`

Zod schema for DocItemTypeType.

```ts
const DocItemTypeEnum: z.ZodType<DocItemTypeType>;
```

### `DocItemTypeType`

All item types accepted in order/invoice input schemas (includes structural dividers).

```ts
type DocItemTypeType = indexedAccess;
```

### `DocLineItemTypeEnum`

Zod schema for DocLineItemTypeType.

```ts
const DocLineItemTypeEnum: z.ZodType<DocLineItemTypeType>;
```

### `DocLineItemTypeType`

Billable line item types stored in order/invoice documents (excludes destination/group dividers).

```ts
type DocLineItemTypeType = indexedAccess;
```

### `DocSource`

Zod schema for a polymorphic doc reference.

```ts
const DocSource: z.ZodType<DocSourceType>;
```

### `DocSourceType`

A `{collection, uid}` pointer to any Firestore document. Used polymorphically
by Thread, Comment, and Card to reference the source docs they belong to.

Lives here (not in thread.ts where it originated) because it's a shared
primitive — the "thread" prefix misled readers into thinking it was
thread-specific.

```ts
interface DocSourceType {
  collection: CfsSourceCollectionType;
  uid: string;
  label?: string | null;
}
```

### `Email`

Email string with format and length constraints.

```ts
const Email: z.ZodType<string>;
```

### `EmailInput`

```ts
const EmailInput: z.ZodType<EmailInputType>;
```

### `EmailInputType`

Input schema for POST /auth/forgot-password and POST /auth/resend-verification.

```ts
interface EmailInputType {
  email: string;
}
```

### `EmailSendFailedLogRecord`

Structured log entry for a failed outbound email.

```ts
interface EmailSendFailedLogRecord {
  level: LogLevelType;
  msg: "email_send_failed";
  ts: string;
  status: number;
  body?: string;
  email_from: string;
  to?: string;
  subject?: string;
  request_id?: string;
  method?: string;
  path?: string;
  route?: string;
  user_id?: string;
  trace_id?: string;
  span_id?: string;
}
```

### `EmailSendFailedLogRecordSchema`

Zod schema for {@link EmailSendFailedLogRecord}.

```ts
const EmailSendFailedLogRecordSchema: z.ZodType<EmailSendFailedLogRecord>;
```

### `EmailSentLogRecord`

Structured log entry for a successful outbound email.

```ts
interface EmailSentLogRecord {
  level: LogLevelType;
  msg: "email_sent";
  ts: string;
  email_from: string;
  to?: string;
  request_id?: string;
  method?: string;
  path?: string;
  route?: string;
  user_id?: string;
  trace_id?: string;
  span_id?: string;
}
```

### `EmailSentLogRecordSchema`

Zod schema for {@link EmailSentLogRecord}.

```ts
const EmailSentLogRecordSchema: z.ZodType<EmailSentLogRecord>;
```

### `EmailVerification`

Full Firestore document for a single-use email verification token.

```ts
interface EmailVerification {
  user_id: string;
  email: string;
  expiresAt: FirestoreTimestampType;
  created_at: number;
}
```

### `EmailVerificationSchema`

Zod schema for EmailVerification.

```ts
const EmailVerificationSchema: z.ZodType<EmailVerification>;
```

### `EventCardId`

`cards` event-card composite id — `{uid_order}:{uid_destination}:start|end`
(one per order delivery/collection endpoint). See `api-cloudrun
src/lib/eventCards.ts` (`EventPosition = "start" | "end"`).

```ts
const EventCardId: z.ZodType<string>;
```

### `EventEnvelope`

Common envelope wrapping every domain event.

`data` is the full Firestore document after all server sentinels
(serverTimestamp, increment, etc.) have been resolved by Firestore.

```ts
interface EventEnvelope {
  event: string;
  version: number;
  timestamp: string;
  timestamp_fs: FirestoreTimestampType;
  source_uid: string;
  correlation_id?: string;
  data: T;
}
```

### `FIRESTORE_TIMESTAMP_META`

Meta key marking a node as the {@link FirestoreTimestamp} custom type.

`isDateLikeNode` used to recognise it by **instance identity** — the only
handle a `z.custom()` offers, since its `def.type` is the uninformative
`"custom"`. That was safe exactly as long as nobody annotated a timestamp
field, because **`.meta()` clones**: `FirestoreTimestamp.meta({ label })` is a
different instance, the identity test fails, and a `created_at` column
silently stops rendering as a date and starts printing a raw epoch. Declaring
display columns means annotating `created_at` / `updated_at` / `last_order`,
so the identity test had to go.

A meta marker survives the clone because `.meta()` **merges**: the clone
carries both this key and whatever the annotation added.

```ts
const FIRESTORE_TIMESTAMP_META: "firestoreTimestamp";
```

### `FULFILLMENT_LINE_ITEM_TYPES`

Line item types a fulfillment carries — the `fulfillable: true` members.
`transaction_fee` is excluded because a fee has no stock and is never picked
off a shelf, so this is NOT a narrower spelling of {@link DOC_LINE_ITEM_TYPES}
waiting to be collapsed into it; the exclusion IS the contract.

Lives here rather than in `fulfillment.ts` so the list, the table it must
agree with, and the assertion below are one thing to read.

```ts
const FULFILLMENT_LINE_ITEM_TYPES: "rental" | "replacement" | "sale" | "service" | "surcharge"[];
```

### `FieldMapping`

Describes how a single field moves from source to target.

```ts
interface FieldMapping {
  source: FieldPath;
  target: FieldPath;
  transform?: string;
}
```

### `FieldPath`

Path segments into a document — e.g. ["organization", "uid"]. Empty = computed/metadata.

```ts
type FieldPath = string[];
```

### `FirestoreDisplayDefaults`

Display defaults for a Firestore collection in the UI.

```ts
interface FirestoreDisplayDefaults {
  columns: string[];
  filters: Record<string, parenthesized[]>;
  sort: typeLiteral;
  groupBy?: GroupByAxis[];
}
```

### `FirestoreDisplayPrefs`

User display preferences for a Firestore-backed collection view.

```ts
interface FirestoreDisplayPrefs {
  columns: string[];
  filters: Record<string, parenthesized[]>;
  sort: DisplaySort;
}
```

### `FirestoreFieldValue`

Structural interface for Firestore FieldValue (write-time sentinel).

```ts
interface FirestoreFieldValue {
  isEqual(other: FirestoreFieldValue): boolean;
}
```

### `FirestoreId`

Atomic Firestore auto-generated document id (`[A-Za-z0-9]{20}`).

```ts
const FirestoreId: z.ZodType<string>;
```

### `FirestoreTimestamp`

Firestore Timestamp — structural check for `{ seconds, nanoseconds }`.

Tight on purpose: rejects `undefined`, `null`, plain objects, and
`FieldValue` write-time sentinels (which only carry `isEqual`). Writers
must stamp a real `Timestamp` (e.g. `Timestamp.now()` from
`firebase-admin/firestore`) — `validateBeforeWrite` strips `FieldValue`
sentinels before validation, so a sentinel-stamped timestamp would
surface here as `undefined` and fail loudly.

The accepted union still includes `FirestoreFieldValue` for back-compat
with consumers that type fields against the union (e.g. user-facing
`cloneDeep` mutate-then-stamp patterns), but the runtime gate enforces
the real-Timestamp contract.

Carries {@link FIRESTORE_TIMESTAMP_META} so it stays recognisable **through a
`.meta()` clone** — see that constant.

```ts
const FirestoreTimestamp: z.ZodType<FirestoreTimestampType>;
```

### `FirestoreTimestampType`

Union of Firestore Timestamp (read) and FieldValue (write).

```ts
type FirestoreTimestampType = FirestoreTimestampValue | FirestoreFieldValue;
```

### `FirestoreTimestampValue`

Structural interfaces for Firestore Timestamp and FieldValue.
Expressed structurally so the schemas package has no firebase-admin dependency.

```ts
interface FirestoreTimestampValue {
  seconds: number;
  nanoseconds: number;
  toMillis(): number;
  toDate(): Date;
}
```

### `FixtureMeta`

A fixture manifest entry — the operator-facing label/description for one
git-canonical fixture (`fixtures/<git_path>/<slug>.json`). Files are
authoritative: discovery globs the directory; this manifest only enriches
the manager list with labels. An orphaned manifest entry (slug with no
matching file) is ignored at render/golden time — never breaks a render.

```ts
interface FixtureMeta {
  slug: string;
  label: string;
  description?: string;
}
```

### `FixtureMetaSchema`

Zod schema for a fixture manifest entry.

```ts
const FixtureMetaSchema: z.ZodType<FixtureMeta>;
```

### `FromTotalItemType`

The `pricing: "from_total"` members — priced FROM the document total rather
than into it, which is what makes a `percent_of_total` formula legal on them.

```ts
type FromTotalItemType = indexedAccess;
```

### `FulfillableItemType`

```ts
type FulfillableItemType = indexedAccess;
```

### `Fulfillment`

Sanitized order document for the fulfillment client view.
Mirrors the order by uid — one fulfillment doc per order.

```ts
interface Fulfillment {
  uid: string;
  number: number;
  status: FulfillmentOrderStatusType;
  organization: typeLiteral;
  destinations: DocDestinationType[];
  items: FulfillmentItemType[];
  subject: string;
  reference: string | null;
  query_by_items: string[];
  query_by_contacts: string[];
  query_by_dates: string[];
  version: number;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}
```

### `FulfillmentDestinationItem`

```ts
const FulfillmentDestinationItem: z.ZodType<FulfillmentDestinationItemType>;
```

### `FulfillmentDestinationItemType`

Destination divider in the fulfillment items array.

```ts
interface FulfillmentDestinationItemType {
  uid: string;
  type: "destination";
  name: string;
  path: string[];
  uid_delivery: string | null;
  uid_collection: string | null;
  description: string;
}
```

### `FulfillmentGroupItem`

```ts
const FulfillmentGroupItem: z.ZodType<FulfillmentGroupItemType>;
```

### `FulfillmentGroupItemType`

Group divider in the fulfillment items array.

```ts
interface FulfillmentGroupItemType {
  uid: string;
  type: "group";
  name: string;
  path: string[];
  description: string;
}
```

### `FulfillmentItem`

```ts
const FulfillmentItem: z.ZodType<FulfillmentItemType>;
```

### `FulfillmentItemType`

Union of all item types in the fulfillment order view.

```ts
type FulfillmentItemType = FulfillmentLineItemType | FulfillmentDestinationItemType | FulfillmentGroupItemType;
```

### `FulfillmentLineItem`

```ts
const FulfillmentLineItem: z.ZodType<FulfillmentLineItemType>;
```

### `FulfillmentLineItemType`

Line item in the fulfillment order view — no price, no financial flags.

```ts
interface FulfillmentLineItemType {
  uid: string;
  type: FulfillmentLineItemTypeType;
  name: string;
  description: string;
  quantity: number;
  stock_method?: StockMethodType;
  path: string[];
  order_number?: number;
  uid_order?: string;
  uid_delivery?: string | null;
  uid_collection?: string | null;
  quantity_order?: number;
  path_substituted_for?: string[];
}
```

### `FulfillmentSchema`

```ts
const FulfillmentSchema: z.ZodType<Fulfillment>;
```

### `GOLDEN_DIFF_VERDICTS`

Golden visual-diff verdicts (mirrors the golden-diff endpoint).

`no-fixtures` is an informational result emitted when a template family has
zero fixtures in git — there is nothing to render, so CI treats it as a pass
and the manager renders it as a "capture a source doc to enable golden
review" hint. It's never aggregated with other verdicts (the family-level
aggregate uses the per-fixture entries directly).

```ts
const GOLDEN_DIFF_VERDICTS: "match" | "diff" | "no-golden" | "renderer-unavailable" | "no-fixtures"[];
```

### `GetAvailabilityInput`

```ts
const GetAvailabilityInput: z.ZodType<GetAvailabilityInputType>;
```

### `GetAvailabilityInputType`

```ts
interface GetAvailabilityInputType {
  productUid: string;
  type: "rental" | "sale";
  start?: string;
  end?: string;
  date?: string;
}
```

### `GoldenDiff`

Per-fixture golden visual-diff result for a draft branch. The CI golden-diff
path fans out over the family's git-canonical fixtures (`fixtures/<gp>/*.json`)
and persists one entry per fixture so the manager can render the
approve-to-merge review row-by-row. `image_uuids` are Uploadcare UUIDs
(served via ucarecdn.com); `fixture` is the slug join key
(`fixtures/<gp>/<slug>.json`).

```ts
interface GoldenDiff {
  fixture: string;
  verdict: GoldenDiffVerdict;
  delta: number;
  image_uuids: typeLiteral;
  sha: string;
  checked_at: FirestoreTimestampType;
}
```

### `GoldenDiffSchema`

Zod schema for a GoldenDiff.

```ts
const GoldenDiffSchema: z.ZodType<GoldenDiff>;
```

### `GoldenDiffVerdict`

```ts
type GoldenDiffVerdict = indexedAccess;
```

### `GroupByAxis`

Describes how a client should enumerate the keys a groupBy axis produces.

- `enum` — keys come from the Zod enum at `field` (e.g. card status).
- `collectionFeed` — keys come from a live Firestore collection (e.g. one
  section per list); `collection` names the source.
- `dateBucket` — keys are computed client-side from the row's date value;
  no separate per-key query.

A single "None" / ungrouped axis is represented with `field: null` and no
`kind` — the axis lists which *groupings are available*, and "no grouping"
is always one of them.

```ts
interface GroupByAxis {
  field: string | null;
  label: string;
  kind?: "enum" | "collectionFeed" | "dateBucket";
  collection?: string;
}
```

### `GroupPathType`

Path context for an item — which destination and group it belongs to.
Used by getGroupPath() in utilities and consumed by the manager app.

```ts
interface GroupPathType {
  destination: string | null;
  group: string | null;
  product: string | null;
}
```

### `HolidayDates`

Full Firestore document for a single holiday date entry.

```ts
interface HolidayDates {
  uid: string;
  uid_holiday: string;
  date: string;
  date_fs: FirestoreTimestampType;
  name: string;
  type: "fixed" | "variable";
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}
```

### `HolidayDatesAdded`

```ts
type HolidayDatesAdded = EventEnvelope<HolidayDates> & typeLiteral;
```

### `HolidayDatesDeleted`

```ts
type HolidayDatesDeleted = EventEnvelope<HolidayDates> & typeLiteral;
```

### `HolidayDatesSchema`

Zod schema for HolidayDates.

```ts
const HolidayDatesSchema: z.ZodType<HolidayDates>;
```

### `HolidayDefinition`

A holiday definition document in Firestore (collection: holiday-definitions).

`type: "fixed"` rules carry `date` (day-of-month); `type: "variable"` rules
carry `day`/`display_day`/`week`/`display_suffix` (e.g. "3rd Monday"). The
variant fields are optional on the document because both shapes share one
collection; the input schemas guarantee the correct set per type.

```ts
interface HolidayDefinition {
  uid: string;
  type: HolidayType;
  name: string;
  display_month: number;
  js_month: number;
  date?: number;
  day?: string;
  display_day?: string;
  week?: string;
  display_suffix?: string;
  active: boolean;
  version: number;
  created_by: ActorRefType;
  updated_by: ActorRefType;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}
```

### `HolidayDefinitionSchema`

Zod schema for HolidayDefinition.

```ts
const HolidayDefinitionSchema: z.ZodType<HolidayDefinition>;
```

### `HolidaySnapshot`

The materialized holiday snapshot singleton (`holiday-snapshot/current`).

```ts
interface HolidaySnapshot {
  uid: "current";
  materialized_dates: string[];
  materialized_count: number;
  materialized_year_range: HolidaySnapshotYearRange;
  materialized_at: FirestoreTimestampType;
}
```

### `HolidaySnapshotSchema`

Zod schema for HolidaySnapshot.

```ts
const HolidaySnapshotSchema: z.ZodType<HolidaySnapshot>;
```

### `HolidaySnapshotYearRange`

Inclusive year span covered by the materialized snapshot.

```ts
interface HolidaySnapshotYearRange {
  from: number;
  to: number;
}
```

### `HolidayType`

Holiday rule discriminator.

```ts
type HolidayType = "fixed" | "variable";
```

### `HolidayWeekInputType`

Ordinal-week selector for a variable holiday — string or numeric form.

```ts
type HolidayWeekInputType = "1" | "2" | "3" | "4" | "last" | 1 | 2 | 3 | 4;
```

### `HorizonMaterialized`

```ts
type HorizonMaterialized = EventEnvelope<HorizonMaterializedData> & typeLiteral;
```

### `HorizonMaterializedData`

Payload shape for `horizon.materialized` — compact summary, not a full
document. Emitted per-recurrence after a materialize-horizon run writes
(or would have written) new cards.

```ts
interface HorizonMaterializedData {
  recurrence_uid: string;
  horizon_through: string;
  previous_horizon_through: string | null;
  cards_created: number;
  dates_skipped_exceptions: number;
}
```

### `INVOICE_STATUS_CONTRACTS`

The per-status contract table.

The `Readonly<Record<InvoiceStatusType, …>>` annotation is what enforces
totality: a sixth status is a type error **here**, at the declaration, which
forces an answer to all five questions rather than defaulting four of them.
No separate parity guard — a `T extends keyof typeof TABLE` assertion beside
this would read `T extends T` and could not fail.

Deliberately **not** carrying an `amounts` column. Two status↔amounts rules
were proposed and both were killed by paging all 962 prod invoices:
`paid ⟹ amount_due <= 0` fails on 20 of 813, and `issued ⟹ amount_paid == 0`
fails on **75 of 98** — a bucket whose money matches Xero to the cent and
whose `status` is what is stale. The arithmetic identity that did survive
(`amount_paid + amount_credited + amount_due == total`, exempting `void`)
ships separately as a `superRefine`, because it is the one rule that does not
mention status.

```ts
const INVOICE_STATUS_CONTRACTS: Readonly<Record<InvoiceStatusType, InvoiceStatusContract>>;
```

### `ITEM_CONTRACTS`

The per-type item contract table. @see {@link ItemContract}

```ts
const ITEM_CONTRACTS: Readonly<Record<ItemTypeType, ItemContract>>;
```

### `InclusionTypeEnum`

Zod schema for InclusionTypeType.

```ts
const InclusionTypeEnum: z.ZodType<InclusionTypeType>;
```

### `InclusionTypeType`

Allowed values for component inclusion type.

```ts
type InclusionTypeType = indexedAccess;
```

### `InventoryLedger`

An inventory ledger document tracking stock quantities and costs per product.

```ts
interface InventoryLedger {
  uid: string;
  uid_product: string;
  type: ProductTypeType;
  stock_method: InventoryStockMethodType;
  quantity_held: number;
  quantity_in_service: number;
  quantity_out_of_service: number;
  average_unit_cost: number;
  total_cost_basis_cents: number;
  out_of_service_breakdown: typeLiteral;
  store_breakdown: StoreBreakdownEntry[];
  query_by_uid_store: string[];
  query_by_uid_location: string[];
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}
```

### `InventoryLedgerRecalculated`

```ts
type InventoryLedgerRecalculated = EventEnvelope<InventoryLedger> & typeLiteral;
```

### `InventoryLedgerSchema`

Zod schema for an InventoryLedger document.

```ts
const InventoryLedgerSchema: z.ZodType<InventoryLedger>;
```

### `Invite`

Full Firestore document for a single-use invite.

```ts
interface Invite {
  uid: string;
  email: string;
  name: string;
  roles: string[];
  invited_by: string;
  used: boolean;
  expires_at: FirestoreTimestampType;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}
```

### `InviteSchema`

Zod schema for an Invite document.

```ts
const InviteSchema: z.ZodType<Invite>;
```

### `Invoice`

An invoice document in the invoices Firestore collection.

```ts
interface Invoice {
  uid: string;
  number: number;
  status: InvoiceStatusType;
  query_by_orders: string[];
  number_orders: number[];
  tax_profile: TaxProfileType;
  date: string;
  date_fs: FirestoreTimestampType;
  due_date?: string;
  due_date_fs?: FirestoreTimestampType;
  subject?: string | null;
  reference?: string | null;
  external_notes?: string | null;
  internal_notes?: string | null;
  organization: typeLiteral;
  destinations: InvoiceDocDestinationType[];
  items: InvoiceDocItemType[];
  totals: InvoiceDocTotals;
  xero_id: string | null;
  uploadcare_uuid: string | null;
  pdf_generated_at: FirestoreTimestampType | null;
  pdf_versions?: Array<typeLiteral>;
  uploadcare_files?: Array<typeLiteral>;
  crms_id?: number | null;
  crms_opportunity_ids?: number[];
  uid_thread?: string;
  version: number;
  created_by: ActorRefType;
  updated_by: ActorRefType;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}
```

### `InvoiceCreated`

```ts
type InvoiceCreated = EventEnvelope<Invoice> & typeLiteral;
```

### `InvoiceDocDestination`

```ts
const InvoiceDocDestination: z.ZodType<InvoiceDocDestinationType>;
```

### `InvoiceDocDestinationType`

Destination pair on an invoice — mirrors the order's `DocDestinationType`
with a `uid_order` scope field so multi-order invoices can carry pairs
from several orders and have them selectively synced per source order.
Carries `dates` (rendered on the invoice) snapshotted from the source order.

```ts
interface InvoiceDocDestinationType {
  uid_order: string;
}
```

### `InvoiceDocItem`

Zod schema for any invoice document item — discriminated on `type`.

The invoice side never carried a second `transaction_fee` claimant, so it was
always discriminable; it stayed a plain union only because the order side
wasn't. See `OrderDocItem`.

```ts
const InvoiceDocItem: z.ZodType<InvoiceDocItemType>;
```

### `InvoiceDocItemPrice`

Pricing breakdown for a single invoice line item.

```ts
interface InvoiceDocItemPrice {
  base_cents: number;
  base_percent?: number | null;
  chargeable_days: number | null;
  formula: PriceFormulaType;
  subtotal_cents: number;
  subtotal_discounted_cents: number;
  discount: DiscountType | null;
  taxes: PriceModifierType[];
  taxes_base?: TaxRefType[];
  total_cents: number;
  discount_percent?: number;
}
```

### `InvoiceDocItemType`

Union of all item types stored in an invoice document.

```ts
type InvoiceDocItemType = InvoiceDocLineItem | OrderDocGroupItemType | OrderDocDestinationItemType | InvoiceDocOrderItemType;
```

### `InvoiceDocLineItem`

A billable line item on an invoice.

```ts
interface InvoiceDocLineItem {
  uid: string;
  type: DocLineItemTypeType;
  name: string;
  description: string;
  quantity: number;
  price: InvoiceDocItemPrice;
  path: string[];
  coa_revenue?: COARevenueType | null;
  tracking_category?: string | null;
  xero_id?: string | null;
  xero_tracking_option_id?: string | null;
  crms_opportunity_id?: number | null;
  crms_id?: number | string | null;
}
```

### `InvoiceDocLineItemSchema`

```ts
const InvoiceDocLineItemSchema: z.ZodType<InvoiceDocLineItem>;
```

### `InvoiceDocOrderItem`

Zod schema for an order divider item.

```ts
const InvoiceDocOrderItem: z.ZodType<InvoiceDocOrderItemType>;
```

### `InvoiceDocOrderItemType`

Order divider item — scopes invoice items to a source order for multi-order invoices.

```ts
interface InvoiceDocOrderItemType {
  uid: string;
  type: "order";
  name: string;
  path: string[];
  description: string;
}
```

### `InvoiceDocTotals`

Invoice-level totals with settlement tracking.

`amount_paid`, `amount_credited` and `amount_due` are a **co-written
projection** of the `settlements` journal — produced only by
`recomputeSettlementTotals`, written in the same transaction as the settlement
that changed them, and rebuildable from the log by
`scripts/repair-invoice-settlement-totals.ts`. They are not a denormalization
to apologise for; they are the target architecture, and the same shape
`stock-summaries` already has against the movement journal.

`total` is NOT part of that projection — it derives from `items[]`. So the
rebuild is deliberately **partial**: it repairs the settlement-fed fields
without re-pricing anything.

```ts
interface InvoiceDocTotals {
  subtotal_cents: number;
  subtotal_discounted_cents: number;
  discount_amount_cents: number;
  taxes: PriceModifierType[];
  transaction_fees: PriceModifierType[];
  total_cents: number;
  amount_paid_cents: number;
  amount_credited_cents?: number;
  amount_void_cents?: number;
  amount_due_cents: number;
}
```

### `InvoiceIssued`

```ts
type InvoiceIssued = EventEnvelope<Invoice> & typeLiteral;
```

### `InvoiceItemInputDestination`

Zod schema for a destination divider (invoice input).

```ts
const InvoiceItemInputDestination: z.ZodType<InvoiceItemInputDestinationType>;
```

### `InvoiceItemInputDestinationType`

A destination divider as a client sends it.

```ts
interface InvoiceItemInputDestinationType {
  uid: string;
  type: "destination";
  name?: string;
  description?: string;
  path?: string[];
  uid_delivery?: string;
  uid_collection?: string;
}
```

### `InvoiceItemInputGroup`

Zod schema for a group divider (invoice input).

```ts
const InvoiceItemInputGroup: z.ZodType<InvoiceItemInputGroupType>;
```

### `InvoiceItemInputGroupType`

A group divider as a client sends it.

```ts
interface InvoiceItemInputGroupType {
  uid: string;
  type: "group";
  name?: string;
  description?: string;
  path?: string[];
}
```

### `InvoiceItemInputLine`

Zod schema for a billable invoice line (input).

```ts
const InvoiceItemInputLine: z.ZodType<InvoiceItemInputLineType>;
```

### `InvoiceItemInputLineType`

A billable invoice line as a client sends it — the input mirror of
`InvoiceDocLineItemSchema`.

`uid_order` / `uid_delivery` / `uid_collection` are absent on purpose. The
flat schema this replaces accepted all three on any item; `buildInvoiceItems`
reads the destination pair only on a destination divider and reads `uid_order`
nowhere at all (the order divider's identity IS the source order's uid — the
transitional field was retired in Phase D, and the manager stopped sending
it). Prod agrees: 0 of 8,744 invoice line items carry any of the three.

```ts
interface InvoiceItemInputLineType {
  uid: string;
  type: DocLineItemTypeType;
  name?: string;
  description?: string;
  quantity?: number;
  price?: InvoiceItemInputPrice;
  path?: string[];
  coa_revenue?: COARevenueType | null;
  tracking_category?: string | null;
}
```

### `InvoiceItemInputOrder`

Zod schema for an order divider (invoice input).

```ts
const InvoiceItemInputOrder: z.ZodType<InvoiceItemInputOrderType>;
```

### `InvoiceItemInputOrderType`

An order divider as a client sends it — invoice-only, scopes items to a source order.

```ts
interface InvoiceItemInputOrderType {
  uid: string;
  type: "order";
  name?: string;
  description?: string;
  path?: string[];
}
```

### `InvoiceItemInputType`

Input version of an invoice item — a line, or one of the three dividers.

```ts
type InvoiceItemInputType = InvoiceItemInputLineType | InvoiceItemInputDestinationType | InvoiceItemInputGroupType | InvoiceItemInputOrderType;
```

### `InvoiceSchema`

Zod schema for an Invoice document.

```ts
const InvoiceSchema: z.ZodType<Invoice>;
```

### `InvoiceStatusContract`

What one invoice status admits, on every axis anything in CFS asks about.

Five hand-written status sets used to live in four repos, and three of them
were textually identical while a fourth looked identical and was not. As
columns they stop looking like duplicates of each other and start being
separate answers to separate questions — which is what makes collapsing them
safe where a naive merge was not.

```ts
interface InvoiceStatusContract {
  operator_moves: readonly InvoiceStatusType[];
  reached_xero: boolean;
  live_in_xero: boolean;
  settled: boolean;
  accepts_payment: boolean;
}
```

### `InvoiceStatusEnum`

Zod schema for InvoiceStatusType.

```ts
const InvoiceStatusEnum: z.ZodType<InvoiceStatusType>;
```

### `InvoiceStatusType`

Possible invoice statuses.

```ts
type InvoiceStatusType = indexedAccess;
```

### `InvoiceUpdated`

```ts
type InvoiceUpdated = EventEnvelope<Invoice> & typeLiteral;
```

### `InvoiceVoided`

```ts
type InvoiceVoided = EventEnvelope<Invoice> & typeLiteral;
```

### `ItemContract`

The per-type rules an `items[]` entry must satisfy, one entry per
{@link ITEM_TYPES} member. Modelled on `MOVEMENT_CONTRACTS` in
`transaction.ts`: a table the schema reads, so a contradiction is reported by
the schema instead of restated in every consumer.

**The table carries only the axes that vary by TYPE.** The axes that vary by
COLLECTION are already the three documents' shapes and are not repeated here —
an invoice line has no `stock_method` key and its price has no `replacement`
key, a fulfillment line has no `price` at all, and every one of those objects
is a `z.strictObject`. Restating "forbidden" for them would be a second source
of truth for something the shape already makes inexpressible.

Measured against prod `cfs-3100` (951 orders / 958 invoices / 952
fulfillments, 2026-07-29) before each axis was written — three axes an earlier
draft proposed are absent because the corpus refutes them:

- **no `taxable` axis.** Every line type carries taxes on some rows and not
  others (surcharges: 149 of 151 order rows ARE taxed). Whether a line is
  taxed is the product's `tax_class` and the document's `tax_profile`, i.e.
  configuration, not a type invariant.
- **no per-type `formula` whitelist.** Order `sale`/`service`/`surcharge` rows
  are `fixed` while their invoice projections are `five_day_week` (617 sale,
  643 service, 137 surcharge). A whitelist keyed on type would reject the
  invoice side of the same line.
- **`replacement` is `optional`, not `forbidden`, off the rental arm.** All
  1,480 non-rental order line items carry a `price.replacement`; the builder
  writes it for every type.

```ts
interface ItemContract {
  kind: "divider" | "line";
  pricing: "pre_tax" | "from_total" | "none";
  replacement: "required_when_stocked" | "optional" | "forbidden";
  fulfillable: boolean;
  parentable_by: readonly ItemTypeType[];
}
```

### `ItemPrice`

Zod schema for item price breakdown (input).

```ts
const ItemPrice: z.ZodType<ItemPriceType>;
```

### `ItemPriceType`

Price breakdown for an order item (input — client sends partial data, server computes the rest).

```ts
interface ItemPriceType {
  base_cents?: number;
  base_percent?: number | null;
  replacement_cents?: number | null;
  chargeable_days?: number | null;
  formula?: PriceFormulaType;
  subtotal_cents?: number;
  discount?: DiscountInputType | null;
  taxes?: Array<typeLiteral>;
  total_cents?: number;
}
```

### `ItemTypeEnum`

Zod schema for {@link ItemTypeType}.

```ts
const ItemTypeEnum: z.ZodType<ItemTypeType>;
```

### `ItemTypeType`

Union of every order/invoice/fulfillment item type.

```ts
type ItemTypeType = indexedAccess;
```

### `ItemUid`

Polymorphic `items[].uid` + `path[]` segment in order/invoice/fulfillment
documents: a product's Firestore id, a divider UUID, or a custom-product id.

```ts
const ItemUid: z.ZodType<string>;
```

### `LIVE_IN_XERO_STATUSES`

Statuses whose Xero counterpart is expected to exist and be non-VOIDED.

Was three textually identical copies — `lib/xeroQuoteStatus.ts`,
`services/invoices.ts` and `scripts/audit-xero-quotes.ts`, the last carrying
a "keep in lockstep" comment that nothing enforced.

```ts
const LIVE_IN_XERO_STATUSES: readonly InvoiceStatusType[];
```

### `LeafPath`

A scalar leaf reached by {@link collectLeafPaths}.

```ts
interface LeafPath {
  path: string;
  node: z.ZodType;
  type: string;
  format?: string;
  meta: Record<string, unknown>;
}
```

### `List`

List Firestore document shape.

```ts
interface List {
  uid: string;
  name: string;
  description: string;
  icon: string | null;
  color: string | null;
  position: number;
  locked: ListLockKey[];
  version: number;
  created_by: ActorRefType;
  updated_by: ActorRefType;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}
```

### `ListCreated`

```ts
type ListCreated = EventEnvelope<List> & typeLiteral;
```

### `ListDeleted`

```ts
type ListDeleted = EventEnvelope<List> & typeLiteral;
```

### `ListId`

`lists.uid` (and `uid_list` references) — a Firestore auto-id (user-created
lists) or a lowercase-kebab slug (seeded/system lists, e.g. `in-store`,
`field-service`).

```ts
const ListId: z.ZodType<string>;
```

### `ListLockKey`

Enum of lockable list surfaces. Mirrors the `CardLockKey` shape: presence in
`List.locked[]` blocks the corresponding action. Defaults to `[]`.

- `"list"` — sentinel: blocks DELETE of this list doc
- `"create_card"` — blocks `POST /cards` with `uid_list` = this list
- `"update_card"` — blocks `PATCH /cards/:uid` for cards on this list
- `"delete_card"` — blocks `DELETE /cards/:uid` for cards on this list

Used by system-managed lists (e.g. `field-service`, `in-store`) whose cards
are fanned out from order events and shouldn't be created or deleted by
users — the API still updates them, and users can still edit non-locked
fields per `Card.locked[]`.

```ts
type ListLockKey = indexedAccess;
```

### `ListLockKeyEnum`

Zod schema for ListLockKey.

```ts
const ListLockKeyEnum: z.ZodType<ListLockKey>;
```

### `ListSchema`

Zod schema for a list Firestore document.

```ts
const ListSchema: z.ZodType<List>;
```

### `ListUpdated`

```ts
type ListUpdated = EventEnvelope<List> & typeLiteral;
```

### `Location`

A location document in Firestore.

```ts
interface Location {
  uid: string;
  uid_store: string;
  name: string;
  name_key?: string;
  default: boolean;
  uid_location_type: string | null;
  product_capacities: LocationProductCapacity[];
  query_by_product_capacities: string[];
  active: boolean;
  products: LocationProduct[];
  query_by_products: string[];
  version: number;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}
```

### `LocationCreated`

```ts
type LocationCreated = EventEnvelope<Location> & typeLiteral;
```

### `LocationProduct`

A product assigned to a location.

```ts
interface LocationProduct {
  uid: string;
  name: string;
  quantity: number;
  default: boolean;
}
```

### `LocationProductCapacity`

Product capacity constraint for a location.

```ts
interface LocationProductCapacity {
  uid: string;
  max: number | null;
  max_default: number | null;
}
```

### `LocationSchema`

Zod schema for Location.

```ts
const LocationSchema: z.ZodType<Location>;
```

### `LocationType`

A location type document in Firestore.

```ts
interface LocationType {
  uid: string;
  name: string;
  product_capacities: LocationTypeProductCapacity[];
  query_by_product_capacities?: string[];
  dimensions?: LocationTypeDimensions | null;
  version: number;
  active: boolean;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}
```

### `LocationTypeCreated`

```ts
type LocationTypeCreated = EventEnvelope<LocationType> & typeLiteral;
```

### `LocationTypeDimensions`

Physical dimensions for a location type.

```ts
interface LocationTypeDimensions {
  width?: number;
  depth?: number;
  height?: number;
  weight_capacity?: number;
}
```

### `LocationTypeProductCapacity`

Product capacity constraint for a location type.

```ts
interface LocationTypeProductCapacity {
  uid: string;
  max: number | null;
}
```

### `LocationTypeSchema`

Zod schema for LocationType.

```ts
const LocationTypeSchema: z.ZodType<LocationType>;
```

### `LocationTypeUpdated`

```ts
type LocationTypeUpdated = EventEnvelope<LocationType> & typeLiteral;
```

### `LocationUpdated`

```ts
type LocationUpdated = EventEnvelope<Location> & typeLiteral;
```

### `LogLevelEnum`

Zod enum for log levels — exported for reuse in arm schemas.

```ts
const LogLevelEnum: z.ZodType<LogLevelType>;
```

### `LogLevelType`

Log severity level.

```ts
type LogLevelType = indexedAccess;
```

### `LogRecord`

Structured log envelope emitted by the API (OpenAPI shape).

```ts
interface LogRecord {
  level: LogLevelType;
  msg: string;
  ts: string;
  request_id?: string;
  method?: string;
  path?: string;
  route?: string;
  user_id?: string;
  trace_id?: string;
  span_id?: string;
  duration_ms?: number;
  dry_run?: boolean;
}
```

### `LogRecordSchema`

Zod schema for {@link LogRecord} — generic envelope, OpenAPI-only.

```ts
const LogRecordSchema: z.ZodType<LogRecord>;
```

### `LoginInput`

```ts
const LoginInput: z.ZodType<LoginInputType>;
```

### `LoginInputType`

Input schema for POST /auth/login.

```ts
interface LoginInputType {
  email: string;
  password: string;
}
```

### `MOVEMENT_CONTRACTS`

The per-kind line contract, one entry per {@link MOVEMENT_TYPES} member.

```ts
const MOVEMENT_CONTRACTS: Readonly<Record<MovementTypeType, MovementContract>>;
```

### `MOVEMENT_TYPES`

Every kind of movement, as ONE classifier. There is deliberately no second
`kind` field: `type` is required in a strict object and drives
{@link getTransactionMultiplier}, so a document can never be half-classified.

Grouped by which axes the type carries — see {@link MOVEMENT_CONTRACTS}, which
is the machine-readable form of the same grouping.

**Removed in the journal migration**, all with zero stored instances in prod
AND dev, unreachable from `MANUAL_TRANSACTION_TYPES` and
{@link getDisplayTransactionTypes}: `acquisition`, `disposal`,
`partial_disposal`, `depreciation_tax`, `depreciation_gaap`. They were the
only unclassified branch, which is why `getTransactionMultiplier` used to
throw — a live 500 waiting on a type nothing could produce.

Asset depreciation IS on the roadmap. When it lands:
  - **`depreciation` wants to be ONE type with a `book` field** on the cost
    object, not `depreciation_tax` + `depreciation_gaap`. As types they double
    every future cost-only event; as a field the book is one dimension.
    The movement shape already exists: `lines: []` + a negative `cost`, the
    same shape a late landed-cost adjustment uses.
  - **`disposal` wants to come back as its own type**, even though `write_off`
    already covers the mechanics (`out-of-service → null` + `cost`). Finance
    reporting a "disposals" line has to tell a disposal from a damage
    write-off, and inferring that from "is there an OOS record in `sources[]`"
    is inferring cause from effect — the same reason a refund is a credit-note
    link and not a `total_cost > 0` test.
  - `acquisition` and `partial_disposal` do NOT come back: the first is
    `purchase`, and the second is a `disposal` whose quantity is less than
    what's held. Quantity already says it.

`transfer_increase` / `transfer_decrease` collapsed into a single
{@link MOVEMENT_CONTRACTS} `transfer`: they existed only because one row could
not say "out of A, into B", which `location: {from, to}` now says. The
migration rewrites the stored pairs.

```ts
const MOVEMENT_TYPES: "prep" | "check_out" | "check_in" | "mark_damaged" | "mark_lost" | "sale" | "sale_return" | "opening_balance" | "purchase" | "find" | "make" | "adjustment_increase" | "adjustment_decrease" | "trade_in" | "write_off" | "transfer"[];
```

### `MSG_SCHEMA_REGISTRY`

Runtime msg → schema lookup. The structured logger's `emit()` reads
`record.msg`, looks up the matching schema here, and (if present)
passes the record through the schema-driven PII walker in
`@cfs/core/schemas/pii` before stringification.

Records whose `msg` is NOT in this registry fall through to the
runtime key-name denylist tier (forward defense). The coverage test
in api-cloudrun keeps the registry exhaustive over what the source
tree emits.

```ts
const MSG_SCHEMA_REGISTRY: ReadonlyMap<string, z.ZodType>;
```

### `McpOAuthAuthorizeRequest`

Short-lived staging state for an in-flight authorization request.

```ts
interface McpOAuthAuthorizeRequest {
  id: string;
  user_uid: string;
  client_id: string;
  scope: string;
  redirect_uri: string;
  state?: string;
  code_challenge: string;
  code_challenge_method: "S256";
  created_at: number;
  expiresAt: FirestoreTimestampType;
}
```

### `McpOAuthAuthorizeRequestSchema`

Zod schema for McpOAuthAuthorizeRequest.

```ts
const McpOAuthAuthorizeRequestSchema: z.ZodType<McpOAuthAuthorizeRequest>;
```

### `McpOAuthClient`

A registered MCP client (dynamic client registration).

```ts
interface McpOAuthClient {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  created_at: number;
}
```

### `McpOAuthClientSchema`

Zod schema for McpOAuthClient.

```ts
const McpOAuthClientSchema: z.ZodType<McpOAuthClient>;
```

### `McpOAuthCode`

A single-use authorization code (stored under sha256(code)).

```ts
interface McpOAuthCode {
  user_uid: string;
  client_id: string;
  scope: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: "S256";
  created_at: number;
  expiresAt: FirestoreTimestampType;
}
```

### `McpOAuthCodeSchema`

Zod schema for McpOAuthCode.

```ts
const McpOAuthCodeSchema: z.ZodType<McpOAuthCode>;
```

### `McpOAuthToken`

An opaque access token (stored under sha256(token)).

```ts
interface McpOAuthToken {
  user_uid: string;
  client_id: string;
  scope: string;
  created_at: number;
  expiresAt: FirestoreTimestampType;
}
```

### `McpOAuthTokenSchema`

Zod schema for McpOAuthToken.

```ts
const McpOAuthTokenSchema: z.ZodType<McpOAuthToken>;
```

### `Movement`

A movement-journal event.

```ts
interface Movement {
  uid: string;
  number: number;
  uid_product: string;
  uid_booking: string | null;
  type: MovementTypeType;
  quantity: number;
  custody: MovementCustodyType | null;
  cost: MovementCostType | null;
  lines: MovementLineType[];
  date: string;
  date_fs: FirestoreTimestampType;
  reference: string;
  uid_session: string;
  reverses: string | null;
  sources: DocSourceType[];
  query_by_sources: string[];
  query_by_uid_store: string[];
  query_by_uid_location: string[];
  serialized_details: typeLiteral | null;
  version: number;
  created_by: ActorRefType;
  updated_by: ActorRefType;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}
```

### `MovementAllocationInput`

Zod schema for one requested placement.

```ts
const MovementAllocationInput: z.ZodType<MovementAllocationInputType>;
```

### `MovementAllocationInputType`

One requested placement of `quantity` units. Direction-agnostic on purpose:
{@link MOVEMENT_CONTRACTS} decides whether it lands on `location.from` or
`location.to`, so the client never has to know which way a type moves.

```ts
interface MovementAllocationInputType {
  uid_location: string;
  quantity: number;
}
```

### `MovementContract`

How the three axes may be filled for one movement type.

Fixing this per type is what makes a missing axis a validation error rather
than a silent zero, a stray axis a validation error, and reversal a pure
negate-every-line transform. It is `hasCosts(type)` generalized to all three
axes.

`custody: "with_booking"` — required exactly when `uid_booking` is set. Sales
are the only types that legitimately happen both ways: 247 stored rows are
order-sourced (a booking's units being sold), and the manual transaction form
lets an operator key an off-the-shelf sale with no order at all.

```ts
interface MovementContract {
  custody: "required" | "forbidden" | "with_booking";
  cost: "required" | "forbidden";
  places: typeLiteral | null;
  booking: "required" | "forbidden" | "optional";
}
```

### `MovementCost`

Zod schema for a cost change.

```ts
const MovementCost: z.ZodType<MovementCostType>;
```

### `MovementCostType`

The carrying-value change this event records. `amount_cents` is signed:
negative removes basis, positive adds it. `unit_costs_cents[]` carries the
per-unit basis actually consumed or added, which the weighted-average cost
fold reads.

⚠️ **`unit_cost` sits between two `_cents` fields and is NOT one of them.**
It is a per-unit **rate** at 4dp, and quantizing it to the cent is a measured
regression, not a hypothetical: `@cfs/core@10.0.0-beta.117` emitted it
through `fromCentsBig` and a 100-unit $6.39 purchase reported $0.06/unit — a
6% error that went a week undetected because every movement written in that
window happened to divide evenly at the cent. A mechanical "convert every
money field in this object" pass restores it exactly.

```ts
interface MovementCostType {
  amount_cents: number;
  unit_cost: number;
  unit_costs_cents: number[];
}
```

### `MovementCustody`

Zod schema for a custody transition.

```ts
const MovementCustody: z.ZodType<MovementCustodyType>;
```

### `MovementCustodyType`

The custody transition this event records, as a pair of breakdown keys.

Named `custody` and deliberately NOT `status` or `state`: `Booking` already
has a `status` field (`draft/quoted/reserved/part-prepped/prepped/active/
complete`) that is a different thing from a breakdown key, and the two enums
share several words — `status: {from: "prepped"}` would misread as
`booking.status`.

A side may be `null` for a one-sided transition: an order edit that changes
the booking's own quantity moves units into or out of the breakdown without a
matching opposite key.

```ts
interface MovementCustodyType {
  from: BookingBreakdownKeyType | null;
  to: BookingBreakdownKeyType | null;
}
```

### `MovementLine`

Zod schema for one movement line.

```ts
const MovementLine: z.ZodType<MovementLineType>;
```

### `MovementLineType`

One physical movement of `quantity` units between two places.

A `null` side means "outside CFS ownership". Both sides non-null is a move
that leaves `quantity_held` untouched.

Note `lines[]` is NOT directly queryable — Firestore `array-contains` works on
scalar arrays, not nested object fields. Query paths come from the flat
`query_by_*` denorms.

```ts
interface MovementLineType {
  quantity: number;
  location: typeLiteral;
}
```

### `MovementSchema`

Zod schema for a Movement.

```ts
const MovementSchema: z.ZodType<Movement>;
```

### `MovementTypeEnum`

Zod schema for MovementTypeType.

```ts
const MovementTypeEnum: z.ZodType<MovementTypeType>;
```

### `MovementTypeType`

Union of all movement type string literals.

```ts
type MovementTypeType = indexedAccess;
```

### `NameField`

Zod field for the denormalized `name` on stored documents (Contact, User,
Invite, embedded contact refs in destinations, ActorRef-shaped objects).

The 255 max is the exact upper bound of `deriveName(parts)` given the
existing per-part maxes:
  50 (first) + 1 (sp) + 50 (middle) + 1 (sp) + 50 (last) + 1 (sp)
  + 1 ("(") + 100 (pronunciation) + 1 (")") = 255
If any part's `.max(...)` changes, this ceiling must move with it or
worst-case writes will fail validation.

```ts
const NameField: z.ZodType<string>;
```

### `NameParts`

Split name fields shared across Contact, User, Invite, and any schema
embedding a contact reference. `first_name` is required; the rest are optional.

Stored documents also carry a denormalized `name: string` (use `NameField`
+ `deriveName()` below). Inputs do not — clients send parts; the server
derives `name` at write time. See `deriveName` for the canonical join rule.

```ts
interface NameParts {
  first_name: string;
  middle_name?: string;
  last_name?: string;
  pronunciation?: string;
}
```

### `NamePartsFields`

Fields object — spread into a parent `z.strictObject()` (documents) or
`z.object()` (inputs) to attach the standard split-name fields.

```ts
const NamePartsFields: typeLiteral;
```

### `NamePartsFieldsPartial`

Variant of `NamePartsFields` where every field is optional — use for partial
update input schemas (PUT endpoints) where callers may omit `first_name`.

```ts
const NamePartsFieldsPartial: typeLiteral;
```

### `NewContactInput`

Zod schema for new contact data submitted inline with an organization.

```ts
const NewContactInput: z.ZodType<NewContactInputType>;
```

### `NewContactInputType`

New contact data submitted inline when creating/updating an organization.

```ts
interface NewContactInputType {
  uid: string;
  emails?: string[];
  phones?: string[];
}
```

### `OAuthRefreshLogRecord`

Structured log entry for an OAuth token refresh.

```ts
interface OAuthRefreshLogRecord {
  level: LogLevelType;
  msg: "oauth_refresh";
  ts: string;
  service: string;
  grant_type?: string;
  scope?: string;
  token_type?: string;
  expires_in?: number;
  token_age_hours?: number;
  refreshed_at_debug?: string;
  recovered?: boolean;
  request_id?: string;
  method?: string;
  path?: string;
  route?: string;
  user_id?: string;
  trace_id?: string;
  span_id?: string;
}
```

### `OAuthRefreshLogRecordSchema`

Zod schema for {@link OAuthRefreshLogRecord}.

```ts
const OAuthRefreshLogRecordSchema: z.ZodType<OAuthRefreshLogRecord>;
```

### `OOSBreakdown`

Per-phase quantity breakdown — sum equals top-level `quantity`.

```ts
interface OOSBreakdown {
  draft: number;
  planned: number;
  active: number;
  blocked: number;
  written_off: number;
  returned_to_service: number;
}
```

### `OOSBreakdownSchema`

Zod schema for OOSBreakdown.

```ts
const OOSBreakdownSchema: z.ZodType<OOSBreakdown>;
```

### `OOSDates`

Date object — booking-style start/end with paired Firestore timestamps.

`start` is nullable for `draft` records (operator composing) and `planned`
records (scheduled maintenance with no pinned start instant). Once the
record reaches `active`, `start` should be set (writer enforces).

```ts
interface OOSDates {
  start: string | null;
  start_fs: FirestoreTimestampType | null;
  end: string | null;
  end_fs: FirestoreTimestampType | null;
}
```

### `OOSReasonEnum`

Zod schema for OOSReasonType.

```ts
const OOSReasonEnum: z.ZodType<OOSReasonType>;
```

### `OOSReasonType`

Allowed values for out-of-service reason.

```ts
type OOSReasonType = indexedAccess;
```

### `OOSStatusEnum`

Zod schema for OOSStatusType.

```ts
const OOSStatusEnum: z.ZodType<OOSStatusType>;
```

### `OOSStatusType`

Allowed out-of-service statuses. Server-derived from breakdown + number + canceled_at; only "canceled" is operator-set.

```ts
type OOSStatusType = indexedAccess;
```

### `OOSStore`

A store affected by an out-of-service record.

```ts
interface OOSStore {
  uid_store: string;
  name: string;
  default: boolean;
  quantity: number;
  locations: OOSStoreLocation[];
}
```

### `OOSStoreLocation`

A location within a store affected by an out-of-service record.

```ts
interface OOSStoreLocation {
  uid_location: string;
  name: string;
  quantity: number;
  transactionQuantity: number;
  default: boolean;
  max?: number | null;
}
```

### `OOSTransaction`

A transaction entry within an out-of-service record.

```ts
interface OOSTransaction {
  crms_id?: number | null;
  crms_quarantine_id?: number | null;
  crms_stock_level_id?: number | null;
  crms_stock_level_uid?: string;
  date: string;
  date_fs: FirestoreTimestampType;
  quantity: number;
  source: DocSourceType;
  type: OOSTransactionTypeType;
}
```

### `OOSTransactionTypeEnum`

Zod schema for OOSTransactionTypeType.

```ts
const OOSTransactionTypeEnum: z.ZodType<OOSTransactionTypeType>;
```

### `OOSTransactionTypeType`

Allowed types for an `OOSTransaction`. Terminal types match the breakdown
keys 1:1 — a transaction with `type === "written_off"` and `quantity === N`
corresponds to `breakdown.written_off += N`.

```ts
type OOSTransactionTypeType = indexedAccess;
```

### `ORDER_COMPUTED_STATUSES`

Statuses derived from booking state — set only by the API's booking write
path (reserved → active when a booking moves quantity into out;
active → complete when every quantity has reached a terminal state).

```ts
const ORDER_COMPUTED_STATUSES: "active" | "complete"[];
```

### `ORDER_STATUSES`

```ts
const ORDER_STATUSES: "draft" | "quoted" | "reserved" | "active" | "complete" | "canceled"[];
```

### `ORDER_USER_STATUSES`

Statuses an operator may set directly via UpdateOrderInput.status.
`active` and `complete` are computed by the booking workflow and are
never accepted from a manual write.

```ts
const ORDER_USER_STATUSES: "draft" | "quoted" | "reserved" | "canceled"[];
```

### `Order`

Full order document schema (Firestore document shape).
Used for validation before writing to Firestore.

```ts
interface Order {
  uid: string;
  number: number;
  status: OrderStatusType;
  organization: typeLiteral;
  destinations: DocDestinationType[];
  items: OrderDocItemType[];
  tax_profile: TaxProfileType;
  totals: OrderDocTotalsType;
  invoices: Array<typeLiteral>;
  query_by_invoices: string[];
  query_by_items: string[];
  query_by_contacts: string[];
  query_by_dates: string[];
  bookings_breakdown: typeLiteral;
  crms_id?: number | null;
  crms_status?: string;
  subject?: string;
  reference?: string | null;
  xero_id?: string | null;
  uid_thread?: string;
  version: number;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}
```

### `OrderCanceled`

```ts
type OrderCanceled = EventEnvelope<Order> & typeLiteral;
```

### `OrderComputedStatusType`

```ts
type OrderComputedStatusType = indexedAccess;
```

### `OrderCreated`

```ts
type OrderCreated = EventEnvelope<Order> & typeLiteral;
```

### `OrderDates`

Zod schema for order dates.

```ts
const OrderDates: z.ZodType<OrderDatesType>;
```

### `OrderDatesType`

Order dates — all six date boundaries as ISO datetime strings with offset,
or null when the boundary is unset.

```ts
interface OrderDatesType {
  delivery_start: string | null;
  delivery_end: string | null;
  collection_start: string | null;
  collection_end: string | null;
  charge_start: string | null;
  charge_end: string | null;
}
```

### `OrderDocDates`

Zod schema for order dates with Firestore timestamp companions.

```ts
const OrderDocDates: z.ZodType<OrderDocDatesType>;
```

### `OrderDocDatesType`

Order dates with Firestore timestamp companions — the persisted, per-destination
date set. Each destination on an order/fulfillment/invoice owns one of these;
there is no order-level rollup (derive on demand via deriveOrderDateEnvelope).

```ts
interface OrderDocDatesType {
  delivery_start: string | null;
  delivery_start_fs: FirestoreTimestampType | null;
  delivery_end: string | null;
  delivery_end_fs: FirestoreTimestampType | null;
  collection_start: string | null;
  collection_start_fs: FirestoreTimestampType | null;
  collection_end: string | null;
  collection_end_fs: FirestoreTimestampType | null;
  charge_start: string | null;
  charge_start_fs: FirestoreTimestampType | null;
  charge_end: string | null;
  charge_end_fs: FirestoreTimestampType | null;
  days_active: number | null;
  days_charged: number | null;
}
```

### `OrderDocDestinationItem`

Destination divider in items array.

```ts
const OrderDocDestinationItem: z.ZodType<OrderDocDestinationItemType>;
```

### `OrderDocDestinationItemType`

Destination divider item in the order document items array.

```ts
interface OrderDocDestinationItemType {
  uid: string;
  type: "destination";
  name: string;
  path: string[];
  uid_delivery: string | null;
  uid_collection: string | null;
  description: string;
}
```

### `OrderDocGroupItem`

```ts
const OrderDocGroupItem: z.ZodType<OrderDocGroupItemType>;
```

### `OrderDocGroupItemType`

Group divider in items array.

```ts
interface OrderDocGroupItemType {
  uid: string;
  type: "group";
  name: string;
  path: string[];
  description: string;
}
```

### `OrderDocItem`

Union of all item types in the document — discriminated on `type`.

There is exactly ONE claimant per discriminator value, which is what makes
the discrimination possible at all. `transaction_fee` used to be claimed
twice — once by `DOC_LINE_ITEM_TYPES` here and once by a separate
`OrderDocTransactionFeeItem` arm carrying a `PriceModifier` instead of an
`OrderDocItemPrice` — and Zod answers a duplicate discriminator with a bare
`Error`, not a `ZodError`, so `safeParse` could not trap it. A fee is now an
ordinary line item whose `price.formula` says `percent_of_total`; the
per-document rollup (`totals.transaction_fees`) keeps the `PriceModifier`
shape, because that IS a rate-and-amount summary rather than a line.

```ts
const OrderDocItem: z.ZodType<OrderDocItemType>;
```

### `OrderDocItemPrice`

```ts
const OrderDocItemPrice: z.ZodType<OrderDocItemPriceType>;
```

### `OrderDocItemPriceType`

Line item price in the full order document (all fields required after server compute).
subtotal = pre-discount (base × qty × days_factor).
subtotal_discounted = post-discount.
total = subtotal_discounted + sum(taxes[].amount).

```ts
interface OrderDocItemPriceType {
  base_cents: number;
  base_percent?: number | null;
  replacement_cents?: number | null;
  chargeable_days: number | null;
  formula: PriceFormulaType;
  subtotal_cents: number;
  subtotal_discounted_cents: number;
  discount: DiscountType | null;
  taxes: PriceModifierType[];
  taxes_base?: TaxRefType[];
  total_cents: number;
}
```

### `OrderDocItemType`

Union of all item types stored in the order document.

```ts
type OrderDocItemType = OrderDocLineItemType | OrderDocDestinationItemType | OrderDocGroupItemType;
```

### `OrderDocLineItem`

```ts
const OrderDocLineItem: z.ZodType<OrderDocLineItemType>;
```

### `OrderDocLineItemType`

Line item in the full order document.

`price` and `stock_method` are REQUIRED, and that is a statement about the
writers rather than a convenience: every one of the 9,303 line items in prod
(and in dev) carries both, because `buildOrderLineItem` resolves them off the
backing product doc — or off the `custom-` line's own payload — before it can
build anything at all. While they were optional, three call sites downstream
had to compensate for a shape no writer has ever produced: two `item.price!`
assertions, and a `"stock_method" in item` duck-type that answered "not a line
item" for a line item that merely omitted the field.

`uid_delivery` / `uid_collection` are absent, matching the input arm. They
belong to the destination divider — 0 of 9,303 stored lines carry either key,
no writer has ever set one on a line, and both readers in
`@cfs/core/utils/orders` gate on `type === "destination"` before looking. The
FULFILLMENT line arm keeps its own pair: 9,304 prod rows carry an explicit
`null` there, so removing it would be a backfill, not a tightening.

```ts
interface OrderDocLineItemType {
  uid: string;
  type: DocLineItemTypeType;
  name: string;
  description: string;
  quantity: number;
  price: OrderDocItemPriceType;
  stock_method: StockMethodType;
  order_number?: number;
  uid_order?: string;
  path: string[];
  inclusion_type?: "default" | "mandatory" | "optional" | null;
  zero_priced?: boolean | null;
  crms_id?: number | null;
  coa_revenue?: COARevenueType | null;
}
```

### `OrderDocTotalsType`

Order totals.

```ts
interface OrderDocTotalsType {
  discount_amount_cents: number;
  subtotal_cents: number;
  subtotal_discounted_cents: number;
  taxes: PriceModifierType[];
  transaction_fees: PriceModifierType[];
  total_cents: number;
  replacement_total_cents: number;
}
```

### `OrderDocument`

Metadata for a single generated order document (quote / packing list PDF).

```ts
interface OrderDocument {
  uuid: string;
  mime: string;
  name: string;
  orderUpdatedAt: FirestoreTimestampType;
}
```

### `OrderDocumentSchema`

Zod schema for OrderDocument.

```ts
const OrderDocumentSchema: z.ZodType<OrderDocument>;
```

### `OrderItem`

Zod schema for an individual order item (input) — discriminated on `type`,
mirroring the stored {@link OrderDocItem} union.

This was one flat `z.object` where every field but `uid`/`type`/`path` was
optional, so `PUT /orders` accepted a `destination` divider carrying a
`quantity` and a `price`. Nothing stripped them: `buildOrderLineItem` passes a
divider through verbatim, so the payload reached `validateBeforeWrite` and
failed there as `unrecognized_keys` against the stored strict arm — a layer
too late, and phrased as a storage complaint rather than "a divider has no
price". Now it is unwritable at the boundary. Prod says nothing relied on it:
0 of 3,635 order dividers carry any line-only key.

**The line arm comes first, and the order is load-bearing.**
`getInitialValues` resolves a union by taking its first arm, and the manager
seeds a new order line with `getInitialValues(OrderItem)`. Putting a divider
first would silently reshape every staged line.

Only `checkItemPriceFormula` is attached, not the full `checkItemContract`.
The `replacement` axis keys on `stock_method`, which an order INPUT does not
own — the product does, and the server reads it there — so enforcing it here
would reject a legal payload for an unstocked product. Storage already
enforces it against the resolved `stock_method`. Tighten storage, not the
input.

```ts
const OrderItem: z.ZodType<OrderItemType>;
```

### `OrderItemDestination`

Zod schema for a destination divider (input).

```ts
const OrderItemDestination: z.ZodType<OrderItemDestinationType>;
```

### `OrderItemDestinationType`

A destination divider as a client sends it.

```ts
interface OrderItemDestinationType {
  uid: string;
  type: "destination";
  name?: string;
  description?: string;
  path: string[];
  uid_delivery?: string;
  uid_collection?: string;
}
```

### `OrderItemGroup`

Zod schema for a group divider (input).

```ts
const OrderItemGroup: z.ZodType<OrderItemGroupType>;
```

### `OrderItemGroupType`

A group divider as a client sends it.

```ts
interface OrderItemGroupType {
  uid: string;
  type: "group";
  name?: string;
  description?: string;
  path: string[];
}
```

### `OrderItemLine`

Zod schema for a billable order line (input).

```ts
const OrderItemLine: z.ZodType<OrderItemLineType>;
```

### `OrderItemLineType`

A billable order line as a client sends it — the input mirror of
`OrderDocLineItem`.

Deliberately permissive about what may be OMITTED: the server fills `name`,
`stock_method` and the whole price from the backing product doc, and a custom
line supplies them itself. What it is no longer permissive about is what a
line may CLAIM — see {@link OrderItem} for why the arms exist.

`uid_delivery` / `uid_collection` are absent here on purpose. The flat schema
this replaces accepted both on any item, and `buildOrderLineItem` has never
propagated them to a line — prod agrees: 0 of 9,303 order line items carry
either key. They belong to the destination divider, which is where they now
live exclusively.

```ts
interface OrderItemLineType {
  uid: string;
  type: DocLineItemTypeType;
  name?: string;
  description?: string;
  quantity?: number;
  price?: ItemPriceType;
  stock_method?: StockMethodType;
  path: string[];
  inclusion_type?: InclusionTypeType | null;
  zero_priced?: boolean | null;
  order_number?: number;
  uid_order?: string;
}
```

### `OrderItemType`

An individual order item (input) — a line, or one of the two dividers.

```ts
type OrderItemType = OrderItemLineType | OrderItemDestinationType | OrderItemGroupType;
```

### `OrderSchema`

Zod schema for the full order Firestore document.

```ts
const OrderSchema: z.ZodType<Order>;
```

### `OrderStatusChanged`

```ts
type OrderStatusChanged = EventEnvelope<Order> & typeLiteral;
```

### `OrderStatusType`

```ts
type OrderStatusType = indexedAccess;
```

### `OrderUpdated`

```ts
type OrderUpdated = EventEnvelope<Order> & typeLiteral;
```

### `OrderUserStatusType`

```ts
type OrderUserStatusType = indexedAccess;
```

### `Organization`

Full organization document schema (Firestore document shape).

```ts
interface Organization {
  uid: string;
  name: string;
  crms_id: number;
  xero_id: string | null;
  tax_profile: TaxProfileType;
  description?: string;
  emails: string[];
  phones: string[];
  billing_address: AddressType | null;
  contacts: OrganizationContactType[];
  query_by_contacts: string[];
  last_order?: FirestoreTimestampType | null;
  uid_thread?: string;
  version: number;
  created_by: ActorRefType;
  updated_by: ActorRefType;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}
```

### `OrganizationContact`

Zod schema for a contact reference embedded in an organization.

```ts
const OrganizationContact: z.ZodType<OrganizationContactType>;
```

### `OrganizationContactType`

Contact reference embedded in an organization document.
`name` is the server-derived display string (see `deriveName` in common.ts).

```ts
interface OrganizationContactType {
  uid: string;
  name: string;
  roles: string[];
}
```

### `OrganizationCreated`

```ts
type OrganizationCreated = EventEnvelope<Organization> & typeLiteral;
```

### `OrganizationSchema`

Zod schema for a full organization Firestore document.

```ts
const OrganizationSchema: z.ZodType<Organization>;
```

### `OrganizationUpdated`

```ts
type OrganizationUpdated = EventEnvelope<Organization> & typeLiteral;
```

### `OutOfService`

An out-of-service record tracking inventory removed from active service.

```ts
interface OutOfService {
  uid: string;
  uid_product: string;
  number: number;
  reason: OOSReasonType;
  status: OOSStatusType;
  quantity: number;
  breakdown: OOSBreakdown;
  canceled_at: FirestoreTimestampType | null;
  organization: typeLiteral | null;
  dates: OOSDates;
  sources: DocSourceType[];
  query_by_sources: string[];
  crms_id?: number | null;
  crms_stock_level_id?: number | null;
  stores: OOSStore[];
  query_by_uid_store: string[];
  query_by_uid_location: string[];
  transactions?: OOSTransaction[];
  uid_thread?: string;
  version: number;
  created_by: ActorRefType;
  updated_by: ActorRefType;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}
```

### `OutOfServiceCreated`

```ts
type OutOfServiceCreated = EventEnvelope<OutOfService> & typeLiteral;
```

### `OutOfServiceSchema`

Zod schema for OutOfService.

```ts
const OutOfServiceSchema: z.ZodType<OutOfService>;
```

### `OutOfServiceUpdated`

```ts
type OutOfServiceUpdated = EventEnvelope<OutOfService> & typeLiteral;
```

### `PERMISSIONS`

The full catalog of permissions. Adding a new route? Add its permission here first.

```ts
const PERMISSIONS: "orders.create" | "orders.read" | "orders.update" | "orders.delete" | "orders.search" | "orders.checkout" | "orders.return" | "products.create" | "products.read" | "products.update" | "products.delete" | "products.search" | "webshopProducts.read" | "webshopProducts.search" | "contacts.create" | "contacts.read" | "contacts.update" | "contacts.delete" | "contacts.search" | "organizations.create" | "organizations.read" | "organizations.update" | "organizations.delete" | "organizations.search" | "transactions.create" | "transactions.read" | "transactions.update" | "transactions.delete" | "invoices.create" | "invoices.read" | "invoices.update" | "invoices.delete" | "invoices.search" | "settlements.create" | "settlements.read" | "settlements.reverse" | "creditNotes.create" | "creditNotes.read" | "creditNotes.update" | "creditNotes.void" | "creditNotes.search" | "quotes.create" | "quotes.read" | "quotes.update" | "quotes.delete" | "locations.create" | "locations.read" | "locations.update" | "locations.delete" | "locations.search" | "locationTypes.create" | "locationTypes.read" | "locationTypes.update" | "locationTypes.delete" | "stores.create" | "stores.read" | "stores.update" | "stores.delete" | "stores.search" | "taxes.create" | "taxes.read" | "taxes.update" | "taxes.delete" | "tags.create" | "tags.read" | "tags.update" | "tags.delete" | "tags.search" | "trackingCategories.create" | "trackingCategories.read" | "trackingCategories.update" | "trackingCategories.delete" | "trackingCategories.search" | "holidays.create" | "holidays.read" | "holidays.update" | "holidays.delete" | "templates.create" | "templates.read" | "templates.search" | "templates.propose" | "templates.release" | "templates.merge" | "templates.rollback" | "templates.blessGolden" | "templates.archive" | "lists.create" | "lists.read" | "lists.update" | "lists.delete" | "cards.create" | "cards.read" | "cards.update" | "cards.delete" | "cards.search" | "recurrences.create" | "recurrences.read" | "recurrences.update" | "recurrences.delete" | "bookings.read" | "bookings.update" | "chartOfAccounts.read" | "chartOfAccounts.search" | "dateHelpers.read" | "destinations.read" | "destinations.search" | "ledgers.read" | "fulfillment.read" | "fulfillment.search" | "fulfillment.update" | "fulfillment.reset" | "outOfService.create" | "outOfService.read" | "outOfService.update" | "outOfService.delete" | "outOfService.search" | "stockSummaries.read" | "typesenseSync.read" | "users.read" | "users.update" | "users.delete" | "users.invite" | "users.search" | "users.assignRoles" | "roles.read" | "roles.edit" | "threads.create" | "threads.read" | "threads.update" | "threads.search" | "comments.create" | "comments.read" | "comments.update" | "comments.delete" | "comments.moderate" | "comments.search" | "comments.react" | "uploads.sign" | "admin.reindex" | "admin.validate" | "admin.sync" | "admin.previewRole"[];
```

### `PLACE_KINDS`

The kinds of place a unit can be in. `"outside"` is the absence of a place —
a `null` side of `location`, meaning outside CFS ownership entirely.

```ts
const PLACE_KINDS: "locations" | "bookings" | "out-of-service" | "outside"[];
```

### `PartialNameParts`

All-optional variant of `NameParts` — use for partial update input types
(PUT endpoints) where callers may omit `first_name`.

```ts
interface PartialNameParts {
  first_name?: string;
  middle_name?: string;
  last_name?: string;
  pronunciation?: string;
}
```

### `PasswordReset`

Full Firestore document for a single-use password reset token.

```ts
interface PasswordReset {
  user_id: string;
  email: string;
  expiresAt: FirestoreTimestampType;
  created_at: number;
}
```

### `PasswordResetSchema`

Zod schema for PasswordReset.

```ts
const PasswordResetSchema: z.ZodType<PasswordReset>;
```

### `Permission`

Union type of every permission string in the catalog.

```ts
type Permission = indexedAccess;
```

### `Phone`

Phone string with length constraints.

Carries `cell: "phone"` because a phone number is the one display type Zod
cannot discriminate — it is a `z.string()` with a regex, structurally
identical to a subject line. Declared once, here, rather than recovered per
column by testing whether the path `includes("phone")`. (An email needs no
such marker: `z.email()` has its own `format`.)

```ts
const Phone: z.ZodType<string>;
```

### `PiiClassification`

PII classification vocabulary.

Applied via `.meta({ pii: "..." })` on any Zod field; the schema-driven
walker in `./walker.ts` reads these tags and dispatches to the matching
leaf transform.

- `"none"`   — safe field, no processing
- `"mask"`   — partial reveal (`alice@x.com` → `a****@x.com`, last-4 for opaque strings)
- `"hash"`   — deterministic HMAC-SHA256 prefix (server-side only; needs a key)
- `"redact"` — full removal → `"[REDACTED]"`

```ts
type PiiClassification = "none" | "mask" | "hash" | "redact";
```

### `PlaceKindType`

One kind of place a unit can occupy.

```ts
type PlaceKindType = indexedAccess;
```

### `PreTaxItemType`

The `pricing: "pre_tax"` members — every type that counts INTO the document
subtotal.

Derived from {@link ITEM_CONTRACTS} rather than listed. A hand-written copy of
this union is exactly the drift the parity assertions above exist to prevent,
and `@cfs/core/utils/orders` carried one — `PreTaxLineItem["type"]` was the
literal list `"rental" | "sale" | "service" | "surcharge" | "replacement"`,
a sixth place to remember when a type is added.

```ts
type PreTaxItemType = indexedAccess;
```

### `PreviewRecord`

A cached rendered-PDF preview document.

```ts
interface PreviewRecord {
  uid: string;
  user_id: string;
  pdf_base64: string;
  filename: string;
  created_at: FirestoreTimestampType;
  expires_at: FirestoreTimestampType;
}
```

### `PreviewRecordSchema`

Zod schema for PreviewRecord.

```ts
const PreviewRecordSchema: z.ZodType<PreviewRecord>;
```

### `PriceFormulaEnum`

Zod schema for PriceFormulaType.

```ts
const PriceFormulaEnum: z.ZodType<PriceFormulaType>;
```

### `PriceFormulaType`

Allowed values for pricing formula.

```ts
type PriceFormulaType = indexedAccess;
```

### `PriceModifier`

Zod schema for a rate-based price modifier (tax or transaction fee).

`rate` and `amount_cents` are deliberately DIFFERENT units and the names say
so: `rate` stays a 4dp dollars-or-percent rate discriminated on `type` (see
{@link DiscountType}), while `amount_cents` is the computed money in integer
cents. A sweep that "converts every number in this object" restores exactly
the rate/amount confusion the suffix exists to prevent.

```ts
const PriceModifier: z.ZodType<PriceModifierType>;
```

### `PriceModifierType`

A rate-based charge applied to an item or order (tax or transaction fee).
uid references a tax doc (for taxes) or a product doc (for transaction fees).

```ts
interface PriceModifierType {
  uid: string;
  name: string;
  rate: number;
  type: RateType;
  amount_cents: number;
}
```

### `Product`

A product document in the products Firestore collection.

```ts
interface Product {
  uid: string;
  name: string;
  active: boolean;
  type: ProductTypeType;
  stock_method: StockMethodType;
  component_only: boolean;
  crms_id: number | null;
  crms_rate_id?: number | null;
  crms_stock_level_ids?: Record<string, number>;
  crms_linked_rental_id?: number | null;
  crms_linked_replacement_id?: number | null;
  crms_linked_replacement_rate_id?: number | null;
  description?: string;
  eligible_delivery: boolean;
  eligible_in_store_pickup: boolean;
  eligible_shipping_ground: boolean;
  eligible_shipping_air: boolean;
  price: ProductPrice;
  shipping?: ProductShipping;
  alternates: ProductAlternate[];
  components: AuthoredProductComponent[];
  component_of: ProductComponent[];
  tags: UidNameRefType[];
  query_by_tags?: string[];
  query_by_components?: string[];
  query_by_component_of?: string[];
  query_by_alternates?: string[];
  tracking_category_name?: string;
  uid_linked_rental?: string | null;
  uid_linked_replacement?: string | null;
  uid_tracking_category?: string | null;
  webshop: ProductWebshop;
  images?: ProductImage[];
  query_by_images?: string[];
  xero_id: string | null;
  xero_code?: string | null;
  xero_tracking_option_id: string | null;
  uid_thread?: string;
  version: number;
  created_by: ActorRefType;
  updated_by: ActorRefType;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}
```

### `ProductAlternate`

An alternate product reference.

```ts
interface ProductAlternate {
  uid: string;
  name: string;
}
```

### `ProductComponent`

A product reference in `component_of` — the RECIPROCAL back-reference naming a
parent this product is a component of.

Deliberately the reduced shape: the relationship attributes
(`inclusion_type`, `zero_priced`, `active`, `description`) describe how the
PARENT includes this product and are authored on the parent's own
`components` entry, which is the authoritative side. Prod agrees — across 141
`component_of` rows on 91 products, exactly one carries any of them
(measured 2026-07-29), against 165/165 on `components`.

```ts
interface ProductComponent {
  uid: string;
  path: string[];
  name: string;
  active?: boolean;
  type: ComponentTypeType;
  stock_method: StockMethodType;
  crms_id: number | null;
  crms_accessory_id?: number | null;
  description?: string;
  inclusion_type?: InclusionTypeType;
  quantity: number;
  zero_priced?: boolean;
  price: typeLiteral;
}
```

### `ProductCreated`

```ts
type ProductCreated = EventEnvelope<Product> & typeLiteral;
```

### `ProductImage`

One product photo. Array order is display order and `images[0]` is the
primary image — there is deliberately no `sort` or `is_primary` field, so
there is only one thing to disagree with.

Row identity is `uuid`, the original upload. It never changes (background
removal is additive: it fills `uuid_cutout` and leaves the original intact),
so it is the value `DELETE|PATCH /products/{uid}/images/{image_id}` carries.
That is why this array member has no `crypto.randomUUID()` `uid` — the
convention exists for members with no natural key, and this one has one.

Display rule everywhere: `img.uuid_cutout ?? img.uuid`.

```ts
interface ProductImage {
  uuid: string;
  uuid_cutout: string | null;
  alt: string | null;
  width: number | null;
  height: number | null;
}
```

### `ProductPrice`

Pricing details for a product.

```ts
interface ProductPrice {
  base_cents: number;
  replacement_cents?: number | null;
  coa_revenue?: COARevenueType;
  taxes: TaxRefType[];
  formula: PriceFormulaType;
  discountable: boolean;
}
```

### `ProductSchema`

Zod schema for a Product document.

```ts
const ProductSchema: z.ZodType<Product>;
```

### `ProductShipping`

Shipping dimensions and hazard classification for a product.

The four dimensions are nullable: `null` is "not measured yet", which `0`
could not express. See the storage schema for why the distinction is
load-bearing (core#51).

```ts
interface ProductShipping {
  weight: number | null;
  height: number | null;
  width: number | null;
  length: number | null;
  air_hazardous: boolean;
  air_un: number | null;
}
```

### `ProductTypeEnum`

Zod schema for ProductTypeType.

```ts
const ProductTypeEnum: z.ZodType<ProductTypeType>;
```

### `ProductTypeType`

Allowed values for product type.

```ts
type ProductTypeType = indexedAccess;
```

### `ProductUpdated`

```ts
type ProductUpdated = EventEnvelope<Product> & typeLiteral;
```

### `ProductWebshop`

Webshop availability and description for a product.

```ts
interface ProductWebshop {
  available: boolean;
  description?: string | null;
}
```

### `PropagationLogRecord`

Structured log entry for a single propagation rule execution.

```ts
interface PropagationLogRecord {
  level: LogLevelType;
  msg: "propagation";
  ts: string;
  rule_id: string;
  source: string;
  target: string;
  mode: PropagationModeType;
  transaction?: string;
  fields_mapped: number;
  source_doc_id?: string;
  target_doc_id?: string;
  status: PropagationStatusType;
  duration_ms?: number;
  error?: string;
  rules_fired?: string[];
  rules_fired_count?: number;
  rules_expected?: number;
  target_counts?: Record<string, number>;
  target_count?: number;
  request_id?: string;
  method?: string;
  path?: string;
  route?: string;
  user_id?: string;
  trace_id?: string;
  span_id?: string;
}
```

### `PropagationLogRecordSchema`

Zod schema for {@link PropagationLogRecord}.

```ts
const PropagationLogRecordSchema: z.ZodType<PropagationLogRecord>;
```

### `PropagationMode`

How a field value moves from one document to another.

```ts
type PropagationMode = "embed" | "fan-out" | "co-write" | "derive" | "reference";
```

### `PropagationModeType`

Propagation strategy used by a rule.

```ts
type PropagationModeType = indexedAccess;
```

### `PropagationStatusType`

Status outcome of a propagation rule execution.

```ts
type PropagationStatusType = indexedAccess;
```

### `PublicStockSummary`

Window-independent, public-safe availability inputs for one product.

```ts
interface PublicStockSummary {
  uid: string;
  uid_product: string;
  type: ProductTypeType;
  quantity_held: number;
  unavailable: PublicUnavailableEntry[];
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}
```

### `PublicStockSummaryRecalculated`

```ts
type PublicStockSummaryRecalculated = EventEnvelope<PublicStockSummary> & typeLiteral;
```

### `PublicStockSummarySchema`

Zod schema for PublicStockSummary.

```ts
const PublicStockSummarySchema: z.ZodType<PublicStockSummary>;
```

### `PublicUnavailableEntry`

One anonymous unavailable interval — a booking or an OOS record, indistinguishable.

```ts
interface PublicUnavailableEntry {
  start: string | null;
  start_fs: FirestoreTimestampType | null;
  end: string | null;
  end_fs: FirestoreTimestampType | null;
  quantity: number;
}
```

### `Quote`

A PDF quote document associated with an order.

```ts
interface Quote {
  uid: string;
  uid_order: string;
  order_number: number;
  version: number | null;
  is_draft: boolean;
  uploadcare_uuid: string | null;
  uploadcare_files?: Array<typeLiteral>;
  deleted_at: FirestoreTimestampType | null;
  expires_at: FirestoreTimestampType | null;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}
```

### `QuoteCreated`

```ts
type QuoteCreated = EventEnvelope<Quote> & typeLiteral;
```

### `QuoteDeleted`

```ts
type QuoteDeleted = EventEnvelope<Quote> & typeLiteral;
```

### `QuoteId`

`quotes.uid` — deterministic composite `{uid_order}:v{N}` (saved versions) or
`{uid_order}:draft` (the working draft). Built in api-cloudrun
`src/services/quotes.ts` (`${uidOrder}:v${version}` / `${uidOrder}:draft`).

```ts
const QuoteId: z.ZodType<string>;
```

### `QuoteRestored`

```ts
type QuoteRestored = EventEnvelope<Quote> & typeLiteral;
```

### `QuoteSchema`

Zod schema for Quote.

```ts
const QuoteSchema: z.ZodType<Quote>;
```

### `RATE_UNIT_META`

The display annotation a **discriminated** rate column carries.

A rate normally names its unit outright — `unit: "usd"` on
`transactions:cost.unit_cost` says "4dp dollars" and the cell formats it. A
`rate` beside a {@link RateTypeEnum} cannot: `10.25` is `10.25%` when the
row's own `type` says `percent` and `$10.25` per unit when it says `flat`. The
unit is a property of the ROW, not of the field, so no static per-field value
can express it — one would render the other arm wrongly.

So the annotation names *where to look* (`unitVia`, a sibling key resolved
against the leaf's own parent object) and *what each value means* (`unitMap`).
The map is the load-bearing half: a bare `rate: true` would repeat exactly
what `TypesenseField.money` did — carry a definition with no unit, which
rendered every money mirror 100× on 2026-08-08.

One constant rather than four copies, so a new `RateType` member is one edit;
`tests/display-columns.test.ts` T14 fails if the map stops covering the enum.

```ts
const RATE_UNIT_META: typeLiteral;
```

### `REACHED_XERO_STATUSES`

Statuses that have **ever** reached Xero. Includes `void` — see
{@link InvoiceStatusContract.reached_xero}. NOT interchangeable with
{@link LIVE_IN_XERO_STATUSES}, which is exactly the mistake this pair exists
to prevent.

```ts
const REACHED_XERO_STATUSES: readonly InvoiceStatusType[];
```

### `RateLimit`

```ts
interface RateLimit {
  attempt_count: number;
  first_attempt_at: number;
  expiresAt: FirestoreTimestampType;
}
```

### `RateLimitSchema`

```ts
const RateLimitSchema: z.ZodType<RateLimit>;
```

### `RateType`

Allowed values for rate type: percent or flat.

```ts
type RateType = indexedAccess;
```

### `RateTypeEnum`

Zod schema for RateType.

```ts
const RateTypeEnum: z.ZodType<RateType>;
```

### `ReactionActionType`

Allowed reaction actions.

```ts
type ReactionActionType = indexedAccess;
```

### `Recurrence`

Recurrence Firestore document shape.

```ts
interface Recurrence {
  uid: string;
  uid_list: string;
  status: RecurrenceStatus;
  rule: RecurrenceRuleType;
  active_from: string;
  active_until: string | null;
  horizon_through: string | null;
  horizon_days: number | null;
  exception_dates: string[];
  prototype: RecurrencePrototypeType;
  version: number;
  created_by: ActorRefType;
  updated_by: ActorRefType;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}
```

### `RecurrenceCreated`

```ts
type RecurrenceCreated = EventEnvelope<Recurrence> & typeLiteral;
```

### `RecurrenceDeleted`

```ts
type RecurrenceDeleted = EventEnvelope<Recurrence> & typeLiteral;
```

### `RecurrenceFreq`

RFC 5545 FREQ value.

```ts
type RecurrenceFreq = indexedAccess;
```

### `RecurrenceFreqEnum`

Zod schema for RecurrenceFreq.

```ts
const RecurrenceFreqEnum: z.ZodType<RecurrenceFreq>;
```

### `RecurrencePrototype`

Zod schema for the recurrence prototype.

```ts
const RecurrencePrototype: z.ZodType<RecurrencePrototypeType>;
```

### `RecurrencePrototypeType`

The card prototype — fields that materialize verbatim into each instance
card unless per-instance `recurrence_overrides` pin them. Mirrors
`CreateCardInputType` minus `uid_list`, `position`, and `date`
(those live on the Recurrence root since they're series-level concerns).

```ts
interface RecurrencePrototypeType {
  subject: string;
  body: CommentBodyJson | null;
  body_text: string;
  status: CardStatus;
  destination: DocDestinationEndpointType | null;
  sources: DocSourceType[];
  attachments: CardAttachmentType[];
  uid_assignees: string[];
  locked: CardLockKey[];
}
```

### `RecurrenceRule`

Zod schema for a recurrence rule.

```ts
const RecurrenceRule: z.ZodType<RecurrenceRuleType>;
```

### `RecurrenceRuleType`

RFC 5545 / rrule-temporal-aligned recurrence rule. Each field maps
directly to a rrule-temporal constructor option — see
https://jsr.io/@gsphw/rrule-temporal.

```ts
interface RecurrenceRuleType {
  freq: RecurrenceFreq;
  interval: number;
  byweekday: RecurrenceWeekday[] | null;
  bymonthday: number[] | null;
  bymonth: number[] | null;
  bysetpos: number[] | null;
  count: number | null;
  until: string | null;
}
```

### `RecurrenceSchema`

Zod schema for a Recurrence Firestore document.

```ts
const RecurrenceSchema: z.ZodType<Recurrence>;
```

### `RecurrenceStatus`

Recurrence lifecycle.
- `active` — nightly materializer rolls the horizon forward; prototype
  edits fan out to existing instances (respecting per-card overrides).
- `paused` — materializer skips; existing instances remain untouched.
  Use for temporary holds ("no deliveries this month").
- `archived` — materializer skips; instances remain but the recurrence
  is hidden from the settings UI.

```ts
type RecurrenceStatus = indexedAccess;
```

### `RecurrenceStatusEnum`

Zod schema for RecurrenceStatus.

```ts
const RecurrenceStatusEnum: z.ZodType<RecurrenceStatus>;
```

### `RecurrenceUpdated`

```ts
type RecurrenceUpdated = EventEnvelope<Recurrence> & typeLiteral;
```

### `RecurrenceWeekday`

RFC 5545 BYDAY value (two-letter weekday code).

```ts
type RecurrenceWeekday = indexedAccess;
```

### `RecurrenceWeekdayEnum`

Zod schema for RecurrenceWeekday.

```ts
const RecurrenceWeekdayEnum: z.ZodType<RecurrenceWeekday>;
```

### `RegisterInput`

```ts
const RegisterInput: z.ZodType<RegisterInputType>;
```

### `RegisterInputType`

Input schema for POST /auth/register.

Carries the split-name parts (`first_name` required, the rest optional) the
register route derives the denormalized `name` from via `deriveName()`. No
`name` field — inputs send parts; the server derives `name` at write time.

```ts
interface RegisterInputType {
  email: string;
  password: string;
}
```

### `RequestLogRecord`

Structured log entry for a completed HTTP request.

```ts
interface RequestLogRecord {
  level: LogLevelType;
  msg: "request";
  ts: string;
  route: string;
  status: number;
  duration_ms: number;
  request_id?: string;
  method?: string;
  path?: string;
  user_id?: string;
  trace_id?: string;
  span_id?: string;
  dry_run?: boolean;
}
```

### `RequestLogRecordSchema`

Zod schema for {@link RequestLogRecord}.

```ts
const RequestLogRecordSchema: z.ZodType<RequestLogRecord>;
```

### `ResetPasswordInput`

```ts
const ResetPasswordInput: z.ZodType<ResetPasswordInputType>;
```

### `ResetPasswordInputType`

Input schema for POST /auth/reset-password.

```ts
interface ResetPasswordInputType {
  token: string;
  password: string;
}
```

### `RestoreQuoteInput`

Zod schema for RestoreQuoteInput.

```ts
const RestoreQuoteInput: z.ZodType<RestoreQuoteInputType>;
```

### `RestoreQuoteInputType`

Input for restoring a soft-deleted quote.

```ts
interface RestoreQuoteInputType {
  uid: string;
}
```

### `ReverseTransactionInput`

Input schema for reversing a movement. The reversal negates every line of the
event it names; nothing else is client-supplied, so a reversal cannot silently
disagree with what it reverses.

```ts
const ReverseTransactionInput: z.ZodType<ReverseTransactionInputType>;
```

### `ReverseTransactionInputType`

Input for reversing a movement.

```ts
interface ReverseTransactionInputType {
  uid_session: string;
  reference: string;
  date?: string;
}
```

### `Role`

A role document in Firestore.

```ts
interface Role {
  name: string;
  label: string;
  permissions: string[];
  description?: string;
  uid_thread?: string;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}
```

### `RoleSchema`

Zod schema for Role.

```ts
const RoleSchema: z.ZodType<Role>;
```

### `RouteManifest`

Runtime route manifest — emitted by api-cloudrun at GET /permissions/manifest.

```ts
interface RouteManifest {
  version: string;
  permissions: readonly Permission[];
  routes: RouteManifestEntry[];
}
```

### `RouteManifestEntry`

A single entry in the runtime route manifest — one per protected route.

```ts
interface RouteManifestEntry {
  method: RouteMethod;
  path: string;
  permission: Permission;
  operationId?: string;
}
```

### `RouteMethod`

HTTP methods accepted by the runtime route manifest.

```ts
type RouteMethod = "get" | "post" | "put" | "delete" | "patch";
```

### `SETTLED_STATUSES`

Statuses whose embedded snapshot is frozen against org-cascade rewrites.

```ts
const SETTLED_STATUSES: readonly InvoiceStatusType[];
```

### `SETTLEMENT_CONTRACTS`

The per-type settlement contract, one entry per {@link SETTLEMENT_TYPES}
member — a table the schema reads, so a contradiction is reported by the
schema instead of restated in every consumer.

`sums_into` is load-bearing rather than documentation: `calculateInvoiceTotals`
takes its settlement argument structurally, so without a declared target a
credit row would be silently summed into `amount_paid`. Reading the target
from the table removes that class entirely.

A reversal carries **no** external id. The reap appends a reverser because
Xero stopped reporting a payment — the reverser is a CFS event with no Xero
counterpart, and the id it retracts is still on the row `reverses` names.

```ts
const SETTLEMENT_CONTRACTS: Readonly<Record<SettlementTypeType, SettlementContract>>;
```

### `SaveQuoteVersionInput`

Zod schema for SaveQuoteVersionInput.

```ts
const SaveQuoteVersionInput: z.ZodType<SaveQuoteVersionInputType>;
```

### `SaveQuoteVersionInputType`

Input for saving a new quote version.

```ts
interface SaveQuoteVersionInputType {
  uid_order: string;
}
```

### `SchemaDocType`

Union of all Firestore document types. Use with validateBeforeWrite.

**`TemplateVersion` and `TemplateComponent` were the only two schema-backed
document types missing from this union**, and their absence was the whole
reason for 43 `as unknown as SchemaDocType` casts in `api-cloudrun`. The
proof it was the union and not the pattern: `Template` IS a member and writes
uncast, while its sibling `TemplateComponent` was not and writes cast — same
three-collection family, different treatment, no stated reason.

Widening is safe by construction rather than by review: there is no
discriminant to switch on (these types share no common `type` tag, so a
discriminated union over `SchemaDocType` is not expressible), and a
workspace-wide grep finds no `Extract<SchemaDocType…>`, no
`keyof SchemaDocType` and no exhaustive switch. Every one of the 126
references lives in `api-cloudrun`; `manager` and `templates` have none.

The one thing it gives up is real and was never a guarantee: `tx.set(ref,
templateVersionDoc)` used to be a compile error absent a cast. That caught
nothing 51 of 53 doc types were not already free to do, and the runtime guard
in `validateBeforeWrite` still rejects every doc/collection mismatch with a
`collection/id` label.

```ts
type SchemaDocType = Booking | CacheGeocodes | Card | ChartOfAccounts | Comment | Contact | Counter | DestinationDocType | EmailVerification | HolidayDates | HolidayDefinition | HolidaySnapshot | InventoryLedger | Invite | Invoice | List | Location | LocationType | Order | OrderDocument | Organization | OutOfService | PasswordReset | Fulfillment | Product | PreviewRecord | PublicStockSummary | Quote | RateLimit | Recurrence | Role | Session | StockSummary | Tax | Template | TemplateComponent | TemplateVersion | CreditNote | Settlement | Store | Tag | Thread | TrackingCategory | Movement | TypesenseConfig | UploadcareSweepRun | User | WebhookEvent | WebshopProduct | XeroBudget | XeroSyncState | McpOAuthClient | McpOAuthAuthorizeRequest | McpOAuthCode | McpOAuthToken;
```

### `SchemaField`

A single field entry in the schema reference.

```ts
interface SchemaField {
  path: string;
  type: string;
}
```

### `Session`

Full session document schema (Firestore document shape).
Note: expiresAt kept in camelCase for Firestore TTL policy.

```ts
interface Session {
  id: string;
  user_id: string;
  anonymous: boolean;
  expiresAt: FirestoreTimestampType;
  created_at: number;
  user_agent: string;
  preview_role?: string;
}
```

### `SessionSchema`

Zod schema for Session.

```ts
const SessionSchema: z.ZodType<Session>;
```

### `Settlement`

One settlement event against an invoice.

```ts
interface Settlement {
  uid: string;
  uid_invoice: string;
  uid_organization: string;
  type: SettlementTypeType;
  reason: SettlementReasonType;
  amount_cents: number;
  date: string;
  date_fs: FirestoreTimestampType;
  reference: string | null;
  uid_session: string;
  reverses: string | null;
  uid_credit_note: string | null;
  number_credit_note: string | null;
  xero_payment_id: string | null;
  xero_credit_note_id: string | null;
  synced_at: FirestoreTimestampType | null;
  legacy_payment_uid: string | null;
  version: number;
  created_by: ActorRefType;
  updated_by: ActorRefType;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}
```

### `SettlementContract`

How one settlement type may be filled. @see {@link SETTLEMENT_CONTRACTS}

```ts
interface SettlementContract {
  reasons: readonly SettlementReasonType[];
  xero_id_field: "xero_payment_id" | "xero_credit_note_id" | null;
  sums_into: "amount_paid_cents" | "amount_credited_cents" | "amount_void_cents";
  reverses: "required" | "forbidden";
}
```

### `SettlementReasonEnum`

Zod schema for SettlementReasonType.

```ts
const SettlementReasonEnum: z.ZodType<SettlementReasonType>;
```

### `SettlementReasonType`

Why a settlement happened. @see {@link SETTLEMENT_CONTRACTS}

```ts
type SettlementReasonType = indexedAccess;
```

### `SettlementSchema`

Zod schema for a Settlement.

```ts
const SettlementSchema: z.ZodType<Settlement>;
```

### `SettlementTypeEnum`

Zod schema for SettlementTypeType.

```ts
const SettlementTypeEnum: z.ZodType<SettlementTypeType>;
```

### `SettlementTypeType`

One settlement event's kind. @see {@link SETTLEMENT_CONTRACTS}

```ts
type SettlementTypeType = indexedAccess;
```

### `StockMethodEnum`

Zod schema for StockMethodType.

```ts
const StockMethodEnum: z.ZodType<StockMethodType>;
```

### `StockMethodType`

Allowed values for inventory stock tracking method.

```ts
type StockMethodType = indexedAccess;
```

### `StockSummary`

Window-independent availability inputs for one product. Doc id == `uid` ==
`uid_product` == the product's / inventory-ledger's Firestore id.

```ts
interface StockSummary {
  uid: string;
  uid_product: string;
  type: ProductTypeType;
  quantity_held: number;
  bookings: StockSummaryBookingEntry[];
  out_of_service: StockSummaryOOSEntry[];
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}
```

### `StockSummaryBookingEntry`

A live (non-complete) booking as an interval + its breakdown. `end`/`end_fs`
null = open-ended (see the module note — this is the sale case).

```ts
interface StockSummaryBookingEntry {
  uid: string;
  number: number;
  start: string | null;
  start_fs: FirestoreTimestampType | null;
  end: string | null;
  end_fs: FirestoreTimestampType | null;
  breakdown: BookingBreakdown;
  type: ComponentTypeType;
}
```

### `StockSummaryOOSEntry`

A non-terminal out-of-service record as an interval + its quantity.

```ts
interface StockSummaryOOSEntry {
  uid: string;
  start: string | null;
  start_fs: FirestoreTimestampType | null;
  end: string | null;
  end_fs: FirestoreTimestampType | null;
  quantity: number;
  reason: OOSReasonType;
  status: OOSStatusType;
}
```

### `StockSummaryRecalculated`

```ts
type StockSummaryRecalculated = EventEnvelope<StockSummary> & typeLiteral;
```

### `StockSummarySchema`

Zod schema for StockSummary.

```ts
const StockSummarySchema: z.ZodType<StockSummary>;
```

### `Store`

A store document in Firestore.

```ts
interface Store {
  uid: string;
  name: string;
  default: boolean;
  default_location: UidNameRefType | null;
  crms_store_id: number;
  version: number;
  active: boolean;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}
```

### `StoreBreakdownEntry`

A single store entry in a stock breakdown, containing its locations.

```ts
interface StoreBreakdownEntry {
  uid_store: string;
  name: string;
  default: boolean;
  crms_stock_level_id: number | null;
  quantity: number;
  locations: StoreBreakdownLocation[];
}
```

### `StoreBreakdownEntrySchema`

Zod schema for StoreBreakdownEntry.

```ts
const StoreBreakdownEntrySchema: z.ZodType<StoreBreakdownEntry>;
```

### `StoreBreakdownLocation`

A single location within a store breakdown entry.

```ts
interface StoreBreakdownLocation {
  uid_location: string;
  name: string;
  quantity: number;
  default: boolean;
  max: number | null;
}
```

### `StoreBreakdownLocationSchema`

Zod schema for StoreBreakdownLocation.

```ts
const StoreBreakdownLocationSchema: z.ZodType<StoreBreakdownLocation>;
```

### `StoreCreated`

```ts
type StoreCreated = EventEnvelope<Store> & typeLiteral;
```

### `StoreSchema`

Zod schema for Store.

```ts
const StoreSchema: z.ZodType<Store>;
```

### `StoreUpdated`

```ts
type StoreUpdated = EventEnvelope<Store> & typeLiteral;
```

### `SyncErrorLogRecord`

Structured log entry for a sync-pipeline failure.

```ts
interface SyncErrorLogRecord {
  level: LogLevelType;
  msg: "sync_error";
  ts: string;
  sync_service: string;
  document_path?: string;
  operation?: string;
  error_name?: string;
  error_message?: string;
  error_stack?: string;
  request_id?: string;
  method?: string;
  path?: string;
  route?: string;
  user_id?: string;
  trace_id?: string;
  span_id?: string;
}
```

### `SyncErrorLogRecordSchema`

Zod schema for {@link SyncErrorLogRecord}.

```ts
const SyncErrorLogRecordSchema: z.ZodType<SyncErrorLogRecord>;
```

### `TEMPLATE_COLLECTION_UTILS`

Collection → the `@cfs/core/utils` namespace injected for it, exposed as
`it.<namespace>` inside a template.

`Partial` on purpose: a collection need not have a utils namespace.
`quotes` and `packing_lists` have none — templates *produce* those, they
don't compute over them.

Values must be valid `it.<ns>` identifiers. `contact-name` is deliberately
unmapped for that reason; a future collection needing it would map to
`"contactName"`.

```ts
const TEMPLATE_COLLECTION_UTILS: Partial<Record<TemplateCollectionType, string>>;
```

### `TEMPLATE_LIB_GLOBALS`

Third-party libraries injected as `it.*` globals for every template
(`it.dateFns`, `it.tz`). Not `@cfs/core` utils — documented here so the
render context has one authoritative inventory.

**This list IS the contract, not a description of one.** `api-cloudrun`'s
money Ratchet E asserts the render context's raw injections against it
directly, so adding a name here is what permits a new raw library into every
template — there is no second copy to keep in sync.

⚠️ **A money library must never come back.** `currency` lived here until
Phase 11 Phase E and was the one unguarded money surface templates had:
`it.currency(x).divide(y)` is a real, working call that makes a silent
rounding decision, and no ratchet in `api-cloudrun` or `core` can see what an
`.eta` file does with it — template content is canonical in the `templates`
repo, not here. Money reaches templates through `it.money` (see
{@link ALWAYS_ON_UTIL_NAMESPACES}), which is swept.

```ts
const TEMPLATE_LIB_GLOBALS: readonly string[];
```

### `TEMPLATE_PARAM_TYPES`

Render-time parameter types a template can declare. v1: boolean only.

```ts
const TEMPLATE_PARAM_TYPES: "boolean"[];
```

### `TEMPLATE_SCALAR_GLOBALS`

Per-render scalars injected as `it.*` globals for every template. `it.doc` is
always the **source** document — a template never reads its target, it
produces it.

```ts
const TEMPLATE_SCALAR_GLOBALS: readonly string[];
```

### `TEMPLATE_SOURCE_COLLECTIONS`

Collections that can serve as data sources for templates.

```ts
const TEMPLATE_SOURCE_COLLECTIONS: "orders" | "invoices"[];
```

### `TEMPLATE_SURFACES`

Client-agnostic detail surfaces where a template family is offered. NOT route
strings — clients map a surface to their own route (e.g. manager binds
`"order"` → `/orders/:id`). A packing list might surface on both `"order"`
and `"fulfillment"`; a quote only on `"order"`.

```ts
const TEMPLATE_SURFACES: "order" | "fulfillment" | "invoice"[];
```

### `TEMPLATE_TARGET_COLLECTIONS`

Collections that templates can produce documents for.

```ts
const TEMPLATE_TARGET_COLLECTIONS: "quotes" | "packing_lists" | "invoices"[];
```

### `TEMPLATE_VERSION_STATUSES`

Lifecycle status of a template version (mirrors the git lifecycle).

```ts
const TEMPLATE_VERSION_STATUSES: "draft" | "published" | "archived"[];
```

### `TYPESENSE_ROLLUP_COLUMNS`

Typesense fields **computed at index time**, which therefore have no Firestore
field to hang a label on.

Keyed `"<alias>:<field>"`, exactly like `DERIVED_FIELDS` in
`tests/typesenseFieldCoverage.test.ts` — and pinned against the real configs
by `tests/display-columns.test.ts`, so an entry naming a field the collection
does not declare fails rather than sitting here as a column that renders
nothing.

The root `dates.*` envelope is here because **Typesense cannot sort or filter
on a value inside an array**: orders and fulfillments stopped persisting a
top-level `dates`, and `deriveOrderDateEnvelope` synthesizes a flat min/max
across `destinations[]` purely so the index has something to order by.
`deliveries` / `pickups` / `has_conflicts` are `postProcess` predicates over
the same array.

**`_str` mirrors never appear here.** They are search mirrors that let a
number be *found* as text — `facet: false, sort: false` by construction — not
display columns. Under an opt-in model they are excluded by simply never
being annotated, so no suffix rule is needed anywhere.

```ts
const TYPESENSE_ROLLUP_COLUMNS: Record<string, Record<string, typeLiteral>>;
```

### `Tag`

A tag document in Firestore.

```ts
interface Tag {
  uid: string;
  name: string;
  count?: number;
  products?: UidNameRefType[];
  query_by_products?: string[];
  version: number;
  created_by: ActorRefType;
  updated_by: ActorRefType;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}
```

### `TagCreated`

```ts
type TagCreated = EventEnvelope<Tag> & typeLiteral;
```

### `TagDeleted`

```ts
type TagDeleted = EventEnvelope<Tag> & typeLiteral;
```

### `TagSchema`

Zod schema for Tag.

```ts
const TagSchema: z.ZodType<Tag>;
```

### `TagUpdated`

```ts
type TagUpdated = EventEnvelope<Tag> & typeLiteral;
```

### `Tax`

A tax definition used for computing item-level and order-level tax amounts.

```ts
interface Tax {
  uid: string;
  name: string;
  rate: number;
  type: RateType;
  active: boolean;
  crms_id: number | null;
  valid_from: string;
  valid_from_fs: FirestoreTimestampType;
  valid_to: string | null;
  valid_to_fs: FirestoreTimestampType | null;
  version: number;
  created_by: ActorRefType;
  updated_by: ActorRefType;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}
```

### `TaxProfileEnum`

Zod schema for TaxProfileType.

```ts
const TaxProfileEnum: z.ZodType<TaxProfileType>;
```

### `TaxProfileType`

Allowed values for organization-level tax profile.

```ts
type TaxProfileType = indexedAccess;
```

### `TaxRef`

Zod schema for a denormalized tax snapshot without computed amount.

```ts
const TaxRef: z.ZodType<TaxRefType>;
```

### `TaxRefType`

Denormalized tax snapshot without computed amount — used on product catalog entries.
PriceModifier extends this shape with `amount` for order-time computation.

```ts
interface TaxRefType {
  uid: string;
  name: string;
  rate: number;
  type: RateType;
}
```

### `TaxSchema`

Zod schema for Tax.

```ts
const TaxSchema: z.ZodType<Tax>;
```

### `Template`

A thin template *family* document — identity + rollups, no content/status.

```ts
interface Template {
  uid: string;
  git_path: string;
  name: string;
  collection_source: TemplateSourceCollectionType;
  collection_target: TemplateTargetCollectionType;
  surfaces: TemplateSurfaceType[];
  uid_active: string | null;
  active_semver?: string | null;
  depends_on: TemplateDependsOn;
  fixtures: FixtureMeta[];
  draft_uids: string[];
  version_count: number;
  last_published_at: FirestoreTimestampType | null;
  uid_thread: string;
  version: number;
  created_by: ActorRefType;
  updated_by: ActorRefType;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}
```

### `TemplateCollectionType`

Any collection a template can read from or produce.

```ts
type TemplateCollectionType = TemplateSourceCollectionType | TemplateTargetCollectionType;
```

### `TemplateComponent`

A thin template-component *family* document.

```ts
interface TemplateComponent {
  uid: string;
  git_path: string;
  name: string;
  uid_active: string | null;
  draft_uids: string[];
  version_count: number;
  last_published_at: FirestoreTimestampType | null;
  version: number;
  created_by: ActorRefType;
  updated_by: ActorRefType;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}
```

### `TemplateComponentInputSchema`

Zod schema for TemplateComponentInput.

```ts
const TemplateComponentInputSchema: z.ZodType<TemplateComponentInputType>;
```

### `TemplateComponentInputType`

Input for registering a new template-component family.

```ts
interface TemplateComponentInputType {
  name: string;
}
```

### `TemplateComponentSchema`

Zod schema for a TemplateComponent family document.

```ts
const TemplateComponentSchema: z.ZodType<TemplateComponent>;
```

### `TemplateContext`

Context object passed to Eta templates at render time.

```ts
interface TemplateContext {
  doc: Record<string, unknown>;
  version?: number | null;
  logo?: string;
  params?: Record<string, unknown>;
}
```

### `TemplateCreated`

```ts
type TemplateCreated = EventEnvelope<Template> & typeLiteral;
```

### `TemplateDependsOn`

Component dependencies a template family overlays at render time.

```ts
interface TemplateDependsOn {
  components: string[];
}
```

### `TemplateHelperEntry`

One callable helper in the template editor's helper panel.

```ts
interface TemplateHelperEntry {
  name: string;
  expr: string;
  desc: string;
  returns: string;
}
```

### `TemplateInputSchema`

Zod schema for TemplateInput.

```ts
const TemplateInputSchema: z.ZodType<TemplateInputType>;
```

### `TemplateInputType`

Input for registering a new template *family*. Content is not provided here —
registration creates the family doc + a git branch carrying the sidecar; the
server derives `git_path = slugify(name)` and freezes it.

```ts
interface TemplateInputType {
  name: string;
  collection_source: TemplateSourceCollectionType;
  collection_target: TemplateTargetCollectionType;
  surfaces: TemplateSurfaceType[];
  depends_on?: Partial<TemplateDependsOn>;
}
```

### `TemplateParam`

A render-time parameter declared by a template version.

```ts
interface TemplateParam {
  key: string;
  type: TemplateParamType;
  label?: string;
  default?: boolean;
  required?: boolean;
}
```

### `TemplateParamSchema`

Zod schema for a TemplateParam.

```ts
const TemplateParamSchema: z.ZodType<TemplateParam>;
```

### `TemplateParamType`

A single render-time parameter type.

```ts
type TemplateParamType = indexedAccess;
```

### `TemplateSchema`

Zod schema for a Template family document.

```ts
const TemplateSchema: z.ZodType<Template>;
```

### `TemplateSourceCollectionType`

Firestore collection that provides data to a template.

```ts
type TemplateSourceCollectionType = indexedAccess;
```

### `TemplateSurfaceType`

A single client-agnostic surface a template is offered on.

```ts
type TemplateSurfaceType = indexedAccess;
```

### `TemplateTargetCollectionType`

Firestore collection that a template produces documents for.

```ts
type TemplateTargetCollectionType = indexedAccess;
```

### `TemplateUpdated`

```ts
type TemplateUpdated = EventEnvelope<Template> & typeLiteral;
```

### `TemplateVersion`

A status-discriminated template version (draft | published | archived).

```ts
interface TemplateVersion {
  uid: string;
  uid_template: string;
  status: TemplateVersionStatusType;
  content: Record<string, string>;
  params: TemplateParam[];
  consumed_components: string[];
  git_branch?: string;
  base_sha?: string;
  base_seq?: number;
  display_name?: string;
  uid_thread?: string;
  committed_content_hash?: string;
  sha?: string;
  semver?: string;
  seq?: number;
  commit_meta?: CommitMeta;
  blob_refs?: BlobRef[];
  pr_number?: number | null;
  golden_results?: GoldenDiff[];
  reconciled?: boolean;
  written_by: ActorRefType;
  version: number;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}
```

### `TemplateVersionSchema`

Zod schema for a TemplateVersion document.

```ts
const TemplateVersionSchema: z.ZodType<TemplateVersion>;
```

### `TemplateVersionStatusType`

A single template-version status.

```ts
type TemplateVersionStatusType = indexedAccess;
```

### `Thread`

Thread Firestore document shape.

```ts
interface Thread {
  uid: string;
  sources: DocSourceType[];
  title: string | null;
  last_message_at: FirestoreTimestampType | null;
  last_message_preview: string;
  comment_count: number;
  version: number;
  created_by: ActorRefType;
  updated_by: ActorRefType;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}
```

### `ThreadCreated`

```ts
type ThreadCreated = EventEnvelope<Thread> & typeLiteral;
```

### `ThreadId`

`threads.uid` and every `uid_thread` reference — `cards`, `comments`, and the
eight default-thread carriers (`orders`, `invoices`, `products`, `roles`,
`contacts`, `organizations`, `out-of-service`, `credit-notes`, where it is
`.optional()`) — either a Firestore auto-id (the default-thread cowrite) or
an `EventCardId` composite. Event-card threads are minted at a **deterministic
id equal to their card uid** (`${uid_order}:${uid_destination}:start|end`) so
the delete→recreate churn of a CRMS opportunity-webhook burst reuses the one
stable `threads/{cardUid}` doc instead of piling up random-id orphans (and
comments survive across the cycle). Structurally identical to `CardId`; see
`services/eventCardReconcile.ts` `eventCardThreadId`.

```ts
const ThreadId: z.ZodType<string>;
```

### `ThreadSchema`

Zod schema for a thread Firestore document.

```ts
const ThreadSchema: z.ZodType<Thread>;
```

### `ThreadUpdated`

```ts
type ThreadUpdated = EventEnvelope<Thread> & typeLiteral;
```

### `TimestampFields`

Standard timestamp fields present on most documents.

Both are declared display columns here rather than at each of the ~30 sites
that spread this object — the heading is the same everywhere because the
meaning is. `.meta()` clones, so these two are distinct instances of
`FirestoreTimestamp` and the base stays unannotated.

```ts
const TimestampFields: typeLiteral;
```

### `TrackingCategory`

A tracking category document in Firestore.

```ts
interface TrackingCategory {
  uid: string;
  name: string;
  count?: number;
  crms_product_group_id?: number;
  crms_service_group_id?: number;
  crms_product_group_name: string;
  products: Record<string, UidNameRefType>;
  xero_tracking_option_id: string | null;
  version: number;
  created_by: ActorRefType;
  updated_by: ActorRefType;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}
```

### `TrackingCategoryCreated`

```ts
type TrackingCategoryCreated = EventEnvelope<TrackingCategory> & typeLiteral;
```

### `TrackingCategorySchema`

Zod schema for TrackingCategory.

```ts
const TrackingCategorySchema: z.ZodType<TrackingCategory>;
```

### `TrackingCategoryUpdated`

```ts
type TrackingCategoryUpdated = EventEnvelope<TrackingCategory> & typeLiteral;
```

### `TransactionCreated`

```ts
type TransactionCreated = EventEnvelope<Movement> & typeLiteral;
```

### `TransactionDefinition`

Groups CollectionRules into a named atomic operation.

```ts
interface TransactionDefinition {
  id: string;
  description: string;
  steps: string[];
}
```

### `TransactionLogRecord`

Structured log entry for a single Firestore transaction commit (success or failure).

```ts
interface TransactionLogRecord {
  level: LogLevelType;
  msg: "transaction";
  ts: string;
  tx_name: string;
  status: TransactionStatusType;
  duration_ms: number;
  write_count: number;
  target_counts: Record<string, number>;
  estimated_json_bytes: number;
  sample_doc_paths: string[];
  read_paths?: string[];
  read_count?: number;
  read_counts?: Record<string, number>;
  range_reads?: Record<string, number>;
  contended_ranges?: string[];
  error_name?: string;
  error_message?: string;
  error_stack?: string;
  aborted?: boolean;
  request_id?: string;
  method?: string;
  path?: string;
  route?: string;
  user_id?: string;
  trace_id?: string;
  span_id?: string;
  dry_run?: boolean;
}
```

### `TransactionLogRecordSchema`

Zod schema for {@link TransactionLogRecord}.

```ts
const TransactionLogRecordSchema: z.ZodType<TransactionLogRecord>;
```

### `TransactionStatusType`

Status outcome of a Firestore transaction commit.

```ts
type TransactionStatusType = indexedAccess;
```

### `TransactionUpdated`

```ts
type TransactionUpdated = EventEnvelope<Movement> & typeLiteral;
```

### `TypedLogRecord`

Discriminated union of every typed log record, keyed by the `msg`
literal. The new `logTyped<R extends TypedLogRecord>` API in
api-cloudrun's `src/lib/logger.ts` constrains its argument to this
union — TS narrows to the matching arm based on the supplied `msg`,
giving compile-time enforcement that every field is correctly named
and typed.

Adding a new arm requires:
  1. Define schema + interface in `./<archetype>.ts`
  2. Re-export both above
  3. Add to this union
  4. Add to {@link MSG_SCHEMA_REGISTRY} below

The `log-records.test.ts` coverage test asserts union ↔ registry
symmetry so it's impossible to add one without the other.

```ts
type TypedLogRecord = ClientLogRecord | DmarcAggregateLogRecord | EmailSendFailedLogRecord | EmailSentLogRecord | OAuthRefreshLogRecord | PropagationLogRecord | RequestLogRecord | SyncErrorLogRecord | TransactionLogRecord | ValidationErrorLogRecord | AccessControlEventLogRecord | CalendarEventLogRecord | CloudTaskEventLogRecord | DomainEventLogRecord | IntegrationEventLogRecord | McpEventLogRecord | OAuthEventLogRecord | SystemEventLogRecord | TemplateEventLogRecord | TypesenseEventLogRecord | UserSessionEventLogRecord | XeroEventLogRecord;
```

### `TypesenseConfig`

```ts
interface TypesenseConfig {
  uid: string;
  current_collection: string;
  schema_hash: string;
  intended_hash?: string;
  updates?: number;
  last_reindex?: FirestoreTimestampType;
  last_reindex_stats?: TypesenseConfigReindexStats;
  reindex_attempts?: number;
}
```

### `TypesenseConfigReindexStats`

```ts
interface TypesenseConfigReindexStats {
  total: number;
  success: number;
  failed: number;
  errors?: string[];
}
```

### `TypesenseConfigSchema`

```ts
const TypesenseConfigSchema: z.ZodType<TypesenseConfig>;
```

### `TypesenseDisplayPrefs`

User display preferences for a Typesense-backed collection view.

`group` and `facet` were removed here alongside
{@linkcode TypesenseDisplayDefaults} — both were written on every save and
read by nothing. This object is **strict**, so a blob still carrying them
fails to parse; the write path does not validate (`updateUser` merges and
`transaction.set`s), so nothing breaks at runtime, but
`scripts/audit-schema-validation.ts --only=users` will report it. Both
environments held `{}` when this landed, so there was nothing to migrate.

```ts
interface TypesenseDisplayPrefs {
  columns: string[];
  filters: Record<string, parenthesized[]>;
  sort: DisplaySort;
}
```

### `UidNameRef`

Zod schema for a uid + name reference.

```ts
const UidNameRef: z.ZodType<UidNameRefType>;
```

### `UidNameRefType`

Generic uid + name reference used across many collections.

```ts
interface UidNameRefType {
  uid: string;
  name: string;
}
```

### `UpdateBookingInput`

Zod schema for UpdateBookingInput.

```ts
const UpdateBookingInput: z.ZodType<UpdateBookingInputType>;
```

### `UpdateBookingInputType`

Input for updating a single booking via `PUT /bookings/{uid}`.

Status and breakdown are independently optional — most warehouse PUTs only
change the breakdown. When `breakdown` is supplied it must be the complete
next state (all 7 keys); the service requires `sum(breakdown) === quantity`
and treats the value as an absolute write, not a partial patch. Version is
required for optimistic concurrency.

{@link UpdateBookingInputType.uid_session} is what makes this endpoint safe to
retry once a breakdown change also appends to the movement journal — see the
field's own note.

```ts
interface UpdateBookingInputType {
  status?: BookingStatusType;
  breakdown?: indexedAccess;
  version: number;
  uid_session: string;
}
```

### `UpdateCardInput`

Zod schema for updating a card. Lock enforcement happens at the service
layer (api-cloudrun) — the schema accepts any field, then service rejects
with FIELD_LOCKED if the card's `locked[]` contains the field name.

```ts
const UpdateCardInput: z.ZodType<UpdateCardInputType>;
```

### `UpdateCardInputType`

Input for PATCH /cards/:uid — all fields optional except version.

```ts
interface UpdateCardInputType {
  uid_list?: string;
  status?: CardStatus;
  position?: number;
  subject?: string;
  body?: CommentBodyJson | null;
  body_text?: string;
  dates?: CardDatesType;
  all_day?: boolean;
  destination?: DocDestinationEndpointType | null;
  organization?: CardOrganizationType | null;
  sources?: DocSourceType[];
  attachments?: CardAttachmentType[];
  uid_assignees?: string[];
  version: number;
}
```

### `UpdateCommentInput`

Zod schema for updating a comment.

```ts
const UpdateCommentInput: z.ZodType<UpdateCommentInputType>;
```

### `UpdateCommentInputType`

Input for PATCH /comments/:uid.

```ts
interface UpdateCommentInputType {
  body: CommentBodyJson;
  body_text: string;
  version: number;
}
```

### `UpdateContactInput`

Input schema for updating a contact.

```ts
const UpdateContactInput: z.ZodType<UpdateContactInputType>;
```

### `UpdateContactInputType`

Input schema for PUT /contacts/:uid — partial update.

```ts
interface UpdateContactInputType {
  uid?: string;
  emails?: string[];
  phones?: string[];
  organizations?: ContactOrganizationType[];
  version: number;
}
```

### `UpdateFixedHolidayInputType`

Input type for updating a fixed-date holiday (full rule replacement).

```ts
interface UpdateFixedHolidayInputType {
  uid: string;
  version: number;
  type: "fixed";
  name: string;
  month: number;
  date: number;
}
```

### `UpdateHolidayDefinitionInput`

Input schema for updating a holiday definition (in-place edit, version-checked).

```ts
const UpdateHolidayDefinitionInput: z.ZodType<UpdateHolidayDefinitionInputType>;
```

### `UpdateHolidayDefinitionInputType`

Input type for updating a holiday definition. Carries `version` for the optimistic-lock check.

```ts
type UpdateHolidayDefinitionInputType = UpdateFixedHolidayInputType | UpdateVariableHolidayInputType;
```

### `UpdateInvoiceInput`

Input schema for updating an invoice.

```ts
const UpdateInvoiceInput: z.ZodType<UpdateInvoiceInputType>;
```

### `UpdateInvoiceInputType`

Input schema for PUT /invoices/:uid — partial update.

```ts
interface UpdateInvoiceInputType {
  status?: InvoiceStatusType;
  items?: InvoiceItemInputType[];
  destinations?: InvoiceDocDestinationType[];
  date?: string;
  due_date?: string;
  subject?: string;
  reference?: string | null;
  external_notes?: string;
  internal_notes?: string;
  version: number;
}
```

### `UpdateListInput`

Zod schema for updating a list.

```ts
const UpdateListInput: z.ZodType<UpdateListInputType>;
```

### `UpdateListInputType`

Input for PATCH /lists/:uid — all fields optional except version.

```ts
interface UpdateListInputType {
  name?: string;
  description?: string;
  icon?: string | null;
  color?: string | null;
  position?: number;
  locked?: ListLockKey[];
  version: number;
}
```

### `UpdateLocationInput`

Input schema for updating a location.

```ts
const UpdateLocationInput: z.ZodType<UpdateLocationInputType>;
```

### `UpdateLocationInputType`

Input type for updating a location.

```ts
interface UpdateLocationInputType {
  uid: string;
  name?: string;
  default?: boolean;
  active?: boolean;
  version: number;
}
```

### `UpdateLocationTypeInput`

Input schema for updating a location type.

```ts
const UpdateLocationTypeInput: z.ZodType<UpdateLocationTypeInputType>;
```

### `UpdateLocationTypeInputType`

Input type for updating a location type.

```ts
interface UpdateLocationTypeInputType {
  uid: string;
  name?: string;
  product_capacities?: Record<string, typeLiteral>;
  dimensions?: typeLiteral | null;
  active?: boolean;
  version: number;
}
```

### `UpdateOrderInput`

Input schema for updating an order.

```ts
const UpdateOrderInput: z.ZodType<UpdateOrderInputType>;
```

### `UpdateOrderInputType`

Input schema for PUT /orders/:uid — partial update.

```ts
interface UpdateOrderInputType {
  uid?: string;
  organization?: typeLiteral;
  status?: OrderStatusType;
  tax_profile?: TaxProfileType;
  destinations?: DestinationType[];
  items?: OrderItemType[];
  subject?: string;
  reference?: string | null;
  version: number;
}
```

### `UpdateOrganizationInput`

Input schema for updating an organization.

```ts
const UpdateOrganizationInput: z.ZodType<UpdateOrganizationInputType>;
```

### `UpdateOrganizationInputType`

Input schema for PUT /organizations/:uid — partial update.

```ts
interface UpdateOrganizationInputType {
  uid?: string;
  name?: string;
  tax_profile?: TaxProfileType;
  description?: string;
  billing_address?: AddressType | null;
  contacts?: OrganizationContactType[];
  newContacts?: NewContactInputType[] | null;
  emails?: string[];
  phones?: string[];
  version: number;
}
```

### `UpdateOutOfServiceInput`

Zod schema for UpdateOutOfServiceInput.

```ts
const UpdateOutOfServiceInput: z.ZodType<UpdateOutOfServiceInputType>;
```

### `UpdateOutOfServiceInputType`

Input for updating an out-of-service record.

`breakdown` (when supplied) must be the complete next state — the writer
enforces `sum(breakdown) === quantity`. `status` is server-derived; only
`"canceled"` is honored from the client and translated into
`canceled_at = now()`.

`dates.start` is honored on update only when the record has no sources
(`sources.length === 0` — manually created / ad-hoc). Source-bound records
(booking PUT or order check-in lineage) reject `dates.start` updates with a
400 — the start there reflects a real ledger event recorded by the upstream
writer, and operator-side drift would desync the OOS from the source's
audit trail.

```ts
interface UpdateOutOfServiceInputType {
  status?: OOSStatusType;
  breakdown?: OOSBreakdown;
  dates?: typeLiteral;
  stores?: OOSStore[];
  version: number;
}
```

### `UpdateProductInput`

Input schema for updating a product.

```ts
const UpdateProductInput: z.ZodType<UpdateProductInputType>;
```

### `UpdateProductInputType`

Input type for updating a product.

```ts
interface UpdateProductInputType {
  uid: string;
  name?: string;
  active?: boolean;
  type?: ProductTypeType;
  stock_method?: StockMethodType;
  component_only?: boolean;
  description?: string;
  eligible_delivery?: boolean;
  eligible_in_store_pickup?: boolean;
  eligible_shipping_ground?: boolean;
  eligible_shipping_air?: boolean;
  price?: typeLiteral;
  shipping?: typeLiteral;
  alternates?: UidNameRefType[];
  components?: ProductComponent[];
  component_of?: ProductComponent[];
  tags?: UidNameRefType[];
  uid_tracking_category?: string | null;
  uid_linked_rental?: string;
  uid_linked_replacement?: string;
  webshop?: typeLiteral;
  version: number;
}
```

### `UpdateRecurrenceInput`

Zod schema for updating a recurrence.

```ts
const UpdateRecurrenceInput: z.ZodType<UpdateRecurrenceInputType>;
```

### `UpdateRecurrenceInputType`

Input for PATCH /recurrences/:uid — all fields optional. Prototype
field patches fan out to existing instance cards at the service layer
(skipping cards whose `recurrence_overrides` pin the field).

```ts
interface UpdateRecurrenceInputType {
  uid_list?: string;
  status?: RecurrenceStatus;
  rule?: RecurrenceRuleType;
  active_from?: string;
  active_until?: string | null;
  horizon_days?: number | null;
  prototype?: typeLiteral;
  version: number;
}
```

### `UpdateStoreInput`

Input schema for updating a store.

```ts
const UpdateStoreInput: z.ZodType<UpdateStoreInputType>;
```

### `UpdateStoreInputType`

Input type for updating a store.

```ts
interface UpdateStoreInputType {
  uid: string;
  name?: string;
  crms_store_id?: number;
  default?: boolean;
  active?: boolean;
  version: number;
}
```

### `UpdateTagInput`

Input schema for updating a tag.

```ts
const UpdateTagInput: z.ZodType<UpdateTagInputType>;
```

### `UpdateTagInputType`

Input type for updating a tag.

```ts
interface UpdateTagInputType {
  uid: string;
  name: string;
  version: number;
}
```

### `UpdateTaxInput`

Zod schema for UpdateTaxInput.

```ts
const UpdateTaxInput: z.ZodType<UpdateTaxInputType>;
```

### `UpdateTaxInputType`

Input for updating an existing tax definition.

```ts
interface UpdateTaxInputType {
  uid: string;
  name?: string;
  rate?: number;
  type?: RateType;
  active?: boolean;
  valid_from?: string;
  valid_to?: string | null;
  version: number;
}
```

### `UpdateTemplateVersionInput`

Zod schema for updating a template version. NON-strict on purpose: the manager
cache's buildDiff injects `uid`, and validateUpdate runs this against the full
TemplateVersion entity — both rely on unknown-key stripping.

```ts
const UpdateTemplateVersionInput: z.ZodType<UpdateTemplateVersionInputType>;
```

### `UpdateTemplateVersionInputType`

Input for PUT /templates-versions/:uid — partial content/params/rename + OCC token.

```ts
interface UpdateTemplateVersionInputType {
  content?: Record<string, string>;
  params?: TemplateParam[];
  display_name?: string;
  version: number;
}
```

### `UpdateThreadInput`

Zod schema for updating a thread.

```ts
const UpdateThreadInput: z.ZodType<UpdateThreadInputType>;
```

### `UpdateThreadInputType`

Input for PATCH /threads/:uid — rename only.

```ts
interface UpdateThreadInputType {
  title: string | null;
  version: number;
}
```

### `UpdateTrackingCategoryInput`

Input schema for updating a tracking category.

```ts
const UpdateTrackingCategoryInput: z.ZodType<UpdateTrackingCategoryInputType>;
```

### `UpdateTrackingCategoryInputType`

Input type for updating a tracking category.

```ts
interface UpdateTrackingCategoryInputType {
  uid: string;
  name: string;
  version: number;
}
```

### `UpdateTransactionInput`

Input schema for editing a movement's descriptive fields.

```ts
const UpdateTransactionInput: z.ZodType<UpdateTransactionInputType>;
```

### `UpdateTransactionInputType`

Input for editing a movement's descriptive fields.

**Balance-affecting fields are absent by design.** Quantity, type, cost,
placement and date change through a reversal plus a corrected event, not an
in-place edit — that is what makes the collection a journal rather than a
mutable table. Only `reference` still edits in place.

```ts
interface UpdateTransactionInputType {
  reference: string;
  version: number;
}
```

### `UpdateUserInput`

Input schema for updating a user.

```ts
const UpdateUserInput: z.ZodType<UpdateUserInputType>;
```

### `UpdateUserInputType`

Payload for PUT /users/:uid — full-doc replace; server-managed fields excluded.

```ts
interface UpdateUserInputType {
  email?: string;
  uid_contact?: string | null;
  version: number;
  prefs_firestore?: Record<string, FirestoreDisplayPrefs>;
  prefs_typesense?: Record<string, TypesenseDisplayPrefs>;
}
```

### `UpdateVariableHolidayInputType`

Input type for updating a variable-date holiday (full rule replacement).

```ts
interface UpdateVariableHolidayInputType {
  uid: string;
  version: number;
  type: "variable";
  name: string;
  month: number;
  day: number;
  week: HolidayWeekInputType;
}
```

### `UploadcareSweepRun`

One recorded sweep run.

```ts
interface UploadcareSweepRun {
  ref_counts: Record<string, number>;
  recorded_at: FirestoreTimestampType;
}
```

### `UploadcareSweepRunSchema`

Zod schema for UploadcareSweepRun.

```ts
const UploadcareSweepRunSchema: z.ZodType<UploadcareSweepRun>;
```

### `User`

Full user document schema (Firestore document shape).

```ts
interface User {
  uid: string;
  email: string;
  name: string;
  password_hash: string;
  email_verified: boolean;
  uid_contact?: string | null;
  roles?: string[];
  token_version?: number;
  version: number;
  prefs_firestore: Record<string, FirestoreDisplayPrefs>;
  prefs_typesense: Record<string, TypesenseDisplayPrefs>;
  deleted_at?: FirestoreTimestampType | null;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}
```

### `UserSchema`

Zod schema for a full user Firestore document.

```ts
const UserSchema: z.ZodType<User>;
```

### `ValidationErrorLogRecord`

Structured log entry for a schema validation failure.

```ts
interface ValidationErrorLogRecord {
  level: LogLevelType;
  msg: "validation_error";
  ts: string;
  label: string;
  issues: ValidationIssue[];
  request_id?: string;
  method?: string;
  path?: string;
  route?: string;
  user_id?: string;
  trace_id?: string;
  span_id?: string;
}
```

### `ValidationErrorLogRecordSchema`

Zod schema for {@link ValidationErrorLogRecord}.

```ts
const ValidationErrorLogRecordSchema: z.ZodType<ValidationErrorLogRecord>;
```

### `ValidationIssue`

Single Zod issue, structurally.

```ts
interface ValidationIssue {
  path?: parenthesized[];
  code?: string;
  message?: string;
  keys?: string[];
  expected?: string;
}
```

### `WebhookEvent`

An inbound webhook event stored for processing.

```ts
interface WebhookEvent {
  id: string;
  event: string;
  received: FirestoreTimestampType;
  expiresAt: FirestoreTimestampType;
  payload: unknown;
}
```

### `WebhookEventSchema`

Zod schema for WebhookEvent.

```ts
const WebhookEventSchema: z.ZodType<WebhookEvent>;
```

### `WebshopProduct`

A webshop product document in the webshop-products Firestore collection.

```ts
interface WebshopProduct {
  uid: string;
  name: string;
  active: boolean;
  type: WebshopProductTypeType;
  stock_method?: StockMethodType;
  component_only?: boolean;
  description?: string;
  eligible_delivery: boolean;
  eligible_in_store_pickup: boolean;
  eligible_shipping_ground: boolean;
  eligible_shipping_air: boolean;
  price: typeLiteral;
  shipping?: WebshopProductShipping;
  alternates: UidNameRefType[];
  components: WebshopProductComponent[];
  component_of: WebshopProductComponent[];
  tags?: UidNameRefType[];
  query_by_tags?: string[];
  query_by_components?: string[];
  query_by_component_of?: string[];
  query_by_alternates?: string[];
  webshop: typeLiteral;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}
```

### `WebshopProductComponent`

A component product within a webshop parent product.

```ts
interface WebshopProductComponent {
  uid: string;
  path: string[];
  name: string;
  active?: boolean;
  type: ComponentTypeType;
  stock_method?: StockMethodType;
  description?: string;
  inclusion_type?: InclusionTypeType;
  quantity: number;
  zero_priced?: boolean;
  price: typeLiteral;
}
```

### `WebshopProductSchema`

Zod schema for a WebshopProduct document.

```ts
const WebshopProductSchema: z.ZodType<WebshopProduct>;
```

### `WebshopProductShipping`

Shipping dimensions and hazard classification for a webshop product.

```ts
interface WebshopProductShipping {
  weight?: number | null;
  height?: number | null;
  width?: number | null;
  length?: number | null;
  air_hazardous?: boolean;
  air_un?: number | null;
}
```

### `WebshopProductUpdated`

```ts
type WebshopProductUpdated = EventEnvelope<WebshopProduct> & typeLiteral;
```

### `XeroBudget`

The persisted Xero daily-budget snapshot (`xero-budget/current`).

```ts
interface XeroBudget {
  uid: "current";
  day_remaining: number;
  observed_at: string;
  resets_at: string;
  resets_at_source: XeroResetsAtSource;
  updated_at: FirestoreTimestampType;
}
```

### `XeroBudgetSchema`

Zod schema for XeroBudget.

```ts
const XeroBudgetSchema: z.ZodType<XeroBudget>;
```

### `XeroResetsAtSource`

How `resets_at` was determined.

- `retry_after` — derived from Xero's `Retry-After` header on a day-429. Xero
  sends it only on a 429, but it *does* send it on a day-429 and the raw
  value is the real time-to-reset. Trust it.
- `inferred_rollover` — no `Retry-After` was available, so the next observed
  ~20:00–20:20 UTC tenant rollover was assumed (corroborated across
  2026-07-09/10/12), clamped to `now + 24h`.

Stamped so an inferred value is *visible* rather than indistinguishable from
a reported one.

```ts
type XeroResetsAtSource = "retry_after" | "inferred_rollover";
```

### `XeroSyncState`

The per-order Xero-quote sync watermark (`orders/{uid}/xero-sync/state`).

```ts
interface XeroSyncState {
  uid: "state";
  pushed_hash: string;
  pushed_at: FirestoreTimestampType;
}
```

### `XeroSyncStateSchema`

Zod schema for XeroSyncState.

```ts
const XeroSyncStateSchema: z.ZodType<XeroSyncState>;
```

### `XeroThrottleResetsAtSource`

How a *throttle's* `resets_at` was determined. A superset of
{@link XeroResetsAtSource}, because Xero throttles on two independent windows
and only the daily one rolls over:

- `assumed_minute` — a minute / app-minute / concurrent 429 that carried no
  `Retry-After` (per Xero's docs the concurrent and app-minute limits don't send
  one), so `now + 60s` was assumed — the width of the minute window.

Deliberately NOT added to {@link XeroBudgetSchema}: the persisted
`xero-budget/current` doc describes the **day** window only, and a minute-limit
refusal must never be able to write a 60-second `resets_at` into it. Widening the
doc schema would let a transient throttle masquerade as the daily budget and make
the gate fail open a minute later.

```ts
type XeroThrottleResetsAtSource = XeroResetsAtSource | "assumed_minute";
```

### `aggregates`

```ts
const aggregates: AggregateDefinition[];
```

### `availableUtilNamespaces(sources: readonly TemplateCollectionType[], targets: readonly TemplateCollectionType[]): string[]`

Resolve the `@cfs/core/utils` namespaces available to a template, as the union
of the always-on set plus each source/target collection's namespace.

```ts
availableUtilNamespaces(["orders"], ["quotes"]);     // ["dates", "orders"]
availableUtilNamespaces(["orders"], ["invoices"]);   // ["dates", "orders", "invoices"]
availableUtilNamespaces(["invoices"], ["invoices"]); // ["dates", "invoices"]
```

Note that a **target**-derived namespace is forward-looking: `it.doc` is the
source document, so e.g. an orders→invoices template gets `it.invoices`
helpers with no invoice document to apply them to until the author builds
invoice-shaped data themselves.

**Parameters**

- `sources` — The template's source collections (single-element today).
- `targets` — The template's target collections (single-element today).

**Returns** — Deduped namespace list, always-on first, in collection order.

### `canOperatorTransition(from: string, to: string): boolean`

May an operator move `from` to `to` via `PUT /invoices/{uid}`?

Read this rather than the column, so the manager cannot offer a button the
server will 400 — and so a status outside the vocabulary answers `false`
instead of throwing on an undefined lookup.

### `cardRules`

All card-related propagation rules.

```ts
const cardRules: CollectionRule[];
```

### `checkItemContract(item: typeLiteral, ctx: z.RefinementCtx): void`

The full per-item contract check — {@link checkItemPriceFormula} plus the
`replacement` axis. Attached with `.superRefine` to the ORDER line-item arm,
the one item shape whose price carries a `replacement` channel. The direct
analogue of `checkMovementContract` in `transaction.ts`.

`required_when_stocked` treats a MISSING `stock_method` as stocked — the
conservative reading, and the one the hand-written refine this replaced always
enforced. **Both callers now make the field required** (`OrderDocLineItemInner`
as of W5, `ComponentObject` from the start), so that branch is unreachable
through either one; it is kept because a refinement is not a parse and this
function takes a structural bound, not a schema.

The `stock_method` requirement is also why the axis does not run on the
invoice arm: an invoice line drops `stock_method` and `price.replacement`
together, so an absent `stock_method` there means "this shape has no answer",
not "unknown" — and running it would reject all 7,076 invoice rentals in prod.

⚠️ **This function takes a STRUCTURAL BOUND, not a schema, so the compiler
cannot tell you when a field it reads has been renamed away.** During the
dollars→cents migration `price.replacement` became `price.replacement_cents`
everywhere; had the bound below not moved with it, `deno check` would have
stayed green while `item.price?.replacement` read `undefined` forever — the
`forbidden` arm permanently vacuous (a transaction_fee could carry a
replacement price) and the `required_when_stocked` arm firing on every
stocked rental. Any future rename of a field named here must edit this
signature; `tests/common.test.ts` pins both arms against a live shape so a
vacuous bound fails rather than passes.

### `checkItemPriceFormula(item: typeLiteral, ctx: z.RefinementCtx): void`

The `pricing` half of {@link ITEM_CONTRACTS}: a `percent_of_total` price is
legal only where the contract says the line is priced FROM the document total.

Applies to every price shape in the package, so it is the check the invoice
arm attaches on its own — an invoice line has no `stock_method` and its price
has no `replacement` key, which leaves this as the only axis it can express.

`percent_of_total` prices a line from the DOCUMENT total, which only
`calculateTransactionFeeAmount` knows how to do — `calculateItemSubtotal`
throws on it. Before this axis the combination was merely thrown on at
runtime, deep in `perUnitSubtotal`; here it is unwritable. The converse is
deliberately NOT asserted: a flat-amount fee is legitimate, and
`calculateTransactionFeeAmount` prices one.

### `collectDisplayColumns(schema: z.ZodType, opts?: typeLiteral): CollectDisplayColumnsResult`

Collect every column a schema **declares** for display.

This is the replacement for generating the column universe by enumerating a
schema and then generating a label for each entry with structural regexes.
Nobody chose those columns and nobody wrote those headings, so both drifted on
every rename — a money migration turned `total` into `total_cents` and the
heading became "Totals - Total Cents", and `date_fs` degenerated to the
two-letter heading **"Fs"**. Declaring is opt-in: a new field cannot surface a
broken column by existing, and a rename carries its annotation with it.

## What is emitted

Any node tagged `column: true` — **object nodes included**. A contact ref and
an address are single columns rendered from the whole object (joined name,
multi-line block), not one column per part, so the annotation has to be able
to land above the scalars. The walk continues past an emitted object, so a
parent and a child can both be columns.

## The label composes down the key path

The heading is the `label` of **every key traversed**, root→leaf, joined with
a space and with consecutive repeats collapsed. So `full` inside the shared
`Address` schema is labelled `"Address"` exactly once and yields
"Delivery Address" under `destinations[].delivery`, "Collection Address" under
`destinations[].collection`, and a bare "Address" where nothing above it is
labelled.

The composition source is the sequence of **keys traversed**, not the terminal
node — which is what lets one shared schema carry one label and still read
correctly at ten sites. Two keys holding the *same* schema instance get
distinct labels because **`.meta()` clones**: `Leg.meta({ label: "Delivery" })
!== Leg`, and the base schema stays unannotated.

A `label` with no `column` is a pure prefix — that is the normal state of an
intermediate key like `delivery` or `organization`.

## Fails closed, like {@link collectLeafPaths}

A node type the walker does not recognise lands in `unhandled` rather than
being skipped silently, because skipping it would drop its whole subtree and
make every column under it vanish from the picker with nothing to notice.

Union members are visited at the same path and deduped by (path, node), so a
discriminated `items[]` contributes each arm's columns once. Where two arms
annotate the same path, the first wins — they are the same column.

### `collectLeafPaths(schema: z.ZodType, opts?: typeLiteral): CollectLeafPathsResult`

Walk a schema and collect every scalar leaf with its dotted path and merged
meta. Backs the Uploadcare authoring lint (`schemas/uploadcare/`) — a third
meta-collecting walker alongside `applyPii` and `getServerSortableColumns`,
neither of which is reusable here (the latter is depth-capped at 1 and skips
arrays entirely).

**It fails CLOSED.** A walker that emits unrecognised nodes as leaves would
silently swallow their subtree — a field named `attachments` typed
`z.tuple([...])` would vanish from the walk and be invisible to every
assertion built on it. So the type allowlist is two-sided: descend the known
containers, emit the known scalars, and push everything else into
`unhandled`, which callers are expected to assert is empty.

Traversal:
- **transparent wrappers** (`optional`, `default`, `nullable`, `prefault`,
  `catch`, `readonly`, `nonoptional`) and **pipes** (`def.in` — the input side
  of `chicagoInstant()` et al) are walked through, merging meta at each level;
- **object** → each field, `path.key`;
- **array** → the element, `path[]`;
- **record** → the value type, `path.<key>` (dynamic keys aren't enumerable);
- **union / discriminatedUnion** → every member at the *same* path, deduped by
  (path, node identity) so shared nodes are visited once.

Meta does **not** cross a container boundary by default: an object's
schema-level `.meta({ title, collection })` must not leak onto its fields, and
by symmetry an annotation on an array node does not reach its element.
Annotate the leaf.

`opts.inherit` names the meta keys that DO cross, for annotations whose whole
point is to cover a subtree. `pii` is the motivating case: `Address` is tagged
`.nullable().meta({ pii: "mask" })` on the object, and the runtime walker
(`pii/walker.ts` `applyTagged`) pushes that tag down to every leaf, with a
child's own tag winning and `pii: "none"` opting back out — exactly the
`{...inherited, ...own}` merge this function already performs through
wrappers. Without it, the PII lint would report every leaf under a correctly
tagged `Address` as a violation (measured: 213 of them).

Default `[]` — no key crosses, so every existing caller is bit-identical.

`maxDepth` defaults to **24**. Wrappers are nodes, so depth counts them: the
deepest chain in core today measures 11, and an obvious-looking 12 would have
been one `.optional().nullable()` away from silently truncating. Hitting the
cap pushes a `__depth_cap__` entry into `unhandled` rather than returning
quietly.

### `createCardRules`

```ts
const createCardRules: CollectionRule[];
```

### `createCardTransaction`

```ts
const createCardTransaction: TransactionDefinition;
```

### `createCommentRules`

```ts
const createCommentRules: CollectionRule[];
```

### `createCommentTransaction`

```ts
const createCommentTransaction: TransactionDefinition;
```

### `createContactRules`

```ts
const createContactRules: CollectionRule[];
```

### `createContactTransaction`

```ts
const createContactTransaction: TransactionDefinition;
```

### `createInvoiceRules`

```ts
const createInvoiceRules: CollectionRule[];
```

### `createInvoiceTransaction`

```ts
const createInvoiceTransaction: TransactionDefinition;
```

### `createLocationRules`

```ts
const createLocationRules: CollectionRule[];
```

### `createLocationTransaction`

```ts
const createLocationTransaction: TransactionDefinition;
```

### `createOrderRules`

```ts
const createOrderRules: CollectionRule[];
```

### `createOrderTransaction`

```ts
const createOrderTransaction: TransactionDefinition;
```

### `createOrganizationRules`

```ts
const createOrganizationRules: CollectionRule[];
```

### `createOrganizationTransaction`

```ts
const createOrganizationTransaction: TransactionDefinition;
```

### `createProductRules`

```ts
const createProductRules: CollectionRule[];
```

### `createProductTransaction`

```ts
const createProductTransaction: TransactionDefinition;
```

### `createRecurrenceRules`

```ts
const createRecurrenceRules: CollectionRule[];
```

### `createRecurrenceTransaction`

```ts
const createRecurrenceTransaction: TransactionDefinition;
```

### `createRoleTransaction`

`create-role` is a new named transaction introduced with Threads Phase 1 —
role creation was a direct `ref.set(role)` before, promoted to a Firestore
transaction so the cowrite of the default thread happens atomically.

```ts
const createRoleTransaction: TransactionDefinition;
```

### `createTemplateRules`

```ts
const createTemplateRules: CollectionRule[];
```

### `createTemplateTransaction`

```ts
const createTemplateTransaction: TransactionDefinition;
```

### `createTransactionRules`

```ts
const createTransactionRules: CollectionRule[];
```

### `createTransactionTransaction`

```ts
const createTransactionTransaction: TransactionDefinition;
```

### `createUserRules`

```ts
const createUserRules: CollectionRule[];
```

### `createUserTransaction`

```ts
const createUserTransaction: TransactionDefinition;
```

### `deleteCardRules`

```ts
const deleteCardRules: CollectionRule[];
```

### `deleteCardScopeAllRules`

```ts
const deleteCardScopeAllRules: CollectionRule[];
```

### `deleteCardScopeAllTransaction`

```ts
const deleteCardScopeAllTransaction: TransactionDefinition;
```

### `deleteCardScopeFollowingRules`

```ts
const deleteCardScopeFollowingRules: CollectionRule[];
```

### `deleteCardScopeFollowingTransaction`

```ts
const deleteCardScopeFollowingTransaction: TransactionDefinition;
```

### `deleteCardScopeThisRules`

```ts
const deleteCardScopeThisRules: CollectionRule[];
```

### `deleteCardScopeThisTransaction`

```ts
const deleteCardScopeThisTransaction: TransactionDefinition;
```

### `deleteCardTransaction`

```ts
const deleteCardTransaction: TransactionDefinition;
```

### `deleteRecurrenceRules`

```ts
const deleteRecurrenceRules: CollectionRule[];
```

### `deleteRecurrenceTransaction`

```ts
const deleteRecurrenceTransaction: TransactionDefinition;
```

### `deleteTagRules`

```ts
const deleteTagRules: CollectionRule[];
```

### `deleteUserRules`

```ts
const deleteUserRules: CollectionRule[];
```

### `deleteUserTransaction`

```ts
const deleteUserTransaction: TransactionDefinition;
```

### `deriveCreditPostingAccount(reason: SettlementReasonType, coaRevenue: number | null): number | null`

Where a credit line posts, from the two facts that decide it.

**Bad debt is not a revenue reversal, and that is the whole rule.** The money
*was* owed — the sale stands — and the write-off moves it to Bad Debt so it
can be written off: `DR 6900 / CR A/R`. Everything else is a return or an
allowance, where the customer never owed the money and the revenue itself is
reversed: `DR <the line's own revenue account> / CR A/R`. `early_return` is
the clearest case of the second kind.

**New notes derive this; history does not obey it.** Of the 12 notes in the
live tenant, 8 agree and 4 are miscodings the owner has ruled historic rather
than sanctioned — CN-1007 books a bad-debt write-off to 4210 (revenue), and
CN-1010/1011/1012 book a customer credit to 6000 General Operating Expenses
on a free-text line whose `TaxType` is `INPUT`, a *purchase* tax type on a
receivable. CFS stores the corrected account and leaves Xero alone; the
divergence is recorded as a comment on the note's thread, and
`audit-credit-note-posting.ts` reports it. Xero still holds the original, so
nothing is lost by correcting.

That is also why `coa_posting` is STORED rather than derived on read: the
stored value is what CFS asserts, this function is what CFS intends, and an
audit comparing them against Xero is a real guard precisely because the three
come from different places. Deriving on read would make the check a
restatement of its own oracle.

`correction` is deliberately absent: it is bidirectional — an operator may be
adding a credit they missed or removing one that never happened — so its
posting depends on what is being corrected. Callers must supply it.

**Returns** — the account code, or `null` when the rule has no opinion.

### `deriveName(parts: PartialNameParts): string`

Canonical join rule for deriving a single display string from name parts.
Joins `[first_name, middle_name, last_name]` with single spaces (missing
parts are dropped, never produce empty padding) and appends ` (pronunciation)`
when set. This is the single source of truth — every `name` field on a
stored document and `ActorRef.name` is computed by passing through here.

### `deriveProductImageUuids(images: readonly typeLiteral[] | undefined): string[]`

Derive `query_by_images` from `images` — each row's `uuid` followed by its
`uuid_cutout` when set, walking `images` in order.

The single source of the denormalization, called by every writer. Defined here
rather than in `utils/products.ts` because the schema needs it and the import
direction is strictly utils → schemas; `@cfs/core/utils/products` re-exports
it, which is where writers should import from (same shape as `deriveName`).

**Ordered, but not an ordering source.** The emitted array follows `images`
row order — it costs nothing (one pass either way) and a mirror that tracks
the display array is easier to eyeball in the console than an arbitrary one.
But `images` remains the sole authority on display order: this field exists
for Firestore `array-contains`, and the refinement below compares it as a
multiset, so a differently-ordered mirror holding the same uuids is still
valid. Nothing may read order back out of it.

### `enumValues(schema: z.ZodType<T>): T[]`

Return the values of a `ZodEnum` in declaration order. Throws when passed a
non-enum schema — callers should pass the enum directly (e.g.
`enumValues(CardStatusEnum)`), not a wrapped schema.

### `firestoreDisplayDefaults`

Display defaults for every Firestore collection, derived from schema meta.

```ts
const firestoreDisplayDefaults: Record<string, FirestoreDisplayDefaults>;
```

### `getDisplayTransactionTypes(increaseOnly?: boolean): MovementTypeType[]`

Movement types suitable for the manual transaction form.

**Derived from {@link MANUAL_MOVEMENT_TYPES}, which is what
`CreateTransactionInput` validates against — so the picker cannot offer a type
the API rejects.** It used to re-derive the set independently from
`MOVEMENT_CONTRACTS`, and the two disagreed: `sale_return` has no *required*
booking, so it passed that filter and reached the manager's type picker, while
the input schema refused it. An operator picking it got a 400. (core#41)

The one remaining asymmetry is deliberate and runs the safe way:
`opening_balance` is *accepted* by the input but hidden here, because it is
minted at product creation rather than keyed. Hiding an accepted type costs
nothing; offering a rejected one is a dead end in the UI.

When `increaseOnly` is true, returns only types that add stock — for the first
transaction on a product.

### `getFirestoreColumns(collection: string): DisplayTableColumn[]`

Columns a Firestore document surface offers for `collection` — every field
the schema annotates `column: true`. `[]` for an unregistered collection.

### `getInitialValues(schema: S): Partial<z.output<S>>`

Walk a Zod schema and produce an initial/blank object for form binding.

Derives values from schema structure: `""` for strings, `0` for numbers,
`false` for booleans, `[]` for arrays, `{}` for records, `null` for
nullables, first value for enums, and recursion for objects.
Fields with `.default()` use the default value.
Custom types (e.g. FirestoreTimestamp) are omitted.

A field annotated `.meta({ initial: <value> })` uses that value instead, at
any level — it is checked before the type switch, and because wrapper nodes
recurse, an annotation on the leaf is found through `.optional()` and
`.transform()` pipes too. Use it when the form seed and the parse-time
default must differ (see the note in `resolveField`).

## The return is `Partial`, and that is not conservatism — it is the truth

The result is missing required fields, so `z.output<S>` would be a lie.
Three separate holes put it there, and each is visible above:

- **`custom` nodes are omitted entirely** (`SKIP`). `FirestoreTimestamp` is
  `z.custom`, and `TimestampFields` puts `created_at`/`updated_at` on
  essentially every document schema — so *every* document's initial value is
  missing at least two required fields. `tests/initial.test.ts` asserts
  `"created_at" in result === false`, so this is pinned, not incidental.
- **A `union` collapses to its first resolvable arm**, so reading a property
  that only exists on another arm is a type error the `Partial` correctly
  reports rather than hides.
- **The partial is shallow.** Nested objects are partial in fact but typed
  complete, because the walk recurses while the type does not.

`pipe` resolving the *input* side is a fourth, currently latent: both live
transforms are `z.ZodType<string, string>`, so In ≡ Out today.

### `getNodeMeta(node: z.ZodType): Record<string, unknown> | null`

Read the metadata registered on a node via `.meta(...)`. Returns `null` when
no meta has been registered. Does not unwrap — pass the already-unwrapped
node when reading field-level meta.

### `getOrderStatusTransitions(current: OrderStatusType): OrderUserStatusType[]`

The statuses an operator can move to from the given current status.
Returns an empty list for computed statuses (`active`, `complete`) and
filters the current status out of the user-settable set.

### `getServerSortableColumns(schema: z.ZodType): Record<string, string>`

Walk a document schema and collect all fields annotated with
`.meta({ serverSortVia: "<firestore_field>" })`. Used by list views to
discover which columns can drive a server-side `orderBy` clause and which
Firestore field the sort maps to (often an `_fs` timestamp sibling).

Descends one level into nested objects (matching the column walker depth).
Arrays are not traversed.

### `getSettlementMultiplier(type: SettlementTypeType): 1 | -1`

`+1` for a settlement that increases the total it feeds, `-1` for one that
reduces it.

**Derived from the contract, never declared**, exactly as
`getTransactionMultiplier` derives from `places` rather than carrying a ±1
column: a type that must name what it reverses IS a retraction, and one that
must not IS an application. Two facts that could disagree become one that
cannot.

**The sign keys on `type`, not on `reason`.** The package answers this the
same way three times over — `getTransactionMultiplier(type)`, and
`out_of_service_breakdown[o.reason]` where reason is a *breakdown dimension*
rather than a direction. It is also forced here: `correction` is genuinely
bidirectional (an operator may be adding a payment they missed or removing one
that never happened), so a reason-keyed sign would have to split it into
`correction_added`/`correction_removed`, and every other bidirectional reason
after it. Type carries direction, reason carries why, and the contract's
`reasons` list keeps the pairs legal.

### `getTransactionMultiplier(type: MovementTypeType): 1 | -1 | 0`

Returns +1 for movements that increase owned quantity, -1 for those that
decrease it, and 0 for those that leave it untouched (a `transfer`, a
custody-only fulfillment step, a cost-only adjustment).

**Total** — it cannot throw. The financial-only types that used to make it
partial are gone; see {@link MOVEMENT_TYPES}. Derived from the contract so it
cannot drift from it.

### `getTypesenseColumns(alias: string): DisplayTableColumn[]`

Columns a Typesense surface offers for `alias` — the annotated set
intersected with the fields that collection actually indexes, plus its
computed rollups. `[]` for an unknown alias.

### `getTypesenseDisplayDefaults(alias: string): TypesenseDisplayDefaults | undefined`

Get the display defaults for a Typesense collection by alias.

### `hasCosts(type: MovementTypeType): boolean`

Whether a movement type carries a cost object. Derived from the contract.

### `isDateField(schema: z.ZodType, fieldPath: string): boolean`

True when the schema's leaf at `fieldPath` is an ISO datetime, ISO date, or
the `FirestoreTimestamp` custom type. Unwraps Optional/Default/Nullable and
sees through `.transform()` pipes, so neither modifiers nor Chicago
datetime factories (`chicagoInstant`, `chicagoStartOfDay`) mask the
underlying type.

### `isDateLikeNode(node: z.ZodType): boolean`

True when `node` is an ISO datetime, ISO date, or `FirestoreTimestamp` —
including when those types are wrapped in a `.transform()` pipe (e.g.
`chicagoInstant()`, `chicagoStartOfDay()`). Takes an already-unwrapped node
(see {@link unwrapZod} / {@link unwrapNonArray}); callers that have only a
schema + path should use {@link isDateField} instead.

### `isDividerItemType(type: string): type is DividerItemType`

Whether an item type is a structural divider — the complement of {@link isLineItemType}.

### `isFulfillableItem(item: OrderDocItemType): item is OrderDocLineItemType`

Narrows an order doc item to one that can be PICKED — the `fulfillable` axis,
which additionally excludes `transaction_fee`.

Lives beside {@link isLineItem} because the two are constantly confused: a fee
is a line (it is billed) and is not fulfillable (there is nothing on a shelf).
`isFulfillableItemType` alone cannot do this job — a type predicate on
`item.type` narrows the property, not the union — which is why both
`services/fulfillment.ts` and `services/fulfillmentEdits.ts` had grown their
own item-level copy.

The narrowing is deliberately imprecise in the same way `isLineItem` is: it
reports `OrderDocLineItemType`, whose `type` still nominally includes
`transaction_fee`. Every field a caller reads after this guard is shared
across all line types, so the imprecision costs nothing.

### `isFulfillableItemType(type: string): type is FulfillableItemType`

Whether an item type can be picked off a shelf — the `fulfillable` axis.

NOT a synonym for {@link isLineItemType}: `transaction_fee` is a line and is
not fulfillable. Two predicates seven lines apart in `services/fulfillment.ts`
drew exactly that distinction by hand and read as if they disagreed.

### `isIntegerSafeLeaf(node: z.ZodType): boolean`

Can this leaf hold a non-integer?

The question a Typesense `int32`/`int64` declaration asks of the schema
behind it. One fractional value at such a field does not fail its own
document — it aborts the import for the **entire collection**, and the
previous index keeps serving queries, so nothing looks wrong until someone
checks the alias (api-cloudrun#451, #460).

## Three shapes count as safe, and reading only one of them is a live trap

1. **`z.int()`** — `def.format === "safeint"`, no checks.
2. **`z.number().int()`** — no `def.format` at all; the format lives in a
   `checks[]` entry as `{ check: "number_format", format: "safeint" }`.
   ⚠️ Reading `def.format` alone reports every field spelled this way as
   unsafe, and `src/schemas/` uses both spellings today. A predicate that
   lands red on correct fields gets an allowlist, and the allowlist is what
   the guard was supposed to replace.
3. **A numeric literal** — `z.literal(4000)`, and by extension a union of
   them (`COARevenueEnum`), which `collectLeafPaths` emits as one leaf per
   member. Every value is fixed, so integrality is decided by inspection.
   Retyping those to `z.int()` would DELETE the enum to satisfy a check,
   which is the wrong direction — 4 of the 126 int declarations in the
   configs are backed this way.

`z.number().multipleOf(1)` is deliberately **not** safe. It is integral in
effect and not declared so: `multipleOf` is a numeric refinement whose
argument nothing constrains, and accepting it means this predicate now has an
opinion about arithmetic rather than about a declaration. Nothing in
`src/schemas/` spells it that way.

Callers pass an already-unwrapped leaf — {@link collectLeafPaths}'s
`leaf.node`, which has been walked through every transparent wrapper and pipe.
A `.optional()` or `.nullable()` around an int does not make it fractional,
and this function does no unwrapping of its own precisely so a caller cannot
accidentally ask it about a wrapper.

**It says nothing about timestamps.** `FirestoreTimestamp` is a `z.custom`,
so it answers `false` here — correctly, because it is not a number. The 73
declarations backed by one are exempted structurally by their callers, on the
`firestoreTimestamp` meta marker rather than on a name.

### `isInvoiceLineItem(item: InvoiceDocItemType): item is InvoiceDocLineItem`

Type guard that narrows an invoice doc item to a billable line item (excludes
structural dividers).

The narrowing target is invoice-specific, but the DECISION is not: it is
`ITEM_CONTRACTS[type].kind`, shared with `isLineItem` in `order.ts`. Written
out by hand this read `!== "destination" && !== "group" && !== "order"` — one
clause longer than the order guard, which is exactly the kind of difference
that looks like a bug and is not.

### `isLineItem(item: OrderDocItemType): item is OrderDocLineItemType`

Type guard that narrows an order doc item to a line item (excludes
destination/group dividers). Sound: every non-divider `type` is now backed by
exactly one shape, so the narrowing cannot hand a caller a `price` of the
wrong kind.

### `isLineItemType(type: string): type is DocLineItemTypeType`

Whether an item type is a billable line rather than a structural divider.

The ONE answer to a question that was previously answered by hand in five
modules as `type !== "destination" && type !== "group"` — sometimes with
`&& type !== "order"` (correct for invoices, where an `order` divider exists)
and sometimes with `&& type !== "transaction_fee"`, which is a **different
question**: see {@link isFulfillableItemType}.

Takes a `string` because callers hold item types from loosely-typed sources.
A value outside {@link ITEM_TYPES} has no contract and answers `false`.

### `isValidOrderStatusTransition(prev: OrderStatusType, next: OrderStatusType, source: "manual" | "propagation"): boolean`

Server-side gate for an order status write. `source: "manual"` rejects
writes that move into a computed status or out of a computed status into
anything other than the same value (no-op). `source: "propagation"`
trusts the booking write path that sets `active` or `complete`.

### `itemContract(type: string): ItemContract | undefined`

The contract for an item `type`, or `undefined` for a value outside
{@link ITEM_TYPES}. Takes a `string` because the loose `LineItem` shadow in
`@cfs/core/utils/orders` types `type` as `string`; an unrecognized type has no
contract and every derived predicate answers `false` for it.

### `manageDraftRules`

```ts
const manageDraftRules: CollectionRule[];
```

### `manageDraftTransaction`

```ts
const manageDraftTransaction: TransactionDefinition;
```

### `materializeHorizonRules`

```ts
const materializeHorizonRules: CollectionRule[];
```

### `materializeHorizonTransaction`

```ts
const materializeHorizonTransaction: TransactionDefinition;
```

### `publishTemplateRules`

```ts
const publishTemplateRules: CollectionRule[];
```

### `publishTemplateTransaction`

```ts
const publishTemplateTransaction: TransactionDefinition;
```

### `recurrenceRules`

All recurrence-related propagation rules.

```ts
const recurrenceRules: CollectionRule[];
```

### `resolveFieldMeta(schema: z.ZodType, fieldPath: string): Record<string, unknown> | null`

Convenience: resolve a dotted path and read its meta in one call. Returns
`null` when the path is unresolvable or the leaf has no meta.

### `resolveZodField(schema: z.ZodType, fieldPath: string, opts?: typeLiteral): z.ZodType | null`

Resolve a dotted field path (e.g. `"dates.end"`, `"reactions.❤️.u1.name"`) to
the leaf schema. Each segment descends through an object shape or a record's
value type after unwrapping. Returns `null` when any segment is missing or
when the traversal hits a non-object/non-record node before exhausting the
path (e.g. an array-index segment — not modelled).

`opts.unwrap` (default `true`) controls the LEAF only: when `true` the leaf's
Optional/Default/Nullable/etc. wrappers are stripped (callers reading the
inner type / `.meta()`); when `false` the leaf is returned AS DECLARED — use
this to validate a write VALUE against the field, so a `null` write to a
`.nullable()` field (or `undefined` to an `.optional()` one) is accepted.
Intermediate segments are always unwrapped (needed to descend).

### `rules`

All propagation rules across all transactions and cascades.

```ts
const rules: CollectionRule[];
```

### `schemas`

All document schemas keyed by singular and plural collection names.

```ts
const schemas: Record<string, z.ZodType>;
```

### `settlementContract(type: string): SettlementContract | undefined`

The contract for a settlement `type`, or `undefined` for a value outside
{@link SETTLEMENT_TYPES}. Tolerant of a `string` for the same reason
{@link itemContract} is — callers hold types from loosely-typed sources.

### `templateHelpers`

Helper catalogue keyed by utils namespace — `templateHelpers["orders"]` is what
a template calls as `it.orders.*`.

Generated for every `./utils/*` entrypoint; which of them a given template can
actually call is resolved from its collections by `availableUtilNamespaces()`
in `./template-context.ts`.

```ts
const templateHelpers: Record<string, TemplateHelperEntry[]>;
```

### `templateRules`

All template-related propagation rules.

```ts
const templateRules: CollectionRule[];
```

### `templateSchemaFields`

Pre-compiled document field metadata for every template source and target
collection. Source collections are always present; a target is present only if
it has a walkable schema — `packing_lists` has none, hence `Partial`.

```ts
const templateSchemaFields: Partial<Record<TemplateSourceCollectionType | TemplateTargetCollectionType, SchemaField[]>>;
```

### `threadContactRules`

```ts
const threadContactRules: CollectionRule[];
```

### `threadCowriteRules`

All create-<X> cowrite rules across every entity that gets a default thread.

```ts
const threadCowriteRules: CollectionRule[];
```

### `threadInvoiceRules`

```ts
const threadInvoiceRules: CollectionRule[];
```

### `threadOrderRules`

```ts
const threadOrderRules: CollectionRule[];
```

### `threadOrganizationRules`

```ts
const threadOrganizationRules: CollectionRule[];
```

### `threadProductRules`

```ts
const threadProductRules: CollectionRule[];
```

### `threadRoleRules`

```ts
const threadRoleRules: CollectionRule[];
```

### `transactions`

```ts
const transactions: TransactionDefinition[];
```

### `typesenseDisplayDefaults`

Display defaults for every Typesense collection, derived from collection config.

```ts
const typesenseDisplayDefaults: Record<string, TypesenseDisplayDefaults>;
```

### `unwrapNonArray(node: z.ZodType): z.ZodType`

Like {@link unwrapZod} but stops at `ZodArray`. In Zod 4, `ZodArray.unwrap()`
returns the element type; callers that need to detect "is this an array?"
use this variant so the array node is preserved.

### `unwrapZod(node: z.ZodType): z.ZodType`

Unwrap wrapper nodes (Optional, Default, Nullable, Prefault, Catch) to reach
the inner schema where `.meta()` was called. Does not descend into arrays,
records, or objects.

### `updateCardScopeAllRules`

```ts
const updateCardScopeAllRules: CollectionRule[];
```

### `updateCardScopeAllTransaction`

```ts
const updateCardScopeAllTransaction: TransactionDefinition;
```

### `updateCardScopeFollowingRules`

```ts
const updateCardScopeFollowingRules: CollectionRule[];
```

### `updateCardScopeFollowingTransaction`

```ts
const updateCardScopeFollowingTransaction: TransactionDefinition;
```

### `updateContactRules`

```ts
const updateContactRules: CollectionRule[];
```

### `updateContactTransaction`

```ts
const updateContactTransaction: TransactionDefinition;
```

### `updateInvoiceOrderRules`

```ts
const updateInvoiceOrderRules: CollectionRule[];
```

### `updateLocationRules`

```ts
const updateLocationRules: CollectionRule[];
```

### `updateLocationTransaction`

```ts
const updateLocationTransaction: TransactionDefinition;
```

### `updateLocationTransactionalRules`

```ts
const updateLocationTransactionalRules: CollectionRule[];
```

### `updateLocationTypeRules`

```ts
const updateLocationTypeRules: CollectionRule[];
```

### `updateOrderInvoiceRules`

```ts
const updateOrderInvoiceRules: CollectionRule[];
```

### `updateOrderRules`

```ts
const updateOrderRules: CollectionRule[];
```

### `updateOrderTransaction`

```ts
const updateOrderTransaction: TransactionDefinition;
```

### `updateOrganizationRules`

```ts
const updateOrganizationRules: CollectionRule[];
```

### `updateOrganizationTransaction`

```ts
const updateOrganizationTransaction: TransactionDefinition;
```

### `updateProductRules`

```ts
const updateProductRules: CollectionRule[];
```

### `updateProductTransaction`

```ts
const updateProductTransaction: TransactionDefinition;
```

### `updateRecurrenceRules`

```ts
const updateRecurrenceRules: CollectionRule[];
```

### `updateRecurrenceTransaction`

```ts
const updateRecurrenceTransaction: TransactionDefinition;
```

### `updateTagRules`

```ts
const updateTagRules: CollectionRule[];
```

### `updateTrackingCategoryRules`

```ts
const updateTrackingCategoryRules: CollectionRule[];
```

### `updateUserRules`

```ts
const updateUserRules: CollectionRule[];
```

### `updateUserTransaction`

```ts
const updateUserTransaction: TransactionDefinition;
```

## `@cfs/core/schemas/common`

### `ActorRef`

Zod schema for an actor reference.

```ts
const ActorRef: z.ZodType<ActorRefType>;
```

### `ActorRefType`

Actor reference — embedded `{uid, name}` for `created_by` / `updated_by` /
`deleted_by` fields across document schemas. The `name` is denormalized at
write time by the server via `deriveName(parts)` (with `uid` as a fallback
when all parts are empty — see `buildActorRef` in api-cloudrun). Non-human
actors (e.g. integrations, scheduled jobs) use a synthetic uid such as
`"manager-bot"` with a matching display name. Name changes on the source
user fan out via the `update-user:name-to-actor-refs` propagation rule.

```ts
interface ActorRefType {
  uid: string;
  name: string;
}
```

### `Address`

Zod schema for Address, nullable.

The object carries the `pii: "mask"` tag and every leaf inherits it, so a
new field added here is masked by default — the safe direction. The three
coarse-geography leaves opt OUT explicitly: a city / state / country cannot
identify anyone on their own, they are what makes a sanitized fixture still
look like a plausible address, and faking them produces nonsense (the mask
transform reads `"United States"` as a person's name and `"IL"` as a city).
The identifying parts — `street`, `street2`, `full`, `name`, `postcode`, and
the two `Coordinates` — stay masked.

```ts
const Address: z.ZodType<AddressType | null>;
```

### `AddressType`

Address object — shared between organizations and order destinations.

```ts
interface AddressType {
  city: string;
  country_name: string;
  full: string;
  name: string;
  postcode: string;
  region: string;
  street: string;
  street2?: string;
  mapbox_id?: string;
  address_coordinates?: CoordinatesType | null;
  user_coordinates?: CoordinatesType | null;
}
```

### `AnyUid`

Any known CFS document-id shape — atomic Firestore id, divider/custom item
id, a composite (booking / event-card), or a lowercase-kebab slug (slug-keyed
collections such as `roles` and seeded `lists`). Use for polymorphic
references (`DocSource`, `UidNameRef`) that may point at any collection.
`ItemUid` already covers `FirestoreId | uuid | custom-`.

```ts
const AnyUid: z.ZodType<string>;
```

### `BookingId`

`bookings.uid` — deterministic composite
`{uid_order}:{item uid}:{uid_destination}` (the middle segment is the order
item's uid, which for a custom product is `custom-{uuid}`).

```ts
const BookingId: z.ZodType<string>;
```

### `CFS_SOURCE_COLLECTIONS`

Collections that may legitimately appear as a {@link DocSourceType} `collection`.

This was `z.string().min(1)` — free text that reached a Firestore collection
name. `CreateCardInput.sources` comes straight off the POST body and
`createCard` copies it into the THREAD's `sources`, so
`POST /cards {sources:[{collection:"cards", uid:X}]}` wrote a thread claiming
a card as its own source, which `deleteCard` then unpicks by
`s.collection === "cards"`. Every consumer was re-deriving the same implicit
"it's one of the known CFS collections" contract; it is encoded once here.

Membership is the union of a read-only survey of every stored `DocSource` in
BOTH envs (threads, comments, cards, recurrences.prototype, out-of-service
`sources[]` + `transactions[].source` — dev and prod agreed on the same 12
values, no malformed entries) plus `template-components`, which has no stored
instance yet but is declared legitimate by `TEMPLATE_SOURCES` in `comment.ts`.

`transactions` is now a live-written source: the movement journal links a
reversal to the event it negates, and a component event to its parent, both
through `sources[]`. (It was historical-only when this list was surveyed —
898 instances, identical count in both envs.) Never narrow this past stored
data; survey first.

`locations` carries no `sources[]` of its own — it is here because a movement
line's `location.from` / `location.to` is a `DocSource` pointing at wherever
the units physically are: a `locations` doc (on a shelf), a `bookings` doc
(out on a job), or an `out-of-service` record. Widening is safe; the
`DocSource` shape is unchanged.

```ts
const CFS_SOURCE_COLLECTIONS: "bookings" | "cards" | "contacts" | "credit-notes" | "invoices" | "locations" | "orders" | "organizations" | "out-of-service" | "products" | "roles" | "settlements" | "template-components" | "templates" | "templates-versions" | "transactions"[];
```

### `COARevenueEnum`

Zod schema for COARevenueType.

```ts
const COARevenueEnum: z.ZodType<COARevenueType>;
```

### `COARevenueType`

Allowed values for chart-of-accounts revenue code.

```ts
type COARevenueType = indexedAccess;
```

### `CardId`

`cards.uid` — either a Firestore auto-id (kanban/to-do cards) or an
`EventCardId` composite (auto-generated order event cards).

```ts
const CardId: z.ZodType<string>;
```

### `CfsSourceCollectionEnum`

Zod schema for CfsSourceCollectionType.

```ts
const CfsSourceCollectionEnum: z.ZodType<CfsSourceCollectionType>;
```

### `CfsSourceCollectionType`

A collection name valid in a {@link DocSourceType}.

```ts
type CfsSourceCollectionType = indexedAccess;
```

### `ComponentTypeEnum`

Zod schema for ComponentTypeType.

```ts
const ComponentTypeEnum: z.ZodType<ComponentTypeType>;
```

### `ComponentTypeType`

Allowed values for component type.

```ts
type ComponentTypeType = indexedAccess;
```

### `Coordinates`

Zod schema for coordinates (latitude/longitude), nullable.

```ts
const Coordinates: z.ZodType<CoordinatesType | null>;
```

### `CoordinatesType`

Coordinates object (latitude/longitude).

```ts
interface CoordinatesType {
  latitude: number;
  longitude: number;
}
```

### `DOC_LINE_ITEM_TYPES`

Billable line item types stored in order/invoice documents (excludes destination/group dividers).

```ts
const DOC_LINE_ITEM_TYPES: "rental" | "replacement" | "sale" | "service" | "surcharge" | "transaction_fee"[];
```

### `DividerItemType`

The `kind: "divider"` members — the structural types that organize an array.

```ts
type DividerItemType = indexedAccess;
```

### `DocItemTypeEnum`

Zod schema for DocItemTypeType.

```ts
const DocItemTypeEnum: z.ZodType<DocItemTypeType>;
```

### `DocItemTypeType`

All item types accepted in order/invoice input schemas (includes structural dividers).

```ts
type DocItemTypeType = indexedAccess;
```

### `DocLineItemTypeEnum`

Zod schema for DocLineItemTypeType.

```ts
const DocLineItemTypeEnum: z.ZodType<DocLineItemTypeType>;
```

### `DocLineItemTypeType`

Billable line item types stored in order/invoice documents (excludes destination/group dividers).

```ts
type DocLineItemTypeType = indexedAccess;
```

### `DocSource`

Zod schema for a polymorphic doc reference.

```ts
const DocSource: z.ZodType<DocSourceType>;
```

### `DocSourceType`

A `{collection, uid}` pointer to any Firestore document. Used polymorphically
by Thread, Comment, and Card to reference the source docs they belong to.

Lives here (not in thread.ts where it originated) because it's a shared
primitive — the "thread" prefix misled readers into thinking it was
thread-specific.

```ts
interface DocSourceType {
  collection: CfsSourceCollectionType;
  uid: string;
  label?: string | null;
}
```

### `Email`

Email string with format and length constraints.

```ts
const Email: z.ZodType<string>;
```

### `EventCardId`

`cards` event-card composite id — `{uid_order}:{uid_destination}:start|end`
(one per order delivery/collection endpoint). See `api-cloudrun
src/lib/eventCards.ts` (`EventPosition = "start" | "end"`).

```ts
const EventCardId: z.ZodType<string>;
```

### `FIRESTORE_TIMESTAMP_META`

Meta key marking a node as the {@link FirestoreTimestamp} custom type.

`isDateLikeNode` used to recognise it by **instance identity** — the only
handle a `z.custom()` offers, since its `def.type` is the uninformative
`"custom"`. That was safe exactly as long as nobody annotated a timestamp
field, because **`.meta()` clones**: `FirestoreTimestamp.meta({ label })` is a
different instance, the identity test fails, and a `created_at` column
silently stops rendering as a date and starts printing a raw epoch. Declaring
display columns means annotating `created_at` / `updated_at` / `last_order`,
so the identity test had to go.

A meta marker survives the clone because `.meta()` **merges**: the clone
carries both this key and whatever the annotation added.

```ts
const FIRESTORE_TIMESTAMP_META: "firestoreTimestamp";
```

### `FULFILLMENT_LINE_ITEM_TYPES`

Line item types a fulfillment carries — the `fulfillable: true` members.
`transaction_fee` is excluded because a fee has no stock and is never picked
off a shelf, so this is NOT a narrower spelling of {@link DOC_LINE_ITEM_TYPES}
waiting to be collapsed into it; the exclusion IS the contract.

Lives here rather than in `fulfillment.ts` so the list, the table it must
agree with, and the assertion below are one thing to read.

```ts
const FULFILLMENT_LINE_ITEM_TYPES: "rental" | "replacement" | "sale" | "service" | "surcharge"[];
```

### `FirestoreFieldValue`

Structural interface for Firestore FieldValue (write-time sentinel).

```ts
interface FirestoreFieldValue {
  isEqual(other: FirestoreFieldValue): boolean;
}
```

### `FirestoreId`

Atomic Firestore auto-generated document id (`[A-Za-z0-9]{20}`).

```ts
const FirestoreId: z.ZodType<string>;
```

### `FirestoreTimestamp`

Firestore Timestamp — structural check for `{ seconds, nanoseconds }`.

Tight on purpose: rejects `undefined`, `null`, plain objects, and
`FieldValue` write-time sentinels (which only carry `isEqual`). Writers
must stamp a real `Timestamp` (e.g. `Timestamp.now()` from
`firebase-admin/firestore`) — `validateBeforeWrite` strips `FieldValue`
sentinels before validation, so a sentinel-stamped timestamp would
surface here as `undefined` and fail loudly.

The accepted union still includes `FirestoreFieldValue` for back-compat
with consumers that type fields against the union (e.g. user-facing
`cloneDeep` mutate-then-stamp patterns), but the runtime gate enforces
the real-Timestamp contract.

Carries {@link FIRESTORE_TIMESTAMP_META} so it stays recognisable **through a
`.meta()` clone** — see that constant.

```ts
const FirestoreTimestamp: z.ZodType<FirestoreTimestampType>;
```

### `FirestoreTimestampType`

Union of Firestore Timestamp (read) and FieldValue (write).

```ts
type FirestoreTimestampType = FirestoreTimestampValue | FirestoreFieldValue;
```

### `FirestoreTimestampValue`

Structural interfaces for Firestore Timestamp and FieldValue.
Expressed structurally so the schemas package has no firebase-admin dependency.

```ts
interface FirestoreTimestampValue {
  seconds: number;
  nanoseconds: number;
  toMillis(): number;
  toDate(): Date;
}
```

### `FromTotalItemType`

The `pricing: "from_total"` members — priced FROM the document total rather
than into it, which is what makes a `percent_of_total` formula legal on them.

```ts
type FromTotalItemType = indexedAccess;
```

### `FulfillableItemType`

```ts
type FulfillableItemType = indexedAccess;
```

### `ITEM_CONTRACTS`

The per-type item contract table. @see {@link ItemContract}

```ts
const ITEM_CONTRACTS: Readonly<Record<ItemTypeType, ItemContract>>;
```

### `InclusionTypeEnum`

Zod schema for InclusionTypeType.

```ts
const InclusionTypeEnum: z.ZodType<InclusionTypeType>;
```

### `InclusionTypeType`

Allowed values for component inclusion type.

```ts
type InclusionTypeType = indexedAccess;
```

### `InvoiceStatusEnum`

Zod schema for InvoiceStatusType.

```ts
const InvoiceStatusEnum: z.ZodType<InvoiceStatusType>;
```

### `InvoiceStatusType`

Possible invoice statuses.

```ts
type InvoiceStatusType = indexedAccess;
```

### `ItemContract`

The per-type rules an `items[]` entry must satisfy, one entry per
{@link ITEM_TYPES} member. Modelled on `MOVEMENT_CONTRACTS` in
`transaction.ts`: a table the schema reads, so a contradiction is reported by
the schema instead of restated in every consumer.

**The table carries only the axes that vary by TYPE.** The axes that vary by
COLLECTION are already the three documents' shapes and are not repeated here —
an invoice line has no `stock_method` key and its price has no `replacement`
key, a fulfillment line has no `price` at all, and every one of those objects
is a `z.strictObject`. Restating "forbidden" for them would be a second source
of truth for something the shape already makes inexpressible.

Measured against prod `cfs-3100` (951 orders / 958 invoices / 952
fulfillments, 2026-07-29) before each axis was written — three axes an earlier
draft proposed are absent because the corpus refutes them:

- **no `taxable` axis.** Every line type carries taxes on some rows and not
  others (surcharges: 149 of 151 order rows ARE taxed). Whether a line is
  taxed is the product's `tax_class` and the document's `tax_profile`, i.e.
  configuration, not a type invariant.
- **no per-type `formula` whitelist.** Order `sale`/`service`/`surcharge` rows
  are `fixed` while their invoice projections are `five_day_week` (617 sale,
  643 service, 137 surcharge). A whitelist keyed on type would reject the
  invoice side of the same line.
- **`replacement` is `optional`, not `forbidden`, off the rental arm.** All
  1,480 non-rental order line items carry a `price.replacement`; the builder
  writes it for every type.

```ts
interface ItemContract {
  kind: "divider" | "line";
  pricing: "pre_tax" | "from_total" | "none";
  replacement: "required_when_stocked" | "optional" | "forbidden";
  fulfillable: boolean;
  parentable_by: readonly ItemTypeType[];
}
```

### `ItemTypeEnum`

Zod schema for {@link ItemTypeType}.

```ts
const ItemTypeEnum: z.ZodType<ItemTypeType>;
```

### `ItemTypeType`

Union of every order/invoice/fulfillment item type.

```ts
type ItemTypeType = indexedAccess;
```

### `ItemUid`

Polymorphic `items[].uid` + `path[]` segment in order/invoice/fulfillment
documents: a product's Firestore id, a divider UUID, or a custom-product id.

```ts
const ItemUid: z.ZodType<string>;
```

### `ListId`

`lists.uid` (and `uid_list` references) — a Firestore auto-id (user-created
lists) or a lowercase-kebab slug (seeded/system lists, e.g. `in-store`,
`field-service`).

```ts
const ListId: z.ZodType<string>;
```

### `NameField`

Zod field for the denormalized `name` on stored documents (Contact, User,
Invite, embedded contact refs in destinations, ActorRef-shaped objects).

The 255 max is the exact upper bound of `deriveName(parts)` given the
existing per-part maxes:
  50 (first) + 1 (sp) + 50 (middle) + 1 (sp) + 50 (last) + 1 (sp)
  + 1 ("(") + 100 (pronunciation) + 1 (")") = 255
If any part's `.max(...)` changes, this ceiling must move with it or
worst-case writes will fail validation.

```ts
const NameField: z.ZodType<string>;
```

### `NameParts`

Split name fields shared across Contact, User, Invite, and any schema
embedding a contact reference. `first_name` is required; the rest are optional.

Stored documents also carry a denormalized `name: string` (use `NameField`
+ `deriveName()` below). Inputs do not — clients send parts; the server
derives `name` at write time. See `deriveName` for the canonical join rule.

```ts
interface NameParts {
  first_name: string;
  middle_name?: string;
  last_name?: string;
  pronunciation?: string;
}
```

### `NamePartsFields`

Fields object — spread into a parent `z.strictObject()` (documents) or
`z.object()` (inputs) to attach the standard split-name fields.

```ts
const NamePartsFields: typeLiteral;
```

### `NamePartsFieldsPartial`

Variant of `NamePartsFields` where every field is optional — use for partial
update input schemas (PUT endpoints) where callers may omit `first_name`.

```ts
const NamePartsFieldsPartial: typeLiteral;
```

### `OOSReasonEnum`

Zod schema for OOSReasonType.

```ts
const OOSReasonEnum: z.ZodType<OOSReasonType>;
```

### `OOSReasonType`

Allowed values for out-of-service reason.

```ts
type OOSReasonType = indexedAccess;
```

### `PartialNameParts`

All-optional variant of `NameParts` — use for partial update input types
(PUT endpoints) where callers may omit `first_name`.

```ts
interface PartialNameParts {
  first_name?: string;
  middle_name?: string;
  last_name?: string;
  pronunciation?: string;
}
```

### `Phone`

Phone string with length constraints.

Carries `cell: "phone"` because a phone number is the one display type Zod
cannot discriminate — it is a `z.string()` with a regex, structurally
identical to a subject line. Declared once, here, rather than recovered per
column by testing whether the path `includes("phone")`. (An email needs no
such marker: `z.email()` has its own `format`.)

```ts
const Phone: z.ZodType<string>;
```

### `PreTaxItemType`

The `pricing: "pre_tax"` members — every type that counts INTO the document
subtotal.

Derived from {@link ITEM_CONTRACTS} rather than listed. A hand-written copy of
this union is exactly the drift the parity assertions above exist to prevent,
and `@cfs/core/utils/orders` carried one — `PreTaxLineItem["type"]` was the
literal list `"rental" | "sale" | "service" | "surcharge" | "replacement"`,
a sixth place to remember when a type is added.

```ts
type PreTaxItemType = indexedAccess;
```

### `PriceFormulaEnum`

Zod schema for PriceFormulaType.

```ts
const PriceFormulaEnum: z.ZodType<PriceFormulaType>;
```

### `PriceFormulaType`

Allowed values for pricing formula.

```ts
type PriceFormulaType = indexedAccess;
```

### `ProductTypeEnum`

Zod schema for ProductTypeType.

```ts
const ProductTypeEnum: z.ZodType<ProductTypeType>;
```

### `ProductTypeType`

Allowed values for product type.

```ts
type ProductTypeType = indexedAccess;
```

### `QuoteId`

`quotes.uid` — deterministic composite `{uid_order}:v{N}` (saved versions) or
`{uid_order}:draft` (the working draft). Built in api-cloudrun
`src/services/quotes.ts` (`${uidOrder}:v${version}` / `${uidOrder}:draft`).

```ts
const QuoteId: z.ZodType<string>;
```

### `RATE_UNIT_META`

The display annotation a **discriminated** rate column carries.

A rate normally names its unit outright — `unit: "usd"` on
`transactions:cost.unit_cost` says "4dp dollars" and the cell formats it. A
`rate` beside a {@link RateTypeEnum} cannot: `10.25` is `10.25%` when the
row's own `type` says `percent` and `$10.25` per unit when it says `flat`. The
unit is a property of the ROW, not of the field, so no static per-field value
can express it — one would render the other arm wrongly.

So the annotation names *where to look* (`unitVia`, a sibling key resolved
against the leaf's own parent object) and *what each value means* (`unitMap`).
The map is the load-bearing half: a bare `rate: true` would repeat exactly
what `TypesenseField.money` did — carry a definition with no unit, which
rendered every money mirror 100× on 2026-08-08.

One constant rather than four copies, so a new `RateType` member is one edit;
`tests/display-columns.test.ts` T14 fails if the map stops covering the enum.

```ts
const RATE_UNIT_META: typeLiteral;
```

### `RateType`

Allowed values for rate type: percent or flat.

```ts
type RateType = indexedAccess;
```

### `RateTypeEnum`

Zod schema for RateType.

```ts
const RateTypeEnum: z.ZodType<RateType>;
```

### `SETTLEMENT_CONTRACTS`

The per-type settlement contract, one entry per {@link SETTLEMENT_TYPES}
member — a table the schema reads, so a contradiction is reported by the
schema instead of restated in every consumer.

`sums_into` is load-bearing rather than documentation: `calculateInvoiceTotals`
takes its settlement argument structurally, so without a declared target a
credit row would be silently summed into `amount_paid`. Reading the target
from the table removes that class entirely.

A reversal carries **no** external id. The reap appends a reverser because
Xero stopped reporting a payment — the reverser is a CFS event with no Xero
counterpart, and the id it retracts is still on the row `reverses` names.

```ts
const SETTLEMENT_CONTRACTS: Readonly<Record<SettlementTypeType, SettlementContract>>;
```

### `SettlementContract`

How one settlement type may be filled. @see {@link SETTLEMENT_CONTRACTS}

```ts
interface SettlementContract {
  reasons: readonly SettlementReasonType[];
  xero_id_field: "xero_payment_id" | "xero_credit_note_id" | null;
  sums_into: "amount_paid_cents" | "amount_credited_cents" | "amount_void_cents";
  reverses: "required" | "forbidden";
}
```

### `SettlementReasonEnum`

Zod schema for SettlementReasonType.

```ts
const SettlementReasonEnum: z.ZodType<SettlementReasonType>;
```

### `SettlementReasonType`

Why a settlement happened. @see {@link SETTLEMENT_CONTRACTS}

```ts
type SettlementReasonType = indexedAccess;
```

### `SettlementTypeEnum`

Zod schema for SettlementTypeType.

```ts
const SettlementTypeEnum: z.ZodType<SettlementTypeType>;
```

### `SettlementTypeType`

One settlement event's kind. @see {@link SETTLEMENT_CONTRACTS}

```ts
type SettlementTypeType = indexedAccess;
```

### `StockMethodEnum`

Zod schema for StockMethodType.

```ts
const StockMethodEnum: z.ZodType<StockMethodType>;
```

### `StockMethodType`

Allowed values for inventory stock tracking method.

```ts
type StockMethodType = indexedAccess;
```

### `StoreBreakdownEntry`

A single store entry in a stock breakdown, containing its locations.

```ts
interface StoreBreakdownEntry {
  uid_store: string;
  name: string;
  default: boolean;
  crms_stock_level_id: number | null;
  quantity: number;
  locations: StoreBreakdownLocation[];
}
```

### `StoreBreakdownEntrySchema`

Zod schema for StoreBreakdownEntry.

```ts
const StoreBreakdownEntrySchema: z.ZodType<StoreBreakdownEntry>;
```

### `StoreBreakdownLocation`

A single location within a store breakdown entry.

```ts
interface StoreBreakdownLocation {
  uid_location: string;
  name: string;
  quantity: number;
  default: boolean;
  max: number | null;
}
```

### `StoreBreakdownLocationSchema`

Zod schema for StoreBreakdownLocation.

```ts
const StoreBreakdownLocationSchema: z.ZodType<StoreBreakdownLocation>;
```

### `TaxProfileEnum`

Zod schema for TaxProfileType.

```ts
const TaxProfileEnum: z.ZodType<TaxProfileType>;
```

### `TaxProfileType`

Allowed values for organization-level tax profile.

```ts
type TaxProfileType = indexedAccess;
```

### `ThreadId`

`threads.uid` and every `uid_thread` reference — `cards`, `comments`, and the
eight default-thread carriers (`orders`, `invoices`, `products`, `roles`,
`contacts`, `organizations`, `out-of-service`, `credit-notes`, where it is
`.optional()`) — either a Firestore auto-id (the default-thread cowrite) or
an `EventCardId` composite. Event-card threads are minted at a **deterministic
id equal to their card uid** (`${uid_order}:${uid_destination}:start|end`) so
the delete→recreate churn of a CRMS opportunity-webhook burst reuses the one
stable `threads/{cardUid}` doc instead of piling up random-id orphans (and
comments survive across the cycle). Structurally identical to `CardId`; see
`services/eventCardReconcile.ts` `eventCardThreadId`.

```ts
const ThreadId: z.ZodType<string>;
```

### `TimestampFields`

Standard timestamp fields present on most documents.

Both are declared display columns here rather than at each of the ~30 sites
that spread this object — the heading is the same everywhere because the
meaning is. `.meta()` clones, so these two are distinct instances of
`FirestoreTimestamp` and the base stays unannotated.

```ts
const TimestampFields: typeLiteral;
```

### `UidNameRef`

Zod schema for a uid + name reference.

```ts
const UidNameRef: z.ZodType<UidNameRefType>;
```

### `UidNameRefType`

Generic uid + name reference used across many collections.

```ts
interface UidNameRefType {
  uid: string;
  name: string;
}
```

### `checkItemContract(item: typeLiteral, ctx: z.RefinementCtx): void`

The full per-item contract check — {@link checkItemPriceFormula} plus the
`replacement` axis. Attached with `.superRefine` to the ORDER line-item arm,
the one item shape whose price carries a `replacement` channel. The direct
analogue of `checkMovementContract` in `transaction.ts`.

`required_when_stocked` treats a MISSING `stock_method` as stocked — the
conservative reading, and the one the hand-written refine this replaced always
enforced. **Both callers now make the field required** (`OrderDocLineItemInner`
as of W5, `ComponentObject` from the start), so that branch is unreachable
through either one; it is kept because a refinement is not a parse and this
function takes a structural bound, not a schema.

The `stock_method` requirement is also why the axis does not run on the
invoice arm: an invoice line drops `stock_method` and `price.replacement`
together, so an absent `stock_method` there means "this shape has no answer",
not "unknown" — and running it would reject all 7,076 invoice rentals in prod.

⚠️ **This function takes a STRUCTURAL BOUND, not a schema, so the compiler
cannot tell you when a field it reads has been renamed away.** During the
dollars→cents migration `price.replacement` became `price.replacement_cents`
everywhere; had the bound below not moved with it, `deno check` would have
stayed green while `item.price?.replacement` read `undefined` forever — the
`forbidden` arm permanently vacuous (a transaction_fee could carry a
replacement price) and the `required_when_stocked` arm firing on every
stocked rental. Any future rename of a field named here must edit this
signature; `tests/common.test.ts` pins both arms against a live shape so a
vacuous bound fails rather than passes.

### `checkItemPriceFormula(item: typeLiteral, ctx: z.RefinementCtx): void`

The `pricing` half of {@link ITEM_CONTRACTS}: a `percent_of_total` price is
legal only where the contract says the line is priced FROM the document total.

Applies to every price shape in the package, so it is the check the invoice
arm attaches on its own — an invoice line has no `stock_method` and its price
has no `replacement` key, which leaves this as the only axis it can express.

`percent_of_total` prices a line from the DOCUMENT total, which only
`calculateTransactionFeeAmount` knows how to do — `calculateItemSubtotal`
throws on it. Before this axis the combination was merely thrown on at
runtime, deep in `perUnitSubtotal`; here it is unwritable. The converse is
deliberately NOT asserted: a flat-amount fee is legitimate, and
`calculateTransactionFeeAmount` prices one.

### `checkPriceBaseUnit(price: typeLiteral | null | undefined, ctx: z.RefinementCtx): void`

The unit half of a line's price: which of `base_cents` / `base_percent` a
`formula` is allowed to carry.

**This exists because `price.base` used to carry two units.** On a
`transaction_fee` line with `formula === "percent_of_total"`, `base` was a
*percentage* of the document's `subtotal_discounted`; on every other line it
was a per-unit dollar amount. One field, two units, discriminated only by a
sibling — so a reader that did not consult `formula` first multiplied a 2.9%
card fee as if it were $2.90, and integer cents would have made 2.9%
unrepresentable outright.

The split puts the unit in the NAME: `base_cents` is money (integer cents),
`base_percent` is a percentage stored at 4dp — the quantum Xero's
`DiscountRate` holds, and deliberately NOT the `RATE_SCALE = 1_000_000n`
widening `utils/orders.ts` uses to *apply* a rate exactly. Conflating those
two would store six decimals Xero cannot carry.

**The rule is exactly-one-of, in the only form a `.default(0)` leaves
checkable.** `base_cents` keeps its default, so it is materialized by the
parse before any object-level refinement runs and can never be observed
"absent" here; asserting it is *zero* on the fee arm is the same guarantee
against the same failure, and it is the half that can actually fail. The
`base_percent` half is asserted in both directions.

### `deriveName(parts: PartialNameParts): string`

Canonical join rule for deriving a single display string from name parts.
Joins `[first_name, middle_name, last_name]` with single spaces (missing
parts are dropped, never produce empty padding) and appends ` (pronunciation)`
when set. This is the single source of truth — every `name` field on a
stored document and `ActorRef.name` is computed by passing through here.

### `getSettlementMultiplier(type: SettlementTypeType): 1 | -1`

`+1` for a settlement that increases the total it feeds, `-1` for one that
reduces it.

**Derived from the contract, never declared**, exactly as
`getTransactionMultiplier` derives from `places` rather than carrying a ±1
column: a type that must name what it reverses IS a retraction, and one that
must not IS an application. Two facts that could disagree become one that
cannot.

**The sign keys on `type`, not on `reason`.** The package answers this the
same way three times over — `getTransactionMultiplier(type)`, and
`out_of_service_breakdown[o.reason]` where reason is a *breakdown dimension*
rather than a direction. It is also forced here: `correction` is genuinely
bidirectional (an operator may be adding a payment they missed or removing one
that never happened), so a reason-keyed sign would have to split it into
`correction_added`/`correction_removed`, and every other bidirectional reason
after it. Type carries direction, reason carries why, and the contract's
`reasons` list keeps the pairs legal.

### `isDividerItemType(type: string): type is DividerItemType`

Whether an item type is a structural divider — the complement of {@link isLineItemType}.

### `isFulfillableItemType(type: string): type is FulfillableItemType`

Whether an item type can be picked off a shelf — the `fulfillable` axis.

NOT a synonym for {@link isLineItemType}: `transaction_fee` is a line and is
not fulfillable. Two predicates seven lines apart in `services/fulfillment.ts`
drew exactly that distinction by hand and read as if they disagreed.

### `isLineItemType(type: string): type is DocLineItemTypeType`

Whether an item type is a billable line rather than a structural divider.

The ONE answer to a question that was previously answered by hand in five
modules as `type !== "destination" && type !== "group"` — sometimes with
`&& type !== "order"` (correct for invoices, where an `order` divider exists)
and sometimes with `&& type !== "transaction_fee"`, which is a **different
question**: see {@link isFulfillableItemType}.

Takes a `string` because callers hold item types from loosely-typed sources.
A value outside {@link ITEM_TYPES} has no contract and answers `false`.

### `itemContract(type: string): ItemContract | undefined`

The contract for an item `type`, or `undefined` for a value outside
{@link ITEM_TYPES}. Takes a `string` because the loose `LineItem` shadow in
`@cfs/core/utils/orders` types `type` as `string`; an unrecognized type has no
contract and every derived predicate answers `false` for it.

### `settlementContract(type: string): SettlementContract | undefined`

The contract for a settlement `type`, or `undefined` for a value outside
{@link SETTLEMENT_TYPES}. Tolerant of a `string` for the same reason
{@link itemContract} is — callers hold types from loosely-typed sources.

## `@cfs/core/schemas/booking`

### `BOOKING_BREAKDOWN_KEYS`

All seven keys of the booking lifecycle breakdown, in lifecycle order (which
is NOT the schema's alphabetical field order — the UI reads left to right).

These live beside the schema rather than in `utils/bookings.ts` because
schema modules cannot import utils (the dependency runs strictly one way) and
the movement journal needs the key union to type a custody transition.
`utils/bookings.ts` re-exports all three, so existing importers are unaffected.

```ts
const BOOKING_BREAKDOWN_KEYS: "quoted" | "reserved" | "prepped" | "out" | "returned" | "lost" | "damaged"[];
```

### `BOOKING_BREAKDOWN_TERMINAL_KEYS`

Keys representing items that have reached a terminal state.

```ts
const BOOKING_BREAKDOWN_TERMINAL_KEYS: "returned" | "lost" | "damaged"[];
```

### `BOOKING_STATUSES`

```ts
const BOOKING_STATUSES: "draft" | "quoted" | "reserved" | "part-prepped" | "prepped" | "active" | "complete"[];
```

### `Booking`

Full Firestore document for a booking (a single product line within an order).

```ts
interface Booking {
  uid: string;
  uid_order: string;
  uid_product: string;
  name: string;
  number: number;
  type: ComponentTypeType;
  status: BookingStatusType;
  quantity: number;
  shortage: number;
  subject: string;
  unit_price_cents: number;
  total_price_cents: number;
  crms_id?: number | null;
  crms_product_id?: number | null;
  breakdown: BookingBreakdown;
  dates: typeLiteral;
  destinations: typeLiteral;
  organization: typeLiteral;
  stores: BookingStore[];
  query_by_uid_store: string[];
  query_by_uid_location: string[];
  uid_destination_delivery: string;
  uid_destination_collection: string;
  version: number;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}
```

### `BookingBreakdown`

Per-status quantity breakdown for a booking — also embedded in stock-summary entries.

```ts
interface BookingBreakdown {
  damaged: number;
  lost: number;
  out: number;
  prepped: number;
  quoted: number;
  reserved: number;
  returned: number;
}
```

### `BookingBreakdownKeyEnum`

Zod enum over the seven breakdown keys — the custody axis of a movement.

```ts
const BookingBreakdownKeyEnum: z.ZodType<BookingBreakdownKeyType>;
```

### `BookingBreakdownKeyType`

One key of the booking lifecycle breakdown.

```ts
type BookingBreakdownKeyType = indexedAccess;
```

### `BookingBreakdownSchema`

Zod schema for BookingBreakdown.

```ts
const BookingBreakdownSchema: z.ZodType<BookingBreakdown>;
```

### `BookingDestinationRef`

A reference to a destination with its address, used in booking delivery/collection.

```ts
interface BookingDestinationRef {
  uid: string;
  address: AddressType | null;
}
```

### `BookingSchema`

Zod schema for Booking.

```ts
const BookingSchema: z.ZodType<Booking>;
```

### `BookingStatusType`

```ts
type BookingStatusType = indexedAccess;
```

### `BookingStore`

A store and its locations assigned to a booking.

```ts
interface BookingStore {
  uid_store: string;
  name: string;
  default: boolean;
  quantity: number;
  locations: BookingStoreLocation[];
}
```

### `BookingStoreLocation`

A specific location within a store allocated for a booking.

```ts
interface BookingStoreLocation {
  uid_location: string;
  name: string;
  quantity: number;
  default: boolean;
}
```

### `BookingUpdate`

```ts
const BookingUpdate: z.ZodType<BookingUpdateType>;
```

### `BookingUpdateType`

Per-row entry for the bulk fulfillment-bookings endpoint. Matches
`UpdateBookingInputType` field-for-field, plus the booking `uid` to address
the row (since the URL carries the fulfillment uid, not the booking uid).

```ts
interface BookingUpdateType {
  uid: string;
  status?: BookingStatusType;
  breakdown?: indexedAccess;
  version: number;
}
```

### `BulkBookingUpdateInput`

```ts
const BulkBookingUpdateInput: z.ZodType<BulkBookingUpdateInputType>;
```

### `BulkBookingUpdateInputType`

Body of `PUT /fulfillments/{uid}/bookings` — applies N booking transitions
for one order in a single Firestore transaction.

Top-level `version` is the fulfillment doc version at read time. Currently
advisory: a stale value 409s. Per-row `version` carries each booking's
current version for optimistic concurrency.

No fixed cap on `updates.length`. Bound only by the real Firestore limits
(270s tx duration, 10 MiB request size). The bulk service rejects empty
arrays with 400.

```ts
interface BulkBookingUpdateInputType {
  version: number;
  updates: BookingUpdateType[];
  uid_session: string;
}
```

### `BulkBookingUpdateResponse`

```ts
const BulkBookingUpdateResponse: z.ZodType<BulkBookingUpdateResponseType>;
```

### `BulkBookingUpdateResponseType`

Successful response from `PUT /fulfillments/{uid}/bookings`. Per-row
`results` carry the post-write booking versions in input order.

```ts
interface BulkBookingUpdateResponseType {
  success: true;
  order_completed: boolean;
  oos_records_written: number;
  results: Array<typeLiteral>;
}
```

### `UpdateBookingInput`

Zod schema for UpdateBookingInput.

```ts
const UpdateBookingInput: z.ZodType<UpdateBookingInputType>;
```

### `UpdateBookingInputType`

Input for updating a single booking via `PUT /bookings/{uid}`.

Status and breakdown are independently optional — most warehouse PUTs only
change the breakdown. When `breakdown` is supplied it must be the complete
next state (all 7 keys); the service requires `sum(breakdown) === quantity`
and treats the value as an absolute write, not a partial patch. Version is
required for optimistic concurrency.

{@link UpdateBookingInputType.uid_session} is what makes this endpoint safe to
retry once a breakdown change also appends to the movement journal — see the
field's own note.

```ts
interface UpdateBookingInputType {
  status?: BookingStatusType;
  breakdown?: indexedAccess;
  version: number;
  uid_session: string;
}
```

## `@cfs/core/schemas/cache-geocodes`

### `CacheGeocodes`

Full Firestore document for a cached geocode result.

```ts
interface CacheGeocodes {
  query: string;
  coordinates: CoordinatesType | null;
  mapbox_id: string;
  address: CacheGeocodesAddress;
  created_at: FirestoreTimestampType;
  expiresAt: FirestoreTimestampType;
}
```

### `CacheGeocodesAddress`

Parsed address fields returned from a geocode lookup.

```ts
interface CacheGeocodesAddress {
  street?: string;
  city?: string;
  region?: string;
  postcode?: string;
  country_name?: string;
  full?: string;
  name?: string;
}
```

### `CacheGeocodesSchema`

Zod schema for CacheGeocodes.

Every field here except the timestamps describes ONE customer address, so the
whole document is PII and is tagged as such. It is the untagged twin of
`Address` (`common.ts`) — hand-rolled from the Mapbox response rather than
reusing the primitive — and it stayed untagged because `cache-geocodes` was
not in `tests/pii.test.ts`'s old hand-maintained schema list.

Tagged to match `Address` exactly: `mask` on the object so a new field is
masked by default, with the three coarse-geography leaves opting OUT (a city
/ state / country identifies no one alone, and the mask transform mangles
them). `query`, `coordinates` and `mapbox_id` are tagged individually because
they sit OUTSIDE the address object — and each one resolves to the same
street address on its own, so masking `address` while leaving them raw would
be theatre. Note `query`/`coordinates`/`mapbox_id` are invisible to the
name-dictionary in `pii/dictionary.ts`: no lint would have caught them.

```ts
const CacheGeocodesSchema: z.ZodType<CacheGeocodes>;
```

## `@cfs/core/schemas/card`

### `Card`

Card Firestore document shape.

```ts
interface Card {
  uid: string;
  uid_list: string;
  uid_thread: string;
  status: CardStatus;
  action: CardAction | null;
  position: number;
  subject: string;
  body: CommentBodyJson | null;
  body_text: string;
  dates: CardDatesType;
  all_day: boolean;
  date_fs: FirestoreTimestampType | null;
  destination: DocDestinationEndpointType | null;
  organization: CardOrganizationType | null;
  sources: DocSourceType[];
  attachments: CardAttachmentType[];
  uid_assignees: string[];
  locked: CardLockKey[];
  recurrence_parent_uid: string | null;
  recurrence_index: number | null;
  recurrence_overrides: string[];
  version: number;
  created_by: ActorRefType;
  updated_by: ActorRefType;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}
```

### `CardAction`

Denormalized "next action" for a card's primary button, computed server-side
on every booking write (alongside `status`). Surfaces on Dashboard/Calendar
surfaces where no bookings are loaded, so the button can show the *next* step
without a join.

A discriminated object (not a flat enum) so non-fulfillment sources can be
added as purely additive arms (e.g. `{ source: "out_of_service", value: … }`)
without a cross-repo field rename. `null` when nothing is actionable
(terminal status, or no pending step on this side).

```ts
type CardAction = typeLiteral;
```

### `CardActionSchema`

Zod schema for CardAction (discriminated on `source`; JSR no-slow-types-safe).

```ts
const CardActionSchema: z.ZodType<CardAction>;
```

### `CardAttachment`

Zod schema for a card attachment.

One node, seven consumers — `CardSchema`, `RecurrenceSchema`'s prototype, and
the create/update inputs of both all reference this same instance (no
`.extend()` / `.omit()` / `.pick()` anywhere in `src/schemas/`), and
`z.globalRegistry` is a WeakMap keyed on the instance. So the single
`uploadcareRef()` below annotates `uid` for every one of them.

```ts
const CardAttachment: z.ZodType<CardAttachmentType>;
```

### `CardAttachmentType`

A single attachment on a card (Uploadcare UUID + display metadata).

```ts
interface CardAttachmentType {
  uid: string;
  type: CardAttachmentTypeEnum;
  filename: string;
  mime_type: string;
  size_bytes: number;
  locked: boolean;
}
```

### `CardAttachmentTypeEnum`

Semantic discriminator for a card attachment. Server-derived attachments
(packing/quote/invoice) carry their domain meaning so the UI can render
them as labelled chips without sniffing MIME or filename. User uploads
default to `image` (when MIME starts with `image/`) or `file` otherwise.

```ts
type CardAttachmentTypeEnum = indexedAccess;
```

### `CardAttachmentTypeEnumSchema`

Zod schema for CardAttachmentTypeEnum.

```ts
const CardAttachmentTypeEnumSchema: z.ZodType<CardAttachmentTypeEnum>;
```

### `CardDates`

Zod schema for the card dates sub-object.

```ts
const CardDates: z.ZodType<CardDatesType>;
```

### `CardDatesType`

Card datetime range. `start` is the canonical occurrence instant — Chicago
offset form, idempotent through `chicagoInstant()`. `end` carries the
occurrence's wall-clock close (deliveries with start + end times); `null`
means single-instant or all-day. `start` is nullable so cards without a
date (generic to-dos, shopping items) stay valid.

```ts
interface CardDatesType {
  start: string | null;
  end: string | null;
}
```

### `CardFulfillmentAction`

The next fulfillment step a fulfillment-sourced card surfaces on its button.

```ts
type CardFulfillmentAction = indexedAccess;
```

### `CardFulfillmentActionEnum`

Zod schema for CardFulfillmentAction.

```ts
const CardFulfillmentActionEnum: z.ZodType<CardFulfillmentAction>;
```

### `CardLockKey`

Enum of lockable card surfaces.

- `"card"` — presence blocks DELETE (all other keys are field locks)
- `"status_auto"` — narrow override slot: server auto-computes `status`,
  but PATCH still accepts `status: "blocked"` (manual block) or a no-op of
  the current auto value. Distinct from `"status"`, which fully locks the
  field.
- Any other value — presence rejects PATCH of that specific field

Narrower than `(keyof Card)[]` because (a) most Card fields are
system-managed (uid, timestamps, actor refs) and nonsensical to lock, and
(b) we need a sentinel for "prevent delete" that doesn't collide with a
real field name.

```ts
type CardLockKey = indexedAccess;
```

### `CardLockKeyEnum`

Zod schema for CardLockKey.

```ts
const CardLockKeyEnum: z.ZodType<CardLockKey>;
```

### `CardOrganization`

Zod schema for CardOrganizationType.

```ts
const CardOrganization: z.ZodType<CardOrganizationType>;
```

### `CardOrganizationType`

Denormalized organization snapshot on order-derived event cards. Surfaces
"who is this card for?" on every card-rendering surface (list, kanban,
calendar, dashboard) without joining back to the order. `uid` is nullable
because some organizations exist without a CFS-side uid (legacy CRMS-only
customers).

```ts
interface CardOrganizationType {
  uid: string | null;
  name: string;
}
```

### `CardSchema`

Zod schema for a card Firestore document.

```ts
const CardSchema: z.ZodType<Card>;
```

### `CardStatus`

Allowed card statuses. Shared across field-service, to-do, shopping, calendar.

```ts
type CardStatus = indexedAccess;
```

### `CardStatusEnum`

Zod schema for CardStatus.

```ts
const CardStatusEnum: z.ZodType<CardStatus>;
```

### `CreateCardInput`

Zod schema for creating a card.

```ts
const CreateCardInput: z.ZodType<CreateCardInputType>;
```

### `CreateCardInputType`

Input for POST /cards.

```ts
interface CreateCardInputType {
  uid_list: string;
  subject: string;
  status?: CardStatus;
  position?: number;
  body?: CommentBodyJson | null;
  body_text?: string;
  dates?: CardDatesType;
  all_day?: boolean;
  destination?: DocDestinationEndpointType | null;
  organization?: CardOrganizationType | null;
  sources?: DocSourceType[];
  attachments?: CardAttachmentType[];
  uid_assignees?: string[];
  locked?: CardLockKey[];
}
```

### `UpdateCardInput`

Zod schema for updating a card. Lock enforcement happens at the service
layer (api-cloudrun) — the schema accepts any field, then service rejects
with FIELD_LOCKED if the card's `locked[]` contains the field name.

```ts
const UpdateCardInput: z.ZodType<UpdateCardInputType>;
```

### `UpdateCardInputType`

Input for PATCH /cards/:uid — all fields optional except version.

```ts
interface UpdateCardInputType {
  uid_list?: string;
  status?: CardStatus;
  position?: number;
  subject?: string;
  body?: CommentBodyJson | null;
  body_text?: string;
  dates?: CardDatesType;
  all_day?: boolean;
  destination?: DocDestinationEndpointType | null;
  organization?: CardOrganizationType | null;
  sources?: DocSourceType[];
  attachments?: CardAttachmentType[];
  uid_assignees?: string[];
  version: number;
}
```

## `@cfs/core/schemas/chart-of-accounts`

### `COAClass`

Zod schema for COAClass.

```ts
const COAClass: z.ZodType<COAClassType>;
```

### `COAClassType`

Which side of a posting this account sits on.

```ts
type COAClassType = indexedAccess;
```

### `COACode`

Zod schema for COACode.

```ts
const COACode: z.ZodType<COACodeType>;
```

### `COACodeType`

A chart-of-accounts code.

No longer a closed union — see the module docstring. The catalog is the
`chart-of-accounts` collection, so an unknown code is caught by a lookup that
can actually be refreshed, not by a literal list that goes stale silently.

```ts
type COACodeType = number;
```

### `COAStatus`

Zod schema for COAStatus.

```ts
const COAStatus: z.ZodType<COAStatusType>;
```

### `COAStatusType`

Whether Xero still offers this account for new coding.

```ts
type COAStatusType = indexedAccess;
```

### `COAType`

Zod schema for COAType.

```ts
const COAType: z.ZodType<COATypeType>;
```

### `COATypeType`

Valid chart of accounts type values.

```ts
type COATypeType = indexedAccess;
```

### `ChartOfAccounts`

A chart of accounts document in Firestore.

```ts
interface ChartOfAccounts {
  uid: string;
  code: COACodeType;
  name: string;
  type: COATypeType;
  class: COAClassType;
  status: COAStatusType;
  xero_id: string | null;
  description?: string;
  version: number;
  created_by: ActorRefType;
  updated_by: ActorRefType;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}
```

### `ChartOfAccountsSchema`

Zod schema for ChartOfAccounts.

```ts
const ChartOfAccountsSchema: z.ZodType<ChartOfAccounts>;
```

## `@cfs/core/schemas/contact`

### `Contact`

Full contact document schema (Firestore document shape).

```ts
interface Contact {
  uid: string;
  name: string;
  crms_id?: number;
  emails: string[];
  phones: string[];
  organizations: ContactOrganizationType[];
  query_by_organizations: string[];
  uid_user?: string;
  uid_thread?: string;
  version: number;
  created_by: ActorRefType;
  updated_by: ActorRefType;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}
```

### `ContactOrganization`

Zod schema for an organization reference embedded in a contact.

```ts
const ContactOrganization: z.ZodType<ContactOrganizationType>;
```

### `ContactOrganizationType`

Organization reference embedded in a contact document.

```ts
interface ContactOrganizationType {
  uid: string;
  name: string;
}
```

### `ContactSchema`

Zod schema for a full contact Firestore document.

```ts
const ContactSchema: z.ZodType<Contact>;
```

### `CreateContactInput`

Input schema for creating a contact.

```ts
const CreateContactInput: z.ZodType<CreateContactInputType>;
```

### `CreateContactInputType`

Input schema for POST /contacts — what the endpoint accepts.

```ts
interface CreateContactInputType {
  uid: string;
  emails?: string[];
  phones?: string[];
  organizations?: ContactOrganizationType[];
}
```

### `UpdateContactInput`

Input schema for updating a contact.

```ts
const UpdateContactInput: z.ZodType<UpdateContactInputType>;
```

### `UpdateContactInputType`

Input schema for PUT /contacts/:uid — partial update.

```ts
interface UpdateContactInputType {
  uid?: string;
  emails?: string[];
  phones?: string[];
  organizations?: ContactOrganizationType[];
  version: number;
}
```

## `@cfs/core/schemas/destination`

### `Destination`

Full Firestore document for a destination (a physical address used in orders).

```ts
interface Destination {
  uid: string;
  address: AddressType | null;
  mapbox_ids: string[];
  organizations?: UidNameRefType[];
  query_by_organizations?: string[];
  products?: UidNameRefType[];
  query_by_products?: string[];
  contacts?: DestinationContactRefType[];
  query_by_contacts?: string[];
  version: number;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}
```

### `DestinationContactRef`

Zod schema for a contact reference embedded in a destination.

```ts
const DestinationContactRef: z.ZodType<DestinationContactRefType>;
```

### `DestinationContactRefType`

Contact reference embedded in a destination document.

Mirrors the split-name shape used in `organizations.contacts[]` so that the
Typesense `destinations_v5` collection can index the same `first_name /
middle_name / last_name / pronunciation` fields without an adapter. `name`
is the server-derived display string (see `deriveName` in common.ts).

```ts
interface DestinationContactRefType {
  uid: string;
  name: string;
}
```

### `DestinationSchema`

Zod schema for Destination.

```ts
const DestinationSchema: z.ZodType<Destination>;
```

## `@cfs/core/schemas/email-verification`

### `EmailVerification`

Full Firestore document for a single-use email verification token.

```ts
interface EmailVerification {
  user_id: string;
  email: string;
  expiresAt: FirestoreTimestampType;
  created_at: number;
}
```

### `EmailVerificationSchema`

Zod schema for EmailVerification.

```ts
const EmailVerificationSchema: z.ZodType<EmailVerification>;
```

## `@cfs/core/schemas/holiday-dates`

### `HolidayDates`

Full Firestore document for a single holiday date entry.

```ts
interface HolidayDates {
  uid: string;
  uid_holiday: string;
  date: string;
  date_fs: FirestoreTimestampType;
  name: string;
  type: "fixed" | "variable";
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}
```

### `HolidayDatesSchema`

Zod schema for HolidayDates.

```ts
const HolidayDatesSchema: z.ZodType<HolidayDates>;
```

## `@cfs/core/schemas/holiday-definition`

### `CreateFixedHolidayInputType`

Input type for creating a fixed-date holiday.

```ts
interface CreateFixedHolidayInputType {
  uid?: string;
  type: "fixed";
  name: string;
  month: number;
  date: number;
}
```

### `CreateHolidayDefinitionInput`

Input schema for creating a holiday definition.

```ts
const CreateHolidayDefinitionInput: z.ZodType<CreateHolidayDefinitionInputType>;
```

### `CreateHolidayDefinitionInputType`

Input type for creating a holiday definition.

```ts
type CreateHolidayDefinitionInputType = CreateFixedHolidayInputType | CreateVariableHolidayInputType;
```

### `CreateVariableHolidayInputType`

Input type for creating a variable-date holiday.

```ts
interface CreateVariableHolidayInputType {
  uid?: string;
  type: "variable";
  name: string;
  month: number;
  day: number;
  week: HolidayWeekInputType;
}
```

### `HolidayDefinition`

A holiday definition document in Firestore (collection: holiday-definitions).

`type: "fixed"` rules carry `date` (day-of-month); `type: "variable"` rules
carry `day`/`display_day`/`week`/`display_suffix` (e.g. "3rd Monday"). The
variant fields are optional on the document because both shapes share one
collection; the input schemas guarantee the correct set per type.

```ts
interface HolidayDefinition {
  uid: string;
  type: HolidayType;
  name: string;
  display_month: number;
  js_month: number;
  date?: number;
  day?: string;
  display_day?: string;
  week?: string;
  display_suffix?: string;
  active: boolean;
  version: number;
  created_by: ActorRefType;
  updated_by: ActorRefType;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}
```

### `HolidayDefinitionSchema`

Zod schema for HolidayDefinition.

```ts
const HolidayDefinitionSchema: z.ZodType<HolidayDefinition>;
```

### `HolidayType`

Holiday rule discriminator.

```ts
type HolidayType = "fixed" | "variable";
```

### `HolidayWeekInputType`

Ordinal-week selector for a variable holiday — string or numeric form.

```ts
type HolidayWeekInputType = "1" | "2" | "3" | "4" | "last" | 1 | 2 | 3 | 4;
```

### `UpdateFixedHolidayInputType`

Input type for updating a fixed-date holiday (full rule replacement).

```ts
interface UpdateFixedHolidayInputType {
  uid: string;
  version: number;
  type: "fixed";
  name: string;
  month: number;
  date: number;
}
```

### `UpdateHolidayDefinitionInput`

Input schema for updating a holiday definition (in-place edit, version-checked).

```ts
const UpdateHolidayDefinitionInput: z.ZodType<UpdateHolidayDefinitionInputType>;
```

### `UpdateHolidayDefinitionInputType`

Input type for updating a holiday definition. Carries `version` for the optimistic-lock check.

```ts
type UpdateHolidayDefinitionInputType = UpdateFixedHolidayInputType | UpdateVariableHolidayInputType;
```

### `UpdateVariableHolidayInputType`

Input type for updating a variable-date holiday (full rule replacement).

```ts
interface UpdateVariableHolidayInputType {
  uid: string;
  version: number;
  type: "variable";
  name: string;
  month: number;
  day: number;
  week: HolidayWeekInputType;
}
```

## `@cfs/core/schemas/holiday-snapshot`

### `HolidaySnapshot`

The materialized holiday snapshot singleton (`holiday-snapshot/current`).

```ts
interface HolidaySnapshot {
  uid: "current";
  materialized_dates: string[];
  materialized_count: number;
  materialized_year_range: HolidaySnapshotYearRange;
  materialized_at: FirestoreTimestampType;
}
```

### `HolidaySnapshotSchema`

Zod schema for HolidaySnapshot.

```ts
const HolidaySnapshotSchema: z.ZodType<HolidaySnapshot>;
```

### `HolidaySnapshotYearRange`

Inclusive year span covered by the materialized snapshot.

```ts
interface HolidaySnapshotYearRange {
  from: number;
  to: number;
}
```

## `@cfs/core/schemas/inventory-ledger`

### `InventoryLedger`

An inventory ledger document tracking stock quantities and costs per product.

```ts
interface InventoryLedger {
  uid: string;
  uid_product: string;
  type: ProductTypeType;
  stock_method: InventoryStockMethodType;
  quantity_held: number;
  quantity_in_service: number;
  quantity_out_of_service: number;
  average_unit_cost: number;
  total_cost_basis_cents: number;
  out_of_service_breakdown: typeLiteral;
  store_breakdown: StoreBreakdownEntry[];
  query_by_uid_store: string[];
  query_by_uid_location: string[];
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}
```

### `InventoryLedgerSchema`

Zod schema for an InventoryLedger document.

```ts
const InventoryLedgerSchema: z.ZodType<InventoryLedger>;
```

## `@cfs/core/schemas/invite`

### `AcceptInviteInput`

Input schema for POST /auth/accept-invite.

```ts
const AcceptInviteInput: z.ZodType<AcceptInviteInputType>;
```

### `AcceptInviteInputType`

Input to POST /auth/accept-invite. Name fields override the invite's
captured values — each is optional; omitted means "keep the invite's value".

```ts
interface AcceptInviteInputType {
  token: string;
  password: string;
}
```

### `CreateInviteInput`

Input schema for POST /admin/users/invite.

```ts
const CreateInviteInput: z.ZodType<CreateInviteInputType>;
```

### `CreateInviteInputType`

Input to POST /admin/users/invite.

```ts
interface CreateInviteInputType {
  email: string;
  roles: string[];
}
```

### `Invite`

Full Firestore document for a single-use invite.

```ts
interface Invite {
  uid: string;
  email: string;
  name: string;
  roles: string[];
  invited_by: string;
  used: boolean;
  expires_at: FirestoreTimestampType;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}
```

### `InviteSchema`

Zod schema for an Invite document.

```ts
const InviteSchema: z.ZodType<Invite>;
```

## `@cfs/core/schemas/invoice`

### `ACCEPTS_PAYMENT_STATUSES`

Statuses that still admit a further payment. Excludes `paid` deliberately.

```ts
const ACCEPTS_PAYMENT_STATUSES: readonly InvoiceStatusType[];
```

### `CreateInvoiceInput`

Input schema for creating an invoice.

```ts
const CreateInvoiceInput: z.ZodType<CreateInvoiceInputType>;
```

### `CreateInvoiceInputType`

Input schema for POST /invoices — create an invoice from orders.

```ts
interface CreateInvoiceInputType {
  uid: string;
  query_by_orders: string[];
  organization: typeLiteral;
  tax_profile: TaxProfileType;
  items?: InvoiceItemInputType[];
  destinations?: InvoiceDocDestinationType[];
  date?: string;
  due_date?: string;
  subject?: string;
  reference?: string | null;
  external_notes?: string;
  internal_notes?: string;
}
```

### `INVOICE_STATUS_CONTRACTS`

The per-status contract table.

The `Readonly<Record<InvoiceStatusType, …>>` annotation is what enforces
totality: a sixth status is a type error **here**, at the declaration, which
forces an answer to all five questions rather than defaulting four of them.
No separate parity guard — a `T extends keyof typeof TABLE` assertion beside
this would read `T extends T` and could not fail.

Deliberately **not** carrying an `amounts` column. Two status↔amounts rules
were proposed and both were killed by paging all 962 prod invoices:
`paid ⟹ amount_due <= 0` fails on 20 of 813, and `issued ⟹ amount_paid == 0`
fails on **75 of 98** — a bucket whose money matches Xero to the cent and
whose `status` is what is stale. The arithmetic identity that did survive
(`amount_paid + amount_credited + amount_due == total`, exempting `void`)
ships separately as a `superRefine`, because it is the one rule that does not
mention status.

```ts
const INVOICE_STATUS_CONTRACTS: Readonly<Record<InvoiceStatusType, InvoiceStatusContract>>;
```

### `Invoice`

An invoice document in the invoices Firestore collection.

```ts
interface Invoice {
  uid: string;
  number: number;
  status: InvoiceStatusType;
  query_by_orders: string[];
  number_orders: number[];
  tax_profile: TaxProfileType;
  date: string;
  date_fs: FirestoreTimestampType;
  due_date?: string;
  due_date_fs?: FirestoreTimestampType;
  subject?: string | null;
  reference?: string | null;
  external_notes?: string | null;
  internal_notes?: string | null;
  organization: typeLiteral;
  destinations: InvoiceDocDestinationType[];
  items: InvoiceDocItemType[];
  totals: InvoiceDocTotals;
  xero_id: string | null;
  uploadcare_uuid: string | null;
  pdf_generated_at: FirestoreTimestampType | null;
  pdf_versions?: Array<typeLiteral>;
  uploadcare_files?: Array<typeLiteral>;
  crms_id?: number | null;
  crms_opportunity_ids?: number[];
  uid_thread?: string;
  version: number;
  created_by: ActorRefType;
  updated_by: ActorRefType;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}
```

### `InvoiceDocDestination`

```ts
const InvoiceDocDestination: z.ZodType<InvoiceDocDestinationType>;
```

### `InvoiceDocDestinationType`

Destination pair on an invoice — mirrors the order's `DocDestinationType`
with a `uid_order` scope field so multi-order invoices can carry pairs
from several orders and have them selectively synced per source order.
Carries `dates` (rendered on the invoice) snapshotted from the source order.

```ts
interface InvoiceDocDestinationType {
  uid_order: string;
}
```

### `InvoiceDocItem`

Zod schema for any invoice document item — discriminated on `type`.

The invoice side never carried a second `transaction_fee` claimant, so it was
always discriminable; it stayed a plain union only because the order side
wasn't. See `OrderDocItem`.

```ts
const InvoiceDocItem: z.ZodType<InvoiceDocItemType>;
```

### `InvoiceDocItemPrice`

Pricing breakdown for a single invoice line item.

```ts
interface InvoiceDocItemPrice {
  base_cents: number;
  base_percent?: number | null;
  chargeable_days: number | null;
  formula: PriceFormulaType;
  subtotal_cents: number;
  subtotal_discounted_cents: number;
  discount: DiscountType | null;
  taxes: PriceModifierType[];
  taxes_base?: TaxRefType[];
  total_cents: number;
  discount_percent?: number;
}
```

### `InvoiceDocItemType`

Union of all item types stored in an invoice document.

```ts
type InvoiceDocItemType = InvoiceDocLineItem | OrderDocGroupItemType | OrderDocDestinationItemType | InvoiceDocOrderItemType;
```

### `InvoiceDocLineItem`

A billable line item on an invoice.

```ts
interface InvoiceDocLineItem {
  uid: string;
  type: DocLineItemTypeType;
  name: string;
  description: string;
  quantity: number;
  price: InvoiceDocItemPrice;
  path: string[];
  coa_revenue?: COARevenueType | null;
  tracking_category?: string | null;
  xero_id?: string | null;
  xero_tracking_option_id?: string | null;
  crms_opportunity_id?: number | null;
  crms_id?: number | string | null;
}
```

### `InvoiceDocLineItemSchema`

```ts
const InvoiceDocLineItemSchema: z.ZodType<InvoiceDocLineItem>;
```

### `InvoiceDocOrderItem`

Zod schema for an order divider item.

```ts
const InvoiceDocOrderItem: z.ZodType<InvoiceDocOrderItemType>;
```

### `InvoiceDocOrderItemType`

Order divider item — scopes invoice items to a source order for multi-order invoices.

```ts
interface InvoiceDocOrderItemType {
  uid: string;
  type: "order";
  name: string;
  path: string[];
  description: string;
}
```

### `InvoiceDocTotals`

Invoice-level totals with settlement tracking.

`amount_paid`, `amount_credited` and `amount_due` are a **co-written
projection** of the `settlements` journal — produced only by
`recomputeSettlementTotals`, written in the same transaction as the settlement
that changed them, and rebuildable from the log by
`scripts/repair-invoice-settlement-totals.ts`. They are not a denormalization
to apologise for; they are the target architecture, and the same shape
`stock-summaries` already has against the movement journal.

`total` is NOT part of that projection — it derives from `items[]`. So the
rebuild is deliberately **partial**: it repairs the settlement-fed fields
without re-pricing anything.

```ts
interface InvoiceDocTotals {
  subtotal_cents: number;
  subtotal_discounted_cents: number;
  discount_amount_cents: number;
  taxes: PriceModifierType[];
  transaction_fees: PriceModifierType[];
  total_cents: number;
  amount_paid_cents: number;
  amount_credited_cents?: number;
  amount_void_cents?: number;
  amount_due_cents: number;
}
```

### `InvoiceItemInputDestination`

Zod schema for a destination divider (invoice input).

```ts
const InvoiceItemInputDestination: z.ZodType<InvoiceItemInputDestinationType>;
```

### `InvoiceItemInputDestinationType`

A destination divider as a client sends it.

```ts
interface InvoiceItemInputDestinationType {
  uid: string;
  type: "destination";
  name?: string;
  description?: string;
  path?: string[];
  uid_delivery?: string;
  uid_collection?: string;
}
```

### `InvoiceItemInputGroup`

Zod schema for a group divider (invoice input).

```ts
const InvoiceItemInputGroup: z.ZodType<InvoiceItemInputGroupType>;
```

### `InvoiceItemInputGroupType`

A group divider as a client sends it.

```ts
interface InvoiceItemInputGroupType {
  uid: string;
  type: "group";
  name?: string;
  description?: string;
  path?: string[];
}
```

### `InvoiceItemInputLine`

Zod schema for a billable invoice line (input).

```ts
const InvoiceItemInputLine: z.ZodType<InvoiceItemInputLineType>;
```

### `InvoiceItemInputLineType`

A billable invoice line as a client sends it — the input mirror of
`InvoiceDocLineItemSchema`.

`uid_order` / `uid_delivery` / `uid_collection` are absent on purpose. The
flat schema this replaces accepted all three on any item; `buildInvoiceItems`
reads the destination pair only on a destination divider and reads `uid_order`
nowhere at all (the order divider's identity IS the source order's uid — the
transitional field was retired in Phase D, and the manager stopped sending
it). Prod agrees: 0 of 8,744 invoice line items carry any of the three.

```ts
interface InvoiceItemInputLineType {
  uid: string;
  type: DocLineItemTypeType;
  name?: string;
  description?: string;
  quantity?: number;
  price?: InvoiceItemInputPrice;
  path?: string[];
  coa_revenue?: COARevenueType | null;
  tracking_category?: string | null;
}
```

### `InvoiceItemInputOrder`

Zod schema for an order divider (invoice input).

```ts
const InvoiceItemInputOrder: z.ZodType<InvoiceItemInputOrderType>;
```

### `InvoiceItemInputOrderType`

An order divider as a client sends it — invoice-only, scopes items to a source order.

```ts
interface InvoiceItemInputOrderType {
  uid: string;
  type: "order";
  name?: string;
  description?: string;
  path?: string[];
}
```

### `InvoiceItemInputPrice`

Item price input — partial, server computes the rest.

```ts
interface InvoiceItemInputPrice {
  base_cents?: number;
  base_percent?: number | null;
  chargeable_days?: number | null;
  formula?: PriceFormulaType;
  discount?: DiscountInputType | null;
  taxes?: Array<typeLiteral>;
}
```

### `InvoiceItemInputType`

Input version of an invoice item — a line, or one of the three dividers.

```ts
type InvoiceItemInputType = InvoiceItemInputLineType | InvoiceItemInputDestinationType | InvoiceItemInputGroupType | InvoiceItemInputOrderType;
```

### `InvoiceSchema`

Zod schema for an Invoice document.

```ts
const InvoiceSchema: z.ZodType<Invoice>;
```

### `InvoiceStatusContract`

What one invoice status admits, on every axis anything in CFS asks about.

Five hand-written status sets used to live in four repos, and three of them
were textually identical while a fourth looked identical and was not. As
columns they stop looking like duplicates of each other and start being
separate answers to separate questions — which is what makes collapsing them
safe where a naive merge was not.

```ts
interface InvoiceStatusContract {
  operator_moves: readonly InvoiceStatusType[];
  reached_xero: boolean;
  live_in_xero: boolean;
  settled: boolean;
  accepts_payment: boolean;
}
```

### `InvoiceStatusType`

Possible invoice statuses.

```ts
type InvoiceStatusType = indexedAccess;
```

### `LIVE_IN_XERO_STATUSES`

Statuses whose Xero counterpart is expected to exist and be non-VOIDED.

Was three textually identical copies — `lib/xeroQuoteStatus.ts`,
`services/invoices.ts` and `scripts/audit-xero-quotes.ts`, the last carrying
a "keep in lockstep" comment that nothing enforced.

```ts
const LIVE_IN_XERO_STATUSES: readonly InvoiceStatusType[];
```

### `REACHED_XERO_STATUSES`

Statuses that have **ever** reached Xero. Includes `void` — see
{@link InvoiceStatusContract.reached_xero}. NOT interchangeable with
{@link LIVE_IN_XERO_STATUSES}, which is exactly the mistake this pair exists
to prevent.

```ts
const REACHED_XERO_STATUSES: readonly InvoiceStatusType[];
```

### `SETTLED_STATUSES`

Statuses whose embedded snapshot is frozen against org-cascade rewrites.

```ts
const SETTLED_STATUSES: readonly InvoiceStatusType[];
```

### `UpdateInvoiceInput`

Input schema for updating an invoice.

```ts
const UpdateInvoiceInput: z.ZodType<UpdateInvoiceInputType>;
```

### `UpdateInvoiceInputType`

Input schema for PUT /invoices/:uid — partial update.

```ts
interface UpdateInvoiceInputType {
  status?: InvoiceStatusType;
  items?: InvoiceItemInputType[];
  destinations?: InvoiceDocDestinationType[];
  date?: string;
  due_date?: string;
  subject?: string;
  reference?: string | null;
  external_notes?: string;
  internal_notes?: string;
  version: number;
}
```

### `canOperatorTransition(from: string, to: string): boolean`

May an operator move `from` to `to` via `PUT /invoices/{uid}`?

Read this rather than the column, so the manager cannot offer a button the
server will 400 — and so a status outside the vocabulary answers `false`
instead of throwing on an undefined lookup.

### `isInvoiceLineItem(item: InvoiceDocItemType): item is InvoiceDocLineItem`

Type guard that narrows an invoice doc item to a billable line item (excludes
structural dividers).

The narrowing target is invoice-specific, but the DECISION is not: it is
`ITEM_CONTRACTS[type].kind`, shared with `isLineItem` in `order.ts`. Written
out by hand this read `!== "destination" && !== "group" && !== "order"` — one
clause longer than the order guard, which is exactly the kind of difference
that looks like a bug and is not.

## `@cfs/core/schemas/list`

### `CreateListInput`

Zod schema for creating a list.

```ts
const CreateListInput: z.ZodType<CreateListInputType>;
```

### `CreateListInputType`

Input for POST /lists.

```ts
interface CreateListInputType {
  name: string;
  description?: string;
  icon?: string | null;
  color?: string | null;
  position?: number;
  locked?: ListLockKey[];
}
```

### `List`

List Firestore document shape.

```ts
interface List {
  uid: string;
  name: string;
  description: string;
  icon: string | null;
  color: string | null;
  position: number;
  locked: ListLockKey[];
  version: number;
  created_by: ActorRefType;
  updated_by: ActorRefType;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}
```

### `ListLockKey`

Enum of lockable list surfaces. Mirrors the `CardLockKey` shape: presence in
`List.locked[]` blocks the corresponding action. Defaults to `[]`.

- `"list"` — sentinel: blocks DELETE of this list doc
- `"create_card"` — blocks `POST /cards` with `uid_list` = this list
- `"update_card"` — blocks `PATCH /cards/:uid` for cards on this list
- `"delete_card"` — blocks `DELETE /cards/:uid` for cards on this list

Used by system-managed lists (e.g. `field-service`, `in-store`) whose cards
are fanned out from order events and shouldn't be created or deleted by
users — the API still updates them, and users can still edit non-locked
fields per `Card.locked[]`.

```ts
type ListLockKey = indexedAccess;
```

### `ListLockKeyEnum`

Zod schema for ListLockKey.

```ts
const ListLockKeyEnum: z.ZodType<ListLockKey>;
```

### `ListSchema`

Zod schema for a list Firestore document.

```ts
const ListSchema: z.ZodType<List>;
```

### `UpdateListInput`

Zod schema for updating a list.

```ts
const UpdateListInput: z.ZodType<UpdateListInputType>;
```

### `UpdateListInputType`

Input for PATCH /lists/:uid — all fields optional except version.

```ts
interface UpdateListInputType {
  name?: string;
  description?: string;
  icon?: string | null;
  color?: string | null;
  position?: number;
  locked?: ListLockKey[];
  version: number;
}
```

## `@cfs/core/schemas/location`

### `CreateLocationInput`

Input schema for creating a location.

```ts
const CreateLocationInput: z.ZodType<CreateLocationInputType>;
```

### `CreateLocationInputType`

Input type for creating a location.

```ts
interface CreateLocationInputType {
  uid: string;
  uid_store: string;
  name: string;
  uid_location_type?: string | null;
}
```

### `Location`

A location document in Firestore.

```ts
interface Location {
  uid: string;
  uid_store: string;
  name: string;
  name_key?: string;
  default: boolean;
  uid_location_type: string | null;
  product_capacities: LocationProductCapacity[];
  query_by_product_capacities: string[];
  active: boolean;
  products: LocationProduct[];
  query_by_products: string[];
  version: number;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}
```

### `LocationProduct`

A product assigned to a location.

```ts
interface LocationProduct {
  uid: string;
  name: string;
  quantity: number;
  default: boolean;
}
```

### `LocationProductCapacity`

Product capacity constraint for a location.

```ts
interface LocationProductCapacity {
  uid: string;
  max: number | null;
  max_default: number | null;
}
```

### `LocationSchema`

Zod schema for Location.

```ts
const LocationSchema: z.ZodType<Location>;
```

### `UpdateLocationInput`

Input schema for updating a location.

```ts
const UpdateLocationInput: z.ZodType<UpdateLocationInputType>;
```

### `UpdateLocationInputType`

Input type for updating a location.

```ts
interface UpdateLocationInputType {
  uid: string;
  name?: string;
  default?: boolean;
  active?: boolean;
  version: number;
}
```

## `@cfs/core/schemas/location-type`

### `CreateLocationTypeInput`

Input schema for creating a location type.

```ts
const CreateLocationTypeInput: z.ZodType<CreateLocationTypeInputType>;
```

### `CreateLocationTypeInputType`

Input type for creating a location type.

```ts
interface CreateLocationTypeInputType {
  name: string;
  product_capacities?: Record<string, typeLiteral>;
  dimensions?: typeLiteral | null;
}
```

### `LocationType`

A location type document in Firestore.

```ts
interface LocationType {
  uid: string;
  name: string;
  product_capacities: LocationTypeProductCapacity[];
  query_by_product_capacities?: string[];
  dimensions?: LocationTypeDimensions | null;
  version: number;
  active: boolean;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}
```

### `LocationTypeDimensions`

Physical dimensions for a location type.

```ts
interface LocationTypeDimensions {
  width?: number;
  depth?: number;
  height?: number;
  weight_capacity?: number;
}
```

### `LocationTypeProductCapacity`

Product capacity constraint for a location type.

```ts
interface LocationTypeProductCapacity {
  uid: string;
  max: number | null;
}
```

### `LocationTypeSchema`

Zod schema for LocationType.

```ts
const LocationTypeSchema: z.ZodType<LocationType>;
```

### `UpdateLocationTypeInput`

Input schema for updating a location type.

```ts
const UpdateLocationTypeInput: z.ZodType<UpdateLocationTypeInputType>;
```

### `UpdateLocationTypeInputType`

Input type for updating a location type.

```ts
interface UpdateLocationTypeInputType {
  uid: string;
  name?: string;
  product_capacities?: Record<string, typeLiteral>;
  dimensions?: typeLiteral | null;
  active?: boolean;
  version: number;
}
```

## `@cfs/core/schemas/order`

### `ConsolidatedItemType`

A consolidated line item — aggregated quantity and price for display.
Used by consolidateItems() in utilities and the manager app.

```ts
interface ConsolidatedItemType {
  uid: string;
  name: string;
  type: string;
  quantity: number;
  total_price_cents: number;
  unit_price_cents: number;
  stock_method: string;
}
```

### `CreateOrderInput`

Input schema for creating an order.

```ts
const CreateOrderInput: z.ZodType<CreateOrderInputType>;
```

### `CreateOrderInputType`

Input schema for POST /orders — what the endpoint accepts.

```ts
interface CreateOrderInputType {
  uid: string;
  organization: typeLiteral;
  status: OrderStatusType;
  tax_profile: TaxProfileType;
  destinations: DestinationType[];
  items?: OrderItemType[];
  subject?: string;
  reference?: string | null;
}
```

### `Destination`

Zod schema for a destination pair.

```ts
const Destination: z.ZodType<DestinationType>;
```

### `DestinationContact`

Zod schema for destination contact reference.

```ts
const DestinationContact: z.ZodType<DestinationContactType>;
```

### `DestinationContactType`

Contact reference embedded in a destination endpoint.
When present (not null), uid and first_name are required. `name` is the
server-derived display string (see `deriveName` in common.ts) — populated
by api-cloudrun on every write so consumers don't re-derive client-side.

```ts
interface DestinationContactType {
  uid: string;
  name: string;
  phones?: string[];
}
```

### `DestinationEndpoint`

Zod schema for a destination endpoint.

```ts
const DestinationEndpoint: z.ZodType<DestinationEndpointType>;
```

### `DestinationEndpointType`

A single destination endpoint (delivery or collection).

```ts
interface DestinationEndpointType {
  uid?: string | null;
  address?: AddressType | null;
  instructions?: string | null;
  contact?: DestinationContactType | null;
}
```

### `DestinationType`

A destination pair — delivery and collection endpoints.

`customer_collecting` is true when the customer picks up the items at our
warehouse for the delivery side of this pair. `customer_returning` is true
when the customer drops the items off at our warehouse for the collection
side. Both default to false (we deliver / we collect).

```ts
interface DestinationType {
  dates: OrderDatesType;
  delivery: DestinationEndpointType;
  collection: DestinationEndpointType;
  customer_collecting?: boolean;
  customer_returning?: boolean;
}
```

### `Discount`

Zod schema for an item discount.

```ts
const Discount: z.ZodType<DiscountType>;
```

### `DiscountInput`

Zod schema for a discount input (without computed amount).

```ts
const DiscountInput: z.ZodType<DiscountInputType>;
```

### `DiscountInputType`

Discount input — rate and type only. Amount is computed by calculateItemPrice.

```ts
interface DiscountInputType {
  rate: number;
  type: RateType;
}
```

### `DiscountType`

Discount applied to an item price. Nullable — null means no discount.
rate is per-unit for flat discounts (rate × quantity × days_factor = amount).

```ts
interface DiscountType {
  rate: number;
  type: RateType;
  amount_cents: number;
}
```

### `DocDestination`

Zod schema for a document-level destination pair.

```ts
const DocDestination: z.ZodType<DocDestinationType>;
```

### `DocDestinationContact`

Zod schema for destination contact reference (document version).

```ts
const DocDestinationContact: z.ZodType<DocDestinationContactType>;
```

### `DocDestinationContactType`

Contact reference in a destination endpoint (document schema — uid & first_name required).

```ts
interface DocDestinationContactType {
  uid: string;
  name: string;
  phones?: string[];
}
```

### `DocDestinationEndpoint`

Zod schema for a destination endpoint (document version).

```ts
const DocDestinationEndpoint: z.ZodType<DocDestinationEndpointType>;
```

### `DocDestinationEndpointType`

Destination endpoint in the full document (uid is nullable, contact uses doc version).

```ts
interface DocDestinationEndpointType {
  uid: string | null;
  address: AddressType | null;
  instructions: string | null;
  contact: DocDestinationContactType | null;
}
```

### `DocDestinationType`

Document-level destination pair. See `DestinationType` for flag semantics.

```ts
interface DocDestinationType {
  dates: OrderDocDatesType;
  delivery: DocDestinationEndpointType;
  collection: DocDestinationEndpointType;
  customer_collecting: boolean;
  customer_returning: boolean;
}
```

### `GroupPathType`

Path context for an item — which destination and group it belongs to.
Used by getGroupPath() in utilities and consumed by the manager app.

```ts
interface GroupPathType {
  destination: string | null;
  group: string | null;
  product: string | null;
}
```

### `ItemPrice`

Zod schema for item price breakdown (input).

```ts
const ItemPrice: z.ZodType<ItemPriceType>;
```

### `ItemPriceType`

Price breakdown for an order item (input — client sends partial data, server computes the rest).

```ts
interface ItemPriceType {
  base_cents?: number;
  base_percent?: number | null;
  replacement_cents?: number | null;
  chargeable_days?: number | null;
  formula?: PriceFormulaType;
  subtotal_cents?: number;
  discount?: DiscountInputType | null;
  taxes?: Array<typeLiteral>;
  total_cents?: number;
}
```

### `ORDER_COMPUTED_STATUSES`

Statuses derived from booking state — set only by the API's booking write
path (reserved → active when a booking moves quantity into out;
active → complete when every quantity has reached a terminal state).

```ts
const ORDER_COMPUTED_STATUSES: "active" | "complete"[];
```

### `ORDER_STATUSES`

```ts
const ORDER_STATUSES: "draft" | "quoted" | "reserved" | "active" | "complete" | "canceled"[];
```

### `ORDER_USER_STATUSES`

Statuses an operator may set directly via UpdateOrderInput.status.
`active` and `complete` are computed by the booking workflow and are
never accepted from a manual write.

```ts
const ORDER_USER_STATUSES: "draft" | "quoted" | "reserved" | "canceled"[];
```

### `Order`

Full order document schema (Firestore document shape).
Used for validation before writing to Firestore.

```ts
interface Order {
  uid: string;
  number: number;
  status: OrderStatusType;
  organization: typeLiteral;
  destinations: DocDestinationType[];
  items: OrderDocItemType[];
  tax_profile: TaxProfileType;
  totals: OrderDocTotalsType;
  invoices: Array<typeLiteral>;
  query_by_invoices: string[];
  query_by_items: string[];
  query_by_contacts: string[];
  query_by_dates: string[];
  bookings_breakdown: typeLiteral;
  crms_id?: number | null;
  crms_status?: string;
  subject?: string;
  reference?: string | null;
  xero_id?: string | null;
  uid_thread?: string;
  version: number;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}
```

### `OrderComputedStatusType`

```ts
type OrderComputedStatusType = indexedAccess;
```

### `OrderDates`

Zod schema for order dates.

```ts
const OrderDates: z.ZodType<OrderDatesType>;
```

### `OrderDatesType`

Order dates — all six date boundaries as ISO datetime strings with offset,
or null when the boundary is unset.

```ts
interface OrderDatesType {
  delivery_start: string | null;
  delivery_end: string | null;
  collection_start: string | null;
  collection_end: string | null;
  charge_start: string | null;
  charge_end: string | null;
}
```

### `OrderDocDates`

Zod schema for order dates with Firestore timestamp companions.

```ts
const OrderDocDates: z.ZodType<OrderDocDatesType>;
```

### `OrderDocDatesType`

Order dates with Firestore timestamp companions — the persisted, per-destination
date set. Each destination on an order/fulfillment/invoice owns one of these;
there is no order-level rollup (derive on demand via deriveOrderDateEnvelope).

```ts
interface OrderDocDatesType {
  delivery_start: string | null;
  delivery_start_fs: FirestoreTimestampType | null;
  delivery_end: string | null;
  delivery_end_fs: FirestoreTimestampType | null;
  collection_start: string | null;
  collection_start_fs: FirestoreTimestampType | null;
  collection_end: string | null;
  collection_end_fs: FirestoreTimestampType | null;
  charge_start: string | null;
  charge_start_fs: FirestoreTimestampType | null;
  charge_end: string | null;
  charge_end_fs: FirestoreTimestampType | null;
  days_active: number | null;
  days_charged: number | null;
}
```

### `OrderDocDestinationItem`

Destination divider in items array.

```ts
const OrderDocDestinationItem: z.ZodType<OrderDocDestinationItemType>;
```

### `OrderDocDestinationItemType`

Destination divider item in the order document items array.

```ts
interface OrderDocDestinationItemType {
  uid: string;
  type: "destination";
  name: string;
  path: string[];
  uid_delivery: string | null;
  uid_collection: string | null;
  description: string;
}
```

### `OrderDocGroupItem`

```ts
const OrderDocGroupItem: z.ZodType<OrderDocGroupItemType>;
```

### `OrderDocGroupItemType`

Group divider in items array.

```ts
interface OrderDocGroupItemType {
  uid: string;
  type: "group";
  name: string;
  path: string[];
  description: string;
}
```

### `OrderDocItem`

Union of all item types in the document — discriminated on `type`.

There is exactly ONE claimant per discriminator value, which is what makes
the discrimination possible at all. `transaction_fee` used to be claimed
twice — once by `DOC_LINE_ITEM_TYPES` here and once by a separate
`OrderDocTransactionFeeItem` arm carrying a `PriceModifier` instead of an
`OrderDocItemPrice` — and Zod answers a duplicate discriminator with a bare
`Error`, not a `ZodError`, so `safeParse` could not trap it. A fee is now an
ordinary line item whose `price.formula` says `percent_of_total`; the
per-document rollup (`totals.transaction_fees`) keeps the `PriceModifier`
shape, because that IS a rate-and-amount summary rather than a line.

```ts
const OrderDocItem: z.ZodType<OrderDocItemType>;
```

### `OrderDocItemPrice`

```ts
const OrderDocItemPrice: z.ZodType<OrderDocItemPriceType>;
```

### `OrderDocItemPriceType`

Line item price in the full order document (all fields required after server compute).
subtotal = pre-discount (base × qty × days_factor).
subtotal_discounted = post-discount.
total = subtotal_discounted + sum(taxes[].amount).

```ts
interface OrderDocItemPriceType {
  base_cents: number;
  base_percent?: number | null;
  replacement_cents?: number | null;
  chargeable_days: number | null;
  formula: PriceFormulaType;
  subtotal_cents: number;
  subtotal_discounted_cents: number;
  discount: DiscountType | null;
  taxes: PriceModifierType[];
  taxes_base?: TaxRefType[];
  total_cents: number;
}
```

### `OrderDocItemType`

Union of all item types stored in the order document.

```ts
type OrderDocItemType = OrderDocLineItemType | OrderDocDestinationItemType | OrderDocGroupItemType;
```

### `OrderDocLineItem`

```ts
const OrderDocLineItem: z.ZodType<OrderDocLineItemType>;
```

### `OrderDocLineItemType`

Line item in the full order document.

`price` and `stock_method` are REQUIRED, and that is a statement about the
writers rather than a convenience: every one of the 9,303 line items in prod
(and in dev) carries both, because `buildOrderLineItem` resolves them off the
backing product doc — or off the `custom-` line's own payload — before it can
build anything at all. While they were optional, three call sites downstream
had to compensate for a shape no writer has ever produced: two `item.price!`
assertions, and a `"stock_method" in item` duck-type that answered "not a line
item" for a line item that merely omitted the field.

`uid_delivery` / `uid_collection` are absent, matching the input arm. They
belong to the destination divider — 0 of 9,303 stored lines carry either key,
no writer has ever set one on a line, and both readers in
`@cfs/core/utils/orders` gate on `type === "destination"` before looking. The
FULFILLMENT line arm keeps its own pair: 9,304 prod rows carry an explicit
`null` there, so removing it would be a backfill, not a tightening.

```ts
interface OrderDocLineItemType {
  uid: string;
  type: DocLineItemTypeType;
  name: string;
  description: string;
  quantity: number;
  price: OrderDocItemPriceType;
  stock_method: StockMethodType;
  order_number?: number;
  uid_order?: string;
  path: string[];
  inclusion_type?: "default" | "mandatory" | "optional" | null;
  zero_priced?: boolean | null;
  crms_id?: number | null;
  coa_revenue?: COARevenueType | null;
}
```

### `OrderDocTotalsType`

Order totals.

```ts
interface OrderDocTotalsType {
  discount_amount_cents: number;
  subtotal_cents: number;
  subtotal_discounted_cents: number;
  taxes: PriceModifierType[];
  transaction_fees: PriceModifierType[];
  total_cents: number;
  replacement_total_cents: number;
}
```

### `OrderItem`

Zod schema for an individual order item (input) — discriminated on `type`,
mirroring the stored {@link OrderDocItem} union.

This was one flat `z.object` where every field but `uid`/`type`/`path` was
optional, so `PUT /orders` accepted a `destination` divider carrying a
`quantity` and a `price`. Nothing stripped them: `buildOrderLineItem` passes a
divider through verbatim, so the payload reached `validateBeforeWrite` and
failed there as `unrecognized_keys` against the stored strict arm — a layer
too late, and phrased as a storage complaint rather than "a divider has no
price". Now it is unwritable at the boundary. Prod says nothing relied on it:
0 of 3,635 order dividers carry any line-only key.

**The line arm comes first, and the order is load-bearing.**
`getInitialValues` resolves a union by taking its first arm, and the manager
seeds a new order line with `getInitialValues(OrderItem)`. Putting a divider
first would silently reshape every staged line.

Only `checkItemPriceFormula` is attached, not the full `checkItemContract`.
The `replacement` axis keys on `stock_method`, which an order INPUT does not
own — the product does, and the server reads it there — so enforcing it here
would reject a legal payload for an unstocked product. Storage already
enforces it against the resolved `stock_method`. Tighten storage, not the
input.

```ts
const OrderItem: z.ZodType<OrderItemType>;
```

### `OrderItemDestination`

Zod schema for a destination divider (input).

```ts
const OrderItemDestination: z.ZodType<OrderItemDestinationType>;
```

### `OrderItemDestinationType`

A destination divider as a client sends it.

```ts
interface OrderItemDestinationType {
  uid: string;
  type: "destination";
  name?: string;
  description?: string;
  path: string[];
  uid_delivery?: string;
  uid_collection?: string;
}
```

### `OrderItemGroup`

Zod schema for a group divider (input).

```ts
const OrderItemGroup: z.ZodType<OrderItemGroupType>;
```

### `OrderItemGroupType`

A group divider as a client sends it.

```ts
interface OrderItemGroupType {
  uid: string;
  type: "group";
  name?: string;
  description?: string;
  path: string[];
}
```

### `OrderItemLine`

Zod schema for a billable order line (input).

```ts
const OrderItemLine: z.ZodType<OrderItemLineType>;
```

### `OrderItemLineType`

A billable order line as a client sends it — the input mirror of
`OrderDocLineItem`.

Deliberately permissive about what may be OMITTED: the server fills `name`,
`stock_method` and the whole price from the backing product doc, and a custom
line supplies them itself. What it is no longer permissive about is what a
line may CLAIM — see {@link OrderItem} for why the arms exist.

`uid_delivery` / `uid_collection` are absent here on purpose. The flat schema
this replaces accepted both on any item, and `buildOrderLineItem` has never
propagated them to a line — prod agrees: 0 of 9,303 order line items carry
either key. They belong to the destination divider, which is where they now
live exclusively.

```ts
interface OrderItemLineType {
  uid: string;
  type: DocLineItemTypeType;
  name?: string;
  description?: string;
  quantity?: number;
  price?: ItemPriceType;
  stock_method?: StockMethodType;
  path: string[];
  inclusion_type?: InclusionTypeType | null;
  zero_priced?: boolean | null;
  order_number?: number;
  uid_order?: string;
}
```

### `OrderItemType`

An individual order item (input) — a line, or one of the two dividers.

```ts
type OrderItemType = OrderItemLineType | OrderItemDestinationType | OrderItemGroupType;
```

### `OrderSchema`

Zod schema for the full order Firestore document.

```ts
const OrderSchema: z.ZodType<Order>;
```

### `OrderStatusType`

```ts
type OrderStatusType = indexedAccess;
```

### `OrderUserStatusType`

```ts
type OrderUserStatusType = indexedAccess;
```

### `PriceModifier`

Zod schema for a rate-based price modifier (tax or transaction fee).

`rate` and `amount_cents` are deliberately DIFFERENT units and the names say
so: `rate` stays a 4dp dollars-or-percent rate discriminated on `type` (see
{@link DiscountType}), while `amount_cents` is the computed money in integer
cents. A sweep that "converts every number in this object" restores exactly
the rate/amount confusion the suffix exists to prevent.

```ts
const PriceModifier: z.ZodType<PriceModifierType>;
```

### `PriceModifierType`

A rate-based charge applied to an item or order (tax or transaction fee).
uid references a tax doc (for taxes) or a product doc (for transaction fees).

```ts
interface PriceModifierType {
  uid: string;
  name: string;
  rate: number;
  type: RateType;
  amount_cents: number;
}
```

### `TaxRef`

Zod schema for a denormalized tax snapshot without computed amount.

```ts
const TaxRef: z.ZodType<TaxRefType>;
```

### `TaxRefType`

Denormalized tax snapshot without computed amount — used on product catalog entries.
PriceModifier extends this shape with `amount` for order-time computation.

```ts
interface TaxRefType {
  uid: string;
  name: string;
  rate: number;
  type: RateType;
}
```

### `UpdateOrderInput`

Input schema for updating an order.

```ts
const UpdateOrderInput: z.ZodType<UpdateOrderInputType>;
```

### `UpdateOrderInputType`

Input schema for PUT /orders/:uid — partial update.

```ts
interface UpdateOrderInputType {
  uid?: string;
  organization?: typeLiteral;
  status?: OrderStatusType;
  tax_profile?: TaxProfileType;
  destinations?: DestinationType[];
  items?: OrderItemType[];
  subject?: string;
  reference?: string | null;
  version: number;
}
```

### `getOrderStatusTransitions(current: OrderStatusType): OrderUserStatusType[]`

The statuses an operator can move to from the given current status.
Returns an empty list for computed statuses (`active`, `complete`) and
filters the current status out of the user-settable set.

### `isFulfillableItem(item: OrderDocItemType): item is OrderDocLineItemType`

Narrows an order doc item to one that can be PICKED — the `fulfillable` axis,
which additionally excludes `transaction_fee`.

Lives beside {@link isLineItem} because the two are constantly confused: a fee
is a line (it is billed) and is not fulfillable (there is nothing on a shelf).
`isFulfillableItemType` alone cannot do this job — a type predicate on
`item.type` narrows the property, not the union — which is why both
`services/fulfillment.ts` and `services/fulfillmentEdits.ts` had grown their
own item-level copy.

The narrowing is deliberately imprecise in the same way `isLineItem` is: it
reports `OrderDocLineItemType`, whose `type` still nominally includes
`transaction_fee`. Every field a caller reads after this guard is shared
across all line types, so the imprecision costs nothing.

### `isLineItem(item: OrderDocItemType): item is OrderDocLineItemType`

Type guard that narrows an order doc item to a line item (excludes
destination/group dividers). Sound: every non-divider `type` is now backed by
exactly one shape, so the narrowing cannot hand a caller a `price` of the
wrong kind.

### `isValidOrderStatusTransition(prev: OrderStatusType, next: OrderStatusType, source: "manual" | "propagation"): boolean`

Server-side gate for an order status write. `source: "manual"` rejects
writes that move into a computed status or out of a computed status into
anything other than the same value (no-op). `source: "propagation"`
trusts the booking write path that sets `active` or `complete`.

## `@cfs/core/schemas/fulfillment`

### `Fulfillment`

Sanitized order document for the fulfillment client view.
Mirrors the order by uid — one fulfillment doc per order.

```ts
interface Fulfillment {
  uid: string;
  number: number;
  status: FulfillmentOrderStatusType;
  organization: typeLiteral;
  destinations: DocDestinationType[];
  items: FulfillmentItemType[];
  subject: string;
  reference: string | null;
  query_by_items: string[];
  query_by_contacts: string[];
  query_by_dates: string[];
  version: number;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}
```

### `FulfillmentDestinationItem`

```ts
const FulfillmentDestinationItem: z.ZodType<FulfillmentDestinationItemType>;
```

### `FulfillmentDestinationItemType`

Destination divider in the fulfillment items array.

```ts
interface FulfillmentDestinationItemType {
  uid: string;
  type: "destination";
  name: string;
  path: string[];
  uid_delivery: string | null;
  uid_collection: string | null;
  description: string;
}
```

### `FulfillmentGroupItem`

```ts
const FulfillmentGroupItem: z.ZodType<FulfillmentGroupItemType>;
```

### `FulfillmentGroupItemType`

Group divider in the fulfillment items array.

```ts
interface FulfillmentGroupItemType {
  uid: string;
  type: "group";
  name: string;
  path: string[];
  description: string;
}
```

### `FulfillmentItem`

```ts
const FulfillmentItem: z.ZodType<FulfillmentItemType>;
```

### `FulfillmentItemType`

Union of all item types in the fulfillment order view.

```ts
type FulfillmentItemType = FulfillmentLineItemType | FulfillmentDestinationItemType | FulfillmentGroupItemType;
```

### `FulfillmentLineItem`

```ts
const FulfillmentLineItem: z.ZodType<FulfillmentLineItemType>;
```

### `FulfillmentLineItemType`

Line item in the fulfillment order view — no price, no financial flags.

```ts
interface FulfillmentLineItemType {
  uid: string;
  type: FulfillmentLineItemTypeType;
  name: string;
  description: string;
  quantity: number;
  stock_method?: StockMethodType;
  path: string[];
  order_number?: number;
  uid_order?: string;
  uid_delivery?: string | null;
  uid_collection?: string | null;
  quantity_order?: number;
  path_substituted_for?: string[];
}
```

### `FulfillmentSchema`

```ts
const FulfillmentSchema: z.ZodType<Fulfillment>;
```

## `@cfs/core/schemas/organization`

### `CreateOrganizationInput`

Input schema for creating an organization.

```ts
const CreateOrganizationInput: z.ZodType<CreateOrganizationInputType>;
```

### `CreateOrganizationInputType`

Input schema for POST /organizations.
crms_id and xero_id are obtained from external APIs — not in input.

```ts
interface CreateOrganizationInputType {
  uid: string;
  name: string;
  tax_profile: TaxProfileType;
  billing_address: AddressType | null;
  contacts?: OrganizationContactType[];
  newContacts?: NewContactInputType[] | null;
  emails?: string[];
  phones?: string[];
}
```

### `NewContactInput`

Zod schema for new contact data submitted inline with an organization.

```ts
const NewContactInput: z.ZodType<NewContactInputType>;
```

### `NewContactInputType`

New contact data submitted inline when creating/updating an organization.

```ts
interface NewContactInputType {
  uid: string;
  emails?: string[];
  phones?: string[];
}
```

### `Organization`

Full organization document schema (Firestore document shape).

```ts
interface Organization {
  uid: string;
  name: string;
  crms_id: number;
  xero_id: string | null;
  tax_profile: TaxProfileType;
  description?: string;
  emails: string[];
  phones: string[];
  billing_address: AddressType | null;
  contacts: OrganizationContactType[];
  query_by_contacts: string[];
  last_order?: FirestoreTimestampType | null;
  uid_thread?: string;
  version: number;
  created_by: ActorRefType;
  updated_by: ActorRefType;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}
```

### `OrganizationContact`

Zod schema for a contact reference embedded in an organization.

```ts
const OrganizationContact: z.ZodType<OrganizationContactType>;
```

### `OrganizationContactType`

Contact reference embedded in an organization document.
`name` is the server-derived display string (see `deriveName` in common.ts).

```ts
interface OrganizationContactType {
  uid: string;
  name: string;
  roles: string[];
}
```

### `OrganizationSchema`

Zod schema for a full organization Firestore document.

```ts
const OrganizationSchema: z.ZodType<Organization>;
```

### `UpdateOrganizationInput`

Input schema for updating an organization.

```ts
const UpdateOrganizationInput: z.ZodType<UpdateOrganizationInputType>;
```

### `UpdateOrganizationInputType`

Input schema for PUT /organizations/:uid — partial update.

```ts
interface UpdateOrganizationInputType {
  uid?: string;
  name?: string;
  tax_profile?: TaxProfileType;
  description?: string;
  billing_address?: AddressType | null;
  contacts?: OrganizationContactType[];
  newContacts?: NewContactInputType[] | null;
  emails?: string[];
  phones?: string[];
  version: number;
}
```

## `@cfs/core/schemas/out-of-service`

### `CreateOutOfServiceInput`

Zod schema for CreateOutOfServiceInput.

```ts
const CreateOutOfServiceInput: z.ZodType<CreateOutOfServiceInputType>;
```

### `CreateOutOfServiceInputType`

Input for creating an out-of-service record.

```ts
interface CreateOutOfServiceInputType {
  uid_product: string;
  reason: OOSReasonType;
  quantity: number;
  dates: typeLiteral;
  sources?: DocSourceType[];
  stores?: OOSStore[];
  crms_id?: number | null;
  crms_stock_level_id?: number | null;
}
```

### `OOSBreakdown`

Per-phase quantity breakdown — sum equals top-level `quantity`.

```ts
interface OOSBreakdown {
  draft: number;
  planned: number;
  active: number;
  blocked: number;
  written_off: number;
  returned_to_service: number;
}
```

### `OOSBreakdownSchema`

Zod schema for OOSBreakdown.

```ts
const OOSBreakdownSchema: z.ZodType<OOSBreakdown>;
```

### `OOSDates`

Date object — booking-style start/end with paired Firestore timestamps.

`start` is nullable for `draft` records (operator composing) and `planned`
records (scheduled maintenance with no pinned start instant). Once the
record reaches `active`, `start` should be set (writer enforces).

```ts
interface OOSDates {
  start: string | null;
  start_fs: FirestoreTimestampType | null;
  end: string | null;
  end_fs: FirestoreTimestampType | null;
}
```

### `OOSStatusEnum`

Zod schema for OOSStatusType.

```ts
const OOSStatusEnum: z.ZodType<OOSStatusType>;
```

### `OOSStatusType`

Allowed out-of-service statuses. Server-derived from breakdown + number + canceled_at; only "canceled" is operator-set.

```ts
type OOSStatusType = indexedAccess;
```

### `OOSStore`

A store affected by an out-of-service record.

```ts
interface OOSStore {
  uid_store: string;
  name: string;
  default: boolean;
  quantity: number;
  locations: OOSStoreLocation[];
}
```

### `OOSStoreLocation`

A location within a store affected by an out-of-service record.

```ts
interface OOSStoreLocation {
  uid_location: string;
  name: string;
  quantity: number;
  transactionQuantity: number;
  default: boolean;
  max?: number | null;
}
```

### `OOSTransaction`

A transaction entry within an out-of-service record.

```ts
interface OOSTransaction {
  crms_id?: number | null;
  crms_quarantine_id?: number | null;
  crms_stock_level_id?: number | null;
  crms_stock_level_uid?: string;
  date: string;
  date_fs: FirestoreTimestampType;
  quantity: number;
  source: DocSourceType;
  type: OOSTransactionTypeType;
}
```

### `OOSTransactionTypeEnum`

Zod schema for OOSTransactionTypeType.

```ts
const OOSTransactionTypeEnum: z.ZodType<OOSTransactionTypeType>;
```

### `OOSTransactionTypeType`

Allowed types for an `OOSTransaction`. Terminal types match the breakdown
keys 1:1 — a transaction with `type === "written_off"` and `quantity === N`
corresponds to `breakdown.written_off += N`.

```ts
type OOSTransactionTypeType = indexedAccess;
```

### `OutOfService`

An out-of-service record tracking inventory removed from active service.

```ts
interface OutOfService {
  uid: string;
  uid_product: string;
  number: number;
  reason: OOSReasonType;
  status: OOSStatusType;
  quantity: number;
  breakdown: OOSBreakdown;
  canceled_at: FirestoreTimestampType | null;
  organization: typeLiteral | null;
  dates: OOSDates;
  sources: DocSourceType[];
  query_by_sources: string[];
  crms_id?: number | null;
  crms_stock_level_id?: number | null;
  stores: OOSStore[];
  query_by_uid_store: string[];
  query_by_uid_location: string[];
  transactions?: OOSTransaction[];
  uid_thread?: string;
  version: number;
  created_by: ActorRefType;
  updated_by: ActorRefType;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}
```

### `OutOfServiceSchema`

Zod schema for OutOfService.

```ts
const OutOfServiceSchema: z.ZodType<OutOfService>;
```

### `UpdateOutOfServiceInput`

Zod schema for UpdateOutOfServiceInput.

```ts
const UpdateOutOfServiceInput: z.ZodType<UpdateOutOfServiceInputType>;
```

### `UpdateOutOfServiceInputType`

Input for updating an out-of-service record.

`breakdown` (when supplied) must be the complete next state — the writer
enforces `sum(breakdown) === quantity`. `status` is server-derived; only
`"canceled"` is honored from the client and translated into
`canceled_at = now()`.

`dates.start` is honored on update only when the record has no sources
(`sources.length === 0` — manually created / ad-hoc). Source-bound records
(booking PUT or order check-in lineage) reject `dates.start` updates with a
400 — the start there reflects a real ledger event recorded by the upstream
writer, and operator-side drift would desync the OOS from the source's
audit trail.

```ts
interface UpdateOutOfServiceInputType {
  status?: OOSStatusType;
  breakdown?: OOSBreakdown;
  dates?: typeLiteral;
  stores?: OOSStore[];
  version: number;
}
```

## `@cfs/core/schemas/password-reset`

### `PasswordReset`

Full Firestore document for a single-use password reset token.

```ts
interface PasswordReset {
  user_id: string;
  email: string;
  expiresAt: FirestoreTimestampType;
  created_at: number;
}
```

### `PasswordResetSchema`

Zod schema for PasswordReset.

```ts
const PasswordResetSchema: z.ZodType<PasswordReset>;
```

## `@cfs/core/schemas/product`

### `AuthoredComponentSchema`

Schema for an authored `components` entry — {@link ComponentSchema} with
`inclusion_type` required.

**Storage only.** `CreateProductInput` / `UpdateProductInput` deliberately keep
`ComponentSchema`, so a client may omit `inclusion_type` and the WRITER fills
`"default"` — the reading `crmsProduct.ts` and manager's new-component form
already take. Requiring it at the boundary instead would 400 any client that
has not been rebuilt, and manager is pinned several betas back on purpose
(manager#265). Normalize at the writer, guard at storage: no undefined can
reach a stored document either way, which is what the expanders need.

```ts
const AuthoredComponentSchema: z.ZodType<AuthoredProductComponent>;
```

### `AuthoredProductComponent`

A component product within a parent product — the entry in `components`.

Identical to {@link ProductComponent} except that `inclusion_type` is
**required**, and that difference is the point. Both expanders
(`buildOrderComponentLines` in manager, and the staged-add path) filter
`=== "mandatory" || === "default"`, so an `undefined` here is a silent fourth
bucket whose component is dropped from every order it should have joined.

The optionality it replaces existed to accommodate `component_of`, where the
field genuinely is not authored — and it leaked onto the authored side, where
it is a bug. Splitting the two is what lets this side be required. Prod
carries 0 undefined rows across 165 `components` entries on 63 products, so
this is hardening with a zero-row backfill; writers with no answer pass
`"default"`, the reading `crmsProduct.ts` and manager's new-component form
already take.

NOT expressed as `.default("default")`: `validateBeforeWrite` validates but
writes the RAW doc, so a schema default never materializes and the field would
still be written absent.

```ts
interface AuthoredProductComponent {
  inclusion_type: InclusionTypeType;
}
```

### `ComponentSchema`

Schema for a `component_of` back-reference. `inclusion_type` is optional here
because the parent authors it — see {@link ProductComponent}.

A catalog component is a line item in waiting: `COMPONENT_TYPES` is a subset
of `DOC_LINE_ITEM_TYPES` (pinned by a compile-time assertion in `common.ts`),
and every component that survives expansion becomes an order line of the same
`type`. So it answers to the same contract, and the rental ⇒
`price.replacement_cents` rule is stated once rather than a third time here.

```ts
const ComponentSchema: z.ZodType<ProductComponent>;
```

### `CreateProductInput`

Input schema for creating a product.

```ts
const CreateProductInput: z.ZodType<CreateProductInputType>;
```

### `CreateProductInputType`

Input type for creating a product.

```ts
interface CreateProductInputType {
  uid: string;
  name: string;
  active: boolean;
  type: ProductTypeType;
  stock_method: StockMethodType;
  component_only: boolean;
  description: string;
  eligible_delivery: boolean;
  eligible_in_store_pickup: boolean;
  eligible_shipping_ground: boolean;
  eligible_shipping_air: boolean;
  price: typeLiteral;
  shipping?: typeLiteral;
  alternates?: UidNameRefType[];
  components?: ProductComponent[];
  component_of?: ProductComponent[];
  tags?: UidNameRefType[];
  uid_tracking_category?: string | null;
  uid_linked_rental?: string | null;
  uid_linked_replacement?: string | null;
  webshop: typeLiteral;
  transaction?: typeLiteral;
}
```

### `Product`

A product document in the products Firestore collection.

```ts
interface Product {
  uid: string;
  name: string;
  active: boolean;
  type: ProductTypeType;
  stock_method: StockMethodType;
  component_only: boolean;
  crms_id: number | null;
  crms_rate_id?: number | null;
  crms_stock_level_ids?: Record<string, number>;
  crms_linked_rental_id?: number | null;
  crms_linked_replacement_id?: number | null;
  crms_linked_replacement_rate_id?: number | null;
  description?: string;
  eligible_delivery: boolean;
  eligible_in_store_pickup: boolean;
  eligible_shipping_ground: boolean;
  eligible_shipping_air: boolean;
  price: ProductPrice;
  shipping?: ProductShipping;
  alternates: ProductAlternate[];
  components: AuthoredProductComponent[];
  component_of: ProductComponent[];
  tags: UidNameRefType[];
  query_by_tags?: string[];
  query_by_components?: string[];
  query_by_component_of?: string[];
  query_by_alternates?: string[];
  tracking_category_name?: string;
  uid_linked_rental?: string | null;
  uid_linked_replacement?: string | null;
  uid_tracking_category?: string | null;
  webshop: ProductWebshop;
  images?: ProductImage[];
  query_by_images?: string[];
  xero_id: string | null;
  xero_code?: string | null;
  xero_tracking_option_id: string | null;
  uid_thread?: string;
  version: number;
  created_by: ActorRefType;
  updated_by: ActorRefType;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}
```

### `ProductAlternate`

An alternate product reference.

```ts
interface ProductAlternate {
  uid: string;
  name: string;
}
```

### `ProductComponent`

A product reference in `component_of` — the RECIPROCAL back-reference naming a
parent this product is a component of.

Deliberately the reduced shape: the relationship attributes
(`inclusion_type`, `zero_priced`, `active`, `description`) describe how the
PARENT includes this product and are authored on the parent's own
`components` entry, which is the authoritative side. Prod agrees — across 141
`component_of` rows on 91 products, exactly one carries any of them
(measured 2026-07-29), against 165/165 on `components`.

```ts
interface ProductComponent {
  uid: string;
  path: string[];
  name: string;
  active?: boolean;
  type: ComponentTypeType;
  stock_method: StockMethodType;
  crms_id: number | null;
  crms_accessory_id?: number | null;
  description?: string;
  inclusion_type?: InclusionTypeType;
  quantity: number;
  zero_priced?: boolean;
  price: typeLiteral;
}
```

### `ProductImage`

One product photo. Array order is display order and `images[0]` is the
primary image — there is deliberately no `sort` or `is_primary` field, so
there is only one thing to disagree with.

Row identity is `uuid`, the original upload. It never changes (background
removal is additive: it fills `uuid_cutout` and leaves the original intact),
so it is the value `DELETE|PATCH /products/{uid}/images/{image_id}` carries.
That is why this array member has no `crypto.randomUUID()` `uid` — the
convention exists for members with no natural key, and this one has one.

Display rule everywhere: `img.uuid_cutout ?? img.uuid`.

```ts
interface ProductImage {
  uuid: string;
  uuid_cutout: string | null;
  alt: string | null;
  width: number | null;
  height: number | null;
}
```

### `ProductPrice`

Pricing details for a product.

```ts
interface ProductPrice {
  base_cents: number;
  replacement_cents?: number | null;
  coa_revenue?: COARevenueType;
  taxes: TaxRefType[];
  formula: PriceFormulaType;
  discountable: boolean;
}
```

### `ProductSchema`

Zod schema for a Product document.

```ts
const ProductSchema: z.ZodType<Product>;
```

### `ProductShipping`

Shipping dimensions and hazard classification for a product.

The four dimensions are nullable: `null` is "not measured yet", which `0`
could not express. See the storage schema for why the distinction is
load-bearing (core#51).

```ts
interface ProductShipping {
  weight: number | null;
  height: number | null;
  width: number | null;
  length: number | null;
  air_hazardous: boolean;
  air_un: number | null;
}
```

### `ProductWebshop`

Webshop availability and description for a product.

```ts
interface ProductWebshop {
  available: boolean;
  description?: string | null;
}
```

### `UpdateProductInput`

Input schema for updating a product.

```ts
const UpdateProductInput: z.ZodType<UpdateProductInputType>;
```

### `UpdateProductInputType`

Input type for updating a product.

```ts
interface UpdateProductInputType {
  uid: string;
  name?: string;
  active?: boolean;
  type?: ProductTypeType;
  stock_method?: StockMethodType;
  component_only?: boolean;
  description?: string;
  eligible_delivery?: boolean;
  eligible_in_store_pickup?: boolean;
  eligible_shipping_ground?: boolean;
  eligible_shipping_air?: boolean;
  price?: typeLiteral;
  shipping?: typeLiteral;
  alternates?: UidNameRefType[];
  components?: ProductComponent[];
  component_of?: ProductComponent[];
  tags?: UidNameRefType[];
  uid_tracking_category?: string | null;
  uid_linked_rental?: string;
  uid_linked_replacement?: string;
  webshop?: typeLiteral;
  version: number;
}
```

### `deriveProductImageUuids(images: readonly typeLiteral[] | undefined): string[]`

Derive `query_by_images` from `images` — each row's `uuid` followed by its
`uuid_cutout` when set, walking `images` in order.

The single source of the denormalization, called by every writer. Defined here
rather than in `utils/products.ts` because the schema needs it and the import
direction is strictly utils → schemas; `@cfs/core/utils/products` re-exports
it, which is where writers should import from (same shape as `deriveName`).

**Ordered, but not an ordering source.** The emitted array follows `images`
row order — it costs nothing (one pass either way) and a mirror that tracks
the display array is easier to eyeball in the console than an arbitrary one.
But `images` remains the sole authority on display order: this field exists
for Firestore `array-contains`, and the refinement below compares it as a
multiset, so a differently-ordered mirror holding the same uuids is still
valid. Nothing may read order back out of it.

## `@cfs/core/schemas/public-stock-summary`

### `PublicStockSummary`

Window-independent, public-safe availability inputs for one product.

```ts
interface PublicStockSummary {
  uid: string;
  uid_product: string;
  type: ProductTypeType;
  quantity_held: number;
  unavailable: PublicUnavailableEntry[];
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}
```

### `PublicStockSummarySchema`

Zod schema for PublicStockSummary.

```ts
const PublicStockSummarySchema: z.ZodType<PublicStockSummary>;
```

### `PublicUnavailableEntry`

One anonymous unavailable interval — a booking or an OOS record, indistinguishable.

```ts
interface PublicUnavailableEntry {
  start: string | null;
  start_fs: FirestoreTimestampType | null;
  end: string | null;
  end_fs: FirestoreTimestampType | null;
  quantity: number;
}
```

## `@cfs/core/schemas/recurrence`

### `CreateRecurrenceInput`

Zod schema for creating a recurrence.

```ts
const CreateRecurrenceInput: z.ZodType<CreateRecurrenceInputType>;
```

### `CreateRecurrenceInputType`

Input for POST /recurrences.

```ts
interface CreateRecurrenceInputType {
  uid_list: string;
  status?: RecurrenceStatus;
  rule: RecurrenceRuleType;
  active_from: string;
  active_until?: string | null;
  horizon_days?: number | null;
  prototype: typeLiteral;
}
```

### `Recurrence`

Recurrence Firestore document shape.

```ts
interface Recurrence {
  uid: string;
  uid_list: string;
  status: RecurrenceStatus;
  rule: RecurrenceRuleType;
  active_from: string;
  active_until: string | null;
  horizon_through: string | null;
  horizon_days: number | null;
  exception_dates: string[];
  prototype: RecurrencePrototypeType;
  version: number;
  created_by: ActorRefType;
  updated_by: ActorRefType;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}
```

### `RecurrenceFreq`

RFC 5545 FREQ value.

```ts
type RecurrenceFreq = indexedAccess;
```

### `RecurrenceFreqEnum`

Zod schema for RecurrenceFreq.

```ts
const RecurrenceFreqEnum: z.ZodType<RecurrenceFreq>;
```

### `RecurrencePrototype`

Zod schema for the recurrence prototype.

```ts
const RecurrencePrototype: z.ZodType<RecurrencePrototypeType>;
```

### `RecurrencePrototypeType`

The card prototype — fields that materialize verbatim into each instance
card unless per-instance `recurrence_overrides` pin them. Mirrors
`CreateCardInputType` minus `uid_list`, `position`, and `date`
(those live on the Recurrence root since they're series-level concerns).

```ts
interface RecurrencePrototypeType {
  subject: string;
  body: CommentBodyJson | null;
  body_text: string;
  status: CardStatus;
  destination: DocDestinationEndpointType | null;
  sources: DocSourceType[];
  attachments: CardAttachmentType[];
  uid_assignees: string[];
  locked: CardLockKey[];
}
```

### `RecurrenceRule`

Zod schema for a recurrence rule.

```ts
const RecurrenceRule: z.ZodType<RecurrenceRuleType>;
```

### `RecurrenceRuleType`

RFC 5545 / rrule-temporal-aligned recurrence rule. Each field maps
directly to a rrule-temporal constructor option — see
https://jsr.io/@gsphw/rrule-temporal.

```ts
interface RecurrenceRuleType {
  freq: RecurrenceFreq;
  interval: number;
  byweekday: RecurrenceWeekday[] | null;
  bymonthday: number[] | null;
  bymonth: number[] | null;
  bysetpos: number[] | null;
  count: number | null;
  until: string | null;
}
```

### `RecurrenceSchema`

Zod schema for a Recurrence Firestore document.

```ts
const RecurrenceSchema: z.ZodType<Recurrence>;
```

### `RecurrenceStatus`

Recurrence lifecycle.
- `active` — nightly materializer rolls the horizon forward; prototype
  edits fan out to existing instances (respecting per-card overrides).
- `paused` — materializer skips; existing instances remain untouched.
  Use for temporary holds ("no deliveries this month").
- `archived` — materializer skips; instances remain but the recurrence
  is hidden from the settings UI.

```ts
type RecurrenceStatus = indexedAccess;
```

### `RecurrenceStatusEnum`

Zod schema for RecurrenceStatus.

```ts
const RecurrenceStatusEnum: z.ZodType<RecurrenceStatus>;
```

### `RecurrenceWeekday`

RFC 5545 BYDAY value (two-letter weekday code).

```ts
type RecurrenceWeekday = indexedAccess;
```

### `RecurrenceWeekdayEnum`

Zod schema for RecurrenceWeekday.

```ts
const RecurrenceWeekdayEnum: z.ZodType<RecurrenceWeekday>;
```

### `UpdateRecurrenceInput`

Zod schema for updating a recurrence.

```ts
const UpdateRecurrenceInput: z.ZodType<UpdateRecurrenceInputType>;
```

### `UpdateRecurrenceInputType`

Input for PATCH /recurrences/:uid — all fields optional. Prototype
field patches fan out to existing instance cards at the service layer
(skipping cards whose `recurrence_overrides` pin the field).

```ts
interface UpdateRecurrenceInputType {
  uid_list?: string;
  status?: RecurrenceStatus;
  rule?: RecurrenceRuleType;
  active_from?: string;
  active_until?: string | null;
  horizon_days?: number | null;
  prototype?: typeLiteral;
  version: number;
}
```

## `@cfs/core/schemas/credit-note`

CreditNote document schema — Firestore collection: `credit-notes`

The **value instrument**: a credit issued to an organization, with lines, tax,
a number and a remaining balance. Where it gets *applied* is not stored here —
an allocation is a `settlements` document, and `where("uid_credit_note","==",uid)`
is an ordinary query. Three of the four platforms surveyed (TigerBeetle, Odoo,
Xero) make the allocation its own record; the one that doesn't, ERPNext, is the
one whose seam is its documented failure source.

**A first-class collection, not an invoice variant.** `Invoice` carries a
`query_by_orders` min-1 + destinations refine a credit note has no analogue
for, the Xero push targets a different endpoint, and `Discount.amount` is
`.min(0)` with sign-naive item math — so Odoo's positive-amount-with-a-type
trick would mean threading a direction sign through `calculateItemSubtotal`
and `getTaxTotals`. Against ~4 notes a year, a union would make all 962
invoices carry credit-note columns.

**`credit-notes`, not `credits`.** Both fit the kebab-case-plural convention,
but `credit` is the most overloaded word in this space — it is the
double-entry *side*, it is TigerBeetle's `credits_pending`/`credits_posted`,
and it is the accounting sense throughout `chart-of-accounts`. A collection
called `credits` would collide head-on with the ledger vocabulary the moment
CFS owns its ledger, which is the stated destination.

**Organization-scoped, not contact-scoped.** Xero's model is contact-scoped,
but CFS has no contact-scoped billing document and every invoice carries the
denormalized `organization` block. A contact-scoped document could not reuse
it and would lose the `organization.name` Typesense sort.

### `COA_BAD_DEBT`

Xero's Bad Debt account. The one posting account a `reason` determines.

```ts
const COA_BAD_DEBT: 6900;
```

### `CREDIT_NOTE_REASONS`

Why this credit was issued — the `credit` arm of {@link SETTLEMENT_CONTRACTS},
**derived rather than re-listed**, so the document and the settlements it
spawns can never offer different reasons.

The reason lives on the *document* and is denormalized onto each settlement:
one credit note allocated across three invoices has one reason, and authoring
it three times invites three answers.

```ts
const CREDIT_NOTE_REASONS: readonly SettlementReasonType[];
```

### `CreditNote`

A credit note issued to an organization.

```ts
interface CreditNote {
  uid: string;
  number: number;
  status: CreditNoteStatusType;
  reason: SettlementReasonType;
  date: string;
  date_fs: FirestoreTimestampType;
  reference: string | null;
  external_notes?: string | null;
  internal_notes?: string | null;
  organization: typeLiteral;
  tax_profile: TaxProfileType;
  items: CreditNoteDocLineItem[];
  totals: CreditNoteDocTotals;
  remaining_credit_cents: number;
  sources: DocSourceType[];
  query_by_sources: string[];
  xero_credit_note_id: string | null;
  uid_thread?: string;
  version: number;
  created_by: ActorRefType;
  updated_by: ActorRefType;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}
```

### `CreditNoteDocItemPrice`

Pricing breakdown for a single credit-note line.

```ts
interface CreditNoteDocItemPrice {
  base_cents: number;
  base_percent?: number | null;
  chargeable_days: number | null;
  formula: PriceFormulaType;
  subtotal_cents: number;
  subtotal_discounted_cents: number;
  discount: DiscountType | null;
  taxes: PriceModifierType[];
  total_cents: number;
}
```

### `CreditNoteDocLineItem`

A credited line.

**`coa_revenue` is required, not optional.** A credit spanning lines with
different revenue accounts (#1689 hits 4000 and 4100; #1322 is all 4210)
cannot be posted correctly from a document-level amount, and apportioning it
afterwards is inferring cause from effect — the thing `transaction.ts` warns
against. This is also the gap Xero *has*: its allocation view carries
`LineItems: []`, and Odoo's users pay OCA for a module that adds line-level
provenance.

**No dividers.** A credit note has no destinations and bills no orders, so the
whole `ORDER_ITEM_LEVELS` / `INVOICE_ITEM_LEVELS` hierarchy — and the `path`
machinery that goes with it — has nothing to organize here. Lines are flat.

## `coa_revenue` and `coa_posting` are TWO facts, and a line has both

They are routinely different, and collapsing them loses real information.
Measured on the live tenant: CN-1009 writes off 35 lines whose products are
rentals — `product.price.coa_revenue` 4000 Rental Income — and every one of
them posts to **6900 Bad Debt**. Store only the posting account and the
revenue attribution that tracking-category rollups and the tax tables depend
on is gone; store only the revenue account and the write-off is invisible.

- **`coa_revenue`** — the revenue account of the *thing being credited*.
  Product-sourced, same vocabulary as the invoice line it mirrors, and the
  input to {@link isTaxableCoa}. Never the account the credit posts to.
- **`coa_posting`** — where this credit lands in the ledger. Any account in
  the `chart-of-accounts` catalog, including the expense range, which is
  exactly why it cannot be `COARevenueEnum`: that enum is shared with
  `Product.price.coa_revenue`, and widening it would make a catalog product
  whose revenue account is Bad Debt Expense representable.

```ts
interface CreditNoteDocLineItem {
  uid: string;
  type: DocLineItemTypeType;
  name: string;
  description: string;
  quantity: number;
  price: CreditNoteDocItemPrice;
  coa_revenue: COARevenueType | null;
  coa_posting: number;
  tracking_category: string | null;
  xero_id: string | null;
  xero_tracking_option_id: string | null;
  uid_invoice_item: string | null;
}
```

### `CreditNoteDocLineItem`

Zod schema for a credit-note line item.

```ts
const CreditNoteDocLineItem: z.ZodType<CreditNoteDocLineItem>;
```

### `CreditNoteDocTotals`

Credit-note totals.

Integer cents, matching `items[]` and matching the `settlements` journal the
allocations are drawn into. **This document used to be dollars end to end**
while the journal beside it was already cents — a split that was recorded as
an intentional boundary and was in fact just drift, and which meant the 2dp
census had never evaluated this corpus at all.

**No `transaction_fees`.** A card-processing fee is charged when money is
taken, not when it is given back; crediting one is an `order_adjustment` line,
not a fee row.

```ts
interface CreditNoteDocTotals {
  subtotal_cents: number;
  subtotal_discounted_cents: number;
  discount_amount_cents: number;
  taxes: PriceModifierType[];
  total_cents: number;
}
```

### `CreditNoteSchema`

Zod schema for a CreditNote.

```ts
const CreditNoteSchema: z.ZodType<CreditNote>;
```

### `CreditNoteStatusEnum`

Zod schema for CreditNoteStatusType.

```ts
const CreditNoteStatusEnum: z.ZodType<CreditNoteStatusType>;
```

### `CreditNoteStatusType`

Allowed credit-note statuses.

```ts
type CreditNoteStatusType = indexedAccess;
```

### `deriveCreditPostingAccount(reason: SettlementReasonType, coaRevenue: number | null): number | null`

Where a credit line posts, from the two facts that decide it.

**Bad debt is not a revenue reversal, and that is the whole rule.** The money
*was* owed — the sale stands — and the write-off moves it to Bad Debt so it
can be written off: `DR 6900 / CR A/R`. Everything else is a return or an
allowance, where the customer never owed the money and the revenue itself is
reversed: `DR <the line's own revenue account> / CR A/R`. `early_return` is
the clearest case of the second kind.

**New notes derive this; history does not obey it.** Of the 12 notes in the
live tenant, 8 agree and 4 are miscodings the owner has ruled historic rather
than sanctioned — CN-1007 books a bad-debt write-off to 4210 (revenue), and
CN-1010/1011/1012 book a customer credit to 6000 General Operating Expenses
on a free-text line whose `TaxType` is `INPUT`, a *purchase* tax type on a
receivable. CFS stores the corrected account and leaves Xero alone; the
divergence is recorded as a comment on the note's thread, and
`audit-credit-note-posting.ts` reports it. Xero still holds the original, so
nothing is lost by correcting.

That is also why `coa_posting` is STORED rather than derived on read: the
stored value is what CFS asserts, this function is what CFS intends, and an
audit comparing them against Xero is a real guard precisely because the three
come from different places. Deriving on read would make the check a
restatement of its own oracle.

`correction` is deliberately absent: it is bidirectional — an operator may be
adding a credit they missed or removing one that never happened — so its
posting depends on what is being corrected. Callers must supply it.

**Returns** — the account code, or `null` when the rule has no opinion.

## `@cfs/core/schemas/session`

### `Session`

Full session document schema (Firestore document shape).
Note: expiresAt kept in camelCase for Firestore TTL policy.

```ts
interface Session {
  id: string;
  user_id: string;
  anonymous: boolean;
  expiresAt: FirestoreTimestampType;
  created_at: number;
  user_agent: string;
  preview_role?: string;
}
```

### `SessionSchema`

Zod schema for Session.

```ts
const SessionSchema: z.ZodType<Session>;
```

## `@cfs/core/schemas/settlement`

Settlement document schema — Firestore collection: `settlements`

One settlement event against an invoice. **The revenue-side twin of the
`transactions` movement journal**: append-only, dated, reversible, and
type-blind by design — a cash payment and a credit-note allocation differ
only in `type` and `reason`.

CFS puts event journals in collections and value-detail in arrays. `items[]`
is detail; movements are events; a settlement is an event. `transaction.ts`
draws the boundary from the other side — *"cost is cost only, never revenue —
customer-facing money lives in Xero"* — so the shape is the model and revenue
is exactly what it excludes. This is that missing half.

**APPEND-ONLY.** Nothing is edited or deleted; a correction is a NEW document
carrying `reverses`. There is deliberately no `status` field, for the same
reason `Movement` has none: a status flag *and* a reverser link is two sources
of truth. The one permitted mutation in the whole design is
`linkSettlementToXero` (api-cloudrun `src/lib/settlements.ts`) writing
`xero_payment_id` null → value once — late-binding external linkage is not
part of the money fact.

The invoice's `totals.{amount_paid, amount_credited, amount_due}` are a
**co-written projection** of this log, produced only by
`recomputeSettlementTotals` and rebuildable from it. That is CFS v2's shape —
an event log plus a client-ready projection for snapshot listeners — arriving
early in one domain, and it is `transactions` + `stock-summaries` for money.

### `Settlement`

One settlement event against an invoice.

```ts
interface Settlement {
  uid: string;
  uid_invoice: string;
  uid_organization: string;
  type: SettlementTypeType;
  reason: SettlementReasonType;
  amount_cents: number;
  date: string;
  date_fs: FirestoreTimestampType;
  reference: string | null;
  uid_session: string;
  reverses: string | null;
  uid_credit_note: string | null;
  number_credit_note: string | null;
  xero_payment_id: string | null;
  xero_credit_note_id: string | null;
  synced_at: FirestoreTimestampType | null;
  legacy_payment_uid: string | null;
  version: number;
  created_by: ActorRefType;
  updated_by: ActorRefType;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}
```

### `SettlementSchema`

Zod schema for a Settlement.

```ts
const SettlementSchema: z.ZodType<Settlement>;
```

## `@cfs/core/schemas/stock-summary`

### `StockSummary`

Window-independent availability inputs for one product. Doc id == `uid` ==
`uid_product` == the product's / inventory-ledger's Firestore id.

```ts
interface StockSummary {
  uid: string;
  uid_product: string;
  type: ProductTypeType;
  quantity_held: number;
  bookings: StockSummaryBookingEntry[];
  out_of_service: StockSummaryOOSEntry[];
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}
```

### `StockSummaryBookingEntry`

A live (non-complete) booking as an interval + its breakdown. `end`/`end_fs`
null = open-ended (see the module note — this is the sale case).

```ts
interface StockSummaryBookingEntry {
  uid: string;
  number: number;
  start: string | null;
  start_fs: FirestoreTimestampType | null;
  end: string | null;
  end_fs: FirestoreTimestampType | null;
  breakdown: BookingBreakdown;
  type: ComponentTypeType;
}
```

### `StockSummaryOOSEntry`

A non-terminal out-of-service record as an interval + its quantity.

```ts
interface StockSummaryOOSEntry {
  uid: string;
  start: string | null;
  start_fs: FirestoreTimestampType | null;
  end: string | null;
  end_fs: FirestoreTimestampType | null;
  quantity: number;
  reason: OOSReasonType;
  status: OOSStatusType;
}
```

### `StockSummarySchema`

Zod schema for StockSummary.

```ts
const StockSummarySchema: z.ZodType<StockSummary>;
```

## `@cfs/core/schemas/store`

### `CreateStoreInput`

Input schema for creating a store.

```ts
const CreateStoreInput: z.ZodType<CreateStoreInputType>;
```

### `CreateStoreInputType`

Input type for creating a store.

```ts
interface CreateStoreInputType {
  uid: string;
  name: string;
  crms_store_id: number;
  default?: boolean;
}
```

### `Store`

A store document in Firestore.

```ts
interface Store {
  uid: string;
  name: string;
  default: boolean;
  default_location: UidNameRefType | null;
  crms_store_id: number;
  version: number;
  active: boolean;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}
```

### `StoreSchema`

Zod schema for Store.

```ts
const StoreSchema: z.ZodType<Store>;
```

### `UpdateStoreInput`

Input schema for updating a store.

```ts
const UpdateStoreInput: z.ZodType<UpdateStoreInputType>;
```

### `UpdateStoreInputType`

Input type for updating a store.

```ts
interface UpdateStoreInputType {
  uid: string;
  name?: string;
  crms_store_id?: number;
  default?: boolean;
  active?: boolean;
  version: number;
}
```

## `@cfs/core/schemas/tag`

### `CreateTagInput`

Input schema for creating a tag.

```ts
const CreateTagInput: z.ZodType<CreateTagInputType>;
```

### `CreateTagInputType`

Input type for creating a tag.

```ts
interface CreateTagInputType {
  uid?: string;
  name: string;
}
```

### `DeleteTagInput`

Input schema for deleting a tag.

```ts
const DeleteTagInput: z.ZodType<DeleteTagInputType>;
```

### `DeleteTagInputType`

Input type for deleting a tag.

```ts
interface DeleteTagInputType {
  uid: string;
}
```

### `Tag`

A tag document in Firestore.

```ts
interface Tag {
  uid: string;
  name: string;
  count?: number;
  products?: UidNameRefType[];
  query_by_products?: string[];
  version: number;
  created_by: ActorRefType;
  updated_by: ActorRefType;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}
```

### `TagSchema`

Zod schema for Tag.

```ts
const TagSchema: z.ZodType<Tag>;
```

### `UpdateTagInput`

Input schema for updating a tag.

```ts
const UpdateTagInput: z.ZodType<UpdateTagInputType>;
```

### `UpdateTagInputType`

Input type for updating a tag.

```ts
interface UpdateTagInputType {
  uid: string;
  name: string;
  version: number;
}
```

## `@cfs/core/schemas/tracking-category`

### `CreateTrackingCategoryInput`

Input schema for creating a tracking category.

```ts
const CreateTrackingCategoryInput: z.ZodType<CreateTrackingCategoryInputType>;
```

### `CreateTrackingCategoryInputType`

Input type for creating a tracking category.

```ts
interface CreateTrackingCategoryInputType {
  uid: string;
  name: string;
  crms_product_group_id: number;
  crms_product_group_name: string;
}
```

### `TrackingCategory`

A tracking category document in Firestore.

```ts
interface TrackingCategory {
  uid: string;
  name: string;
  count?: number;
  crms_product_group_id?: number;
  crms_service_group_id?: number;
  crms_product_group_name: string;
  products: Record<string, UidNameRefType>;
  xero_tracking_option_id: string | null;
  version: number;
  created_by: ActorRefType;
  updated_by: ActorRefType;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}
```

### `TrackingCategorySchema`

Zod schema for TrackingCategory.

```ts
const TrackingCategorySchema: z.ZodType<TrackingCategory>;
```

### `UpdateTrackingCategoryInput`

Input schema for updating a tracking category.

```ts
const UpdateTrackingCategoryInput: z.ZodType<UpdateTrackingCategoryInputType>;
```

### `UpdateTrackingCategoryInputType`

Input type for updating a tracking category.

```ts
interface UpdateTrackingCategoryInputType {
  uid: string;
  name: string;
  version: number;
}
```

## `@cfs/core/schemas/transaction`

Movement document schema — Firestore collection: `transactions`

An append-only journal of inventory movement. Every event is **one subject**
(a booking for custody events, a product for ownership events) plus a set of
signed lines, grouped with its siblings by a client-minted `uid_session`.

The collection keeps its name — the journal was migrated in place — but the
document is a `Movement`, not the old current-state `Transaction`.

## Three axes

Each answers an independent question about the same physical unit:

| Axis       | Question                              | Lands on                                  |
|------------|---------------------------------------|-------------------------------------------|
| `custody`  | How far through this order is it?     | `booking.breakdown` — the seven keys      |
| `lines[]`  | Where is it in the warehouse?         | `locations.products[]`; `quantity_held`   |
| `cost`     | What is it carried at on the books?   | `inventory-ledgers.total_cost_basis`      |

`cost` is **cost only, never revenue** — customer-facing money lives in Xero;
the only money here is inventory's carrying value.

`custody` and `lines` are correlated but not derivable from each other:
custody implies the *kind* of place a unit is in ({@link CUSTODY_PLACE_KINDS})
but not *which* location, because where a returning unit goes back to is an
operator's choice.

## Conservation is structural, not checked

A line's contribution to `quantity_held` is
`(location.to ? +q : 0) + (location.from ? −q : 0)` — no cross-line
summation. `{from: null, to: L3}` reads "entered ownership at L3";
`{from: L3, to: null}` reads "left ownership from L3"; both non-null is a
move that leaves ownership untouched. A half-move is inexpressible.

`lines: []` means **nothing physically moved** — a `prep`, where reserved and
prepped units sit on the same shelf, or a cost-only adjustment.

### `CUSTODY_PLACE_KINDS`

**Location is a total function**: every owned unit is in exactly one kind of
place, determined by its custody key. Consumed by the balance checker (rule 2)
and by every writer, so the mapping exists once.

`out` is the one key whose place depends on the booking: a rental's units sit
at the booking until they come back, a sale's units left ownership at the
point of sale and are nowhere.

```ts
const CUSTODY_PLACE_KINDS: Readonly<Record<BookingBreakdownKeyType, readonly PlaceKindType[]>>;
```

### `CreateStoreTransferInput`

Input schema for a store-to-store transfer.

One event, not the old `transfer_increase` + `transfer_decrease` pair:
`location: {from, to}` says what two documents used to. `total_cost` is gone —
a transfer nets to zero on ownership, so it has no cost object to mis-gate,
which is what made #286 possible.

```ts
const CreateStoreTransferInput: z.ZodType<CreateStoreTransferInputType>;
```

### `CreateStoreTransferInputType`

Input for creating a store-to-store transfer.

```ts
interface CreateStoreTransferInputType {
  uid_product: string;
  quantity: number;
  date: string;
  reference: string;
  uid_session: string;
  from: MovementAllocationInputType[];
  to: MovementAllocationInputType[];
  serialized_details?: typeLiteral | null;
}
```

### `CreateTransactionInput`

Input schema for creating a manual movement.

`uid` is gone: the document id is derived (`{uid_session}|{type}|{subject}`),
which is what makes a retried create idempotent instead of appending a second
event. `allocations` is optional — absent means the server allocates.

```ts
const CreateTransactionInput: z.ZodType<CreateTransactionInputType>;
```

### `CreateTransactionInputType`

Input for creating a manual movement.

```ts
interface CreateTransactionInputType {
  uid_product: string;
  type: indexedAccess;
  quantity: number;
  total_cost_cents: number;
  date: string;
  reference: string;
  uid_session: string;
  allocations?: MovementAllocationInputType[];
  serialized_details?: typeLiteral | null;
}
```

### `MOVEMENT_CONTRACTS`

The per-kind line contract, one entry per {@link MOVEMENT_TYPES} member.

```ts
const MOVEMENT_CONTRACTS: Readonly<Record<MovementTypeType, MovementContract>>;
```

### `MOVEMENT_TYPES`

Every kind of movement, as ONE classifier. There is deliberately no second
`kind` field: `type` is required in a strict object and drives
{@link getTransactionMultiplier}, so a document can never be half-classified.

Grouped by which axes the type carries — see {@link MOVEMENT_CONTRACTS}, which
is the machine-readable form of the same grouping.

**Removed in the journal migration**, all with zero stored instances in prod
AND dev, unreachable from `MANUAL_TRANSACTION_TYPES` and
{@link getDisplayTransactionTypes}: `acquisition`, `disposal`,
`partial_disposal`, `depreciation_tax`, `depreciation_gaap`. They were the
only unclassified branch, which is why `getTransactionMultiplier` used to
throw — a live 500 waiting on a type nothing could produce.

Asset depreciation IS on the roadmap. When it lands:
  - **`depreciation` wants to be ONE type with a `book` field** on the cost
    object, not `depreciation_tax` + `depreciation_gaap`. As types they double
    every future cost-only event; as a field the book is one dimension.
    The movement shape already exists: `lines: []` + a negative `cost`, the
    same shape a late landed-cost adjustment uses.
  - **`disposal` wants to come back as its own type**, even though `write_off`
    already covers the mechanics (`out-of-service → null` + `cost`). Finance
    reporting a "disposals" line has to tell a disposal from a damage
    write-off, and inferring that from "is there an OOS record in `sources[]`"
    is inferring cause from effect — the same reason a refund is a credit-note
    link and not a `total_cost > 0` test.
  - `acquisition` and `partial_disposal` do NOT come back: the first is
    `purchase`, and the second is a `disposal` whose quantity is less than
    what's held. Quantity already says it.

`transfer_increase` / `transfer_decrease` collapsed into a single
{@link MOVEMENT_CONTRACTS} `transfer`: they existed only because one row could
not say "out of A, into B", which `location: {from, to}` now says. The
migration rewrites the stored pairs.

```ts
const MOVEMENT_TYPES: "prep" | "check_out" | "check_in" | "mark_damaged" | "mark_lost" | "sale" | "sale_return" | "opening_balance" | "purchase" | "find" | "make" | "adjustment_increase" | "adjustment_decrease" | "trade_in" | "write_off" | "transfer"[];
```

### `Movement`

A movement-journal event.

```ts
interface Movement {
  uid: string;
  number: number;
  uid_product: string;
  uid_booking: string | null;
  type: MovementTypeType;
  quantity: number;
  custody: MovementCustodyType | null;
  cost: MovementCostType | null;
  lines: MovementLineType[];
  date: string;
  date_fs: FirestoreTimestampType;
  reference: string;
  uid_session: string;
  reverses: string | null;
  sources: DocSourceType[];
  query_by_sources: string[];
  query_by_uid_store: string[];
  query_by_uid_location: string[];
  serialized_details: typeLiteral | null;
  version: number;
  created_by: ActorRefType;
  updated_by: ActorRefType;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}
```

### `MovementAllocationInput`

Zod schema for one requested placement.

```ts
const MovementAllocationInput: z.ZodType<MovementAllocationInputType>;
```

### `MovementAllocationInputType`

One requested placement of `quantity` units. Direction-agnostic on purpose:
{@link MOVEMENT_CONTRACTS} decides whether it lands on `location.from` or
`location.to`, so the client never has to know which way a type moves.

```ts
interface MovementAllocationInputType {
  uid_location: string;
  quantity: number;
}
```

### `MovementContract`

How the three axes may be filled for one movement type.

Fixing this per type is what makes a missing axis a validation error rather
than a silent zero, a stray axis a validation error, and reversal a pure
negate-every-line transform. It is `hasCosts(type)` generalized to all three
axes.

`custody: "with_booking"` — required exactly when `uid_booking` is set. Sales
are the only types that legitimately happen both ways: 247 stored rows are
order-sourced (a booking's units being sold), and the manual transaction form
lets an operator key an off-the-shelf sale with no order at all.

```ts
interface MovementContract {
  custody: "required" | "forbidden" | "with_booking";
  cost: "required" | "forbidden";
  places: typeLiteral | null;
  booking: "required" | "forbidden" | "optional";
}
```

### `MovementCost`

Zod schema for a cost change.

```ts
const MovementCost: z.ZodType<MovementCostType>;
```

### `MovementCostType`

The carrying-value change this event records. `amount_cents` is signed:
negative removes basis, positive adds it. `unit_costs_cents[]` carries the
per-unit basis actually consumed or added, which the weighted-average cost
fold reads.

⚠️ **`unit_cost` sits between two `_cents` fields and is NOT one of them.**
It is a per-unit **rate** at 4dp, and quantizing it to the cent is a measured
regression, not a hypothetical: `@cfs/core@10.0.0-beta.117` emitted it
through `fromCentsBig` and a 100-unit $6.39 purchase reported $0.06/unit — a
6% error that went a week undetected because every movement written in that
window happened to divide evenly at the cent. A mechanical "convert every
money field in this object" pass restores it exactly.

```ts
interface MovementCostType {
  amount_cents: number;
  unit_cost: number;
  unit_costs_cents: number[];
}
```

### `MovementCustody`

Zod schema for a custody transition.

```ts
const MovementCustody: z.ZodType<MovementCustodyType>;
```

### `MovementCustodyType`

The custody transition this event records, as a pair of breakdown keys.

Named `custody` and deliberately NOT `status` or `state`: `Booking` already
has a `status` field (`draft/quoted/reserved/part-prepped/prepped/active/
complete`) that is a different thing from a breakdown key, and the two enums
share several words — `status: {from: "prepped"}` would misread as
`booking.status`.

A side may be `null` for a one-sided transition: an order edit that changes
the booking's own quantity moves units into or out of the breakdown without a
matching opposite key.

```ts
interface MovementCustodyType {
  from: BookingBreakdownKeyType | null;
  to: BookingBreakdownKeyType | null;
}
```

### `MovementLine`

Zod schema for one movement line.

```ts
const MovementLine: z.ZodType<MovementLineType>;
```

### `MovementLineType`

One physical movement of `quantity` units between two places.

A `null` side means "outside CFS ownership". Both sides non-null is a move
that leaves `quantity_held` untouched.

Note `lines[]` is NOT directly queryable — Firestore `array-contains` works on
scalar arrays, not nested object fields. Query paths come from the flat
`query_by_*` denorms.

```ts
interface MovementLineType {
  quantity: number;
  location: typeLiteral;
}
```

### `MovementSchema`

Zod schema for a Movement.

```ts
const MovementSchema: z.ZodType<Movement>;
```

### `MovementTypeEnum`

Zod schema for MovementTypeType.

```ts
const MovementTypeEnum: z.ZodType<MovementTypeType>;
```

### `MovementTypeType`

Union of all movement type string literals.

```ts
type MovementTypeType = indexedAccess;
```

### `PLACE_KINDS`

The kinds of place a unit can be in. `"outside"` is the absence of a place —
a `null` side of `location`, meaning outside CFS ownership entirely.

```ts
const PLACE_KINDS: "locations" | "bookings" | "out-of-service" | "outside"[];
```

### `PlaceKindType`

One kind of place a unit can occupy.

```ts
type PlaceKindType = indexedAccess;
```

### `ReverseTransactionInput`

Input schema for reversing a movement. The reversal negates every line of the
event it names; nothing else is client-supplied, so a reversal cannot silently
disagree with what it reverses.

```ts
const ReverseTransactionInput: z.ZodType<ReverseTransactionInputType>;
```

### `ReverseTransactionInputType`

Input for reversing a movement.

```ts
interface ReverseTransactionInputType {
  uid_session: string;
  reference: string;
  date?: string;
}
```

### `UpdateTransactionInput`

Input schema for editing a movement's descriptive fields.

```ts
const UpdateTransactionInput: z.ZodType<UpdateTransactionInputType>;
```

### `UpdateTransactionInputType`

Input for editing a movement's descriptive fields.

**Balance-affecting fields are absent by design.** Quantity, type, cost,
placement and date change through a reversal plus a corrected event, not an
in-place edit — that is what makes the collection a journal rather than a
mutable table. Only `reference` still edits in place.

```ts
interface UpdateTransactionInputType {
  reference: string;
  version: number;
}
```

### `getDisplayTransactionTypes(increaseOnly?: boolean): MovementTypeType[]`

Movement types suitable for the manual transaction form.

**Derived from {@link MANUAL_MOVEMENT_TYPES}, which is what
`CreateTransactionInput` validates against — so the picker cannot offer a type
the API rejects.** It used to re-derive the set independently from
`MOVEMENT_CONTRACTS`, and the two disagreed: `sale_return` has no *required*
booking, so it passed that filter and reached the manager's type picker, while
the input schema refused it. An operator picking it got a 400. (core#41)

The one remaining asymmetry is deliberate and runs the safe way:
`opening_balance` is *accepted* by the input but hidden here, because it is
minted at product creation rather than keyed. Hiding an accepted type costs
nothing; offering a rejected one is a dead end in the UI.

When `increaseOnly` is true, returns only types that add stock — for the first
transaction on a product.

### `getTransactionMultiplier(type: MovementTypeType): 1 | -1 | 0`

Returns +1 for movements that increase owned quantity, -1 for those that
decrease it, and 0 for those that leave it untouched (a `transfer`, a
custody-only fulfillment step, a cost-only adjustment).

**Total** — it cannot throw. The financial-only types that used to make it
partial are gone; see {@link MOVEMENT_TYPES}. Derived from the contract so it
cannot drift from it.

### `hasCosts(type: MovementTypeType): boolean`

Whether a movement type carries a cost object. Derived from the contract.

## `@cfs/core/schemas/user`

### `CreateUserInput`

Input schema for creating a user (internal — not exposed as a public route).

```ts
const CreateUserInput: z.ZodType<CreateUserInputType>;
```

### `CreateUserInputType`

Payload for creating a user — used internally by the accept-invite flow.

```ts
interface CreateUserInputType {
  email: string;
  password: string;
  roles?: string[];
  uid_contact?: string | null;
}
```

### `DisplaySort`

Sort configuration for a display preference (column + direction).

```ts
interface DisplaySort {
  column: string | null;
  direction: "asc" | "desc";
}
```

### `FirestoreDisplayPrefs`

User display preferences for a Firestore-backed collection view.

```ts
interface FirestoreDisplayPrefs {
  columns: string[];
  filters: Record<string, parenthesized[]>;
  sort: DisplaySort;
}
```

### `TypesenseDisplayPrefs`

User display preferences for a Typesense-backed collection view.

`group` and `facet` were removed here alongside
{@linkcode TypesenseDisplayDefaults} — both were written on every save and
read by nothing. This object is **strict**, so a blob still carrying them
fails to parse; the write path does not validate (`updateUser` merges and
`transaction.set`s), so nothing breaks at runtime, but
`scripts/audit-schema-validation.ts --only=users` will report it. Both
environments held `{}` when this landed, so there was nothing to migrate.

```ts
interface TypesenseDisplayPrefs {
  columns: string[];
  filters: Record<string, parenthesized[]>;
  sort: DisplaySort;
}
```

### `UpdateUserInput`

Input schema for updating a user.

```ts
const UpdateUserInput: z.ZodType<UpdateUserInputType>;
```

### `UpdateUserInputType`

Payload for PUT /users/:uid — full-doc replace; server-managed fields excluded.

```ts
interface UpdateUserInputType {
  email?: string;
  uid_contact?: string | null;
  version: number;
  prefs_firestore?: Record<string, FirestoreDisplayPrefs>;
  prefs_typesense?: Record<string, TypesenseDisplayPrefs>;
}
```

### `User`

Full user document schema (Firestore document shape).

```ts
interface User {
  uid: string;
  email: string;
  name: string;
  password_hash: string;
  email_verified: boolean;
  uid_contact?: string | null;
  roles?: string[];
  token_version?: number;
  version: number;
  prefs_firestore: Record<string, FirestoreDisplayPrefs>;
  prefs_typesense: Record<string, TypesenseDisplayPrefs>;
  deleted_at?: FirestoreTimestampType | null;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}
```

### `UserSchema`

Zod schema for a full user Firestore document.

```ts
const UserSchema: z.ZodType<User>;
```

## `@cfs/core/schemas/webshop-product`

### `WebshopProduct`

A webshop product document in the webshop-products Firestore collection.

```ts
interface WebshopProduct {
  uid: string;
  name: string;
  active: boolean;
  type: WebshopProductTypeType;
  stock_method?: StockMethodType;
  component_only?: boolean;
  description?: string;
  eligible_delivery: boolean;
  eligible_in_store_pickup: boolean;
  eligible_shipping_ground: boolean;
  eligible_shipping_air: boolean;
  price: typeLiteral;
  shipping?: WebshopProductShipping;
  alternates: UidNameRefType[];
  components: WebshopProductComponent[];
  component_of: WebshopProductComponent[];
  tags?: UidNameRefType[];
  query_by_tags?: string[];
  query_by_components?: string[];
  query_by_component_of?: string[];
  query_by_alternates?: string[];
  webshop: typeLiteral;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}
```

### `WebshopProductComponent`

A component product within a webshop parent product.

```ts
interface WebshopProductComponent {
  uid: string;
  path: string[];
  name: string;
  active?: boolean;
  type: ComponentTypeType;
  stock_method?: StockMethodType;
  description?: string;
  inclusion_type?: InclusionTypeType;
  quantity: number;
  zero_priced?: boolean;
  price: typeLiteral;
}
```

### `WebshopProductSchema`

Zod schema for a WebshopProduct document.

```ts
const WebshopProductSchema: z.ZodType<WebshopProduct>;
```

### `WebshopProductShipping`

Shipping dimensions and hazard classification for a webshop product.

```ts
interface WebshopProductShipping {
  weight?: number | null;
  height?: number | null;
  width?: number | null;
  length?: number | null;
  air_hazardous?: boolean;
  air_un?: number | null;
}
```

## `@cfs/core/schemas/typesense`

### `BookingDocument`

Typesense document type for bookings.

```ts
interface BookingDocument {
  id: string;
  uid: string;
  uid_product: string;
  uid_order: string;
  number: number;
  number_str?: string;
  crms_id?: number;
  crms_id_str?: string;
  crms_product_id?: number;
  crms_product_id_str?: string;
  status: string;
  type: string;
  name: string;
  subject?: string;
  organization: typeLiteral;
  breakdown: typeLiteral;
  quantity: number;
  shortage?: number;
  total_price_cents?: number;
  unit_price_cents?: number;
  dates: typeLiteral;
  destinations?: typeLiteral;
  stores?: Array<typeLiteral>;
  uid_destination_delivery?: string;
  uid_destination_collection?: string;
  created_at?: number;
  updated_at: number;
}
```

### `ChartOfAccountsDocument`

Typesense document type for chart of accounts.

```ts
interface ChartOfAccountsDocument {
  id: string;
  uid: string;
  name: string;
  code: number;
  code_str?: string;
  type: string;
  description?: string;
  created_by?: TypesenseActorRef;
  updated_by?: TypesenseActorRef;
  updated_at: number;
}
```

### `CommentDocument`

Typesense document type for comments.

```ts
interface CommentDocument {
  id: string;
  uid: string;
  uid_thread: string;
  sources: Array<typeLiteral>;
  body_text: string;
  created_by: TypesenseActorRef;
  updated_by?: TypesenseActorRef;
  deleted_by?: TypesenseActorRef;
  deleted_at?: number;
  created_at: number;
  updated_at?: number;
}
```

### `ContactDocument`

Typesense document type for contacts.

```ts
interface ContactDocument {
  id: string;
  uid: string;
  name: string;
  first_name: string;
  middle_name?: string;
  last_name?: string;
  pronunciation?: string;
  crms_id?: number;
  crms_id_str?: string;
  emails: string[];
  phones: string[];
  organizations?: Array<typeLiteral>;
  created_by?: TypesenseActorRef;
  updated_by?: TypesenseActorRef;
  created_at?: number;
  updated_at: number;
}
```

### `CreditNoteDocument`

Typesense document type for credit notes.

```ts
interface CreditNoteDocument {
  id: string;
  uid: string;
  number: number;
  number_str?: string;
  status: string;
  reason: string;
  tax_profile: string;
  reference?: string;
  external_notes?: string;
  internal_notes?: string;
  organization: typeLiteral;
  items?: Array<typeLiteral>;
  totals?: typeLiteral;
  remaining_credit_cents?: number;
  remaining_credit_cents_str?: string;
  xero_credit_note_id?: string;
  created_by?: TypesenseActorRef;
  updated_by?: TypesenseActorRef;
  date_fs: number;
  created_at?: number;
  updated_at?: number;
}
```

### `DestinationDocument`

Typesense document type for destinations.

```ts
interface DestinationDocument {
  id: string;
  uid: string;
  mapbox_ids: string[];
  address?: TypesenseAddressFields;
  organizations?: Array<typeLiteral>;
  products?: Array<typeLiteral>;
  contacts?: Array<typeLiteral>;
  created_at?: number;
  updated_at: number;
}
```

### `FulfillmentDocument`

Typesense document type for the sanitized fulfillment order view.

Mirrors `OrderDocument` but strips pricing, totals, tax profile,
invoice refs, CRM/Xero ids, and financial line-item fields.

```ts
interface FulfillmentDocument {
  id: string;
  uid: string;
  number: number;
  number_str?: string;
  status: string;
  deliveries?: boolean;
  pickups?: boolean;
  subject?: string;
  reference?: string;
  organization: typeLiteral;
  dates: typeLiteral;
  destinations: Array<typeLiteral>;
  items?: Array<typeLiteral>;
  created_at?: number;
  updated_at: number;
}
```

### `GroupByAxis`

Describes how a client should enumerate the keys a groupBy axis produces.

- `enum` — keys come from the Zod enum at `field` (e.g. card status).
- `collectionFeed` — keys come from a live Firestore collection (e.g. one
  section per list); `collection` names the source.
- `dateBucket` — keys are computed client-side from the row's date value;
  no separate per-key query.

A single "None" / ungrouped axis is represented with `field: null` and no
`kind` — the axis lists which *groupings are available*, and "no grouping"
is always one of them.

```ts
interface GroupByAxis {
  field: string | null;
  label: string;
  kind?: "enum" | "collectionFeed" | "dateBucket";
  collection?: string;
}
```

### `GroupByAxisSchema`

Zod schema for GroupByAxis.

```ts
const GroupByAxisSchema: z.ZodType<GroupByAxis>;
```

### `InvoiceDocument`

Typesense document type for invoices.

```ts
interface InvoiceDocument {
  id: string;
  uid: string;
  number: number;
  number_str?: string;
  crms_id?: number;
  crms_id_str?: string;
  status: string;
  tax_profile: string;
  number_orders?: number[];
  number_orders_str?: string[];
  subject?: string;
  reference?: string;
  external_notes?: string;
  internal_notes?: string;
  organization: typeLiteral;
  items?: Array<typeLiteral>;
  totals?: typeLiteral;
  crms_opportunity_ids?: number[];
  xero_id?: string;
  created_by?: TypesenseActorRef;
  updated_by?: TypesenseActorRef;
  date_fs: number;
  due_date_fs?: number;
  created_at?: number;
  updated_at?: number;
}
```

### `LocationDocument`

Typesense document type for locations.

```ts
interface LocationDocument {
  id: string;
  uid: string;
  name: string;
  uid_store: string;
  active: boolean;
  default?: boolean;
  uid_location_type?: string;
  products?: Array<typeLiteral>;
  product_capacities?: Array<typeLiteral>;
  created_at: number;
  updated_at?: number;
}
```

### `OrderDocument`

Typesense document type for orders.

```ts
interface OrderDocument {
  id: string;
  uid: string;
  number: number;
  number_str?: string;
  crms_id?: number;
  crms_id_str?: string;
  status: string;
  tax_profile: string;
  deliveries?: boolean;
  pickups?: boolean;
  subject?: string;
  reference?: string;
  crms_status?: string;
  invoices?: Array<typeLiteral>;
  organization: typeLiteral;
  dates: typeLiteral;
  destinations: Array<typeLiteral>;
  totals: typeLiteral;
  items?: Array<typeLiteral>;
  created_at?: number;
  updated_at: number;
}
```

### `OrganizationDocument`

Typesense document type for organizations.

```ts
interface OrganizationDocument {
  id: string;
  uid: string;
  name: string;
  description?: string;
  crms_id: number;
  crms_id_str?: string;
  xero_id?: string;
  tax_profile: string;
  emails?: string[];
  phones?: string[];
  billing_address: TypesenseAddressFields;
  contacts: Array<typeLiteral>;
  created_by?: TypesenseActorRef;
  updated_by?: TypesenseActorRef;
  last_order?: number;
  created_at?: number;
  updated_at: number;
}
```

### `OutOfServiceDocument`

Typesense document type for out-of-service records.

```ts
interface OutOfServiceDocument {
  id: string;
  uid: string;
  uid_product: string;
  number: number;
  number_str?: string;
  reason: string;
  status: string;
  quantity: number;
  breakdown: typeLiteral;
  organization?: typeLiteral;
  dates: typeLiteral;
  stores?: Array<typeLiteral>;
  canceled_at?: number;
  created_at?: number;
  updated_at: number;
}
```

### `ProductDocument`

Typesense document type for products.

```ts
interface ProductDocument {
  id: string;
  uid: string;
  name: string;
  description?: string;
  tracking_category_name?: string;
  type: string;
  stock_method: string;
  active: boolean;
  component_only: boolean;
  eligible_delivery?: boolean;
  eligible_in_store_pickup?: boolean;
  eligible_shipping_ground?: boolean;
  eligible_shipping_air?: boolean;
  price?: typeLiteral;
  webshop?: typeLiteral;
  alternates?: Array<typeLiteral>;
  crms_id?: number;
  crms_id_str?: string;
  uid_tracking_category?: string;
  uid_linked_replacement?: string;
  uid_linked_rental?: string;
  xero_id?: string;
  xero_tracking_option_id?: string;
  crms_rate_id?: number;
  crms_linked_rental_id?: number;
  crms_linked_replacement_id?: number;
  crms_linked_replacement_rate_id?: number;
  shipping?: typeLiteral;
  tags?: Array<typeLiteral>;
  components?: ProductDocumentComponent[];
  component_of?: ProductDocumentComponent[];
  crms_stock_level_ids?: number[];
  images?: string[];
  created_by?: TypesenseActorRef;
  updated_by?: TypesenseActorRef;
  updated_at: number;
  created_at?: number;
}
```

### `ProductDocumentComponent`

Typesense document type for a product component entry.

```ts
interface ProductDocumentComponent {
  uid?: string;
  path?: string[];
  name?: string;
  quantity?: number;
  active?: boolean;
  type?: string;
  stock_method?: string;
  crms_id?: number;
  crms_accessory_id?: number;
  description?: string;
  inclusion_type?: string;
  zero_priced?: boolean;
  price?: typeLiteral;
}
```

### `QUERY_BY_PREFIX`

Prefix marking a **Firestore reverse-index mirror** — a denormalized flat
array (`query_by_sources`, `query_by_components`, …) that exists purely so
Firestore can `array-contains` a value it cannot reach inside an object array.

Typesense CAN query inside a nested array, so the mirror is redundant there
and is deleted from every document on the way to the index.

```ts
const QUERY_BY_PREFIX: "query_by_";
```

### `SEARCH_PERMISSION_BY_ALIAS`

```ts
const SEARCH_PERMISSION_BY_ALIAS: Partial<Record<TypesenseAlias, Permission>>;
```

### `StoreDocument`

Typesense document type for stores.

```ts
interface StoreDocument {
  id: string;
  uid: string;
  name: string;
  default: boolean;
  active: boolean;
  default_location?: typeLiteral;
  crms_store_id: number;
  crms_store_id_str?: string;
  created_at: number;
  updated_at?: number;
}
```

### `TagDocument`

Typesense document type for tags.

```ts
interface TagDocument {
  id: string;
  uid: string;
  name: string;
  count: number;
  products?: Array<typeLiteral>;
  created_by?: TypesenseActorRef;
  updated_by?: TypesenseActorRef;
  updated_at: number;
}
```

### `TemplateComponentDocument`

Typesense document type for template-component families.

```ts
interface TemplateComponentDocument {
  id: string;
  uid: string;
  git_path: string;
  name: string;
  uid_active?: string;
  version_count: number;
  version: number;
  created_at: number;
  updated_at: number;
}
```

### `TemplateDocument`

Typesense document type for templates.

```ts
interface TemplateDocument {
  id: string;
  uid: string;
  uid_template: string;
  name: string;
  collection_source: string;
  collection_target: string;
  scope: string;
  version: number;
  version_str?: string;
  source_filename?: string;
  created_at: number;
  updated_at: number;
}
```

### `TrackingCategoryDocument`

Typesense document type for tracking categories.

```ts
interface TrackingCategoryDocument {
  id: string;
  uid: string;
  name: string;
  crms_product_group_name: string;
  count: number;
  crms_product_group_id?: number;
  crms_product_group_id_str?: string;
  crms_service_group_id?: number;
  crms_service_group_id_str?: string;
  xero_tracking_option_id?: string;
  products?: Array<typeLiteral>;
  created_by?: TypesenseActorRef;
  updated_by?: TypesenseActorRef;
  updated_at: number;
}
```

### `TypesenseAddressFields`

Shared address fields used across Typesense document types.

Coordinates are stored as `[latitude, longitude]` geopoints.
The API translates Firestore `{latitude, longitude}` objects into this format.

```ts
interface TypesenseAddressFields {
  full?: string;
  name?: string;
  city?: string;
  region?: string;
  street?: string;
  street2?: string;
  postcode?: string;
  country_name?: string;
  mapbox_id?: string;
  address_coordinates?: [number, number];
  user_coordinates?: [number, number];
}
```

### `TypesenseAlias`

Union of all Typesense collection alias names.

```ts
type TypesenseAlias = "bookings" | "cards" | "chart-of-accounts" | "comments" | "contacts" | "destinations" | "invoices" | "credit-notes" | "locations" | "orders" | "fulfillments" | "organizations" | "out-of-service" | "products" | "stores" | "tags" | "templates" | "template-components" | "threads" | "tracking-categories" | "users" | "webshop-products";
```

### `TypesenseCollectionConfig`

Full collection config with alias, version, and Firestore mapping.

```ts
interface TypesenseCollectionConfig {
  alias: string;
  version: number;
  firestoreCollection: string;
  collectionName: string;
  schema: TypesenseSchema;
  synonyms: TypesenseSynonym[];
  displayDefaults: TypesenseDisplayDefaults;
  enabled?: boolean;
}
```

### `TypesenseCollectionConfigSchema`

Zod schema for TypesenseCollectionConfig.

```ts
const TypesenseCollectionConfigSchema: z.ZodType<TypesenseCollectionConfig>;
```

### `TypesenseDisplayDefaults`

Display defaults for a Typesense collection in the UI.

**`facet` and `group` used to sit here and were write-only.** Both were
carried into every saved prefs blob by manager's `buildTypesensePrefs` and
read back by nothing — measured 2026-08-09: `typesenseDisplayDefaults` is read
in three places, all for `columns` or `filters`.

`facet: string[]` is easy to mistake for Typesense's own faceting. It is not:
that is {@linkcode TypesenseField.facet}, a per-field boolean on the index
schema, which is load-bearing. This was a list of field NAMES — the facet
analogue of `columns`, meaning "which filters does this collection open with".
The filter bar was built on a different mechanism (`getFilters()` derives what
is *offered* from `TypesenseField.facet` + a covering column; the sibling
`filters` key holds what is *active*), so it never acquired a reader.

Because the object is strict and both keys were required, all 22 collections
had to declare them, 21 of them `facet: []` purely to satisfy the type — and
an entry inside a field nothing reads is unfalsifiable. `cards` named
`uid_list` there and carried a comment asserting the facet UI resolved it to a
list name; no such resolution existed anywhere (core#50).

Deleted rather than left empty, so a future entry cannot be inert: with the
key gone every reference is a compile error. Re-adding either is ~2 lines the
day something actually renders it.

```ts
interface TypesenseDisplayDefaults {
  columns: string[];
  filters: Record<string, parenthesized[]>;
  sort: typeLiteral;
  groupBy?: GroupByAxis[];
}
```

### `TypesenseDisplayDefaultsSchema`

Zod schema for TypesenseDisplayDefaults.

```ts
const TypesenseDisplayDefaultsSchema: z.ZodType<TypesenseDisplayDefaults>;
```

### `TypesenseDocument`

Union of all Typesense document types.

```ts
type TypesenseDocument = BookingDocument | ChartOfAccountsDocument | CommentDocument | ContactDocument | DestinationDocument | InvoiceDocument | CreditNoteDocument | LocationDocument | OrderDocument | FulfillmentDocument | OrganizationDocument | OutOfServiceDocument | ProductDocument | StoreDocument | TagDocument | TemplateDocument | TemplateComponentDocument | TrackingCategoryDocument | UserDocument | WebshopProductDocument;
```

### `TypesenseDocumentMap`

Map from collection alias to its document type.

```ts
interface TypesenseDocumentMap {
  bookings: BookingDocument;
  chart-of-accounts: ChartOfAccountsDocument;
  comments: CommentDocument;
  contacts: ContactDocument;
  destinations: DestinationDocument;
  invoices: InvoiceDocument;
  credit-notes: CreditNoteDocument;
  locations: LocationDocument;
  orders: OrderDocument;
  fulfillments: FulfillmentDocument;
  organizations: OrganizationDocument;
  out-of-service: OutOfServiceDocument;
  products: ProductDocument;
  stores: StoreDocument;
  tags: TagDocument;
  templates: TemplateDocument;
  template-components: TemplateComponentDocument;
  tracking-categories: TrackingCategoryDocument;
  users: UserDocument;
  webshop-products: WebshopProductDocument;
}
```

### `TypesenseField`

A single field definition in a Typesense collection schema.

```ts
interface TypesenseField {
  name: string;
  type: TypesenseFieldType;
  sort?: boolean;
  stem?: boolean;
  facet?: boolean;
  index?: boolean;
  optional?: boolean;
  money?: boolean;
}
```

### `TypesenseFieldSchema`

Zod schema for TypesenseField.

```ts
const TypesenseFieldSchema: z.ZodType<TypesenseField>;
```

### `TypesenseFieldType`

Field type in a Typesense collection schema.

```ts
type TypesenseFieldType = indexedAccess;
```

### `TypesenseFieldTypeEnum`

Zod schema for TypesenseFieldType.

```ts
const TypesenseFieldTypeEnum: z.ZodType<TypesenseFieldType>;
```

### `TypesenseMultiWaySynonym`

A multi-way synonym where all terms are interchangeable.

```ts
interface TypesenseMultiWaySynonym {
  id: string;
  synonyms: string[];
}
```

### `TypesenseMultiWaySynonymSchema`

Zod schema for TypesenseMultiWaySynonym.

```ts
const TypesenseMultiWaySynonymSchema: z.ZodType<TypesenseMultiWaySynonym>;
```

### `TypesenseOneWaySynonym`

A one-way synonym where a root term expands to alternatives.

```ts
interface TypesenseOneWaySynonym {
  id: string;
  root: string;
  synonyms: string[];
}
```

### `TypesenseOneWaySynonymSchema`

Zod schema for TypesenseOneWaySynonym.

```ts
const TypesenseOneWaySynonymSchema: z.ZodType<TypesenseOneWaySynonym>;
```

### `TypesenseSchema`

The schema portion passed to the Typesense collections API.

```ts
interface TypesenseSchema {
  name: string;
  enable_nested_fields?: boolean;
  token_separators?: string[];
  fields: TypesenseField[];
  default_sorting_field?: string;
}
```

### `TypesenseSchemaSchema`

Zod schema for TypesenseSchema.

```ts
const TypesenseSchemaSchema: z.ZodType<TypesenseSchema>;
```

### `TypesenseSynonym`

A synonym rule for a Typesense collection.

```ts
type TypesenseSynonym = TypesenseMultiWaySynonym | TypesenseOneWaySynonym;
```

### `TypesenseSynonymSchema`

Zod schema for TypesenseSynonym.

```ts
const TypesenseSynonymSchema: z.ZodType<TypesenseSynonym>;
```

### `UserDocument`

Typesense document type for users.

```ts
interface UserDocument {
  id: string;
  uid: string;
  email: string;
  name: string;
  first_name: string;
  middle_name?: string;
  last_name?: string;
  pronunciation?: string;
  roles?: string[];
  email_verified: boolean;
  uid_contact?: string;
  created_at?: number;
  updated_at: number;
}
```

### `WebshopProductDocument`

Typesense document type for webshop products.

```ts
interface WebshopProductDocument {
  id: string;
  uid: string;
  name: string;
  description?: string;
  type: string;
  stock_method?: string;
  active: boolean;
  component_only?: boolean;
  eligible_delivery?: boolean;
  eligible_in_store_pickup?: boolean;
  eligible_shipping_ground?: boolean;
  eligible_shipping_air?: boolean;
  price: typeLiteral;
  webshop: typeLiteral;
  alternates?: Array<typeLiteral>;
  shipping?: typeLiteral;
  tags?: Array<typeLiteral>;
  components?: WebshopProductDocumentComponent[];
  component_of?: WebshopProductDocumentComponent[];
  updated_at?: number;
  created_at?: number;
}
```

### `WebshopProductDocumentComponent`

Typesense document type for a webshop product component entry.

```ts
interface WebshopProductDocumentComponent {
  uid?: string;
  path?: string[];
  name?: string;
  quantity?: number;
  active?: boolean;
  type?: string;
  stock_method?: string;
  description?: string;
  inclusion_type?: string;
  zero_priced?: boolean;
  price?: typeLiteral;
}
```

### `bookings`

Typesense collection config for bookings.

```ts
const bookings: TypesenseCollectionConfig;
```

### `cards`

```ts
const cards: TypesenseCollectionConfig;
```

### `chartOfAccounts`

Typesense collection config for chart of accounts.

```ts
const chartOfAccounts: TypesenseCollectionConfig;
```

### `comments`

Typesense collection config for comments.

```ts
const comments: TypesenseCollectionConfig;
```

### `contacts`

Typesense collection config for contacts.

```ts
const contacts: TypesenseCollectionConfig;
```

### `creditNotes`

Typesense collection config for credit notes.

`number` is the `default_sorting_field` and is stored bare — `CN-` is
presentation only. A prefixed string number would make this field a string
and break the sort outright, which is the concrete reason the schema stores an
int rather than a display label.

There is deliberately **no `settlements` collection here**: settlements are
reached by query (`where("uid_invoice","==",…)`), not by search, and a journal
with no free-text field has nothing to match on.

```ts
const creditNotes: TypesenseCollectionConfig;
```

### `destinations`

Typesense collection config for destinations.

```ts
const destinations: TypesenseCollectionConfig;
```

### `fulfillments`

Typesense collection config for the sanitized fulfillment order view.

Mirrors `orders` by uid but strips all pricing, totals, tax profile,
invoice refs, CRM/Xero ids, and financial line-item fields. The default
sort is `number` (non-optional, always set) because Typesense rejects
optional fields as default_sorting_field; the fulfillment UI overrides
this at query time via `displayDefaults.sort` to order by delivery date.

```ts
const fulfillments: TypesenseCollectionConfig;
```

### `getDefaultSortDirection(alias: string): "asc" | "desc" | null`

Default sort direction for a Typesense collection's default sorting field.
Numeric types (`int32`, `int64`, `float`) sort descending (recent/large
first); everything else sorts ascending. Returns `null` when the collection
has no default sorting field.

### `getDefaultSortingField(alias: string): string | null`

Look up the default sorting field for a Typesense collection. Returns
`null` when the alias is unknown or the config does not declare one.

### `getSearchAlias(collection: string): string | null`

Resolve a Firestore collection name (singular or plural) to its Typesense
alias. Returns `null` when no matching Typesense collection exists.

### `invoices`

Typesense collection config for invoices.

```ts
const invoices: TypesenseCollectionConfig;
```

### `isStrippedAtIndexTime(fieldName: string): boolean`

Is this document key / declared field name removed before it reaches the
index?

**This is the single source of truth for that rule**, imported by BOTH sides:
api-cloudrun's `deleteQueryByFields` (`lib/typesenseTranslate.ts`), which
performs the strip, and `tests/typesenseFieldCoverage.test.ts`, which fails
when a collection declares a field the strip would remove. A restated copy in
either place is a rule that can drift into blessing exactly the declarations
it exists to forbid — and it did: six `query_by_*` fields were declared across
five collections, four of them `facet: true`, and none ever held a value.

**Top-level keys only, matching the strip.** `deleteQueryByFields` iterates
`Object.keys(doc)`, so a nested `sources.query_by_x` survives; a predicate
that tested the whole dotted name would be stricter than the code it stands
in for and would reject a legal declaration.

### `locations`

Typesense collection config for locations.

```ts
const locations: TypesenseCollectionConfig;
```

### `orders`

Typesense collection config for orders.

```ts
const orders: TypesenseCollectionConfig;
```

### `organizations`

Typesense collection config for organizations.

```ts
const organizations: TypesenseCollectionConfig;
```

### `outOfService`

Typesense collection config for out-of-service records.

```ts
const outOfService: TypesenseCollectionConfig;
```

### `products`

Typesense collection config for products.

```ts
const products: TypesenseCollectionConfig;
```

### `stores`

Typesense collection config for stores.

```ts
const stores: TypesenseCollectionConfig;
```

### `tags`

Typesense collection config for tags.

```ts
const tags: TypesenseCollectionConfig;
```

### `templateComponents`

Typesense collection config for template-*component* families (git-canonical
system). Indexes the thin component family doc — identity + rollups, no
content (content lives in git, projected into `templates-versions`, not
indexed here). Backs the components list + the register form's `depends_on`
picker. A component is thinner than a template family: no
source/target/surfaces.

```ts
const templateComponents: TypesenseCollectionConfig;
```

### `templates`

Typesense collection config for template *families* (git-canonical system).

Indexes the thin family doc — identity + rollups, no content. Content lives
in git and is projected into `templates-versions` (not indexed here). Bumped
to v2 when the family shape changed (dropped `scope`/`source`/per-version
fields; added `git_path`/`surfaces`/`uid_active`/rollups).

```ts
const templates: TypesenseCollectionConfig;
```

### `threads`

Typesense collection config for threads.

Reserved slot — threads aren't currently indexed (Phase 1 searches comments
directly; thread-level search can pivot off comment hits). `enabled: false`
so provisioning skips this collection; the schema exists only to keep the
`threads.search` permission mapped in `SEARCH_PERMISSION_BY_ALIAS`.

```ts
const threads: TypesenseCollectionConfig;
```

### `toWireSchema(schema: TypesenseSchema): TypesenseSchema`

The wire form of a collection schema — what actually gets POSTed to
`collections`.

A CFS annotation left on a field would be sent to Typesense as if it were a
field property. Call this at the one place the create-collection body is
built; everywhere else wants the annotated schema.

**Deliberately not used for the reindex schema hash.** The hash covers the
full annotated schema, so adding or removing a `money` marker changes it and
forces a reindex — which is exactly right, because the marker changes what
every `_str` mirror in that collection contains. A hash over the wire form
would call the change a no-op and leave a stale index that no dollar-amount
query could reach.

### `trackingCategories`

Typesense collection config for tracking categories.

```ts
const trackingCategories: TypesenseCollectionConfig;
```

### `typesenseAddressFields(prefix: string, _: unknown): TypesenseField[]`

Generate Typesense field definitions for a nested address object.

Coordinates use the `geopoint` type with `[latitude, longitude]` order.
The API translates Firestore `{latitude, longitude}` objects into this format.

### `typesenseEnabledCollections`

Firestore collection names that are actively synced to Typesense (enabled !== false).

```ts
const typesenseEnabledCollections: Set<string>;
```

### `typesenseSchemas`

All Typesense collection configs keyed by alias.

```ts
const typesenseSchemas: Record<TypesenseAlias, TypesenseCollectionConfig>;
```

### `users`

Typesense collection config for users.

```ts
const users: TypesenseCollectionConfig;
```

### `webshopProducts`

Typesense collection config for webshop products.

```ts
const webshopProducts: TypesenseCollectionConfig;
```

## `@cfs/core/schemas/typesense/cards`

### `cards`

```ts
const cards: TypesenseCollectionConfig;
```

## `@cfs/core/schemas/quote`

### `Quote`

A PDF quote document associated with an order.

```ts
interface Quote {
  uid: string;
  uid_order: string;
  order_number: number;
  version: number | null;
  is_draft: boolean;
  uploadcare_uuid: string | null;
  uploadcare_files?: Array<typeLiteral>;
  deleted_at: FirestoreTimestampType | null;
  expires_at: FirestoreTimestampType | null;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}
```

### `QuoteSchema`

Zod schema for Quote.

```ts
const QuoteSchema: z.ZodType<Quote>;
```

### `RestoreQuoteInput`

Zod schema for RestoreQuoteInput.

```ts
const RestoreQuoteInput: z.ZodType<RestoreQuoteInputType>;
```

### `RestoreQuoteInputType`

Input for restoring a soft-deleted quote.

```ts
interface RestoreQuoteInputType {
  uid: string;
}
```

### `SaveQuoteVersionInput`

Zod schema for SaveQuoteVersionInput.

```ts
const SaveQuoteVersionInput: z.ZodType<SaveQuoteVersionInputType>;
```

### `SaveQuoteVersionInputType`

Input for saving a new quote version.

```ts
interface SaveQuoteVersionInputType {
  uid_order: string;
}
```

## `@cfs/core/schemas/template`

### `FixtureMeta`

A fixture manifest entry — the operator-facing label/description for one
git-canonical fixture (`fixtures/<git_path>/<slug>.json`). Files are
authoritative: discovery globs the directory; this manifest only enriches
the manager list with labels. An orphaned manifest entry (slug with no
matching file) is ignored at render/golden time — never breaks a render.

```ts
interface FixtureMeta {
  slug: string;
  label: string;
  description?: string;
}
```

### `FixtureMetaSchema`

Zod schema for a fixture manifest entry.

```ts
const FixtureMetaSchema: z.ZodType<FixtureMeta>;
```

### `TEMPLATE_SOURCE_COLLECTIONS`

Collections that can serve as data sources for templates.

```ts
const TEMPLATE_SOURCE_COLLECTIONS: "orders" | "invoices"[];
```

### `TEMPLATE_SURFACES`

Client-agnostic detail surfaces where a template family is offered. NOT route
strings — clients map a surface to their own route (e.g. manager binds
`"order"` → `/orders/:id`). A packing list might surface on both `"order"`
and `"fulfillment"`; a quote only on `"order"`.

```ts
const TEMPLATE_SURFACES: "order" | "fulfillment" | "invoice"[];
```

### `TEMPLATE_TARGET_COLLECTIONS`

Collections that templates can produce documents for.

```ts
const TEMPLATE_TARGET_COLLECTIONS: "quotes" | "packing_lists" | "invoices"[];
```

### `Template`

A thin template *family* document — identity + rollups, no content/status.

```ts
interface Template {
  uid: string;
  git_path: string;
  name: string;
  collection_source: TemplateSourceCollectionType;
  collection_target: TemplateTargetCollectionType;
  surfaces: TemplateSurfaceType[];
  uid_active: string | null;
  active_semver?: string | null;
  depends_on: TemplateDependsOn;
  fixtures: FixtureMeta[];
  draft_uids: string[];
  version_count: number;
  last_published_at: FirestoreTimestampType | null;
  uid_thread: string;
  version: number;
  created_by: ActorRefType;
  updated_by: ActorRefType;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}
```

### `TemplateContext`

Context object passed to Eta templates at render time.

```ts
interface TemplateContext {
  doc: Record<string, unknown>;
  version?: number | null;
  logo?: string;
  params?: Record<string, unknown>;
}
```

### `TemplateDependsOn`

Component dependencies a template family overlays at render time.

```ts
interface TemplateDependsOn {
  components: string[];
}
```

### `TemplateInputSchema`

Zod schema for TemplateInput.

```ts
const TemplateInputSchema: z.ZodType<TemplateInputType>;
```

### `TemplateInputType`

Input for registering a new template *family*. Content is not provided here —
registration creates the family doc + a git branch carrying the sidecar; the
server derives `git_path = slugify(name)` and freezes it.

```ts
interface TemplateInputType {
  name: string;
  collection_source: TemplateSourceCollectionType;
  collection_target: TemplateTargetCollectionType;
  surfaces: TemplateSurfaceType[];
  depends_on?: Partial<TemplateDependsOn>;
}
```

### `TemplateSchema`

Zod schema for a Template family document.

```ts
const TemplateSchema: z.ZodType<Template>;
```

### `TemplateSourceCollectionType`

Firestore collection that provides data to a template.

```ts
type TemplateSourceCollectionType = indexedAccess;
```

### `TemplateSurfaceType`

A single client-agnostic surface a template is offered on.

```ts
type TemplateSurfaceType = indexedAccess;
```

### `TemplateTargetCollectionType`

Firestore collection that a template produces documents for.

```ts
type TemplateTargetCollectionType = indexedAccess;
```

## `@cfs/core/schemas/template-context`

Template render-context descriptor — the single source of truth for **which
`it.*` namespaces a template can call**, shared by the API's render context
and the manager's editor reference panels.

A template's available helpers are determined by its **collections**, not by a
fixed list. `api-cloudrun`'s `eta.ts` used to inject `it.orders` + `it.dates`
unconditionally, so an invoices-source template got order helpers and no
invoice helpers. Both the runtime injection and the editor panels now resolve
the same set through {@link availableUtilNamespaces}, so the panel can never
advertise a helper the server won't provide.

The resolver takes **lists** even though `collection_source`/`collection_target`
are single-valued today (`z.enum` on the family doc). When a template grows to
multiple sources/targets, only the call sites change — not this contract.

### `ALWAYS_ON_UTIL_NAMESPACES`

Utils namespaces injected for every template regardless of collection.

`money` is here rather than in {@link TEMPLATE_COLLECTION_UTILS} because every
document a template renders carries money — an order, an invoice and a quote
all need `it.money.formatCents`, so keying it to one collection would just
mean listing it under all of them.

It also closes a gap the generated helper catalogue had already opened:
`template-helpers.generated.ts` derives its namespaces from `src/utils/`, so
it has been advertising eleven `it.money.*` helpers to template authors while
the render path injected none of them. Documentation promising a global that
throws at render time is worse than no documentation.

✅ `it.currency` (raw currency.js) **is gone as of Phase 11 Phase E**, and
`it.money` is what replaced it. It survived this long because the natural
replacement takes **cents** while template documents held **dollars**, so
every one of the 19 call sites in `templates/quote.eta` would have read
`it.money.formatCents(it.money.toCents(x))` — worse than what it replaced.
Documents are cents-denominated now, `it.money.formatCents(doc.total_cents)`
is the natural form, and the trade flipped exactly as predicted.

```ts
const ALWAYS_ON_UTIL_NAMESPACES: readonly string[];
```

### `TEMPLATE_COLLECTION_UTILS`

Collection → the `@cfs/core/utils` namespace injected for it, exposed as
`it.<namespace>` inside a template.

`Partial` on purpose: a collection need not have a utils namespace.
`quotes` and `packing_lists` have none — templates *produce* those, they
don't compute over them.

Values must be valid `it.<ns>` identifiers. `contact-name` is deliberately
unmapped for that reason; a future collection needing it would map to
`"contactName"`.

```ts
const TEMPLATE_COLLECTION_UTILS: Partial<Record<TemplateCollectionType, string>>;
```

### `TEMPLATE_LIB_GLOBALS`

Third-party libraries injected as `it.*` globals for every template
(`it.dateFns`, `it.tz`). Not `@cfs/core` utils — documented here so the
render context has one authoritative inventory.

**This list IS the contract, not a description of one.** `api-cloudrun`'s
money Ratchet E asserts the render context's raw injections against it
directly, so adding a name here is what permits a new raw library into every
template — there is no second copy to keep in sync.

⚠️ **A money library must never come back.** `currency` lived here until
Phase 11 Phase E and was the one unguarded money surface templates had:
`it.currency(x).divide(y)` is a real, working call that makes a silent
rounding decision, and no ratchet in `api-cloudrun` or `core` can see what an
`.eta` file does with it — template content is canonical in the `templates`
repo, not here. Money reaches templates through `it.money` (see
{@link ALWAYS_ON_UTIL_NAMESPACES}), which is swept.

```ts
const TEMPLATE_LIB_GLOBALS: readonly string[];
```

### `TEMPLATE_SCALAR_GLOBALS`

Per-render scalars injected as `it.*` globals for every template. `it.doc` is
always the **source** document — a template never reads its target, it
produces it.

```ts
const TEMPLATE_SCALAR_GLOBALS: readonly string[];
```

### `TemplateCollectionType`

Any collection a template can read from or produce.

```ts
type TemplateCollectionType = TemplateSourceCollectionType | TemplateTargetCollectionType;
```

### `availableUtilNamespaces(sources: readonly TemplateCollectionType[], targets: readonly TemplateCollectionType[]): string[]`

Resolve the `@cfs/core/utils` namespaces available to a template, as the union
of the always-on set plus each source/target collection's namespace.

```ts
availableUtilNamespaces(["orders"], ["quotes"]);     // ["dates", "orders"]
availableUtilNamespaces(["orders"], ["invoices"]);   // ["dates", "orders", "invoices"]
availableUtilNamespaces(["invoices"], ["invoices"]); // ["dates", "invoices"]
```

Note that a **target**-derived namespace is forward-looking: `it.doc` is the
source document, so e.g. an orders→invoices template gets `it.invoices`
helpers with no invoice document to apply them to until the author builds
invoice-shaped data themselves.

**Parameters**

- `sources` — The template's source collections (single-element today).
- `targets` — The template's target collections (single-element today).

**Returns** — Deduped namespace list, always-on first, in collection order.

## `@cfs/core/schemas/webhook-event`

### `WebhookEvent`

An inbound webhook event stored for processing.

```ts
interface WebhookEvent {
  id: string;
  event: string;
  received: FirestoreTimestampType;
  expiresAt: FirestoreTimestampType;
  payload: unknown;
}
```

### `WebhookEventSchema`

Zod schema for WebhookEvent.

```ts
const WebhookEventSchema: z.ZodType<WebhookEvent>;
```

## `@cfs/core/schemas/log`

### `ACCESS_CONTROL_EVENT_MSGS`

Msg literals this archetype absorbs.

```ts
const ACCESS_CONTROL_EVENT_MSGS: "rbac_registry_drift" | "rbac_user_missing" | "role_create_conflict" | "role_created" | "role_invalid_permission" | "role_permission_unknown" | "role_schema_invalid" | "role_update_not_found" | "role_updated" | "permission_denied" | "service_oidc_observed" | "preview_role_self_healed" | "preview_role_started" | "preview_role_stopped" | "preview_role_subset_violation"[];
```

### `AccessControlEventLogRecord`

Structured log entry for any RBAC / role / preview-role event.

```ts
interface AccessControlEventLogRecord {
  level: LogLevelType;
  msg: AccessControlEventMsg;
  ts: string;
  role_name?: string;
  permission?: string;
  request_id?: string;
  method?: string;
  path?: string;
  route?: string;
  user_id?: string;
  trace_id?: string;
  span_id?: string;
}
```

### `AccessControlEventLogRecordSchema`

Zod schema for {@link AccessControlEventLogRecord}.

```ts
const AccessControlEventLogRecordSchema: z.ZodType<AccessControlEventLogRecord>;
```

### `AccessControlEventMsg`

Discriminated msg union for Access-Control-archetype log records.

```ts
type AccessControlEventMsg = indexedAccess;
```

### `BaseLogFields`

TypeScript shape of {@link baseLogFields} — for use in archetype
interfaces that want to declare the envelope explicitly.

```ts
interface BaseLogFields {
  level: LogLevelType;
  ts: string;
  request_id?: string;
  method?: string;
  path?: string;
  route?: string;
  user_id?: string;
  subject?: string;
  trace_id?: string;
  span_id?: string;
  duration_ms?: number;
  dry_run?: boolean;
}
```

### `CALENDAR_EVENT_MSGS`

Msg literals this archetype absorbs.

```ts
const CALENDAR_EVENT_MSGS: "calendar_event_adopted" | "calendar_event_not_found" | "calendar_event_stale" | "calendar_missing_date" | "calendar_not_configured" | "calendar_not_found" | "calendar_search_failed" | "calendar_stale_event_cleared" | "calendar_update_superseded"[];
```

### `CLOUD_TASK_EVENT_MSGS`

Msg literals this archetype absorbs.

```ts
const CLOUD_TASK_EVENT_MSGS: "cloud_task_already_exists" | "cloud_task_cancel_error" | "cloud_task_cancel_failed" | "cloud_task_canceled" | "cloud_task_create_failed" | "cloud_task_created" | "cloud_task_not_configured" | "cloud_task_payload_rejected" | "cloud_task_sa_unavailable"[];
```

### `CalendarEventLogRecord`

Structured log entry for any Google Calendar sync event.

```ts
interface CalendarEventLogRecord {
  level: LogLevelType;
  msg: CalendarEventMsg;
  ts: string;
  booking_uid?: string;
  calendar_event_id?: string;
  request_id?: string;
  method?: string;
  path?: string;
  route?: string;
  user_id?: string;
  trace_id?: string;
  span_id?: string;
}
```

### `CalendarEventLogRecordSchema`

Zod schema for {@link CalendarEventLogRecord}.

```ts
const CalendarEventLogRecordSchema: z.ZodType<CalendarEventLogRecord>;
```

### `CalendarEventMsg`

Discriminated msg union for Calendar-archetype log records.

```ts
type CalendarEventMsg = indexedAccess;
```

### `ClientAppType`

Identifier for a client application that emits logs.

```ts
type ClientAppType = indexedAccess;
```

### `ClientLogBatch`

A batch of client log entries submitted in a single request.

```ts
interface ClientLogBatch {
  logs: ClientLogEntry[];
}
```

### `ClientLogBatchSchema`

Zod schema for {@link ClientLogBatch}.

```ts
const ClientLogBatchSchema: z.ZodType<ClientLogBatch>;
```

### `ClientLogEntry`

A single log entry sent from a client application.

```ts
interface ClientLogEntry {
  level: LogLevelType;
  msg: string;
  ts: string;
  app: ClientAppType;
  page?: string;
  request_id?: string;
  data?: Record<string, unknown>;
}
```

### `ClientLogEntrySchema`

Zod schema for {@link ClientLogEntry}.

The `data` field is capped at 20 top-level keys + 4 KB stringified to
defend against runaway client-side payloads. Manager logs in practice
carry ≤5 keys and <500 bytes per entry, so this cap is far above the
legitimate ceiling.

```ts
const ClientLogEntrySchema: z.ZodType<ClientLogEntry>;
```

### `ClientLogRecord`

Server-emitted log record for browser-shipped events.

api-cloudrun's `src/routes/clientLogs.ts` re-emits each ingested
{@link ClientLogEntry} as `msg: "client_log"` with the wire entry's
envelope rewritten into `client_*` namespaced fields (`client_msg`,
`client_ts`, `client_level` — to avoid collision with the server
envelope's `msg`/`ts`/`level`) and the `data` payload spread to the
top level. PII-shaped passthrough keys are declared here with their
`pii: "mask"` meta so the schema walker masks them partial-form
instead of Tier 2 fully redacting.

```ts
interface ClientLogRecord {
  level: BaseLogLevelType;
  msg: "client_log";
  ts: string;
  source: "browser";
  app: ClientAppType;
  client_msg: string;
  client_ts: string;
  client_level: BaseLogLevelType;
  page?: string;
  request_id?: string;
  user_id?: string;
  trace_id?: string;
  span_id?: string;
  email?: string;
  to?: string;
  subject?: string;
}
```

### `ClientLogRecordSchema`

Zod schema for {@link ClientLogRecord}.

```ts
const ClientLogRecordSchema: z.ZodType<ClientLogRecord>;
```

### `CloudTaskEventLogRecord`

Structured log entry for any Cloud Tasks lifecycle event.

```ts
interface CloudTaskEventLogRecord {
  level: LogLevelType;
  msg: CloudTaskEventMsg;
  ts: string;
  queue?: string;
  task_name?: string;
  document_path?: string;
  request_id?: string;
  method?: string;
  path?: string;
  route?: string;
  user_id?: string;
  trace_id?: string;
  span_id?: string;
}
```

### `CloudTaskEventLogRecordSchema`

Zod schema for {@link CloudTaskEventLogRecord}.

```ts
const CloudTaskEventLogRecordSchema: z.ZodType<CloudTaskEventLogRecord>;
```

### `CloudTaskEventMsg`

Discriminated msg union for Cloud-Task-archetype log records.

```ts
type CloudTaskEventMsg = indexedAccess;
```

### `DOMAIN_EVENT_MSGS`

Msg literals this archetype absorbs.

```ts
const DOMAIN_EVENT_MSGS: "afterOrderWrite_order_not_found" | "after_product_write_no_changes" | "after_product_write_not_found" | "after_product_write_skip_create" | "update_order_no_changes" | "order_docs_skipped" | "order_invoice_count_high" | "invoice_created" | "invoice_org_bootstrapped_from_crms" | "invoice_pdf_not_found" | "invoice_pdf_skip" | "invoice_updated" | "payment_added" | "payment_updated" | "organization_check_failed" | "organization_no_crms_id" | "organization_no_xero_id" | "receive_invoice_hook_failed" | "receive_member_update_failed" | "receive_opportunity_hook_failed" | "receive_quarantine_hook_failed" | "item_path_invariant_failed" | "order_invoice_mirror_repaired" | "location_cascade_skip" | "location_reversal_skip" | "location_quantity_negative" | "stock_recalc_item_added" | "stock_recalc_item_modified" | "stock_recalc_item_removed" | "stock_recalc_items" | "stock_recalc_status_changed" | "fulfillment_custom_item_qty_override"[];
```

### `DmarcAggregateLogRecord`

Structured log entry for one record from a DMARC aggregate report.

```ts
interface DmarcAggregateLogRecord {
  level: LogLevelType;
  msg: "dmarc_aggregate_record";
  ts: string;
  source_ip: string;
  count: number;
  disposition: string;
  dkim_result: string;
  spf_result: string;
  dkim_aligned: boolean;
  spf_aligned: boolean;
  header_from: string;
  org_name: string;
  report_id: string;
  domain: string;
  date_range_begin: number;
  date_range_end: number;
  dmarc_pass: "true" | "false";
  request_id?: string;
  method?: string;
  path?: string;
  route?: string;
  user_id?: string;
  trace_id?: string;
  span_id?: string;
}
```

### `DmarcAggregateLogRecordSchema`

Zod schema for {@link DmarcAggregateLogRecord}.

```ts
const DmarcAggregateLogRecordSchema: z.ZodType<DmarcAggregateLogRecord>;
```

### `DomainEventLogRecord`

Structured log entry for any domain-aggregate lifecycle event.

```ts
interface DomainEventLogRecord {
  level: LogLevelType;
  msg: DomainEventMsg;
  ts: string;
  order_uid?: string;
  invoice_uid?: string;
  product_uid?: string;
  organization_uid?: string;
  document_path?: string;
  request_id?: string;
  method?: string;
  path?: string;
  route?: string;
  user_id?: string;
  trace_id?: string;
  span_id?: string;
}
```

### `DomainEventLogRecordSchema`

Zod schema for {@link DomainEventLogRecord}.

```ts
const DomainEventLogRecordSchema: z.ZodType<DomainEventLogRecord>;
```

### `DomainEventMsg`

Discriminated msg union for Domain-archetype log records.

```ts
type DomainEventMsg = indexedAccess;
```

### `EmailSendFailedLogRecord`

Structured log entry for a failed outbound email.

```ts
interface EmailSendFailedLogRecord {
  level: LogLevelType;
  msg: "email_send_failed";
  ts: string;
  status: number;
  body?: string;
  email_from: string;
  to?: string;
  subject?: string;
  request_id?: string;
  method?: string;
  path?: string;
  route?: string;
  user_id?: string;
  trace_id?: string;
  span_id?: string;
}
```

### `EmailSendFailedLogRecordSchema`

Zod schema for {@link EmailSendFailedLogRecord}.

```ts
const EmailSendFailedLogRecordSchema: z.ZodType<EmailSendFailedLogRecord>;
```

### `EmailSentLogRecord`

Structured log entry for a successful outbound email.

```ts
interface EmailSentLogRecord {
  level: LogLevelType;
  msg: "email_sent";
  ts: string;
  email_from: string;
  to?: string;
  request_id?: string;
  method?: string;
  path?: string;
  route?: string;
  user_id?: string;
  trace_id?: string;
  span_id?: string;
}
```

### `EmailSentLogRecordSchema`

Zod schema for {@link EmailSentLogRecord}.

```ts
const EmailSentLogRecordSchema: z.ZodType<EmailSentLogRecord>;
```

### `INTEGRATION_EVENT_MSGS`

Msg literals this archetype absorbs.

```ts
const INTEGRATION_EVENT_MSGS: "crms_invoice_items_uniqueness_violation" | "crms_invoice_ambiguous_line_pairing" | "crms_invoice_multiple_orders_found" | "crms_multiple_matches_found" | "crms_invoice_order_not_found" | "crms_discount_roundtrip_drift" | "crms_invoice_chargeable_days_unresolved" | "crms_invoice_reprice_frozen" | "crms_mark_paid_failed" | "crms_product_not_found" | "uploadcare_draft_cleanup_failed" | "uploadcare_file_not_found" | "uploadcare_invoice_cleanup_failed" | "uploadcare_orphan_batch_failed" | "uploadcare_orphan_cleanup_failed" | "uploadcare_orphan_sweep_completed" | "uploadcare_upload_abandoned" | "dmarc_report_ingest_failed" | "dmarc_report_processor_run" | "eventarc_duplicate_event" | "eventarc_processed" | "trello_locked" | "trello_newer_update_detected" | "trello_no_new_updates" | "trello_queue_error" | "mirror_deleted" | "mirror_failed" | "mirror_set" | "mirror_set_failed_terminal" | "mirror_set_queue_failed" | "mirror_skipped_stale" | "draft_quote_skipped_deleted" | "draft_quote_skipped_invalid_order" | "draft_quote_superseded" | "dns_record_check" | "dns_record_check_resolve_failed" | "location_integrity_check" | "location_integrity_check_failed" | "stock_summary_sweep" | "sync_collection_completed" | "sync_collection_skipped" | "sync_started" | "geocode_cache_write_failed" | "geocode_poi_fallback" | "geocoding_failed" | "member_geocode_skipped" | "user_name_cascade_batch" | "customer_linking_failed"[];
```

### `IntegrationEventLogRecord`

Structured log entry for any external-integration event.

```ts
interface IntegrationEventLogRecord {
  level: LogLevelType;
  msg: IntegrationEventMsg;
  ts: string;
  service?: string;
  document_path?: string;
  request_id?: string;
  method?: string;
  path?: string;
  route?: string;
  user_id?: string;
  trace_id?: string;
  span_id?: string;
}
```

### `IntegrationEventLogRecordSchema`

Zod schema for {@link IntegrationEventLogRecord}.

```ts
const IntegrationEventLogRecordSchema: z.ZodType<IntegrationEventLogRecord>;
```

### `IntegrationEventMsg`

Discriminated msg union for Integration-archetype log records.

```ts
type IntegrationEventMsg = indexedAccess;
```

### `LogLevelEnum`

Zod enum for log levels — exported for reuse in arm schemas.

```ts
const LogLevelEnum: z.ZodType<LogLevelType>;
```

### `LogLevelType`

Log severity level.

```ts
type LogLevelType = indexedAccess;
```

### `LogRecord`

Structured log envelope emitted by the API (OpenAPI shape).

```ts
interface LogRecord {
  level: LogLevelType;
  msg: string;
  ts: string;
  request_id?: string;
  method?: string;
  path?: string;
  route?: string;
  user_id?: string;
  trace_id?: string;
  span_id?: string;
  duration_ms?: number;
  dry_run?: boolean;
}
```

### `LogRecordSchema`

Zod schema for {@link LogRecord} — generic envelope, OpenAPI-only.

```ts
const LogRecordSchema: z.ZodType<LogRecord>;
```

### `MCP_EVENT_MSGS`

Msg literals this archetype absorbs.

```ts
const MCP_EVENT_MSGS: "mcp_autogen_tool_error" | "mcp_autogen_tools_registered" | "mcp_bearer_invalid" | "mcp_bearer_unconfigured" | "mcp_legacy_bearer_used" | "mcp_result_capped" | "mcp_template_tool_error" | "mcp_template_tools_registered"[];
```

### `MSG_SCHEMA_REGISTRY`

Runtime msg → schema lookup. The structured logger's `emit()` reads
`record.msg`, looks up the matching schema here, and (if present)
passes the record through the schema-driven PII walker in
`@cfs/core/schemas/pii` before stringification.

Records whose `msg` is NOT in this registry fall through to the
runtime key-name denylist tier (forward defense). The coverage test
in api-cloudrun keeps the registry exhaustive over what the source
tree emits.

```ts
const MSG_SCHEMA_REGISTRY: ReadonlyMap<string, z.ZodType>;
```

### `McpEventLogRecord`

Structured log entry for any MCP tool / bearer-auth event.

```ts
interface McpEventLogRecord {
  level: LogLevelType;
  msg: McpEventMsg;
  ts: string;
  tool?: string;
  request_id?: string;
  method?: string;
  path?: string;
  route?: string;
  user_id?: string;
  trace_id?: string;
  span_id?: string;
}
```

### `McpEventLogRecordSchema`

Zod schema for {@link McpEventLogRecord}.

```ts
const McpEventLogRecordSchema: z.ZodType<McpEventLogRecord>;
```

### `McpEventMsg`

Discriminated msg union for MCP-archetype log records.

```ts
type McpEventMsg = indexedAccess;
```

### `OAUTH_EVENT_MSGS`

Msg literals this archetype absorbs.

```ts
const OAUTH_EVENT_MSGS: "oauth_401_retry" | "oauth_alert_email_failed" | "oauth_refresh_attempt" | "oauth_refresh_chain_broken" | "oauth_refresh_failed_response" | "oauth_refresh_scheduled" | "oauth_refresh_stale_task" | "oauth_token_exchanged" | "oauth_token_expired" | "oauth_token_expired_refreshing" | "oauth_token_refresh_skipped" | "oauth_token_refreshed" | "oauth_token_response" | "mcp_oauth_authorize_staged" | "mcp_oauth_client_registered" | "mcp_oauth_code_consume_failed" | "mcp_oauth_consent_approved" | "mcp_oauth_consent_denied" | "mcp_oauth_scope_denied" | "mcp_oauth_token_invalid" | "mcp_oauth_token_minted" | "mcp_oauth_user_missing" | "token_refresh_failed" | "crms_token_exchange_failed" | "xero_token_exchange_failed"[];
```

### `OAuthEventLogRecord`

Structured log entry for any OAuth / token-lifecycle event.

```ts
interface OAuthEventLogRecord {
  level: LogLevelType;
  msg: OAuthEventMsg;
  ts: string;
  service?: string;
  request_id?: string;
  method?: string;
  path?: string;
  route?: string;
  user_id?: string;
  trace_id?: string;
  span_id?: string;
}
```

### `OAuthEventLogRecordSchema`

Zod schema for {@link OAuthEventLogRecord}.

```ts
const OAuthEventLogRecordSchema: z.ZodType<OAuthEventLogRecord>;
```

### `OAuthEventMsg`

Discriminated msg union for OAuth-archetype log records.

```ts
type OAuthEventMsg = indexedAccess;
```

### `OAuthRefreshLogRecord`

Structured log entry for an OAuth token refresh.

```ts
interface OAuthRefreshLogRecord {
  level: LogLevelType;
  msg: "oauth_refresh";
  ts: string;
  service: string;
  grant_type?: string;
  scope?: string;
  token_type?: string;
  expires_in?: number;
  token_age_hours?: number;
  refreshed_at_debug?: string;
  recovered?: boolean;
  request_id?: string;
  method?: string;
  path?: string;
  route?: string;
  user_id?: string;
  trace_id?: string;
  span_id?: string;
}
```

### `OAuthRefreshLogRecordSchema`

Zod schema for {@link OAuthRefreshLogRecord}.

```ts
const OAuthRefreshLogRecordSchema: z.ZodType<OAuthRefreshLogRecord>;
```

### `PiiClassification`

PII classification vocabulary.

Applied via `.meta({ pii: "..." })` on any Zod field; the schema-driven
walker in `./walker.ts` reads these tags and dispatches to the matching
leaf transform.

- `"none"`   — safe field, no processing
- `"mask"`   — partial reveal (`alice@x.com` → `a****@x.com`, last-4 for opaque strings)
- `"hash"`   — deterministic HMAC-SHA256 prefix (server-side only; needs a key)
- `"redact"` — full removal → `"[REDACTED]"`

```ts
type PiiClassification = "none" | "mask" | "hash" | "redact";
```

### `PropagationLogRecord`

Structured log entry for a single propagation rule execution.

```ts
interface PropagationLogRecord {
  level: LogLevelType;
  msg: "propagation";
  ts: string;
  rule_id: string;
  source: string;
  target: string;
  mode: PropagationModeType;
  transaction?: string;
  fields_mapped: number;
  source_doc_id?: string;
  target_doc_id?: string;
  status: PropagationStatusType;
  duration_ms?: number;
  error?: string;
  rules_fired?: string[];
  rules_fired_count?: number;
  rules_expected?: number;
  target_counts?: Record<string, number>;
  target_count?: number;
  request_id?: string;
  method?: string;
  path?: string;
  route?: string;
  user_id?: string;
  trace_id?: string;
  span_id?: string;
}
```

### `PropagationLogRecordSchema`

Zod schema for {@link PropagationLogRecord}.

```ts
const PropagationLogRecordSchema: z.ZodType<PropagationLogRecord>;
```

### `PropagationModeType`

Propagation strategy used by a rule.

```ts
type PropagationModeType = indexedAccess;
```

### `PropagationStatusType`

Status outcome of a propagation rule execution.

```ts
type PropagationStatusType = indexedAccess;
```

### `RequestLogRecord`

Structured log entry for a completed HTTP request.

```ts
interface RequestLogRecord {
  level: LogLevelType;
  msg: "request";
  ts: string;
  route: string;
  status: number;
  duration_ms: number;
  request_id?: string;
  method?: string;
  path?: string;
  user_id?: string;
  trace_id?: string;
  span_id?: string;
  dry_run?: boolean;
}
```

### `RequestLogRecordSchema`

Zod schema for {@link RequestLogRecord}.

```ts
const RequestLogRecordSchema: z.ZodType<RequestLogRecord>;
```

### `SYSTEM_EVENT_MSGS`

Msg literals this archetype absorbs.

```ts
const SYSTEM_EVENT_MSGS: "db_page_clipped" | "dev_guard_skip" | "dry_run_skip" | "rate_limit_exceeded" | "retry_attempt" | "startup_error" | "unhandled_error" | "health_check_firestore_error" | "preview_served" | "validation_failed"[];
```

### `SyncErrorLogRecord`

Structured log entry for a sync-pipeline failure.

```ts
interface SyncErrorLogRecord {
  level: LogLevelType;
  msg: "sync_error";
  ts: string;
  sync_service: string;
  document_path?: string;
  operation?: string;
  error_name?: string;
  error_message?: string;
  error_stack?: string;
  request_id?: string;
  method?: string;
  path?: string;
  route?: string;
  user_id?: string;
  trace_id?: string;
  span_id?: string;
}
```

### `SyncErrorLogRecordSchema`

Zod schema for {@link SyncErrorLogRecord}.

```ts
const SyncErrorLogRecordSchema: z.ZodType<SyncErrorLogRecord>;
```

### `SystemEventLogRecord`

Structured log entry for any system-lifecycle event.

```ts
interface SystemEventLogRecord {
  level: LogLevelType;
  msg: SystemEventMsg;
  ts: string;
  attempt?: number;
  request_id?: string;
  method?: string;
  path?: string;
  route?: string;
  user_id?: string;
  trace_id?: string;
  span_id?: string;
}
```

### `SystemEventLogRecordSchema`

Zod schema for {@link SystemEventLogRecord}.

```ts
const SystemEventLogRecordSchema: z.ZodType<SystemEventLogRecord>;
```

### `SystemEventMsg`

Discriminated msg union for System-archetype log records.

```ts
type SystemEventMsg = indexedAccess;
```

### `TEMPLATE_EVENT_MSGS`

Msg literals this archetype absorbs.

```ts
const TEMPLATE_EVENT_MSGS: "fixture_saved" | "fixture_deleted" | "template_abandon_close_pr_failed" | "template_component_file_missing" | "template_component_no_content" | "template_component_sidecar_parse_failed" | "template_metadata_pr_opened" | "template_metadata_close_pr_failed" | "template_metadata_automerge_unavailable" | "template_preview_store_failed" | "template_preview_stored" | "template_publish_affected" | "template_publish_base_ref_rejected" | "template_publish_no_merge_sha" | "template_publish_noop" | "template_publish_warning" | "template_publish_skipped_no_app" | "template_publish_unknown_component" | "template_rebuild_from_git" | "template_reconcile_sweep" | "template_release_auto_merge_failed" | "template_render_config_parse_failed" | "template_render_failed" | "draft_git_backfill_failed" | "template_sandbox_diverged" | "template_sandbox_fast_forwarded" | "template_sandbox_force_resynced" | "template_sync_skipped_no_app" | "get_quote_template_failed" | "golden_diff_oidc_identity_rejected" | "golden_diff_oidc_unconfigured" | "golden_diff_oidc_verify_failed" | "golden_diff_result" | "golden_verdict_persist_failed" | "github_templates_no_merge_sha" | "github_templates_publish_failed" | "comment_sync_awaiting_create" | "comment_sync_github_unconfigured" | "comment_sync_no_pr" | "comment_sync_posted"[];
```

### `TYPESENSE_EVENT_MSGS`

Msg literals this archetype absorbs.

```ts
const TYPESENSE_EVENT_MSGS: "typesense_alias_mismatch" | "typesense_batch_import_failed" | "typesense_build_delete_failed" | "typesense_cleanup_old_collections_failed" | "typesense_collection_created" | "typesense_count_mismatch" | "typesense_delete" | "typesense_import_failed" | "typesense_orphan_delete_failed" | "typesense_parent_keys_missing" | "typesense_parent_keys_parse_failed" | "typesense_purge_orphans_failed" | "typesense_reindex_enqueued" | "typesense_reindex_superseded" | "typesense_reindex_swapped" | "typesense_scoped_key_parent_missing" | "typesense_swap_alias_failed" | "typesense_sync_check_failed" | "typesense_sync_synonyms_failed" | "typesense_synonyms_synced" | "typesense_translate_failed" | "typesense_upsert"[];
```

### `TemplateEventLogRecord`

Structured log entry for any template / golden-diff event.

```ts
interface TemplateEventLogRecord {
  level: LogLevelType;
  msg: TemplateEventMsg;
  ts: string;
  template_uid?: string;
  template_version_uid?: string;
  branch?: string;
  pr_number?: number;
  commit_sha?: string;
  request_id?: string;
  method?: string;
  path?: string;
  route?: string;
  user_id?: string;
  trace_id?: string;
  span_id?: string;
}
```

### `TemplateEventLogRecordSchema`

Zod schema for {@link TemplateEventLogRecord}.

```ts
const TemplateEventLogRecordSchema: z.ZodType<TemplateEventLogRecord>;
```

### `TemplateEventMsg`

Discriminated msg union for Template-archetype log records.

```ts
type TemplateEventMsg = indexedAccess;
```

### `TransactionLogRecord`

Structured log entry for a single Firestore transaction commit (success or failure).

```ts
interface TransactionLogRecord {
  level: LogLevelType;
  msg: "transaction";
  ts: string;
  tx_name: string;
  status: TransactionStatusType;
  duration_ms: number;
  write_count: number;
  target_counts: Record<string, number>;
  estimated_json_bytes: number;
  sample_doc_paths: string[];
  read_paths?: string[];
  read_count?: number;
  read_counts?: Record<string, number>;
  range_reads?: Record<string, number>;
  contended_ranges?: string[];
  error_name?: string;
  error_message?: string;
  error_stack?: string;
  aborted?: boolean;
  request_id?: string;
  method?: string;
  path?: string;
  route?: string;
  user_id?: string;
  trace_id?: string;
  span_id?: string;
  dry_run?: boolean;
}
```

### `TransactionLogRecordSchema`

Zod schema for {@link TransactionLogRecord}.

```ts
const TransactionLogRecordSchema: z.ZodType<TransactionLogRecord>;
```

### `TransactionStatusType`

Status outcome of a Firestore transaction commit.

```ts
type TransactionStatusType = indexedAccess;
```

### `TypedLogRecord`

Discriminated union of every typed log record, keyed by the `msg`
literal. The new `logTyped<R extends TypedLogRecord>` API in
api-cloudrun's `src/lib/logger.ts` constrains its argument to this
union — TS narrows to the matching arm based on the supplied `msg`,
giving compile-time enforcement that every field is correctly named
and typed.

Adding a new arm requires:
  1. Define schema + interface in `./<archetype>.ts`
  2. Re-export both above
  3. Add to this union
  4. Add to {@link MSG_SCHEMA_REGISTRY} below

The `log-records.test.ts` coverage test asserts union ↔ registry
symmetry so it's impossible to add one without the other.

```ts
type TypedLogRecord = ClientLogRecord | DmarcAggregateLogRecord | EmailSendFailedLogRecord | EmailSentLogRecord | OAuthRefreshLogRecord | PropagationLogRecord | RequestLogRecord | SyncErrorLogRecord | TransactionLogRecord | ValidationErrorLogRecord | AccessControlEventLogRecord | CalendarEventLogRecord | CloudTaskEventLogRecord | DomainEventLogRecord | IntegrationEventLogRecord | McpEventLogRecord | OAuthEventLogRecord | SystemEventLogRecord | TemplateEventLogRecord | TypesenseEventLogRecord | UserSessionEventLogRecord | XeroEventLogRecord;
```

### `TypesenseEventLogRecord`

Structured log entry for any Typesense pipeline event.

```ts
interface TypesenseEventLogRecord {
  level: LogLevelType;
  msg: TypesenseEventMsg;
  ts: string;
  collection?: string;
  typesense_collection?: string;
  document_id?: string;
  request_id?: string;
  method?: string;
  path?: string;
  route?: string;
  user_id?: string;
  trace_id?: string;
  span_id?: string;
}
```

### `TypesenseEventLogRecordSchema`

Zod schema for {@link TypesenseEventLogRecord}.

```ts
const TypesenseEventLogRecordSchema: z.ZodType<TypesenseEventLogRecord>;
```

### `TypesenseEventMsg`

Discriminated msg union for Typesense-archetype log records.

```ts
type TypesenseEventMsg = indexedAccess;
```

### `USER_SESSION_EVENT_MSGS`

Msg literals this archetype absorbs.

```ts
const USER_SESSION_EVENT_MSGS: "invite_accepted" | "invite_created" | "invite_preview" | "session_replaced_on_invite_accept" | "session_user_preload" | "turnstile_verification_failed"[];
```

### `UserSessionEventLogRecord`

Structured log entry for any user-session / invite / turnstile event.

```ts
interface UserSessionEventLogRecord {
  level: LogLevelType;
  msg: UserSessionEventMsg;
  ts: string;
  invite_uid?: string;
  session_uid?: string;
  request_id?: string;
  method?: string;
  path?: string;
  route?: string;
  user_id?: string;
  trace_id?: string;
  span_id?: string;
}
```

### `UserSessionEventLogRecordSchema`

Zod schema for {@link UserSessionEventLogRecord}.

```ts
const UserSessionEventLogRecordSchema: z.ZodType<UserSessionEventLogRecord>;
```

### `UserSessionEventMsg`

Discriminated msg union for User-Session-archetype log records.

```ts
type UserSessionEventMsg = indexedAccess;
```

### `ValidationErrorLogRecord`

Structured log entry for a schema validation failure.

```ts
interface ValidationErrorLogRecord {
  level: LogLevelType;
  msg: "validation_error";
  ts: string;
  label: string;
  issues: ValidationIssue[];
  request_id?: string;
  method?: string;
  path?: string;
  route?: string;
  user_id?: string;
  trace_id?: string;
  span_id?: string;
}
```

### `ValidationErrorLogRecordSchema`

Zod schema for {@link ValidationErrorLogRecord}.

```ts
const ValidationErrorLogRecordSchema: z.ZodType<ValidationErrorLogRecord>;
```

### `ValidationIssue`

Single Zod issue, structurally.

```ts
interface ValidationIssue {
  path?: parenthesized[];
  code?: string;
  message?: string;
  keys?: string[];
  expected?: string;
}
```

### `XERO_EVENT_MSGS`

Msg literals this archetype absorbs.

Quote-push terminal/diagnostic arms (added 2026-07 with the queue restore):
- `xero_quote_validation_rejected` — Xero returned 400 `ValidationException`.
  The task is dropped (handler returns 200) rather than retried 15×; a
  malformed payload never becomes well-formed on retry.
- `xero_quote_locked` — the quote sits in a state CFS refuses to move out of, so
  the push made ZERO Xero calls. This is the honest outcome that replaces the
  swallow: for 30 days every one of the 27 rejected transitions was ALSO logged
  `xero_quote_synced`, because the swallow fell through to the success path and
  advanced the push watermark. There is exactly one `reason`:

    - `invoiced_terminal` — the quote is INVOICED and the target is not. Xero
      will actually *permit* INVOICED → SENT → DECLINED, and that is precisely
      the bug: we un-invoiced 3 live quotes that way. INVOICED is terminal for
      CFS regardless of what Xero tolerates. (There is deliberately no
      `accepted_locked` — an ACCEPTED quote is NOT write-locked; a canceled
      order's quote declines via the legal ACCEPTED → SENT → DECLINED walk.)
- `xero_quote_tax_unmapped` — an order item carries a tax uid with no Xero
  TaxType mapping. Previously `throw` → 500 → 15 retries.
- `xero_quote_noop` — the Xero quote is already at the target Status; no
  write was issued.

Quota-gate arms (added 2026-07 with the daily-budget gate):
- `xero_quota_exhausted` — a call was refused **pre-flight**, before touching
  Xero, because the persisted day budget was at/below the caller's floor.
  Carries `resets_at` so the deferral's schedule is auditable.
- `xero_write_deferred` — a Xero write that could not run now was re-enqueued
  past the day reset under a distinct `xq-defer-…` task name. The `outcome`
  field is load-bearing: a `"deduped"` here is the intended storm-coalescing,
  but a `"skipped"` would be a silently-dropped write.
- `xero_quote_superseded` — the order's push-determining state changed between
  enqueue and execution, so the task returned without issuing ANY Xero call.
- `xero_invoice_push_skipped` — `/tasks/push-xero-invoice` re-read the invoice
  and found nothing to do. Usually benign and expected: the deferred task derives
  issue-vs-void from the invoice DOC rather than from its payload, so a re-run (or
  a run after a human fixed the invoice by hand) is a no-op. At `error` level it
  means the re-deferral itself failed to enqueue — a genuinely dropped write.

  Note what does NOT protect us here. Deriving intent from the doc keys on
  `xero_id == null`, and that means "CFS holds no receipt", NOT "Xero holds no
  invoice" — the two diverge, because the POST and the `xero_id` write-back are
  not atomic. Prod invoice 2312 proves it. What actually prevents a double-create
  is that the push POSTs, and Xero's `POST /Invoices` is upsert-by-InvoiceNumber;
  `PUT` would duplicate. The idempotency is Xero's, not ours.
- `xero_defer_escalated` — a deferred Xero write hit the re-deferral cap and was
  abandoned. `defer_attempt` is otherwise unbounded (the task handler returns 200,
  so Cloud Tasks' `max_attempts` never applies), which lets an unpushable write
  re-defer forever, silently. This is the event that makes that loud; it is always
  a dropped write needing a human.

```ts
const XERO_EVENT_MSGS: "xero_id_self_healed" | "xero_invoice_issued" | "xero_invoice_push_skipped" | "xero_invoice_twin_adopted" | "xero_invoice_twin_refused" | "xero_stock_adjustment_bill" | "xero_settlement_synced" | "xero_settlement_reaped" | "xero_settlement_resurrected" | "xero_manual_intervention_required" | "xero_payment_already_synced" | "xero_payment_appended" | "xero_payment_backfilled" | "xero_payment_processing_failed" | "xero_payment_sync" | "xero_payment_sync_skip" | "xero_payment_webhook_received" | "xero_quote_enqueue_failed" | "xero_quote_locked" | "xero_quote_noop" | "xero_quote_self_throttle" | "xero_quote_skip_draft" | "xero_quote_skip_missing_order" | "xero_quote_skip_no_org_crms_id" | "xero_quote_superseded" | "xero_quote_synced" | "xero_quote_tax_unmapped" | "xero_quote_validation_rejected" | "xero_quota_exhausted" | "xero_rate_limit" | "xero_write_deferred" | "xero_defer_escalated" | "xero_tracking_option_create_failed" | "xero_tracking_option_unresolved" | "xero_tracking_option_update_failed" | "xero_void_failed" | "xero_void_requires_manual_action" | "xero_webhook_invoice_not_found" | "xero_webhook_no_invoice"[];
```

### `XeroEventLogRecord`

Structured log entry for any Xero sync event.

```ts
interface XeroEventLogRecord {
  level: LogLevelType;
  msg: XeroEventMsg;
  ts: string;
  xero_invoice_id?: string;
  xero_payment_id?: string;
  xero_credit_note_id?: string;
  xero_contact_id?: string;
  settlement_uid?: string;
  settlement_type?: string;
  credit_note_number?: string;
  seam?: string;
  remedy?: string;
  xero_url?: string;
  xero_error?: string;
  invoice_number?: number;
  invoice_uid?: string;
  order_uid?: string;
  xero_quote_id?: string | null;
  order_number?: number;
  current_status?: string | null;
  target_status?: string;
  reason?: string;
  retry_after_s?: number;
  resets_at_source?: XeroThrottleResetsAtSource;
  throttle_reason?: "day_budget" | "minute_limit";
  defer_attempt?: number;
  resets_at?: string;
  day_remaining?: number;
  critical?: boolean;
  outcome?: "created" | "deduped" | "skipped";
  request_id?: string;
  method?: string;
  path?: string;
  route?: string;
  user_id?: string;
  trace_id?: string;
  span_id?: string;
}
```

### `XeroEventLogRecordSchema`

Zod schema for {@link XeroEventLogRecord}.

```ts
const XeroEventLogRecordSchema: z.ZodType<XeroEventLogRecord>;
```

### `XeroEventMsg`

Discriminated msg union for Xero-archetype log records.

```ts
type XeroEventMsg = indexedAccess;
```

## `@cfs/core/schemas/pii`

### `NAME_SENSITIVE`

Schemas in which a bare `name` field is a PERSON or ORGANIZATION name rather
than a label, keyed by `schemas`-record key or by exported input-schema name.

This replaces the `nameIsSensitive` boolean that used to live in
`tests/pii.test.ts`'s hand-maintained schema tuple. It has to be explicit:
`name` means a customer in `contact`, and a catalog product in `product`, and
nothing structural distinguishes them. Defaults to FALSE for any schema not
listed — an unlisted schema's `name` is treated as a label.

A parent-segment heuristic is not a substitute: a root-level `name` has no
parent segment, so it would silently drop `contact::name` itself.

`order` / `invoice` / `fulfillment` and their input schemas are listed for the
OPPOSITE reason (#40): every `name` under them is a label — catalog text, a
section header, a venue, a tax name, `Order #NNN` — and every one is annotated
`pii: "none"`. Listing them buys nothing at runtime; it makes the enforcement
test refuse a NEW untagged `name` on those three documents, which is what let
`items[].name` drift into three different answers twice. Being listed here is
what forces a `name` to state its answer rather than default into one.

```ts
const NAME_SENSITIVE: ReadonlySet<string>;
```

### `PiiClassification`

PII classification vocabulary.

Applied via `.meta({ pii: "..." })` on any Zod field; the schema-driven
walker in `./walker.ts` reads these tags and dispatches to the matching
leaf transform.

- `"none"`   — safe field, no processing
- `"mask"`   — partial reveal (`alice@x.com` → `a****@x.com`, last-4 for opaque strings)
- `"hash"`   — deterministic HMAC-SHA256 prefix (server-side only; needs a key)
- `"redact"` — full removal → `"[REDACTED]"`

```ts
type PiiClassification = "none" | "mask" | "hash" | "redact";
```

### `PiiStrategy`

How to transform a leaf value given its PII classification. Consumers
provide their own strategy; the structured logger uses
{@link createLoggerStrategy} below.

The walker calls `apply` with the leaf value, the field's classification,
and the dotted field path (for strategies that want path-dependent output
like the fixture sanitizer's deterministic fakes).

`apply` is also offered every CONTAINER inside a tagged subtree (the tagged
object itself, each nested object/array within it, and each ENTRY of a nested
`z.record`, at `path.<key>`) before the walker recurses into it. An untagged
record's own object is never offered — only its entries, and only once a tag
is in scope. Return the value unchanged to let the walker keep descending to
the leaves; return anything else to replace the container wholesale and stop
the descent. The fixture sanitizer uses this to null a whole `Coordinates`
object — a leaf-by-leaf transform cannot, because `latitude` is a `z.number()`
and there is no in-band "absent" value for it.

```ts
interface PiiStrategy {
  apply(value: unknown, classification: PiiClassification, fieldPath: string): unknown;
}
```

### `RUNTIME_DENYLIST`

Runtime key-name denylist for the structured logger's untyped-passthrough
scrub tier. Recursive **exact-key** match (NOT substring) against log
payload keys; matching values are redacted in-place.

Curated set, intentionally different from the schema-enforcement
dictionary (`./dictionary.ts`):

- **Drops** ambiguous tokens like `name` and bare `address` — too noisy
  in logs that legitimately carry `store_name`, `collection_name`,
  `delivery_address`, etc. Schema-level PII tags handle the
  contact/org/user cases via the walker; runtime denylist is the safety
  net for the un-schematized passthrough surface.
- **Adds** transport / secret / network identifiers that are never schema
  fields but absolutely flow through log payloads (Authorization headers,
  OAuth tokens, request-source IPs).

Empirically validated against 316k log records (dev + prod, 2026-05-23 →
2026-05-27): no `email` / `phone` / `address` / `password` / `token` keys
appear in current logs at all — but `source_ip` and `header_from` do
(DMARC ingest, 3,772 hits each in prod), which is why those are here.

The `_debug` suffix convention is intentionally OUT of this denylist's
purview: `*_debug` fields are an internal-diagnostics marker, not a
sensitivity marker — `refreshed_at_debug` and friends are deliberately
present in logs for ops correlation.

```ts
const RUNTIME_DENYLIST: ReadonlySet<string>;
```

### `SAFE_PASSTHROUGH`

Keys that the runtime scrubber MUST preserve untouched, regardless of
value content. Protects against accidental over-scrubbing — without this
allowlist, a `request_id` UUID that happens to match a regex pattern
could be redacted, breaking trace correlation across logs.

Strictly limited to structural / diagnostic fields that are *definitionally*
not personal data:

- log envelope fields (`level`, `msg`, `ts`)
- correlation IDs (`request_id`, `trace_id`, `span_id`)
- HTTP routing metadata (`route`, `method`, `path`, `status`)
- timing / size measurements (`duration_ms`, `write_count`, etc.)
- schema-event identifiers (`tx_name`, `rule_id`, `source_doc_id`, `collection`)

Any field whose value is *user-supplied* (even if it currently appears
benign) belongs in the schema as a `pii`-tagged field instead, NOT here.

```ts
const SAFE_PASSTHROUGH: ReadonlySet<string>;
```

### `SENSITIVE_EXACT`

Field names that MUST carry a `pii` meta when they appear at any depth in a
schema — matched against EVERY segment of a leaf's path, not just the last.

The any-segment rule is load-bearing: `address` and `billing_address` are
object-typed everywhere in core, so they are never a leaf's own name. A
leaf-only match would make those two entries dead letters and would miss an
untagged address container entirely — which is the exact class of bug the
`Address` object-level tag was introduced to fix.

```ts
const SENSITIVE_EXACT: ReadonlySet<string>;
```

### `SENSITIVE_NAME_FIELD`

Field name treated as sensitive only inside contact / org / user-adjacent schemas.

```ts
const SENSITIVE_NAME_FIELD: "name";
```

### `applyPii(record: T, schema: z.ZodType<T>, strategy: PiiStrategy): T`

Recursively apply the strategy's PII transforms to every field in
`record` whose schema position carries a `.meta({ pii })` tag.

Returns a shallow-cloned record at each object level — never mutates the
input. Safe to call on the same record repeatedly; idempotent for mask /
redact (hash is deterministic).

### `createLoggerStrategy(hashFn?: fnOrConstructor): PiiStrategy`

Default strategy for the structured logger.

- `mask`   → partial reveal via {@link mask}
- `redact` → literal `[REDACTED]`
- `hash`   → calls `hashFn(value)` if supplied; otherwise FAIL-CLOSED to
             `redact()` (never raw passthrough, never throws). Logging
             must never throw, so a missing key degrades gracefully.
- `none`   → pass through unchanged

**Non-string SCALARS under a tag fail closed** — a number or boolean is
`[REDACTED]`, not passed through. It used to pass through, which meant a
numeric leaf inside a tagged subtree was never scrubbed:
`Address.address_coordinates` is a 6dp geocode (≈0.11 m) and went to the log
raw. That was survivable only while no log record schema embedded an
`Address`, an invariant nothing enforced (it is now pinned by
`tests/log-imports.test.ts`) and which was never the real guarantee anyway —
a log arm can write `z.number().meta({pii:"mask"})` inline without importing
anything at all.

Two deliberate passthroughs remain:

- **`null` / `undefined`** — they carry no PII, and callers rely on the
  absent-stays-absent contract.
- **Containers (objects and arrays)** — returned by reference so the walker
  keeps descending to the leaves. This is load-bearing, not an oversight:
  {@link PiiStrategy} is offered every container before descent and treats a
  changed return value as "replace this wholesale and stop", so redacting here
  would collapse a masked `Address` to a single `"[REDACTED]"` string and
  destroy the `city` / `region` / `country_name` `pii: "none"` opt-outs inside
  it.

Returning a container by reference is therefore a *descend* instruction, never
a passthrough — and the walker holds up its end: a tagged container it cannot
descend (an OBJECT-shaped scalar such as a `Date` or a Firestore `Timestamp`)
is redacted by {@link applyPii} itself rather than emitted raw. It used to be
emitted raw; nothing in this file guaranteed otherwise except the observation
that no schema had one under a tag.

**Parameters**

- `hashFn` — Optional sync HMAC function. The api-cloudrun logger
supplies `(v) => nodeHash(v, LOG_HMAC_KEY)`; browser
consumers omit it (no sync HMAC available — manager
pre-scrub should only use `mask` / `redact` classifications
in its records).

### `mask(value: string): string`

Partial-reveal mask. Shape-preserving so masked values stay debuggable
(you can tell two masked emails differ) without exposing PII.

- **Emails** (contain a single `@` mid-string): keep first char of local
  part, mask the rest, keep the full domain.
  `alice@example.com` → `a****@example.com`
- **Other strings** of length ≥ 4: keep first and last char, mask between.
  `abcdefg` → `a*****g`
- **Short strings** (length < 4): fully redact — masking would leak too
  much of a 2–3 char value.
  `ab` → `[REDACTED]`

### `readPiiTag(node: z.ZodType): PiiClassification | undefined`

Read a field's `pii` classification, checking every wrapper level.

The one reader for both the runtime walker and the schema-drift test
(`tests/pii.test.ts`) — they used to disagree about *where* a tag lives (the
test walked the wrapper chain, the walker unwrapped first and read only the
final node), which is exactly how `Address`'s object-level `pii: "mask"`
stayed green in the test while doing nothing at runtime.

### `redact(): string`

Full redaction. Returns the literal string `[REDACTED]`.

## `@cfs/core/schemas/pii/hash-node`

### `nodeHash(value: string, key: string): string`

Compute `HMAC-SHA256(value, key)` and return the first 16 hex chars of
the digest — collision-resistant enough for log correlation, short enough
to keep records compact.

Callers should stringify non-string values before invoking. An empty
string is hashed normally (no special case), so two empty values
correlate; ensure the caller has skipped null/undefined.

**Parameters**

- `value` — Raw string to pseudonymize.
- `key` — HMAC secret. Must be stable across instances for correlation.

## `@cfs/core/schemas/uploadcare`

### `MEDIA_CONTAINER_RE`

Field/parent names that conventionally *contain* CDN files.

**Do not widen this list.** Adding `icons?|logos?|…` makes `lists::icon`
(`list.ts`, a UI icon/colour pair) a candidate with no exemption, and the
lint fails on day one for a field that has nothing to do with the CDN. The
residual — a CDN field named `logo` or `signature` — is deliberately left to
the harvest, which does not care what a field is called.

```ts
const MEDIA_CONTAINER_RE: RegExp;
```

### `UPLOADCARE_CANDIDATE_EXEMPTIONS`

Candidate leaves the lint should not flag. Keyed `<collection>::<leaf path>`.

Two kinds live here. Most are leaves that simply are **not** CDN file ids
(`alt`, `filename`, `mime_type`). A few — the `uploadcare_files[].uuid` work
lists — genuinely **are** CDN ids and are exempted anyway, because annotating
them would enlist a transient producer work list into the hand-written
extractors, the `.select()` projections and the `EXPECTED_REF_PATHS` snapshot,
and so into the `refCounts` scan-anomaly canary. Their protection comes from
the value harvest, which does not consult this map at all.

A stale entry here is an ergonomics bug, never a data-loss bug — the harvest
protects files regardless of what this map says. `uploadcareRef.test.ts`
asserts in both directions, so an exemption for a field that no longer exists
fails the build.

```ts
const UPLOADCARE_CANDIDATE_EXEMPTIONS: ReadonlyMap<string, string>;
```

### `UPLOADCARE_COLLECTION_KEYS`

The collections that hold CDN refs today, **pinned**.

Pinned rather than derived because the `schemas` record deliberately maps a
singular *and* a plural key to the same instance (`"card"` and `"cards"` are
the same node), so "dedupe by instance" is underdetermined — first-wins gives
the singular, last-wins the plural, and only one of them is the Firestore
collection name the sweep counts against.

These are `schemas`-record keys, NOT the schema-level `.meta({ collection })`:
`OrderDocumentSchema`'s meta reads `"orders/{uid}/documents"`, which matches
neither the sweep's `collectionCounts` keys nor `db.collectionGroup("documents")`.

```ts
const UPLOADCARE_COLLECTION_KEYS: "quotes" | "invoices" | "products" | "cards" | "recurrences" | "templates-versions" | "documents"[];
```

### `UPLOADCARE_REF_META`

The `.meta()` key `uploadcareRef()` sets. Read by the walker + the lint.

```ts
const UPLOADCARE_REF_META: "uploadcareRef";
```

### `UploadcareCollectionKey`

A key of {@link UPLOADCARE_COLLECTION_KEYS}.

```ts
type UploadcareCollectionKey = indexedAccess;
```

### `isUploadcareCandidate(leaf: LeafPath): boolean`

True when a leaf looks like it holds an Uploadcare CDN file id.

The `type === "string"` gate is REQUIRED, not cosmetic: without it the
predicate also matches `attachments[].{type,size_bytes,locked}` and yields 19
candidates instead of 13.

A `format === "uuid"` heuristic is unusable as an arm here — dozens of leaves
carry it, because `ItemUid` is a union containing `z.uuid()` and spreads
through orders / invoices / fulfillments / tags / stores, and every `xero_id`
is a `z.uuid()` too.

### `uploadcareRef(schema: T): T`

Mark a schema node as holding an Uploadcare CDN file id.

Wrap the **leaf**, not its container: `z.array(uploadcareRef(z.string()))`,
never `uploadcareRef(z.array(z.string()))`. `collectLeafPaths` merges meta
down a node's own wrapper chain (`.optional()`, `.nullable()`, …) but not
across a container boundary, so an annotation on the array node would be
invisible to `uploadcareRefPaths()`. The lint catches that: the element leaf
stays an unwrapped candidate and assertion 1 fails.

### `uploadcareRefPaths(): Record<string, string[]>`

Every `uploadcareRef()`-annotated leaf, grouped by collection.

Paths carry `collectLeafPaths`' container markers, e.g.
`{ invoices: ["uploadcare_uuid", "pdf_versions[].uploadcare_uuid"] }`.
Sorted for a stable snapshot.

### `uploadcareSelectFields(collection: string): string[]`

The top-level Firestore field names a `.select()` projection must carry to
reach every CDN ref in `collection` — the first path segment of each ref,
container markers stripped (`pdf_versions[].uploadcare_uuid` → `pdf_versions`).

Throws on an unknown collection rather than returning `[]`: an empty
projection would silently under-count the sweep's canary.

## `@cfs/core/schemas/uploadcare-sweep`

### `UploadcareSweepRun`

One recorded sweep run.

```ts
interface UploadcareSweepRun {
  ref_counts: Record<string, number>;
  recorded_at: FirestoreTimestampType;
}
```

### `UploadcareSweepRunSchema`

Zod schema for UploadcareSweepRun.

```ts
const UploadcareSweepRunSchema: z.ZodType<UploadcareSweepRun>;
```

## `@cfs/core/schemas/role`

### `Role`

A role document in Firestore.

```ts
interface Role {
  name: string;
  label: string;
  permissions: string[];
  description?: string;
  uid_thread?: string;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}
```

### `RoleSchema`

Zod schema for Role.

```ts
const RoleSchema: z.ZodType<Role>;
```

## `@cfs/core/schemas/permissions`

### `PERMISSIONS`

The full catalog of permissions. Adding a new route? Add its permission here first.

```ts
const PERMISSIONS: "orders.create" | "orders.read" | "orders.update" | "orders.delete" | "orders.search" | "orders.checkout" | "orders.return" | "products.create" | "products.read" | "products.update" | "products.delete" | "products.search" | "webshopProducts.read" | "webshopProducts.search" | "contacts.create" | "contacts.read" | "contacts.update" | "contacts.delete" | "contacts.search" | "organizations.create" | "organizations.read" | "organizations.update" | "organizations.delete" | "organizations.search" | "transactions.create" | "transactions.read" | "transactions.update" | "transactions.delete" | "invoices.create" | "invoices.read" | "invoices.update" | "invoices.delete" | "invoices.search" | "settlements.create" | "settlements.read" | "settlements.reverse" | "creditNotes.create" | "creditNotes.read" | "creditNotes.update" | "creditNotes.void" | "creditNotes.search" | "quotes.create" | "quotes.read" | "quotes.update" | "quotes.delete" | "locations.create" | "locations.read" | "locations.update" | "locations.delete" | "locations.search" | "locationTypes.create" | "locationTypes.read" | "locationTypes.update" | "locationTypes.delete" | "stores.create" | "stores.read" | "stores.update" | "stores.delete" | "stores.search" | "taxes.create" | "taxes.read" | "taxes.update" | "taxes.delete" | "tags.create" | "tags.read" | "tags.update" | "tags.delete" | "tags.search" | "trackingCategories.create" | "trackingCategories.read" | "trackingCategories.update" | "trackingCategories.delete" | "trackingCategories.search" | "holidays.create" | "holidays.read" | "holidays.update" | "holidays.delete" | "templates.create" | "templates.read" | "templates.search" | "templates.propose" | "templates.release" | "templates.merge" | "templates.rollback" | "templates.blessGolden" | "templates.archive" | "lists.create" | "lists.read" | "lists.update" | "lists.delete" | "cards.create" | "cards.read" | "cards.update" | "cards.delete" | "cards.search" | "recurrences.create" | "recurrences.read" | "recurrences.update" | "recurrences.delete" | "bookings.read" | "bookings.update" | "chartOfAccounts.read" | "chartOfAccounts.search" | "dateHelpers.read" | "destinations.read" | "destinations.search" | "ledgers.read" | "fulfillment.read" | "fulfillment.search" | "fulfillment.update" | "fulfillment.reset" | "outOfService.create" | "outOfService.read" | "outOfService.update" | "outOfService.delete" | "outOfService.search" | "stockSummaries.read" | "typesenseSync.read" | "users.read" | "users.update" | "users.delete" | "users.invite" | "users.search" | "users.assignRoles" | "roles.read" | "roles.edit" | "threads.create" | "threads.read" | "threads.update" | "threads.search" | "comments.create" | "comments.read" | "comments.update" | "comments.delete" | "comments.moderate" | "comments.search" | "comments.react" | "uploads.sign" | "admin.reindex" | "admin.validate" | "admin.sync" | "admin.previewRole"[];
```

### `Permission`

Union type of every permission string in the catalog.

```ts
type Permission = indexedAccess;
```

### `RouteManifest`

Runtime route manifest — emitted by api-cloudrun at GET /permissions/manifest.

```ts
interface RouteManifest {
  version: string;
  permissions: readonly Permission[];
  routes: RouteManifestEntry[];
}
```

### `RouteManifestEntry`

A single entry in the runtime route manifest — one per protected route.

```ts
interface RouteManifestEntry {
  method: RouteMethod;
  path: string;
  permission: Permission;
  operationId?: string;
}
```

### `RouteMethod`

HTTP methods accepted by the runtime route manifest.

```ts
type RouteMethod = "get" | "post" | "put" | "delete" | "patch";
```

## `@cfs/core/schemas/thread`

### `Thread`

Thread Firestore document shape.

```ts
interface Thread {
  uid: string;
  sources: DocSourceType[];
  title: string | null;
  last_message_at: FirestoreTimestampType | null;
  last_message_preview: string;
  comment_count: number;
  version: number;
  created_by: ActorRefType;
  updated_by: ActorRefType;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}
```

### `ThreadSchema`

Zod schema for a thread Firestore document.

```ts
const ThreadSchema: z.ZodType<Thread>;
```

### `UpdateThreadInput`

Zod schema for updating a thread.

```ts
const UpdateThreadInput: z.ZodType<UpdateThreadInputType>;
```

### `UpdateThreadInputType`

Input for PATCH /threads/:uid — rename only.

```ts
interface UpdateThreadInputType {
  title: string | null;
  version: number;
}
```

## `@cfs/core/schemas/comment`

### `Comment`

Comment Firestore document shape.

```ts
interface Comment {
  uid: string;
  uid_thread: string;
  sources: DocSourceType[];
  body: CommentBodyJson;
  body_text: string;
  reactions: Record<string, Record<string, ActorRefType>>;
  git?: CommentGitMirror;
  version: number;
  created_by: ActorRefType;
  deleted_at: FirestoreTimestampType | null;
  deleted_by: ActorRefType | null;
  updated_by: ActorRefType;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}
```

### `CommentBody`

Zod schema for the Tiptap JSON body.

```ts
const CommentBody: z.ZodType<CommentBodyJson>;
```

### `CommentBodyJson`

Tiptap JSON body payload. Stored as a loose record to keep the schema
forward-compatible with Tiptap's node spec. The composer owns shape
correctness; the `body_text` mirror is the authoritative plain-text form.

```ts
type CommentBodyJson = Record<string, unknown>;
```

### `CommentGitMirror`

GitHub PR-comment mirror metadata. Set only on template branch-thread
comments by the comment-sync Cloud Task after the external POST: `comment_id`
is the GitHub issue-comment id (the idempotency key for later update/tombstone
PATCHes). `synced_at` is an internal machine timestamp marking the last
successful mirror — it is NEVER transmitted to GitHub (GitHub server-stamps
its own comment times).

```ts
interface CommentGitMirror {
  comment_id: number;
  node_id?: string;
  html_url?: string;
  synced_at: FirestoreTimestampType;
}
```

### `CommentGitMirrorSchema`

Zod schema for a comment's GitHub-mirror metadata.

```ts
const CommentGitMirrorSchema: z.ZodType<CommentGitMirror>;
```

### `CommentReactionInput`

Zod schema for a comment reaction add/remove.

```ts
const CommentReactionInput: z.ZodType<CommentReactionInputType>;
```

### `CommentReactionInputType`

Input for POST /comments/:uid/reactions.

```ts
interface CommentReactionInputType {
  emoji: string;
  action: ReactionActionType;
}
```

### `CommentSchema`

Zod schema for a comment Firestore document.

```ts
const CommentSchema: z.ZodType<Comment>;
```

### `CreateCommentInput`

Zod schema for creating a comment.

```ts
const CreateCommentInput: z.ZodType<CreateCommentInputType>;
```

### `CreateCommentInputType`

Input for POST /comments.

```ts
interface CreateCommentInputType {
  uid_thread: string;
  body: CommentBodyJson;
  body_text: string;
}
```

### `ReactionActionType`

Allowed reaction actions.

```ts
type ReactionActionType = indexedAccess;
```

### `UpdateCommentInput`

Zod schema for updating a comment.

```ts
const UpdateCommentInput: z.ZodType<UpdateCommentInputType>;
```

### `UpdateCommentInputType`

Input for PATCH /comments/:uid.

```ts
interface UpdateCommentInputType {
  body: CommentBodyJson;
  body_text: string;
  version: number;
}
```

## `@cfs/core/utils/availability`

The availability engine — the single source of the CFS availability formula.

A stock summary caches the *inputs* to an availability answer (one doc per
product: `quantity_held` + the live booking intervals + the live OOS
intervals). The window enters only as an overlap filter, so any window is
derivable from that one doc, by anyone holding it:

```ts
import { computeAvailability } from "@cfs/core/utils/availability";

const { quantity_available } = computeAvailability(summary, {
  start: "2026-06-01T00:00:00.000-05:00",
  end:   "2026-06-05T00:00:00.000-05:00",
});
```

Pure and db-free: interval arithmetic runs off `FirestoreTimestampValue`'s
structural `toMillis()` (or the paired ISO string), so this runs unchanged in
Deno on the server, in the browser against an `onSnapshot` doc, and over a
plain JSON fixture in a test. No Firestore SDK import, either side.

**Availability is always Chicago wall clock, and this module owns that rule.**
The shop is in Chicago; a requester in California asking for "June 1 – June 5"
means Chicago `Jun 1 00:00:00.000` → `Jun 5 23:59:59.999`, no matter where the
browser is. The window is normalized here — `toChicagoStartOfDay` on `start`,
`toChicagoEndOfDay` on `end` — so a `-08:00`, a `Z` and a `-06:00` spelling of
the same day produce identical numbers. Callers pass offset-carrying ISO
strings; a bare `YYYY-MM-DD` is rejected upstream by the schema factories.

**This must not be decomposed into a per-day rollup.** With `held = 2`, a
booking on days 1–2 and another on days 4–5, the answer for window `[1, 5]` is
exactly **0** — no single unit is free for the whole span — while a
min-over-days curve says 1. Overstating availability oversells. Intervals give
the exact answer; a daily curve does not.

### `AvailabilityResult`

Everything the manager's availability cells and stock panel need for one window.

```ts
interface AvailabilityResult {
  quantity_held: number;
  quantity_booked: number;
  quantity_out_of_service: number;
  quantity_in_service: number;
  quantity_available: number;
  bookings_breakdown: BookingBreakdown;
  out_of_service_breakdown: OutOfServiceBreakdown;
  bookings: StockSummaryBookingEntry[];
}
```

### `AvailabilityWindow`

The window an availability question is asked about. Offset-carrying ISO strings.

```ts
interface AvailabilityWindow {
  start: string;
  end: string;
}
```

### `OutOfServiceBreakdown`

Per-reason out-of-service quantities over the window.

```ts
interface OutOfServiceBreakdown {
  cleaning: number;
  damaged: number;
  maintenance: number;
  lost: number;
}
```

### `PublicAvailabilityResult`

The public storefront's answer — no booking/OOS detail, same exact numbers.

```ts
interface PublicAvailabilityResult {
  quantity_held: number;
  quantity_unavailable: number;
  quantity_available: number;
}
```

### `computeAvailability(summary: StockSummary, window: AvailabilityWindow): AvailabilityResult`

Compute availability for one product over one window, from the cached inputs.

```
quantity_available = quantity_held − quantity_booked(w) − quantity_out_of_service(w)
```

Negative results are preserved, never clamped: an oversold product must stay
visibly oversold.

### `computePublicAvailability(summary: PublicStockSummary, window: AvailabilityWindow): PublicAvailabilityResult`

The public-storefront form. Same arithmetic, run over the sanitized
`unavailable[]` list (bookings ∪ OOS, merged and anonymized), so an outsider
gets the exact number without learning what made a unit unavailable.

### `toPublicStockSummary(summary: StockSummary): PublicStockSummary`

Project the internal summary to its public twin — the one place the sanitized
shape is defined, so the API's writer and any rebuild script can't drift.

Bookings and OOS records merge into one anonymous interval list. Only
stock-*consuming* entries survive: a booking contributes `heldByBooking` (a
`quoted` booking holds nothing), and zero-quantity entries are dropped
outright — they'd leak the existence of a booking without affecting any answer.

## `@cfs/core/utils/bookings`

Pure helpers over the booking breakdown shape and the order's denormalized
roll-up. Used both server-side (api-cloudrun) and client-side (manager) so
the warehouse picker sees instant optimistic updates and the order detail
page can compute "is this order done?" without a round-trip.

```ts
import {
  sumBookingBreakdown,
  isOrderBookingsClosed,
  mergeBookingBreakdown,
} from "@cfs/core/utils/bookings";
```

### `BOOKING_BREAKDOWN_KEYS`

All seven keys of the booking lifecycle breakdown, in lifecycle order (which
is NOT the schema's alphabetical field order — the UI reads left to right).

These live beside the schema rather than in `utils/bookings.ts` because
schema modules cannot import utils (the dependency runs strictly one way) and
the movement journal needs the key union to type a custody transition.
`utils/bookings.ts` re-exports all three, so existing importers are unaffected.

```ts
const BOOKING_BREAKDOWN_KEYS: "quoted" | "reserved" | "prepped" | "out" | "returned" | "lost" | "damaged"[];
```

### `BOOKING_BREAKDOWN_TERMINAL_KEYS`

Keys representing items that have reached a terminal state.

```ts
const BOOKING_BREAKDOWN_TERMINAL_KEYS: "returned" | "lost" | "damaged"[];
```

### `BookingBreakdownKeyEnum`

Zod enum over the seven breakdown keys — the custody axis of a movement.

```ts
const BookingBreakdownKeyEnum: z.ZodType<BookingBreakdownKeyType>;
```

### `BookingBreakdownKeyType`

One key of the booking lifecycle breakdown.

```ts
type BookingBreakdownKeyType = indexedAccess;
```

### `applyBookingBreakdownDelta(orderBreakdown: indexedAccess, prev: indexedAccess, next: indexedAccess): void`

Apply a per-key delta to an order's bookings_breakdown roll-up in place.

Given a booking's previous and next breakdown, mutate the order roll-up by
`+= next[k] - prev[k]` for each key. Useful both server-side (where
`updateBooking` applies a single-doc delta to avoid reading every sibling
booking) and client-side (where the manager can apply the same delta
locally for instant feedback).

### `calculateBookingBreakdown(status: OrderStatusType, type: ComponentTypeType, quantity: number, existingBreakdown?: indexedAccess): indexedAccess`

Project a booking's breakdown for a given **order** status, item type, and
total quantity. Pure sync — no I/O.

⚠️ `status` is an `OrderStatusType`, **not** a `BookingStatusType`. The two
vocabularies overlap but are not the same set: an order can be `canceled`
(a booking cannot) and a booking can be `part-prepped`/`prepped` (an order
cannot). The projection is driven by the parent order, so a caller holding a
`booking.status` must read through to the order rather than pass it here —
that mismatch is what the narrowing exists to make a compile error.

Status rules:
  draft / canceled  → all zeros (cleared on cancel/draft)
  quoted            → quoted = quantity − carry; preserves prepped/out/terminals
  reserved / active → reserved = quantity − carry; preserves prepped/out/terminals
  complete + rental → returned = quantity − (lost + damaged); zero everything else
  complete + sale   → out = quantity; zero everything else
  complete + service / surcharge → all zeros

### `emptyBookingsBreakdown(): indexedAccess`

The empty breakdown shape — all seven keys at zero.

Use as the seed for new orders and as the target shape for fresh bookings.

```ts
const order = { ...orderInput, bookings_breakdown: emptyBookingsBreakdown() };
```

### `isBookingClosed(b: Pick<Booking, "type" | "breakdown">): boolean`

Per-booking closure rule.

`quoted + reserved + prepped` must always be zero. The treatment of `out`
depends on `booking.type`:

- `rental`: `out` is in-flight — units must be returned (or lost/damaged)
  before the booking is closed.
- any other type (`sale`, defensively `service`/`surcharge`): `out` is
  terminal — checkout is delivery and the units don't come back. The
  booking can sit in `out` indefinitely without blocking completion.

Sale items still expose Return/Lost/Damaged actions in the picker (a sold
item *can* be returned for credit and lost/damaged-in-transit is real) —
they're available, just not required for closure.

### `isOrderBookingsClosed(bookings: ReadonlyArray<Pick<Booking, "type" | "breakdown">>): boolean`

Predicate: is the order fully closed?

An order is closed when every booking is closed (per `isBookingClosed`)
and the order has at least one booking. The non-empty guard prevents
auto-completing an empty order simply because it has nothing in flight.

Drives the auto-cascade in the booking write path: when this predicate
flips to true after applying booking deltas, the order's status is set to
"complete" in the same Firestore transaction.

### `mergeBookingBreakdown(current: indexedAccess, patch: Partial<indexedAccess> | undefined): indexedAccess`

Merge a `Partial<breakdown>` over a current breakdown. Missing keys are
inherited from `current`. Useful for the optimistic UI path: a picker
types "returned: 1, out: 2" and the manager renders the merged result
before the API confirms.

### `sumBookingBreakdown(b: indexedAccess): number`

Sum the seven values of a single booking's breakdown.

The booking-level invariant is `sumBookingBreakdown(booking.breakdown) === booking.quantity`.
Use this to verify that a proposed breakdown change preserves the invariant
before submitting it through `PUT /bookings/{uid}`.

### `sumBookingsBreakdown(bookings: Array<typeLiteral>): indexedAccess`

Sum a list of booking breakdowns into the order's roll-up shape.

Mirrors the keys of `stock-summaries.bookings_breakdown` (which aggregates
along the *product* axis) but aggregated along the *order* axis. Used to
seed `order.bookings_breakdown` at create/update time and to recompute it
client-side from cached bookings when the order doc isn't authoritative
yet.

## `@cfs/core/utils/cards`

Pure helpers over event-card lifecycle. Shared by api-cloudrun (writers
inside the booking-update transaction) and the manager (optimistic
client-side projections in `applyBookingActions`) so both sides agree on
exactly what `card.status` becomes after a booking write.

```ts
import { computeCardStatusFromBookings } from "@cfs/core/utils/cards";
```

### `CardSiblingBooking`

Subset of `Booking` the formula reads. Keeps the helper dependency-light.

```ts
type CardSiblingBooking = Pick<Booking, "type" | "quantity" | "breakdown">;
```

### `CardSide`

Which side of the order's lifecycle a card represents:
- `"start"` — delivery event (items leave the warehouse for a destination).
  Backed by sibling bookings filtered by `uid_destination_delivery`.
- `"end"`   — collection event (items return from a destination).
  Backed by sibling bookings filtered by `uid_destination_collection`.

```ts
type CardSide = "start" | "end";
```

### `computeCardActionFromBookings(side: CardSide, siblings: CardSiblingBooking[], current: CardStatus): CardAction | null`

Recompute a card's denormalized **next fulfillment action** from its sibling
bookings — the value the `CardTile` button shows on surfaces (Dashboard
kanban, Calendar agenda) where no bookings are loaded. Pure function — no
Firestore reads. Computed in lockstep with `computeCardStatusFromBookings`
on every booking write.

Returns `null` (no actionable next step) when:
- `current` is `blocked | canceled | complete | draft` — **wider than the
  status helper**, which only preserves `blocked`/`canceled`. A complete or
  draft card must never surface a stale action.
- the relevant side has nothing pending (see per-side rules).

**Start side (delivery)** — siblings filtered to `uid_destination_delivery`.
No sale filter: sale lines are genuinely prepped + checked out on delivery.
  - `reserved > 0` → `prep`     (still has unprepped quantity)
  - else `prepped > 0` → `checkout` (prepped, awaiting check-out)
  - else → `null`               (nothing reserved/prepped; quote-only or fully out)

**End side (collection)** — **rentals only** (`b.type === "rental"`),
mirroring the end-card status formula. Sale, service, and surcharge lines
have no collection event.
  - `out > 0` → `return`        (checked-out rental quantity awaiting return)
  - else → `null`               (nothing out yet — end card shows no action
                                 until check-out produces `out > 0`)

Side-scoped by design: a start card never reports `return` and an end card
never reports `prep`/`checkout` — unlike the manager's destination-wide
`getStageForBookings`, which collapses both sides into one stage.

**Parameters**

- `side` — Which card side — selects the per-side rule + sibling set.
- `siblings` — Bookings filtered to the relevant destination side.
- `current` — The card's current status — non-actionable statuses null out.

### `computeCardStatusFromBookings(side: CardSide, siblings: CardSiblingBooking[], current: CardStatus): CardStatus`

Recompute an event card's `status` from its sibling bookings on the
destination it belongs to. Pure function — no Firestore reads.

Preserves manual overrides:
- `"blocked"` — manually set on the card; sticks until either the parent
  order transitions to canceled (handled in update-order) or a future
  "Clear block" affordance writes a new auto value through the same path.
- `"canceled"` — terminal; sourced from order.status only.

Otherwise, applies per-side roll-up rules:

**Start card (delivery)** — siblings filtered to `uid_destination_delivery`:
  - `pre_delivery = Σ (quoted + reserved + prepped)` — still in the warehouse.
  - `out          = Σ breakdown.out` — delivery in flight.
  - if `pre_delivery === 0`            → `complete` (everything has at least left)
  - else if `out > 0`                  → `active`   (delivery in progress)
  - else                                → `planned`  (nothing has moved yet)

  Known limitation: `pre_delivery === 0 → complete` would read `complete` for
  a hypothetical phased order where every unit has *at least* left the
  warehouse but some legs are still mid-cycle. No live incidence today;
  tracked as a low-priority follow-up, not a code change.

**End card (collection)** — siblings filtered to `uid_destination_collection`,
  then to **rentals only** (`b.type === "rental"`). Only a rental has a
  collection event — checked out (`breakdown.out > 0`) and later returned —
  so only a rental can drive the card to `complete`. Sale, service, and
  surcharge lines are all excluded:
  - a kept **sale** sits permanently at `out = quantity` (a sale is only
    rarely returned, and then via the fulfillment flow, never via the card);
  - **service** / **surcharge** lines have no return event at all, so their
    `breakdown.out` is always 0 and they never reach a terminal
    `returned`/`lost`/`damaged` count.
  Counting any of their `quantity` toward `total` would leave
  `terminal < total` forever and pin the end card `active` after the rentals
  are all back.
  - `terminal  = Σ (returned + lost + damaged)`
  - `total     = Σ booking.quantity`
  - `still_out = Σ breakdown.out`
  - if `terminal === total`              → `complete` (everything collected/written-off)
  - else if `terminal > 0 || still_out > 0` → `active`   (collection in progress)
  - else                                  → `planned`  (nothing has come back yet)

If the end-side roll-up has no rental siblings (e.g. a sale/service-only
destination), the card resolves to `complete` — there is nothing to collect.

**Parameters**

- `side` — Which card side this is — drives which key set we sum and
which sibling set the caller is expected to have prepared.
- `siblings` — Bookings filtered to the relevant destination side.
- `current` — The card's current status — preserved if `blocked` or
`canceled` so manual overrides aren't clobbered.

## `@cfs/core/utils/contact-name`

Contact name helpers — re-exports the canonical `deriveName` from
`@cfs/core/schemas` so manager and other utilities consumers can import it
from a single, stable runtime location.

```ts
import { deriveName } from "@cfs/core/utils/contact-name";

deriveName({ first_name: "Alex", last_name: "Hughes" }); // "Alex Hughes"
deriveName({ first_name: "Alex", pronunciation: "al-ix" }); // "Alex (al-ix)"
```

Stored documents (Contact, User, Invite, embedded contact refs) carry a
denormalized `name` field populated by the server via this helper. Use
`entity.name` directly when the doc has been read back; only call
`deriveName` for in-flight objects whose `name` hasn't been server-derived
yet (e.g. manager-side optimistic state before the API responds).

### `deriveName(parts: PartialNameParts): string`

Canonical join rule for deriving a single display string from name parts.
Joins `[first_name, middle_name, last_name]` with single spaces (missing
parts are dropped, never produce empty padding) and appends ` (pronunciation)`
when set. This is the single source of truth — every `name` field on a
stored document and `ActorRef.name` is computed by passing through here.

## `@cfs/core/utils/dates`

Pure date helper functions for CFS applications.
All functions accept holidays as a parameter to enable client-side calculations.

```ts
import { formatChargeDays, countCfsBusinessDays } from "@cfs/core/utils/dates";

const result = formatChargeDays(10);
console.log(result.periodLabel); // "2 weeks"

const start = new Date("2025-01-06");
const end = new Date("2025-01-10");
const days = countCfsBusinessDays(start, end, []);
console.log(days.days); // 5
```

Published in lockstep with `@cfs/core/schemas` — version bumps track the
schemas package so consumers pin one pair of beta versions without
resolving dual shapes (Card.recurrence_overrides, Recurrence collection
rollout, etc.).

### `BusinessDaysResult`

Result of a business-day count between two dates.

```ts
interface BusinessDaysResult {
  calendarDays: number;
  calendarWeeks: number;
  days: number;
  weeks: number;
  label: ChargeDaysLabel;
  periodLabel: string;
}
```

### `ChargeDaysLabel`

Display values returned by {@link formatChargeDays}.

```ts
type ChargeDaysLabel = "day" | "days" | "week" | "weeks";
```

### `DurationDates`

Date strings required by {@link getDuration}. Nullable to mirror OrderDocDatesType — runtime guards throw when either boundary is null.

```ts
interface DurationDates {
  delivery_start: string | null;
  collection_start: string | null;
  charge_start?: string | null;
  charge_end?: string | null;
}
```

### `DurationResult`

Active and chargeable duration breakdown returned by {@link getDuration}.

```ts
interface DurationResult {
  activeDays: number;
  activeWeeks: number;
  activeLabel: string;
  activePeriodLabel: string;
  chargeDays: number;
  chargeWeeks: number;
  chargeLabel: string;
  chargePeriodLabel: string;
}
```

### `FormatChargeDaysResult`

```ts
interface FormatChargeDaysResult {
  value: number;
  label: ChargeDaysLabel;
  periodLabel: string;
  isWeeks: boolean;
  step: number;
}
```

### `countCfsBusinessDays(start: Date, end: Date, holidays: string[]): BusinessDaysResult`

Count CFS business days between two dates (excludes weekends and CFS holidays).

### `formatChargeDays(days: number, unit?: "day" | "days" | "week" | "weeks"): FormatChargeDaysResult`

Format a chargeable days number into display values for a duration input.

The unit (day vs. week) is chosen one of two ways:
- **Explicit** — pass `unit` (`"day"`, `"days"`, `"week"`, or `"weeks"`); the
  caller's choice wins, and singular/plural is normalized from the computed value.
- **Auto (omit `unit`)** — the mode is derived from the day count: weeks when
  `days >= 5`, days when `days < 5` (the boundary `days === 5` formats as `1 week`).
  Omitting the argument *is* the auto path — there is no separate `"default"`/`"auto"` unit value.

In weeks mode `value = days / 5` and `step = 0.2`; in days mode `value = days` and
`step = 1`. `label` is always one of the four concrete {@link ChargeDaysLabel} literals,
singularized when `value === 1`.

**Parameters**

- `days` — A positive, finite number of chargeable days. Throws on `<= 0` / non-finite.
- `unit` — Optional display unit. Omit to auto-derive from `days` (see above).

**Returns** — — `{ value, label, periodLabel, isWeeks, step }`.

### `getDefaultStartDate(holidays: string[]): Date`

Get the default start date for a rental (next business day at 9am).
If after 8am today, defaults to tomorrow. Skips weekends and holidays.

### `getDuration(dates: DurationDates, holidays: string[]): DurationResult`

Calculate active and chargeable durations for an order's dates.

### `getEndDateByChargePeriod(startDate: Date, chargePeriod: number, holidays: string[]): Date`

Calculate end date based on start date and number of chargeable days.
Chargeable days exclude weekends and holidays.

### `isHoliday(testDate: Date, holidays: string[]): boolean`

Test if a given date is a CFS holiday.

### `isOffHours(date: Date): boolean`

Test if a date/time is outside business hours (before 8am or after 4pm).

### `toChargeDays(inputValue: number, isWeeks: boolean): number`

Convert a duration input value back to chargeable days.

### `toChicagoEndOfDay(input: string): string`

Canonicalize to the last representable instant of the Chicago calendar date
containing the input (`23:59:59.999` local). The closing twin of
{@link toChicagoStartOfDay} — together they turn a pair of dates into the
half-open-in-spirit, closed-in-fact window `[startOfDay(s), endOfDay(e)]` that
{@link module:availability} overlaps intervals against. Idempotent, DST-aware.

```ts
toChicagoEndOfDay("2025-12-22T15:15:00.000Z"); // "2025-12-22T23:59:59.999-06:00"
toChicagoEndOfDay("2025-12-22T03:00:00.000Z"); // "2025-12-21T23:59:59.999-06:00" (Chicago day = Dec 21)
toChicagoEndOfDay("2025-07-04");               // "2025-07-04T23:59:59.999-05:00" (CDT)
```

### `toChicagoInstant(input: string): string`

Canonicalize any valid ISO datetime string to Chicago offset form,
preserving the instant. Idempotent.

```ts
toChicagoInstant("2025-12-22T15:15:00.000Z");      // "2025-12-22T09:15:00.000-06:00"
toChicagoInstant("2025-12-22T09:15:00.000-06:00"); // "2025-12-22T09:15:00.000-06:00" (no-op)
toChicagoInstant("2025-12-23T00:15:00.000+09:00"); // "2025-12-22T09:15:00.000-06:00" (same instant)
```

### `toChicagoStartOfDay(input: string): string`

Canonicalize to Chicago local midnight for the calendar date containing
the input instant. Use for fields that semantically represent a date
(invoice.date, invoice.due_date, payments[].date). Idempotent.

```ts
toChicagoStartOfDay("2025-12-22T15:15:00.000Z"); // "2025-12-22T00:00:00.000-06:00"
toChicagoStartOfDay("2025-12-22T03:00:00.000Z"); // "2025-12-21T00:00:00.000-06:00" (Chicago day = Dec 21)
toChicagoStartOfDay("2025-07-04");               // "2025-07-04T00:00:00.000-05:00" (CDT)
```

### `toChicagoYmd(input: string): string`

Format an ISO datetime as the Chicago calendar date in `YYYY-MM-DD` form.
The inverse of {@link toChicagoStartOfDay} — use to populate
`<input type="date">` from a canonical Chicago-offset value.

```ts
toChicagoYmd("2025-02-14T00:00:00.000-06:00"); // "2025-02-14"
toChicagoYmd("2025-02-14T03:00:00.000Z");      // "2025-02-13" (Chicago day)
toChicagoYmd("2025-07-04T00:00:00.000-05:00"); // "2025-07-04" (CDT)
```

## `@cfs/core/utils/invoices`

Shared invoice utility functions for CFS applications.
Re-exports generic item helpers from orders and adds invoice-specific utilities.

```ts
import { flattenForXero, isPriceableItem, syncOrderItems } from "@cfs/core/utils/invoices";

const billableItems = flattenForXero(invoice.items);
```

### `AdoptedDividerStructure`

```ts
interface AdoptedDividerStructure {
  items: InvoiceDocItemType[];
  ambiguous: AmbiguousItemPairing[];
}
```

### `AmbiguousItemPairing`

A uid that identifies more than one line on at least one side, so the k-th
occurrence pairing in {@link adoptOrderDividerStructure} is a guess rather
than a fact. Reported, never silently resolved.

```ts
interface AmbiguousItemPairing {
  uid: string;
  invoiceOccurrences: number;
  orderOccurrences: number;
}
```

### `ConsolidatedItem`

```ts
type ConsolidatedItem = ConsolidatedItemType;
```

### `Discount`

```ts
type Discount = DiscountType;
```

### `GroupPath`

```ts
type GroupPath = GroupPathType;
```

### `INVOICE_ITEM_LEVELS`

The structural divider hierarchy of an INVOICE's items array, outermost
first — one level deeper than an order's, because an invoice can bill
several orders and separates them with an `order` divider.

```ts
const INVOICE_ITEM_LEVELS: "order" | "destination" | "group"[];
```

### `InvoiceDestinationPair`

Invoice-side destination pair: a {@link DocDestinationType} plus a `uid_order`
scope field, so a multi-order invoice can carry pairs from several orders and
have them selectively synced per source order. Alias of the canonical
`InvoiceDocDestinationType` from `@cfs/core/schemas`.

```ts
type InvoiceDestinationPair = InvoiceDocDestinationType;
```

### `InvoiceItem`

An invoice item with optional order-scoping and invoice-specific fields.
Extends LineItem with properties that should be carried forward during sync
and fields needed for Xero mapping.

`price` accepts both the utility's intermediate PriceObject and the full
InvoiceDocItemPrice from schemas to avoid type drift.

```ts
interface InvoiceItem {
  uid_order?: string | null;
  description?: string;
  price?: PriceObject | InvoiceDocItemPrice;
  coa_revenue?: COARevenueType | null;
  tracking_category?: string | null;
  xero_id?: string | null;
  xero_tracking_option_id?: string | null;
  crms_id?: number | string | null;
  crms_opportunity_id?: number | null;
}
```

### `InvoiceTotals`

```ts
type InvoiceTotals = InvoiceDocTotals;
```

### `ItemPathIssue`

A single path mismatch reported by {@link validateItemPaths} or
{@link validateInvoiceItemPaths} (re-exported from `@cfs/core/utils/invoices`).

```ts
interface ItemPathIssue {
  index: number;
  uid: string | undefined;
  path: string[];
  expected: string[];
}
```

### `ItemUniquenessIssue`

A single uniqueness violation reported by {@link validateItemUniqueness}
(and the invoice-scoped variant in `@cfs/core/utils/invoices`).

```ts
interface ItemUniquenessIssue {
  index: number;
  uid: string;
  parentUid: string | null;
  firstIndex: number;
}
```

### `LineItem`

A single item in an order/invoice/fulfillment array — product, divider,
surcharge or fee.

A structural supertype, not a shadow of the real unions. Every member of
`OrderDocItemType`, `InvoiceDocItemType` and `FulfillmentItemType` is
assignable to it, so a caller holding real doc items passes them straight in
and the generic helpers (`computeItemPaths`, `getItemSubtreeRange`, …) hand
back the caller's own type. It exists because the manager also calls these
helpers on STAGED, mid-edit items that are not yet valid doc items — narrowing
the helpers to the doc unions would force those callers back into casts.

`type` is `ItemTypeType`, NOT `string`. That is the difference between a
supertype and a hole: the pricing and billability predicates all resolve
through `ITEM_CONTRACTS`, and a `string` here made "a type with no contract" a
reachable state for every one of them. The runtime guards still handle it —
these items come off Firestore documents — but no caller can construct it.

Member-specific fields are still reached through the type guards
(`isPriceableItem`, `isPreTaxItem`, `isTransactionFeeItem`).

```ts
interface LineItem {
  uid: string;
  name: string;
  type: ItemTypeType;
  quantity?: number;
  price?: PriceObject;
  stock_method?: string;
  path: string[];
  uid_delivery?: string | null;
  uid_collection?: string | null;
  zero_priced?: boolean | null;
  description?: string;
  order_number?: number;
  uid_order?: string | null;
  coa_revenue?: COARevenueType | null;
}
```

### `PreTaxLineItem`

A pre-tax line item with a full price object — every type the contract table
marks `pricing: "pre_tax"`.

The member list is DERIVED from `ITEM_CONTRACTS`, not written out. It used to
be the literal `"rental" | "sale" | "service" | "surcharge" | "replacement"`,
which made this a sixth place to remember when an item type was added.

```ts
interface PreTaxLineItem {
  type: PreTaxItemType;
  quantity: number;
  price: PriceObject;
}
```

### `PreTaxPricingItem`

A {@link PricingItem} that has passed {@link isPreTaxPricingItem}.

```ts
type PreTaxPricingItem = PricingItem & typeLiteral;
```

### `PriceModifier`

```ts
type PriceModifier = PriceModifierType;
```

### `PriceObject`

```ts
type PriceObject = OrderDocItemPriceType;
```

### `PriceableLineItem`

Any item that has pricing — pre-tax or transaction fee.

```ts
type PriceableLineItem = PreTaxLineItem | TransactionFeeLineItem;
```

### `PricingItem`

The item surface the pricing pipeline reads: a type (to look up the contract),
a quantity, and a {@link PricingPrice}. Both a stored {@link LineItem} and an
order-input item satisfy it.

```ts
interface PricingItem {
  type: ItemTypeType;
  quantity?: number;
  price?: PricingPrice | null;
  coa_revenue?: number | null;
}
```

### `PricingPrice`

The price fields the pricing pipeline actually READS — deliberately narrower
than the stored {@link PriceObject}.

`taxes` needs only a `uid`, because the name/rate/type/amount_cents are what
`calculateItemTax` resolves and computes; `subtotal_cents`,
`subtotal_discounted_cents`, `total_cents` and `taxes_base` are pricing's
OUTPUT and are never read as input.

That is not a convenience: it is the shape an order-input item genuinely
arrives in (`ItemPriceType` in `@cfs/core/schemas`, whose `taxes` is
`{ uid }[]`). Typing the pricing entry points here is what lets a writer price
an item it has not built yet, instead of casting the input through
`as unknown as LineItem` and claiming a stored price it does not have —
which is what `api-cloudrun`'s `buildLineItem` did, twice, on the money path.

```ts
interface PricingPrice {
  base_cents?: number;
  base_percent?: number | null;
  formula?: PriceFormulaType;
  chargeable_days?: number | null;
  discount?: typeLiteral | null;
  taxes?: readonly typeLiteral[];
}
```

### `StructuralItem`

The item surface the structural/path helpers read: identity, type, and path.

Narrower than {@link LineItem} deliberately — these helpers never look at
`name`, `price` or `quantity`, and callers legitimately hold items that have
none of them yet (api-cloudrun's CRMS `ItemLike` is exactly this shape). Typing
them at `LineItem` is what forced `as unknown as LineItem[]` at those sites.

```ts
interface StructuralItem {
  uid: string;
  type: ItemTypeType;
  path?: string[];
}
```

### `Tax`

Subset of the full Tax document needed by utility functions.
`valid_from`/`valid_to` are optional — only the as-of resolver (`findTaxAt` in
`@cfs/core/utils/taxes`) reads them; pricing helpers ignore them. Optional so
partial `Tax` literals in tests/callers keep type-checking.

```ts
type Tax = Pick<SchemaTax, "uid" | "name" | "rate" | "type"> & Partial<Pick<SchemaTax, "valid_from" | "valid_to">>;
```

### `TransactionFeeLineItem`

A transaction fee line item.

Carries the same `PriceObject` every other line carries — a fee is an
ordinary line whose `price.formula` is `percent_of_total`, not a second price
shape. It differs from a `PreTaxLineItem` only in that it is priced FROM the
document total rather than into it, which is why it has its own predicate and
its own pass in `calculateOrderTotals`.

```ts
interface TransactionFeeLineItem {
  type: FromTotalItemType;
  quantity: number;
  price: PriceObject;
}
```

### `adoptOrderDividerStructure(scopedInvoiceItems: InvoiceDocItemType[], orderItems: LineItem[], orderDividerUid: string): AdoptedDividerStructure`

Re-hang one order-scope of an invoice's items on the ORDER's divider
skeleton. Pure, and **structure-only**.

The CRMS invoice tree carries none of the `group` dividers its order does
(measured 2026-08-10: zero of 999 prod invoices carry one; 941 of 978 orders
do), so every invoice line's path is shorter than its counterpart's and the
path-keyed comparators match nothing at all — `computeInvoiceSyncStatus`
reports every line both "missing" and "removed", and
`syncOrderToInvoiceSelective` re-projects nothing. This is what makes the two
trees comparable again; the direction is settled — **the order tree is
right**, and `flattenForXero` strips dividers at the Xero boundary so
carrying them costs Xero nothing.

What it does:
- **Adopts the order's divider skeleton wholesale.** A `destination`/`group`
  divider the order carries is placed at the order's position; an invoice-side
  divider the order lacks is dropped. A divider the invoice ALREADY carries
  under the same uid keeps its own row — only its `path` moves. That is
  deliberate: 112 prod invoices hold destination dividers whose
  `uid_delivery`/`uid_collection` point at a different `destinations` doc than
  the order's, and that staleness is a real difference the badge should keep
  showing, not something a structural repair should quietly overwrite.
- **Re-paths each paired line** to `[orderDividerUid, ...orderLine.path]`.
- **Adds, removes, re-prices, re-names and re-quantifies nothing.** An order
  line the invoice does not carry is NOT added; an invoice line the order does
  not carry is kept, at its current parent (root of the order scope when that
  parent no longer exists), because an invoice-only line is line-level drift
  for the badge to report — not a structural defect to erase.
- **Passes any `order` divider row through at the head**, and never mints one:
  its identity is the source order's uid and only the caller knows it.

Pairing is by `uid`; where a uid repeats, the k-th invoice occurrence pairs
with the k-th order occurrence in document order. `uid` is NOT a row identity
(it repeats within one document on 18% of prod orders), so those pairings are
returned in `ambiguous` for the caller to surface rather than being trusted
silently.

The result is a fixed point of {@link computeInvoiceItemPaths}: callers still
run it (and {@link validateInvoiceItemUniqueness}) before writing.

**Parameters**

- `scopedInvoiceItems` — This order's slice of the invoice's items, as
{@link getOrderScopedItems} returns it (the `order` divider may be present
or absent)
- `orderItems` — The source order's full `items` array
- `orderDividerUid` — The order divider's uid, i.e. the source order's uid

### `buildInvoiceDestinationDivider(source: typeLiteral, _: unknown): OrderDocDestinationItemType`

Build an invoice destination divider from a source order's destination item.
Single source of truth for the divider shape — reused by
`projectOrderItemToInvoiceItem` (order→invoice projection), the CRMS invoice
webhook (`createUpdateInvoiceFromCrms`), and the destination-divider backfill.

`path` defaults to `[]` so callers that run `computeInvoiceItemPaths`
afterward (the webhook + backfill) get positional path assignment; the
order-projection caller passes the scoped path `[orderDividerUid, ...basePath]`.

### `buildOrderScopedItems(orderItems: LineItem[], orderDividerUid: string): InvoiceDocItemType[]`

Build invoice items from an order's items, scoped under an order divider.
Projects each order item to its invoice-item shape and prepends the order
divider uid to its path.

**Parameters**

- `orderItems` — The order's items array (may contain destination/group/line items)
- `orderDividerUid` — The uid of the order divider these items belong under

**Returns** — Items projected to invoice shape with path prepended by orderDividerUid

### `calculateInvoiceTotals(items: InvoiceItem[], taxes: Tax[], settlements?: readonly typeLiteral[]): InvoiceTotals`

Calculate aggregated pricing totals for an invoice.

The six-field arithmetic core is {@link sumDocumentTotals}, shared with
`calculateOrderTotals` — it was ~35 byte-identical lines in each, and
"assembled independently so invoices can diverge later" was a licence for
silent drift, not an insurance policy. What genuinely differs is here: the
`flattenForXero` prefilter (inert on the arithmetic — see
`sumDocumentTotals`) and the settlement projection below, which is what a
credit note or a partial billing actually changes.

**Parameters**

- `items` — Full invoice items array (structural items are filtered out)
- `taxes` — Tax definitions for tax calculation
- `settlements` — Every settlement against the invoice, reversals included

### `calculateItemDiscountCents(item: LineItem): number`

Calculate the discount amount, in cents, for a single line item.

Plain integer subtraction: both operands are exact counts of cents, so there
is nothing for currency.js to be careful about.

### `calculateItemPrice(item: PricingItem, taxes: Tax[]): typeLiteral`

Calculate the complete price for a single line item.
Runs the full pipeline: subtotal → discount → taxes → total.

### `calculateItemSubtotal(item: PricingItem): typeLiteral`

Calculate the pre-discount and post-discount subtotals for a single line item.

`subtotal = base × quantity × max(chargeable_days / 5, 1)` for `five_day_week`,
or `base × quantity` for `fixed`. The one-week floor means the day factor only
applies above 5 chargeable days.

### `calculateItemTax(item: PricingItem, taxes: Tax[]): PriceModifier[]`

Calculate tax amounts for a single line item from the Tax[] parameter.
Returns a PriceModifier[] with computed amounts.

### `calculateItemTotalCents(item: LineItem, taxes: Tax[]): number`

Calculate the total (subtotal_discounted + taxes) for a single line item.

A `transaction_fee` reports its stored `price.total_cents`: it is priced from
the document, so the only correct value is the one the totals pass already
wrote. Recomputing it here would need a basis this function does not have.

### `carryForwardOverrides(rebuiltItems: InvoiceDocItemType[], existingItems: InvoiceItem[]): InvoiceDocItemType[]`

Carry forward invoice-specific overrides from existing items to rebuilt items.
Matches by uid — if a rebuilt item has the same uid as an existing invoice
item, the {@link INVOICE_ONLY_ITEM_FIELDS} are preserved from the existing
item. The field list is not restated here on purpose; this delegates to
{@link pickInvoiceOnlyFields} so there is one place to change.

**Parameters**

- `rebuiltItems` — Items rebuilt from the order
- `existingItems` — Current invoice items (to carry forward overrides from)

**Returns** — Rebuilt items with invoice-specific overrides applied

### `computeInvoiceItemPaths(items: T[]): T[]`

Compute paths for all invoice items, respecting order divider scoping.

This is `computeItemPaths` at invoice depth, and nothing else — the invoice
hierarchy IS the order hierarchy with `order` prepended, and "a divider
closes every level at or below its own" already expresses order-divider
scoping. It is kept as a named function rather than asking callers to pass
`INVOICE_ITEM_LEVELS` themselves because the level list is the one thing a
caller must not get wrong: handing invoice items the order hierarchy would
silently treat every `order` divider as an ordinary line item and drop it out
of every path.

It used to be a real wrapper — slice into per-divider scopes, strip the
prefix, delegate, re-add the prefix — and that scope loop is where D1 lived:
it returned early when no `order` divider had been seen, so any invoice
without one fell through to a tail loop that copied the INPUT objects by
reference. No prefix, no self-append, no linearization, and the documented
purity guarantee false on that branch. 28 prod invoices / 79 items sat at
`path: []`, and the write guard — "path equals what this function
produces" — called them clean, because a fixed-point check inherits every
hole in its normalizer. With the levels generalized there is no scope loop to
return early from, so that shape is now unwriteable rather than merely fixed.

Pure: returns a fresh array of fresh items. Inputs are not mutated, so it is
safe to pass items that originate from a Solid store proxy. Callers should
replace their working array with the return value.

Generic in `T`, like every sibling here (`computeItemPaths`,
`validateItemPaths`, `validateInvoiceItemPaths`, `getItemSubtreeRange`), so a
caller holding the real `Invoice["items"]` gets it back rather than the loose
`InvoiceItem[]`.

### `computeInvoiceSyncStatus(currentInvoiceItems: InvoiceItem[], orderItems: LineItem[], orderDividerUid: string): Map<string, "in_sync" | "out_of_sync">`

Derive each order-scoped invoice line's sync status against the CURRENT order
projection — no stored flag (minimal-state, derived). A line is `out_of_sync`
when it differs from `projectOrderItemToInvoiceItem(orderItem)` at the same
`path`, ignoring the invoice-only override fields
({@link INVOICE_ONLY_ITEM_FIELDS}); otherwise `in_sync`. Comparison is
{@link invoiceItemsMatch}. Surfaced by `GET /invoices/{uid}/sync-status`, to
badge lines and offer per-line/whole resync (see {@link resyncInvoiceLines}).

⚠️ **Meaningful only where the invoice is hung on the SAME divider skeleton as
its order** — it is keyed on `path`, so if the two trees disagree structurally
no pair is ever compared and every line reports both "missing" and "removed"
with `differs` at exactly 0. Check {@link invoiceScopeDividersMatch} first; a
`differs` of 0 beside two large counts is the tell.

Keyed by the full, divider-scoped `path` (`join("/")`), matching what the
invoice stores. Scoped to one order divider; a multi-order invoice merges the
per-divider maps. Reports as `out_of_sync`:
- an order line the invoice is missing (keyed by its projected path), and
- an order-scoped invoice line with no matching order line (removed upstream).

### `computeItemPaths(items: T[], _: unknown): T[]`

Compute full structural paths for a flat items array AND linearize it
depth-first with `zero_priced` items sorted before priced ones inside each
parent's direct-children block.

Each item's path = [structural context...] + [component ancestry...] + [self uid].

Client-sent paths carry component ancestry (from ProductComponent.path).
This function prepends structural context (dest/group) and appends self uid.

`path` has exactly ONE author: the resolved parent. Per (destination, group)
block, in order:
 1. Resolve each line item's parent — the last segment of the client-supplied
    path that names another line item IN THE SAME BLOCK (structural uids and
    the item's own uid are skipped, as are orphan segments that resolve to no
    item in the block, e.g. catalog-only intermediate kit uids). No parent
    resolves to a block root. Parent cycles are broken deterministically.
 2. Derive `path` as `[...parent.path, self uid]`, or `[...structural prefix,
    self uid]` at a block root. Deriving from the parent's own path rather
    than from the client's chain is what makes ancestry transitively
    consistent: a client chain that skips or misnames an intermediate cannot
    survive, and `path.at(-2)` is the resolved parent BY CONSTRUCTION.
 3. Emit depth-first from that same parent relation — each parent followed by
    its full subtree before the next sibling — stable-sorting `zero_priced
    === true` before priced within each parent's direct children. Drag-drop
    reorders preserve intra-band order. Destination and group dividers keep
    their source positions; only the line items between them are reordered.

Steps 2 and 3 read the SAME resolved parent, so the written path and the
emitted position cannot disagree. (They used to be decided independently —
the path from a globally-filtered client chain, the position from a
block-scoped bucketing — and a parent living in a different block was a
stable fixed point of the pair: 26 such order items in prod.)

Pure: returns a fresh array of fresh items. Inputs are not mutated, so it is
safe to pass items that originate from a Solid store proxy (the manager app
routes reordered arrays through this function inside `setEntity` updaters).
Callers should replace their working array with the return value.

Post-condition (under the within-parent uniqueness invariant): a parent and
its full subtree occupy a contiguous index range, so `getItemSubtreeRange`
and `getGroupItems` can rely on path-prefix matching alone. Unconditionally:
every returned `path` is non-empty and ends in the item's own uid.

### `derivePaymentStatus(currentStatus: InvoiceStatusType, amountPaidCents: number, amountDueCents: number, _: unknown): InvoiceStatusType`

Derive invoice status from settlement amounts.
Pure function — does not mutate the invoice.

**No new status member is needed for a credited invoice.** `paid` already
means `amount_due_cents === 0`, not "cash received" — which is exactly what Xero
says: #1751 and #1322 are both PAID there with `AmountPaid: 0`.

**Parameters**

- `currentStatus` — Current invoice status
- `amountPaidCents` — Total settled in cash, in integer cents
- `amountDueCents` — Total still outstanding, in integer cents
- `amountCreditedCents` — Total settled by credit note, in integer cents

**Returns** — The derived status

### `flattenForXero(items: LineItem[]): LineItem[]`

Filter out structural items (group/destination/order dividers) and return only
billable line items suitable for Xero sync or totals calculation.

The membership test is `ITEM_CONTRACTS[type].kind`. It used to be a local
`STRUCTURAL_TYPES` set — a thirteenth hand-written copy of the divider list,
and the only one that answered "billable" for a type it had never heard of.

### `getItemSubtreeRange(items: T[], index: number): typeLiteral`

Return the contiguous index range covering an item and every descendant of it,
derived purely from `path` (not from item types or adjacency rules).

`computeItemPaths` lays items out depth-first, so descendants of `items[index]`
are always contiguous starting at `index + 1` and run until the first item
whose path does not start with `items[index].path`.

Generic over any `{ path: string[] }` so it works on order line items, invoice
line items (whose paths are scoped by an order divider uid), and any other
path-keyed flat array.

### `getOrderScopedItems(items: T[], orderDividerUid: string): T[]`

Get all invoice items scoped to a specific order divider.
Returns the order divider itself plus all items whose path starts
with the order divider's uid.

**Parameters**

- `items` — Full invoice items array
- `orderDividerUid` — The uid of the order divider item

**Returns** — Items scoped to that order (divider + children)

### `getParentProductUid(item: StructuralItem, structuralUids: Set<string>): string | null`

Get the parent product uid from an item's path.
Returns null for non-components (where path.at(-2) is a structural uid or absent).

### `getSharedFields(keysA: string[], keysB: string[], excludes: string[]): string[]`

Return the intersection of two key arrays, minus any keys in the exclude set.
Used to derive comparable fields from two schema shapes without hardcoding.

**Parameters**

- `keysA` — Field names from schema A
- `keysB` — Field names from schema B
- `excludes` — Field names to exclude from the result

**Returns** — Shared field names, excluding the exclude set

### `getStructuralUids(items: StructuralItem[]): Set<string>`

Build a set of structural item uids (dest/group) from items array.
Used to distinguish structural path elements from product parent refs.

Order-shaped by default. `computeItemPaths` does NOT call this — it derives
the set from whichever `levels` it was handed, so an invoice's `order`
dividers count as structural there too. That asymmetry is why this keeps its
own two-type test rather than reading `ITEM_CONTRACTS[type].kind`: switching
to the contract would silently make `order` dividers structural here, for
every invoice caller.

### `getXeroUnitAmountFromCents(subtotalCents: number, quantity: number): number`

Compute the Xero unit amount from subtotal and quantity.
Bakes duration (chargeable_days × formula) into per-unit price,
since Xero has no concept of rental duration.

## The round trip does not close, and that is a property, not a bug

Xero recomputes `LineAmount = UnitAmount × Quantity` on its own side, so the
remainder this division discards is **real money in someone else's ledger** —
unlike the booking `unit_price_cents` denorm, whose residual is discarded on
purpose because nothing ever multiplies it back.

`getXeroUnitAmountFromCents(10000, 3)` is `33.33`, and Xero will bill
`99.99`. **Rounding
better does not fix this**: `10000 ÷ 3` is `3333` cents too, and `× 3` is
`9999` cents regardless of the arithmetic. The gap is bounded by
`quantity − 1` cents on a line and is absorbed through the discount channel
(`DiscountRate` at 4dp), which is the only per-line lever Xero gives us.

So the exactness this function buys is not a closed round trip — it is that
the residual is **at most one cent per unit and never grows**. The float form
it replaced could quantize the quotient and then have that error scale with
the line.

Half away from zero rather than plain half-up: a line's `subtotal_discounted`
may be negative when a flat discount exceeds it, and `roundDivHalfUp` rounds
a negative numerator toward zero. Symmetry means a credit and its matching
charge cannot differ in magnitude.

## Cents in, DOLLARS out — and the asymmetry is the point

The input is CFS storage, which is integer cents. The return is Xero's wire
format, which is dollars and does not change because CFS's storage did. So
this is the one function in the package that deliberately straddles the two
units, and the name says which side each is on.

⚠️ **The body moved with the name, and had to.** Its first act used to be
`toCentsBig(subtotal)`. Feeding cents to that unedited body is a clean 100×
that type-checks perfectly — same signature, same types, silently wrong
invoice on a single-env production Xero tenant with no dev twin. The rename
exists so every call site fails to compile and the pairing cannot be
half-done.

**Parameters**

- `subtotalCents` — Pre-discount subtotal in integer cents
(base_cents × days × formula × quantity)
- `quantity` — Item quantity. May be fractional; scaled rather than
narrowed, so a non-integer cannot throw on the Xero push path.

**Returns** — Per-unit amount for Xero **in dollars**, or 0 if quantity is 0

### `invoiceItemsMatch(expected: InvoiceItem, current: InvoiceItem): boolean`

**The one comparator.** Are two invoice-shaped items the same row, ignoring
the fields an invoice OWNS ({@link INVOICE_ONLY_ITEM_FIELDS})?

It replaced two near-duplicate comparisons — the private
`invoiceProjectionMatches` behind {@link computeInvoiceSyncStatus}, and
{@link isItemSynced}'s order-shaped one behind the draft mirror — which had
drifted into disagreeing about what "the same line" means. Both now call
this; {@link isItemSynced} projects its order item first.

Both arguments must already be invoice-shaped, with full (divider-scoped)
paths. Comparison is:

- **top-level key sets** must be equal, minus the invoice-only fields, on
  both sides (a key whose value is `undefined` does not count as present —
  Firestore stores no such value, so it can only come from a caller's
  partially-built object);
- **`price` structurally** ({@link invoicePricesMatch}), with absent ≡ null
  on the keys the schema blesses both encodings of;
- **every other key by canonical value** ({@link stableStringify}).

### `invoiceScopeDividersMatch(scopedInvoiceItems: InvoiceItem[], orderItems: LineItem[], orderDividerUid: string): boolean`

Is one order-scope of an invoice hung on the same divider skeleton as its
order? The alignment predicate {@link adoptOrderDividerStructure} drives
toward, and the one definition of "aligned" the audit and the endpoint share.

⚠️ **It compares DIVIDER paths, not all paths.** Full path-set equality is
the wrong criterion and would never go green: measured 2026-08-10, 15 of the
102 prod pairs carrying a custom line carry a legitimate invoice-only line,
which makes the path sets differ forever while the tree shapes agree
perfectly. A line the order lacks is **line-level drift**, correctly reported
`out_of_sync` by {@link computeInvoiceSyncStatus}; conflating it with a
structural misalignment would make the two indistinguishable and the
structural repair unfinishable.

The invoice's own `order` divider is excluded — it has no order-side
counterpart by construction (`isDividerItemType("order")` is `true`).

### `isItemSynced(prevOrderItem: LineItem, invoiceItem: InvoiceItem, orderDividerUid: string): boolean`

Compare a previous order item to a current invoice item to detect overrides.
Returns true if the invoice item is "synced" (matches the order item on all
non-invoice-only fields), false if it has been manually overridden.

**It projects the order item first, then delegates to
{@link invoiceItemsMatch} — and that projection IS core#52's fix.** The
function used to compare an order-SHAPED item against an invoice-SHAPED one,
key sets before values; `stock_method` is required on a stored order line
(`schemas/order.ts`) and REJECTED by the strict `InvoiceDocLineItemSchema`,
so the two sets could never be equal and an unchanged item reported
"overridden" — for every real line item in the corpus, with nothing thrown.
`price.replacement_cents` was a second, independent mismatch. The consequence
was that the order→invoice draft mirror propagated additions only: never an
edit, never a removal. Filtering both sides did NOT fix it — those are
order-only fields, not invoice-only overrides — so the fix had to be to
compare two invoice-shaped items, which is a real behavioural change to the
mirror rather than a tidy-up.

⚠️ The covering unit test's fixture omits `stock_method`, which is why it was
green throughout. Keep it that way only if it is testing something else — a
fixture repaired to make this green would delete the evidence.

**Parameters**

- `prevOrderItem` — The order item from the previous version of the order
- `invoiceItem` — The current invoice item (with order-scoped path)
- `orderDividerUid` — The uid of the order divider (both sides carry the
scoped path once the order item is projected, so nothing is stripped)

**Returns** — true if the item is synced (not overridden), false if overridden

### `isPreTaxItem(item: LineItem): item is PreTaxLineItem`

Determine whether a line item participates in subtotal/discount/tax calculations.
Standalone predicate (not composed) because TS doesn't support negated predicates.

### `isPreTaxPricingItem(item: PricingItem): item is PreTaxPricingItem`

{@link isPreTaxItem} at the {@link PricingItem} surface — the same three
checks, narrowing to a shape the pricing pipeline can read rather than to a
stored line item. Used by the three pricing entry points so they accept an
order-input item without being handed a stored price that does not exist yet.

### `isPriceableItem(item: LineItem): item is PriceableLineItem`

Determine whether a line item is priceable (has a price object, not a structural item).

### `isTransactionFeeItem(item: LineItem): item is TransactionFeeLineItem`

Determine whether a line item is a transaction fee.

### `recomputeSettlementTotals(totalCents: number, settlements: readonly typeLiteral[]): typeLiteral`

Turn the settlements journal into the invoice's stored totals.

**This is the one function that produces `amount_paid_cents`,
`amount_credited_cents` and `amount_due_cents`.** It runs inside the api's
co-write transaction and again in manager's optimistic recompute, so the two
cannot disagree — the property `computeAvailability` already provides for
stock.

It used to be "the one place the cents↔dollars boundary is crossed": the
journal has always stored minor units while the invoice's `total` was
dollars, so this fold converted at the end. With `total_cents` the two sides
are the same unit and the boundary is gone — the function is now integer in,
integer out, with nothing to convert and nothing to round.

**A straight signed fold over EVERY row, with no filtering.** A reversal is
simply a settlement whose contract multiplier is −1, so a do/undo pair nets to
zero arithmetically rather than by being excluded, and an invoice's
settlements can do and undo each other perpetually with the totals correct
after every single append. That deletes the liveness derivation entirely —
along with the `R2 → R1 → S1` chain that silently vanished money when the
trichotomy got it wrong, which under the fold is just `+500 −500 +500 = +500`,
correct at every step. `reverses` is provenance for the UI and for audit; it
contributes nothing to the sum.

Integer sums are exact by construction — nothing to round, no ordering to get
wrong — which is the whole reason the journal stores minor units.
`Number.MAX_SAFE_INTEGER` is ~$90 trillion in cents, so plain integers are
safe here without BigInt.

**Negative results are preserved, never clamped.** An over-credited invoice
must stay negative, exactly as availability preserves an oversold product's
negative. Clamping hides the defect this exists to find.

**THREE buckets, dispatched on `sums_into` with no fallthrough arm.** It was
two — `if (… === "amount_paid_cents") paid += …; else credited += …` — and
that `else` is precisely what made `void` a schema change with a silent
runtime hazard: a void row would have landed in `amount_credited_cents`, the
identity would still have balanced, and every consumer would have reported a
voided invoice as fully credited. A `switch` with a `default` that throws
turns the next bucket into a loud failure at the one site that must know
about it, instead of a quiet mis-route at every site that reads the result.

**Parameters**

- `totalCents` — Invoice total, in integer cents, from `items[]`
- `settlements` — Every settlement against the invoice, reversals included

**Returns** — The four projected totals plus a per-reason breakdown, in cents

### `removeOrderScopedDestinations(dests: InvoiceDestinationPair[], uidOrder: string): InvoiceDestinationPair[]`

Remove all destination pairs scoped to a specific order.
Mirrors `removeOrderScopedItems` for the items array.

### `removeOrderScopedItems(items: T[], orderDividerUid: string): T[]`

Remove all invoice items scoped to a specific order divider.
Returns a new array with the order divider and all items whose path
starts with the order divider's uid removed.

**Parameters**

- `items` — Full invoice items array
- `orderDividerUid` — The uid of the order divider item to remove

**Returns** — Items with the order scope removed

### `resyncInvoiceLines(currentInvoiceItems: InvoiceDocItemType[], orderItems: LineItem[], orderDividerUid: string, targetPaths?: string[][]): InvoiceDocItemType[]`

Re-project an order's lines into an invoice, on demand.

The automatic `syncOrderToInvoiceSelective` (inside `updateOrder`) keeps
non-overridden lines current as the order changes. This is the operator's
manual trigger to either snap a whole order's scope back to the order after
edits, or re-pull individual lines by `path` — the escape hatch for a line
that was overridden on the invoice and should now track the order again.

Pure: returns a fresh items array; the input is not mutated. Scoped to one
**order divider** — a multi-order invoice loops its linked orders. Invoice-only
override fields (`coa_revenue`, `tracking_category`, `xero_id`,
`xero_tracking_option_id`) are always carried forward.

- `targetPaths` omitted → **whole**: every order-scoped line is rebuilt from
  the order — a hard snap-to-order, so price overrides are discarded and lines
  the order dropped are removed. Delegates to {@link syncOrderItems}.
- `targetPaths` given → **per-line**: only lines at those full, divider-scoped
  paths are replaced with a fresh projection of the matching order line; every
  other line — siblings and untargeted overrides — is left untouched. A target
  path the order no longer has is left as-is (use a whole resync to drop
  removed lines); a target path not on the invoice is a no-op.

The caller re-linearizes paths via {@link computeInvoiceItemPaths} and
recomputes `totals` via {@link calculateInvoiceTotals} before writing.

### `syncObjectWithOverride(prevOrderValue: T, newOrderValue: T, currentInvoiceValue: T, keys?: parenthesized[]): T`

Object co-write with override detection. Like `syncScalarWithOverride` but
compares two objects for deep equality via JSON.stringify. If `keys` is
provided, only those keys are compared (useful when one side carries
fields the other doesn't — e.g. invoice.organization.tax_profile has no
equivalent on the order snapshot).

### `syncOrderDestinationsSelective(prevOrderDests: DocDestinationType[], newOrderDests: DocDestinationType[], currentInvoiceDests: InvoiceDestinationPair[], uidOrder: string): InvoiceDestinationPair[]`

Selectively sync one order's destination pairs into an invoice's destinations,
respecting invoice-side overrides. Per-pair matching is by
`(uid_order, delivery.uid, collection.uid)`; only pairs scoped to `uidOrder`
are touched — pairs from other orders pass through unchanged.

Policy per pair:
- Not in invoice (new in order) → add, tagged with `uid_order`.
- In invoice AND prev order matches current invoice → replace with new order pair.
- In invoice BUT prev order ≠ invoice → overridden, keep invoice version.
- In invoice but not in new order:
  - prev matches invoice → deleted from order, drop.
  - prev ≠ invoice → overridden, keep.

**Parameters**

- `prevOrderDests` — Pairs from the previous version of the order
- `newOrderDests` — Pairs from the new version of the order
- `currentInvoiceDests` — Current full invoice destinations array (all orders)
- `uidOrder` — The order uid this sync is scoped to

**Returns** — Updated full invoice destinations array

### `syncOrderItems(invoiceItems: InvoiceDocItemType[], orderItems: LineItem[], orderDividerUid: string): InvoiceDocItemType[]`

Sync a single order's items into an invoice's items array.
Replaces all items scoped to the order divider with rebuilt items from the order,
carrying forward invoice-specific overrides on matched uids.

**Parameters**

- `invoiceItems` — Current full invoice items array
- `orderItems` — The order's current items array
- `orderDividerUid` — The uid of the order divider in the invoice

**Returns** — Updated invoice items array

### `syncOrderToInvoiceSelective(prevOrderItems: LineItem[], newOrderItems: LineItem[], currentInvoiceItems: InvoiceDocItemType[], orderDividerUid: string): InvoiceDocItemType[]`

Selectively sync order items into an invoice, respecting invoice-side overrides.

Items are matched by **path** (not uid), since the same product can appear at
multiple positions in the items array. For each item:

- **Synced** (prev order matches current invoice, minus invoice-only fields):
  replaced with the new order item, carrying forward invoice-only overrides
- **Overridden** (invoice item differs from prev order): left unchanged
- **New** (in new order, not in prev): added under the order divider
- **Removed** (in prev order, not in new): removed only if synced, kept if overridden

**Parameters**

- `prevOrderItems` — Items from the previous version of the order
- `newOrderItems` — Items from the new version of the order
- `currentInvoiceItems` — Items scoped to this order in the current invoice (without order divider)
- `orderDividerUid` — The uid of the order divider in the invoice

**Returns** — Updated invoice items (scoped under the order divider, ready for insertion)

### `syncScalarWithOverride(prevOrderValue: T | undefined, newOrderValue: T | undefined, currentInvoiceValue: T | undefined): T | undefined`

Scalar co-write with override detection. Returns the new order value if
the invoice value still matches the previous order value (i.e. the invoice
has not been manually edited on this field); otherwise returns the current
invoice value (treated as an override, preserved).

Values are compared by strict equality (`===`). Both `undefined` and `null`
participate in the match — a field that was `null` on prev and is `null`
on the invoice will accept a new non-null order value.

### `validateInvoiceItemPaths(items: T[]): ItemPathIssue[]`

Assert every invoice item's `path` matches what {@link computeInvoiceItemPaths}
would produce — the order-divider-scoped variant of {@link computeItemPaths}.

Use as a defensive write-time invariant: any client that writes invoices
should pipe `items` through `computeInvoiceItemPaths` first, so a non-empty
result here means the client skipped the recompute step. Also flags index
positions whose `uid` doesn't match the recomputed array's uid at the same
index — under depth-first contiguity, a uid mismatch means the array needs
re-linearization.

Returns `[]` when every path is clean and order is canonical.

### `validateInvoiceItemUniqueness(items: T[]): ItemUniquenessIssue[]`

Within-parent uniqueness check for invoice items.

Reuses {@link validateItemUniqueness}'s logic — the parent uid is the
second-to-last `path` segment, which for invoice items naturally captures
each scope:
 - top-level destination/group/product under an order divider →
   parentUid is the order divider uid (first segment),
 - product under a destination → parentUid is the destination uid,
 - product under a group → parentUid is the group uid,
 - component → parentUid is the parent product line uid.

So the `(parentUid, uid)` key naturally scopes per order divider for
top-level entries, and per parent product for nested ones.

Returns `[]` when uniqueness holds.

### `validateItemPaths(items: T[]): ItemPathIssue[]`

Assert every line item's `path` matches what {@link computeItemPaths} would
produce — i.e. structural prefix + component ancestry + self uid, with no
stale dest/group uids from prior drag positions.

Use as a defensive write-time invariant: any client (manager, webhook
handlers, manual firestore_admin pokes) that writes orders should pipe
`items` through `computeItemPaths` first, so a non-empty result here means
the client skipped the recompute step.

Reports per-index mismatches; under the depth-first contiguity invariant,
an index whose `uid` doesn't match the recomputed array's uid at the same
index is also a violation (the array needs re-linearization). The original
path is reported so the caller can diff against `expected`.

Returns `[]` when every path is clean and order is canonical.

### `validateItemUniqueness(items: T[]): ItemUniquenessIssue[]`

Assert that within each items array, no two entries share the same `uid`
AND the same immediate structural parent. The immediate structural parent
is the second-to-last `path` segment (or `null` for items whose path is
just `[self.uid]`).

This is the uniqueness invariant orders/invoices rely on so that path-based
line identity is unambiguous. Violations indicate a duplicate that should
be merged — `mergeStagedIntoOrder` and the migration script consolidate.

Returns `[]` when uniqueness holds.

NOTE: assumes the self-INCLUDED `path` convention. Product `components`
exclude self from `path` — use {@link validateComponentUniqueness} for them.

## `@cfs/core/utils/locations`

Location helpers — pure, dependency-free canonicalization shared by every
service that enforces "one active location name per store".

### `normalizeLocationName(name: string): string`

Canonical uniqueness key for a location name, scoped within its store.

Location names are unique per active store, but operators type the same bin
many ways — "Shelf A", "shelf-a", "SHELF / A", "Shelf_A" all name the same
shelf. This folds those to one comparable key so the uniqueness checks on the
CRUD path (`createLocation` / `updateLocation`) and the inventory-transaction
path (`stageLocationUpdates`) agree. Two paths normalizing differently is the
exact bug this exists to prevent, so it MUST be the only normalizer any writer
or uniqueness query uses.

The transform, in order:
 - NFKD-decompose and strip combining marks so diacritics fold ("Café" →
   "cafe").
 - collapse every run of non-alphanumerics — space, hyphen, slash, underscore,
   punctuation — to a single space (Unicode letters/numbers of any script are
   kept), then trim.
 - lowercase.

Separators are interchangeable and insignificant, but a *missing* separator
stays significant: "Shelf A" and "Shelf-A" collide; "Shelfa" does not. The
stored value stays human-readable ("shelf a") so it reads cleanly in the
Firestore console and in "name already exists" error messages.

Persisted on `Location.name_key`.

## `@cfs/core/utils/allocation`

### `ReservedByLocation`

Per-location reserved quantity (uid_location → units already claimed).

```ts
type ReservedByLocation = Map<string, number>;
```

### `ReservingBooking`

A stock-holding booking with its window, for in-memory overlap netting.

```ts
interface ReservingBooking {
  breakdown: BookingBreakdown;
  stores: BookingStore[];
  startMs: number | null;
  endMs: number | null;
}
```

### `addAllocationToReserved(reserved: ReservedByLocation, stores: BookingStore[]): void`

Fold a freshly-computed allocation into a running reserved map (in-batch netting).

### `allocateBookingNetted(storeBreakdown: StoreBreakdownEntry[], quantity: number, reserved: ReservedByLocation): ReturnType<allocateBookingToStores>`

Booking allocation that first nets out units already reserved by other open
bookings, so two overlapping bookings of a 5-stock product don't both point
pickers at the same physical unit (#171). When free stock runs out,
`shortage > 0` and the summary's `quantity_available` goes negative —
overbooking is allowed, it's just no longer silent. Falls back to the gross
allocation when `reserved` is empty.

### `allocateBookingToStores(ledgerStoreBreakdown: StoreBreakdownEntry[], bookingQuantity: number): typeLiteral`

Allocates booking quantity across all available stores.
Follows priority: default store first, then others alphabetically.
Draws from default locations first within each store.

**Parameters**

- `ledgerStoreBreakdown` — Store breakdown array from inventory ledger
- `bookingQuantity` — Total quantity to allocate

**Returns** — stores array, query_by_uid_store array, query_by_uid_location array, and shortage count

### `allocateBookingWithNetting(storeBreakdown: StoreBreakdownEntry[], quantity: number, reserving: ReservingBooking[], windowStartMs: number | null, windowEndMs: number | null, inBatchReserved: ReservedByLocation): ReturnType<allocateBookingToStores>`

Allocate one booking's stores, netting against (a) pre-fetched bookings of the
same product that overlap this booking's window and (b) `inBatchReserved` —
allocations already made earlier in THIS transaction for the same product. The
allocation is folded back into `inBatchReserved` so the next booking for the
same product nets against it too. Pure (no I/O).

### `buildReservedByLocation(bookings: ReadonlyArray<typeLiteral>): ReservedByLocation`

Sum the physical units held by a set of bookings, per location. Only bookings
that currently hold stock (`reserved + prepped + out > 0`, the same definition
as `quantity_booked`) contribute — a returned/quoted booking reserves nothing
even if a stale `stores` array lingers.

## `@cfs/core/utils/money`

Money as integer minor units — the dollars↔cents boundary, the exact-division
primitive that factor arithmetic is built on, and a float-free formatter.

```ts
import { formatCents, roundDivHalfUp, toCents } from "@cfs/core/utils/money";

toCents(19.99); // 1999
formatCents(-4495_62); // "-$4,495.62"
roundDivHalfUp(1000n * 33n, 100n); // 330n  — × n ÷ d, never × (n/d)
```

**Never let a float carry a money value or a factor applied to one.** The trap
is operation order, not precision: `× (n / d)` bakes an unrepresentable
quotient into the money before it is ever scaled, while `× n ÷ d` over integer
cents rounds exactly once, at the end. Measured over a 500k-pair corpus,
divide-first is wrong 496,088 times and integer cents 0.

## Two numeric flavours, and which to reach for

- **`number`** — `toCents` / `fromCents` / `formatCents`. The storage and
  display boundary: a `*_cents` field, a wire payload, a rendered row. Safe
  because `Number.MAX_SAFE_INTEGER` is 9.007e15 cents ≈ **$90 trillion**, so a
  cent value and a sum of cent values never approach it.
- **`bigint`** — `toCentsBig` / `fromCentsBig` / `roundDivHalfUp`. Applying a
  *factor* to money, where the intermediate is the problem rather than the
  result: `calculateItemSubtotal` scales cents by `100 × RATE_SCALE` = 1e8, so
  a $1M line reaches 1e16 and overflows 2^53 before any division happens.

Sums of cents need neither — integer addition is exact by construction, which
is the whole reason journals store minor units.

## currency.js appears here, once, on purpose

{@linkcode parseMoney} and {@linkcode parseRate} **wrap** currency.js rather
than reimplementing it, and they are the only place in CFS that should.
Separator, symbol, sign and epsilon handling is exactly the hand-rolled money
code this module exists to delete — `"$1,583.505"` has three ways to go wrong
before it is ever a number. {@linkcode distributeCents} takes the opposite
call and reimplements, because in integers it is five lines that outsource no
subtlety at all.

## The rate boundary is a parallel set, not an option on the money one

`perUnitCostAt4dp` / {@linkcode parseRate} / {@linkcode formatRate} produce,
parse and render a **4dp rate**; `roundDivHalfUp` / {@linkcode parseMoney} /
{@linkcode formatCents} do the same for **integer cents**. They are twins
rather than one family with a `precision` argument because a rate is not an
amount: `Discount.rate`, `PriceModifier.rate`, `Tax.rate` and
`transactions:cost.unit_cost` hold four decimals to match Xero's
`DiscountRate`, and putting either through the other's function is a measured
regression in both directions — 2dp renders `$0.0639/unit` as **`$0.00`**,
and a rate is not in cents so a cents renderer is 100× out.

### `PAYMENT_MATCH_TOLERANCE_CENTS`

How far a CFS settlement may sit from the Xero payment it matches, in cents.

A domain rule, not a fudge factor: Xero rounds its own line arithmetic, so a
payment can land one cent from what CFS computed for the same invoice. One
cent is the whole allowance — the pre-2026-08 matcher used `<= 0.01` **on
floats**, twice as loose as the `0.005` the repair scripts used to re-check
the same match, so the live matcher could bind a pair those scripts then
flagged as broken.

```ts
const PAYMENT_MATCH_TOLERANCE_CENTS: 1;
```

### `distributeCents(total: bigint, parts: number): bigint[]`

Split `total` cents into `parts` whole-cent shares that **sum to exactly
`total`**.

Conservation is the entire contract: `sum(distributeCents(t, n)) === t` for
every input. Everything else — how many shares, what order — is subordinate
to that.

**Residual policy: front-loaded, and it is CFS's choice rather than an
inherited one.** `distributeCents(100_00n, 3n)` is
`[3334n, 3333n, 3333n]` — the leftover cent goes to the earliest shares. This
matches what `currency.js.distribute()` did before this function replaced it,
so no stored `unit_costs[]` array changes shape; but it is now *named*, and a
caller that needs the residual somewhere else has to say so rather than
discover it. Today the only consumer sums the shares back, so the order is
unobservable — display and any future FIFO cost semantics would not be.

**Symmetric on negatives**: `f(-t, n) === f(t, n).map(x => -x)`, so a sign
flip upstream can never change a magnitude downstream. BigInt division
truncates toward zero, which is what makes the sign fold below correct rather
than merely convenient.

**Throws on `parts <= 0`.** currency.js returned `[]`, which loses the whole
amount silently — both CFS callers had to guard at the call site to avoid it,
and a call-site guard is only ever one new caller away from being forgotten.
There is no split of $100 into zero parts that conserves $100, so the honest
answer is a refusal.

`parts` is a `number` while `total` is a `bigint`, and the asymmetry is
deliberate: the returned array's **length must equal `parts` exactly**, so a
`bigint` count would have to be narrowed to build it — putting one lossy
conversion inside the function whose whole contract is conservation. A count
is not money; every schema already types a quantity as `z.number().int()`.

**Parameters**

- `total` — The amount to split, in whole cents. Either sign.
- `parts` — How many shares. Must be a positive integer.

**Returns** — `parts` shares, in cents, summing to `total`.

### `formatCents(cents: number, _: unknown): string`

Format integer cents for display **without ever creating a float**.

Integer division and a modulo, then string work — so the number on screen and
the number in the journal are the same object, which is what a ledger UI
should do. Output matches manager's `formatCurrency`
(`currency(v, { symbol: "$" }).format()`) so this is a visual drop-in for a
cents-denominated value: `"$1,234.56"`, `"-$50.00"`.

`cents` is expected to be an integer — every `*_cents` field is a `z.int()`.
The truncation is a display guard against a stray float reaching the renderer,
not a rounding policy; a caller with a fractional cent has a bug upstream.

## `{ symbol: "", group: false }` — the search-mirror form

A Typesense `_str` mirror needs `"1234.56"`, not `"$1,234.56"`: **both `$`
and `,` are token separators**, so the display form tokenizes as
`1`/`234`/`56` and a plain `1234.56` query cannot match it. That is the whole
reason a second renderer existed in `api-cloudrun/scripts/_moneySurface.ts`
for two weeks; the options are cheaper than the copy, and this way the mirror
and the display cannot drift on rounding.

**Parameters**

- `cents` — Integer minor units.
- `options.symbol` — Currency symbol. `""` for a search mirror.
- `options.group` — Thousands separators. `false` for a search mirror.

### `formatRate(value: number, _: unknown): string`

Render a **rate** for display — {@linkcode formatCents}'s twin at the other
boundary, and the direction the rate pair was missing.

The rate boundary already had a producer ({@linkcode perUnitCostAt4dp}) and a
parser ({@linkcode parseRate}); with no formatter, a collection table printed
a bare `0.0639` for a unit cost. It had previously printed **`$0.00`**,
because a name heuristic claimed `cost.unit_cost` for the money formatter —
"not money" turns out to be necessary and not sufficient, since a 2dp
formatter destroys a 4dp rate either way.

**Not `formatCents` with a `dp` option.** `formatCents` takes *integer cents*
and its minor part is literally `abs % 100`; adding a precision knob would put
a 4dp rate through a function whose whole contract is integer minor units, and
would make correctness depend on a per-call-site option with a default. Same
argument that keeps `parseRate` separate from `parseMoney`.

```ts
formatRate(0.0639, { symbol: "$" });  // "$0.0639"
formatRate(10.25);                    // "10.25"     — trailing zeros trimmed
formatRate(10.25, { symbol: "%" });   // "10.25%"    — a percent trails its number
```

Trailing zeros are trimmed because a rate's precision is a *ceiling*, not a
denomination: `$6.39` should not read `$6.3900`. Money is the opposite and
pads to exactly 2, which is why these are two functions.

**Parameters**

- `value` — The rate, in whatever unit the field declares. NOT cents.
- `options.dp` — Maximum decimal places. 4 — Xero's `DiscountRate` width.
- `options.symbol` — `"$"` prefixes; `"%"` suffixes; `""` (default) neither.

### `fromCents(cents: number): number`

Narrow integer cents back to dollars, for a dollar-denominated projection.

This is the one place a money value re-enters float space, so it belongs at a
named boundary and nowhere else — see `recomputeSettlementTotals`.

### `fromCentsBig(cents: bigint): number`

The `bigint` flavour of {@linkcode fromCents}.

### `parseMoney(s: string | null | undefined): number`

Parse a money string to 2dp dollars — the string→money direction.

Every external money value reaches CFS as text: an operator types into
`CurrencyInput`, CRMS sends `"1,583.50"` in a webhook body. Both grew their
own parser, and both were wrong in the same way — a bare
`parseFloat("1,583.50")` is **1**, and `Number("$12.00")` is `NaN`. This is
the one direction the module had no answer for, which is precisely why the
local copies appeared.

Total by contract: unparseable input yields `0`, never `NaN` and never a
throw. `parseMoney("")` and `parseMoney("abc")` are both `0` — a parser at an
ingest boundary that can fail closed turns a bad character into a 500.

```ts
parseMoney("$1,583.50");  // 1583.5
parseMoney("1,583.505");  // 1583.51 — quantized to the money quantum
parseMoney("-5.00");      // -5   (sign preserved; a non-negative caller strips it)
parseMoney("abc");        // 0
```

**Sign is preserved.** A caller whose field is non-negative — `CurrencyInput`
is — strips it before calling; that is a UI contract, not a parsing rule, and
baking it in here would silently swallow a legitimate credit.

### `parseRate(s: string | null | undefined): number`

Parse a **rate** string to 4dp — {@linkcode parseMoney}'s twin, and
deliberately a separate function rather than a `precision` option.

A rate is not an amount. `Discount.rate`, `PriceModifier.rate` and `Tax.rate`
hold four decimals because Xero's `DiscountRate` does and it is a line's only
discount channel, so quantizing a rate to the money quantum coarsens every
discount in the system. Making the caller choose a `precision` argument would
put that domain fact behind a default — the failure mode this whole module is
organized against.

```ts
parseRate("33.3333"); // 33.3333 — parseMoney would give 33.33
```

### `perUnitCostAt4dp(cents: bigint, units: bigint): number`

A per-unit **rate** in dollars at 4dp — `cents ÷ units`, rounded once.

**This is deliberately finer than money.** A purchase of 100 units for $6.39
has a true unit cost of $0.0639; quantizing it to cents stores $0.06, a 6%
error on the figure an operator reads. The same argument the schema makes for
`Discount.rate` at 4dp — a rate is not an amount, and forcing it to the money
quantum destroys information that was never money in the first place.

So do **not** reach for `fromCentsBig(roundDivHalfUp(…))` here: it is the
right call for a value that will be stored, summed or paid, and the wrong one
for a ratio that only ever gets displayed. 4dp also matches what CFS already
does at its other rate boundary — Xero's `DiscountRate` holds 4 decimals.

`× 100 ÷ units` widens to hundredths-of-a-cent *before* dividing, so the
rounding happens once, at the end, on exact integers.

**Non-negative `cents` only** — {@linkcode roundDivHalfUp}'s precondition, and
every caller applies it to a cost basis. `units <= 0` yields 0 rather than
dividing. Headroom: the quotient must stay under `2^53`, i.e. ~$900B.

### `roundDivHalfAwayFromZero(num: bigint, den: bigint): bigint`

{@linkcode roundDivHalfUp} for a numerator of **either** sign, rounding half
*away from zero*: `1/2 → 1` and `-1/2 → -1`.

Money that can legitimately go negative needs this rather than the bare
half-up form, and the distinction is not academic — `calculateItemSubtotal`
deliberately lets a flat discount larger than its line produce a negative
`subtotal_discounted` ("the caller's problem to surface, not ours to clamp"),
and that value is then handed straight to the tax calculation. Clamping it to
zero would silently drop the sign; passing it to `roundDivHalfUp` would round
it toward zero instead of half-up.

Symmetry is the point: `f(-x) === -f(x)` for every input, so a sign flip
upstream can never change a magnitude downstream.

### `roundDivHalfUp(num: bigint, den: bigint): bigint`

Round `num / den` half-up, exactly, over integers.

**Non-negative numerator and positive denominator only.** BigInt division
truncates toward zero, so `(2n + d) / 2d` rounds a negative numerator the
wrong way — toward zero rather than half-up. Every caller applies a factor to
a non-negative money value (a base price, a quantity, a chargeable-day count,
a rate, a cost basis), which is what makes the form correct rather than merely
convenient. A caller that acquires a negative numerator must not reach for
this without revisiting the rounding rule.

### `toCents(dollars: number): number`

Widen dollars to exact integer cents.

Stored money is 2dp, so `× 100` is a lossless widening rather than a rounding;
the `Math.round` is there to absorb the binary representation error in values
like `19.99 * 100 === 1998.9999999999998`, not to make a decision about a
third decimal place.

### `toCentsBig(dollars: number): bigint`

The `bigint` flavour of {@linkcode toCents}, for factor arithmetic whose
intermediates exceed `Number.MAX_SAFE_INTEGER`.

## `@cfs/core/utils/movements`

Pure helpers over the movement journal — the fold from an event's lines onto
an inventory ledger, the reversal transform, and the placement helpers that
turn a contract plus an allocation into lines.

```ts
import { applyMovementToLedger, negateLines } from "@cfs/core/utils/movements";
```

Db-free and side-effect-free, so the same fold runs server-side inside a
Firestore transaction and in a test over a plain object. Document refs,
throws and logging stay in api-cloudrun; this module only computes.

The contract tables themselves (`MOVEMENT_CONTRACTS`, `CUSTODY_PLACE_KINDS`)
live in `schemas/transaction.ts`, not here — the document schema validates
against them, and schema modules cannot import utils.

### `LedgerFoldResult`

What a movement did to a ledger, and the cost it actually consumed.

```ts
interface LedgerFoldResult {
  ledger: InventoryLedger;
  costAppliedCents: number;
  unitCost: number;
}
```

### `LocationPlacement`

Where a `locations`-kind DocSource sits, resolved by the caller.

Every field is read from the `locations` / `stores` documents, never from
client input — that is what makes a cross-store placement inexpressible
(#307). It carries the store's identity as well as the location's because the
ledger's `store_breakdown` denormalizes both, and `allocateBookingToStores`
sorts on `store.default`, `store.name` and `location.default`: a placement
that left them at `""`/`false` would silently cost the allocator its
default-store-first and default-location-first ordering.

```ts
interface LocationPlacement {
  uid_store: string;
  store_name: string;
  store_default: boolean;
  name: string;
  default: boolean;
  max: number | null;
}
```

### `allocationSide(type: MovementTypeType): "from" | "to" | "both" | null`

Which side of a line an operator-supplied allocation lands on, per the type's
contract. `check_out` is location→booking so an allocation names the source;
`check_in` is booking→location so it names the destination.

Returning the side rather than letting callers decide is the point: the client
sends a direction-agnostic `[{uid_location, quantity}]` and never has to know
which way a type moves.

### `applyMovementToLedger(ledger: InventoryLedger, movement: Pick<Movement, "type" | "quantity" | "lines" | "cost">, placements: ReadonlyMap<string, LocationPlacement>, now: indexedAccess): LedgerFoldResult`

Fold one movement onto a ledger, returning a NEW ledger.

Purely a function of `(ledger, movement, placements)`: no Firestore, no clock,
no mutation of either input. `now` is injected rather than read so the same
write instant can be shared across a multi-document transaction.

`placements` resolves each `locations`-kind line endpoint to the store that
owns it. The caller must have already asserted that ownership (#307) — this
fold trusts the map, because the read that proves it is what stops a future
writer from skipping the check.

## Cost

Increases add the caller-supplied acquisition cost. Cost-bearing decreases
remove the weighted-average share of the basis captured BEFORE the quantity
changes — never the caller's number, which is revenue or an estimate and let
the basis drift from quantity and even go negative.

The returned `unitCost` and the ledger's `average_unit_cost` are per-unit
**rates at 4dp** (`perUnitCostAt4dp`), not money. Both were quantized to the
cent until 2026-08-03, which reported a 100-unit purchase at $6.39 as
$0.06/unit — a 6% error on a figure that is only ever displayed. The basis
itself is money and is unchanged.

A type whose contract forbids cost never touches the basis at all. That is
what makes #286 (a costed transfer corrupting the basis) structurally
impossible rather than gated: a transfer has no cost object to mis-gate.

### `applyOutOfServiceReason(breakdown: indexedAccess, reason: keyof indexedAccess, delta: number): indexedAccess`

Apply an OOS record's reason to the per-reason breakdown. Split from
`deriveServiceQuantities` because the reason lives on the OOS document, which
only the caller can read.

### `costOfUnits(basisCents: bigint, heldUnits: number, quantity: number): bigint`

The carrying value of `quantity` units drawn from a basis of `basisCents`
spread over `heldUnits`, rounded once at the end.

**`× quantity ÷ held`, never `× (basis / held)`.** Deriving a per-unit average
first and multiplying by it quantizes the average before it is scaled, so the
error rides into the money — the operation-order trap, not a precision one.
The previous ledger fold did exactly that: it read the stored
`average_unit_cost` (already quantized) and multiplied. Here the division
happens last, on exact integer cents.

### `deriveServiceQuantities(ledger: InventoryLedger, lines: readonly MovementLineType[]): Pick<InventoryLedger, "quantity_in_service" | "quantity_out_of_service">`

`quantity_in_service` and `quantity_out_of_service` from placement kind.

These moved in exact lockstep with `quantity_held` before the journal — so
`in_service` always equalled `held` — while `out_of_service` was written once
as zero at ledger creation and never moved again, meaning the ledger reported
every product as 100% in service. Under the line model they are derived:
units at a `locations` doc or a `booking` are in service, units at an
`out-of-service` record are not.

`out_of_service_breakdown` needs the OOS record's `reason`, which this module
cannot read, so the caller supplies it — see `applyOutOfServiceReason`.

### `heldDelta(line: MovementLineType): number`

A line's contribution to `quantity_held`: `+q` if it lands somewhere, `−q` if
it leaves from somewhere, and `0` when it does both.

Conservation is structural — no cross-line summation, and a half-move is
inexpressible because a line with two nulls does not validate.

### `movementHeldDelta(lines: readonly MovementLineType[]): number`

A movement's total effect on `quantity_held`.

### `negateLines(lines: readonly MovementLineType[]): MovementLineType[]`

Swap every line's `from` and `to`. This is the whole of a reversal: because a
line carries both sides, negating it needs no knowledge of the movement type,
and the per-kind contract makes the result either valid or rejected rather
than silently lopsided.

## `@cfs/core/utils/order-lines`

The order/invoice line builders — the one answer to *"given catalog product P
at quantity N, which line items does it produce, at what quantities?"*

```ts
import { buildOrderLineFromProduct, buildOrderComponentLines } from "@cfs/core/utils/order-lines";

const line = buildOrderLineFromProduct(productDoc, { quantity: 2, chargeDays: 5, uidOrder });
const kids = buildOrderComponentLines(productDoc, { quantity: 2, chargeDays: 5, uidOrder });
```

Pure and db-free — the input is a Typesense `ProductDocument` the caller
already holds, and the output is a plain array. It lives here for the same
reason `@cfs/core/utils/availability` does: it is shared verbatim so two
consumers **cannot disagree**. There are three — the manager's staging
popover, the manager's order/invoice stores, and the public webapp's order
drafts — across two repos. A second copy of the component expansion is a
second answer to "what does this kit bring", and the drafts a customer creates
would then disagree with the operator's view of the same order.

## What these builders do NOT do: price

The returned lines carry `subtotal`/`subtotal_discounted`/`total` of `0`, and
their `price.taxes` are bare `{ uid }` references copied from the catalog.
Run {@link https://jsr.io/@cfs/core/doc/utils/orders | calculateItemPrice}
against the live tax docs before persisting — that resolves each uid to
name/rate/type and computes the amounts. Pricing is not folded in here
because the custom-line builders receive the *line's* tax set rather than the
tax catalog `calculateItemPrice` needs, so a single signature cannot express
both.

## The catalog `path` convention is the INVERSE of the doc-item one

A `product.components[]` row's `path` **excludes** itself and starts at the
root product: a direct child of product `A` has `path: ["A"]`, a grandchild
has `path: ["A", "child"]`. A doc-item `path` **includes** itself, so its
parent is `path.at(-2)`. {@link buildOrderComponentLines} is the seam where one
becomes the other, and it derives every doc path from the **resolved parent**
rather than concatenating the catalog chain — the same "one author, parent-
derived" rule `computeItemPaths` follows, and for the same reason: a catalog
row whose chain contradicts its position must not be able to write a path.

### `CustomLineBuildOptions`

Options for a one-off "custom" line with no product catalog entry behind it —
the orders/invoices "Add Custom Item" flow.

`taxes` is the line's own resolved tax set (already carrying name/rate/type),
not the tax catalog: a custom line has no product to read tax references off,
so the caller resolves them.

```ts
interface CustomLineBuildOptions {
  type: DocLineItemTypeType;
  name?: string;
  quantity?: number;
  base_cents?: number;
  formula?: PriceFormulaType;
  chargeDays: number | null;
  taxes: ReadonlyArray<typeLiteral>;
  uidOrder?: string;
}
```

### `OrderLineBuildOptions`

Shared options for building order line items from a Typesense
`ProductDocument` — used by the staging popover, the substitute flow, and any
"add product to an order" surface.

There is deliberately no `initial` option. All three consumers used to pass
`getInitialValues(OrderItem)`, and the three seeds could drift; worse, the
spread quietly supplied fields the builder did not own — every expanded
component claimed `stock_method: "bulk"` regardless of the component's real
value, and every line carried `order_number: 0` for a number only the server
can allocate. Each builder now writes every field it emits.

```ts
interface OrderLineBuildOptions {
  quantity: number;
  chargeDays: number | null;
  inheritedAncestry?: string[];
  uidOrder?: string;
}
```

### `buildCustomInvoiceLine(opts: Omit<CustomLineBuildOptions, "uidOrder">): InvoiceDocLineItem`

Build a custom (no-product) invoice line item.

An invoice line is a strictly smaller shape than an order line: no
`stock_method`, no `crms_id`, no `uid_order`, no `inclusion_type`/
`zero_priced`, and no `price.replacement_cents` — an invoice does not track
replacement value. This used to claim it "strips order-only fields" while the
`initial` spread put `stock_method: "bulk"`, `order_number: 0` and
`uid_order: ""` straight back in; constructing the object outright is what
makes the docblock true.

### `buildCustomOrderLine(opts: CustomLineBuildOptions): OrderDocLineItemType`

Build a custom (no-product) order line item.

Stamps the `"custom-"` uid prefix, which is part of the data contract rather
than a UI hint: api-cloudrun's `buildOrderLineItem` branches on it to skip the
product lookup and accept the line's own payload.

### `buildOrderComponentLines(doc: ProductDocument, opts: OrderLineBuildOptions): OrderDocLineItemType[]`

Build the mandatory/default sub-component lines for a parent
`ProductDocument`, scaling each component's quantity off the parent quantity.

Walks the catalog tree depth-first (parent → its descendants → next sibling)
and stable-sorts each parent's direct-children block `zero_priced === true`
first. `computeItemPaths` re-linearizes downstream anyway, but emitting
depth-first up front keeps the array readable when inspected raw.

Quantities recurse with a per-level effective quantity —
`ceil(comp.quantity × parentEffective)` — because a fractional catalog ratio
compounds with depth. 34 of prod's 165 component rows carry a fractional
quantity and 6 of those sit below a direct child, so scaling a whole subtree
by one root-level ratio gives a different (wrong) answer. All 34 are
`inclusion_type: "default"` and no fractional component is `mandatory`, so the
result is always a valid integer.

**One drop IS intentional, and the distinction matters.** A `mandatory` or
`default` row whose parent is `optional` is NOT emitted: the walk starts at the
root and only descends through rows that survived the filter, so an unselected
parent takes its subtree with it. Prod has 3 such rows — a generator's
fuel-tank cap and hose under an optional extension tank, and a hand truck under
an optional folding chair — and staging them unasked would put a fuel-tank cap
on every generator order.

**Nothing is lost, and that is a property of the data rather than a hope.**
`product.components[]` is a *materialized* denorm of the whole descendant tree
(`buildComponentEntries` prepends the new parent to every row of the child
product's own array), so a subtree sitting behind an optional parent is still
reachable — through that parent's OWN `components`. Adding "Extension Fuel
Tank" as its own line expands its own array, which carries the cap and hose at
`path: [tankUid]`. Verified end to end: all **5** prod orders containing the
optional tank carry **both** of its mandatory children, 0 missing. Optional
parents do reach orders — 72 nested prod lines across 13 distinct optional
pairs — so this path is exercised, not theoretical.

So do **not** "fix" this by hoisting an unreachable row to the root. The
hardening in {@link resolveParentUid} is about a row whose `path` is
*malformed*; this is a row whose parent is *deselected*, and its subtree has
another way in. Pinned by a test, because the two look identical from inside
the walk.

### `buildOrderLineFromProduct(doc: ProductDocument, opts: OrderLineBuildOptions): OrderDocLineItemType`

Build a top-level order line item from a `ProductDocument`.

`path` carries the component ancestry only — the item's own uid and the
structural destination/group prefix are appended by `computeItemPaths`, which
is the sole author of a stored `path`.

## `@cfs/core/utils/orders`

Shared order utility functions for CFS applications.
Includes pricing calculations, item consolidation, and destination grouping.
All arithmetic uses currency.js for safe floating-point calculations.

```ts
import { calculateOrderTotals } from "@cfs/core/utils/orders";

const items = [
  {
    type: "rental",
    quantity: 1,
    price: {
      base: 100,
      formula: "five_day_week",
      chargeable_days: 5,
      discount: null,
      taxes: [],
      subtotal: 100,
      subtotal_discounted: 100,
    },
  },
];
const totals = calculateOrderTotals(items, []);
console.log(totals.total); // 100
```

### `ConsolidatedItem`

```ts
type ConsolidatedItem = ConsolidatedItemType;
```

### `DestinationGroup`

A destination section with its delivery/collection UIDs and child items.

```ts
interface DestinationGroup {
  uid_delivery: string;
  uid_collection: string;
  items: LineItem[];
  packing_list_delivery: LineItem[];
  packing_list_collection: LineItem[];
}
```

### `Discount`

```ts
type Discount = DiscountType;
```

### `DocumentTotalsCore`

The six totals fields an order and an invoice compute identically.

Deliberately the **intersection**, not a superset: both document totals are
`z.strictObject`s embedded in schemas `assertValidPatch` enforces at write
time, so an order doc carrying `amount_paid_cents` — or an invoice doc
carrying `replacement_total_cents` — fails validation. Each caller appends
its own tail.

**Hand-declared as the intersection of two schema-derived shapes**, so it is
one of the places a rename does NOT arrive as a compile error automatically:
it must be edited in the same commit as `OrderDocTotalsType` and
`InvoiceDocTotals`, which is one of the three reasons Phase 11's core change
is a single commit rather than a series.

```ts
interface DocumentTotalsCore {
  discount_amount_cents: number;
  subtotal_cents: number;
  subtotal_discounted_cents: number;
  taxes: PriceModifier[];
  transaction_fees: PriceModifier[];
  total_cents: number;
}
```

### `GroupPath`

```ts
type GroupPath = GroupPathType;
```

### `GroupTotalsResult`

Count and pricing totals for a collapsed destination or group section.

```ts
interface GroupTotalsResult {
  count: number;
  subtotal_cents: number;
  subtotal_discounted_cents: number;
  total_cents: number;
}
```

### `ItemParentageIssue`

A single parentage violation reported by {@link validateItemParentage}.

```ts
interface ItemParentageIssue {
  index: number;
  uid: string;
  type: string;
  parentUid: string;
  parentType: string;
}
```

### `ItemPathIssue`

A single path mismatch reported by {@link validateItemPaths} or
{@link validateInvoiceItemPaths} (re-exported from `@cfs/core/utils/invoices`).

```ts
interface ItemPathIssue {
  index: number;
  uid: string | undefined;
  path: string[];
  expected: string[];
}
```

### `ItemUniquenessIssue`

A single uniqueness violation reported by {@link validateItemUniqueness}
(and the invoice-scoped variant in `@cfs/core/utils/invoices`).

```ts
interface ItemUniquenessIssue {
  index: number;
  uid: string;
  parentUid: string | null;
  firstIndex: number;
}
```

### `LineItem`

A single item in an order/invoice/fulfillment array — product, divider,
surcharge or fee.

A structural supertype, not a shadow of the real unions. Every member of
`OrderDocItemType`, `InvoiceDocItemType` and `FulfillmentItemType` is
assignable to it, so a caller holding real doc items passes them straight in
and the generic helpers (`computeItemPaths`, `getItemSubtreeRange`, …) hand
back the caller's own type. It exists because the manager also calls these
helpers on STAGED, mid-edit items that are not yet valid doc items — narrowing
the helpers to the doc unions would force those callers back into casts.

`type` is `ItemTypeType`, NOT `string`. That is the difference between a
supertype and a hole: the pricing and billability predicates all resolve
through `ITEM_CONTRACTS`, and a `string` here made "a type with no contract" a
reachable state for every one of them. The runtime guards still handle it —
these items come off Firestore documents — but no caller can construct it.

Member-specific fields are still reached through the type guards
(`isPriceableItem`, `isPreTaxItem`, `isTransactionFeeItem`).

```ts
interface LineItem {
  uid: string;
  name: string;
  type: ItemTypeType;
  quantity?: number;
  price?: PriceObject;
  stock_method?: string;
  path: string[];
  uid_delivery?: string | null;
  uid_collection?: string | null;
  zero_priced?: boolean | null;
  description?: string;
  order_number?: number;
  uid_order?: string | null;
  coa_revenue?: COARevenueType | null;
}
```

### `ORDER_ITEM_LEVELS`

The structural divider hierarchy of an ORDER's items array, outermost first.

A divider's index here is its level: encountering one closes every level at
or below it and opens its own. So a `destination` (level 0) ends the group
that preceded it, while a `group` (level 1) only ends a sibling group.

Invoices nest one level deeper — see `INVOICE_ITEM_LEVELS` in
`@cfs/core/utils/invoices`. Fulfillments share the order hierarchy.

```ts
const ORDER_ITEM_LEVELS: "destination" | "group"[];
```

### `OrderDateEnvelope`

Order-level date envelope derived on demand from per-destination dates.

Mirrors the field set of the old top-level `order.dates`, except the `_fs`
companions are nullable: utilities can't mint a Firestore Timestamp, so each
boundary copies the `_fs` from whichever destination owns the extreme value
(and is null when no destination sets that boundary).

```ts
interface OrderDateEnvelope {
  delivery_start: string | null;
  delivery_start_fs: FirestoreTimestampType | null;
  delivery_end: string | null;
  delivery_end_fs: FirestoreTimestampType | null;
  collection_start: string | null;
  collection_start_fs: FirestoreTimestampType | null;
  collection_end: string | null;
  collection_end_fs: FirestoreTimestampType | null;
  charge_start: string | null;
  charge_start_fs: FirestoreTimestampType | null;
  charge_end: string | null;
  charge_end_fs: FirestoreTimestampType | null;
  days_active: number | null;
  days_charged: number | null;
}
```

### `OrderTotals`

```ts
type OrderTotals = OrderDocTotalsType;
```

### `PackingListItem`

An expanded packing list entry preserving group context.

```ts
interface PackingListItem {
  uid: string;
  name: string;
  type: string;
  quantity: number;
  stock_method: string;
  group_name: string | null;
}
```

### `PreTaxLineItem`

A pre-tax line item with a full price object — every type the contract table
marks `pricing: "pre_tax"`.

The member list is DERIVED from `ITEM_CONTRACTS`, not written out. It used to
be the literal `"rental" | "sale" | "service" | "surcharge" | "replacement"`,
which made this a sixth place to remember when an item type was added.

```ts
interface PreTaxLineItem {
  type: PreTaxItemType;
  quantity: number;
  price: PriceObject;
}
```

### `PreTaxPricingItem`

A {@link PricingItem} that has passed {@link isPreTaxPricingItem}.

```ts
type PreTaxPricingItem = PricingItem & typeLiteral;
```

### `PriceModifier`

```ts
type PriceModifier = PriceModifierType;
```

### `PriceObject`

```ts
type PriceObject = OrderDocItemPriceType;
```

### `PriceableLineItem`

Any item that has pricing — pre-tax or transaction fee.

```ts
type PriceableLineItem = PreTaxLineItem | TransactionFeeLineItem;
```

### `PricingItem`

The item surface the pricing pipeline reads: a type (to look up the contract),
a quantity, and a {@link PricingPrice}. Both a stored {@link LineItem} and an
order-input item satisfy it.

```ts
interface PricingItem {
  type: ItemTypeType;
  quantity?: number;
  price?: PricingPrice | null;
  coa_revenue?: number | null;
}
```

### `PricingPrice`

The price fields the pricing pipeline actually READS — deliberately narrower
than the stored {@link PriceObject}.

`taxes` needs only a `uid`, because the name/rate/type/amount_cents are what
`calculateItemTax` resolves and computes; `subtotal_cents`,
`subtotal_discounted_cents`, `total_cents` and `taxes_base` are pricing's
OUTPUT and are never read as input.

That is not a convenience: it is the shape an order-input item genuinely
arrives in (`ItemPriceType` in `@cfs/core/schemas`, whose `taxes` is
`{ uid }[]`). Typing the pricing entry points here is what lets a writer price
an item it has not built yet, instead of casting the input through
`as unknown as LineItem` and claiming a stored price it does not have —
which is what `api-cloudrun`'s `buildLineItem` did, twice, on the money path.

```ts
interface PricingPrice {
  base_cents?: number;
  base_percent?: number | null;
  formula?: PriceFormulaType;
  chargeable_days?: number | null;
  discount?: typeLiteral | null;
  taxes?: readonly typeLiteral[];
}
```

### `ReplacementTotals`

Replacement cost totals for an order, with and without tax.

```ts
interface ReplacementTotals {
  subtotal_cents: number;
  tax_cents: number;
  total_cents: number;
}
```

### `StructuralItem`

The item surface the structural/path helpers read: identity, type, and path.

Narrower than {@link LineItem} deliberately — these helpers never look at
`name`, `price` or `quantity`, and callers legitimately hold items that have
none of them yet (api-cloudrun's CRMS `ItemLike` is exactly this shape). Typing
them at `LineItem` is what forced `as unknown as LineItem[]` at those sites.

```ts
interface StructuralItem {
  uid: string;
  type: ItemTypeType;
  path?: string[];
}
```

### `TAXABLE_REVENUE_COAS`

The revenue COAs that sales/rental tax is actually owed on — 4000 Rental
Income, 4140 Pass Through Income, 4200 Retail Sales Income, 4210 Replacement
Sales Income.

**This is the single source of truth for line taxability**, and it has to be,
because it previously existed only on the *Xero push* side and nowhere in the
engine computing CFS's own totals. So CFS taxed lines it then told Xero were
untaxable (`TaxType: "NONE"`), inflating `total` and leaving the difference as
a phantom `amount_due`. Measured on prod 2026-07-30: **19 invoices /
$2,741.78**, plus 9 orders / $453.50.

Everything outside the set is a service or fee — Service Income, Delivery
Surcharges, Transaction Fee, Other Income — and sales tax is not owed on it.
Xero was right and the engine was wrong, so there is no historical
under-collection: the customer was always billed the untaxed amount and CFS
merely displayed a balance that was never real.

**4140 Pass Through Income was added 2026-08-02, and the direction matters.**
Every other member of this set was here because Xero disagreed with the engine
and Xero was right. 4140 is the one case where the two agreed with each other
and the constant was the outlier: prod invoice #1897 carries its SSD Card line
at `AccountCode: 4140` in CFS *and* in Xero, taxed `TAX003` (Chicago Rental,
11%) for $510.40 in both, paid in full. Excluding 4140 meant the next reprice
of that invoice would have deleted tax that was charged, collected and
remitted. Operator decision: pass-through income is taxable.

`api-cloudrun/src/lib/xeroTax.ts` consumes this same constant so the push and
the totals cannot drift apart again.

```ts
const TAXABLE_REVENUE_COAS: readonly number[];
```

### `Tax`

Subset of the full Tax document needed by utility functions.
`valid_from`/`valid_to` are optional — only the as-of resolver (`findTaxAt` in
`@cfs/core/utils/taxes`) reads them; pricing helpers ignore them. Optional so
partial `Tax` literals in tests/callers keep type-checking.

```ts
type Tax = Pick<SchemaTax, "uid" | "name" | "rate" | "type"> & Partial<Pick<SchemaTax, "valid_from" | "valid_to">>;
```

### `TransactionFeeLineItem`

A transaction fee line item.

Carries the same `PriceObject` every other line carries — a fee is an
ordinary line whose `price.formula` is `percent_of_total`, not a second price
shape. It differs from a `PreTaxLineItem` only in that it is priced FROM the
document total rather than into it, which is why it has its own predicate and
its own pass in `calculateOrderTotals`.

```ts
interface TransactionFeeLineItem {
  type: FromTotalItemType;
  quantity: number;
  price: PriceObject;
}
```

### `buildPackingList(items: LineItem[], consolidated?: boolean, destinationUid?: string): PackingListItem[] | ConsolidatedItem[]`

Build a packing list from order line items.

When `consolidated` is true, deduplicates by product UID and sums quantities
(delegates to {@link consolidateItems}). When false (default), returns
expanded entries with `group_name` preserved.

Pass `destinationUid` to scope to a single destination; omit for the full order.

Excludes structural rows, surcharges, transaction fees, and services.

### `buildQueryByDates(destinations: ReadonlyArray<QueryByDatesDestination>): string[]`

Deduped, ascending list of Chicago `YYYY-MM-DD` boundary days across every
destination's delivery + collection windows. Server-maintained on the order
(and fulfillment) doc as `query_by_dates`, reserved for exact-day Firestore
`array-contains` lookups. Charge dates are billing-only and excluded.

### `calculateItemDiscountCents(item: LineItem): number`

Calculate the discount amount, in cents, for a single line item.

Plain integer subtraction: both operands are exact counts of cents, so there
is nothing for currency.js to be careful about.

### `calculateItemPrice(item: PricingItem, taxes: Tax[]): typeLiteral`

Calculate the complete price for a single line item.
Runs the full pipeline: subtotal → discount → taxes → total.

### `calculateItemSubtotal(item: PricingItem): typeLiteral`

Calculate the pre-discount and post-discount subtotals for a single line item.

`subtotal = base × quantity × max(chargeable_days / 5, 1)` for `five_day_week`,
or `base × quantity` for `fixed`. The one-week floor means the day factor only
applies above 5 chargeable days.

### `calculateItemTax(item: PricingItem, taxes: Tax[]): PriceModifier[]`

Calculate tax amounts for a single line item from the Tax[] parameter.
Returns a PriceModifier[] with computed amounts.

### `calculateItemTotalCents(item: LineItem, taxes: Tax[]): number`

Calculate the total (subtotal_discounted + taxes) for a single line item.

A `transaction_fee` reports its stored `price.total_cents`: it is priced from
the document, so the only correct value is the one the totals pass already
wrote. Recomputing it here would need a basis this function does not have.

### `calculateOrderTotals(items: LineItem[], taxes: Tax[]): OrderTotals`

Calculate aggregated pricing totals for an entire order.
Owns the two-pass computation: pre-tax items first, then transaction fees.

### `calculateReplacementTotals(items: LineItem[], taxes: Tax[]): ReplacementTotals`

Calculate the total replacement cost across all pre-tax items that have
a replacement value on their price object.

Returns `subtotal_cents` (sum of replacement × quantity), `tax_cents` (taxes
applied to that subtotal), and `total_cents` (subtotal + tax).

**Multiply-then-round, per line.** The per-line product is rounded once, at
the line, and the rounded lines are summed — which is not the same number as
rounding a per-unit figure first and multiplying it. `quote.eta` in the
`templates` repo hand-rolls the opposite order, and under integer cents the
two diverge systematically rather than coincidentally; that divergence is
tracked as Phase C3 work, and this function is the side that is right.

### `calculateTransactionFeeAmountCents(item: LineItem, basisCents: number): number`

The dollar amount a `transaction_fee` line contributes to a document.

A fee is priced from the document, not from itself, so it needs the one input
`calculateItemSubtotal` cannot see: `basis`, the document's
`subtotal_discounted` (pre-tax, post-discount — the same base the fee has
always been computed against).

- `percent_of_total` → `basisCents × base_percent / 100`.
- anything else → the ordinary per-unit subtotal, `base_cents × quantity`, so
  a flat processing charge stays expressible without a second formula.

Exact: the percentage is applied as `× rate ÷ 100` over integer cents rather
than as a pre-divided float factor, and rounds half-up exactly once.

The form this replaced was `currency(basis).multiply(rate / 100)`. That is the
*benign* float form, and an earlier version of this docstring was wrong about
why — `multiply` takes a plain JS number and never wraps it, so nothing
quantizes the ratio; it carries only the ~1e-18 representation error in
`rate / 100`, which flips a tie so rarely that it mis-costs **0** of the fee
sweep's pairs. The form that genuinely loses money is **divide-first**,
`currency(rate).divide(100)`, which does re-enter the constructor and
quantizes: `currency(12.345).divide(100) === 0.12`. Both are measured on every
run by the fail-closed companion in `tests/orders.test.ts` — the assertion
pins divide-first, the benign form is reported.

### `computeItemPaths(items: T[], _: unknown): T[]`

Compute full structural paths for a flat items array AND linearize it
depth-first with `zero_priced` items sorted before priced ones inside each
parent's direct-children block.

Each item's path = [structural context...] + [component ancestry...] + [self uid].

Client-sent paths carry component ancestry (from ProductComponent.path).
This function prepends structural context (dest/group) and appends self uid.

`path` has exactly ONE author: the resolved parent. Per (destination, group)
block, in order:
 1. Resolve each line item's parent — the last segment of the client-supplied
    path that names another line item IN THE SAME BLOCK (structural uids and
    the item's own uid are skipped, as are orphan segments that resolve to no
    item in the block, e.g. catalog-only intermediate kit uids). No parent
    resolves to a block root. Parent cycles are broken deterministically.
 2. Derive `path` as `[...parent.path, self uid]`, or `[...structural prefix,
    self uid]` at a block root. Deriving from the parent's own path rather
    than from the client's chain is what makes ancestry transitively
    consistent: a client chain that skips or misnames an intermediate cannot
    survive, and `path.at(-2)` is the resolved parent BY CONSTRUCTION.
 3. Emit depth-first from that same parent relation — each parent followed by
    its full subtree before the next sibling — stable-sorting `zero_priced
    === true` before priced within each parent's direct children. Drag-drop
    reorders preserve intra-band order. Destination and group dividers keep
    their source positions; only the line items between them are reordered.

Steps 2 and 3 read the SAME resolved parent, so the written path and the
emitted position cannot disagree. (They used to be decided independently —
the path from a globally-filtered client chain, the position from a
block-scoped bucketing — and a parent living in a different block was a
stable fixed point of the pair: 26 such order items in prod.)

Pure: returns a fresh array of fresh items. Inputs are not mutated, so it is
safe to pass items that originate from a Solid store proxy (the manager app
routes reordered arrays through this function inside `setEntity` updaters).
Callers should replace their working array with the return value.

Post-condition (under the within-parent uniqueness invariant): a parent and
its full subtree occupy a contiguous index range, so `getItemSubtreeRange`
and `getGroupItems` can rely on path-prefix matching alone. Unconditionally:
every returned `path` is non-empty and ends in the item's own uid.

### `computeItemTaxAmountCents(tax: Pick<Tax, "rate" | "type">, subtotalDiscountedCents: number, quantity: number): number`

Pure per-item tax amount for one tax against a given subtotal.
`percent` → `subtotalDiscounted × rate/100`; `flat` → `rate × quantity`.

`subtotalDiscounted` is a **parameter** (not recomputed) so both the order
path (which passes its `calculateItemSubtotal` result) and the CRMS invoice
webhook (which passes its `charge_total`-authoritative stored subtotal) share
one formula. Lives here (base module) and is re-exported from
`@cfs/core/utils/taxes` to avoid a `taxes ↔ orders` import cycle.

Exact: both factors are applied as `× n ÷ d` over integer cents and rounded
half-up exactly once (core#47). The form this replaced was
`currency(subtotalDiscounted).multiply(tax.rate / 100)` — a pre-divided float
ratio, and **the one percent-of-money path that never migrated to integer
cents**: inside a single `calculateItemPrice` call the discount on a line was
already exact BigInt while the tax on that same line was not. It was measured
benign across CFS's six live rates, which is precisely why it survived; the
sweep in `tests/orders.test.ts` is what makes a future rate or magnitude
unable to change that silently.

A negative `subtotalDiscounted` is legal — `calculateItemSubtotal` lets a flat
discount exceed its line rather than clamping — so the rounding is half *away
from zero* and the tax carries the subtotal's sign, exactly as the currency.js
form did.

### `consolidateItems(lineItems: LineItem[]): ConsolidatedItem[]`

Deduplicate line items by product UID and sum quantities.

## `unit_price` is a stored denorm, and `unit_price × quantity ≠ total_price`

`total_price` is the authoritative figure — it is a sum of line totals, and
summing money is exact. `unit_price` is derived from it by a division that
usually has a remainder, so the two are related by *rounding*, not by
multiplication: 3 units totalling $100 give `unit_price` $33.33, and
`33.33 × 3` is $99.99.

**That is correct, and it is written down here because it does not look
correct.** The field exists so `bookings` can be queried as a flat per-line
fact table — sortable, filterable, "show me every line over $500/unit" — and
for that a single representative per-unit figure is exactly right. It is
never summed and never reconciled against; anything that multiplies it back
to recover a total should read `total_price_cents` instead. The four money÷quantity
sites in CFS have four different residual contracts, and this is the
stored-denorm one: **the residual is discarded on purpose.**

(Contrast `getXeroUnitAmountFromCents`, whose residual is real money because Xero
recomputes `LineAmount = UnitAmount × Quantity` on the other side of a wire.)

### `costTransactionFees(items: LineItem[], basisCents: number): LineItem[]`

Cost every `transaction_fee` line against a document subtotal, returning
copies with the computed amount written into `price`.

Shared by the order and invoice totals so the two cannot drift — they were
two byte-identical loops, and the invoice copy was reading `price.rate` /
`price.type` off a shape invoice line items have never had.

### `deriveOrderDateEnvelope(destinations: ReadonlyArray<Pick<DocDestinationType, "dates">>): OrderDateEnvelope`

Collapse per-destination dates into one order-level envelope.

There is no persisted order-level `dates` anymore — every destination owns
its own range. This derives a bounding envelope on demand for the consumers
that still want one order-level range: the Typesense projection's sort key
and the quote / Xero / Calendar / Trello exporters.

`*_start` boundaries take the earliest value across destinations, `*_end`
boundaries take the latest; `days_active` / `days_charged` take the largest
non-null value. For a single-destination order the envelope equals that
destination's dates exactly.

### `getDefaultChargeDays(dates: OrderDatesType, holidays: string[]): number | null`

Compute default chargeable days from order dates and holidays.
Returns null if required dates are missing.

### `getDestinationPairItemName(destination: DestinationType, index: number): string`

Build a display name for a destination pair from its delivery/collection addresses.
Falls back to "Destination N" when no addresses are present.

### `getDestinationsLegend(destinations: DestinationType[] | undefined | null): typeLiteral`

Pair-derived legend strings for the order's start/end dates.

Each pair contributes a label based on its `customer_collecting` /
`customer_returning` flags. Labels are deduped and joined with " / ", so
a mixed-mode order (one pair we deliver, one pair the customer picks up)
renders as "In Store Pickup / Delivery".

Mapping:
  start: customer_collecting === true → "In Store Pickup", else → "Delivery"
  end:   customer_returning  === true → "In Store Return", else → "Pickup"

Empty input returns empty strings.

### `getGroupItems(items: LineItem[], index: number): LineItem[]`

Collect the child product items belonging to a collapsible section.

Destination / group: walk forward to the next divider of the same or
outer level, collecting every line item.

Product: walk only its own contiguous subtree (via `getItemSubtreeRange`)
and return the immediate children (`path.at(-2) === item.uid`). Under the
within-parent uniqueness invariant, `path.at(-2) === uid` is unambiguous
inside the subtree; constraining to the subtree range protects against
accidental cross-parent collisions if an upstream invariant violation
slips through.

### `getGroupPath(items: LineItem[], index: number): GroupPath`

Walk backwards from `index` to determine which destination and group
an item belongs to. `destination` is the destination's `uid_delivery`;
`group` is the group item's `uid` (not its display name) — keying on
uid lets group display names be edited without losing collapse state
or risking collisions between two groups that happen to share a name.

### `getGroupTotals(items: LineItem[], index: number, taxes: Tax[]): GroupTotalsResult`

Get count and pricing totals for a collapsed section.

### `getItemSubtreeRange(items: T[], index: number): typeLiteral`

Return the contiguous index range covering an item and every descendant of it,
derived purely from `path` (not from item types or adjacency rules).

`computeItemPaths` lays items out depth-first, so descendants of `items[index]`
are always contiguous starting at `index + 1` and run until the first item
whose path does not start with `items[index].path`.

Generic over any `{ path: string[] }` so it works on order line items, invoice
line items (whose paths are scoped by an order divider uid), and any other
path-keyed flat array.

### `getParentProductUid(item: StructuralItem, structuralUids: Set<string>): string | null`

Get the parent product uid from an item's path.
Returns null for non-components (where path.at(-2) is a structural uid or absent).

### `getRemovalIndices(items: LineItem[], index: number): number[]`

Collect the indices of all items that should be removed when the item
at `index` is deleted — the item itself plus all its descendants.
Returns indices sorted ascending.

### `getStructuralUids(items: StructuralItem[]): Set<string>`

Build a set of structural item uids (dest/group) from items array.
Used to distinguish structural path elements from product parent refs.

Order-shaped by default. `computeItemPaths` does NOT call this — it derives
the set from whichever `levels` it was handed, so an invoice's `order`
dividers count as structural there too. That asymmetry is why this keeps its
own two-type test rather than reading `ITEM_CONTRACTS[type].kind`: switching
to the contract would silently make `order` dividers structural here, for
every invoice caller.

### `getTaxTotals(items: LineItem[], taxes: Tax[]): PriceModifier[]`

Aggregate tax PriceModifiers by name across all pre-tax items.

### `getTotalDiscountCents(items: LineItem[]): number`

Calculate the total discount amount, in cents, across all pre-tax items.

### `getTransactionFeeTotals(items: LineItem[]): PriceModifier[]`

Aggregate priced fee lines into the document-level `transaction_fees` rollup.

Input is fee ITEMS carrying a costed `price` (as produced by the second pass
of `calculateOrderTotals` / `calculateInvoiceTotals`); output is a
`PriceModifier[]` — a rate-and-amount summary, which is a genuinely different
shape from a line and stays one. The fee's identity comes from the item
itself now that the price no longer carries a nested `{uid, name}`: a line
item's `uid` IS its product uid, which is exactly what the old
`price.uid` held.

### `groupByDestination(items: LineItem[], fallbackDeliveryUid: string, fallbackCollectionUid?: string): DestinationGroup[]`

Slice the flat items array into destination sections.

### `isPreTaxItem(item: LineItem): item is PreTaxLineItem`

Determine whether a line item participates in subtotal/discount/tax calculations.
Standalone predicate (not composed) because TS doesn't support negated predicates.

### `isPreTaxPricingItem(item: PricingItem): item is PreTaxPricingItem`

{@link isPreTaxItem} at the {@link PricingItem} surface — the same three
checks, narrowing to a shape the pricing pipeline can read rather than to a
stored line item. Used by the three pricing entry points so they accept an
order-input item without being handed a stored price that does not exist yet.

### `isPriceableItem(item: LineItem): item is PriceableLineItem`

Determine whether a line item is priceable (has a price object, not a structural item).

### `isSameAsDeliveryDates(dates: OrderDatesType): boolean`

Whether charge dates match the delivery/collection dates
(i.e. no custom charge period has been set).

### `isSameAsDeliveryDestination(destination: DestinationType): boolean`

Whether a destination's collection endpoint matches its delivery endpoint
(address, contact, and instructions are all equal).

### `isTaxableCoa(coaRevenue: number | null | undefined): boolean`

Is a line with this revenue COA subject to tax?

**`null`/`undefined` means UNKNOWN, and unknown is treated as TAXABLE** — the
opposite of the Xero push's `![4000, 4200, 4210].includes(coa ?? 0)`, and the
asymmetry is deliberate. That call site resolves the COA from the product
before asking, so absent there really does mean "not a taxable account". The
pricing engine has no such guarantee: **an order line item carries no
`coa_revenue` at all** — the field is on the invoice item and the product, not
the order item. Folding unknown into "untaxable" here would silently zero the
tax on every order line in the corpus.

So this gate only ever *removes* tax from a line it can positively identify as
non-revenue, and a caller that can resolve the COA must supply it (see
{@link PricingItem.coa_revenue}).

⚠️ The two sides therefore still disagree for an unknown COA, which is exactly
the state of a `custom-` line: it has no product, so the quote push sends
`NONE` while the engine keeps taxing it. Closing that needs a decision about
what a custom line's COA should be, not a change to this predicate.

### `isTransactionFeeItem(item: LineItem): item is TransactionFeeLineItem`

Determine whether a line item is a transaction fee.

### `orderHasDiscount(items: LineItem[]): boolean`

Check whether any pre-tax line item has a discount.

### `orderHasRentals(items: LineItem[]): boolean`

Check whether any line item is a rental.

### `orderHasTax(items: LineItem[]): boolean`

Check whether any pre-tax line item has taxes applied.

### `sumDocumentTotals(items: LineItem[], taxes: Tax[]): DocumentTotalsCore`

The two-pass totals fold shared by {@link calculateOrderTotals} and
`calculateInvoiceTotals`: pre-tax subtotals first, then transaction fees
costed against `subtotal_discounted`.

It was ~35 byte-identical lines in both, which is the drift shape this
package exists to remove — but the two wrappers are NOT collapsible past
this point, and the differences are load-bearing rather than incidental:

- **`calculateOrderTotals` keeps its `Array.isArray` throw.** Leading this
  helper with the invoice path's `flattenForXero` would turn a clear
  `Error("items must be an array")` into a bare `TypeError` at the call site.
- **`replacement_total` stays outside**, because
  {@link calculateReplacementTotals} reads the **unfiltered** items and is
  order-only.
- **The invoice path pre-filters `flattenForXero(items)` and this one does
  not**, which is safe because that filter is arithmetically inert here: it
  keeps `itemContract(type).kind === "line"`, every `kind: "divider"` member
  has `pricing: "none"` (pinned both directions at compile time by
  `_lineParity` in `schemas/common.ts`), and every predicate below gates on
  `pricing`. An unrecognised type is dropped by both. `filter` preserves
  order, and the fold accumulates in integer cents, so no float
  associativity hazard exists even if it did not.

Not exported to templates — a rendered document reads its **stored**
`totals`, and recomputing at render time is how a document comes to disagree
with the doc it renders.

### `syncChargeDaysToItems(items: LineItem[], previousDefault: number | null, newDefault: number | null): void`

Update chargeable_days on line items that still match the previous default.
Skips structural items, items without a price, and manual overrides.

### `validateComponentUniqueness(items: T[]): ItemUniquenessIssue[]`

Products' `components` variant of {@link validateItemUniqueness}. A product
component `path` is the ancestor chain and EXCLUDES the component's own uid,
so the immediate parent is the LAST segment (`path[-1]`), not the
second-to-last. Reusing {@link validateItemUniqueness} here is off by one: it
keys a depth->=2 entry on its GRANDparent, so the same sub-product placed
under two different direct children — a placement the product editor supports
— collapses into one key and is falsely rejected (api-cloudrun#348).
Exact-duplicate rows (identical full `path` + `uid`) still collide and are
still rejected.

Returns `[]` when uniqueness holds.

### `validateItemParentage(items: T[]): ItemParentageIssue[]`

Assert every item's structural parent is a type its contract admits —
`ITEM_CONTRACTS[item.type].parentable_by`, resolved through `path.at(-2)`.

**This is an INDEPENDENT property, and that is the whole point.**
`validateItemPaths` is a fixed-point check — "`path` equals what the
recompute produces" — so it can only ever agree with `computeItemPaths` and
inherits every hole in it. That is not hypothetical: when
`computeInvoiceItemPaths` returned its input unchanged on a divider-less
invoice, the fixed-point guard certified 79 provably-wrong items as clean,
corpus-wide, for as long as the hole existed. This check consults the contract
table instead of the normalizer, so a future hole cannot hide behind its own
oracle — the same reason `path.length >= 1` and `path.at(-1) === uid` are
asserted directly in `api-cloudrun/src/lib/validate.ts`.

The rule it enforces is the asymmetry the corpus supports: **a divider is
never parented by a line item.** A `group` nested under a rental would make
the structural prefix `computeItemPaths` derives meaningless. Line items are
deliberately permissive — they are parented by dividers AND by other line
items (kit components).

The document root is always legal, so an item whose `path` is just `[self]`
is never reported; the "must sit under a divider" rule is NOT asserted here,
because 78 legacy flat invoice items live at the root in prod and rejecting
them would make those invoices unwritable.

Returns `[]` when every parent is admissible.

### `validateItemPaths(items: T[]): ItemPathIssue[]`

Assert every line item's `path` matches what {@link computeItemPaths} would
produce — i.e. structural prefix + component ancestry + self uid, with no
stale dest/group uids from prior drag positions.

Use as a defensive write-time invariant: any client (manager, webhook
handlers, manual firestore_admin pokes) that writes orders should pipe
`items` through `computeItemPaths` first, so a non-empty result here means
the client skipped the recompute step.

Reports per-index mismatches; under the depth-first contiguity invariant,
an index whose `uid` doesn't match the recomputed array's uid at the same
index is also a violation (the array needs re-linearization). The original
path is reported so the caller can diff against `expected`.

Returns `[]` when every path is clean and order is canonical.

### `validateItemUniqueness(items: T[]): ItemUniquenessIssue[]`

Assert that within each items array, no two entries share the same `uid`
AND the same immediate structural parent. The immediate structural parent
is the second-to-last `path` segment (or `null` for items whose path is
just `[self.uid]`).

This is the uniqueness invariant orders/invoices rely on so that path-based
line identity is unambiguous. Violations indicate a duplicate that should
be merged — `mergeStagedIntoOrder` and the migration script consolidate.

Returns `[]` when uniqueness holds.

NOTE: assumes the self-INCLUDED `path` convention. Product `components`
exclude self from `path` — use {@link validateComponentUniqueness} for them.

### `validatePathsAgainst(items: T[], recompute: fnOrConstructor): ItemPathIssue[]`

The fixed-point comparison behind {@link validateItemPaths} and
`validateInvoiceItemPaths`, parameterised on the recompute.

**Call the named wrappers, not this.** The workspace rule that invoice items
must go through `computeInvoiceItemPaths` *by name* exists because handing
invoice items the order hierarchy silently drops every `order` divider out of
every path — and a `recompute` parameter is exactly the shape that lets that
happen at a call site rather than at a definition. This exists so the two
wrappers cannot drift, not to make the recompute a caller's choice.

It is also a **fixed-point** check, and therefore cannot be the only guard:
it agrees with whatever `recompute` produces, so it inherits every hole in
it. Pair it with a property that holds independently — `validateItemParentage`
against the contract table, and the direct `path.length >= 1` /
`path.at(-1) === uid` assertions in `api-cloudrun/src/lib/validate.ts`.

## `@cfs/core/utils/products`

Shared product utility functions for CFS applications.

```ts
import { buildComponentEntries } from "@cfs/core/utils/products";

// When adding component B to product A, copy B's nested components
// into A's components array with adjusted paths:
const nested = buildComponentEntries("A", productB.components, 1);
```

### `buildComponentEntries(parentUid: string, sourceComponents: T[], baseDepth: number, maxDepth?: number): T[]`

Build component entries for a parent product from a component product's
own `components` array. Each entry's `path` is prepended with `parentUid`
so it reflects its position in the parent's tree.

No recursion needed — the source product's `components` already contains
its full descendant tree as a flat array.

**Parameters**

- `parentUid` — UID of the product receiving the component
- `sourceComponents` — The component product's own `components` array
- `baseDepth` — Depth of the direct component in the parent (typically 1)
- `maxDepth` — If set, exclude entries whose depth in the parent exceeds this

**Returns** — New `ProductComponent[]` entries with adjusted paths

### `deriveProductImageUuids(images: readonly typeLiteral[] | undefined): string[]`

Derive `query_by_images` from `images` — each row's `uuid` followed by its
`uuid_cutout` when set, walking `images` in order.

The single source of the denormalization, called by every writer. Defined here
rather than in `utils/products.ts` because the schema needs it and the import
direction is strictly utils → schemas; `@cfs/core/utils/products` re-exports
it, which is where writers should import from (same shape as `deriveName`).

**Ordered, but not an ordering source.** The emitted array follows `images`
row order — it costs nothing (one pass either way) and a mirror that tracks
the display array is easier to eyeball in the console than an arbitrary one.
But `images` remains the sole authority on display order: this field exists
for Firestore `array-contains`, and the refinement below compares it as a
multiset, so a differently-ordered mirror holding the same uuids is still
valid. Nothing may read order back out of it.

### `removeComponentEntries(components: T[], path: string[]): T[]`

Remove a component and all its descendants from a flat components array.
An entry is removed if its `path` starts with the given path prefix —
this covers the component itself and every entry nested beneath it.

**Parameters**

- `components` — The product's current `components` array
- `path` — Full path of the component to remove (e.g. `["A", "B"]`)

**Returns** — New array with the component and its descendants removed

## `@cfs/core/utils/taxes`

Shared tax helpers for CFS applications — the single home for doc-level
`tax_profile` override logic + as-of Tax-catalog resolution, so the API
(orders + invoice webhook) and the manager (optimistic recompute) share one
implementation.

Depends one-way on `./orders.ts` (base pricing module) — no cycle.

### `TAXABLE_REVENUE_COAS`

The revenue COAs that sales/rental tax is actually owed on — 4000 Rental
Income, 4140 Pass Through Income, 4200 Retail Sales Income, 4210 Replacement
Sales Income.

**This is the single source of truth for line taxability**, and it has to be,
because it previously existed only on the *Xero push* side and nowhere in the
engine computing CFS's own totals. So CFS taxed lines it then told Xero were
untaxable (`TaxType: "NONE"`), inflating `total` and leaving the difference as
a phantom `amount_due`. Measured on prod 2026-07-30: **19 invoices /
$2,741.78**, plus 9 orders / $453.50.

Everything outside the set is a service or fee — Service Income, Delivery
Surcharges, Transaction Fee, Other Income — and sales tax is not owed on it.
Xero was right and the engine was wrong, so there is no historical
under-collection: the customer was always billed the untaxed amount and CFS
merely displayed a balance that was never real.

**4140 Pass Through Income was added 2026-08-02, and the direction matters.**
Every other member of this set was here because Xero disagreed with the engine
and Xero was right. 4140 is the one case where the two agreed with each other
and the constant was the outlier: prod invoice #1897 carries its SSD Card line
at `AccountCode: 4140` in CFS *and* in Xero, taxed `TAX003` (Chicago Rental,
11%) for $510.40 in both, paid in full. Excluding 4140 meant the next reprice
of that invoice would have deleted tax that was charged, collected and
remitted. Operator decision: pass-through income is taxable.

`api-cloudrun/src/lib/xeroTax.ts` consumes this same constant so the push and
the totals cannot drift apart again.

```ts
const TAXABLE_REVENUE_COAS: readonly number[];
```

### `TAX_PROFILE_OVERRIDE_NAME`

Doc-level location tax profiles → the Tax doc `name` they resolve to (by
`findTaxAt`, as-of date). `tax_applied` (no override) and `tax_exempt`
(handled separately) are absent.

**A profile added here needs a `taxes/` document with that exact name, or
`findTaxAt` returns `null` and the override silently does nothing.** That is
the failure mode `tax_paxton` was added to fix rather than to repeat: prod
#1978 was delivered to Paxton, Illinois, Xero taxed it `TAX005` at the 6.25%
IL-state rate, and CFS had no Paxton profile at all — so it fell back to
Rantoul's 9% and disagreed with Xero by $4.89 on top of the service-line tax
it should not have charged.

```ts
const TAX_PROFILE_OVERRIDE_NAME: Partial<Record<TaxProfileType, string>>;
```

### `Tax`

Subset of the full Tax document needed by utility functions.
`valid_from`/`valid_to` are optional — only the as-of resolver (`findTaxAt` in
`@cfs/core/utils/taxes`) reads them; pricing helpers ignore them. Optional so
partial `Tax` literals in tests/callers keep type-checking.

```ts
type Tax = Pick<SchemaTax, "uid" | "name" | "rate" | "type"> & Partial<Pick<SchemaTax, "valid_from" | "valid_to">>;
```

### `computeItemTaxAmountCents(tax: Pick<Tax, "rate" | "type">, subtotalDiscountedCents: number, quantity: number): number`

Pure per-item tax amount for one tax against a given subtotal.
`percent` → `subtotalDiscounted × rate/100`; `flat` → `rate × quantity`.

`subtotalDiscounted` is a **parameter** (not recomputed) so both the order
path (which passes its `calculateItemSubtotal` result) and the CRMS invoice
webhook (which passes its `charge_total`-authoritative stored subtotal) share
one formula. Lives here (base module) and is re-exported from
`@cfs/core/utils/taxes` to avoid a `taxes ↔ orders` import cycle.

Exact: both factors are applied as `× n ÷ d` over integer cents and rounded
half-up exactly once (core#47). The form this replaced was
`currency(subtotalDiscounted).multiply(tax.rate / 100)` — a pre-divided float
ratio, and **the one percent-of-money path that never migrated to integer
cents**: inside a single `calculateItemPrice` call the discount on a line was
already exact BigInt while the tax on that same line was not. It was measured
benign across CFS's six live rates, which is precisely why it survived; the
sweep in `tests/orders.test.ts` is what makes a future rate or magnitude
unable to change that silently.

A negative `subtotalDiscounted` is legal — `calculateItemSubtotal` lets a flat
discount exceed its line rather than clamping — so the rounding is half *away
from zero* and the tax carries the subtotal's sign, exactly as the currency.js
form did.

### `findTaxAt(taxes: Tax[], name: string, asOf: string): Tax | null`

Pick the Tax whose `[valid_from, valid_to)` bracket contains `asOf`, matched
by exact `name`. Returns null when nothing matches (e.g. `asOf` before any
historical doc). Throws on catalog drift (two same-name docs bracket the same
instant). A missing `valid_from` is treated as an open start; missing/null
`valid_to` as an open end.

Comparison is by instant (ms since epoch), so Chicago-offset strings with
heterogeneous DST (-05:00 vs -06:00) compare correctly.

### `getEffectiveProfileTax(orgProfile: string, docProfile: string, taxCatalog: Tax[], asOf: string): Tax | "exempt" | null`

Resolve the effective doc-level override from the org + doc `tax_profile`
pair, as-of `asOf`. Precedence: `tax_exempt` wins (a tax-exempt customer pays
no tax regardless of location) → else the doc-level location profile
(doc over org) resolved to its Tax → else `null` (no override, `tax_applied`).

**Returns** — `"exempt"` (→ empty taxes) | a resolved `Tax` | `null` (no override).

### `isTaxableCoa(coaRevenue: number | null | undefined): boolean`

Is a line with this revenue COA subject to tax?

**`null`/`undefined` means UNKNOWN, and unknown is treated as TAXABLE** — the
opposite of the Xero push's `![4000, 4200, 4210].includes(coa ?? 0)`, and the
asymmetry is deliberate. That call site resolves the COA from the product
before asking, so absent there really does mean "not a taxable account". The
pricing engine has no such guarantee: **an order line item carries no
`coa_revenue` at all** — the field is on the invoice item and the product, not
the order item. Folding unknown into "untaxable" here would silently zero the
tax on every order line in the corpus.

So this gate only ever *removes* tax from a line it can positively identify as
non-revenue, and a caller that can resolve the COA must supply it (see
{@link PricingItem.coa_revenue}).

⚠️ The two sides therefore still disagree for an unknown COA, which is exactly
the state of a `custom-` line: it has no product, so the quote push sends
`NONE` while the engine keeps taxing it. Closing that needs a decision about
what a custom line's COA should be, not a change to this predicate.

### `materializeDocumentTax(items: LineItem[], orgProfile: TaxProfileType, docProfile: TaxProfileType, taxCatalog: Tax[], asOf: string): void`

**The one tax materializer.** Apply a document's `tax_profile` as a doc-level
override, then reprice every priceable line from its (rewritten) tax uid.
Mutates `items` in place; callers run `calculateOrderTotals` /
`calculateInvoiceTotals` afterwards.

This is {@link overrideItemTaxesForProfile} **plus the reprice** — the pair
every write path that owns its own line prices needs, and the pair only the
order path had. `api-cloudrun`'s `repriceOrderItemsForProfile` was this
function for orders only; native `POST/PUT /invoices` called neither half, so
a `tax_exempt` invoice stored the profile, sent Xero `TaxType: NONE`, and kept
CFS items and totals fully taxed.

Three consumers, one implementation: api-cloudrun's order write paths,
api-cloudrun's `createInvoice`/`updateInvoice`, and the manager's optimistic
recompute. The manager consumer is the reason this lives in `core` rather than
in `api-cloudrun/src/lib/` — a client-side reimplementation would recreate, on
the client, exactly the order/invoice divergence this function exists to
close.

⚠️ **The CRMS invoice webhook must keep calling the bare
{@link overrideItemTaxesForProfile}, not this.** Its subtotals are
`charge_total`-authoritative (api-cloudrun#236) — a reprice would recompute
them from `base_cents × quantity × days_factor` and under-bill, which
`crms.test.ts` pins at 28.6% on a real line.

**`orgProfile` is a real parameter, not a constant.** The order path hardcoded
`"tax_applied"` here, so an org-level `tax_exempt` was honored on that
customer's invoices and silently ignored on their orders. Precedence is
{@link getEffectiveProfileTax}'s: `tax_exempt` from either side wins, then the
doc's location profile, then the org's.

**Pure** — `asOf` is injected rather than defaulted to now, so this stays free
of an ambient clock (the workspace date rules ban `new Date()` for business
datetimes, and a defaulted `now` is how that ban gets bypassed). Callers
derive it: the order paths from the earliest destination delivery start, the
invoice paths from `invoice.date`.

**Parameters**

- `items` — Document items, mutated in place. Non-priceable members
(destination/group/transaction_fee) are skipped by both halves.
- `orgProfile` — The customer organization's `tax_profile`.
- `docProfile` — The document's own `tax_profile`, which takes precedence.
- `taxCatalog` — The `taxes` collection, for name+date resolution.
- `asOf` — Instant to resolve the tax catalog at.

### `overrideItemTaxesForProfile(items: LineItem[], orgProfile: string, docProfile: string, taxCatalog: Tax[], asOf: string): void`

Materialize a doc-level `tax_profile` override onto each priceable item's
`price.taxes` (single mode — mutates in place):
- `tax_exempt` → `taxes = []`, `total_cents = subtotal_discounted_cents`.
- `tax_rantoul` / `tax_frankfort` → `taxes = [<resolved tax>]` with amount
  computed from the item's **existing** `subtotal_discounted_cents` + `total_cents`
  refreshed. (Orders re-run `calculateItemPrice` after, which recomputes both
  from the rewritten uid; the CRMS invoice webhook keeps the amounts computed
  here on its `charge_total`-authoritative subtotal.)
- `tax_applied` / no active override doc → item left untouched.

Non-priceable items (destination/group/transaction_fee) are skipped.

## `@cfs/core/utils/templates`

Template helpers for the git-canonical template system — pure functions
shared by api-cloudrun and manager.

- `slugify` derives a `git_path` from a family display name (frozen at create).
- `deriveBump` maps a conventional-commit type → semver bump level, and
  `bumpSemver` applies that bump to the family's previous version.
- `resolveRenderParams` validates caller-provided render params against the
  version's declared params **strictly** — unknown params throw (the API
  maps `RenderParamError` → HTTP 422).

No runtime dependency on `@cfs/core/schemas`: the declared-param shape is accepted
structurally so this module type-checks independent of the schemas publish
cadence. `@cfs/core/schemas`' `TemplateParam` is structurally compatible.

### `BumpLevel`

A semantic-version bump level.

```ts
type BumpLevel = "major" | "minor" | "patch";
```

### `RenderParamDecl`

A render-time parameter declaration (structurally `@cfs/core/schemas`' `TemplateParam`).

```ts
interface RenderParamDecl {
  key: string;
  type: string;
  label?: string;
  default?: boolean;
  required?: boolean;
}
```

### `RenderParamError`

_(class — see source)_

### `bumpSemver(current: string | null | undefined, bump: BumpLevel): string`

Apply a bump level to a `MAJOR.MINOR.PATCH` semver string. A missing/invalid
`current` is treated as `0.0.0` (so the first publish off `deriveBump` yields
`1.0.0` for a major, `0.1.0` for a minor, `0.0.1` for a patch).

### `deriveBump(type: string, breaking: boolean): BumpLevel`

Map a conventional-commit type + breaking flag to a semver bump level.
Breaking always wins (`major`). `feat` → `minor`. Everything else
(`fix`, `refactor`, `chore`, `docs`, …) → `patch`.

### `fixtureDir(gitPath: string): string`

Directory holding a template family's fixtures: `fixtures/<git_path>/`.

### `fixturePath(gitPath: string, slug: string): string`

Path to one fixture: `fixtures/<git_path>/<slug>.json`.

### `goldenPath(branch: string, gitPath: string, slug: string): string`

Path to one branch-keyed golden: `goldens/<branch>/<git_path>/<slug>.png`.

### `hashTemplateContent(content: Record<string, string>): string`

Order-independent fingerprint of a template/component content map
(path → file text). The API stamps a version's `committed_content_hash` with
this when it pushes content to git (commit / release); the manager hashes the
live draft content the same way to detect "dirty since last commit" and warn
at approve-to-merge.

Pure, synchronous, and runtime-agnostic (Deno + browser) so both sides agree
byte-for-byte. A non-cryptographic 64-bit FNV-1a digest (two seeded streams):
collision resistance is irrelevant here — it only answers "did the content
change since the last push?".

```ts
hashTemplateContent({ "a.eta": "x" }) === hashTemplateContent({ "a.eta": "x" }); // true
```

### `parseFixturePath(path: string): typeLiteral | null`

Parse a fixture path back to `{ gitPath, slug }`. Returns `null` for any
path that isn't of the form `fixtures/<gp>/<slug>.json`. The affected-set
classifier consumes this to route fixture-only PR changes into the
`goldenOnly` bucket (golden re-run, no version bump).

### `resolveRenderParams(declared: readonly RenderParamDecl[], provided: Record<string, unknown> | undefined): Record<string, boolean>`

Resolve caller-provided render params against a version's declared params,
**strictly**:
- any provided key not declared → throw `RenderParamError`;
- a provided value of the wrong type → throw;
- a declared param absent from input → its `default` (or `false` for a
  boolean with no default), unless `required` with no default → throw.

Returns a fully-resolved param map safe to hand to the render context.

### `rewriteDocFieldRefs(content: Record<string, string>, fieldMap: Record<string, string | null>): Record<string, string>`

Rewrite `it.doc.<from>` → `it.doc.<to>` across a content map per `fieldMap`
(normalized paths from `scanDocFieldRefs`). Entries mapped to `null` (or to
themselves) are left untouched — the operator resolves those by hand. Array
indices are preserved (`items[0].name` with map `items[].name`→`lines[].name`
becomes `lines[0].name`). Longest `from` rewritten first so a nested path is
handled before its prefix.

### `scanDocFieldRefs(content: Record<string, string>): string[]`

Distinct `it.doc.<path>` references across a content map, with array indices
normalized (`it.doc.items[0].name` → `items[].name`) so paths match the
`templateSchemaFields` catalog. Sorted, deduped.

BEST-EFFORT — does NOT catch loop-aliased refs (`it.doc.items.forEach(i =>
i.name)`) or optional chaining. Most line-item fields are loop-aliased, which
is exactly where order/invoice schemas diverge, so treat the result as a
head-start, never a complete list.

### `slugify(name: string): string`

Derive a URL/git-safe slug from a display name. Lowercases, replaces every
run of non-alphanumeric characters with a single hyphen, and trims leading/
trailing hyphens. Two distinct display names can collapse to the same slug
(e.g. "Quote!" and "quote") — callers enforce slug uniqueness at create.

```ts
slugify("Packing List (v2)"); // "packing-list-v2"
```
