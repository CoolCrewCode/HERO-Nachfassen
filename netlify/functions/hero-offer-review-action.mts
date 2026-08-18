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
import { verifySignature, buildDashboardLink, type ApprovalAction } from "../../lib/approval.mts";

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

type ActionResult =
  | { status: "invalid_link"; message: string }
  | { status: "not_found"; message: string }
  | { status: "already_sent"; message: string }
  | { status: "already_skipped"; message: string }
  | { status: "skipped"; message: string }
  | { status: "no_contact"; message: string }
  | {
      status: "preview";
      subject: string;
      body: string;
      recipientName: string;
      recipientEmail: string;
      isReversal: boolean;
      confirmUrl: string;
    }
  | { status: "sent"; message: string }
  | { status: "error"; message: string };

function htmlPage(title: string, bodyHtml: string): Response {
  let backLink = "";
  try {
    backLink = `<p><a href="${buildDashboardLink()}">← Zurück zur Übersicht</a></p>`;
  } catch {
    // APPROVAL_SECRET fehlt o.ä. – dann eben ohne Rücklink, der Rest der Seite bleibt nutzbar.
  }

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
  .back{margin-top:2rem;font-size:0.9rem}
</style>
</head><body><h1>${title}</h1>${bodyHtml}<div class="back">${backLink}</div></body></html>`;
  return new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
}

function jsonResponse(result: ActionResult): Response {
  return new Response(JSON.stringify(result), { headers: { "content-type": "application/json" } });
}

// Bildet ein ActionResult auf eine vollständige HTML-Seite ab (für Klicks direkt aus der E-Mail,
// ohne JavaScript – die Übersichtsseite nutzt stattdessen jsonResponse und aktualisiert sich selbst).
function resultToHtmlPage(result: ActionResult): Response {
  switch (result.status) {
    case "invalid_link":
    case "not_found":
    case "already_sent":
    case "already_skipped":
    case "skipped":
    case "no_contact":
    case "sent":
    case "error": {
      const titles: Record<string, string> = {
        invalid_link: "Ungültiger Link",
        not_found: "Nicht gefunden",
        already_sent: "Bereits erledigt",
        already_skipped: "Bereits übersprungen",
        skipped: "Übersprungen",
        no_contact: "Kein Kontakt gefunden",
        sent: "Mail verschickt",
        error: "Fehler",
      };
      return htmlPage(titles[result.status], `<p>${escapeHtml(result.message)}</p>`);
    }
    case "preview": {
      const reversalNote = result.isReversal
        ? `<p>ℹ️ Du hattest dieses Angebot zuvor übersprungen — mit "Ja" wird das jetzt rückgängig gemacht.</p>`
        : "";
      return htmlPage(
        "Vorschau – noch nicht verschickt",
        reversalNote +
          `<p>Diese Mail würde an <strong>${escapeHtml(result.recipientName)}</strong> ` +
          `(${escapeHtml(result.recipientEmail)}) verschickt werden:</p>` +
          `<div class="preview"><dl>` +
          `<dt>Betreff</dt><dd>${escapeHtml(result.subject)}</dd>` +
          `<dt>Text</dt><dd>${escapeHtml(result.body).replaceAll("\n", "<br>")}</dd>` +
          `</dl></div>` +
          `<p><a class="btn" href="${result.confirmUrl}">✅ Ja, jetzt wirklich senden</a></p>` +
          `<p>Wenn du hier nichts klickst, passiert nichts — der Kunde bekommt keine Mail.</p>`
      );
    }
  }
}

function findRecipient(match: HeroProjectMatch): { email: string; name: string | null } | null {
  const person = match.contact ?? match.customer;
  if (!person?.email) return null;
  const name = [person.first_name, person.last_name].filter(Boolean).join(" ") || null;
  return { email: person.email, name };
}

async function handle(req: Request): Promise<ActionResult> {
  const url = new URL(req.url);
  const action = url.searchParams.get("action") as ApprovalAction | null;
  const matchId = url.searchParams.get("matchId");
  const offerNr = url.searchParams.get("offerNr");
  const signature = url.searchParams.get("sig");
  const confirmed = url.searchParams.get("confirm") === "1";

  if (!action || !matchId || !offerNr || !signature || (action !== "send" && action !== "skip")) {
    return { status: "invalid_link", message: "Dieser Link ist unvollständig oder fehlerhaft." };
  }

  if (!verifySignature(matchId, offerNr, action, signature)) {
    return { status: "invalid_link", message: "Dieser Link ist nicht gültig (falsche oder abgelaufene Signatur)." };
  }

  const matchIdNum = Number(matchId);
  if (!Number.isFinite(matchIdNum)) {
    return { status: "invalid_link", message: "Die Projekt-ID in diesem Link ist ungültig." };
  }

  let matches: HeroProjectMatch[];
  try {
    matches = await fetchProjectMatches({ ids: [matchIdNum] });
  } catch (err) {
    return { status: "error", message: `Die HERO-Daten konnten nicht geladen werden: ${String(err)}` };
  }

  // HERO liefert die id als Zahl zurück, matchId aus der URL ist ein String – deshalb hier
  // beide als String vergleichen (sonst schlägt der Vergleich immer fehl, siehe status_code-Bug).
  const match = matches.find((m) => String(m.id) === matchId);
  if (!match) {
    return {
      status: "not_found",
      message:
        "Dieses Projekt wurde in HERO nicht gefunden. Das passiert meist, wenn es zwischenzeitlich bereits " +
        "geschlossen/archiviert wurde — dann ist ohnehin keine Nachfass-Mail mehr nötig, es ist also alles in Ordnung.",
    };
  }

  // Verschickt ist endgültig (die Mail ist raus, das lässt sich nicht zurückholen).
  if (alreadySent(match)) {
    return {
      status: "already_sent",
      message: `Für Angebot ${offerNr} (Projekt ${match.project_nr}) wurde die Nachfass-Mail bereits verschickt — es passiert nichts Weiteres.`,
    };
  }

  // "Übersprungen" ist dagegen eine Zwischenentscheidung: Ein erneuter Klick auf "Nein" ist einfach
  // idempotent, aber ein Klick auf "Ja" nach vorherigem "Nein" wird bewusst zugelassen (Umentscheiden
  // soll möglich sein, z.B. wenn sich die Lage beim Kunden doch wieder geändert hat).
  if (action === "skip" && alreadySkipped(match)) {
    return {
      status: "already_skipped",
      message: `Für Angebot ${offerNr} (Projekt ${match.project_nr}) hattest du schon entschieden, nicht nachzufassen — es passiert nichts Weiteres.`,
    };
  }

  const offer = match.customer_documents.find((d) => d.nr === offerNr);
  if (!offer) {
    return { status: "not_found", message: "Dieses Angebot wurde in HERO nicht gefunden." };
  }

  const now = new Date().toISOString();
  const isReversal = action === "send" && alreadySkipped(match);

  if (action === "skip") {
    try {
      await addLogbookEntry(match.id, buildSkipMarker(now));
    } catch (err) {
      return { status: "error", message: `Der Vermerk "übersprungen" konnte nicht in HERO gespeichert werden: ${String(err)}` };
    }
    return {
      status: "skipped",
      message: `Für Angebot ${offer.nr} (Projekt ${match.project_nr}) wird nicht nachgefasst. Das ist in HERO vermerkt. Du kannst das jederzeit rückgängig machen.`,
    };
  }

  const recipient = findRecipient(match);
  if (!recipient) {
    return {
      status: "no_contact",
      message: `Für Projekt ${match.project_nr} ist keine E-Mail-Adresse hinterlegt, es konnte keine Mail verschickt werden.`,
    };
  }

  const subject = buildSubject({ toName: recipient.name, projectNr: match.project_nr, offer });
  const body = buildBody({ toName: recipient.name, projectNr: match.project_nr, offer });

  if (!confirmed) {
    const confirmUrl = new URL(req.url);
    confirmUrl.searchParams.set("confirm", "1");
    return {
      status: "preview",
      subject,
      body,
      recipientName: recipient.name ?? recipient.email,
      recipientEmail: recipient.email,
      isReversal,
      confirmUrl: confirmUrl.toString(),
    };
  }

  try {
    await sendGraphMail({ toEmail: recipient.email, toName: recipient.name, subject, body });
    await addLogbookEntry(match.id, buildSentMarker(now));
  } catch (err) {
    return { status: "error", message: `Die Mail konnte nicht verschickt werden: ${String(err)}` };
  }

  return {
    status: "sent",
    message: `Die Nachfass-Mail für Angebot ${offer.nr} wurde an ${recipient.email} verschickt.`,
  };
}

export default async (req: Request): Promise<Response> => {
  const wantsJson = new URL(req.url).searchParams.get("format") === "json";
  const result = await handle(req);
  return wantsJson ? jsonResponse(result) : resultToHtmlPage(result);
};
