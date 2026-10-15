import type { RealShopifyGateway } from './gateway.js';
import { WEBHOOK_TOPICS } from '../webhooks.js';

const norm = (uri: string) => uri.replace(/\/$/, '');

/** Legt fehlende Admin-API-Webhooks an. Topics aus shopify.app.toml nicht noch einmal anlegen. */
export async function ensureWebhooks(gw: RealShopifyGateway, baseUrl: string): Promise<{ created: string[]; skipped: string[]; failed: string[] }> {
  const uri = `${baseUrl.replace(/\/$/, '')}/webhooks/shopify`;
  const existing = await gw.listWebhooks();
  const created: string[] = [];
  const skipped: string[] = [];
  const failed: string[] = [];
  for (const topic of WEBHOOK_TOPICS) {
    if (existing.some((e) => e.topic === topic && norm(e.uri) === norm(uri))) {
      skipped.push(topic);
      continue;
    }
    try {
      await gw.registerWebhook(topic, uri);
      created.push(topic);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/already been taken|already exists/i.test(msg)) skipped.push(topic);
      else failed.push(`${topic}: ${msg}`);
    }
  }
  return { created, skipped, failed };
}
