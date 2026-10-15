# PearlRhine Dropship – Funktionsweise

Stand: Code im Ordner `pearlrhine-dropship/`, Version 0.2.0. Diese Datei beschreibt, was die App tut, in welcher Reihenfolge, mit welchen Daten und wo die Grenzen liegen. Sie ist als Kontext für spätere Rückfragen an eine KI gedacht. Wenn diese Datei und der Code widersprechen, gilt der Code. Die Installation steht in [INSTALLATION.md](INSTALLATION.md).

Kurzfassung für die KI: Das ist eine Ein-Shop-Anwendung für die Agentur PearlRhine. Der eigene Shopify-B2B-Shop ist die einzige Waren- und Auftragswahrheit. Die App kopiert Bestand und Produktdaten in einen lokalen Snapshot, gibt sie Händlern als Feed und nimmt deren Endkunden-Bestellungen an. Angenommene Bestellungen werden als Shopify-Draft-Order angelegt und sofort abgeschlossen. Die App versendet nicht selbst und schickt keine eigenen Mails.

## 1. Geschäftlicher Zweck

Die Agentur übernimmt den Vertrieb für chinesische Hersteller an Händler im Inland. Die Händler sollen die Artikel in ihrem eigenen Shop listen können, ohne die Ware vorher zu kaufen. Kommt dort eine Bestellung, geht sie an PearlRhine. PearlRhine bzw. der Fulfiller versendet neutral an den Endkunden.

Dafür braucht es drei Dinge:

1. Einen Bestand, den der Händler oft genug lesen kann, manuell oder aus seinem System.
2. Produktdaten inklusive Einkaufspreis, Bildern und GPSR-Angaben, damit er listen kann.
3. Einen Weg, Bestellungen automatisch oder per Datei anzunehmen und in den Shopify-B2B-Shop zu schreiben.

Der chinesische Hersteller, dessen Lager und dessen Shop sind nicht angebunden. Was in Shopify steht, ist für diese App der Lagerbestand.

## 2. Was die App ist und was sie nicht ist

Sie ist:

- Eine Node.js-Anwendung (TypeScript, Hono, SQLite, better-sqlite3).
- Eine nicht eingebettete Shopify-App für genau einen Shop (`embedded = false` in `shopify.app.toml`). Die Oberfläche ist eine eigene Website mit HTTP-Basic-Auth, kein Shopify App Bridge.
- Ein Gateway: Shopify bleibt Master, die App hält eine Arbeitskopie und ein Bestellprotokoll.

Sie ist nicht:

- Kein öffentlicher App-Store-Multi-Tenant. Es gibt genau ein `SHOPIFY_STORE`.
- Kein Shopify Collective und kein Ersatz dafür.
- Kein Shop-Frontend und kein Theme.
- Kein System, das selbst Pakete bucht, Etiketten druckt oder E-Mails verschickt. Die Versandmail kommt aus den Shopify-Benachrichtigungen an die E-Mail, die auf der Order steht (die Händler-E-Mail).
- Kein Sortiment pro Händler. Jeder aktive Händler sieht denselben Katalog. Nur der Einkaufspreis kann pro Händler abweichen.
- Kein automatisches Storno in Shopify. Ein Storno nach Annahme ist eine Aufgabe für einen Menschen im Admin.
- Keine Preislogik mit festen Euro-Beträgen von Leon. Pauschale und Rabattstufen sind Konfiguration. Im Code stehen Standardwerte (30 % Rabatt, 0 € Pauschale, 30 Tage Zahlungsziel).

## 3. Beteiligte

| Rolle | Was sie tut | Wie sie sich ausweist |
| --- | --- | --- |
| Shopify-Shop | Produkte, Bestand, Orders, Fulfillment, Versandmail | Admin-API-Token |
| Agentur-Mitarbeiter | Händler anlegen, Prüfliste, Storno bestätigen | HTTP Basic Auth, `ADMIN_USER` / `ADMIN_PASSWORD` |
| Händler-System | Feed pullen, Bestellung per API | API-Key `Authorization: Bearer dsk_…` |
| Händler-Mensch | Feed-Links kopieren, CSV hochladen, Tracking sehen | Geheimer Link `/h/<feed_token>`, kein Login |
| Shopify-Webhooks | Bestand, Produkte, Orders, Fulfillment, Compliance | HMAC SHA-256, Base64, Header `X-Shopify-Hmac-Sha256` |

Ein gesperrter Händler (`active = 0`) bekommt weder Feed noch API noch Händlerseite. Der Datensatz bleibt.

## 4. Prozess, den eine Bestellung durchläuft

1. Shopify pflegt Produkte mit Tag `dropship` (änderbar über `PRODUCT_QUERY`) und Bestand an Locations.
2. Die App lädt Varianten, Bestand, Metafelder und optional die B2B-Preisliste. Zusätzlich patcht jeder `inventory_levels/update`-Webhook den Snapshot sofort.
3. Der Händler liest `/feed/<token>/stock.csv` alle paar Minuten und `/feed/<token>/products.csv` etwa täglich. Die angezeigte Menge ist nicht der echte Shopify-Bestand.
4. Der Endkunde bestellt im Shop des Händlers. Der Händler sendet die Bestellung an `POST /api/orders` oder lädt eine CSV auf der Händlerseite hoch.
5. Die App prüft Land, SKU und Menge gegen den veröffentlichten Bestand.
6. Bei `auto_accept` und ohne Problem wird eine Draft Order angelegt und abgeschlossen. Sonst liegt die Bestellung in der Prüfliste.
7. Shopify reserviert den echten Bestand. Die App zieht dieselbe Menge lokal ab, damit der nächste Feed nicht zu viel zeigt, bevor der Webhook kommt.
8. Der Fulfiller versendet. Shopify schickt die Versandmail an die Händler-E-Mail. Ein Fulfillment-Webhook oder der nächste Statusabruf setzt die lokale Order auf `shipped` und speichert Tracking.
9. Der Händler liest Status und Tracking per API, Händlerseite oder `tracking.csv`.

Parallel dazu: Bestellungen, die ein Händler direkt im B2B-Shop aufgibt und an eine andere Adresse als die Rechnungsadresse schickt, werden nur in Shopify mit den Tags `dropship` und `kanal-b2b_shop` markiert. Sie landen nicht in der lokalen Tabelle `orders`.

## 5. Laufzeit und Dateien

Start: `src/server.ts` lädt die Konfiguration, öffnet `DATA_DIR/dropship.sqlite`, baut das Shopify-Gateway (echt oder Mock) und hängt die HTTP-Routen an `PORT`.

Beim Start laufen sofort und danach im Intervall:

- Produktdaten alle `PRODUCT_REFRESH_MINUTES` (Standard 60).
- Bestand alle `STOCK_REFRESH_MINUTES` (Standard 5).
- Wenn `REGISTER_WEBHOOKS=true` und nicht Mock: fehlende Admin-API-Webhooks anlegen. Bei einer App mit `shopify.app.toml` muss das false bleiben.

Jobs überlappen sich nicht. Ein laufender Lauf überspringt den nächsten Tick. Fehler werden geloggt, der Prozess bleibt an.

Prozessende auf SIGINT/SIGTERM schließt die Datenbank.

| Pfad | Aufgabe |
| --- | --- |
| `src/server.ts` | Prozess, Intervalle, optionale Webhook-Registrierung |
| `src/app.ts` | Startseite, Zusammenbau der Router, Fehlerseite „Interner Fehler“ |
| `src/config.ts` | Alle Umgebungsvariablen, Abbruch bei ungültiger Konfiguration |
| `src/db.ts` | SQLite, Migrationen über `user_version`, Key-Value |
| `src/deps.ts` | Verdrahtung und die zwei entprellten Refresh-Timer (Bestand 5 s, Produkte 60 s) |
| `src/catalog.ts` | Snapshot, Bestandsregel, Reservierung, EK |
| `src/feeds.ts` | CSV, XML, JSON |
| `src/retailers.ts` | Händler, Token, API-Keys, Preisstufe |
| `src/orders/schema.ts` | Zod-Prüfung einer Bestellung |
| `src/orders/service.ts` | Statusmaschine, Shopify-Anlage, Tracking, Schwärzung |
| `src/orders/csv-import.ts` | CSV-Zeilen zu Bestellungen gruppieren |
| `src/webhooks.ts` | HMAC und Topics |
| `src/shopify/client.ts` | GraphQL, Token, Throttle |
| `src/shopify/gateway.ts` | Konkrete Queries und Mutations |
| `src/shopify/oauth.ts` | Install-URL, OAuth-HMAC, Token in `kv` |
| `src/shopify/scopes.ts` | Scope-Liste, muss mit `shopify.app.toml` gleich sein |
| `src/shopify/register-webhooks.ts` | Idempotentes Anlegen per Admin-API |
| `src/shopify/mock.ts` | Drei Beispielartikel für Tests und `MOCK_SHOPIFY` |
| `src/routes/public.ts` | `/health`, Feeds, `/api`, Webhook-Eingang |
| `src/routes/admin.ts` | `/admin` |
| `src/routes/retailer-page.ts` | `/h/<token>` |
| `src/routes/auth.ts` | `/auth` und `/auth/callback` |
| `shopify.app.toml` | Dev-Dashboard-App: Scopes, Webhooks, Compliance |
| `shopify/packing-slip.liquid` | Lieferschein zum Einfügen in den Shopify-Admin, wird von dieser App nicht gerendert |
| `scripts/register-webhooks.ts` | Einmaliges CLI, wenn keine toml-Subscriptions existieren |

HTTP-Rahmen ist Hono. JSON-Logs auf stdout, in Tests still außer bei `error`. Es gibt keine Queue, keinen Redis, keinen zweiten Prozess. Rate-Limits und Webhook-Deduplizierung liegen im RAM und sind nach einem Neustart leer.

## 6. Konfiguration

Quelle ist die Umgebung, Vorlage `.env.example`. `loadConfig` bricht den Start ab, wenn ein Feld ungültig ist. Ohne `MOCK_SHOPIFY=true` muss entweder `SHOPIFY_ADMIN_TOKEN` oder das Paar `SHOPIFY_CLIENT_ID` und `SHOPIFY_CLIENT_SECRET` gesetzt sein. Boolesche Werte akzeptieren `1`, `true`, `yes`, `ja`. Leer oder fehlend nimmt den Standard.

| Variable | Standard | Wirkung |
| --- | --- | --- |
| `PORT` | `3000` | HTTP-Port |
| `BASE_URL` | `http://localhost:3000` | Öffentliche Basis für Links, OAuth-Redirect und Webhook-URL. Muss `https://` im echten Betrieb sein |
| `DATA_DIR` | `./data` | Ordner der SQLite-Datei. Im Compose fest auf `/data` gesetzt, damit ein lokales `./data` im `.env` den Container nicht verfehlt |
| `SHOPIFY_STORE` | Pflicht | Host, z. B. `mein-shop.myshopify.com`. OAuth akzeptiert nur diesen Host und nur `*.myshopify.com` |
| `SHOPIFY_API_VERSION` | `2026-07` | Pfad der Admin-GraphQL-URL. Dieselbe Version steht in `shopify.app.toml` unter `[webhooks]` |
| `SHOPIFY_ADMIN_TOKEN` | leer | Statisches Token. Wenn gesetzt, werden OAuth und Client-Credentials ignoriert |
| `SHOPIFY_CLIENT_ID` / `SHOPIFY_CLIENT_SECRET` | leer | Dev-Dashboard-App. Secret signiert OAuth. Webhook-HMAC fällt darauf zurück, wenn `SHOPIFY_WEBHOOK_SECRET` leer ist |
| `SHOPIFY_WEBHOOK_SECRET` | leer | HMAC der Webhooks. Bei der Dev-Dashboard-App ist das das Client-Secret |
| `PRODUCT_QUERY` | `tag:dropship AND product_status:active` | Shopify-Suchsyntax für `productVariants`. Steuert, was in Bestand und Produktfeed kommt |
| `DROPSHIP_LOCATION_IDS` | leer | Kommagetrennte numerische IDs oder GIDs. Leer heißt: alle Locations der Variante summieren. Gesetzt heißt: nur diese Locations zählen für die veröffentlichte Menge |
| `STOCK_BUFFER` | `2` | Wird vom verfügbaren Bestand abgezogen |
| `STOCK_CAP` | `20` | Obergrenze der angezeigten Menge |
| `STOCK_REFRESH_MINUTES` | `5` | Vollabgleich Bestand |
| `PRODUCT_REFRESH_MINUTES` | `60` | Vollabgleich Produkte und Preisliste |
| `B2B_PRICE_LIST_ID` | leer | Numerische ID oder GID der B2B-Preisliste. Leer: keine Katalogpreise |
| `DEFAULT_EK_DISCOUNT_PERCENT` | `30` | Rabatt auf die UVP netto, wenn weder Metafeld noch Händlerstufe noch Preisliste greifen |
| `TAX_RATE_PERCENT` | `19` | Ein Steuersatz für alle Artikel. Keine Steuersätze pro Produkt |
| `PRICES_INCLUDE_TAX` | `true` | Shopify-Preis und Preisliste werden als brutto gelesen und für den EK durch `1 + Steuer` geteilt. Die Pauschale wird zum Speichern in der Order wieder hochgerechnet |
| `DROPSHIP_FEE_NET` | `0` | Netto-Pauschale je Bestellung. `0` legt keine Extra-Position an |
| `CURRENCY` | `EUR` | Währung der Pauschalen-Position |
| `PAYMENT_TERMS_DAYS` | `30` | Netto-Tage. Die App sucht ein Payment-Terms-Template mit dieser `dueInDays`, bevorzugt Typ `NET` |
| `PAYMENT_TERMS_TEMPLATE_ID` | leer | Feste Template-ID oder GID. Hat Vorrang vor der Suche. Wirkt auch bei `PAYMENT_TERMS_DAYS=0` |
| `REGISTER_WEBHOOKS` | `false` | `true` legt beim Start Webhooks per GraphQL an. Zusammen mit der toml entstehen Doppellieferungen |
| `DELIVERY_TIME_TEXT` | `1–2 Werktage` | Textspalte im Produktfeed, keine Berechnung |
| `ALLOWED_COUNTRIES` | `DE` | Kommaliste von ISO-Ländercodes. Andere Lieferländer gehen in die Prüfliste |
| `OUR_RETURN_ADDRESS` | leer | Eine Zeile. Steht in der Order-Notiz, wenn der Händler Rücksendungen an PearlRhine schickt |
| `ADMIN_USER` | `admin` | Basic Auth |
| `ADMIN_PASSWORD` | Pflicht, mindestens 8 Zeichen | Basic Auth |
| `MOCK_SHOPIFY` | `false` | Keine echten API-Aufrufe. Drei fest eingebaute Artikel |

Docker setzt im Image `NODE_ENV=production` und `DATA_DIR=/data`. Der Entrypoint legt `/data` an, gibt es dem User `node` und startet `node dist/server.js` als dieser User, damit SIGTERM die Datenbank schließt.

## 7. Datenbank

Eine Datei: `dropship.sqlite`, WAL, Foreign Keys an. Migrationen sind ein Array in `src/db.ts`. `PRAGMA user_version` ist die Nummer der nächsten noch nicht gelaufenen Migration. Neue Migrationen nur anhängen, alte Statements nicht ändern. Die fünfte Migration ergänzt `retailers.ek_discount_percent` und den Index `orders_shopify_id`.

### Tabelle `retailers`

| Spalte | Bedeutung |
| --- | --- |
| `name`, `email` | Anzeigename und Ziel der Shopify-Versandmail |
| `feed_token` | Geheimnis in Feed-URL und Händlerseite. 24 Byte, base64url |
| `api_key_hash`, `api_key_prefix` | SHA-256 des vollen Keys und die ersten 8 Zeichen nach `dsk_` |
| `sender_address` | JSON einer Adresse. Wird zur Rechnungsadresse der Order und damit zum Absender auf dem Lieferschein, sobald `address1` gefüllt ist |
| `return_mode` | `retailer` oder `us` |
| `company_id`, `company_location_id`, `company_contact_id` | Optionale Shopify-B2B-Verknüpfung. Wirksam nur, wenn alle drei gesetzt sind |
| `ek_discount_percent` | `NULL` = Standardrabatt. Sonst Zahl 0–100, eine Stelle wird auf zwei Nachkommastellen gerundet gespeichert, wenn sie aus dem Formular kommt |
| `auto_accept` | `1`: gültige Bestellungen gehen direkt nach Shopify. `0`: jede Bestellung in die Prüfliste. Neue Händler starten mit `0`, bis das Formular anders speichert. Das Admin-Formular legt ohne Haken bei „automatisch“ an |
| `active` | `0` sperrt Feed, API und Händlerseite |

### Tabelle `orders`

Eine Zeile pro Paar `(retailer_id, reference)`. `reference` ist die Bestellnummer des Händlers, nicht die Shopify-Nummer.

| Spalte | Bedeutung |
| --- | --- |
| `channel` | `api`, `csv` oder der Typ `b2b_shop`. Der Webhook für B2B-Shop-Bestellungen schreibt hier nichts |
| `status` | Siehe Statusmaschine |
| `payload` | JSON der geprüften Bestellung: Adresse, Positionen, Notiz |
| `problems` | JSON-Liste von Hinweisen. Shopify-Fehler beginnen mit `Shopify:` |
| `shopify_order_id` | GID `gid://shopify/Order/…` |
| `shopify_order_name` | z. B. `#1001` |
| `tracking` | JSON-Liste `{ company, number, url }` |
| `status_checked_at` | Letzter Shopify-Statusabruf, `datetime('now')` ohne Zeitzone, als UTC gemeint |

### Tabelle `kv`

JSON-Werte. Bekannte Schlüssel:

| Schlüssel | Inhalt |
| --- | --- |
| `snapshot.stock` | `{ stock: StockItem[], at: ISO-Zeit }` |
| `snapshot.products` | `{ products: ProductItem[], prices: [variantId, preis][], at }` |
| `shopify.oauth` | Access-Token, optional Refresh-Token, `expires_at` in Epoch-ms, Shop-Host |
| `shopify.oauth.state` | Einmal-State für den OAuth-Redirect, 10 Minuten gültig |

Nach einem Neustart liefert der Katalog sofort den letzten Snapshot, bevor der erste API-Lauf fertig ist. Ein leerer Snapshot heißt: Feeds sind leer, bis der erste Lauf klappt.

## 8. Shopify-Anbindung

### Token, in dieser Reihenfolge

1. `SHOPIFY_ADMIN_TOKEN`, wenn gesetzt. Kein Ablauf, kein Refresh.
2. Gespeichertes OAuth-Token aus `kv`, wenn der Shop-Host passt und es nicht abgelaufen ist. Mit Refresh-Token wird 60 Sekunden vor Ablauf erneuert (`grant_type=refresh_token`).
3. Client-Credentials an `https://<shop>/admin/oauth/access_token`. Das Token wird nur im RAM gehalten, etwa 24 Stunden minus 5 Minuten.

HTTP 401 ohne statisches Token verwirft das RAM-Token, setzt `expires_at` des gespeicherten Tokens auf 0 und versucht genau einmal neu. Danach kommt der normale Fehler.

GraphQL-URL: `https://<SHOPIFY_STORE>/admin/api/<SHOPIFY_API_VERSION>/graphql.json`.

Der Client wiederholt HTTP 429 und HTTP 5xx bis zu 5 Mal mit exponentiellem Warten, `THROTTLED` bis zu 8 Mal. Liegt `currentlyAvailable` unter 200, wartet er vor der Rückgabe. `userErrors` einer Mutation werden zu einer Exception mit Feld und Meldung. Die Order-Anlage fängt das und setzt die lokale Order auf `error`.

### OAuth-Installation

`GET /auth?shop=<SHOPIFY_STORE>` prüft den Shop, speichert einen State und leitet auf `/admin/oauth/authorize` mit den Scopes aus `src/shopify/scopes.ts` und Redirect `BASE_URL/auth/callback`.

`GET /auth/callback` prüft die Query-HMAC (Hex, Parameter sortiert, `hmac` und `signature` ausgenommen, Secret = Client-Secret). State muss passen und wird dabei verbraucht. Der Code wird gegen ein Access-Token getauscht und in `kv` geschrieben. Danach Redirect auf `/admin?ok=Shopify verbunden`.

Die Admin-Oberfläche bleibt hinter Basic Auth. Das OAuth-Token ist nur das API-Token, keine Sitzung für Menschen.

### Gelesene Daten

Bestand, seitenweise 100 Varianten, Query `PRODUCT_QUERY`:

- Varianten-GID, SKU, Barcode
- Inventory Item: GID, `tracked`
- je Location bis zu 10 Levels, Menge `available`

Produkte, seitenweise 25:

- Titel, Preis, Gewicht (`KILOGRAMS`, `GRAMS`, `POUNDS`, `OUNCES`, nach kg gerundet)
- Metafelder Namespace `dropship`, zuerst Produkt, dann Variante. Die Variante überschreibt gleichnamige Keys
- bis zu 6 Medien-URLs, Vendor, Produkttyp, HTML-Beschreibung
- Varianten-Titel wird an den Produkttitel gehängt, außer er ist `Default Title`

Preisliste, nur wenn `B2B_PRICE_LIST_ID` gesetzt ist, seitenweise 250: Varianten-GID auf Betrag. Die App behandelt diesen Betrag steuerlich wie den Variantenpreis (`PRICES_INCLUDE_TAX`).

Zahlungsziel-Templates: `paymentTermsTemplates { id dueInDays paymentTermsType }`. Treffer wird für die Prozesslebensdauer gecacht. Ein Fehler beim Lesen wird nicht gecacht; die Order fällt dann auf `paymentPending` zurück.

### Geschriebene Daten

`draftOrderCreate`, danach `draftOrderComplete`. Details in Abschnitt 14.

`tagsAdd` für B2B-Shop-Bestellungen, die als Dropship erkannt werden.

`webhookSubscriptionCreate`, nur über das CLI oder `REGISTER_WEBHOOKS`.

Die App schreibt keinen Bestand zurück nach Shopify, legt keine Produkte an und storniert keine Order per API.

### Scopes

`read_products`, `read_inventory`, `read_locations`, `read_orders`, `write_orders`, `write_draft_orders`, `read_draft_orders`, `read_companies`, `read_fulfillments`, `read_payment_terms`, `write_payment_terms`.

Dieselbe Liste steht in `shopify.app.toml` und in `ADMIN_SCOPES`. Eine von beiden zu ändern, ohne die andere, führt zu fehlenden Rechten oder zu einem Install, der mehr verlangt als die App nutzt.

## 9. Katalog-Snapshot und Bestandsregel

Ein `StockItem` hat `variantId`, `inventoryItemId`, `sku`, `barcode`, `tracked` und `levels`: Location-GID auf verfügbare Stückzahl.

Verfügbare Menge einer Variante:

- Nicht `tracked`: unendlich. Die Veröffentlichung deckelt trotzdem bei `STOCK_CAP`.
- Sonst Summe der Locations, negative Einzelmengen zählen als 0. Liegt `DROPSHIP_LOCATION_IDS`, zählen nur diese Locations. IDs werden vor dem Vergleich zu `gid://shopify/Location/…`.

Veröffentlichte Menge:

```
angezeigt = max(0, min(verfügbar − STOCK_BUFFER, STOCK_CAP))
```

Beispiele bei Puffer 2 und Deckel 20:

| Shopify verfügbar | angezeigt | Status, wenn nicht ausgelaufen und kein ETA |
| --- | --- | --- |
| 37 | 20 | `lieferbar` |
| 5 | 3 | `lieferbar` |
| 2 | 0 | `nicht_lieferbar` |
| 0 oder negativ | 0 | `nicht_lieferbar` |
| nicht geführt | 20 | `lieferbar` |

Status `availability`:

- Metafeld `dropship.ausgelaufen` ist `true`, `1` oder `ja` (Groß/Klein egal): `ausgelaufen`, Menge 0, auch wenn Bestand da ist.
- Sonst Menge > 0: `lieferbar`.
- Sonst Metafeld `eta` nicht leer: `nachschub`.
- Sonst: `nicht_lieferbar`.

Varianten ohne SKU kommen in keinen Feed und sind nicht bestellbar. SKU-Vergleich ist ohne Groß/Klein und mit getrimmtem Text. Zwei Varianten mit derselben SKU sind ein Datenfehler: `bySku` nimmt den ersten Treffer nach Sortierung der SKU. Die App führt die Dublette nicht zusammen.

### Webhook patcht eine Location

`inventory_levels/update` setzt `levels[Location-GID]` auf die mitgeschickte Zahl `available`. Das ist ein absoluter Wert, kein Delta. Die Location darf neu sein. Danach wird der Snapshot in `kv` geschrieben und `stockUpdatedAt` gesetzt.

Die Variante muss schon im Snapshot liegen (gleiche Inventory-Item-GID). Sonst passiert am Snapshot nichts und 5 Sekunden später startet ein Vollabgleich, falls nicht schon einer geplant ist. `inventory_levels/connect` und `disconnect` planen denselben Abgleich, ohne den Snapshot selbst zu ändern.

`products/update` plant einen Produkt-Vollabgleich in 60 Sekunden. Viele Webhooks in der Minute lösen nur einen Lauf aus.

### Lokale Reservierung

Nach erfolgreicher Shopify-Anlage zieht `reserve` die bestellte Menge von den erlaubten Locations ab, größte Location zuerst. Nicht geführte Artikel werden nicht angefasst. Die Reservierung ist absichtlich grob: der nächste Webhook oder Vollabgleich überschreibt sie mit dem echten Shopify-Wert. Sie soll nur die Lücke schließen, in der zwei Händler dieselbe letzte Menge sehen.

Storno-Bestätigung und ein von Shopify gemeldeter Cancel planen einen Bestands-Vollabgleich in 5 Sekunden. Die App bucht die Reservierung nicht selbst zurück.

## 10. Einkaufspreis

Alle EK-Werte in Feed und Rabatt sind netto, auf zwei Nachkommastellen.

Entscheidung in `Catalog.pricing`, erste passende Zeile gewinnt:

1. Metafeld `dropship.ek` an Variante oder, wenn dort leer, am Produkt, sofern die Zahl gültig ist. Der Wert wird als netto genommen und nicht durch die Steuer geteilt. Quelle `metafeld`. Eine Händlerstufe ändert daran nichts.
2. Ist für diesen Aufruf eine Händlerstufe übergeben (Zahl, auch 0): UVP netto mal `(1 − Stufe/100)`. Quelle `stufe`. Die globale Preisliste wird dann übersprungen.
3. Preisliste hat einen Preis für die Variante: netto nach derselben Steuerregel wie die UVP. Quelle `preisliste`.
4. Sonst UVP netto mal `(1 − DEFAULT_EK_DISCOUNT_PERCENT/100)`. Quelle `stufe`.

UVP netto bei `PRICES_INCLUDE_TAX=true` ist `Preis / (1 + TAX_RATE_PERCENT/100)`.

Welche Stufe ein Händler bekommt, entscheidet `pricingTier`:

- Händler hat alle drei Company-IDs und `B2B_PRICE_LIST_ID` ist gesetzt: Stufe ist `null`. Feed und Zeilenrabatt nutzen die Preisliste. Shopify soll den Katalogpreis selbst anwenden, die App setzt keinen zusätzlichen Zeilenrabatt. So entsteht kein doppelter Rabatt.
- Sonst: `ek_discount_percent` des Händlers, oder `null` wenn leer. `null` heißt in `pricing` nicht „0 %“, sondern „Stufe 3 oder 4“, also Preisliste oder Standardrabatt.

Sonderfall, den man kennen muss: Company-IDs sind gesetzt, `B2B_PRICE_LIST_ID` ist leer. Dann gilt die Händlerstufe bzw. der Standard, und die Order wird trotzdem mit `purchasingCompany` angelegt. Hat diese Firma in Shopify einen eigenen Katalog, kann Shopify zusätzlich rabattieren. Das ist im Admin-Hinweis am Formular beschrieben. Die App kann den Katalog der Firma nicht sehen, solange die Preisliste nicht konfiguriert ist.

### Zeilenrabatt auf der Draft Order

Wenn Company und Preisliste zusammenkommen: kein `appliedDiscount`.

Sonst wird der EK in die Preisdarstellung des Shops zurückgerechnet (bei Brutto-Shop mal Steuerfaktor) und als Prozent vom Shopify-Preis ausgedrückt, auf vier Nachkommastellen. Prozent kleiner oder gleich 0 wird weggelassen. Der Rabatt-Titel in Shopify ist `Händler-EK`.

Beispiel, Brutto-Shop, 19 %, Stufe 40 %, Stativ-UVP 189:

- UVP netto = 189 / 1,19 = 158,8235…
- EK netto = 158,8235… × 0,6 = 95,29
- EK brutto = 95,29 × 1,19 = 113,3951
- Rabatt = (1 − 113,3951 / 189) × 100 ≈ 40 %

Der Feed schreibt `ek_netto=95.29` und `ek_quelle=stufe`. `uvp_brutto` ist der unveränderte Shopify-Preis mit zwei Nachkommastellen, auch wenn der Shop netto führt. Der Feldname bleibt `uvp_brutto`.

`bySku` und die Bestandsprüfung rufen `items()` ohne Händlerstufe auf. Die Prüfung nutzt nur SKU, Status und Menge, nicht den EK. Der EK der konkreten Order wird erst in `pushToShopify` mit der Stufe des Händlers berechnet.

## 11. Feeds

URL: `GET /feed/<feed_token>/<kind>.<format>`

- `kind`: `stock` oder `products`
- `format`: `csv`, `json`, `xml`
- Unbekannter oder inaktiver Token: `404` und Text `Unbekannter Feed`
- Falscher Dateiname: `404` mit der Liste der gültigen Namen
- Über 60 Abrufe pro Minute und Händler: `429`

`Cache-Control: no-store`. Es gibt keinen ETag und keine Delta-Feeds. Jeder Abruf ist der volle aktuelle Snapshot.

Der Produktfeed bekommt die Preisstufe des Händlers. Der Bestandsfeed auch, aber seine Spalten enthalten keinen Preis. Zwei Händler mit verschiedener Stufe sehen dieselben Mengen und verschiedene `ek_netto`.

### Bestandsspalten

`sku`, `ean`, `menge`, `status`, `eta`, `stand`

`stand` ist `stockUpdatedAt` des Snapshots, nicht die Uhrzeit des HTTP-Abrufs. `ean` ist der Shopify-Barcode.

### Produktspalten

`sku`, `ean`, `hersteller_artnr` (Metafeld `mpn`), `marke` (Vendor), `titel`, `beschreibung_html`, `beschreibung_text`, `kategorie` (productType), `bilder`, `gewicht_kg`, `uvp_brutto`, `ek_netto`, `ek_quelle`, `waehrung`, `menge`, `status`, `lieferzeit`, `gpsr_hersteller`, `gpsr_eu_verantwortlicher`, `sicherheitshinweise`, `weee_reg_nr` (`weee_reg`), `datenblatt_url`, `anleitung_url`.

### Formate

- JSON: `{ generated_at, stock_at, items }`. `generated_at` ist der Abrufzeitpunkt. `bilder` bleibt ein Array.
- CSV: Semikolon, RFC 4180, UTF-8 mit BOM für Excel. Arrays als `url1|url2`. Felder mit Anführungszeichen, Semikolon oder Zeilenumbruch werden gequotet.
- XML: Wurzel `<feed generated_at stock_at>`. Bestandszeile `<artikel>`, Produktzeile `<produkt>`. Bilder als wiederholte `<url>` in `<bilder>`. Text ist XML-escaped.

Leerer Katalog liefert eine fast leere Datei mit Kopf bzw. leerem `<feed>`, keinen Fehler.

`GET /api/stock` mit API-Key ist derselbe Bestand als JSON: `sku`, `ean`, `quantity`, `status`, `eta`, plus `stock_at`. Ohne Preise.

## 12. Händler-API

Basis `/api`. Auth: `Authorization: Bearer dsk_<8 Zeichen>_<Geheimnis>`. Gespeichert wird nur SHA-256. Die Suche läuft über das Präfix, der Vergleich ist `timingSafeEqual`. Falscher Key: `401` `{ "error": "unauthorized" }`. Über 120 Requests pro Minute und Händler: `429`.

| Methode und Pfad | Ergebnis |
| --- | --- |
| `GET /api/stock` | Bestand |
| `POST /api/orders` | Anlegen. `201` neu, `200` gleiche Referenz schon da. Body ist die öffentliche Order |
| `GET /api/orders?days=30` | Liste, `days` höchstens 365, Limit 500 |
| `GET /api/orders/<referenz>` | Eine Order, Status wird aus Shopify nachgezogen |
| `POST /api/orders/<referenz>/cancel` | Storno anfragen |

Die Referenz in der URL darf Punkte und Schrägstriche enthalten. Die Route ist `/api/orders/:reference{.+}` und der Wert wird dekodiert.

### Body von `POST /api/orders`

```json
{
  "reference": "A-1001",
  "shippingAddress": {
    "name": "Erika Musterfrau",
    "company": "",
    "address1": "Ringstraße 7",
    "address2": "",
    "zip": "50667",
    "city": "Köln",
    "countryCode": "DE",
    "phone": ""
  },
  "lines": [{ "sku": "DF-TRIPOD-01", "quantity": 1 }],
  "note": ""
}
```

Prüfung, bevor irgendetwas gespeichert wird:

- `reference`: 1–64 Zeichen, nur Buchstaben, Ziffern und `. - _ / #`.
- Name mindestens 3, Straße mindestens 3, PLZ mindestens 4, Ort mindestens 2, Land genau 2 Buchstaben, Standard `DE`.
- Land `DE`: PLZ muss `^\d{5}$` sein.
- 1–50 Positionen, Menge je Position 1–100, SKU nicht leer.
- Notiz höchstens 500 Zeichen.
- Fehler: `422` `{ "error": "validation", "issues": ["…"] }`.
- Kein JSON: `400` `{ "error": "invalid_json" }`.

Fachliche Prüfung danach, gegen den Snapshot:

- Land nicht in `ALLOWED_COUNTRIES`.
- SKU unbekannt.
- SKU ausgelaufen.
- Summe der Menge dieser SKU über alle Zeilen größer als die veröffentlichte Menge.

Treffer werden als `problems` gespeichert. Die Order wird trotzdem angelegt, mit Status `on_hold`. Sie geht nicht nach Shopify, bis jemand sie im Admin freigibt. Die Freigabe prüft den Bestand nicht noch einmal.

### Öffentliche Sicht für den Händler

Felder: `reference`, `status`, `channel`, `order_name`, `tracking`, `problems`, `created_at`, `updated_at`.

Interner Status `error` wird nach außen `on_hold`. Die Probleme lauten dann nur `Wird von uns geprüft`. Shopify-Meldungen (`Shopify: …`) sieht der Händler nicht. Bei `on_hold` und `rejected` sieht er die fachlichen Probleme ohne die Shopify-Zeilen.

### Idempotenz

Gleicher Händler und gleiche `reference`: die vorhandene Zeile kommt zurück, Shopify wird nicht noch einmal aufgerufen. Das gilt auch, wenn die erste noch `on_hold` oder `error` ist. Eine Korrektur derselben Nummer legt keine neue Order an. Zwei parallele Requests: die zweite Insert-Unique-Verletzung wird als Duplikat gelesen, nicht als 500.

Verschiedene Händler dürfen dieselbe `reference` haben. Das sind zwei Orders.

## 13. Statusmaschine

| Status | Bedeutung | Wie er entsteht |
| --- | --- | --- |
| `on_hold` | Prüfliste | Validierung fachlich fehlgeschlagen, oder Händler ohne `auto_accept`. Auch der Zwischenstatus in der Datenbank, bevor Shopify geantwortet hat |
| `accepted` | In Shopify angelegt, nicht als versendet bekannt | Shopify-Anlage hat eine Order-GID zurückgegeben |
| `error` | Anlage fehlgeschlagen | Exception aus dem Gateway. Für den Händler sieht das aus wie `on_hold` |
| `rejected` | Abgelehnt | Admin, mit Grund |
| `shipped` | Versand bekannt | Fulfillment-Webhook oder Statusabruf `FULFILLED` / `PARTIALLY_FULFILLED` |
| `cancel_requested` | Händler will stornieren, Order existiert in Shopify | API-Storno aus `accepted` |
| `cancelled` | Storniert | Sofort aus `on_hold` oder `error`; oder Admin bestätigt `cancel_requested`; oder Shopify meldet `cancelledAt` |
| `returned` | Rückläufer | Shopify `returnStatus` `RETURNED` oder `INSPECTION_COMPLETE` |

Übergänge, die der Code erlaubt:

- Anlegen → `on_hold` oder (nach Shopify) `accepted` oder `error`.
- Admin `approve` nur aus `on_hold` und `error`.
- Admin `reject` nur aus `on_hold` und `error`.
- Händler-Storno aus `on_hold` und `error` → `cancelled`. Aus `accepted` → `cancel_requested`. Aus `shipped`, `cancel_requested`, `cancelled`, `rejected`, `returned` → 422.
- Admin „Storno erledigt“ nur aus `cancel_requested` → `cancelled`, danach Bestandsabgleich.
- Statusabruf darf `accepted`, `shipped`, `cancel_requested` auf `cancelled`, `returned` oder `shipped` heben. Andere lokale Status werden nicht abgefragt.
- Fulfillment-Webhook setzt `accepted` und `cancel_requested` auf `shipped`, wenn der Fulfillment-Status nicht `cancelled`, `failure` oder `error` ist. Andere lokale Status behalten ihren Status und bekommen trotzdem Tracking, wenn Nummern mitkommen.

Der Statusabruf ist 5 Minuten gecacht (`status_checked_at`). Die Händlerseite zieht beim Öffnen höchstens die ersten 20 offenen Orders der letzten 60 Tage nach. Die Tracking-CSV zieht höchstens die ersten 50 der letzten 30 Tage nach, Liste bis 1000 Zeilen.

Teilversand gilt als `shipped`. Es gibt keinen Status „teilweise versendet“.

## 14. Anlage in Shopify

`pushToShopify` baut eine Draft Order.

| Order-Feld | Herkunft |
| --- | --- |
| `email` | Händler-E-Mail. Dorthin geht die Shopify-Versandmail |
| `shippingAddress` | Endkunde aus der Bestellung. Der Name wird am letzten Wort getrennt: letztes Wort Nachname, der Rest Vorname |
| `billingAddress` | Absenderadresse des Händlers, nur wenn `address1` gefüllt ist. Der Lieferschein behandelt die Rechnungsadresse im Dropship-Fall als Absender |
| `lineItems` | Variante, Menge, optional Prozent-Rabatt `Händler-EK` |
| Extra-Position | Nur wenn `DROPSHIP_FEE_NET > 0`. Titel `Dropship-Pauschale`, Menge 1, nicht versandpflichtig, steuerpflichtig. Betrag ist netto mal Steuerfaktor, wenn Preise brutto sind, sonst netto. Zwei Nachkommastellen |
| `tags` | `dropship`, `haendler-<id>`, `kanal-api` oder `kanal-csv` |
| Custom Attributes | `Händler`, `Händler-Bestellnr` |
| `note` | Zeilen: `Bestellnummer: …`, `Rücksendungen an: …`, `Hinweis Händler: …`. Leerzeilen fallen weg |
| `purchasingEntity.purchasingCompany` | Die drei Company-GIDs, nur wenn alle drei IDs gesetzt sind |
| `paymentTerms` | Template-GID, siehe unten |

Rücksendezeile: bei `return_mode=us` der Text `OUR_RETURN_ADDRESS`, sonst die Absenderadresse in einer Zeile (Firma, Name, Straße, Zusatz, PLZ Ort, Land).

Zahlungsziel:

- Mit B2B-Firma: kein Template an der Draft. `draftOrderComplete` ohne `paymentPending`, damit die Zahlungsbedingungen der Firma gelten.
- Ohne Firma und (`PAYMENT_TERMS_DAYS > 0` oder eine Template-ID): Template an die Draft, Complete ohne `paymentPending`. Die Terms halten die Zahlung offen.
- Sonst: Complete mit `paymentPending: true`. Das Argument ist in der Admin-API 2026 als veraltet markiert und bleibt der Fallback, damit die Order nicht als bezahlt geschlossen wird.

Das Template wird einmal geholt und gecacht. Konfigurierte ID gewinnt. Sonst das Template mit passenden Tagen und Typ `NET`, sonst irgendeines mit passenden Tagen. Kein Treffer oder Lesefehler: `paymentPending`.

Nach Erfolg: Status `accepted`, GID und Name gespeichert, Bestand lokal reserviert. Die Insert-Zeile steht bis dahin auf `on_hold`, auch wenn sie eigentlich angenommen werden soll. Stirbt der Prozess zwischen Insert und Shopify-Antwort, bleibt `on_hold` ohne Shopify-GID. Ein Mensch kann freigeben; das legt dann eine Order an. Ein zweites API-POST derselben Referenz legt nichts Neues an.

Schlägt Shopify fehl, wird aus der Exception eine Problemzeile `Shopify: …` und der Status `error`. Der Händler sieht Prüfung. Admin kann „Erneut senden“.

Die App setzt kein `sourceName`. Sie markiert die Order nicht als bezahlt und legt keine Transaktion an.

## 15. B2B-Shop-Bestellungen

Webhook `orders/create`. Eine Order gilt als Dropship, wenn alle Punkte stimmen:

- `company.id` ist gesetzt.
- Die Tags enthalten nicht schon `dropship` (Komma-getrennt, getrimmt).
- Liefer- und Rechnungsadresse sind beide da.
- Straße, PLZ oder Name unterscheiden sich. Vergleich: getrimmt, kleingeschrieben, Whitespace auf ein Leerzeichen gefaltet.

Dann `tagsAdd` mit `dropship` und `kanal-b2b_shop`. Es entsteht keine Zeile in `orders`, kein Feed-Eintrag und keine Händler-API-Antwort. Wer diese Aufträge in der lokalen Prüfliste sehen will, muss das neu bauen. Heute sind sie nur in Shopify markiert.

## 16. Fulfillment und Tracking

Topics `fulfillments/create` und `fulfillments/update`.

Die App sucht `orders.shopify_order_id` über `gid://shopify/Order/<order_id>` aus dem Webhook. Keine Zeile: stilles Ignorieren, HTTP bleibt 200.

Status `cancelled`, `failure` oder `error`: keine Änderung.

Tracking-Nummern aus `tracking_numbers` oder der einzelnen `tracking_number`. URLs analog. Firma aus `tracking_company`. Neue Nummern werden mit vorhandenen über die Nummer zusammengeführt, dieselbe Nummer wird ersetzt. Ohne Nummern bleibt das alte Tracking.

Liegt die Order auf `accepted` oder `cancel_requested`, wird sie `shipped`. Ein Storno-Wunsch, der schon versendet wurde, erscheint danach als versendet.

Der langsame Weg ist `order(id)` mit `cancelledAt`, `displayFulfillmentStatus`, `returnStatus` und `fulfillments.trackingInfo`. Der überschreibt die Tracking-Liste mit dem, was Shopify gerade liefert.

## 17. Webhook-Eingang

`POST /webhooks/shopify`.

HMAC über den rohen Body, SHA-256, Secret `SHOPIFY_WEBHOOK_SECRET` oder sonst Client-Secret, Vergleich zeitkonstant gegen den Base64-Header. Ohne Secret oder ohne Header: 401. Falsche Signatur: 401 und ein Log. Die Antwort `ok` geht sofort mit 200 raus. Die Verarbeitung läuft danach in einem Microtask. Shopify soll unter 5 Sekunden eine Antwort haben. Ein Fehler in der Verarbeitung wird geloggt und nicht an Shopify zurückgegeben. Shopify wiederholt dann nicht, weil es schon 200 gab.

Header `X-Shopify-Topic` ist der REST-Name (`inventory_levels/update`), nicht das GraphQL-Enum (`INVENTORY_LEVELS_UPDATE`). Header `X-Shopify-Webhook-Id` dedupliziert im RAM. Über 5000 IDs werden Einträge älter als eine Stunde gelöscht. Nach einem Neustart kann dieselbe Lieferung noch einmal laufen. Bestands-Patches und Tag-Adds vertragen das. Ein Fulfillment mit derselben Trackingnummer auch.

Compliance, nur über die toml abonnierbar, nicht über die Admin-API:

- `customers/data_request`: nur ein Log. Die App hat keinen automatischen Datenexport an den Händler.
- `customers/redact`: für jede ID in `orders_to_redact` wird die passende lokale Order gesucht. Liefername, Firma, Straßen, PLZ-Anzeige, Ort und Telefon werden durch `geschwärzt` bzw. leer ersetzt, PLZ wird `00000`, die Notiz wird leer. Das Land bleibt. Unbekannte IDs werden übersprungen. Es gibt keine Kundentabelle.
- `shop/redact`: nur eine Warnung. Die SQLite-Datei wird nicht gelöscht. Das ist Absicht bei dieser Ein-Shop-App, weil ein versehentliches Leeren die Händler-Tokens zerstören würde.
- `app/uninstalled`: nur eine Warnung. Das OAuth-Token bleibt in `kv` liegen und wird beim nächsten API-Call scheitern oder per Client-Credentials ersetzt, je nach Konfiguration.

## 18. CSV-Bestellimport

Händlerseite `POST /h/<token>/upload`, Feld `file`, höchstens 2 MB.

Kopfzeile, Groß/Klein egal. Standard:

`bestellnummer;sku;menge;name;firma;strasse;adresszusatz;plz;ort;land;telefon;notiz`

Englische und weitere Aliase werden auf diese Namen gefaltet (`reference`, `sku`, `quantity`, `street`, `zip`, `city`, `country`, `phone`, `note`, `straße`, …). Trennzeichen ist Semikolon, wenn die erste Zeile mindestens so viele Semikolons wie Kommas hat, sonst Komma.

Zeilen mit derselben Bestellnummer sind eine Order. Adresse und Notiz kommen aus der ersten Zeile der Gruppe. Fehlende Bestellnummer in einer Datenzeile ist ein Fehler, der Rest wird trotzdem versucht. Fehlende Pflichtspalten brechen die ganze Datei ab: `bestellnummer`, `sku`, `menge`, `name`, `strasse`, `plz`, `ort`.

Jede Gruppe läuft durch dieselbe `submit`-Funktion wie die API, Kanal `csv`. Die Antwort ist ein Redirect mit Kurztext: wie viele neu, wie viele in Prüfung, wie viele schon da, und bis zu 10 Fehlertexte.

Vorlage: `GET /h/<token>/vorlage.csv`.

## 19. Admin

Basic Auth auf `/admin` und `/admin/*`. Falsch: 401.

| Pfad | Funktion |
| --- | --- |
| `GET /admin` | Karten: Varianten im Feed, davon mit Menge > 0, offene Aufgaben (`on_hold`, `error`, `cancel_requested`), aktive Händler. Zeitstempel und die Bestandsformel. Button „Jetzt aus Shopify neu laden“ |
| `POST /admin/refresh` | Bestand und Produkte sofort. Fehler als Redirect-Text |
| `GET /admin/orders` | Letzte 300 Orders |
| `POST /admin/orders/:id/approve` | Freigeben oder erneut senden |
| `POST /admin/orders/:id/reject` | Feld `reason` |
| `POST /admin/orders/:id/cancel-done` | Storno in Shopify wurde von Hand erledigt |
| `GET /admin/retailers` | Liste |
| `POST /admin/retailers` | Anlegen. API-Key wird einmal im HTML gezeigt und danach nur noch als Präfix |
| `POST /admin/retailers/:id` | Speichern, inklusive Stufe und Aktiv-Flag |
| `POST …/rotate-key` | Alter Key sofort ungültig |
| `POST …/rotate-feed` | Feed-URL und Händlerseite ändern sich |

Die Startseite `/` ist öffentlich, erklärt den Zweck und verlinkt auf `/admin`. Steht eine Client-ID, gibt es zusätzlich „Mit Shopify verbinden“.

EK-Rabatt im Formular: leer speichert `NULL`. `150` oder Text ist ein Fehler „EK-Rabatt muss zwischen 0 und 100 liegen“. Komma wird als Dezimaltrenner gelesen. `0` ist ein gültiger Rabatt von 0 %, nicht „Standard“.

## 20. Händlerseite

`GET /h/<feed_token>`. Kein zweites Passwort. Wer den Token hat, sieht Bestellungen, lädt CSV hoch und lädt Tracking herunter. Der Token ist ein Geheimnis und steht in jeder Feed-URL.

Die Seite zeigt die Preisstufe (oder „Standard x %“), die Feed-Links, das Upload-Formular und die Orders der letzten 60 Tage. Interne `error`-Orders erscheinen als Prüfung. Shopify-Fehlertexte werden ausgeblendet.

`GET /h/<token>/tracking.csv`: `bestellnummer`, `status`, `versanddienstleister`, `trackingnummer`, `tracking_url`. Ohne Tracking eine Zeile mit leeren Tracking-Feldern. Mit mehreren Nummern mehrere Zeilen.

## 21. Lieferschein

`shopify/packing-slip.liquid` wird nicht von Node gerendert. Ein Mensch fügt den Inhalt im Shopify-Admin unter Versand, Lieferschein-Vorlage, ein.

Dropship ist dort wahr, wenn Rechnungs- und Lieferadresse in Straße oder PLZ abweichen. Dann:

- Absender ist Firma der Rechnungsadresse, sonst der Name, plus Straße und Ort. Kein Shop-Name.
- Die Zeile aus `order.note`, die `Bestellnummer:` enthält, wird gedruckt.
- Die Zeile, die `Rücksendungen an:` enthält, wird gedruckt.
- Der Dankes-Footer mit Shop-Namen entfällt.
- Positionen nur, wenn `requires_shipping`. Die Pauschale fällt damit weg.

Ohne Adressunterschied bleibt es ein normaler Lieferschein mit Shop-Absender und Shopify-Bestellname.

Die Notiz muss exakt diese Präfixe enthalten. `pushToShopify` schreibt sie so.

## 22. Sicherheit und Betriebsgrenzen

- Feed-Token und API-Key sind Bearer-Geheimnisse. Sie liegen in URLs bzw. Headern. Zugriffslogs des Proxys enthalten den Token.
- API-Keys werden gehasht. Feed-Tokens liegen im Klartext, weil sie die URL sind.
- Admin-Passwort liegt im Klartext in der Umgebung. Basic Auth ohne weitere Sitzung.
- `/health` ist öffentlich und nennt Variantenzahl und Zeitstempel.
- Rate-Limits sind pro Prozess. Zwei Instanzen hinter einem Load Balancer hätten getrennte Zähler und getrennte Snapshots. Die App ist für eine Instanz gebaut. SQLite ist nicht für mehrere Schreiber auf derselben Datei ausgelegt.
- Webhook-Deduplizierung und OAuth-State liegen im RAM bzw. in `kv`. HMAC ist Pflicht.
- Die Händlerseite hat keine zweite Authentifizierung.
- Es gibt keine Mandantentrennung über den Händler-Datensatz hinaus. Ein gültiger Token sieht den ganzen Katalog und nur die eigenen Orders.
- Länder außerhalb der Allowlist werden nicht still verworfen, sondern in die Prüfliste gelegt. Ein Admin kann sie trotzdem freigeben.
- Die Freigabe überspringt die Mengenprüfung. Damit kann man bewusst überbuchen.
- Ein Steuersatz, eine Währung, ein Shop, ein Standort-Filter.
- Gewichtsunbekannte Varianten haben `weightKg: null` und eine leere CSV-Zelle.
- Metafelder außerhalb des Namespace `dropship` werden ignoriert. Mehr als 20 Keys pro Produkt oder Variante werden von der Query abgeschnitten (`first: 20`).
- Mehr als 10 Inventory-Levels pro Variante werden abgeschnitten (`first: 10`).
- Mehr als 6 Bilder werden abgeschnitten.

## 23. Deployment

Der schrittweise Ablauf steht in [INSTALLATION.md](INSTALLATION.md). Hier nur die technischen Eckpunkte.

`docker-compose.yml`: Dienst `app` baut das Dockerfile, mountet `./data` nach `/data`, Healthcheck auf `GET /health`. Davor Caddy mit dem `Caddyfile`. Die Beispiel-Domain ist `dropship.example.com` und muss in Caddyfile, `BASE_URL`, `application_url` und `redirect_urls` dieselbe HTTPS-Adresse sein.

Ablauf für den echten Shop:

1. App im Dev Dashboard anlegen, `client_id` in `shopify.app.toml` eintragen, URLs auf die echte Domain setzen, Scopes nicht verkleinern.
2. `.env` aus der Vorlage. Entweder vorhandenes Admin-Token oder Client-ID und Secret. `REGISTER_WEBHOOKS=false`, weil die toml die Webhooks schon abonniert.
3. `docker compose up -d --build`.
4. Einmal `/auth?shop=<shop>.myshopify.com` öffnen, falls kein statisches Token und kein reiner Client-Credentials-Lauf gewünscht ist. Client-Credentials reichen für den API-Zugriff einer im eigenen Shop installierten Dev-Dashboard-App.
5. Lieferschein-Vorlage in Shopify einsetzen und mit einer Testbestellung prüfen.
6. B2B-Firma des Händlers: Lieferung an einmalige Adressen erlauben, Zahlungsziel setzen, wenn der Katalogpreis von Shopify kommen soll. Dann Company-, Location- und Contact-ID aus der Admin-URL in den Händler schreiben und `B2B_PRICE_LIST_ID` setzen.
7. Händler anlegen, API-Key einmal kopieren, zuerst ohne automatische Annahme laufen lassen.
8. Backup ist der Ordner `data/` oder ein Snapshot der VM.

`npm run register-webhooks` ist der Weg für ein reines Admin-Token ohne toml-Subscriptions. Es legt fehlende Topics an und behandelt „already been taken“ als Erfolg. Compliance-Topics kann dieses Skript nicht anlegen.

Lokal ohne Shopify:

```
MOCK_SHOPIFY=true SHOPIFY_STORE=x.myshopify.com ADMIN_PASSWORD=geheim123 npm run dev
```

Der Mock hat drei Artikel an Location `gid://shopify/Location/1`:

| SKU | EAN | Titel | Preis brutto | Bestand |
| --- | --- | --- | --- | --- |
| `DF-TRIPOD-01` | `6970000000011` | Carbon-Stativ T1 | 189 | 37 → angezeigt 20 |
| `DF-GIMBAL-02` | `6970000000028` | Gimbal G2 | 249 | 5 → angezeigt 3 |
| `DF-CAGE-03` | `6970000000035` | Kamera-Cage C3 | 79 | 1 → angezeigt 0 |

Tests: `npm test` (Vitest, Mock, In-Memory-SQLite). `npm run typecheck`. Die Testdatei `test/flows.test.ts` ist die Spezifikation der HTTP-Abläufe, `test/units.test.ts` die der Preis- und CSV-Regeln.

## 24. Fehlerbilder

| Beobachtung | Wahrscheinliche Ursache |
| --- | --- |
| Feed 404 | Token rotiert, Händler gesperrt, oder Tippfehler in `stock.csv` / `products.xml` |
| Feed leer, Health zeigt `variants: 0` | `PRODUCT_QUERY` trifft nichts, Token fehlt, oder der erste Shopify-Lauf ist fehlgeschlagen. Logs nach `bestand aktualisiert` und `Shopify HTTP` |
| Menge immer 0 trotz Lager | Puffer schluckt den Rest, Location-Filter schließt das Lager aus, oder `ausgelaufen` ist gesetzt |
| Zwei Händler sehen verschiedene EK, gleiche Mengen | Preisstufe. So ist es gebaut |
| Händlerstufe steht im Formular, Feed zeigt Preisliste | Company-IDs und `B2B_PRICE_LIST_ID` sind beide gesetzt. Die Stufe wird dann ignoriert |
| Order `on_hold`, Problem „SKU … verfügbar“ | Veröffentlichte Menge, nicht der rohe Shopify-Bestand |
| Order für den Händler „in Prüfung“, im Admin `error` | Shopify hat die Draft abgelehnt. Die letzte `problems`-Zeile beginnt mit `Shopify:` |
| Zweite POST derselben Nummer ändert die Adresse nicht | Idempotenz. Neue Nummer oder die Zeile löschen, Löschen gibt es in der UI nicht |
| Storno aus `shipped` geht nicht | Absicht. 422 |
| `cancel_requested` bleibt liegen | Jemand muss in Shopify stornieren und im Admin „Storno erledigt“ klicken |
| Webhooks 401 | Secret leer oder nicht das Client-Secret, mit dem Shopify signiert. Während einer Secret-Rotation signiert Shopify mit dem ältesten noch gültigen Secret |
| Jedes Event zweimal | toml-Subscription und zusätzlich `REGISTER_WEBHOOKS` oder das CLI |
| Bestand hinkt 5 Minuten hinterher | Webhook kam nicht an, der Vollabgleich ist der Rückfall |
| Nach Neustart kurz der alte Bestand | Snapshot aus `kv`, bis der erste Lauf fertig ist |
| OAuth 400 „Unbekannter Shop“ | `shop` ist nicht exakt `SHOPIFY_STORE` oder kein `*.myshopify.com` |
| Container schreibt keine Datenbank | `DATA_DIR` zeigt nicht auf das Volume. Compose erzwingt `/data` |

## 25. Was eine spätere Änderung nicht still voraussetzen darf

- Beträge der Pauschale und die Liste der Rabattstufen sind nicht fachlich festgelegt. Sie kommen aus der Umgebung und aus `ek_discount_percent`.
- Es gibt keine zweite Datenbank und keine Historie der Bestände. `kv` hält nur den letzten Snapshot.
- Bestellungen aus dem B2B-Shop selbst sind nicht in `orders`.
- Die App cancelt Shopify-Orders nicht.
- Die App schreibt keinen Bestand nach Shopify.
- `paymentPending: true` ist ein Fallback, kein gewünschter Dauerweg.
- Ein Händler-Feed ist kein personalisiertes Sortiment.
- Tests laufen gegen `MockShopifyGateway`. Ein grüner Test beweist nicht, dass die GraphQL-Felder der konfigurierten API-Version im echten Shop noch heißen wie in `src/shopify/gateway.ts`. Vor einem Livegang die Queries gegen den Dev-Store prüfen: Bestand, Draft anlegen, Complete mit Terms, Complete mit B2B-Firma, Tag, Webhook-Signatur, Lieferschein, Versandmail.

Wenn eine KI etwas ergänzt, soll sie die bestehende Statusmaschine, die Idempotenz über `(Händler, Bestellnummer)` und die Regel „Shopify ist Master, die App publiziert eine gedeckelte Kopie“ beibehalten, außer die Aufgabe sagt ausdrücklich etwas anderes.
