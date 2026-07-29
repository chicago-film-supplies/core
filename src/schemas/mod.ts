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
  enumValues,
  getServerSortableColumns,
  collectLeafPaths,
} from "./zod-walk.ts";

export type { CollectLeafPathsResult, LeafPath } from "./zod-walk.ts";

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
  TaxProfileEnum,
  PriceFormulaEnum,
  ItemTaxProfileEnum,
  InclusionTypeEnum,
  ComponentTypeEnum,
  COARevenueEnum,
  InvoiceStatusEnum,
  OOSReasonEnum,
  RateTypeEnum,
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
  type AddressType,
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
  type TaxProfileType,
  type PriceFormulaType,
  type ItemTaxProfileType,
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
  StoreBreakdownEntrySchema,
  StoreBreakdownLocationSchema,
  type StoreBreakdownEntry,
  type StoreBreakdownLocation,
  // Identifier validators (defined in _uid.ts, re-exported via common.ts)
  FirestoreId,
  ItemUid,
  BookingId,
  AnyUid,
  CardId,
  EventCardId,
  ListId,
  QuoteId,
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
  COACode,
  COAType,
  type ChartOfAccounts,
  type COACodeType,
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
  BOOKING_BREAKDOWN_OPEN_KEYS,
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
} from "./booking.ts";

export {
  CreateInvoiceInput,
  InvoiceDocDestination,
  InvoiceDocItem,
  InvoiceDocLineItemSchema,
  InvoiceDocOrderItem,
  InvoiceSchema,
  isInvoiceLineItem,
  UpdateInvoiceInput,
  UpdatePaymentInput,
  type CreateInvoiceInputType,
  type Invoice,
  type InvoiceDocDestinationType,
  type InvoiceDocItemPrice,
  type InvoiceDocItemType,
  type InvoiceDocLineItem,
  type InvoiceDocOrderItemType,
  type InvoiceDocTotals,
  type InvoiceItemInputType,
  type InvoiceItemTypeType,
  type InvoicePayment,
  type InvoiceStatusType,
  type UpdateInvoiceInputType,
  type UpdatePaymentInputType,
} from "./invoice.ts";

export {
  TaxSchema,
  CreateTaxInput,
  UpdateTaxInput,
  type Tax,
  type CreateTaxInputType,
  type UpdateTaxInputType,
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
  GetAvailabilityInput,
  type GetAvailabilityInputType,
} from "./availability.ts";

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
  StockSummarySchema,
  type StockSummary,
  type StockSummaryBookingEntry,
  type StockSummaryOOSEntry,
} from "./stock-summary.ts";

export {
  PublicStockSummarySchema,
  type PublicStockSummary,
  type PublicUnavailableEntry,
} from "./public-stock-summary.ts";

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
  FieldPath,
  PropagationMode,
  FieldMapping,
  CollectionRule,
  TransactionDefinition,
  AggregateDefinition,
} from "./propagation/mod.ts";

export {
  aggregates,
  rules,
  transactions,
  createOrderRules,
  createOrderTransaction,
  updateOrderRules,
  updateOrderTransaction,
  createTransactionRules,
  createTransactionTransaction,
  createProductRules,
  createProductTransaction,
  updateProductRules,
  updateProductTransaction,
  createOrganizationRules,
  createOrganizationTransaction,
  updateOrganizationRules,
  updateOrganizationTransaction,
  createContactRules,
  createContactTransaction,
  updateContactRules,
  updateContactTransaction,
  createUserRules,
  createUserTransaction,
  updateUserRules,
  updateUserTransaction,
  deleteUserRules,
  deleteUserTransaction,
  createInvoiceRules,
  createInvoiceTransaction,
  updateInvoiceOrderRules,
  updateOrderInvoiceRules,
  updateTagRules,
  deleteTagRules,
  updateTrackingCategoryRules,
  updateLocationTypeRules,
  updateLocationRules,
  createLocationRules,
  createLocationTransaction,
  updateLocationTransactionalRules,
  updateLocationTransaction,
  threadCowriteRules,
  threadOrderRules,
  threadInvoiceRules,
  threadContactRules,
  threadOrganizationRules,
  threadProductRules,
  threadRoleRules,
  createRoleTransaction,
  createCommentRules,
  createCommentTransaction,
  cardRules,
  createCardRules,
  createCardTransaction,
  deleteCardRules,
  deleteCardTransaction,
  templateRules,
  createTemplateRules,
  createTemplateTransaction,
  manageDraftRules,
  manageDraftTransaction,
  publishTemplateRules,
  publishTemplateTransaction,
  recurrenceRules,
  createRecurrenceRules,
  createRecurrenceTransaction,
  materializeHorizonRules,
  materializeHorizonTransaction,
  updateRecurrenceRules,
  updateRecurrenceTransaction,
  deleteRecurrenceRules,
  deleteRecurrenceTransaction,
  updateCardScopeFollowingRules,
  updateCardScopeFollowingTransaction,
  updateCardScopeAllRules,
  updateCardScopeAllTransaction,
  deleteCardScopeThisRules,
  deleteCardScopeThisTransaction,
  deleteCardScopeFollowingRules,
  deleteCardScopeFollowingTransaction,
  deleteCardScopeAllRules,
  deleteCardScopeAllTransaction,
} from "./propagation/mod.ts";

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
  StockSummaryRecalculated,
  PublicStockSummaryRecalculated,
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
  InvoicePaymentReceived,
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
import type { Destination as DestinationDocType } from "./destination.ts";
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
import type { PasswordReset } from "./password-reset.ts";
import type { Product } from "./product.ts";
import type { Quote } from "./quote.ts";
import type { Template } from "./template.ts";
import type { PublicStockSummary } from "./public-stock-summary.ts";
import type { RateLimit } from "./rate-limit.ts";
import type { Session } from "./session.ts";
import type { StockSummary } from "./stock-summary.ts";
import type { Store } from "./store.ts";
import type { Role } from "./role.ts";
import type { Thread } from "./thread.ts";
import type { Tag } from "./tag.ts";
import type { Tax } from "./tax.ts";
import type { TrackingCategory } from "./tracking-category.ts";
import type { Movement } from "./transaction.ts";
import type { TypesenseConfig } from "./typesense-config.ts";
import type { UploadcareSweepRun } from "./uploadcare-sweep.ts";
import type { User } from "./user.ts";
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

/** Union of all Firestore document types. Use with validateBeforeWrite. */
export type SchemaDocType =
  | Booking | CacheGeocodes | Card | ChartOfAccounts | Comment | Contact | Counter | DestinationDocType
  | EmailVerification | HolidayDates | HolidayDefinition | HolidaySnapshot | InventoryLedger | Invite | Invoice | List | Location
  | LocationType | Order | OrderDocument | Organization | OutOfService | PasswordReset
  | Fulfillment | Product | PreviewRecord | PublicStockSummary | Quote | RateLimit | Recurrence | Role | Session | StockSummary | Tax | Template
  | Store | Tag | Thread | TrackingCategory | Movement | TypesenseConfig | UploadcareSweepRun | User
  | WebhookEvent | WebshopProduct | XeroBudget | XeroSyncState
  | McpOAuthClient | McpOAuthAuthorizeRequest | McpOAuthCode | McpOAuthToken;

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
import { PasswordResetSchema } from "./password-reset.ts";
import { ProductSchema } from "./product.ts";
import { QuoteSchema as QuoteSchema_ } from "./quote.ts";
import { TemplateSchema as TemplateSchema_ } from "./template.ts";
import { TemplateVersionSchema as TemplateVersionSchema_ } from "./template-version.ts";
import { TemplateComponentSchema as TemplateComponentSchema_ } from "./template-component.ts";
import { RateLimitSchema } from "./rate-limit.ts";
import { RecurrenceSchema } from "./recurrence.ts";
import { RoleSchema } from "./role.ts";
import { PublicStockSummarySchema } from "./public-stock-summary.ts";
import { SessionSchema } from "./session.ts";
import { StockSummarySchema } from "./stock-summary.ts";
import { StoreSchema } from "./store.ts";
import { TagSchema } from "./tag.ts";
import { TaxSchema as TaxSchema_ } from "./tax.ts";
import { ThreadSchema } from "./thread.ts";
import { TrackingCategorySchema } from "./tracking-category.ts";
import { MovementSchema } from "./transaction.ts";
import { UserSchema } from "./user.ts";
import { TypesenseConfigSchema } from "./typesense-config.ts";
import { UploadcareSweepRunSchema } from "./uploadcare-sweep.ts";
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

/** All document schemas keyed by singular and plural collection names. */
export const schemas: Record<string, z.ZodType> = {
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
  "public-stock-summary": PublicStockSummarySchema, "public-stock-summaries": PublicStockSummarySchema,
  "session": SessionSchema, "sessions": SessionSchema,
  "stock-summary": StockSummarySchema, "stock-summaries": StockSummarySchema,
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
