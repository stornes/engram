import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadEnvFile, loadEnvFiles } from "../lib/env.ts";

let dir: string;
const ENV_KEYS = [
  "ENGRAM_TEST_FOO",
  "ENGRAM_TEST_BAR",
  "ENGRAM_TEST_BAZ",
  "ENGRAM_TEST_QUUX",
  "ENGRAM_TEST_EXISTING",
];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "engram-env-"));
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const k of ENV_KEYS) delete process.env[k];
});

function writeEnv(name: string, content: string): string {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

describe("loadEnvFile", () => {
  test("sets KEY=value lines", () => {
    const path = writeEnv(".env", "ENGRAM_TEST_FOO=hello\nENGRAM_TEST_BAR=world\n");
    loadEnvFile(path);
    expect(process.env.ENGRAM_TEST_FOO).toBe("hello");
    expect(process.env.ENGRAM_TEST_BAR).toBe("world");
  });

  test("does not overwrite existing process.env entries", () => {
    process.env.ENGRAM_TEST_EXISTING = "from-shell";
    writeFileSync(join(dir, ".env"), "ENGRAM_TEST_EXISTING=from-file\n");
    loadEnvFile(join(dir, ".env"));
    expect(process.env.ENGRAM_TEST_EXISTING).toBe("from-shell");
  });

  test("ignores comment and blank lines", () => {
    const path = writeEnv(
      ".env",
      "# a comment\n\nENGRAM_TEST_FOO=ok\n   \n#ENGRAM_TEST_BAR=skipped\n"
    );
    loadEnvFile(path);
    expect(process.env.ENGRAM_TEST_FOO).toBe("ok");
    expect(process.env.ENGRAM_TEST_BAR).toBeUndefined();
  });

  test("trims whitespace around key and value", () => {
    const path = writeEnv(".env", "  ENGRAM_TEST_FOO  =  spaced  \n");
    loadEnvFile(path);
    expect(process.env.ENGRAM_TEST_FOO).toBe("spaced");
  });

  test("handles values containing '=' characters", () => {
    const path = writeEnv(".env", "ENGRAM_TEST_FOO=key=value=more\n");
    loadEnvFile(path);
    expect(process.env.ENGRAM_TEST_FOO).toBe("key=value=more");
  });

  test("missing file is a no-op (does not throw)", () => {
    const missing = join(dir, "does-not-exist.env");
    expect(() => loadEnvFile(missing)).not.toThrow();
  });
});

describe("loadEnvFiles", () => {
  test("earlier files win when both define the same key", () => {
    const a = writeEnv("a.env", "ENGRAM_TEST_FOO=from-a\n");
    const b = writeEnv("b.env", "ENGRAM_TEST_FOO=from-b\n");
    loadEnvFiles([a, b]);
    expect(process.env.ENGRAM_TEST_FOO).toBe("from-a");
  });

  test("merges keys from multiple files", () => {
    const a = writeEnv("a.env", "ENGRAM_TEST_FOO=foo\n");
    const b = writeEnv("b.env", "ENGRAM_TEST_BAR=bar\n");
    loadEnvFiles([a, b]);
    expect(process.env.ENGRAM_TEST_FOO).toBe("foo");
    expect(process.env.ENGRAM_TEST_BAR).toBe("bar");
  });

  test("missing files in the list are skipped", () => {
    const a = writeEnv("a.env", "ENGRAM_TEST_FOO=foo\n");
    expect(() =>
      loadEnvFiles([join(dir, "missing-1"), a, join(dir, "missing-2")])
    ).not.toThrow();
    expect(process.env.ENGRAM_TEST_FOO).toBe("foo");
  });
});
