# PearlRhine Dropship-Gateway

Eine Anwendung, die zwischen unserem Shopify-Shop und den Händlern sitzt:

- **Feeds** pro Händler: Bestand (alle 5–15 Min. abrufbar) und Produktdaten, als CSV, XML oder JSON
- **Bestellungen** per REST-API oder CSV-Upload → werden als Shopify-Order (Draft Order → Order) angelegt
- **B2B-Shop-Bestellungen** mit abweichender Lieferadresse werden automatisch als `dropship` markiert
- **Status & Tracking** zurück an den Händler (API, Händlerseite, Tracking-CSV; Versandmail kommt von Shopify)
- **Admin** unter `/admin`: Händler verwalten, Prüfliste, Storno-Aufgaben

Shopify bleibt die einzige Wahrheit. Die App hält nur eine SQLite-Datei (Händler-Zugänge, Bestell-Log, Bestands-Snapshot).

Die genaue Funktionsweise für Rückfragen steht in [FUNKTIONSWEISE.md](FUNKTIONSWEISE.md). Die Installation steht in [INSTALLATION.md](INSTALLATION.md).

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

Der vollständige Ablauf steht in [INSTALLATION.md](INSTALLATION.md). Kurz:

1. App im Dev Dashboard anlegen, `shopify.app.toml` auf die echte Domain bringen und deployen. `REGISTER_WEBHOOKS` bleibt `false`, sonst kommen Webhooks doppelt.
2. DNS auf den Server, `.env` aus `.env.example`, Domain in `Caddyfile`, dann `docker compose up -d --build`.
3. Lieferschein aus `shopify/packing-slip.liquid` in Shopify einsetzen. Händler unter `/admin/retailers/new` anlegen, zuerst ohne automatische Annahme.

`npm run register-webhooks` nur verwenden, wenn die App keine toml-Subscriptions hat.

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
npm test                    # Tests gegen Mock-Shopify
MOCK_SHOPIFY=true SHOPIFY_STORE=x.myshopify.com ADMIN_PASSWORD=geheim123 npm run dev
```

## Vor dem Livegang gegen einen Dev-Store prüfen
- GraphQL-Abfragen gegen `SHOPIFY_API_VERSION` (Standard 2026-07), inklusive `paymentTermsTemplates`
- Order mit Zahlungsziel (ohne B2B-Firma) und Order mit B2B-Firma: kein doppelter Rabatt, Zahlung bleibt offen
- Lieferschein-Vorlage im Dropship-Fall
- Versandmail an die Händler-E-Mail
- Betrag der Dropship-Pauschale und die konkreten Rabattstufen (Konfiguration, keine Vorgabe im Code)
