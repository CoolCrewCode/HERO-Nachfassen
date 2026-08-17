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

export function buildLogbookMarker(sentAtIso: string): string {
  return `🔔 Nachfass-Mail automatisch verschickt am ${formatDate(sentAtIso)}`;
}

export const LOGBOOK_MARKER_SUBSTRING = "Nachfass-Mail automatisch verschickt";

export function alreadyFollowedUp(match: HeroProjectMatch): boolean {
  return match.histories.some((h) => (h.custom_text ?? "").includes(LOGBOOK_MARKER_SUBSTRING));
}
