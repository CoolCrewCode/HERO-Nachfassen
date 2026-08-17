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
  query OpenOfferProjectMatches($statuses: [Int]) {
    project_matches(statuses: $statuses) {
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
 * Holt project_matches samt Status, Angebots-Dokumenten und Logbuch/Notizen (histories).
 * Per Introspection bestätigt: `statuses: [Int]` filtert serverseitig nach status_code,
 * damit nicht der ganze Account-Bestand geladen werden muss.
 */
export async function fetchProjectMatches(statuses?: number[]): Promise<HeroProjectMatch[]> {
  const data = await heroGraphQL<{ project_matches: HeroProjectMatch[] }>(PROJECT_MATCHES_QUERY, {
    statuses: statuses && statuses.length > 0 ? statuses : null,
  });
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

// ---------------------------------------------------------------------------
// Baut den add_logbook_entry-Aufruf automatisch aus der per Introspection ermittelten
// echten Signatur (statt geratener Argumentnamen) und testet ihn direkt.
// ---------------------------------------------------------------------------

export interface DynamicLogbookTestResult {
  ok: boolean;
  usedArgs: Record<string, string>;
  unmappedRequiredArgs: string[];
  allInputFields?: string[];
  error?: string;
}

/**
 * Fragt die Felder eines benannten Input-Objekt-Typs ab (z.B. "LogbookEntryInput"),
 * damit wir Mutationen, die ein einzelnes Input-Objekt statt Einzelargumente nehmen,
 * trotzdem automatisch zusammenbauen können.
 */
async function introspectInputType(typeName: string): Promise<FieldSignature | null> {
  const query = /* GraphQL */ `
    query IntrospectInputType($name: String!) {
      __type(name: $name) {
        name
        inputFields {
          name
          type {
            ...TypeRef
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
          }
        }
      }
    }
  `;

  const data = await heroGraphQL<{
    __type: { name: string; inputFields: Array<{ name: string; type: IntrospectionTypeRef }> } | null;
  }>(query, { name: typeName });

  if (!data.__type) return null;

  return {
    name: data.__type.name,
    args: data.__type.inputFields.map((f) => `${f.name}: ${stringifyType(f.type)}`),
  };
}

function mapFieldsToTestValues(
  fields: Array<{ name: string; type: string }>,
  projectMatchId: string
): { values: Record<string, unknown>; usedArgs: Record<string, string>; unmapped: string[] } {
  const values: Record<string, unknown> = {};
  const usedArgs: Record<string, string> = {};
  const unmapped: string[] = [];

  for (const { name, type } of fields) {
    const lower = name.toLowerCase();
    if (lower.includes("id")) {
      values[name] = /Int/.test(type) ? Number(projectMatchId) : projectMatchId;
      usedArgs[name] = `→ project_match_id (${type})`;
    } else if (lower.includes("title")) {
      values[name] = "Test (HERO-Nachfass-Automatisierung)";
      usedArgs[name] = "→ Test-Titel";
    } else if (/text|note|comment|body|content|description|message/.test(lower)) {
      values[name] = "🧪 Testeintrag der Nachfass-Automatisierung – kann ignoriert/gelöscht werden.";
      usedArgs[name] = "→ Test-Text";
    } else if (lower === "target" || lower.endsWith("_type") || lower === "type") {
      // HERO-Fehlermeldung deutete auf ein Feld "target" hin, das die Ziel-Entität benennt
      // (z.B. "project_match"). Reiner Rateversuch – falls falsch, verrät die Fehlermeldung
      // meist die erlaubten Enum-Werte.
      values[name] = "project_match";
      usedArgs[name] = "→ Rateversuch: 'project_match'";
    } else if (type.replace("!", "") === "String") {
      values[name] = "Test (HERO-Nachfass-Automatisierung)";
      usedArgs[name] = "→ Test-Text (Fallback, unbekanntes Feld)";
    } else if (type.endsWith("!")) {
      unmapped.push(`${name}: ${type}`);
    }
  }

  return { values, usedArgs, unmapped };
}

export async function testAddLogbookEntryDynamic(
  projectMatchId: string,
  signature: FieldSignature
): Promise<DynamicLogbookTestResult> {
  const parsed = signature.args.map((a) => {
    const [name, ...rest] = a.split(":");
    return { name: name.trim(), type: rest.join(":").trim() };
  });

  // Fall A: genau ein Argument, dessen Typ auf einen Input-Objekt-Typnamen hindeutet
  // (HERO nennt diese z.B. "LogbookEntryInput") -> dessen Felder introspizieren und
  // als verschachteltes Objekt befüllen.
  if (parsed.length === 1 && /Input!?$/.test(parsed[0].type)) {
    const baseTypeName = parsed[0].type.replace(/!$/, "");
    const inputType = await introspectInputType(baseTypeName);
    if (!inputType) {
      return {
        ok: false,
        usedArgs: {},
        unmappedRequiredArgs: [],
        error: `Konnte Input-Typ '${baseTypeName}' nicht introspizieren.`,
      };
    }

    const innerFields = inputType.args.map((a) => {
      const [name, ...rest] = a.split(":");
      return { name: name.trim(), type: rest.join(":").trim() };
    });
    const { values, usedArgs, unmapped } = mapFieldsToTestValues(innerFields, projectMatchId);

    if (unmapped.length > 0) {
      return {
        ok: false,
        usedArgs,
        unmappedRequiredArgs: unmapped,
        allInputFields: inputType.args,
        error: `Konnte nicht alle Pflichtfelder in '${baseTypeName}' automatisch befüllen.`,
      };
    }

    const argName = parsed[0].name;
    const mutation = `mutation TestAddLogbookEntryDynamic($input: ${baseTypeName}!) { add_logbook_entry(${argName}: $input) { id } }`;

    try {
      await heroGraphQL(mutation, { input: values });
      return { ok: true, usedArgs, unmappedRequiredArgs: [], allInputFields: inputType.args };
    } catch (err) {
      return {
        ok: false,
        usedArgs,
        unmappedRequiredArgs: [],
        allInputFields: inputType.args,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // Fall B: mehrere skalare Einzelargumente -> direkt befüllen.
  const { values, usedArgs, unmapped } = mapFieldsToTestValues(parsed, projectMatchId);

  if (unmapped.length > 0) {
    return {
      ok: false,
      usedArgs,
      unmappedRequiredArgs: unmapped,
      error: "Konnte nicht alle Pflichtargumente automatisch befüllen (siehe unmappedRequiredArgs).",
    };
  }

  const varDefs = parsed.map(({ name, type }) => `$${name}: ${type}`).join(", ");
  const callArgs = parsed.map(({ name }) => `${name}: $${name}`).join(", ");
  const mutation = `mutation TestAddLogbookEntryDynamic(${varDefs}) { add_logbook_entry(${callArgs}) { id } }`;

  try {
    await heroGraphQL(mutation, values);
    return { ok: true, usedArgs, unmappedRequiredArgs: [] };
  } catch (err) {
    return {
      ok: false,
      usedArgs,
      unmappedRequiredArgs: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
