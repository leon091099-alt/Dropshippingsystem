import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Catalog } from './catalog.js';
import { log } from './log.js';
import type { OrderService } from './orders/service.js';
import type { ShopifyGateway } from './shopify/types.js';

/** GraphQL-Enum-Namen. Die REST-Topics in shopify.app.toml müssen dazu passen. */
export const WEBHOOK_TOPICS = [
  'INVENTORY_LEVELS_UPDATE',
  'INVENTORY_LEVELS_CONNECT',
  'INVENTORY_LEVELS_DISCONNECT',
  'ORDERS_CREATE',
  'PRODUCTS_UPDATE',
  'FULFILLMENTS_CREATE',
  'FULFILLMENTS_UPDATE',
  'APP_UNINSTALLED',
] as const;

export function verifyHmac(rawBody: string, hmacHeader: string | undefined, secret: string): boolean {
  if (!hmacHeader || !secret) return false;
  const digest = createHmac('sha256', secret).update(rawBody, 'utf8').digest();
  const given = Buffer.from(hmacHeader, 'base64');
  return given.length === digest.length && timingSafeEqual(given, digest);
}

const norm = (s: unknown) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

/** B2B-Shop-Bestellung mit abweichender Lieferadresse = Dropship. */
export function isB2bDropship(order: any): boolean {
  if (!order?.company?.id) return false;
  const tags = String(order.tags ?? '').split(',').map((t) => t.trim());
  if (tags.includes('dropship')) return false;
  const s = order.shipping_address, b = order.billing_address;
  if (!s || !b) return false;
  return norm(s.address1) !== norm(b.address1) || norm(s.zip) !== norm(b.zip) || norm(s.name) !== norm(b.name);
}

export class WebhookHandler {
  private seen = new Map<string, number>();

  constructor(
    private readonly catalog: Catalog,
    private readonly shopify: ShopifyGateway,
    private readonly scheduleProductRefresh: () => void,
    private readonly scheduleStockRefresh: () => void,
    private readonly orders: OrderService,
  ) {}

  /** true = verarbeitet, false = Duplikat */
  async handle(topic: string, webhookId: string | undefined, payload: any): Promise<boolean> {
    if (webhookId) {
      if (this.seen.has(webhookId)) return false;
      this.seen.set(webhookId, Date.now());
      if (this.seen.size > 5000) {
        const cutoff = Date.now() - 3600_000;
        for (const [k, t] of this.seen) if (t < cutoff) this.seen.delete(k);
      }
    }

    switch (topic) {
      case 'inventory_levels/update': {
        const available = Number(payload.available ?? 0);
        const ok = Number.isFinite(available)
          && this.catalog.applyInventoryLevel(String(payload.inventory_item_id), String(payload.location_id), available);
        if (!ok) {
          log.info('inventory webhook außerhalb des snapshots, vollabgleich folgt', { item: payload.inventory_item_id });
          this.scheduleStockRefresh();
        }
        break;
      }
      case 'inventory_levels/connect':
      case 'inventory_levels/disconnect':
        this.scheduleStockRefresh();
        break;
      case 'orders/create': {
        if (isB2bDropship(payload)) {
          await this.shopify.addOrderTags(payload.admin_graphql_api_id, ['dropship', 'kanal-b2b_shop']);
          log.info('b2b-shop-bestellung als dropship markiert', { order: payload.name });
        }
        break;
      }
      case 'products/update':
        this.scheduleProductRefresh();
        break;
      case 'fulfillments/create':
      case 'fulfillments/update':
        this.orders.applyFulfillment(payload);
        break;
      case 'customers/data_request':
      case 'customers/redact':
      case 'shop/redact':
        this.orders.handleCompliance(topic, payload);
        break;
      case 'app/uninstalled':
        log.warn('shopify-app deinstalliert, token wird beim nächsten aufruf erneuert oder ungültig', { shop: payload?.domain ?? payload?.myshopify_domain });
        break;
      default:
        log.warn('unbekanntes webhook-topic', { topic });
    }
    return true;
  }
}
