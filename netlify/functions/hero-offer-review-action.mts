import { fetchProjectMatches, addLogbookEntry, type HeroProjectMatch } from "../../lib/hero-client.mts";
import { sendGraphMail } from "../../lib/graph-mailer.mts";
import { buildSubject, buildBody, buildSentMarker, buildSkipMarker, alreadyHandled } from "../../lib/mail-template.mts";
import { verifySignature, type ApprovalAction } from "../../lib/approval.mts";

function htmlPage(title: string, message: string): Response {
  const body = `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5}</style>
</head><body><h1>${title}</h1><p>${message}</p></body></html>`;
  return new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
}

function findRecipient(match: HeroProjectMatch): { email: string; name: string | null } | null {
  const person = match.contact ?? match.customer;
  if (!person?.email) return null;
  const name = [person.first_name, person.last_name].filter(Boolean).join(" ") || null;
  return { email: person.email, name };
}

export default async (req: Request): Promise<Response> => {
  const url = new URL(req.url);
  const action = url.searchParams.get("action") as ApprovalAction | null;
  const matchId = url.searchParams.get("matchId");
  const offerNr = url.searchParams.get("offerNr");
  const signature = url.searchParams.get("sig");

  if (!action || !matchId || !offerNr || !signature || (action !== "send" && action !== "skip")) {
    return htmlPage("Ungültiger Link", "Dieser Link ist unvollständig oder fehlerhaft.");
  }

  if (!verifySignature(matchId, offerNr, action, signature)) {
    return htmlPage("Ungültiger Link", "Dieser Link ist nicht gültig (falsche oder abgelaufene Signatur).");
  }

  let matches: HeroProjectMatch[];
  try {
    matches = await fetchProjectMatches();
  } catch (err) {
    return htmlPage("Fehler", `Die HERO-Daten konnten nicht geladen werden: ${String(err)}`);
  }

  const match = matches.find((m) => m.id === matchId);
  if (!match) {
    return htmlPage("Nicht gefunden", "Dieses Angebot/Projekt wurde in HERO nicht gefunden.");
  }

  if (alreadyHandled(match)) {
    return htmlPage(
      "Bereits erledigt",
      `Für Angebot ${offerNr} (Projekt ${match.project_nr}) wurde bereits eine Entscheidung getroffen — ` +
        "es passiert nichts Weiteres."
    );
  }

  const offer = match.customer_documents.find((d) => d.nr === offerNr);
  if (!offer) {
    return htmlPage("Nicht gefunden", "Dieses Angebot wurde in HERO nicht gefunden.");
  }

  const now = new Date().toISOString();

  if (action === "skip") {
    await addLogbookEntry(match.id, buildSkipMarker(now));
    return htmlPage(
      "Übersprungen",
      `Für Angebot ${offer.nr} (Projekt ${match.project_nr}) wird nicht nachgefasst. Das ist in HERO vermerkt.`
    );
  }

  const recipient = findRecipient(match);
  if (!recipient) {
    return htmlPage(
      "Kein Kontakt gefunden",
      `Für Projekt ${match.project_nr} ist keine E-Mail-Adresse hinterlegt, es konnte keine Mail verschickt werden.`
    );
  }

  try {
    await sendGraphMail({
      toEmail: recipient.email,
      toName: recipient.name,
      subject: buildSubject({ toName: recipient.name, projectNr: match.project_nr, offer }),
      body: buildBody({ toName: recipient.name, projectNr: match.project_nr, offer }),
    });
    await addLogbookEntry(match.id, buildSentMarker(now));
  } catch (err) {
    return htmlPage("Fehler beim Versand", `Die Mail konnte nicht verschickt werden: ${String(err)}`);
  }

  return htmlPage(
    "Mail verschickt",
    `Die Nachfass-Mail für Angebot ${offer.nr} wurde an ${recipient.email} verschickt.`
  );
};
