// ============================================================================
// project-config.ts — Dual-project credential selection (Phase 6 Step 1)
// ============================================================================
// During the Phase 6 cutover, both Supabase projects are live simultaneously:
//   - OLD project: authoritative for orgs + the use_new_pipeline flag. Orgs
//     with use_new_pipeline=FALSE route here.
//   - NEW project: the fresh project with the clean schema. Orgs with
//     use_new_pipeline=TRUE route here.
//
// The ingress Worker reads the flag from the OLD project per-request, then
// selects which project's credentials to use for the actual upload + job
// creation. This file encapsulates that logic so the rest of the Worker
// just calls `resolveProject(env, orgId)` and gets back the right config.
// ============================================================================

import type { Env } from './env';

// ---------------------------------------------------------------------------
// ProjectConfig — the credentials for ONE Supabase project. The supabase-
// client functions accept this instead of the full Env, so they're project-
// agnostic. During the cutover, the Worker has two of these; post-cutover,
// only the NEW one remains (and the OLD can be removed).
// ---------------------------------------------------------------------------
export interface ProjectConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
  supabaseServiceRoleKey: string;
  /** 'old' or 'new' — included in logs so the operator can see which project a request hit. */
  projectLabel: 'old' | 'new';
}

// ---------------------------------------------------------------------------
// oldProjectConfig / newProjectConfig — extract the credentials from env.
// ---------------------------------------------------------------------------
export function oldProjectConfig(env: Env): ProjectConfig {
  return {
    supabaseUrl: env.OLD_SUPABASE_URL,
    supabaseAnonKey: env.OLD_SUPABASE_ANON_KEY,
    supabaseServiceRoleKey: env.OLD_SUPABASE_SERVICE_ROLE_KEY,
    projectLabel: 'old',
  };
}

export function newProjectConfig(env: Env): ProjectConfig {
  return {
    supabaseUrl: env.NEW_SUPABASE_URL,
    supabaseAnonKey: env.NEW_SUPABASE_ANON_KEY,
    supabaseServiceRoleKey: env.NEW_SUPABASE_SERVICE_ROLE_KEY,
    projectLabel: 'new',
  };
}

// ---------------------------------------------------------------------------
// resolveProject — the per-request credential selector.
// ---------------------------------------------------------------------------
// Steps:
//   1. Always read the use_new_pipeline flag from the OLD project (the OLD
//      project is authoritative for org metadata during the transition).
//   2. If TRUE → return the NEW project config (the org's data lives there).
//   3. If FALSE → return the OLD project config (the org hasn't been migrated).
//   4. On error (flag check fails, org doesn't exist) → fail safe to OLD.
//      A failed flag check should NOT route to the new pipeline (which might
//      not have the org's data yet) — the old path is the known-good fallback.
//
// The flag check is a REST call to the OLD project's is_org_on_new_pipeline
// RPC (defined in 007_feature_flag_cutover.sql). Uses the OLD service-role
// key to bypass RLS on the organizations table.
// ---------------------------------------------------------------------------
export async function resolveProject(env: Env, orgId: string): Promise<ProjectConfig> {
  const oldConfig = oldProjectConfig(env);

  try {
    // Read the flag from the OLD project.
    const flagRes = await fetch(
      `${oldConfig.supabaseUrl}/rest/v1/rpc/is_org_on_new_pipeline`,
      {
        method: 'POST',
        headers: {
          'apikey': oldConfig.supabaseAnonKey,
          'Authorization': `Bearer ${oldConfig.supabaseServiceRoleKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ p_org_id: orgId }),
      },
    );

    if (!flagRes.ok) {
      // Flag check failed — fail safe to OLD. Log the error.
      console.warn(`[project-config] flag check failed for org ${orgId}: ${flagRes.status} — routing to OLD project`);
      return oldConfig;
    }

    const flagData = await flagRes.json() as unknown;
    // PostgREST returns a bare boolean for a boolean-returning function.
    const useNew = flagData === true || (Array.isArray(flagData) && flagData[0] === true);

    if (useNew) {
      return newProjectConfig(env);
    }
    return oldConfig;
  } catch (err) {
    // Network error / parse error — fail safe to OLD.
    console.warn(
      `[project-config] flag check error for org ${orgId}:`,
      err instanceof Error ? err.message : String(err),
    );
    return oldConfig;
  }
}
