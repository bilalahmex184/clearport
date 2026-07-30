// ============================================================================
// 11-env-validation.test.ts — Test strict env validation at boot
// ============================================================================
// Asserts the app fails fast when required env vars are missing.
// ============================================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { envSchema, validateEnv } from '@/lib/env';

describe('Environment validation', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    // Restore original env after each test
    process.env = { ...originalEnv };
  });

  it('should fail when NEXT_PUBLIC_SUPABASE_URL is missing', () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    expect(() => envSchema.parse(process.env)).toThrow();
  });

  it('should fail when NEXT_PUBLIC_SUPABASE_URL is not a valid URL', () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'not-a-url';
    expect(() => envSchema.parse(process.env)).toThrow();
  });

  it('should fail when NEXT_PUBLIC_SUPABASE_ANON_KEY is too short', () => {
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'short';
    expect(() => envSchema.parse(process.env)).toThrow();
  });

  it('should warn (not fail) when OPENROUTER_API_KEY is missing', () => {
    delete process.env.OPENROUTER_API_KEY;
    // This should NOT throw — OPENROUTER_API_KEY is optional (regex fallback)
    const result = envSchema.safeParse(process.env);
    expect(result.success).toBe(true);
  });

  it('should fail when OPENROUTER_API_KEY has wrong prefix', () => {
    process.env.OPENROUTER_API_KEY = 'gemini-key-not-openrouter';
    const result = envSchema.safeParse(process.env);
    // The refine check should reject keys that don't start with sk-or-
    expect(result.success).toBe(false);
  });

  it('should accept valid OPENROUTER_API_KEY', () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-v1-test-key-1234567890';
    const result = envSchema.safeParse(process.env);
    expect(result.success).toBe(true);
  });

  it('should accept NEXT_PUBLIC_DEMO_MODE as true or false', () => {
    process.env.NEXT_PUBLIC_DEMO_MODE = 'true';
    expect(envSchema.safeParse(process.env).success).toBe(true);

    process.env.NEXT_PUBLIC_DEMO_MODE = 'false';
    expect(envSchema.safeParse(process.env).success).toBe(true);
  });

  it('should reject invalid NEXT_PUBLIC_DEMO_MODE', () => {
    process.env.NEXT_PUBLIC_DEMO_MODE = 'yes';
    expect(envSchema.safeParse(process.env).success).toBe(false);
  });

  it('validateEnv should throw with a clear message naming the missing var', () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    try {
      validateEnv();
      expect.fail('validateEnv should have thrown');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).toContain('ENVIRONMENT VALIDATION FAILED');
      expect(msg).toContain('NEXT_PUBLIC_SUPABASE_URL');
    }
  });

  it('validateEnv should succeed with all required vars set', () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key-at-least-20-chars';
    process.env.NEXT_PUBLIC_DEMO_MODE = 'true';

    // Should not throw
    const env = validateEnv();
    expect(env.NEXT_PUBLIC_SUPABASE_URL).toBe('https://test.supabase.co');
  });
});
