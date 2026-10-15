# PearlRhine Dropship-Gateway

Eine Anwendung, die zwischen unserem Shopify-Shop und den Händlern sitzt:

- **Feeds** pro Händler: Bestand (alle 5–15 Min. abrufbar) und Produktdaten, als CSV, XML oder JSON
- **Bestellungen** per REST-API oder CSV-Upload → werden als Shopify-Order (Draft Order → Order) angelegt
- **B2B-Shop-Bestellungen** mit abweichender Lieferadresse werden automatisch als `dropship` markiert
- **Status & Tracking** zurück an den Händler (API, Händlerseite, Tracking-CSV; Versandmail kommt von Shopify)
- **Admin** unter `/admin`: Händler verwalten, Prüfliste, Storno-Aufgaben

Shopify bleibt die einzige Wahrheit. Die App hält nur eine SQLite-Datei (Händler-Zugänge, Bestell-Log, Bestands-Snapshot).

## Aufbau

```
src/
  server.ts            Start, Hintergrundjobs (Bestand alle 5 Min., Produkte stündlich)
  app.ts               Routen zusammenführen
  config.ts            alle Einstellungen aus .env
  catalog.ts           Snapshot, Bestandsregel, EK-Berechnung
  feeds.ts             CSV/XML/JSON-Ausgabe
  orders/              Prüfung, Anlage in Shopify, Status, CSV-Import
  retailers.ts         Händler, Feed-Token, API-Keys (gehasht)
  webhooks.ts          HMAC-Prüfung, inventory_levels/update, orders/create, products/update
  shopify/             GraphQL-Client, Gateway (real + Mock)
  routes/              öffentliche Routen, Händlerseite, Admin
shopify/packing-slip.liquid   Lieferschein-Vorlage mit Neutralversand
scripts/register-webhooks.ts  Webhooks einmalig registrieren
```

## Bestandsregel

`angezeigt = min(verfügbar − STOCK_BUFFER, STOCK_CAP)`, nie unter 0 (Standard: Puffer 2, Deckel 20).
Verfügbar = Summe „available“ über alle Locations bzw. nur `DROPSHIP_LOCATION_IDS`.
Aktualisierung: Webhook patcht den Snapshot sofort, zusätzlich Vollabgleich alle 5 Min.; nach jeder angelegten Order wird lokal reserviert.

## EK (Händler-Einkaufspreis netto)

Reihenfolge:
1. Metafeld `dropship.ek` an Variante oder Produkt (netto)
2. B2B-Preisliste `B2B_PRICE_LIST_ID` (wird bei gesetztem Steuer-Flag in netto umgerechnet)
3. Händler-Preisstufe `ek_discount_percent`, sonst `DEFAULT_EK_DISCOUNT_PERCENT`: UVP netto × (1 − Rabatt)

In der Draft Order setzt die App den EK als prozentualen Zeilenrabatt. Ausnahme: Händler ist mit einer
B2B-Firma verknüpft **und** eine Preisliste ist gesetzt → Shopify wendet den Katalogpreis selbst an,
die Händlerstufe wird dann ignoriert. Im Produktfeed steht die Herkunft in `ek_quelle`
(`metafeld`, `preisliste`, `stufe`).

Zahlungsziel: ohne B2B-Firma setzt die App ein Netto-Template (`PAYMENT_TERMS_DAYS`, Standard 30, oder
`PAYMENT_TERMS_TEMPLATE_ID`) und schließt die Draft Order ohne das deprecated `paymentPending` ab.
Fehlt ein passendes Template, bleibt `paymentPending: true` der Fallback. Bei verknüpfter B2B-Firma
gelten die Zahlungsbedingungen der Firma.

## Optionale Metafelder (Namespace `dropship`, Produkt oder Variante)

| Key | Inhalt |
| --- | --- |
| `ek` | Händler-EK netto (Dezimalzahl) |
| `mpn` | Hersteller-Artikelnummer |
| `eta` | Nachschubtermin (Text/Datum) |
| `ausgelaufen` | `true` = nicht mehr bestellbar |
| `gpsr_hersteller`, `gpsr_eu_verantwortlicher`, `sicherheitshinweise` | GPSR-Angaben |
| `weee_reg` | WEEE-Registrierungsnummer |
| `datenblatt_url`, `anleitung_url` | PDFs |

Produkte kommen in die Feeds, wenn sie `PRODUCT_QUERY` erfüllen (Standard: Tag `dropship`, Status aktiv).

## Einrichtung

### 1. Shopify-App
Seit 01.01.2026 lassen sich keine neuen „Legacy Custom Apps“ im Shop-Admin anlegen. Die App-Konfiguration
liegt in `shopify.app.toml` (Scopes, Webhooks, `embedded = false`). `client_id` und `application_url`
nach dem Anlegen im Dev Dashboard eintragen (`shopify app config link`).

Token, in dieser Reihenfolge:
- **Vorhandenes Admin-API-Token** → `SHOPIFY_ADMIN_TOKEN`
- **OAuth-Installation** → einmalig `/auth?shop=dein-shop.myshopify.com` öffnen. Das Token liegt in der SQLite-Datei und wird bei Ablauf erneuert.
- **Client-Credentials** der Dev-Dashboard-App → `SHOPIFY_CLIENT_ID` + `SHOPIFY_CLIENT_SECRET` (24 h, automatische Erneuerung).

Scopes stehen in `shopify.app.toml` und `src/shopify/scopes.ts` und müssen gleich bleiben.
Webhooks kommen aus der toml-Datei. `REGISTER_WEBHOOKS=true` oder `npm run register-webhooks` nur nutzen,
wenn die App keine toml-Subscriptions hat — sonst liefert Shopify jedes Event doppelt.
Pflicht-Webhooks (`customers/data_request`, `customers/redact`, `shop/redact`) antwortet die App mit 200;
`customers/redact` schwärzt Lieferadressen der genannten Orders.

### 2. Server (ein VPS, z. B. Hetzner CX22)
```bash
cp .env.example .env        # ausfüllen
# Domain in Caddyfile eintragen, DNS auf den Server zeigen lassen
docker compose up -d --build
```
Webhooks einmalig registrieren (lokal mit gleicher .env):
```bash
npm ci && npm run register-webhooks
```
Backup: Ordner `./data` (eine SQLite-Datei) oder Server-Snapshot.

### 3. Shopify-Einstellungen
- Lieferschein-Vorlage: Inhalt von `shopify/packing-slip.liquid` einsetzen, mit Testbestellung prüfen.
- B2B-Firmen der Händler: „Allow customers to ship to any one-time address“ aktivieren, Zahlungsziel setzen.
- Externe Fulfiller: deren Neutralversand-Option prüfen (eigene Lieferscheine).

### 4. Händler anlegen
`/admin/retailers/new` → Zugangsdaten werden einmal angezeigt (API-Key) → Link zur Händlerseite schicken.
Neue Händler zuerst ohne „automatisch annehmen“ laufen lassen (jede Bestellung in der Prüfliste).

## API für Händler

Auth: `Authorization: Bearer dsk_…`

| Methode | Pfad | Zweck |
| --- | --- | --- |
| GET | `/api/stock` | Bestand JSON |
| POST | `/api/orders` | Bestellung anlegen (idempotent über `reference`) |
| GET | `/api/orders?days=30` | Bestellungen |
| GET | `/api/orders/{reference}` | Status + Tracking |
| POST | `/api/orders/{reference}/cancel` | Storno anfragen |

```json
POST /api/orders
{
  "reference": "A-1001",
  "shippingAddress": { "name": "Erika Musterfrau", "company": "", "address1": "Ringstraße 7",
                       "address2": "", "zip": "50667", "city": "Köln", "countryCode": "DE", "phone": "" },
  "lines": [{ "sku": "DF-TRIPOD-01", "quantity": 1 }],
  "note": ""
}
```
Antwort `201` (neu) bzw. `200` (bereits vorhanden), `422` bei Formfehlern.
Status: `accepted`, `on_hold`, `rejected`, `shipped`, `cancel_requested`, `cancelled`, `returned`.

Feeds: `/feed/{token}/stock.csv|xml|json`, `/feed/{token}/products.csv|xml|json` (max. 60 Abrufe/Min.).

## CSV-Bestellimport
Kopfzeile: `bestellnummer;sku;menge;name;firma;strasse;adresszusatz;plz;ort;land;telefon;notiz`
(englische Spaltennamen werden erkannt). Mehrere Zeilen mit gleicher Bestellnummer = eine Bestellung.

## Entwicklung
```bash
npm install
npm test                    # 22 Tests gegen Mock-Shopify
MOCK_SHOPIFY=true SHOPIFY_STORE=x.myshopify.com ADMIN_PASSWORD=geheim123 npm run dev
```

## Vor dem Livegang gegen einen Dev-Store prüfen
- GraphQL-Abfragen gegen `SHOPIFY_API_VERSION` (Standard 2026-07), inklusive `paymentTermsTemplates`
- Order mit Zahlungsziel (ohne B2B-Firma) und Order mit B2B-Firma: kein doppelter Rabatt, Zahlung bleibt offen
- Lieferschein-Vorlage im Dropship-Fall
- Versandmail an die Händler-E-Mail
- Betrag der Dropship-Pauschale und die konkreten Rabattstufen (Konfiguration, keine Vorgabe im Code)
