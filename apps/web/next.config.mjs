/** @type {import('next').NextConfig} */
import { fileURLToPath } from "node:url";

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
