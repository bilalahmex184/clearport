// ============================================================================
// inline-pipeline.ts — Fallback extraction+validation pipeline
// ============================================================================
// Extracted from ClearPortContext.tsx (§4 refactor — behavior-preserving).
//
// Used ONLY when the processing_jobs table doesn't exist (migration 018 not
// run yet) or the queue insert fails. This is the old synchronous path that
// calls the edge function directly from the browser. The primary path is the
// queue + worker — this is the safety net so extraction still works during
// the migration period.
// ============================================================================

import { invokeEdgeFunction } from '@/lib/supabase';

type ApiFetchOrg = <T = any>(path: string, options?: RequestInit & { raw?: boolean }) => Promise<T>;
type RefreshShipment = (shipmentId: string) => Promise<void>;

/**
 * Run the extraction + validation pipeline inline (browser-side).
 *
 * @param shipmentId - The shipment to process
 * @param apiFetchOrg - Org-scoped fetch wrapper
 * @param refreshShipment - Refresh the shipment from the DB after completion
 */
export async function runInlinePipeline(
  shipmentId: string,
  apiFetchOrg: ApiFetchOrg,
  refreshShipment: RefreshShipment,
): Promise<void> {
  try {
    // Extraction
    try {
      await invokeEdgeFunction<any>('extract-document', { shipmentId });
    } catch (err) {
      console.warn('[inline-pipeline] extraction failed:', err);
    }

    // Validation chain
    const traceId = typeof crypto !== 'undefined' ? crypto.randomUUID() : `trace-${Date.now()}`;
    try {
      await apiFetchOrg('/api/shipments/' + shipmentId, {
        method: 'PATCH',
        body: JSON.stringify({ validation_status: 'running', pipeline_trace_id: traceId }),
      });
    } catch (e) {
      console.error('[inline-pipeline] failed to set validation_status=running:', e);
    }

    const invokeWithRetry = async (fnName: string, reqBody: Record<string, any>): Promise<void> => {
      const delays = [500, 1500];
      let lastErr: unknown;
      for (let attempt = 0; attempt <= delays.length; attempt++) {
        try {
          await invokeEdgeFunction(fnName, reqBody);
          return;
        } catch (err) {
          lastErr = err;
          if (attempt < delays.length) {
            await new Promise(r => setTimeout(r, delays[attempt]));
          }
        }
      }
      throw lastErr;
    };

    const results = await Promise.allSettled([
      invokeWithRetry('schema-validate', { shipmentId, trace_id: traceId }),
      invokeWithRetry('math-validate', { shipmentId, trace_id: traceId }),
      invokeWithRetry('cross-validate', { shipmentId, trace_id: traceId }),
    ]);
    const failures = results.filter(r => r.status === 'rejected');

    if (failures.length > 0) {
      await apiFetchOrg('/api/shipments/' + shipmentId, {
        method: 'PATCH',
        body: JSON.stringify({ validation_status: 'failed' }),
      }).catch((err) => { console.warn('[inline-pipeline] PATCH failed status failed:', err instanceof Error ? err.message : err); });
    } else {
      try {
        await invokeWithRetry('flag-exceptions', { shipmentId, trace_id: traceId });
      } catch {
        // flag-exceptions failed → degraded
      }
      await apiFetchOrg('/api/shipments/' + shipmentId, {
        method: 'PATCH',
        body: JSON.stringify({
          validation_status: 'completed',
          last_validated_at: new Date().toISOString(),
        }),
      }).catch((err) => { console.warn('[inline-pipeline] PATCH completed status failed:', err instanceof Error ? err.message : err); });
    }

    await refreshShipment(shipmentId);
  } catch (err) {
    console.error('[inline-pipeline] unexpected error:', err);
  }
}
