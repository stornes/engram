// Engram MCP Server
// Deployed as Supabase Edge Function
// Exposes: search_thoughts, list_thoughts, capture_thought, thought_stats

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY")!;
const BRAIN_KEY = Deno.env.get("BRAIN_KEY") || "";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// --- Embedding ---
async function getEmbedding(text: string): Promise<number[]> {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "text-embedding-3-small",
      input: text.slice(0, 8000),
      dimensions: 1024,
    }),
  });
  const data = await res.json();
  return data.data[0].embedding;
}

// --- Metadata extraction ---
async function extractMetadata(
  content: string
): Promise<Record<string, unknown>> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `Extract metadata from this thought/note. Return JSON with:
- "type": one of "observation", "task", "idea", "reference", "person_note", "meeting", "decision", "learning"
- "topics": array of 1-3 topic tags (lowercase, specific)
- "people": array of people mentioned (first name last name if available)
- "action_items": array of implied tasks (empty if none)
- "dates_mentioned": array of dates in YYYY-MM-DD format (empty if none)
Only include fields with actual content. Do not invent.`,
        },
        { role: "user", content: content.slice(0, 4000) },
      ],
    }),
  });
  const data = await res.json();
  try {
    return JSON.parse(data.choices[0].message.content);
  } catch {
    return { type: "observation", topics: [] };
  }
}

// --- MCP Protocol ---
const TOOLS = [
  {
    name: "search_thoughts",
    description:
      "Search memory by meaning. Returns thoughts semantically similar to the query.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "What to search for (searched by meaning, not keywords)",
        },
        limit: {
          type: "number",
          description: "Max results (default 10)",
        },
        threshold: {
          type: "number",
          description: "Similarity threshold 0-1 (default 0.5)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "list_thoughts",
    description:
      "List recent thoughts, optionally filtered by type, topic, person, or date range.",
    inputSchema: {
      type: "object" as const,
      properties: {
        type: {
          type: "string",
          description:
            'Filter by type: observation, task, idea, reference, person_note, meeting, decision, learning',
        },
        topic: { type: "string", description: "Filter by topic tag" },
        person: { type: "string", description: "Filter by person mentioned" },
        days: {
          type: "number",
          description: "Only thoughts from last N days (default 30)",
        },
        limit: { type: "number", description: "Max results (default 20)" },
      },
    },
  },
  {
    name: "capture_thought",
    description:
      "Save a thought/note to Engram. Auto-extracts metadata and generates embedding.",
    inputSchema: {
      type: "object" as const,
      properties: {
        content: {
          type: "string",
          description: "The thought, note, decision, or observation to capture",
        },
        source: {
          type: "string",
          description: 'Source identifier (default "mcp")',
        },
      },
      required: ["content"],
    },
  },
  {
    name: "thought_stats",
    description:
      "Get statistics about the Engram: total thoughts, type distribution, top topics, top people.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
];

// --- Tool handlers ---
async function handleSearch(args: {
  query: string;
  limit?: number;
  threshold?: number;
}) {
  const embedding = await getEmbedding(args.query);
  const { data, error } = await supabase.rpc("match_thoughts", {
    query_embedding: embedding,
    match_threshold: args.threshold || 0.5,
    match_count: args.limit || 10,
  });
  if (error) return { error: error.message };
  return {
    results: (data || []).map(
      (t: {
        content: string;
        metadata: Record<string, unknown>;
        similarity: number;
        created_at: string;
      }) => ({
        content: t.content,
        metadata: t.metadata,
        similarity: Math.round(t.similarity * 100) / 100,
        created_at: t.created_at,
      })
    ),
  };
}

async function handleList(args: {
  type?: string;
  topic?: string;
  person?: string;
  days?: number;
  limit?: number;
}) {
  let query = supabase
    .from("thoughts")
    .select("id, content, metadata, created_at")
    .order("created_at", { ascending: false })
    .limit(args.limit || 20);

  if (args.type)
    query = query.contains("metadata", { type: args.type });
  if (args.topic)
    query = query.contains("metadata", { topics: [args.topic] });
  if (args.person)
    query = query.contains("metadata", { people: [args.person] });
  if (args.days) {
    const since = new Date(
      Date.now() - args.days * 24 * 60 * 60 * 1000
    ).toISOString();
    query = query.gte("created_at", since);
  }

  const { data, error } = await query;
  if (error) return { error: error.message };
  return { thoughts: data || [] };
}

async function handleCapture(args: { content: string; source?: string }) {
  const [embedding, metadata] = await Promise.all([
    getEmbedding(args.content),
    extractMetadata(args.content),
  ]);

  const enrichedMetadata = {
    ...metadata,
    source: args.source || "mcp",
  };

  const { data, error } = await supabase
    .from("thoughts")
    .insert({
      content: args.content,
      embedding: embedding,
      metadata: enrichedMetadata,
    })
    .select("id, metadata")
    .single();

  if (error) return { error: error.message };
  return {
    id: data.id,
    type: enrichedMetadata.type,
    topics: (enrichedMetadata as Record<string, unknown>).topics || [],
    message: `Captured as ${enrichedMetadata.type}`,
  };
}

async function handleStats() {
  const { data, error } = await supabase.rpc("thought_stats");
  if (error) return { error: error.message };
  return data;
}

// --- HTTP Handler (MCP over HTTP) ---
Deno.serve(async (req) => {
  // Auth check
  const url = new URL(req.url);
  const key = url.searchParams.get("key") || req.headers.get("x-brain-key");
  if (BRAIN_KEY && key !== BRAIN_KEY) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Handle MCP JSON-RPC
  if (req.method === "POST") {
    const body = await req.json();
    const { method, params, id } = body;

    let result: unknown;

    switch (method) {
      case "initialize":
        result = {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "engram", version: "1.0.0" },
        };
        break;

      case "tools/list":
        result = { tools: TOOLS };
        break;

      case "tools/call": {
        const toolName = params?.name;
        const toolArgs = params?.arguments || {};

        try {
          let toolResult: unknown;
          switch (toolName) {
            case "search_thoughts":
              toolResult = await handleSearch(toolArgs);
              break;
            case "list_thoughts":
              toolResult = await handleList(toolArgs);
              break;
            case "capture_thought":
              toolResult = await handleCapture(toolArgs);
              break;
            case "thought_stats":
              toolResult = await handleStats();
              break;
            default:
              toolResult = { error: `Unknown tool: ${toolName}` };
          }
          result = {
            content: [
              { type: "text", text: JSON.stringify(toolResult, null, 2) },
            ],
          };
        } catch (e) {
          result = {
            content: [{ type: "text", text: `Error: ${(e as Error).message}` }],
            isError: true,
          };
        }
        break;
      }

      default:
        result = { error: `Unknown method: ${method}` };
    }

    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id, result }),
      { headers: { "Content-Type": "application/json" } }
    );
  }

  // GET = health check
  return new Response(
    JSON.stringify({
      status: "ok",
      name: "Engram",
      tools: TOOLS.map((t) => t.name),
    }),
    { headers: { "Content-Type": "application/json" } }
  );
});
