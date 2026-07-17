import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // P6: ignoreBuildErrors removed — the compiler and linter now gate the build.
  // All tsc errors in src/ have been fixed. CI runs `tsc --noEmit` + `eslint .`
  // on every PR to prevent regressions.
  // P7: reactStrictMode re-enabled — refs are no longer mutated during render,
  // so React's double-render-in-dev behavior is safe.
  reactStrictMode: true,
};

export default nextConfig;
