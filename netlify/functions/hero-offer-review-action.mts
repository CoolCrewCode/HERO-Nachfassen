import { fetchProjectMatches, addLogbookEntry, type HeroProjectMatch } from "../../lib/hero-client.mts";
import { sendGraphMail } from "../../lib/graph-mailer.mts";
import {
  buildSubject,
  buildBody,
  buildSentMarker,
  buildSkipMarker,
  alreadySent,
  alreadySkipped,
} from "../../lib/mail-template.mts";
import { verifySignature, type ApprovalAction } from "../../lib/approval.mts";

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function htmlPage(title: string, bodyHtml: string): Response {
  const body = `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><title>${title}</title>
<style>
  body{font-family:system-ui,sans-serif;max-width:36rem;margin:4rem auto;padding:0 1rem;line-height:1.5}
  .preview{border:1px solid #ccc;border-radius:8px;padding:1rem;background:#f9f9f9;margin:1.5rem 0}
  .preview dt{font-weight:bold;margin-top:0.5rem}
  .preview dd{margin:0.25rem 0 0}
  .btn{display:inline-block;padding:0.6rem 1.2rem;background:#1a7f37;color:#fff;text-decoration:none;
       border-radius:6px;font-weight:bold}
  .btn:hover{background:#146c2e}
</style>
</head><body><h1>${title}</h1>${bodyHtml}</body></html>`;
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
  const confirmed = url.searchParams.get("confirm") === "1";

  if (!action || !matchId || !offerNr || !signature || (action !== "send" && action !== "skip")) {
    return htmlPage("Ungültiger Link", "<p>Dieser Link ist unvollständig oder fehlerhaft.</p>");
  }

  if (!verifySignature(matchId, offerNr, action, signature)) {
    return htmlPage("Ungültiger Link", "<p>Dieser Link ist nicht gültig (falsche oder abgelaufene Signatur).</p>");
  }

  const matchIdNum = Number(matchId);
  if (!Number.isFinite(matchIdNum)) {
    return htmlPage("Ungültiger Link", "<p>Die Projekt-ID in diesem Link ist ungültig.</p>");
  }

  let matches: HeroProjectMatch[];
  try {
    matches = await fetchProjectMatches({ ids: [matchIdNum] });
  } catch (err) {
    return htmlPage("Fehler", `<p>Die HERO-Daten konnten nicht geladen werden: ${escapeHtml(String(err))}</p>`);
  }

  const match = matches.find((m) => m.id === matchId);
  if (!match) {
    return htmlPage(
      "Nicht gefunden",
      "<p>Dieses Projekt wurde in HERO nicht gefunden. Das passiert meist, wenn es zwischenzeitlich bereits " +
        "geschlossen/archiviert wurde — dann ist ohnehin keine Nachfass-Mail mehr nötig, es ist also alles in Ordnung.</p>"
    );
  }

  // Verschickt ist endgültig (die Mail ist raus, das lässt sich nicht zurückholen).
  if (alreadySent(match)) {
    return htmlPage(
      "Bereits erledigt",
      `<p>Für Angebot ${escapeHtml(offerNr)} (Projekt ${escapeHtml(match.project_nr)}) wurde die Nachfass-Mail ` +
        "bereits verschickt — es passiert nichts Weiteres.</p>"
    );
  }

  // "Übersprungen" ist dagegen eine Zwischenentscheidung: Ein erneuter Klick auf "Nein" ist einfach
  // idempotent, aber ein Klick auf "Ja" nach vorherigem "Nein" wird bewusst zugelassen (Umentscheiden
  // soll möglich sein, z.B. wenn sich die Lage beim Kunden doch wieder geändert hat).
  if (action === "skip" && alreadySkipped(match)) {
    return htmlPage(
      "Bereits übersprungen",
      `<p>Für Angebot ${escapeHtml(offerNr)} (Projekt ${escapeHtml(match.project_nr)}) hattest du schon ` +
        "entschieden, nicht nachzufassen — es passiert nichts Weiteres.</p>"
    );
  }

  const offer = match.customer_documents.find((d) => d.nr === offerNr);
  if (!offer) {
    return htmlPage("Nicht gefunden", "<p>Dieses Angebot wurde in HERO nicht gefunden.</p>");
  }

  const now = new Date().toISOString();
  const isReversal = action === "send" && alreadySkipped(match);

  if (action === "skip") {
    await addLogbookEntry(match.id, buildSkipMarker(now));
    return htmlPage(
      "Übersprungen",
      `<p>Für Angebot ${escapeHtml(offer.nr)} (Projekt ${escapeHtml(match.project_nr)}) wird nicht nachgefasst. ` +
        "Das ist in HERO vermerkt. Falls sich das noch ändert, kannst du jederzeit auf denselben \"Ja\"-Link " +
        "aus der E-Mail klicken, um das rückgängig zu machen.</p>"
    );
  }

  const recipient = findRecipient(match);
  if (!recipient) {
    return htmlPage(
      "Kein Kontakt gefunden",
      `<p>Für Projekt ${escapeHtml(match.project_nr)} ist keine E-Mail-Adresse hinterlegt, es konnte keine ` +
        "Mail verschickt werden.</p>"
    );
  }

  const subject = buildSubject({ toName: recipient.name, projectNr: match.project_nr, offer });
  const body = buildBody({ toName: recipient.name, projectNr: match.project_nr, offer });

  // Erst Vorschau zeigen. Erst der zweite Klick (mit confirm=1) verschickt tatsächlich.
  if (!confirmed) {
    const confirmUrl = new URL(req.url);
    confirmUrl.searchParams.set("confirm", "1");

    const reversalNote = isReversal
      ? `<p>ℹ️ Du hattest dieses Angebot zuvor übersprungen — mit "Ja" wird das jetzt rückgängig gemacht.</p>`
      : "";

    return htmlPage(
      "Vorschau – noch nicht verschickt",
      reversalNote +
        `<p>Diese Mail würde an <strong>${escapeHtml(recipient.name ?? recipient.email)}</strong> ` +
        `(${escapeHtml(recipient.email)}) verschickt werden:</p>` +
        `<div class="preview"><dl>` +
        `<dt>Betreff</dt><dd>${escapeHtml(subject)}</dd>` +
        `<dt>Text</dt><dd>${escapeHtml(body).replaceAll("\n", "<br>")}</dd>` +
        `</dl></div>` +
        `<p><a class="btn" href="${confirmUrl.toString()}">✅ Ja, jetzt wirklich senden</a></p>` +
        `<p>Wenn du hier nichts klickst, passiert nichts — der Kunde bekommt keine Mail.</p>`
    );
  }

  try {
    await sendGraphMail({
      toEmail: recipient.email,
      toName: recipient.name,
      subject,
      body,
    });
    await addLogbookEntry(match.id, buildSentMarker(now));
  } catch (err) {
    return htmlPage("Fehler beim Versand", `<p>Die Mail konnte nicht verschickt werden: ${escapeHtml(String(err))}</p>`);
  }

  return htmlPage(
    "Mail verschickt",
    `<p>Die Nachfass-Mail für Angebot ${escapeHtml(offer.nr)} wurde an ${escapeHtml(recipient.email)} verschickt.</p>`
  );
};
