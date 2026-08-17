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

export interface HeroMeasure {
  id: string;
  short: string | null;
  name: string | null;
}

export interface HeroProjectMatch {
  id: string;
  project_nr: string;
  customer: HeroPerson | null;
  contact: HeroPerson | null;
  measure: HeroMeasure | null;
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
  query OpenOfferProjectMatches($statuses: [Int], $measure_ids: [Int]) {
    project_matches(statuses: $statuses, measure_ids: $measure_ids) {
      id
      project_nr
      measure {
        id
        short
        name
      }
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

export interface ProjectMatchFilter {
  statuses?: number[];
  measureIds?: number[];
}

/**
 * Holt project_matches samt Kategorie (measure), Status, Angebots-Dokumenten und
 * Logbuch/Notizen (histories). Per Introspection bestätigt: `statuses: [Int]` und
 * `measure_ids: [Int]` filtern serverseitig, damit nicht der ganze Account-Bestand
 * geladen werden muss (HERO hat mehrere Kategorien wie Projekte/Reparaturen/Montagen/Wartung,
 * "measure" bildet das ab).
 */
export async function fetchProjectMatches(filter?: ProjectMatchFilter): Promise<HeroProjectMatch[]> {
  const data = await heroGraphQL<{ project_matches: HeroProjectMatch[] }>(PROJECT_MATCHES_QUERY, {
    statuses: filter?.statuses && filter.statuses.length > 0 ? filter.statuses : null,
    measure_ids: filter?.measureIds && filter.measureIds.length > 0 ? filter.measureIds : null,
  });
  return data.project_matches ?? [];
}

// ---------------------------------------------------------------------------
// Logbuch-Eintrag schreiben (Tracking "schon nachgefasst")
// ---------------------------------------------------------------------------
//
// Per Introspection bestätigt (siehe README): add_logbook_entry nimmt ein einzelnes
// LogbookEntryInput-Objekt. Relevante Felder: target (Enum, "project_match" für unseren
// Fall), target_id (Int, die project_match-ID), custom_text (String!). Ein separates
// Titel-Feld gibt es nicht – weitere optionale Felder (type_code, target_users,
// role_visibility) werden nicht benötigt.

const ADD_LOGBOOK_ENTRY_MUTATION = /* GraphQL */ `
  mutation AddLogbookEntry($targetId: Int!, $text: String!) {
    add_logbook_entry(logbook_entry: { target: project_match, target_id: $targetId, custom_text: $text }) {
      id
    }
  }
`;

export async function addLogbookEntry(projectMatchId: string, text: string): Promise<void> {
  await heroGraphQL(ADD_LOGBOOK_ENTRY_MUTATION, {
    targetId: Number(projectMatchId),
    text,
  });
}

/** Sanity-Check im Discovery-Modus: schreibt einen klar markierten Testeintrag. */
export async function testAddLogbookEntry(
  projectMatchId: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await addLogbookEntry(
      projectMatchId,
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

// HERO nennt seine Root-Typen nicht "Mutation"/"Query" (sondern z.B. "PartnerMutation"),
// deshalb über __schema.mutationType/__schema.queryType gehen statt über __type(name: ...)
// mit geratenem Namen – so funktioniert es unabhängig vom tatsächlichen Typnamen.
const INTROSPECTION_QUERY = /* GraphQL */ `
  query IntrospectMutationAndQuery {
    __schema {
      mutationType {
        name
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
      queryType {
        name
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
  __schema: {
    mutationType: { name: string; fields: IntrospectionField[] } | null;
    queryType: { name: string; fields: IntrospectionField[] } | null;
  };
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
  mutationTypeName: string | null;
  queryTypeName: string | null;
  addLogbookEntry: FieldSignature | null;
  projectMatches: FieldSignature | null;
  allMutationNames: string[];
  allQueryNames: string[];
}> {
  const data = await heroGraphQL<IntrospectionResult>(INTROSPECTION_QUERY);

  const mutationFields = data.__schema.mutationType?.fields ?? [];
  const queryFields = data.__schema.queryType?.fields ?? [];

  const toSignature = (f: IntrospectionField): FieldSignature => ({
    name: f.name,
    args: f.args.map((a) => `${a.name}: ${stringifyType(a.type)}`),
  });

  return {
    mutationTypeName: data.__schema.mutationType?.name ?? null,
    queryTypeName: data.__schema.queryType?.name ?? null,
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
