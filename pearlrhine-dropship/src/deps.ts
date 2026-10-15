import { Catalog } from './catalog.js';
import type { Config } from './config.js';
import type { DB } from './db.js';
import { log } from './log.js';
import { OrderService } from './orders/service.js';
import { Retailers } from './retailers.js';
import type { ShopifyGateway } from './shopify/types.js';
import { WebhookHandler } from './webhooks.js';

export interface Deps {
  cfg: Config;
  db: DB;
  shopify: ShopifyGateway;
  catalog: Catalog;
  retailers: Retailers;
  orders: OrderService;
  webhooks: WebhookHandler;
  jobs: { refreshStockNow(): Promise<void>; refreshProductsNow(): Promise<void>; scheduleProductRefresh(): void };
}

export function buildDeps(cfg: Config, db: DB, shopify: ShopifyGateway): Deps {
  const catalog = new Catalog(cfg, shopify, db);
  const retailers = new Retailers(db);

  let productTimer: NodeJS.Timeout | null = null;
  let stockTimer: NodeJS.Timeout | null = null;
  const scheduleStockRefresh = () => {
    if (stockTimer) return;
    stockTimer = setTimeout(() => {
      stockTimer = null;
      catalog.refreshStock().catch((e) => log.error('bestandsabgleich fehlgeschlagen', { error: String(e) }));
    }, 5_000);
    stockTimer.unref?.();
  };
  const jobs = {
    refreshStockNow: () => catalog.refreshStock(),
    refreshProductsNow: () => catalog.refreshProducts(),
    scheduleStockRefresh,
    // Produktänderungen bündeln (viele Webhooks bei Massenbearbeitung)
    scheduleProductRefresh: () => {
      if (productTimer) return;
      productTimer = setTimeout(() => {
        productTimer = null;
        catalog.refreshProducts().catch((e) => log.error('produktabgleich fehlgeschlagen', { error: String(e) }));
      }, 60_000);
      productTimer.unref?.();
    },
  };
  const orders = new OrderService(cfg, db, shopify, catalog, retailers, scheduleStockRefresh);
  const webhooks = new WebhookHandler(catalog, shopify, jobs.scheduleProductRefresh, scheduleStockRefresh, orders);
  return { cfg, db, shopify, catalog, retailers, orders, webhooks, jobs };
}
