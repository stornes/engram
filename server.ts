#!/usr/bin/env bun
/**
 * Engram v2.0.0 — MCP Server
 *
 * Domain-partitioned knowledge system with ontology-driven classification.
 *
 * Domains: work, personal, life, learning
 * Each domain maps to a Supabase schema: ob_work, ob_personal, ob_life, ob_learning
 *
 * Tools: search_thoughts, list_thoughts, capture_thought, project_status, thought_stats,
 *         add_relationship, query_relationships, invalidate_relationship,
 *         discover_connections, wake_up
 *
 * Environment:
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY, OPENAI_API_KEY, VOYAGE_API_KEY
 *   OB_DEFAULT_DOMAIN — default domain scope (default: "work")
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { readFileSync } from "fs";
import { parse as parseYaml } from "yaml";

// --- Config ---
const SUPABASE_URL =
  process.env.SUPABASE_URL || "";
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_KEY ||
  "";
const OPENAI_KEY = process.env.OPENAI_API_KEY || "";
const VOYAGE_KEY = process.env.VOYAGE_API_KEY || "";
const DEFAULT_DOMAIN = process.env.OB_DEFAULT_DOMAIN || "work";

const VALID_DOMAINS = ["work", "personal", "life", "learning"] as const;
type Domain = (typeof VALID_DOMAINS)[number];

if (!SUPABASE_KEY) {
  process.stderr.write("SUPABASE_SERVICE_KEY required\n");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// --- Ontology ---
const VALID_HORIZONS = ["daily", "weekly", "monthly", "quarterly"] as const;
type Horizon = (typeof VALID_HORIZONS)[number];

function isValidHorizon(h: string): h is Horizon {
  return VALID_HORIZONS.includes(h as Horizon);
}

const HORIZON_WINDOWS: Record<Horizon, number> = {
  daily: 1,
  weekly: 7,
  monthly: 30,
  quarterly: 90,
};

type Ontology = {
  version: string;
  domains: Record<string, { schema: string; default_sensitivity: string }>;
  horizons?: Record<string, { description: string; window_days: number; entity_defaults: string[] }>;
  entity_types: Record<string, { domain_default: string; sensitivity: string; default_horizon?: string }>;
  inference_rules: Array<{
    name: string;
    condition: Record<string, unknown>;
    action: { domain: string; sensitivity: string; confidence_boost: number };
  }>;
  synapse_rules: Record<string, Array<{ domain: string; entity_types: string[]; sensitivity_max: string }>>;
  never_cross?: string[];
};

let ontology: Ontology;
try {
  const ontologyPath = new URL("./ontology/v1.1.0.yaml", import.meta.url).pathname;
  ontology = parseYaml(readFileSync(ontologyPath, "utf-8")) as Ontology;
  process.stderr.write(`[OB] Ontology v${ontology.version} loaded\n`);
} catch (e) {
  process.stderr.write(`[OB] Warning: could not load ontology, using defaults\n`);
  ontology = {
    version: "0.0.0",
    domains: {
      work: { schema: "ob_work", default_sensitivity: "internal" },
      personal: { schema: "ob_personal", default_sensitivity: "confidential" },
      life: { schema: "ob_life", default_sensitivity: "confidential" },
      learning: { schema: "ob_learning", default_sensitivity: "public" },
    },
    entity_types: {},
    inference_rules: [],
    synapse_rules: {},
  };
}

// --- Helpers ---
function schemaFor(domain: Domain): string {
  return `ob_${domain}`;
}

function isValidDomain(d: string): d is Domain {
  return VALID_DOMAINS.includes(d as Domain);
}

function getSynapseDomains(primaryDomain: Domain): Domain[] {
  const domains: Domain[] = [primaryDomain];
  const rules = ontology.synapse_rules?.[`${primaryDomain}_can_see`] || [];
  for (const rule of rules) {
    const d = rule.domain as Domain;
    if (isValidDomain(d) && !domains.includes(d)) {
      domains.push(d);
    }
  }
  return domains;
}

// --- Embedding (Voyage voyage-3, 1024d) ---
async function getEmbedding(text: string): Promise<number[]> {
  if (VOYAGE_KEY) {
    const res = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${VOYAGE_KEY}`,
      },
      body: JSON.stringify({ model: "voyage-3", input: text.slice(0, 16000) }),
    });
    const data = (await res.json()) as any;
    return data?.data?.[0]?.embedding || [];
  }
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "text-embedding-3-small",
      input: text.slice(0, 8000),
      dimensions: 1024,
    }),
  });
  const data = (await res.json()) as any;
  return data.data[0].embedding;
}

// --- Metadata + Domain Classification ---
async function classifyAndExtract(
  content: string
): Promise<{ metadata: Record<string, unknown>; suggestedDomain: Domain; confidence: number; reasoning: string }> {
  // Build inference context from ontology
  const entityTypeList = Object.entries(ontology.entity_types || {})
    .map(([name, def]) => `${name} (default domain: ${def.domain_default}, sensitivity: ${def.sensitivity}, default horizon: ${def.default_horizon || "daily"})`)
    .join("\n");

  const inferenceRuleList = (ontology.inference_rules || [])
    .map((r) => `${r.name}: ${JSON.stringify(r.condition)} => domain=${r.action.domain}`)
    .join("\n");

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `You are the Engram classifier. Extract metadata AND classify the domain.

ENTITY TYPES:
${entityTypeList}

INFERENCE RULES:
${inferenceRuleList}

Return JSON with:
- "type": one of the entity types listed above
- "topics": array of 1-3 topic tags (lowercase, specific)
- "people": array of people mentioned (first+last name if available)
- "action_items": array of implied tasks (empty if none)
- "dates_mentioned": array of dates YYYY-MM-DD (empty if none)
- "project_id": kebab-case slug if this thought relates to a specific project (e.g. "lighthouse", "north-star"). null if not project-related. For project artifact types (project_risk, project_decision, project_dependency, project_milestone, project_cost), this field is required.
- "domain": one of "work", "personal", "life", "learning"
- "sensitivity": one of "public", "internal", "confidential", "secret"
- "horizon": one of "daily", "weekly", "monthly", "quarterly" (time relevance: daily=ephemeral/today, weekly=this week's context, monthly=ongoing work, quarterly=long-term/strategic)
- "stakes": string or null (what is at risk if the topics in this content are not addressed? Only populate for meetings, decisions, and project content. One sentence max. null if not applicable)
- "conflict_points": array of strings (topics where disagreement, tension, unresolved debate, or competing priorities are visible. Empty if none. Be specific: "CRM timeline vs budget" not "disagreement")
- "confidence": float 0-1 (how confident you are in the domain classification)
- "reasoning": one sentence explaining why this domain was chosen

Apply inference rules first. If no rule matches, use the entity type's default domain.
Use the entity type's default_horizon as a starting point, but override if the content clearly belongs to a different horizon (e.g. a meeting about quarterly goals should be "quarterly", not "daily").
Only extract what exists. Do not invent. stakes and conflict_points should be null/empty unless genuinely present in the content.`,
        },
        { role: "user", content: content.slice(0, 4000) },
      ],
    }),
  });
  const data = (await res.json()) as any;
  try {
    const parsed = JSON.parse(data.choices[0].message.content);
    const domain = isValidDomain(parsed.domain) ? (parsed.domain as Domain) : (DEFAULT_DOMAIN as Domain);
    const classifiedType = parsed.type || "observation";
    // Resolve horizon: use classifier output, fall back to entity type default, then "daily"
    const entityDef = ontology.entity_types?.[classifiedType];
    const horizon = isValidHorizon(parsed.horizon)
      ? parsed.horizon
      : (entityDef?.default_horizon || "daily");
    // Only include stakes/conflict_points when present (avoid null noise in metadata)
    const stakes = parsed.stakes || null;
    const conflictPoints = parsed.conflict_points?.length ? parsed.conflict_points : [];
    const projectId = parsed.project_id || null;
    return {
      metadata: {
        type: classifiedType,
        topics: parsed.topics || [],
        people: parsed.people || [],
        action_items: parsed.action_items || [],
        dates_mentioned: parsed.dates_mentioned || [],
        sensitivity: parsed.sensitivity || "internal",
        horizon,
        ...(stakes ? { stakes } : {}),
        ...(conflictPoints.length ? { conflict_points: conflictPoints } : {}),
        ...(projectId ? { project_id: projectId } : {}),
      },
      suggestedDomain: domain,
      confidence: parsed.confidence || 0.5,
      reasoning: parsed.reasoning || "Default classification",
    };
  } catch {
    return {
      metadata: { type: "observation", topics: [], horizon: "daily" },
      suggestedDomain: DEFAULT_DOMAIN as Domain,
      confidence: 0.3,
      reasoning: "Failed to parse classification response",
    };
  }
}

// --- Ontology Evolution Proposals ---
type ProposalChangeType = "add_entity" | "add_relationship" | "change_sensitivity" | "add_inference_rule";

type OntologyProposal = {
  version_from: string;
  version_to: string;
  entity_type: string | null;
  change_type: ProposalChangeType;
  proposal: Record<string, unknown>;
  rationale: string;
};

function bumpPatch(version: string): string {
  const parts = version.split(".");
  parts[2] = String(Number(parts[2] || 0) + 1);
  return parts.join(".");
}

function detectOntologyGaps(
  classification: { metadata: Record<string, unknown>; suggestedDomain: Domain; confidence: number; reasoning: string }
): OntologyProposal[] {
  const proposals: OntologyProposal[] = [];
  const knownTypes = Object.keys(ontology.entity_types || {});
  const classifiedType = (classification.metadata.type as string) || "observation";
  const proposedVersion = bumpPatch(ontology.version);

  if (!knownTypes.includes(classifiedType)) {
    // Unknown entity type
    proposals.push({
      version_from: ontology.version,
      version_to: proposedVersion,
      entity_type: classifiedType,
      change_type: "add_entity",
      proposal: {
        name: classifiedType,
        domain_default: classification.suggestedDomain,
        sensitivity: classification.metadata.sensitivity || "internal",
        description: `Auto-detected entity type from classification: "${classifiedType}"`,
      },
      rationale: `Classifier returned type "${classifiedType}" which is not in ontology v${ontology.version}. ${classification.reasoning}`,
    });
  } else {
    // Known type: check for domain mismatch
    const entityDef = ontology.entity_types[classifiedType];
    if (entityDef && entityDef.domain_default !== classification.suggestedDomain && classification.confidence >= 0.7) {
      proposals.push({
        version_from: ontology.version,
        version_to: proposedVersion,
        entity_type: classifiedType,
        change_type: "add_inference_rule",
        proposal: {
          name: `reclassify_${classifiedType}_to_${classification.suggestedDomain}`,
          description: `Entity type "${classifiedType}" defaults to "${entityDef.domain_default}" but classifier routed to "${classification.suggestedDomain}" with ${classification.confidence} confidence`,
          condition: { type_match: classifiedType },
          action: {
            domain: classification.suggestedDomain,
            sensitivity: classification.metadata.sensitivity || entityDef.sensitivity,
            confidence_boost: classification.confidence,
          },
        },
        rationale: `Type "${classifiedType}" has domain_default "${entityDef.domain_default}" but was classified as "${classification.suggestedDomain}" (confidence: ${classification.confidence}). ${classification.reasoning}`,
      });
    }
  }

  // Low confidence suggests insufficient inference rules
  if (classification.confidence < 0.5) {
    const topics = (classification.metadata.topics as string[]) || [];
    proposals.push({
      version_from: ontology.version,
      version_to: proposedVersion,
      entity_type: classifiedType,
      change_type: "add_inference_rule",
      proposal: {
        name: `low_confidence_${classifiedType}_${classification.suggestedDomain}`,
        condition: { topics_match_any: topics },
        action: {
          domain: classification.suggestedDomain,
          sensitivity: classification.metadata.sensitivity || "internal",
          confidence_boost: 0.7,
        },
      },
      rationale: `Classification confidence ${classification.confidence} below 0.5 for domain "${classification.suggestedDomain}". Topics: [${topics.join(", ")}]. Consider adding an inference rule.`,
    });
  }

  return proposals;
}

async function insertProposals(proposals: OntologyProposal[]): Promise<void> {
  if (proposals.length === 0) return;
  try {
    const { error } = await supabase
      .from("ob_ontology_proposals")
      .insert(proposals);
    if (error) {
      process.stderr.write(`[OB] Proposal insert error: ${error.message}\n`);
    } else {
      process.stderr.write(`[OB] ${proposals.length} ontology proposal(s) recorded\n`);
    }
  } catch (e) {
    process.stderr.write(`[OB] Proposal insert failed: ${e}\n`);
  }
}

// --- Importance Scoring ---
const TYPE_WEIGHTS: Record<string, number> = {
  project: 0.9, project_risk: 0.8, project_decision: 0.85, project_milestone: 0.8,
  project_dependency: 0.7, project_cost: 0.7,
  decision: 0.8, goal: 0.85, belief: 0.8,
  meeting: 0.5, colleague_note: 0.4, person_note: 0.6,
  health: 0.7, financial: 0.7, custody: 0.7,
  daily_briefing: 0.2, observation: 0.3, task: 0.4,
  email: 0.2, idea: 0.5, learning: 0.5, research: 0.6, reference: 0.5,
};

const HORIZON_WEIGHTS: Record<string, number> = {
  quarterly: 0.9, monthly: 0.6, weekly: 0.4, daily: 0.2,
};

function computeImportance(metadata: Record<string, unknown>, createdAt: string): number {
  const type = (metadata.type as string) || "observation";
  const horizon = (metadata.horizon as string) || "daily";
  const typeW = TYPE_WEIGHTS[type] ?? 0.3;
  const horizonW = HORIZON_WEIGHTS[horizon] ?? 0.3;

  // Recency decay: 1.0 for today, 0.5 at 30 days, 0.2 at 90 days
  const ageMs = Date.now() - new Date(createdAt).getTime();
  const ageDays = ageMs / 86400000;
  const recency = Math.max(0.1, 1.0 / (1.0 + ageDays / 30));

  // Weighted combination: type matters most, then horizon, then recency
  return Math.round((typeW * 0.5 + horizonW * 0.3 + recency * 0.2) * 100) / 100;
}

// --- Server setup ---
const server = new McpServer({
  name: "engram",
  version: "2.0.0",
});

// --- search_thoughts ---
server.tool(
  "search_thoughts",
  "Search Engram by meaning. Returns thoughts semantically similar to the query. Use this to find memories, notes, decisions, and context by what they mean, not just keywords.",
  {
    query: z.string().describe("What to search for (by meaning)"),
    domain: z
      .string()
      .optional()
      .describe(`Domain to search: work, personal, life, learning (default: ${DEFAULT_DOMAIN})`),
    cross_domain: z
      .boolean()
      .optional()
      .describe("Search across ALL domains (overrides domain scope). Use only when explicitly requested."),
    limit: z.number().optional().describe("Max results (default 10)"),
    threshold: z.number().optional().describe("Similarity threshold 0-1 (default 0.5)"),
  },
  async ({ query, domain, cross_domain, limit, threshold }) => {
    const embedding = await getEmbedding(query);
    const matchCount = limit ?? 10;
    const matchThreshold = threshold ?? 0.5;

    if (cross_domain) {
      // Search all domains
      const { data, error } = await supabase.rpc("match_thoughts_cross_domain", {
        query_embedding: embedding,
        domains: VALID_DOMAINS.map((d) => `ob_${d}`),
        match_threshold: matchThreshold,
        match_count: matchCount,
      });
      if (error) return { content: [{ type: "text" as const, text: `Error: ${error.message}` }] };
      const results = (data || []).map((t: any) => ({
        content: t.content.slice(0, 500),
        metadata: t.metadata,
        domain: t.domain,
        similarity: Math.round(t.similarity * 100) / 100,
        created_at: t.created_at,
      }));
      return { content: [{ type: "text" as const, text: JSON.stringify({ results }, null, 2) }] };
    }

    // Domain-scoped search (with synapse)
    const primaryDomain = (isValidDomain(domain || "") ? domain : DEFAULT_DOMAIN) as Domain;
    const searchDomains = getSynapseDomains(primaryDomain);

    const { data, error } = await supabase.rpc("match_thoughts_cross_domain", {
      query_embedding: embedding,
      domains: searchDomains.map((d) => `ob_${d}`),
      match_threshold: matchThreshold,
      match_count: matchCount,
    });
    if (error) return { content: [{ type: "text" as const, text: `Error: ${error.message}` }] };
    const results = (data || []).map((t: any) => ({
      content: t.content.slice(0, 500),
      metadata: t.metadata,
      domain: t.domain,
      similarity: Math.round(t.similarity * 100) / 100,
      created_at: t.created_at,
    }));
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            { domain: primaryDomain, synapse_domains: searchDomains, results },
            null,
            2
          ),
        },
      ],
    };
  }
);

// --- list_thoughts ---
server.tool(
  "list_thoughts",
  "List recent thoughts from Engram, optionally filtered by type, topic, person, or date range.",
  {
    domain: z
      .string()
      .optional()
      .describe(`Domain: work, personal, life, learning (default: ${DEFAULT_DOMAIN})`),
    cross_domain: z.boolean().optional().describe("List from ALL domains"),
    type: z
      .string()
      .optional()
      .describe("Filter by type"),
    topic: z.string().optional().describe("Filter by topic tag"),
    person: z.string().optional().describe("Filter by person mentioned"),
    horizon: z.string().optional().describe("Filter by time horizon: daily, weekly, monthly, quarterly"),
    days: z.number().optional().describe("Last N days (default 30)"),
    limit: z.number().optional().describe("Max results (default 20)"),
  },
  async ({ domain, cross_domain, type, topic, person, horizon, days, limit }) => {
    const targetDomains: Domain[] = cross_domain
      ? [...VALID_DOMAINS]
      : [(isValidDomain(domain || "") ? domain : DEFAULT_DOMAIN) as Domain];

    const allThoughts: any[] = [];

    for (const d of targetDomains) {
      const schema = schemaFor(d);
      let query = supabase
        .schema(schema as any)
        .from("thoughts")
        .select("id, content, raw_source, metadata, created_at")
        .order("created_at", { ascending: false })
        .limit(limit ?? 20);

      if (type) query = query.contains("metadata", { type });
      if (topic) query = query.contains("metadata", { topics: [topic] });
      if (person) query = query.contains("metadata", { people: [person] });
      if (horizon && isValidHorizon(horizon)) query = query.contains("metadata", { horizon });
      if (days) {
        const since = new Date(Date.now() - days * 86400000).toISOString();
        query = query.gte("created_at", since);
      }

      const { data, error } = await query;
      if (error) {
        process.stderr.write(`[OB] list error for ${schema}: ${error.message}\n`);
        continue;
      }
      for (const t of data || []) {
        allThoughts.push({
          id: t.id,
          content: (t.content as string).slice(0, 300),
          ...(t.raw_source ? { raw_source: (t.raw_source as string).slice(0, 300) } : {}),
          metadata: t.metadata,
          domain: d,
          created_at: t.created_at,
        });
      }
    }

    // Sort by created_at desc, limit
    allThoughts.sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    );
    const thoughts = allThoughts.slice(0, limit ?? 20);

    return {
      content: [{ type: "text" as const, text: JSON.stringify({ thoughts }, null, 2) }],
    };
  }
);

// --- capture_thought ---
server.tool(
  "capture_thought",
  "Save a thought to Engram. Auto-classifies domain and extracts metadata using the ontology. Returns suggested domain for confirmation.",
  {
    content: z.string().describe("The thought to capture"),
    domain: z
      .string()
      .optional()
      .describe("Force a specific domain (skip auto-classification): work, personal, life, learning"),
    source: z.string().optional().describe('Source (default "mcp")'),
    project_id: z
      .string()
      .optional()
      .describe("Link this thought to a project by slug (e.g. 'lighthouse', 'north-star'). Overrides classifier extraction."),
  },
  async ({ content, domain, source, project_id }) => {
    const [embedding, classification] = await Promise.all([
      getEmbedding(content),
      classifyAndExtract(content),
    ]);

    // Use forced domain if provided, otherwise use auto-classification
    const targetDomain = (
      domain && isValidDomain(domain) ? domain : classification.suggestedDomain
    ) as Domain;
    const schema = schemaFor(targetDomain);

    // Resolve project_id: explicit parameter takes precedence over classifier extraction
    const resolvedProjectId = project_id || (classification.metadata as any).project_id || null;

    const enrichedMetadata = {
      ...classification.metadata,
      source: source ?? "mcp",
      domain: targetDomain,
      ...(resolvedProjectId ? { project_id: resolvedProjectId } : {}),
    };

    // Detect ontology gaps and fire-and-forget proposal insert
    const proposals = detectOntologyGaps(classification);
    insertProposals(proposals);

    const { data, error } = await supabase
      .schema(schema as any)
      .from("thoughts")
      .insert({
        content,
        embedding,
        metadata: enrichedMetadata,
        importance: computeImportance(enrichedMetadata, new Date().toISOString()),
      })
      .select("id, metadata")
      .single();

    if (error) {
      return {
        content: [{ type: "text" as const, text: `Error: ${error.message}` }],
      };
    }

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              id: data.id,
              domain: targetDomain,
              type: (enrichedMetadata as any).type,
              topics: (enrichedMetadata as any).topics || [],
              sensitivity: (enrichedMetadata as any).sensitivity,
              classification: {
                suggested_domain: classification.suggestedDomain,
                confidence: classification.confidence,
                reasoning: classification.reasoning,
                forced: domain ? true : false,
              },
              ontology_proposals: proposals.length > 0
                ? proposals.map((p) => ({
                    change_type: p.change_type,
                    entity_type: p.entity_type,
                    rationale: p.rationale,
                  }))
                : [],
              message: `Captured to ${targetDomain} as ${(enrichedMetadata as any).type}`,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// --- situational_awareness ---
server.tool(
  "situational_awareness",
  "Get situational awareness at a specific time horizon. Returns relevant thoughts from the appropriate time window: daily (today), weekly (7 days), monthly (30 days), quarterly (90 days). Combines horizon-tagged thoughts with time-windowed recent thoughts.",
  {
    horizon: z
      .enum(["daily", "weekly", "monthly", "quarterly"])
      .describe("Time horizon to get awareness for"),
    domain: z
      .string()
      .optional()
      .describe(`Domain scope: work, personal, life, learning (default: ${DEFAULT_DOMAIN})`),
    cross_domain: z
      .boolean()
      .optional()
      .describe("Include all domains"),
    limit: z.number().optional().describe("Max results (default 20)"),
  },
  async ({ horizon, domain, cross_domain, limit }) => {
    const windowDays = HORIZON_WINDOWS[horizon];
    const since = new Date(Date.now() - windowDays * 86400000).toISOString();
    const maxResults = limit ?? 20;

    const targetDomains: Domain[] = cross_domain
      ? [...VALID_DOMAINS]
      : [(isValidDomain(domain || "") ? domain : DEFAULT_DOMAIN) as Domain];

    const allThoughts: any[] = [];

    for (const d of targetDomains) {
      const schema = schemaFor(d);

      // Query 1: thoughts with matching horizon tag (from any time, but within window)
      const horizonQuery = supabase
        .schema(schema as any)
        .from("thoughts")
        .select("id, content, metadata, created_at")
        .contains("metadata", { horizon })
        .gte("created_at", since)
        .order("created_at", { ascending: false })
        .limit(maxResults);

      // Query 2: all thoughts within time window (catches old thoughts without horizon)
      const timeQuery = supabase
        .schema(schema as any)
        .from("thoughts")
        .select("id, content, metadata, created_at")
        .gte("created_at", since)
        .order("created_at", { ascending: false })
        .limit(maxResults);

      const [horizonResult, timeResult] = await Promise.all([horizonQuery, timeQuery]);

      const seenIds = new Set<string>();
      const addThought = (t: any, matchType: string) => {
        if (seenIds.has(t.id)) return;
        seenIds.add(t.id);
        allThoughts.push({
          id: t.id,
          content: (t.content as string).slice(0, 400),
          metadata: t.metadata,
          domain: d,
          match: matchType,
          created_at: t.created_at,
        });
      };

      // Horizon-tagged thoughts get priority
      for (const t of horizonResult.data || []) addThought(t, "horizon");
      // Time-window thoughts fill in the rest
      for (const t of timeResult.data || []) addThought(t, "time_window");
    }

    // Sort: horizon-tagged first, then by recency
    allThoughts.sort((a, b) => {
      if (a.match !== b.match) return a.match === "horizon" ? -1 : 1;
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    });

    const thoughts = allThoughts.slice(0, maxResults);

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              horizon,
              window_days: windowDays,
              since,
              domains: targetDomains,
              total: thoughts.length,
              thoughts,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// --- project_status ---
server.tool(
  "project_status",
  "Get a complete project overview: definition, risks, decisions, dependencies, milestones, and costs. Aggregates all thoughts linked to a project_id.",
  {
    project_id: z.string().describe("Project slug (e.g. 'lighthouse', 'north-star')"),
    include_content: z
      .boolean()
      .optional()
      .describe("Include full thought content (default: true, set false for summary only)"),
  },
  async ({ project_id, include_content }) => {
    const { data, error } = await supabase
      .schema(schemaFor("work") as any)
      .from("thoughts")
      .select("id, content, metadata, created_at")
      .contains("metadata", { project_id })
      .order("created_at", { ascending: false })
      .limit(500);

    if (error) {
      return { content: [{ type: "text" as const, text: `Error: ${error.message}` }] };
    }

    const projectThoughts = data || [];
    const grouped: Record<string, any[]> = {};
    let projectDefinition: any = null;

    for (const t of projectThoughts) {
      const type = t.metadata?.type || "unknown";
      if (type === "project") {
        projectDefinition = {
          id: t.id,
          content: t.content,
          status: t.metadata?.status || "unknown",
          start_date: t.metadata?.start_date || null,
          end_date: t.metadata?.end_date || null,
          goal: t.metadata?.goal || null,
          scope: t.metadata?.scope || null,
          owner: t.metadata?.owner || null,
          sponsor: t.metadata?.sponsor || null,
          created_at: t.created_at,
        };
      } else {
        if (!grouped[type]) grouped[type] = [];
        grouped[type].push({
          id: t.id,
          ...(include_content !== false ? { content: t.content } : {}),
          metadata: t.metadata,
          created_at: t.created_at,
        });
      }
    }

    const summary = {
      project_id,
      total_thoughts: projectThoughts.length,
      definition: projectDefinition,
      artifact_counts: Object.fromEntries(
        Object.entries(grouped).map(([type, items]) => [type, items.length])
      ),
      artifacts: grouped,
    };

    return {
      content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }],
    };
  }
);

// --- thought_stats ---
server.tool(
  "thought_stats",
  "Get Engram statistics: total thoughts, type distribution, top topics. Optionally scoped to a domain.",
  {
    domain: z
      .string()
      .optional()
      .describe("Domain to get stats for (default: all domains)"),
  },
  async ({ domain }) => {
    if (domain && isValidDomain(domain)) {
      const { data, error } = await supabase.rpc("thought_stats_by_domain", {
        target_domain: domain,
      });
      if (error) return { content: [{ type: "text" as const, text: `Error: ${error.message}` }] };
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }

    // All domains
    const results: Record<string, any> = {};
    let grandTotal = 0;
    for (const d of VALID_DOMAINS) {
      const { data, error } = await supabase.rpc("thought_stats_by_domain", {
        target_domain: d,
      });
      if (!error && data) {
        results[d] = data;
        grandTotal += (data as any).total || 0;
      }
    }
    results.grand_total = grandTotal;
    results.ontology_version = ontology.version;

    return {
      content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }],
    };
  }
);

// --- add_relationship ---
server.tool(
  "add_relationship",
  "Add a temporal relationship between two entities. Supports valid_from/valid_to for tracking how facts change over time.",
  {
    subject: z.string().describe("The source entity (e.g. person name, project slug)"),
    subject_domain: z.enum(["work", "personal", "life", "learning"]).optional().describe("Domain of subject (default: work)"),
    object: z.string().describe("The target entity"),
    object_domain: z.enum(["work", "personal", "life", "learning"]).optional().describe("Domain of object (default: work)"),
    predicate: z.string().describe("Relationship type (e.g. 'works_on', 'reports_to', 'owns', 'depends_on')"),
    properties: z.record(z.unknown()).optional().describe("Additional properties as key-value pairs"),
    valid_from: z.string().optional().describe("ISO timestamp when this became true (default: now)"),
    source_thought_id: z.string().uuid().optional().describe("UUID of the thought this relationship was extracted from"),
  },
  async ({ subject, subject_domain, object, object_domain, predicate, properties, valid_from, source_thought_id }) => {
    const { data, error } = await supabase
      .from("ob_relationships")
      .insert({
        subject,
        subject_domain: subject_domain || "work",
        object,
        object_domain: object_domain || "work",
        predicate,
        properties: properties || {},
        valid_from: valid_from || new Date().toISOString(),
        source_thought_id: source_thought_id || null,
      })
      .select("id")
      .single();

    if (error) return { content: [{ type: "text" as const, text: `Error: ${error.message}` }] };
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ id: data.id, subject, predicate, object, message: "Relationship added" }, null, 2) }],
    };
  }
);

// --- query_relationships ---
server.tool(
  "query_relationships",
  "Query the temporal knowledge graph. Find relationships involving an entity, optionally filtered by predicate and point-in-time.",
  {
    entity: z.string().describe("Entity name to query (matches subject or object)"),
    predicate: z.string().optional().describe("Filter by relationship type"),
    as_of: z.string().optional().describe("ISO timestamp: show relationships valid at this point in time (default: now)"),
    include_expired: z.boolean().optional().describe("Include expired relationships (default: false)"),
    limit: z.number().optional().describe("Max results (default 50)"),
  },
  async ({ entity, predicate, as_of, include_expired, limit }) => {
    const asOfDate = as_of || new Date().toISOString();
    const maxResults = limit ?? 50;

    if (include_expired) {
      // All relationships, current and expired
      let query = supabase
        .from("ob_relationships")
        .select("*")
        .or(`subject.eq.${entity},object.eq.${entity}`)
        .order("valid_from", { ascending: false })
        .limit(maxResults);

      if (predicate) query = query.eq("predicate", predicate);

      const { data, error } = await query;
      if (error) return { content: [{ type: "text" as const, text: `Error: ${error.message}` }] };

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ entity, include_expired: true, total: (data || []).length, relationships: data || [] }, null, 2) }],
      };
    }

    const { data, error } = await supabase.rpc("query_relationships_at", {
      target_entity: entity,
      as_of: asOfDate,
      rel_predicate: predicate || null,
      max_results: maxResults,
    });

    if (error) return { content: [{ type: "text" as const, text: `Error: ${error.message}` }] };

    return {
      content: [{ type: "text" as const, text: JSON.stringify({ entity, as_of: asOfDate, total: (data || []).length, relationships: data || [] }, null, 2) }],
    };
  }
);

// --- invalidate_relationship ---
server.tool(
  "invalidate_relationship",
  "Mark a relationship as no longer valid by setting its valid_to timestamp. Does not delete the record (preserves history).",
  {
    relationship_id: z.string().uuid().describe("UUID of the relationship to invalidate"),
    valid_to: z.string().optional().describe("ISO timestamp when this stopped being true (default: now)"),
  },
  async ({ relationship_id, valid_to }) => {
    const { data, error } = await supabase
      .from("ob_relationships")
      .update({ valid_to: valid_to || new Date().toISOString() })
      .eq("id", relationship_id)
      .select("id, subject, predicate, object, valid_to")
      .single();

    if (error) return { content: [{ type: "text" as const, text: `Error: ${error.message}` }] };
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ ...data, message: "Relationship invalidated" }, null, 2) }],
    };
  }
);

// --- discover_connections ---
server.tool(
  "discover_connections",
  "Discover cross-domain connections: find thoughts in different domains that share people, topics, or project_ids. Respects never_cross constraints.",
  {
    entity: z.string().describe("Person name, topic, or project_id to trace across domains"),
    connection_type: z.enum(["person", "topic", "project"]).describe("What type of connection to look for"),
    limit_per_domain: z.number().optional().describe("Max results per domain (default 5)"),
  },
  async ({ entity, connection_type, limit_per_domain }) => {
    const perDomain = limit_per_domain ?? 5;
    const neverCross = ontology.synapse_rules?.never_cross || [];
    const connections: Record<string, any[]> = {};

    let metadataFilter: Record<string, unknown>;
    switch (connection_type) {
      case "person":
        metadataFilter = { people: [entity] };
        break;
      case "topic":
        metadataFilter = { topics: [entity] };
        break;
      case "project":
        metadataFilter = { project_id: entity };
        break;
    }

    // Query all 4 domains in parallel
    const results = await Promise.all(
      VALID_DOMAINS.map(async (d) => {
        const schema = schemaFor(d);
        const { data, error } = await supabase
          .schema(schema as any)
          .from("thoughts")
          .select("id, content, metadata, created_at")
          .contains("metadata", metadataFilter)
          .order("created_at", { ascending: false })
          .limit(perDomain);
        return { domain: d, data, error };
      })
    );

    for (const { domain: d, data, error } of results) {
      if (error || !data?.length) continue;

      const filtered = data.filter((t: any) => {
        const type = t.metadata?.type || "";
        return !neverCross.includes(type);
      });

      if (filtered.length > 0) {
        connections[d] = filtered.map((t: any) => ({
          id: t.id,
          type: t.metadata?.type,
          content: (t.content as string).slice(0, 200),
          topics: t.metadata?.topics || [],
          people: t.metadata?.people || [],
          created_at: t.created_at,
        }));
      }
    }

    const domainCount = Object.keys(connections).length;

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          entity,
          connection_type,
          domains_found: domainCount,
          is_cross_domain: domainCount > 1,
          connections,
        }, null, 2),
      }],
    };
  }
);

// --- wake_up ---
server.tool(
  "wake_up",
  "Quick context injection for session start. Returns layered recall: L0 (identity/role, max 3), L1 (active projects, max 5), L2 (recent high-importance thoughts, max 10). Designed to fit within ~1500 tokens.",
  {
    domain: z.string().optional().describe(`Primary domain (default: ${DEFAULT_DOMAIN})`),
  },
  async ({ domain }) => {
    const primaryDomain = (isValidDomain(domain || "") ? domain : DEFAULT_DOMAIN) as Domain;
    const schema = schemaFor(primaryDomain);

    // L0: Identity/role thoughts (goals, beliefs, daily briefings)
    const l0Query = supabase
      .schema("ob_life" as any)
      .from("thoughts")
      .select("id, content, metadata, importance, created_at")
      .or("metadata->>type.eq.goal,metadata->>type.eq.belief,metadata->>type.eq.daily_briefing")
      .order("importance", { ascending: false, nullsFirst: false })
      .limit(3);

    // L1: Active project definitions
    const l1Query = supabase
      .schema(schema as any)
      .from("thoughts")
      .select("id, content, metadata, importance, created_at")
      .contains("metadata", { type: "project" })
      .order("importance", { ascending: false, nullsFirst: false })
      .limit(5);

    // L2: Recent high-importance thoughts (last 7 days)
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();
    const l2Query = supabase
      .schema(schema as any)
      .from("thoughts")
      .select("id, content, metadata, importance, created_at")
      .gte("created_at", sevenDaysAgo)
      .not("metadata->>type", "eq", "project") // don't duplicate L1
      .order("importance", { ascending: false, nullsFirst: false })
      .limit(10);

    const [l0Result, l1Result, l2Result] = await Promise.all([l0Query, l1Query, l2Query]);

    const formatLayer = (data: any[] | null, maxContentLen: number) =>
      (data || []).map((t: any) => ({
        id: t.id,
        type: t.metadata?.type,
        content: (t.content as string).slice(0, maxContentLen),
        importance: t.importance,
        created_at: t.created_at,
      }));

    const l0 = formatLayer(l0Result.data, 150);  // Short for identity
    const l1 = formatLayer(l1Result.data, 200);  // Medium for projects
    const l2 = formatLayer(l2Result.data, 100);  // Brief for recent context

    // Estimate tokens (~4 chars per token)
    const estimatedTokens = Math.round(
      JSON.stringify({ l0, l1, l2 }).length / 4
    );

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          domain: primaryDomain,
          estimated_tokens: estimatedTokens,
          layers: {
            L0_identity: { count: l0.length, thoughts: l0 },
            L1_projects: { count: l1.length, thoughts: l1 },
            L2_recent: { count: l2.length, thoughts: l2 },
          },
        }, null, 2),
      }],
    };
  }
);

// --- Start ---
const transport = new StdioServerTransport();
await server.connect(transport);
