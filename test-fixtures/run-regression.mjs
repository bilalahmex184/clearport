import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const SUPABASE_URL = 'https://apfsceomnnhefxkvjhkz.supabase.co';
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFwZnNjZW9tbm5oZWZ4a3ZqaGt6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM1MDI0ODQsImV4cCI6MjA5OTA3ODQ4NH0.TN_HXmJlNBw94ikW0zeTCgG7uEiZX1dpzVazau0pQ1s';
const FIXTURES_DIR = join(import.meta.dirname);

async function runRegression() {
  console.log('=== ClearPort Regression Test (20 documents) ===\n');

  const authRes = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
    method: 'POST', headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' }, body: '{}',
  });
  const authData = await authRes.json();
  const token = authData.access_token;

  const orgRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/create_organization`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_org_name: 'Regression Test Org', p_creator_uid: authData.user.id }),
  });
  const orgData = await orgRes.json();
  const orgId = orgData[0]?.org_id;
  console.log('Test org:', orgId?.slice(0, 8));

  let totalFields = 0, docsProcessed = 0, totalExceptions = 0;
  let results = [];

  const files = readdirSync(FIXTURES_DIR).filter(f => f.endsWith('.txt')).sort();

  for (const file of files) {
    const text = readFileSync(join(FIXTURES_DIR, file), 'utf8');
    const shipmentId = `SHIP-REG-${file.substring(0, 2)}`;

    // Create shipment
    await fetch(`${SUPABASE_URL}/rest/v1/shipments`, {
      method: 'POST',
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: JSON.stringify({ id: shipmentId, org_id: orgId, shipper: 'Test', consignee: 'Test', status: 'Under Review', docs_count: 1, urgency: '08:00:00', initial_confidence: 70, current_confidence: 70 }),
    });

    // Upload
    const formData = new FormData();
    formData.append('file', new Blob([text], { type: 'text/plain' }), file);
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

    // Check results
    const fieldsRes = await fetch(`${SUPABASE_URL}/rest/v1/document_fields?select=field_key,extracted_value,confidence&shipment_id=eq.${shipmentId}`, {
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}` },
    });
    const fieldsData = await fieldsRes.json();

    const excRes = await fetch(`${SUPABASE_URL}/rest/v1/exceptions?select=exception_type,reason&shipment_id=eq.${shipmentId}`, {
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}` },
    });
    const excData = await excRes.json();

    const fieldCount = fieldsData?.length || 0;
    const excCount = excData?.length || 0;
    totalFields += fieldCount;
    totalExceptions += excCount;
    docsProcessed++;

    const fieldKeys = (fieldsData || []).map(f => f.field_key);
    const hasInvoice = fieldKeys.includes('invoiceNo');
    const hasValue = fieldKeys.includes('declaredValue');
    const hasHTS = fieldKeys.includes('htsCode');

    results.push({
      file, fields: fieldCount, exceptions: excCount,
      hasInvoice, hasValue, hasHTS,
      excTypes: [...new Set((excData || []).map(e => e.exception_type))],
    });

    console.log(`${file.padEnd(30)} | Fields: ${String(fieldCount).padStart(2)} | Exc: ${String(excCount).padStart(2)} | ${hasInvoice ? '✓' : '✗'}INV ${hasValue ? '✓' : '✗'}VAL ${hasHTS ? '✓' : '✗'}HTS | ${excCount > 0 ? excData.map(e => e.exception_type).join(',') : 'none'}`);

    // Cleanup shipment
    await fetch(`${SUPABASE_URL}/rest/v1/shipments?id=eq.${shipmentId}`, {
      method: 'DELETE', headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}` },
    });
  }

  // Cleanup org
  const mgmtToken = process.env.SUPABASE_MANAGEMENT_TOKEN;
  if (mgmtToken) {
    await fetch(`https://api.supabase.com/v1/projects/apfsceomnnhefxkvjhkz/database/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${mgmtToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: `DELETE FROM organizations WHERE id = '${orgId}'` }),
    });
  }

  console.log('\n=== REGRESSION SUMMARY ===');
  console.log(`Documents processed: ${docsProcessed}/20`);
  console.log(`Total fields extracted: ${totalFields}`);
  console.log(`Total exceptions created: ${totalExceptions}`);
  console.log(`Average fields per doc: ${(totalFields / docsProcessed).toFixed(1)}`);
  console.log(`Average exceptions per doc: ${(totalExceptions / docsProcessed).toFixed(1)}`);

  const docsWithInvoice = results.filter(r => r.hasInvoice).length;
  const docsWithValue = results.filter(r => r.hasValue).length;
  const docsWithHTS = results.filter(r => r.hasHTS).length;
  console.log(`\nField coverage:`);
  console.log(`  Invoice #: ${docsWithInvoice}/${docsProcessed} (${Math.round(docsWithInvoice/docsProcessed*100)}%)`);
  console.log(`  Declared Value: ${docsWithValue}/${docsProcessed} (${Math.round(docsWithValue/docsProcessed*100)}%)`);
  console.log(`  HTS Code: ${docsWithHTS}/${docsProcessed} (${Math.round(docsWithHTS/docsProcessed*100)}%)`);

  console.log(`\nException types seen:`);
  const excTypes = {};
  results.forEach(r => r.excTypes.forEach(t => { excTypes[t] = (excTypes[t]||0) + 1; }));
  Object.entries(excTypes).sort((a,b) => b[1]-a[1]).forEach(([t, c]) => console.log(`  ${t}: ${c} docs`));

  console.log(`\n${docsProcessed === 20 ? '✓ ALL 20 DOCS PROCESSED' : '✗ SOME DOCS FAILED'}`);
  console.log(`${totalExceptions > 0 ? '✓ ERRORS ROUTED TO EXCEPTION UI' : '✗ NO EXCEPTIONS CREATED'}`);
}

runRegression().catch(console.error);
