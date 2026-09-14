/** @type {import('next').NextConfig} */
import { fileURLToPath } from "node:url";

/*
 * Load the repository-root `.env` before the config is read.
 *
 * The monorepo keeps one `.env` at the root — the worker and the agent both reach
 * it through core's `loadDotEnv` — but Next only looks in the app directory, so
 * `apps/web` would otherwise be the one workspace that needs its own copy of the
 * passcode and the session secret. Two copies of a secret is one too many.
 *
 * Deliberately non-fatal: in the container there is no `.env` at all (it is in
 * `.dockerignore`, and Coolify injects the environment), so a missing file is the
 * normal production case and not an error. Anything already in `process.env` is
 * left alone by Node here, which is the right precedence — a real environment
 * variable must beat a file.
 */
try {
  process.loadEnvFile(fileURLToPath(new URL("../../.env", import.meta.url)));
} catch {
  // No root .env — expected in the container, where the environment is injected.
}

const nextConfig = {
  // Standalone bundles only the files the server actually needs, which keeps the
  // image small and — more usefully here — resolves the pnpm workspace symlinks
  // into real files, so @baton/core works inside the container.
  output: "standalone",

  // The repository root, so the standalone trace follows the workspace symlink
  // into packages/core rather than stopping at apps/web. Resolved with
  // `fileURLToPath` rather than `URL.pathname`: on Windows, and on any path
  // containing spaces, `.pathname` leaves a leading slash before the drive
  // letter and percent-encoded spaces, which made the tracer write a duplicated
  // directory tree. `fileURLToPath` yields a real filesystem path on every OS.
  outputFileTracingRoot: fileURLToPath(new URL("../../", import.meta.url)),

  // Desktop only, one human user. No image optimisation surface needed.
  images: { unoptimized: true },

  eslint: {
    // Linting is a single root config run by `pnpm lint`, not per-app.
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
