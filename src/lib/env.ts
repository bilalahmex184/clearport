// ============================================================================
// env.ts — Strict environment validation at boot
// ============================================================================
// Validates every env var the app reads. If any required var is missing or
// malformed, throws immediately with a message naming exactly which var and
// why. The app must refuse to boot rather than run in a partially-configured
// state.
//
// Call envSchema.parse(process.env) at the top of instrumentation.ts (or the
// earliest Next.js boot hook). In Phase 3, call it in each Cloudflare
// Worker's entry file.
// ============================================================================

import { z } from 'zod';

export const envSchema = z.object({
  // --- Supabase (required) ---
  NEXT_PUBLIC_SUPABASE_URL: z.string().url('NEXT_PUBLIC_SUPABASE_URL must be a valid URL'),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(20, 'NEXT_PUBLIC_SUPABASE_ANON_KEY must be at least 20 characters'),

  // --- AI Extraction Provider (required for AI mode, optional for regex-only) ---
  OPENROUTER_API_KEY: z.string().min(10, 'OPENROUTER_API_KEY must be at least 10 characters').optional()
    .refine(val => !val || val.startsWith('sk-or-'), 'OPENROUTER_API_KEY should start with "sk-or-"'),

  // --- Demo mode (optional, defaults to false) ---
  NEXT_PUBLIC_DEMO_MODE: z.enum(['true', 'false']).optional().default('false'),

  // --- App URL (optional) ---
  NEXT_PUBLIC_APP_URL: z.string().url().optional(),

  // --- Stripe (optional — billing is a stub) ---
  STRIPE_SECRET_KEY: z.string().optional(),

  // --- Service role key (optional — only needed for worker/admin operations) ---
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),

  // --- Internal OCR secret (optional — legacy, OCR route is deprecated) ---
  INTERNAL_OCR_SECRET: z.string().optional(),

  // --- Sentry (optional) ---
  NEXT_PUBLIC_SENTRY_DSN: z.string().optional(),
  SENTRY_DSN: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Parse and validate environment variables. Throws on first invalid/missing
 * required var with a clear message. Call this at the very top of the app's
 * entry point.
 *
 * In development, prints a summary of which vars are configured.
 */
export function validateEnv(): Env {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const errors = result.error.issues.map(issue => {
      const varName = issue.path.join('.');
      return `  ❌ ${varName}: ${issue.message}`;
    }).join('\n');

    throw new Error(
      `\n` +
      `========================================\n` +
      `ENVIRONMENT VALIDATION FAILED\n` +
      `========================================\n` +
      `The following environment variables are missing or invalid:\n\n` +
      `${errors}\n\n` +
      `The app refuses to boot in a partially-configured state.\n` +
      `Fix these in your .env file and restart.\n` +
      `See .env.example for documentation.\n` +
      `========================================`
    );
  }

  const env = result.data;

  // Warn about optional but recommended vars
  if (!env.OPENROUTER_API_KEY) {
    console.warn(
      '[env] OPENROUTER_API_KEY is not set — AI extraction is disabled. ' +
      'The pipeline will fall back to regex-only extraction (degraded mode). ' +
      'Get a key at https://openrouter.ai/keys'
    );
  }

  if (env.NEXT_PUBLIC_DEMO_MODE === 'true') {
    console.warn(
      '[env] NEXT_PUBLIC_DEMO_MODE=true — anonymous sign-in is enabled. ' +
      'Set to false in production.'
    );
  }

  return env;
}

/**
 * Get the validated env. Must be called after validateEnv() has been called
 * at least once (typically at boot). Returns a cached parse result.
 */
let _cachedEnv: Env | null = null;

export function getEnv(): Env {
  if (!_cachedEnv) {
    _cachedEnv = validateEnv();
  }
  return _cachedEnv;
}
