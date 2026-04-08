#!/usr/bin/env bun
/**
 * Notion → Engram Meeting Sync
 *
 * Fetches AI meeting notes from Notion, extracts transcription blocks
 * (summary + action items), builds metadata directly from structured
 * Notion data (zero LLM calls), generates 1024d embeddings, and inserts
 * into Supabase thoughts table.
 *
 * Runs via launchd daily at 07:15 (after existing Notion → markdown sync).
 *
 * Required env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY
 * Notion token: extracted from ~/.claude.json mcpServers config or NOTION_TOKEN env
 *
 * Usage:
 *   bun run sync-notion-meetings.ts              # incremental sync
 *   bun run sync-notion-meetings.ts --test       # test against known page
 *   bun run sync-notion-meetings.ts --dry-run    # discover without inserting
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

// ─── Config ──────────────────────────────────────────────────────────────────

const DATABASE_ID = "YOUR_NOTION_DATABASE_ID";
// Database queries require older API version; block children (transcription) need newer version
const NOTION_API_DB = "2022-06-28";
const NOTION_API_BLOCKS = "2025-09-03";
const STATE_DIR = `${process.env.HOME}/.claude/engram/state`;
const STATE_FILE = `${STATE_DIR}/meeting-sync-last.json`;
const TEST_PAGE_ID = "YOUR_TEST_PAGE_ID";

// ─── Env loading ─────────────────────────────────────────────────────────────

const envPath = `${process.env.HOME}/.claude/engram/.env`;
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

if (!SUPABASE_URL || !SUPABASE_KEY || !OPENAI_KEY) {
  console.error("Missing SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, or OPENAI_API_KEY");
  process.exit(1);
}

// ─── Notion Token ────────────────────────────────────────────────────────────

function getNotionToken(): string {
  if (process.env.NOTION_TOKEN) return process.env.NOTION_TOKEN;
  try {
    const config = JSON.parse(readFileSync(`${process.env.HOME}/.claude.json`, "utf-8"));
    const headers = JSON.parse(config.mcpServers?.notion_local?.env?.OPENAPI_MCP_HEADERS || "{}");
    const auth = headers.Authorization as string;
    if (auth?.startsWith("Bearer ")) return auth.slice(7);
  } catch {}
  throw new Error("No Notion token found (set NOTION_TOKEN or configure ~/.claude.json)");
}

function notionHeaders(token: string, apiVersion: string = NOTION_API_BLOCKS) {
  return {
    Authorization: `Bearer ${token}`,
    "Notion-Version": apiVersion,
    "Content-Type": "application/json",
  };
}

// ─── Checkpoint ──────────────────────────────────────────────────────────────

function getLastSync(): string {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf-8")).lastSync;
  } catch {
    return "2026-01-01T00:00:00.000Z";
  }
}

function saveLastSync(ts: string): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify({ lastSync: ts, updatedAt: new Date().toISOString() }, null, 2));
}

// ─── Notion API helpers ──────────────────────────────────────────────────────

async function fetchAllBlocks(token: string, blockId: string): Promise<any[]> {
  const allBlocks: any[] = [];
  let cursor: string | undefined;
  do {
    const url = new URL(`https://api.notion.com/v1/blocks/${blockId}/children`);
    url.searchParams.set("page_size", "100");
    if (cursor) url.searchParams.set("start_cursor", cursor);

    const res = await fetch(url.toString(), { headers: notionHeaders(token) });
    if (!res.ok) {
      const text = await res.text();
      if (res.status === 429) {
        const retryAfter = parseInt(res.headers.get("retry-after") || "2", 10);
        console.log(`  Rate limited, waiting ${retryAfter}s...`);
        await new Promise(r => setTimeout(r, retryAfter * 1000));
        continue;
      }
      throw new Error(`Notion API ${res.status}: ${text}`);
    }

    const data = await res.json();
    allBlocks.push(...data.results);
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return allBlocks;
}

// ─── Transcription extraction ────────────────────────────────────────────────

interface TranscriptionBlock {
  title: string;
  status: string;
  startTime: string | null;
  summaryBlockId: string;
  notesBlockId: string;
  transcriptBlockId: string;
}

async function getTranscriptionBlock(token: string, pageId: string): Promise<TranscriptionBlock | null> {
  const blocks = await fetchAllBlocks(token, pageId);
  const tb = blocks.find((b: any) => b.type === "transcription");
  if (!tb) return null;

  return {
    title: tb.transcription.title?.map((t: any) => t.plain_text).join("") || "",
    status: tb.transcription.status || "",
    startTime: tb.transcription.recording?.start_time || null,
    summaryBlockId: tb.transcription.children?.summary_block_id || "",
    notesBlockId: tb.transcription.children?.notes_block_id || "",
    transcriptBlockId: tb.transcription.children?.transcript_block_id || "",
  };
}

// ─── Summary + Action Items ─────────────────────────────────────────────────

interface ActionItem {
  text: string;
  owner: string;
  checked: boolean;
}

interface SummaryResult {
  sections: string[];
  actions: ActionItem[];
  people: string[];
}

async function getSummaryAndActions(token: string, summaryBlockId: string): Promise<SummaryResult> {
  const blocks = await fetchAllBlocks(token, summaryBlockId);
  const sections: string[] = [];
  const actions: ActionItem[] = [];
  const people = new Set<string>();

  for (const block of blocks) {
    if (block.type === "heading_3") {
      sections.push(`### ${block.heading_3.rich_text.map((t: any) => t.plain_text).join("")}`);
    } else if (block.type === "to_do") {
      const text = block.to_do.rich_text.map((t: any) => t.plain_text).join("");
      const mentions = block.to_do.rich_text
        .filter((t: any) => t.type === "mention" && t.mention?.type === "user")
        .map((t: any) => t.mention.user.name);
      for (const name of mentions) people.add(name);
      const owner = mentions.join(", ") || "Unassigned";
      actions.push({ text, owner, checked: block.to_do.checked });
    } else if (block.type === "paragraph") {
      const text = block.paragraph.rich_text.map((t: any) => t.plain_text).join("");
      if (text) sections.push(text);
      // Extract @mentions from paragraphs too
      for (const rt of block.paragraph.rich_text) {
        if (rt.type === "mention" && rt.mention?.type === "user" && rt.mention.user?.name) {
          people.add(rt.mention.user.name);
        }
      }
    } else if (block.type === "bulleted_list_item") {
      const text = block.bulleted_list_item.rich_text.map((t: any) => t.plain_text).join("");
      if (text) sections.push(`- ${text}`);
    }
  }

  return { sections, actions, people: [...people] };
}

// ─── Topic derivation (no AI) ───────────────────────────────────────────────

function deriveTopics(title: string): string[] {
  const lower = title.toLowerCase();
  const topics: string[] = [];
  // Add your own topic detection patterns here
  const patterns: [RegExp, string][] = [
    [/budget|cost|finance/i, "budget"],
    [/training/i, "training"],
    [/risk/i, "risk-management"],
    [/weekly|bi-weekly|status/i, "status-meeting"],
    [/planning/i, "planning"],
    // Add project-specific patterns:
    // [/your-project/i, "your-project"],
  ];
  for (const [regex, topic] of patterns) {
    if (regex.test(lower)) topics.push(topic);
  }
  return topics.length > 0 ? topics.slice(0, 3) : ["general"];
}

// ─── Slug generation ─────────────────────────────────────────────────────────

function generateSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

// ─── Embedding (1024d, text-embedding-3-small) ──────────────────────────────

async function getEmbedding(text: string): Promise<number[]> {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "text-embedding-3-small",
      input: text.slice(0, 8000),
      dimensions: 1024,
    }),
  });
  const data = await res.json();
  if (!data.data?.[0]?.embedding) throw new Error(`Embedding failed: ${JSON.stringify(data)}`);
  return data.data[0].embedding;
}

// ─── Deduplication ──────────────────────────────────────────────────────────

async function getExistingNotionPageIds(): Promise<Set<string>> {
  const ids = new Set<string>();
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/thoughts?metadata->>source=eq.notion-sync&metadata->>type=eq.meeting&select=metadata`,
    {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "Accept-Profile": "ob_work",
      },
    }
  );
  if (res.ok) {
    const rows = await res.json();
    for (const row of rows) {
      const pid = row.metadata?.notion_page_id;
      if (pid) ids.add(pid);
    }
  }
  return ids;
}

// ─── Compose markdown ───────────────────────────────────────────────────────

function composeMarkdown(
  title: string,
  date: string,
  time: string,
  pageId: string,
  attendees: string[],
  sections: string[],
  actions: ActionItem[],
): string {
  const actionTable = actions.length > 0
    ? `\n## Action Items\n| Action | Owner | Status |\n|--------|-------|--------|\n` +
      actions.map(a =>
        `| ${a.text.replace(/\|/g, "\\|")} | ${a.owner} | ${a.checked ? "DONE" : "PENDING"} |`
      ).join("\n")
    : "";

  return `# ${title} - ${date}

## Metadata
- **Date:** ${date}
- **Time:** ${time}
- **Type:** AI Meeting Notes
- **Notion ID:** ${pageId}
- **Attendees:** ${attendees.join(", ") || "Unknown"}
- **Fetched:** ${new Date().toISOString().split("T")[0]}

## Summary
${sections.join("\n")}
${actionTable}
`.trim() + "\n";
}

// ─── Supabase direct insert ─────────────────────────────────────────────────

async function insertToEngram(
  content: string,
  embedding: number[],
  metadata: Record<string, unknown>,
): Promise<string> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/thoughts`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      "Accept-Profile": "ob_work",
      "Content-Profile": "ob_work",
    },
    body: JSON.stringify({ content, embedding, metadata }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase insert failed (${res.status}): ${text}`);
  }

  const [row] = await res.json();
  return row.id;
}

// ─── Discovery ──────────────────────────────────────────────────────────────

interface DiscoveredMeeting {
  pageId: string;
  title: string;
  date: string | null;
  attendees: string[];
  createdTime: string;
}

async function discoverMeetings(token: string, afterTimestamp: string): Promise<DiscoveredMeeting[]> {
  const meetings: DiscoveredMeeting[] = [];
  let cursor: string | undefined;

  do {
    const body: any = {
      filter: { timestamp: "created_time", created_time: { after: afterTimestamp } },
      sorts: [{ timestamp: "created_time", direction: "ascending" }],
      page_size: 100,
    };
    if (cursor) body.start_cursor = cursor;

    const res = await fetch(
      `https://api.notion.com/v1/databases/${DATABASE_ID}/query`,
      { method: "POST", headers: notionHeaders(token, NOTION_API_DB), body: JSON.stringify(body) }
    );

    if (!res.ok) {
      const text = await res.text();
      if (res.status === 401) {
        console.error("  ERROR: Notion token expired (401 Unauthorized). Regenerate token.");
        process.exit(2);
      }
      console.error(`  Notion query failed (${res.status}): ${text}`);
      break;
    }

    const data = await res.json();

    for (const page of data.results) {
      const props = page.properties;
      const title = props?.["Meeting Title"]?.title?.map((t: any) => t.plain_text).join("") || "";
      const date = props?.["Meeting Date"]?.date?.start?.slice(0, 10) || null;
      const attendees = props?.["Attendees"]?.multi_select?.map((a: any) => a.name) || [];

      meetings.push({
        pageId: page.id,
        title,
        date,
        attendees,
        createdTime: page.created_time,
      });
    }

    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);

  return meetings;
}

// ─── Process one meeting ────────────────────────────────────────────────────

async function processMeeting(
  token: string,
  meeting: DiscoveredMeeting,
  dryRun: boolean,
): Promise<boolean> {
  // Step 1: Get transcription block
  const tb = await getTranscriptionBlock(token, meeting.pageId);
  if (!tb) {
    console.log(`    SKIP: No transcription block`);
    return false;
  }
  if (tb.status !== "notes_ready") {
    console.log(`    SKIP: Status "${tb.status}" (not notes_ready)`);
    return false;
  }
  if (!tb.summaryBlockId) {
    console.log(`    SKIP: No summary block`);
    return false;
  }

  // Step 2: Get summary + action items
  const summary = await getSummaryAndActions(token, tb.summaryBlockId);
  if (summary.sections.length === 0 && summary.actions.length === 0) {
    console.log(`    SKIP: Empty summary`);
    return false;
  }

  // Step 3: Build meeting date from multiple sources
  const meetingDate = meeting.date
    || (tb.startTime ? tb.startTime.slice(0, 10) : null)
    || meeting.createdTime.slice(0, 10);

  const meetingTime = tb.startTime
    ? new Date(tb.startTime).toLocaleTimeString("en-GB", { timeZone: "Europe/Oslo", hour: "2-digit", minute: "2-digit" })
    : "Unknown";

  // Step 4: Merge attendees from DB properties + @mentions in summary
  const allPeople = [...new Set([...meeting.attendees, ...summary.people])];

  // Step 5: Use transcription title (AI-generated, descriptive)
  const displayTitle = tb.title || meeting.title || "Untitled Meeting";

  // Step 6: Compose markdown
  const markdown = composeMarkdown(
    displayTitle,
    meetingDate,
    meetingTime,
    meeting.pageId,
    allPeople,
    summary.sections,
    summary.actions,
  );

  if (dryRun) {
    console.log(`    DRY RUN: Would insert ${markdown.length} chars`);
    console.log(`    Title: ${displayTitle}`);
    console.log(`    Date: ${meetingDate}, Time: ${meetingTime}`);
    console.log(`    People: ${allPeople.join(", ")}`);
    console.log(`    Actions: ${summary.actions.length}`);
    return true;
  }

  // Step 7: Build metadata (no LLM)
  const metadata = {
    type: "meeting",
    source: "notion-sync",
    people: allPeople,
    topics: deriveTopics(displayTitle),
    action_items: summary.actions.map(a => a.text),
    dates_mentioned: [meetingDate],
    notion_page_id: meeting.pageId,
    recording_start: tb.startTime || null,
    meeting_title: displayTitle,
  };

  // Step 8: Generate embedding + insert
  const embedding = await getEmbedding(markdown);
  const id = await insertToEngram(markdown, embedding, metadata);
  console.log(`    Inserted: ${id} (${markdown.length} chars, ${summary.actions.length} actions)`);
  return true;
}

// ─── Test mode ──────────────────────────────────────────────────────────────

async function runTest(token: string) {
  console.log(`Testing against page ${TEST_PAGE_ID}...`);
  const meeting: DiscoveredMeeting = {
    pageId: TEST_PAGE_ID,
    title: "Example Meeting",
    date: "2026-04-01",
    attendees: ["Example"],
    createdTime: "2026-04-01T14:00:00.000Z",
  };

  const ok = await processMeeting(token, meeting, true);
  if (ok) {
    console.log("\nTest PASSED: Successfully extracted and composed meeting.");
  } else {
    console.log("\nTest FAILED: Could not process test meeting.");
    process.exit(1);
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const isTest = args.includes("--test");
  const isDryRun = args.includes("--dry-run");

  const token = getNotionToken();
  const syncStart = new Date().toISOString();

  console.log(`[${syncStart}] Engram meeting sync`);

  if (isTest) {
    await runTest(token);
    return;
  }

  const lastSync = getLastSync();
  console.log(`  Last sync: ${lastSync}`);
  console.log(`  Mode: ${isDryRun ? "DRY RUN" : "LIVE"}`);

  // Discover new meetings
  const allMeetings = await discoverMeetings(token, lastSync);
  console.log(`  Discovered: ${allMeetings.length} meeting(s) since last sync`);

  if (allMeetings.length === 0) {
    console.log("  Nothing to sync.");
    return;
  }

  // Check existing in OB for deduplication
  const existingIds = await getExistingNotionPageIds();
  console.log(`  Already in Engram: ${existingIds.size} meetings`);

  const newMeetings = allMeetings.filter(m => !existingIds.has(m.pageId));
  console.log(`  New to process: ${newMeetings.length}`);

  if (newMeetings.length === 0) {
    console.log("  All meetings already in Engram.");
    if (!isDryRun) saveLastSync(syncStart);
    return;
  }

  let captured = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < newMeetings.length; i++) {
    const m = newMeetings[i];
    console.log(`  [${i + 1}/${newMeetings.length}] ${m.title || m.pageId} (${m.date || "no date"})`);

    try {
      const ok = await processMeeting(token, m, isDryRun);
      if (ok) captured++;
      else skipped++;
    } catch (err) {
      console.error(`    ERROR: ${(err as Error).message}`);
      failed++;
    }

    // Rate limit: ~3 req/s, each meeting uses 2-3 requests
    if (i < newMeetings.length - 1) await new Promise(r => setTimeout(r, 1000));
  }

  // Only advance checkpoint if no failures
  if (failed === 0 && !isDryRun) {
    saveLastSync(syncStart);
  } else if (failed > 0) {
    console.log(`  WARNING: Checkpoint NOT advanced due to ${failed} failure(s)`);
  }

  console.log(`[${new Date().toISOString()}] Done: ${captured} captured, ${skipped} skipped, ${failed} failed`);
}

main().catch(err => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
