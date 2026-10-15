# PearlRhine Dropship – Installation

Stand: Code im Ordner `pearlrhine-dropship/`, Version 0.2.0. Diese Anleitung ist der maßgebliche Installationsablauf. Die kurze Fassung im README verweist hierher. Was die App danach tut, steht in [FUNKTIONSWEISE.md](FUNKTIONSWEISE.md). Wenn diese Datei und der Code widersprechen, gilt der Code.

Die App ist für genau einen Shopify-Shop gebaut. Sie läuft als ein Prozess mit einer SQLite-Datei. Zwei Instanzen auf derselben Datei sind nicht vorgesehen.

Es gibt drei Wege, die App zu starten. Für den echten Betrieb ist Weg A der richtige.

| Weg | Wann | Shopify |
| --- | --- | --- |
| A. Server mit Docker und Caddy | Betrieb für Händler | Dev-Dashboard-App, Webhooks aus `shopify.app.toml` |
| B. Nur ein vorhandenes Admin-API-Token | Es gibt schon ein Token und keine neue App im Dev Dashboard | Webhooks einmalig per `npm run register-webhooks`, `REGISTER_WEBHOOKS` bleibt danach `false` |
| C. Lokal mit Mock | Oberfläche ansehen, ohne Shop und ohne Docker | `MOCK_SHOPIFY=true`, keine echten Orders |

Weg A und Weg B nicht mischen. Wer die toml deployed und zusätzlich das Registrier-Skript ausführt, bekommt jedes Shopify-Event doppelt.

## 1. Was vorher da sein muss

- Der Shopify-Shop, dessen Bestand und Produkte die Quelle sind. Host der Form `name.myshopify.com`. Eine eigene Domain des Shops reicht der App nicht; `SHOPIFY_STORE` muss der `myshopify.com`-Host sein.
- Eine Domain für die App selbst, zum Beispiel `dropship.example.com`. Sie ist nicht die Shop-Domain. Feeds, Admin, OAuth und Webhooks hängen an dieser Domain.
- Ein Server mit Docker und dem Docker-Compose-Plugin. Die App veröffentlicht nur die Ports 80 und 443. Intern spricht Caddy `app:3000`.
- Node.js 22 oder neuer, nur wenn lokal entwickelt oder Weg B das Registrier-Skript auf dem Server ausführt. Das Produktionsimage bringt Node 22 mit.
- DNS-Zugriff für die App-Domain und Zugang zum Shopify-Dev-Dashboard des Shops.

Ports 80 und 443 müssen von außen frei sein. Ein zweiter Webserver auf demselben Host kollidiert mit Caddy. Die Firewall lässt 22, 80 und 443 zu, sonst nichts.

Produkte, die in den Feed sollen, tragen im Standard das Tag `dropship` und sind aktiv. Das steuert `PRODUCT_QUERY`. Ohne passendes Produkt bleibt der Feed leer, die App startet trotzdem.

## 2. Dieselbe Adresse an vier Stellen

Diese vier Werte sind dieselbe öffentliche HTTPS-Adresse, ohne Pfad und ohne Schrägstrich am Ende:

| Stelle | Feld |
| --- | --- |
| `.env` | `BASE_URL` |
| `Caddyfile` | der Site-Block, heute `dropship.example.com` |
| `shopify.app.toml` | `application_url` |
| `shopify.app.toml` | `redirect_urls`, genau `https://…/auth/callback` |

`SHOPIFY_API_VERSION` in der `.env` und `api_version` unter `[webhooks]` in der toml sind dieselbe Version. Standard ist `2026-07`.

Die Scope-Liste in `shopify.app.toml` und in `src/shopify/scopes.ts` bleibt gleich. Sie lautet:

`read_products`, `read_inventory`, `read_locations`, `read_orders`, `write_orders`, `write_draft_orders`, `read_draft_orders`, `read_companies`, `read_fulfillments`, `read_payment_terms`, `write_payment_terms`.

## 3. Shopify-App im Dev Dashboard

Seit dem 1. Januar 2026 lassen sich im Shop-Admin keine neuen Legacy-Custom-Apps mehr anlegen. Neue Zugänge entstehen im Dev Dashboard. Die Datei `shopify.app.toml` ist die Konfiguration, die Shopify CLI dorthin schickt. `embedded = false` ist Absicht: die Oberfläche ist eine eigene Website, kein eingebettetes Shopify-Admin-Fenster.

Auf einem Rechner mit Shopify CLI, im Ordner `pearlrhine-dropship`:

1. `client_id`, `application_url` und `redirect_urls` in `shopify.app.toml` auf die echte App setzen. `client_id` ist nach dem Anlegen der App im Dev Dashboard sichtbar. `shopify app config link` verknüpft das Verzeichnis mit dieser App und kann die `client_id` eintragen. Die Platzhalter `replace-me` und `dropship.example.com` dürfen nicht deployed werden.
2. `shopify app deploy` veröffentlicht diese toml, inklusive Scopes und Webhook-Abos. Die Webhook-URLs sind relativ (`/webhooks/shopify`). Shopify hängt sie an `application_url`. Deshalb muss die App-URL schon per HTTPS antworten, bevor Shopify die erste Zustellung prüft. Reihenfolge im Zweifel: DNS und Container zuerst, danach deployen, danach im Dashboard die Installation auf dem Shop auslösen.
3. Die App im eigenen Shop installieren und die genannten Scopes bestätigen. Distribution ist der eigene Shop, nicht der App Store.
4. Client-ID und Client-Secret aus dem Dev Dashboard in die `.env` übernehmen. Das Secret ist das HMAC-Geheimnis der Webhooks. Während einer Secret-Rotation signiert Shopify weiter mit dem ältesten noch nicht widerrufenen Secret. `SHOPIFY_WEBHOOK_SECRET` erst umstellen, wenn das alte Secret widerrufen ist.

Compliance-Webhooks (`customers/data_request`, `customers/redact`, `shop/redact`) kann nur die toml abonnieren. `npm run register-webhooks` kann sie nicht anlegen.

`REGISTER_WEBHOOKS` bleibt `false`.

### Welches Token die App benutzt

Der Prozess prüft in dieser Reihenfolge:

1. `SHOPIFY_ADMIN_TOKEN`, wenn das Feld nicht leer ist. Dann werden OAuth und Client-Credentials ignoriert.
2. Ein bei der OAuth-Installation gespeichertes Token in der SQLite-Datei.
3. Client-Credentials mit `SHOPIFY_CLIENT_ID` und `SHOPIFY_CLIENT_SECRET`. Das Token lebt etwa 24 Stunden und wird von der App erneuert.

Für Weg A reichen Client-ID und Secret, sobald die App im Shop installiert ist. Der Browser-Schritt `/auth?shop=name.myshopify.com` ist dann zusätzlich möglich, aber nicht nötig. Ohne statisches Token und ohne beide Client-Felder bricht der Start ab, außer `MOCK_SHOPIFY=true`.

Der Shop-Parameter bei OAuth muss exakt `SHOPIFY_STORE` sein und auf `.myshopify.com` enden. Sonst antwortet `/auth` mit `Unbekannter Shop`.

## 4. Server vorbereiten

Beispiel für einen einzelnen VPS. Im Verzeichnis, in dem das Compose-File liegen soll:

```bash
git clone <repository-url>
cd pearlrhine-dropship
```

Docker und Compose müssen laufen. Prüfen:

```bash
docker compose version
```

DNS: ein A-Record der App-Domain auf die IPv4-Adresse des Servers. AAAA nur, wenn der Server IPv6 wirklich annimmt. Caddy holt das Zertifikat von Let's Encrypt, sobald Port 80 aus dem Internet die Domain erreicht. Bis das Zertifikat da ist, schlagen `https://`-Aufrufe fehl. Die App selbst spricht kein TLS.

`Caddyfile` auf die echte Domain ändern. Nur der Name links ändert sich:

```
dropship.beispiel.de {
  reverse_proxy app:3000
}
```

Keine `tls`-Zeile eintragen, solange Caddy das Zertifikat selbst holen soll.

## 5. Datei `.env`

```bash
cp .env.example .env
```

`.env` steht in `.gitignore` und wird nicht mitcommitted. Rechte so setzen, dass nur der Betreiber sie liest.

Pflicht für Weg A:

```
BASE_URL=https://dropship.beispiel.de
PORT=3000
SHOPIFY_STORE=name.myshopify.com
SHOPIFY_API_VERSION=2026-07
SHOPIFY_CLIENT_ID=...
SHOPIFY_CLIENT_SECRET=...
SHOPIFY_WEBHOOK_SECRET=
REGISTER_WEBHOOKS=false
MOCK_SHOPIFY=false
ADMIN_USER=admin
ADMIN_PASSWORD=ein-langes-passwort
OUR_RETURN_ADDRESS=PearlRhine Partners, Musterstraße 1, 50667 Köln
```

`SHOPIFY_WEBHOOK_SECRET` leer lassen, wenn es dasselbe Geheimnis wie `SHOPIFY_CLIENT_SECRET` ist. Die App fällt dann auf das Client-Secret zurück. Ein anderes Secret eintragen nur, wenn Shopify die Webhooks mit genau diesem Wert signiert.

`ADMIN_PASSWORD` hat mindestens 8 Zeichen. Es liegt im Klartext in der `.env`. Basic Auth über HTTPS ist der Schutz der Admin-Oberfläche.

`DATA_DIR` in der `.env` nicht auf `./data` setzen, wenn Docker genutzt wird. `docker-compose.yml` erzwingt im Container `DATA_DIR=/data`, und das Volume `./data:/data` hängt den Host-Ordner dort ein. Ein abweichendes `DATA_DIR` in der `.env` würde ohne diese Zeile die Datenbank im Container statt auf dem Volume anlegen.

Werte, die vor dem ersten Händler festliegen sollten:

| Variable | Empfehlung zum Start |
| --- | --- |
| `PRODUCT_QUERY` | `tag:dropship AND product_status:active`, bis das Sortiment anders markiert ist |
| `DROPSHIP_LOCATION_IDS` | leer, solange jedes Lager zählt. Sonst numerische Location-IDs aus der Shopify-Admin-URL, kommagetrennt |
| `STOCK_BUFFER` / `STOCK_CAP` | `2` und `20`, sofern die Bestandsregel so bleiben soll |
| `DEFAULT_EK_DISCOUNT_PERCENT` | `30`, bis die vereinbarten Stufen feststehen |
| `DROPSHIP_FEE_NET` | `0`, bis der Pauschalbetrag feststeht. Einheit ist netto je Bestellung |
| `TAX_RATE_PERCENT` | `19` |
| `PRICES_INCLUDE_TAX` | `true`, wenn die Shopify-Preise brutto sind |
| `PAYMENT_TERMS_DAYS` | `30`. `0` und leere `PAYMENT_TERMS_TEMPLATE_ID` schalten auf den veralteten Fallback `paymentPending` |
| `ALLOWED_COUNTRIES` | `DE` oder eine Kommaliste wie `DE,AT` |
| `B2B_PRICE_LIST_ID` | leer, bis eine B2B-Preisliste der EK sein soll |

Ein vorhandenes Admin-Token statt Client-Credentials: `SHOPIFY_ADMIN_TOKEN` setzen und die Client-Felder leer lassen. Das ist Weg B. Die toml dann nicht zusätzlich mit Webhooks deployen.

## 6. Container starten

Im Ordner mit `docker-compose.yml` und `.env`:

```bash
docker compose up -d --build
```

Der Build kompiliert TypeScript und braucht für `better-sqlite3` Compiler-Pakete. Das passiert im Image, nicht auf dem Host. Der Entrypoint legt `/data` an, gibt es dem User `node` und startet den Server als diesen User.

Logs:

```bash
docker compose logs -f app
```

Erfolgreicher Start enthält eine Zeile `dropship-gateway läuft` mit `"mock":false` und dem Shop-Host. Kurz davor oder danach kommen `bestand aktualisiert` und `produktdaten aktualisiert` mit einer Variantenzahl. `varianten: 0` bei laufendem Shop heißt: die Query trifft nichts, oder Shopify hat die Abfrage abgelehnt. Die Fehlzeile steht im selben Log.

Healthcheck des Compose-Files ruft aus dem App-Container `http://127.0.0.1:3000/health` auf. Von außen:

```bash
curl -sS https://dropship.beispiel.de/health
```

Die Antwort ist JSON mit `ok`, `variants`, `products`, `priceList`, `stockUpdatedAt`, `productsUpdatedAt`. `/health` ist öffentlich.

Die Startseite `https://dropship.beispiel.de/` ist ebenfalls öffentlich und verlinkt auf `/admin`. Basic Auth: Benutzer und Passwort aus der `.env`. Falsch ist HTTP 401.

Nach einem Neustart bedient die App sofort den letzten Snapshot aus der SQLite-Datei und zieht parallel neu von Shopify.

## 7. Webhooks prüfen

Bei Weg A hat `shopify app deploy` die Abos angelegt. Im Dev Dashboard müssen diese Topics auf `https://dropship.beispiel.de/webhooks/shopify` zeigen:

- `inventory_levels/update`, `inventory_levels/connect`, `inventory_levels/disconnect`
- `orders/create`
- `products/update`
- `fulfillments/create`, `fulfillments/update`
- `app/uninstalled`
- Compliance: `customers/data_request`, `customers/redact`, `shop/redact`

Eine Testzustellung aus dem Dashboard muss HTTP 200 und den Text `ok` liefern. `401` heißt: das Signatur-Secret in der App ist nicht das Secret, mit dem Shopify signiert.

Nicht zusätzlich `npm run register-webhooks` ausführen.

Weg B, nur statisches Token, ohne toml-Webhooks: einmal, mit derselben `.env` wie der Server,

```bash
npm ci
npm run register-webhooks
```

Node 22 und die `.env` müssen in dieser Shell sichtbar sein. Das Skript legt fehlende Topics an und behandelt „already been taken“ als Erfolg. Compliance-Topics fehlen bei diesem Weg. `REGISTER_WEBHOOKS` nicht auf `true` stellen. Der Schalter würde bei jedem Prozessstart dieselben Topics noch einmal anlegen wollen. Einmaliges CLI reicht.

## 8. Shopify-Shop vorbereiten

### Produkte

- Tag `dropship` auf jedes Produkt, das in den Feed soll, sofern `PRODUCT_QUERY` nicht geändert wurde.
- SKU an jeder Variante. Ohne SKU erscheint die Variante in keinem Feed und ist nicht bestellbar.
- Barcode wird zur EAN-Spalte.
- Bestand an den Locations führen, die `DROPSHIP_LOCATION_IDS` zulässt. Leer heißt alle Locations.
- Metafelder im Namespace `dropship`, am Produkt oder an der Variante. Die Variante gewinnt bei gleichem Key. Keys: `ek` (netto, Dezimalzahl), `mpn`, `eta`, `ausgelaufen` (`true`, `1` oder `ja`), `gpsr_hersteller`, `gpsr_eu_verantwortlicher`, `sicherheitshinweise`, `weee_reg`, `datenblatt_url`, `anleitung_url`. Höchstens 20 Keys werden gelesen.

### Lieferschein

Den Inhalt von `shopify/packing-slip.liquid` in die Lieferschein-Vorlage des Shops einsetzen: Shopify-Admin, Einstellungen, Versand und Zustellung, Lieferschein. Die App rendert diese Datei nicht. Eine Testbestellung mit abweichender Rechnungs- und Lieferadresse muss den Händler als Absender zeigen, die Zeile `Bestellnummer:` und die Zeile `Rücksendungen an:`. Der Shop-Name darf auf diesem Beleg nicht stehen.

### B2B, nur wenn Katalogpreise und Zahlungsziel der Firma gelten sollen

Pro Händler eine Company mit Location und Contact. In der Location erlauben, an eine einmalige fremde Adresse zu liefern, und das Zahlungsziel setzen. Die drei numerischen IDs aus den Admin-URLs später in den Händlerdatensatz schreiben. Die ID der Preisliste nach `B2B_PRICE_LIST_ID`. Sind Company und Preisliste beide gesetzt, ignoriert die App die Händler-Rabattstufe und legt keinen eigenen Zeilenrabatt an.

Ohne diese Verknüpfung setzt die App selbst ein Netto-Zahlungsziel von `PAYMENT_TERMS_DAYS` Tagen, sofern Shopify ein passendes Payment-Terms-Template hat.

### Versandmail

Die Order trägt die E-Mail-Adresse des Händlers. Die Versandbestätigung muss in Shopify an die Order-E-Mail gehen. Die App verschickt keine Mail.

### Fulfiller

Wenn ein externer Dienst die Pakete packt, dessen Neutralversand prüfen. Dessen eigener Lieferschein würde den Shop-Namen wieder auf den Beleg bringen. Dann gilt dessen Vorlage, nicht `packing-slip.liquid`.

## 9. Ersten Händler anlegen

`https://dropship.beispiel.de/admin/retailers/new`

- Name und E-Mail. Die E-Mail bekommt die Versandmails.
- Absenderadresse vollständig, mindestens Straße. Sie wird die Rechnungsadresse der Shopify-Order und damit der Absender auf dem Lieferschein.
- Rücksendungen: an den Händler oder an `OUR_RETURN_ADDRESS`.
- EK-Rabatt leer lassen für den Standardprozentsatz, oder eine Zahl von 0 bis 100. `0` ist 0 Prozent Rabatt, nicht „Standard“.
- „Bestellungen automatisch annehmen“ aus lassen, bis die ersten Orders stimmen.
- Company-Felder leer lassen, solange Abschnitt 8 das nicht vorbereitet hat.

Speichern zeigt den API-Key einmal. Er beginnt mit `dsk_`. Danach liegt nur noch ein Hash in der Datenbank. Den Key und diese Links an den Händler geben:

- Händlerseite: `https://dropship.beispiel.de/h/<feed_token>`
- Bestand: `…/feed/<feed_token>/stock.csv` (auch `.xml` und `.json`)
- Produkte: `…/feed/<feed_token>/products.csv`

Die Händlerseite hat kein weiteres Passwort. Der Token in der URL ist das Geheimnis. Feed-Rotation und Key-Rotation gibt es auf der Händlerkarte im Admin. Danach gelten die alten URLs und der alte Key nicht mehr.

Prüfen, bevor ein Händler das bekommt:

```bash
curl -sS "https://dropship.beispiel.de/feed/<token>/stock.csv"
curl -sS "https://dropship.beispiel.de/feed/<token>/products.xml"
```

Die CSV beginnt mit `sku;ean;menge;status;eta;stand`. Die XML enthält `<ek_netto>` und `<ek_quelle>`. Ein unbekannter Token liefert `404` und den Text `Unbekannter Feed`.

Eine Testbestellung, Händler noch ohne automatische Annahme:

```bash
curl -sS -D - \
  -H "Authorization: Bearer dsk_…" \
  -H "Content-Type: application/json" \
  -d '{"reference":"TEST-1","shippingAddress":{"name":"Erika Musterfrau","address1":"Ringstraße 7","zip":"50667","city":"Köln","countryCode":"DE"},"lines":[{"sku":"ECHTE-SKU","quantity":1}]}' \
  "https://dropship.beispiel.de/api/orders"
```

Erwartung bei Prüfmodus: HTTP 201 und `"status":"on_hold"`. Im Admin unter Aufgaben die Zeile freigeben. Danach muss in Shopify eine Order mit Tag `dropship` existieren, E-Mail des Händlers, Lieferadresse des Endkunden, Rechnungsadresse des Händlers, Notiz mit Bestellnummer und Rücksendezeile. Die Zahlung bleibt offen (Zahlungsziel oder Payment pending), sie ist nicht als bezahlt markiert.

Dieselbe `reference` ein zweites Mal senden liefert HTTP 200 und legt keine zweite Shopify-Order an.

Erst danach beim Händler „automatisch annehmen“ setzen.

## 10. Lokal ohne Shopify

Nur zum Ansehen. Keine Händler-URLs aus diesem Betrieb nach außen geben.

```bash
cd pearlrhine-dropship
npm ci
MOCK_SHOPIFY=true SHOPIFY_STORE=mock.myshopify.com ADMIN_PASSWORD=geheim123 BASE_URL=http://127.0.0.1:3000 npm run dev
```

`npm ci` baut `better-sqlite3`. Dafür braucht der Rechner Python, make und g++. Node muss 22 oder neuer sein.

Admin: `http://127.0.0.1:3000/admin`, Benutzer `admin`, Passwort `geheim123`. Drei Beispielartikel `DF-TRIPOD-01`, `DF-GIMBAL-02`, `DF-CAGE-03`. Tests:

```bash
npm test
npm run typecheck
```

`MOCK_SHOPIFY` auf einem erreichbaren Server nie auf `true` lassen. Der Mock nimmt Bestellungen an und spricht nicht mit Shopify.

## 11. Weg B, nur Admin-Token

Für ein Token, das es schon gibt, und keine Dev-Dashboard-App:

- `.env`: `SHOPIFY_ADMIN_TOKEN` gesetzt, Client-ID und Secret leer, `REGISTER_WEBHOOKS=false`, `MOCK_SHOPIFY=false`.
- `shopify.app.toml` nicht deployen. Sonst entstehen zweite Webhooks, sobald beide auf dieselbe URL zeigen.
- Server wie in Abschnitt 6 starten.
- Einmal `npm run register-webhooks` mit dieser `.env`.
- HMAC: ohne Client-Secret muss `SHOPIFY_WEBHOOK_SECRET` das Secret sein, mit dem dieses Token-Setup die Webhooks signiert. Ohne Secret antwortet `/webhooks/shopify` immer mit 401, und der Bestand läuft nur noch über den Fünf-Minuten-Abgleich.

Compliance-Webhooks gibt es auf diesem Weg nicht.

## 12. Update, Backup, Störungen

Update:

```bash
git pull
docker compose up -d --build
```

Migrationen laufen beim Start über `PRAGMA user_version`. Den Ordner `data/` nicht löschen. Ein Pull, der nur Code ändert, behält Händler, Orders und den Snapshot.

Backup ist der Host-Ordner `./data` (`dropship.sqlite` plus WAL-Dateien) oder ein Snapshot der VM. Die Datei im laufenden Betrieb kopieren ist brauchbar, solange `-wal` und `-shm` mitkommen. Sauberer ist ein kurzes `docker compose stop app`, dann kopieren, dann `start`.

Rollback eines Images bringt die SQLite-Datei nicht auf ein älteres Schema zurück. Eine neue Migration nicht rückwärts ausrollen, ohne ein Backup von vorher.

| Beobachtung | Was tun |
| --- | --- |
| Container startet nicht, Text `Konfiguration ungültig` | `.env` fehlt im Compose-Kontext, Passwort kürzer als 8 Zeichen, oder weder Token noch Client-Paar noch Mock |
| `https://` kommt nicht zustande | DNS zeigt woanders hin, Port 80 von außen nicht erreichbar, oder der Caddy-Site-Name ist nicht die aufgerufene Domain. `docker compose logs caddy` |
| Health von außen 502 | App-Container läuft nicht. `docker compose ps` und `logs app` |
| Health `variants: 0`, Log zeigt HTTP 401 | Token falsch, App nicht im Shop installiert, oder Client-Credentials vor der Installation verwendet |
| Feed leer, Health zeigt Varianten | Token in der URL falsch, Händler gesperrt, oder die aufgerufene Datei heißt nicht `stock.csv` / `products.xml` und so weiter |
| Webhooks 401 | Secret stimmt nicht mit dem signierenden Shopify-Secret überein |
| Jedes Event zweimal | toml-Abo und zusätzlich Registrier-Skript oder `REGISTER_WEBHOOKS=true` |
| Admin 401 | Basic Auth. Benutzer `ADMIN_USER`, Passwort `ADMIN_PASSWORD` |
| OAuth `Unbekannter Shop` | Query `shop` ist nicht `SHOPIFY_STORE` |
| Daten nach Neustart weg | Volume fehlt. Compose muss `./data:/data` haben, im Container ist `DATA_DIR=/data` |
| Zertifikat wird nicht ausgestellt | Domain zeigt nicht auf diesen Server, oder etwas anderes belegt Port 80 |

Geheimnisse nach einem Leak: API-Key und Feed-Token des betroffenen Händlers im Admin rotieren, Client-Secret im Dev Dashboard rotieren und erst danach `SHOPIFY_CLIENT_SECRET` wechseln, Admin-Passwort in der `.env` ändern und `docker compose up -d` neu starten, damit der Prozess die neue Umgebung liest. `docker compose restart` allein lädt eine geänderte `.env` nicht zuverlässig. Dafür `docker compose up -d` verwenden.

## 13. Abnahme vor dem ersten echten Händler

- `curl https://<domain>/health` zeigt `ok: true` und eine Variantenzahl größer 0.
- Ein Test-Händler sieht im Produktfeed EK, `ek_quelle`, Bilder und GPSR-Felder der gepflegten Metafelder.
- Eine freigegebene Testorder liegt in Shopify, Zahlung offen, Tags `dropship` und `haendler-<id>`, Notiz mit Bestellnummer und Rücksendeadresse.
- Der Lieferschein dieser Order nennt den Händler als Absender und nicht den Shop.
- Ein Bestandwechsel in Shopify ist im Feed sichtbar, entweder nach dem Webhook innerhalb weniger Sekunden oder nach spätestens einem Bestandsintervall.
- Eine Fulfillment-Meldung in Shopify setzt die Händlerseite auf versendet und zeigt die Trackingnummer. Die Versandmail kommt bei der Händler-E-Mail an.
- `REGISTER_WEBHOOKS` ist `false`, und im Dashboard gibt es je Topic nur ein Abo auf diese App-URL.
