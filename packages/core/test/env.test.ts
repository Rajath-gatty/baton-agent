/**
 * Dotenv loading.
 *
 * The empty-string case is the reason this module exists, and it is the reason it is
 * tested. `process.loadEnvFile` will not override a variable that already exists, and it
 * counts a variable set to `""` as existing — so on a machine whose shell exports every
 * name it knows about, a correctly-set `MODEL_BASE_URL` in `.env` is silently ignored and
 * the failure surfaces as a missing-configuration error for a value you can see is set.
 *
 * That cost a real half hour during gate G1. These assertions are cheap insurance against
 * someone simplifying this back to the built-in.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadDotEnv } from "../src/env.js";

function writeEnv(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "baton-env-"));
  const path = join(dir, ".env");
  writeFileSync(path, contents, "utf8");
  return path;
}

describe("loadDotEnv", () => {
  it("applies a value when the name is absent", () => {
    const env: NodeJS.ProcessEnv = {};
    const result = loadDotEnv(writeEnv("MODEL_BASE_URL=https://example.test/v1\n"), { env });

    expect(env["MODEL_BASE_URL"]).toBe("https://example.test/v1");
    expect(result.applied).toContain("MODEL_BASE_URL");
  });

  it("treats an empty pre-set variable as absent", () => {
    // The bug. A shell exporting `MODEL_BASE_URL=` must not beat the file.
    const env: NodeJS.ProcessEnv = { MODEL_BASE_URL: "" };
    loadDotEnv(writeEnv("MODEL_BASE_URL=https://example.test/v1\n"), { env });

    expect(env["MODEL_BASE_URL"]).toBe("https://example.test/v1");
  });

  it("lets a real environment value win by default", () => {
    // The container rule: a deployed environment must beat a file in the image.
    const env: NodeJS.ProcessEnv = { MODEL_BASE_URL: "https://real.test/v1" };
    const result = loadDotEnv(writeEnv("MODEL_BASE_URL=https://file.test/v1\n"), { env });

    expect(env["MODEL_BASE_URL"]).toBe("https://real.test/v1");
    expect(result.skipped).toContain("MODEL_BASE_URL");
  });

  it("lets the file win when override is set, for developer diagnostics", () => {
    const env: NodeJS.ProcessEnv = { DEFAULT_MODEL: "stale-from-shell" };
    loadDotEnv(writeEnv("DEFAULT_MODEL=from-file\n"), { env, override: true });

    expect(env["DEFAULT_MODEL"]).toBe("from-file");
  });

  it("reports a disagreement rather than resolving it silently", () => {
    const env: NodeJS.ProcessEnv = { DEFAULT_MODEL: "stale-from-shell" };
    const result = loadDotEnv(writeEnv("DEFAULT_MODEL=from-file\n"), { env, override: true });

    expect(result.conflicts).toContain("DEFAULT_MODEL");
  });

  it("does not report a conflict when the values agree", () => {
    const env: NodeJS.ProcessEnv = { DEFAULT_MODEL: "same" };
    const result = loadDotEnv(writeEnv("DEFAULT_MODEL=same\n"), { env });

    expect(result.conflicts).toEqual([]);
  });

  it("ignores comments and blank lines", () => {
    const env: NodeJS.ProcessEnv = {};
    const result = loadDotEnv(writeEnv("# a comment\n\n  # indented comment\nKEY=value\n"), {
      env,
    });

    expect(result.applied).toEqual(["KEY"]);
    expect(env["KEY"]).toBe("value");
  });

  it("keeps a value containing '=' intact", () => {
    // Connection strings and base64 secrets both contain '='.
    const env: NodeJS.ProcessEnv = {};
    loadDotEnv(writeEnv("DATABASE_URL=postgres://u:p@host/db?opt=1\n"), { env });

    expect(env["DATABASE_URL"]).toBe("postgres://u:p@host/db?opt=1");
  });

  it("strips one matched pair of surrounding quotes", () => {
    const env: NodeJS.ProcessEnv = {};
    loadDotEnv(writeEnv('A="spaced value"\nB=\'single\'\nC="unmatched\n'), { env });

    expect(env["A"]).toBe("spaced value");
    expect(env["B"]).toBe("single");
    // Unmatched quote is left alone rather than half-stripped into something wrong.
    expect(env["C"]).toBe('"unmatched');
  });

  it("returns empty rather than throwing when the file does not exist", () => {
    const env: NodeJS.ProcessEnv = {};
    expect(loadDotEnv(join(tmpdir(), "baton-does-not-exist", ".env"), { env })).toEqual({
      applied: [],
      skipped: [],
      conflicts: [],
    });
  });

  it("handles CRLF line endings", () => {
    // The repository normalises to LF, but a hand-edited .env on Windows may not.
    const env: NodeJS.ProcessEnv = {};
    loadDotEnv(writeEnv("A=one\r\nB=two\r\n"), { env });

    expect(env["A"]).toBe("one");
    expect(env["B"]).toBe("two");
  });
});
