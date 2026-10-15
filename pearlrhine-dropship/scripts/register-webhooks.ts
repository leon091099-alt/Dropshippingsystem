/**
 * Registriert die Shopify-Webhooks auf BASE_URL/webhooks/shopify.
 * Einmalig, wenn die App kein shopify.app.toml nutzt:  npm run register-webhooks
 * Mit Dev-Dashboard-App die Topics in shopify.app.toml lassen und REGISTER_WEBHOOKS=false halten.
 */
import { loadConfig } from '../src/config.js';
import { RealShopifyGateway } from '../src/shopify/gateway.js';
import { ensureWebhooks } from '../src/shopify/register-webhooks.js';

const cfg = loadConfig();
const gw = new RealShopifyGateway(cfg);
const { created, skipped, failed } = await ensureWebhooks(gw, cfg.BASE_URL);
for (const topic of created) console.log(`✓ ${topic}`);
for (const topic of skipped) console.log(`• ${topic} bereits vorhanden`);
for (const topic of failed) console.error(`✗ ${topic}`);
if (failed.length) process.exitCode = 1;
