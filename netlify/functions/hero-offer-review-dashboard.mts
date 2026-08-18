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

// Läuft im Browser der Übersichtsseite (nicht in der Netlify Function). Ruft dieselbe
// hero-offer-review-action-Funktion per fetch() mit format=json auf, statt dorthin zu
// navigieren, und aktualisiert nur die betroffene Tabellenzeile.
const CLIENT_SCRIPT = `
function setRowBusy(row, busy) {
  row.querySelectorAll("button").forEach(function (b) { b.disabled = busy; });
}

function showResultInRow(row, html) {
  var cell = row.querySelector(".actions");
  cell.innerHTML = html;
}

async function callAction(url) {
  var sep = url.indexOf("?") === -1 ? "?" : "&";
  var res = await fetch(url + sep + "format=json");
  return res.json();
}

function renderStatus(result) {
  if (result.status === "skipped" || result.status === "already_skipped") {
    return '<span class="tag tag-no">🚫 Übersprungen</span> <button type="button" class="linklike js-undo">rückgängig?</button>';
  }
  if (result.status === "sent" || result.status === "already_sent") {
    return '<span class="tag tag-yes">✅ Verschickt</span>';
  }
  if (result.status === "not_found") {
    return '<span class="tag tag-warn">⚠️ Nicht mehr in HERO gefunden (evtl. schon archiviert)</span>';
  }
  return '<span class="tag tag-warn">⚠️ ' + result.message + '</span>';
}

document.addEventListener("click", async function (ev) {
  var el = ev.target.closest("[data-skip-url], [data-send-url], .js-undo, .js-confirm-send");
  if (!el) return;
  ev.preventDefault();
  var row = el.closest("tr");

  if (el.hasAttribute("data-skip-url")) {
    setRowBusy(row, true);
    var result = await callAction(el.getAttribute("data-skip-url"));
    showResultInRow(row, renderStatus(result));
    return;
  }

  if (el.hasAttribute("data-send-url")) {
    setRowBusy(row, true);
    var result = await callAction(el.getAttribute("data-send-url"));
    if (result.status !== "preview") {
      showResultInRow(row, renderStatus(result));
      return;
    }
    var html =
      '<div class="inline-preview">' +
      (result.isReversal ? '<p class="note">ℹ️ War übersprungen — wird jetzt rückgängig gemacht.</p>' : "") +
      '<dl><dt>Betreff</dt><dd>' + result.subject.replace(/&/g,"&amp;").replace(/</g,"&lt;") + '</dd>' +
      '<dt>Text</dt><dd>' + result.body.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/\\n/g,"<br>") + '</dd></dl>' +
      '<button type="button" class="btn btn-yes js-confirm-send" data-confirm-url="' + result.confirmUrl + '">✅ Jetzt wirklich senden</button> ' +
      '<button type="button" class="linklike js-cancel-send">Abbrechen</button>' +
      '</div>';
    showResultInRow(row, html);
    row.querySelector(".js-cancel-send").addEventListener("click", function () {
      showResultInRow(row, row.getAttribute("data-original-actions"));
    });
    setRowBusy(row, false);
    return;
  }

  if (el.classList.contains("js-confirm-send")) {
    setRowBusy(row, true);
    var result = await callAction(el.getAttribute("data-confirm-url"));
    showResultInRow(row, renderStatus(result));
    return;
  }

  if (el.classList.contains("js-undo")) {
    var original = row.getAttribute("data-original-actions");
    showResultInRow(row, original);
  }
});
`;

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

  // Älteste (am längsten überfällige) zuerst, die sind am dringendsten.
  const sorted = [...result.due].sort((a, b) => b.daysOld - a.daysOld);

  const rows = sorted
    .map((c) => {
      const name = c.recipient.name ?? c.recipient.email;
      const sendLink = buildApprovalLink(c.match.id, c.offer.nr, "send");
      const skipLink = buildApprovalLink(c.match.id, c.offer.nr, "skip");
      const skippedNote = c.wasSkippedBefore
        ? `<div class="note">🚫 zuvor übersprungen — "Ja" macht das rückgängig</div>`
        : "";
      const actionsHtml =
        `<a class="btn btn-yes" href="${sendLink}" data-send-url="${sendLink}">✅ Ja</a> ` +
        `<a class="btn btn-no" href="${skipLink}" data-skip-url="${skipLink}">🚫 Nein</a>` +
        skippedNote;
      return `<tr data-original-actions="${escapeHtml(actionsHtml)}">
        <td>${escapeHtml(c.match.project_nr)}</td>
        <td>${escapeHtml(name)}<div class="muted">${escapeHtml(c.recipient.email)}</div></td>
        <td>${escapeHtml(c.offer.nr)}</td>
        <td>${escapeHtml(formatDate(c.offer.created))}</td>
        <td class="num">${Math.floor(c.daysOld)}</td>
        <td class="actions">${actionsHtml}</td>
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
  .actions{white-space:normal;min-width:12rem}
  .btn{display:inline-block;padding:0.35rem 0.7rem;border-radius:5px;text-decoration:none;font-weight:bold;
       font-size:0.9rem;margin-right:0.3rem;border:none;cursor:pointer;font-family:inherit}
  .btn-yes{background:#1a7f37;color:#fff}
  .btn-no{background:#b42318;color:#fff}
  .btn:disabled{opacity:0.5;cursor:default}
  .linklike{background:none;border:none;color:#0969da;text-decoration:underline;cursor:pointer;font-size:0.85rem;
            padding:0;font-family:inherit}
  .note{font-size:0.8rem;color:#b45309;margin-top:0.3rem}
  .tag{font-weight:bold;font-size:0.9rem}
  .tag-no{color:#b42318}
  .tag-yes{color:#1a7f37}
  .tag-warn{color:#b45309}
  .inline-preview{background:#f9f9f9;border:1px solid #ccc;border-radius:8px;padding:0.75rem;max-width:28rem}
  .inline-preview dt{font-weight:bold;margin-top:0.4rem;font-size:0.85rem}
  .inline-preview dd{margin:0.15rem 0 0;font-size:0.9rem}
  .empty{margin-top:2rem;padding:1.5rem;background:#f0fdf4;border-radius:8px;color:#166534}
</style>
</head><body>
  <h1>Offene Angebote – Nachfassen</h1>
  <p class="sub">${result.due.length} Angebot(e) seit mindestens ${FOLLOWUP_AFTER_DAYS} Tagen ohne Rückmeldung.
    Ja/Nein wirkt sofort in dieser Zeile, ohne die Seite neu zu laden.</p>
  ${
    result.due.length === 0
      ? `<div class="empty">🎉 Aktuell nichts offen. Alles erledigt oder noch nicht fällig.</div>`
      : `<table>
        <thead><tr><th>Projekt</th><th>Kunde</th><th>Angebot</th><th>Datum</th><th>Tage</th><th>Aktion</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`
  }
  <script>${CLIENT_SCRIPT}</script>
</body></html>`;

  return new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
};
