import { fetchDueCandidates, FOLLOWUP_AFTER_DAYS } from "../../lib/candidates.mts";
import { buildApprovalLink, verifyDashboardKey } from "../../lib/approval.mts";

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatDate(iso: string): string {
  try {
    return new Intl.DateTimeFormat("de-DE", { dateStyle: "medium" }).format(new Date(iso));
  } catch {
    return iso;
  }
}

export default async (req: Request): Promise<Response> => {
  const url = new URL(req.url);
  const key = url.searchParams.get("key");

  if (!key || !verifyDashboardKey(key)) {
    return new Response(
      `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>Ungültiger Link</title></head>` +
        `<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem">` +
        `<h1>Ungültiger Link</h1><p>Dieser Link ist nicht gültig.</p></body></html>`,
      { status: 403, headers: { "content-type": "text/html; charset=utf-8" } }
    );
  }

  let result: Awaited<ReturnType<typeof fetchDueCandidates>>;
  try {
    result = await fetchDueCandidates();
  } catch (err) {
    return new Response(
      `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>Fehler</title></head>` +
        `<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem">` +
        `<h1>Fehler</h1><p>Die HERO-Daten konnten nicht geladen werden: ${escapeHtml(String(err))}</p></body></html>`,
      { status: 502, headers: { "content-type": "text/html; charset=utf-8" } }
    );
  }

  // Neueste zuerst? Nein – älteste (am längsten überfällige) zuerst, die sind am dringendsten.
  const sorted = [...result.due].sort((a, b) => b.daysOld - a.daysOld);

  const rows = sorted
    .map((c) => {
      const name = c.recipient.name ?? c.recipient.email;
      const sendLink = buildApprovalLink(c.match.id, c.offer.nr, "send");
      const skipLink = buildApprovalLink(c.match.id, c.offer.nr, "skip");
      const skippedNote = c.wasSkippedBefore
        ? `<div class="note">🚫 zuvor übersprungen — "Ja" klicken macht das rückgängig</div>`
        : "";
      return `<tr>
        <td>${escapeHtml(c.match.project_nr)}</td>
        <td>${escapeHtml(name)}<div class="muted">${escapeHtml(c.recipient.email)}</div></td>
        <td>${escapeHtml(c.offer.nr)}</td>
        <td>${escapeHtml(formatDate(c.offer.created))}</td>
        <td class="num">${Math.floor(c.daysOld)}</td>
        <td class="actions">
          <a class="btn btn-yes" href="${sendLink}">✅ Ja</a>
          <a class="btn btn-no" href="${skipLink}">🚫 Nein</a>
          ${skippedNote}
        </td>
      </tr>`;
    })
    .join("\n");

  const body = `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><title>Offene Angebote – Nachfassen</title>
<style>
  body{font-family:system-ui,sans-serif;max-width:64rem;margin:2rem auto;padding:0 1rem;line-height:1.4;color:#1a1a1a}
  h1{margin-bottom:0.25rem}
  .sub{color:#555;margin-top:0}
  table{width:100%;border-collapse:collapse;margin-top:1.5rem}
  th{text-align:left;border-bottom:2px solid #ddd;padding:0.5rem;font-size:0.85rem;color:#555}
  td{border-bottom:1px solid #eee;padding:0.6rem 0.5rem;vertical-align:top}
  .muted{color:#777;font-size:0.85rem}
  .num{text-align:right;font-variant-numeric:tabular-nums}
  .actions{white-space:nowrap}
  .btn{display:inline-block;padding:0.35rem 0.7rem;border-radius:5px;text-decoration:none;font-weight:bold;
       font-size:0.9rem;margin-right:0.3rem}
  .btn-yes{background:#1a7f37;color:#fff}
  .btn-no{background:#b42318;color:#fff}
  .note{font-size:0.8rem;color:#b45309;margin-top:0.3rem}
  .empty{margin-top:2rem;padding:1.5rem;background:#f0fdf4;border-radius:8px;color:#166534}
</style>
</head><body>
  <h1>Offene Angebote – Nachfassen</h1>
  <p class="sub">${result.due.length} Angebot(e) seit mindestens ${FOLLOWUP_AFTER_DAYS} Tagen ohne Rückmeldung.
    Diese Seite zeigt immer den aktuellen Stand — bereits verschickte verschwinden automatisch.</p>
  ${
    result.due.length === 0
      ? `<div class="empty">🎉 Aktuell nichts offen. Alles erledigt oder noch nicht fällig.</div>`
      : `<table>
        <thead><tr><th>Projekt</th><th>Kunde</th><th>Angebot</th><th>Datum</th><th>Tage</th><th>Aktion</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`
  }
</body></html>`;

  return new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
};
