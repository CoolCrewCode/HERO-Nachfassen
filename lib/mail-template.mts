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

// Mail wurde bereits an den Kunden verschickt – endgültig, kann nicht rückgängig gemacht werden.
export function alreadySent(match: HeroProjectMatch): boolean {
  return match.histories.some((h) => (h.custom_text ?? "").includes(SENT_MARKER_SUBSTRING));
}

// Bewusst übersprungen – das ist eine Zwischenentscheidung, keine endgültige: Wer sich umentscheidet,
// kann trotzdem noch auf "Ja" klicken (siehe hero-offer-review-action.mts).
export function alreadySkipped(match: HeroProjectMatch): boolean {
  return match.histories.some((h) => (h.custom_text ?? "").includes(SKIP_MARKER_SUBSTRING));
}

// Bereits in einer früheren Benachrichtigung als "neu" gemeldet (verhindert, dass dieselbe Anfrage
// jeden Tag erneut als "X neue Angebote" gemeldet wird, solange noch keine Entscheidung fiel). Die
// Übersichtsseite selbst filtert NICHT danach – dort bleibt alles sichtbar, was noch nicht final ist.
export function alreadyProposed(match: HeroProjectMatch): boolean {
  return match.histories.some((h) => (h.custom_text ?? "").includes(PROPOSED_MARKER_SUBSTRING));
}

// ---------------------------------------------------------------------------
// Kurze Benachrichtigungs-Mail an den Reviewer (z.B. Robert) – verlinkt auf die Übersichtsseite,
// statt alle Kandidaten einzeln in der Mail aufzulisten (bei vielen Angeboten sonst unübersichtlich
// und man verliert den Überblick, was schon entschieden wurde).
// ---------------------------------------------------------------------------

export function buildNotificationSubject(newCount: number, totalCount: number): string {
  if (newCount > 0) return `${newCount} neue Angebot(e) bereit zum Nachfassen (${totalCount} insgesamt offen)`;
  return `Erinnerung: ${totalCount} Angebot(e) warten noch auf deine Entscheidung`;
}

export function buildNotificationBody(newCount: number, totalCount: number, dashboardLink: string): string {
  const intro =
    newCount > 0
      ? `${newCount} weitere Angebot(e) sind seit mindestens ${process.env.HERO_FOLLOWUP_DAYS ?? 7} Tagen ` +
        `ohne Rückmeldung dazugekommen. Insgesamt warten aktuell ${totalCount} Angebot(e) auf deine Entscheidung.`
      : `Es sind aktuell ${totalCount} Angebot(e) offen, die noch auf deine Entscheidung warten.`;

  return [
    intro,
    "",
    "Alle noch offenen Angebote findest du hier – bereits entschiedene verschwinden automatisch " +
      "aus der Liste:",
    "",
    dashboardLink,
  ].join("\n");
}
