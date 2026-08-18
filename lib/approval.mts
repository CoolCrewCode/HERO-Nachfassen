import { createHmac, timingSafeEqual } from "node:crypto";

// Signierte Freigabe-/Aktions-Links, damit im Klick keine echte Authentifizierung nötig ist,
// die Links aber trotzdem nicht erratbar/fälschbar sind.

export type ApprovalAction = "send" | "skip";

function getSecret(): string {
  const secret = process.env.APPROVAL_SECRET;
  if (!secret) {
    throw new Error("APPROVAL_SECRET ist nicht gesetzt (siehe .env.example).");
  }
  return secret;
}

function sign(payload: string): string {
  return createHmac("sha256", getSecret()).update(payload).digest("hex");
}

function safeCompare(expectedHex: string, actualHex: string): boolean {
  const a = Buffer.from(expectedHex, "hex");
  const b = Buffer.from(actualHex, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function getBaseUrl(): string {
  // URL wird von Netlify automatisch als Env-Var bereitgestellt (primäre Site-URL).
  const url = process.env.URL || process.env.SITE_URL;
  if (!url) {
    throw new Error("Konnte die Site-URL nicht ermitteln (URL/SITE_URL Env-Var fehlt).");
  }
  return url.replace(/\/$/, "");
}

// ---------------------------------------------------------------------------
// Angebots-Nachfassen (Ja/Nein pro Angebot + Übersichtsseite)
// ---------------------------------------------------------------------------

function payloadFor(matchId: string, offerNr: string, action: ApprovalAction): string {
  return `${matchId}:${offerNr}:${action}`;
}

export function verifySignature(
  matchId: string,
  offerNr: string,
  action: ApprovalAction,
  signature: string
): boolean {
  return safeCompare(sign(payloadFor(matchId, offerNr, action)), signature);
}

export function buildApprovalLink(matchId: string, offerNr: string, action: ApprovalAction): string {
  const signature = sign(payloadFor(matchId, offerNr, action));
  const params = new URLSearchParams({ action, matchId, offerNr, sig: signature });
  return `${getBaseUrl()}/.netlify/functions/hero-offer-review-action?${params.toString()}`;
}

const DASHBOARD_PAYLOAD = "dashboard";

/** Ein fester, merkbarer Link zur Übersichtsseite (nicht an ein einzelnes Angebot gebunden). */
export function buildDashboardLink(): string {
  const params = new URLSearchParams({ key: sign(DASHBOARD_PAYLOAD) });
  return `${getBaseUrl()}/.netlify/functions/hero-offer-review-dashboard?${params.toString()}`;
}

export function verifyDashboardKey(key: string): boolean {
  return safeCompare(sign(DASHBOARD_PAYLOAD), key);
}

// ---------------------------------------------------------------------------
// Empfehlungsprogramm (Übersichtsseite + Status-Änderungen)
// ---------------------------------------------------------------------------

const REFERRAL_DASHBOARD_PAYLOAD = "referral-dashboard";

export function buildReferralDashboardLink(): string {
  const params = new URLSearchParams({ key: sign(REFERRAL_DASHBOARD_PAYLOAD) });
  return `${getBaseUrl()}/.netlify/functions/hero-referral-dashboard?${params.toString()}`;
}

export function verifyReferralDashboardKey(key: string): boolean {
  return safeCompare(sign(REFERRAL_DASHBOARD_PAYLOAD), key);
}

function referralActionPayload(id: string, field: string, value: string): string {
  return `referral:${id}:${field}:${value}`;
}

/** Link, der auf der Übersichtsseite direkt Status/Prämienstatus/Prämienwahl einer Empfehlung ändert. */
export function buildReferralActionLink(
  id: string,
  field: "status" | "premiumStatus" | "rewardType",
  value: string
): string {
  const params = new URLSearchParams({
    id,
    field,
    value,
    sig: sign(referralActionPayload(id, field, value)),
  });
  return `${getBaseUrl()}/.netlify/functions/hero-referral-dashboard?${params.toString()}`;
}

export function verifyReferralActionSignature(id: string, field: string, value: string, signature: string): boolean {
  return safeCompare(sign(referralActionPayload(id, field, value)), signature);
}
