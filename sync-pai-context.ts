#!/usr/bin/env bun
/**
 * Context Backup to Engram
 *
 * Daily diff-based backup of context files to Engram (Supabase + pgvector).
 * Uses git diff to find what changed since last backup, then captures each
 * changed file with semantic embeddings for retrieval.
 *
 * Runs via launchd daily at 07:15.
 *
 * Required env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, relative } from "node:path";
import { createClient } from "@supabase/supabase-js";

// --- Config ---

const CONTEXT_ROOT = join(process.env.HOME!, ".claude");
const STATE_DIR = join(CONTEXT_ROOT, "engram/state");
const STATE_FILE = join(STATE_DIR, "context-backup-state.json");

// Directories to back up (relative to CONTEXT_ROOT)
const BACKUP_PATHS = [
  "MEMORY",
  "CLAUDE.md",
  "skills/*/SKILL.md",
  "agents/*.md",
  "hooks/*.ts",
  "hooks/handlers/*.ts",
  "hooks/lib/*.ts",
];

// File extensions to include
const TEXT_EXTENSIONS = new Set([
  ".md", ".jsonl", ".json", ".yaml", ".yml", ".ts", ".sh", ".txt",
]);

// Max file size to capture (skip huge files)
const MAX_FILE_SIZE = 100_000; // 100KB

// Load env
const envPath = join(CONTEXT_ROOT, "engram/.env");
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
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || "";
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

interface BackupState {
  lastCommit: string;
  lastBackup: string;
  filesBackedUp: number;
}

function getState(): BackupState {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
  } catch {
    return { lastCommit: "", lastBackup: "", filesBackedUp: 0 };
  }
}

function saveState(state: BackupState): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// --- Git ---

function getCurrentCommit(): string {
  try {
    return execSync("git rev-parse HEAD", { cwd: CONTEXT_ROOT, encoding: "utf-8" }).trim();
  } catch {
    return "";
  }
}

function getChangedFiles(sinceCommit: string): { path: string; status: string }[] {
  try {
    let cmd: string;
    if (sinceCommit) {
      // Diff between last backup commit and current working tree (including uncommitted)
      cmd = `git diff --name-status ${sinceCommit} HEAD 2>/dev/null; git diff --name-status HEAD 2>/dev/null`;
    } else {
      // First run: get all tracked text files
      cmd = `git ls-files`;
    }

    const output = execSync(cmd, { cwd: CONTEXT_ROOT, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 });

    if (!sinceCommit) {
      // First run: all files are "added"
      return output.split("\n").filter(Boolean).map(f => ({ path: f, status: "A" }));
    }

    // Parse git diff output: "M\tpath" or "A\tpath" or "D\tpath"
    const seen = new Map<string, string>();
    for (const line of output.split("\n").filter(Boolean)) {
      const parts = line.split("\t");
      if (parts.length >= 2) {
        const status = parts[0].charAt(0); // M, A, D, R, etc.
        const filePath = parts[parts.length - 1]; // Use last part (handles renames)
        seen.set(filePath, status);
      }
    }

    return Array.from(seen.entries()).map(([path, status]) => ({ path, status }));
  } catch (err) {
    console.error(`  Git diff failed: ${(err as Error).message}`);
    return [];
  }
}

function isBackupTarget(filePath: string): boolean {
  // Check extension
  const ext = filePath.substring(filePath.lastIndexOf("."));
  if (!TEXT_EXTENSIONS.has(ext)) return false;

  // Check if it's in a backup path
  // Exclude MEMORY/ENGRAM/ — these are pulled FROM Engram DB, not pushed TO it (anti-echo)
  if (filePath.startsWith("MEMORY/ENGRAM/")) return false;
  if (filePath.startsWith("MEMORY/")) return true;
  if (filePath === "CLAUDE.md") return true;
  if (filePath.match(/^skills\/[^/]+\/SKILL\.md$/)) return true;
  if (filePath.match(/^agents\/.*\.md$/)) return true;
  if (filePath.match(/^hooks\/.*\.ts$/)) return true;

  return false;
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

// --- Capture ---

function categorize(filePath: string): string {
  if (filePath.startsWith("MEMORY/WORK/meetings/")) return "meeting-note";
  if (filePath.startsWith("MEMORY/WORK/")) return "work-context";
  if (filePath.startsWith("MEMORY/PEOPLE/")) return "person-context";
  if (filePath.startsWith("MEMORY/LEARNING/")) return "learning";
  if (filePath.startsWith("MEMORY/LIFE/")) return "life-event";
  if (filePath.startsWith("MEMORY/STATE/")) return "system-state";
  if (filePath.startsWith("MEMORY/RESEARCH/")) return "research";
  if (filePath.startsWith("MEMORY/OKR/")) return "okr";
  if (filePath.startsWith("skills/")) return "skill-definition";
  if (filePath.startsWith("agents/")) return "agent-definition";
  if (filePath.startsWith("hooks/")) return "hook-code";
  if (filePath === "CLAUDE.md") return "system-config";
  return "pai-context";
}

async function captureFile(
  filePath: string,
  changeType: string,
  backupDate: string
): Promise<boolean> {
  const fullPath = join(CONTEXT_ROOT, filePath);

  // For deletions, just record the deletion
  if (changeType === "D") {
    const content = `[DELETED] ${filePath}\n\nThis file was deleted on ${backupDate}.`;
    try {
      const embedding = await getEmbedding(content);
      const { error } = await supabase.schema(DOMAIN as any).from("thoughts").insert({
        content,
        embedding,
        metadata: {
          type: categorize(filePath),
          source: "pai-context-backup",
          file_path: filePath,
          change_type: "deleted",
          backup_date: backupDate,
        },
      });
      if (error) throw error;
      return true;
    } catch (err) {
      console.error(`    FAILED (delete record): ${(err as Error).message}`);
      return false;
    }
  }

  // Read file content
  if (!existsSync(fullPath)) return false;

  let content: string;
  try {
    const stat = Bun.file(fullPath);
    if (stat.size > MAX_FILE_SIZE) {
      console.log(`    SKIP (too large: ${Math.round(stat.size / 1024)}KB): ${filePath}`);
      return false;
    }
    content = readFileSync(fullPath, "utf-8");
  } catch {
    return false;
  }

  if (content.trim().length < 10) return false;

  // Prefix with file path for context
  const captureContent = `# ${filePath}\n\n${content}`;

  try {
    const embedding = await getEmbedding(captureContent);

    // Upsert: delete previous version of this file, insert new
    await supabase
      .schema(DOMAIN as any)
      .from("thoughts")
      .delete()
      .eq("metadata->>file_path", filePath)
      .eq("metadata->>source", "pai-context-backup");

    const { error } = await supabase.schema(DOMAIN as any).from("thoughts").insert({
      content: captureContent,
      embedding,
      metadata: {
        type: categorize(filePath),
        source: "pai-context-backup",
        file_path: filePath,
        change_type: changeType === "A" ? "added" : "modified",
        backup_date: backupDate,
        content_length: content.length,
      },
    });

    if (error) throw error;
    return true;
  } catch (err) {
    console.error(`    FAILED: ${(err as Error).message}`);
    return false;
  }
}

// --- Main ---

async function main() {
  const state = getState();
  const currentCommit = getCurrentCommit();
  const backupDate = new Date().toISOString().slice(0, 10);

  console.log(`[${new Date().toISOString()}] PAI Context Backup starting`);
  console.log(`  Last backup: ${state.lastBackup || "never"}`);
  console.log(`  Last commit: ${state.lastCommit?.slice(0, 8) || "none"}`);
  console.log(`  Current commit: ${currentCommit.slice(0, 8)}`);

  // Get changed files
  const allChanges = getChangedFiles(state.lastCommit);
  const targetChanges = allChanges.filter(f => isBackupTarget(f.path));

  console.log(`  Total changes: ${allChanges.length}, backup targets: ${targetChanges.length}`);

  if (targetChanges.length === 0) {
    console.log("  No changes to back up.");
    saveState({ lastCommit: currentCommit, lastBackup: backupDate, filesBackedUp: state.filesBackedUp });
    console.log(`[${new Date().toISOString()}] Backup complete: 0 files`);
    return;
  }

  // Prioritize: important context first, learning signals last
  const priority = (f: string) => {
    if (f === "CLAUDE.md") return 0;
    if (f.startsWith("MEMORY/PEOPLE/")) return 1;
    if (f.startsWith("MEMORY/WORK/meetings/")) return 2;
    if (f.startsWith("MEMORY/WORK/employer/")) return 3;
    if (f.startsWith("MEMORY/WORK/")) return 4;
    if (f.startsWith("MEMORY/OKR/")) return 4;
    if (f.startsWith("MEMORY/LIFE/")) return 5;
    if (f.startsWith("MEMORY/RESEARCH/")) return 6;
    if (f.startsWith("skills/")) return 7;
    if (f.startsWith("agents/")) return 7;
    if (f.startsWith("hooks/")) return 8;
    if (f.startsWith("MEMORY/LEARNING/")) return 9; // bulk signals last
    return 10;
  };
  targetChanges.sort((a, b) => priority(a.path) - priority(b.path));

  // First run: 200 files. Daily diffs: 50 files max.
  const isFirstRun = !state.lastCommit;
  const batchSize = isFirstRun ? 200 : 50;
  const batch = targetChanges.slice(0, batchSize);
  if (targetChanges.length > batchSize) {
    console.log(`  Processing ${batchSize} of ${targetChanges.length} changes (remainder queued for next run)`);
  }

  let captured = 0;
  let failed = 0;

  for (let i = 0; i < batch.length; i++) {
    const { path: filePath, status } = batch[i];
    const changeLabel = status === "A" ? "ADD" : status === "D" ? "DEL" : "MOD";
    console.log(`  [${i + 1}/${batch.length}] ${changeLabel}: ${filePath}`);

    const ok = await captureFile(filePath, status, backupDate);
    if (ok) {
      captured++;
    } else {
      failed++;
    }

    // Rate limit: 200ms between API calls
    if (i < batch.length - 1) await new Promise(r => setTimeout(r, 200));
  }

  // Only advance the commit pointer when all changes are processed
  const allProcessed = targetChanges.length <= batchSize;
  saveState({
    lastCommit: allProcessed ? currentCommit : state.lastCommit || "",
    lastBackup: backupDate,
    filesBackedUp: (state.filesBackedUp || 0) + captured,
  });

  console.log(`[${new Date().toISOString()}] Backup complete: ${captured} captured, ${failed} failed, ${batch.length} processed`);
  if (targetChanges.length > 50) {
    console.log(`  ${targetChanges.length - 50} files remaining for next run`);
  }
}

main().catch(err => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
