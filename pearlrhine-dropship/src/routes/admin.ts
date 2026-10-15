import { Hono } from 'hono';
import { basicAuth } from 'hono/basic-auth';
import { html } from 'hono/html';
import type { Deps } from '../deps.js';
import type { Retailer, RetailerInput } from '../retailers.js';
import { layout, statusBadge, trackingCell } from '../views/layout.js';

const nav = html`<a href="/admin">Übersicht</a><a href="/admin/retailers">Händler</a><a href="/admin/orders">Bestellungen</a>`;
const page = (title: string, body: Parameters<typeof layout>[1]) => layout(title, body, nav);

export function adminRoutes(d: Deps) {
  const app = new Hono();
  app.use('/admin/*', basicAuth({ username: d.cfg.ADMIN_USER, password: d.cfg.ADMIN_PASSWORD }));
  app.use('/admin', basicAuth({ username: d.cfg.ADMIN_USER, password: d.cfg.ADMIN_PASSWORD }));

  const retailerName = (id: number) => d.retailers.get(id)?.name ?? `#${id}`;
  const flash = (q: string | undefined, bad = false) => (q ? html`<div class="flash ${bad ? 'bad' : ''}">${q}</div>` : '');

  app.get('/admin', (c) => {
    const s = d.catalog.stats();
    const hold = d.orders.list({ status: ['on_hold', 'error', 'cancel_requested'] });
    const items = d.catalog.items();
    return c.html(page('Übersicht', html`
      <h1>Übersicht</h1>${flash(c.req.query('ok'))}${flash(c.req.query('err'), true)}
      <div class="grid">
        <div class="card stat"><b>${s.variants}</b><span>Varianten im Feed</span></div>
        <div class="card stat"><b>${items.filter((i) => i.qty > 0).length}</b><span>davon lieferbar</span></div>
        <div class="card stat"><b>${hold.length}</b><span>offene Aufgaben</span></div>
        <div class="card stat"><b>${d.retailers.list().filter((r) => r.active).length}</b><span>aktive Händler</span></div>
      </div>
      <div class="card">
        <p class="note">Bestand: ${s.stockUpdatedAt ?? 'nie'} · Produktdaten: ${s.productsUpdatedAt ?? 'nie'} · Preisliste: ${s.priceList} Preise ·
        Regel: angezeigt = min(verfügbar − ${d.cfg.STOCK_BUFFER}, ${d.cfg.STOCK_CAP})</p>
        <form class="inline" method="post" action="/admin/refresh"><button class="secondary">Jetzt aus Shopify neu laden</button></form>
      </div>
      <h2>Aufgaben</h2>
      <div class="card">${hold.length ? orderTable(hold, retailerName, true) : html`<p class="note">Nichts zu tun.</p>`}</div>`));
  });

  app.post('/admin/refresh', async (c) => {
    try {
      await d.jobs.refreshStockNow();
      await d.jobs.refreshProductsNow();
      return c.redirect('/admin?ok=' + encodeURIComponent('Bestand und Produktdaten neu geladen'));
    } catch (e) {
      return c.redirect('/admin?err=' + encodeURIComponent(`Fehler: ${String(e)}`));
    }
  });

  app.get('/admin/orders', (c) => {
    const list = d.orders.list({ limit: 300 });
    return c.html(page('Bestellungen', html`<h1>Bestellungen</h1><div class="card">${orderTable(list, retailerName, true)}</div>`));
  });

  app.post('/admin/orders/:id/approve', async (c) => {
    try {
      const o = await d.orders.approve(Number(c.req.param('id')));
      return c.redirect(o.status === 'accepted'
        ? '/admin?ok=' + encodeURIComponent(`${o.reference} in Shopify angelegt (${o.shopify_order_name})`)
        : '/admin?err=' + encodeURIComponent(`${o.reference}: ${o.problems.at(-1) ?? 'Fehler'}`));
    } catch (e) {
      return c.redirect('/admin?err=' + encodeURIComponent(String(e)));
    }
  });

  app.post('/admin/orders/:id/reject', async (c) => {
    const form = await c.req.parseBody();
    try {
      d.orders.reject(Number(c.req.param('id')), String(form.reason ?? ''));
      return c.redirect('/admin?ok=abgelehnt');
    } catch (e) {
      return c.redirect('/admin?err=' + encodeURIComponent(String(e)));
    }
  });

  app.post('/admin/orders/:id/cancel-done', (c) => {
    try {
      d.orders.confirmCancel(Number(c.req.param('id')));
      return c.redirect('/admin?ok=' + encodeURIComponent('Storno bestätigt'));
    } catch (e) {
      return c.redirect('/admin?err=' + encodeURIComponent(String(e)));
    }
  });

  // Händler
  app.get('/admin/retailers', (c) => {
    const list = d.retailers.list();
    return c.html(page('Händler', html`
      <h1>Händler</h1>
      <p><a class="btn" href="/admin/retailers/new">Händler anlegen</a></p>
      <div class="card"><table>
        <tr><th>Name</th><th>E-Mail</th><th>B2B-Firma</th><th>Freigabe</th><th>Status</th><th></th></tr>
        ${list.map((r) => html`<tr>
          <td>${r.name}</td><td>${r.email}</td><td>${r.company_location_id ? 'verknüpft' : '–'}</td>
          <td>${r.auto_accept ? 'automatisch' : 'manuell'}</td><td>${r.active ? 'aktiv' : 'gesperrt'}</td>
          <td><a href="/admin/retailers/${r.id}">bearbeiten</a></td></tr>`)}
      </table></div>`));
  });

  app.get('/admin/retailers/new', (c) => c.html(page('Händler anlegen', html`<h1>Händler anlegen</h1>${retailerForm('/admin/retailers', d.cfg.DEFAULT_EK_DISCOUNT_PERCENT)}`)));

  app.post('/admin/retailers', async (c) => {
    const body = await c.req.parseBody();
    let input;
    try { input = formToRetailer(body); }
    catch (e) { return c.html(page('Händler anlegen', html`<h1>Händler anlegen</h1>${flash(e instanceof Error ? e.message : String(e), true)}${retailerForm('/admin/retailers', d.cfg.DEFAULT_EK_DISCOUNT_PERCENT)}`), 400); }
    if (!input.name || !input.email) return c.html(page('Händler anlegen', html`<h1>Händler anlegen</h1>${flash('Name und E-Mail sind Pflicht', true)}${retailerForm('/admin/retailers', d.cfg.DEFAULT_EK_DISCOUNT_PERCENT)}`), 400);
    const { retailer, apiKey } = d.retailers.create(input);
    return c.html(page('Händler angelegt', credentials(d, retailer, apiKey)));
  });

  app.get('/admin/retailers/:id', (c) => {
    const r = d.retailers.get(Number(c.req.param('id')));
    if (!r) return c.notFound();
    return c.html(page(r.name, html`
      <h1>${r.name}</h1>${flash(c.req.query('ok'))}${flash(c.req.query('err'), true)}
      ${links(d, r)}
      ${retailerForm(`/admin/retailers/${r.id}`, d.cfg.DEFAULT_EK_DISCOUNT_PERCENT, r)}
      <div class="card">
        <form class="inline" method="post" action="/admin/retailers/${r.id}/rotate-key" onsubmit="return confirm('Alter API-Key wird sofort ungültig. Fortfahren?')"><button class="secondary">Neuen API-Key erzeugen</button></form>
        <form class="inline" method="post" action="/admin/retailers/${r.id}/rotate-feed" onsubmit="return confirm('Feed-URLs und Händlerseite ändern sich. Fortfahren?')"><button class="danger">Feed-Link neu erzeugen</button></form>
      </div>`));
  });

  app.post('/admin/retailers/:id', async (c) => {
    const id = Number(c.req.param('id'));
    const current = d.retailers.get(id);
    if (!current) return c.notFound();
    try {
      d.retailers.update(id, formToRetailer(await c.req.parseBody()));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return c.html(page(current.name, html`<h1>${current.name}</h1>${flash(message, true)}${links(d, current)}${retailerForm(`/admin/retailers/${id}`, d.cfg.DEFAULT_EK_DISCOUNT_PERCENT, current)}`), 400);
    }
    return c.redirect(`/admin/retailers/${id}?ok=gespeichert`);
  });

  app.post('/admin/retailers/:id/rotate-key', (c) => {
    const r = d.retailers.get(Number(c.req.param('id')));
    if (!r) return c.notFound();
    return c.html(page('Neuer API-Key', credentials(d, r, d.retailers.rotateApiKey(r.id))));
  });

  app.post('/admin/retailers/:id/rotate-feed', (c) => {
    const id = Number(c.req.param('id'));
    d.retailers.rotateFeedToken(id);
    return c.redirect(`/admin/retailers/${id}?ok=${encodeURIComponent('Neuer Feed-Link erzeugt')}`);
  });

  return app;
}

function orderTable(list: ReturnType<Deps['orders']['list']>, retailerName: (id: number) => string, actions: boolean) {
  return html`<table>
    <tr><th>Datum</th><th>Händler</th><th>Bestellnr.</th><th>Kanal</th><th>Status</th><th>Shopify</th><th>Positionen</th><th>Tracking / Hinweise</th>${actions ? html`<th></th>` : ''}</tr>
    ${list.map((o) => html`<tr>
      <td>${o.created_at.slice(0, 16)}</td><td>${retailerName(o.retailer_id)}</td><td>${o.reference}</td><td>${o.channel}</td>
      <td>${statusBadge(o.status)}</td><td>${o.shopify_order_name ?? '–'}</td>
      <td>${o.payload.lines.map((l) => html`${l.quantity}× ${l.sku}<br>`)}<span class="note">${o.payload.shippingAddress.zip} ${o.payload.shippingAddress.city}</span></td>
      <td>${trackingCell(o.tracking)}${o.problems.length ? html`<ul class="plain note">${o.problems.map((p) => html`<li>${p}</li>`)}</ul>` : ''}</td>
      ${actions ? html`<td>${actionButtons(o)}</td>` : ''}
    </tr>`)}
  </table>`;
}

function actionButtons(o: { id: number; status: string }) {
  if (o.status === 'on_hold' || o.status === 'error') {
    return html`<form class="inline" method="post" action="/admin/orders/${o.id}/approve"><button>${o.status === 'error' ? 'Erneut senden' : 'Freigeben'}</button></form>
      <form method="post" action="/admin/orders/${o.id}/reject" style="margin-top:6px"><input name="reason" placeholder="Grund"><button class="danger" style="margin-top:4px">Ablehnen</button></form>`;
  }
  if (o.status === 'cancel_requested') {
    return html`<span class="note">In Shopify stornieren, dann:</span><form method="post" action="/admin/orders/${o.id}/cancel-done"><button class="secondary">Storno erledigt</button></form>`;
  }
  return '';
}

function retailerForm(action: string, defaultDiscount: number, r?: Retailer) {
  const a = r?.sender_address;
  return html`<form class="card" method="post" action="${action}">
    <div class="row">
      <div><label>Name (Firma)</label><input name="name" required value="${r?.name ?? ''}"></div>
      <div><label>E-Mail (bekommt Versandmails und Tracking)</label><input name="email" type="email" required value="${r?.email ?? ''}"></div>
    </div>
    <h2>Absender auf dem Lieferschein</h2>
    <div class="row">
      <div><label>Firma</label><input name="s_company" value="${a?.company ?? ''}"></div>
      <div><label>Ansprechpartner / Name</label><input name="s_name" value="${a?.name ?? ''}"></div>
      <div><label>Straße</label><input name="s_address1" value="${a?.address1 ?? ''}"></div>
      <div><label>Adresszusatz</label><input name="s_address2" value="${a?.address2 ?? ''}"></div>
      <div><label>PLZ</label><input name="s_zip" value="${a?.zip ?? ''}"></div>
      <div><label>Ort</label><input name="s_city" value="${a?.city ?? ''}"></div>
    </div>
    <label>Rücksendungen gehen an</label>
    <select name="return_mode">
      <option value="retailer" ${r?.return_mode !== 'us' ? 'selected' : ''}>Händler (Absenderadresse)</option>
      <option value="us" ${r?.return_mode === 'us' ? 'selected' : ''}>PearlRhine-Lager</option>
    </select>
    <label>EK-Rabatt in % (leer = Standard ${String(defaultDiscount)})</label>
    <p class="note">Leer lassen für den Standardrabatt. Eine Stufe gilt nur ohne B2B-Katalogpreis, sonst setzt Shopify den Katalog.</p>
    <input name="ek_discount_percent" inputmode="decimal" placeholder="z. B. 35" value="${r?.ek_discount_percent ?? ''}">
    <h2>Shopify-B2B (optional, für Zahlungsziel und Katalogpreise)</h2>
    <p class="note">Numerische IDs aus der Admin-URL der B2B-Firma, des Standorts und des Kontakts.</p>
    <div class="row">
      <div><label>Company-ID</label><input name="company_id" value="${r?.company_id ?? ''}"></div>
      <div><label>Company-Location-ID</label><input name="company_location_id" value="${r?.company_location_id ?? ''}"></div>
      <div><label>Company-Contact-ID</label><input name="company_contact_id" value="${r?.company_contact_id ?? ''}"></div>
    </div>
    <label><input type="checkbox" name="auto_accept" value="1" style="width:auto" ${r?.auto_accept ? 'checked' : ''}> Bestellungen automatisch annehmen (sonst jede Bestellung manuell freigeben)</label>
    ${r ? html`<input type="hidden" name="form_mode" value="edit"><label><input type="checkbox" name="active" value="1" style="width:auto" ${r.active ? 'checked' : ''}> aktiv</label>` : ''}
    <p><button type="submit">Speichern</button></p>
  </form>`;
}

function parseTier(raw: string): number | null {
  if (!raw) return null;
  const n = Number(raw.replace(',', '.'));
  if (!Number.isFinite(n) || n < 0 || n > 100) throw new Error('EK-Rabatt muss zwischen 0 und 100 liegen');
  return Math.round(n * 100) / 100;
}

function formToRetailer(f: Record<string, string | File | (string | File)[]>): RetailerInput {
  const s = (k: string) => (typeof f[k] === 'string' ? (f[k] as string).trim() : '');
  return {
    name: s('name'),
    email: s('email'),
    sender_address: {
      company: s('s_company'), name: s('s_name') || s('name'), address1: s('s_address1'), address2: s('s_address2'),
      zip: s('s_zip'), city: s('s_city'), countryCode: 'DE',
    },
    return_mode: s('return_mode') === 'us' ? 'us' : 'retailer',
    company_id: s('company_id'),
    company_location_id: s('company_location_id'),
    company_contact_id: s('company_contact_id'),
    auto_accept: s('auto_accept') === '1',
    ek_discount_percent: parseTier(s('ek_discount_percent')),
    // Checkbox fehlt im Formular, wenn nicht angehakt; beim Anlegen gibt es sie gar nicht
    active: s('form_mode') === 'edit' ? s('active') === '1' : true,
  };
}

function links(d: Deps, r: Retailer) {
  const base = d.cfg.BASE_URL;
  return html`<div class="card">
    <p><b>Händlerseite:</b> <code>${base}/h/${r.feed_token}</code></p>
    <p><b>Bestandsfeed:</b> <code>${base}/feed/${r.feed_token}/stock.csv</code><br>
    <b>Produktfeed:</b> <code>${base}/feed/${r.feed_token}/products.csv</code></p>
    <p><b>API:</b> <code>${base}/api</code> · API-Key-Präfix <code>dsk_${r.api_key_prefix ?? ''}_…</code></p>
  </div>`;
}

function credentials(d: Deps, r: Retailer, apiKey: string) {
  return html`<h1>${r.name}: Zugangsdaten</h1>
    <div class="flash">Den API-Key jetzt kopieren und dem Händler sicher übermitteln. Er wird nicht noch einmal angezeigt.</div>
    <div class="card"><p><b>API-Key:</b> <code>${apiKey}</code></p></div>
    ${links(d, r)}
    <p><a class="btn secondary" href="/admin/retailers/${r.id}">Zum Händler</a></p>`;
}
