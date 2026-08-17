import {
  fetchProjectMatches,
  addLogbookEntry,
  introspectSchema,
  testAddLogbookEntry,
  testAddLogbookEntryDynamic,
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

// customer_documents.type-Wert, der ein Angebot kennzeichnet (z.B. "OFFER" oder "ANGEBOT").
// Ebenfalls per Discovery-Modus ermitteln.
const OFFER_DOCUMENT_TYPE = process.env.HERO_OFFER_DOCUMENT_TYPE?.trim() ?? "";

const DISCOVERY_MODE = process.env.HERO_DISCOVERY === "true";
const DRY_RUN = process.env.DRY_RUN === "true";

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

  for (const match of matches) {
    const status = match.current_project_match_status;
    if (status?.status_code) statusCodes.set(String(status.status_code), status.name);
    for (const doc of match.customer_documents) {
      documentTypes.add(doc.type);
    }
  }

  let introspection: Awaited<ReturnType<typeof introspectSchema>> | { error: string };
  try {
    introspection = await introspectSchema();
  } catch (err) {
    introspection = { error: String(err) };
  }

  // Erst mit der (bisher geratenen) festen Signatur testen; falls Introspection jetzt echte
  // Argumentnamen liefert und der feste Test fehlschlägt, zusätzlich automatisch mit der
  // per Introspection ermittelten echten Signatur testen.
  let addLogbookEntryTest: { ok: true } | { ok: false; error: string } | { ok: null; reason: string } = {
    ok: null,
    reason: "Kein project_match vorhanden, um zu testen.",
  };
  let addLogbookEntryDynamicTest: Awaited<ReturnType<typeof testAddLogbookEntryDynamic>> | null = null;

  if (matches.length > 0) {
    addLogbookEntryTest = await testAddLogbookEntry(matches[0].id);

    if (
      addLogbookEntryTest.ok === false &&
      "addLogbookEntry" in introspection &&
      introspection.addLogbookEntry
    ) {
      addLogbookEntryDynamicTest = await testAddLogbookEntryDynamic(matches[0].id, introspection.addLogbookEntry);
    }
  }

  const summary = {
    mode: "discovery",
    hinweise: [
      "Trage passende Werte als HERO_OPEN_STATUS_CODES bzw. HERO_OFFER_DOCUMENT_TYPE ein und setze HERO_DISCOVERY=false.",
      "'gefundene_status_codes' zeigt Code -> Klarname. Nur die Codes für 'offenes Angebot, wartet auf Kunde' in " +
        "HERO_OPEN_STATUS_CODES eintragen (kommagetrennt).",
      "'add_logbook_entry_test.ok' zeigt, ob die Notiz-Mutation mit der aktuellen Annahme in lib/hero-client.mts " +
        "(ADD_LOGBOOK_ENTRY_MUTATION) funktioniert hat.",
      "Falls add_logbook_entry_test.ok=false: 'add_logbook_entry_dynamic_test' zeigt das Ergebnis eines zweiten " +
        "Versuchs mit den per Introspection ermittelten echten Argumentnamen (usedArgs zeigt, welcher echte " +
        "Name wofür verwendet wurde). Bei ok:true muss ADD_LOGBOOK_ENTRY_MUTATION in lib/hero-client.mts auf diese " +
        "Argumentnamen umgestellt werden.",
      `Bei ok:true (in einem der beiden Tests) wurde ein Testeintrag geschrieben, den man in HERO beim ersten ` +
        `Projekt (${matches[0]?.project_nr ?? "-"}) im Verlauf/Notizen sieht und löschen kann.`,
    ],
    gefundene_status_codes: Object.fromEntries(statusCodes),
    gefundene_dokument_typen: [...documentTypes].sort(),
    anzahl_project_matches: matches.length,
    add_logbook_entry_test: addLogbookEntryTest,
    add_logbook_entry_dynamic_test: addLogbookEntryDynamicTest,
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

  // Im Discovery-Modus bewusst ungefiltert laden, um alle vorkommenden Status/Dokumenttypen
  // zu sehen. Im Normalbetrieb serverseitig auf die konfigurierten offenen Status einschränken.
  const statusFilter = DISCOVERY_MODE ? undefined : OPEN_STATUS_CODES.map(Number);

  let matches: HeroProjectMatch[];
  try {
    matches = await fetchProjectMatches(statusFilter);
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
  let skippedAlreadyHandled = 0;
  let skippedAlreadyProposed = 0;
  let skippedNoEmail = 0;
  const candidates: ReviewCandidate[] = [];

  for (const match of matches) {
    checked++;

    if (!isOpenStatus(match)) continue;

    const offer = latestOfferDocument(match.customer_documents);
    if (!offer) continue;

    if (daysSince(offer.created) < FOLLOWUP_AFTER_DAYS) continue;

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
        await addLogbookEntry(c.matchId, "Nachfassen vorgeschlagen", buildProposedMarker(now));
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
