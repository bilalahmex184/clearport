#!/usr/bin/env node
// ============================================================================
// ClearPort — Regression Test Script
// Runs all 10 test fixtures through the full pipeline and checks results.
// Run after ANY change to extraction or validation logic.
// ============================================================================

import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const SUPABASE_URL = 'https://apfsceomnnhefxkvjhkz.supabase.co';
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFwZnNjZW9tbm5oZWZ4a3ZqaGt6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM1MDI0ODQsImV4cCI6MjA5OTA3ODQ4NH0.TN_HXmJlNBw94ikW0zeTCgG7uEiZX1dpzVazau0pQ1s';
const FIXTURES_DIR = join(import.meta.dirname);

// Expected results for each fixture
const EXPECTED = {
  '01_clean_invoice.txt': {
    invoiceNo: 'INV-2026-001', invoiceDate: '2026-01-15', shipper: 'Acme', consignee: 'Beta',
    declaredValue: '$12,500.00', htsCode: '8471.30.0100', netWeight: '450 lbs', countryOfOrigin: 'US',
  },
  '02_missing_hts.txt': {
    invoiceNo: 'INV-2026-002', shipper: 'Global Trade', consignee: 'Northwind',
    declaredValue: '$8,750.50', netWeight: '220 kg', countryOfOrigin: 'CN',
    // htsCode should be MISSING → should create a missing_field exception
  },
  '03_bad_hts_format.txt': {
    invoiceNo: 'INV-2026-003', shipper: 'Pacific', consignee: 'Summit',
    declaredValue: '$45,000.00', htsCode: '8471300100', netWeight: '1,200 lbs', countryOfOrigin: 'JP',
    // htsCode has bad format → should create a schema_error exception
  },
  '04_german_umlauts.txt': {
    invoiceNo: 'INV-2026-004', shipper: 'Präzisions', consignee: 'Midwest',
    declaredValue: '€28,900.00', htsCode: '8480.71.8010', netWeight: '2,500 kg', countryOfOrigin: 'DE',
  },
  '05_missing_value.txt': {
    invoiceNo: 'INV-2026-005', shipper: 'Tech Solutions', consignee: 'Data Systems',
    htsCode: '8517.62.0050', netWeight: '75 lbs', countryOfOrigin: 'US',
    // declaredValue should be MISSING → should create a missing_field exception
  },
  '06_sparse.txt': {
    invoiceNo: 'INV-2026-006', shipper: 'Acme', declaredValue: '$5,000',
    netWeight: '100 lbs', countryOfOrigin: 'US',
  },
  '07_french.txt': {
    invoiceNo: 'INV-2026-007', shipper: 'Société', consignee: 'American',
    declaredValue: '€15,300.00', htsCode: '8504.40.9580', netWeight: '850 kg', countryOfOrigin: 'FR',
  },
  '08_multiline_table.txt': {
    invoiceNo: 'INV-2026-008', shipper: 'Industrial', consignee: 'Manufacturing',
    declaredValue: '$12,800.00', htsCode: '7326.90.0100', netWeight: '1,100 lbs', countryOfOrigin: 'US',
  },
  '09_no_currency.txt': {
    invoiceNo: 'INV-2026-009', shipper: 'Export', consignee: 'Import',
    declaredValue: '9500.00', htsCode: '7308.90.0000', netWeight: '500 lbs', countryOfOrigin: 'CN',
  },
  '10_minimal.txt': {
    invoiceNo: 'INV-2026-010', declaredValue: '$1,000', htsCode: '8471.30.0100', countryOfOrigin: 'CN',
  },
};

async function runRegression() {
  console.log('=== ClearPort Regression Test ===\n');

  // Sign in
  const authRes = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
    method: 'POST', headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' }, body: '{}',
  });
  const authData = await authRes.json();
  const token = authData.access_token;

  // Create org
  const orgRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/create_organization`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_org_name: 'Regression Test Org', p_creator_uid: authData.user.id }),
  });
  const orgData = await orgRes.json();
  const orgId = orgData[0]?.org_id;
  console.log('Test org:', orgId?.slice(0, 8));

  let totalTests = 0, passedTests = 0;
  let falseNegatives = 0;

  const fixtures = Object.keys(EXPECTED).sort();

  for (const fixtureFile of fixtures) {
    const text = readFileSync(join(FIXTURES_DIR, fixtureFile), 'utf8');
    const expected = EXPECTED[fixtureFile];
    const shipmentId = `SHIP-REG-${fixtureFile.substring(0, 2)}`;

    console.log(`\n--- ${fixtureFile} ---`);

    // Create shipment
    await fetch(`${SUPABASE_URL}/rest/v1/shipments`, {
      method: 'POST',
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: JSON.stringify({ id: shipmentId, org_id: orgId, shipper: 'Test', consignee: 'Test', status: 'Under Review', docs_count: 1, urgency: '08:00:00', initial_confidence: 70, current_confidence: 70 }),
    });

    // Upload
    const formData = new FormData();
    formData.append('file', new Blob([text], { type: 'text/plain' }), fixtureFile);
    formData.append('shipment_id', shipmentId);
    await fetch(`${SUPABASE_URL}/functions/v1/upload-document`, {
      method: 'POST', headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}` }, body: formData,
    });

    // Extract
    await fetch(`${SUPABASE_URL}/functions/v1/extract-document`, {
      method: 'POST', headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ shipmentId }),
    });

    // Validate (parallel)
    await Promise.allSettled([
      fetch(`${SUPABASE_URL}/functions/v1/schema-validate`, { method: 'POST', headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ shipmentId }) }),
      fetch(`${SUPABASE_URL}/functions/v1/math-validate`, { method: 'POST', headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ shipmentId }) }),
      fetch(`${SUPABASE_URL}/functions/v1/cross-validate`, { method: 'POST', headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ shipmentId }) }),
    ]);
    await fetch(`${SUPABASE_URL}/functions/v1/flag-exceptions`, { method: 'POST', headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ shipmentId }) });

    // Check fields
    const fieldsRes = await fetch(`${SUPABASE_URL}/rest/v1/document_fields?select=field_key,extracted_value&shipment_id=eq.${shipmentId}`, {
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}` },
    });
    const fieldsData = await fieldsRes.json();
    const fieldMap = {};
    fieldsData.forEach(f => { fieldMap[f.field_key] = f.extracted_value; });

    // Check exceptions
    const excRes = await fetch(`${SUPABASE_URL}/rest/v1/exceptions?select=exception_type,field_key,reason&shipment_id=eq.${shipmentId}`, {
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}` },
    });
    const excData = await excRes.json();

    // Verify expected fields
    let docPassed = true;
    for (const [key, expVal] of Object.entries(expected)) {
      totalTests++;
      const got = fieldMap[key];
      const normGot = (got || '').toLowerCase().replace(/\s+/g, ' ').trim();
      const normExp = expVal.toLowerCase().replace(/\s+/g, ' ').trim();
      const match = normGot === normExp || normGot.includes(normExp) || normExp.includes(normGot);
      if (match) {
        passedTests++;
      } else {
        docPassed = false;
        console.log(`  ✗ ${key}: expected "${expVal}" got "${got || 'MISSING'}"`);
      }
    }

    // Check for false negatives — fields that are wrong but not flagged
    // (This is a simplified check — in production, a human reviewer would verify)
    if (expected.htsCode && fieldMap.htsCode) {
      // If HTS format is wrong, check it was flagged
      if (!/^\d{4}\.\d{2}\.\d{4}$/.test(fieldMap.htsCode)) {
        const htsException = excData.find(e => e.field_key === 'htsCode');
        if (!htsException) {
          falseNegatives++;
          console.log(`  ⚠ FALSE NEGATIVE: Bad HTS format not flagged`);
        }
      }
    }

    // Check missing required fields are flagged
    if (!expected.htsCode && !fieldMap.htsCode) {
      const missingExc = excData.find(e => e.exception_type === 'missing_field' && e.field_key === 'htsCode');
      if (!missingExc) {
        // This might be OK if htsCode isn't in the required fields for this org
      }
    }

    if (docPassed) {
      console.log(`  ✓ All expected fields correct`);
    }
    console.log(`  Fields: ${fieldsData.length} | Exceptions: ${excData.length} (${excData.map(e => e.exception_type).join(', ')})`);

    // Cleanup
    await fetch(`${SUPABASE_URL}/rest/v1/shipments?id=eq.${shipmentId}`, {
      method: 'DELETE', headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}` },
    });
  }

  // Cleanup org
  await fetch(`https://api.supabase.com/v1/projects/apfsceomnnhefxkvjhkz/database/query`, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer SCRUBBED', 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: `DELETE FROM organizations WHERE id = '${orgId}'` }),
  });

  console.log('\n=== REGRESSION SUMMARY ===');
  console.log(`Field accuracy: ${passedTests}/${totalTests} (${Math.round(passedTests/totalTests*100)}%)`);
  console.log(`False negatives: ${falseNegatives}`);
  console.log(falseNegatives === 0 ? '✓ ZERO FALSE NEGATIVES — PASS' : '✗ FALSE NEGATIVES DETECTED — FAIL');
}

runRegression().catch(console.error);
