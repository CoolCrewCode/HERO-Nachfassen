import { fetchProjectMatches, addLogbookEntry, introspectSchema, type HeroDocument, type HeroProjectMatch } from "../../lib/hero-client.mts";
import { sendGraphMail } from "../../lib/graph-mailer.mts";
import { buildSubject, buildBody, buildLogbookMarker, alreadyFollowedUp } from "../../lib/mail-template.mts";

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
  const statusCodes = new Set<string>();
  const documentTypes = new Set<string>();

  for (const match of matches) {
    const code = match.current_project_match_status?.status_code;
    if (code) statusCodes.add(code);
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

  const summary = {
    mode: "discovery",
    hinweise: [
      "Trage passende Werte als HERO_OPEN_STATUS_CODES bzw. HERO_OFFER_DOCUMENT_TYPE ein und setze HERO_DISCOVERY=false.",
      "Prüfe 'introspection.addLogbookEntry' gegen die Annahme in lib/hero-client.mts (ADD_LOGBOOK_ENTRY_MUTATION) " +
        "und passe die Argumentnamen dort an, falls sie abweichen.",
      "Prüfe 'introspection.projectMatches' auf Filter-/Pagination-Argumente, um die Query bei Bedarf serverseitig einzuschränken.",
    ],
    gefundene_status_codes: [...statusCodes].sort(),
    gefundene_dokument_typen: [...documentTypes].sort(),
    anzahl_project_matches: matches.length,
    introspection,
  };

  console.log(JSON.stringify(summary, null, 2));
  return new Response(JSON.stringify(summary, null, 2), {
    headers: { "content-type": "application/json" },
  });
}

interface FollowUpResult {
  projectNr: string;
  offerNr: string;
  toEmail: string;
}

async function sendSummaryMail(results: FollowUpResult[], errors: string[]): Promise<void> {
  const summaryTo = process.env.MAIL_SUMMARY_TO?.trim();
  if (!summaryTo || (results.length === 0 && errors.length === 0)) return;

  const lines = [
    `Nachfass-Lauf abgeschlossen: ${results.length} Mail(s) verschickt.`,
    "",
    ...results.map((r) => `- Angebot ${r.offerNr} (Projekt ${r.projectNr}) an ${r.toEmail}`),
  ];

  if (errors.length > 0) {
    lines.push("", "Fehler:", ...errors.map((e) => `- ${e}`));
  }

  try {
    await sendGraphMail({
      toEmail: summaryTo,
      toName: null,
      subject: `HERO Nachfass-Lauf: ${results.length} Angebot(e) nachgefasst`,
      body: lines.join("\n"),
    });
  } catch (err) {
    console.error("Interne Zusammenfassungs-Mail konnte nicht verschickt werden:", err);
  }
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

  let matches: HeroProjectMatch[];
  try {
    matches = await fetchProjectMatches();
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

  let checked = 0;
  let due = 0;
  let sent = 0;
  let skippedAlreadySent = 0;
  let skippedNoEmail = 0;
  const errors: string[] = [];
  const results: FollowUpResult[] = [];

  for (const match of matches) {
    checked++;

    if (!isOpenStatus(match)) continue;

    const offer = latestOfferDocument(match.customer_documents);
    if (!offer) continue;

    if (daysSince(offer.created) < FOLLOWUP_AFTER_DAYS) continue;

    due++;

    if (alreadyFollowedUp(match)) {
      skippedAlreadySent++;
      continue;
    }

    const recipient = recipientOf(match);
    if (!recipient) {
      skippedNoEmail++;
      console.warn(`Kein E-Mail-Kontakt für project_match ${match.id} (${match.project_nr}) gefunden.`);
      continue;
    }

    try {
      if (!DRY_RUN) {
        const now = new Date().toISOString();

        await sendGraphMail({
          toEmail: recipient.email,
          toName: recipient.name,
          subject: buildSubject({ toName: recipient.name, projectNr: match.project_nr, offer }),
          body: buildBody({ toName: recipient.name, projectNr: match.project_nr, offer }),
        });

        await addLogbookEntry(match.id, "Automatisches Nachfassen", buildLogbookMarker(now));
      }
      sent++;
      results.push({ projectNr: match.project_nr, offerNr: offer.nr, toEmail: recipient.email });
    } catch (err) {
      const msg = `Fehlgeschlagen für project_match ${match.id} (${offer.nr}): ${err}`;
      console.error(msg);
      errors.push(msg);
    }
  }

  if (!DRY_RUN) {
    await sendSummaryMail(results, errors);
  }

  const summary = {
    checked,
    due,
    sent,
    skippedAlreadySent,
    skippedNoEmail,
    dryRun: DRY_RUN,
    errors,
  };

  console.log("HERO Angebots-Nachfassen abgeschlossen:", JSON.stringify(summary));

  return new Response(JSON.stringify(summary, null, 2), {
    headers: { "content-type": "application/json" },
  });
};
