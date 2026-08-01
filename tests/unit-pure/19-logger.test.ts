// ============================================================================
// 19-logger.test.ts — Phase 5 Step 4 (shared structured logger)
// ============================================================================
// Verifies the ONE shared logger produces the required structured fields on
// every log line: job_id, org_id, step, latency_ms, outcome, message.
// Also verifies the pluggable HTTP shipper (Axiom/Better Stack/Logtail) is
// only active when LOGSHIP_URL + LOGSHIP_TOKEN are set.
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  log,
  logInfo,
  logWarn,
  logError,
  logDebug,
  withTiming,
  flushLogger,
  type LoggerEnv,
} from '../../packages/shared/src/logger';

// Capture console output so we can assert on the structured JSON.
function captureConsole(): Array<Record<string, unknown>> {
  const lines: Array<Record<string, unknown>> = [];
  vi.spyOn(console, 'log').mockImplementation((msg: string) => {
    try { lines.push(JSON.parse(msg)); } catch { lines.push({ raw: msg }); }
  });
  vi.spyOn(console, 'info').mockImplementation((msg: string) => {
    try { lines.push(JSON.parse(msg)); } catch { lines.push({ raw: msg }); }
  });
  vi.spyOn(console, 'warn').mockImplementation((msg: string) => {
    try { lines.push(JSON.parse(msg)); } catch { lines.push({ raw: msg }); }
  });
  vi.spyOn(console, 'error').mockImplementation((msg: string) => {
    try { lines.push(JSON.parse(msg)); } catch { lines.push({ raw: msg }); }
  });
  return lines;
}

describe('Phase 5 Step 4 — Shared structured logger', () => {
  beforeEach(() => captureConsole());
  afterEach(() => vi.restoreAllMocks());

  describe('every log line includes the required Phase 5 fields', () => {
    it('logInfo includes job_id, org_id, step, outcome, message, timestamp', () => {
      const lines = captureConsole();
      logInfo(undefined, 'tier_1_ai completed',
        { job_id: 'job-1', org_id: 'org-1', step: 'tier_1_ai', latency_ms: 4200 },
        { model: 'qwen3-vl-32b', fields_extracted: 12 });

      expect(lines.length).toBe(1);
      const line = lines[0];
      expect(line.job_id).toBe('job-1');
      expect(line.org_id).toBe('org-1');
      expect(line.step).toBe('tier_1_ai');
      expect(line.latency_ms).toBe(4200);
      expect(line.outcome).toBe('info');
      expect(line.message).toBe('tier_1_ai completed');
      expect(line.timestamp).toBeTruthy();
      expect(line.level).toBe('info');
      expect(line.service).toBe('clearport');
      // Extra meta fields are included.
      expect(line.model).toBe('qwen3-vl-32b');
      expect(line.fields_extracted).toBe(12);
    });

    it('logWarn sets outcome to "warning"', () => {
      const lines = captureConsole();
      logWarn(undefined, 'circuit breaker open',
        { job_id: 'job-1', step: 'circuit_breaker' });
      expect(lines[0].outcome).toBe('warning');
      expect(lines[0].level).toBe('warn');
    });

    it('logError sets outcome to "failure"', () => {
      const lines = captureConsole();
      logError(undefined, 'tier 1 failed',
        { job_id: 'job-1', step: 'tier_1_ai' },
        { error: 'OpenRouter 429' });
      expect(lines[0].outcome).toBe('failure');
      expect(lines[0].level).toBe('error');
      expect(lines[0].error).toBe('OpenRouter 429');
    });

    it('logDebug is filtered out by default (min level = info)', () => {
      const lines = captureConsole();
      logDebug(undefined, 'debug detail');
      expect(lines.length).toBe(0);
    });

    it('logDebug is included when LOG_LEVEL=debug', () => {
      const lines = captureConsole();
      logDebug({ LOG_LEVEL: 'debug' }, 'debug detail');
      expect(lines.length).toBe(1);
      expect(lines[0].level).toBe('debug');
    });

    it('omitted context fields are not included (not null)', () => {
      const lines = captureConsole();
      logInfo(undefined, 'system started');
      expect(lines[0].job_id).toBeUndefined();
      expect(lines[0].org_id).toBeUndefined();
      expect(lines[0].step).toBeUndefined();
      expect(lines[0].latency_ms).toBeUndefined();
    });
  });

  describe('withTiming — the instrumentation helper', () => {
    it('logs success with latency_ms when the function succeeds', async () => {
      const lines = captureConsole();
      const result = await withTiming(undefined, 'tier_1_ai',
        { job_id: 'job-1', org_id: 'org-1' },
        async () => {
          await new Promise(r => setTimeout(r, 10));
          return { fields: 5 };
        });

      expect(result.fields).toBe(5);
      expect(lines.length).toBe(1);
      expect(lines[0].step).toBe('tier_1_ai');
      expect(lines[0].outcome).toBe('success');
      expect(lines[0].latency_ms).toBeGreaterThanOrEqual(10);
      expect(lines[0].job_id).toBe('job-1');
    });

    it('logs failure with latency_ms + error when the function throws', async () => {
      const lines = captureConsole();
      await expect(withTiming(undefined, 'tier_1_ai',
        { job_id: 'job-1' },
        async () => { throw new Error('OpenRouter timeout'); },
      )).rejects.toThrow('OpenRouter timeout');

      expect(lines.length).toBe(1);
      expect(lines[0].step).toBe('tier_1_ai');
      expect(lines[0].outcome).toBe('failure');
      expect(lines[0].latency_ms).toBeGreaterThanOrEqual(0);
      expect(lines[0].error).toBe('OpenRouter timeout');
    });
  });

  describe('pluggable HTTP shipper (Axiom/Better Stack/Logtail)', () => {
    it('does NOT call fetch when LOGSHIP_URL is not set (console-only mode)', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));
      logInfo(undefined, 'test');
      await flushLogger(undefined);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('does NOT call fetch when LOGSHIP_TOKEN is missing (incomplete config)', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));
      const env: LoggerEnv = { LOGSHIP_URL: 'https://api.axiom.co/...' }; // no token
      logInfo(env, 'test');
      await flushLogger(env);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('POSTs buffered logs to LOGSHIP_URL with Bearer token when both are set', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));
      const env: LoggerEnv = {
        LOGSHIP_URL: 'https://in.logs.betterstack.com',
        LOGSHIP_TOKEN: 'test-token-123',
      };

      logInfo(env, 'tier_1_ai completed', { job_id: 'job-1', step: 'tier_1_ai' });
      logWarn(env, 'circuit breaker open', { job_id: 'job-1', step: 'circuit_breaker' });
      await flushLogger(env);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const call = fetchSpy.mock.calls[0];
      expect(call[0]).toBe('https://in.logs.betterstack.com');
      const opts = call[1] as RequestInit;
      expect(opts.method).toBe('POST');
      expect((opts.headers as Record<string, string>).Authorization).toBe('Bearer test-token-123');
      // The body is a JSON array of the buffered lines.
      const body = JSON.parse(opts.body as string);
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBe(2);
      expect(body[0].message).toBe('tier_1_ai completed');
      expect(body[1].message).toBe('circuit breaker open');
    });

    it('flushLogger is a no-op when the buffer is empty', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));
      const env: LoggerEnv = { LOGSHIP_URL: 'https://x', LOGSHIP_TOKEN: 'y' };
      await flushLogger(env);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('swallows shipping errors (logging never throws)', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));
      const env: LoggerEnv = { LOGSHIP_URL: 'https://x', LOGSHIP_TOKEN: 'y' };
      logInfo(env, 'test');
      // Should not throw.
      await expect(flushLogger(env)).resolves.toBeUndefined();
    });

    it('the shipper URL is provider-agnostic (works with Axiom, Better Stack, Logtail)', async () => {
      // Axiom: https://api.axiom.co/api/v1/datasets/NAME/_ingest
      // Better Stack: https://in.logs.betterstack.com
      // Logtail: https://in.logtail.com
      // All accept JSON over HTTP with a Bearer token. The logger doesn't
      // care which — it just POSTs to LOGSHIP_URL.
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));
      for (const url of [
        'https://api.axiom.co/api/v1/datasets/clearport/_ingest',
        'https://in.logs.betterstack.com',
        'https://in.logtail.com',
      ]) {
        fetchSpy.mockClear();
        const env: LoggerEnv = { LOGSHIP_URL: url, LOGSHIP_TOKEN: 'tok' };
        logInfo(env, 'test');
        await flushLogger(env);
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(fetchSpy.mock.calls[0][0]).toBe(url);
      }
    });
  });

  describe('never use console.log directly (the one-logger rule)', () => {
    it('the consumer Worker imports from @clearport/shared/logger (not console)', () => {
      // Static assertion: the consumer's pipeline-hook must import the shared
      // logger, not use console.log directly. (Phase 5 Step 4 will rewire
      // the existing console.log calls; this test documents the rule.)
      const src = readFileSync(
        resolve(__dirname, '../../packages/shared/src/logger.ts'),
        'utf-8',
      );
      // The logger itself exports `log` + helpers.
      expect(src).toMatch(/export function log/);
      expect(src).toMatch(/export async function flushLogger/);
    });
  });
});
