#!/usr/bin/env bun
/**
 * rechunk_thoughts.ts - Split oversized Engram thoughts into semantic chunks
 *
 * Finds thoughts where content exceeds the embedding window (~6000 chars),
 * splits them into smaller chunks, re-embeds each chunk, and inserts as
 * new rows linked to the original via metadata.parent_id. Original row
 * is marked with metadata.chunked=true (not deleted).
 *
 * Usage:
 *   bun rechunk_thoughts.ts --dry-run       # Preview only
 *   bun rechunk_thoughts.ts --limit 10      # Process first 10
 *   bun rechunk_thoughts.ts                 # Full run
 */

import { readFileSync } from "fs";
import { join } from "path";
import { createClient } from "@supabase/supabase-js";
import { getEmbedding } from "./lib/embeddings.ts";

// --- Load env ---
const envPath = join(process.env.HOME!, ".claude", "engram", ".env");
try {
  const content = readFileSync(envPath, "utf-8");
  for (const line of content.split("\n")) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match) {
      const key = match[1].trim();
      const val = match[2].trim();
      if (!process.env[key]) process.env[key] = val;
    }
  }
} catch {}

// Also load from ~/.claude/.env
try {
  const content = readFileSync(join(process.env.HOME!, ".claude", ".env"), "utf-8");
  for (const line of content.split("\n")) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match) {
      const key = match[1].trim();
      const val = match[2].trim();
      if (!process.env[key]) process.env[key] = val;
    }
  }
} catch {}

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || "";
const MAX_CHUNK_CHARS = 1500; // ~375 tokens, optimal for semantic search
const CHUNK_OVERLAP = 150; // overlap for context continuity
const OVERSIZE_THRESHOLD = 5000; // chars; rows above this get rechunked

if (!SUPABASE_KEY) {
  console.error("ERROR: SUPABASE_SERVICE_ROLE_KEY or SUPABASE_SERVICE_KEY required");
  process.exit(1);
}
if (!process.env.VOYAGE_API_KEY && !process.env.OPENAI_API_KEY) {
  console.error("ERROR: VOYAGE_API_KEY or OPENAI_API_KEY required");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// --- CLI args ---
const DRY_RUN = process.argv.includes("--dry-run");
const limitIdx = process.argv.indexOf("--limit");
const LIMIT = limitIdx !== -1 ? parseInt(process.argv[limitIdx + 1], 10) : 0;

// --- Chunking ---
function chunkContent(content: string): string[] {
  const chunks: string[] = [];
  const sections = content.split(/(?=\n#{1,3} |\n\n)/);
  let buffer = "";

  for (const section of sections) {
    if ((buffer + section).length <= MAX_CHUNK_CHARS) {
      buffer += section;
    } else {
      if (buffer.trim()) chunks.push(buffer.trim());
      if (section.length > MAX_CHUNK_CHARS) {
        let pos = 0;
        while (pos < section.length) {
          const slice = section.slice(pos, pos + MAX_CHUNK_CHARS).trim();
          if (slice.length > 50) chunks.push(slice);
          pos += MAX_CHUNK_CHARS - CHUNK_OVERLAP;
        }
        buffer = "";
      } else {
        buffer = (chunks.at(-1) ?? "").slice(-CHUNK_OVERLAP) + section;
      }
    }
  }
  if (buffer.trim().length > 50) chunks.push(buffer.trim());
  return chunks;
}

// --- Main ---
async function main() {
  console.log(`Engram Rechunker`);
  console.log(`  Mode: ${DRY_RUN ? "DRY RUN" : "LIVE"}`);
  console.log(`  Threshold: ${OVERSIZE_THRESHOLD} chars`);
  console.log(`  Max chunk: ${MAX_CHUNK_CHARS} chars`);
  if (LIMIT) console.log(`  Limit: ${LIMIT} rows`);
  console.log("");

  // Find oversized thoughts that haven't been chunked yet
  let query = supabase
    .from("thoughts")
    .select("id, content, metadata, created_at")
    .not("metadata", "cs", '{"chunked":true}')
    .order("created_at", { ascending: true });

  if (LIMIT) {
    query = query.limit(LIMIT * 2); // Fetch more, filter in-app
  }

  const { data: rows, error } = await query;

  if (error) {
    console.error(`Supabase query failed: ${error.message}`);
    process.exit(1);
  }

  // Filter to oversized rows
  const oversized = (rows || []).filter(r => r.content.length > OVERSIZE_THRESHOLD);
  const toProcess = LIMIT ? oversized.slice(0, LIMIT) : oversized;

  console.log(`Found ${oversized.length} oversized thoughts (total rows scanned: ${rows?.length || 0})`);
  console.log(`Processing: ${toProcess.length}`);
  console.log("");

  let totalChunks = 0;
  let processed = 0;
  let errors = 0;

  for (const row of toProcess) {
    const chunks = chunkContent(row.content);
    const preview = row.content.slice(0, 80).replace(/\n/g, " ");
    console.log(`[${processed + 1}/${toProcess.length}] ${row.id} (${row.content.length} chars -> ${chunks.length} chunks)`);
    console.log(`  "${preview}..."`);

    if (DRY_RUN) {
      for (let i = 0; i < chunks.length; i++) {
        console.log(`  Chunk ${i + 1}: ${chunks[i].length} chars`);
      }
      totalChunks += chunks.length;
      processed++;
      continue;
    }

    try {
      // Insert chunks
      for (let i = 0; i < chunks.length; i++) {
        const chunkContent = chunks[i];
        const embedding = await getEmbedding(chunkContent);

        const chunkMetadata = {
          ...(row.metadata || {}),
          parent_id: row.id,
          chunk_index: i,
          chunk_total: chunks.length,
          source: row.metadata?.source ? `${row.metadata.source}:chunk` : "rechunk",
        };

        const { error: insertError } = await supabase
          .from("thoughts")
          .insert({
            content: chunkContent,
            embedding: embedding.length > 0 ? embedding : null,
            metadata: chunkMetadata,
            created_at: row.created_at, // Preserve original timestamp
          });

        if (insertError) {
          console.error(`  ERROR inserting chunk ${i + 1}: ${insertError.message}`);
          errors++;
        } else {
          console.log(`  Chunk ${i + 1}/${chunks.length}: ${chunkContent.length} chars, embedded`);
        }
      }

      // Mark original as chunked (don't delete)
      const { error: updateError } = await supabase
        .from("thoughts")
        .update({
          metadata: { ...(row.metadata || {}), chunked: true, chunk_count: chunks.length },
        })
        .eq("id", row.id);

      if (updateError) {
        console.error(`  ERROR marking original: ${updateError.message}`);
        errors++;
      }

      totalChunks += chunks.length;
      processed++;
    } catch (e) {
      console.error(`  FATAL: ${e}`);
      errors++;
    }

    // Rate limit: 1 thought per second to stay under OpenAI limits
    if (!DRY_RUN) await new Promise(r => setTimeout(r, 1000));
  }

  console.log("");
  console.log("--- Summary ---");
  console.log(`Processed: ${processed}/${toProcess.length}`);
  console.log(`Chunks created: ${totalChunks}`);
  console.log(`Errors: ${errors}`);
  if (DRY_RUN) console.log("(Dry run, no changes made)");
}

main().catch((e) => {
  console.error(`FATAL: ${e}`);
  process.exit(1);
});
