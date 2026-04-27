#!/usr/bin/env bun
/**
 * Pull-Back Sync from Engram
 *
 * Detects thoughts in Engram added by external sources (MCP captures,
 * mobile app, web UI) and materializes them into local memory as
 * markdown files + daily digest.
 *
 * Architecture: Source Exclusion + Markdown materialization.
 * Anti-echo: MEMORY/ENGRAM/ excluded from push script's isBackupTarget().
 *
 * Runs via launchd daily at 05:00 (called from run-meeting-sync.sh).
 *
 * Required env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadEnvFile } from "./lib/env.ts";
import { createSupabaseClient } from "./lib/supabase.ts";

// --- Config ---

const PAI_ROOT = join(process.env.HOME!, ".claude");
const SCRIPT_DIR = join(PAI_ROOT, "engram");
const STATE_DIR = join(SCRIPT_DIR, "state");
const STATE_FILE = join(STATE_DIR, "pull-engram-state.json");
const ENGRAM_DIR = join(PAI_ROOT, "MEMORY/ENGRAM");
const DIGEST_DIR = join(ENGRAM_DIR, "digests");
const BATCH_LIMIT = 50;
const MAX_CONTENT_CHARS = 10_000;

// Sources that sync scripts push — exclude these from pull
const PAI_PUSH_SOURCES = [
  "pai-context-backup",
  "slack-sync",
  "calendar-sync",
  "session-sync",
];

loadEnvFile(join(SCRIPT_DIR, ".env"));

const supabase = createSupabaseClient();

// --- State ---

interface PullState {
  lastPullTimestamp: string; // ISO timestamp of last successful pull
  pulledIds: string[]; // rolling window of already-pulled thought IDs
  totalPulled: number;
}

function getState(): PullState {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
  } catch {
    return { lastPullTimestamp: "", pulledIds: [], totalPulled: 0 };
  }
}

function saveState(state: PullState): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// --- Query ---

interface Thought {
  id: string;
  content: string;
  metadata: Record<string, any>;
  created_at: string;
}

async function fetchExternalThoughts(since: string): Promise<Thought[]> {
  // Query all domain schemas for external thoughts (not from sync push sources)
  const schemas = ["ob_work", "ob_personal", "ob_life", "ob_learning"] as const;
  const allThoughts: Thought[] = [];

  for (const schema of schemas) {
    let query = supabase
      .schema(schema as any)
      .from("thoughts")
      .select("id, content, metadata, created_at")
      .order("created_at", { ascending: true })
      .limit(BATCH_LIMIT);

    // Filter out sync push sources
    for (const source of PAI_PUSH_SOURCES) {
      query = query.neq("metadata->>source", source);
    }

    // Timestamp watermark
    if (since) {
      query = query.gt("created_at", since);
    }

    const { data, error } = await query;

    if (error) {
      console.error(`  Supabase query failed for ${schema}: ${error.message}`);
      continue;
    }

    // Add domain tag to each thought
    for (const t of (data || []) as Thought[]) {
      (t.metadata as any).ob_domain = schema.replace("ob_", "");
      allThoughts.push(t);
    }
  }

  // Sort by created_at ascending, limit
  allThoughts.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  return allThoughts.slice(0, BATCH_LIMIT);
}

// --- Materialization ---

function sanitizeFilename(s: string): string {
  return s.replace(/[^a-zA-Z0-9-_]/g, "-").replace(/-+/g, "-").slice(0, 50);
}

function materializeThought(thought: Thought): string {
  const date = thought.created_at.slice(0, 10);
  const type = thought.metadata?.type || "unknown";
  const id8 = thought.id.slice(0, 8);
  const source = thought.metadata?.source || "unknown";

  const filename = `${date}-${sanitizeFilename(type)}-${id8}.md`;
  const filepath = join(ENGRAM_DIR, filename);

  // Truncate content
  let content = thought.content || "";
  if (content.length > MAX_CONTENT_CHARS) {
    content = content.slice(0, MAX_CONTENT_CHARS) + "\n\n[... truncated at 10K chars ...]";
  }

  // Extract useful metadata
  const topics = thought.metadata?.topics
    ? `\ntopics: [${thought.metadata.topics.join(", ")}]`
    : "";
  const people = thought.metadata?.people
    ? `\npeople: [${thought.metadata.people.join(", ")}]`
    : "";

  const md = `---
id: ${thought.id}
type: ${type}
source: ${source}
created: ${thought.created_at}
pulled: ${new Date().toISOString()}${topics}${people}
---

${content}
`;

  writeFileSync(filepath, md);
  return filename;
}

// --- Digest ---

interface DigestEntry {
  id: string;
  type: string;
  source: string;
  summary: string;
  created: string;
}

function writeDigest(entries: DigestEntry[], date: string): void {
  if (entries.length === 0) return;

  const digestPath = join(DIGEST_DIR, `${date}.md`);

  // Count by type
  const typeCounts: Record<string, number> = {};
  for (const e of entries) {
    typeCounts[e.type] = (typeCounts[e.type] || 0) + 1;
  }

  const typeBreakdown = Object.entries(typeCounts)
    .map(([t, c]) => `- ${t}: ${c}`)
    .join("\n");

  const entryLines = entries
    .map(e => `### ${e.type} (${e.source})\n*${e.created.slice(0, 16)}*\n\n${e.summary}\n`)
    .join("\n---\n\n");

  const digest = `# Engram Pull Digest — ${date}

**Pulled:** ${entries.length} new external thoughts
**Types:**
${typeBreakdown}

---

${entryLines}
`;

  // Append if digest already exists for today, otherwise create
  if (existsSync(digestPath)) {
    const existing = readFileSync(digestPath, "utf-8");
    writeFileSync(digestPath, existing + "\n---\n\n" + entryLines);
  } else {
    writeFileSync(digestPath, digest);
  }
}

function summarizeForDigest(thought: Thought): string {
  const content = thought.content || "";
  // First 200 chars as summary
  const firstLine = content.split("\n").find(l => l.trim() && !l.startsWith("#") && !l.startsWith("---"));
  if (firstLine && firstLine.length > 10) {
    return firstLine.slice(0, 200) + (firstLine.length > 200 ? "..." : "");
  }
  return content.slice(0, 200) + (content.length > 200 ? "..." : "");
}

// --- Main ---

async function main() {
  const state = getState();
  const now = new Date();
  const today = now.toISOString().slice(0, 10);

  console.log(`[${now.toISOString()}] Engram pull-back starting`);
  console.log(`  Last pull: ${state.lastPullTimestamp || "never"}`);
  console.log(`  Total pulled to date: ${state.totalPulled}`);

  // Ensure directories exist
  mkdirSync(ENGRAM_DIR, { recursive: true });
  mkdirSync(DIGEST_DIR, { recursive: true });

  // Fetch external thoughts
  const thoughts = await fetchExternalThoughts(state.lastPullTimestamp);
  console.log(`  Found ${thoughts.length} new external thoughts`);

  if (thoughts.length === 0) {
    console.log("  Nothing to pull.");
    return;
  }

  // Filter out already-pulled IDs (safety net for edge cases)
  const knownIds = new Set(state.pulledIds);
  const newThoughts = thoughts.filter(t => !knownIds.has(t.id));
  console.log(`  After dedup: ${newThoughts.length} truly new`);

  if (newThoughts.length === 0) {
    // Advance watermark even if all were dupes
    const latestTs = thoughts[thoughts.length - 1].created_at;
    saveState({ ...state, lastPullTimestamp: latestTs });
    console.log("  All already pulled (advancing watermark).");
    return;
  }

  let materialized = 0;
  let failed = 0;
  const digestEntries: DigestEntry[] = [];
  const newIds: string[] = [];
  let latestTs = state.lastPullTimestamp;

  for (const thought of newThoughts) {
    try {
      const filename = materializeThought(thought);
      materialized++;
      newIds.push(thought.id);

      digestEntries.push({
        id: thought.id,
        type: thought.metadata?.type || "unknown",
        source: thought.metadata?.source || "unknown",
        summary: summarizeForDigest(thought),
        created: thought.created_at,
      });

      // Track latest timestamp
      if (thought.created_at > latestTs) {
        latestTs = thought.created_at;
      }

      console.log(`  [${materialized}] ${filename}`);
    } catch (err) {
      console.error(`  FAILED (${thought.id.slice(0, 8)}): ${(err as Error).message}`);
      failed++;
    }
  }

  // Write daily digest
  if (digestEntries.length > 0) {
    writeDigest(digestEntries, today);
    console.log(`  Digest written: ${DIGEST_DIR}/${today}.md`);
  }

  // Update state — rolling 1000-entry ID window
  const MAX_IDS = 1000;
  const allIds = [...state.pulledIds, ...newIds].slice(-MAX_IDS);

  saveState({
    lastPullTimestamp: latestTs,
    pulledIds: allIds,
    totalPulled: (state.totalPulled || 0) + materialized,
  });

  console.log(`[${new Date().toISOString()}] Pull-back complete: ${materialized} materialized, ${failed} failed`);
}

main().catch(err => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
