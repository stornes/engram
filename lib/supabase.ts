/**
 * Singleton Supabase service-role client used by every entry point that
 * writes to or queries the engram schemas.
 *
 * Reads SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (with SUPABASE_SERVICE_KEY
 * as a legacy fallback) from process.env, so callers must ensure env is
 * loaded first (e.g. via lib/env.ts or the launcher).
 *
 * Throws on missing credentials rather than producing an unconfigured client
 * that fails opaquely on the first call.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let cached: SupabaseClient | null = null;

export function createSupabaseClient(): SupabaseClient {
  if (cached) return cached;

  const url = process.env.SUPABASE_URL ?? "";
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ??
    process.env.SUPABASE_SERVICE_KEY ??
    "";

  if (!url) throw new Error("SUPABASE_URL is required");
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is required");

  cached = createClient(url, key);
  return cached;
}

/** Test seam: clear the cached client (no production callers). */
export function _resetSupabaseClient(): void {
  cached = null;
}
