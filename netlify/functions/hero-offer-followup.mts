import {
  fetchProjectMatches,
  addLogbookEntry,
  introspectSchema,
  introspectObjectTypeFields,
  fetchProjectTypes,
  testAddLogbookEntry,
  type HeroDocument,
  type HeroProjectMatch,
} from "../../lib/hero-client.mts";
import { sendGraphMail } from "../../lib/graph-mailer.mts";
import {
  alreadyHandled,
  alreadyProposed,
  buildReviewSubject,
  buildReviewBody,
  buildProposedMarker,
  type ReviewCandidate,
} from "../../lib/mail-template.mts";
import { buildApprovalLink } from "../../lib/approval.mts";

// ---------------------------------------------------------------------------
// Konfiguration über Env-Vars (siehe .env.example)
// ---------------------------------------------------------------------------

const FOLLOWUP_AFTER_DAYS = Number(process.env.HERO_FOLLOWUP_DAYS ?? 7);

// Status-Codes, die als "offenes Angebot, wartet auf Kundenantwort" gelten.
// Kommagetrennt, z.B. "OFFER_SENT,QUOTE_SENT". Muss pro HERO-Account einmalig
// über den Discovery-Modus (HERO_DISCOVERY=true) ermittelt werden.
const OPEN_STATUS_CODES = (process.env.HERO_OPEN_STATUS_CODES ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// HERO-Kategorien ("measure"), z.B. Projekte/Reparaturen/Montagen/Wartung. Nur Angebote
// aus diesen Kategorien berücksichtigen (kommagetrennte measure-IDs). Leer = alle Kategorien.
const MEASURE_IDS = (process.env.HERO_MEASURE_IDS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// customer_documents.type-Wert, der ein Angebot kennzeichnet (z.B. "OFFER" oder "ANGEBOT").
// Ebenfalls per Discovery-Modus ermitteln.
const OFFER_DOCUMENT_TYPE = process.env.HERO_OFFER_DOCUMENT_TYPE?.trim() ?? "";

const DISCOVERY_MODE = process.env.HERO_DISCOVERY === "true";
const DRY_RUN = process.env.DRY_RUN === "true";
const DEBUG = process.env.DEBUG === "true";

// ---------------------------------------------------------------------------

function daysSince(iso: string): number {
  const ms = Date.now() - new Date(iso).getTime();
  return ms / (1000 * 60 * 60 * 24);
}

function latestOfferDocument(docs: HeroDocument[]): HeroDocument | null {
  const offers = OFFER_DOCUMENT_TYPE ? docs.filter((d) => d.type === OFFER_DOCUMENT_TYPE) : docs;
  if (offers.length === 0) return null;
  return offers.reduce((latest, d) => (new Date(d.created) > new Date(latest.created) ? d : latest));
}

function isOpenStatus(match: HeroProjectMatch): boolean {
  if (OPEN_STATUS_CODES.length === 0) return true; // ungefiltert, solange nicht konfiguriert
  const code = match.current_project_match_status?.status_code;
  return !!code && OPEN_STATUS_CODES.includes(code);
}

function recipientOf(match: HeroProjectMatch): { email: string; name: string | null } | null {
  const person = match.contact ?? match.customer;
  if (!person?.email) return null;
  const name = [person.first_name, person.last_name].filter(Boolean).join(" ") || null;
  return { email: person.email, name };
}

async function runDiscovery(matches: HeroProjectMatch[]): Promise<Response> {
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

  // "Montagen" tauchte nicht unter den measures auf – vermutlich eine andere Dimension
  // (project_matches(type_ids: [Int])). Rückgabetyp von project_matches introspizieren, um
  // dessen lesbare Felder zu sehen (z.B. ein "type"/"project_type"-Feld), und project_types
  // direkt abfragen (Feldnamen id/name sind eine Annahme, Fehler zeigt die echten Namen).
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

  // Sanity-Check: schreibt einen Testeintrag über die (jetzt bestätigte) echte Mutation.
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
  if (!OFFER_DOCUMENT_TYPE && !DISCOVERY_MODE) {
    console.warn(
      "HERO_OFFER_DOCUMENT_TYPE ist nicht gesetzt – es wird das jeweils neueste customer_document " +
        "jedes project_match als 'Angebot' behandelt, unabhängig vom Typ. Zum Ermitteln des korrekten " +
        "Typs HERO_DISCOVERY=true setzen."
    );
  }
  if (OPEN_STATUS_CODES.length === 0 && !DISCOVERY_MODE) {
    console.warn(
      "HERO_OPEN_STATUS_CODES ist nicht gesetzt – es werden project_matches unabhängig vom Status " +
        "berücksichtigt. Zum Ermitteln der korrekten Codes HERO_DISCOVERY=true setzen."
    );
  }

  // Im Discovery-Modus bewusst ungefiltert laden, um alle vorkommenden Status/Kategorien
  // zu sehen. Im Normalbetrieb serverseitig auf Status + Kategorie (measure) einschränken.
  const filter = DISCOVERY_MODE
    ? undefined
    : { statuses: OPEN_STATUS_CODES.map(Number), measureIds: MEASURE_IDS.map(Number) };

  let matches: HeroProjectMatch[];
  try {
    matches = await fetchProjectMatches(filter);
  } catch (err) {
    console.error("Fehler beim Laden der HERO-Angebote:", err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });
  }

  if (DISCOVERY_MODE) {
    return runDiscovery(matches);
  }

  const reviewTo = process.env.MAIL_REVIEW_TO?.trim();
  if (!reviewTo) {
    const msg = "MAIL_REVIEW_TO ist nicht gesetzt – ohne Empfänger kann keine Freigabe-Mail verschickt werden.";
    console.error(msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }

  let checked = 0;
  let due = 0;
  let skippedNotOpenStatus = 0;
  let skippedNoOfferDoc = 0;
  let skippedTooRecent = 0;
  let skippedAlreadyHandled = 0;
  let skippedAlreadyProposed = 0;
  let skippedNoEmail = 0;
  const candidates: ReviewCandidate[] = [];

  for (const match of matches) {
    checked++;

    const offerForDebug = latestOfferDocument(match.customer_documents);
    if (DEBUG) {
      console.log(
        `DEBUG ${match.project_nr}: measure=${match.measure?.id} (${match.measure?.name ?? match.measure?.short}) ` +
          `status=${match.current_project_match_status?.status_code} ` +
          `(${match.current_project_match_status?.name}) ` +
          `dokumente=[${match.customer_documents.map((d) => d.type).join(",")}] ` +
          `angebotGefunden=${!!offerForDebug} ` +
          (offerForDebug ? `angebotDatum=${offerForDebug.created} tageAlt=${daysSince(offerForDebug.created).toFixed(1)}` : "")
      );
    }

    if (!isOpenStatus(match)) {
      skippedNotOpenStatus++;
      continue;
    }

    const offer = latestOfferDocument(match.customer_documents);
    if (!offer) {
      skippedNoOfferDoc++;
      continue;
    }

    if (daysSince(offer.created) < FOLLOWUP_AFTER_DAYS) {
      skippedTooRecent++;
      continue;
    }

    due++;

    if (alreadyHandled(match)) {
      skippedAlreadyHandled++;
      continue;
    }

    if (alreadyProposed(match)) {
      skippedAlreadyProposed++;
      continue;
    }

    const recipient = recipientOf(match);
    if (!recipient) {
      skippedNoEmail++;
      console.warn(`Kein E-Mail-Kontakt für project_match ${match.id} (${match.project_nr}) gefunden.`);
      continue;
    }

    candidates.push({
      matchId: match.id,
      toName: recipient.name,
      toEmail: recipient.email,
      projectNr: match.project_nr,
      offer,
      sendLink: buildApprovalLink(match.id, offer.nr, "send"),
      skipLink: buildApprovalLink(match.id, offer.nr, "skip"),
    });
  }

  let reviewMailSent = false;
  if (!DRY_RUN && candidates.length > 0) {
    await sendGraphMail({
      toEmail: reviewTo,
      toName: null,
      subject: buildReviewSubject(candidates.length),
      body: buildReviewBody(candidates),
    });
    reviewMailSent = true;

    // Markiert die Angebote als "zur Freigabe vorgeschlagen", damit sie nicht jeden Tag
    // erneut in einer neuen Übersichts-Mail auftauchen, solange noch keine Entscheidung fiel.
    const now = new Date().toISOString();
    for (const c of candidates) {
      try {
        await addLogbookEntry(c.matchId, buildProposedMarker(now));
      } catch (err) {
        console.error(`Konnte 'vorgeschlagen'-Vermerk nicht schreiben für ${c.projectNr}:`, err);
      }
    }
  }

  const summary = {
    checked,
    due,
    candidatesInReviewMail: candidates.length,
    reviewMailSent,
    skippedNotOpenStatus,
    skippedNoOfferDoc,
    skippedTooRecent,
    skippedAlreadyHandled,
    skippedAlreadyProposed,
    skippedNoEmail,
    dryRun: DRY_RUN,
  };

  console.log("HERO Angebots-Nachfassen (Übersicht) abgeschlossen:", JSON.stringify(summary));

  return new Response(JSON.stringify(summary, null, 2), {
    headers: { "content-type": "application/json" },
  });
};
