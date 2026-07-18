import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

const nextConfig: NextConfig = {
  output: "standalone",
  // P6: ignoreBuildErrors removed — the compiler and linter now gate the build.
  // All tsc errors in src/ have been fixed. CI runs `tsc --noEmit` + `eslint .`
  // on every PR to prevent regressions.
  // P7: reactStrictMode re-enabled — refs are no longer mutated during render,
  // so React's double-render-in-dev behavior is safe.
  reactStrictMode: true,
};

// S6: Sentry webpack wrapper. Wraps the Next.js config so the Sentry plugin
// can instrument the client/server/edge bundles and load the matching
// sentry.{client,server,edge}.config.ts files. Source map uploading is
// intentionally disabled — we don't have a SENTRY_AUTH_TOKEN in this env.
// No-op in dev when no DSN is set: the config files guard Sentry.init() on
// the presence of NEXT_PUBLIC_SENTRY_DSN / SENTRY_DSN.
export default withSentryConfig(nextConfig, {
  // Only run Sentry webpack in production (faster dev builds)
  silent: true,
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  // Disable source map uploading in dev (no auth token)
  widenClientFileUpload: false,
});
