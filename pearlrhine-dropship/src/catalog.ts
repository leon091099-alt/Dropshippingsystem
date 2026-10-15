import type { Config } from './config.js';
import { kvGet, kvSet, type DB } from './db.js';
import { log } from './log.js';
import { toGid } from './shopify/client.js';
import type { ProductItem, ShopifyGateway, StockItem } from './shopify/types.js';

/** Bestandsregel: angezeigt = min(verfügbar − Puffer, Deckel), nie unter 0. */
export function publishedQty(available: number, buffer: number, cap: number): number {
  return Math.max(0, Math.min(available - buffer, cap));
}

export type Availability = 'lieferbar' | 'nachschub' | 'nicht_lieferbar' | 'ausgelaufen';

export interface FeedItem {
  sku: string;
  ean: string;
  variantId: string;
  qty: number;
  availability: Availability;
  eta: string;
  product?: ProductItem;
  ekNet: number | null;
  ekSource: EkSource;
  uvp: number | null;
}

export type EkSource = 'metafeld' | 'preisliste' | 'stufe';

const round2 = (n: number) => Math.round(n * 100) / 100;

export class Catalog {
  private stock: StockItem[] = [];
  private products = new Map<string, ProductItem>();
  private priceList = new Map<string, number>();
  stockUpdatedAt: string | null = null;
  productsUpdatedAt: string | null = null;
  private allowedLocations: Set<string> | null;

  constructor(private readonly cfg: Config, private readonly shopify: ShopifyGateway, private readonly db: DB) {
    const ids = cfg.DROPSHIP_LOCATION_IDS.split(',').map((s) => s.trim()).filter(Boolean);
    this.allowedLocations = ids.length ? new Set(ids.map((id) => toGid('Location', id))) : null;
    // nach Neustart sofort aus dem letzten Snapshot liefern
    const saved = kvGet<{ stock: StockItem[]; at: string }>(db, 'snapshot.stock');
    if (saved) { this.stock = saved.stock; this.stockUpdatedAt = saved.at; }
    const savedP = kvGet<{ products: ProductItem[]; prices: [string, number][]; at: string }>(db, 'snapshot.products');
    if (savedP) {
      this.products = new Map(savedP.products.map((p) => [p.variantId, p]));
      this.priceList = new Map(savedP.prices);
      this.productsUpdatedAt = savedP.at;
    }
  }

  async refreshStock() {
    const stock = await this.shopify.fetchStock();
    this.stock = stock;
    this.stockUpdatedAt = new Date().toISOString();
    kvSet(this.db, 'snapshot.stock', { stock, at: this.stockUpdatedAt });
    log.info('bestand aktualisiert', { varianten: stock.length });
  }

  async refreshProducts() {
    const [products, prices] = await Promise.all([this.shopify.fetchProducts(), this.shopify.fetchPriceList()]);
    this.products = new Map(products.map((p) => [p.variantId, p]));
    this.priceList = prices;
    this.productsUpdatedAt = new Date().toISOString();
    kvSet(this.db, 'snapshot.products', { products, prices: [...prices], at: this.productsUpdatedAt });
    log.info('produktdaten aktualisiert', { varianten: products.length, preisliste: prices.size });
  }

  /** Webhook inventory_levels/update: Snapshot direkt patchen, ohne API-Aufruf. */
  applyInventoryLevel(inventoryItemId: string, locationId: string, available: number): boolean {
    const item = this.stock.find((s) => s.inventoryItemId === toGid('InventoryItem', inventoryItemId));
    if (!item) return false;
    item.levels[toGid('Location', locationId)] = available;
    this.stockUpdatedAt = new Date().toISOString();
    kvSet(this.db, 'snapshot.stock', { stock: this.stock, at: this.stockUpdatedAt });
    return true;
  }

  /** Nach Order-Anlage sofort lokal abziehen; der nächste Webhook/Abgleich setzt den echten Wert. */
  reserve(variantId: string, qty: number) {
    const item = this.stock.find((s) => s.variantId === variantId);
    if (!item || !item.tracked) return;
    const locs = Object.entries(item.levels).filter(([loc]) => !this.allowedLocations || this.allowedLocations.has(loc));
    let rest = qty;
    for (const [loc, q] of locs.sort((a, b) => b[1] - a[1])) {
      const take = Math.min(Math.max(q, 0), rest);
      item.levels[loc] = q - take;
      rest -= take;
      if (rest <= 0) break;
    }
  }

  available(item: StockItem): number {
    if (!item.tracked) return Number.POSITIVE_INFINITY;
    return Object.entries(item.levels)
      .filter(([loc]) => !this.allowedLocations || this.allowedLocations.has(loc))
      .reduce((sum, [, q]) => sum + Math.max(0, q), 0);
  }

  /** EK netto. tierPercent ersetzt den Standardrabatt und die Preisliste, nicht das Metafeld dropship.ek. */
  pricing(variantId: string, tierPercent?: number | null): { ekNet: number | null; ekSource: EkSource } {
    const p = this.products.get(variantId);
    const taxFactor = 1 + this.cfg.TAX_RATE_PERCENT / 100;
    const net = (v: number) => (this.cfg.PRICES_INCLUDE_TAX ? v / taxFactor : v);
    if (p?.meta.ek && !Number.isNaN(Number(p.meta.ek))) return { ekNet: round2(Number(p.meta.ek)), ekSource: 'metafeld' };
    if (tierPercent != null && !Number.isNaN(tierPercent)) {
      if (!p) return { ekNet: null, ekSource: 'stufe' };
      return { ekNet: round2(net(p.price) * (1 - tierPercent / 100)), ekSource: 'stufe' };
    }
    const pl = this.priceList.get(variantId);
    if (pl !== undefined) return { ekNet: round2(net(pl)), ekSource: 'preisliste' };
    if (!p) return { ekNet: null, ekSource: 'stufe' };
    return { ekNet: round2(net(p.price) * (1 - this.cfg.DEFAULT_EK_DISCOUNT_PERCENT / 100)), ekSource: 'stufe' };
  }

  ekNet(variantId: string, tierPercent?: number | null): number | null {
    return this.pricing(variantId, tierPercent).ekNet;
  }

  items(tierPercent?: number | null): FeedItem[] {
    return this.stock
      .filter((s) => s.sku)
      .map((s) => {
        const product = this.products.get(s.variantId);
        const meta = product?.meta ?? {};
        const qty = publishedQty(this.available(s), this.cfg.STOCK_BUFFER, this.cfg.STOCK_CAP);
        const discontinued = ['true', '1', 'ja'].includes((meta.ausgelaufen ?? '').toLowerCase());
        const availability: Availability = discontinued ? 'ausgelaufen' : qty > 0 ? 'lieferbar' : meta.eta ? 'nachschub' : 'nicht_lieferbar';
        const priced = this.pricing(s.variantId, tierPercent);
        return {
          sku: s.sku,
          ean: s.barcode,
          variantId: s.variantId,
          qty: discontinued ? 0 : qty,
          availability,
          eta: meta.eta ?? '',
          product,
          ekNet: priced.ekNet,
          ekSource: priced.ekSource,
          uvp: product ? product.price : null,
        };
      })
      .sort((a, b) => a.sku.localeCompare(b.sku));
  }

  bySku(sku: string): FeedItem | undefined {
    const norm = sku.trim().toUpperCase();
    return this.items().find((i) => i.sku.toUpperCase() === norm);
  }

  /** Rabatt in %, damit eine Shopify-Zeile auf den EK kommt. undefined = Shopify-Katalog regelt den Preis. */
  lineDiscountPercent(variantId: string, catalogApplies: boolean, tierPercent?: number | null): number | undefined {
    if (catalogApplies && this.cfg.B2B_PRICE_LIST_ID) return undefined;
    const p = this.products.get(variantId);
    const ek = this.ekNet(variantId, tierPercent);
    if (!p || ek === null || p.price <= 0) return undefined;
    const ekInStoreTerms = this.cfg.PRICES_INCLUDE_TAX ? ek * (1 + this.cfg.TAX_RATE_PERCENT / 100) : ek;
    const pct = (1 - ekInStoreTerms / p.price) * 100;
    return pct > 0 ? Math.round(pct * 10000) / 10000 : undefined;
  }

  stats() {
    return {
      variants: this.stock.length,
      products: this.products.size,
      priceList: this.priceList.size,
      stockUpdatedAt: this.stockUpdatedAt,
      productsUpdatedAt: this.productsUpdatedAt,
    };
  }
}
