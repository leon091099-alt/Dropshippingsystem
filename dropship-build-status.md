# Dropship-Gateway – Build-Status

Konzept: Dropshipping für die China-Agentur. Der eigene Shopify-B2B-Shop bleibt die Waren- und Auftragswahrheit. Die App dazwischen liefert Händlern Produkt- und Bestandsfeeds und nimmt deren Bestellungen an.

Code: `pearlrhine-dropship/` (Node, TypeScript, Hono, SQLite, Docker + Caddy). Shopify-App-Konfiguration: `shopify.app.toml`.

## Fertig
- Bestands-Snapshot (Webhook sofort, Vollabgleich alle 5 Min., Puffer/Deckel, lokale Reservierung)
- Unbekannter Bestands-Webhook und Connect/Disconnect stoßen einen Abgleich an
- Feeds stock/products als CSV, XML, JSON pro Händler, EK je Preisstufe (`ek_quelle`)
- REST-API und CSV-Upload, idempotent auch bei paralleler gleicher Bestellnummer
- Draft Order mit EK-Rabatt oder B2B-Katalog; Zahlungsziel über Payment-Terms-Template, `paymentPending` nur noch als Fallback
- Fulfillment-Webhook schreibt Tracking; Polling bleibt für die Händlerseite
- Admin, Händlerseite, Lieferschein-Vorlage, Compliance-Webhooks (`customers/redact` schwärzt Adressen)
- OAuth-Callback, Client-Credentials und statisches Admin-Token
- Tests gegen Mock-Shopify

## Braucht den Dev-Store
- Einmal installieren (Dev Dashboard, `client_id` in `shopify.app.toml`, Domain in Caddyfile und `BASE_URL`)
- GraphQL, Zahlungsziel, Katalogpreis und Lieferschein mit einer echten Testbestellung prüfen
- Dropship-Pauschale und die konkreten Rabattstufen eintragen
- Deployment auf den VPS (`docker compose up -d --build`)
- Shopify Collective nur als separater Pilot, nicht Teil dieser App
