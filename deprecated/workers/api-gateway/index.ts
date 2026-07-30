// ============================================================================
// ClearPort — Cloudflare Worker: API Gateway (Upload Endpoint)
// ============================================================================
// Handles file uploads from the Next.js frontend:
//   1. Validates file size (<20MB) and type (PDF/PNG/JPEG)
//   2. Hashes file for idempotency (duplicate uploads return existing job)
//   3. Uploads to Cloudflare R2 (10GB free, zero egress)
//   4. Inserts a saga_jobs row with status='queued'
// ============================================================================

export interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  R2_BUCKET: R2Bucket;
  MAX_FILE_SIZE: string;
}

const ALLOWED_MIME_TYPES = new Set([
  'application/pdf', 'image/png', 'image/jpeg', 'image/jpg',
  'image/tiff', 'text/plain', 'text/csv',
]);
const DEFAULT_MAX_SIZE = 20 * 1024 * 1024;
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

async function hashFile(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function findExistingJob(env: Env, fileHash: string, orgId: string): Promise<string | null> {
  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/saga_jobs?file_hash=eq.${fileHash}&org_id=eq.${orgId}&select=id&limit=1`,
    { headers: { 'apikey': env.SUPABASE_SERVICE_ROLE_KEY, 'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` } },
  );
  if (!res.ok) return null;
  const data = await res.json() as any[];
  return data.length > 0 ? data[0].id : null;
}

async function insertJob(env: Env, orgId: string, fileHash: string, r2Url: string): Promise<string> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/saga_jobs`, {
    method: 'POST',
    headers: {
      'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
    },
    body: JSON.stringify({
      org_id: orgId, file_hash: fileHash, file_r2_url: r2Url,
      status: 'queued', retry_count: 0, next_retry_at: new Date().toISOString(),
    }),
  });
  if (!res.ok) throw new Error(`Failed to insert job: ${res.status} ${await res.text()}`);
  const data = await res.json() as any[];
  return data[0].id;
}

const apiGateway = {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
    if (req.method !== 'POST') return Response.json({ error: 'Method not allowed' }, { status: 405, headers: corsHeaders });

    try {
      const formData = await req.formData();
      const file = formData.get('file') as File | null;
      const orgId = formData.get('org_id') as string | null;
      if (!file) return Response.json({ error: 'No file provided' }, { status: 400, headers: corsHeaders });
      if (!orgId) return Response.json({ error: 'No org_id provided' }, { status: 400, headers: corsHeaders });
      if (!ALLOWED_MIME_TYPES.has(file.type))
        return Response.json({ error: `Unsupported file type: ${file.type}` }, { status: 415, headers: corsHeaders });
      const maxSize = parseInt(env.MAX_FILE_SIZE || String(DEFAULT_MAX_SIZE));
      if (file.size > maxSize)
        return Response.json({ error: `File too large: ${(file.size / 1024 / 1024).toFixed(1)}MB` }, { status: 413, headers: corsHeaders });

      const fileBuffer = await file.arrayBuffer();
      const fileHash = await hashFile(fileBuffer);
      const existingJobId = await findExistingJob(env, fileHash, orgId);
      if (existingJobId) return Response.json({ success: true, job_id: existingJobId, idempotent: true }, { headers: corsHeaders });

      const r2Key = `${orgId}/${fileHash}/${file.name}`;
      await env.R2_BUCKET.put(r2Key, fileBuffer, {
        customMetadata: { 'content-type': file.type, 'original-name': file.name, 'file-hash': fileHash, 'org-id': orgId },
      });
      const jobId = await insertJob(env, orgId, fileHash, `r2://${r2Key}`);
      console.log(`[api-gateway] Job ${jobId} created for org ${orgId}, file ${file.name}`);
      return Response.json({ success: true, job_id: jobId, file_r2_url: `r2://${r2Key}` }, { headers: corsHeaders });
    } catch (err) {
      console.error('[api-gateway] Error:', err);
      return Response.json({ error: 'Upload failed', detail: String(err) }, { status: 500, headers: corsHeaders });
    }
  },
};

export default apiGateway;
