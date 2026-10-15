import { Hono, type Context } from 'hono';
import { webhookSecret } from '../config.js';
import type { Deps } from '../deps.js';
import { renderFeed, type FeedFormat, type FeedKind } from '../feeds.js';
import { log } from '../log.js';
import { publicOrder, ValidationError } from '../orders/service.js';
import { pricingTier, type Retailer } from '../retailers.js';
import { verifyHmac } from '../webhooks.js';
import { rateLimit } from '../ratelimit.js';

const FEED_RE = /^(stock|products)\.(csv|json|xml)$/;

export function publicRoutes(d: Deps) {
  const app = new Hono<{ Variables: { retailer: Retailer } }>();

  app.get('/health', (c) => c.json({ ok: true, ...d.catalog.stats() }));

  // Feeds: /feed/<token>/stock.csv | products.xml | ...
  app.get('/feed/:token/:file', (c) => {
    const r = d.retailers.byFeedToken(c.req.param('token'));
    if (!r) return c.text('Unbekannter Feed', 404);
    if (!rateLimit(`feed:${r.id}`, 60)) return c.text('Zu viele Abrufe (max. 60 pro Minute)', 429);
    const m = FEED_RE.exec(c.req.param('file'));
    if (!m) return c.text('Feeds: stock.csv|json|xml, products.csv|json|xml', 404);
    const tier = pricingTier(r, Boolean(d.cfg.B2B_PRICE_LIST_ID));
    const feed = renderFeed(m[1] as FeedKind, m[2] as FeedFormat, d.catalog.items(tier), d.cfg, d.catalog.stockUpdatedAt);
    return c.body(feed.body, 200, { 'Content-Type': feed.contentType, 'Cache-Control': 'no-store' });
  });

  // REST-API für Händler
  const api = new Hono<{ Variables: { retailer: Retailer } }>();
  api.use('*', async (c, next) => {
    const key = (c.req.header('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    const r = key ? d.retailers.byApiKey(key) : undefined;
    if (!r) return c.json({ error: 'unauthorized' }, 401);
    if (!rateLimit(`api:${r.id}`, 120)) return c.json({ error: 'rate_limited' }, 429);
    c.set('retailer', r);
    await next();
  });

  api.get('/stock', (c) => {
    const items = d.catalog.items().map((i) => ({ sku: i.sku, ean: i.ean, quantity: i.qty, status: i.availability, eta: i.eta }));
    return c.json({ stock_at: d.catalog.stockUpdatedAt, items });
  });

  api.post('/orders', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body) return c.json({ error: 'invalid_json' }, 400);
    try {
      const { order, duplicate } = await d.orders.submit(c.get('retailer'), body, 'api');
      return c.json(publicOrder(order), duplicate ? 200 : 201);
    } catch (e) {
      return handleError(c, e);
    }
  });

  api.get('/orders', async (c) => {
    const days = Math.min(Number(c.req.query('days') ?? 30) || 30, 365);
    const list = d.orders.list({ retailerId: c.get('retailer').id, sinceDays: days, limit: 500 });
    return c.json({ orders: list.map(publicOrder) });
  });

  api.get('/orders/:reference{.+}', async (c) => {
    const ref = c.req.param('reference');
    if (ref.endsWith('/cancel')) return c.notFound();
    const o = d.orders.find(c.get('retailer').id, decodeURIComponent(ref));
    if (!o) return c.json({ error: 'not_found' }, 404);
    return c.json(publicOrder(await d.orders.refreshStatus(o)));
  });

  api.post('/orders/:reference{.+}/cancel', (c) => {
    try {
      const o = d.orders.requestCancel(c.get('retailer').id, decodeURIComponent(c.req.param('reference')));
      return c.json(publicOrder(o));
    } catch (e) {
      return handleError(c, e);
    }
  });

  app.route('/api', api);

  // Shopify-Webhooks
  app.post('/webhooks/shopify', async (c) => {
    const raw = await c.req.text();
    if (!verifyHmac(raw, c.req.header('X-Shopify-Hmac-Sha256'), webhookSecret(d.cfg))) {
      log.warn('webhook mit ungültiger signatur');
      return c.text('invalid hmac', 401);
    }
    const topic = c.req.header('X-Shopify-Topic') ?? '';
    // schnell 200 antworten, Verarbeitung asynchron (Shopify erwartet < 5 s)
    queueMicrotask(() => {
      d.webhooks.handle(topic, c.req.header('X-Shopify-Webhook-Id'), JSON.parse(raw))
        .catch((e) => log.error('webhook-verarbeitung fehlgeschlagen', { topic, error: String(e) }));
    });
    return c.text('ok');
  });

  return app;
}

function handleError(c: Context, e: unknown) {
  if (e instanceof ValidationError) return c.json({ error: 'validation', issues: e.issues }, 422);
  log.error('api-fehler', { error: String(e) });
  return c.json({ error: 'internal' }, 500);
}
