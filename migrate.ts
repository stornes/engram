#!/usr/bin/env bun
/**
 * Engram Migration Script
 *
 * Reads all markdown files from ~/.claude/MEMORY/ and ingests them
 * as thoughts with auto-extracted metadata and embeddings.
 *
 * Usage: SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... OPENAI_API_KEY=... bun run migrate.ts
 *
 * Options:
 *   --dry-run     Show what would be migrated without writing
 *   --limit N     Only migrate first N files
 *   --dir PATH    Override memory directory (default: ~/.claude/MEMORY)
 */

import { createClient } from "@supabase/supabase-js";
import { readdir, readFile, stat } from "fs/promises";
import { join, relative, extname, basename } from "path";

const SUPABASE_URL =
  process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const OPENAI_KEY = process.env.OPENAI_API_KEY || "";
const MEMORY_DIR = process.argv.includes("--dir")
  ? process.argv[process.argv.indexOf("--dir") + 1]
  : join(process.env.HOME!, ".claude", "MEMORY");
const DRY_RUN = process.argv.includes("--dry-run");
const LIMIT = process.argv.includes("--limit")
  ? parseInt(process.argv[process.argv.indexOf("--limit") + 1])
  : Infinity;

if (!SUPABASE_KEY && !DRY_RUN) {
  console.error("Error: SUPABASE_SERVICE_ROLE_KEY required (unless --dry-run)");
  process.exit(1);
}
if (!OPENAI_KEY && !DRY_RUN) {
  console.error("Error: OPENAI_API_KEY required (unless --dry-run)");
  process.exit(1);
}

const supabase = DRY_RUN ? null : createClient(SUPABASE_URL, SUPABASE_KEY);

// --- Collect all markdown and JSONL files ---
async function collectFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip STATE, VOICE, .DS_Store
      if (["STATE", "VOICE", ".DS_Store", "node_modules"].includes(entry.name))
        continue;
      files.push(...(await collectFiles(fullPath)));
    } else if (extname(entry.name) === ".md") {
      // Skip index files and READMEs
      if (
        entry.name === "README.md" ||
        entry.name === "_index.md" ||
        entry.name === "MEMORY.md"
      )
        continue;
      files.push(fullPath);
    }
  }
  return files;
}

// --- Determine thought type from path ---
function inferType(
  relPath: string
): string {
  if (relPath.startsWith("PEOPLE/")) return "person_note";
  if (relPath.startsWith("LEARNING/ALGORITHM/")) return "learning";
  if (relPath.startsWith("LEARNING/SYSTEM/")) return "learning";
  if (relPath.startsWith("LEARNING/REFLECTIONS/")) return "learning";
  if (relPath.startsWith("LEARNING/SYNTHESIS/")) return "observation";
  if (relPath.startsWith("RESEARCH/")) return "reference";
  if (relPath.startsWith("WORK/") && relPath.includes("meetings/"))
    return "meeting";
  if (relPath.startsWith("WORK/") && relPath.includes("email/"))
    return "reference";
  if (relPath.startsWith("WORK/") && relPath.endsWith("PRD.md"))
    return "task";
  if (relPath.startsWith("WORK/")) return "observation";
  if (relPath.startsWith("SECURITY/")) return "reference";
  if (relPath.startsWith("LIFE/")) return "observation";
  return "observation";
}

// --- Extract people from content ---
function extractPeopleFromPath(relPath: string): string[] {
  if (relPath.startsWith("PEOPLE/")) {
    const name = basename(relPath, ".md")
      .split("-")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
    return [name];
  }
  return [];
}

// --- Get embedding ---
async function getEmbedding(text: string): Promise<number[]> {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "text-embedding-3-small",
      input: text.slice(0, 8000),
    }),
  });
  if (!res.ok) {
    throw new Error(`Embedding API error: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return data.data[0].embedding;
}

// --- Extract metadata via LLM ---
async function extractMetadata(
  content: string,
  relPath: string
): Promise<Record<string, unknown>> {
  const inferredType = inferType(relPath);
  const inferredPeople = extractPeopleFromPath(relPath);

  // For short files or JSONL entries, skip LLM extraction
  if (content.length < 50) {
    return {
      type: inferredType,
      topics: [],
      people: inferredPeople,
      action_items: [],
      source: "migration",
      original_path: relPath,
    };
  }

  try {
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
            content: `Extract metadata from this note. Return JSON:
- "type": "${inferredType}" (use this default unless clearly wrong)
- "topics": array of 1-3 topic tags (lowercase)
- "people": array of people mentioned
- "action_items": array of tasks (empty if none)
- "dates_mentioned": array of YYYY-MM-DD dates (empty if none)
Only extract what actually exists. Do not invent.`,
          },
          { role: "user", content: content.slice(0, 4000) },
        ],
      }),
    });
    const data = await res.json();
    const extracted = JSON.parse(data.choices[0].message.content);
    return {
      ...extracted,
      people: [
        ...new Set([...inferredPeople, ...(extracted.people || [])]),
      ],
      source: "migration",
      original_path: relPath,
    };
  } catch {
    return {
      type: inferredType,
      topics: [],
      people: inferredPeople,
      source: "migration",
      original_path: relPath,
    };
  }
}

// --- Parse JSONL files into individual entries ---
function parseFile(
  content: string,
  filePath: string
): { content: string; relPath: string }[] {
  const relPath = relative(MEMORY_DIR, filePath);
  if (extname(filePath) === ".jsonl") {
    return content
      .split("\n")
      .filter((line) => line.trim())
      .map((line, i) => {
        try {
          const obj = JSON.parse(line);
          // Create readable content from JSONL
          const readable = Object.entries(obj)
            .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
            .join("\n");
          return { content: readable, relPath: `${relPath}#line${i + 1}` };
        } catch {
          return { content: line, relPath: `${relPath}#line${i + 1}` };
        }
      });
  }
  return [{ content, relPath }];
}

// --- Main ---
async function main() {
  console.log(`Engram Migration`);
  console.log(`Memory dir: ${MEMORY_DIR}`);
  console.log(`Supabase: ${SUPABASE_URL}`);
  console.log(`Dry run: ${DRY_RUN}`);
  console.log();

  const files = await collectFiles(MEMORY_DIR);
  console.log(`Found ${files.length} files`);

  let entries: { content: string; relPath: string }[] = [];
  for (const file of files) {
    const content = await readFile(file, "utf-8");
    if (!content.trim()) continue;
    entries.push(...parseFile(content, file));
  }

  console.log(`Parsed into ${entries.length} thought entries`);

  if (LIMIT < entries.length) {
    entries = entries.slice(0, LIMIT);
    console.log(`Limited to ${LIMIT} entries`);
  }

  if (DRY_RUN) {
    console.log("\n--- DRY RUN ---");
    const typeCounts: Record<string, number> = {};
    for (const entry of entries) {
      const type = inferType(entry.relPath);
      typeCounts[type] = (typeCounts[type] || 0) + 1;
    }
    console.log("Type distribution:");
    for (const [type, count] of Object.entries(typeCounts).sort(
      (a, b) => b[1] - a[1]
    )) {
      console.log(`  ${type}: ${count}`);
    }
    console.log(`\nEstimated embedding cost: ~$${(entries.length * 0.00002).toFixed(4)}`);
    return;
  }

  // Batch process
  const BATCH_SIZE = 5;
  let success = 0;
  let failed = 0;

  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    const batch = entries.slice(i, i + BATCH_SIZE);
    const promises = batch.map(async (entry) => {
      try {
        const [embedding, metadata] = await Promise.all([
          getEmbedding(entry.content),
          extractMetadata(entry.content, entry.relPath),
        ]);

        const { error } = await supabase!.from("thoughts").insert({
          content: entry.content,
          embedding,
          metadata,
        });

        if (error) throw error;
        return true;
      } catch (e) {
        console.error(`Failed: ${entry.relPath}: ${(e as Error).message}`);
        return false;
      }
    });

    const results = await Promise.all(promises);
    success += results.filter(Boolean).length;
    failed += results.filter((r) => !r).length;

    const pct = Math.round(((i + batch.length) / entries.length) * 100);
    process.stdout.write(
      `\rProgress: ${i + batch.length}/${entries.length} (${pct}%) | OK: ${success} | Failed: ${failed}`
    );

    // Rate limit: ~10 req/s to OpenAI
    if (i + BATCH_SIZE < entries.length) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  console.log(`\n\nMigration complete!`);
  console.log(`  Success: ${success}`);
  console.log(`  Failed: ${failed}`);
  console.log(`  Total: ${entries.length}`);
}

main().catch(console.error);
