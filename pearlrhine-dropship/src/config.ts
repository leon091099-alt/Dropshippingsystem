import { z } from 'zod';

const bool = (def: boolean) =>
  z.string().optional().transform((v) => (v === undefined || v === '' ? def : ['1', 'true', 'yes', 'ja'].includes(v.toLowerCase())));

const schema = z.object({
  PORT: z.coerce.number().default(3000),
  BASE_URL: z.string().url().default('http://localhost:3000'),
  DATA_DIR: z.string().default('./data'),

  // Shopify
  SHOPIFY_STORE: z.string().min(1).describe('z. B. mein-shop.myshopify.com'),
  SHOPIFY_API_VERSION: z.string().default('2026-07'),
  /** Variante A: statisches Admin-API-Token (bestehende Custom App) */
  SHOPIFY_ADMIN_TOKEN: z.string().optional(),
  /** Variante B: Dev-Dashboard-App, Token per Client-Credentials-Grant (24 h gültig, wird automatisch erneuert) */
  SHOPIFY_CLIENT_ID: z.string().optional(),
  SHOPIFY_CLIENT_SECRET: z.string().optional(),
  /** HMAC-Secret der Webhooks = Client Secret der App. Fällt auf SHOPIFY_CLIENT_SECRET zurück. */
  SHOPIFY_WEBHOOK_SECRET: z.string().optional(),

  /** Welche Varianten in den Feeds landen (Shopify-Suchsyntax für productVariants) */
  PRODUCT_QUERY: z.string().default('tag:dropship AND product_status:active'),
  /** Optional: nur Bestand dieser Locations zählt (kommagetrennte numerische IDs oder GIDs). Leer = alle. */
  DROPSHIP_LOCATION_IDS: z.string().default(''),

  // Bestandsregel: angezeigt = min(verfügbar − Puffer, Deckel), nie < 0
  STOCK_BUFFER: z.coerce.number().int().min(0).default(2),
  STOCK_CAP: z.coerce.number().int().min(1).default(20),
  STOCK_REFRESH_MINUTES: z.coerce.number().min(1).default(5),
  PRODUCT_REFRESH_MINUTES: z.coerce.number().min(5).default(60),

  // Preise
  /** ID der B2B-Preisliste (Katalog). Gesetzt = EK kommt aus der Preisliste und Shopify wendet ihn bei B2B-Orders selbst an. */
  B2B_PRICE_LIST_ID: z.string().default(''),
  /** Fallback, wenn kein Metafeld dropship.ek und keine Preisliste: EK = UVP netto × (1 − Rabatt) */
  DEFAULT_EK_DISCOUNT_PERCENT: z.coerce.number().min(0).max(100).default(30),
  TAX_RATE_PERCENT: z.coerce.number().default(19),
  PRICES_INCLUDE_TAX: bool(true),
  /** Dropship-Pauschale netto pro Bestellung, 0 = keine Position */
  DROPSHIP_FEE_NET: z.coerce.number().min(0).default(0),
  CURRENCY: z.string().default('EUR'),
  /** Netto-Tage fürs Zahlungsziel, wenn keine B2B-Firma verknüpft ist. 0 = kein Template. */
  PAYMENT_TERMS_DAYS: z.coerce.number().int().min(0).max(365).default(30),
  /** Optionale PaymentTermsTemplate-ID/GID. Gesetzt = wird statt der Suche nach PAYMENT_TERMS_DAYS verwendet. */
  PAYMENT_TERMS_TEMPLATE_ID: z.string().default(''),
  /** true = fehlende Webhooks beim Start über die Admin-API anlegen. Bei shopify.app.toml false lassen. */
  REGISTER_WEBHOOKS: bool(false),

  DELIVERY_TIME_TEXT: z.string().default('1–2 Werktage'),
  ALLOWED_COUNTRIES: z.string().default('DE'),
  /** Rücksendeadresse PearlRhine (eine Zeile), wenn der Händler „unsere Adresse“ gewählt hat */
  OUR_RETURN_ADDRESS: z.string().default(''),

  // Admin-Oberfläche
  ADMIN_USER: z.string().default('admin'),
  ADMIN_PASSWORD: z.string().min(8),

  /** Testbetrieb ohne Shopify: Mock-Daten, keine echten Orders */
  MOCK_SHOPIFY: bool(false),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Konfiguration ungültig:\n${msg}`);
  }
  const c = parsed.data;
  if (!c.MOCK_SHOPIFY && !c.SHOPIFY_ADMIN_TOKEN && !(c.SHOPIFY_CLIENT_ID && c.SHOPIFY_CLIENT_SECRET)) {
    throw new Error('Konfiguration ungültig: SHOPIFY_ADMIN_TOKEN oder SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET setzen.');
  }
  return c;
}

export const allowedCountries = (c: Config) => c.ALLOWED_COUNTRIES.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
export const webhookSecret = (c: Config) => c.SHOPIFY_WEBHOOK_SECRET || c.SHOPIFY_CLIENT_SECRET || '';
