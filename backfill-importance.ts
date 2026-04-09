#!/usr/bin/env bun
/**
 * Backfill importance scores on existing OpenBrain thoughts.
 *
 * Reads entity_type -> importance heuristic from hardcoded weights,
 * applies computeImportance(metadata, created_at) to all thoughts
 * where importance IS NULL.
 *
 * Usage: bun run backfill-importance.ts [--dry-run]
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";

const DRY_RUN = process.argv.includes("--dry-run");

// Load env
const envPath = new URL("./.env", import.meta.url).pathname;
try {
  const envContent = readFileSync(envPath, "utf-8");
  for (const line of envContent.split("\n")) {
    const match = line.match(/^([^#=]+)=(.+)$/);
    if (match) {
      if (!process.env[match[1].trim()]) process.env[match[1].trim()] = match[2].trim();
    }
  }
} catch {}

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

if (!SUPABASE_KEY) {
  console.error("SUPABASE_SERVICE_ROLE_KEY required");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Importance scoring (mirrors server.ts)
const TYPE_WEIGHTS: Record<string, number> = {
  project: 0.9, project_risk: 0.8, project_decision: 0.85, project_milestone: 0.8,
  project_dependency: 0.7, project_cost: 0.7,
  decision: 0.8, goal: 0.85, belief: 0.8,
  meeting: 0.5, colleague_note: 0.4, person_note: 0.6,
  health: 0.7, financial: 0.7, custody: 0.7,
  daily_briefing: 0.2, observation: 0.3, task: 0.4,
  email: 0.2, idea: 0.5, learning: 0.5, research: 0.6, reference: 0.5,
};

const HORIZON_WEIGHTS: Record<string, number> = {
  quarterly: 0.9, monthly: 0.6, weekly: 0.4, daily: 0.2,
};

function computeImportance(metadata: Record<string, any>, createdAt: string): number {
  const type = metadata.type || "observation";
  const horizon = metadata.horizon || "daily";
  const typeW = TYPE_WEIGHTS[type] ?? 0.3;
  const horizonW = HORIZON_WEIGHTS[horizon] ?? 0.3;
  const ageMs = Date.now() - new Date(createdAt).getTime();
  const ageDays = ageMs / 86400000;
  const recency = Math.max(0.1, 1.0 / (1.0 + ageDays / 30));
  return Math.round((typeW * 0.5 + horizonW * 0.3 + recency * 0.2) * 100) / 100;
}

const SCHEMAS = ["ob_work", "ob_personal", "ob_life", "ob_learning"] as const;
const BATCH_SIZE = 50;

let totalUpdated = 0;
let totalSkipped = 0;
let totalProcessed = 0;

for (const schema of SCHEMAS) {
  console.log(`\n--- ${schema} ---`);
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    const { data, error } = await supabase
      .schema(schema as any)
      .from("thoughts")
      .select("id, metadata, created_at, importance")
      .range(offset, offset + BATCH_SIZE - 1)
      .order("created_at", { ascending: true });

    if (error) {
      console.error(`Error reading ${schema}: ${error.message}`);
      break;
    }
    if (!data || data.length === 0) { hasMore = false; break; }

    for (const thought of data) {
      totalProcessed++;
      if (thought.importance !== null && thought.importance !== undefined) {
        totalSkipped++;
        continue;
      }

      const importance = computeImportance(
        (thought.metadata || {}) as Record<string, any>,
        thought.created_at
      );

      if (DRY_RUN) {
        const type = (thought.metadata as any)?.type || "?";
        if (totalUpdated < 10) console.log(`  [dry-run] ${thought.id} (${type}) -> ${importance}`);
        totalUpdated++;
        continue;
      }

      const { error: updateError } = await supabase
        .schema(schema as any)
        .from("thoughts")
        .update({ importance })
        .eq("id", thought.id);

      if (updateError) {
        console.error(`  Failed ${thought.id}: ${updateError.message}`);
      } else {
        totalUpdated++;
      }

      if (totalUpdated % 100 === 0 && totalUpdated > 0) {
        console.log(`  ${totalUpdated} updated (${totalProcessed} processed)`);
      }
    }

    offset += data.length;
    if (data.length < BATCH_SIZE) hasMore = false;
  }
}

console.log(`\n=== COMPLETE ===`);
console.log(`Processed: ${totalProcessed}`);
console.log(`Updated: ${totalUpdated}`);
console.log(`Skipped (already had importance): ${totalSkipped}`);
if (DRY_RUN) console.log("(dry run, no changes written)");
