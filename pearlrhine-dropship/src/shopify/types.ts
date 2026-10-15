export interface Address {
  name: string;
  company?: string;
  address1: string;
  address2?: string;
  zip: string;
  city: string;
  countryCode: string;
  phone?: string;
}

export interface StockItem {
  variantId: string;
  inventoryItemId: string;
  sku: string;
  barcode: string;
  /** verfügbar je Location-GID */
  levels: Record<string, number>;
  tracked: boolean;
}

export interface ProductItem {
  variantId: string;
  productId: string;
  sku: string;
  barcode: string;
  title: string;
  brand: string;
  productType: string;
  descriptionHtml: string;
  images: string[];
  weightKg: number | null;
  /** UVP, so wie in Shopify gepflegt (brutto, wenn PRICES_INCLUDE_TAX) */
  price: number;
  /** Metafelder Namespace "dropship", Produkt + Variante (Variante gewinnt) */
  meta: Record<string, string>;
}

export interface DraftLine {
  variantId: string;
  quantity: number;
  /** Rabatt in Prozent auf den Shopify-Preis, um auf den EK zu kommen. undefined = Shopify-Preis/Katalog gilt */
  discountPercent?: number;
}

export interface CreateOrderInput {
  email: string;
  shippingAddress: Address;
  billingAddress?: Address;
  lines: DraftLine[];
  fee?: { title: string; amount: number };
  tags: string[];
  attributes: { key: string; value: string }[];
  note?: string;
  purchasingCompany?: { companyId: string; companyLocationId: string; companyContactId: string };
  /** Gesetztes Zahlungsziel. Fehlt es und es gibt keine B2B-Firma, bleibt die Order über paymentPending offen. */
  paymentTermsTemplateId?: string;
}

export interface ShopifyOrderStatus {
  name: string;
  cancelled: boolean;
  fulfillmentStatus: string;
  returnStatus: string;
  tracking: { company: string | null; number: string | null; url: string | null }[];
}

/** Alles, was die App von Shopify braucht – real oder gemockt. */
export interface ShopifyGateway {
  fetchStock(): Promise<StockItem[]>;
  fetchProducts(): Promise<ProductItem[]>;
  /** variantId -> Preis aus der B2B-Preisliste */
  fetchPriceList(): Promise<Map<string, number>>;
  createOrder(input: CreateOrderInput): Promise<{ orderId: string; orderName: string }>;
  getOrderStatus(orderId: string): Promise<ShopifyOrderStatus | null>;
  addOrderTags(orderId: string, tags: string[]): Promise<void>;
  registerWebhook(topic: string, uri: string): Promise<string>;
  /** Template fürs Netto-Zahlungsziel, oder null wenn keins konfiguriert/gefunden wurde. */
  resolvePaymentTermsTemplate(): Promise<string | null>;
}
