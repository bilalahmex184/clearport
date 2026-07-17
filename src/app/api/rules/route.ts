// ============================================================================
// /api/rules — operational thresholds (GET + PATCH)
// ============================================================================
//
// GET   /api/rules
//   → { rules: OperationalRules }  (auto-creates defaults 80/85/75 if missing)
//   (RBAC: viewer)
//
// PATCH /api/rules  { invoiceThreshold?, htsThreshold?, partiesThreshold? }
//   → { rules: OperationalRules }
//   (RBAC: admin)
//
// There is one rules row per org (keyed by org_id). If the row doesn't exist
// yet, GET auto-creates it with the spec defaults (80/85/75) for the active
// org. The active org is resolved from the X-Org-Id header (or the user's
// first membership) via `requireOrgRole()`.
// ============================================================================

import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireOrgRole, getUserEmail } from '@/lib/services/auth.service';
import { updateRulesSchema } from '@/lib/validators/rules.validator';
import { logRulesUpdate } from '@/lib/services/audit-log.service';
import { errorResponse, AppError } from '@/lib/utils/error-handler';
import { logger } from '@/lib/utils/logger';
import type {
  OperationalRules,
  DbOperationalRules,
} from '@/lib/clearport-types';

const DEFAULT_RULES: OperationalRules = {
  invoiceThreshold: 80,
  htsThreshold: 85,
  partiesThreshold: 75,
};

function isSchemaNotDeployed(message: string): boolean {
  return (
    message.includes('PGRST205') ||
    message.includes('42P01') ||
    message.includes('does not exist')
  );
}

function wrapDbError(action: string, message: string): AppError {
  if (isSchemaNotDeployed(message)) {
    return new AppError(
      'Schema not deployed. Run supabase/schema.sql in Supabase SQL Editor.',
      500,
      'SCHEMA_NOT_DEPLOYED',
      { action, dbError: message },
    );
  }
  return new AppError(`Failed to ${action}`, 500, 'DB_ERROR', message);
}

function mapDbToRules(db: DbOperationalRules): OperationalRules {
  return {
    invoiceThreshold: db.invoice_threshold,
    htsThreshold: db.hts_threshold,
    partiesThreshold: db.parties_threshold,
  };
}

/**
 * Fetch the active org's rules row. If it doesn't exist, create it with the
 * spec defaults and return those. RLS ensures only the active org's row is
 * visible; the explicit `.eq('org_id', orgId)` makes that intent clear.
 */
async function getOrCreateRules(
  client: SupabaseClient,
  orgId: string,
): Promise<OperationalRules> {
  const { data, error } = await client
    .from('operational_rules')
    .select('*')
    .eq('org_id', orgId)
    .maybeSingle();

  if (error) {
    throw wrapDbError('fetch operational_rules', error.message);
  }

  if (data) {
    return mapDbToRules(data as DbOperationalRules);
  }

  // Auto-create with defaults. user_id is set by the trigger; org_id is
  // explicitly set to the active org.
  const payload = {
    invoice_threshold: DEFAULT_RULES.invoiceThreshold,
    hts_threshold: DEFAULT_RULES.htsThreshold,
    parties_threshold: DEFAULT_RULES.partiesThreshold,
    org_id: orgId,
    updated_at: new Date().toISOString(),
  };

  const { data: created, error: insertErr } = await client
    .from('operational_rules')
    .insert(payload)
    .select()
    .maybeSingle();

  if (insertErr) {
    throw wrapDbError('create default operational_rules', insertErr.message);
  }

  logger.info('Created default operational_rules row', { orgId });
  return mapDbToRules(created as DbOperationalRules);
}

// ---------------------------------------------------------------------------
// GET (viewer)
// ---------------------------------------------------------------------------

export async function GET(req: Request) {
  try {
    const { client, orgId, role } = await requireOrgRole(req, 'viewer');
    const rules = await getOrCreateRules(client, orgId);

    logger.debug('Rules fetched', { orgId, role });
    return NextResponse.json({ rules });
  } catch (err) {
    return errorResponse(err);
  }
}

// ---------------------------------------------------------------------------
// PATCH — partial update (admin only)
// ---------------------------------------------------------------------------

export async function PATCH(req: Request) {
  try {
    const { user, client, orgId, role } = await requireOrgRole(req, 'admin');

    const body = await req.json().catch(() => null);
    if (!body) {
      return NextResponse.json(
        { error: 'Invalid JSON body' },
        { status: 400 },
      );
    }

    const parsed = updateRulesSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.flatten() },
        { status: 422 },
      );
    }

    // Load the current rules (auto-creates defaults if missing) so we can
    // merge the patch rather than overwriting un-specified fields with null.
    const current = await getOrCreateRules(client, orgId);
    const merged: OperationalRules = {
      invoiceThreshold: parsed.data.invoiceThreshold ?? current.invoiceThreshold,
      htsThreshold: parsed.data.htsThreshold ?? current.htsThreshold,
      partiesThreshold: parsed.data.partiesThreshold ?? current.partiesThreshold,
    };

    // Update the active org's row (scoped by org_id so cross-org PATCHes
    // are no-ops).
    const { error } = await client
      .from('operational_rules')
      .update({
        invoice_threshold: merged.invoiceThreshold,
        hts_threshold: merged.htsThreshold,
        parties_threshold: merged.partiesThreshold,
        updated_at: new Date().toISOString(),
      })
      .eq('org_id', orgId);

    if (error) {
      throw wrapDbError('update operational_rules', error.message);
    }

    logger.info('Operational rules updated via API', {
      rules: merged,
      orgId,
      role,
      user: getUserEmail(user),
    });

    // Structured audit log — records which thresholds changed + who changed
    // them. Best-effort: failures are logged but don't break the response.
    await logRulesUpdate(client, getUserEmail(user), {
      action: 'updated',
      ruleName: 'operational_thresholds',
      ruleType: 'threshold_update',
      changes: {
        invoiceThreshold: merged.invoiceThreshold,
        htsThreshold: merged.htsThreshold,
        partiesThreshold: merged.partiesThreshold,
      },
    }).catch((err) => {
      logger.warn('rules: audit log failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    return NextResponse.json({ rules: merged });
  } catch (err) {
    return errorResponse(err);
  }
}
