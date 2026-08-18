import { createHmac, timingSafeEqual } from "node:crypto";

// Signierte Freigabe-Links, damit im "Ja/Nein"-Klick keine echte Authentifizierung
// nötig ist, die Links aber trotzdem nicht erratbar/fälschbar sind.

export type ApprovalAction = "send" | "skip";

function getSecret(): string {
  const secret = process.env.APPROVAL_SECRET;
  if (!secret) {
    throw new Error("APPROVAL_SECRET ist nicht gesetzt (siehe .env.example).");
  }
  return secret;
}

function payloadFor(matchId: string, offerNr: string, action: ApprovalAction): string {
  return `${matchId}:${offerNr}:${action}`;
}

function sign(payload: string): string {
  return createHmac("sha256", getSecret()).update(payload).digest("hex");
}

export function verifySignature(
  matchId: string,
  offerNr: string,
  action: ApprovalAction,
  signature: string
): boolean {
  const expected = sign(payloadFor(matchId, offerNr, action));
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(signature, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function getBaseUrl(): string {
  // URL wird von Netlify automatisch als Env-Var bereitgestellt (primäre Site-URL).
  const url = process.env.URL || process.env.SITE_URL;
  if (!url) {
    throw new Error("Konnte die Site-URL nicht ermitteln (URL/SITE_URL Env-Var fehlt).");
  }
  return url.replace(/\/$/, "");
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
  const expected = sign(DASHBOARD_PAYLOAD);
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(key, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
