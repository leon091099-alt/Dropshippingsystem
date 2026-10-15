import type { Catalog } from '../catalog.js';
import { allowedCountries, type Config } from '../config.js';
import type { DB } from '../db.js';
import { log } from '../log.js';
import { hasCompany, pricingTier, type Retailer, type Retailers } from '../retailers.js';
import { toGid } from '../shopify/client.js';
import type { Address, ShopifyGateway } from '../shopify/types.js';
import { formatIssues, orderSchema, type OrderPayload } from './schema.js';

export type OrderStatus =
  | 'on_hold' | 'accepted' | 'rejected' | 'error'
  | 'shipped' | 'cancel_requested' | 'cancelled' | 'returned';

export type Channel = 'api' | 'csv' | 'b2b_shop';

export interface Tracking { company: string | null; number: string | null; url: string | null }

export interface OrderRow {
  id: number;
  retailer_id: number;
  reference: string;
  channel: Channel;
  status: OrderStatus;
  payload: OrderPayload;
  problems: string[];
  shopify_order_id: string | null;
  shopify_order_name: string | null;
  tracking: Tracking[];
  status_checked_at: string | null;
  created_at: string;
  updated_at: string;
}

export class ValidationError extends Error {
  constructor(readonly issues: string[]) { super(issues.join('; ')); }
}

const STATUS_TTL_MS = 5 * 60 * 1000;

function hydrate(row: any): OrderRow {
  return {
    ...row,
    payload: JSON.parse(row.payload),
    problems: row.problems ? JSON.parse(row.problems) : [],
    tracking: row.tracking ? JSON.parse(row.tracking) : [],
  };
}

export const formatAddress = (a: Address) =>
  [a.company, a.name, a.address1, a.address2, `${a.zip} ${a.city}`, a.countryCode].filter(Boolean).join(', ');

export class OrderService {
  constructor(
    private readonly cfg: Config,
    private readonly db: DB,
    private readonly shopify: ShopifyGateway,
    private readonly catalog: Catalog,
    private readonly retailers: Retailers,
    private readonly scheduleStockRefresh: () => void = () => {},
  ) {}

  /** Bestellung annehmen. Idempotent über (Händler, Bestellnummer). */
  async submit(retailer: Retailer, raw: unknown, channel: Channel): Promise<{ order: OrderRow; duplicate: boolean }> {
    const parsed = orderSchema.safeParse(raw);
    if (!parsed.success) throw new ValidationError(formatIssues(parsed.error));
    const payload = parsed.data;

    const existing = this.find(retailer.id, payload.reference);
    if (existing) return { order: existing, duplicate: true };

    const problems = this.check(payload);
    const status: OrderStatus = problems.length || !retailer.auto_accept ? 'on_hold' : 'accepted';
    const holdReasons = [...problems];
    if (!problems.length && !retailer.auto_accept) holdReasons.push('Händler im Prüfmodus: manuelle Freigabe nötig');

    let id: number;
    try {
      const info = this.db.prepare(
        `INSERT INTO orders (retailer_id, reference, channel, status, payload, problems) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(retailer.id, payload.reference, channel, status === 'accepted' ? 'on_hold' : status, JSON.stringify(payload), JSON.stringify(holdReasons));
      id = Number(info.lastInsertRowid);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('UNIQUE')) {
        const raced = this.find(retailer.id, payload.reference);
        if (raced) return { order: raced, duplicate: true };
      }
      throw e;
    }

    if (status === 'accepted') await this.pushToShopify(id);
    else log.info('bestellung in prüfliste', { id, reference: payload.reference, problems: holdReasons });
    return { order: this.get(id)!, duplicate: false };
  }

  /** Fachliche Prüfung gegen den aktuellen Snapshot. Leere Liste = automatisch annehmbar. */
  check(p: OrderPayload): string[] {
    const problems: string[] = [];
    if (!allowedCountries(this.cfg).includes(p.shippingAddress.countryCode)) {
      problems.push(`Lieferland ${p.shippingAddress.countryCode} wird nicht beliefert`);
    }
    const qtyBySku = new Map<string, number>();
    for (const l of p.lines) qtyBySku.set(l.sku.toUpperCase(), (qtyBySku.get(l.sku.toUpperCase()) ?? 0) + l.quantity);
    for (const [sku, qty] of qtyBySku) {
      const item = this.catalog.bySku(sku);
      if (!item) problems.push(`SKU ${sku} unbekannt`);
      else if (item.availability === 'ausgelaufen') problems.push(`SKU ${sku} ausgelaufen`);
      else if (qty > item.qty) problems.push(`SKU ${sku}: ${qty} bestellt, ${item.qty} verfügbar`);
    }
    return problems;
  }

  /** Freigabe aus der Prüfliste (überspringt Bestandsprüfung) oder Retry nach Fehler. */
  async approve(id: number) {
    const o = this.get(id);
    if (!o || !['on_hold', 'error'].includes(o.status)) throw new Error('Bestellung nicht freigebbar');
    await this.pushToShopify(id);
    return this.get(id)!;
  }

  reject(id: number, reason: string) {
    const o = this.get(id);
    if (!o || !['on_hold', 'error'].includes(o.status)) throw new Error('Bestellung nicht ablehnbar');
    this.setStatus(id, 'rejected', { problems: [...o.problems, `Abgelehnt: ${reason || 'ohne Angabe'}`] });
  }

  /** Storno-Wunsch des Händlers. Vor Anlage sofort, danach als Aufgabe für uns. */
  requestCancel(retailerId: number, reference: string): OrderRow {
    const o = this.find(retailerId, reference);
    if (!o) throw new ValidationError(['Bestellung nicht gefunden']);
    if (['on_hold', 'error'].includes(o.status)) this.setStatus(o.id, 'cancelled');
    else if (o.status === 'accepted') this.setStatus(o.id, 'cancel_requested');
    else throw new ValidationError([`Storno im Status ${o.status} nicht möglich`]);
    return this.get(o.id)!;
  }

  /** Storno in Shopify erledigt -> im Admin bestätigen */
  confirmCancel(id: number) {
    const o = this.get(id);
    if (o?.status !== 'cancel_requested') throw new Error('Kein offener Storno-Wunsch');
    this.setStatus(id, 'cancelled');
    this.scheduleStockRefresh();
  }

  private async pushToShopify(id: number) {
    const o = this.get(id)!;
    const r = this.retailers.get(o.retailer_id)!;
    const p = o.payload;
    try {
      const tier = pricingTier(r, Boolean(this.cfg.B2B_PRICE_LIST_ID));
      const lines = p.lines.map((l) => {
        const item = this.catalog.bySku(l.sku);
        if (!item) throw new Error(`SKU ${l.sku} unbekannt`);
        return { variantId: item.variantId, quantity: l.quantity, discountPercent: this.catalog.lineDiscountPercent(item.variantId, hasCompany(r), tier) };
      });
      const paymentTermsTemplateId = hasCompany(r) || (this.cfg.PAYMENT_TERMS_DAYS <= 0 && !this.cfg.PAYMENT_TERMS_TEMPLATE_ID)
        ? undefined
        : (await this.shopify.resolvePaymentTermsTemplate()) ?? undefined;
      const taxFactor = this.cfg.PRICES_INCLUDE_TAX ? 1 + this.cfg.TAX_RATE_PERCENT / 100 : 1;
      const returnTo = r.return_mode === 'us' ? this.cfg.OUR_RETURN_ADDRESS : formatAddress(r.sender_address);
      const result = await this.shopify.createOrder({
        email: r.email,
        shippingAddress: p.shippingAddress,
        billingAddress: r.sender_address?.address1 ? r.sender_address : undefined,
        lines,
        fee: this.cfg.DROPSHIP_FEE_NET > 0 ? { title: 'Dropship-Pauschale', amount: Math.round(this.cfg.DROPSHIP_FEE_NET * taxFactor * 100) / 100 } : undefined,
        tags: ['dropship', `haendler-${r.id}`, `kanal-${o.channel}`],
        attributes: [
          { key: 'Händler', value: r.name },
          { key: 'Händler-Bestellnr', value: o.reference },
        ],
        // order.note ist im Lieferschein verfügbar -> Rücksendeadresse
        note: [`Bestellnummer: ${o.reference}`, returnTo ? `Rücksendungen an: ${returnTo}` : '', p.note ? `Hinweis Händler: ${p.note}` : ''].filter(Boolean).join('\n'),
        purchasingCompany: hasCompany(r)
          ? { companyId: r.company_id!, companyLocationId: r.company_location_id!, companyContactId: r.company_contact_id! }
          : undefined,
        paymentTermsTemplateId,
      });
      this.db.prepare(
        `UPDATE orders SET status='accepted', shopify_order_id=?, shopify_order_name=?, updated_at=datetime('now') WHERE id=?`,
      ).run(result.orderId, result.orderName, id);
      for (const l of lines) this.catalog.reserve(l.variantId, l.quantity);
      log.info('order in shopify angelegt', { id, reference: o.reference, order: result.orderName });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.setStatus(id, 'error', { problems: [...o.problems, `Shopify: ${msg}`] });
      log.error('order anlage fehlgeschlagen', { id, reference: o.reference, error: msg });
    }
  }

  /** Status inkl. Tracking aus Shopify nachziehen (gecacht). */
  async refreshStatus(o: OrderRow, force = false): Promise<OrderRow> {
    if (!o.shopify_order_id || !['accepted', 'shipped', 'cancel_requested'].includes(o.status)) return o;
    if (!force && o.status_checked_at && Date.now() - Date.parse(o.status_checked_at + 'Z') < STATUS_TTL_MS) return o;
    try {
      const s = await this.shopify.getOrderStatus(o.shopify_order_id);
      if (!s) return o;
      let status: OrderStatus = o.status;
      if (s.cancelled) status = 'cancelled';
      else if (['RETURNED', 'INSPECTION_COMPLETE'].includes(s.returnStatus)) status = 'returned';
      else if (['FULFILLED', 'PARTIALLY_FULFILLED'].includes(s.fulfillmentStatus)) status = 'shipped';
      if (status === 'cancelled' && o.status !== 'cancelled') this.scheduleStockRefresh();
      this.db.prepare(
        `UPDATE orders SET status=?, tracking=?, status_checked_at=datetime('now'), updated_at=CASE WHEN status<>? THEN datetime('now') ELSE updated_at END WHERE id=?`,
      ).run(status, JSON.stringify(s.tracking), status, o.id);
    } catch (e) {
      log.warn('status-abruf fehlgeschlagen', { id: o.id, error: String(e) });
    }
    return this.get(o.id)!;
  }

  get(id: number) {
    const row = this.db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
    return row ? hydrate(row) : undefined;
  }

  find(retailerId: number, reference: string) {
    const row = this.db.prepare('SELECT * FROM orders WHERE retailer_id = ? AND reference = ?').get(retailerId, reference.trim());
    return row ? hydrate(row) : undefined;
  }

  list(filter: { retailerId?: number; status?: OrderStatus[]; sinceDays?: number; limit?: number } = {}): OrderRow[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (filter.retailerId) { where.push('retailer_id = ?'); args.push(filter.retailerId); }
    if (filter.status?.length) { where.push(`status IN (${filter.status.map(() => '?').join(',')})`); args.push(...filter.status); }
    if (filter.sinceDays) { where.push(`created_at >= datetime('now', ?)`); args.push(`-${filter.sinceDays} days`); }
    const sql = `SELECT * FROM orders ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ${filter.limit ?? 200}`;
    return (this.db.prepare(sql).all(...args) as any[]).map(hydrate);
  }

  /** fulfillment-Webhook: Tracking schreiben und als versendet markieren. */
  applyFulfillment(payload: { order_id?: number | string; status?: string; tracking_company?: string | null; tracking_number?: string | null; tracking_url?: string | null; tracking_numbers?: string[]; tracking_urls?: string[] }): boolean {
    if (payload.order_id == null) return false;
    const row = this.db.prepare('SELECT * FROM orders WHERE shopify_order_id = ?').get(toGid('Order', String(payload.order_id)));
    if (!row) return false;
    const o = hydrate(row);
    const state = String(payload.status ?? '').toLowerCase();
    if (state === 'cancelled' || state === 'failure' || state === 'error') return true;
    const numbers = payload.tracking_numbers?.length ? payload.tracking_numbers : payload.tracking_number ? [payload.tracking_number] : [];
    const urls = payload.tracking_urls?.length ? payload.tracking_urls : payload.tracking_url ? [payload.tracking_url] : [];
    const incoming = numbers.map((number, i) => ({ company: payload.tracking_company ?? null, number, url: urls[i] ?? urls[0] ?? null }));
    const merged = new Map(o.tracking.filter((t) => t.number).map((t) => [t.number as string, t]));
    for (const t of incoming) if (t.number) merged.set(t.number, t);
    const tracking = incoming.length ? [...merged.values()] : o.tracking;
    const status: OrderStatus = ['accepted', 'cancel_requested'].includes(o.status) ? 'shipped' : o.status;
    this.db.prepare(
      `UPDATE orders SET status=?, tracking=?, status_checked_at=datetime('now'), updated_at=datetime('now') WHERE id=?`,
    ).run(status, JSON.stringify(tracking), o.id);
    return true;
  }

  /** Pflicht-Webhooks der Shopify-App: Adressen zu genannten Orders schwärzen. Shop-Daten löscht der Betrieb manuell. */
  handleCompliance(topic: string, payload: { shop_domain?: string; orders_to_redact?: number[] }) {
    log.info('compliance webhook', { topic, shop: payload?.shop_domain });
    if (topic === 'customers/redact') {
      for (const id of payload.orders_to_redact ?? []) this.redactShopifyOrder(id);
    }
    if (topic === 'shop/redact') {
      log.warn('shop/redact: Bestände und Händler liegen in der lokalen Datenbank und werden nicht automatisch gelöscht', { shop: payload?.shop_domain });
    }
  }

  private redactShopifyOrder(numericId: number) {
    const row = this.db.prepare('SELECT * FROM orders WHERE shopify_order_id = ?').get(toGid('Order', String(numericId)));
    if (!row) return;
    const o = hydrate(row);
    const payload: OrderPayload = {
      ...o.payload,
      note: '',
      shippingAddress: { name: 'geschwärzt', company: '', address1: 'geschwärzt', address2: '', zip: '00000', city: 'geschwärzt', countryCode: o.payload.shippingAddress.countryCode, phone: '' },
    };
    this.db.prepare(`UPDATE orders SET payload=?, updated_at=datetime('now') WHERE id=?`).run(JSON.stringify(payload), o.id);
  }

  private setStatus(id: number, status: OrderStatus, extra: { problems?: string[] } = {}) {
    if (extra.problems) {
      this.db.prepare(`UPDATE orders SET status=?, problems=?, updated_at=datetime('now') WHERE id=?`).run(status, JSON.stringify(extra.problems), id);
    } else {
      this.db.prepare(`UPDATE orders SET status=?, updated_at=datetime('now') WHERE id=?`).run(status, id);
    }
  }
}

/** Öffentliche Sicht für Händler (API, Händlerseite) */
export const publicOrder = (o: OrderRow) => ({
  reference: o.reference,
  // interne Fehler sieht der Händler als Prüfung
  status: o.status === 'error' ? 'on_hold' : o.status,
  channel: o.channel,
  order_name: o.shopify_order_name,
  tracking: o.tracking,
  problems: o.status === 'error'
    ? ['Wird von uns geprüft']
    : o.status === 'on_hold' || o.status === 'rejected' ? o.problems.filter((p) => !p.startsWith('Shopify:')) : [],
  created_at: o.created_at,
  updated_at: o.updated_at,
});
