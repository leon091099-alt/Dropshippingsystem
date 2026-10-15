# Dropship-Gateway – Build-Status (6.10.2026)

Konzept: Claude-Doc „Dropshipping-System – Konzept“ (https://claude.ai/code/artifact/eb399458-a348-49cd-9159-cecd35799611)
Code: pearlrhine-dropship.zip (im Chat vom 6.10.2026 übergeben), Node/TypeScript, Hono, SQLite, Docker + Caddy.

## Gebaut
- Bestands-Snapshot (Webhook-Patch + 5-Min-Abgleich), Regel min(verfügbar − 2, 20), lokale Reservierung nach Order
- Feeds stock/products als CSV/XML/JSON pro Händler-Token
- REST-API (Bestellung anlegen idempotent, Status/Tracking, Storno-Anfrage), CSV-Upload auf Händlerseite
- Anlage als Draft Order → Order (paymentPending), EK als Zeilenrabatt oder B2B-Katalog
- orders/create-Webhook markiert B2B-Shop-Bestellungen mit abweichender Lieferadresse als dropship
- Admin /admin: Händler, Prüfliste, Freigabe/Ablehnung, Storno-Aufgaben
- Lieferschein-Vorlage (Liquid) mit Neutralversand: Händler = Rechnungsadresse, Rücksendeadresse + Händler-Bestellnr über order.note
- 22 Tests gegen Mock-Shopify grün

## Offen
- Live-Test gegen Dev-Store (GraphQL-Schema, paymentPending deprecated, Katalogpreis vs. Rabatt, Lieferschein, Versandmail)
- Dropship-Pauschale (DROPSHIP_FEE_NET) und Preisstufen von Leon
- Deployment auf VPS, Webhook-Registrierung
- Shopify Collective im Pilot testen
