// ============================================================================
// ClearPort Pipeline Worker
// ============================================================================
// Standalone process that polls the processing_jobs table for queued jobs,
// claims them via claim_next_job() (SELECT ... FOR UPDATE SKIP LOCKED), runs
// the extraction/validation pipeline by calling the extract-document edge
// function, and updates the job status on completion.
//
// This decouples the upload request path from the extraction pipeline:
//   - Upload writes a 'queued' processing_jobs row → returns immediately
//   - This worker claims the job → calls the edge function (18s wall-clock
//     budget, 5-tier fallback chain) → marks the job completed/failed/dead
//   - On failure, the job retries up to max_attempts (3), then dead-letters
//
// Run via pm2 (ecosystem.config.js includes this as a second app) or directly:
//   bun mini-services/worker/index.ts
// ============================================================================

import { createClient } from '@supabase/supabase-js';
import { config as loadEnv } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// Load .env from the project root (parent of mini-services/worker/)
// Works under both bun (import.meta.dir) and Node (import.meta.url + fileURLToPath)
const __dirname = typeof import.meta.dir !== 'undefined'
  ? import.meta.dir
  : dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(__dirname, '..', '..', '.env') });

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const EDGE_FUNCTION_URL =
  process.env.NEXT_PUBLIC_SUPABASE_FUNCTIONS_URL ||
  (SUPABASE_URL ? `${SUPABASE_URL}/functions/v1` : '');
const WORKER_ID = process.env.WORKER_ID || `worker-${process.pid}`;
const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_MS || 3000); // 3 seconds
const EXTRACTION_TIMEOUT_MS = 30_000; // 30s — longer than edge function's 18s budget so it can finish

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error('[worker] FATAL: NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set');
  console.error('[worker] Set these in .env at the project root');
  process.exit(1);
}

// Service-role client — bypasses RLS so the worker can claim/update any org's jobs
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

console.log(`[worker] ${WORKER_ID} started — polling every ${POLL_INTERVAL_MS}ms`);

// ---------------------------------------------------------------------------
// Main poll loop
// ---------------------------------------------------------------------------
async function pollOnce(): Promise<void> {
  try {
    // Claim the oldest queued job atomically
    const { data: jobs, error: claimError } = await supabase.rpc('claim_next_job', {
      p_worker_id: WORKER_ID,
    });

    if (claimError) {
      console.error('[worker] claim_next_job error:', claimError.message);
      return;
    }

    if (!jobs || jobs.length === 0) {
      return; // no jobs available — poll again on next interval
    }

    const job = jobs[0];
    console.log(`[worker] Claimed job ${job.id} (type=${job.job_type}, shipment=${job.shipment_id}, attempt=${job.attempts}/${job.max_attempts})`);

    // Process the job
    const success = await processJob(job);

    // Mark the job as complete (or failed → retry/dead-letter)
    const { error: completeError } = await supabase.rpc('complete_job', {
      p_job_id: job.id,
      p_success: success,
      p_error: success ? null : `Extraction failed on attempt ${job.attempts}`,
    });

    if (completeError) {
      console.error(`[worker] complete_job error for ${job.id}:`, completeError.message);
    } else {
      console.log(`[worker] Job ${job.id} marked as ${success ? 'completed' : 'failed (will retry or dead-letter)'}`);
    }
  } catch (err) {
    console.error('[worker] Unexpected poll error:', err instanceof Error ? err.message : String(err));
  }
}

// ---------------------------------------------------------------------------
// Process a single job — calls the extract-document edge function
// ---------------------------------------------------------------------------
// Only 'extraction' jobs are enqueued today (the upload path creates
// processing_jobs rows with job_type='extraction'). Validation runs inline
// from the browser via ClearPortContext's inline-pipeline fallback after
// extraction completes. If validation is later moved to the queue, add the
// enqueue call in ClearPortContext and uncomment runValidation below.
// ---------------------------------------------------------------------------
async function processJob(job: any): Promise<boolean> {
  if (job.job_type === 'extraction') {
    return runExtraction(job);
  }
  // Unknown job types are logged + treated as failures so they dead-letter
  // rather than silently sitting in 'processing' forever.
  console.warn(`[worker] Unknown job_type: ${job.job_type}`);
  return false;
}

async function runExtraction(job: any): Promise<boolean> {
  const fnUrl = `${EDGE_FUNCTION_URL}/extract-document`;
  console.log(`[worker] Calling extract-document for shipment ${job.shipment_id}`);

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), EXTRACTION_TIMEOUT_MS);

    const res = await fetch(fnUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({
        shipmentId: job.shipment_id,
        documentId: job.document_id || undefined,
        trace_id: job.trace_id,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      console.error(`[worker] extract-document returned ${res.status}: ${errBody.slice(0, 200)}`);
      return false;
    }

    const result = await res.json();
    console.log(`[worker] Extraction complete for ${job.shipment_id}: ${result.fields?.length || 0} fields, success=${result.success}`);

    // If the edge function reported budget exhaustion or total failure, treat as failure
    if (result.success === false) {
      return false;
    }

    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('aborted') || msg.includes('timeout')) {
      console.error(`[worker] Extraction timed out for ${job.shipment_id} after ${EXTRACTION_TIMEOUT_MS}ms`);
    } else {
      console.error(`[worker] Extraction fetch failed for ${job.shipment_id}:`, msg);
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// Start polling
// ---------------------------------------------------------------------------
const interval = setInterval(pollOnce, POLL_INTERVAL_MS);

// Allow the process to exit cleanly on SIGTERM/SIGINT (pm2 sends SIGTERM)
process.on('SIGTERM', () => {
  console.log('[worker] SIGTERM received — shutting down');
  clearInterval(interval);
  process.exit(0);
});
process.on('SIGINT', () => {
  console.log('[worker] SIGINT received — shutting down');
  clearInterval(interval);
  process.exit(0);
});

// Fire one poll immediately on startup
pollOnce();
