/**
 * TypeScript interfaces for Typesense search result documents.
 *
 * These represent the shape of documents returned by Typesense search hits
 * for each collection. Every document includes an `id` field added by Typesense.
 */

// ── Shared ─────────────────────────────────────────────────────────

/** Shared actor reference (uid + denormalized display name) across Typesense document types. */
export interface TypesenseActorRef {
  uid?: string;
  name?: string;
}

/**
 * Shared address fields used across Typesense document types.
 *
 * Coordinates are stored as `[latitude, longitude]` geopoints.
 * The API translates Firestore `{latitude, longitude}` objects into this format.
 */
export interface TypesenseAddressFields {
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

// ── Bookings ────────────────────────────────────────────────────────

/** Typesense document type for bookings. */
export interface BookingDocument {
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
  organization: {
    uid?: string;
    name: string;
    crms_id?: number;
    crms_id_str?: string;
  };
  breakdown: {
    out: number;
    prepped: number;
    returned: number;
    quoted: number;
    reserved: number;
    lost: number;
    damaged: number;
  };
  quantity: number;
  shortage?: number;
  total_price_cents?: number;
  unit_price_cents?: number;
  dates: {
    start_fs?: number;
    end_fs?: number;
    charge_start_fs?: number;
    charge_end_fs?: number;
  };
  destinations?: {
    delivery?: {
      uid?: string;
      address?: TypesenseAddressFields;
    };
    collection?: {
      uid?: string;
      address?: TypesenseAddressFields;
    };
  };
  stores?: Array<{
    uid_store?: string;
    name?: string;
    quantity?: number;
  }>;
  uid_destination_delivery?: string;
  uid_destination_collection?: string;
  created_at?: number;
  updated_at: number;
}

// ── Chart of Accounts ───────────────────────────────────────────────

/** Typesense document type for chart of accounts. */
export interface ChartOfAccountsDocument {
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

// ── Comments ────────────────────────────────────────────────────────

/** Typesense document type for comments. */
export interface CommentDocument {
  id: string;
  uid: string;
  uid_thread: string;
  sources: Array<{
    collection?: string;
    uid?: string;
  }>;
  body_text: string;
  created_by: TypesenseActorRef;
  updated_by?: TypesenseActorRef;
  deleted_by?: TypesenseActorRef;
  deleted_at?: number;
  created_at: number;
  updated_at?: number;
}

// ── Contacts ────────────────────────────────────────────────────────

/** Typesense document type for contacts. */
export interface ContactDocument {
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
  organizations?: Array<{
    uid?: string;
    name?: string;
  }>;
  created_by?: TypesenseActorRef;
  updated_by?: TypesenseActorRef;
  created_at?: number;
  updated_at: number;
}

// ── Destinations ────────────────────────────────────────────────────

/** Typesense document type for destinations. */
export interface DestinationDocument {
  id: string;
  uid: string;
  mapbox_ids: string[];
  address?: TypesenseAddressFields;
  organizations?: Array<{
    uid?: string;
    name?: string;
  }>;
  products?: Array<{
    uid?: string;
    name?: string;
  }>;
  contacts?: Array<{
    uid?: string;
    name?: string;
    first_name?: string;
    middle_name?: string;
    last_name?: string;
    pronunciation?: string;
  }>;
  created_at?: number;
  updated_at: number;
}

// ── Invoices ────────────────────────────────────────────────────────

/** Typesense document type for invoices. */
export interface InvoiceDocument {
  id: string;
  uid: string;
  number: number;
  number_str?: string;
  crms_id?: number;
  crms_id_str?: string;
  status: string;
  number_orders?: number[];
  number_orders_str?: string[];
  subject?: string;
  reference?: string;
  external_notes?: string;
  internal_notes?: string;
  organization: {
    uid?: string;
    name: string;
    crms_id?: number;
    crms_id_str?: string;
    xero_id?: string;
    billing_address?: TypesenseAddressFields;
  };
  items?: Array<{
    uid?: string;
    name?: string;
    quantity?: number;
    type?: string;
  }>;
  totals?: {
    total_cents?: number;
    total_cents_str?: string;
    amount_paid_cents?: number;
    amount_paid_cents_str?: string;
    amount_credited_cents?: number;
    amount_credited_cents_str?: string;
    amount_void_cents?: number;
    amount_void_cents_str?: string;
    amount_due_cents?: number;
    amount_due_cents_str?: string;
  };
  crms_opportunity_ids?: number[];
  xero_id?: string;
  created_by?: TypesenseActorRef;
  updated_by?: TypesenseActorRef;
  date_fs: number;
  due_date_fs?: number;
  created_at?: number;
  updated_at?: number;
}

// ── Credit notes ────────────────────────────────────────────────────

/** Typesense document type for credit notes. */
export interface CreditNoteDocument {
  id: string;
  uid: string;
  number: number;
  number_str?: string;
  status: string;
  reason: string;
  reference?: string;
  external_notes?: string;
  internal_notes?: string;
  organization: {
    uid?: string;
    name: string;
    crms_id?: number;
    crms_id_str?: string;
    xero_id?: string;
    billing_address?: TypesenseAddressFields;
  };
  items?: Array<{
    uid?: string;
    name?: string;
    quantity?: number;
    type?: string;
    coa_revenue?: number;
  }>;
  totals?: {
    total_cents?: number;
    total_cents_str?: string;
  };
  remaining_credit_cents?: number;
  remaining_credit_cents_str?: string;
  xero_credit_note_id?: string;
  created_by?: TypesenseActorRef;
  updated_by?: TypesenseActorRef;
  date_fs: number;
  created_at?: number;
  updated_at?: number;
}

// ── Locations ───────────────────────────────────────────────────────

/** Typesense document type for locations. */
export interface LocationDocument {
  id: string;
  uid: string;
  name: string;
  uid_store: string;
  active: boolean;
  default?: boolean;
  uid_location_type?: string;
  products?: Array<{
    uid?: string;
    name?: string;
    quantity?: number;
    default?: boolean;
  }>;
  product_capacities?: Array<{
    uid?: string;
    max?: number;
    max_default?: number;
  }>;
  created_at: number;
  updated_at?: number;
}

// ── Orders ──────────────────────────────────────────────────────────

/** Typesense document type for orders. */
export interface OrderDocument {
  id: string;
  uid: string;
  number: number;
  number_str?: string;
  crms_id?: number;
  crms_id_str?: string;
  status: string;
  deliveries?: boolean;
  pickups?: boolean;
  subject?: string;
  reference?: string;
  crms_status?: string;
  invoices?: Array<{
    uid?: string;
    number?: number;
    status?: string;
  }>;
  organization: {
    uid?: string;
    name: string;
    crms_id?: number;
    crms_id_str?: string;
    xero_id?: string;
    billing_address?: TypesenseAddressFields;
  };
  dates: {
    delivery_start_fs?: number;
    delivery_end_fs?: number;
    collection_start_fs?: number;
    collection_end_fs?: number;
    charge_start_fs?: number;
    charge_end_fs?: number;
    days_active?: number;
    days_charged?: number;
  };
  destinations: Array<{
    delivery?: {
      uid?: string;
      address?: TypesenseAddressFields;
      instructions?: string;
      contact?: {
        uid?: string;
        name?: string;
        first_name?: string;
        middle_name?: string;
        last_name?: string;
        pronunciation?: string;
      };
    };
    collection?: {
      uid?: string;
      address?: TypesenseAddressFields;
      instructions?: string;
      contact?: {
        uid?: string;
        name?: string;
        first_name?: string;
        middle_name?: string;
        last_name?: string;
        pronunciation?: string;
      };
    };
  }>;
  totals: {
    discount_amount_cents?: number;
    subtotal_cents?: number;
    subtotal_discounted_cents?: number;
    taxes?: Array<{ uid?: string; name?: string; rate?: number; type?: string; amount_cents?: number }>;
    transaction_fees?: Array<{ uid?: string; name?: string; rate?: number; type?: string; amount_cents?: number }>;
    total_cents?: number;
    total_cents_str?: string;
  };
  items?: Array<{
    uid?: string;
    name?: string;
    quantity?: number;
    type?: string;
    description?: string;
    stock_method?: string;
    inclusion_type?: string;
    zero_priced?: boolean;
    uid_order?: string;
    order_number?: number;
    path?: string[];
    price?: {
      base_cents?: number;
      replacement_cents?: number;
      subtotal_cents?: number;
      subtotal_discounted_cents?: number;
      total_cents?: number;
      discount?: { rate?: number; type?: string; amount_cents?: number };
      taxes?: Array<{ uid?: string; name?: string; rate?: number; type?: string; amount_cents?: number }>;
      chargeable_days?: number;
      formula?: string;
    };
  }>;
  created_at?: number;
  updated_at: number;
}

// ── Fulfillments ────────────────────────────────────────────────────

/**
 * Typesense document type for the sanitized fulfillment order view.
 *
 * Mirrors `OrderDocument` but strips pricing, totals, tax profile,
 * invoice refs, CRM/Xero ids, and financial line-item fields.
 */
export interface FulfillmentDocument {
  id: string;
  uid: string;
  number: number;
  number_str?: string;
  status: string;
  deliveries?: boolean;
  pickups?: boolean;
  subject?: string;
  reference?: string;
  organization: {
    uid?: string;
    name: string;
  };
  dates: {
    delivery_start_fs?: number;
    delivery_end_fs?: number;
    collection_start_fs?: number;
    collection_end_fs?: number;
    charge_start_fs?: number;
    charge_end_fs?: number;
  };
  destinations: Array<{
    delivery?: {
      uid?: string;
      address?: TypesenseAddressFields;
      instructions?: string;
      contact?: {
        uid?: string;
        name?: string;
        first_name?: string;
        middle_name?: string;
        last_name?: string;
        pronunciation?: string;
      };
    };
    collection?: {
      uid?: string;
      address?: TypesenseAddressFields;
      instructions?: string;
      contact?: {
        uid?: string;
        name?: string;
        first_name?: string;
        middle_name?: string;
        last_name?: string;
        pronunciation?: string;
      };
    };
  }>;
  items?: Array<{
    uid?: string;
    name?: string;
    quantity?: number;
    type?: string;
    description?: string;
    stock_method?: string;
    path?: string[];
    order_number?: number;
    uid_order?: string;
  }>;
  created_at?: number;
  updated_at: number;
}

// ── Out of Service ──────────────────────────────────────────────────

/** Typesense document type for out-of-service records. */
export interface OutOfServiceDocument {
  id: string;
  uid: string;
  uid_product: string;
  number: number;
  number_str?: string;
  reason: string;
  status: string;
  quantity: number;
  breakdown: {
    draft: number;
    planned: number;
    active: number;
    blocked: number;
    written_off: number;
    returned_to_service: number;
  };
  organization?: {
    uid?: string;
    name?: string;
  };
  dates: {
    start_fs?: number;
    end_fs?: number;
  };
  stores?: Array<{
    uid_store?: string;
    name?: string;
    quantity?: number;
  }>;
  canceled_at?: number;
  created_at?: number;
  updated_at: number;
}

// ── Organizations ───────────────────────────────────────────────────

/** Typesense document type for organizations. */
export interface OrganizationDocument {
  id: string;
  uid: string;
  /**
   * The COMPOSED label — `composeOrgName(path)`, derived at index time.
   *
   * ⚠️ **Not the stored scalar `name`.** A migrated node still carries the
   * operator's old delimited string there until its first rename, after which it
   * carries the node's OWN segment alone; neither is a label. This field is what
   * every search surface renders, and it is why a consumer never needs `path`
   * (whose `derived` flag is not indexed, so a hit cannot be re-composed).
   */
  name: string;
  description?: string;
  /**
   * 🔴 **Optional because `Organization.crms_id` is NULLABLE** — a minted root or
   * project has no CRMS counterpart and must not create one, and the config
   * declares it optional for exactly that reason. It read `number` here for as
   * long as the index has carried the tree — core#57's failure class, where the
   * config moved and the hand-written document type did not.
   */
  crms_id?: number;
  crms_id_str?: string;
  /**
   * `ORG_LEVELS[path.length - 1]`, DERIVED at index time — Typesense cannot facet
   * on an array's length, and there is no stored `level` (a stored one is the
   * copy that could disagree with `path`).
   *
   * A facet and a declared column, which together are what make a
   * `level:=department` filter legal through the manager's generic filter
   * surface rather than an undeclared one its rules refuse.
   */
  level?: string;
  xero_id?: string;
  jurisdiction_claim?: string;
  tax_exempt?: boolean;
  emails?: string[];
  phones?: string[];
  billing_address: TypesenseAddressFields;
  contacts: Array<{
    uid?: string;
    first_name?: string;
    middle_name?: string;
    last_name?: string;
    pronunciation?: string;
    roles?: string[];
  }>;
  created_by?: TypesenseActorRef;
  updated_by?: TypesenseActorRef;
  last_order?: number;
  created_at?: number;
  updated_at: number;
}

// ── Products ────────────────────────────────────────────────────────

/** Typesense document type for a product component entry. */
export interface ProductDocumentComponent {
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
  price?: {
    base_cents?: number;
    replacement_cents?: number;
    coa_revenue?: number;
    taxes?: Array<{ uid?: string; name?: string; rate?: number; type?: string }>;
    formula?: string;
    discountable?: boolean;
  };
}

/** Typesense document type for products. */
export interface ProductDocument {
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
  price?: {
    base_cents?: number;
    replacement_cents?: number;
    coa_revenue?: number;
    taxes?: Array<{ uid?: string; name?: string; rate?: number; type?: string }>;
    formula?: string;
    discountable?: boolean;
  };
  webshop?: {
    available?: boolean;
    description?: string;
  };
  alternates?: Array<{
    uid?: string;
    name?: string;
  }>;
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
  shipping?: {
    weight?: number;
    height?: number;
    width?: number;
    length?: number;
    air_hazardous?: boolean;
    air_un?: number;
  };
  tags?: Array<{
    uid?: string;
    name?: string;
  }>;
  components?: ProductDocumentComponent[];
  component_of?: ProductDocumentComponent[];
  crms_stock_level_ids?: number[];
  images?: string[];
  created_by?: TypesenseActorRef;
  updated_by?: TypesenseActorRef;
  updated_at: number;
  created_at?: number;
}

// ── Stores ──────────────────────────────────────────────────────────

/** Typesense document type for stores. */
export interface StoreDocument {
  id: string;
  uid: string;
  name: string;
  default: boolean;
  active: boolean;
  default_location?: {
    uid?: string;
    name?: string;
  };
  crms_store_id: number;
  crms_store_id_str?: string;
  created_at: number;
  updated_at?: number;
}

// ── Tags ────────────────────────────────────────────────────────────

/** Typesense document type for tags. */
export interface TagDocument {
  id: string;
  uid: string;
  name: string;
  count: number;
  products?: Array<{
    uid?: string;
    name?: string;
  }>;
  created_by?: TypesenseActorRef;
  updated_by?: TypesenseActorRef;
  updated_at: number;
}

// ── Templates ───────────────────────────────────────────────────────

/** Typesense document type for templates. */
/**
 * ⚠️ **Rebuilt 2026-08-18 against the index config — it had drifted in BOTH
 * directions and described a superseded model** (core#57, found by the new
 * `typesense document parity` guard on its first clean run).
 *
 * It declared `uid_template`, `scope`, `version_str` and `source_filename`,
 * none of which the index has — so a consumer reading any of them type-checked
 * and got `undefined`. And it omitted `git_path`, `surfaces`, `uid_active` and
 * `version_count`, which the index does have — so those were unreachable
 * without a cast. All four phantoms are pre-git-canonical-rebuild concepts;
 * this interface was a mirror of the template model that rebuild replaced.
 *
 * **The config is the authority here**, and the guard now enforces that
 * relationship rather than leaving it to be noticed.
 */
export interface TemplateDocument {
  id: string;
  uid: string;
  git_path: string;
  name: string;
  collection_source: string;
  collection_target: string;
  surfaces: string[];
  uid_active?: string;
  version_count: number;
  version: number;
  created_at: number;
  updated_at: number;
}

// ── Template Components ─────────────────────────────────────────────

/** Typesense document type for template-component families. */
export interface TemplateComponentDocument {
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

// ── Tracking Categories ─────────────────────────────────────────────

/** Typesense document type for tracking categories. */
export interface TrackingCategoryDocument {
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
  products?: Array<{
    uid?: string;
    name?: string;
  }>;
  created_by?: TypesenseActorRef;
  updated_by?: TypesenseActorRef;
  updated_at: number;
}

// ── Webshop Products ────────────────────────────────────────────────

/** Typesense document type for a webshop product component entry. */
export interface WebshopProductDocumentComponent {
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
  price?: {
    base_cents?: number;
    replacement_cents?: number;
    taxes?: Array<{ uid?: string; name?: string; rate?: number; type?: string }>;
    formula?: string;
    discountable?: boolean;
  };
}

/** Typesense document type for webshop products. */
export interface WebshopProductDocument {
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
  price: {
    base_cents?: number;
    replacement_cents?: number;
    taxes?: Array<{ uid?: string; name?: string; rate?: number; type?: string }>;
    formula?: string;
    discountable?: boolean;
  };
  webshop: {
    available: boolean;
    description?: string;
  };
  alternates?: Array<{
    uid?: string;
    name?: string;
  }>;
  shipping?: {
    weight?: number;
    height?: number;
    width?: number;
    length?: number;
    air_hazardous?: boolean;
    air_un?: number;
  };
  tags?: Array<{
    uid?: string;
    name?: string;
  }>;
  components?: WebshopProductDocumentComponent[];
  component_of?: WebshopProductDocumentComponent[];
  updated_at?: number;
  created_at?: number;
}

// ── Users ───────────────────────────────────────────────────────────

/** Typesense document type for users. */
export interface UserDocument {
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

// ── Union and map ───────────────────────────────────────────────────

/** Union of all Typesense document types. */
export type TypesenseDocument =
  | BookingDocument
  | ChartOfAccountsDocument
  | CommentDocument
  | ContactDocument
  | DestinationDocument
  | InvoiceDocument
  | CreditNoteDocument
  | LocationDocument
  | OrderDocument
  | FulfillmentDocument
  | OrganizationDocument
  | OutOfServiceDocument
  | ProductDocument
  | StoreDocument
  | TagDocument
  | TemplateDocument
  | TemplateComponentDocument
  | TrackingCategoryDocument
  | UserDocument
  | WebshopProductDocument;

/** Map from collection alias to its document type. */
// ── Cards ───────────────────────────────────────────────────────────

/**
 * Typesense document type for cards (core#60).
 *
 * ⚠️ **Mirrors the TRANSLATION, not the storage schema.** Three conventions the
 * `cards` config depends on and that a `Card`-shaped copy would get wrong:
 *
 * - **`date_fs` is an `int64`, and `dates.start` is not declared at all.**
 *   `translateObject` turns the stored Firestore Timestamp into epoch ms. The
 *   ISO string beside it is a Chicago-offset string, and range-filtering that is
 *   the lexicographic-date trap `date_fs` exists to avoid.
 * - **`address_coordinates` is a `[lat, lng]` tuple**, rewritten from Firestore's
 *   `{latitude, longitude}` by `GEOPOINT_KEYS` — hence {@link TypesenseAddressFields}
 *   rather than a hand-spelled pair.
 * - **`created_at` / `updated_at` are `int64`**, not the stored Timestamps.
 *
 * `sources` is required-but-possibly-empty while its nested members are optional:
 * Typesense cannot flatten nested facets out of an empty array, so a source-less
 * manual card would 400 on upsert if `sources.uid` were required. The interface
 * states that asymmetry rather than smoothing it.
 */
export interface CardDocument {
  id: string;
  uid: string;
  uid_list: string;
  status: string;
  position: number;
  subject: string;
  body_text?: string;
  date_fs?: number;
  destination?: {
    address?: Pick<TypesenseAddressFields, "city" | "region" | "address_coordinates">;
  };
  sources: Array<{
    collection?: string;
    uid?: string;
  }>;
  uid_thread: string;
  uid_assignees?: string[];
  recurrence_parent_uid?: string;
  created_by: TypesenseActorRef;
  updated_by?: TypesenseActorRef;
  created_at: number;
  updated_at?: number;
}

// ── Threads ─────────────────────────────────────────────────────────

/**
 * Typesense document type for threads (core#60).
 *
 * ⚠️ **The `threads` config is `enabled: false`** — a reserved slot, since
 * thread-level search can pivot off comment hits. It is declared here anyway
 * because {@link TypesenseDocumentMap} is about **type reachability from
 * manager's typed search surface**, not about liveness: `enabled` defaults to on
 * and `bookings` is disabled *and* mapped. A map keyed on liveness would drop a
 * type the moment someone toggled a flag.
 */
export interface ThreadDocument {
  id: string;
  uid: string;
  sources: Array<{
    collection?: string;
    uid?: string;
  }>;
  title?: string;
  last_message_preview?: string;
  last_message_at?: number;
  comment_count: number;
  created_by: TypesenseActorRef;
  updated_by?: TypesenseActorRef;
  created_at: number;
  updated_at?: number;
}

export interface TypesenseDocumentMap {
  bookings: BookingDocument;
  cards: CardDocument;
  "chart-of-accounts": ChartOfAccountsDocument;
  comments: CommentDocument;
  contacts: ContactDocument;
  destinations: DestinationDocument;
  invoices: InvoiceDocument;
  "credit-notes": CreditNoteDocument;
  locations: LocationDocument;
  orders: OrderDocument;
  fulfillments: FulfillmentDocument;
  organizations: OrganizationDocument;
  "out-of-service": OutOfServiceDocument;
  products: ProductDocument;
  stores: StoreDocument;
  tags: TagDocument;
  templates: TemplateDocument;
  "template-components": TemplateComponentDocument;
  threads: ThreadDocument;
  "tracking-categories": TrackingCategoryDocument;
  users: UserDocument;
  "webshop-products": WebshopProductDocument;
}
