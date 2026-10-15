import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { buildDeps } from './deps.js';
import { log } from './log.js';
import { RealShopifyGateway } from './shopify/gateway.js';
import { MockShopifyGateway } from './shopify/mock.js';
import { ensureWebhooks } from './shopify/register-webhooks.js';

const cfg = loadConfig();
const db = openDb(cfg.DATA_DIR);
const shopify = cfg.MOCK_SHOPIFY ? new MockShopifyGateway() : new RealShopifyGateway(cfg, db);
const deps = buildDeps(cfg, db, shopify);

/** Wiederkehrender Job ohne Überlappung */
function every(minutes: number, name: string, fn: () => Promise<void>) {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try { await fn(); } catch (e) { log.error(`job ${name} fehlgeschlagen`, { error: String(e) }); }
    finally { running = false; }
  };
  void run();
  setInterval(run, minutes * 60_000);
}

every(cfg.PRODUCT_REFRESH_MINUTES, 'produkte', () => deps.catalog.refreshProducts());
every(cfg.STOCK_REFRESH_MINUTES, 'bestand', () => deps.catalog.refreshStock());

if (!cfg.MOCK_SHOPIFY && cfg.REGISTER_WEBHOOKS && shopify instanceof RealShopifyGateway) {
  void ensureWebhooks(shopify, cfg.BASE_URL).catch((e) => log.error('webhook-registrierung fehlgeschlagen', { error: String(e) }));
}

serve({ fetch: createApp(deps).fetch, port: cfg.PORT }, (info) => {
  log.info('dropship-gateway läuft', { port: info.port, mock: cfg.MOCK_SHOPIFY, store: cfg.SHOPIFY_STORE });
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => { db.close(); process.exit(0); });
}
