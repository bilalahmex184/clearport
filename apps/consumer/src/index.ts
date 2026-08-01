// ============================================================================
// index.ts — ClearPort consumer Worker (Phase 3, Step 2 — p3-2)
// ============================================================================
// WHAT THIS WORKER DOES
//   1. queue() handler    — triggered by the `extraction-jobs` Cloudflare
//                            Queue. Each message is { job_id }. The worker
//                            atomically claims the job (race-safe via
//                            claim_job RPC), fetches the file from Supabase
//                            Storage, runs the extraction pipeline (Phase 3
//                            STUB — Phase 4 fills in the real impl), writes
//                            the result, and records every tier attempt to
//                            the job_attempts audit ledger.
//
//   2. scheduled() handler — triggered every 1 minute by a Cron Trigger.
//                            Calls reclaim_stuck_jobs_v2() to reset any
//                            'processing' job past the 5-minute TTL back to
//                            'pending' (dead-job recovery, Phase 3 Step 3).
//                            Logs every reset at WARN — a job needing this
//                            sweep is a signal something upstream is slow
//                            or crashing; it should be visible, not silent.
//
// THE 5 STEPS (from the Phase 3 spec):
//   Step 1 — Race-safe claiming via claim_job RPC (THE critical step).
//   Step 2 — Fetch file from Storage + run pipeline (Phase 3 stub).
//   Step 3 — On success: write document_fields, PATCH documents + shipments,
//            call complete_job(true), ackAll.
//   Step 4 — On failure: record_job_attempt(failure), complete_job(false)
//            which retries (→ pending) or dead-letters, ackAll.
//   Step 5 — job_attempts ledger is NEVER skipped. Every tier attempted
//            (the stub records one; Phase 4's real pipeline records one
//            per tier — AI, regex, etc.) gets a record_job_attempt call.
//
// RACE SAFETY (the core of p3-2)
//   claim_job does: UPDATE jobs SET status='processing', claimed_at=now(),
//   attempts=attempts+1 WHERE id=$1 AND (status='pending' OR
//   (status='processing' AND claimed_at < now() - interval '5 minutes'))
//   RETURNING *. The atomic UPDATE ... RETURNING means two racing workers
//   can't both win. If the RPC returns zero rows, another consumer already
//   claimed it OR it's already terminal — ackAll and exit. The job's retry
//   state lives in the DB (jobs.attempts, jobs.status), NOT in queue
//   redelivery, so we always ackAll even on failure to avoid infinite
//   redelivery loops.
// ============================================================================

import type { Env } from './env';
import {
  supabaseRpc,
  supabaseRestSelect,
  supabaseRestInsert,
  supabaseRestUpdate,
  supabaseStorageDownload,
} from './supabase-client';
import {
  runExtractionPipeline,
  type ClaimedJob,
  type PipelineResult,
} from './pipeline-hook';
// Pipeline-result schema — validated at the consumer→DB boundary (Point 1
// contract). A malformed result is treated as a pipeline FAILURE: the throw
// is caught by processJob's try/catch, which calls recordFailureAndComplete
// (records to the ledger + complete_job(false) → retry or dead-letter).
import { pipelineResultSchema } from '@clearport/shared/pipeline-result';

// ---------------------------------------------------------------------------
// Message body shape — the ingress Worker enqueues { job_id: string }.
// ---------------------------------------------------------------------------
interface QueueMessageBody {
  job_id: string;
}

// ---------------------------------------------------------------------------
// documents row — only the columns the consumer needs from the GET select.
// ---------------------------------------------------------------------------
interface DocumentRow {
  storage_path: string;
  file_name: string;
  mime_type: string | null;
}

// ---------------------------------------------------------------------------
// recently-reset job row — used by the scheduled() handler to log each
// individual job that reclaim_stuck_jobs_v2() just reset.
// ---------------------------------------------------------------------------
interface RecentlyResetJob {
  id: string;
  org_id: string;
  shipment_id: string;
  claimed_at: string | null;
}

// ===========================================================================
// Consumer Worker — queue + scheduled handlers
// ===========================================================================
// Assigned to a named const before `export default` to satisfy the
// import/no-anonymous-default-export lint rule (clearer stack traces too).
// ===========================================================================
const consumerWorker = {
  // =========================================================================
  // queue() handler — race-safe claim → fetch → pipeline → write → complete
  // =========================================================================
  async queue(
    batch: MessageBatch<QueueMessageBody>,
    env: Env,
  ): Promise<void> {
    // max_batch_size=1 in wrangler.toml, so typically one message per batch.
    // Iterate defensively — if the config is tuned upward later, each
    // message is still processed independently.
    for (const message of batch.messages) {
      const jobId = message.body?.job_id;

      // Malformed message — ack so the queue doesn't redeliver forever.
      // This is a poison-pill guard: a bad message shouldn't block the queue.
      if (!jobId || typeof jobId !== 'string') {
        console.warn(
          '[consumer] malformed queue message — acking and skipping',
          { body: message.body },
        );
        continue; // ackAll at the end of the batch loop
      }

      try {
        await processJob(env, jobId);
      } catch (err) {
        // processJob already handles pipeline failures internally (records
        // the failure to the ledger + calls complete_job(false)). Anything
        // that escapes processJob is an infrastructure error (DB down,
        // Storage down, etc.) — log it loudly and let the message be acked.
        // The job's retry/dead-letter state is tracked in the DB; queue
        // redelivery would just retry the same broken infra. The cron
        // sweep (reclaim_stuck_jobs_v2) will reset the job back to pending
        // after the 5-min TTL if claim_job succeeded but the pipeline
        // never reached complete_job.
        console.error(
          `[consumer] unhandled error processing job ${jobId}`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    // Always ackAll — the job's retry state lives in the DB, not in queue
    // redelivery. This avoids infinite redelivery loops. Even on failure,
    // complete_job(false) has already set the job back to 'pending' (retry)
    // or 'dead_letter' (terminal) by the time we reach here.
    batch.ackAll();
  },

  // =========================================================================
  // scheduled() handler — dead-job recovery sweep (Phase 3 Step 3)
  // =========================================================================
  // Runs every 1 minute (cron: "* * * * *"). Calls reclaim_stuck_jobs_v2()
  // which resets any 'processing' job past the 5-minute TTL back to 'pending'.
  // Logs the count at WARN, then queries the recently-reset jobs and logs
  // each one individually at WARN — a job needing this sweep is a signal
  // something upstream is slow or crashing, and it should be visible.
  //
  // TODO(Phase 4): after measuring p99 pipeline latency, tune the TTL
  //   threshold to ~2x p99. Update reclaim_stuck_jobs_v2() in
  //   002_async_jobs.sql AND the claim_job WHERE clause (both currently
  //   use 5 minutes). The spec says "do not guess this number, measure
  //   it first" — Phase 4 measures.
  // =========================================================================
  async scheduled(
    _event: ScheduledEvent,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    let resetCount = 0;
    try {
      // reclaim_stuck_jobs_v2() returns INTEGER — the number of jobs reset.
      const result = await supabaseRpc<unknown>(env, 'reclaim_stuck_jobs_v2', {});
      // PostgREST returns scalars as a bare JSON value (e.g. `3`), not
      // wrapped in an array. Normalize both shapes defensively.
      if (typeof result === 'number') {
        resetCount = result;
      } else if (Array.isArray(result) && result.length > 0) {
        resetCount = Number(result[0]) || 0;
      }

      // WARN — even zero is informational but a non-zero count is the
      // actionable signal. Always log so the operator can see the sweep
      // ran; the cron itself should never be silent.
      console.warn(`[cron] reclaimed ${resetCount} stuck jobs`);

      // If jobs were reset, fetch the individual job rows so each one is
      // logged with its org_id + shipment_id for triage. A reset job means
      // a consumer either crashed or took >5 min — surface every one.
      if (resetCount > 0) {
        try {
          // PostgREST filter: updated_at > now() - interval '1 minute'.
          // The value `now()-interval'1 minute'` is a SQL expression that
          // PostgREST evaluates server-side. URL-encode the value portion
          // so the embedded space and single quotes survive transit.
          const oneMinuteAgoExpr = encodeURIComponent("now()-interval'1 minute'");
          const recentlyReset = await supabaseRestSelect<RecentlyResetJob>(
            env,
            'jobs',
            'select=id,org_id,shipment_id,claimed_at'
              + '&status=eq.pending'
              + '&claimed_at=is.null'
              + '&attempts=gt.0'
              + `&updated_at=gt.${oneMinuteAgoExpr}`,
          );

          for (const job of recentlyReset) {
            console.warn(
              `[cron] stuck job reset: id=${job.id} org=${job.org_id} shipment=${job.shipment_id}`,
            );
          }
        } catch (selectErr) {
          // Don't let a select failure mask the reclaim count. Log + continue.
          console.warn(
            '[cron] failed to fetch recently-reset job details',
            selectErr instanceof Error ? selectErr.message : String(selectErr),
          );
        }
      }
    } catch (err) {
      // The cron sweep must never throw — a thrown scheduled() handler
      // shows up as a failed Worker invocation in Cloudflare's dashboard
      // and triggers retried cron runs. Log loudly and return cleanly.
      console.error(
        '[cron] reclaim_stuck_jobs_v2 failed:',
        err instanceof Error ? err.message : String(err),
      );
    }

    // =======================================================================
    // Phase 5 reality check (Point 4): dead-letter alerting.
    // The dead_letter_alerts SQL view + check_dead_letter_threshold() function
    // exist (004_dead_letter_alerting.sql) but were never CALLED. This wires
    // them into the same 1-minute cron — every minute, check if any org has
    // crossed the dead-letter threshold (5 in 5 min) and log at ERROR level
    // so it's visible on the dashboard + any log-based alerting (Axiom/Better
    // Stack via the shared logger's HTTP shipper).
    //
    // This makes the system OPERATED, not just OBSERVABLE: the metrics exist
    // (006_metrics_view.sql + /api/metrics) AND the alert check runs on a
    // cron AND the result is logged at a severity that triggers downstream
    // alert routing. Phase 6 can wire the actual Slack/PagerDuty webhook;
    // for now, the ERROR-level log IS the alert.
    // =======================================================================
    try {
      const alertsResult = await supabaseRpc<unknown>(env, 'check_dead_letter_threshold', {});
      // PostgREST returns the function's TABLE result as an array of objects.
      const alerts = Array.isArray(alertsResult) ? alertsResult : [];
      for (const alert of alerts) {
        const a = alert as {
          org_id?: string; org_name?: string; dead_letter_count?: number;
          severity?: string; sample_job_ids?: unknown; sample_errors?: unknown;
        };
        console.error(
          `[ALERT] dead-letter spike: org=${a.org_name || a.org_id} ` +
          `count=${a.dead_letter_count} severity=${a.severity} ` +
          `sample_jobs=${JSON.stringify(a.sample_job_ids || [])} ` +
          `sample_errors=${JSON.stringify(a.sample_errors || [])}`,
        );
      }
      // If the function returned an error (e.g. migration not applied), log
      // a notice but don't fail the cron — the reclaim sweep above still ran.
      if (!Array.isArray(alertsResult) && alertsResult != null) {
        console.warn('[cron] check_dead_letter_threshold returned non-array result:', alertsResult);
      }
    } catch (alertErr) {
      // Don't let the alerting check failure mask the reclaim sweep. Log + continue.
      console.warn(
        '[cron] check_dead_letter_threshold failed (migration 004 may not be applied):',
        alertErr instanceof Error ? alertErr.message : String(alertErr),
      );
    }
  },
};

export default consumerWorker;

// ===========================================================================
// processJob — the 5-step pipeline for a single job_id
// ===========================================================================
// Wrapped in try/catch by the queue() handler. Internally handles pipeline
// failures (records them to the ledger + calls complete_job(false)) so the
// only errors that escape are infrastructure errors (DB/Storage down).
// ===========================================================================
async function processJob(env: Env, jobId: string): Promise<void> {
  // =======================================================================
  // STEP 1 — Race-safe claiming via claim_job RPC
  // =======================================================================
  // claim_job returns an array. Empty array = another consumer already
  // claimed it OR the job is already terminal. Non-empty = we won the
  // race; the returned row is the claimed job. The atomic UPDATE ...
  // RETURNING in claim_job means two racing workers can't both win.
  // =======================================================================
  const claimResult = await supabaseRpc<ClaimedJob[]>(
    env,
    'claim_job',
    { p_job_id: jobId },
  );

  if (!Array.isArray(claimResult) || claimResult.length === 0) {
    // Race lost (or job already terminal) — nothing to do. The queue()
    // handler will ackAll. This is the race-safe exit: no double-processing.
    console.log(`[consumer] job ${jobId} not claimable — skipping`);
    return;
  }

  const claimedJob = claimResult[0];
  console.log(
    `[consumer] claimed job ${jobId} (attempt ${claimedJob.attempts}/${claimedJob.max_attempts})`,
  );

  // The job must have a document_id to extract from. A job without one is
  // a producer bug (the ingress Worker should always set document_id before
  // enqueuing). Record the failure and complete_job(false) so it retries
  // or dead-letters — don't silently skip.
  if (!claimedJob.document_id) {
    const errMsg = `Job ${jobId} has no document_id — cannot extract`;
    console.error(`[consumer] ${errMsg}`);
    await recordFailureAndComplete(
      env,
      jobId,
      claimedJob,
      errMsg,
      /* latencyMs */ 0,
    );
    return;
  }

  try {
    // =====================================================================
    // STEP 2 — Fetch the document row, download the file, run pipeline
    // =====================================================================
    // 2a. Fetch the documents row to get storage_path + file_name + mime.
    // ---------------------------------------------------------------------
    const docRows = await supabaseRestSelect<DocumentRow>(
      env,
      'documents',
      `id=eq.${claimedJob.document_id}&select=storage_path,file_name,mime_type`,
    );

    if (docRows.length === 0) {
      throw new Error(
        `Document row not found for document_id=${claimedJob.document_id} (job ${jobId})`,
      );
    }

    const doc = docRows[0];

    // ---------------------------------------------------------------------
    // 2b. Download the file bytes from Supabase Storage (documents bucket).
    // ---------------------------------------------------------------------
    const fileBytes = await supabaseStorageDownload(
      env,
      'documents',
      doc.storage_path,
    );

    // ---------------------------------------------------------------------
    // 2c. Run the extraction pipeline (Phase 3 STUB).
    // The stub records a single `record_job_attempt` (tier='stub_v3') and
    // returns a minimal PipelineResult (overall_confidence=0, HOLD).
    // Phase 4 replaces the stub with the real pipeline (ai-extract →
    // canonical-schema → pipeline.runPipeline → regex fallback) which will
    // record one attempt PER TIER attempted.
    // ---------------------------------------------------------------------
    const pipelineResult = await runExtractionPipeline(env, {
      jobId,
      documentId: claimedJob.document_id,
      shipmentId: claimedJob.shipment_id,
      orgId: claimedJob.org_id,
      userId: claimedJob.user_id,
      fileBytes,
      fileName: doc.file_name,
      mimeType: doc.mime_type || 'application/octet-stream',
    }, claimedJob);

    // =====================================================================
    // STEP 3 — On success: write fields, PATCH documents + shipments,
    //          complete_job(true)
    // =====================================================================
    await writeSuccessResult(env, claimedJob, pipelineResult);

    console.log(
      `[consumer] job ${jobId} completed (decision=${pipelineResult.decision}, fields=${pipelineResult.fields.length}, confidence=${pipelineResult.overall_confidence})`,
    );
  } catch (err) {
    // =====================================================================
    // STEP 4 — On failure: record_job_attempt(failure), complete_job(false)
    // =====================================================================
    // complete_job(false) checks attempts < max_attempts: if true, sets
    // status back to 'pending' (retry); if false, sets 'dead_letter'.
    // The message is still acked — the job's retry state is in the DB,
    // not in queue redelivery.
    // =====================================================================
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[consumer] job ${jobId} pipeline failed: ${errMsg}`);

    await recordFailureAndComplete(
      env,
      jobId,
      claimedJob,
      errMsg,
      /* latencyMs */ 0,
    );
  }
}

// ===========================================================================
// writeSuccessResult — Step 3: persist the extraction result
// ===========================================================================
// 1. Batch-insert all extracted fields to document_fields.
// 2. PATCH documents: processing_status='completed', extraction_source,
//    overall_confidence.
// 3. PATCH shipments: validation_status='completed', last_validated_at=now(),
//    pipeline_trace_id.
// 4. complete_job(jobId, true, null, result) — sets status='completed',
//    stores the result JSONB.
// ===========================================================================
async function writeSuccessResult(
  env: Env,
  claimedJob: ClaimedJob,
  result: PipelineResult,
): Promise<void> {
  // -----------------------------------------------------------------------
  // 0. CONTRACT GATE (Point 1) — validate the pipeline result BEFORE any
  //    write. A malformed result is a pipeline bug: we throw, processJob's
  //    try/catch catches it and routes to recordFailureAndComplete (ledger
  //    row + complete_job(false) → retry or dead-letter). A buggy Phase 4
  //    pipeline CANNOT write garbage to the DB. The shape is identical
  //    post-validation, but using parsed.data guarantees we persist exactly
  //    the validated shape (no extra keys, no type drift).
  // -----------------------------------------------------------------------
  const parsed = pipelineResultSchema.safeParse(result);
  if (!parsed.success) {
    const errMsg = `Pipeline result schema validation failed: ${parsed.error.message}`;
    throw new Error(errMsg);
  }
  const validated: PipelineResult = parsed.data;

  // -----------------------------------------------------------------------
  // 1. Batch-insert document_fields (if any). The stub returns zero fields;
  //    skip the insert to avoid an empty-array 400 from PostgREST.
  // -----------------------------------------------------------------------
  if (validated.fields.length > 0) {
    const fieldRows = validated.fields.map((f) => ({
      document_id: claimedJob.document_id,
      shipment_id: claimedJob.shipment_id,
      org_id: claimedJob.org_id,
      user_id: claimedJob.user_id,
      field_key: f.field_key,
      field_label: f.field_label,
      extracted_value: f.extracted_value,
      confidence: Math.max(0, Math.min(100, Math.round(f.confidence))),
      extraction_source: f.extraction_source,
    }));

    await supabaseRestInsert(env, 'document_fields', fieldRows);
  }

  // -----------------------------------------------------------------------
  // 2. PATCH documents row. overall_confidence is INTEGER 0-100 per the
  //    schema; coerce to int and clamp.
  // -----------------------------------------------------------------------
  await supabaseRestUpdate(
    env,
    'documents',
    `id=eq.${claimedJob.document_id}`,
    {
      processing_status: 'completed',
      extraction_source: 'ai', // Phase 4: use the dominant tier from the result
      overall_confidence: Math.max(0, Math.min(100, Math.round(validated.overall_confidence))),
    },
  );

  // -----------------------------------------------------------------------
  // 3. PATCH shipments row — validation_status='completed' +
  //    last_validated_at=now() + pipeline_trace_id. Use the REST function
  //    `now()` (PostgREST supports this for timestamptz columns).
  // -----------------------------------------------------------------------
  await supabaseRestUpdate(
    env,
    'shipments',
    `id=eq.${encodeURIComponent(claimedJob.shipment_id)}`,
    {
      validation_status: 'completed',
      last_validated_at: new Date().toISOString(),
      pipeline_trace_id: validated.pipeline_trace_id,
    },
  );

  // -----------------------------------------------------------------------
  // 4. complete_job(true) — sets status='completed', stores result JSONB.
  //    complete_job signature (005_fencing_token.sql §3):
  //      (p_job_id, p_claim_token, p_success, p_error, p_result).
  //    Returns BOOLEAN: FALSE if the fencing token is stale (cron reclaimed
  //    the job mid-extraction). On FALSE, the writes above (document_fields,
  //    documents, shipments PATCH) already happened — but those are
  //    idempotent-ish (the new consumer will overwrite them). The critical
  //    invariant is that complete_job itself is atomic: only ONE consumer
  //    can flip status to 'completed'. A stale consumer's complete_job is a
  //    no-op. Persist the schema-validated shape so jobs.result is always canonical.
  //
  //    NOTE: the document_fields + documents + shipments PATCHes above are
  //    NOT fencing-protected (they go through REST, not the RPC). This is a
  //    known tradeoff: full fencing would route all writes through
  //    SECURITY DEFINER functions, adding latency. The complete_job gate is
  //    the single source of truth for "did this job complete?" — the other
  //    writes are intermediate state that the new consumer overwrites if it
  //    re-processes. Phase 4 should evaluate whether the intermediate writes
  //    need fencing too (likely yes for document_fields to avoid duplicates).
  // -----------------------------------------------------------------------
  const completeResult = await supabaseRpc<boolean>(env, 'complete_job', {
    p_job_id: claimedJob.id,
    p_claim_token: claimedJob.claim_token,
    p_success: true,
    p_error: null,
    p_result: {
      fields: validated.fields,
      overall_confidence: validated.overall_confidence,
      decision: validated.decision,
      exceptions: validated.exceptions,
      pipeline_trace_id: validated.pipeline_trace_id,
    },
  });

  // Fencing rejection: complete_job returned FALSE (or a falsy shape).
  // The cron reclaimed this job while we were extracting. Our completion
  // was NOT applied — a different consumer is now (or will be) re-processing.
  // Log at WARN (not ERROR — this is expected under TTL contention, not a
  // bug) and return without error. The job is in good hands (the new consumer).
  const applied = Array.isArray(completeResult) ? completeResult[0] : completeResult;
  if (applied === false) {
    console.warn(
      `[consumer] FENCING REJECTION: job ${claimedJob.id} was reclaimed mid-extraction (claim_token stale). ` +
      `Completion NOT applied — a new consumer will reprocess. This is expected under TTL contention, not a bug.`,
    );
  }
}

// ===========================================================================
// recordFailureAndComplete — Step 4 + Step 5 on failure
// ===========================================================================
// STEP 5 (job_attempts ledger) is NEVER skipped. Even on failure we record
// a `record_job_attempt` row with status='failure' and the error message.
// complete_job(false) then either retries (→ pending) or dead-letters
// based on attempts vs max_attempts.
// ===========================================================================
async function recordFailureAndComplete(
  env: Env,
  jobId: string,
  claimedJob: ClaimedJob,
  errorMessage: string,
  latencyMs: number,
): Promise<void> {
  // --- STEP 5: record the failure to the audit ledger --------------------
  // The stub records success internally; on a failure path we record a
  // separate 'failure' attempt row so the ledger captures the failure
  // tier. Phase 4's real pipeline will record one row per tier attempted
  // (some may succeed, some may fail) before the overall failure.
  try {
    await supabaseRpc(env, 'record_job_attempt', {
      p_job_id: jobId,
      p_claim_token: claimedJob.claim_token,
      p_org_id: claimedJob.org_id,
      p_attempt_number: claimedJob.attempts,
      p_tier: 'consumer_error',
      p_status: 'failure',
      p_fields_extracted: 0,
      p_latency_ms: latencyMs,
      p_error_message: errorMessage.slice(0, 2000), // truncate — TEXT but sane
      p_result: null,
    });
  } catch (ledgerErr) {
    // The ledger write itself failed (DB down, etc.) OR the fencing token
    // was stale (record_job_attempt returned NULL — the job was reclaimed).
    // In the stale-token case, this is expected: we don't want phantom
    // failure rows from a consumer whose claim was reclaimed. Log + continue
    // to complete_job (which will also be fencing-rejected, but that's fine).
    console.error(
      `[consumer] FAILED to record failure to job_attempts ledger for job ${jobId}:`,
      ledgerErr instanceof Error ? ledgerErr.message : String(ledgerErr),
    );
  }

  // --- STEP 4: complete_job(false) — retry or dead-letter ----------------
  // complete_job checks attempts < max_attempts: if true → 'pending' (retry,
  // claimed_at cleared so it's immediately claimable); if false → 'dead_letter'
  // (terminal, surfaced in /api/health/alerts).
  //
  // FENCING: if the cron reclaimed this job since we claimed it,
  // complete_job returns FALSE (token stale). In that case the job is
  // already being reprocessed by a new consumer — our failure recording
  // is correctly rejected (no false retry/dead-letter from a stale consumer).
  try {
    const completeResult = await supabaseRpc<boolean>(env, 'complete_job', {
      p_job_id: jobId,
      p_claim_token: claimedJob.claim_token,
      p_success: false,
      p_error: errorMessage.slice(0, 2000),
      p_result: null,
    });
    const applied = Array.isArray(completeResult) ? completeResult[0] : completeResult;
    if (applied === false) {
      console.warn(
        `[consumer] FENCING REJECTION on failure path: job ${jobId} was reclaimed. ` +
        `complete_job(false) NOT applied — new consumer will reprocess.`,
      );
    }
  } catch (completeErr) {
    // complete_job itself failed (DB down). The job is stuck in 'processing'
    // — the cron sweep (reclaim_stuck_jobs_v2) will reset it back to
    // 'pending' after the 5-min TTL. Log loudly so the operator notices.
    console.error(
      `[consumer] FAILED to call complete_job(false) for job ${jobId}:`,
      completeErr instanceof Error ? completeErr.message : String(completeErr),
    );
  }
}
