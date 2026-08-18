// Speicherung der Empfehlungs-Einreichungen in Netlify Blobs – bewusst ohne HERO-Anbindung
// (wir kennen die HERO-Mutation zum automatischen Lead-Anlegen noch nicht sicher genug, um sie
// ungeprüft gegen echte Kundendaten laufen zu lassen). Robert legt den Lead vorerst wie gewohnt
// selbst in HERO an, nachdem er per Mail benachrichtigt wurde.

import { getStore } from "@netlify/blobs";

const STORE_NAME = "hero-referrals";
const SENT_PREFIX = "sent:";
const SUBMISSION_PREFIX = "submission:";

export type ReferralStatus = "eingegangen" | "lead_angelegt" | "auftrag" | "abgelehnt";
export type PremiumStatus = "offen" | "faellig" | "ausgezahlt" | "entfaellt";

export interface ReferralSubmission {
  id: string;
  createdAt: string;
  referrerCode: string;
  referrerCustomerNr: string | null;
  newContactName: string;
  newContactEmail: string;
  newContactPhone: string;
  message: string;
  status: ReferralStatus;
  premiumStatus: PremiumStatus;
}

function store() {
  return getStore(STORE_NAME);
}

/** Verhindert, dass derselbe Kunde bei mehreren Aufträgen wiederholt den Code zugeschickt bekommt. */
export async function markReferralCodeSent(customerNr: string): Promise<void> {
  await store().set(`${SENT_PREFIX}${customerNr}`, new Date().toISOString());
}

export async function wasReferralCodeSent(customerNr: string): Promise<boolean> {
  const value = await store().get(`${SENT_PREFIX}${customerNr}`);
  return value !== null;
}

export async function saveSubmission(submission: ReferralSubmission): Promise<void> {
  await store().setJSON(`${SUBMISSION_PREFIX}${submission.id}`, submission);
}

export async function getSubmission(id: string): Promise<ReferralSubmission | null> {
  const value = await store().get(`${SUBMISSION_PREFIX}${id}`, { type: "json" });
  return (value as ReferralSubmission | null) ?? null;
}

export async function updateSubmission(
  id: string,
  patch: Partial<Pick<ReferralSubmission, "status" | "premiumStatus">>
): Promise<ReferralSubmission | null> {
  const existing = await getSubmission(id);
  if (!existing) return null;
  const updated: ReferralSubmission = { ...existing, ...patch };
  await store().setJSON(`${SUBMISSION_PREFIX}${id}`, updated);
  return updated;
}

export async function listSubmissions(): Promise<ReferralSubmission[]> {
  const { blobs } = await store().list({ prefix: SUBMISSION_PREFIX });
  const results: ReferralSubmission[] = [];
  for (const entry of blobs) {
    const value = await store().get(entry.key, { type: "json" });
    if (value) results.push(value as ReferralSubmission);
  }
  results.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return results;
}
