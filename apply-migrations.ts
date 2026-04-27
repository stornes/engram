#!/usr/bin/env bun
/**
 * Apply pending SQL migrations from migrations/ to the Engram database.
 *
 * Usage:
 *   DATABASE_URL=postgresql://... bun run apply-migrations.ts
 *   bun run apply-migrations.ts --dry-run        # show pending, apply none
 *   bun run apply-migrations.ts --status         # show applied vs pending
 *
 * DATABASE_URL points to the postgres connection string for your Supabase
 * project (Project Settings → Database → Connection string → URI). The
 * Supabase REST URL is NOT enough — this script needs raw SQL access.
 *
 * Tracks state in public.engram_migrations (filename + sha256 + applied_at).
 * Each migration runs in a transaction; a failure rolls the whole file back.
 *
 * Filenames must sort lexicographically in apply order (the existing
 * NNN_*.sql convention does that). Already-applied migrations are skipped.
 * If a previously-applied migration's content changes on disk, the script
 * refuses to proceed — schema drift demands operator review.
 */

import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import postgres from "postgres";
import { loadEnvFiles } from "./lib/env.ts";

loadEnvFiles([
  join(process.env.HOME ?? "", ".claude", "engram", ".env"),
  new URL("./.env", import.meta.url).pathname,
]);

const DATABASE_URL = process.env.DATABASE_URL ?? "";
if (!DATABASE_URL) {
  console.error("DATABASE_URL is required.");
  console.error("Find it in: Supabase Dashboard → Project Settings → Database → Connection string (URI).");
  process.exit(1);
}

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has("--dry-run");
const STATUS_ONLY = args.has("--status");

const MIGRATIONS_DIR = new URL("./migrations/", import.meta.url).pathname;

type Migration = { name: string; path: string; sql: string; sha256: string };

function loadMigrations(): Migration[] {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  return files.map((name) => {
    const path = join(MIGRATIONS_DIR, name);
    const sql = readFileSync(path, "utf-8");
    const sha256 = createHash("sha256").update(sql).digest("hex");
    return { name, path, sql, sha256 };
  });
}

const sql = postgres(DATABASE_URL, { max: 1 });

async function ensureLedger(): Promise<void> {
  await sql`
    create table if not exists public.engram_migrations (
      name        text primary key,
      sha256      text not null,
      applied_at  timestamptz not null default now()
    )
  `;
}

async function appliedRows(): Promise<Map<string, string>> {
  const rows = await sql<{ name: string; sha256: string }[]>`
    select name, sha256 from public.engram_migrations
  `;
  return new Map(rows.map((r) => [r.name, r.sha256]));
}

async function main(): Promise<void> {
  await ensureLedger();
  const migrations = loadMigrations();
  const applied = await appliedRows();

  // Drift check: any applied migration whose disk content has changed.
  const drifted: string[] = [];
  for (const m of migrations) {
    const prior = applied.get(m.name);
    if (prior && prior !== m.sha256) drifted.push(m.name);
  }
  if (drifted.length > 0) {
    console.error("Refusing to proceed: the following applied migrations have changed on disk:");
    for (const name of drifted) console.error(`  - ${name}`);
    console.error("Resolve drift manually (revert the file or write a new migration).");
    process.exit(2);
  }

  const pending = migrations.filter((m) => !applied.has(m.name));

  console.log(`Database: ${redactedDsn(DATABASE_URL)}`);
  console.log(`Applied:  ${applied.size}`);
  console.log(`Pending:  ${pending.length}`);

  if (STATUS_ONLY) {
    if (pending.length > 0) {
      console.log("\nPending migrations:");
      for (const m of pending) console.log(`  - ${m.name}`);
    }
    await sql.end();
    return;
  }

  if (pending.length === 0) {
    console.log("Nothing to do.");
    await sql.end();
    return;
  }

  for (const m of pending) {
    if (DRY_RUN) {
      console.log(`[dry-run] would apply ${m.name} (${m.sha256.slice(0, 12)})`);
      continue;
    }
    console.log(`Applying ${m.name}...`);
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe(m.sql);
        await tx`
          insert into public.engram_migrations (name, sha256)
          values (${m.name}, ${m.sha256})
        `;
      });
      console.log(`  ok`);
    } catch (err) {
      console.error(`  FAILED: ${(err as Error).message}`);
      await sql.end();
      process.exit(3);
    }
  }

  await sql.end();
  console.log(DRY_RUN ? "Dry run complete." : "All migrations applied.");
}

function redactedDsn(dsn: string): string {
  // Mask password component for log output.
  return dsn.replace(/:([^@/]+)@/, ":****@");
}

main().catch((err) => {
  console.error(err);
  sql.end().finally(() => process.exit(1));
});
