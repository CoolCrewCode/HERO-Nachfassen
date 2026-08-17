import type { HeroDocument, HeroProjectMatch } from "./hero-client.mts";

export interface TemplateInput {
  toName: string | null;
  projectNr: string;
  offer: HeroDocument;
}

function formatCurrency(value: number | null): string {
  if (value === null || Number.isNaN(value)) return "";
  return new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" }).format(value);
}

function formatDate(iso: string): string {
  try {
    return new Intl.DateTimeFormat("de-DE", { dateStyle: "long" }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function applyPlaceholders(template: string, input: TemplateInput): string {
  return template
    .replaceAll("{{customer_name}}", input.toName ?? "")
    .replaceAll("{{project_nr}}", input.projectNr)
    .replaceAll("{{offer_nr}}", input.offer.nr)
    .replaceAll("{{offer_value}}", formatCurrency(input.offer.value))
    .replaceAll("{{offer_date}}", formatDate(input.offer.created))
    .replaceAll("{{company_name}}", process.env.COMPANY_NAME ?? "")
    .replaceAll("{{company_phone}}", process.env.COMPANY_PHONE ?? "");
}

export function buildSubject(input: TemplateInput): string {
  const template = process.env.MAIL_SUBJECT_TEMPLATE?.trim();
  if (template) return applyPlaceholders(template, input);
  return `Ihr Angebot ${input.offer.nr} – Haben Sie noch Fragen?`;
}

// Standardtext wie im Chat mit Robert abgestimmt (freundlich, unaufdringlich, klarer CTA).
export function buildBody(input: TemplateInput): string {
  const template = process.env.MAIL_BODY_TEMPLATE?.trim();
  if (template) return applyPlaceholders(template, input);

  const greeting = input.toName ? `Guten Tag ${input.toName}` : "Guten Tag";
  const phoneLine = process.env.COMPANY_PHONE
    ? `Sie erreichen uns unter ${process.env.COMPANY_PHONE} oder ganz einfach direkt auf diese E-Mail.`
    : "Antworten Sie gerne direkt auf diese E-Mail.";
  const signOff = process.env.MAIL_SIGNATURE?.trim() || process.env.COMPANY_NAME || "Ihr Team";

  return [
    `${greeting},`,
    "",
    `vor einiger Zeit haben wir Ihnen unser Angebot ${input.offer.nr} zukommen lassen. Da wir bisher noch ` +
      "keine Rückmeldung von Ihnen erhalten haben, wollten wir kurz nachfragen, ob noch Fragen offen sind " +
      "oder ob wir Ihnen bei der Entscheidung weiterhelfen können.",
    "",
    "Gerne besprechen wir Details, passen das Angebot bei Bedarf an oder klären technische Rückfragen in " +
      "einem kurzen Telefonat.",
    "",
    phoneLine,
    "",
    "Wir freuen uns, von Ihnen zu hören.",
    "",
    "Mit freundlichen Grüßen",
    signOff,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Tracking: Marker-Texte, die als HERO-Logbuch-Eintrag (histories) geschrieben werden.
// ---------------------------------------------------------------------------

export const SENT_MARKER_SUBSTRING = "Nachfass-Mail verschickt";
export const SKIP_MARKER_SUBSTRING = "Nachfassen übersprungen";
export const PROPOSED_MARKER_SUBSTRING = "Nachfassen zur Freigabe vorgeschlagen";

export function buildSentMarker(sentAtIso: string): string {
  return `🔔 ${SENT_MARKER_SUBSTRING} am ${formatDate(sentAtIso)} (nach Freigabe)`;
}

export function buildSkipMarker(sentAtIso: string): string {
  return `🚫 ${SKIP_MARKER_SUBSTRING} am ${formatDate(sentAtIso)} (manuell entschieden)`;
}

export function buildProposedMarker(sentAtIso: string): string {
  return `✉️ ${PROPOSED_MARKER_SUBSTRING} am ${formatDate(sentAtIso)}`;
}

// Bereits erledigt (verschickt oder bewusst übersprungen) – wird nicht erneut vorgeschlagen.
export function alreadyHandled(match: HeroProjectMatch): boolean {
  return match.histories.some((h) => {
    const text = h.custom_text ?? "";
    return text.includes(SENT_MARKER_SUBSTRING) || text.includes(SKIP_MARKER_SUBSTRING);
  });
}

// Bereits in einer früheren Übersichts-Mail zur Freigabe vorgeschlagen (verhindert, dass
// dieselbe Anfrage jeden Tag erneut in der Übersichts-Mail auftaucht).
export function alreadyProposed(match: HeroProjectMatch): boolean {
  return match.histories.some((h) => (h.custom_text ?? "").includes(PROPOSED_MARKER_SUBSTRING));
}

// ---------------------------------------------------------------------------
// Übersichts-/Freigabe-Mail an den Reviewer (z.B. Robert)
// ---------------------------------------------------------------------------

export interface ReviewCandidate {
  matchId: string;
  toName: string | null;
  toEmail: string;
  projectNr: string;
  offer: HeroDocument;
  sendLink: string;
  skipLink: string;
}

export function buildReviewSubject(count: number): string {
  return `${count} Angebot(e) bereit zum Nachfassen – bitte prüfen`;
}

export function buildReviewBody(candidates: ReviewCandidate[]): string {
  const intro = [
    `Es sind ${candidates.length} Angebot(e) seit mindestens ${process.env.HERO_FOLLOWUP_DAYS ?? 7} Tagen ohne Rückmeldung.`,
    "Bitte für jedes Angebot entscheiden, ob nachgefasst werden soll (z.B. wenn es zwischenzeitlich schon",
    "persönlichen Kontakt gab, lieber überspringen).",
    "",
  ];

  const blocks = candidates.map((c) => {
    const name = c.toName ?? c.toEmail;
    const value = c.offer.value !== null ? formatCurrency(c.offer.value) : "";
    return [
      `— Angebot ${c.offer.nr} (Projekt ${c.projectNr})`,
      `  Kunde: ${name} <${c.toEmail}>`,
      `  Versendet am: ${formatDate(c.offer.created)}${value ? `, Wert: ${value}` : ""}`,
      `  ✅ Ja, jetzt nachfassen:  ${c.sendLink}`,
      `  🚫 Nein, überspringen:   ${c.skipLink}`,
      "",
    ].join("\n");
  });

  return [...intro, ...blocks].join("\n");
}
