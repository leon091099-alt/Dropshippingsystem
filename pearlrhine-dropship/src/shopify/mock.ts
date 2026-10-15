import type { CreateOrderInput, ProductItem, ShopifyGateway, ShopifyOrderStatus, StockItem } from './types.js';

const LOC = 'gid://shopify/Location/1';

const SAMPLE = [
  { n: 1, sku: 'DF-TRIPOD-01', ean: '6970000000011', title: 'Carbon-Stativ T1', brand: 'DIGITALFOTO', price: 189, qty: 37 },
  { n: 2, sku: 'DF-GIMBAL-02', ean: '6970000000028', title: 'Gimbal G2', brand: 'DIGITALFOTO', price: 249, qty: 5 },
  { n: 3, sku: 'DF-CAGE-03', ean: '6970000000035', title: 'Kamera-Cage C3', brand: 'DIGITALFOTO', price: 79, qty: 1 },
];

/** Shopify-Ersatz für Tests und Testbetrieb (MOCK_SHOPIFY=true). */
export class MockShopifyGateway implements ShopifyGateway {
  stock: StockItem[] = SAMPLE.map((s) => ({
    variantId: `gid://shopify/ProductVariant/${s.n}`,
    inventoryItemId: `gid://shopify/InventoryItem/${s.n}`,
    sku: s.sku, barcode: s.ean, tracked: true,
    levels: { [LOC]: s.qty },
  }));
  products: ProductItem[] = SAMPLE.map((s) => ({
    variantId: `gid://shopify/ProductVariant/${s.n}`,
    productId: `gid://shopify/Product/${s.n}`,
    sku: s.sku, barcode: s.ean, title: s.title, brand: s.brand, productType: 'Kamerazubehör',
    descriptionHtml: `<p>${s.title} – Beschreibung</p>`,
    images: [`https://cdn.example.com/${s.sku}.jpg`],
    weightKg: 1.2, price: s.price,
    meta: { gpsr_hersteller: 'Nanjing Example Co., Ltd.', weee_reg: 'DE12345678' },
  }));
  priceList = new Map<string, number>();
  created: CreateOrderInput[] = [];
  statuses = new Map<string, ShopifyOrderStatus>();
  tagged: { orderId: string; tags: string[] }[] = [];
  failNextCreate: string | null = null;

  async fetchStock() { return structuredClone(this.stock); }
  async fetchProducts() { return structuredClone(this.products); }
  async fetchPriceList() { return new Map(this.priceList); }

  async createOrder(input: CreateOrderInput) {
    if (this.failNextCreate) {
      const msg = this.failNextCreate;
      this.failNextCreate = null;
      throw new Error(msg);
    }
    this.created.push(input);
    const n = 1000 + this.created.length;
    const orderId = `gid://shopify/Order/${n}`;
    this.statuses.set(orderId, { name: `#${n}`, cancelled: false, fulfillmentStatus: 'UNFULFILLED', returnStatus: 'NO_RETURN', tracking: [] });
    // Bestand wie in Shopify reservieren
    for (const l of input.lines) {
      const s = this.stock.find((x) => x.variantId === l.variantId);
      if (s) s.levels[LOC] = (s.levels[LOC] ?? 0) - l.quantity;
    }
    return { orderId, orderName: `#${n}` };
  }

  async getOrderStatus(orderId: string) { return this.statuses.get(orderId) ?? null; }
  async addOrderTags(orderId: string, tags: string[]) { this.tagged.push({ orderId, tags }); }
  async registerWebhook(topic: string) { return `gid://shopify/WebhookSubscription/${topic}`; }
  async resolvePaymentTermsTemplate() { return 'gid://shopify/PaymentTermsTemplate/2'; }
}
