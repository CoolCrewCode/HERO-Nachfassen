import {
  listSubmissions,
  updateSubmission,
  type ReferralStatus,
  type PremiumStatus,
  type RewardType,
} from "../../lib/referral-store.mts";
import {
  verifyReferralDashboardKey,
  verifyReferralActionSignature,
  buildReferralActionLink,
  buildReferralDashboardLink,
} from "../../lib/approval.mts";

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatDate(iso: string): string {
  try {
    return new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
  } catch {
    return iso;
  }
}

const STATUS_LABELS: Record<ReferralStatus, string> = {
  eingegangen: "🆕 Eingegangen",
  lead_angelegt: "📋 Lead angelegt",
  auftrag: "✅ Auftrag",
  abgelehnt: "❌ Abgelehnt",
};

const PREMIUM_LABELS: Record<PremiumStatus, string> = {
  offen: "Prämie: offen",
  faellig: "💶 Prämie fällig",
  ausgezahlt: "✔️ Prämie ausgezahlt",
  entfaellt: "Prämie entfällt",
};

const STATUS_ORDER: ReferralStatus[] = ["eingegangen", "lead_angelegt", "auftrag", "abgelehnt"];
const PREMIUM_ORDER: PremiumStatus[] = ["offen", "faellig", "ausgezahlt", "entfaellt"];

const REWARD_LABELS: Record<RewardType, string> = {
  bar: "💶 Bar-Prämie",
  wartungsrabatt: "🔧 Wartungsrabatt",
};
const REWARD_ORDER: RewardType[] = ["bar", "wartungsrabatt"];

export default async (req: Request): Promise<Response> => {
  const url = new URL(req.url);

  // Status-Änderung? (Klick auf einen der Aktions-Links unten auf der Seite)
  const actionId = url.searchParams.get("id");
  const field = url.searchParams.get("field");
  const value = url.searchParams.get("value");
  const sig = url.searchParams.get("sig");

  if (actionId && field && value && sig) {
    const validField = field === "status" || field === "premiumStatus" || field === "rewardType";
    if (!validField || !verifyReferralActionSignature(actionId, field, value, sig)) {
      return new Response("Ungültiger Link", { status: 403 });
    }
    try {
      await updateSubmission(actionId, { [field]: value } as Partial<{
        status: ReferralStatus;
        premiumStatus: PremiumStatus;
        rewardType: RewardType;
      }>);
    } catch (err) {
      console.error("Konnte Empfehlungsstatus nicht aktualisieren:", err);
    }
    // Nach der Aktion zurück zur normalen Übersicht (ohne Aktions-Parameter in der URL).
    return Response.redirect(buildReferralDashboardLink(), 303);
  }

  // Normale Ansicht
  const key = url.searchParams.get("key");
  if (!key || !verifyReferralDashboardKey(key)) {
    return new Response(
      `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>Ungültiger Link</title></head>` +
        `<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem">` +
        `<h1>Ungültiger Link</h1><p>Dieser Link ist nicht gültig.</p></body></html>`,
      { status: 403, headers: { "content-type": "text/html; charset=utf-8" } }
    );
  }

  let submissions;
  try {
    submissions = await listSubmissions();
  } catch (err) {
    return new Response(
      `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>Fehler</title></head>` +
        `<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem">` +
        `<h1>Fehler</h1><p>Die Empfehlungen konnten nicht geladen werden: ${escapeHtml(String(err))}</p></body></html>`,
      { status: 502, headers: { "content-type": "text/html; charset=utf-8" } }
    );
  }

  const rows = submissions
    .map((s) => {
      const statusButtons = STATUS_ORDER.filter((st) => st !== s.status)
        .map((st) => `<a class="chip" href="${buildReferralActionLink(s.id, "status", st)}">${STATUS_LABELS[st]}</a>`)
        .join(" ");
      const premiumButtons = PREMIUM_ORDER.filter((p) => p !== s.premiumStatus)
        .map((p) => `<a class="chip" href="${buildReferralActionLink(s.id, "premiumStatus", p)}">${PREMIUM_LABELS[p]}</a>`)
        .join(" ");
      const rewardButtons = REWARD_ORDER.filter((r) => r !== s.rewardType)
        .map((r) => `<a class="chip" href="${buildReferralActionLink(s.id, "rewardType", r)}">${REWARD_LABELS[r]}</a>`)
        .join(" ");
      const rewardLabel = s.rewardType ? REWARD_LABELS[s.rewardType] : "Noch keine Wahl";

      return `<tr>
        <td>${escapeHtml(formatDate(s.createdAt))}</td>
        <td>${escapeHtml(s.referrerCode || "–")}${s.referrerCustomerNr ? "" : ' <span class="warn">(unbekanntes Format)</span>'}</td>
        <td>${escapeHtml(s.newContactName)}<div class="muted">${escapeHtml(s.newContactEmail)}${s.newContactPhone ? " · " + escapeHtml(s.newContactPhone) : ""}</div>
            ${s.message ? `<div class="muted">"${escapeHtml(s.message)}"</div>` : ""}</td>
        <td><strong>${STATUS_LABELS[s.status]}</strong><div class="chips">${statusButtons}</div></td>
        <td><strong>${PREMIUM_LABELS[s.premiumStatus]}</strong><div class="chips">${premiumButtons}</div></td>
        <td><strong>${rewardLabel}</strong><div class="chips">${rewardButtons}</div></td>
      </tr>`;
    })
    .join("\n");

  const body = `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><title>Empfehlungen – Übersicht</title>
<style>
  body{font-family:system-ui,sans-serif;max-width:72rem;margin:2rem auto;padding:0 1rem;line-height:1.4;color:#1a1a1a}
  h1{margin-bottom:0.25rem}
  .sub{color:#555;margin-top:0}
  table{width:100%;border-collapse:collapse;margin-top:1.5rem}
  th{text-align:left;border-bottom:2px solid #ddd;padding:0.5rem;font-size:0.85rem;color:#555}
  td{border-bottom:1px solid #eee;padding:0.6rem 0.5rem;vertical-align:top;font-size:0.9rem}
  .muted{color:#777;font-size:0.8rem;margin-top:0.2rem}
  .warn{color:#b45309;font-size:0.8rem}
  .chips{margin-top:0.4rem}
  .chip{display:inline-block;font-size:0.75rem;padding:0.15rem 0.5rem;border-radius:999px;background:#f0f0f0;
        color:#333;text-decoration:none;margin:0.1rem 0.2rem 0.1rem 0}
  .chip:hover{background:#e0e0e0}
  .empty{margin-top:2rem;padding:1.5rem;background:#f0fdf4;border-radius:8px;color:#166534}
</style>
</head><body>
  <h1>Empfehlungen – Übersicht</h1>
  <p class="sub">${submissions.length} Empfehlung(en) insgesamt. Status/Prämie per Klick auf die kleinen Buttons ändern.</p>
  ${
    submissions.length === 0
      ? `<div class="empty">Noch keine Empfehlungen eingegangen.</div>`
      : `<table>
        <thead><tr><th>Datum</th><th>Code</th><th>Neuer Kontakt</th><th>Status</th><th>Prämie</th><th>Prämienwahl</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`
  }
</body></html>`;

  return new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
};
