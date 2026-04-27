#!/usr/bin/env bun
/**
 * Enrich Notion Meeting Transcripts
 *
 * Fills empty database properties from transcription block data:
 * - Meeting Date (from recording.start_time)
 * - Attendees (from @mentions in summary + title parsing)
 * - Key Topics (from title keyword matching)
 * - Action Items (from to_do blocks)
 * - Summary (first ~25 words of AI summary)
 * - Status → "Completed"
 *
 * Usage:
 *   bun run enrich-notion-meetings.ts              # enrich all empty pages
 *   bun run enrich-notion-meetings.ts --dry-run    # preview without writing
 *   bun run enrich-notion-meetings.ts --force      # re-enrich already-filled pages
 */

import { readFileSync } from "node:fs";
import { loadEnvFile } from "./lib/env.ts";

// ─── Config ──────────────────────────────────────────────────────────────────

const DATABASE_ID = "YOUR_NOTION_DATABASE_ID";
const NOTION_API_VERSION = "2022-06-28";
const NOTION_API_BLOCKS = "2025-09-03";

// Known attendee multi_select options in the database
const KNOWN_ATTENDEES = new Set([
  // Add your team members' first names here
  // These must match the multi_select option names in your Notion database
  "Alice", "Bob", "Carol", "Dave", "Eve",
]);

// Map full names to multi_select option names
const NAME_MAP: Record<string, string> = {
  // Map full names (lowercase) to multi_select option names
  // Example:
  // "alice johnson": "Alice",
  // "bob smith": "Bob",
  // "carol": "Carol",
};

// ─── Env loading ─────────────────────────────────────────────────────────────

loadEnvFile(`${process.env.HOME}/.claude/engram/.env`);

// ─── Notion Token ────────────────────────────────────────────────────────────

function getNotionToken(): string {
  if (process.env.NOTION_TOKEN) return process.env.NOTION_TOKEN;
  try {
    const config = JSON.parse(readFileSync(`${process.env.HOME}/.claude.json`, "utf-8"));
    const headers = JSON.parse(config.mcpServers?.notion_local?.env?.OPENAPI_MCP_HEADERS || "{}");
    const auth = headers.Authorization as string;
    if (auth?.startsWith("Bearer ")) return auth.slice(7);
  } catch {}
  throw new Error("No Notion token found");
}

function notionHeaders(token: string, apiVersion: string = NOTION_API_BLOCKS) {
  return {
    Authorization: `Bearer ${token}`,
    "Notion-Version": apiVersion,
    "Content-Type": "application/json",
  };
}

// ─── Paginated block fetcher ─────────────────────────────────────────────────

async function fetchAllBlocks(token: string, blockId: string): Promise<any[]> {
  const allBlocks: any[] = [];
  let cursor: string | undefined;
  do {
    const url = new URL(`https://api.notion.com/v1/blocks/${blockId}/children`);
    url.searchParams.set("page_size", "100");
    if (cursor) url.searchParams.set("start_cursor", cursor);

    const res = await fetch(url.toString(), { headers: notionHeaders(token, NOTION_API_BLOCKS) });
    if (!res.ok) {
      if (res.status === 429) {
        const retryAfter = parseInt(res.headers.get("retry-after") || "2", 10);
        console.log(`    Rate limited, waiting ${retryAfter}s...`);
        await new Promise(r => setTimeout(r, retryAfter * 1000));
        continue;
      }
      throw new Error(`Notion API ${res.status}: ${await res.text()}`);
    }
    const data = await res.json();
    allBlocks.push(...data.results);
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return allBlocks;
}

// ─── Topic derivation ───────────────────────────────────────────────────────

function deriveTopics(title: string): string[] {
  const lower = title.toLowerCase();
  const topics: string[] = [];
  // Add your own topic detection patterns here
  const patterns: [RegExp, string][] = [
    [/budget|cost|finance/i, "Budget"],
    [/training/i, "Training"],
    [/risk/i, "Risk"],
    [/weekly|bi-weekly|status/i, "Status Meeting"],
    [/1:1|121|one.on.one/i, "1:1"],
    [/demo/i, "Demo"],
    [/planning/i, "Planning"],
    [/steering|steerco/i, "Steering"],
    // Add project-specific patterns:
    // [/your-project/i, "Your Project"],
  ];
  for (const [regex, topic] of patterns) {
    if (regex.test(lower)) topics.push(topic);
  }
  return topics.length > 0 ? topics.slice(0, 3) : [];
}

// ─── Name resolution ────────────────────────────────────────────────────────

function resolveAttendee(fullName: string): string | null {
  const lower = fullName.toLowerCase().trim();
  if (NAME_MAP[lower]) return NAME_MAP[lower];
  // Try first name only
  const firstName = lower.split(" ")[0];
  if (NAME_MAP[firstName]) return NAME_MAP[firstName];
  // Check if it matches a known option directly
  for (const known of KNOWN_ATTENDEES) {
    if (known.toLowerCase() === firstName) return known;
  }
  return null;
}

// ─── Extract title names ────────────────────────────────────────────────────

function extractNamesFromTitle(title: string): string[] {
  const names: string[] = [];
  // Match known first names in the title
  for (const [key, value] of Object.entries(NAME_MAP)) {
    if (key.split(" ").length === 1) continue; // Skip single-word keys for title matching
    if (title.toLowerCase().includes(key)) names.push(value);
  }
  // Also check single known names against title words
  const words = title.split(/[\s,\-:]+/).map(w => w.toLowerCase());
  for (const word of words) {
    const resolved = resolveAttendee(word);
    if (resolved && !names.includes(resolved)) names.push(resolved);
  }
  return names;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const isDryRun = args.includes("--dry-run");
  const force = args.includes("--force");

  const token = getNotionToken();
  console.log(`[${new Date().toISOString()}] Notion Meeting Enrichment`);
  console.log(`  Mode: ${isDryRun ? "DRY RUN" : "LIVE"}${force ? " (force)" : ""}`);

  // Fetch all pages
  let allPages: any[] = [];
  let cursor: string | undefined;
  do {
    const body: any = {
      sorts: [{ timestamp: "created_time", direction: "ascending" }],
      page_size: 100,
    };
    if (cursor) body.start_cursor = cursor;

    const res = await fetch(
      `https://api.notion.com/v1/databases/${DATABASE_ID}/query`,
      { method: "POST", headers: notionHeaders(token, NOTION_API_VERSION), body: JSON.stringify(body) }
    );
    if (!res.ok) {
      console.error(`  Query failed: ${await res.text()}`);
      break;
    }
    const data = await res.json();
    allPages.push(...data.results);
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);

  console.log(`  Total pages: ${allPages.length}`);

  // Filter to pages needing enrichment
  const needsEnrichment = allPages.filter(p => {
    if (force) return true;
    const summary = p.properties.Summary?.rich_text?.length || 0;
    const date = p.properties["Meeting Date"]?.date ? 1 : 0;
    const attendees = p.properties.Attendees?.multi_select?.length || 0;
    return summary === 0 || date === 0 || attendees === 0;
  });

  console.log(`  Need enrichment: ${needsEnrichment.length}`);

  let enriched = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < needsEnrichment.length; i++) {
    const page = needsEnrichment[i];
    const pageId = page.id;
    const rawTitle = page.properties["Meeting Title"]?.title?.map((t: any) => t.plain_text).join("") || "";
    console.log(`  [${i + 1}/${needsEnrichment.length}] ${rawTitle || pageId}`);

    try {
      // Get transcription block
      const blocks = await fetchAllBlocks(token, pageId);
      const tb = blocks.find((b: any) => b.type === "transcription");

      if (!tb) {
        console.log(`    SKIP: No transcription block`);
        skipped++;
        continue;
      }

      if (tb.transcription.status !== "notes_ready") {
        console.log(`    SKIP: Status "${tb.transcription.status}"`);
        skipped++;
        continue;
      }

      const transcriptionTitle = tb.transcription.title?.map((t: any) => t.plain_text).join("") || "";
      const startTime = tb.transcription.recording?.start_time;
      const summaryBlockId = tb.transcription.children?.summary_block_id;

      if (!summaryBlockId) {
        console.log(`    SKIP: No summary block`);
        skipped++;
        continue;
      }

      // Get summary blocks
      const summaryBlocks = await fetchAllBlocks(token, summaryBlockId);

      // Extract data
      const summaryTexts: string[] = [];
      const actionItems: string[] = [];
      const people = new Set<string>();

      for (const block of summaryBlocks) {
        if (block.type === "heading_3") {
          // Skip headings from summary text
        } else if (block.type === "to_do") {
          const text = block.to_do.rich_text.map((t: any) => t.plain_text).join("");
          actionItems.push(text.trim());
          // Extract @mentions
          for (const rt of block.to_do.rich_text) {
            if (rt.type === "mention" && rt.mention?.type === "user" && rt.mention.user?.name) {
              people.add(rt.mention.user.name);
            }
          }
        } else if (block.type === "paragraph") {
          const text = block.paragraph.rich_text.map((t: any) => t.plain_text).join("");
          if (text.trim()) summaryTexts.push(text.trim());
          for (const rt of block.paragraph.rich_text) {
            if (rt.type === "mention" && rt.mention?.type === "user" && rt.mention.user?.name) {
              people.add(rt.mention.user.name);
            }
          }
        } else if (block.type === "bulleted_list_item") {
          const text = block.bulleted_list_item.rich_text.map((t: any) => t.plain_text).join("");
          if (text.trim()) summaryTexts.push(text.trim());
        }
      }

      // Build 25-word summary
      const fullSummary = summaryTexts.join(" ");
      const words = fullSummary.split(/\s+/);
      const shortSummary = words.slice(0, 25).join(" ") + (words.length > 25 ? "..." : "");

      // Build attendees: from @mentions + title parsing
      const titlePeople = extractNamesFromTitle(transcriptionTitle);
      const resolvedAttendees = new Set<string>();
      for (const name of people) {
        const resolved = resolveAttendee(name);
        if (resolved) resolvedAttendees.add(resolved);
      }
      for (const name of titlePeople) {
        resolvedAttendees.add(name);
      }
      // Always add yourself (you record all meetings)
      // resolvedAttendees.add("YourName");

      // Build topics
      const topics = deriveTopics(transcriptionTitle);

      // Build date
      const meetingDate = startTime ? startTime.slice(0, 10) : null;
      const meetingDateTime = startTime || null;

      // Build action items string (newline separated)
      const actionItemsText = actionItems
        .map((a, i) => `${i + 1}. ${a}`)
        .join("\n")
        .slice(0, 2000); // Notion rich_text limit

      if (isDryRun) {
        console.log(`    Title: ${transcriptionTitle}`);
        console.log(`    Date: ${meetingDate}`);
        console.log(`    Attendees: ${[...resolvedAttendees].join(", ")}`);
        console.log(`    Topics: ${topics.join(", ")}`);
        console.log(`    Summary: ${shortSummary.slice(0, 80)}...`);
        console.log(`    Actions: ${actionItems.length}`);
        enriched++;
        continue;
      }

      // Build PATCH payload
      const properties: Record<string, any> = {
        Status: { select: { name: "Completed" } },
      };

      // Summary (rich_text)
      if (shortSummary) {
        properties.Summary = {
          rich_text: [{ type: "text", text: { content: shortSummary.slice(0, 2000) } }],
        };
      }

      // Key Topics (rich_text)
      if (topics.length > 0) {
        properties["Key Topics"] = {
          rich_text: [{ type: "text", text: { content: topics.join(", ") } }],
        };
      }

      // Action Items (rich_text)
      if (actionItemsText) {
        properties["Action Items"] = {
          rich_text: [{ type: "text", text: { content: actionItemsText.slice(0, 2000) } }],
        };
      }

      // Meeting Date (date)
      if (meetingDateTime) {
        properties["Meeting Date"] = {
          date: { start: meetingDateTime },
        };
      }

      // Attendees (multi_select)
      if (resolvedAttendees.size > 0) {
        properties.Attendees = {
          multi_select: [...resolvedAttendees].map(name => ({ name })),
        };
      }

      // PATCH the page
      const patchRes = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
        method: "PATCH",
        headers: notionHeaders(token, NOTION_API_VERSION),
        body: JSON.stringify({ properties }),
      });

      if (!patchRes.ok) {
        const errText = await patchRes.text();
        console.error(`    PATCH FAILED (${patchRes.status}): ${errText.slice(0, 200)}`);
        failed++;
        continue;
      }

      console.log(`    ✓ Enriched: ${[...resolvedAttendees].join(", ")} | ${topics.join(", ")} | ${actionItems.length} actions`);
      enriched++;

    } catch (err) {
      console.error(`    ERROR: ${(err as Error).message}`);
      failed++;
    }

    // Rate limit: ~1s between pages (2-3 API calls per page)
    if (i < needsEnrichment.length - 1) await new Promise(r => setTimeout(r, 1000));
  }

  console.log(`\n[${new Date().toISOString()}] Done: ${enriched} enriched, ${skipped} skipped, ${failed} failed`);
}

main().catch(err => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
