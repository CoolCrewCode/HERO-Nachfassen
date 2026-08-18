// Empfehlungscode: KK-<HERO-Kundennummer>. Keine eigene Erzeugung/Speicherung nötig, wird bei
// Bedarf direkt aus der Kundennummer abgeleitet.

const CODE_PREFIX = "KK-";

export function buildReferralCode(customerNr: string): string {
  return `${CODE_PREFIX}${customerNr}`;
}

/** Liefert die Kundennummer aus einem Code wie "KK-1042", oder null falls das Format nicht passt. */
export function parseReferralCode(code: string): string | null {
  const trimmed = code.trim();
  if (!trimmed.toUpperCase().startsWith(CODE_PREFIX)) return null;
  const nr = trimmed.slice(CODE_PREFIX.length).trim();
  return nr.length > 0 ? nr : null;
}
