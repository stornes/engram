#!/usr/bin/env bun
/**
 * Backfill horizon metadata on existing Engram thoughts.
 *
 * Reads the ontology to get entity_type -> default_horizon mapping,
 * then updates all thoughts in all 4 domain schemas that have a
 * metadata.type but no metadata.horizon.
 *
 * Usage: bun run backfill-horizons.ts [--dry-run]
 */

import { readFileSync } from "fs";
import { parse as parseYaml } from "yaml";
import { loadEnvFile } from "./lib/env.ts";
import { createSupabaseClient } from "./lib/supabase.ts";

const DRY_RUN = process.argv.includes("--dry-run");

loadEnvFile(new URL("./.env", import.meta.url).pathname);

const supabase = createSupabaseClient();

// Load ontology for type -> horizon mapping
const ontologyPath = new URL("./ontology/v1.1.0.yaml", import.meta.url).pathname;
const ontology = parseYaml(readFileSync(ontologyPath, "utf-8"));

const typeToHorizon: Record<string, string> = {};
for (const [typeName, def] of Object.entries(ontology.entity_types || {})) {
  typeToHorizon[typeName] = (def as any).default_horizon || "daily";
}

console.log("Type -> Horizon mapping:");
for (const [t, h] of Object.entries(typeToHorizon)) {
  console.log(`  ${t} -> ${h}`);
}

const SCHEMAS = ["ob_work", "ob_personal", "ob_life", "ob_learning"] as const;
const BATCH_SIZE = 50;

let totalUpdated = 0;
let totalSkipped = 0;
let totalProcessed = 0;

for (const schema of SCHEMAS) {
  console.log(`\n--- ${schema} ---`);

  // Get all thoughts without horizon in metadata
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    const { data, error } = await supabase
      .schema(schema as any)
      .from("thoughts")
      .select("id, metadata")
      .range(offset, offset + BATCH_SIZE - 1)
      .order("created_at", { ascending: true });

    if (error) {
      console.error(`Error reading ${schema}: ${error.message}`);
      break;
    }

    if (!data || data.length === 0) {
      hasMore = false;
      break;
    }

    for (const thought of data) {
      totalProcessed++;
      const meta = (thought.metadata || {}) as Record<string, any>;

      // Skip if already has horizon
      if (meta.horizon) {
        totalSkipped++;
        continue;
      }

      // Determine horizon from type
      const entityType = meta.type || "observation";
      const horizon = typeToHorizon[entityType] || "daily";

      if (DRY_RUN) {
        console.log(`  [dry-run] ${thought.id} (${entityType}) -> ${horizon}`);
        totalUpdated++;
        continue;
      }

      const updatedMeta = { ...meta, horizon };
      const { error: updateError } = await supabase
        .schema(schema as any)
        .from("thoughts")
        .update({ metadata: updatedMeta })
        .eq("id", thought.id);

      if (updateError) {
        console.error(`  Failed ${thought.id}: ${updateError.message}`);
      } else {
        totalUpdated++;
      }

      // Progress
      if (totalUpdated % 100 === 0 && totalUpdated > 0) {
        console.log(`  ${totalUpdated} updated so far (${totalProcessed} processed)`);
      }
    }

    offset += data.length;
    if (data.length < BATCH_SIZE) hasMore = false;
  }

  console.log(`  ${schema} done. Processed so far: ${totalProcessed}`);
}

console.log(`\n=== COMPLETE ===`);
console.log(`Processed: ${totalProcessed}`);
console.log(`Updated: ${totalUpdated}`);
console.log(`Skipped (already had horizon): ${totalSkipped}`);
if (DRY_RUN) console.log("(dry run, no changes written)");
