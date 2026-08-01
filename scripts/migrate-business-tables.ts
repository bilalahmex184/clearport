#!/usr/bin/env bun
// ============================================================================
// scripts/migrate-business-tables.ts — Phase 6 Step 2b
// ============================================================================
// Migrates an org's business data from the OLD Supabase project to the NEW
// one. Run twice: once for the test org, then for remaining orgs in batches.
//
// WHAT IT DOES (high level)
//   1. Reads the user-id-map (JSON file from Step 2a) mapping old user IDs
//      to new user IDs.
//   2. Exports the org's rows from the OLD project's tables via REST
//      (service-role key bypasses RLS), table by table, in dependency order.
//   3. Remaps every user_id column from the OLD value to the NEW value.
//   4. Inserts into the NEW project via REST, idempotently: existing rows
//      (matched by PK) are skipped, not duplicated.
//   5. Returns a summary { tablesMigrated, errors }.
//
// USAGE
//   bun run scripts/migrate-business-tables.ts <orgId> [--dry-run]
//
// ENV
//   OLD_SUPABASE_URL, OLD_SUPABASE_SERVICE_ROLE_KEY
//   NEW_SUPABASE_URL, NEW_SUPABASE_SERVICE_ROLE_KEY
//   USER_ID_MAP_FILE (path to {orgId}-user-id-map.json from Step 2a)
//
// PROPERTIES
//   - Reusable: works for any orgId.
//   - Resumable: idempotent per-row (existing PKs are skipped).
//   - Operator-side: runs from Node/Bun, NOT in a Worker.
//   - Never logs secrets: service-role keys come from env, never echoed.
//   - Error isolation: a failure on one row/table doesn't abort the rest;
//     errors are collected and reported in the summary.
// ============================================================================

import { promises as fs } from 'node:fs';
import { resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface MigrateBusinessTablesOpts {
  orgId: string;
  oldSupabaseUrl: string;
  oldServiceRoleKey: string;
  newSupabaseUrl: string;
  newServiceRoleKey: string;
  /** oldUserId → newUserId */
  userIdMap: Record<string, string>;
  dryRun?: boolean;
}

export interface MigrateBusinessTablesResult {
  tablesMigrated: Record<string, number>;
  errors: string[];
}

// ---------------------------------------------------------------------------
// Table config — order matters (dependency order: parents before children)
// ---------------------------------------------------------------------------
// The `filterMode` controls how rows are scoped to this org:
//   - 'org_id_eq'      → filter by <filterColumn>=eq.<orgId>
//   - 'id_eq_org'      → filter by id=eq.<orgId> (the organizations table)
//   - 'by_templates'   → filter by template_id=in.(<ids from broker_templates>)
//
// `userIdColumns` lists every column holding a user_id that needs remapping.
// `paginate` enables 1000-row pages for potentially large tables.
// ============================================================================

type FilterMode = 'org_id_eq' | 'id_eq_org' | 'by_templates';

interface TableConfig {
  name: string;
  pkColumn: string;
  filterMode: FilterMode;
  filterColumn?: string; // for org_id_eq / id_eq_org
  userIdColumns?: string[];
  paginate?: boolean;
}

const TABLES: TableConfig[] = [
  // 1. Root — the org row itself.
  { name: 'organizations', pkColumn: 'id', filterMode: 'id_eq_org', filterColumn: 'id' },

  // 2. Members — depends on organizations.
  { name: 'organization_members', pkColumn: 'id', filterMode: 'org_id_eq', filterColumn: 'org_id', userIdColumns: ['user_id', 'invited_by'] },

  // 3. Shipments — depends on organizations.
  { name: 'shipments', pkColumn: 'id', filterMode: 'org_id_eq', filterColumn: 'org_id', userIdColumns: ['user_id'] },

  // 4. Documents — depends on shipments + organizations.
  { name: 'documents', pkColumn: 'id', filterMode: 'org_id_eq', filterColumn: 'org_id', userIdColumns: ['user_id'] },

  // 5. Document fields — depends on documents. May be large → paginate.
  { name: 'document_fields', pkColumn: 'id', filterMode: 'org_id_eq', filterColumn: 'org_id', userIdColumns: ['user_id'], paginate: true },

  // 6. Exceptions — depends on documents / document_fields.
  { name: 'exceptions', pkColumn: 'id', filterMode: 'org_id_eq', filterColumn: 'org_id', userIdColumns: ['user_id'] },

  // 7. Operational rules — per-org config.
  { name: 'operational_rules', pkColumn: 'id', filterMode: 'org_id_eq', filterColumn: 'org_id', userIdColumns: ['user_id'] },

  // 8. Validation rules — per-org config.
  { name: 'validation_rules', pkColumn: 'id', filterMode: 'org_id_eq', filterColumn: 'org_id', userIdColumns: ['user_id'] },

  // 9. Broker templates — per-org config.
  { name: 'broker_templates', pkColumn: 'id', filterMode: 'org_id_eq', filterColumn: 'org_id', userIdColumns: ['user_id'] },

  // 10. Broker field mappings — depends on broker_templates. Filtered via
  //     template_id IN (templates for this org) since the table has no
  //     direct org_id column.
  { name: 'broker_field_mappings', pkColumn: 'id', filterMode: 'by_templates', filterColumn: 'template_id' },

  // 11. Org subscriptions — single row per org (PK is org_id).
  { name: 'org_subscriptions', pkColumn: 'org_id', filterMode: 'org_id_eq', filterColumn: 'org_id' },

  // 12. Audit logs — may be large → paginate.
  { name: 'audit_logs', pkColumn: 'id', filterMode: 'org_id_eq', filterColumn: 'org_id', userIdColumns: ['user_id'], paginate: true },

  // 13. Notifications.
  { name: 'notifications', pkColumn: 'id', filterMode: 'org_id_eq', filterColumn: 'org_id', userIdColumns: ['user_id'] },

  // 14. Extraction attempts (old audit ledger).
  { name: 'extraction_attempts', pkColumn: 'id', filterMode: 'org_id_eq', filterColumn: 'org_id' },

  // 15. Jobs (async queue).
  { name: 'jobs', pkColumn: 'id', filterMode: 'org_id_eq', filterColumn: 'org_id', userIdColumns: ['user_id'] },

  // 16. Job attempts (per-tier audit ledger).
  { name: 'job_attempts', pkColumn: 'id', filterMode: 'org_id_eq', filterColumn: 'org_id' },
];

// Tables intentionally NOT migrated (config / transient infra):
//   - usage_limits: config table, already seeded by 001_baseline_schema.sql.
//   - stuck_documents: transient reconciliation state, recomputed by cron.
//   - cron_sweep_log: transient infra log, not business data.
const SKIP_TABLES = ['usage_limits', 'stuck_documents', 'cron_sweep_log'];

// ---------------------------------------------------------------------------
// REST helpers (PostgREST via fetch)
// ---------------------------------------------------------------------------

function authHeaders(serviceRoleKey: string): Record<string, string> {
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    'Content-Type': 'application/json',
  };
}

/**
 * Fetch rows from a table scoped to this org.
 * - filterMode='org_id_eq' or 'id_eq_org' → `<filterColumn>=eq.<orgId>`
 * - filterMode='by_templates' → `template_id=in.(<templateIds>)`
 */
async function fetchRows(
  supabaseUrl: string,
  serviceRoleKey: string,
  table: string,
  cfg: TableConfig,
  orgId: string,
  templateIds: string[],
): Promise<Record<string, any>[]> {
  const allRows: Record<string, any>[] = [];
  const baseHeaders = authHeaders(serviceRoleKey);

  let filterQs: string;
  if (cfg.filterMode === 'by_templates') {
    if (templateIds.length === 0) return []; // no templates → no mappings
    filterQs = `${cfg.filterColumn}=in.(${templateIds.map(encodeURIComponent).join(',')})`;
  } else {
    filterQs = `${cfg.filterColumn}=eq.${encodeURIComponent(orgId)}`;
  }

  const baseUrl = `${supabaseUrl}/rest/v1/${table}?${filterQs}`;

  if (!cfg.paginate) {
    const res = await fetch(baseUrl, {
      method: 'GET',
      headers: { ...baseHeaders, Range: '0-999999' },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`GET ${table} failed: ${res.status} ${text}`);
    }
    return (await res.json()) as Record<string, any>[];
  }

  // Paginated: 1000 rows per page.
  const PAGE_SIZE = 1000;
  let offset = 0;
  while (true) {
    const res = await fetch(baseUrl, {
      method: 'GET',
      headers: { ...baseHeaders, Range: `${offset}-${offset + PAGE_SIZE - 1}` },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`GET ${table} offset=${offset} failed: ${res.status} ${text}`);
    }
    const rows = (await res.json()) as Record<string, any>[];
    if (rows.length === 0) break;
    allRows.push(...rows);
    if (rows.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return allRows;
}

/**
 * Batch-fetch existing PKs from the NEW project so we can skip rows that
 * were already migrated (idempotency). Returns a Set of existing PK strings.
 */
async function getExistingIds(
  supabaseUrl: string,
  serviceRoleKey: string,
  table: string,
  pkColumn: string,
  ids: string[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  // PostgREST `in.(...)` filter — UUIDs have no commas so no escaping needed
  // beyond encodeURIComponent (which leaves commas alone).
  const filter = `in.(${ids.map(encodeURIComponent).join(',')})`;
  const url = `${supabaseUrl}/rest/v1/${table}?select=${pkColumn}&${pkColumn}=${filter}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { ...authHeaders(serviceRoleKey), Range: '0-999999' },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GET existing ${table} IDs failed: ${res.status} ${text}`);
  }
  const rows = (await res.json()) as Record<string, any>[];
  return new Set(rows.map(r => String(r[pkColumn])));
}

/**
 * Upsert rows via PostgREST. Uses `Prefer: resolution=merge-duplicates` +
 * `on_conflict=<pk>` so a re-insert of an existing PK is a no-op (defensive
 * idempotency on top of the getExistingIds pre-check).
 */
async function upsertRows(
  supabaseUrl: string,
  serviceRoleKey: string,
  table: string,
  pkColumn: string,
  rows: Record<string, any>[],
): Promise<void> {
  if (rows.length === 0) return;
  const url = `${supabaseUrl}/rest/v1/${table}?on_conflict=${pkColumn}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      ...authHeaders(serviceRoleKey),
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`POST ${table} upsert failed: ${res.status} ${text}`);
  }
}

// ---------------------------------------------------------------------------
// User ID remapping
// ---------------------------------------------------------------------------

/**
 * For each row, remap every user_id column from the OLD value to the NEW
 * value via userIdMap. If an OLD user_id has no mapping, the value is set to
 * NULL (the new project may not have that user yet — better to break a
 * nullable FK than to insert a dangling reference to the wrong user).
 *
 * Returns a list of warnings about unmapped user_ids so the operator can
 * investigate (these are NOT errors — the row still migrates).
 */
function remapUserIds(
  rows: Record<string, any>[],
  userIdColumns: string[] | undefined,
  userIdMap: Record<string, string>,
): string[] {
  const warnings: string[] = [];
  if (!userIdColumns || userIdColumns.length === 0) return warnings;
  for (const row of rows) {
    for (const col of userIdColumns) {
      const oldId = row[col];
      if (!oldId) continue; // null/undefined → leave alone
      const newId = userIdMap[String(oldId)];
      if (newId) {
        row[col] = newId;
      } else {
        warnings.push(`user_id ${oldId} (col=${col}) not in map; set to null`);
        row[col] = null;
      }
    }
  }
  return warnings;
}

// ---------------------------------------------------------------------------
// Main migration
// ---------------------------------------------------------------------------

export async function migrateBusinessTables(
  opts: MigrateBusinessTablesOpts,
): Promise<MigrateBusinessTablesResult> {
  const { orgId, dryRun, userIdMap } = opts;
  const tablesMigrated: Record<string, number> = {};
  const errors: string[] = [];

  // Dry-run: log the plan and exit without any API calls.
  if (dryRun) {
    console.log(
      `[dry-run] Would migrate org ${orgId} ` +
      `(user-id-map has ${Object.keys(userIdMap).length} entries).`,
    );
    for (const t of TABLES) {
      console.log(
        `[dry-run]   - ${t.name} ` +
        `(filter: ${t.filterMode}${t.filterColumn ? ` on ${t.filterColumn}` : ''})`,
      );
      tablesMigrated[t.name] = 0;
    }
    console.log(`[dry-run] Skipping config/transient tables: ${SKIP_TABLES.join(', ')}`);
    return { tablesMigrated, errors };
  }

  // Track template IDs collected from broker_templates so we can fetch
  // broker_field_mappings (which has no direct org_id column).
  const templateIds: string[] = [];

  for (const table of TABLES) {
    try {
      // 1. Fetch rows from OLD.
      const rows = await fetchRows(
        opts.oldSupabaseUrl,
        opts.oldServiceRoleKey,
        table.name,
        table,
        orgId,
        templateIds,
      );

      // 2. After fetching broker_templates, collect IDs for the next table.
      if (table.name === 'broker_templates') {
        for (const r of rows) {
          if (r && r.id) templateIds.push(String(r.id));
        }
      }

      // 3. Remap user_id columns.
      const warnings = remapUserIds(rows, table.userIdColumns, userIdMap);
      for (const w of warnings) {
        console.warn(`[warn] ${table.name}: ${w}`);
      }

      // 4. Idempotency: check which rows already exist in NEW by PK.
      const ids = rows
        .map(r => (r && r[table.pkColumn] != null ? String(r[table.pkColumn]) : ''))
        .filter(Boolean);
      const existing = await getExistingIds(
        opts.newSupabaseUrl,
        opts.newServiceRoleKey,
        table.name,
        table.pkColumn,
        ids,
      );
      const toInsert = rows.filter(
        r => r && r[table.pkColumn] != null && !existing.has(String(r[table.pkColumn])),
      );

      // 5. Upsert the missing rows.
      if (toInsert.length > 0) {
        await upsertRows(
          opts.newSupabaseUrl,
          opts.newServiceRoleKey,
          table.name,
          table.pkColumn,
          toInsert,
        );
      }

      tablesMigrated[table.name] = toInsert.length;
      console.log(
        `[migrate] ${table.name}: ${toInsert.length} inserted ` +
        `(${rows.length - toInsert.length} already existed).`,
      );
    } catch (err: any) {
      const msg = `${table.name}: ${err?.message || String(err)}`;
      errors.push(msg);
      console.error(`[error] ${msg}`);
      tablesMigrated[table.name] = 0;
    }
  }

  return { tablesMigrated, errors };
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const orgId = args.find(a => !a.startsWith('--'));
  if (!orgId) {
    console.error('Usage: bun run scripts/migrate-business-tables.ts <orgId> [--dry-run]');
    process.exit(1);
  }

  const oldUrl = process.env.OLD_SUPABASE_URL;
  const oldKey = process.env.OLD_SUPABASE_SERVICE_ROLE_KEY;
  const newUrl = process.env.NEW_SUPABASE_URL;
  const newKey = process.env.NEW_SUPABASE_SERVICE_ROLE_KEY;
  const mapFile = process.env.USER_ID_MAP_FILE;

  if (!oldUrl || !oldKey || !newUrl || !newKey) {
    console.error(
      'Missing required env vars: OLD_SUPABASE_URL, OLD_SUPABASE_SERVICE_ROLE_KEY, ' +
      'NEW_SUPABASE_URL, NEW_SUPABASE_SERVICE_ROLE_KEY',
    );
    process.exit(1);
  }
  if (!mapFile) {
    console.error('Missing USER_ID_MAP_FILE env var (path to the {orgId}-user-id-map.json from Step 2a).');
    process.exit(1);
  }

  let userIdMap: Record<string, string> = {};
  try {
    const content = await fs.readFile(resolve(mapFile), 'utf-8');
    userIdMap = JSON.parse(content) as Record<string, string>;
  } catch (err: any) {
    console.error(`Failed to read user-id-map file ${mapFile}: ${err.message}`);
    process.exit(1);
  }

  const result = await migrateBusinessTables({
    orgId,
    oldSupabaseUrl: oldUrl,
    oldServiceRoleKey: oldKey,
    newSupabaseUrl: newUrl,
    newServiceRoleKey: newKey,
    userIdMap,
    dryRun,
  });

  console.log('\n============================================');
  console.log('Business tables migration summary');
  console.log('============================================');
  let total = 0;
  for (const [table, count] of Object.entries(result.tablesMigrated)) {
    console.log(`  ${table}: ${count}`);
    total += count;
  }
  console.log(`  TOTAL: ${total} rows`);
  if (result.errors.length > 0) {
    console.log(`\nErrors (${result.errors.length}):`);
    for (const e of result.errors) console.log(`  - ${e}`);
  }
  process.exit(result.errors.length > 0 ? 1 : 0);
}

// Run only when invoked directly (not when imported by tests).
const isMain = (() => {
  try {
    return (
      !process.env.VITEST &&
      !!process.argv[1]?.endsWith('migrate-business-tables.ts')
    );
  } catch {
    return false;
  }
})();
if (isMain) main();
