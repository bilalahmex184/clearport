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
// Phase 2.5 Step 3 fix (#48): resolveProject NO LONGER depends on the OLD
// project being alive for already-migrated orgs.
//
// Steps:
//   1. Check the NEW project's organizations table for this org_id.
//      - If the org EXISTS in the NEW project → it's been migrated. Return
//        the NEW project config. The OLD project is NOT queried.
//      - This means once Phase 6 Step 5 decommissions the OLD project,
//        already-migrated orgs keep working with zero code changes.
//   2. If the org does NOT exist in the NEW project → it hasn't been migrated
//      yet. Fall back to checking the OLD project's use_new_pipeline flag.
//      - If the OLD project says TRUE (shouldn't happen if the org isn't in
//        the NEW project, but defensive) → return NEW config anyway.
//      - If FALSE or OLD project is unreachable → return OLD config (the
//        known-good path for un-migrated orgs).
//   3. On any error → fail safe to OLD (the old path is the known-good fallback
//      for orgs that haven't been migrated yet).
//
// This is option (a) from the spec: mirror the flag into the NEW project's
// organizations table during migration (Phase 6 Step 3 sets use_new_pipeline=
// TRUE there), and check the NEW project first. The OLD project is only
// queried for orgs NOT yet in the NEW project — so decommissioning the OLD
// project only affects un-migrated orgs (which shouldn't exist post-cutover).
// ---------------------------------------------------------------------------
export async function resolveProject(env: Env, orgId: string): Promise<ProjectConfig> {
  const newConfig = newProjectConfig(env);
  const oldConfig = oldProjectConfig(env);

  // --- Step 1: Check the NEW project first ---
  // If the org exists in the NEW project's organizations table, it's been
  // migrated. Return the NEW config WITHOUT querying the OLD project.
  try {
    const newOrgRes = await fetch(
      `${newConfig.supabaseUrl}/rest/v1/organizations?select=id,use_new_pipeline&id=eq.${encodeURIComponent(orgId)}`,
      {
        headers: {
          'apikey': newConfig.supabaseAnonKey,
          'Authorization': `Bearer ${newConfig.supabaseServiceRoleKey}`,
        },
      },
    );

    if (newOrgRes.ok) {
      const newOrgData = await newOrgRes.json() as Array<{ id: string; use_new_pipeline: boolean }>;
      if (Array.isArray(newOrgData) && newOrgData.length > 0) {
        // Org exists in the NEW project — it's migrated. Use the NEW project.
        console.log(`[project-config] org ${orgId} found in NEW project — routing to NEW`);
        return newConfig;
      }
    }
    // If the NEW project returns an error or the org isn't there, fall through
    // to the OLD project check.
  } catch (err) {
    // NEW project unreachable — fall through to OLD project check.
    console.warn(
      `[project-config] NEW project check failed for org ${orgId}:`,
      err instanceof Error ? err.message : String(err),
    );
  }

  // --- Step 2: Org not in NEW project — check the OLD project's flag ---
  try {
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
      // Flag check failed — fail safe to OLD.
      console.warn(`[project-config] OLD project flag check failed for org ${orgId}: ${flagRes.status} — routing to OLD project`);
      return oldConfig;
    }

    const flagData = await flagRes.json() as unknown;
    const useNew = flagData === true || (Array.isArray(flagData) && flagData[0] === true);

    if (useNew) {
      // Flag is TRUE but org isn't in the NEW project — this is a race
      // condition (migration in progress). Route to NEW anyway.
      return newConfig;
    }
    return oldConfig;
  } catch (err) {
    // OLD project also unreachable — fail safe to OLD config (the org
    // hasn't been migrated, so OLD is the right place even if it's down).
    console.warn(
      `[project-config] OLD project flag check error for org ${orgId}:`,
      err instanceof Error ? err.message : String(err),
    );
    return oldConfig;
  }
}
