# HERO Angebots-Nachfassen (Netlify Scheduled Function)

Läuft täglich (Standard: 07:00 UTC, siehe `netlify.toml`) und holt offene Angebote aus
HERO Software (GraphQL-API), die seit `HERO_FOLLOWUP_DAYS` Tagen (Standard 7) unbeantwortet
sind.

**Kein Angebot wird automatisch verschickt.** Stattdessen bekommt `MAIL_REVIEW_TO` (z.B.
Robert) eine kurze Benachrichtigungs-Mail ("X neue Angebote"), die auf eine **Übersichtsseite**
verlinkt ([netlify/functions/hero-offer-review-dashboard.mts](netlify/functions/hero-offer-review-dashboard.mts)).
Diese Seite zeigt live den aktuellen Stand aller noch offenen Angebote (Tabelle, älteste
zuerst) — bereits verschickte verschwinden automatisch, es sammelt sich also nichts an.

Pro Angebot gibt es dort zwei Aktionen:

- ✅ **Ja** → zeigt zuerst eine **Vorschau** der Nachfass-Mail (Betreff + Text). Erst ein
  zweiter Klick "Jetzt wirklich senden" verschickt sie tatsächlich (über Microsoft Graph,
  Absender `info@kuepper-kaelte.de`) und trägt einen Vermerk in HERO ein.
- 🚫 **Nein** → es wird nichts verschickt, mit Vermerk in HERO. Das ist **umkehrbar**: Ein
  späterer Klick auf "Ja" (z.B. weil sich die Lage beim Kunden geändert hat) funktioniert
  trotzdem noch. Nur ein bereits **verschicktes** Angebot lässt sich nicht mehr zurücknehmen.

Die Benachrichtigungs-Mail selbst wird nur für *neue* Angebote ausgelöst (kein täglicher Spam
über den ganzen Bestand) — die Übersichtsseite zeigt aber immer den vollständigen aktuellen
Stand, auch älterer, bereits gemeldeter Angebote.

## Setup

1. Abhängigkeiten installieren:
   ```bash
   npm install
   ```

2. `.env.example` nach `.env` kopieren und ausfüllen:
   - `HERO_API_TOKEN`: vorhanden.
   - `MS_TENANT_ID` / `MS_CLIENT_ID` / `MS_CLIENT_SECRET`: aus der bereits angelegten
     Entra-ID-App-Registrierung (Application Permission `Mail.Send`, Admin-Zustimmung
     erteilt).
   - `MAIL_FROM=info@kuepper-kaelte.de`.
   - `MAIL_REVIEW_TO`: wer die Benachrichtigungs-Mail bekommt und die Ja/Nein-Entscheidungen trifft.
   - `APPROVAL_SECRET`: einmalig einen langen zufälligen Text eintragen (sichert die Freigabe-
     Links UND den Übersichtsseiten-Link ab).

3. **Discovery-Lauf** (einmalig, um die richtigen HERO-Werte für euren Account zu finden):
   - `HERO_DISCOVERY=true` setzen.
   - Function auslösen (nach Deploy über den "Run now"-Button im Netlify-Dashboard bei
     `hero-offer-followup`).
   - Die Function loggt: alle vorkommenden `status_code`-Werte (Klarnamen), `measure`-
     Kategorien (z.B. Montagen/Reparaturen/Wartung/Projekte), Dokumenttypen, sowie das
     GraphQL-Schema für `add_logbook_entry`/`project_matches` per Introspection.
   - Passende Werte eintragen: `HERO_OPEN_STATUS_CODES` (der Status, der "Angebot liegt vor,
     wartet auf Kunde" bedeutet — das ist **nicht** zwangsläufig der naheliegendste Name,
     bei Küpper Kälte z.B. "Auftragsvergabe"/801, nicht "Vor-Ort Termin"), `HERO_MEASURE_IDS`
     (optional, falls nur bestimmte Kategorien relevant sind) und `HERO_OFFER_DOCUMENT_TYPE`.
   - `HERO_DISCOVERY` wieder auf `false` setzen.

4. Testlauf ohne Mailversand: `DRY_RUN=true` setzen, Function erneut aufrufen und die
   Zusammenfassung im Log prüfen. `DEBUG=true` zeigt zusätzlich pro Projekt, warum es
   mitgezählt oder ausgeschlossen wurde (hilfreich zum Fehlersuchen, für den Alltag aber
   nicht nötig — erzeugt sehr viele Log-Zeilen).

5. Env-Vars in Netlify hinterlegen (Site settings → Environment variables) und deployen.
   `URL` wird von Netlify automatisch gesetzt und für die Freigabe-/Übersichtsseiten-Links
   verwendet — dafür ist keine eigene Konfiguration nötig.

## Wichtig

- `project_matches` wird serverseitig nach `statuses`/`measure_ids` gefiltert und bei Bedarf
  seitenweise geladen (`first`/`offset`, siehe `fetchProjectMatches` in
  [lib/hero-client.mts](lib/hero-client.mts)) — funktioniert auch bei mehreren hundert
  offenen Vorgängen innerhalb des 30-Sekunden-Zeitlimits von Netlify Functions.
- Tracking läuft komplett über die `histories`-Einträge (Notizen/Logbuch) eines project_match
  (siehe [lib/mail-template.mts](lib/mail-template.mts)): "zur Freigabe vorgeschlagen",
  "verschickt" oder "übersprungen". Das ist etwas fehleranfälliger als ein echtes Statusfeld
  (Absprache mit Robert: HERO hat kein eigenes Tag-Feld dafür), macht den Vermerk aber auch
  für Menschen in HERO sichtbar.
- Alle Freigabe-Links (Ja/Nein) und der Übersichtsseiten-Link sind mit `APPROVAL_SECRET`
  signiert (siehe [lib/approval.mts](lib/approval.mts)) — ohne gültige Signatur passiert
  nichts. Sie sind nicht personengebunden: Wer den Link/die Seite öffnet, kann handeln — die
  Übersichtsseite sollte daher nicht öffentlich geteilt werden.
- E-Mail-Text/Betreff der Kunden-Mail lassen sich über `MAIL_SUBJECT_TEMPLATE` /
  `MAIL_BODY_TEMPLATE` anpassen (Platzhalter siehe `.env.example`). Der Standardtext
  entspricht dem mit Robert abgestimmten Entwurf (freundlich, unaufdringlich, klarer
  Call-to-Action).
- Zeitplan ändern: Cron-Ausdruck in `netlify.toml` anpassen (läuft in UTC).
