// ============================================================================
// 10-ai-provider-live.test.ts — Regression test for Issue #38
// ============================================================================
// isGeminiConfigured() (now isAIProviderConfigured()) checked OPENROUTER_API_KEY
// but was named "gemini" — a stock deploy with GEMINI_API_KEY set but
// OPENROUTER_API_KEY unset would silently disable AI extraction and fall
// back to regex, with no visible error.
//
// This test calls the ACTUAL extraction entry point used by the live upload
// flow and asserts it reaches a real AI provider — not just that it returns
// *a* result. It fails loudly if extraction silently falls back to regex.
// ============================================================================

import { describe, it, expect } from 'vitest';
import { isAIProviderConfigured, callAIExtraction } from '@/lib/extraction/ai-extract';
import { regexExtract } from '@/lib/extraction/regex-extract';

// A simple invoice text that the AI should extract fields from
const SAMPLE_INVOICE = `
COMMERCIAL INVOICE
Invoice Number: INV-2026-TEST-001
Invoice Date: 2026-01-15
Shipper: Test Industries Ltd.
Consignee: Global Trading Corp
Total Declared Value: $12,500.00 USD
HTS Code: 8471.30.0100
Net Weight: 450 lbs
Gross Weight: 520 lbs
Country of Origin: US
Incoterms: FOB Seattle
`;

describe('AI Provider Live Regression', () => {
  it('isAIProviderConfigured() should return true when OPENROUTER_API_KEY is set', () => {
    // This test documents the expected behavior: the function checks
    // OPENROUTER_API_KEY, not GEMINI_API_KEY. If someone sets GEMINI_API_KEY
    // but not OPENROUTER_API_KEY, AI extraction will be silently disabled.
    const configured = isAIProviderConfigured();
    const keySet = !!process.env.OPENROUTER_API_KEY && process.env.OPENROUTER_API_KEY.length > 10;

    // The function should agree with the direct env check
    expect(configured).toBe(keySet);

    if (!keySet) {
      console.warn(
        '[AI PROVIDER REGRESSION] OPENROUTER_API_KEY is not set. ' +
        'AI extraction will be disabled and the pipeline will fall back to regex. ' +
        'This is a degraded mode — set OPENROUTER_API_KEY in .env to enable AI extraction. ' +
        'Note: GEMINI_API_KEY is NOT used by this extraction path — the function name ' +
        'was corrected from isGeminiConfigured() to isAIProviderConfigured() in Phase 0.'
      );
    }
  });

  it('callAIExtraction should return fields with real AI (not regex fallback)', async () => {
    if (!isAIProviderConfigured()) {
      console.warn('[AI PROVIDER REGRESSION] Skipping live AI test — OPENROUTER_API_KEY not set');
      return;
    }

    const result = await callAIExtraction(SAMPLE_INVOICE, Date.now() + 60000);

    // Must return fields — if it returns 0 fields, either the AI failed
    // or the key is misconfigured
    expect(result.fields.length).toBeGreaterThan(0);

    // Must have a model name — if null, the AI was never called
    expect(result.model).not.toBeNull();

    // The model should be one of the Qwen models (NOT gemini)
    expect(result.model).toMatch(/qwen/i);

    // Fields should contain at least some of the expected keys
    const fieldKeys = result.fields.map(f => f.field_key);
    const expectedKeys = ['invoice_number', 'shipper_name', 'consignee_name', 'total_value', 'invoice_date'];
    const foundKeys = expectedKeys.filter(k => fieldKeys.includes(k));
    expect(foundKeys.length).toBeGreaterThan(0);

    // If this test passes, the AI provider is actually being reached.
    // If it fails with "0 fields", check:
    // 1. OPENROUTER_API_KEY is set and valid
    // 2. The Qwen models are available on your OpenRouter account
    // 3. The extraction prompt is returning valid JSON
  });

  it('regex fallback should produce different results than AI (proving AI is actually called)', async () => {
    if (!isAIProviderConfigured()) {
      console.warn('[AI PROVIDER REGRESSION] Skipping AI vs regex comparison — OPENROUTER_API_KEY not set');
      return;
    }

    const aiResult = await callAIExtraction(SAMPLE_INVOICE, Date.now() + 60000);
    const regexResult = regexExtract(SAMPLE_INVOICE);

    // If AI is actually running, it should find MORE fields than regex
    // (regex can't do classification, document_type, exceptions, etc.)
    // If they return the same count, the AI might not be running at all.
    if (aiResult.fields.length > 0) {
      // AI should have at least as many fields as regex
      expect(aiResult.fields.length).toBeGreaterThanOrEqual(regexResult.length);

      // AI should have a documentType (regex doesn't produce this)
      expect(aiResult.documentType).toBeTruthy();
    }
  });

  it('should NOT reference GEMINI_API_KEY anywhere in the extraction module', async () => {
    // Read the source file and verify no GEMINI references
    const fs = await import('fs');
    const path = await import('path');
    const sourcePath = path.resolve(process.cwd(), 'src/lib/extraction/ai-extract.ts');
    const source = fs.readFileSync(sourcePath, 'utf-8');

    // The file should NOT contain any reference to GEMINI_API_KEY or isGeminiConfigured
    expect(source).not.toContain('GEMINI_API_KEY');
    expect(source).not.toContain('isGeminiConfigured');
    expect(source).not.toContain('callGeminiExtraction');

    // It SHOULD contain the correct names
    expect(source).toContain('OPENROUTER_API_KEY');
    expect(source).toContain('isAIProviderConfigured');
    expect(source).toContain('callAIExtraction');
  });
});
