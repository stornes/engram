#!/usr/bin/env bun
/**
 * Slack Message Sync to Engram
 *
 * Fetches recent messages from configured Slack channels via Web API
 * and inserts them as thoughts with semantic embeddings.
 *
 * Runs via launchd daily at 07:15 (called from run-meeting-sync.sh).
 *
 * Required env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY, SLACK_BOT_TOKEN
 * Optional env: SLACK_CHANNELS (comma-separated channel IDs, defaults to configured list)
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";

// --- Config ---

const SCRIPT_DIR = join(process.env.HOME!, ".claude/engram");
const STATE_DIR = join(SCRIPT_DIR, "state");
const STATE_FILE = join(STATE_DIR, "slack-sync-state.json");
const BATCH_LIMIT = 50; // max messages per run
const LOOKBACK_HOURS = 26; // slightly more than 24h to avoid gaps

// Default channels to sync (can override with SLACK_CHANNELS env)
const DEFAULT_CHANNELS = [
  "YOUR_CHANNEL_ID", // #your-channel
];

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
const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN || "";

if (!SUPABASE_KEY || !OPENAI_KEY || !SLACK_TOKEN) {
  console.error("Missing SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY, or SLACK_BOT_TOKEN");
  process.exit(1);
}

const VALID_DOMAINS = ["ob_work", "ob_personal", "ob_life", "ob_learning"] as const;
type Domain = (typeof VALID_DOMAINS)[number];
const DOMAIN: Domain = (process.env.ENGRAM_DOMAIN as Domain) || "ob_work";
if (!VALID_DOMAINS.includes(DOMAIN)) {
  console.error(`Invalid ENGRAM_DOMAIN '${DOMAIN}'. Must be one of: ${VALID_DOMAINS.join(", ")}`);
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const CHANNELS = process.env.SLACK_CHANNELS
  ? process.env.SLACK_CHANNELS.split(",").map(s => s.trim())
  : DEFAULT_CHANNELS;

// --- State ---

interface SlackSyncState {
  lastSync: string;
  channelTimestamps: Record<string, string>; // channel_id -> latest message ts
  messagesSynced: number;
}

function getState(): SlackSyncState {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
  } catch {
    return { lastSync: "", channelTimestamps: {}, messagesSynced: 0 };
  }
}

function saveState(state: SlackSyncState): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// --- Slack API ---

interface SlackMessage {
  type: string;
  text: string;
  user?: string;
  ts: string;
  thread_ts?: string;
}

async function fetchChannelHistory(
  channelId: string,
  oldest: string
): Promise<SlackMessage[]> {
  const url = new URL("https://slack.com/api/conversations.history");
  url.searchParams.set("channel", channelId);
  url.searchParams.set("oldest", oldest);
  url.searchParams.set("limit", "200");

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${SLACK_TOKEN}` },
  });

  const data = await res.json();
  if (!data.ok) {
    console.error(`  Slack API error for ${channelId}: ${data.error}`);
    return [];
  }

  return (data.messages || []).filter(
    (m: SlackMessage) => m.type === "message" && m.text && !m.thread_ts
  );
}

async function getChannelName(channelId: string): Promise<string> {
  try {
    const res = await fetch(
      `https://slack.com/api/conversations.info?channel=${channelId}`,
      { headers: { Authorization: `Bearer ${SLACK_TOKEN}` } }
    );
    const data = await res.json();
    return data.ok ? data.channel?.name || channelId : channelId;
  } catch {
    return channelId;
  }
}

async function getUserName(userId: string): Promise<string> {
  try {
    const res = await fetch(
      `https://slack.com/api/users.info?user=${userId}`,
      { headers: { Authorization: `Bearer ${SLACK_TOKEN}` } }
    );
    const data = await res.json();
    return data.ok
      ? data.user?.real_name || data.user?.name || userId
      : userId;
  } catch {
    return userId;
  }
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
  const cutoff = new Date(now.getTime() - LOOKBACK_HOURS * 60 * 60 * 1000);
  const oldestTs = String(cutoff.getTime() / 1000);

  console.log(`[${now.toISOString()}] Slack sync starting`);
  console.log(`  Channels: ${CHANNELS.join(", ")}`);
  console.log(`  Lookback: ${LOOKBACK_HOURS}h (oldest: ${cutoff.toISOString()})`);
  console.log(`  Last sync: ${state.lastSync || "never"}`);

  // Cache user names to avoid repeated API calls
  const userCache = new Map<string, string>();

  let totalCaptured = 0;
  let totalFailed = 0;

  for (const channelId of CHANNELS) {
    const channelName = await getChannelName(channelId);
    const sinceTs = state.channelTimestamps[channelId] || oldestTs;

    console.log(`  Channel #${channelName} (${channelId}):`);
    const messages = await fetchChannelHistory(channelId, sinceTs);
    console.log(`    Found ${messages.length} new messages`);

    if (messages.length === 0) continue;

    // Sort by timestamp (oldest first)
    messages.sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts));

    // Limit batch size
    const batch = messages.slice(0, BATCH_LIMIT);
    let latestTs = sinceTs;

    for (const msg of batch) {
      // Resolve user name
      let author = "unknown";
      if (msg.user) {
        if (userCache.has(msg.user)) {
          author = userCache.get(msg.user)!;
        } else {
          author = await getUserName(msg.user);
          userCache.set(msg.user, author);
        }
      }

      const msgDate = new Date(parseFloat(msg.ts) * 1000);
      const content = `# Slack: #${channelName}\n\n**From:** ${author}\n**Date:** ${msgDate.toISOString()}\n\n${msg.text}`;

      try {
        const embedding = await getEmbedding(content);

        // Upsert: delete previous version of this exact message
        await supabase
          .schema(DOMAIN as any)
          .from("thoughts")
          .delete()
          .eq("metadata->>slack_ts", msg.ts)
          .eq("metadata->>source", "slack-sync");

        const { error } = await supabase.schema(DOMAIN as any).from("thoughts").insert({
          content,
          embedding,
          metadata: {
            type: "slack-message",
            source: "slack-sync",
            channel_id: channelId,
            channel_name: channelName,
            author,
            user_id: msg.user || "",
            slack_ts: msg.ts,
            message_date: msgDate.toISOString(),
            sync_date: now.toISOString().slice(0, 10),
          },
        });

        if (error) throw error;
        totalCaptured++;
      } catch (err) {
        console.error(`    FAILED: ${(err as Error).message}`);
        totalFailed++;
      }

      // Track latest timestamp
      if (parseFloat(msg.ts) > parseFloat(latestTs)) {
        latestTs = msg.ts;
      }

      // Rate limit
      await new Promise(r => setTimeout(r, 200));
    }

    state.channelTimestamps[channelId] = latestTs;
  }

  state.lastSync = now.toISOString().slice(0, 10);
  state.messagesSynced = (state.messagesSynced || 0) + totalCaptured;
  saveState(state);

  console.log(`[${new Date().toISOString()}] Slack sync complete: ${totalCaptured} captured, ${totalFailed} failed`);
}

main().catch(err => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
