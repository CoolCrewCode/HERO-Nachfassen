import { fetchProjectMatches, type HeroPerson, type HeroProjectMatch } from "../../lib/hero-client.mts";
import { sendGraphMail } from "../../lib/graph-mailer.mts";
import { getBaseUrl } from "../../lib/approval.mts";
import { buildReferralCode } from "../../lib/referral.mts";
import { buildReferralMailSubject, buildReferralMailBody } from "../../lib/referral-mail.mts";
import { wasReferralCodeSent, markReferralCodeSent } from "../../lib/referral-store.mts";

// Kein Status-Filter: Status-Codes sind offenbar pro Kategorie/Pipeline unterschiedlich (siehe
// Nachfass-System, wo 801 nur innerhalb der Klima/Montagen-Pipeline galt) – "hat eine Rechnung"
// lässt sich daher nicht zuverlässig über einen festen Status-Code für ALLE Kategorien abbilden.
// Stattdessen wird direkt anhand von customer_documents.type === "invoice" erkannt, über alle
// Kategorien/Status hinweg. Optional lässt sich über HERO_INVOICED_STATUS_CODES trotzdem wieder
// ein Status-Filter aktivieren (z.B. für Performance bei sehr großem Bestand).
const INVOICED_STATUS_CODES = (process.env.HERO_INVOICED_STATUS_CODES ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map(Number);

const DRY_RUN = process.env.REFERRAL_DRY_RUN === "true";
const DEBUG = process.env.REFERRAL_DEBUG === "true";

function recipientOf(match: HeroProjectMatch): { email: string; name: string | null; nr: string | null } | null {
  const person: HeroPerson | null = match.customer ?? match.contact;
  if (!person?.email) return null;
  const name = [person.first_name, person.last_name].filter(Boolean).join(" ") || null;
  return { email: person.email, name, nr: person.nr };
}

export default async (): Promise<Response> => {
  let matches: HeroProjectMatch[];
  try {
    matches = await fetchProjectMatches(
      INVOICED_STATUS_CODES.length > 0 ? { statuses: INVOICED_STATUS_CODES } : undefined
    );
  } catch (err) {
    console.error("Fehler beim Laden der HERO-Projekte:", err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });
  }

  let checked = 0;
  let sent = 0;
  let skippedNoInvoice = 0;
  let skippedAlreadySent = 0;
  let skippedNoEmail = 0;
  let skippedNoCustomerNr = 0;

  for (const match of matches) {
    checked++;

    const hasInvoice = match.customer_documents.some((d) => d.type === "invoice");

    if (DEBUG) {
      console.log(
        `DEBUG ${match.project_nr}: measure=${match.measure?.name ?? match.measure?.short} ` +
          `status=${match.current_project_match_status?.status_code} (${match.current_project_match_status?.name}) ` +
          `dokumente=[${match.customer_documents.map((d) => d.type).join(",")}] hatRechnung=${hasInvoice}`
      );
    }

    if (!hasInvoice) {
      skippedNoInvoice++;
      continue;
    }

    const recipient = recipientOf(match);
    if (!recipient) {
      skippedNoEmail++;
      continue;
    }
    if (!recipient.nr) {
      skippedNoCustomerNr++;
      console.warn(`Keine Kundennummer (nr) für project_match ${match.id} (${match.project_nr}) – übersprungen.`);
      continue;
    }

    if (await wasReferralCodeSent(recipient.nr)) {
      skippedAlreadySent++;
      continue;
    }

    const code = buildReferralCode(recipient.nr);
    const landingUrl = `${getBaseUrl()}/.netlify/functions/hero-referral-landing?code=${encodeURIComponent(code)}`;

    if (!DRY_RUN) {
      try {
        await sendGraphMail({
          toEmail: recipient.email,
          toName: recipient.name,
          subject: buildReferralMailSubject(),
          body: buildReferralMailBody(recipient.name, code, landingUrl),
        });
        await markReferralCodeSent(recipient.nr);
        sent++;
      } catch (err) {
        console.error(`Empfehlungscode-Mail fehlgeschlagen für Kunde ${recipient.nr}:`, err);
      }
    } else {
      sent++;
    }
  }

  const summary = {
    checked,
    sent,
    skippedNoInvoice,
    skippedAlreadySent,
    skippedNoEmail,
    skippedNoCustomerNr,
    dryRun: DRY_RUN,
  };

  console.log("HERO Empfehlungscode-Versand abgeschlossen:", JSON.stringify(summary));

  return new Response(JSON.stringify(summary, null, 2), {
    headers: { "content-type": "application/json" },
  });
};
