import {
  fetchProjectMatches,
  addLogbookEntry,
  introspectSchema,
  introspectObjectTypeFields,
  fetchProjectTypes,
  testAddLogbookEntry,
} from "../../lib/hero-client.mts";
import { sendGraphMail } from "../../lib/graph-mailer.mts";
import { fetchDueCandidates, type Candidate } from "../../lib/candidates.mts";
import { alreadyProposed, buildProposedMarker, buildNotificationSubject, buildNotificationBody } from "../../lib/mail-template.mts";
import { buildDashboardLink } from "../../lib/approval.mts";

const DISCOVERY_MODE = process.env.HERO_DISCOVERY === "true";
const DRY_RUN = process.env.DRY_RUN === "true";
const DEBUG = process.env.DEBUG === "true";

async function runDiscovery(): Promise<Response> {
  const matches = await fetchProjectMatches(); // bewusst ungefiltert, um alle Status/Kategorien zu sehen

  const statusCodes = new Map<string, string>(); // status_code -> name
  const documentTypes = new Set<string>();
  const measures = new Map<string, string>(); // measure_id -> name/short

  for (const match of matches) {
    const status = match.current_project_match_status;
    if (status?.status_code) statusCodes.set(String(status.status_code), status.name);
    for (const doc of match.customer_documents) {
      documentTypes.add(doc.type);
    }
    if (match.measure) {
      measures.set(match.measure.id, match.measure.name ?? match.measure.short ?? match.measure.id);
    }
  }

  let introspection: Awaited<ReturnType<typeof introspectSchema>> | { error: string };
  try {
    introspection = await introspectSchema();
  } catch (err) {
    introspection = { error: String(err) };
  }

  let projectMatchFields: string[] | { error: string } | null = null;
  if ("projectMatches" in introspection && introspection.projectMatches?.returnType) {
    const baseTypeName = introspection.projectMatches.returnType.replace(/[![\]]/g, "");
    try {
      projectMatchFields = await introspectObjectTypeFields(baseTypeName);
    } catch (err) {
      projectMatchFields = { error: String(err) };
    }
  }

  let projectTypes: Array<{ id: string; name: string }> | { error: string };
  try {
    projectTypes = await fetchProjectTypes();
  } catch (err) {
    projectTypes = { error: String(err) };
  }

  let addLogbookEntryTest: { ok: true } | { ok: false; error: string } | { ok: null; reason: string } = {
    ok: null,
    reason: "Kein project_match vorhanden, um zu testen.",
  };
  if (matches.length > 0) {
    addLogbookEntryTest = await testAddLogbookEntry(matches[0].id);
  }

  const summary = {
    mode: "discovery",
    hinweise: [
      "Trage passende Werte als HERO_OPEN_STATUS_CODES bzw. HERO_OFFER_DOCUMENT_TYPE ein und setze HERO_DISCOVERY=false.",
      "'gefundene_status_codes' zeigt Code -> Klarname. Nur die Codes für 'offenes Angebot, wartet auf Kunde' in " +
        "HERO_OPEN_STATUS_CODES eintragen (kommagetrennt).",
      "'gefundene_measures' zeigt id -> Kategoriename (z.B. Montagen/Reparaturen/Wartung/Projekte). Die passende(n) " +
        "ID(s) in HERO_MEASURE_IDS eintragen (kommagetrennt), damit nur diese Kategorie(n) berücksichtigt werden.",
      "Falls 'Montagen' nicht unter gefundene_measures auftaucht: 'project_types' zeigt eine alternative Liste " +
        "(id -> Name) – project_matches(type_ids: [Int]) filtert darüber. 'project_match_fields' zeigt alle " +
        "lesbaren Felder eines project_match, falls dort ein anderes Feld für die Kategorie zuständig ist.",
      "'add_logbook_entry_test.ok' zeigt, ob das Schreiben eines HERO-Logbuch-Eintrags funktioniert. Bei ok:true " +
        `wurde ein Testeintrag geschrieben, den man in HERO beim ersten Projekt (${matches[0]?.project_nr ?? "-"}) ` +
        "im Verlauf/Notizen sieht und löschen kann.",
    ],
    gefundene_status_codes: Object.fromEntries(statusCodes),
    gefundene_dokument_typen: [...documentTypes].sort(),
    gefundene_measures: Object.fromEntries(measures),
    project_types: projectTypes,
    project_match_fields: projectMatchFields,
    anzahl_project_matches: matches.length,
    add_logbook_entry_test: addLogbookEntryTest,
    introspection,
  };

  console.log(JSON.stringify(summary, null, 2));
  return new Response(JSON.stringify(summary, null, 2), {
    headers: { "content-type": "application/json" },
  });
}

export default async (): Promise<Response> => {
  if (DISCOVERY_MODE) {
    try {
      return await runDiscovery();
    } catch (err) {
      console.error("Fehler beim Discovery-Lauf:", err);
      return new Response(JSON.stringify({ error: String(err) }), {
        status: 502,
        headers: { "content-type": "application/json" },
      });
    }
  }

  const reviewTo = process.env.MAIL_REVIEW_TO?.trim();
  if (!reviewTo) {
    const msg = "MAIL_REVIEW_TO ist nicht gesetzt – ohne Empfänger kann keine Benachrichtigung verschickt werden.";
    console.error(msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }

  let result: Awaited<ReturnType<typeof fetchDueCandidates>>;
  try {
    result = await fetchDueCandidates(DEBUG);
  } catch (err) {
    console.error("Fehler beim Laden der HERO-Angebote:", err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });
  }

  // Kandidaten, die noch nie gemeldet wurden, weisen auf "wirklich neu" hin – beeinflusst nur
  // den Betreff/Text der Benachrichtigung. Verschickt wird die Mail (mit Link zur
  // Übersichtsseite), sobald überhaupt etwas offen ist, damit der Übersichts-Link jederzeit
  // erreichbar bleibt (auch wenn gerade nichts Neues dazugekommen ist).
  const newCandidates: Candidate[] = result.due.filter((c) => !alreadyProposed(c.match));

  let notificationSent = false;
  if (!DRY_RUN && result.due.length > 0) {
    await sendGraphMail({
      toEmail: reviewTo,
      toName: null,
      subject: buildNotificationSubject(newCandidates.length, result.due.length),
      body: buildNotificationBody(newCandidates.length, result.due.length, buildDashboardLink()),
    });
    notificationSent = true;

    // Parallel (statt nacheinander) schreiben, sonst droht bei vielen Kandidaten das
    // 30-Sekunden-Zeitlimit von Netlify Functions.
    const now = new Date().toISOString();
    const MARKER_WRITE_CONCURRENCY = 10;
    for (let i = 0; i < newCandidates.length; i += MARKER_WRITE_CONCURRENCY) {
      const batch = newCandidates.slice(i, i + MARKER_WRITE_CONCURRENCY);
      await Promise.all(
        batch.map((c) =>
          addLogbookEntry(c.match.id, buildProposedMarker(now)).catch((err) => {
            console.error(`Konnte 'vorgeschlagen'-Vermerk nicht schreiben für ${c.match.project_nr}:`, err);
          })
        )
      );
    }
  }

  const summary = {
    checked: result.checked,
    dueTotal: result.due.length,
    newSinceLastRun: newCandidates.length,
    notificationSent,
    skippedNotOpenStatus: result.skippedNotOpenStatus,
    skippedNoOfferDoc: result.skippedNoOfferDoc,
    skippedTooRecent: result.skippedTooRecent,
    skippedAlreadySent: result.skippedAlreadySent,
    skippedNoEmail: result.skippedNoEmail,
    dryRun: DRY_RUN,
  };

  console.log("HERO Angebots-Nachfassen abgeschlossen:", JSON.stringify(summary));

  return new Response(JSON.stringify(summary, null, 2), {
    headers: { "content-type": "application/json" },
  });
};
