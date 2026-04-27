#!/usr/bin/env bun
/**
 * Email Sync to Engram
 *
 * Syncs relevant work emails from Apple Mail (Exchange account) to Engram.
 * Architecture: V10 — Hybrid Reply-Detection + Self-Updating Contact Allowlist.
 *
 * Strategy:
 * 1. Scan recent Sent Items (7-day window)
 * 2. Filter out noise (calendar, HAL, SharePoint, automated)
 * 3. Detect replies (Re:/SV:/Fwd: prefixes) → extract recipients as known contacts
 * 4. Sync sent replies with body snippet to Engram
 * 5. Scan recent Inbox, filter by contact allowlist
 * 6. Sync matched inbox emails (metadata only) to Engram
 *
 * Runs via launchd daily at 05:00 (called from run-meeting-sync.sh).
 *
 * Required env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { getEmbedding } from "./lib/embeddings.ts";

// --- Config ---

const PAI_ROOT = join(process.env.HOME!, ".claude");
const SCRIPT_DIR = join(PAI_ROOT, "engram");
const STATE_DIR = join(SCRIPT_DIR, "state");
const STATE_FILE = join(STATE_DIR, "email-sync-state.json");

const ACCOUNT = process.env.MAIL_ACCOUNT || "Exchange";
const LOOKBACK_DAYS = parseInt(process.env.MAIL_LOOKBACK_DAYS || "7", 10);
const BATCH_LIMIT = 30;
const MAX_BODY_CHARS = 2000;
const MAX_SYNCED_IDS = 2000;
const MAX_CONTACTS = 500;
const BACKFILL_BATCH = 1000; // messages per backfill run
const BACKFILL_SYNC_LIMIT = 50; // max emails to sync per backfill run (API calls)

// CLI flags
const IS_BACKFILL = process.argv.includes("--backfill");

// Reply/forward prefixes (including Norwegian SV:/VS:)
const REPLY_PREFIXES = ["Re:", "RE:", "SV:", "Sv:", "Fwd:", "FW:", "VS:", "Vs:"];

// Denylist patterns for noise filtering
const DENYLIST_SUBJECT_PREFIXES = [
  "Accepted:",
  "Declined:",
  "Canceled:",
  "Tentative:",
];

const DENYLIST_SUBJECT_CONTAINS = [
  "left a comment in",
  "mentioned you in",
  "shared a file with you",
  "Microsoft Teams meeting",
];

// Self-addressed emails to skip (your AI sends to you)
const SELF_EMAIL = process.env.SELF_EMAIL || "";
if (!SELF_EMAIL) {
  console.error("SELF_EMAIL required (your email address, used to filter self-sent messages)");
  process.exit(1);
}

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
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_KEY ||
  "";
if (!SUPABASE_KEY) {
  console.error("Missing SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
if (!process.env.VOYAGE_API_KEY && !process.env.OPENAI_API_KEY) {
  console.error("Missing embedding key: set VOYAGE_API_KEY or OPENAI_API_KEY");
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

// --- State ---

interface EmailSyncState {
  lastSyncDate: string; // ISO date of last successful sync
  contactAllowlist: string[]; // email addresses of known contacts
  syncedIds: string[]; // rolling window of synced message identifiers
  totalSynced: number;
  backfillOffset?: number; // how far back we've scanned (message index)
  backfillComplete?: boolean; // true when all sent items have been processed
}

function getState(): EmailSyncState {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
  } catch {
    return { lastSyncDate: "", contactAllowlist: [], syncedIds: [], totalSynced: 0, backfillOffset: 0, backfillComplete: false };
  }
}

function saveState(state: EmailSyncState): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// --- AppleScript Helpers ---

function escapeAS(str: string): string {
  return str.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

interface EmailMeta {
  index: number;
  subject: string;
  sender: string;
  recipients: string; // comma-separated To addresses
  cc: string; // comma-separated CC addresses
  date: string;
  messageId: string; // subject+date hash as unique identifier
}

function extractEmail(senderStr: string): string {
  // Try to extract email from "Name <email@domain.com>" format
  const match = senderStr.match(/<([^>]+@[^>]+)>/);
  if (match) return match[1].toLowerCase();
  // Try bare email
  const emailMatch = senderStr.match(/[\w.+-]+@[\w.-]+\.\w+/);
  if (emailMatch) return emailMatch[0].toLowerCase();
  return senderStr.toLowerCase().trim();
}

function isReply(subject: string): boolean {
  const trimmed = subject.trim();
  return REPLY_PREFIXES.some((p) => trimmed.startsWith(p));
}

/** Strip Re:/SV:/FW:/Fwd:/VS: prefixes to get the root thread subject. */
function getThreadSubject(subject: string): string {
  let s = subject.trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const prefix of REPLY_PREFIXES) {
      if (s.startsWith(prefix)) {
        s = s.slice(prefix.length).trim();
        changed = true;
      }
    }
  }
  return s;
}

/** Convert AppleScript date ("Friday, 20 March 2026 at 12:15:27") to ISO 8601. */
function toISODate(appleDate: string): string {
  const parsed = new Date(appleDate.replace(" at ", " "));
  if (isNaN(parsed.getTime())) return appleDate; // fallback to original if unparseable
  return parsed.toISOString();
}

function isDenylisted(subject: string): boolean {
  const trimmed = subject.trim();
  // Check prefix denylist
  if (DENYLIST_SUBJECT_PREFIXES.some((p) => trimmed.startsWith(p))) return true;
  // Check contains denylist
  if (DENYLIST_SUBJECT_CONTAINS.some((p) => trimmed.includes(p))) return true;
  return false;
}

function makeMessageId(subject: string, date: string, sender: string): string {
  // Create a stable identifier from subject+date+sender
  const raw = `${subject}|${date}|${sender}`;
  let hash = 0;
  for (let i = 0; i < raw.length; i++) {
    const char = raw.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  return `email-${Math.abs(hash).toString(36)}`;
}

/**
 * Fetch recent emails from a mailbox via AppleScript.
 * Uses index-based scan (messages 1 thru N, most recent first) instead of
 * date-filtered `whose` queries which time out on large mailboxes (24K+).
 * Returns tab-delimited metadata (fast batch operation).
 */
function fetchMailboxMetadata(mailbox: string, days: number): EmailMeta[] {
  // Use batch reference (messages 1 thru N) — much faster than iterating by index
  // on large mailboxes. 50 messages is the sweet spot for ~45s runtime.
  // Includes recipient extraction in the same batch to avoid per-message calls.
  const scanCount = 50;
  const script = `
tell application "Mail"
  set acct to account "${escapeAS(ACCOUNT)}"
  set mb to mailbox "${escapeAS(mailbox)}" of acct
  set msgCount to count of messages of mb
  if msgCount < 1 then return ""
  if msgCount > ${scanCount} then set msgCount to ${scanCount}
  set msgs to messages 1 thru msgCount of mb
  set output to ""
  set i to 0
  repeat with msg in msgs
    set i to i + 1
    set subj to subject of msg
    set sndr to sender of msg
    set dt to date received of msg
    set recipStr to ""
    try
      set recips to to recipients of msg
      repeat with r in recips
        set recipStr to recipStr & (address of r) & ","
      end repeat
    end try
    set ccStr to ""
    try
      set ccs to cc recipients of msg
      repeat with c in ccs
        set ccStr to ccStr & (address of c) & ","
      end repeat
    end try
    set output to output & i & "\\t" & subj & "\\t" & sndr & "\\t" & recipStr & "\\t" & ccStr & "\\t" & dt & linefeed
  end repeat
  return output
end tell`;

  try {
    const result = execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, {
      encoding: "utf-8",
      timeout: 60000,
      maxBuffer: 5 * 1024 * 1024,
    });

    // Parse all results, then filter by date in TypeScript
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);

    return result
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const parts = line.split("\t");
        const subject = parts[1] || "";
        const sender = parts[2] || "";
        const recipients = parts[3] || "";
        const cc = parts[4] || "";
        const date = parts[5] || "";
        return {
          index: parseInt(parts[0], 10),
          subject,
          sender,
          recipients,
          cc,
          date,
          messageId: makeMessageId(subject, date, sender),
        };
      })
      .filter((e) => {
        // Parse AppleScript date format (e.g., "Friday, 20 March 2026 at 12:15:27")
        const parsed = new Date(e.date.replace(" at ", " "));
        return !isNaN(parsed.getTime()) && parsed >= cutoff;
      });
  } catch (err) {
    console.error(`  AppleScript error (${mailbox}): ${(err as Error).message.slice(0, 200)}`);
    return [];
  }
}

/**
 * Fetch metadata for a single chunk of messages (max ~200) via AppleScript.
 */
function fetchMailboxMetadataChunk(mailbox: string, startIndex: number, endIndex: number): EmailMeta[] {
  const script = `
tell application "Mail"
  set acct to account "${escapeAS(ACCOUNT)}"
  set mb to mailbox "${escapeAS(mailbox)}" of acct
  set msgCount to count of messages of mb
  if msgCount < ${startIndex} then return ""
  set endIdx to ${endIndex}
  if msgCount < endIdx then set endIdx to msgCount
  set msgs to messages ${startIndex} thru endIdx of mb
  set output to ""
  set i to ${startIndex - 1}
  repeat with msg in msgs
    set i to i + 1
    set subj to subject of msg
    set sndr to sender of msg
    set dt to date received of msg
    set recipStr to ""
    try
      set recips to to recipients of msg
      repeat with r in recips
        set recipStr to recipStr & (address of r) & ","
      end repeat
    end try
    set ccStr to ""
    try
      set ccs to cc recipients of msg
      repeat with c in ccs
        set ccStr to ccStr & (address of c) & ","
      end repeat
    end try
    set output to output & i & "\\t" & subj & "\\t" & sndr & "\\t" & recipStr & "\\t" & ccStr & "\\t" & dt & linefeed
  end repeat
  return output
end tell`;

  try {
    const result = execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, {
      encoding: "utf-8",
      timeout: 120000, // 2 min per chunk
      maxBuffer: 5 * 1024 * 1024,
    });

    if (!result.trim()) return [];

    return result
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const parts = line.split("\t");
        const subject = parts[1] || "";
        const sender = parts[2] || "";
        const recipients = parts[3] || "";
        const cc = parts[4] || "";
        const date = parts[5] || "";
        return {
          index: parseInt(parts[0], 10),
          subject,
          sender,
          recipients,
          cc,
          date,
          messageId: makeMessageId(subject, date, sender),
        };
      });
  } catch (err) {
    console.error(`  AppleScript error (${mailbox} chunk ${startIndex}-${endIndex}): ${(err as Error).message.slice(0, 200)}`);
    return [];
  }
}

/**
 * Fetch metadata for a large range by chunking into 200-message batches.
 * AppleScript times out on >500 messages in a single batch reference.
 * Returns emails AND the last successfully scanned index (for safe offset advancement).
 */
function restartMail(): void {
  try {
    execSync(`osascript -e 'tell application "Mail" to quit'`, { timeout: 15000 });
  } catch {}
  // Use Bun.sleepSync for reliable non-blocking wait
  Bun.sleepSync(5000);
  try {
    execSync("open -a Mail", { timeout: 10000 });
  } catch {}
  Bun.sleepSync(10000);
}

function fetchMailboxMetadataRange(mailbox: string, startIndex: number, endIndex: number): { emails: EmailMeta[]; lastScannedIndex: number } {
  const CHUNK_SIZE = 200;
  const RESTART_EVERY = 4; // restart Mail every N chunks to prevent hangs
  const allResults: EmailMeta[] = [];
  let lastScannedIndex = startIndex - 1;
  let chunkCount = 0;

  for (let chunkStart = startIndex; chunkStart <= endIndex; chunkStart += CHUNK_SIZE) {
    // Restart Mail every N chunks to keep it responsive
    if (chunkCount > 0 && chunkCount % RESTART_EVERY === 0) {
      console.log(`    Restarting Mail (after ${chunkCount} chunks)...`);
      restartMail();
      console.log(`    Mail restarted`);
    }

    const chunkEnd = Math.min(chunkStart + CHUNK_SIZE - 1, endIndex);
    console.log(`    Chunk ${chunkStart}-${chunkEnd}...`);
    const chunk = fetchMailboxMetadataChunk(mailbox, chunkStart, chunkEnd);

    if (chunk.length === 0) {
      // Chunk failed — restart Mail and retry once
      console.log(`    Chunk failed, restarting Mail and retrying...`);
      restartMail();

      const retry = fetchMailboxMetadataChunk(mailbox, chunkStart, chunkEnd);
      if (retry.length === 0) {
        console.log(`    Retry failed, stopping at index ${lastScannedIndex}`);
        break;
      }
      allResults.push(...retry);
      lastScannedIndex = chunkEnd;
    } else {
      allResults.push(...chunk);
      lastScannedIndex = chunkEnd;
    }

    chunkCount++;
  }

  return { emails: allResults, lastScannedIndex };
}

/**
 * Get total message count for a mailbox.
 */
function getMailboxCount(mailbox: string): number {
  const script = `
tell application "Mail"
  set acct to account "${escapeAS(ACCOUNT)}"
  set mb to mailbox "${escapeAS(mailbox)}" of acct
  return count of messages of mb
end tell`;
  try {
    const result = execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, {
      encoding: "utf-8",
      timeout: 30000,
    });
    return parseInt(result.trim(), 10) || 0;
  } catch {
    return 0;
  }
}

/**
 * Fetch email body for a specific message by index (individual call, may be slow).
 * Uses item N of batch reference for consistent behavior with metadata scan.
 */
function fetchEmailBody(mailbox: string, index: number): string {
  // Use messages reference to access by position
  const script = `
tell application "Mail"
  set acct to account "${escapeAS(ACCOUNT)}"
  set mb to mailbox "${escapeAS(mailbox)}" of acct
  set msgs to messages 1 thru ${index} of mb
  set msg to item ${index} of msgs
  set bodyText to content of msg
  if (length of bodyText) > ${MAX_BODY_CHARS} then
    set bodyText to text 1 thru ${MAX_BODY_CHARS} of bodyText
  end if
  return bodyText
end tell`;

  try {
    const result = execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, {
      encoding: "utf-8",
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    });
    return result.trim().slice(0, MAX_BODY_CHARS);
  } catch {
    return "[body extraction failed]";
  }
}

// --- Sync ---

async function syncEmail(
  email: EmailMeta,
  bodySnippet: string | null,
  direction: "sent" | "received"
): Promise<boolean> {
  const senderEmail = extractEmail(email.sender);
  const isoDate = toISODate(email.date);
  const threadSubject = getThreadSubject(email.subject);

  // Structured content for better embedding and retrieval
  const contentParts = [
    `# Email: ${email.subject}`,
    "",
    "## Metadata",
    `- **Direction:** ${direction}`,
    `- **${direction === "sent" ? "To" : "From"}:** ${email.sender}`,
  ];
  if (email.recipients) {
    contentParts.push(`- **To:** ${email.recipients.replace(/,$/,"")}`);
  }
  if (email.cc) {
    contentParts.push(`- **CC:** ${email.cc.replace(/,$/,"")}`);
  }
  contentParts.push(`- **Date:** ${isoDate}`);
  if (threadSubject !== email.subject) {
    contentParts.push(`- **Thread:** ${threadSubject}`);
  }

  if (bodySnippet && bodySnippet !== "[body extraction failed]") {
    contentParts.push("", "## Content", bodySnippet);
  }

  const content = contentParts.join("\n");

  // Build metadata with CC and recipients lists
  const ccList = email.cc
    ? email.cc.split(",").filter(Boolean).map((c) => c.toLowerCase().trim())
    : [];
  const recipientList = email.recipients
    ? email.recipients.split(",").filter(Boolean).map((r) => r.toLowerCase().trim())
    : [];

  try {
    const embedding = await getEmbedding(content);

    const { error } = await supabase.schema(DOMAIN as any).from("thoughts").insert({
      content,
      embedding,
      metadata: {
        type: "email",
        source: "email-sync",
        direction,
        sender: senderEmail,
        recipients: recipientList,
        cc: ccList.length > 0 ? ccList : undefined,
        subject: email.subject.slice(0, 200),
        thread_subject: threadSubject.slice(0, 200),
        date_sent: isoDate,
        message_id: email.messageId,
      },
    });

    if (error) throw error;
    return true;
  } catch (err) {
    console.error(`    FAILED: ${(err as Error).message.slice(0, 200)}`);
    return false;
  }
}

// --- Main ---

async function main() {
  const state = getState();
  const now = new Date();

  console.log(`[${now.toISOString()}] Email sync starting`);
  console.log(`  Last sync: ${state.lastSyncDate || "never"}`);
  console.log(`  Known contacts: ${state.contactAllowlist.length}`);
  console.log(`  Total synced to date: ${state.totalSynced}`);

  const knownIds = new Set(state.syncedIds);
  let synced = 0;
  let failed = 0;
  const newIds: string[] = [];
  const newContacts = new Set(state.contactAllowlist.map((c) => c.toLowerCase()));

  // --- Phase 1: Scan Sent Items ---
  console.log(`  Scanning Sent Items (last ${LOOKBACK_DAYS} days)...`);
  const sentEmails = fetchMailboxMetadata("Sent Items", LOOKBACK_DAYS);
  console.log(`  Found ${sentEmails.length} sent emails`);

  // Filter out noise
  const relevantSent = sentEmails.filter((e) => !isDenylisted(e.subject));
  console.log(`  After denylist: ${relevantSent.length} relevant sent emails`);

  // Detect replies and build allowlist
  const sentReplies = relevantSent.filter((e) => isReply(e.subject));
  console.log(`  Sent replies/forwards: ${sentReplies.length}`);

  // Extract recipients from all relevant sent items → build contact allowlist
  for (const sent of relevantSent) {
    const recipients = sent.recipients
      .split(",")
      .filter(Boolean)
      .map((r) => r.toLowerCase().trim());
    for (const r of recipients) {
      if (r && r !== SELF_EMAIL) {
        newContacts.add(r);
      }
    }
  }
  console.log(`  Contact allowlist: ${newContacts.size} contacts`);

  // Sync sent replies (with body)
  const unsynced = sentReplies.filter((e) => !knownIds.has(e.messageId));
  const toSync = unsynced.slice(0, BATCH_LIMIT);
  console.log(`  New sent replies to sync: ${unsynced.length} (processing ${toSync.length})`);

  for (let i = 0; i < toSync.length; i++) {
    const email = toSync[i];
    console.log(`  [${i + 1}/${toSync.length}] SENT: ${email.subject.slice(0, 60)}`);

    // Extract body for sent replies
    const body = fetchEmailBody("Sent Items", email.index);
    const ok = await syncEmail(email, body, "sent");

    if (ok) {
      synced++;
      newIds.push(email.messageId);
    } else {
      failed++;
    }

    // Rate limit
    if (i < toSync.length - 1) await new Promise((r) => setTimeout(r, 200));
  }

  // --- Phase 2: Scan Inbox ---
  const remainingBudget = BATCH_LIMIT - synced;
  if (remainingBudget > 0) {
    console.log(`  Scanning Inbox (last ${LOOKBACK_DAYS} days)...`);
    const inboxEmails = fetchMailboxMetadata("Inbox", LOOKBACK_DAYS);
    console.log(`  Found ${inboxEmails.length} inbox emails`);

    // Filter by contact allowlist
    const fromKnown = inboxEmails.filter((e) => {
      if (isDenylisted(e.subject)) return false;
      const senderEmail = extractEmail(e.sender);
      return newContacts.has(senderEmail);
    });
    console.log(`  From known contacts: ${fromKnown.length}`);

    const unsyncedInbox = fromKnown.filter((e) => !knownIds.has(e.messageId));
    const inboxToSync = unsyncedInbox.slice(0, remainingBudget);
    console.log(`  New inbox to sync: ${unsyncedInbox.length} (processing ${inboxToSync.length})`);

    const inboxStart = synced;
    for (let i = 0; i < inboxToSync.length; i++) {
      const email = inboxToSync[i];
      console.log(`  [${inboxStart + i + 1}/${inboxStart + inboxToSync.length}] INBOX: ${email.subject.slice(0, 60)}`);

      // Metadata only for inbox emails (no body extraction)
      const ok = await syncEmail(email, null, "received");

      if (ok) {
        synced++;
        newIds.push(email.messageId);
      } else {
        failed++;
      }

      if (i < inboxToSync.length - 1) await new Promise((r) => setTimeout(r, 200));
    }
  }

  // --- Save state ---
  const allIds = [...state.syncedIds, ...newIds].slice(-MAX_SYNCED_IDS);

  saveState({
    lastSyncDate: now.toISOString().slice(0, 10),
    contactAllowlist: Array.from(newContacts).slice(-MAX_CONTACTS),
    syncedIds: allIds,
    totalSynced: (state.totalSynced || 0) + synced,
    backfillOffset: state.backfillOffset,
    backfillComplete: state.backfillComplete,
  });

  console.log(
    `[${new Date().toISOString()}] Email sync complete: ${synced} synced, ${failed} failed, ${newContacts.size} contacts`
  );
}

// --- Backfill Mode ---

async function backfillMain() {
  const state = getState();
  const now = new Date();

  if (state.backfillComplete) {
    console.log(`[${now.toISOString()}] Backfill already complete (${state.totalSynced} total synced). Nothing to do.`);
    return;
  }

  const offset = state.backfillOffset || 0;
  const totalMessages = getMailboxCount("Sent Items");

  console.log(`[${now.toISOString()}] Email BACKFILL starting`);
  console.log(`  Total Sent Items: ${totalMessages}`);
  console.log(`  Current offset: ${offset} (${totalMessages > 0 ? Math.round(offset / totalMessages * 100) : 0}% done)`);
  console.log(`  Known contacts: ${state.contactAllowlist.length}`);
  console.log(`  Total synced to date: ${state.totalSynced}`);

  if (totalMessages === 0) {
    console.log(`  ERROR: Could not get mailbox count (Mail may not be running). Aborting.`);
    return;
  }

  // Messages are 1-indexed, most recent first. offset=0 means start from newest.
  // Daily sync handles messages 1-50 (recent). Backfill starts at 51 and walks backwards.
  const startIndex = Math.max(offset + 1, 51); // skip the recent 50 (handled by daily sync)
  const endIndex = startIndex + BACKFILL_BATCH - 1;

  if (startIndex > totalMessages) {
    console.log(`  Backfill complete! All ${totalMessages} sent items processed.`);
    saveState({ ...state, backfillComplete: true, backfillOffset: totalMessages });
    return;
  }

  console.log(`  Scanning messages ${startIndex} thru ${Math.min(endIndex, totalMessages)}...`);
  const { emails, lastScannedIndex } = fetchMailboxMetadataRange("Sent Items", startIndex, endIndex);
  console.log(`  Fetched ${emails.length} messages (scanned up to index ${lastScannedIndex})`);

  // Filter out noise
  const relevant = emails.filter((e) => !isDenylisted(e.subject));
  console.log(`  After denylist: ${relevant.length} relevant`);

  // Detect replies
  const replies = relevant.filter((e) => isReply(e.subject));
  console.log(`  Replies/forwards: ${replies.length}`);

  // Build contacts from all relevant sent items
  const knownIds = new Set(state.syncedIds);
  const contacts = new Set(state.contactAllowlist.map((c) => c.toLowerCase()));

  for (const sent of relevant) {
    const recipients = sent.recipients.split(",").filter(Boolean).map((r) => r.toLowerCase().trim());
    for (const r of recipients) {
      if (r && r !== SELF_EMAIL) contacts.add(r);
    }
  }

  // Sync replies (with body) — limited to BACKFILL_SYNC_LIMIT per run
  const unsynced = replies.filter((e) => !knownIds.has(e.messageId));
  const toSync = unsynced.slice(0, BACKFILL_SYNC_LIMIT);
  console.log(`  New replies to sync: ${unsynced.length} (processing ${toSync.length})`);

  let synced = 0;
  let failed = 0;
  const newIds: string[] = [];

  for (let i = 0; i < toSync.length; i++) {
    const email = toSync[i];
    console.log(`  [${i + 1}/${toSync.length}] BACKFILL: ${email.subject.slice(0, 60)}`);

    const body = fetchEmailBody("Sent Items", email.index);
    const ok = await syncEmail(email, body, "sent");

    if (ok) {
      synced++;
      newIds.push(email.messageId);
    } else {
      failed++;
    }

    if (i < toSync.length - 1) await new Promise((r) => setTimeout(r, 200));
  }

  // Advance offset only to last successfully scanned chunk (not the full batch)
  const newOffset = lastScannedIndex > 0 ? Math.min(lastScannedIndex, totalMessages) : offset;
  const allIds = [...state.syncedIds, ...newIds].slice(-MAX_SYNCED_IDS);
  const isComplete = newOffset >= totalMessages;

  saveState({
    lastSyncDate: state.lastSyncDate, // don't update — backfill doesn't affect daily sync date
    contactAllowlist: Array.from(contacts).slice(-MAX_CONTACTS),
    syncedIds: allIds,
    totalSynced: (state.totalSynced || 0) + synced,
    backfillOffset: newOffset,
    backfillComplete: isComplete,
  });

  const remaining = totalMessages - newOffset;
  const runsLeft = Math.ceil(remaining / BACKFILL_BATCH);

  console.log(
    `[${new Date().toISOString()}] Backfill run complete: ${synced} synced, ${failed} failed, ${contacts.size} contacts`
  );
  console.log(`  Progress: ${newOffset}/${totalMessages} (${Math.round(newOffset / totalMessages * 100)}%)`);
  if (!isComplete) {
    console.log(`  Remaining: ${remaining} messages, ~${runsLeft} runs (~${runsLeft} nights)`);
  } else {
    console.log(`  BACKFILL COMPLETE!`);
  }
}

// --- Entry Point ---

const entry = IS_BACKFILL ? backfillMain : main;
entry().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
