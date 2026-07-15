// ============================================================================
// /api/rules — operational thresholds (GET + PATCH)
// ============================================================================
//
// GET   /api/rules
//   → { rules: OperationalRules }  (auto-creates defaults 80/85/75 if missing)
//
// PATCH /api/rules  { invoiceThreshold?, htsThreshold?, partiesThreshold? }
//   → { rules: OperationalRules }
//
// There is one rules row per user, keyed by `id = 'default_config'` (RLS
// enforces user isolation so the same id is safe across users). If the row
// doesn't exist yet, GET auto-creates it with the spec defaults (80/85/75).
// ============================================================================

import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireUserClient, getUserRole, getUserEmail } from '@/lib/services/auth.service';
import { canManageRules } from '@/lib/services/rbac.service';
import { updateRulesSchema } from '@/lib/validators/rules.validator';
import { logRulesUpdate } from '@/lib/services/audit-log.service';
import { errorResponse, AppError } from '@/lib/utils/error-handler';
import { logger } from '@/lib/utils/logger';
import type {
  OperationalRules,
  DbOperationalRules,
} from '@/lib/clearport-types';

const RULES_ROW_ID = 'default_config';
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
 * Fetch the user's rules row. If it doesn't exist, create it with the spec
 * defaults and return those. RLS ensures only the current user's row is visible.
 */
async function getOrCreateRules(
  client: SupabaseClient,
): Promise<OperationalRules> {
  // Query without filtering by id — RLS ensures we only see our own row
  const { data, error } = await client
    .from('operational_rules')
    .select('*')
    .maybeSingle();

  if (error) {
    throw wrapDbError('fetch operational_rules', error.message);
  }

  if (data) {
    return mapDbToRules(data as DbOperationalRules);
  }

  // Auto-create with defaults. user_id is set by the trigger.
  const payload = {
    invoice_threshold: DEFAULT_RULES.invoiceThreshold,
    hts_threshold: DEFAULT_RULES.htsThreshold,
    parties_threshold: DEFAULT_RULES.partiesThreshold,
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

  logger.info('Created default operational_rules row');
  return mapDbToRules(created as DbOperationalRules);
}

// ---------------------------------------------------------------------------
// GET
// ---------------------------------------------------------------------------

export async function GET(req: Request) {
  try {
    const { client } = await requireUserClient(req);
    const rules = await getOrCreateRules(client);
    return NextResponse.json({ rules });
  } catch (err) {
    return errorResponse(err);
  }
}

// ---------------------------------------------------------------------------
// PATCH — partial update (upsert so it works even if the row was never created)
// ---------------------------------------------------------------------------

export async function PATCH(req: Request) {
  try {
    const { client, user } = await requireUserClient(req);

    // RBAC: tuning operational thresholds is an admin-only action. operator
    // and viewer can read the rules (GET above) but cannot mutate them.
    const role = getUserRole(user);
    if (!canManageRules(role)) {
      return NextResponse.json(
        { error: 'Insufficient permissions: manage_rules required', code: 'FORBIDDEN' },
        { status: 403 },
      );
    }

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
    const current = await getOrCreateRules(client);
    const merged: OperationalRules = {
      invoiceThreshold: parsed.data.invoiceThreshold ?? current.invoiceThreshold,
      htsThreshold: parsed.data.htsThreshold ?? current.htsThreshold,
      partiesThreshold: parsed.data.partiesThreshold ?? current.partiesThreshold,
    };

    // Update existing row (getOrCreateRules ensures it exists)
    const { error } = await client
      .from('operational_rules')
      .update({
        invoice_threshold: merged.invoiceThreshold,
        hts_threshold: merged.htsThreshold,
        parties_threshold: merged.partiesThreshold,
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', user.id);

    if (error) {
      throw wrapDbError('update operational_rules', error.message);
    }

    logger.info('Operational rules updated via API', { rules: merged });

    // Structured audit log — records which thresholds changed + who changed
    // them. Best-effort: failures are logged but don't break the response.
    await logRulesUpdate(client, getUserEmail(user), {
      invoiceThreshold: merged.invoiceThreshold,
      htsThreshold: merged.htsThreshold,
      partiesThreshold: merged.partiesThreshold,
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
