#!/usr/bin/env bun
/**
 * Calendar Event Sync to Engram
 *
 * Fetches today's and yesterday's calendar events via Swift EventKit
 * and inserts them as thoughts with semantic embeddings.
 *
 * Runs via launchd daily at 07:15 (called from run-meeting-sync.sh).
 *
 * Required env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { getEmbedding } from "./lib/embeddings.ts";

// --- Config ---

const SCRIPT_DIR = join(process.env.HOME!, ".claude/engram");
const STATE_DIR = join(SCRIPT_DIR, "state");
const STATE_FILE = join(STATE_DIR, "calendar-sync-state.json");
const EVENTS_SWIFT = process.env.EVENTS_SWIFT_PATH || join(SCRIPT_DIR, "tools", "GetEvents.swift");
const BATCH_LIMIT = 30; // max events per run

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

interface CalendarSyncState {
  lastSync: string;
  syncedEventIds: string[]; // event IDs already synced (rolling 7-day window)
  eventsSynced: number;
}

function getState(): CalendarSyncState {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
  } catch {
    return { lastSync: "", syncedEventIds: [], eventsSynced: 0 };
  }
}

function saveState(state: CalendarSyncState): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// --- EventKit ---

interface CalendarEvent {
  title: string;
  startDate: string;
  endDate: string;
  location?: string;
  calendar?: string;
  isAllDay?: boolean;
  attendees?: string[];
  notes?: string;
  id?: string;
}

function fetchEvents(dayOffset: number): CalendarEvent[] {
  try {
    const output = execSync(
      `swift "${EVENTS_SWIFT}" --offset ${dayOffset}`,
      { encoding: "utf-8", timeout: 30000 }
    );

    // Parse JSON output from GetEvents.swift
    const parsed = JSON.parse(output);
    if (Array.isArray(parsed)) return parsed;
    if (parsed.events && Array.isArray(parsed.events)) return parsed.events;
    return [];
  } catch (err) {
    console.error(`  EventKit fetch failed (offset ${dayOffset}): ${(err as Error).message}`);
    return [];
  }
}

// --- Main ---

async function main() {
  const state = getState();
  const now = new Date();
  const today = now.toISOString().slice(0, 10);

  console.log(`[${now.toISOString()}] Calendar sync starting`);
  console.log(`  Last sync: ${state.lastSync || "never"}`);

  // Fetch today's and yesterday's events
  const todayEvents = fetchEvents(0);
  const yesterdayEvents = fetchEvents(-1);
  const allEvents = [...yesterdayEvents, ...todayEvents];

  console.log(`  Found ${todayEvents.length} today + ${yesterdayEvents.length} yesterday = ${allEvents.length} total`);

  if (allEvents.length === 0) {
    console.log("  No events to sync.");
    saveState({ ...state, lastSync: today });
    return;
  }

  // Generate stable event ID from title + start time
  function eventId(ev: CalendarEvent): string {
    return `${ev.title}|${ev.startDate}`;
  }

  // Filter out already-synced events
  const knownIds = new Set(state.syncedEventIds);
  const newEvents = allEvents.filter(ev => !knownIds.has(eventId(ev)));

  console.log(`  New events: ${newEvents.length} (${allEvents.length - newEvents.length} already synced)`);

  if (newEvents.length === 0) {
    console.log("  All events already synced.");
    saveState({ ...state, lastSync: today });
    return;
  }

  // Batch limit
  const batch = newEvents.slice(0, BATCH_LIMIT);
  let captured = 0;
  let failed = 0;
  const newIds: string[] = [];

  for (const ev of batch) {
    const attendeeList = ev.attendees?.length
      ? `\n**Attendees:** ${ev.attendees.join(", ")}`
      : "";
    const locationLine = ev.location ? `\n**Location:** ${ev.location}` : "";
    const notesLine = ev.notes ? `\n\n${ev.notes.slice(0, 2000)}` : "";
    const calendarLine = ev.calendar ? `\n**Calendar:** ${ev.calendar}` : "";

    const content = `# Calendar: ${ev.title}\n\n**Start:** ${ev.startDate}\n**End:** ${ev.endDate}${locationLine}${calendarLine}${attendeeList}${notesLine}`;

    const evId = eventId(ev);

    try {
      const embedding = await getEmbedding(content);

      // Upsert: delete previous version of this event
      await supabase
        .schema(DOMAIN as any)
        .from("thoughts")
        .delete()
        .eq("metadata->>event_id", evId)
        .eq("metadata->>source", "calendar-sync");

      const { error } = await supabase.schema(DOMAIN as any).from("thoughts").insert({
        content,
        embedding,
        metadata: {
          type: "calendar-event",
          source: "calendar-sync",
          event_id: evId,
          title: ev.title,
          start_date: ev.startDate,
          end_date: ev.endDate,
          location: ev.location || "",
          calendar: ev.calendar || "",
          is_all_day: ev.isAllDay || false,
          attendee_count: ev.attendees?.length || 0,
          sync_date: today,
        },
      });

      if (error) throw error;
      captured++;
      newIds.push(evId);
    } catch (err) {
      console.error(`    FAILED (${ev.title}): ${(err as Error).message}`);
      failed++;
    }

    // Rate limit
    await new Promise(r => setTimeout(r, 200));
  }

  // Keep rolling 7-day window of synced IDs (avoid unbounded growth)
  const MAX_IDS = 500;
  const allIds = [...state.syncedEventIds, ...newIds].slice(-MAX_IDS);

  saveState({
    lastSync: today,
    syncedEventIds: allIds,
    eventsSynced: (state.eventsSynced || 0) + captured,
  });

  console.log(`[${new Date().toISOString()}] Calendar sync complete: ${captured} captured, ${failed} failed`);
}

main().catch(err => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
