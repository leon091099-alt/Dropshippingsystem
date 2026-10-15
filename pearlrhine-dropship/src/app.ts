import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { html } from 'hono/html';
import type { Deps } from './deps.js';
import { log } from './log.js';
import { authRoutes } from './routes/auth.js';
import { adminRoutes } from './routes/admin.js';
import { publicRoutes } from './routes/public.js';
import { retailerPage } from './routes/retailer-page.js';
import { layout } from './views/layout.js';

export function createApp(d: Deps) {
  const app = new Hono();
  app.get('/', (c) => c.html(layout('PearlRhine Dropship', html`
    <h1>PearlRhine Dropship</h1>
    <div class="card">
      <p>Shopify-App für Produktfeeds und Lagerbestände. Angebundene Händler lesen Bestand und Produktdaten und geben Bestellungen an den B2B-Shop weiter.</p>
      <p><a class="btn" href="/admin">Admin</a></p>
      ${d.cfg.SHOPIFY_CLIENT_ID ? html`<p class="note"><a href="/auth?shop=${d.cfg.SHOPIFY_STORE}">Mit Shopify verbinden</a></p>` : ''}
    </div>`)));
  app.route('/', authRoutes(d.cfg, d.db));
  app.route('/', publicRoutes(d));
  app.route('/', retailerPage(d));
  app.route('/', adminRoutes(d));
  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    log.error('unbehandelter fehler', { path: c.req.path, error: String(err) });
    return c.text('Interner Fehler', 500);
  });
  return app;
}
