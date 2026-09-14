/**
 * Dotenv loading for CLI entry points.
 *
 * **Why this exists rather than `process.loadEnvFile`.** Node's built-in loader will not
 * override a variable that already exists in the environment — and it counts a variable
 * set to the **empty string** as existing. Some shells and process managers export every
 * name they know about, empty ones included, so on such a machine `MODEL_BASE_URL=` in
 * the ambient environment silently beats `MODEL_BASE_URL=https://...` in the file. The
 * failure is a config error from a variable you can see correctly set in `.env`, which is
 * a genuinely nasty half hour.
 *
 * So an empty value is treated as absent. A variable that is meaningfully set in the
 * environment still wins, because that is how a container overrides a local file.
 *
 * Only CLI paths should call this. Long-running services read their real environment:
 * silently absorbing a stray local `.env` inside a container would be a way to deploy
 * against the wrong database.
 */

import { readFileSync } from "node:fs";

export interface LoadDotEnvResult {
  /** Names taken from the file, because they were absent or empty. */
  applied: string[];
  /** Names left alone, because the environment had a real value. */
  skipped: string[];
  /**
   * Names where the environment and the file both had real values that differ.
   *
   * Surfaced rather than resolved silently. A developer whose shell exports a stale
   * `DEFAULT_MODEL` sees a smoke test use a model that appears nowhere in their `.env`,
   * and there is otherwise nothing to tell them why.
   */
  conflicts: string[];
}

export interface LoadDotEnvOptions {
  /**
   * Let the file win over a variable already set in the environment.
   *
   * Default `false`, which is correct for anything long-running: a container's
   * environment must beat a file that happened to be copied into the image.
   *
   * CLI diagnostics pass `true`, because their purpose is to exercise the configuration
   * the developer actually wrote down, and a shell that exports empty or stale values
   * would otherwise quietly test something else.
   */
  override?: boolean;
  env?: NodeJS.ProcessEnv;
}

/**
 * Applies `path` to `process.env`, filling names that are absent or empty.
 *
 * Returns rather than throws when the file is missing: a repository with no `.env` is a
 * normal state, and the caller's own validation reports what is actually required.
 */
export function loadDotEnv(path: string, options: LoadDotEnvOptions = {}): LoadDotEnvResult {
  const { override = false, env = process.env } = options;

  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch {
    return { applied: [], skipped: [], conflicts: [] };
  }

  const applied: string[] = [];
  const skipped: string[] = [];
  const conflicts: string[] = [];

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;

    const separator = line.indexOf("=");
    if (separator === -1) continue;

    const key = line.slice(0, separator).trim();
    if (key === "") continue;

    let value = line.slice(separator + 1).trim();

    // Strip one matched pair of surrounding quotes, so a quoted value with spaces works.
    const quote = value[0];
    if (value.length >= 2 && (quote === '"' || quote === "'") && value.endsWith(quote)) {
      value = value.slice(1, -1);
    }

    const existing = env[key];
    const isSet = existing !== undefined && existing !== "";

    if (isSet && existing !== value) conflicts.push(key);

    if (isSet && !override) {
      skipped.push(key);
      continue;
    }

    env[key] = value;
    applied.push(key);
  }

  return { applied, skipped, conflicts };
}
