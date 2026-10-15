import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { publishedQty } from '../src/catalog.js';
import { parseCsv, toCsv } from '../src/csv.js';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { csvToOrderPayloads } from '../src/orders/csv-import.js';
import { ShopifyClient } from '../src/shopify/client.js';
import { verifyOauthHmac, writeOauth } from '../src/shopify/oauth.js';
import { isB2bDropship, verifyHmac, WebhookHandler } from '../src/webhooks.js';
import { setup } from './helpers.js';

describe('Bestandsregel', () => {
  it('Puffer und Deckel', () => {
    expect(publishedQty(37, 2, 20)).toBe(20);
    expect(publishedQty(5, 2, 20)).toBe(3);
    expect(publishedQty(2, 2, 20)).toBe(0);
    expect(publishedQty(-4, 2, 20)).toBe(0);
    expect(publishedQty(Infinity, 2, 20)).toBe(20);
  });
});

describe('CSV', () => {
  it('Roundtrip mit Sonderzeichen', () => {
    const text = toCsv(['a', 'b'], [['x;y', 'Zitat "z"'], ['Köln', '']]);
    expect(parseCsv(text)).toEqual([{ a: 'x;y', b: 'Zitat "z"' }, { a: 'Köln', b: '' }]);
  });
  it('Komma-getrennt und Aliase, gruppiert nach Bestellnummer', () => {
    const csv = 'Reference,SKU,Quantity,Name,Street,ZIP,City\nB1,S1,1,Max M,Weg 1,12345,Ort\nB1,S2,3,Max M,Weg 1,12345,Ort\nB2,S1,1,Eva E,Pfad 2,54321,Dorf\n';
    const { payloads, errors } = csvToOrderPayloads(csv);
    expect(errors).toEqual([]);
    expect(payloads).toHaveLength(2);
    expect((payloads[0] as any).lines).toEqual([{ sku: 'S1', quantity: 1 }, { sku: 'S2', quantity: 3 }]);
  });
  it('meldet fehlende Spalten', () => {
    expect(csvToOrderPayloads('bestellnummer;sku\nA;B').errors[0]).toMatch(/Spalten fehlen/);
  });
});

describe('Webhooks', () => {
  it('HMAC', () => {
    const body = '{"a":1}';
    const sig = createHmac('sha256', 's').update(body).digest('base64');
    expect(verifyHmac(body, sig, 's')).toBe(true);
    expect(verifyHmac(body, sig, 'x')).toBe(false);
    expect(verifyHmac(body, undefined, 's')).toBe(false);
  });
  it('erkennt B2B-Dropship', () => {
    const b = { name: 'Foto Schmidt', address1: 'Hauptstr. 5', zip: '10115' };
    expect(isB2bDropship({ company: { id: 1 }, tags: '', billing_address: b, shipping_address: { ...b, name: 'Erika', address1: 'Ring 7', zip: '50667' } })).toBe(true);
    expect(isB2bDropship({ company: { id: 1 }, tags: '', billing_address: b, shipping_address: b })).toBe(false);
    expect(isB2bDropship({ tags: '', billing_address: b, shipping_address: { ...b, zip: '1' } })).toBe(false);
    expect(isB2bDropship({ company: { id: 1 }, tags: 'dropship, x', billing_address: b, shipping_address: { ...b, zip: '1' } })).toBe(false);
  });
});

describe('EK', () => {
  it('Fallback aus UVP brutto und Rabatt-%', async () => {
    const { deps } = await setup();
    const item = deps.catalog.bySku('df-tripod-01')!;
    expect(item.ekNet).toBe(111.18); // 189 / 1,19 × 0,7
    expect(deps.catalog.lineDiscountPercent(item.variantId, false)).toBeCloseTo(30, 1);
  });
  it('Metafeld dropship.ek gewinnt', async () => {
    const { deps, shopify } = await setup();
    shopify.products[0].meta.ek = '99.5';
    await deps.catalog.refreshProducts();
    expect(deps.catalog.bySku('DF-TRIPOD-01')!.ekNet).toBe(99.5);
  });
  it('Händlerstufe schlägt die Preisliste, Metafeld schlägt die Stufe', async () => {
    const { deps, shopify } = await setup({ B2B_PRICE_LIST_ID: '77' });
    shopify.priceList.set('gid://shopify/ProductVariant/1', 142.8);
    await deps.catalog.refreshProducts();
    expect(deps.catalog.ekNet('gid://shopify/ProductVariant/1', 50)).toBe(79.41);
    expect(deps.catalog.pricing('gid://shopify/ProductVariant/1', 50).ekSource).toBe('stufe');
    shopify.products[0].meta.ek = '99.5';
    await deps.catalog.refreshProducts();
    expect(deps.catalog.ekNet('gid://shopify/ProductVariant/1', 50)).toBe(99.5);
    expect(deps.catalog.pricing('gid://shopify/ProductVariant/1', 50).ekSource).toBe('metafeld');
  });
  it('Preisliste + B2B-Firma: kein eigener Rabatt', async () => {
    const { deps, shopify } = await setup({ B2B_PRICE_LIST_ID: '77' });
    shopify.priceList.set('gid://shopify/ProductVariant/1', 142.8);
    await deps.catalog.refreshProducts();
    expect(deps.catalog.bySku('DF-TRIPOD-01')!.ekNet).toBe(120);
    expect(deps.catalog.lineDiscountPercent('gid://shopify/ProductVariant/1', true)).toBeUndefined();
  });
});

describe('Shopify-App', () => {
  it('OAuth-HMAC und gespeichertes Token', async () => {
    const params = new URLSearchParams({ code: 'abc', shop: 'test.myshopify.com', state: 's', timestamp: '1' });
    const message = [...params.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('&');
    params.set('hmac', createHmac('sha256', 'secret').update(message).digest('hex'));
    expect(verifyOauthHmac(params, 'secret')).toBe(true);
    expect(verifyOauthHmac(params, 'falsch')).toBe(false);

    const cfg = loadConfig({
      SHOPIFY_STORE: 'test.myshopify.com', MOCK_SHOPIFY: 'true', ADMIN_PASSWORD: 'geheim123',
      SHOPIFY_CLIENT_ID: 'cid', SHOPIFY_CLIENT_SECRET: 'secret',
    });
    const db = openDb(':memory:');
    writeOauth(db, { access_token: 'shpat_test', shop: 'test.myshopify.com' });
    let seen = '';
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      seen = new Headers(init?.headers).get('X-Shopify-Access-Token') ?? '';
      return new Response(JSON.stringify({ data: { shop: { name: 'Test' } } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    const client = new ShopifyClient(cfg, db, fetchImpl);
    await client.graphql('query { shop { name } }');
    expect(seen).toBe('shpat_test');
  });

  it('Bestand außerhalb des Snapshots plant einen Abgleich', async () => {
    const { deps } = await setup();
    let planned = 0;
    const handler = new WebhookHandler(deps.catalog, deps.shopify, () => undefined, () => { planned++; }, deps.orders);
    await handler.handle('inventory_levels/update', 'neu', { inventory_item_id: 999, location_id: 1, available: 4 });
    await handler.handle('inventory_levels/connect', 'con', { inventory_item_id: 1, location_id: 2 });
    expect(planned).toBe(2);
  });
});
