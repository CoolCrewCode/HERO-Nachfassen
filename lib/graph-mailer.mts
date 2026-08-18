// Mailversand über Microsoft Graph (App-Registrierung, Client-Credentials-Flow).
// Voraussetzung: App-Registrierung in Entra ID mit Application Permission "Mail.Send"
// (Admin-Zustimmung erteilt) und Sende-Recht für das Postfach MAIL_FROM.

interface CachedToken {
  accessToken: string;
  expiresAt: number; // epoch ms
}

let cachedToken: CachedToken | null = null;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} ist nicht gesetzt (siehe .env.example).`);
  }
  return value;
}

async function getAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 30_000) {
    return cachedToken.accessToken;
  }

  const tenantId = requireEnv("MS_TENANT_ID");
  const clientId = requireEnv("MS_CLIENT_ID");
  const clientSecret = requireEnv("MS_CLIENT_SECRET");

  const res = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
      scope: "https://graph.microsoft.com/.default",
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Microsoft-Token-Anfrage fehlgeschlagen (HTTP ${res.status}): ${body}`);
  }

  const json = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = {
    accessToken: json.access_token,
    expiresAt: Date.now() + json.expires_in * 1000,
  };
  return cachedToken.accessToken;
}

export interface GraphMailInput {
  toEmail: string;
  toName: string | null;
  subject: string;
  body: string;
  /** "Text" (Standard) oder "HTML", z.B. um einen Link hinter einem Linktext zu verstecken. */
  bodyType?: "Text" | "HTML";
}

export async function sendGraphMail(input: GraphMailInput): Promise<void> {
  const mailFrom = requireEnv("MAIL_FROM");
  const accessToken = await getAccessToken();

  const res = await fetch(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailFrom)}/sendMail`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: {
          subject: input.subject,
          body: { contentType: input.bodyType ?? "Text", content: input.body },
          toRecipients: [
            {
              emailAddress: { address: input.toEmail, name: input.toName ?? undefined },
            },
          ],
        },
        saveToSentItems: true,
      }),
    }
  );

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Microsoft Graph sendMail fehlgeschlagen (HTTP ${res.status}): ${body}`);
  }
}
