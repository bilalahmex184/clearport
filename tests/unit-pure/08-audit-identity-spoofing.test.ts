// ============================================================================
// 08-audit-identity-spoofing.test.ts
// ============================================================================
// Regression test for §2: audit-trail identity spoofing in update-exception.
//
// The bug: the update-exception edge function accepted `resolvedBy` from the
// client body and used it as the permanent resolved_by value + history user
// field. Any authenticated caller could set it to an arbitrary string.
//
// The fix: resolvedBy is always derived from the server-verified user identity
// (user.email || user.id), never from client input.
//
// This test uses STATIC SOURCE ANALYSIS (reading the source files and asserting
// on their content) rather than runtime calls, because:
//   - The edge function runs on Deno and can't be imported by vitest
//   - The server-side service (exception.service.ts) imports @/lib/supabase
//     which initializes a real Supabase client at import time, causing tests
//     to hang
//
// Static analysis is sufficient here because the bug was a code-structure
// issue (reading resolvedBy from the client body) — we can verify the fix by
// checking that the source no longer destructures resolvedBy from the body
// and instead derives it from user.email || user.id.
// ============================================================================

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function readSource(filePath: string): string {
  return readFileSync(resolve(process.cwd(), filePath), 'utf-8');
}

// ---------------------------------------------------------------------------

describe('update-exception edge function (§2 — audit identity spoofing fix)', () => {
  const source = readSource('supabase/functions/update-exception/index.ts');

  it('does NOT destructure resolvedBy from the request body', () => {
    // The body destructuring line must NOT include resolvedBy
    const destructuringMatch = source.match(/const \{([^}]*)\} = body \|\| \{\};/);
    expect(destructuringMatch).not.toBeNull();
    const destructuredFields = destructuringMatch![1];
    expect(destructuredFields).not.toContain('resolvedBy');
  });

  it('derives the resolver from the server-verified user identity', () => {
    // The resolver must be set from user.email || user.id, not from body
    expect(source).toContain('user.email || user.id');
  });

  it('does NOT contain the old vulnerable pattern (typeof resolvedBy === "string")', () => {
    // The old code was:
    //   const resolver = typeof resolvedBy === "string" && resolvedBy.trim()
    //     ? resolvedBy.trim()
    //     : user.email || user.id;
    expect(source).not.toContain('typeof resolvedBy === "string"');
    expect(source).not.toContain('resolvedBy.trim()');
  });

  it('uses the server-verified resolver for resolved_by, history, and audit log', () => {
    // The `resolver` variable (derived from user.email || user.id) must be
    // used in all three audit-trail positions:
    //   1. historyEntry.user
    //   2. exceptionUpdate.resolved_by
    //   3. auditText (the audit log text)
    expect(source).toContain('user: resolver');
    expect(source).toContain('resolved_by: resolver');
    expect(source).toContain('by ${resolver}');
  });

  it('the input doc comment no longer lists resolvedBy as an accepted field', () => {
    // The JSDoc/input contract should NOT list resolvedBy
    const inputDocMatch = source.match(/Input: JSON \{([^}]*)\}/);
    if (inputDocMatch) {
      expect(inputDocMatch[1]).not.toContain('resolvedBy');
    }
  });
});

describe('API route (exceptions/[id]/route.ts) — server-verified identity', () => {
  const source = readSource('src/app/api/exceptions/[id]/route.ts');

  it('passes getUserEmail(user) as resolvedBy, NOT client input', () => {
    // The API route must call getUserEmail(user) to get the resolver identity
    expect(source).toContain('getUserEmail(user)');
    // It must NOT read resolvedBy from parsed.data (the client-validated body)
    expect(source).not.toContain('parsed.data.resolvedBy');
  });

  it('the validator does not accept resolvedBy from the client', () => {
    const validatorSource = readSource('src/lib/validators/exception.validator.ts');
    // The Zod schema must NOT include resolvedBy
    expect(validatorSource).not.toMatch(/resolvedBy/);
  });
});

describe('service layer (exception.service.ts) — resolvedBy contract', () => {
  const source = readSource('src/lib/services/exception.service.ts');

  it('accepts resolvedBy as a parameter (from the server-verified API route)', () => {
    // The service accepts resolvedBy in its input type — this is fine because
    // the ONLY caller (the API route) passes getUserEmail(user), never client
    // input. The service itself doesn't know or care where resolvedBy came
    // from — the trust boundary is at the API route.
    expect(source).toContain('resolvedBy: string');
  });

  it('uses resolvedBy for resolved_by, history user, and audit log text', () => {
    // The service must use the resolvedBy parameter consistently for all
    // audit-trail positions
    expect(source).toContain('resolved_by: resolvedBy');
    expect(source).toContain('user: resolvedBy');
  });
});
