import { Hono } from 'hono';
import { html } from 'hono/html';
import { toCsv } from '../csv.js';
import type { Deps } from '../deps.js';
import { CSV_COLUMNS, csvToOrderPayloads } from '../orders/csv-import.js';
import { ValidationError, type OrderRow } from '../orders/service.js';
import { layout, statusBadge, trackingCell } from '../views/layout.js';

/** Händlerseite: erreichbar über persönlichen Link /h/<feed-token>. Kein Login nötig. */
export function retailerPage(d: Deps) {
  const app = new Hono();

  app.get('/h/:token', async (c) => {
    const r = d.retailers.byFeedToken(c.req.param('token'));
    if (!r) return c.text('Link ungültig', 404);
    const base = `${d.cfg.BASE_URL}/feed/${r.feed_token}`;
    const recent = d.orders.list({ retailerId: r.id, sinceDays: 60, limit: 100 });
    // Status der offenen Orders nachziehen (gecacht, max. 20 pro Aufruf)
    const refreshed: OrderRow[] = [];
    for (const [i, o] of recent.entries()) refreshed.push(i < 20 ? await d.orders.refreshStatus(o) : o);
    const flash = c.req.query('ok') ? html`<div class="flash">${c.req.query('ok')}</div>` : c.req.query('err') ? html`<div class="flash bad">${c.req.query('err')}</div>` : '';

    return c.html(layout(`Händlerbereich ${r.name}`, html`
      <h1>${r.name}</h1>${flash}
      <div class="card">
        <h2 style="margin-top:0">Feeds</h2>
        <p class="note">Bestand alle 5–15 Minuten abrufen, Produktdaten 1× täglich. Stand Bestand: ${d.catalog.stockUpdatedAt ?? '–'} · Preisstufe: ${r.ek_discount_percent == null ? `Standard ${d.cfg.DEFAULT_EK_DISCOUNT_PERCENT} %` : `${r.ek_discount_percent} %`}</p>
        <table>
          <tr><th>Feed</th><th>CSV</th><th>XML</th><th>JSON</th></tr>
          <tr><td>Bestand</td><td><code>${base}/stock.csv</code></td><td><a href="${base}/stock.xml">XML</a></td><td><a href="${base}/stock.json">JSON</a></td></tr>
          <tr><td>Produkte</td><td><code>${base}/products.csv</code></td><td><a href="${base}/products.xml">XML</a></td><td><a href="${base}/products.json">JSON</a></td></tr>
        </table>
      </div>
      <div class="card">
        <h2 style="margin-top:0">Bestellungen per CSV hochladen</h2>
        <p class="note">Eine Zeile pro Position, gleiche Bestellnummer = eine Bestellung. Trennzeichen ; oder ,. <a href="/h/${r.feed_token}/vorlage.csv">Vorlage herunterladen</a></p>
        <form method="post" action="/h/${r.feed_token}/upload" enctype="multipart/form-data">
          <input type="file" name="file" accept=".csv,text/csv" required>
          <p><button type="submit">Hochladen</button></p>
        </form>
      </div>
      <div class="card">
        <h2 style="margin-top:0">Bestellungen der letzten 60 Tage</h2>
        <p><a class="btn secondary" href="/h/${r.feed_token}/tracking.csv">Tracking als CSV</a></p>
        <table>
          <tr><th>Bestellnr.</th><th>Datum</th><th>Status</th><th>Tracking</th><th>Hinweis</th></tr>
          ${refreshed.map((o) => html`<tr>
            <td>${o.reference}</td><td>${o.created_at.slice(0, 16)}</td>
            <td>${statusBadge(o.status === 'error' ? 'on_hold' : o.status)}</td>
            <td>${trackingCell(o.tracking)}</td>
            <td class="note">${o.status === 'on_hold' || o.status === 'rejected' ? o.problems.filter((p) => !p.startsWith('Shopify:')).join('; ') : ''}</td>
          </tr>`)}
        </table>
      </div>`));
  });

  app.post('/h/:token/upload', async (c) => {
    const r = d.retailers.byFeedToken(c.req.param('token'));
    if (!r) return c.text('Link ungültig', 404);
    const form = await c.req.parseBody();
    const file = form.file;
    if (!(file instanceof File) || file.size === 0) return c.redirect(`/h/${r.feed_token}?err=${encodeURIComponent('Keine Datei')}`);
    if (file.size > 2_000_000) return c.redirect(`/h/${r.feed_token}?err=${encodeURIComponent('Datei zu groß (max. 2 MB)')}`);

    const { payloads, errors } = csvToOrderPayloads(await file.text());
    let created = 0, duplicates = 0, held = 0;
    for (const p of payloads) {
      try {
        const { order, duplicate } = await d.orders.submit(r, p, 'csv');
        if (duplicate) duplicates++; else created++;
        if (!duplicate && order.status === 'on_hold') held++;
      } catch (e) {
        const ref = (p as { reference?: string }).reference;
        errors.push(`${ref}: ${e instanceof ValidationError ? e.issues.join(', ') : 'interner Fehler'}`);
      }
    }
    const msg = `${created} Bestellung(en) übernommen${held ? `, davon ${held} in Prüfung` : ''}${duplicates ? `, ${duplicates} bereits vorhanden` : ''}.`;
    const q = errors.length ? `err=${encodeURIComponent(msg + ' Fehler: ' + errors.slice(0, 10).join(' | '))}` : `ok=${encodeURIComponent(msg)}`;
    return c.redirect(`/h/${r.feed_token}?${q}`);
  });

  app.get('/h/:token/vorlage.csv', (c) => {
    const r = d.retailers.byFeedToken(c.req.param('token'));
    if (!r) return c.text('Link ungültig', 404);
    const body = toCsv(CSV_COLUMNS, [
      ['A-1001', 'DF-TRIPOD-01', 1, 'Max Mustermann', '', 'Musterstraße 1', '', '50667', 'Köln', 'DE', '', ''],
      ['A-1001', 'DF-CAGE-03', 2, 'Max Mustermann', '', 'Musterstraße 1', '', '50667', 'Köln', 'DE', '', ''],
    ]);
    return c.body(body, 200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="bestellungen-vorlage.csv"' });
  });

  app.get('/h/:token/tracking.csv', async (c) => {
    const r = d.retailers.byFeedToken(c.req.param('token'));
    if (!r) return c.text('Link ungültig', 404);
    const list: OrderRow[] = [];
    for (const [i, o] of d.orders.list({ retailerId: r.id, sinceDays: 30, limit: 1000 }).entries()) {
      list.push(i < 50 ? await d.orders.refreshStatus(o) : o);
    }
    const rows = list.flatMap((o) => {
      const status = o.status === 'error' ? 'on_hold' : o.status;
      if (!o.tracking.length) return [[o.reference, status, '', '', '']];
      return o.tracking.map((t) => [o.reference, status, t.company ?? '', t.number ?? '', t.url ?? '']);
    });
    return c.body(toCsv(['bestellnummer', 'status', 'versanddienstleister', 'trackingnummer', 'tracking_url'], rows), 200, {
      'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="tracking.csv"',
    });
  });

  return app;
}
