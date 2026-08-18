import { randomUUID } from "node:crypto";
import { sendGraphMail } from "../../lib/graph-mailer.mts";
import { parseReferralCode } from "../../lib/referral.mts";
import { saveSubmission, type ReferralSubmission } from "../../lib/referral-store.mts";
import { buildReferralDashboardLink } from "../../lib/approval.mts";

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function page(title: string, bodyHtml: string): Response {
  const html = `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><title>${title}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body{font-family:system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;line-height:1.5;color:#1a1a1a}
  label{display:block;margin-top:1rem;font-weight:bold}
  input,textarea{width:100%;padding:0.5rem;margin-top:0.3rem;border:1px solid #ccc;border-radius:6px;
                 font-family:inherit;font-size:1rem;box-sizing:border-box}
  textarea{min-height:5rem}
  button{margin-top:1.5rem;padding:0.7rem 1.5rem;background:#1a7f37;color:#fff;border:none;border-radius:6px;
         font-weight:bold;font-size:1rem;cursor:pointer}
  button:hover{background:#146c2e}
  .error{color:#b42318}
  .code{background:#f0fdf4;border-radius:6px;padding:0.6rem 1rem;display:inline-block;font-weight:bold}
</style>
</head><body>${bodyHtml}</body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

function formPage(code: string, error?: string): Response {
  return page(
    "Weiterempfehlung – Küpper Kälte- und Klimatechnik",
    `<h1>Sie wurden empfohlen!</h1>
     <p>Schön, dass Sie den Weg zu uns gefunden haben. Hinterlassen Sie kurz Ihre Kontaktdaten,
     wir melden uns bei Ihnen.</p>
     ${code ? `<p>Empfehlungscode: <span class="code">${escapeHtml(code)}</span></p>` : ""}
     ${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
     <form method="POST">
       <input type="hidden" name="code" value="${escapeHtml(code)}">
       <label>Ihr Name*<input required name="name" autocomplete="name"></label>
       <label>Ihre E-Mail-Adresse*<input required type="email" name="email" autocomplete="email"></label>
       <label>Ihre Telefonnummer<input name="phone" autocomplete="tel"></label>
       <label>Kurze Nachricht (optional)<textarea name="message"></textarea></label>
       <button type="submit">Absenden</button>
     </form>`
  );
}

export default async (req: Request): Promise<Response> => {
  const url = new URL(req.url);

  if (req.method === "GET") {
    const code = url.searchParams.get("code")?.trim() ?? "";
    return formPage(code);
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const form = await req.formData();
  const code = String(form.get("code") ?? "").trim();
  const name = String(form.get("name") ?? "").trim();
  const email = String(form.get("email") ?? "").trim();
  const phone = String(form.get("phone") ?? "").trim();
  const message = String(form.get("message") ?? "").trim();

  if (!name || !email) {
    return formPage(code, "Bitte Name und E-Mail-Adresse angeben.");
  }

  const submission: ReferralSubmission = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    referrerCode: code,
    referrerCustomerNr: parseReferralCode(code),
    newContactName: name,
    newContactEmail: email,
    newContactPhone: phone,
    message,
    status: "eingegangen",
    premiumStatus: "offen",
  };

  try {
    await saveSubmission(submission);
  } catch (err) {
    console.error("Konnte Empfehlung nicht speichern:", err);
    return page(
      "Fehler",
      `<h1>Das hat leider nicht geklappt</h1>
       <p>Ihre Empfehlung konnte nicht gespeichert werden. Bitte versuchen Sie es später erneut
       oder rufen Sie uns an.</p>`
    );
  }

  const reviewTo = process.env.MAIL_REVIEW_TO?.trim();
  if (reviewTo) {
    try {
      await sendGraphMail({
        toEmail: reviewTo,
        toName: null,
        subject: `Neue Empfehlung: ${name}${code ? ` (Code ${code})` : ""}`,
        body: [
          "Neue Weiterempfehlung eingegangen:",
          "",
          `Empfehlungscode: ${code || "(keiner angegeben)"}`,
          `Name: ${name}`,
          `E-Mail: ${email}`,
          phone ? `Telefon: ${phone}` : "",
          message ? `Nachricht: ${message}` : "",
          "",
          "Bitte wie gewohnt als Lead in HERO anlegen. Alle Empfehlungen im Überblick:",
          buildReferralDashboardLink(),
        ]
          .filter(Boolean)
          .join("\n"),
      });
    } catch (err) {
      console.error("Konnte Benachrichtigung über neue Empfehlung nicht senden:", err);
    }
  }

  return page(
    "Vielen Dank!",
    `<h1>Vielen Dank!</h1>
     <p>Wir haben Ihre Empfehlung erhalten und melden uns in Kürze bei Ihnen.</p>`
  );
};
