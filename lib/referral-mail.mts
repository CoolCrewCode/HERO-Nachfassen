function premiumEuro(): string {
  return process.env.REFERRAL_PREMIUM_EUR?.trim() || "50";
}

export function buildReferralMailSubject(): string {
  return "Danke für Ihr Vertrauen – jetzt Prämie sichern";
}

export function buildReferralMailBody(customerName: string | null, code: string, landingUrl: string): string {
  const greeting = customerName ? `Guten Tag ${customerName}` : "Guten Tag";
  const companyName = process.env.COMPANY_NAME?.trim() || "uns";
  const signOff = process.env.MAIL_SIGNATURE?.trim().replaceAll("\\n", "\n") || companyName;

  return [
    `${greeting},`,
    "",
    `vielen Dank, dass Sie sich für ${companyName} entschieden haben.`,
    "",
    `Kennen Sie jemanden, der auch von unserem Service profitieren könnte? Empfehlen Sie uns weiter ` +
      `und Sie erhalten ${premiumEuro()}€ Prämie für jede erfolgreiche Empfehlung – Sie entscheiden ` +
      `dann, ob als Auszahlung oder als Rabatt auf Ihre nächste Wartung.`,
    "",
    `Ihr persönlicher Empfehlungscode: ${code}`,
    "",
    "Die von Ihnen empfohlene Person kann direkt hier Kontakt zu uns aufnehmen (der Code ist schon eingetragen):",
    landingUrl,
    "",
    "Vielen Dank und viele Grüße",
    signOff,
  ].join("\n");
}
