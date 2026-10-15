import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { DB } from './db.js';
import type { Address } from './shopify/types.js';

export interface Retailer {
  id: number;
  name: string;
  email: string;
  feed_token: string;
  api_key_hash: string | null;
  api_key_prefix: string | null;
  sender_address: Address;
  return_mode: 'retailer' | 'us';
  company_id: string | null;
  company_location_id: string | null;
  company_contact_id: string | null;
  /** Abweichender EK-Rabatt auf die UVP netto. null = Standard aus der Konfiguration. */
  ek_discount_percent: number | null;
  auto_accept: boolean;
  active: boolean;
  created_at: string;
}

export interface RetailerInput {
  name: string;
  email: string;
  sender_address: Address;
  return_mode: 'retailer' | 'us';
  company_id?: string | null;
  company_location_id?: string | null;
  company_contact_id?: string | null;
  ek_discount_percent?: number | null;
  auto_accept: boolean;
  active?: boolean;
}

const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const token = (bytes: number) => randomBytes(bytes).toString('base64url');

function hydrate(row: any): Retailer | undefined {
  if (!row) return undefined;
  return {
    ...row,
    sender_address: JSON.parse(row.sender_address),
    ek_discount_percent: row.ek_discount_percent == null ? null : Number(row.ek_discount_percent),
    auto_accept: !!row.auto_accept,
    active: !!row.active,
  };
}

export class Retailers {
  constructor(private readonly db: DB) {}

  list(): Retailer[] {
    return (this.db.prepare('SELECT * FROM retailers ORDER BY name').all() as any[]).map((r) => hydrate(r)!);
  }

  get(id: number) {
    return hydrate(this.db.prepare('SELECT * FROM retailers WHERE id = ?').get(id));
  }

  /** Feed-Token: für Feeds und die Händlerseite. Nur aktive Händler. */
  byFeedToken(t: string) {
    const r = hydrate(this.db.prepare('SELECT * FROM retailers WHERE feed_token = ?').get(t));
    return r?.active ? r : undefined;
  }

  /** API-Key Format: dsk_<prefix>_<secret>; gespeichert wird nur der Hash. */
  byApiKey(key: string) {
    const m = /^dsk_([A-Za-z0-9_-]{8})_[A-Za-z0-9_-]+$/.exec(key);
    if (!m) return undefined;
    const r = hydrate(this.db.prepare('SELECT * FROM retailers WHERE api_key_prefix = ?').get(m[1]));
    if (!r?.active || !r.api_key_hash) return undefined;
    const a = Buffer.from(hash(key), 'hex');
    const b = Buffer.from(r.api_key_hash, 'hex');
    return a.length === b.length && timingSafeEqual(a, b) ? r : undefined;
  }

  create(input: RetailerInput): { retailer: Retailer; apiKey: string } {
    const info = this.db.prepare(
      `INSERT INTO retailers (name, email, feed_token, sender_address, return_mode, company_id, company_location_id, company_contact_id, ek_discount_percent, auto_accept, active)
       VALUES (@name, @email, @feed_token, @sender_address, @return_mode, @company_id, @company_location_id, @company_contact_id, @ek_discount_percent, @auto_accept, 1)`,
    ).run({
      ...this.params(input),
      feed_token: token(24),
    });
    const id = Number(info.lastInsertRowid);
    const apiKey = this.rotateApiKey(id);
    return { retailer: this.get(id)!, apiKey };
  }

  update(id: number, input: RetailerInput) {
    this.db.prepare(
      `UPDATE retailers SET name=@name, email=@email, sender_address=@sender_address, return_mode=@return_mode,
         company_id=@company_id, company_location_id=@company_location_id, company_contact_id=@company_contact_id,
         ek_discount_percent=@ek_discount_percent, auto_accept=@auto_accept, active=@active WHERE id=@id`,
    ).run({ ...this.params(input), active: input.active === false ? 0 : 1, id });
  }

  rotateApiKey(id: number): string {
    const prefix = token(6).slice(0, 8);
    const key = `dsk_${prefix}_${token(24)}`;
    this.db.prepare('UPDATE retailers SET api_key_hash = ?, api_key_prefix = ? WHERE id = ?').run(hash(key), prefix, id);
    return key;
  }

  rotateFeedToken(id: number) {
    this.db.prepare('UPDATE retailers SET feed_token = ? WHERE id = ?').run(token(24), id);
  }

  private params(i: RetailerInput) {
    return {
      name: i.name.trim(),
      email: i.email.trim(),
      sender_address: JSON.stringify(i.sender_address),
      return_mode: i.return_mode,
      company_id: i.company_id || null,
      company_location_id: i.company_location_id || null,
      company_contact_id: i.company_contact_id || null,
      ek_discount_percent: i.ek_discount_percent == null || Number.isNaN(i.ek_discount_percent) ? null : i.ek_discount_percent,
      auto_accept: i.auto_accept ? 1 : 0,
    };
  }
}

export const hasCompany = (r: Retailer) => Boolean(r.company_id && r.company_location_id && r.company_contact_id);

/**
 * EK-Stufe für Feeds und Zeilenrabatt.
 * Verknüpfte B2B-Firma plus Preisliste: Shopify setzt den Katalogpreis, die Stufe bleibt außen vor.
 */
export function pricingTier(r: Retailer, priceListConfigured: boolean): number | null {
  if (priceListConfigured && hasCompany(r)) return null;
  return r.ek_discount_percent;
}
