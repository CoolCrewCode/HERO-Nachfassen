import { fetchProjectMatches, type HeroDocument, type HeroProjectMatch } from "./hero-client.mts";
import { alreadySent, alreadySkipped } from "./mail-template.mts";

// ---------------------------------------------------------------------------
// Konfiguration über Env-Vars (siehe .env.example) – zentral hier, damit Tagesjob und
// Übersichtsseite exakt dieselben Angebote finden.
// ---------------------------------------------------------------------------

export const FOLLOWUP_AFTER_DAYS = Number(process.env.HERO_FOLLOWUP_DAYS ?? 7);

const OPEN_STATUS_CODES = (process.env.HERO_OPEN_STATUS_CODES ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const MEASURE_IDS = (process.env.HERO_MEASURE_IDS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const OFFER_DOCUMENT_TYPE = process.env.HERO_OFFER_DOCUMENT_TYPE?.trim() ?? "";

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
  return code !== undefined && code !== null && OPEN_STATUS_CODES.includes(String(code));
}

export function recipientOf(match: HeroProjectMatch): { email: string; name: string | null } | null {
  const person = match.contact ?? match.customer;
  if (!person?.email) return null;
  const name = [person.first_name, person.last_name].filter(Boolean).join(" ") || null;
  return { email: person.email, name };
}

export interface Candidate {
  match: HeroProjectMatch;
  offer: HeroDocument;
  recipient: { email: string; name: string | null };
  daysOld: number;
  wasSkippedBefore: boolean;
}

export interface FindDueResult {
  checked: number;
  due: Candidate[];
  skippedNotOpenStatus: number;
  skippedNoOfferDoc: number;
  skippedTooRecent: number;
  skippedAlreadySent: number;
  skippedNoEmail: number;
}

/**
 * Lädt alle noch offenen (nicht bereits verschickten) Nachfass-Kandidaten. Bereits übersprungene
 * werden NICHT ausgeschlossen (die Entscheidung ist umkehrbar) – dafür markiert
 * `wasSkippedBefore`, damit die Anzeige das kenntlich machen kann.
 */
export async function fetchDueCandidates(debug = false): Promise<FindDueResult> {
  const matches = await fetchProjectMatches({
    statuses: OPEN_STATUS_CODES.map(Number),
    measureIds: MEASURE_IDS.map(Number),
  });

  const result: FindDueResult = {
    checked: 0,
    due: [],
    skippedNotOpenStatus: 0,
    skippedNoOfferDoc: 0,
    skippedTooRecent: 0,
    skippedAlreadySent: 0,
    skippedNoEmail: 0,
  };

  for (const match of matches) {
    result.checked++;

    if (debug) {
      const offer = latestOfferDocument(match.customer_documents);
      console.log(
        `DEBUG ${match.project_nr}: measure=${match.measure?.id} (${match.measure?.name ?? match.measure?.short}) ` +
          `status=${match.current_project_match_status?.status_code} (${match.current_project_match_status?.name}) ` +
          `dokumente=[${match.customer_documents.map((d) => d.type).join(",")}] angebotGefunden=${!!offer} ` +
          (offer ? `angebotDatum=${offer.created} tageAlt=${daysSince(offer.created).toFixed(1)}` : "")
      );
    }

    if (!isOpenStatus(match)) {
      result.skippedNotOpenStatus++;
      continue;
    }

    const offer = latestOfferDocument(match.customer_documents);
    if (!offer) {
      result.skippedNoOfferDoc++;
      continue;
    }

    if (daysSince(offer.created) < FOLLOWUP_AFTER_DAYS) {
      result.skippedTooRecent++;
      continue;
    }

    if (alreadySent(match)) {
      result.skippedAlreadySent++;
      continue;
    }

    const recipient = recipientOf(match);
    if (!recipient) {
      result.skippedNoEmail++;
      continue;
    }

    result.due.push({
      match,
      offer,
      recipient,
      daysOld: daysSince(offer.created),
      wasSkippedBefore: alreadySkipped(match),
    });
  }

  return result;
}
