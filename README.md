# HERO Angebots-Nachfassen (Netlify Scheduled Function)

Läuft täglich (Standard: 07:00 UTC, siehe `netlify.toml`), holt offene Angebote aus
HERO Software (GraphQL-API) und verschickt eine Nachfass-Mail per Microsoft Graph
(Absender `info@kuepper-kaelte.de`), sobald das Angebot seit `HERO_FOLLOWUP_DAYS`
Tagen (Standard 7) unbeantwortet ist. Bereits angeschriebene Angebote werden über
einen automatischen Eintrag im HERO-Notizen-/Logbuch-Feld des Projekts erkannt
(`add_logbook_entry`), damit niemand doppelt kontaktiert wird und der Vermerk auch
in HERO selbst sichtbar ist.

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
   - `MAIL_FROM=info@kuepper-kaelte.de`, optional `MAIL_SUMMARY_TO` für eine interne
     Zusammenfassungs-Mail nach jedem Lauf.

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
   die Zusammenfassung (`checked`/`due`/`sent`/…) im Log prüfen.

5. Env-Vars in Netlify hinterlegen (Site settings → Environment variables) und deployen.

## Wichtig

- Die HERO-GraphQL-Doku dokumentiert öffentlich keine Filter-/Pagination-Argumente
  für `project_matches`. Die Function lädt daher aktuell alle project_matches und
  filtert client-seitig. Bei sehr vielen offenen Vorgängen (Function-Limit: 30s
  Laufzeit) hilft der Discovery-Lauf zu sehen, ob es Server-seitige Filter gibt
  (`introspection.projectMatches`).
- "Schon nachgefasst" wird erkannt, indem die `histories`-Einträge (Notizen/Logbuch)
  eines project_match nach dem Text "Nachfass-Mail automatisch verschickt" durchsucht
  werden (siehe [lib/mail-template.mts](lib/mail-template.mts)). Das ist etwas
  fehleranfälliger als ein echtes Statusfeld (Absprache mit Robert: HERO hat kein
  eigenes Tag-Feld dafür), aber macht den Vermerk auch für Menschen in HERO sichtbar.
- E-Mail-Text/Betreff lassen sich über `MAIL_SUBJECT_TEMPLATE` / `MAIL_BODY_TEMPLATE`
  anpassen (Platzhalter siehe `.env.example`). Der Standardtext entspricht dem mit
  Robert abgestimmten Entwurf (freundlich, unaufdringlich, klarer Call-to-Action).
- Zeitplan ändern: Cron-Ausdruck in `netlify.toml` anpassen (läuft in UTC).
