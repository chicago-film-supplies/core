/**
 * @cfs/core/schemas
 *
 * Zod schemas for CFS Firestore collections.
 * Each schema exports: Zod schema, interface type, and input schemas.
 */
export {
  ContactSchema,
  ContactOrganization,
  CreateContactInput,
  UpdateContactInput,
  type Contact,
  type ContactOrganizationType,
  type CreateContactInputType,
  type UpdateContactInputType,
} from "./contact.ts";

export {
  OrganizationSchema,
  OrganizationContact,
  CreateOrganizationInput,
  UpdateOrganizationInput,
  NewContactInput,
  type Organization,
  type OrganizationContactType,
  type CreateOrganizationInputType,
  type UpdateOrganizationInputType,
  type NewContactInputType,
} from "./organization.ts";

export {
  UserSchema,
  CreateUserInput,
  UpdateUserInput,
  // Exported so a consumer can DERIVE prefs fixtures from the schema rather
  // than hand-writing them (api-cloudrun#472). Hand-written prefs scaffolding
  // drifts on every schema change, and both objects are `z.strictObject`, so
  // the drift surfaces as an unrelated test failure rather than as a message
  // about prefs.
  FirestoreDisplayPrefsSchema,
  TypesenseDisplayPrefsSchema,
  type User,
  type DisplaySort,
  type FirestoreDisplayPrefs,
  type TypesenseDisplayPrefs,
  type CreateUserInputType,
  type UpdateUserInputType,
} from "./user.ts";

export {
  InviteSchema,
  CreateInviteInput,
  AcceptInviteInput,
  type Invite,
  type CreateInviteInputType,
  type AcceptInviteInputType,
} from "./invite.ts";

export {
  typesenseDisplayDefaults,
  getTypesenseDisplayDefaults,
  type FirestoreDisplayDefaults,
} from "./display-defaults.ts";

export type { GroupByAxis } from "./typesense/types.ts";

export { getInitialValues } from "./initial.ts";

export {
  unwrapZod,
  unwrapNonArray,
  resolveZodField,
  getNodeMeta,
  resolveFieldMeta,
  isDateField,
  isDateLikeNode,
  isIntegerSafeLeaf,
  enumValues,
  getServerSortableColumns,
  collectLeafPaths,
  collectDisplayColumns,
} from "./zod-walk.ts";

export type {
  CollectDisplayColumnsResult,
  CollectLeafPathsResult,
  DisplayColumn,
  LeafPath,
} from "./zod-walk.ts";

export {
  SessionSchema,
  type Session,
} from "./session.ts";

export {
  EmailVerificationSchema,
  type EmailVerification,
} from "./email-verification.ts";

export {
  PasswordResetSchema,
  type PasswordReset,
} from "./password-reset.ts";

export {
  RateLimitSchema,
  type RateLimit,
} from "./rate-limit.ts";

export {
  XeroBudgetSchema,
  type XeroBudget,
  type XeroResetsAtSource,
  type XeroThrottleResetsAtSource,
} from "./xero-budget.ts";

export {
  XeroSyncStateSchema,
  type XeroSyncState,
} from "./xero-sync-state.ts";

export {
  OrderSchema,
  CreateOrderInput,
  UpdateOrderInput,
  OrderDates,
  Destination,
  DestinationEndpoint,
  DestinationContact,
  DocDestination,
  DocDestinationEndpoint,
  DocDestinationContact,
  OrderItem,
  OrderItemLine,
  OrderItemDestination,
  OrderItemGroup,
  OrderDocDestinationItem,
  OrderDocGroupItem,
  OrderDocLineItem,
  OrderDocItemPrice,
  ItemPrice,
  PriceModifier,
  TaxRef,
  Discount,
  DiscountInput,
  type Order,
  type CreateOrderInputType,
  type UpdateOrderInputType,
  type OrderDatesType,
  type DestinationType,
  type DestinationEndpointType,
  type DestinationContactType,
  type DocDestinationType,
  type DocDestinationEndpointType,
  type DocDestinationContactType,
  type OrderItemType,
  type OrderItemLineType,
  type OrderItemDestinationType,
  type OrderItemGroupType,
  type ItemPriceType,
  type PriceModifierType,
  type TaxRefType,
  type DiscountType,
  type DiscountInputType,
  type OrderDocTotalsType,
  OrderDocDates,
  OrderDocItem,
  type OrderDocDatesType,
  type OrderDocItemType,
  type OrderDocItemPriceType,
  type OrderDocLineItemType,
  type OrderDocGroupItemType,
  type OrderDocDestinationItemType,
  isLineItem,
  isFulfillableItem,
  type ConsolidatedItemType,
  type GroupPathType,
  ORDER_STATUSES,
  type OrderStatusType,
  ORDER_USER_STATUSES,
  type OrderUserStatusType,
  ORDER_COMPUTED_STATUSES,
  type OrderComputedStatusType,
  getOrderStatusTransitions,
  isValidOrderStatusTransition,
} from "./order.ts";

export {
  FulfillmentSchema,
  FulfillmentItem,
  FulfillmentLineItem,
  FulfillmentDestinationItem,
  FulfillmentGroupItem,
  type Fulfillment,
  type FulfillmentItemType,
  type FulfillmentLineItemType,
  type FulfillmentDestinationItemType,
  type FulfillmentGroupItemType,
} from "./fulfillment.ts";

export {
  LoginInput,
  RegisterInput,
  ResetPasswordInput,
  EmailInput,
  type LoginInputType,
  type RegisterInputType,
  type ResetPasswordInputType,
  type EmailInputType,
} from "./auth.ts";

export {
  Address,
  Coordinates,
  DocSource,
  Email,
  Phone,
  FirestoreTimestamp,
  TimestampFields,
  UidNameRef,
  ActorRef,
  NamePartsFields,
  NamePartsFieldsPartial,
  NameField,
  deriveName,
  ProductTypeEnum,
  StockMethodEnum,
  JURISDICTIONS,
  JurisdictionEnum,
  PRE_TAX_ITEM_TYPES,
  PreTaxItemTypeEnum,
  TaxedAsEnum,
  DocumentOrganizationSnapshot,
  toRegionCode,
  toUsStateCode,
  isIllinoisPostcode,
  usState,
  PriceFormulaEnum,
  InclusionTypeEnum,
  ComponentTypeEnum,
  COARevenueEnum,
  InvoiceStatusEnum,
  OOSReasonEnum,
  RateTypeEnum,
  RATE_UNIT_META,
  DocItemTypeEnum,
  DocLineItemTypeEnum,
  DOC_LINE_ITEM_TYPES,
  ItemTypeEnum,
  ITEM_CONTRACTS,
  itemContract,
  checkItemContract,
  checkItemPriceFormula,
  isLineItemType,
  isDividerItemType,
  isFulfillableItemType,
  FULFILLMENT_LINE_ITEM_TYPES,
  CfsSourceCollectionEnum,
  CFS_SOURCE_COLLECTIONS,
  SettlementTypeEnum,
  SettlementReasonEnum,
  SETTLEMENT_CONTRACTS,
  settlementContract,
  getSettlementMultiplier,
  type AddressType,
  type DocumentOrganizationSnapshotType,
  type CfsSourceCollectionType,
  type CoordinatesType,
  type DocSourceType,
  type FirestoreTimestampType,
  type FirestoreTimestampValue,
  type FirestoreFieldValue,
  type UidNameRefType,
  type ActorRefType,
  type NameParts,
  type PartialNameParts,
  type ProductTypeType,
  type StockMethodType,
  type JurisdictionType,
  type TaxedAsType,
  type PriceFormulaType,
  type InclusionTypeType,
  type ComponentTypeType,
  type COARevenueType,
  type OOSReasonType,
  type RateType,
  type DocItemTypeType,
  type DocLineItemTypeType,
  type ItemTypeType,
  type ItemContract,
  type FulfillableItemType,
  type PreTaxItemType,
  type FromTotalItemType,
  type DividerItemType,
  type SettlementTypeType,
  type SettlementReasonType,
  type SettlementContract,
  StoreBreakdownEntrySchema,
  StoreBreakdownLocationSchema,
  type StoreBreakdownEntry,
  type StoreBreakdownLocation,
  // Identifier validators (defined in _uid.ts, re-exported via common.ts)
  FIRESTORE_TIMESTAMP_META,
  FirestoreId,
  ItemUid,
  BookingId,
  AnyUid,
  CardId,
  EventCardId,
  ListId,
  // No consumer imports this today — exported anyway so the set of identifier
  // validators has NO exceptions, which is what lets the barrel-reachability
  // guard in `tests/_uid.test.ts` be a plain "every one" rather than a list with
  // an allowlist beside it. An allowlist is the thing that rots.
  MovementId,
  QuoteId,
  RoleId,
  SEEDED_ROLE_NAMES,
  type SeededRoleName,
  ThreadId,
} from "./common.ts";

export {
  // Generic envelope (OpenAPI-only)
  LogRecordSchema,
  type LogRecord,
  // Shared envelope primitives
  LogLevelEnum,
  type BaseLogFields,
  type LogLevelType,
  type PiiClassification,
  // Typed archetype arms (Phase 0: ~10; more added by big-bang migration)
  PropagationLogRecordSchema,
  TransactionLogRecordSchema,
  ClientLogEntrySchema,
  ClientLogBatchSchema,
  RequestLogRecordSchema,
  DmarcAggregateLogRecordSchema,
  SyncErrorLogRecordSchema,
  ValidationErrorLogRecordSchema,
  EmailSendFailedLogRecordSchema,
  EmailSentLogRecordSchema,
  OAuthRefreshLogRecordSchema,
  type PropagationLogRecord,
  type PropagationModeType,
  type PropagationStatusType,
  type TransactionLogRecord,
  type TransactionStatusType,
  type ClientLogEntry,
  type ClientLogBatch,
  type ClientAppType,
  type RequestLogRecord,
  type DmarcAggregateLogRecord,
  type SyncErrorLogRecord,
  type ValidationErrorLogRecord,
  type ValidationIssue,
  type EmailSendFailedLogRecord,
  type EmailSentLogRecord,
  type OAuthRefreshLogRecord,
  // Discriminated union + msg→schema registry — primary surface for the
  // typed `logTyped` API in api-cloudrun.
  type TypedLogRecord,
  MSG_SCHEMA_REGISTRY,
  // `typesense_sync_state`'s outcome. Exported so the emitter can ANNOTATE its
  // variable rather than pass a bare string into a passthrough record — that is
  // what makes a typo a compile error at the assignment instead of a row the
  // alert silently never matches.
  type TypesenseSyncOutcome,
} from "./log/mod.ts";

export {
  StoreSchema,
  CreateStoreInput,
  UpdateStoreInput,
  type Store,
  type CreateStoreInputType,
  type UpdateStoreInputType,
} from "./store.ts";

export {
  TagSchema,
  CreateTagInput,
  UpdateTagInput,
  DeleteTagInput,
  type Tag,
  type CreateTagInputType,
  type UpdateTagInputType,
  type DeleteTagInputType,
} from "./tag.ts";

export {
  RoleSchema,
  type Role,
  RoleSummarySchema,
  type RoleSummary,
} from "./role.ts";

export {
  ThreadSchema,
  UpdateThreadInput,
  type Thread,
  type UpdateThreadInputType,
} from "./thread.ts";

export {
  CommentSchema,
  CommentBody,
  CreateCommentInput,
  UpdateCommentInput,
  CommentReactionInput,
  type Comment,
  type CommentBodyJson,
  type CreateCommentInputType,
  type UpdateCommentInputType,
  type CommentReactionInputType,
  type ReactionActionType,
} from "./comment.ts";

export {
  ListSchema,
  ListLockKeyEnum,
  CreateListInput,
  UpdateListInput,
  type List,
  type ListLockKey,
  type CreateListInputType,
  type UpdateListInputType,
} from "./list.ts";

export {
  CardActionSchema,
  CardSchema,
  CardAttachment,
  CardAttachmentTypeEnumSchema,
  CardDates,
  CardFulfillmentActionEnum,
  CardLockKeyEnum,
  CardOrganization,
  CardStatusEnum,
  CreateCardInput,
  UpdateCardInput,
  type Card,
  type CardAction,
  type CardAttachmentType,
  type CardAttachmentTypeEnum,
  type CardDatesType,
  type CardFulfillmentAction,
  type CardLockKey,
  type CardOrganizationType,
  type CardStatus,
  type CreateCardInputType,
  type UpdateCardInputType,
} from "./card.ts";

export {
  RecurrenceSchema,
  RecurrencePrototype,
  RecurrenceRule,
  RecurrenceFreqEnum,
  RecurrenceStatusEnum,
  RecurrenceWeekdayEnum,
  CreateRecurrenceInput,
  UpdateRecurrenceInput,
  type Recurrence,
  type RecurrencePrototypeType,
  type RecurrenceRuleType,
  type RecurrenceFreq,
  type RecurrenceStatus,
  type RecurrenceWeekday,
  type CreateRecurrenceInputType,
  type UpdateRecurrenceInputType,
} from "./recurrence.ts";

export {
  PERMISSIONS,
  type Permission,
  type RouteMethod,
  type RouteManifest,
  type RouteManifestEntry,
} from "./permissions.ts";

export {
  HolidayDatesSchema,
  type HolidayDates,
} from "./holiday-dates.ts";

export {
  HolidayDefinitionSchema,
  CreateHolidayDefinitionInput,
  UpdateHolidayDefinitionInput,
  type HolidayDefinition,
  type HolidayType,
  type HolidayWeekInputType,
  type CreateHolidayDefinitionInputType,
  type CreateFixedHolidayInputType,
  type CreateVariableHolidayInputType,
  type UpdateHolidayDefinitionInputType,
  type UpdateFixedHolidayInputType,
  type UpdateVariableHolidayInputType,
} from "./holiday-definition.ts";

export {
  HolidaySnapshotSchema,
  type HolidaySnapshot,
  type HolidaySnapshotYearRange,
} from "./holiday-snapshot.ts";

export {
  CacheGeocodesSchema,
  type CacheGeocodes,
  type CacheGeocodesAddress,
} from "./cache-geocodes.ts";

export {
  DestinationSchema,
  DestinationContactRef,
  type Destination as DestinationDoc,
  type DestinationContactRefType,
} from "./destination.ts";

export {
  LocationTypeSchema,
  CreateLocationTypeInput,
  UpdateLocationTypeInput,
  type LocationType,
  type LocationTypeProductCapacity,
  type LocationTypeDimensions,
  type CreateLocationTypeInputType,
  type UpdateLocationTypeInputType,
} from "./location-type.ts";

export {
  LocationSchema,
  CreateLocationInput,
  UpdateLocationInput,
  type Location,
  type LocationProductCapacity,
  type LocationProduct,
  type CreateLocationInputType,
  type UpdateLocationInputType,
} from "./location.ts";

export {
  ChartOfAccountsSchema,
  COAClass,
  COACode,
  COAStatus,
  COAType,
  type ChartOfAccounts,
  type COAClassType,
  type COACodeType,
  type COAStatusType,
  type COATypeType,
} from "./chart-of-accounts.ts";

export {
  TrackingCategorySchema,
  CreateTrackingCategoryInput,
  UpdateTrackingCategoryInput,
  type TrackingCategory,
  type CreateTrackingCategoryInputType,
  type UpdateTrackingCategoryInputType,
} from "./tracking-category.ts";

export {
  ProductSchema,
  CreateProductInput,
  UpdateProductInput,
  type Product,
  type CreateProductInputType,
  type UpdateProductInputType,
  type ProductAlternate,
  AuthoredComponentSchema,
  type AuthoredProductComponent,
  ComponentSchema,
  type ProductComponent,
  type ProductPrice,
  type ProductShipping,
  type ProductWebshop,
  type ProductImage,
  deriveProductImageUuids,
} from "./product.ts";

export {
  WebshopProductSchema,
  type WebshopProduct,
  type WebshopProductComponent,
  type WebshopProductShipping,
} from "./webshop-product.ts";

export {
  BookingSchema,
  BOOKING_STATUSES,
  type BookingStatusType,
  BookingBreakdownSchema,
  BOOKING_BREAKDOWN_KEYS,
  BOOKING_BREAKDOWN_TERMINAL_KEYS,
  BookingBreakdownKeyEnum,
  type BookingBreakdownKeyType,
  type Booking,
  type BookingBreakdown,
  type BookingDestinationRef,
  type BookingStore,
  type BookingStoreLocation,
  UpdateBookingInput,
  type UpdateBookingInputType,
  BookingUpdate,
  type BookingUpdateType,
  BulkBookingUpdateInput,
  type BulkBookingUpdateInputType,
  BulkBookingUpdateResponse,
  type BulkBookingUpdateResponseType,
  UpdateBookingResponse,
  type UpdateBookingResponseType,
} from "./booking.ts";

export {
  ACCEPTS_PAYMENT_STATUSES,
  canOperatorTransition,
  CreateInvoiceInput,
  INVOICE_STATUS_CONTRACTS,
  type InvoiceStatusContract,
  InvoiceDocDestination,
  InvoiceDocItem,
  InvoiceDocLineItemSchema,
  InvoiceDocOrderItem,
  LIVE_IN_XERO_STATUSES,
  REACHED_XERO_STATUSES,
  SETTLED_STATUSES,
  InvoiceItemInputLine,
  InvoiceItemInputDestination,
  InvoiceItemInputGroup,
  InvoiceItemInputOrder,
  InvoiceSchema,
  isInvoiceLineItem,
  UpdateInvoiceInput,
  type CreateInvoiceInputType,
  type Invoice,
  type InvoiceDocDestinationType,
  type InvoiceDocItemPrice,
  type InvoiceDocItemType,
  type InvoiceDocLineItem,
  type InvoiceDocOrderItemType,
  type InvoiceDocTotals,
  type InvoiceItemInputType,
  type InvoiceItemInputLineType,
  type InvoiceItemInputDestinationType,
  type InvoiceItemInputGroupType,
  type InvoiceItemInputOrderType,
  type InvoiceStatusType,
  type UpdateInvoiceInputType,
} from "./invoice.ts";

export {
  TaxSchema,
  CreateTaxInput,
  UpdateTaxInput,
  SupersedeTaxInput,
  XeroTaxComponent,
  type Tax,
  type CreateTaxInputType,
  type UpdateTaxInputType,
  type SupersedeTaxInputType,
  type XeroTaxComponentType,
} from "./tax.ts";

export {
  InventoryLedgerSchema,
  type InventoryLedger,
} from "./inventory-ledger.ts";

export {
  MovementSchema,
  MOVEMENT_TYPES,
  MovementTypeEnum,
  MOVEMENT_CONTRACTS,
  CUSTODY_PLACE_KINDS,
  PLACE_KINDS,
  MovementLine,
  MovementCustody,
  MovementCost,
  MovementAllocationInput,
  getTransactionMultiplier,
  hasCosts,
  getDisplayTransactionTypes,
  CreateTransactionInput,
  UpdateTransactionInput,
  ReverseTransactionInput,
  CreateStoreTransferInput,
  type Movement,
  type MovementTypeType,
  type MovementContract,
  type MovementLineType,
  type MovementCustodyType,
  type MovementCostType,
  type MovementAllocationInputType,
  type PlaceKindType,
  type CreateTransactionInputType,
  type UpdateTransactionInputType,
  type ReverseTransactionInputType,
  type CreateStoreTransferInputType,
} from "./transaction.ts";

export {
  OutOfServiceSchema,
  type OutOfService,
  OOSStatusEnum,
  type OOSStatusType,
  OOSBreakdownSchema,
  type OOSBreakdown,
  OOSTransactionTypeEnum,
  type OOSTransactionTypeType,
  type OOSStore,
  type OOSStoreLocation,
  type OOSTransaction,
  type OOSDates,
  CreateOutOfServiceInput,
  type CreateOutOfServiceInputType,
  UpdateOutOfServiceInput,
  type UpdateOutOfServiceInputType,
} from "./out-of-service.ts";
export {
  type Settlement,
  SettlementSchema,
} from "./settlement.ts";
export {
  CREDIT_NOTE_REASONS,
  COA_BAD_DEBT,
  deriveCreditPostingAccount,
  type CreditNote,
  type CreditNoteDocItemPrice,
  CreditNoteDocLineItem,
  type CreditNoteDocLineItem as CreditNoteDocLineItemType,
  CreditNoteSchema,
  CreditNoteStatusEnum,
  type CreditNoteStatusType,
  type CreditNoteDocTotals,
} from "./credit-note.ts";

export {
  STOCK_UNAVAILABLE_KINDS,
  type Stock,
  StockLockSchema,
  type StockLock,
  StockSchema,
  StockUnavailableKindEnum,
  type StockUnavailableEntry,
  type StockUnavailableKindType,
} from "./stock.ts";

export {
  TypesenseConfigSchema,
  type TypesenseConfig,
  type TypesenseConfigReindexStats,
} from "./typesense-config.ts";

export {
  UploadcareSweepRunSchema,
  type UploadcareSweepRun,
} from "./uploadcare-sweep.ts";

export {
  UploadcareOwnerCollectionEnum,
  type UploadcareOwnerCollectionType,
  UploadcareUploadKindEnum,
  type UploadcareUploadKindType,
  type UploadcareWorkListEntry,
  UploadcareWorkListEntrySchema,
} from "./uploadcare-worklist.ts";

export {
  WebhookEventSchema,
  type WebhookEvent,
} from "./webhook-event.ts";

export {
  CounterSchema,
  type Counter,
} from "./counter.ts";

export {
  OrderDocumentSchema,
  type OrderDocument,
} from "./order-document.ts";

export {
  PreviewRecordSchema,
  type PreviewRecord,
} from "./template-preview.ts";

export {
  McpOAuthClientSchema,
  McpOAuthAuthorizeRequestSchema,
  McpOAuthCodeSchema,
  McpOAuthTokenSchema,
  type McpOAuthClient,
  type McpOAuthAuthorizeRequest,
  type McpOAuthCode,
  type McpOAuthToken,
} from "./mcp-oauth.ts";

export {
  QuoteSchema,
  SaveQuoteVersionInput,
  RestoreQuoteInput,
  type Quote,
  type SaveQuoteVersionInputType,
  type RestoreQuoteInputType,
} from "./quote.ts";

export {
  TEMPLATE_SOURCE_COLLECTIONS,
  TEMPLATE_TARGET_COLLECTIONS,
  TEMPLATE_SURFACES,
  TemplateSchema,
  TemplateInputSchema,
  FixtureMetaSchema,
  type Template,
  type TemplateInputType,
  type TemplateContext,
  type TemplateDependsOn,
  type FixtureMeta,
  type TemplateSourceCollectionType,
  type TemplateTargetCollectionType,
  type TemplateSurfaceType,
} from "./template.ts";

export {
  TEMPLATE_VERSION_STATUSES,
  TEMPLATE_PARAM_TYPES,
  GOLDEN_DIFF_VERDICTS,
  TemplateVersionSchema,
  TemplateParamSchema,
  CommitMetaSchema,
  BlobRefSchema,
  GoldenDiffSchema,
  UpdateTemplateVersionInput,
  type TemplateVersion,
  type TemplateVersionStatusType,
  type TemplateParam,
  type TemplateParamType,
  type CommitMeta,
  type BlobRef,
  type GoldenDiff,
  type GoldenDiffVerdict,
  type UpdateTemplateVersionInputType,
} from "./template-version.ts";

export {
  TemplateComponentSchema,
  TemplateComponentInputSchema,
  type TemplateComponent,
  type TemplateComponentInputType,
} from "./template-component.ts";

// ── Propagation ─────────────────────────────────────────────────────

export type {
  AggregateDefinition,
  CollectionRule,
  FieldMapping,
  FieldPath,
  PropagationMode,
  PropagationModule,
  RuleId,
  TransactionDefinition,
  TransactionId,
} from "./propagation/mod.ts";

// 🔴 **The three VALUES are deliberately NOT re-exported here — import them from
// `@cfs/core/schemas/propagation` instead** (Tier 1 item 4).
//
// This barrel used to carry `export { aggregates, rules, transactions }`, and
// **176 manager files import the bare `@cfs/core/schemas` barrel**. That pulled
// 161 rule objects — whose `invariant` fields are paragraphs of prose — into a
// browser bundle that reads **none** of them. The JSR npm shim does not declare
// `sideEffects: false`, so Rollup cannot reliably drop it. Measured before
// removing: zero propagation value imports in manager, zero in templates, nine
// in api-cloudrun — so the entire cost was carried for one consumer that never
// asked for it.
//
// ⚠️ **The TYPES above stay, and that is not an inconsistency.** `export type`
// is erased at build, so it costs a bundle nothing; the values are the whole
// weight. Moving the types too would break consumers for no gain.
//
// Do not re-add the values here, and do not re-add named rule/transaction
// symbols either — this block used to re-export 81 of them while
// `propagation/mod.ts` exported 141, so 60 had silently drifted out with nothing
// noticing. One module object per file is the convention now (see
// `propagation/types.ts`), and a hand-maintained list is the defect it removes.

// ── Domain events ───────────────────────────────────────────────────

export type {
  EventEnvelope,
  // Order aggregate
  OrderCreated,
  OrderUpdated,
  OrderStatusChanged,
  OrderCanceled,
  BookingCreated,
  BookingUpdated,
  BookingStatusChanged,
  StockRecalculated,
  QuoteCreated,
  QuoteRestored,
  QuoteDeleted,
  // Product aggregate
  ProductCreated,
  ProductUpdated,
  WebshopProductUpdated,
  InventoryLedgerRecalculated,
  // Invoice aggregate
  InvoiceCreated,
  InvoiceIssued,
  InvoiceUpdated,
  InvoiceVoided,
  // Organization aggregate
  OrganizationCreated,
  OrganizationUpdated,
  // Contact aggregate
  ContactCreated,
  ContactUpdated,
  // Store aggregate
  StoreCreated,
  StoreUpdated,
  LocationCreated,
  LocationUpdated,
  LocationTypeCreated,
  LocationTypeUpdated,
  // Transaction aggregate
  TransactionCreated,
  TransactionUpdated,
  OutOfServiceCreated,
  OutOfServiceUpdated,
  // Threads aggregate
  ThreadCreated,
  ThreadUpdated,
  CommentCreated,
  CommentUpdated,
  CommentDeleted,
  // Cards aggregate
  CardCreated,
  CardUpdated,
  CardDeleted,
  ListCreated,
  ListUpdated,
  ListDeleted,
  // Recurrences aggregate
  RecurrenceCreated,
  RecurrenceUpdated,
  RecurrenceDeleted,
  HorizonMaterialized,
  HorizonMaterializedData,
  // Reference data
  TagCreated,
  TagUpdated,
  TagDeleted,
  TrackingCategoryCreated,
  TrackingCategoryUpdated,
  TemplateCreated,
  TemplateUpdated,
  HolidayDatesAdded,
  HolidayDatesDeleted,
  ChartOfAccountsUpdated,
} from "./events/mod.ts";

// ── Union of all Firestore document types ───────────────────────────

import type { Card } from "./card.ts";
import type { Comment } from "./comment.ts";
import type { Counter } from "./counter.ts";
import type { Booking } from "./booking.ts";
import type { List } from "./list.ts";
import type { Recurrence } from "./recurrence.ts";
import type { CacheGeocodes } from "./cache-geocodes.ts";
import type { ChartOfAccounts } from "./chart-of-accounts.ts";
import type { Contact } from "./contact.ts";
import type { EmailVerification } from "./email-verification.ts";
import type { Fulfillment } from "./fulfillment.ts";
import type { HolidayDates } from "./holiday-dates.ts";
import type { HolidayDefinition } from "./holiday-definition.ts";
import type { HolidaySnapshot } from "./holiday-snapshot.ts";
import type { InventoryLedger } from "./inventory-ledger.ts";
import type { Invite } from "./invite.ts";
import type { Invoice } from "./invoice.ts";
import type { Location } from "./location.ts";
import type { LocationType } from "./location-type.ts";
import type { Order } from "./order.ts";
import type { Organization } from "./organization.ts";
import type { OutOfService } from "./out-of-service.ts";
import type { Settlement } from "./settlement.ts";
import type { CreditNote } from "./credit-note.ts";
import type { PasswordReset } from "./password-reset.ts";
import type { Product } from "./product.ts";
import type { Quote } from "./quote.ts";
import type { Template } from "./template.ts";
import type { TemplateComponent } from "./template-component.ts";
import type { TemplateVersion } from "./template-version.ts";
import type { RateLimit } from "./rate-limit.ts";
import type { Session } from "./session.ts";
import type { Stock, StockLock } from "./stock.ts";
import type { Store } from "./store.ts";
import type { Role } from "./role.ts";
import type { Thread } from "./thread.ts";
import type { Tag } from "./tag.ts";
import type { Tax } from "./tax.ts";
import type { TrackingCategory } from "./tracking-category.ts";
import type { Movement } from "./transaction.ts";
import type { TypesenseConfig } from "./typesense-config.ts";
import type { UploadcareSweepRun } from "./uploadcare-sweep.ts";
import type { UploadcareWorkListEntry } from "./uploadcare-worklist.ts";
import type { User } from "./user.ts";
import type { Destination } from "./destination.ts";
import type { WebhookEvent } from "./webhook-event.ts";
import type { WebshopProduct } from "./webshop-product.ts";
import type { XeroBudget } from "./xero-budget.ts";
import type { XeroSyncState } from "./xero-sync-state.ts";
import type { OrderDocument } from "./order-document.ts";
import type { PreviewRecord } from "./template-preview.ts";
import type {
  McpOAuthAuthorizeRequest,
  McpOAuthClient,
  McpOAuthCode,
  McpOAuthToken,
} from "./mcp-oauth.ts";

/**
 * Union of all Firestore document types. Use with validateBeforeWrite.
 *
 * **`TemplateVersion` and `TemplateComponent` were the only two schema-backed
 * document types missing from this union**, and their absence was the whole
 * reason for 43 `as unknown as SchemaDocType` casts in `api-cloudrun`. The
 * proof it was the union and not the pattern: `Template` IS a member and writes
 * uncast, while its sibling `TemplateComponent` was not and writes cast — same
 * three-collection family, different treatment, no stated reason.
 *
 * Widening is safe by construction rather than by review: there is no
 * discriminant to switch on (these types share no common `type` tag, so a
 * discriminated union over `SchemaDocType` is not expressible), and a
 * workspace-wide grep finds no `Extract<SchemaDocType…>`, no
 * `keyof SchemaDocType` and no exhaustive switch. Every one of the 126
 * references lives in `api-cloudrun`; `manager` and `templates` have none.
 *
 * The one thing it gives up is real and was never a guarantee: `tx.set(ref,
 * templateVersionDoc)` used to be a compile error absent a cast. That caught
 * nothing 51 of 53 doc types were not already free to do, and the runtime guard
 * in `validateBeforeWrite` still rejects every doc/collection mismatch with a
 * `collection/id` label.
 *
 * ⭐ **DERIVED from {@link CollectionDocs}, not written out** (core#44 work item
 * A, landed with Wave 6). It was a hand-maintained 56-member union sitting a few
 * hundred lines above the registry that already knew all of them, so a new
 * collection needed an edit in two places and only ONE of them failed to compile
 * if you forgot.
 *
 * **Measured a no-op before the swap**, non-distributively — `[A] extends [B]`
 * in both directions, with planted negatives to prove the check could still
 * return false. ⚠️ The naive `A extends B ? true : never` does NOT work here: it
 * distributes over the union, so the result is `true | never` and `true` stays
 * assignable to it whatever the members are. That check cannot fail, which is
 * the same shape as the fixed-point guards this package keeps finding.
 */
export type SchemaDocType = CollectionDocs[CollectionName];

// ── Schema record keyed by collection name ─────────────────────────

import { z } from "zod";

import { BookingSchema } from "./booking.ts";
import { CardSchema } from "./card.ts";
import { CommentSchema } from "./comment.ts";
import { ListSchema } from "./list.ts";
import { CounterSchema as CounterSchema_ } from "./counter.ts";
import { CacheGeocodesSchema } from "./cache-geocodes.ts";
import { ChartOfAccountsSchema } from "./chart-of-accounts.ts";
import { ContactSchema } from "./contact.ts";
import { DestinationSchema } from "./destination.ts";
import { EmailVerificationSchema } from "./email-verification.ts";
import { FulfillmentSchema } from "./fulfillment.ts";
import { HolidayDatesSchema } from "./holiday-dates.ts";
import { HolidayDefinitionSchema } from "./holiday-definition.ts";
import { HolidaySnapshotSchema } from "./holiday-snapshot.ts";
import { InventoryLedgerSchema } from "./inventory-ledger.ts";
import { InviteSchema } from "./invite.ts";
import { InvoiceSchema } from "./invoice.ts";
import { LocationSchema } from "./location.ts";
import { LocationTypeSchema } from "./location-type.ts";
import { OrderSchema } from "./order.ts";
import { OrganizationSchema } from "./organization.ts";
import { OutOfServiceSchema } from "./out-of-service.ts";
import { SettlementSchema } from "./settlement.ts";
import { CreditNoteSchema } from "./credit-note.ts";
import { PasswordResetSchema } from "./password-reset.ts";
import { ProductSchema } from "./product.ts";
import { QuoteSchema as QuoteSchema_ } from "./quote.ts";
import { TemplateSchema as TemplateSchema_ } from "./template.ts";
import { TemplateVersionSchema as TemplateVersionSchema_ } from "./template-version.ts";
import { TemplateComponentSchema as TemplateComponentSchema_ } from "./template-component.ts";
import { RateLimitSchema } from "./rate-limit.ts";
import { RecurrenceSchema } from "./recurrence.ts";
import { RoleSchema } from "./role.ts";
import { SessionSchema } from "./session.ts";
import { StockLockSchema, StockSchema } from "./stock.ts";
import { StoreSchema } from "./store.ts";
import { TagSchema } from "./tag.ts";
import { TaxSchema as TaxSchema_ } from "./tax.ts";
import { ThreadSchema } from "./thread.ts";
import { TrackingCategorySchema } from "./tracking-category.ts";
import { MovementSchema } from "./transaction.ts";
import { UserSchema } from "./user.ts";
import { TypesenseConfigSchema } from "./typesense-config.ts";
import { UploadcareSweepRunSchema } from "./uploadcare-sweep.ts";
import { UploadcareWorkListEntrySchema } from "./uploadcare-worklist.ts";
import { WebhookEventSchema as WebhookEventSchema_ } from "./webhook-event.ts";
import { WebshopProductSchema } from "./webshop-product.ts";
import { XeroBudgetSchema as XeroBudgetSchema_ } from "./xero-budget.ts";
import { XeroSyncStateSchema as XeroSyncStateSchema_ } from "./xero-sync-state.ts";
import { OrderDocumentSchema as OrderDocumentSchema_ } from "./order-document.ts";
import { PreviewRecordSchema as PreviewRecordSchema_ } from "./template-preview.ts";
import {
  McpOAuthAuthorizeRequestSchema as McpOAuthAuthorizeRequestSchema_,
  McpOAuthClientSchema as McpOAuthClientSchema_,
  McpOAuthCodeSchema as McpOAuthCodeSchema_,
  McpOAuthTokenSchema as McpOAuthTokenSchema_,
} from "./mcp-oauth.ts";

/**
 * The ONE place a collection name is bound to its document type.
 *
 * `schemas` below is annotated by a mapped type over this interface, so the two
 * cannot drift: a key here with no entry there is an error at the object
 * literal, and an entry there with no key here is an excess property. That is
 * the compiler enforcing the parity — not a test that can go stale, and not the
 * "parity assertion between two hand-maintained lists" the workspace rules warn
 * about. It fails at `deno task check`.
 *
 * ⚠️ **Both halves are written out explicitly, and that is deliberate.** JSR's
 * npm declaration emit is SYNTACTIC — it writes declarations without running
 * inference — so a type it has to COMPUTE from an initializer can publish
 * wrongly to npm consumers while Deno consumers, this suite, `deno task check`
 * and `deno publish --dry-run` all agree with the source. That is core#43: nine
 * `as const` members emitted as one, and 57 phantom type errors on manager's
 * next pin bump. An interface and a written mapped-type annotation are text the
 * emitter copies verbatim, so neither needs expanding.
 *
 * ⚠️ Measured 2026-08-14, because the obvious reasoning is wrong: the
 * inference-requiring form (`= {…} satisfies Record<string, z.ZodType>` plus
 * `keyof typeof`) **also passes** `deno publish --dry-run`'s slow-types check.
 * Passing that check is NOT evidence the emit is right. The explicit form is
 * chosen because it needs no expansion at all, which is a reasoned preference
 * rather than a measured one.
 *
 * ⚠️ The line above used to add *"core#44 closed as 'no post-publish declaration
 * gate', so nothing here can see a wrong published declaration."* **That is no
 * longer true**: core#44 reopened on a second divergence and
 * `deno task check:declarations` now runs `isolatedDeclarations` over all of
 * `src/`. It is still not a check of JSR's *emitter* — it is a conservative
 * over-approximation of it — so "passing does not prove the emit is right"
 * survives; what does not survive is "nothing can see it".
 *
 * Singular and plural both appear because the registry has always carried both.
 * ⚠️ The singular half may be vestigial — there are zero literal `schemas["order"]`
 * -style lookups across api-cloudrun, manager and templates, and every call site
 * found passes a plural or the literal `"events"`. Removing them would halve this
 * file's hand-written surface, but it is a breaking change to a published API and
 * wants the dynamic callers' domain established first. Not folded in here.
 */
export interface CollectionDocs {
  booking: Booking;
  bookings: Booking;
  card: Card;
  cards: Card;
  counter: Counter;
  counters: Counter;
  "cache-geocodes": CacheGeocodes;
  "chart-of-accounts": ChartOfAccounts;
  comment: Comment;
  comments: Comment;
  contact: Contact;
  contacts: Contact;
  destination: Destination;
  destinations: Destination;
  "email-verification": EmailVerification;
  "email-verifications": EmailVerification;
  "holiday-dates": HolidayDates;
  dates: HolidayDates;
  "holiday-definition": HolidayDefinition;
  "holiday-definitions": HolidayDefinition;
  "holiday-snapshot": HolidaySnapshot;
  "inventory-ledger": InventoryLedger;
  "inventory-ledgers": InventoryLedger;
  invite: Invite;
  invites: Invite;
  invoice: Invoice;
  invoices: Invoice;
  list: List;
  lists: List;
  location: Location;
  locations: Location;
  "location-type": LocationType;
  "location-types": LocationType;
  order: Order;
  orders: Order;
  fulfillment: Fulfillment;
  fulfillments: Fulfillment;
  organization: Organization;
  organizations: Organization;
  "out-of-service": OutOfService;
  "password-reset": PasswordReset;
  "password-resets": PasswordReset;
  product: Product;
  products: Product;
  quote: Quote;
  quotes: Quote;
  template: Template;
  templates: Template;
  "templates-versions": TemplateVersion;
  "template-components": TemplateComponent;
  "rate-limit": RateLimit;
  "rate-limits": RateLimit;
  recurrence: Recurrence;
  recurrences: Recurrence;
  role: Role;
  roles: Role;
  session: Session;
  sessions: Session;
  "credit-note": CreditNote;
  "credit-notes": CreditNote;
  settlement: Settlement;
  settlements: Settlement;
  stock: Stock;
  "stock-lock": StockLock;
  "stock-locks": StockLock;
  store: Store;
  stores: Store;
  tag: Tag;
  tags: Tag;
  tax: Tax;
  taxes: Tax;
  thread: Thread;
  threads: Thread;
  "tracking-category": TrackingCategory;
  "tracking-categories": TrackingCategory;
  transaction: Movement;
  transactions: Movement;
  user: User;
  users: User;
  "webhook-event": WebhookEvent;
  "webhook-events": WebhookEvent;
  events: WebhookEvent;
  "webshop-product": WebshopProduct;
  "webshop-products": WebshopProduct;
  "typesense-config": TypesenseConfig;
  typesense: TypesenseConfig;
  "uploadcare-sweep": UploadcareSweepRun;
  "uploadcare-worklist": UploadcareWorkListEntry;
  "xero-budget": XeroBudget;
  "xero-sync": XeroSyncState;
  documents: OrderDocument;
  template_previews: PreviewRecord;
  "mcp-oauth-clients": McpOAuthClient;
  "mcp-oauth-authorize-requests": McpOAuthAuthorizeRequest;
  "mcp-oauth-codes": McpOAuthCode;
  "mcp-oauth-tokens": McpOAuthToken;
}

/** Every collection name the registry answers for. */
export type CollectionName = keyof CollectionDocs;

/**
 * The stored document type for a collection.
 *
 * Reads {@link CollectionDocs} directly rather than going through
 * `z.infer<typeof schemas[C]>` — one less thing for the declaration emit to
 * expand, on the one surface this package cannot verify locally.
 */
export type DocFor<C extends CollectionName> = CollectionDocs[C];

/** All document schemas keyed by singular and plural collection names. */
const schemasTyped: { [C in CollectionName]: z.ZodType<CollectionDocs[C]> } = {
  "booking": BookingSchema, "bookings": BookingSchema,
  "card": CardSchema, "cards": CardSchema,
  "counter": CounterSchema_, "counters": CounterSchema_,
  "cache-geocodes": CacheGeocodesSchema,
  "chart-of-accounts": ChartOfAccountsSchema,
  "comment": CommentSchema, "comments": CommentSchema,
  "contact": ContactSchema, "contacts": ContactSchema,
  "destination": DestinationSchema, "destinations": DestinationSchema,
  "email-verification": EmailVerificationSchema, "email-verifications": EmailVerificationSchema,
  "holiday-dates": HolidayDatesSchema,
  // `holiday-dates` is now the live top-level collection. `dates` is a retained
  // legacy alias for the old `config/{id}/dates` subcollection (migrated to
  // top-level + deleted 2026-06); kept only so historical tooling that resolves
  // that key still validates against HolidayDatesSchema.
  "dates": HolidayDatesSchema,
  "holiday-definition": HolidayDefinitionSchema, "holiday-definitions": HolidayDefinitionSchema,
  "holiday-snapshot": HolidaySnapshotSchema,
  "inventory-ledger": InventoryLedgerSchema, "inventory-ledgers": InventoryLedgerSchema,
  "invite": InviteSchema, "invites": InviteSchema,
  "invoice": InvoiceSchema, "invoices": InvoiceSchema,
  "list": ListSchema, "lists": ListSchema,
  "location": LocationSchema, "locations": LocationSchema,
  "location-type": LocationTypeSchema, "location-types": LocationTypeSchema,
  "order": OrderSchema, "orders": OrderSchema,
  "fulfillment": FulfillmentSchema, "fulfillments": FulfillmentSchema,
  "organization": OrganizationSchema, "organizations": OrganizationSchema,
  "out-of-service": OutOfServiceSchema,
  "password-reset": PasswordResetSchema, "password-resets": PasswordResetSchema,
  "product": ProductSchema, "products": ProductSchema,
  "quote": QuoteSchema_, "quotes": QuoteSchema_,
  "template": TemplateSchema_, "templates": TemplateSchema_,
  "templates-versions": TemplateVersionSchema_,
  "template-components": TemplateComponentSchema_,
  "rate-limit": RateLimitSchema, "rate-limits": RateLimitSchema,
  "recurrence": RecurrenceSchema, "recurrences": RecurrenceSchema,
  "role": RoleSchema, "roles": RoleSchema,
  "session": SessionSchema, "sessions": SessionSchema,
  "credit-note": CreditNoteSchema, "credit-notes": CreditNoteSchema,
  "settlement": SettlementSchema, "settlements": SettlementSchema,
  // `stock` is both the singular and the plural, so it takes one key rather than
  // the usual pair. `stock-locks` gets the pair like everything else.
  "stock": StockSchema,
  "stock-lock": StockLockSchema, "stock-locks": StockLockSchema,
  "store": StoreSchema, "stores": StoreSchema,
  "tag": TagSchema, "tags": TagSchema,
  "tax": TaxSchema_, "taxes": TaxSchema_,
  "thread": ThreadSchema, "threads": ThreadSchema,
  "tracking-category": TrackingCategorySchema, "tracking-categories": TrackingCategorySchema,
  "transaction": MovementSchema, "transactions": MovementSchema,
  "user": UserSchema, "users": UserSchema,
  "webhook-event": WebhookEventSchema_, "webhook-events": WebhookEventSchema_,
  // `events` is the inbound-webhook idempotency subcollection webhooks/{service}/events.
  "events": WebhookEventSchema_,
  "webshop-product": WebshopProductSchema, "webshop-products": WebshopProductSchema,
  "typesense-config": TypesenseConfigSchema, "typesense": TypesenseConfigSchema,
  "uploadcare-sweep": UploadcareSweepRunSchema,
  // One key rather than the usual singular/plural pair: "worklist" already
  // reads as both, the way `stock` does.
  "uploadcare-worklist": UploadcareWorkListEntrySchema,
  // Singleton `xero-budget/current` — the persisted daily-quota snapshot the
  // Xero gate reads pre-flight. Deliberately NOT a `config/…` doc: `config` is
  // in api-cloudrun's UNVALIDATED_COLLECTIONS, which would exempt it from
  // validateBeforeWrite.
  "xero-budget": XeroBudgetSchema_,
  // Sidecar `orders/{uid}/xero-sync/state` — the last-successfully-pushed hash
  // the order eventarc fan-out gates its quote enqueue on.
  "xero-sync": XeroSyncStateSchema_,
  "documents": OrderDocumentSchema_,
  "template_previews": PreviewRecordSchema_,
  "mcp-oauth-clients": McpOAuthClientSchema_,
  "mcp-oauth-authorize-requests": McpOAuthAuthorizeRequestSchema_,
  "mcp-oauth-codes": McpOAuthCodeSchema_,
  "mcp-oauth-tokens": McpOAuthTokenSchema_,
};

/**
 * All document schemas keyed by singular and plural collection names.
 *
 * ⚠️ **PRECISE as of beta.170 — indexing it with a bare `string` is now a
 * compile error, and that is the point.** It was `Record<string, z.ZodType>`
 * through beta.169 while every consumer still reached it with a runtime string.
 * Flipping it earlier would have broken api-cloudrun, manager and templates on
 * their next pin bump, so the migration went first and the flip went last:
 * every one of those call sites now narrows through {@link isCollectionName}
 * and reads {@link schemaFor}, and each repo was verified clean against this
 * exact annotation BEFORE it landed here (api by a `file://` pin across all 26
 * subpaths, manager by patching its installed declaration, templates by holding
 * zero references at all).
 *
 * What the precision buys is not the lookup type — it is that a **key nothing
 * declares** stops compiling. `schemas["packing_lsits"]` was `undefined` at
 * runtime and silently well-typed; it is now `TS7053`/`TS2339` at the call site.
 *
 * The object is unchanged — this is the same value as {@link schemasTyped},
 * exported once. There is no second table to drift.
 */
export const schemas: { [C in CollectionName]: z.ZodType<CollectionDocs[C]> } = schemasTyped;

/**
 * The schema for a collection known at compile time, typed to its document.
 *
 * The precise counterpart to {@link schemas} — use it wherever the collection is
 * a literal, and the return type carries the document type instead of
 * `z.ZodType<unknown>`. Return type written out rather than inferred: this is
 * exported, and the declaration emit is the one surface this package cannot
 * verify locally (see {@link CollectionDocs}).
 */
export function schemaFor<C extends CollectionName>(collection: C): z.ZodType<CollectionDocs[C]> {
  return schemasTyped[collection];
}

/**
 * Narrow a runtime string to a known collection name.
 *
 * The bridge for the call sites that genuinely start from a string — a Firestore
 * path segment, a route param, a Typesense alias. Most already ran a `if
 * (!schema)` check and threw or returned a default; this lets that SAME check
 * also narrow the type, so the runtime guard they already had starts paying for
 * itself at compile time instead of being duplicated by one.
 */
export function isCollectionName(name: string): name is CollectionName {
  return Object.hasOwn(schemasTyped, name);
}

// Defined here (not in display-defaults.ts) to avoid a circular dependency.
// Firestore display defaults live in Zod's .meta() registry, so we need the
// `schemas` record above to extract them. display-defaults.ts is re-exported
// by this file, so importing `schemas` from there would hit a TDZ error.
import type { FirestoreDisplayDefaults } from "./display-defaults.ts";

/** Display defaults for every Firestore collection, derived from schema meta. */
export const firestoreDisplayDefaults: Record<string, FirestoreDisplayDefaults> =
  Object.fromEntries(
    Object.entries(schemas)
      .map(([key, schema]) => {
        const meta = z.globalRegistry.get(schema) as
          | { displayDefaults?: FirestoreDisplayDefaults }
          | undefined;
        return [key, meta?.displayDefaults] as const;
      })
      .filter((entry): entry is [string, FirestoreDisplayDefaults] => entry[1] != null),
  );

// ── Declared table columns ─────────────────────────────────────────
//
// Bound here for the same reason as `firestoreDisplayDefaults`: the derivation
// is pure and lives in display-columns.ts, but it needs the `schemas` record
// above, which is defined in this file. Memoized because both walks allocate
// and a table asks for its columns on every render.

import {
  buildFirestoreColumns,
  buildTypesenseColumns,
  type DisplayTableColumn,
} from "./display-columns.ts";
import { typesenseSchemas } from "./typesense/mod.ts";

export type { CellKind, DisplayTableColumn } from "./display-columns.ts";
export { TYPESENSE_ROLLUP_COLUMNS } from "./display-columns.ts";

const firestoreColumnCache = new Map<string, DisplayTableColumn[]>();

/**
 * Columns a Firestore document surface offers for `collection` — every field
 * the schema annotates `column: true`. `[]` for an unregistered collection.
 */
export function getFirestoreColumns(collection: string): DisplayTableColumn[] {
  const hit = firestoreColumnCache.get(collection);
  if (hit) return hit;
  // Narrowed rather than looked up loosely: this returns `[]` for an
  // unregistered collection either way, so the guard costs nothing and the
  // lookup below is precise.
  const columns = isCollectionName(collection) ? buildFirestoreColumns(schemasTyped[collection]) : [];
  firestoreColumnCache.set(collection, columns);
  return columns;
}

const typesenseColumnCache = new Map<string, DisplayTableColumn[]>();

/**
 * Columns a Typesense surface offers for `alias` — the annotated set
 * intersected with the fields that collection actually indexes, plus its
 * computed rollups. `[]` for an unknown alias.
 */
export function getTypesenseColumns(alias: string): DisplayTableColumn[] {
  const hit = typesenseColumnCache.get(alias);
  if (hit) return hit;
  const config = typesenseSchemas[alias as keyof typeof typesenseSchemas];
  // `firestoreCollection` is a `CollectionName`, so the lookup cannot miss.
  // Reads `schemasTyped` directly rather than the loose view (api-cloudrun#444).
  const schema = config ? schemasTyped[config.firestoreCollection] : undefined;
  const columns = config && schema ? buildTypesenseColumns(schema, config) : [];
  typesenseColumnCache.set(alias, columns);
  return columns;
}

// ── Template schema fields (static, generated) ─────────────────────

export type { SchemaField } from "./template-schema-fields.generated.ts";
export { templateSchemaFields } from "./template-schema-fields.generated.ts";

// ── Template helper catalogue (static, generated) ──────────────────

export type { TemplateHelperEntry } from "./template-helpers.generated.ts";
export { templateHelpers } from "./template-helpers.generated.ts";

// ── Template render context (which `it.*` namespaces a template gets) ──

export type { TemplateCollectionType } from "./template-context.ts";
export {
  ALWAYS_ON_UTIL_NAMESPACES,
  availableUtilNamespaces,
  TEMPLATE_COLLECTION_UTILS,
  TEMPLATE_LIB_GLOBALS,
  TEMPLATE_SCALAR_GLOBALS,
} from "./template-context.ts";
