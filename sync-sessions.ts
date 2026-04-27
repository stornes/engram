#!/usr/bin/env bun
/**
 * Claude Code Session Transcript Sync to Engram
 *
 * Finds recently modified .jsonl session transcripts, extracts user+assistant
 * messages, and inserts a summary as thoughts with semantic embeddings.
 *
 * Runs via launchd daily at 07:15 (called from run-meeting-sync.sh).
 *
 * Required env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY
 */

import { readFileSync, writeFileSync, mkdirSync, statSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { createClient } from "@supabase/supabase-js";

// --- Config ---

const SCRIPT_DIR = join(process.env.HOME!, ".claude/engram");
const STATE_DIR = join(SCRIPT_DIR, "state");
const STATE_FILE = join(STATE_DIR, "sessions-sync-state.json");
const PROJECTS_DIR = join(process.env.HOME!, ".claude/projects");
const BATCH_LIMIT = 20; // max sessions per run
const LOOKBACK_HOURS = 26; // slightly more than 24h
const SUMMARY_CHARS = 2000; // chars from start + end of extracted messages

// Load env
const envPath = join(SCRIPT_DIR, ".env");
try {
  const envContent = readFileSync(envPath, "utf-8");
  for (const line of envContent.split("\n")) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match) {
      const key = match[1].trim();
      const val = match[2].trim();
      if (!process.env[key]) process.env[key] = val;
    }
  }
} catch {}

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const OPENAI_KEY = process.env.OPENAI_API_KEY || "";

if (!SUPABASE_KEY || !OPENAI_KEY) {
  console.error("Missing SUPABASE_SERVICE_ROLE_KEY or OPENAI_API_KEY");
  process.exit(1);
}

const VALID_DOMAINS = ["ob_work", "ob_personal", "ob_life", "ob_learning"] as const;
type Domain = (typeof VALID_DOMAINS)[number];
const DOMAIN: Domain = (process.env.ENGRAM_DOMAIN as Domain) || "ob_learning";
if (!VALID_DOMAINS.includes(DOMAIN)) {
  console.error(`Invalid ENGRAM_DOMAIN '${DOMAIN}'. Must be one of: ${VALID_DOMAINS.join(", ")}`);
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// --- State ---

interface SessionSyncState {
  lastSync: string;
  syncedFiles: Record<string, number>; // filepath -> mtime (epoch ms)
  sessionsSynced: number;
}

function getState(): SessionSyncState {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
  } catch {
    return { lastSync: "", syncedFiles: {}, sessionsSynced: 0 };
  }
}

function saveState(state: SessionSyncState): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// --- Session Extraction ---

interface SessionMessage {
  role: "user" | "assistant";
  text: string;
  timestamp: string;
}

function extractMessages(filePath: string): SessionMessage[] {
  const messages: SessionMessage[] = [];

  try {
    const content = readFileSync(filePath, "utf-8");
    const lines = content.split("\n").filter(Boolean);

    for (const line of lines) {
      try {
        const obj = JSON.parse(line);

        if (obj.type === "user" && obj.message?.content) {
          const text =
            typeof obj.message.content === "string"
              ? obj.message.content
              : Array.isArray(obj.message.content)
                ? obj.message.content
                    .filter((b: any) => b.type === "text")
                    .map((b: any) => b.text)
                    .join("\n")
                : "";

          if (text.trim()) {
            messages.push({
              role: "user",
              text: text.trim(),
              timestamp: obj.timestamp || "",
            });
          }
        }

        if (obj.type === "assistant" && obj.message?.content) {
          const content = obj.message.content;
          let text = "";

          if (typeof content === "string") {
            text = content;
          } else if (Array.isArray(content)) {
            text = content
              .filter((b: any) => b.type === "text")
              .map((b: any) => b.text)
              .join("\n");
          }

          if (text.trim()) {
            messages.push({
              role: "assistant",
              text: text.trim(),
              timestamp: obj.timestamp || "",
            });
          }
        }
      } catch {
        // Skip malformed lines
      }
    }
  } catch (err) {
    console.error(`  Failed to read ${filePath}: ${(err as Error).message}`);
  }

  return messages;
}

function summarizeSession(messages: SessionMessage[], filePath: string): string {
  if (messages.length === 0) return "";

  // Build a condensed view: first N chars + last N chars of conversation
  const fullText = messages
    .map(m => `[${m.role}]: ${m.text}`)
    .join("\n\n");

  const sessionId = basename(filePath, ".jsonl");
  const projectDir = basename(join(filePath, ".."));
  const firstTs = messages[0]?.timestamp || "";
  const lastTs = messages[messages.length - 1]?.timestamp || "";

  // Get user messages for topic extraction
  const userMessages = messages
    .filter(m => m.role === "user")
    .map(m => m.text)
    .join(" | ");

  let summary: string;
  if (fullText.length <= SUMMARY_CHARS * 2) {
    summary = fullText;
  } else {
    // First SUMMARY_CHARS + last SUMMARY_CHARS
    const head = fullText.slice(0, SUMMARY_CHARS);
    const tail = fullText.slice(-SUMMARY_CHARS);
    summary = `${head}\n\n[... ${messages.length} messages total ...]\n\n${tail}`;
  }

  return `# Session Transcript: ${sessionId}\n\n**Project:** ${projectDir}\n**Started:** ${firstTs}\n**Ended:** ${lastTs}\n**Messages:** ${messages.length} (${messages.filter(m => m.role === "user").length} user, ${messages.filter(m => m.role === "assistant").length} assistant)\n**User topics:** ${userMessages.slice(0, 500)}\n\n---\n\n${summary}`;
}

// --- Find Recent Sessions ---

function findRecentSessions(cutoffMs: number): { path: string; mtime: number }[] {
  const results: { path: string; mtime: number }[] = [];

  try {
    const projectDirs = readdirSync(PROJECTS_DIR);

    for (const dir of projectDirs) {
      const projectPath = join(PROJECTS_DIR, dir);
      try {
        const stat = statSync(projectPath);
        if (!stat.isDirectory()) continue;

        const files = readdirSync(projectPath);
        for (const file of files) {
          if (!file.endsWith(".jsonl")) continue;
          const filePath = join(projectPath, file);
          try {
            const fstat = statSync(filePath);
            if (fstat.mtimeMs >= cutoffMs && fstat.size > 1000) {
              results.push({ path: filePath, mtime: fstat.mtimeMs });
            }
          } catch {}
        }
      } catch {}
    }
  } catch (err) {
    console.error(`  Failed to scan projects: ${(err as Error).message}`);
  }

  // Sort by mtime descending (most recent first)
  results.sort((a, b) => b.mtime - a.mtime);
  return results;
}

// --- OpenAI ---

async function getEmbedding(text: string): Promise<number[]> {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "text-embedding-3-small", input: text.slice(0, 8000) }),
  });
  const data = await res.json();
  if (!data.data?.[0]?.embedding) throw new Error(`Embedding failed: ${JSON.stringify(data)}`);
  return data.data[0].embedding;
}

// --- Main ---

async function main() {
  const state = getState();
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const cutoffMs = now.getTime() - LOOKBACK_HOURS * 60 * 60 * 1000;

  console.log(`[${now.toISOString()}] Session sync starting`);
  console.log(`  Last sync: ${state.lastSync || "never"}`);
  console.log(`  Lookback: ${LOOKBACK_HOURS}h`);

  // Find recently modified session files
  const recentSessions = findRecentSessions(cutoffMs);
  console.log(`  Found ${recentSessions.length} recently modified session files`);

  // Filter out already-synced files (same mtime = no changes)
  const newSessions = recentSessions.filter(s => {
    const previousMtime = state.syncedFiles[s.path];
    return !previousMtime || s.mtime > previousMtime;
  });

  console.log(`  New/modified sessions: ${newSessions.length}`);

  if (newSessions.length === 0) {
    console.log("  No new sessions to sync.");
    saveState({ ...state, lastSync: today });
    return;
  }

  // Batch limit
  const batch = newSessions.slice(0, BATCH_LIMIT);
  let captured = 0;
  let failed = 0;

  for (let i = 0; i < batch.length; i++) {
    const { path: filePath, mtime } = batch[i];
    const sessionId = basename(filePath, ".jsonl");
    const projectDir = basename(join(filePath, ".."));

    console.log(`  [${i + 1}/${batch.length}] ${projectDir}/${sessionId.slice(0, 8)}...`);

    const messages = extractMessages(filePath);
    if (messages.length < 2) {
      console.log(`    Skip: only ${messages.length} messages`);
      state.syncedFiles[filePath] = mtime;
      continue;
    }

    const summary = summarizeSession(messages, filePath);
    if (!summary) {
      state.syncedFiles[filePath] = mtime;
      continue;
    }

    try {
      const embedding = await getEmbedding(summary);

      // Upsert: delete previous version of this session
      await supabase
        .schema(DOMAIN as any)
        .from("thoughts")
        .delete()
        .eq("metadata->>session_id", sessionId)
        .eq("metadata->>source", "session-sync");

      const { error } = await supabase.schema(DOMAIN as any).from("thoughts").insert({
        content: summary,
        embedding,
        metadata: {
          type: "session-transcript",
          source: "session-sync",
          session_id: sessionId,
          project: projectDir,
          message_count: messages.length,
          user_message_count: messages.filter(m => m.role === "user").length,
          first_timestamp: messages[0]?.timestamp || "",
          last_timestamp: messages[messages.length - 1]?.timestamp || "",
          sync_date: today,
        },
      });

      if (error) throw error;
      captured++;
      state.syncedFiles[filePath] = mtime;
    } catch (err) {
      console.error(`    FAILED: ${(err as Error).message}`);
      failed++;
    }

    // Rate limit
    await new Promise(r => setTimeout(r, 200));
  }

  // Clean up old entries from syncedFiles (keep only last 7 days worth)
  const cleanupCutoff = now.getTime() - 7 * 24 * 60 * 60 * 1000;
  for (const [path, mtime] of Object.entries(state.syncedFiles)) {
    if (mtime < cleanupCutoff) {
      delete state.syncedFiles[path];
    }
  }

  state.lastSync = today;
  state.sessionsSynced = (state.sessionsSynced || 0) + captured;
  saveState(state);

  console.log(`[${new Date().toISOString()}] Session sync complete: ${captured} captured, ${failed} failed`);
}

main().catch(err => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
