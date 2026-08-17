// Schlanker Client für die HERO GraphQL-API.
// Doku: https://hero-software.de/api-doku/graphql-guide
// API-Key gibt's beim HERO-Support (steht nicht öffentlich in der Doku, s. README).

const DEFAULT_ENDPOINT = "https://login.hero-software.de/api/external/v7/graphql";

export interface HeroDocument {
  type: string;
  nr: string;
  value: number | null;
  created: string;
}

export interface HeroHistoryEntry {
  custom_title: string | null;
  custom_text: string | null;
  created: string;
}

export interface HeroPerson {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
}

export interface HeroProjectMatch {
  id: string;
  project_nr: string;
  customer: HeroPerson | null;
  contact: HeroPerson | null;
  current_project_match_status: {
    status_code: string;
    name: string;
  } | null;
  customer_documents: HeroDocument[];
  histories: HeroHistoryEntry[];
}

export class HeroApiError extends Error {
  constructor(message: string, public readonly details?: unknown) {
    super(message);
    this.name = "HeroApiError";
  }
}

function getEndpoint(): string {
  return process.env.HERO_GRAPHQL_ENDPOINT?.trim() || DEFAULT_ENDPOINT;
}

function getToken(): string {
  const token = process.env.HERO_API_TOKEN;
  if (!token) {
    throw new HeroApiError(
      "HERO_API_TOKEN ist nicht gesetzt. API-Key beim HERO-Support anfragen und als Env-Var hinterlegen."
    );
  }
  return token;
}

async function heroGraphQL<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const res = await fetch(getEndpoint(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getToken()}`,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new HeroApiError(`HERO API antwortete mit HTTP ${res.status}`, body);
  }

  const json = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };

  if (json.errors?.length) {
    throw new HeroApiError(
      `HERO GraphQL-Fehler: ${json.errors.map((e) => e.message).join("; ")}`,
      json.errors
    );
  }

  if (!json.data) {
    throw new HeroApiError("HERO API lieferte keine Daten zurück.");
  }

  return json.data;
}

const PROJECT_MATCHES_QUERY = /* GraphQL */ `
  query OpenOfferProjectMatches {
    project_matches {
      id
      project_nr
      customer {
        id
        first_name
        last_name
        email
      }
      contact {
        id
        first_name
        last_name
        email
      }
      current_project_match_status {
        status_code
        name
      }
      customer_documents {
        type
        nr
        value
        created
      }
      histories {
        custom_title
        custom_text
        created
      }
    }
  }
`;

/**
 * Holt alle project_matches samt Status, Angebots-Dokumenten und Logbuch/Notizen (histories).
 *
 * ACHTUNG: Die HERO-GraphQL-Doku dokumentiert öffentlich keine Filter-/Pagination-Argumente
 * für project_matches. Bei sehr vielen Projekten in eurem HERO-Account lohnt es sich, per
 * Introspection (siehe `introspectSchema`) zu prüfen, ob es z.B. Filterargumente gibt, um
 * die Query serverseitig einzuschränken statt client-seitig zu filtern.
 */
export async function fetchProjectMatches(): Promise<HeroProjectMatch[]> {
  const data = await heroGraphQL<{ project_matches: HeroProjectMatch[] }>(PROJECT_MATCHES_QUERY);
  return data.project_matches ?? [];
}

// ---------------------------------------------------------------------------
// Logbuch-Eintrag schreiben (Tracking "schon nachgefasst")
// ---------------------------------------------------------------------------
//
// ANNAHME: Mutationsname und Argumentnamen sind aus der öffentlichen Doku nicht ersichtlich
// (nur der Name `add_logbook_entry` ist als "häufig genutzte Mutation" gelistet). Diese
// Signatur ist eine plausible Annahme basierend auf den lesbaren `histories`-Feldern
// (custom_title, custom_text). VOR PRODUKTIVEINSATZ per `HERO_DISCOVERY=true` (Introspection)
// prüfen und ggf. Argumentnamen unten anpassen.

const ADD_LOGBOOK_ENTRY_MUTATION = /* GraphQL */ `
  mutation AddLogbookEntry($projectMatchId: ID!, $title: String!, $text: String!) {
    add_logbook_entry(project_match_id: $projectMatchId, custom_title: $title, custom_text: $text) {
      id
    }
  }
`;

export async function addLogbookEntry(
  projectMatchId: string,
  title: string,
  text: string
): Promise<void> {
  await heroGraphQL(ADD_LOGBOOK_ENTRY_MUTATION, {
    projectMatchId,
    title,
    text,
  });
}

/**
 * Testet die ADD_LOGBOOK_ENTRY_MUTATION-Annahme gegen die echte API, ohne dass ein Fehler
 * geworfen wird. Wird vom Discovery-Modus genutzt, weil HERO Introspection deaktiviert hat
 * und die Argumentnamen sich nicht anders vorab prüfen lassen.
 */
export async function testAddLogbookEntry(
  projectMatchId: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await addLogbookEntry(
      projectMatchId,
      "Test (HERO-Nachfass-Automatisierung)",
      "🧪 Testeintrag der Nachfass-Automatisierung – kann ignoriert/gelöscht werden."
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// Introspection – hilft, echte Schema-Details (Mutation-Args, Query-Filter) zu ermitteln,
// ohne dass wir sie raten müssen. Wird vom Discovery-Modus der Function genutzt.
// ---------------------------------------------------------------------------

const INTROSPECTION_QUERY = /* GraphQL */ `
  query IntrospectMutationAndQuery {
    mutationType: __type(name: "Mutation") {
      fields {
        name
        args {
          name
          type {
            ...TypeRef
          }
        }
      }
    }
    queryType: __type(name: "Query") {
      fields {
        name
        args {
          name
          type {
            ...TypeRef
          }
        }
      }
    }
  }

  fragment TypeRef on __Type {
    kind
    name
    ofType {
      kind
      name
      ofType {
        kind
        name
        ofType {
          kind
          name
          ofType {
            kind
            name
          }
        }
      }
    }
  }
`;

interface IntrospectionTypeRef {
  kind: string;
  name: string | null;
  ofType: IntrospectionTypeRef | null;
}

interface IntrospectionField {
  name: string;
  args: Array<{ name: string; type: IntrospectionTypeRef }>;
}

interface IntrospectionResult {
  mutationType: { fields: IntrospectionField[] } | null;
  queryType: { fields: IntrospectionField[] } | null;
}

function stringifyType(type: IntrospectionTypeRef): string {
  if (type.kind === "NON_NULL") return `${stringifyType(type.ofType!)}!`;
  if (type.kind === "LIST") return `[${stringifyType(type.ofType!)}]`;
  return type.name ?? "?";
}

export interface FieldSignature {
  name: string;
  args: string[];
}

/**
 * Fragt per GraphQL-Introspection die echten Argumentnamen für `add_logbook_entry`
 * (Mutation) und `project_matches` (Query) ab. Gibt außerdem alle verfügbaren
 * Mutation-/Query-Feldnamen zurück, falls die Namen doch anders lauten.
 */
export async function introspectSchema(): Promise<{
  addLogbookEntry: FieldSignature | null;
  projectMatches: FieldSignature | null;
  allMutationNames: string[];
  allQueryNames: string[];
}> {
  const data = await heroGraphQL<IntrospectionResult>(INTROSPECTION_QUERY);

  const mutationFields = data.mutationType?.fields ?? [];
  const queryFields = data.queryType?.fields ?? [];

  const toSignature = (f: IntrospectionField): FieldSignature => ({
    name: f.name,
    args: f.args.map((a) => `${a.name}: ${stringifyType(a.type)}`),
  });

  return {
    addLogbookEntry: mutationFields.find((f) => f.name === "add_logbook_entry")
      ? toSignature(mutationFields.find((f) => f.name === "add_logbook_entry")!)
      : null,
    projectMatches: queryFields.find((f) => f.name === "project_matches")
      ? toSignature(queryFields.find((f) => f.name === "project_matches")!)
      : null,
    allMutationNames: mutationFields.map((f) => f.name).sort(),
    allQueryNames: queryFields.map((f) => f.name).sort(),
  };
}
