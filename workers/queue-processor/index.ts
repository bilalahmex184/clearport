// ============================================================================
// ClearPort — Cloudflare Worker: Queue Processor (Saga Pattern)
// ============================================================================
// Runs via Cloudflare Cron Trigger every 1 minute. Claims ONE job from
// saga_jobs using FOR UPDATE SKIP LOCKED, executes ONE fast step, exits.
// ============================================================================

export interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  R2_BUCKET: R2Bucket;
  OCR_SPACE_API_KEY: string;
  OPENROUTER_API_KEY: string;
  MAX_RETRIES: string;
}

interface ProcessingJob {
  id: string; org_id: string; file_hash: string; file_r2_url: string;
  status: string; retry_count: number; next_retry_at: string;
  extracted_data: Record<string, any> | null; confidence_score: number | null;
  error_log: string | null; created_at: string; updated_at: string;
}

async function supabaseRpc(env: Env, fn: string, params: Record<string, any>): Promise<any> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { 'apikey': env.SUPABASE_SERVICE_ROLE_KEY, 'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
    body: JSON.stringify(params),
  });
  if (!res.ok) throw new Error(`Supabase RPC ${fn} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function isProviderAvailable(env: Env, provider: string): Promise<boolean> {
  try { const r = await supabaseRpc(env, 'is_provider_available', { p_provider: provider }); return r === true; }
  catch { return true; }
}

async function recordApiFailure(env: Env, provider: string, reason: string): Promise<void> {
  try { await supabaseRpc(env, 'record_api_failure', { p_provider: provider, p_reason: reason }); } catch {}
}

async function recordApiSuccess(env: Env, provider: string): Promise<void> {
  try { await supabaseRpc(env, 'record_api_success', { p_provider: provider }); } catch {}
}

async function updateJobStatus(env: Env, jobId: string, status: string, extra: Record<string, any> = {}): Promise<void> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/saga_jobs?id=eq.${jobId}`, {
    method: 'PATCH',
    headers: { 'apikey': env.SUPABASE_SERVICE_ROLE_KEY, 'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
    body: JSON.stringify({ status, updated_at: new Date().toISOString(), ...extra }),
  });
  if (!res.ok) throw new Error(`Failed to update job ${jobId} to ${status}`);
}

async function claimJob(env: Env): Promise<ProcessingJob | null> {
  try {
    const result = await supabaseRpc(env, 'claim_next_saga_job', {});
    return result?.[0] || null;
  } catch (err) { console.error('[saga] claim failed:', err); return null; }
}

async function runOcrStep(env: Env, job: ProcessingJob): Promise<void> {
  console.log(`[saga] Job ${job.id}: OCR step`);
  if (!(await isProviderAvailable(env, 'ocr_space'))) { console.log('[saga] OCR.space tripped — skip'); return; }

  const r2Key = job.file_r2_url.replace('r2://', '');
  const r2Object = await env.R2_BUCKET.get(r2Key);
  if (!r2Object) { await updateJobStatus(env, job.id, 'failed', { error_log: `PDF not found: ${r2Key}` }); return; }

  try {
    const formData = new FormData();
    formData.append('file', new Blob([await r2Object.arrayBuffer()]), 'document.pdf');
    formData.append('language', 'eng'); formData.append('isOverlayRequired', 'false'); formData.append('OCREngine', '2');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const res = await fetch('https://api.ocr.space/parse/image', { method: 'POST', headers: { 'apikey': env.OCR_SPACE_API_KEY }, body: formData, signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) {
      const errText = await res.text();
      if (res.status === 429 || res.status >= 500) await recordApiFailure(env, 'ocr_space', `HTTP ${res.status}`);
      const backoff = Math.min(60 * Math.pow(2, job.retry_count), 900);
      await updateJobStatus(env, job.id, 'queued', { retry_count: job.retry_count + 1, next_retry_at: new Date(Date.now() + backoff * 1000).toISOString(), error_log: `OCR ${res.status}: ${errText.slice(0, 500)}` });
      return;
    }

    const data = await res.json() as any;
    if (data.IsErroredOnProcessing || !data.ParsedResults?.[0]?.ParsedText) {
      await recordApiFailure(env, 'ocr_space', 'No text');
      const maxRetries = parseInt(env.MAX_RETRIES || '3');
      if (job.retry_count + 1 >= maxRetries) await updateJobStatus(env, job.id, 'needs_review', { error_log: `OCR failed after ${job.retry_count + 1} attempts` });
      else { const backoff = Math.min(60 * Math.pow(2, job.retry_count), 900); await updateJobStatus(env, job.id, 'queued', { retry_count: job.retry_count + 1, next_retry_at: new Date(Date.now() + backoff * 1000).toISOString(), error_log: 'OCR: no text' }); }
      return;
    }

    const ocrText = data.ParsedResults[0].ParsedText;
    await env.R2_BUCKET.put(`${job.id}_ocr.txt`, ocrText, { customMetadata: { 'content-type': 'text/plain', 'job-id': job.id } });
    await recordApiSuccess(env, 'ocr_space');
    await updateJobStatus(env, job.id, 'ocr_done', { error_log: null });
    console.log(`[saga] Job ${job.id}: OCR complete (${ocrText.length} chars)`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await recordApiFailure(env, 'ocr_space', msg);
    const backoff = Math.min(60 * Math.pow(2, job.retry_count), 900);
    await updateJobStatus(env, job.id, 'queued', { retry_count: job.retry_count + 1, next_retry_at: new Date(Date.now() + backoff * 1000).toISOString(), error_log: `OCR error: ${msg}` });
  }
}

async function runLlmStep(env: Env, job: ProcessingJob): Promise<void> {
  console.log(`[saga] Job ${job.id}: LLM step`);
  if (!(await isProviderAvailable(env, 'openrouter'))) { console.log('[saga] OpenRouter tripped — skip'); return; }

  const ocrObject = await env.R2_BUCKET.get(`${job.id}_ocr.txt`);
  if (!ocrObject) { await updateJobStatus(env, job.id, 'failed', { error_log: 'OCR text not found' }); return; }
  const ocrText = await ocrObject.text();

  try {
    const { EXTRACTION_PROMPT } = await import('./prompt');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://clearport.app', 'X-Title': 'ClearPort' },
      body: JSON.stringify({ model: 'meta-llama/llama-3-8b-instruct:free', messages: [{ role: 'system', content: EXTRACTION_PROMPT }, { role: 'user', content: `Extract from:\n\n${ocrText}` }], temperature: 0, max_tokens: 2000, response_format: { type: 'json_object' } }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      const errText = await res.text();
      if (res.status === 429 || res.status >= 500) await recordApiFailure(env, 'openrouter', `HTTP ${res.status}`);
      const backoff = Math.min(60 * Math.pow(2, job.retry_count), 900);
      await updateJobStatus(env, job.id, 'ocr_done', { retry_count: job.retry_count + 1, next_retry_at: new Date(Date.now() + backoff * 1000).toISOString(), error_log: `LLM ${res.status}: ${errText.slice(0, 500)}` });
      return;
    }

    const data = await res.json() as any;
    const llmResponse = data.choices?.[0]?.message?.content;
    if (!llmResponse) { await recordApiFailure(env, 'openrouter', 'Empty response'); const backoff = Math.min(60 * Math.pow(2, job.retry_count), 900); await updateJobStatus(env, job.id, 'ocr_done', { retry_count: job.retry_count + 1, next_retry_at: new Date(Date.now() + backoff * 1000).toISOString(), error_log: 'LLM empty' }); return; }

    await env.R2_BUCKET.put(`${job.id}_llm.json`, llmResponse, { customMetadata: { 'content-type': 'application/json', 'job-id': job.id } });
    await recordApiSuccess(env, 'openrouter');
    await updateJobStatus(env, job.id, 'llm_done', { error_log: null });
    console.log(`[saga] Job ${job.id}: LLM complete`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await recordApiFailure(env, 'openrouter', msg);
    const backoff = Math.min(60 * Math.pow(2, job.retry_count), 900);
    await updateJobStatus(env, job.id, 'ocr_done', { retry_count: job.retry_count + 1, next_retry_at: new Date(Date.now() + backoff * 1000).toISOString(), error_log: `LLM error: ${msg}` });
  }
}

async function runValidationStep(env: Env, job: ProcessingJob): Promise<void> {
  console.log(`[saga] Job ${job.id}: validation step`);
  const llmObject = await env.R2_BUCKET.get(`${job.id}_llm.json`);
  if (!llmObject) { await updateJobStatus(env, job.id, 'failed', { error_log: 'LLM JSON not found' }); return; }

  let llmData: any;
  try { llmData = JSON.parse(await llmObject.text()); } catch { await updateJobStatus(env, job.id, 'needs_review', { error_log: 'LLM response not valid JSON' }); return; }

  const { validateExtraction, calculateConfidence } = await import('./validator');
  const { isValid, errors, confidence } = validateExtraction(llmData);
  const finalConfidence = calculateConfidence(llmData, isValid);

  if (isValid && finalConfidence > 0.85) {
    await updateJobStatus(env, job.id, 'done', { extracted_data: llmData.fields || llmData, confidence_score: finalConfidence, error_log: null });
    console.log(`[saga] Job ${job.id}: DONE (confidence=${finalConfidence})`);
  } else {
    await updateJobStatus(env, job.id, 'needs_review', { extracted_data: llmData.fields || llmData, confidence_score: finalConfidence, error_log: `Validation failed: ${errors.join('; ')}` });
    console.log(`[saga] Job ${job.id}: NEEDS REVIEW (confidence=${finalConfidence})`);
  }
}

const queueProcessor = {
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    console.log('[saga] Cron triggered');
    try {
      const job = await claimJob(env);
      if (!job) { console.log('[saga] No jobs — exit'); return; }
      console.log(`[saga] Claimed ${job.id} (status=${job.status})`);
      switch (job.status) {
        case 'queued': await runOcrStep(env, job); break;
        case 'ocr_done': await runLlmStep(env, job); break;
        case 'llm_done': await runValidationStep(env, job); break;
        default: console.warn(`[saga] Unknown status: ${job.status}`);
      }
    } catch (err) { console.error('[saga] Error:', err); }
  },
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/health') return Response.json({ status: 'ok', ts: new Date().toISOString() });
    if (url.pathname === '/process' && req.method === 'POST') {
      try {
        const job = await claimJob(env);
        if (!job) return Response.json({ message: 'No jobs' });
        switch (job.status) {
          case 'queued': await runOcrStep(env, job); break;
          case 'ocr_done': await runLlmStep(env, job); break;
          case 'llm_done': await runValidationStep(env, job); break;
          default: return Response.json({ message: `Unknown status: ${job.status}` });
        }
        return Response.json({ success: true, jobId: job.id });
      } catch (err) { return Response.json({ error: String(err) }, { status: 500 }); }
    }
    return Response.json({ error: 'Not found' }, { status: 404 });
  },
};

export default queueProcessor;
