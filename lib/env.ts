/**
 * Minimal .env file loader. Reads `KEY=value` lines and sets process.env
 * entries that are not already defined (existing process.env always wins).
 *
 * Designed for sync / backfill scripts that traditionally load credentials
 * from `~/.claude/engram/.env`. The MCP server (server.ts) doesn't use it —
 * its env is provided by the launcher.
 *
 * Quietly returns on missing files.
 */

import { readFileSync } from "node:fs";

export function loadEnvFile(path: string): void {
  let content: string;
  try {
    content = readFileSync(path, "utf-8");
  } catch {
    return;
  }
  for (const line of content.split("\n")) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (!m) continue;
    const key = m[1].trim();
    const val = m[2].trim();
    if (!process.env[key]) process.env[key] = val;
  }
}

export function loadEnvFiles(paths: string[]): void {
  for (const p of paths) loadEnvFile(p);
}

/** Conventional default location: `~/.claude/engram/.env`. */
export function defaultEnvPath(): string {
  return `${process.env.HOME ?? ""}/.claude/engram/.env`;
}
