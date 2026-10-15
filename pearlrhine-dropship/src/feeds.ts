import type { Config } from './config.js';
import type { FeedItem } from './catalog.js';
import { toCsv } from './csv.js';

export type FeedFormat = 'csv' | 'json' | 'xml';
export type FeedKind = 'stock' | 'products';

const xmlEsc = (s: unknown) =>
  String(s ?? '').replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!);

const stripHtml = (html: string) =>
  html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|li|h\d)>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\n{3,}/g, '\n\n').trim();

const money = (n: number | null | undefined) => (n == null ? '' : n.toFixed(2));

function stockRecord(i: FeedItem, at: string | null) {
  return { sku: i.sku, ean: i.ean, menge: i.qty, status: i.availability, eta: i.eta, stand: at ?? '' };
}

function productRecord(i: FeedItem, cfg: Config) {
  const p = i.product;
  const m = p?.meta ?? {};
  return {
    sku: i.sku,
    ean: i.ean,
    hersteller_artnr: m.mpn ?? '',
    marke: p?.brand ?? '',
    titel: p?.title ?? '',
    beschreibung_html: p?.descriptionHtml ?? '',
    beschreibung_text: p ? stripHtml(p.descriptionHtml) : '',
    kategorie: p?.productType ?? '',
    bilder: p?.images ?? [],
    gewicht_kg: p?.weightKg ?? '',
    uvp_brutto: money(i.uvp),
    ek_netto: money(i.ekNet),
    ek_quelle: i.ekSource ?? '',
    waehrung: cfg.CURRENCY,
    menge: i.qty,
    status: i.availability,
    lieferzeit: cfg.DELIVERY_TIME_TEXT,
    gpsr_hersteller: m.gpsr_hersteller ?? '',
    gpsr_eu_verantwortlicher: m.gpsr_eu_verantwortlicher ?? '',
    sicherheitshinweise: m.sicherheitshinweise ?? '',
    weee_reg_nr: m.weee_reg ?? '',
    datenblatt_url: m.datenblatt_url ?? '',
    anleitung_url: m.anleitung_url ?? '',
  };
}

export function renderFeed(kind: FeedKind, format: FeedFormat, items: FeedItem[], cfg: Config, stockAt: string | null) {
  const records: Record<string, unknown>[] =
    kind === 'stock' ? items.map((i) => stockRecord(i, stockAt)) : items.map((i) => productRecord(i, cfg));

  if (format === 'json') {
    return { contentType: 'application/json; charset=utf-8', body: JSON.stringify({ generated_at: new Date().toISOString(), stock_at: stockAt, items: records }) };
  }

  if (format === 'csv') {
    const header = Object.keys(records[0] ?? (kind === 'stock' ? stockRecord({} as FeedItem, null) : productRecord({} as FeedItem, cfg)));
    const rows = records.map((r) => header.map((h) => {
      const v = r[h];
      return Array.isArray(v) ? v.join('|') : (v as string | number);
    }));
    return { contentType: 'text/csv; charset=utf-8', body: toCsv(header, rows) };
  }

  const tag = kind === 'stock' ? 'artikel' : 'produkt';
  const body = records.map((r) => {
    const fields = Object.entries(r).map(([k, v]) =>
      Array.isArray(v) ? `<${k}>${v.map((x) => `<url>${xmlEsc(x)}</url>`).join('')}</${k}>` : `<${k}>${xmlEsc(v)}</${k}>`).join('');
    return `<${tag}>${fields}</${tag}>`;
  }).join('\n');
  return {
    contentType: 'application/xml; charset=utf-8',
    body: `<?xml version="1.0" encoding="UTF-8"?>\n<feed generated_at="${new Date().toISOString()}" stock_at="${xmlEsc(stockAt)}">\n${body}\n</feed>\n`,
  };
}
