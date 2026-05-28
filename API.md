# `@cfs/utilities` API Reference

_Generated from source by `scripts/generate-api-docs.ts` — do not edit by hand. A structured companion is emitted alongside as `API.json`. Browsable version on [JSR](https://jsr.io/@cfs/utilities/doc/all_symbols)._

## `@cfs/utilities/bookings`

Pure helpers over the booking breakdown shape and the order's denormalized
roll-up. Used both server-side (api-cloudrun) and client-side (manager) so
the warehouse picker sees instant optimistic updates and the order detail
page can compute "is this order done?" without a round-trip.

```ts
import {
  sumBookingBreakdown,
  isOrderBookingsClosed,
  mergeBookingBreakdown,
} from "@cfs/utilities/bookings";
```

### `BOOKING_BREAKDOWN_KEYS`

All seven keys of the booking lifecycle breakdown. Order matches the schema.

```ts
const BOOKING_BREAKDOWN_KEYS: "quoted" | "reserved" | "prepped" | "out" | "returned" | "lost" | "damaged"[];
```

### `BOOKING_BREAKDOWN_OPEN_KEYS`

Keys representing items that are still in flight (pre-terminal).

```ts
const BOOKING_BREAKDOWN_OPEN_KEYS: "quoted" | "reserved" | "prepped" | "out"[];
```

### `BOOKING_BREAKDOWN_TERMINAL_KEYS`

Keys representing items that have reached a terminal state.

```ts
const BOOKING_BREAKDOWN_TERMINAL_KEYS: "returned" | "lost" | "damaged"[];
```

### `applyBookingBreakdownDelta(orderBreakdown: indexedAccess, prev: indexedAccess, next: indexedAccess): void`

Apply a per-key delta to an order's bookings_breakdown roll-up in place.

Given a booking's previous and next breakdown, mutate the order roll-up by
`+= next[k] - prev[k]` for each key. Useful both server-side (where
`updateBooking` applies a single-doc delta to avoid reading every sibling
booking) and client-side (where the manager can apply the same delta
locally for instant feedback).

### `calculateBookingBreakdown(status: string, type: string, quantity: number, existingBreakdown?: indexedAccess): indexedAccess`

Project a booking's breakdown for a given order status, item type, and
total quantity. Pure sync — no I/O.

The new bucket (`quoted` for status `quoted`, `reserved` for `reserved`/
`active`, `returned`/`out` for `complete`) is computed as
`quantity - (carried-over progress)` so the resulting breakdown always
sums to `quantity`. The carry-over set is `prepped + out + returned + lost
+ damaged` — the previous `quoted` and `reserved` values are intentionally
dropped, which is what fixes the "two open buckets after a status flip"
data corruption that surfaced in opportunity webhook ingestion.

Status rules:
  draft / canceled  → all zeros (cleared on cancel/draft)
  quoted            → quoted = quantity − carry; preserves prepped/out/terminals
  reserved / active → reserved = quantity − carry; preserves prepped/out/terminals
  complete + rental → returned = quantity − (lost + damaged); zero everything else
  complete + sale   → out = quantity; zero everything else
  anything else     → all zeros

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

## `@cfs/utilities/cards`

Pure helpers over event-card lifecycle. Shared by api-cloudrun (writers
inside the booking-update transaction) and the manager (optimistic
client-side projections in `applyBookingActions`) so both sides agree on
exactly what `card.status` becomes after a booking write.

```ts
import { computeCardStatusFromBookings } from "@cfs/utilities/cards";
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

**End card (collection)** — siblings filtered to `uid_destination_collection`:
  Sale-type bookings are excluded — sales have no collection event, so the
  end card stays planned↔complete based on rental siblings only.
  - `terminal  = Σ (returned + lost + damaged)`
  - `total     = Σ booking.quantity`
  - `still_out = Σ breakdown.out`
  - if `terminal === total`              → `complete` (everything collected/written-off)
  - else if `terminal > 0 || still_out > 0` → `active`   (collection in progress)
  - else                                  → `planned`  (nothing has come back yet)

If the end-side roll-up has no rental siblings (e.g. a sale-only
destination), the card resolves to `complete` — there is nothing to collect.

**Parameters**

- `side` — Which card side this is — drives which key set we sum and
which sibling set the caller is expected to have prepared.
- `siblings` — Bookings filtered to the relevant destination side.
- `current` — The card's current status — preserved if `blocked` or
`canceled` so manual overrides aren't clobbered.

## `@cfs/utilities/contact-name`

Contact name helpers — re-exports the canonical `deriveName` from
`@cfs/schemas` so manager and other utilities consumers can import it
from a single, stable runtime location.

```ts
import { deriveName } from "@cfs/utilities/contact-name";

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

## `@cfs/utilities/dates`

Pure date helper functions for CFS applications.
All functions accept holidays as a parameter to enable client-side calculations.

```ts
import { formatChargeDays, countCfsBusinessDays } from "@cfs/utilities/dates";

const result = formatChargeDays(10);
console.log(result.periodLabel); // "2 weeks"

const start = new Date("2025-01-06");
const end = new Date("2025-01-10");
const days = countCfsBusinessDays(start, end, []);
console.log(days.days); // 5
```

Published in lockstep with `@cfs/schemas` — version bumps track the
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

**Parameters**

- `days` — A positive number of chargeable days.
- `unit` — Display unit: `"day"`, `"days"`, `"week"`, or `"weeks"`. When omitted, weeks are used if `days >= 5`.

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

## `@cfs/utilities/invoices`

Shared invoice utility functions for CFS applications.
Re-exports generic item helpers from orders and adds invoice-specific utilities.

```ts
import { flattenForXero, isPriceableItem, syncOrderItems } from "@cfs/utilities/invoices";

const billableItems = flattenForXero(invoice.items);
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

### `InvoiceDestinationPair`

Invoice-side destination pair — matches the schemas-next
`InvoiceDocDestinationType` (a `DocDestinationType` plus a `uid_order`
scope field). Defined structurally here so this module can be published
ahead of / alongside the schemas-next beta that adds the type.

```ts
interface InvoiceDestinationPair {
  uid_order: string;
}
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
  price?: PriceObject | PriceModifierType | InvoiceDocItemPrice;
  coa_revenue?: COARevenueType | null;
  tracking_category?: string | null;
  xero_id?: string | null;
  xero_tracking_option_id?: string | null;
  crms_id?: number | string | null;
}
```

### `InvoiceTotals`

```ts
type InvoiceTotals = InvoiceDocTotals;
```

### `ItemPathIssue`

A single path mismatch reported by {@link validateItemPaths} or
{@link validateInvoiceItemPaths} (re-exported from `@cfs/utilities/invoices`).

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
(and the invoice-scoped variant in `@cfs/utilities/invoices`).

```ts
interface ItemUniquenessIssue {
  index: number;
  uid: string;
  parentUid: string | null;
  firstIndex: number;
}
```

### `LineItem`

A single line item in an order (product, destination, group, surcharge, or fee).
Loose interface compatible with all OrderDocItemType members — utility functions
use type guards (isPriceableItem, isTransactionFeeItem) before accessing
member-specific fields.

```ts
interface LineItem {
  uid: string;
  name: string;
  type: string;
  quantity?: number;
  price?: PriceObject | PriceModifierType;
  stock_method?: string;
  path: string[];
  uid_delivery?: string | null;
  uid_collection?: string | null;
  zero_priced?: boolean | null;
  description?: string;
  order_number?: number;
  uid_order?: string | null;
}
```

### `PreTaxLineItem`

A pre-tax line item with a full price object (rental, sale, service, surcharge, replacement).

```ts
interface PreTaxLineItem {
  type: "rental" | "sale" | "service" | "surcharge" | "replacement";
  quantity: number;
  price: PriceObject;
}
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

### `Tax`

Subset of the full Tax document needed by utility functions.

```ts
type Tax = Pick<SchemaTax, "uid" | "name" | "rate" | "type">;
```

### `TransactionFeeLineItem`

A transaction fee line item with a PriceModifier price.

```ts
interface TransactionFeeLineItem {
  type: "transaction_fee";
  quantity: number;
  price: PriceModifierType;
}
```

### `buildOrderScopedItems(orderItems: LineItem[], orderDividerUid: string): InvoiceItem[]`

Build invoice items from an order's items, scoped under an order divider.
Projects each order item to its invoice-item shape and prepends the order
divider uid to its path.

**Parameters**

- `orderItems` — The order's items array (may contain destination/group/line items)
- `orderDividerUid` — The uid of the order divider these items belong under

**Returns** — Items projected to invoice shape with path prepended by orderDividerUid

### `calculateInvoiceTotals(items: InvoiceItem[], taxes: Tax[], payments?: typeLiteral[]): InvoiceTotals`

Calculate aggregated pricing totals for an invoice.

Composes from the same atomic building blocks as orders (calculateItemSubtotal,
getTaxTotals, etc.) but assembled independently — shared per-item math,
independent aggregation. This avoids business logic drift if invoices need
different totals logic in the future (credit notes, partial billing, etc.).

**Parameters**

- `items` — Full invoice items array (structural items are filtered out)
- `taxes` — Tax definitions for tax calculation
- `payments` — Optional payments array for amount_paid/amount_due

### `calculateItemDiscount(item: LineItem): number`

Calculate the discount dollar amount for a single line item.

### `calculateItemPrice(item: LineItem, taxes: Tax[]): typeLiteral`

Calculate the complete price for a single line item.
Runs the full pipeline: subtotal → discount → taxes → total.

### `calculateItemSubtotal(item: LineItem): typeLiteral`

Calculate the pre-discount and post-discount subtotals for a single line item.

### `calculateItemTax(item: LineItem, taxes: Tax[]): PriceModifier[]`

Calculate tax amounts for a single line item from the Tax[] parameter.
Returns a PriceModifier[] with computed amounts.

### `calculateItemTotal(item: LineItem, taxes: Tax[]): number`

Calculate the total (subtotal_discounted + taxes) for a single line item.
Handles both PriceObject (regular items) and PriceModifier (transaction fee items).

### `carryForwardOverrides(rebuiltItems: InvoiceItem[], existingItems: InvoiceItem[]): InvoiceItem[]`

Carry forward invoice-specific overrides from existing items to rebuilt items.
Matches by uid — if a rebuilt item has the same uid as an existing invoice item,
the invoice-specific fields (coa_revenue, tracking_category, xero_id,
xero_tracking_option_id) are preserved from the existing item.

**Parameters**

- `rebuiltItems` — Items rebuilt from the order
- `existingItems` — Current invoice items (to carry forward overrides from)

**Returns** — Rebuilt items with invoice-specific overrides applied

### `computeInvoiceItemPaths(items: InvoiceItem[]): InvoiceItem[]`

Compute paths for all invoice items, respecting order divider scoping.
Wraps computeItemPaths — strips divider prefix per scope, delegates
to the shared order path logic, then re-adds the prefix.

Pure: returns a fresh array of fresh items. Inputs are not mutated, so it is
safe to pass items that originate from a Solid store proxy. Callers should
replace their working array with the return value.

### `computeItemPaths(items: T[]): T[]`

Compute full structural paths for a flat items array AND linearize it
depth-first with `zero_priced` items sorted before priced ones inside each
parent's direct-children block.

Each item's path = [structural context...] + [component ancestry...] + [self uid].

Client-sent paths carry component ancestry (from ProductComponent.path).
This function prepends structural context (dest/group) and appends self uid.

Three transforms in order:
 1. Recompute every item's `path`. Strip ALL structural uids (every dest +
    group currently in the array) and the item's own uid from the
    client-supplied path; also strip orphan ancestor uids — segments that
    don't resolve to any item in the array (e.g. catalog-only intermediate
    kit uids that were never materialized). Then prepend the structural
    prefix and append the item's own uid.
 2. Linearize line items inside each (destination, group) block as a tree:
    each parent product is followed by its full subtree before the next
    sibling. Destination and group dividers stay where they are; only the
    line items between them are reordered.
 3. Within each parent's direct-children, stable-sort `zero_priced === true`
    before others. Drag-drop reorders preserve intra-band order.

Pure: returns a fresh array of fresh items. Inputs are not mutated, so it is
safe to pass items that originate from a Solid store proxy (the manager app
routes reordered arrays through this function inside `setEntity` updaters).
Callers should replace their working array with the return value.

Post-condition (under the within-parent uniqueness invariant): a parent and
its full subtree occupy a contiguous index range, so `getItemSubtreeRange`
and `getGroupItems` can rely on path-prefix matching alone.

### `derivePaymentStatus(currentStatus: string, amountPaid: number, amountDue: number): string`

Derive invoice status from payment amounts.
Pure function — does not mutate the invoice.

**Parameters**

- `currentStatus` — Current invoice status
- `amountPaid` — Total amount paid
- `amountDue` — Total amount still due

**Returns** — The derived status

### `flattenForXero(items: LineItem[]): LineItem[]`

Filter out structural items (group/destination/order dividers) and return only
billable line items suitable for Xero sync or totals calculation.

### `getItemSubtreeRange(items: T[], index: number): typeLiteral`

Return the contiguous index range covering an item and every descendant of it,
derived purely from `path` (not from item types or adjacency rules).

`computeItemPaths` lays items out depth-first, so descendants of `items[index]`
are always contiguous starting at `index + 1` and run until the first item
whose path does not start with `items[index].path`.

Generic over any `{ path: string[] }` so it works on order line items, invoice
line items (whose paths are scoped by an order divider uid), and any other
path-keyed flat array.

### `getOrderScopedItems(items: InvoiceItem[], orderDividerUid: string): InvoiceItem[]`

Get all invoice items scoped to a specific order divider.
Returns the order divider itself plus all items whose path starts
with the order divider's uid.

**Parameters**

- `items` — Full invoice items array
- `orderDividerUid` — The uid of the order divider item

**Returns** — Items scoped to that order (divider + children)

### `getParentProductUid(item: LineItem, structuralUids: Set<string>): string | null`

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

### `getStructuralUids(items: LineItem[]): Set<string>`

Build a set of structural item uids (dest/group) from items array.
Used to distinguish structural path elements from product parent refs.

### `getXeroUnitAmount(subtotal: number, quantity: number): number`

Compute the Xero unit amount from subtotal and quantity.
Bakes duration (chargeable_days × formula) into per-unit price,
since Xero has no concept of rental duration.

**Parameters**

- `subtotal` — Pre-discount subtotal (base × days × formula × quantity)
- `quantity` — Item quantity

**Returns** — Per-unit amount for Xero, or 0 if quantity is 0

### `isItemSynced(prevOrderItem: LineItem, invoiceItem: InvoiceItem, orderDividerUid: string): boolean`

Compare a previous order item to a current invoice item to detect overrides.
Returns true if the invoice item is "synced" (matches the order item on all
non-invoice-only fields), false if it has been manually overridden.

The comparison strips the order divider prefix from the invoice item's path
and ignores invoice-only fields (coa_revenue, tracking_category, xero_id,
xero_tracking_option_id).

**Parameters**

- `prevOrderItem` — The order item from the previous version of the order
- `invoiceItem` — The current invoice item (with order-scoped path)
- `orderDividerUid` — The uid of the order divider (for path prefix stripping)

**Returns** — true if the item is synced (not overridden), false if overridden

### `isPreTaxItem(item: LineItem): item is PreTaxLineItem`

Determine whether a line item participates in subtotal/discount/tax calculations.
Standalone predicate (not composed) because TS doesn't support negated predicates.

### `isPriceableItem(item: LineItem): item is PriceableLineItem`

Determine whether a line item is priceable (has a price object, not a structural item).

### `isTransactionFeeItem(item: LineItem): item is TransactionFeeLineItem`

Determine whether a line item is a transaction fee.

### `recomputePaymentTotals(total: number, payments: typeLiteral[]): typeLiteral`

Compute amount_paid and amount_due from a payments array.
Pure function — returns values instead of mutating.

**Parameters**

- `total` — Invoice total amount
- `payments` — Payments array with amount and status fields

**Returns** — Computed amount_paid and amount_due

### `removeOrderScopedDestinations(dests: InvoiceDestinationPair[], uidOrder: string): InvoiceDestinationPair[]`

Remove all destination pairs scoped to a specific order.
Mirrors `removeOrderScopedItems` for the items array.

### `removeOrderScopedItems(items: InvoiceItem[], orderDividerUid: string): InvoiceItem[]`

Remove all invoice items scoped to a specific order divider.
Returns a new array with the order divider and all items whose path
starts with the order divider's uid removed.

**Parameters**

- `items` — Full invoice items array
- `orderDividerUid` — The uid of the order divider item to remove

**Returns** — Items with the order scope removed

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

### `syncOrderItems(invoiceItems: InvoiceItem[], orderItems: LineItem[], orderDividerUid: string): InvoiceItem[]`

Sync a single order's items into an invoice's items array.
Replaces all items scoped to the order divider with rebuilt items from the order,
carrying forward invoice-specific overrides on matched uids.

**Parameters**

- `invoiceItems` — Current full invoice items array
- `orderItems` — The order's current items array
- `orderDividerUid` — The uid of the order divider in the invoice

**Returns** — Updated invoice items array

### `syncOrderToInvoiceSelective(prevOrderItems: LineItem[], newOrderItems: LineItem[], currentInvoiceItems: InvoiceItem[], orderDividerUid: string): InvoiceItem[]`

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

## `@cfs/utilities/orders`

Shared order utility functions for CFS applications.
Includes pricing calculations, item consolidation, and destination grouping.
All arithmetic uses currency.js for safe floating-point calculations.

```ts
import { calculateOrderTotals } from "@cfs/utilities/orders";

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

### `GroupPath`

```ts
type GroupPath = GroupPathType;
```

### `GroupTotalsResult`

Count and pricing totals for a collapsed destination or group section.

```ts
interface GroupTotalsResult {
  count: number;
  subtotal: number;
  subtotal_discounted: number;
  total: number;
}
```

### `ItemPathIssue`

A single path mismatch reported by {@link validateItemPaths} or
{@link validateInvoiceItemPaths} (re-exported from `@cfs/utilities/invoices`).

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
(and the invoice-scoped variant in `@cfs/utilities/invoices`).

```ts
interface ItemUniquenessIssue {
  index: number;
  uid: string;
  parentUid: string | null;
  firstIndex: number;
}
```

### `LineItem`

A single line item in an order (product, destination, group, surcharge, or fee).
Loose interface compatible with all OrderDocItemType members — utility functions
use type guards (isPriceableItem, isTransactionFeeItem) before accessing
member-specific fields.

```ts
interface LineItem {
  uid: string;
  name: string;
  type: string;
  quantity?: number;
  price?: PriceObject | PriceModifierType;
  stock_method?: string;
  path: string[];
  uid_delivery?: string | null;
  uid_collection?: string | null;
  zero_priced?: boolean | null;
  description?: string;
  order_number?: number;
  uid_order?: string | null;
}
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

A pre-tax line item with a full price object (rental, sale, service, surcharge, replacement).

```ts
interface PreTaxLineItem {
  type: "rental" | "sale" | "service" | "surcharge" | "replacement";
  quantity: number;
  price: PriceObject;
}
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

### `ReplacementTotals`

Replacement cost totals for an order, with and without tax.

```ts
interface ReplacementTotals {
  subtotal: number;
  tax: number;
  total: number;
}
```

### `Tax`

Subset of the full Tax document needed by utility functions.

```ts
type Tax = Pick<SchemaTax, "uid" | "name" | "rate" | "type">;
```

### `TransactionFeeLineItem`

A transaction fee line item with a PriceModifier price.

```ts
interface TransactionFeeLineItem {
  type: "transaction_fee";
  quantity: number;
  price: PriceModifierType;
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

### `calculateItemDiscount(item: LineItem): number`

Calculate the discount dollar amount for a single line item.

### `calculateItemPrice(item: LineItem, taxes: Tax[]): typeLiteral`

Calculate the complete price for a single line item.
Runs the full pipeline: subtotal → discount → taxes → total.

### `calculateItemSubtotal(item: LineItem): typeLiteral`

Calculate the pre-discount and post-discount subtotals for a single line item.

### `calculateItemTax(item: LineItem, taxes: Tax[]): PriceModifier[]`

Calculate tax amounts for a single line item from the Tax[] parameter.
Returns a PriceModifier[] with computed amounts.

### `calculateItemTotal(item: LineItem, taxes: Tax[]): number`

Calculate the total (subtotal_discounted + taxes) for a single line item.
Handles both PriceObject (regular items) and PriceModifier (transaction fee items).

### `calculateOrderTotals(items: LineItem[], taxes: Tax[]): OrderTotals`

Calculate aggregated pricing totals for an entire order.
Owns the two-pass computation: pre-tax items first, then transaction fees.

### `calculateReplacementTotals(items: LineItem[], taxes: Tax[]): ReplacementTotals`

Calculate the total replacement cost across all pre-tax items that have
a replacement value on their price object.

Returns `subtotal` (sum of replacement × quantity), `tax` (taxes applied
to that subtotal), and `total` (subtotal + tax).

### `computeItemPaths(items: T[]): T[]`

Compute full structural paths for a flat items array AND linearize it
depth-first with `zero_priced` items sorted before priced ones inside each
parent's direct-children block.

Each item's path = [structural context...] + [component ancestry...] + [self uid].

Client-sent paths carry component ancestry (from ProductComponent.path).
This function prepends structural context (dest/group) and appends self uid.

Three transforms in order:
 1. Recompute every item's `path`. Strip ALL structural uids (every dest +
    group currently in the array) and the item's own uid from the
    client-supplied path; also strip orphan ancestor uids — segments that
    don't resolve to any item in the array (e.g. catalog-only intermediate
    kit uids that were never materialized). Then prepend the structural
    prefix and append the item's own uid.
 2. Linearize line items inside each (destination, group) block as a tree:
    each parent product is followed by its full subtree before the next
    sibling. Destination and group dividers stay where they are; only the
    line items between them are reordered.
 3. Within each parent's direct-children, stable-sort `zero_priced === true`
    before others. Drag-drop reorders preserve intra-band order.

Pure: returns a fresh array of fresh items. Inputs are not mutated, so it is
safe to pass items that originate from a Solid store proxy (the manager app
routes reordered arrays through this function inside `setEntity` updaters).
Callers should replace their working array with the return value.

Post-condition (under the within-parent uniqueness invariant): a parent and
its full subtree occupy a contiguous index range, so `getItemSubtreeRange`
and `getGroupItems` can rely on path-prefix matching alone.

### `consolidateItems(lineItems: LineItem[]): ConsolidatedItem[]`

Deduplicate line items by product UID and sum quantities.

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
renders as "Pickup / Delivery".

Mapping:
  start: customer_collecting === true → "Pickup", else → "Delivery"
  end:   customer_returning  === true → "Return", else → "Pickup"

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

### `getParentProductUid(item: LineItem, structuralUids: Set<string>): string | null`

Get the parent product uid from an item's path.
Returns null for non-components (where path.at(-2) is a structural uid or absent).

### `getRemovalIndices(items: LineItem[], index: number): number[]`

Collect the indices of all items that should be removed when the item
at `index` is deleted — the item itself plus all its descendants.
Returns indices sorted ascending.

### `getStructuralUids(items: LineItem[]): Set<string>`

Build a set of structural item uids (dest/group) from items array.
Used to distinguish structural path elements from product parent refs.

### `getTaxTotals(items: LineItem[], taxes: Tax[]): PriceModifier[]`

Aggregate tax PriceModifiers by name across all pre-tax items.

### `getTotalDiscount(items: LineItem[]): number`

Calculate the total discount amount across all pre-tax items.

### `getTransactionFeeTotals(items: LineItem[]): PriceModifier[]`

Aggregate transaction fee PriceModifiers across all fee items.

### `groupByDestination(items: LineItem[], fallbackDeliveryUid: string, fallbackCollectionUid?: string): DestinationGroup[]`

Slice the flat items array into destination sections.

### `isPreTaxItem(item: LineItem): item is PreTaxLineItem`

Determine whether a line item participates in subtotal/discount/tax calculations.
Standalone predicate (not composed) because TS doesn't support negated predicates.

### `isPriceableItem(item: LineItem): item is PriceableLineItem`

Determine whether a line item is priceable (has a price object, not a structural item).

### `isSameAsDeliveryDates(dates: OrderDatesType): boolean`

Whether charge dates match the delivery/collection dates
(i.e. no custom charge period has been set).

### `isSameAsDeliveryDestination(destination: DestinationType): boolean`

Whether a destination's collection endpoint matches its delivery endpoint
(address, contact, and instructions are all equal).

### `isTransactionFeeItem(item: LineItem): item is TransactionFeeLineItem`

Determine whether a line item is a transaction fee.

### `orderHasDiscount(items: LineItem[]): boolean`

Check whether any pre-tax line item has a discount.

### `orderHasRentals(items: LineItem[]): boolean`

Check whether any line item is a rental.

### `orderHasTax(items: LineItem[]): boolean`

Check whether any pre-tax line item has taxes applied.

### `syncChargeDaysToItems(items: LineItem[], previousDefault: number | null, newDefault: number | null): void`

Update chargeable_days on line items that still match the previous default.
Skips structural items, items without a price, and manual overrides.

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

## `@cfs/utilities/products`

Shared product utility functions for CFS applications.

```ts
import { buildComponentEntries } from "@cfs/utilities/products";

// When adding component B to product A, copy B's nested components
// into A's components array with adjusted paths:
const nested = buildComponentEntries("A", productB.components, 1);
```

### `buildComponentEntries(parentUid: string, sourceComponents: ProductComponent[], baseDepth: number, maxDepth?: number): ProductComponent[]`

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

### `removeComponentEntries(components: ProductComponent[], path: string[]): ProductComponent[]`

Remove a component and all its descendants from a flat components array.
An entry is removed if its `path` starts with the given path prefix —
this covers the component itself and every entry nested beneath it.

**Parameters**

- `components` — The product's current `components` array
- `path` — Full path of the component to remove (e.g. `["A", "B"]`)

**Returns** — New array with the component and its descendants removed

## `@cfs/utilities/templates`

Template helpers for the git-canonical template system — pure functions
shared by api-cloudrun and manager.

- `slugify` derives a `git_path` from a family display name (frozen at create).
- `deriveBump` maps a conventional-commit type → semver bump level, and
  `bumpSemver` applies that bump to the family's previous version.
- `resolveRenderParams` validates caller-provided render params against the
  version's declared params **strictly** — unknown params throw (the API
  maps `RenderParamError` → HTTP 422).

No runtime dependency on `@cfs/schemas`: the declared-param shape is accepted
structurally so this module type-checks independent of the schemas publish
cadence. `@cfs/schemas`' `TemplateParam` is structurally compatible.

### `BumpLevel`

A semantic-version bump level.

```ts
type BumpLevel = "major" | "minor" | "patch";
```

### `RenderParamDecl`

A render-time parameter declaration (structurally `@cfs/schemas`' `TemplateParam`).

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

### `resolveRenderParams(declared: typeOperator, provided: Record<string, unknown> | undefined): Record<string, boolean>`

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
