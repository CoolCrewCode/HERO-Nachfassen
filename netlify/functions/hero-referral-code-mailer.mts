import { fetchProjectMatches, type HeroDocument, type HeroPerson, type HeroProjectMatch } from "../../lib/hero-client.mts";
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

// Rechnungen, die älter sind, werden nicht mehr berücksichtigt – sonst bekäme beim ersten Lauf
// der komplette Bestand (auch Jahre alte Rechnungen) rückwirkend eine Werbe-Mail. Entscheidung
// von Robert: 90 Tage.
const MAX_INVOICE_AGE_DAYS = Number(process.env.REFERRAL_MAX_INVOICE_AGE_DAYS ?? 90);

const DRY_RUN = process.env.REFERRAL_DRY_RUN === "true";
const DEBUG = process.env.REFERRAL_DEBUG === "true";
const SEND_CONCURRENCY = 5;

function daysSince(iso: string): number {
  return (Date.now() - new Date(iso).getTime()) / (1000 * 60 * 60 * 24);
}

function latestInvoice(docs: HeroDocument[]): HeroDocument | null {
  const invoices = docs.filter((d) => d.type === "invoice");
  if (invoices.length === 0) return null;
  return invoices.reduce((latest, d) => (new Date(d.created) > new Date(latest.created) ? d : latest));
}

function recipientOf(match: HeroProjectMatch): { email: string; name: string | null; nr: string | null } | null {
  const person: HeroPerson | null = match.customer ?? match.contact;
  if (!person?.email) return null;
  const name = [person.first_name, person.last_name].filter(Boolean).join(" ") || null;
  return { email: person.email, name, nr: person.nr };
}

interface Candidate {
  recipient: { email: string; name: string | null; nr: string };
  code: string;
  landingUrl: string;
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
  let skippedNoInvoice = 0;
  let skippedTooOld = 0;
  let skippedAlreadySent = 0;
  let skippedNoEmail = 0;
  let skippedNoCustomerNr = 0;
  const candidates: Candidate[] = [];

  for (const match of matches) {
    checked++;

    const invoice = latestInvoice(match.customer_documents);

    if (DEBUG) {
      console.log(
        `DEBUG ${match.project_nr}: measure=${match.measure?.name ?? match.measure?.short} ` +
          `status=${match.current_project_match_status?.status_code} (${match.current_project_match_status?.name}) ` +
          `dokumente=[${match.customer_documents.map((d) => d.type).join(",")}] ` +
          `rechnungGefunden=${!!invoice} ` +
          (invoice ? `rechnungDatum=${invoice.created} tageAlt=${daysSince(invoice.created).toFixed(1)}` : "")
      );
    }

    if (!invoice) {
      skippedNoInvoice++;
      continue;
    }

    if (daysSince(invoice.created) > MAX_INVOICE_AGE_DAYS) {
      skippedTooOld++;
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
    candidates.push({
      recipient: { email: recipient.email, name: recipient.name, nr: recipient.nr },
      code,
      landingUrl: `${getBaseUrl()}/.netlify/functions/hero-referral-landing?code=${encodeURIComponent(code)}`,
    });
  }

  let sent = 0;
  if (!DRY_RUN) {
    // Parallel in Batches verschicken, sonst droht bei vielen Kandidaten das 30-Sekunden-
    // Zeitlimit von Netlify Functions (siehe dieselbe Lösung beim Nachfass-System).
    for (let i = 0; i < candidates.length; i += SEND_CONCURRENCY) {
      const batch = candidates.slice(i, i + SEND_CONCURRENCY);
      const results = await Promise.all(
        batch.map((c) =>
          sendGraphMail({
            toEmail: c.recipient.email,
            toName: c.recipient.name,
            subject: buildReferralMailSubject(),
            body: buildReferralMailBody(c.recipient.name, c.code, c.landingUrl),
          })
            .then(() => markReferralCodeSent(c.recipient.nr))
            .then(() => true)
            .catch((err) => {
              console.error(`Empfehlungscode-Mail fehlgeschlagen für Kunde ${c.recipient.nr}:`, err);
              return false;
            })
        )
      );
      sent += results.filter(Boolean).length;
    }
  } else {
    sent = candidates.length;
  }

  const summary = {
    checked,
    candidates: candidates.length,
    sent,
    skippedNoInvoice,
    skippedTooOld,
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
