import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Config } from '../config.js';
import { kvGet, kvSet, type DB } from '../db.js';
import { ADMIN_SCOPES } from './scopes.js';

export const OAUTH_TOKEN_KEY = 'shopify.oauth';
const STATE_KEY = 'shopify.oauth.state';

export interface StoredOauth {
  access_token: string;
  scope?: string;
  refresh_token?: string;
  /** Ablauf des Access-Tokens, Epoch-ms. Fehlt = nicht ablaufend. */
  expires_at?: number;
  shop: string;
}

export function shopHost(shop: string): string {
  return shop.replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();
}

export function shopMatches(cfg: Config, shop: string): boolean {
  return shopHost(shop) === shopHost(cfg.SHOPIFY_STORE) && shopHost(shop).endsWith('.myshopify.com');
}

/** HMAC der OAuth-Query (hex), ohne die Parameter hmac und signature. */
export function verifyOauthHmac(params: URLSearchParams, secret: string): boolean {
  const given = params.get('hmac');
  if (!given || !secret) return false;
  const pairs: [string, string][] = [];
  for (const [key, value] of params) {
    if (key === 'hmac' || key === 'signature') continue;
    pairs.push([key, value]);
  }
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const message = pairs.map(([key, value]) => `${key}=${value}`).join('&');
  const digest = createHmac('sha256', secret).update(message).digest('hex');
  const a = Buffer.from(digest);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function newOauthState(): string {
  return randomBytes(16).toString('hex');
}

export function saveOauthState(db: DB, state: string) {
  kvSet(db, STATE_KEY, { state, at: Date.now() });
}

export function takeOauthState(db: DB, state: string): boolean {
  const saved = kvGet<{ state: string; at: number }>(db, STATE_KEY);
  kvSet(db, STATE_KEY, { state: '', at: 0 });
  return Boolean(saved && saved.state && saved.state === state && Date.now() - saved.at < 10 * 60_000);
}

export function installUrl(cfg: Config, shop: string, state: string): string {
  const url = new URL(`https://${shopHost(shop)}/admin/oauth/authorize`);
  url.searchParams.set('client_id', cfg.SHOPIFY_CLIENT_ID ?? '');
  url.searchParams.set('scope', ADMIN_SCOPES);
  url.searchParams.set('redirect_uri', `${cfg.BASE_URL}/auth/callback`);
  url.searchParams.set('state', state);
  return url.toString();
}

export async function exchangeCode(cfg: Config, shop: string, code: string, fetchImpl: typeof fetch = fetch): Promise<StoredOauth> {
  const res = await fetchImpl(`https://${shopHost(shop)}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_id: cfg.SHOPIFY_CLIENT_ID ?? '',
      client_secret: cfg.SHOPIFY_CLIENT_SECRET ?? '',
      code,
    }),
  });
  if (!res.ok) throw new Error(`OAuth-Tausch HTTP ${res.status}`);
  const body = (await res.json()) as { access_token?: string; scope?: string; expires_in?: number; refresh_token?: string };
  if (!body.access_token) throw new Error('OAuth-Antwort ohne access_token');
  return {
    access_token: body.access_token,
    scope: body.scope,
    refresh_token: body.refresh_token,
    expires_at: body.expires_in ? Date.now() + body.expires_in * 1000 : undefined,
    shop: shopHost(shop),
  };
}

export function readOauth(db: DB): StoredOauth | undefined {
  return kvGet<StoredOauth>(db, OAUTH_TOKEN_KEY);
}

export function writeOauth(db: DB, token: StoredOauth) {
  kvSet(db, OAUTH_TOKEN_KEY, token);
}
