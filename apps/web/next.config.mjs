/** @type {import('next').NextConfig} */
const nextConfig = {
  // Standalone bundles only the files the server actually needs, which keeps the
  // image small and — more usefully here — resolves the pnpm workspace symlinks
  // into real files, so @baton/core works inside the container.
  output: "standalone",

  // The repository root, so the standalone trace follows the workspace symlink
  // into packages/core rather than stopping at apps/web.
  outputFileTracingRoot: new URL("../../", import.meta.url).pathname,

  // Desktop only, one human user. No image optimisation surface needed.
  images: { unoptimized: true },

  eslint: {
    // Linting is a single root config run by `pnpm lint`, not per-app.
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
