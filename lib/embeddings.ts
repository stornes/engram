/**
 * 1024-dimension embedding helper used by the MCP server and every sync /
 * backfill script.
 *
 * Strategy: if VOYAGE_API_KEY is set, use Voyage AI's voyage-3 model (1024
 * dimensions native). Otherwise fall back to OpenAI's text-embedding-3-small
 * with `dimensions: 1024` — this parameter is REQUIRED, otherwise OpenAI
 * returns the model default of 1536 dimensions, which the schema's
 * vector(1024) column rejects.
 *
 * Centralising this prevents the dimension bug from recurring as new sync
 * scripts are added. Inputs are truncated to model-specific safe limits.
 */

const VOYAGE_MAX_CHARS = 16000;
const OPENAI_MAX_CHARS = 8000;

export const EMBEDDING_DIMENSIONS = 1024;

export type EmbeddingProvider = "voyage" | "openai";

export function activeProvider(): EmbeddingProvider {
  return process.env.VOYAGE_API_KEY ? "voyage" : "openai";
}

export async function getEmbedding(text: string): Promise<number[]> {
  if (process.env.VOYAGE_API_KEY) {
    return voyageEmbedding(text);
  }
  if (!process.env.OPENAI_API_KEY) {
    throw new Error(
      "No embedding key configured. Set VOYAGE_API_KEY or OPENAI_API_KEY."
    );
  }
  return openaiEmbedding(text);
}

async function voyageEmbedding(text: string): Promise<number[]> {
  const res = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.VOYAGE_API_KEY}`,
    },
    body: JSON.stringify({
      model: "voyage-3",
      input: text.slice(0, VOYAGE_MAX_CHARS),
    }),
  });
  const data = (await res.json()) as any;
  const embedding = data?.data?.[0]?.embedding;
  if (!Array.isArray(embedding)) {
    throw new Error(`Voyage embedding failed: ${JSON.stringify(data)}`);
  }
  return embedding;
}

async function openaiEmbedding(text: string): Promise<number[]> {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "text-embedding-3-small",
      input: text.slice(0, OPENAI_MAX_CHARS),
      dimensions: EMBEDDING_DIMENSIONS,
    }),
  });
  const data = (await res.json()) as any;
  const embedding = data?.data?.[0]?.embedding;
  if (!Array.isArray(embedding)) {
    throw new Error(`OpenAI embedding failed: ${JSON.stringify(data)}`);
  }
  return embedding;
}
