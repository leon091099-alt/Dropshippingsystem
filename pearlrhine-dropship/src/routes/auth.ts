import { Hono } from 'hono';
import type { Config } from '../config.js';
import type { DB } from '../db.js';
import { log } from '../log.js';
import { exchangeCode, installUrl, newOauthState, saveOauthState, shopMatches, takeOauthState, verifyOauthHmac, writeOauth } from '../shopify/oauth.js';

/** Einmaliger Install-Redirect der Dev-Dashboard-App. Der laufende Token kommt danach aus OAuth oder Client-Credentials. */
export function authRoutes(cfg: Config, db: DB) {
  const app = new Hono();

  app.get('/auth', (c) => {
    const shop = c.req.query('shop') ?? '';
    if (!shopMatches(cfg, shop)) return c.text('Unbekannter Shop', 400);
    if (!cfg.SHOPIFY_CLIENT_ID || !cfg.SHOPIFY_CLIENT_SECRET) return c.text('SHOPIFY_CLIENT_ID und SHOPIFY_CLIENT_SECRET fehlen', 500);
    const state = newOauthState();
    saveOauthState(db, state);
    return c.redirect(installUrl(cfg, shop, state));
  });

  app.get('/auth/callback', async (c) => {
    const params = new URL(c.req.url).searchParams;
    const secret = cfg.SHOPIFY_CLIENT_SECRET ?? '';
    if (!verifyOauthHmac(params, secret)) return c.text('ungültige signatur', 401);
    const shop = params.get('shop') ?? '';
    const code = params.get('code') ?? '';
    const state = params.get('state') ?? '';
    if (!shopMatches(cfg, shop) || !code) return c.text('ungültiger callback', 400);
    if (!takeOauthState(db, state)) return c.text('state ungültig', 401);
    try {
      writeOauth(db, await exchangeCode(cfg, shop, code));
    } catch (e) {
      log.error('oauth-tausch fehlgeschlagen', { error: String(e) });
      return c.text('Shopify hat den Code nicht eingelöst', 502);
    }
    return c.redirect('/admin?ok=' + encodeURIComponent('Shopify verbunden'));
  });

  return app;
}
