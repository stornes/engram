import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { _resetSupabaseClient, createSupabaseClient } from "../lib/supabase.ts";

const KEYS = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SERVICE_KEY"];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  _resetSupabaseClient();
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  _resetSupabaseClient();
});

describe("createSupabaseClient", () => {
  test("throws when SUPABASE_URL is missing", () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key";
    expect(() => createSupabaseClient()).toThrow(/SUPABASE_URL/);
  });

  test("throws when service role key is missing", () => {
    process.env.SUPABASE_URL = "https://example.supabase.co";
    expect(() => createSupabaseClient()).toThrow(/SUPABASE_SERVICE_ROLE_KEY/);
  });

  test("accepts SUPABASE_SERVICE_KEY as a legacy fallback", () => {
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_KEY = "legacy-key";
    expect(() => createSupabaseClient()).not.toThrow();
  });

  test("returns the same cached client on repeated calls", () => {
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key";
    const a = createSupabaseClient();
    const b = createSupabaseClient();
    expect(a).toBe(b);
  });

  test("_resetSupabaseClient clears the cache so a new client is built", () => {
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key";
    const a = createSupabaseClient();
    _resetSupabaseClient();
    const b = createSupabaseClient();
    expect(a).not.toBe(b);
  });
});
