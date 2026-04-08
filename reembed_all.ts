#!/usr/bin/env bun
/**
 * reembed_all.ts - Re-embed all thoughts with Voyage voyage-3
 *
 * After migrating from OpenAI text-embedding-3-small (1536d) to Voyage voyage-3 (1024d).
 * Processes rows where embedding IS NULL in batches.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { createClient } from "@supabase/supabase-js";

// Load env
for (const envPath of [
  join(process.env.HOME!, ".claude", "engram", ".env"),
  join(process.env.HOME!, ".claude", ".env"),
]) {
  try {
    for (const line of readFileSync(envPath, "utf-8").split("\n")) {
      const m = line.match(/^([^#=]+)=(.*)$/);
      if (m && !process.env[m[1].trim()]) process.env[m[1].trim()] = m[2].trim();
    }
  } catch {}
}

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || "";
const VOYAGE_KEY = process.env.VOYAGE_API_KEY || "";

if (!SUPABASE_KEY || !VOYAGE_KEY) {
  console.error("Need SUPABASE_SERVICE_ROLE_KEY and VOYAGE_API_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const BATCH_SIZE = 8; // Voyage allows batching

async function getEmbeddings(texts: string[]): Promise<number[][]> {
  const res = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${VOYAGE_KEY}`,
    },
    body: JSON.stringify({
      model: "voyage-3",
      input: texts.map(t => t.slice(0, 16000)),
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Voyage API error ${res.status}: ${err}`);
  }

  const data = await res.json() as { data: { embedding: number[] }[] };
  return data.data.map(d => d.embedding);
}

async function main() {
  // Count rows needing embeddings
  const { count } = await supabase
    .from("thoughts")
    .select("id", { count: "exact", head: true })
    .is("embedding", null);

  console.log(`Rows to embed: ${count}`);
  if (!count || count === 0) {
    console.log("Nothing to do.");
    return;
  }

  let processed = 0;
  let errors = 0;

  while (processed < count) {
    // Fetch batch of rows without embeddings
    const { data: rows, error } = await supabase
      .from("thoughts")
      .select("id, content")
      .is("embedding", null)
      .order("created_at", { ascending: true })
      .limit(BATCH_SIZE);

    if (error) {
      console.error(`Fetch error: ${error.message}`);
      break;
    }

    if (!rows || rows.length === 0) break;

    try {
      const texts = rows.map(r => r.content || "");
      const embeddings = await getEmbeddings(texts);

      for (let i = 0; i < rows.length; i++) {
        const { error: updateErr } = await supabase
          .from("thoughts")
          .update({ embedding: embeddings[i] as any })
          .eq("id", rows[i].id);

        if (updateErr) {
          console.error(`Update error for ${rows[i].id}: ${updateErr.message}`);
          errors++;
        }
      }

      processed += rows.length;
      const pct = ((processed / count) * 100).toFixed(1);
      process.stdout.write(`\r  ${processed}/${count} (${pct}%) embedded, ${errors} errors`);
    } catch (e) {
      console.error(`\nBatch error: ${e}`);
      errors++;
      await new Promise(r => setTimeout(r, 2000));
    }

    // Rate limit: ~3 batch requests per second
    await new Promise(r => setTimeout(r, 350));
  }

  console.log(`\n\nDone. Embedded: ${processed}, Errors: ${errors}`);
}

main().catch(e => { console.error(`FATAL: ${e}`); process.exit(1); });
