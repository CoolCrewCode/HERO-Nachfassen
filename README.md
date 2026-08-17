# HERO Angebots-Nachfassen (Netlify Scheduled Function)

Läuft täglich (Standard: 07:00 UTC, siehe `netlify.toml`) und holt offene Angebote aus
HERO Software (GraphQL-API), die seit `HERO_FOLLOWUP_DAYS` Tagen (Standard 7) unbeantwortet
sind.

**Kein Angebot wird automatisch verschickt.** Stattdessen bekommt `MAIL_REVIEW_TO`
(z.B. Robert) eine tägliche Übersichts-Mail mit allen fälligen Angeboten, und für jedes
einzeln zwei Links:

- ✅ **Ja, jetzt nachfassen** → verschickt die Nachfass-Mail an den Kunden (über Microsoft
  Graph, Absender `info@kuepper-kaelte.de`) und trägt einen Vermerk in HERO ein.
- 🚫 **Nein, überspringen** → es wird nichts verschickt, ebenfalls mit Vermerk in HERO, damit
  dasselbe Angebot nicht erneut vorgeschlagen wird.

So kann jeder Kunde einzeln geprüft werden (z.B. wenn es zwischenzeitlich schon
persönlichen/telefonischen Kontakt gab), bevor eine Mail rausgeht. Ein Angebot taucht nur
einmal in der Übersichts-Mail auf – bis eine der beiden Optionen angeklickt wurde, wird es
nicht erneut vorgeschlagen.

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
   - `MAIL_REVIEW_TO`: wer die tägliche Freigabe-Mail bekommt und die Ja/Nein-Entscheidung trifft.
   - `APPROVAL_SECRET`: einmalig einen langen zufälligen Text eintragen (sichert die Freigabe-Links ab).

3. **Discovery-Lauf** (einmalig, um die richtigen HERO-Werte für euren Account zu finden):
   - `HERO_DISCOVERY=true` setzen.
   - Function lokal ausführen: `netlify dev` und dann
     `netlify functions:invoke hero-offer-followup`
     (oder nach dem ersten Deploy über den "Run now"-Button im Netlify-Dashboard).
   - Die Function loggt:
     - alle in eurem Account vorkommenden `status_code`- und Dokument-Typ-Werte,
     - das **echte GraphQL-Schema** für `add_logbook_entry` und `project_matches`
       (Argumentnamen), per Introspection.
   - Passende Werte in `HERO_OPEN_STATUS_CODES` (kommagetrennt, alle "wartet auf
     Kundenantwort"-Status) und `HERO_OFFER_DOCUMENT_TYPE` eintragen.
   - **Wichtig:** `introspection.addLogbookEntry` mit der Annahme in
     [lib/hero-client.mts](lib/hero-client.mts) (`ADD_LOGBOOK_ENTRY_MUTATION`) abgleichen.
     Die öffentliche HERO-Doku nennt nur den Mutationsnamen, nicht die Argumente —
     dort steht aktuell eine plausible Annahme (`project_match_id`, `custom_title`,
     `custom_text`), die vor dem Live-Einsatz per Introspection bestätigt werden muss.
   - `HERO_DISCOVERY` wieder auf `false` setzen.

4. Testlauf ohne Mailversand: `DRY_RUN=true` setzen, Function erneut aufrufen und
   die Zusammenfassung (`checked`/`due`/`candidatesInReviewMail`/…) im Log prüfen.

5. Env-Vars in Netlify hinterlegen (Site settings → Environment variables) und deployen.
   `URL` wird von Netlify automatisch gesetzt und für die Freigabe-Links verwendet — dafür
   ist keine eigene Konfiguration nötig.

## Wichtig

- Die HERO-GraphQL-Doku dokumentiert öffentlich keine Filter-/Pagination-Argumente
  für `project_matches`. Die Function lädt daher aktuell alle project_matches und
  filtert client-seitig. Bei sehr vielen offenen Vorgängen (Function-Limit: 30s
  Laufzeit) hilft der Discovery-Lauf zu sehen, ob es Server-seitige Filter gibt
  (`introspection.projectMatches`).
- Tracking läuft komplett über die `histories`-Einträge (Notizen/Logbuch) eines
  project_match (siehe [lib/mail-template.mts](lib/mail-template.mts)): "zur Freigabe
  vorgeschlagen", "verschickt" oder "übersprungen". Das ist etwas fehleranfälliger als ein
  echtes Statusfeld (Absprache mit Robert: HERO hat kein eigenes Tag-Feld dafür), macht den
  Vermerk aber auch für Menschen in HERO sichtbar.
- Die Freigabe-Links in der Übersichts-Mail sind mit `APPROVAL_SECRET` signiert (siehe
  [lib/approval.mts](lib/approval.mts)) — ohne gültige Signatur passiert nichts. Sie sind
  nicht personengebunden: Wer den Link in der Mail von `MAIL_REVIEW_TO` anklickt, löst die
  Aktion aus.
- E-Mail-Text/Betreff der Kunden-Mail lassen sich über `MAIL_SUBJECT_TEMPLATE` /
  `MAIL_BODY_TEMPLATE` anpassen (Platzhalter siehe `.env.example`). Der Standardtext
  entspricht dem mit Robert abgestimmten Entwurf (freundlich, unaufdringlich, klarer
  Call-to-Action).
- Zeitplan ändern: Cron-Ausdruck in `netlify.toml` anpassen (läuft in UTC).
