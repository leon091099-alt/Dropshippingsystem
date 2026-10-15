import type { Config } from '../config.js';
import type { DB } from '../db.js';
import { log } from '../log.js';
import { readOauth, shopHost, writeOauth, type StoredOauth } from './oauth.js';

export class ShopifyError extends Error {
  constructor(message: string, readonly details?: unknown) {
    super(message);
  }
}

type GqlResponse<T> = {
  data?: T;
  errors?: { message: string; extensions?: { code?: string } }[];
  extensions?: { cost?: { throttleStatus?: { currentlyAvailable: number; restoreRate: number } } };
};

/** Minimaler GraphQL-Admin-Client: Token-Beschaffung, Throttle-Retry, Fehler. */
export class ShopifyClient {
  private token?: string;
  private tokenExpiresAt = 0;

  constructor(private readonly cfg: Config, private readonly db?: DB, private readonly fetchImpl: typeof fetch = fetch) {
    this.token = cfg.SHOPIFY_ADMIN_TOKEN;
    if (this.token) this.tokenExpiresAt = Number.POSITIVE_INFINITY;
  }

  private async accessToken(): Promise<string> {
    if (this.cfg.SHOPIFY_ADMIN_TOKEN) return this.cfg.SHOPIFY_ADMIN_TOKEN;
    if (this.token && Date.now() < this.tokenExpiresAt) return this.token;
    const stored = this.db ? readOauth(this.db) : undefined;
    if (stored?.access_token && stored.shop === shopHost(this.cfg.SHOPIFY_STORE)) {
      if (!stored.expires_at || Date.now() < stored.expires_at - 60_000) {
        this.token = stored.access_token;
        this.tokenExpiresAt = stored.expires_at ?? Number.POSITIVE_INFINITY;
        return this.token;
      }
      if (stored.refresh_token) {
        const refreshed = await this.refreshOauth(stored);
        if (refreshed) return refreshed;
      }
    }
    // Client-Credentials-Grant (Dev-Dashboard-App im eigenen Shop), Token 24 h gültig
    const res = await this.fetchImpl(`https://${this.cfg.SHOPIFY_STORE}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.cfg.SHOPIFY_CLIENT_ID ?? '',
        client_secret: this.cfg.SHOPIFY_CLIENT_SECRET ?? '',
        grant_type: 'client_credentials',
      }),
    });
    if (!res.ok) throw new ShopifyError(`Token-Abruf fehlgeschlagen: HTTP ${res.status}`, await res.text());
    const body = (await res.json()) as { access_token: string; expires_in?: number };
    this.token = body.access_token;
    this.tokenExpiresAt = Date.now() + ((body.expires_in ?? 86399) - 300) * 1000;
    return this.token;
  }

  private async refreshOauth(stored: StoredOauth): Promise<string | undefined> {
    const res = await this.fetchImpl(`https://${this.cfg.SHOPIFY_STORE}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.cfg.SHOPIFY_CLIENT_ID ?? '',
        client_secret: this.cfg.SHOPIFY_CLIENT_SECRET ?? '',
        grant_type: 'refresh_token',
        refresh_token: stored.refresh_token ?? '',
      }),
    });
    if (!res.ok) {
      log.warn('oauth-refresh fehlgeschlagen', { status: res.status });
      return undefined;
    }
    const body = (await res.json()) as { access_token: string; expires_in?: number; refresh_token?: string };
    const next: StoredOauth = {
      ...stored,
      access_token: body.access_token,
      refresh_token: body.refresh_token ?? stored.refresh_token,
      expires_at: body.expires_in ? Date.now() + (body.expires_in - 60) * 1000 : undefined,
    };
    if (this.db) writeOauth(this.db, next);
    this.token = next.access_token;
    this.tokenExpiresAt = next.expires_at ?? Number.POSITIVE_INFINITY;
    return this.token;
  }

  async graphql<T>(query: string, variables: Record<string, unknown> = {}, attempt = 0): Promise<T> {
    const url = `https://${this.cfg.SHOPIFY_STORE}/admin/api/${this.cfg.SHOPIFY_API_VERSION}/graphql.json`;
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': await this.accessToken() },
      body: JSON.stringify({ query, variables }),
    });

    if (res.status === 401 && !this.cfg.SHOPIFY_ADMIN_TOKEN && attempt === 0) {
      this.token = undefined;
      this.tokenExpiresAt = 0;
      const stored = this.db ? readOauth(this.db) : undefined;
      if (stored && this.db) writeOauth(this.db, { ...stored, expires_at: 0 });
      return this.graphql(query, variables, attempt + 1);
    }
    if (res.status === 429 || res.status >= 500) {
      if (attempt >= 5) throw new ShopifyError(`Shopify HTTP ${res.status} nach ${attempt} Versuchen`);
      await sleep(1000 * 2 ** attempt);
      return this.graphql(query, variables, attempt + 1);
    }
    if (!res.ok) throw new ShopifyError(`Shopify HTTP ${res.status}`, await res.text());

    const body = (await res.json()) as GqlResponse<T>;
    if (body.errors?.some((e) => e.extensions?.code === 'THROTTLED')) {
      if (attempt >= 8) throw new ShopifyError('Shopify-Throttle hält an');
      const t = body.extensions?.cost?.throttleStatus;
      const wait = t ? Math.max(1000, (1000 / Math.max(t.restoreRate, 1)) * 500) : 2000;
      log.warn('shopify throttled, warte', { ms: Math.round(wait) });
      await sleep(wait);
      return this.graphql(query, variables, attempt + 1);
    }
    if (body.errors?.length) throw new ShopifyError(body.errors.map((e) => e.message).join('; '), body.errors);
    if (!body.data) throw new ShopifyError('Leere Antwort von Shopify');

    // vorsorglich bremsen, wenn der Bucket fast leer ist
    const t = body.extensions?.cost?.throttleStatus;
    if (t && t.currentlyAvailable < 200) await sleep(((200 - t.currentlyAvailable) / t.restoreRate) * 1000);
    return body.data;
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** userErrors aus Mutations in eine Exception verwandeln */
export function assertNoUserErrors(errors: { field?: string[] | null; message: string }[] | undefined, what: string) {
  if (errors && errors.length) {
    throw new ShopifyError(`${what}: ${errors.map((e) => (e.field ? `${e.field.join('.')}: ` : '') + e.message).join('; ')}`, errors);
  }
}

export const toGid = (type: string, id: string) => (id.startsWith('gid://') ? id : `gid://shopify/${type}/${id}`);
export const fromGid = (gid: string) => gid.split('/').pop() ?? gid;
