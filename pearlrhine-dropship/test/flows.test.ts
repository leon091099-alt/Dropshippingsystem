import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { order, setup } from './helpers.js';

const json = (body: unknown, key: string) => ({
  method: 'POST', body: JSON.stringify(body),
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
});

describe('Feeds', () => {
  it('Bestand-CSV mit Puffer und Deckel', async () => {
    const { app, retailer } = await setup();
    const res = await app.request(`/feed/${retailer.feed_token}/stock.csv`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('sku;ean;menge;status;eta;stand');
    expect(text).toMatch(/DF-TRIPOD-01;6970000000011;20;lieferbar/);
    expect(text).toMatch(/DF-GIMBAL-02;\d+;3;lieferbar/);
    expect(text).toMatch(/DF-CAGE-03;\d+;0;nicht_lieferbar/);
  });
  it('Produkt-XML und JSON', async () => {
    const { app, retailer } = await setup();
    const xml = await (await app.request(`/feed/${retailer.feed_token}/products.xml`)).text();
    expect(xml).toContain('<ek_netto>111.18</ek_netto>');
    expect(xml).toContain('<weee_reg_nr>DE12345678</weee_reg_nr>');
    const j = await (await app.request(`/feed/${retailer.feed_token}/products.json`)).json() as any;
    expect(j.items).toHaveLength(3);
    expect(j.items[0].bilder[0]).toMatch(/^https:/);
  });
  it('unbekannter Token / gesperrter Händler', async () => {
    const { app, deps, retailer } = await setup();
    expect((await app.request('/feed/falsch/stock.csv')).status).toBe(404);
    deps.retailers.update(retailer.id, { ...retailer, active: false });
    expect((await app.request(`/feed/${retailer.feed_token}/stock.csv`)).status).toBe(404);
  });
});

describe('Order-API', () => {
  it('nimmt an, legt Draft Order mit EK-Rabatt an, ist idempotent', async () => {
    const { app, apiKey, shopify } = await setup({ DROPSHIP_FEE_NET: '4.5', OUR_RETURN_ADDRESS: 'PearlRhine, Lagerweg 1, 50000 Köln' });
    const res = await app.request('/api/orders', json(order(), apiKey));
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.status).toBe('accepted');
    expect(body.order_name).toBe('#1001');

    const created = shopify.created[0];
    expect(created.email).toBe('shop@foto-schmidt.de');
    expect(created.lines[0].discountPercent).toBeCloseTo(30, 1);
    expect(created.fee).toEqual({ title: 'Dropship-Pauschale', amount: 5.36 });
    expect(created.billingAddress?.company).toBe('Foto Schmidt GmbH');
    expect(created.note).toContain('Rücksendungen an: Foto Schmidt GmbH, Foto Schmidt, Hauptstr. 5');
    expect(created.tags).toEqual(['dropship', 'haendler-1', 'kanal-api']);
    expect(created.paymentTermsTemplateId).toBe('gid://shopify/PaymentTermsTemplate/2');

    const stock = await (await app.request('/api/stock', { headers: { Authorization: `Bearer ${apiKey}` } })).json() as any;
    expect(stock.items.find((i: any) => i.sku === 'DF-TRIPOD-01').quantity).toBe(20); // 35 − 2 > Deckel

    const again = await app.request('/api/orders', json(order(), apiKey));
    expect(again.status).toBe(200);
    expect(shopify.created).toHaveLength(1);
  });

  it('zu viel Menge oder unbekannte SKU -> Prüfliste', async () => {
    const { app, apiKey, shopify } = await setup();
    const res = await app.request('/api/orders', json(order({ lines: [{ sku: 'DF-GIMBAL-02', quantity: 4 }, { sku: 'XYZ', quantity: 1 }] }), apiKey));
    const body = await res.json() as any;
    expect(body.status).toBe('on_hold');
    expect(body.problems).toEqual(['SKU DF-GIMBAL-02: 4 bestellt, 3 verfügbar', 'SKU XYZ unbekannt']);
    expect(shopify.created).toHaveLength(0);
    // lokale Reservierung: nach 2 Stück sind nur noch 1 frei
    await app.request('/api/orders', json(order({ reference: 'R-1', lines: [{ sku: 'DF-GIMBAL-02', quantity: 2 }] }), apiKey));
    const r2 = await (await app.request('/api/orders', json(order({ reference: 'R-2', lines: [{ sku: 'DF-GIMBAL-02', quantity: 2 }] }), apiKey))).json() as any;
    expect(r2.problems).toEqual(['SKU DF-GIMBAL-02: 2 bestellt, 1 verfügbar']);
  });

  it('Validierung, Auslandsadresse und Auth', async () => {
    const { app, apiKey } = await setup();
    const bad = await app.request('/api/orders', json(order({ shippingAddress: { name: 'X Y', address1: 'Weg 1', zip: '123', city: 'Ort', countryCode: 'DE' } }), apiKey));
    expect(bad.status).toBe(422);
    expect(((await bad.json()) as any).issues[0]).toMatch(/PLZ/);
    const at = await app.request('/api/orders', json(order({ reference: 'A-2', shippingAddress: { name: 'X Y', address1: 'Weg 1', zip: '1010', city: 'Wien', countryCode: 'AT' } }), apiKey));
    expect(((await at.json()) as any).problems).toContain('Lieferland AT wird nicht beliefert');
    expect((await app.request('/api/orders', json(order(), 'dsk_falsch12_xxx'))).status).toBe(401);
  });

  it('Prüfmodus, Admin-Freigabe, Tracking, Storno', async () => {
    const { app, apiKey, deps, retailer, shopify, adminAuth } = await setup();
    deps.retailers.update(retailer.id, { ...retailer, auto_accept: false });
    const body = await (await app.request('/api/orders', json(order(), apiKey))).json() as any;
    expect(body.status).toBe('on_hold');

    const o = deps.orders.find(retailer.id, 'A-1001')!;
    expect((await app.request(`/admin/orders/${o.id}/approve`, { method: 'POST' })).status).toBe(401);
    const ap = await app.request(`/admin/orders/${o.id}/approve`, { method: 'POST', headers: { Authorization: adminAuth } });
    expect(ap.status).toBe(302);
    expect(deps.orders.get(o.id)!.status).toBe('accepted');

    shopify.statuses.set('gid://shopify/Order/1001', {
      name: '#1001', cancelled: false, fulfillmentStatus: 'FULFILLED', returnStatus: 'NO_RETURN',
      tracking: [{ company: 'DHL', number: '00340434', url: 'https://dhl.de/t/00340434' }],
    });
    const st = await (await app.request('/api/orders/A-1001', { headers: { Authorization: `Bearer ${apiKey}` } })).json() as any;
    expect(st.status).toBe('shipped');
    expect(st.tracking[0].number).toBe('00340434');

    const cancel = await app.request('/api/orders/A-1001/cancel', json({}, apiKey));
    expect(cancel.status).toBe(422);
  });

  it('Shopify-Fehler -> error, Händler sieht Prüfung, Retry klappt', async () => {
    const { app, apiKey, deps, retailer, shopify } = await setup();
    shopify.failNextCreate = 'Variant not found';
    const body = await (await app.request('/api/orders', json(order(), apiKey))).json() as any;
    expect(body.status).toBe('on_hold');
    expect(body.problems).toEqual(['Wird von uns geprüft']);
    const o = deps.orders.find(retailer.id, 'A-1001')!;
    expect(o.status).toBe('error');
    await deps.orders.approve(o.id);
    expect(deps.orders.get(o.id)!.status).toBe('accepted');
  });

  it('B2B-Firma übernimmt das Zahlungsziel, keine eigene Stufe', async () => {
    const { app, apiKey, deps, retailer, shopify } = await setup({ B2B_PRICE_LIST_ID: '77' });
    shopify.priceList.set('gid://shopify/ProductVariant/1', 142.8);
    await deps.catalog.refreshProducts();
    deps.retailers.update(retailer.id, { ...retailer, company_id: '10', company_location_id: '20', company_contact_id: '30', ek_discount_percent: 50 });
    await app.request('/api/orders', json(order(), apiKey));
    const created = shopify.created[0];
    expect(created.paymentTermsTemplateId).toBeUndefined();
    expect(created.purchasingCompany).toEqual({ companyId: '10', companyLocationId: '20', companyContactId: '30' });
    expect(created.lines[0].discountPercent).toBeUndefined();
  });

  it('Händlerstufe ändert den EK im Produktfeed und den Zeilenrabatt', async () => {
    const { app, apiKey, deps, retailer, shopify, adminAuth } = await setup();
    const form = new URLSearchParams({
      name: retailer.name, email: retailer.email, return_mode: 'retailer', auto_accept: '1', active: '1', form_mode: 'edit',
      s_company: 'Foto Schmidt GmbH', s_name: 'Foto Schmidt', s_address1: 'Hauptstr. 5', s_zip: '10115', s_city: 'Berlin',
      ek_discount_percent: '50',
    });
    const saved = await app.request(`/admin/retailers/${retailer.id}`, {
      method: 'POST', body: form, headers: { Authorization: adminAuth, 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    expect(saved.status).toBe(302);
    const xml = await (await app.request(`/feed/${retailer.feed_token}/products.xml`)).text();
    expect(xml).toContain('<ek_netto>79.41</ek_netto>');
    expect(xml).toContain('<ek_quelle>stufe</ek_quelle>');
    await app.request('/api/orders', json(order({ reference: 'STUFE-1' }), apiKey));
    expect(shopify.created[0].lines[0].discountPercent).toBeCloseTo(50, 1);
  });

  it('gleiche Bestellnummer parallel bleibt eine Shopify-Order', async () => {
    const { app, apiKey, shopify } = await setup();
    const [a, b] = await Promise.all([
      app.request('/api/orders', json(order(), apiKey)),
      app.request('/api/orders', json(order(), apiKey)),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(shopify.created).toHaveLength(1);
  });

  it('Storno vor Versand', async () => {
    const { app, apiKey } = await setup();
    await app.request('/api/orders', json(order(), apiKey));
    const res = await app.request('/api/orders/A-1001/cancel', json({}, apiKey));
    expect(((await res.json()) as any).status).toBe('cancel_requested');
  });
});

describe('Händlerseite', () => {
  it('CSV-Upload legt Bestellungen an', async () => {
    const { app, retailer, shopify } = await setup();
    const csv = 'bestellnummer;sku;menge;name;strasse;plz;ort\nC-1;DF-TRIPOD-01;1;Max Muster;Weg 1;12345;Ort\nC-1;DF-GIMBAL-02;1;Max Muster;Weg 1;12345;Ort\nC-2;DF-TRIPOD-01;1;Eva E;Pfad 2;54321;Dorf\n';
    const form = new FormData();
    form.append('file', new File([csv], 'b.csv', { type: 'text/csv' }));
    const res = await app.request(`/h/${retailer.feed_token}/upload`, { method: 'POST', body: form });
    expect(res.status).toBe(302);
    expect(decodeURIComponent(res.headers.get('location')!)).toContain('2 Bestellung(en) übernommen');
    expect(shopify.created).toHaveLength(2);
    const page = await (await app.request(`/h/${retailer.feed_token}`)).text();
    expect(page).toContain('C-2');
    const tracking = await (await app.request(`/h/${retailer.feed_token}/tracking.csv`)).text();
    expect(tracking).toContain('C-1;accepted');
  });
});

describe('Shopify-Webhooks', () => {
  it('inventory_levels/update patcht den Snapshot', async () => {
    const { app, retailer } = await setup();
    const body = JSON.stringify({ inventory_item_id: 3, location_id: 1, available: 9 });
    const hmac = createHmac('sha256', 'whsec').update(body).digest('base64');
    const res = await app.request('/webhooks/shopify', {
      method: 'POST', body,
      headers: { 'X-Shopify-Topic': 'inventory_levels/update', 'X-Shopify-Hmac-Sha256': hmac, 'X-Shopify-Webhook-Id': 'w1' },
    });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 10));
    const csv = await (await app.request(`/feed/${retailer.feed_token}/stock.csv`)).text();
    expect(csv).toMatch(/DF-CAGE-03;\d+;7;lieferbar/);
  });
  it('Fulfillment setzt Tracking, Redact schwärzt die Adresse', async () => {
    const { app, apiKey, deps, retailer } = await setup();
    await app.request('/api/orders', json(order(), apiKey));
    const body = JSON.stringify({ order_id: 1001, status: 'success', tracking_company: 'DHL', tracking_number: '00340434', tracking_url: 'https://dhl.de/t/00340434' });
    const headers = (id: string) => ({
      'X-Shopify-Topic': 'fulfillments/create',
      'X-Shopify-Hmac-Sha256': createHmac('sha256', 'whsec').update(body).digest('base64'),
      'X-Shopify-Webhook-Id': id,
    });
    expect((await app.request('/webhooks/shopify', { method: 'POST', body, headers: headers('ful-1') })).status).toBe(200);
    await new Promise((r) => setTimeout(r, 10));
    expect(deps.orders.find(retailer.id, 'A-1001')!.status).toBe('shipped');
    expect(deps.orders.find(retailer.id, 'A-1001')!.tracking[0].number).toBe('00340434');

    const redact = JSON.stringify({ shop_domain: 'test.myshopify.com', orders_to_redact: [1001] });
    const redactHeaders = {
      'X-Shopify-Topic': 'customers/redact',
      'X-Shopify-Hmac-Sha256': createHmac('sha256', 'whsec').update(redact).digest('base64'),
      'X-Shopify-Webhook-Id': 'red-1',
    };
    expect((await app.request('/webhooks/shopify', { method: 'POST', body: redact, headers: redactHeaders })).status).toBe(200);
    await new Promise((r) => setTimeout(r, 10));
    expect(deps.orders.find(retailer.id, 'A-1001')!.payload.shippingAddress.name).toBe('geschwärzt');
  });
  it('lehnt falsche Signatur ab', async () => {
    const { app } = await setup();
    const res = await app.request('/webhooks/shopify', { method: 'POST', body: '{}', headers: { 'X-Shopify-Hmac-Sha256': 'abc' } });
    expect(res.status).toBe(401);
  });
});

describe('App', () => {
  it('Startseite und OAuth-Callback', async () => {
    const { app } = await setup();
    const home = await (await app.request('/')).text();
    expect(home).toContain('Produktfeeds');
    expect(home).toContain('/admin');
    expect((await app.request('/auth?shop=fremd.myshopify.com')).status).toBe(400);
    expect((await app.request('/auth/callback?shop=test.myshopify.com&code=abc&state=nope&hmac=deadbeef')).status).toBe(401);
  });
});

describe('Admin', () => {
  it('Übersicht und Händler anlegen', async () => {
    const { app, adminAuth } = await setup();
    expect((await app.request('/admin')).status).toBe(401);
    const home = await app.request('/admin', { headers: { Authorization: adminAuth } });
    expect(await home.text()).toContain('Varianten im Feed');
    const form = new URLSearchParams({ name: 'Kamera Müller', email: 'info@kamera-mueller.de', s_address1: 'Weg 2', s_zip: '80331', s_city: 'München', return_mode: 'us' });
    const res = await app.request('/admin/retailers', { method: 'POST', body: form, headers: { Authorization: adminAuth, 'Content-Type': 'application/x-www-form-urlencoded' } });
    const page = await res.text();
    expect(page).toMatch(/dsk_[\w-]{8}_[\w-]+/);
  });
});
