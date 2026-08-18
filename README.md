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

---

# Empfehlungsprogramm (Kunden-werben-Kunden)

Läuft täglich (Standard: 08:00 UTC), findet Kunden mit neuer Rechnung
(`HERO_INVOICED_STATUS_CODES`) und verschickt ihnen einmalig ihren persönlichen
Empfehlungscode (`KK-<HERO-Kundennummer>`) samt Link zur Empfehlungs-Landingpage und Hinweis
auf die Prämie (`REFERRAL_PREMIUM_EUR`, Standard 50€).

**Ablauf:**

1. [netlify/functions/hero-referral-code-mailer.mts](netlify/functions/hero-referral-code-mailer.mts)
   verschickt den Code nach Rechnung (einmal pro Kunde, Tracking über Netlify Blobs, nicht
   über HERO-Notizen).
2. Der geworbene Neukunde landet über den Link auf
   [netlify/functions/hero-referral-landing.mts](netlify/functions/hero-referral-landing.mts)
   (öffentliches Formular, Code ist schon vorausgefüllt) und trägt seine Kontaktdaten ein.
3. Die Einreichung wird in Netlify Blobs gespeichert, `MAIL_REVIEW_TO` bekommt sofort eine
   Benachrichtigung mit allen Angaben.
4. **Wichtig — bewusste Einschränkung für den Start:** Der Lead wird **nicht automatisch**
   in HERO angelegt (die dafür nötige HERO-Mutation ist ungeprüft, das wollten wir nicht
   blind gegen echte Kundendaten testen). Robert legt den Lead wie gewohnt selbst in HERO an,
   nachdem er die Benachrichtigungs-Mail bekommen hat.
5. Auf der Übersichtsseite
   [netlify/functions/hero-referral-dashboard.mts](netlify/functions/hero-referral-dashboard.mts)
   (Link ebenfalls in der Benachrichtigungs-Mail) sieht Robert alle Empfehlungen und setzt
   den Status (Lead angelegt/Auftrag/abgelehnt) sowie den Prämienstatus (offen/fällig/
   ausgezahlt) per Klick — das automatische tägliche Abgleichen "wurde aus dem Lead ein
   Auftrag?" ist bewusst noch nicht gebaut (hängt vom offenen Punkt 4 ab) und wird aktuell
   manuell gepflegt.

**Setup zusätzlich zum oben genannten:**

- `HERO_INVOICED_STATUS_CODES`, `REFERRAL_PREMIUM_EUR`, `REFERRAL_DRY_RUN` in `.env`/Netlify
  setzen (siehe `.env.example`).
- Nutzt dieselben `MS_*`/`MAIL_FROM`/`MAIL_REVIEW_TO`/`APPROVAL_SECRET`-Variablen wie das
  Nachfass-System.
- **Ungeprüfte Annahme:** `customer`/`contact` werden jetzt zusätzlich mit dem Feld `nr`
  abgefragt (die eigentliche Kundennummer, nicht die interne GraphQL-ID) — das ist beim
  ersten Testlauf zu bestätigen; falls die Query mit einem Feldfehler abbricht, muss der
  Feldname in [lib/hero-client.mts](lib/hero-client.mts) angepasst werden.
- Testlauf: `REFERRAL_DRY_RUN=true` setzen, `hero-referral-code-mailer` manuell auslösen,
  Log prüfen (`checked`/`sent`/...), dann auf `false` zurücksetzen.
