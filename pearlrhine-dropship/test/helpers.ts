import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { buildDeps } from '../src/deps.js';
import { resetRateLimits } from '../src/ratelimit.js';
import { MockShopifyGateway } from '../src/shopify/mock.js';

export async function setup(env: Record<string, string> = {}) {
  resetRateLimits();
  const cfg = loadConfig({
    SHOPIFY_STORE: 'test.myshopify.com', MOCK_SHOPIFY: 'true', ADMIN_PASSWORD: 'geheim123',
    SHOPIFY_WEBHOOK_SECRET: 'whsec', BASE_URL: 'https://dropship.example.com', DATA_DIR: ':memory:', ...env,
  });
  const db = openDb(':memory:');
  const shopify = new MockShopifyGateway();
  const deps = buildDeps(cfg, db, shopify);
  await deps.catalog.refreshProducts();
  await deps.catalog.refreshStock();
  const app = createApp(deps);
  const { retailer, apiKey } = deps.retailers.create({
    name: 'Foto Schmidt', email: 'shop@foto-schmidt.de', return_mode: 'retailer', auto_accept: true,
    sender_address: { name: 'Foto Schmidt', company: 'Foto Schmidt GmbH', address1: 'Hauptstr. 5', zip: '10115', city: 'Berlin', countryCode: 'DE' },
  });
  const adminAuth = 'Basic ' + Buffer.from('admin:geheim123').toString('base64');
  return { cfg, db, shopify, deps, app, retailer, apiKey, adminAuth };
}

export const order = (over: Record<string, unknown> = {}) => ({
  reference: 'A-1001',
  shippingAddress: { name: 'Erika Musterfrau', address1: 'Ringstraße 7', zip: '50667', city: 'Köln', countryCode: 'DE' },
  lines: [{ sku: 'DF-TRIPOD-01', quantity: 2 }],
  ...over,
});
