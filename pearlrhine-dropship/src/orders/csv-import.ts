import { parseCsv } from '../csv.js';

/**
 * CSV-Bestellimport. Eine Zeile pro Position; Zeilen mit gleicher Bestellnummer = eine Bestellung.
 * Spalten (Kopfzeile, Groß/Klein egal): bestellnummer;sku;menge;name;firma;strasse;adresszusatz;plz;ort;land;telefon;notiz
 */
export const CSV_COLUMNS = ['bestellnummer', 'sku', 'menge', 'name', 'firma', 'strasse', 'adresszusatz', 'plz', 'ort', 'land', 'telefon', 'notiz'];

const ALIASES: Record<string, string> = {
  reference: 'bestellnummer', order: 'bestellnummer', 'order_id': 'bestellnummer', auftragsnummer: 'bestellnummer',
  artikelnummer: 'sku', quantity: 'menge', anzahl: 'menge', qty: 'menge',
  company: 'firma', street: 'strasse', 'straße': 'strasse', address1: 'strasse', address2: 'adresszusatz',
  zip: 'plz', postleitzahl: 'plz', city: 'ort', stadt: 'ort', country: 'land', phone: 'telefon', note: 'notiz',
};

export function csvToOrderPayloads(text: string): { payloads: unknown[]; errors: string[] } {
  const rows = parseCsv(text).map((r) => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(r)) out[ALIASES[k] ?? k] = v;
    return out;
  });
  const errors: string[] = [];
  if (!rows.length) return { payloads: [], errors: ['Datei enthält keine Zeilen'] };
  const missing = ['bestellnummer', 'sku', 'menge', 'name', 'strasse', 'plz', 'ort'].filter((c) => !(c in rows[0]));
  if (missing.length) return { payloads: [], errors: [`Spalten fehlen: ${missing.join(', ')}`] };

  const groups = new Map<string, Record<string, string>[]>();
  rows.forEach((r, i) => {
    if (!r.bestellnummer) { errors.push(`Zeile ${i + 2}: Bestellnummer fehlt`); return; }
    groups.set(r.bestellnummer, [...(groups.get(r.bestellnummer) ?? []), r]);
  });

  const payloads = [...groups.entries()].map(([reference, lines]) => {
    const h = lines[0];
    return {
      reference,
      shippingAddress: {
        name: h.name, company: h.firma ?? '', address1: h.strasse, address2: h.adresszusatz ?? '',
        zip: h.plz, city: h.ort, countryCode: (h.land || 'DE').toUpperCase(), phone: h.telefon ?? '',
      },
      lines: lines.map((l) => ({ sku: l.sku, quantity: Number(l.menge) })),
      note: h.notiz ?? '',
    };
  });
  return { payloads, errors };
}
